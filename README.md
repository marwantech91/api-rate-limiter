# API Rate Limiter

![Node.js](https://img.shields.io/badge/Node.js-20-339933?style=flat-square&logo=node.js)
![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)

Express middleware for API rate limiting with Redis support. Protect your APIs from abuse with sliding window rate limiting.

## Features

- **Sliding Window** - Accurate rate limiting algorithm
- **Redis Support** - Distributed rate limiting
- **In-Memory** - Works without Redis for development
- **Custom Keys** - Rate limit by IP, user ID, API key
- **Skip Rules** - Whitelist certain requests
- **Headers** - Standard rate limit headers

## Installation

```bash
npm install @marwantech/api-rate-limiter
```

## Quick Start

```typescript
import express from 'express';
import { rateLimit, RedisStore } from '@marwantech/api-rate-limiter';

const app = express();

// Basic usage (in-memory store)
app.use(rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 100,              // 100 requests per window
}));

// With Redis (production)
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  store: new RedisStore({ url: process.env.REDIS_URL }),
}));
```

## Configuration

```typescript
interface RateLimitOptions {
  windowMs: number;           // Time window in ms
  max: number;                // Max requests per window
  message?: string;           // Error message
  statusCode?: number;        // HTTP status (default: 429)
  store?: Store;              // Storage backend
  keyGenerator?: (req) => string;  // Custom key function
  skip?: (req) => boolean;    // Skip certain requests
  headers?: boolean;          // Include rate limit headers
}
```

## Custom Key Generator

```typescript
// Rate limit by user ID instead of IP
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  keyGenerator: (req) => req.user?.id || req.ip,
}));

// Rate limit by API key
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 1000,
  keyGenerator: (req) => req.headers['x-api-key'] || req.ip,
}));
```

## Skip Rules

```typescript
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  skip: (req) => {
    // Skip health checks
    if (req.path === '/health') return true;
    // Skip whitelisted IPs
    if (WHITELIST.includes(req.ip)) return true;
    return false;
  },
}));
```

## Response Headers

When `headers: true` (default):

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1640000000
```

## Multiple Limits

```typescript
// Strict limit for auth endpoints
app.use('/api/auth', rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 5,
  message: 'Too many login attempts',
}));

// Relaxed limit for other endpoints
app.use('/api', rateLimit({
  windowMs: 60 * 1000,
  max: 100,
}));
```

## License

MIT
