import { expect, it } from "vitest";
import { MemoryRateLimiter, type RateLimiter } from "../src/core/ratelimit.js";

it("rejects after the per-process limit", async () => {
  const limiter = new MemoryRateLimiter({
    limit: 2,
    windowMs: 60_000,
    now: () => 0,
  });

  expect((await limiter.take("client")).allowed).toBe(true);
  expect((await limiter.take("client")).allowed).toBe(true);
  expect(await limiter.take("client")).toMatchObject({
    allowed: false,
    retryAfterSeconds: 60,
  });
});

it("limits each client key independently", async () => {
  const limiter = new MemoryRateLimiter({ limit: 1, windowMs: 60_000 });

  await limiter.take("first");
  expect(await limiter.take("second")).toEqual({ allowed: true });
});

it("expires a fixed window and admits requests in the next window", async () => {
  let now = 0;
  const limiter: RateLimiter = new MemoryRateLimiter({
    limit: 1,
    windowMs: 60_000,
    now: () => now,
  });

  await limiter.take("client");
  now = 60_000;
  expect(await limiter.take("client")).toEqual({ allowed: true });
});
