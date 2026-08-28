import { expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config/schema.js";
import { createCloudflareWorker } from "../src/runtimes/cloudflare.js";

it("keeps health and preflight outside bearer authentication and rate limiting", async () => {
  const limiter = { limit: vi.fn(async () => ({ success: true })) };
  const worker = createCloudflareWorker({
    config: testConfig(crypto.randomUUID()),
    mcpHandler: handler,
  });

  expect(
    (
      await worker.fetch(new Request("https://worker.test/healthz"), {
        MCP_RATE_LIMITER: limiter,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await worker.fetch(
        new Request("https://worker.test/mcp", {
          method: "OPTIONS",
          headers: { origin: "https://worker.test" },
        }),
        { MCP_RATE_LIMITER: limiter },
      )
    ).status,
  ).toBe(204);
  expect(limiter.limit).not.toHaveBeenCalled();
});

it("uses the native limiter after origin and bearer gates", async () => {
  const accessToken = crypto.randomUUID();
  const limiter = { limit: vi.fn(async () => ({ success: false })) };
  const worker = createCloudflareWorker({
    config: testConfig(accessToken),
    mcpHandler: handler,
  });

  const response = await worker.fetch(
    new Request("https://worker.test/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "cf-connecting-ip": "203.0.113.10",
      },
      body: "{}",
    }),
    { MCP_RATE_LIMITER: limiter },
  );

  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBe("60");
  expect(limiter.limit).toHaveBeenCalledWith({
    key: await tokenDigest(accessToken),
  });
});

it("rejects non-POST MCP methods and does not expose an SSE route", async () => {
  const worker = createCloudflareWorker({
    config: testConfig(crypto.randomUUID()),
    mcpHandler: handler,
  });

  expect(
    (await worker.fetch(new Request("https://worker.test/mcp"), {})).status,
  ).toBe(405);
  expect(
    (
      await worker.fetch(
        new Request("https://worker.test/mcp", { method: "DELETE" }),
        {},
      )
    ).status,
  ).toBe(405);
  expect(
    (await worker.fetch(new Request("https://worker.test/sse"), {})).status,
  ).toBe(404);
});

const handler = {
  fetch: async (): Promise<Response> =>
    new Response("{}", { headers: { "content-type": "application/json" } }),
};

function testConfig(accessToken: string): AppConfig {
  return {
    version: 1,
    access: { mode: "bearer", token: accessToken },
    search: { default_provider: "twitee", allow_provider_override: true },
    providers: {
      twitee: { enabled: true, base_url: "https://twitee.test", token: "" },
      x: { enabled: false, base_url: "https://x.test", token: "" },
    },
    ratelimit: { enabled: true, limit: 1, window: "1m" },
  };
}

async function tokenDigest(token: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
