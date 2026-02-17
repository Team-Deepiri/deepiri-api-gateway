/**
 * PostgreSQL Connection Pooling Service
 * 
 * Provides efficient database connection management with:
 * - Connection pooling (configurable pool size)
 * - High-resolution timing for performance measurement
 * - Query execution with automatic connection release
 * - Slow query detection and logging
 * - Pool statistics and health monitoring
 * - Prometheus metrics for monitoring
 */

import { Pool, PoolConfig, QueryResult, QueryResultRow } from 'pg';
import winston from 'winston';
import promClient from 'prom-client';

// ============================================================================
// PROMETHEUS METRICS
// ============================================================================

// Query duration histogram (seconds)
const dbQueryDuration = new promClient.Histogram({
  name: 'db_query_duration_seconds',
  help: 'Duration of database queries in seconds',
  labelNames: ['status'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]
});

// Query counter by status
const dbQueryTotal = new promClient.Counter({
  name: 'db_queries_total',
  help: 'Total number of database queries',
  labelNames: ['status']  // success, error, slow
});

// Connection pool gauges
const dbPoolTotal = new promClient.Gauge({
  name: 'db_pool_connections_total',
  help: 'Total number of connections in the pool'
});

const dbPoolIdle = new promClient.Gauge({
  name: 'db_pool_connections_idle',
  help: 'Number of idle connections in the pool'
});

const dbPoolWaiting = new promClient.Gauge({
  name: 'db_pool_clients_waiting',
  help: 'Number of clients waiting for a connection'
});

// Connection error counter
const dbConnectionErrors = new promClient.Counter({
  name: 'db_connection_errors_total',
  help: 'Total number of database connection errors'
});

// Slow query counter
const dbSlowQueries = new promClient.Counter({
  name: 'db_slow_queries_total',
  help: 'Total number of slow queries detected'
});

// Export metrics registry for /metrics endpoint
export const dbMetrics = {
  queryDuration: dbQueryDuration,
  queryTotal: dbQueryTotal,
  poolTotal: dbPoolTotal,
  poolIdle: dbPoolIdle,
  poolWaiting: dbPoolWaiting,
  connectionErrors: dbConnectionErrors,
  slowQueries: dbSlowQueries
};

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [new winston.transports.Console({ format: winston.format.simple() })]
});

// Database configuration from environment
const dbConfig: PoolConfig = {
  host: process.env.DB_HOST || 'postgres',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'deepiri',
  user: process.env.DB_USER || 'deepiri',
  password: process.env.DB_PASSWORD || 'deepiripassword',
  
  // Connection pool settings
  max: parseInt(process.env.DB_POOL_MAX || '20', 10), // Maximum connections in pool
  min: parseInt(process.env.DB_POOL_MIN || '5', 10),  // Minimum connections to maintain
  idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT || '30000', 10), // Close idle connections after 30s
  connectionTimeoutMillis: parseInt(process.env.DB_CONNECT_TIMEOUT || '5000', 10), // Connection timeout
  
  // Statement timeout (prevent long-running queries)
  statement_timeout: parseInt(process.env.DB_STATEMENT_TIMEOUT || '30000', 10),
};

// Slow query threshold (milliseconds)
const SLOW_QUERY_THRESHOLD_MS = parseInt(process.env.DB_SLOW_QUERY_MS || '100', 10);

// Statistics tracking
interface DbStats {
  totalQueries: number;
  successfulQueries: number;
  failedQueries: number;
  slowQueries: number;
  totalQueryTimeNs: bigint;
  connectionAcquires: number;
  connectionReleases: number;
  connectionErrors: number;
}

const stats: DbStats = {
  totalQueries: 0,
  successfulQueries: 0,
  failedQueries: 0,
  slowQueries: 0,
  totalQueryTimeNs: BigInt(0),
  connectionAcquires: 0,
  connectionReleases: 0,
  connectionErrors: 0
};

// Connection pool instance
let pool: Pool | null = null;

/**
 * Initialize the database connection pool
 */
export async function initDb(): Promise<void> {
  if (pool) {
    logger.info('Database pool already initialized');
    return;
  }

  try {
    logger.info(`Initializing PostgreSQL connection pool...`, {
      host: dbConfig.host,
      port: dbConfig.port,
      database: dbConfig.database,
      user: dbConfig.user,
      poolSize: `${dbConfig.min}-${dbConfig.max}`
    });

    pool = new Pool(dbConfig);

    // Pool event handlers
    pool.on('connect', (client) => {
      stats.connectionAcquires++;
      logger.debug('New client connected to pool');
    });

    pool.on('acquire', (client) => {
      logger.debug('Client acquired from pool');
    });

    pool.on('release', (client) => {
      stats.connectionReleases++;
      logger.debug('Client released to pool');
    });

    pool.on('error', (err, client) => {
      stats.connectionErrors++;
      dbConnectionErrors.inc();
      logger.error('Unexpected error on idle client:', err.message);
    });

    // Test the connection
    const testResult = await pool.query('SELECT NOW() as current_time');
    logger.info('Database connection pool initialized successfully', {
      serverTime: testResult.rows[0]?.current_time
    });
  } catch (error: any) {
    logger.error('Failed to initialize database pool:', error.message);
    pool = null;
    throw error;
  }
}

/**
 * Execute a database query with timing and statistics
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string, 
  params?: any[]
): Promise<{ result: QueryResult<T>; timeNs: bigint; timeMs: number }> {
  const startTime = process.hrtime.bigint();
  stats.totalQueries++;

  try {
    if (!pool) {
      throw new Error('Database pool not initialized');
    }

    const result = await pool.query<T>(text, params);
    const endTime = process.hrtime.bigint();
    const timeNs = endTime - startTime;
    const timeMs = Number(timeNs) / 1_000_000;
    const timeSec = timeMs / 1000;

    stats.successfulQueries++;
    stats.totalQueryTimeNs += timeNs;

    // Record Prometheus metrics
    dbQueryDuration.observe({ status: 'success' }, timeSec);
    dbQueryTotal.inc({ status: 'success' });

    // Log slow queries
    if (timeMs > SLOW_QUERY_THRESHOLD_MS) {
      stats.slowQueries++;
      dbSlowQueries.inc();
      dbQueryTotal.inc({ status: 'slow' });
      logger.warn('Slow query detected', {
        query: text.substring(0, 100),
        timeMs: timeMs.toFixed(3),
        threshold: SLOW_QUERY_THRESHOLD_MS,
        rowCount: result.rowCount
      });
    }

    return { result, timeNs, timeMs };
  } catch (error: any) {
    const endTime = process.hrtime.bigint();
    const timeNs = endTime - startTime;
    const timeMs = Number(timeNs) / 1_000_000;
    const timeSec = timeMs / 1000;

    stats.failedQueries++;
    
    // Record Prometheus error metrics
    dbQueryDuration.observe({ status: 'error' }, timeSec);
    dbQueryTotal.inc({ status: 'error' });
    
    logger.error('Database query error:', {
      error: error.message,
      query: text.substring(0, 100),
      timeMs: timeMs.toFixed(3)
    });
    throw error;
  }
}

/**
 * Execute a query with Redis cache integration
 * First checks cache, then falls back to database
 */
export async function queryWithCache<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: any[] | undefined,
  cacheKey: string,
  cacheTtlSeconds: number,
  redisService: {
    get: (key: string) => Promise<{ value: string | null; timeNs: bigint }>;
    set: (key: string, value: string, ttl: number) => Promise<{ success: boolean; timeNs: bigint }>;
  }
): Promise<{
  result: T[];
  source: 'cache' | 'database';
  cacheTimeNs?: bigint;
  dbTimeNs?: bigint;
  totalTimeNs: bigint;
}> {
  const totalStartTime = process.hrtime.bigint();

  // Try cache first
  const cacheResult = await redisService.get(cacheKey);
  
  if (cacheResult.value !== null) {
    const totalEndTime = process.hrtime.bigint();
    return {
      result: JSON.parse(cacheResult.value),
      source: 'cache',
      cacheTimeNs: cacheResult.timeNs,
      totalTimeNs: totalEndTime - totalStartTime
    };
  }

  // Cache miss - query database
  const dbResult = await query<T>(text, params);
  
  // Store in cache (don't await - fire and forget)
  redisService.set(cacheKey, JSON.stringify(dbResult.result.rows), cacheTtlSeconds)
    .catch(err => logger.error('Failed to cache query result:', err.message));

  const totalEndTime = process.hrtime.bigint();
  return {
    result: dbResult.result.rows,
    source: 'database',
    cacheTimeNs: cacheResult.timeNs,
    dbTimeNs: dbResult.timeNs,
    totalTimeNs: totalEndTime - totalStartTime
  };
}

/**
 * Get a client from the pool for transactions
 */
export async function getClient() {
  if (!pool) {
    throw new Error('Database pool not initialized');
  }
  return pool.connect();
}

/**
 * Check if the database is healthy
 */
export async function isHealthy(): Promise<boolean> {
  try {
    if (!pool) {
      return false;
    }
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/**
 * Update Prometheus pool gauges with current values
 */
export function updatePoolMetrics(): void {
  dbPoolTotal.set(pool?.totalCount ?? 0);
  dbPoolIdle.set(pool?.idleCount ?? 0);
  dbPoolWaiting.set(pool?.waitingCount ?? 0);
}

/**
 * Get pool and query statistics
 */
export function getStats(): {
  totalQueries: number;
  successfulQueries: number;
  failedQueries: number;
  slowQueries: number;
  avgQueryTimeMs: string;
  poolSize: number;
  poolAvailable: number;
  poolWaiting: number;
  connectionAcquires: number;
  connectionErrors: number;
} {
  // Update Prometheus gauges when stats are retrieved
  updatePoolMetrics();
  
  const avgQueryTimeMs = stats.totalQueries > 0
    ? (Number(stats.totalQueryTimeNs / BigInt(stats.totalQueries)) / 1_000_000).toFixed(3)
    : '0.000';

  return {
    totalQueries: stats.totalQueries,
    successfulQueries: stats.successfulQueries,
    failedQueries: stats.failedQueries,
    slowQueries: stats.slowQueries,
    avgQueryTimeMs: `${avgQueryTimeMs}ms`,
    poolSize: pool?.totalCount ?? 0,
    poolAvailable: pool?.idleCount ?? 0,
    poolWaiting: pool?.waitingCount ?? 0,
    connectionAcquires: stats.connectionAcquires,
    connectionErrors: stats.connectionErrors
  };
}

/**
 * Close the database pool gracefully
 */
export async function closeDb(): Promise<void> {
  if (pool) {
    logger.info('Closing database connection pool...');
    await pool.end();
    pool = null;
    logger.info('Database connection pool closed');
  }
}

export default {
  initDb,
  query,
  queryWithCache,
  getClient,
  isHealthy,
  getStats,
  updatePoolMetrics,
  closeDb,
  dbMetrics
};

