import { readFile } from "node:fs/promises";
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

it("fails readiness and MCP POST closed when an enabled binding is absent", async () => {
  const accessToken = crypto.randomUUID();
  const mcpHandler = { fetch: vi.fn(handler.fetch) };
  const worker = createCloudflareWorker({
    config: testConfig(accessToken),
    mcpHandler,
  });

  const readiness = await worker.fetch(
    new Request("https://worker.test/readyz"),
    {},
  );
  const post = await worker.fetch(
    new Request("https://worker.test/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}` },
      body: "{}",
    }),
    {},
  );

  expect(readiness.status).toBe(503);
  await expect(readiness.json()).resolves.toMatchObject({ ready: false });
  expect(post.status).toBe(500);
  await expect(post.json()).resolves.toEqual({
    code: "CONFIG_INVALID",
    message: "Rate limiting is unavailable",
  });
  expect(mcpHandler.fetch).not.toHaveBeenCalled();
});

it("reflects an accepted POST origin on success and safe errors", async () => {
  const accessToken = crypto.randomUUID();
  const allowed = { limit: vi.fn(async () => ({ success: true })) };
  const denied = { limit: vi.fn(async () => ({ success: false })) };
  const worker = createCloudflareWorker({
    config: testConfig(accessToken),
    mcpHandler: handler,
  });
  const request = (binding: RateLimit) =>
    worker.fetch(
      new Request("https://worker.test/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          origin: "https://worker.test",
        },
        body: "{}",
      }),
      { MCP_RATE_LIMITER: binding },
    );

  for (const response of [await request(allowed), await request(denied)]) {
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://worker.test",
    );
    expect(response.headers.get("vary")).toMatch(/(?:^|,\s*)Origin(?:,|$)/);
  }

  const crossOrigin = await worker.fetch(
    new Request("https://worker.test/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        origin: "https://other.test",
      },
      body: "{}",
    }),
    { MCP_RATE_LIMITER: allowed },
  );
  expect(crossOrigin.status).toBe(400);
  expect(crossOrigin.headers.get("access-control-allow-origin")).toBeNull();
});

it("runs initialize, tools/list, and Twitee/X calls through the real handler", async () => {
  const twiteeLatest = await readFile(
    new URL("./fixtures/twitee/latest-ready.json", import.meta.url),
    "utf8",
  );
  const twiteePeople = await readFile(
    new URL("./fixtures/twitee/people-ready.json", import.meta.url),
    "utf8",
  );
  const xRecent = await readFile(
    new URL("./fixtures/x/recent-search.json", import.meta.url),
    "utf8",
  );
  const providerFetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/search/latest")) return new Response(twiteeLatest);
    if (url.includes("/api/search/people")) return new Response(twiteePeople);
    if (url.includes("/2/tweets/search/recent")) return new Response(xRecent);
    throw new Error("Unexpected fixture URL");
  });
  const unexpectedGlobalFetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Global fetch must not be used"));
  const worker = createCloudflareWorker({
    config: dualConfig(),
    dependencies: { fetch: providerFetch, sleep: async () => {} },
  });

  try {
    const initialized = await mcpCall(worker, initializeRequest(1));
    expect(initialized.result.serverInfo.name).toBe("twitter-search-mcp");

    const listed = await mcpCall(worker, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    expect(
      listed.result.tools.map((tool: { name: string }) => tool.name),
    ).toEqual(["search_posts", "lookup_profile", "search_profiles"]);

    const twitee = await mcpCall(
      worker,
      toolCall(3, "search_profiles", { query: "open", provider: "twitee" }),
    );
    const x = await mcpCall(
      worker,
      toolCall(4, "search_posts", { query: "mcp", provider: "x" }),
    );
    expect(twitee.result.structuredContent.provider).toBe("twitee");
    expect(x.result.structuredContent.provider).toBe("x");
    expect(providerFetch).toHaveBeenCalledTimes(2);
    expect(unexpectedGlobalFetch).not.toHaveBeenCalled();
  } finally {
    unexpectedGlobalFetch.mockRestore();
  }
});

it("propagates a Worker request abort to an in-flight provider fetch", async () => {
  let upstreamSignal: AbortSignal | undefined;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const hangingFetch = async (
    _input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    upstreamSignal = init?.signal ?? undefined;
    markStarted?.();
    return await new Promise<Response>((_resolve, reject) => {
      const fallback = setTimeout(
        () => reject(new Error("raw-worker-provider-marker")),
        250,
      );
      upstreamSignal?.addEventListener(
        "abort",
        () => {
          clearTimeout(fallback);
          reject(new Error("raw-worker-abort-marker"));
        },
        { once: true },
      );
    });
  };
  const globalFetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(hangingFetch);
  const worker = createCloudflareWorker({
    config: dualConfig(),
    dependencies: { fetch: hangingFetch },
  });
  const controller = new AbortController();
  const pending = worker
    .fetch(
      new Request("https://worker.test/mcp", {
        method: "POST",
        headers: mcpHeaders(),
        body: JSON.stringify(
          toolCall(1, "search_posts", { query: "mcp", provider: "x" }),
        ),
        signal: controller.signal,
      }),
      {},
    )
    .catch(() => undefined);

  try {
    await started;
    controller.abort();
    await pending;
    await vi.waitFor(() => expect(upstreamSignal?.aborted).toBe(true));
  } finally {
    globalFetch.mockRestore();
  }
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

function dualConfig(): AppConfig {
  return {
    version: 1,
    access: { mode: "anonymous", token: "" },
    search: { default_provider: "twitee", allow_provider_override: true },
    providers: {
      twitee: { enabled: true, base_url: "https://twitee.test", token: "" },
      x: { enabled: true, base_url: "https://x.test", token: "x-token" },
    },
    ratelimit: { enabled: false, limit: 60, window: "1m" },
  };
}

function mcpHeaders(): Record<string, string> {
  return {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  };
}

function initializeRequest(id: number) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "cloudflare-runtime-test", version: "1.0.0" },
    },
  };
}

function toolCall(
  id: number,
  name: string,
  arguments_: Record<string, unknown>,
) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: arguments_ },
  };
}

async function mcpCall(
  worker: ReturnType<typeof createCloudflareWorker>,
  body: Record<string, unknown>,
): Promise<McpTestResponse> {
  const response = await worker.fetch(
    new Request("https://worker.test/mcp", {
      method: "POST",
      headers: mcpHeaders(),
      body: JSON.stringify(body),
    }),
    {},
  );
  expect(response.status).toBe(200);
  const text = await response.text();
  const data = text
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice("data: ".length);
  if (data === undefined) throw new Error("Missing MCP response event");
  return JSON.parse(data) as McpTestResponse;
}

type McpTestResponse = {
  readonly result: {
    readonly serverInfo: { readonly name: string };
    readonly tools: readonly { readonly name: string }[];
    readonly structuredContent: { readonly provider: string };
  };
};

async function tokenDigest(token: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
