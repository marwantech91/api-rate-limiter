import { Request, Response, NextFunction } from 'express';

export interface Store {
  increment(key: string): Promise<{ count: number; resetTime: number }>;
  reset(key: string): Promise<void>;
}

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  message?: string;
  statusCode?: number;
  store?: Store;
  keyGenerator?: (req: Request) => string;
  skip?: (req: Request) => boolean;
  headers?: boolean;
}

// In-memory store for development
class MemoryStore implements Store {
  private hits: Map<string, { count: number; resetTime: number }> = new Map();

  async increment(key: string): Promise<{ count: number; resetTime: number }> {
    const now = Date.now();
    const record = this.hits.get(key);

    if (!record || now > record.resetTime) {
      const resetTime = now + 60000; // 1 minute default
      this.hits.set(key, { count: 1, resetTime });
      return { count: 1, resetTime };
    }

    record.count++;
    return { count: record.count, resetTime: record.resetTime };
  }

  async reset(key: string): Promise<void> {
    this.hits.delete(key);
  }
}

export function rateLimit(options: RateLimitOptions) {
  const {
    windowMs,
    max,
    message = 'Too many requests, please try again later.',
    statusCode = 429,
    store = new MemoryStore(),
    keyGenerator = (req: Request) => req.ip || 'unknown',
    skip = () => false,
    headers = true,
  } = options;

  return async (req: Request, res: Response, next: NextFunction) => {
    // Check if request should be skipped
    if (skip(req)) {
      return next();
    }

    const key = keyGenerator(req);
    const { count, resetTime } = await store.increment(key);

    // Set headers
    if (headers) {
      res.setHeader('X-RateLimit-Limit', max);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, max - count));
      res.setHeader('X-RateLimit-Reset', Math.ceil(resetTime / 1000));
    }

    // Check if limit exceeded
    if (count > max) {
      res.setHeader('Retry-After', Math.ceil(windowMs / 1000));
      return res.status(statusCode).json({ error: message });
    }

    next();
  };
}

// Sliding window rate limiter for more accurate rate limiting
export class SlidingWindowStore implements Store {
  private logs: Map<string, number[]> = new Map();
  private windowMs: number;

  constructor(windowMs: number) {
    this.windowMs = windowMs;
  }

  async increment(key: string): Promise<{ count: number; resetTime: number }> {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    let timestamps = this.logs.get(key) || [];
    timestamps = timestamps.filter((t) => t > windowStart);
    timestamps.push(now);
    this.logs.set(key, timestamps);

    return {
      count: timestamps.length,
      resetTime: timestamps[0] + this.windowMs,
    };
  }

  async reset(key: string): Promise<void> {
    this.logs.delete(key);
  }
}

export { MemoryStore };

// Helper to create rate limiter with sliding window
export function slidingWindowRateLimit(options: Omit<RateLimitOptions, 'store'> & { windowMs: number }) {
  return rateLimit({
    ...options,
    store: new SlidingWindowStore(options.windowMs),
  });
}
