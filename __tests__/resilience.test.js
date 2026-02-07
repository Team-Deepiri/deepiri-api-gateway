const path = require('path');
const resilience = require(path.join(__dirname, '..', 'dist', 'utils', 'resilience.js'));
const metrics = require(path.join(__dirname, '..', 'dist', 'utils', 'metrics.js'));
const { retry, CircuitBreaker, CircuitOpenError } = resilience;

describe('resilience primitives', () => {
  test('retry succeeds after transient failures', async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      if (attempts < 3) throw new Error('transient');
      return 'ok';
    };

    const res = await retry(fn, { attempts: 4, minDelayMs: 1, maxDelayMs: 5, jitter: false, op: 'unit_retry' });
    expect(res).toBe('ok');
    expect(attempts).toBe(3);

    // If metrics enabled, assert counters
    if (process.env.RESILIENCE_METRICS === '1' || process.env.METRICS_MODE === 'test') {
      const totals = await metrics.collectTotals();
      // retry_attempts_total should have an entry for op 'unit_retry'
      const attemptsKey = JSON.stringify({ op: 'unit_retry' });
      expect(totals.retry_attempts_total[attemptsKey]).toBeGreaterThanOrEqual(3);
      expect(totals.retry_success_total[attemptsKey]).toBe(1);
      const fs = require('fs');
      const outDir = require('path').join(process.cwd(), 'artifacts');
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(require('path').join(outDir, 'resilience-metrics-resilience.json'), JSON.stringify(totals, null, 2));
    }
  });

  test('circuit breaker opens and recovers', async () => {
  const cb = new CircuitBreaker({ failureThreshold: 2, successThreshold: 1, openStateTimeoutMs: 100, name: 'unit_cb' });

    // cause failures
    await expect(cb.execute(async () => { throw new Error('boom'); })).rejects.toThrow();
    await expect(cb.execute(async () => { throw new Error('boom'); })).rejects.toThrow();

    // now circuit should be open and short-circuit
    await expect(cb.execute(async () => 'should-not-run')).rejects.toThrow();

    // wait for half-open timeout
    await new Promise(res => setTimeout(res, 150));

    // successful trial should close it
    const val = await cb.execute(async () => 'recovered');
    expect(val).toBe('recovered');

    if (process.env.RESILIENCE_METRICS === '1' || process.env.METRICS_MODE === 'test') {
      const totals = await metrics.collectTotals();
      const nameKey = JSON.stringify({ name: 'unit_cb' });
      expect(totals.circuit_opens_total[nameKey]).toBeGreaterThanOrEqual(1);
      expect(totals.circuit_short_circuits_total[nameKey]).toBeGreaterThanOrEqual(1);
      expect(totals.circuit_success_total[nameKey]).toBeGreaterThanOrEqual(1);
      const fs = require('fs');
      const outDir = require('path').join(process.cwd(), 'artifacts');
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(require('path').join(outDir, 'resilience-metrics-resilience.json'), JSON.stringify(totals, null, 2));
    }
  });
});
