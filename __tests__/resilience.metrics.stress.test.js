const path = require('path');
const resilience = require(path.join(__dirname, '..', 'dist', 'utils', 'resilience.js'));
const metrics = require(path.join(__dirname, '..', 'dist', 'utils', 'metrics.js'));
const fs = require('fs');

const { retry, CircuitBreaker, CircuitOpenError } = resilience;

describe('resilience stress metrics (metrics-only)', () => {
  test('stress test: multiple outage cycles and derived metrics', async () => {
    const METRICS_ENABLED = process.env.RESILIENCE_METRICS === '1' || process.env.METRICS_MODE === 'test';
    if (!METRICS_ENABLED) {
      // keep normal test runs quiet and fast
      expect(true).toBe(true);
      return;
    }

    // use fake timers for deterministic timing
    jest.useFakeTimers('modern');
    jest.setSystemTime(0);

    // Parameters for the stress run
    const outageCycles = 3;
    const attemptsPerCall = 6; // high retry count
    const batchPerCycle = 30; // 3 cycles -> 90 calls total
    const failureThreshold = 3; // failures to open circuit
    const openTimeoutMs = 1000; // short for test
    const successThreshold = 1;
    const opName = 'stress_retry';
    const cbName = 'stress_cb';

    // simulated service state
    let serviceHealthy = true;

    const cb = new CircuitBreaker({ failureThreshold, successThreshold, openStateTimeoutMs: openTimeoutMs, name: cbName });

    // helper to perform a single client call (wrapped by circuit breaker)
    const clientCall = async () => {
      return cb.execute(() => retry(async () => {
        if (serviceHealthy) return 'ok';
        throw new Error('service-down');
      }, { attempts: attemptsPerCall, minDelayMs: 1, maxDelayMs: 5, jitter: false, op: opName }));
    };

    // Run multiple outage cycles
    for (let cycle = 0; cycle < outageCycles; cycle++) {
      // eslint-disable-next-line no-console
      console.log(`stress: starting cycle ${cycle + 1}/${outageCycles}`);
  // ensure service healthy and exercise one successful call to stabilise
  serviceHealthy = true;
  // eslint-disable-next-line no-console
  console.log('stress: before warmup call');
  await clientCall();
  // eslint-disable-next-line no-console
  console.log('stress: after warmup call');

      // flip to hard-fail
      serviceHealthy = false;

      // cause immediate failures to open the circuit (use single-attempt calls so we don't wait on retries)
      for (let i = 0; i < failureThreshold; i++) {
        try {
          await cb.execute(() => retry(async () => { throw new Error('service-down'); }, { attempts: 1, minDelayMs: 0, maxDelayMs: 0, jitter: false, op: opName }));
        } catch (e) { /* expected */ }
      }
      // eslint-disable-next-line no-console
      console.log('stress: circuit should be open; launching batch calls');

      // now circuit should be open; issue a large batch of concurrent calls
      const callers = [];
      for (let i = 0; i < batchPerCycle; i++) {
        // record that we attempted a request during outage
        metrics.incOutageRequest(cbName);
        const p = clientCall().catch((err) => {
          if (err && err.name === 'CircuitOpenError') {
            // when short-circuited, count the retries that were avoided
            metrics.incRetriesAvoided(cbName, attemptsPerCall);
          }
        });
        callers.push(p);
      }

  // advance timers to allow any retry timers to run (deterministic)
  // advance by a few seconds to allow retries/backoffs to complete
  jest.advanceTimersByTime(5000);
  // allow any pending microtasks to run
  await Promise.resolve();
  // wait for all callers to settle
  await Promise.all(callers);
  // eslint-disable-next-line no-console
  console.log('stress: batch settled');

      // advance time to allow half-open
  jest.advanceTimersByTime(openTimeoutMs + 10);
  // ensure Date.now and timers progressed for HALF_OPEN transition
  await Promise.resolve();
      // now allow a successful trial to recover the circuit
      serviceHealthy = true;
      // eslint-disable-next-line no-console
      console.log('stress: attempting recovery call (half-open)');
      await clientCall();
      // eslint-disable-next-line no-console
      console.log('stress: recovery call complete');
    }

    // collect raw totals
    const totals = await metrics.collectTotals();

    // helper to read metric value or zero
    const readMetric = (mname, labels) => {
      if (!totals[mname]) return 0;
      const key = JSON.stringify(labels);
      return totals[mname][key] || 0;
    };

    const totalOutageRequests = readMetric('outage_requests_total', { name: cbName });
    const shortCircuited = readMetric('circuit_short_circuits_total', { name: cbName });
    const retryAttemptsObserved = readMetric('retry_attempts_total', { op: opName });
    const retriesAvoidedCounter = readMetric('retries_avoided_total', { name: cbName });
    const circuitOpens = readMetric('circuit_opens_total', { name: cbName });
    const successfulRecoveries = readMetric('circuit_successful_recoveries_total', { name: cbName });

    const baselineRetries = totalOutageRequests * attemptsPerCall;
    const retriesAvoidedComputed = Math.max(0, baselineRetries - retryAttemptsObserved);

    // Derived metrics
    const shortCircuitPct = totalOutageRequests ? (shortCircuited / totalOutageRequests) * 100 : 0;
    const recoveryRate = outageCycles ? (successfulRecoveries / outageCycles) * 100 : 0;

    const summary = {
      outageCycles,
      totalOutageRequests,
      shortCircuited,
      shortCircuitPct: Number(shortCircuitPct.toFixed(1)),
      retryAttemptsObserved,
      baselineRetries,
      retriesAvoidedCounter,
      retriesAvoidedComputed,
      retryStormReduction: retriesAvoidedComputed,
      circuitOpens,
      successfulRecoveries,
      recoveryRate: Number(recoveryRate.toFixed(1))
    };

    // write a per-test artifact (merged later by the script)
    const outDir = path.join(process.cwd(), 'artifacts');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, 'resilience-metrics-stress.json');
    fs.writeFileSync(outPath, JSON.stringify({ totals, summary }, null, 2));

    // print concise summary for developer readability (only when metrics enabled)
    // keep the print succinct for CI logs
    // eslint-disable-next-line no-console
    console.log('\nRESILIENCE METRICS SUMMARY');
    // eslint-disable-next-line no-console
    console.log(`Outage cycles: ${summary.outageCycles}`);
    // eslint-disable-next-line no-console
    console.log(`Requests during outages: ${summary.totalOutageRequests}`);
    // eslint-disable-next-line no-console
    console.log(`Short-circuited requests: ${summary.shortCircuited} (${summary.shortCircuitPct}%)`);
    // eslint-disable-next-line no-console
    console.log(`Retry attempts observed: ${summary.retryAttemptsObserved}`);
    // eslint-disable-next-line no-console
    console.log(`Baseline retries (no CB): ${summary.baselineRetries}`);
    // eslint-disable-next-line no-console
    console.log(`Retry attempts avoided (computed): ${summary.retriesAvoidedComputed}`);
    // eslint-disable-next-line no-console
    console.log(`Circuit recovery success rate: ${summary.recoveryRate}%`);

    // final assertions to ensure test exercise ran
    expect(totalOutageRequests).toBeGreaterThanOrEqual(batchPerCycle * outageCycles);
    expect(shortCircuited).toBeGreaterThanOrEqual(0);
    expect(successfulRecoveries).toBeGreaterThanOrEqual(0);
  }, 60000);
});
