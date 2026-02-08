import fs from 'fs';

// This module avoids importing ESM-only `prom-client` at module load time so Jest (CJS)
// can require this file during test discovery. Metrics are enabled explicitly by
// calling `enableMetrics()` which dynamically imports `prom-client` at runtime.

const AUTO_ENABLED = process.env.RESILIENCE_METRICS === '1' || process.env.METRICS_MODE === 'test';

let promClient: any = null;
let registry: any = null;

// placeholder implementations (use fallback counters) until metrics are enabled
let incRetryAttemptImpl = (op: string) => { bumpFallback('retry_attempts_total', { op }); };
let incRetrySuccessImpl = (op: string) => { bumpFallback('retry_success_total', { op }); };
let incRetryFailureImpl = (op: string) => { bumpFallback('retry_failure_total', { op }); };
let setCircuitStateImpl = (name: string, state: number) => { /* gauge - store as gauge value */ bumpFallback('circuit_state', { name }, state); };
let incCircuitOpensImpl = (name: string) => { bumpFallback('circuit_opens_total', { name }); };
let incCircuitShortCircuitsImpl = (name: string) => { bumpFallback('circuit_short_circuits_total', { name }); };
let incCircuitSuccessImpl = (name: string) => { bumpFallback('circuit_success_total', { name }); };
let incCircuitFailureImpl = (name: string) => { bumpFallback('circuit_failure_total', { name }); };
let incOutageRequestImpl = (name: string) => { bumpFallback('outage_requests_total', { name }); };
let incRetriesAvoidedImpl = (name: string, count = 1) => { bumpFallback('retries_avoided_total', { name }, count); };
let incSuccessfulRecoveriesImpl = (name: string) => { bumpFallback('circuit_successful_recoveries_total', { name }); };

let initialized = false;

// Fallback plain-JS counters for environments where prom-client isn't
// available yet or during test reset/re-init cycles. Keys are metricName -> labelsKey -> value
const fallbackCounters: { [metric: string]: { [labelsKey: string]: number } } = {};

function bumpFallback(metric: string, labels: Record<string, any> | undefined, by = 1) {
  const lblKey = labels && Object.keys(labels).length ? JSON.stringify(labels) : '{}';
  fallbackCounters[metric] = fallbackCounters[metric] || {};
  fallbackCounters[metric][lblKey] = (fallbackCounters[metric][lblKey] || 0) + by;
}

async function initPromClient() {
  if (initialized) return;
  // dynamic import to avoid ESM/CJS issues at module load time
  const mod = await import('prom-client');
  const p = (mod && (mod as any).default) ? (mod as any).default : mod;
  promClient = p;

  const { Registry, Counter, Gauge } = promClient;
  registry = new Registry();

  const retryAttempts = new Counter({ name: 'retry_attempts_total', help: 'Retry attempts', labelNames: ['op'] });
  const retrySuccess = new Counter({ name: 'retry_success_total', help: 'Retry successes', labelNames: ['op'] });
  const retryFailure = new Counter({ name: 'retry_failure_total', help: 'Retry failures', labelNames: ['op'] });

  const circuitState = new Gauge({ name: 'circuit_state', help: 'Circuit state 0=closed 1=open 2=half-open', labelNames: ['name'] });
  const circuitOpens = new Counter({ name: 'circuit_opens_total', help: 'Circuit opens', labelNames: ['name'] });
  const circuitShortCircuits = new Counter({ name: 'circuit_short_circuits_total', help: 'Short-circuited calls', labelNames: ['name'] });
  const circuitSuccess = new Counter({ name: 'circuit_success_total', help: 'Circuit success', labelNames: ['name'] });
  const circuitFailure = new Counter({ name: 'circuit_failure_total', help: 'Circuit failure', labelNames: ['name'] });
  const outageRequests = new Counter({ name: 'outage_requests_total', help: 'Requests attempted during outages', labelNames: ['name'] });
  const retriesAvoided = new Counter({ name: 'retries_avoided_total', help: 'Retries avoided due to circuit short-circuit', labelNames: ['name'] });
  const successfulRecoveries = new Counter({ name: 'circuit_successful_recoveries_total', help: 'Successful recoveries (half-open -> closed)', labelNames: ['name'] });

  registry.registerMetric(retryAttempts);
  registry.registerMetric(retrySuccess);
  registry.registerMetric(retryFailure);
  registry.registerMetric(circuitState);
  registry.registerMetric(circuitOpens);
  registry.registerMetric(circuitShortCircuits);
  registry.registerMetric(circuitSuccess);
  registry.registerMetric(circuitFailure);
  registry.registerMetric(outageRequests);
  registry.registerMetric(retriesAvoided);
  registry.registerMetric(successfulRecoveries);

  // Migrate any fallback counts into the real counters so we don't lose
  // increments that happened before prom-client was ready. Then clear fallback.
  try {
    const migrate = (metric: any, metricName: string) => {
      const existing = fallbackCounters[metricName] || {};
      for (const lblKey of Object.keys(existing)) {
        const labels = lblKey === '{}' ? {} : JSON.parse(lblKey);
        const val = existing[lblKey] || 0;
        if (val) {
          if (metric && typeof metric.inc === 'function') {
            metric.inc(labels, val);
          } else if (metric && typeof metric.set === 'function') {
            metric.set(labels, val);
          }
        }
      }
      delete fallbackCounters[metricName];
    };

    migrate(retryAttempts, 'retry_attempts_total');
    migrate(retrySuccess, 'retry_success_total');
    migrate(retryFailure, 'retry_failure_total');
    migrate(circuitState, 'circuit_state');
    migrate(circuitOpens, 'circuit_opens_total');
    migrate(circuitShortCircuits, 'circuit_short_circuits_total');
    migrate(circuitSuccess, 'circuit_success_total');
    migrate(circuitFailure, 'circuit_failure_total');
    migrate(outageRequests, 'outage_requests_total');
    migrate(retriesAvoided, 'retries_avoided_total');
    migrate(successfulRecoveries, 'circuit_successful_recoveries_total');
  } catch (err) {
    // ignore migration errors
  }

  // wire implementations
  incRetryAttemptImpl = (op: string) => retryAttempts.inc({ op }, 1);
  incRetrySuccessImpl = (op: string) => retrySuccess.inc({ op }, 1);
  incRetryFailureImpl = (op: string) => retryFailure.inc({ op }, 1);
  setCircuitStateImpl = (name: string, state: number) => circuitState.set({ name }, state);
  incCircuitOpensImpl = (name: string) => circuitOpens.inc({ name }, 1);
  incCircuitShortCircuitsImpl = (name: string) => circuitShortCircuits.inc({ name }, 1);
  incCircuitSuccessImpl = (name: string) => circuitSuccess.inc({ name }, 1);
  incCircuitFailureImpl = (name: string) => circuitFailure.inc({ name }, 1);
  incOutageRequestImpl = (n: string) => outageRequests.inc({ name: n }, 1);
  incRetriesAvoidedImpl = (n: string, count = 1) => retriesAvoided.inc({ name: n }, count);
  incSuccessfulRecoveriesImpl = (n: string) => successfulRecoveries.inc({ name: n }, 1);

  initialized = true;
}

/**
 * Enable metrics (dynamically imports prom-client). Call this at application
 * startup when you want metrics to be active. Tests need not call this.
 */
export async function enableMetrics() {
  if (initialized) return;
  await initPromClient();
}

export async function reset() {
  // ensure prom-client is loaded
  if (!initialized) {
    try { await enableMetrics(); } catch (e) { return; }
  }

  // Prefer resetting metric values if the registry supports it.
  try {
    if (registry && typeof registry.resetMetrics === 'function') {
      registry.resetMetrics();
      return;
    }
    if (promClient && promClient.register && typeof promClient.register.resetMetrics === 'function') {
      promClient.register.resetMetrics();
      return;
    }
  } catch (err) {
    // ignore and fall through to clear/re-init as fallback
  }

  // Fallback: clear global register and re-init to avoid duplicate metric registration errors
  try {
    if (promClient && promClient.register && typeof promClient.register.clear === 'function') {
      promClient.register.clear();
    }
  } catch (err) {
    // ignore
  }
  // clear fallback counters as well between tests
  for (const k of Object.keys(fallbackCounters)) delete fallbackCounters[k];
  // re-init
  initialized = false;
  await initPromClient();
}

export function incRetryAttempt(op: string) {
  try { incRetryAttemptImpl(op); } catch (e) { /* noop on failure */ }
}

export function incRetrySuccess(op: string) {
  try { incRetrySuccessImpl(op); } catch (e) { /* noop */ }
}

export function incRetryFailure(op: string) {
  try { incRetryFailureImpl(op); } catch (e) { /* noop */ }
}

export function setCircuitState(name: string, state: number) {
  try { setCircuitStateImpl(name, state); } catch (e) { /* noop */ }
}

export function incCircuitOpens(name: string) {
  try { incCircuitOpensImpl(name); } catch (e) { /* noop */ }
}

export function incCircuitShortCircuits(name: string) {
  try { incCircuitShortCircuitsImpl(name); } catch (e) { /* noop */ }
}

export function incCircuitSuccess(name: string) {
  try { incCircuitSuccessImpl(name); } catch (e) { /* noop */ }
}

export function incCircuitFailure(name: string) {
  try { incCircuitFailureImpl(name); } catch (e) { /* noop */ }
}

export function incOutageRequest(name: string) {
  try { incOutageRequestImpl(name); } catch (e) { /* noop */ }
}

export function incRetriesAvoided(name: string, count = 1) {
  try { incRetriesAvoidedImpl(name, count); } catch (e) { /* noop */ }
}

export function incSuccessfulRecovery(name: string) {
  try { incSuccessfulRecoveriesImpl(name); } catch (e) { /* noop */ }
}

export async function collectTotals() {
  // include fallback counters even if prom-client hasn't been initialized yet
  const out: any = {};
  for (const metricName of Object.keys(fallbackCounters)) {
    out[metricName] = out[metricName] || {};
    const labels = fallbackCounters[metricName] || {};
    for (const lbl of Object.keys(labels)) out[metricName][lbl] = labels[lbl] || 0;
  }

  if (!initialized) return out;
  const m = await registry.getMetricsAsJSON();
  for (const metric of m) {
    const name = metric.name;
    out[name] = out[name] || {};
    for (const val of metric.values) {
      const labelsKey = Object.keys(val.labels).length ? JSON.stringify(val.labels) : '{}';
      out[name][labelsKey] = val.value;
    }
  }
  return out;
}

// Auto-enable if the environment requests metrics at startup (but do not import prom-client synchronously)
if (AUTO_ENABLED) {
  // fire-and-forget; tests that rely on metrics should call enableMetrics explicitly in setup
  enableMetrics().catch(() => {
    // leave metrics as no-op on failure
  });
}

export default {
  enableMetrics,
  reset,
  incRetryAttempt,
  incRetrySuccess,
  incRetryFailure,
  setCircuitState,
  incCircuitOpens,
  incCircuitShortCircuits,
  incCircuitSuccess,
  incCircuitFailure,
  collectTotals
};
