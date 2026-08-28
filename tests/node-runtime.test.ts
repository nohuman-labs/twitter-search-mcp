import { readFile } from "node:fs/promises";
import type { AddressInfo, Server } from "node:net";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config/schema.js";
import { createNodeServer } from "../src/runtimes/node.js";

function testConfig(
  access: AppConfig["access"] = { mode: "anonymous", token: "" },
): AppConfig {
  return {
    version: 1,
    access,
    search: { default_provider: "x", allow_provider_override: true },
    providers: {
      twitee: { enabled: false, base_url: "https://twitee.test", token: "" },
      x: { enabled: true, base_url: "https://x.test", token: "token" },
    },
    ratelimit: { enabled: false, limit: 60, window: "1m" },
  };
}

function serverAddress(server: Server): string {
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function fixtureFetch(): typeof fetch {
  return vi.fn(async () => {
    const payload = await readFile(
      new URL("./fixtures/x/recent-search.json", import.meta.url),
      "utf8",
    );
    return new Response(payload);
  }) as typeof fetch;
}

function clientFor(
  base: string,
  token?: string,
): { client: Client; transport: StreamableHTTPClientTransport } {
  const client = new Client({ name: "node-runtime-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    ...(token === undefined
      ? {}
      : { authProvider: { token: async () => token } }),
  });
  return { client, transport };
}

function rateLimitedConfig(): AppConfig {
  return {
    ...testConfig(),
    ratelimit: { enabled: true, limit: 1, window: "1m" },
  };
}

it("mounts canonical stateless routes", async () => {
  const server = await createNodeServer({
    config: testConfig(),
    host: "127.0.0.1",
    port: 0,
  });
  const base = serverAddress(server);

  try {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
    expect((await fetch(`${base}/mcp`)).status).toBe(405);
    expect((await fetch(`${base}/mcp`, { method: "DELETE" })).status).toBe(405);
    expect((await fetch(`${base}/sse`)).status).toBe(404);
  } finally {
    await closeServer(server);
  }
});

it("answers matching-origin preflight before bearer authentication and rate limiting", async () => {
  const server = await createNodeServer({
    config: testConfig({ mode: "bearer", token: "token" }),
    host: "127.0.0.1",
    port: 0,
  });
  const base = serverAddress(server);

  try {
    const response = await fetch(`${base}/mcp`, {
      method: "OPTIONS",
      headers: { origin: base },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toBe(
      "POST, OPTIONS",
    );
    expect(response.headers.get("access-control-allow-origin")).toBe(base);
  } finally {
    await closeServer(server);
  }
});

it("serves tools and fixture-backed search posts over stateless MCP HTTP", async () => {
  const server = await createNodeServer({
    config: testConfig(),
    host: "127.0.0.1",
    port: 0,
    dependencies: { fetch: fixtureFetch() },
  });
  const base = serverAddress(server);
  const { client, transport } = clientFor(base);

  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "search_posts",
      "lookup_profile",
    ]);
    expect(
      (
        await client.callTool({
          name: "search_posts",
          arguments: { query: "mcp" },
        })
      ).structuredContent,
    ).toMatchObject({ provider: "x", items: [{ text: "MCP is here" }] });
  } finally {
    await client.close();
    await closeServer(server);
  }
});

it("closes each request-scoped MCP server and transport exactly once", async () => {
  const transport = {
    handleRequest: vi.fn(async (_request, response: ServerResponse) => {
      response.end("{}");
    }),
    close: vi.fn(async () => {}),
  };
  const mcpServer = {
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const server = await createNodeServer({
    config: testConfig(),
    host: "127.0.0.1",
    port: 0,
    mcpServerFactory: () => mcpServer,
    transportFactory: () => transport,
  });
  const base = serverAddress(server);

  try {
    expect(
      (
        await fetch(`${base}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(200);
    expect(transport.close).toHaveBeenCalledOnce();
    expect(mcpServer.close).toHaveBeenCalledOnce();
  } finally {
    await closeServer(server);
  }
});

it("tears down request-scoped MCP resources when the client aborts", async () => {
  const transport = {
    handleRequest: vi.fn(async () => new Promise<void>(() => {})),
    close: vi.fn(async () => {}),
  };
  const mcpServer = {
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const server = await createNodeServer({
    config: testConfig(),
    host: "127.0.0.1",
    port: 0,
    mcpServerFactory: () => mcpServer,
    transportFactory: () => transport,
  });
  const controller = new AbortController();
  const request = fetch(`${serverAddress(server)}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    signal: controller.signal,
  }).catch(() => undefined);

  try {
    await vi.waitFor(() =>
      expect(transport.handleRequest).toHaveBeenCalledOnce(),
    );
    controller.abort();
    await request;
    await vi.waitFor(() => {
      expect(transport.close).toHaveBeenCalledOnce();
      expect(mcpServer.close).toHaveBeenCalledOnce();
    });
  } finally {
    await closeServer(server);
  }
});

it("tears down request-scoped MCP resources after dispatch errors", async () => {
  const transport = {
    handleRequest: vi.fn(async () => {
      throw new Error("dispatch failed");
    }),
    close: vi.fn(async () => {}),
  };
  const mcpServer = {
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const server = await createNodeServer({
    config: testConfig(),
    host: "127.0.0.1",
    port: 0,
    mcpServerFactory: () => mcpServer,
    transportFactory: () => transport,
  });

  try {
    const response = await fetch(`${serverAddress(server)}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      code: "UPSTREAM_UNAVAILABLE",
      message: "Request could not be completed",
    });
    expect(transport.close).toHaveBeenCalledOnce();
    expect(mcpServer.close).toHaveBeenCalledOnce();
  } finally {
    await closeServer(server);
  }
});

it("closes a constructed transport when the MCP server factory throws", async () => {
  const transport = {
    handleRequest: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const server = await createNodeServer({
    config: testConfig(),
    host: "127.0.0.1",
    port: 0,
    mcpServerFactory: () => {
      throw new Error("server factory failed");
    },
    transportFactory: () => transport,
  });

  try {
    const response = await fetch(`${serverAddress(server)}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      code: "UPSTREAM_UNAVAILABLE",
      message: "Request could not be completed",
    });
    expect(transport.close).toHaveBeenCalledOnce();
  } finally {
    await closeServer(server);
  }
});

it("rate limits MCP POSTs while allowing OPTIONS to bypass the limiter", async () => {
  const limiter = {
    take: vi
      .fn()
      .mockResolvedValueOnce({ allowed: true })
      .mockResolvedValueOnce({ allowed: true })
      .mockResolvedValue({ allowed: false, retryAfterSeconds: 19 }),
  };
  const server = await createNodeServer({
    config: rateLimitedConfig(),
    host: "127.0.0.1",
    port: 0,
    dependencies: { fetch: fixtureFetch() },
    rateLimiter: limiter,
  });
  const base = serverAddress(server);
  const { client, transport } = clientFor(base);

  try {
    expect((await fetch(`${base}/mcp`, { method: "OPTIONS" })).status).toBe(
      204,
    );
    expect(limiter.take).not.toHaveBeenCalled();

    await client.connect(transport);
    expect(limiter.take).toHaveBeenCalledTimes(2);

    const denied = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(denied.status).toBe(429);
    expect(denied.headers.get("retry-after")).toBe("19");
  } finally {
    await client.close();
    await closeServer(server);
  }
});

it("requires bearer credentials for MCP without logging the configured token", async () => {
  const token = "token";
  const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const server = await createNodeServer({
    config: testConfig({ mode: "bearer", token }),
    host: "127.0.0.1",
    port: 0,
    dependencies: { fetch: fixtureFetch() },
  });
  const base = serverAddress(server);
  const unauthenticated = clientFor(base);
  const authenticated = clientFor(base, token);

  try {
    await expect(
      unauthenticated.client.connect(unauthenticated.transport),
    ).rejects.toThrow();
    await authenticated.client.connect(authenticated.transport);
    expect((await authenticated.client.listTools()).tools).toHaveLength(2);
    expect(output.mock.calls.flat().join(" ")).not.toContain(token);
  } finally {
    await unauthenticated.client.close();
    await authenticated.client.close();
    await closeServer(server);
    output.mockRestore();
  }
});
