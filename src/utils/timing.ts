/**
 * High-Resolution Timing Utilities
 * 
 * Provides precise timing measurements using process.hrtime.bigint()
 * for accurate performance benchmarking.
 */

/**
 * Timer class for measuring durations
 */
export class Timer {
  private startTime: bigint;
  private endTime: bigint | null = null;
  
  constructor() {
    this.startTime = process.hrtime.bigint();
  }
  
  /**
   * Stop the timer and return duration in nanoseconds
   */
  stop(): bigint {
    this.endTime = process.hrtime.bigint();
    return this.endTime - this.startTime;
  }
  
  /**
   * Get elapsed time in nanoseconds without stopping
   */
  elapsed(): bigint {
    return process.hrtime.bigint() - this.startTime;
  }
  
  /**
   * Get elapsed time in milliseconds
   */
  elapsedMs(): number {
    return Number(this.elapsed()) / 1_000_000;
  }
  
  /**
   * Get elapsed time in microseconds
   */
  elapsedUs(): number {
    return Number(this.elapsed()) / 1_000;
  }
  
  /**
   * Get duration in milliseconds (after stopping)
   */
  durationMs(): number {
    if (this.endTime === null) {
      this.stop();
    }
    return Number(this.endTime! - this.startTime) / 1_000_000;
  }
  
  /**
   * Get duration in microseconds (after stopping)
   */
  durationUs(): number {
    if (this.endTime === null) {
      this.stop();
    }
    return Number(this.endTime! - this.startTime) / 1_000;
  }
}

/**
 * Time an async operation and return the result with timing
 */
export async function timeAsync<T>(
  operation: () => Promise<T>
): Promise<{ result: T; timeNs: bigint; timeMs: number; timeUs: number }> {
  const timer = new Timer();
  const result = await operation();
  const timeNs = timer.stop();
  
  return {
    result,
    timeNs,
    timeMs: Number(timeNs) / 1_000_000,
    timeUs: Number(timeNs) / 1_000
  };
}

/**
 * Time a sync operation and return the result with timing
 */
export function timeSync<T>(
  operation: () => T
): { result: T; timeNs: bigint; timeMs: number; timeUs: number } {
  const timer = new Timer();
  const result = operation();
  const timeNs = timer.stop();
  
  return {
    result,
    timeNs,
    timeMs: Number(timeNs) / 1_000_000,
    timeUs: Number(timeNs) / 1_000
  };
}

/**
 * Format nanoseconds to a human-readable string
 */
export function formatDuration(ns: bigint): string {
  const nsNum = Number(ns);
  
  if (nsNum < 1_000) {
    return `${nsNum}ns`;
  } else if (nsNum < 1_000_000) {
    return `${(nsNum / 1_000).toFixed(2)}µs`;
  } else if (nsNum < 1_000_000_000) {
    return `${(nsNum / 1_000_000).toFixed(3)}ms`;
  } else {
    return `${(nsNum / 1_000_000_000).toFixed(3)}s`;
  }
}

/**
 * Calculate statistics from an array of timing measurements (in nanoseconds)
 */
export function calculateStats(timings: bigint[]): {
  count: number;
  minNs: bigint;
  maxNs: bigint;
  avgNs: bigint;
  medianNs: bigint;
  p95Ns: bigint;
  p99Ns: bigint;
  minMs: number;
  maxMs: number;
  avgMs: number;
  medianMs: number;
  p95Ms: number;
  p99Ms: number;
} {
  if (timings.length === 0) {
    const zero = BigInt(0);
    return {
      count: 0,
      minNs: zero, maxNs: zero, avgNs: zero, medianNs: zero, p95Ns: zero, p99Ns: zero,
      minMs: 0, maxMs: 0, avgMs: 0, medianMs: 0, p95Ms: 0, p99Ms: 0
    };
  }
  
  const sorted = [...timings].sort((a, b) => Number(a - b));
  const count = sorted.length;
  
  const minNs = sorted[0];
  const maxNs = sorted[count - 1];
  const avgNs = sorted.reduce((a, b) => a + b, BigInt(0)) / BigInt(count);
  const medianNs = sorted[Math.floor(count / 2)];
  const p95Ns = sorted[Math.floor(count * 0.95)];
  const p99Ns = sorted[Math.floor(count * 0.99)];
  
  return {
    count,
    minNs, maxNs, avgNs, medianNs, p95Ns, p99Ns,
    minMs: Number(minNs) / 1_000_000,
    maxMs: Number(maxNs) / 1_000_000,
    avgMs: Number(avgNs) / 1_000_000,
    medianMs: Number(medianNs) / 1_000_000,
    p95Ms: Number(p95Ns) / 1_000_000,
    p99Ms: Number(p99Ns) / 1_000_000
  };
}

export default {
  Timer,
  timeAsync,
  timeSync,
  formatDuration,
  calculateStats
};

