/**
 * Redis Connection Pooling Service
 * 
 * Provides efficient Redis connection management with:
 * - Connection pooling (single persistent connection with auto-reconnect)
 * - High-resolution timing for performance measurement
 * - Get/Set/Del operations with TTL support
 * - Connection statistics and health monitoring
 */

import { createClient, RedisClientType } from 'redis';
import { secureLog } from '@deepiri/shared-utils';

// Redis client configuration
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const DEFAULT_TTL = parseInt(process.env.REDIS_DEFAULT_TTL || '300', 10); // 5 minutes default

// Statistics tracking
interface RedisStats {
  hits: number;
  misses: number;
  sets: number;
  deletes: number;
  errors: number;
  totalGetTimeNs: bigint;
  totalSetTimeNs: bigint;
  getCount: number;
  setCount: number;
}

const stats: RedisStats = {
  hits: 0,
  misses: 0,
  sets: 0,
  deletes: 0,
  errors: 0,
  totalGetTimeNs: BigInt(0),
  totalSetTimeNs: BigInt(0),
  getCount: 0,
  setCount: 0
};

// Single Redis client (connection pooling handled by the client internally)
let client: RedisClientType | null = null;
let isConnected = false;

/**
 * Initialize Redis connection
 * Creates a persistent connection with auto-reconnect
 */
export async function initRedis(): Promise<void> {
  if (client && isConnected) {
    secureLog('info', 'Redis already connected');
    return;
  }

  try {
    secureLog('info', `Connecting to Redis at ${REDIS_URL}...`);
    
    client = createClient({
      url: REDIS_URL,
      socket: {
        reconnectStrategy: (retries) => {
          if (retries > 10) {
            secureLog('error', 'Redis max reconnection attempts reached');
            return new Error('Redis max reconnection attempts');
          }
          const delay = Math.min(retries * 100, 3000);
          secureLog('warn', `Redis reconnecting in ${delay}ms (attempt ${retries})`);
          return delay;
        }
      }
    });

    client.on('error', (err) => {
      secureLog('error', 'Redis Client Error:', err.message);
      stats.errors++;
      isConnected = false;
    });

    client.on('connect', () => {
      secureLog('info', 'Redis connected');
      isConnected = true;
    });

    client.on('ready', () => {
      secureLog('info', 'Redis ready');
      isConnected = true;
    });

    client.on('reconnecting', () => {
      secureLog('warn', 'Redis reconnecting...');
      isConnected = false;
    });

    await client.connect();
    isConnected = true;
    secureLog('info', 'Redis connection established successfully');
  } catch (error: any) {
    secureLog('error', 'Failed to connect to Redis:', error.message);
    stats.errors++;
    isConnected = false;
    throw error;
  }
}

/**
 * Get value from Redis with timing
 * Returns null if key doesn't exist or on error
 */
export async function get(key: string): Promise<{ value: string | null; timeNs: bigint }> {
  const startTime = process.hrtime.bigint();
  
  try {
    if (!client || !isConnected) {
      throw new Error('Redis not connected');
    }

    const value = await client.get(key);
    const endTime = process.hrtime.bigint();
    const timeNs = endTime - startTime;

    if (value !== null) {
      stats.hits++;
    } else {
      stats.misses++;
    }
    stats.totalGetTimeNs += timeNs;
    stats.getCount++;

    return { value, timeNs };
  } catch (error: any) {
    const endTime = process.hrtime.bigint();
    secureLog('error', `Redis GET error for key ${key}:`, error.message);
    stats.errors++;
    stats.misses++;
    return { value: null, timeNs: endTime - startTime };
  }
}

/**
 * Set value in Redis with TTL and timing
 */
export async function set(
  key: string, 
  value: string, 
  ttlSeconds: number = DEFAULT_TTL
): Promise<{ success: boolean; timeNs: bigint }> {
  const startTime = process.hrtime.bigint();
  
  try {
    if (!client || !isConnected) {
      throw new Error('Redis not connected');
    }

    await client.setEx(key, ttlSeconds, value);
    const endTime = process.hrtime.bigint();
    const timeNs = endTime - startTime;

    stats.sets++;
    stats.totalSetTimeNs += timeNs;
    stats.setCount++;

    return { success: true, timeNs };
  } catch (error: any) {
    const endTime = process.hrtime.bigint();
    secureLog('error', `Redis SET error for key ${key}:`, error.message);
    stats.errors++;
    return { success: false, timeNs: endTime - startTime };
  }
}

/**
 * Delete key from Redis
 */
export async function del(key: string): Promise<boolean> {
  try {
    if (!client || !isConnected) {
      throw new Error('Redis not connected');
    }

    await client.del(key);
    stats.deletes++;
    return true;
  } catch (error: any) {
    secureLog('error', `Redis DEL error for key ${key}:`, error.message);
    stats.errors++;
    return false;
  }
}

/**
 * Check if Redis is connected and healthy
 */
export async function isHealthy(): Promise<boolean> {
  try {
    if (!client || !isConnected) {
      return false;
    }
    await client.ping();
    return true;
  } catch {
    return false;
  }
}

/**
 * Get Redis statistics
 */
export function getStats(): {
  hits: number;
  misses: number;
  hitRate: string;
  sets: number;
  deletes: number;
  errors: number;
  avgGetTimeMs: string;
  avgSetTimeMs: string;
  isConnected: boolean;
} {
  const hitRate = stats.hits + stats.misses > 0 
    ? ((stats.hits / (stats.hits + stats.misses)) * 100).toFixed(2) 
    : '0.00';
  
  const avgGetTimeMs = stats.getCount > 0 
    ? (Number(stats.totalGetTimeNs / BigInt(stats.getCount)) / 1_000_000).toFixed(3)
    : '0.000';
    
  const avgSetTimeMs = stats.setCount > 0 
    ? (Number(stats.totalSetTimeNs / BigInt(stats.setCount)) / 1_000_000).toFixed(3)
    : '0.000';

  return {
    hits: stats.hits,
    misses: stats.misses,
    hitRate: `${hitRate}%`,
    sets: stats.sets,
    deletes: stats.deletes,
    errors: stats.errors,
    avgGetTimeMs: `${avgGetTimeMs}ms`,
    avgSetTimeMs: `${avgSetTimeMs}ms`,
    isConnected
  };
}

/**
 * Close Redis connection gracefully
 */
export async function closeRedis(): Promise<void> {
  if (client) {
    secureLog('info', 'Closing Redis connection...');
    await client.quit();
    client = null;
    isConnected = false;
    secureLog('info', 'Redis connection closed');
  }
}

export default {
  initRedis,
  get,
  set,
  del,
  isHealthy,
  getStats,
  closeRedis
};

