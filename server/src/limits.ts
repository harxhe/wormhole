/** Per-tunnel limits shared by the HTTP and TCP public listeners. */

export interface LimitDecision {
  allowed: boolean;
  /** Milliseconds until the next request may be accepted. */
  retryAfterMs: number;
}

/**
 * A small sliding-window limiter. `limit <= 0` disables limiting.
 *
 * It keeps at most `limit` timestamps, so memory stays bounded even when a
 * tunnel is hammered.
 */
export class SlidingWindowLimiter {
  private readonly timestamps: number[] = [];

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000
  ) {}

  take(now = Date.now()): LimitDecision {
    if (this.limit <= 0) return { allowed: true, retryAfterMs: 0 };

    while (this.timestamps.length > 0 && this.timestamps[0]! <= now - this.windowMs) {
      this.timestamps.shift();
    }
    if (this.timestamps.length < this.limit) {
      this.timestamps.push(now);
      return { allowed: true, retryAfterMs: 0 };
    }
    return {
      allowed: false,
      retryAfterMs: Math.max(1, this.timestamps[0]! + this.windowMs - now)
    };
  }
}

export type TunnelLimitCode = "TOO_MANY_STREAMS" | "RATE_LIMITED" | "TOO_MANY_TUNNELS";

/** Raised by a tunnel when a public stream cannot be opened. */
export class TunnelLimitError extends Error {
  readonly code: TunnelLimitCode;
  readonly retryAfterMs: number;

  constructor(code: TunnelLimitCode, message: string, retryAfterMs: number) {
    super(message);
    this.name = "TunnelLimitError";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}
