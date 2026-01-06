// Performance test: Redis cache vs Direct DB queries
const { createClient } = require('redis');
const { Pool } = require('pg');

// Use Docker hostnames if DOCKER env var is set, otherwise localhost
const isDocker = process.env.DOCKER === 'true';
const REDIS_URL = isDocker 
  ? 'redis://:redispassword@deepiri-redis-backend:6379'
  : 'redis://:redispassword@localhost:6380';
const DB_HOST = isDocker ? 'deepiri-postgres-backend' : 'localhost';

async function test() {
  console.log('\n=== REDIS + DB PERFORMANCE TEST ===\n');
  
  // Connect Redis (with password)
  const redis = createClient({ url: REDIS_URL });
  await redis.connect();
  console.log('✅ Redis connected');
  
  // Connect PostgreSQL
  const pool = new Pool({
    host: DB_HOST,
    port: 5432,
    database: 'deepiri',
    user: 'deepiri',
    password: 'deepiripassword',
    max: 10
  });
  await pool.query('SELECT 1');
  console.log('✅ PostgreSQL connected\n');
  
  // Performance test
  const iterations = 10;
  const dbTimes = [];
  const cacheTimes = [];
  
  // Test 1: Direct DB queries (uncached)
  console.log(`Running ${iterations} DATABASE queries...`);
  for (let i = 0; i < iterations; i++) {
    const start = process.hrtime.bigint();
    await pool.query('SELECT NOW(), pg_database_size(current_database())');
    const ms = Number(process.hrtime.bigint() - start) / 1_000_000;
    dbTimes.push(ms);
  }
  
  // Cache a result
  const result = await pool.query('SELECT NOW() as ts');
  await redis.setEx('test:cached', 60, JSON.stringify(result.rows[0]));
  
  // Test 2: Redis cache reads
  console.log(`Running ${iterations} REDIS CACHE reads...\n`);
  for (let i = 0; i < iterations; i++) {
    const start = process.hrtime.bigint();
    await redis.get('test:cached');
    const ms = Number(process.hrtime.bigint() - start) / 1_000_000;
    cacheTimes.push(ms);
  }
  
  // Calculate stats
  const avgDb = dbTimes.reduce((a,b) => a+b) / iterations;
  const avgCache = cacheTimes.reduce((a,b) => a+b) / iterations;
  
  console.log('📊 RESULTS:');
  console.log('─────────────────────────────────────');
  console.log(`DATABASE (direct):  ${avgDb.toFixed(3)} ms avg`);
  console.log(`REDIS CACHE:        ${avgCache.toFixed(3)} ms avg`);
  console.log('─────────────────────────────────────');
  console.log(`🚀 IMPROVEMENT:     ${(avgDb/avgCache).toFixed(1)}x faster`);
  console.log(`💾 SAVED:           ${(avgDb-avgCache).toFixed(3)} ms/request\n`);
  
  await redis.quit();
  await pool.end();
}

test().catch(e => { console.error('Error:', e.message); process.exit(1); });

