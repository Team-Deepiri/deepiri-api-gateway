import { Request, Response, NextFunction } from 'express';
import axios, { AxiosError }               from 'axios';
import { hashApiKey }                      from '@deepiri/shared-utils/src/cryptoUtils';
import { createRedisClient }               from '@deepiri/shared-utils/src/redisClient';
import { ApiKeyCachePayload, ApiKeyScope } from '@deepiri/shared-utils/src/types';

const redis = createRedisClient();

const AUTH_SERVICE_URL: string = process.env.AUTH_SERVICE_URL ?? 'http://deepiri-auth-service:3001';
const INTERNAL_SECRET: string | undefined = process.env.INTERNAL_SERVICE_SECRET;
const REQUIRED_SCOPE:  ApiKeyScope        = 'ingestion:write';

const RATE_LIMIT = {
  windowMs:    60_000, 
  maxRequests: 100,
};

interface ResolvedKey {
  payload: ApiKeyCachePayload;
  source:  'cache' | 'auth-service';
}

async function resolveKeyPayload(hashedKey: string): Promise<ResolvedKey> {
  const cacheKey = `apikey:${hashedKey}`;

  const cached = await redis.get(cacheKey);
  if (cached) {
    return {
      payload: JSON.parse(cached) as ApiKeyCachePayload,
      source:  'cache',
    };
  }

  const response = await axios.post<ApiKeyCachePayload>(
    `${AUTH_SERVICE_URL}/internal/validate-api-key`,
    { hashedKey },
    {
      headers: {
        'x-internal-secret': INTERNAL_SECRET,
        'Content-Type':      'application/json',
      },
      timeout: 4_000,
    }
  );

  return { payload: response.data, source: 'auth-service' };
}

interface RateLimitResult {
  allowed:   boolean;
  count:     number;
  remaining: number;
}

async function checkRateLimit(serviceAccountId: string): Promise<RateLimitResult> {
  const key         = `ratelimit:ingestion:${serviceAccountId}`;
  const now         = Date.now();
  const windowStart = now - RATE_LIMIT.windowMs;

  const pipeline = redis.pipeline();
  pipeline.zremrangebyscore(key, '-inf', windowStart);
  pipeline.zadd(key, now, `${now}:${Math.random()}`);
  pipeline.zcard(key);
  pipeline.pexpire(key, RATE_LIMIT.windowMs);

  const results = await pipeline.exec();

  if (!results || results.some(([err]) => err !== null)) {
    console.error('[Gateway/rateLimit] Redis pipeline error:', results);
    return { allowed: true, count: 0, remaining: RATE_LIMIT.maxRequests };
  }

  const count = results[2][1] as number;

  return {
    allowed:   count <= RATE_LIMIT.maxRequests,
    count,
    remaining: Math.max(0, RATE_LIMIT.maxRequests - count),
  };
}

export async function ingestionAuthMiddleware(
  req:  Request,
  res:  Response,
  next: NextFunction
): Promise<void> {
  const rawKey: string =
    (req.headers['x-api-key'] as string | undefined) ??
    (req.headers['authorization'] ?? '').replace(/^Bearer\s+/i, '').trim();

  if (!rawKey) {
    res.status(401).json({ error: 'Unauthorized: Missing API key.' });
    return;
  }

  let payload: ApiKeyCachePayload;
  let source:  'cache' | 'auth-service';

  try {
    const hashedKey = hashApiKey(rawKey);
    ({ payload, source } = await resolveKeyPayload(hashedKey));
    
    console.debug(`[Gateway/ingestionAuth] Key resolved via ${source} for account: ${payload.serviceAccountId}`);
  } catch (err) {
    const axiosErr = err as AxiosError;

    if (axiosErr.isAxiosError && axiosErr.response) {
      const status = axiosErr.response.status;
      if (status === 401 || status === 404) {
        res.status(401).json({ error: 'Unauthorized: Invalid or revoked API key.' });
        return;
      }
      if (status === 403) {
        console.error('[Gateway/ingestionAuth] Internal secret rejected by Auth Service.');
        res.status(503).json({ error: 'Authentication service configuration error.' });
        return;
      }
    }

    console.error('[Gateway/ingestionAuth] Key resolution failed:', (err as Error).message);
    res.status(503).json({ error: 'Authentication service unavailable.' });
    return;
  }

  if (!payload.scopes.includes(REQUIRED_SCOPE)) {
    res.status(403).json({ error: `Forbidden: Requires scope '${REQUIRED_SCOPE}'.` });
    return;
  }

  let rateLimit: RateLimitResult;
  try {
    rateLimit = await checkRateLimit(payload.serviceAccountId);
  } catch (err) {
    console.error('[Gateway/ingestionAuth] Rate limit check failed:', (err as Error).message);
    rateLimit = { allowed: true, remaining: RATE_LIMIT.maxRequests, count: 0 };
  }

  res.setHeader('X-RateLimit-Limit',     RATE_LIMIT.maxRequests);
  res.setHeader('X-RateLimit-Remaining', rateLimit.remaining);

  if (!rateLimit.allowed) {
    res.status(429).json({ error: 'Too Many Requests: Rate limit exceeded.' });
    return;
  }

  // Inject identity for downstream services and strip raw credentials
  req.headers['x-service-account-id']     = payload.serviceAccountId;
  req.headers['x-service-account-scopes'] = payload.scopes.join(',');
  req.headers['x-owner-id']               = payload.ownerId;
  delete req.headers['x-api-key'];
  delete req.headers['authorization'];

  next();
}