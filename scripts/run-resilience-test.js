/*
  Simple smoke test for resilience utilities (retry + circuit breaker).
  This script imports the compiled JS from dist/ and performs small checks.
  Run after `npm run build`.
*/

const path = require('path');

const resilience = require(path.join(__dirname, '..', 'dist', 'utils', 'resilience.js'));
const { retry, CircuitBreaker, CircuitOpenError } = resilience;

async function testRetry() {
  let attempts = 0;
  const fn = async () => {
    attempts++;
    if (attempts < 3) {
      const e = new Error('fail');
      e.attempt = attempts;
      throw e;
    }
    return 'ok';
  };

  const res = await retry(fn, { attempts: 4, minDelayMs: 10, maxDelayMs: 50, jitter: false });
  if (res !== 'ok') throw new Error('retry did not return expected value');
  console.log('retry test passed (attempts:', attempts, ')');
}

async function testCircuitBreaker() {
  const cb = new CircuitBreaker({ failureThreshold: 2, successThreshold: 1, openStateTimeoutMs: 200 });

  // First two calls fail -> should open
  const failFn = async () => { throw new Error('boom'); };

  try { await cb.execute(failFn); } catch (e) { /* expected */ }
  try { await cb.execute(failFn); } catch (e) { /* expected */ }

  // Next call should be short-circuited (circuit open)
  let opened = false;
  try {
    await cb.execute(async () => 'should-not-run');
  } catch (err) {
    if (err instanceof CircuitOpenError || err && err.name === 'CircuitOpenError') {
      opened = true;
      console.log('circuit opened as expected');
    } else {
      throw err;
    }
  }
  if (!opened) throw new Error('circuit did not open');

  // Wait for open timeout to expire (half-open), then make a successful call
  await new Promise(res => setTimeout(res, 250));
  const val = await cb.execute(async () => 'recovered');
  if (val !== 'recovered') throw new Error('circuit did not recover');
  console.log('circuit breaker test passed');
}

async function run() {
  try {
    await testRetry();
    await testCircuitBreaker();
    console.log('\nALL RESILIENCE TESTS PASSED');
    process.exit(0);
  } catch (err) {
    console.error('Resilience smoke test FAILED:', err && err.stack ? err.stack : err);
    process.exit(1);
  }
}

run();
