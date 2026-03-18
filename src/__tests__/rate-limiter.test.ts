import { Request, Response, NextFunction } from 'express';
import {
  rateLimit,
  slidingWindowRateLimit,
  MemoryStore,
  SlidingWindowStore,
  RateLimitOptions,
  Store,
} from '../index';

// Helper to create mock Express objects
function createMockReq(overrides: Partial<Request> = {}): Request {
  return {
    ip: '127.0.0.1',
    ...overrides,
  } as Request;
}

function createMockRes(): Response & { _status: number; _json: any; _headers: Record<string, any> } {
  const res: any = {
    _status: 200,
    _json: null,
    _headers: {} as Record<string, any>,
    setHeader(name: string, value: any) {
      res._headers[name] = value;
      return res;
    },
    status(code: number) {
      res._status = code;
      return res;
    },
    json(body: any) {
      res._json = body;
      return res;
    },
  };
  return res;
}

function createMockNext(): NextFunction & { called: boolean } {
  const fn: any = jest.fn();
  Object.defineProperty(fn, 'called', {
    get: () => fn.mock.calls.length > 0,
  });
  return fn;
}

// ─── MemoryStore ────────────────────────────────────────────────────────────

describe('MemoryStore', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
  });

  it('should start with count 1 on first increment', async () => {
    const result = await store.increment('key1');
    expect(result.count).toBe(1);
    expect(result.resetTime).toBeGreaterThan(Date.now() - 1000);
  });

  it('should increment count on subsequent calls', async () => {
    await store.increment('key1');
    const result = await store.increment('key1');
    expect(result.count).toBe(2);
  });

  it('should track separate keys independently', async () => {
    await store.increment('a');
    await store.increment('a');
    const resultA = await store.increment('a');
    const resultB = await store.increment('b');
    expect(resultA.count).toBe(3);
    expect(resultB.count).toBe(1);
  });

  it('should reset a key', async () => {
    await store.increment('key1');
    await store.increment('key1');
    await store.reset('key1');
    const result = await store.increment('key1');
    expect(result.count).toBe(1);
  });

  it('should reset count after the window expires', async () => {
    const realNow = Date.now;

    let currentTime = 1000000;
    Date.now = () => currentTime;

    const result1 = await store.increment('key1');
    expect(result1.count).toBe(1);

    // Advance time past the 1-minute window
    currentTime += 61000;
    const result2 = await store.increment('key1');
    expect(result2.count).toBe(1);

    Date.now = realNow;
  });
});

// ─── SlidingWindowStore ─────────────────────────────────────────────────────

describe('SlidingWindowStore', () => {
  let store: SlidingWindowStore;
  const windowMs = 10000; // 10 seconds

  beforeEach(() => {
    store = new SlidingWindowStore(windowMs);
  });

  it('should start with count 1 on first increment', async () => {
    const result = await store.increment('key1');
    expect(result.count).toBe(1);
  });

  it('should accumulate counts within the window', async () => {
    await store.increment('key1');
    await store.increment('key1');
    const result = await store.increment('key1');
    expect(result.count).toBe(3);
  });

  it('should drop timestamps outside the window', async () => {
    const realNow = Date.now;

    let currentTime = 1000000;
    Date.now = () => currentTime;

    await store.increment('key1');
    await store.increment('key1');

    // Move past the window
    currentTime += windowMs + 1;

    const result = await store.increment('key1');
    expect(result.count).toBe(1);

    Date.now = realNow;
  });

  it('should compute resetTime from the oldest timestamp in the window', async () => {
    const realNow = Date.now;

    let currentTime = 1000000;
    Date.now = () => currentTime;

    const first = await store.increment('key1');
    expect(first.resetTime).toBe(currentTime + windowMs);

    currentTime += 2000;
    const second = await store.increment('key1');
    // resetTime should still be based on the first (oldest) timestamp
    expect(second.resetTime).toBe(1000000 + windowMs);

    Date.now = realNow;
  });

  it('should reset a key completely', async () => {
    await store.increment('key1');
    await store.increment('key1');
    await store.reset('key1');
    const result = await store.increment('key1');
    expect(result.count).toBe(1);
  });
});

// ─── rateLimit middleware (fixed window) ────────────────────────────────────

describe('rateLimit middleware', () => {
  const defaultOptions: RateLimitOptions = {
    windowMs: 60000,
    max: 3,
  };

  it('should allow requests under the limit', async () => {
    const limiter = rateLimit(defaultOptions);
    const req = createMockReq();
    const res = createMockRes();
    const next = createMockNext();

    await limiter(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res._status).toBe(200);
  });

  it('should set rate limit headers by default', async () => {
    const limiter = rateLimit(defaultOptions);
    const req = createMockReq();
    const res = createMockRes();
    const next = createMockNext();

    await limiter(req, res, next);

    expect(res._headers['X-RateLimit-Limit']).toBe(3);
    expect(res._headers['X-RateLimit-Remaining']).toBe(2);
    expect(res._headers['X-RateLimit-Reset']).toBeDefined();
  });

  it('should decrement remaining header on each request', async () => {
    const limiter = rateLimit(defaultOptions);
    const req = createMockReq();

    for (let i = 0; i < 3; i++) {
      const res = createMockRes();
      const next = createMockNext();
      await limiter(req, res, next);

      expect(res._headers['X-RateLimit-Remaining']).toBe(3 - (i + 1));
    }
  });

  it('should block requests that exceed the limit', async () => {
    const limiter = rateLimit(defaultOptions);
    const req = createMockReq();

    // Exhaust the limit
    for (let i = 0; i < 3; i++) {
      await limiter(req, createMockRes(), createMockNext());
    }

    // 4th request should be blocked
    const res = createMockRes();
    const next = createMockNext();
    await limiter(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(429);
    expect(res._json).toEqual({ error: 'Too many requests, please try again later.' });
  });

  it('should set Retry-After header when limit exceeded', async () => {
    const limiter = rateLimit(defaultOptions);
    const req = createMockReq();

    for (let i = 0; i < 3; i++) {
      await limiter(req, createMockRes(), createMockNext());
    }

    const res = createMockRes();
    await limiter(req, res, createMockNext());

    expect(res._headers['Retry-After']).toBe(Math.ceil(60000 / 1000));
  });

  it('should set remaining to 0 (not negative) when limit exceeded', async () => {
    const limiter = rateLimit(defaultOptions);
    const req = createMockReq();

    // 4 requests (1 over limit)
    for (let i = 0; i < 4; i++) {
      await limiter(req, createMockRes(), createMockNext());
    }

    const res = createMockRes();
    await limiter(req, res, createMockNext());

    expect(res._headers['X-RateLimit-Remaining']).toBe(0);
  });
});

// ─── Custom configurations ──────────────────────────────────────────────────

describe('rateLimit with custom configurations', () => {
  it('should use a custom status code', async () => {
    const limiter = rateLimit({ windowMs: 60000, max: 1, statusCode: 503 });
    const req = createMockReq();

    await limiter(req, createMockRes(), createMockNext());

    const res = createMockRes();
    await limiter(req, res, createMockNext());

    expect(res._status).toBe(503);
  });

  it('should use a custom error message', async () => {
    const msg = 'Slow down!';
    const limiter = rateLimit({ windowMs: 60000, max: 1, message: msg });
    const req = createMockReq();

    await limiter(req, createMockRes(), createMockNext());

    const res = createMockRes();
    await limiter(req, res, createMockNext());

    expect(res._json).toEqual({ error: msg });
  });

  it('should use a custom keyGenerator', async () => {
    const limiter = rateLimit({
      windowMs: 60000,
      max: 1,
      keyGenerator: (req: Request) => (req as any).userId || 'anon',
    });

    const reqA = createMockReq({ userId: 'user-1' } as any);
    const reqB = createMockReq({ userId: 'user-2' } as any);

    await limiter(reqA, createMockRes(), createMockNext());
    await limiter(reqB, createMockRes(), createMockNext());

    // Both should pass since they have different keys
    const resA = createMockRes();
    const nextA = createMockNext();
    await limiter(reqA, resA, nextA);
    expect(nextA).not.toHaveBeenCalled();
    expect(resA._status).toBe(429);

    // user-2 should still pass (only 1 hit so far, now 2nd = blocked)
    const resB = createMockRes();
    const nextB = createMockNext();
    await limiter(reqB, resB, nextB);
    expect(nextB).not.toHaveBeenCalled();
  });

  it('should skip requests when skip returns true', async () => {
    const limiter = rateLimit({
      windowMs: 60000,
      max: 1,
      skip: (req: Request) => (req as any).isAdmin === true,
    });

    const adminReq = createMockReq({ isAdmin: true } as any);
    const limiter_fn = limiter;

    // Admin requests should always pass
    for (let i = 0; i < 5; i++) {
      const res = createMockRes();
      const next = createMockNext();
      await limiter_fn(adminReq, res, next);
      expect(next).toHaveBeenCalled();
    }
  });

  it('should not set headers when headers option is false', async () => {
    const limiter = rateLimit({ windowMs: 60000, max: 5, headers: false });
    const req = createMockReq();
    const res = createMockRes();
    const next = createMockNext();

    await limiter(req, res, next);

    expect(res._headers['X-RateLimit-Limit']).toBeUndefined();
    expect(res._headers['X-RateLimit-Remaining']).toBeUndefined();
    expect(res._headers['X-RateLimit-Reset']).toBeUndefined();
  });
});

// ─── Custom Store ───────────────────────────────────────────────────────────

describe('rateLimit with a custom store', () => {
  it('should delegate to the provided store', async () => {
    const mockStore: Store = {
      increment: jest.fn().mockResolvedValue({ count: 1, resetTime: Date.now() + 60000 }),
      reset: jest.fn().mockResolvedValue(undefined),
    };

    const limiter = rateLimit({ windowMs: 60000, max: 5, store: mockStore });
    const req = createMockReq();

    await limiter(req, createMockRes(), createMockNext());

    expect(mockStore.increment).toHaveBeenCalledWith('127.0.0.1');
  });
});

// ─── slidingWindowRateLimit helper ──────────────────────────────────────────

describe('slidingWindowRateLimit', () => {
  it('should create a limiter backed by SlidingWindowStore', async () => {
    const limiter = slidingWindowRateLimit({ windowMs: 5000, max: 2 });
    const req = createMockReq();

    // First two should pass
    const next1 = createMockNext();
    await limiter(req, createMockRes(), next1);
    expect(next1).toHaveBeenCalled();

    const next2 = createMockNext();
    await limiter(req, createMockRes(), next2);
    expect(next2).toHaveBeenCalled();

    // Third should be blocked
    const res3 = createMockRes();
    const next3 = createMockNext();
    await limiter(req, res3, next3);
    expect(next3).not.toHaveBeenCalled();
    expect(res3._status).toBe(429);
  });

  it('should allow requests again after the sliding window expires', async () => {
    const realNow = Date.now;
    let currentTime = 1000000;
    Date.now = () => currentTime;

    const limiter = slidingWindowRateLimit({ windowMs: 5000, max: 1 });
    const req = createMockReq();

    // First request passes
    const next1 = createMockNext();
    await limiter(req, createMockRes(), next1);
    expect(next1).toHaveBeenCalled();

    // Second blocked
    const res2 = createMockRes();
    const next2 = createMockNext();
    await limiter(req, res2, next2);
    expect(next2).not.toHaveBeenCalled();

    // Advance past the window
    currentTime += 5001;

    const next3 = createMockNext();
    await limiter(req, createMockRes(), next3);
    expect(next3).toHaveBeenCalled();

    Date.now = realNow;
  });
});

// ─── Edge cases ─────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('should handle unknown IP gracefully', async () => {
    const limiter = rateLimit({ windowMs: 60000, max: 5 });
    const req = createMockReq({ ip: undefined } as any);
    const res = createMockRes();
    const next = createMockNext();

    await limiter(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('should handle max of 0 (block everything)', async () => {
    const limiter = rateLimit({ windowMs: 60000, max: 0 });
    const req = createMockReq();
    const res = createMockRes();
    const next = createMockNext();

    await limiter(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(429);
  });

  it('should handle concurrent requests to different IPs', async () => {
    const limiter = rateLimit({ windowMs: 60000, max: 1 });

    const results = await Promise.all(
      ['10.0.0.1', '10.0.0.2', '10.0.0.3'].map(async (ip) => {
        const req = createMockReq({ ip });
        const res = createMockRes();
        const next = createMockNext();
        await limiter(req, res, next);
        return { ip, called: next.called };
      }),
    );

    // All different IPs should pass
    results.forEach(({ called }) => expect(called).toBe(true));
  });
});
