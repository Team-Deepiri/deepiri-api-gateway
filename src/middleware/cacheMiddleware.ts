/**
 * Redis-based Response Caching Middleware
 * 
 * Features:
 * - Caches GET request responses in Redis
 * - Configurable TTL per route
 * - Cache key generation from URL and query params
 * - Cache bypass via header (x-skip-cache: true)
 * - Performance timing headers
 */

import { Request, Response, NextFunction } from 'express';
import * as redisService from '../services/redisService';
import { logger, secureLog } from '@deepiri/shared-utils';

interface CacheOptions {
  ttlSeconds?: number;
  keyPrefix?: string;
  includeQueryParams?: boolean;
}

const DEFAULT_OPTIONS: Required<CacheOptions> = {
  ttlSeconds: 60,
  keyPrefix: 'api-cache',
  includeQueryParams: true
};

/**
 * Generate a cache key from the request
 */
function generateCacheKey(req: Request, options: Required<CacheOptions>): string {
  let key = `${options.keyPrefix}:${req.method}:${req.path}`;
  
  if (options.includeQueryParams && Object.keys(req.query).length > 0) {
    // Sort query params for consistent key generation
    const sortedQuery = Object.keys(req.query)
      .sort()
      .map(k => `${k}=${req.query[k]}`)
      .join('&');
    key += `?${sortedQuery}`;
  }
  
  return key;
}

/**
 * Format nanoseconds to milliseconds string
 */
function nsToMs(ns: bigint): string {
  return (Number(ns) / 1_000_000).toFixed(3);
}

/**
 * Cache middleware factory
 * Returns middleware that caches GET responses in Redis
 */
export function cacheMiddleware(options: CacheOptions = {}) {
  const opts: Required<CacheOptions> = { ...DEFAULT_OPTIONS, ...options };

  return async (req: Request, res: Response, next: NextFunction) => {
    // Only cache GET requests
    if (req.method !== 'GET') {
      return next();
    }

    // Allow cache bypass via header
    if (req.headers['x-skip-cache'] === 'true') {
      res.setHeader('X-Cache', 'BYPASS');
      return next();
    }

    const cacheKey = generateCacheKey(req, opts);
    const startTime = process.hrtime.bigint();

    try {
      // Check cache
      const cached = await redisService.get(cacheKey);
      
      if (cached.value !== null) {
        // Cache hit - return cached response
        const endTime = process.hrtime.bigint();
        const totalTimeNs = endTime - startTime;
        
        res.setHeader('X-Cache', 'HIT');
        res.setHeader('X-Cache-Key', cacheKey);
        res.setHeader('X-Cache-Time-Ms', nsToMs(cached.timeNs));
        res.setHeader('X-Total-Time-Ms', nsToMs(totalTimeNs));
        
        logger.debug('Cache HIT', { 
          key: cacheKey, 
          timeMs: nsToMs(totalTimeNs) 
        });
        
        try {
          const parsedResponse = JSON.parse(cached.value);
          return res.json(parsedResponse);
        } catch {
          // If parsing fails, return as plain text
          return res.send(cached.value);
        }
      }

      // Cache miss - capture and cache the response
      res.setHeader('X-Cache', 'MISS');
      res.setHeader('X-Cache-Key', cacheKey);
      
      // Store original json method
      const originalJson = res.json.bind(res);
      
      // Override json to cache the response
      res.json = function(body: any) {
        // Cache the response asynchronously
        const bodyString = JSON.stringify(body);
        redisService.set(cacheKey, bodyString, opts.ttlSeconds)
          .then(({ timeNs }) => {
            logger.debug('Response cached', { 
              key: cacheKey, 
              ttl: opts.ttlSeconds,
              setTimeMs: nsToMs(timeNs)
            });
          })
          .catch(err => {
            secureLog('error', 'Failed to cache response:', err.message);
          });
        
        return originalJson(body);
      };

      next();
    } catch (error: any) {
      secureLog('error', 'Cache middleware error:', error.message);
      // On cache error, continue without caching
      res.setHeader('X-Cache', 'ERROR');
      next();
    }
  };
}

/**
 * Clear cache for a specific pattern
 */
export async function clearCache(pattern: string): Promise<void> {
  // Note: This is a simplified implementation
  // For production, consider using Redis SCAN with pattern matching
  secureLog('info', `Cache clear requested for pattern: ${pattern}`);
}

export default cacheMiddleware;

