export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

export interface RateLimiter {
  take(key: string): Promise<RateLimitDecision>;
}

export type MemoryRateLimiterOptions = {
  readonly limit: number;
  readonly windowMs: number;
  readonly now?: () => number;
};

type Counter = {
  readonly windowStart: number;
  count: number;
};

export class MemoryRateLimiter implements RateLimiter {
  private readonly counters = new Map<string, Counter>();
  private readonly now: () => number;

  constructor(private readonly options: MemoryRateLimiterOptions) {
    this.now = options.now ?? Date.now;
  }

  async take(key: string): Promise<RateLimitDecision> {
    const now = this.now();
    const windowStart =
      Math.floor(now / this.options.windowMs) * this.options.windowMs;

    this.expire(now);
    const counter = this.counters.get(key);
    if (counter?.windowStart === windowStart) {
      if (counter.count >= this.options.limit) {
        return {
          allowed: false,
          retryAfterSeconds: Math.ceil(
            (windowStart + this.options.windowMs - now) / 1000,
          ),
        };
      }
      counter.count += 1;
      return { allowed: true };
    }

    this.counters.set(key, { windowStart, count: 1 });
    return { allowed: true };
  }

  private expire(now: number): void {
    for (const [key, counter] of this.counters) {
      if (counter.windowStart + this.options.windowMs <= now) {
        this.counters.delete(key);
      }
    }
  }
}
