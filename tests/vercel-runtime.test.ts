import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import healthz from "../api/healthz.js";
import mcp from "../api/mcp.js";
import readyz from "../api/readyz.js";
import type { AppConfig } from "../src/config/schema.js";
import { createVercelHandler } from "../src/runtimes/vercel.js";

it("rewrites canonical MCP and health paths", async () => {
  const config = JSON.parse(await readFile("vercel.json", "utf8"));

  expect(config.rewrites).toContainEqual({
    source: "/mcp",
    destination: "/api/mcp",
  });
  expect(config.rewrites).toContainEqual({
    source: "/healthz",
    destination: "/api/healthz",
  });
  expect(config.rewrites).toContainEqual({
    source: "/readyz",
    destination: "/api/readyz",
  });
});

it("keeps stateless GET and DELETE at 405", async () => {
  const handler = createVercelHandler({ config: testConfig() });

  expect((await handler(new Request("https://example.test/mcp"))).status).toBe(
    405,
  );
  expect(
    (
      await handler(
        new Request("https://example.test/mcp", { method: "DELETE" }),
      )
    ).status,
  ).toBe(405);
});

it("answers matching-origin preflight before bearer authentication and rate limiting", async () => {
  const rateLimiter = { take: vi.fn(async () => ({ allowed: true as const })) };
  const handler = createVercelHandler({
    config: testConfig(bearerAccess()),
    rateLimiter,
    mcpHandler: async () => new Response("{}"),
  });

  const response = await handler(
    new Request("https://example.test/mcp", {
      method: "OPTIONS",
      headers: { origin: "https://example.test" },
    }),
  );

  expect(response.status).toBe(204);
  expect(response.headers.get("access-control-allow-origin")).toBe(
    "https://example.test",
  );
  expect(rateLimiter.take).not.toHaveBeenCalled();
});

it("rejects a cross-origin MCP post before dispatch", async () => {
  const handler = createVercelHandler({
    config: testConfig(),
    mcpHandler: async () => new Response("{}"),
  });

  const response = await handler(
    new Request("https://example.test/mcp", {
      method: "POST",
      headers: { origin: "https://other.test" },
      body: "{}",
    }),
  );

  expect(response.status).toBe(400);
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
  await expect(response.json()).resolves.toEqual({
    code: "INVALID_INPUT",
    message: "Invalid origin",
  });
});

it("reflects an accepted POST origin on success and safe errors", async () => {
  const successHandler = createVercelHandler({
    config: testConfig(),
    mcpHandler: async () =>
      new Response("{}", { headers: { Vary: "Accept-Encoding" } }),
  });
  const success = await successHandler(
    new Request("https://example.test/mcp", {
      method: "POST",
      headers: { origin: "https://example.test" },
      body: "{}",
    }),
  );

  expect(success.headers.get("access-control-allow-origin")).toBe(
    "https://example.test",
  );
  expect(success.headers.get("vary")).toBe("Accept-Encoding, Origin");

  const errorHandler = createVercelHandler({
    config: testConfig(bearerAccess()),
    mcpHandler: async () => new Response("{}"),
  });
  const denied = await errorHandler(
    new Request("https://example.test/mcp", {
      method: "POST",
      headers: { origin: "https://example.test" },
      body: "{}",
    }),
  );

  expect(denied.status).toBe(401);
  expect(denied.headers.get("access-control-allow-origin")).toBe(
    "https://example.test",
  );
  expect(denied.headers.get("vary")).toBe("Origin");
});

it("propagates a Vercel request abort to an in-flight provider fetch", async () => {
  let upstreamSignal: AbortSignal | undefined;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const handler = createVercelHandler({
    config: testConfig(),
    dependencies: {
      fetch: async (_input, init) => {
        upstreamSignal = init?.signal ?? undefined;
        markStarted?.();
        return await new Promise<Response>((_resolve, reject) => {
          const fallback = setTimeout(
            () => reject(new Error("raw-vercel-provider-marker")),
            250,
          );
          upstreamSignal?.addEventListener(
            "abort",
            () => {
              clearTimeout(fallback);
              reject(new Error("raw-vercel-abort-marker"));
            },
            { once: true },
          );
        });
      },
    },
  });
  const controller = new AbortController();
  const pending = handler(
    new Request("https://example.test/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "search_posts", arguments: { query: "mcp" } },
      }),
      signal: controller.signal,
    }),
  ).catch(() => undefined);

  await started;
  controller.abort();
  await pending;
  await vi.waitFor(() => expect(upstreamSignal?.aborted).toBe(true));
});

it("requires bearer credentials before MCP dispatch", async () => {
  const handler = createVercelHandler({
    config: testConfig(bearerAccess()),
    mcpHandler: async () => new Response("{}"),
  });

  const response = await handler(
    new Request("https://example.test/mcp", { method: "POST", body: "{}" }),
  );

  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate")).toBe("Bearer");
});

it("sanitizes unexpected Vercel MCP errors", async () => {
  const handler = createVercelHandler({
    config: testConfig(),
    mcpHandler: async () => {
      throw new Error("provider token should not be exposed");
    },
  });

  const response = await handler(
    new Request("https://example.test/mcp", { method: "POST", body: "{}" }),
  );

  expect(response.status).toBe(500);
  await expect(response.json()).resolves.toEqual({
    code: "UPSTREAM_UNAVAILABLE",
    message: "Request could not be completed",
  });
});

it("limits requests independently per Vercel handler instance", async () => {
  const config = testConfig(undefined, {
    enabled: true,
    limit: 1,
    window: "1m",
  });
  const mcpHandler = async () => new Response("{}");
  const first = createVercelHandler({ config, mcpHandler });
  const second = createVercelHandler({ config, mcpHandler });

  expect(
    (await first(new Request("https://example.test/mcp", { method: "POST" })))
      .status,
  ).toBe(200);
  expect(
    (await first(new Request("https://example.test/mcp", { method: "POST" })))
      .status,
  ).toBe(429);
  expect(
    (await second(new Request("https://example.test/mcp", { method: "POST" })))
      .status,
  ).toBe(200);
});

it("exports Vercel Web-function default handlers", async () => {
  expect(mcp.fetch).toBeTypeOf("function");
  expect(healthz.fetch).toBeTypeOf("function");
  expect(readyz.fetch).toBeTypeOf("function");

  expect(
    (await mcp.fetch(new Request("https://example.test/api/mcp"))).status,
  ).toBe(405);
  await expect(
    healthz
      .fetch(new Request("https://example.test/api/healthz"))
      .then((response) => response.json()),
  ).resolves.toMatchObject({
    service: "twitter-search-mcp",
    ready: true,
  });
  await expect(
    readyz
      .fetch(new Request("https://example.test/api/readyz"))
      .then((response) => response.json()),
  ).resolves.toMatchObject({
    service: "twitter-search-mcp",
    ready: true,
  });
});

function testConfig(
  access: AppConfig["access"] = { mode: "anonymous", token: "" },
  ratelimit: AppConfig["ratelimit"] = {
    enabled: false,
    limit: 60,
    window: "1m",
  },
): AppConfig {
  return {
    version: 1,
    access,
    search: { default_provider: "twitee", allow_provider_override: true },
    providers: {
      twitee: { enabled: true, base_url: "https://twitee.test", token: "" },
      x: { enabled: false, base_url: "https://x.test", token: "" },
    },
    ratelimit,
  };
}

function bearerAccess(): AppConfig["access"] {
  return { mode: "bearer", token: crypto.randomUUID() };
}
