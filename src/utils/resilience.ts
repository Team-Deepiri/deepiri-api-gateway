/**
 * Resilience helpers: retry with exponential backoff + simple circuit breaker
 */
export class CircuitOpenError extends Error {
  constructor(message = 'Circuit is open') {
    super(message);
    this.name = 'CircuitOpenError';
  }
}

import metrics from './metrics';

type CircuitOptions = {
  failureThreshold?: number; // failures to open
  successThreshold?: number; // successes to close when half-open
  openStateTimeoutMs?: number; // time to wait before trying half-open
  name?: string; // optional circuit name for metrics
};

export class CircuitBreaker {
  private name: string;
  private failureCount = 0;
  private successCount = 0;
  private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';
  private openUntil = 0;
  private readonly failureThreshold: number;
  private readonly successThreshold: number;
  private readonly openStateTimeoutMs: number;

  constructor(opts: CircuitOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.successThreshold = opts.successThreshold ?? 2;
    this.openStateTimeoutMs = opts.openStateTimeoutMs ?? 60_000; // 1min
    this.name = opts.name ?? 'default';
    // initialize metric state
    metrics.setCircuitState(this.name, 0);
  }

  public isOpen(): boolean {
    if (this.state === 'OPEN') {
      if (Date.now() > this.openUntil) {
        // move to HALF_OPEN and allow trial requests
        this.state = 'HALF_OPEN';
        this.successCount = 0;
        metrics.setCircuitState(this.name, 2);
        return false;
      }
      return true;
    }
    return false;
  }

  public async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.isOpen()) {
      // record short-circuit
      metrics.incCircuitShortCircuits(this.name);
      throw new CircuitOpenError();
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess() {
    if (this.state === 'HALF_OPEN') {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        this.reset();
        metrics.incCircuitSuccess(this.name);
      }
    } else if (this.state === 'CLOSED') {
      // success in closed state - nothing to do
      this.resetCounts();
      metrics.incCircuitSuccess(this.name);
    }
  }

  private onFailure() {
    this.failureCount++;
    if (this.failureCount >= this.failureThreshold) {
      this.open();
      metrics.incCircuitFailure(this.name);
    }
  }

  private open() {
    this.state = 'OPEN';
    this.openUntil = Date.now() + this.openStateTimeoutMs;
    this.failureCount = 0;
    this.successCount = 0;
    metrics.incCircuitOpens(this.name);
    metrics.setCircuitState(this.name, 1);
  }

  private reset() {
    this.state = 'CLOSED';
    this.resetCounts();
    metrics.setCircuitState(this.name, 0);
  }

  private resetCounts() {
    this.failureCount = 0;
    this.successCount = 0;
  }
}

// Retry helper with exponential backoff and jitter
export type RetryOptions = {
  attempts?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
  op?: string; // operation name for metrics
};

export async function retry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const minDelay = opts.minDelayMs ?? 100;
  const maxDelay = opts.maxDelayMs ?? 2000;
  const jitter = opts.jitter ?? true;
  const op = opts.op ?? 'default';

  let lastErr: any;
  for (let i = 1; i <= attempts; i++) {
    metrics.incRetryAttempt(op);
    try {
      const res = await fn();
      metrics.incRetrySuccess(op);
      return res;
    } catch (err) {
      metrics.incRetryFailure(op);
      lastErr = err;
      if (i === attempts) break;
      // exponential backoff
      const exp = Math.min(maxDelay, Math.round(minDelay * Math.pow(2, i - 1)));
      const wait = jitter ? Math.round(Math.random() * exp) : exp;
  await new Promise((res) => (globalThis as any).setTimeout(res, wait));
    }
  }
  throw lastErr;
}

export default { CircuitBreaker, CircuitOpenError, retry };
