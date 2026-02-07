import promClient from 'prom-client';
import fs from 'fs';

const ENABLED = process.env.RESILIENCE_METRICS === '1' || process.env.METRICS_MODE === 'test';

const registry = new promClient.Registry();

let retryAttempts: promClient.Counter<string> | undefined;
let retrySuccess: promClient.Counter<string> | undefined;
let retryFailure: promClient.Counter<string> | undefined;

let circuitState: promClient.Gauge<string> | undefined;
let circuitOpens: promClient.Counter<string> | undefined;
let circuitShortCircuits: promClient.Counter<string> | undefined;
let circuitSuccess: promClient.Counter<string> | undefined;
let circuitFailure: promClient.Counter<string> | undefined;
// NOTE: Test-only counters were removed per user request. Keep core counters above.

function initIfNeeded() {
  if (!ENABLED) return;
  if (retryAttempts) return;

  retryAttempts = new promClient.Counter({ name: 'retry_attempts_total', help: 'Retry attempts', labelNames: ['op'] });
  retrySuccess = new promClient.Counter({ name: 'retry_success_total', help: 'Retry successes', labelNames: ['op'] });
  retryFailure = new promClient.Counter({ name: 'retry_failure_total', help: 'Retry failures', labelNames: ['op'] });

  circuitState = new promClient.Gauge({ name: 'circuit_state', help: 'Circuit state 0=closed 1=open 2=half-open', labelNames: ['name'] });
  circuitOpens = new promClient.Counter({ name: 'circuit_opens_total', help: 'Circuit opens', labelNames: ['name'] });
  circuitShortCircuits = new promClient.Counter({ name: 'circuit_short_circuits_total', help: 'Short-circuited calls', labelNames: ['name'] });
  circuitSuccess = new promClient.Counter({ name: 'circuit_success_total', help: 'Circuit success', labelNames: ['name'] });
  circuitFailure = new promClient.Counter({ name: 'circuit_failure_total', help: 'Circuit failure', labelNames: ['name'] });
  // test-only counters removed

  registry.registerMetric(retryAttempts);
  registry.registerMetric(retrySuccess);
  registry.registerMetric(retryFailure);
  registry.registerMetric(circuitState);
  registry.registerMetric(circuitOpens);
  registry.registerMetric(circuitShortCircuits);
  registry.registerMetric(circuitSuccess);
  registry.registerMetric(circuitFailure);
  // test-only counters removed
}

export function reset() {
  if (!ENABLED) return;
  // reset metrics by creating new registry and re-init
  promClient.register.clear();
  registry.clear();
  // recreate metric instances
  // (for simplicity, just set to undefined and re-init when next used)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  retryAttempts = undefined;
  retrySuccess = undefined;
  retryFailure = undefined;
  circuitState = undefined;
  circuitOpens = undefined;
  circuitShortCircuits = undefined;
  circuitSuccess = undefined;
  circuitFailure = undefined;
  initIfNeeded();
}

export function incRetryAttempt(op: string) {
  if (!ENABLED) return;
  initIfNeeded();
  retryAttempts!.inc({ op }, 1);
}

export function incRetrySuccess(op: string) {
  if (!ENABLED) return;
  initIfNeeded();
  retrySuccess!.inc({ op }, 1);
}

export function incRetryFailure(op: string) {
  if (!ENABLED) return;
  initIfNeeded();
  retryFailure!.inc({ op }, 1);
}

export function setCircuitState(name: string, state: number) {
  if (!ENABLED) return;
  initIfNeeded();
  circuitState!.set({ name }, state);
}

export function incCircuitOpens(name: string) {
  if (!ENABLED) return;
  initIfNeeded();
  circuitOpens!.inc({ name }, 1);
}

export function incCircuitShortCircuits(name: string) {
  if (!ENABLED) return;
  initIfNeeded();
  circuitShortCircuits!.inc({ name }, 1);
}

export function incCircuitSuccess(name: string) {
  if (!ENABLED) return;
  initIfNeeded();
  circuitSuccess!.inc({ name }, 1);
}

export function incCircuitFailure(name: string) {
  if (!ENABLED) return;
  initIfNeeded();
  circuitFailure!.inc({ name }, 1);
}
// (test-only helpers removed)

export async function collectTotals() {
  if (!ENABLED) return {};
  const out: any = {};
  const m = await registry.getMetricsAsJSON();
  for (const metric of m) {
    const name = metric.name;
    out[name] = {};
    for (const val of metric.values) {
      const labelsKey = Object.keys(val.labels).length ? JSON.stringify(val.labels) : '{}';
      out[name][labelsKey] = val.value;
    }
  }
  return out;
}

// ensure init when module loaded if enabled
initIfNeeded();

export default {
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
