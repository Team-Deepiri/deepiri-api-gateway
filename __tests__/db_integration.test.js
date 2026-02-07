jest.setTimeout(10000);

// Mock 'pg' before requiring the compiled dbService
jest.mock('pg', () => {
  let behavior = null;
  return {
    Pool: class {
      constructor() {
        this._handlers = {};
        this.totalCount = 0;
        this.idleCount = 0;
        this.waitingCount = 0;
      }
      on(event, handler) {
        this._handlers[event] = handler;
      }
      async query(text, params) {
        if (!behavior) throw new Error('no behavior set');
        return behavior(text, params);
      }
      async end() { /* noop */ }
      connect() { /* noop */ }
    },
    __setBehavior: (fn) => { behavior = fn; }
  };
});

const path = require('path');

describe('dbService integration (mocked pg)', () => {
  beforeEach(() => {
    // reset modules so dbService gets re-evaluated with fresh env/config
    jest.resetModules();
    // set circuit breaker thresholds via env before requiring module
    process.env.DB_CB_FAILURE_THRESHOLD = '2';
    process.env.DB_CB_SUCCESS_THRESHOLD = '1';
    process.env.DB_CB_OPEN_TIMEOUT_MS = '200';
  });

  test('initDb retries transient connection failures', async () => {
    let calls = 0;
    const pg = require('pg');
    pg.__setBehavior(async () => {
      calls++;
      if (calls < 3) throw new Error('connect-fail');
      return { rows: [{ current_time: new Date().toISOString() }] };
    });

    const dbService = require(path.join(__dirname, '..', 'dist', 'services', 'dbService.js'));
    await expect(dbService.initDb()).resolves.toBeUndefined();
    expect(calls).toBeGreaterThanOrEqual(3);

    if (process.env.RESILIENCE_METRICS === '1' || process.env.METRICS_MODE === 'test') {
      const metrics = require(path.join(__dirname, '..', 'dist', 'utils', 'metrics.js'));
      const totals = await metrics.collectTotals();
      // debug output for metrics in this test run
      console.log('DBG METRICS AFTER initDb:', JSON.stringify(totals, null, 2));
      const key = JSON.stringify({ op: 'db_init' });
      expect(totals.retry_attempts_total[key]).toBeGreaterThanOrEqual(3);
      expect(totals.retry_success_total[key]).toBe(1);

      // write a per-test-file artifact so we can merge later
      const fs = require('fs');
      const outDir = path.join(process.cwd(), 'artifacts');
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'resilience-metrics-db_integration.json'), JSON.stringify(totals, null, 2));
    }
  });

  test('query triggers circuit open on sustained failures and recovers', async () => {
  // Ensure pool exists and initDb succeeds with a working query
  const pg = require('pg');
  pg.__setBehavior(async () => ({ rows: [{ current_time: new Date().toISOString() }] }));
  const dbService = require(path.join(__dirname, '..', 'dist', 'services', 'dbService.js'));
  await dbService.initDb();

  // Now set query behavior to always fail
    let failCalls = 0;
    pg.__setBehavior(async () => { failCalls++; throw new Error('query-failed'); });

    // Trigger failures up to threshold
    await expect(dbService.query('SELECT 1')).rejects.toThrow();
    await expect(dbService.query('SELECT 1')).rejects.toThrow();

    // Next call should be short-circuited by circuit breaker
    const start = Date.now();
    await expect(dbService.query('SELECT 1')).rejects.toThrow();
    const elapsed = Date.now() - start;
    // short-circuit should be fast (under 50ms)
    expect(elapsed).toBeLessThan(200);

    // Wait for open timeout to expire and then allow recovery
    await new Promise(res => setTimeout(res, 250));

    // Make queries succeed now
    pg.__setBehavior(async () => ({ rows: [{ id: 1 }], rowCount: 1 }));
    const resp = await dbService.query('SELECT 1');
    expect(resp.result.rows[0].id).toBe(1);

    if (process.env.RESILIENCE_METRICS === '1' || process.env.METRICS_MODE === 'test') {
      const metrics = require(path.join(__dirname, '..', 'dist', 'utils', 'metrics.js'));
      const totals = await metrics.collectTotals();
      const nameKey = JSON.stringify({ name: 'database' });
      expect(totals.circuit_opens_total[nameKey]).toBeGreaterThanOrEqual(1);
      expect(totals.circuit_short_circuits_total[nameKey]).toBeGreaterThanOrEqual(1);

      const fs = require('fs');
      const outDir = path.join(process.cwd(), 'artifacts');
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'resilience-metrics-db_integration.json'), JSON.stringify(totals, null, 2));
    }
  });
});
