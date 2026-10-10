export interface BackoffOptions {
  /** First retry delay (default 1000 ms). */
  initialDelayMs?: number;
  /** Upper bound for any delay (default 30000 ms). */
  maxDelayMs?: number;
  /** Growth factor per attempt (default 2). */
  factor?: number;
  /** Random spread, 0..1, so many clients don't retry in lockstep (default 0.2). */
  jitter?: number;
}

/**
 * Exponential backoff: 1s, 2s, 4s, 8s, … capped at `maxDelayMs`, each with
 * ±`jitter` random spread. `reset()` after a successful connection.
 */
export class Backoff {
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly factor: number;
  private readonly jitter: number;
  private attempt = 0;

  constructor(options: BackoffOptions = {}) {
    this.initialDelayMs = options.initialDelayMs ?? 1000;
    this.maxDelayMs = options.maxDelayMs ?? 30_000;
    this.factor = options.factor ?? 2;
    this.jitter = options.jitter ?? 0.2;
  }

  /** Number of delays handed out since the last reset. */
  get attempts(): number {
    return this.attempt;
  }

  /** Delay before the next attempt, in milliseconds. */
  next(random: () => number = Math.random): number {
    const base = Math.min(this.maxDelayMs, this.initialDelayMs * this.factor ** this.attempt);
    this.attempt += 1;
    const spread = base * this.jitter * (random() * 2 - 1);
    return Math.max(0, Math.round(Math.min(this.maxDelayMs, base + spread)));
  }

  reset(): void {
    this.attempt = 0;
  }
}
