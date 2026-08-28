import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { AddressInfo, Server } from "node:net";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { AppConfig } from "../src/config/schema.js";
import { createNodeServer } from "../src/runtimes/node.js";

type ProviderCalls = { twitee: number; x: number };
type ProviderId = keyof ProviderCalls;

const fixtures = {
  latest: new URL("./fixtures/twitee/latest-ready.json", import.meta.url),
  people: new URL("./fixtures/twitee/people-ready.json", import.meta.url),
  recent: new URL("./fixtures/x/recent-search.json", import.meta.url),
  user: new URL("./fixtures/x/user-lookup.json", import.meta.url),
} as const;

async function main(): Promise<void> {
  await verifyTwiteeAndHttp();
  await verifyXOnlyAdvertisement();
  await verifyDualProviderRouting();
  await verifyOverrideRejection();
  console.log("RC fixture matrix: PASS");
}

async function verifyTwiteeAndHttp(): Promise<void> {
  const calls = providerCalls();
  const server = await fixtureServer(config({ twitee: true }), calls);
  const base = serverBase(server);
  const latest = await fixtureObject(fixtures.latest);
  const people = await fixtureObject(fixtures.people);
  const tools = "Tools: search_posts, lookup_profile, search_profiles";

  try {
    for (const [tool, input] of [
      ["search_posts", { query: branchQuery(latest, "latest"), limit: 1 }],
      ["lookup_profile", { handle: firstHandle(people) }],
      ["search_profiles", { query: branchQuery(people, "people"), limit: 1 }],
    ] as const) {
      const result = await smoke(base, tool, input);
      assert.equal(result.exitCode, 0, result.output);
      assert.match(result.output, new RegExp(toPattern(tools)));
      assert.match(result.output, new RegExp(`Called tool: ${tool}`));
    }

    const statuses = await httpStatuses(base);
    assert.deepEqual(statuses, {
      health: 200,
      ready: 200,
      getMcp: 405,
      deleteMcp: 405,
      sse: 404,
      optionsOriginless: 204,
      optionsSameOrigin: 204,
      optionsCrossOrigin: 400,
    });
    assert.deepEqual(calls, { twitee: 3, x: 0 });
    console.log(
      `Twitee tools and HTTP: PASS (adapter calls twitee=${calls.twitee}, x=${calls.x})`,
    );
  } finally {
    await closeServer(server);
  }
}

async function verifyXOnlyAdvertisement(): Promise<void> {
  const calls = providerCalls();
  const server = await fixtureServer(config({ x: true, default: "x" }), calls);

  try {
    const result = await smoke(serverBase(server));
    assert.equal(result.exitCode, 0, result.output);
    assert.match(result.output, /Tools: search_posts, lookup_profile/);
    assert.doesNotMatch(result.output, /search_profiles/);
    assert.deepEqual(calls, { twitee: 0, x: 0 });
    console.log(
      `X-only advertisement: PASS (adapter calls twitee=${calls.twitee}, x=${calls.x})`,
    );
  } finally {
    await closeServer(server);
  }
}

async function verifyDualProviderRouting(): Promise<void> {
  const calls = providerCalls();
  const server = await fixtureServer(
    config({ twitee: true, x: true, default: "twitee", override: true }),
    calls,
  );
  const latest = await fixtureObject(fixtures.latest);
  const input = { query: branchQuery(latest, "latest"), limit: 1 };

  try {
    const defaultResult = await smoke(
      serverBase(server),
      "search_posts",
      input,
    );
    assert.equal(defaultResult.exitCode, 0, defaultResult.output);
    assert.deepEqual(calls, { twitee: 1, x: 0 });

    const explicitResult = await smoke(serverBase(server), "search_posts", {
      ...input,
      provider: "x",
    });
    assert.equal(explicitResult.exitCode, 0, explicitResult.output);
    assert.deepEqual(calls, { twitee: 1, x: 1 });
    console.log(
      `Dual-provider routing: PASS (adapter calls twitee=${calls.twitee}, x=${calls.x})`,
    );
  } finally {
    await closeServer(server);
  }
}

async function verifyOverrideRejection(): Promise<void> {
  const calls = providerCalls();
  const server = await fixtureServer(
    config({ twitee: true, x: true, default: "twitee", override: false }),
    calls,
  );
  const latest = await fixtureObject(fixtures.latest);

  try {
    const result = await smoke(serverBase(server), "search_posts", {
      query: branchQuery(latest, "latest"),
      provider: "x",
      limit: 1,
    });
    assert.notEqual(result.exitCode, 0, result.output);

    const protocolResult = await callTool(serverBase(server), "search_posts", {
      query: branchQuery(latest, "latest"),
      provider: "x",
      limit: 1,
    });
    assert.equal(protocolResult.isError, true);
    const firstContent = protocolResult.content[0];
    assert.equal(firstContent?.type, "text");
    assert.deepEqual(JSON.parse(firstContent.text), {
      code: "INVALID_INPUT",
      message: "Provider override is not allowed",
    });
    assert.deepEqual(calls, { twitee: 0, x: 0 });
    console.log(
      `Override-disabled INVALID_INPUT: PASS (adapter calls twitee=${calls.twitee}, x=${calls.x})`,
    );
  } finally {
    await closeServer(server);
  }
}

function config(options: {
  readonly twitee?: boolean;
  readonly x?: boolean;
  readonly default?: ProviderId;
  readonly override?: boolean;
}): AppConfig {
  return {
    version: 1,
    access: { mode: "anonymous", token: "" },
    search: {
      default_provider: options.default ?? "twitee",
      allow_provider_override: options.override ?? true,
    },
    providers: {
      twitee: {
        enabled: options.twitee ?? false,
        base_url: "https://twitee.fixture.invalid",
        token: "",
      },
      x: {
        enabled: options.x ?? false,
        base_url: "https://x.fixture.invalid",
        token: ["fixture", "only"].join("-"),
      },
    },
    ratelimit: { enabled: false, limit: 60, window: "1m" },
  };
}

function providerCalls(): ProviderCalls {
  return { twitee: 0, x: 0 };
}

async function fixtureServer(
  appConfig: AppConfig,
  calls: ProviderCalls,
): Promise<Server> {
  return createNodeServer({
    config: appConfig,
    host: "127.0.0.1",
    port: 0,
    dependencies: { fetch: fixtureFetch(calls), sleep: async () => {} },
    logger: () => {},
  });
}

function fixtureFetch(calls: ProviderCalls): typeof fetch {
  return async (input) => {
    const url = new URL(String(input));
    const provider: ProviderId = url.hostname.startsWith("twitee")
      ? "twitee"
      : "x";
    calls[provider] += 1;

    if (url.pathname.endsWith("/latest")) {
      return fixtureResponse(fixtures.latest);
    }
    if (url.pathname.endsWith("/people")) {
      return fixtureResponse(fixtures.people);
    }
    if (url.pathname.includes("/tweets/search/recent")) {
      return fixtureResponse(fixtures.recent);
    }
    if (url.pathname.includes("/users/by/username/")) {
      return fixtureResponse(fixtures.user);
    }
    throw new Error("Unexpected fixture route");
  };
}

async function fixtureResponse(url: URL): Promise<Response> {
  return new Response(await readFile(url, "utf8"), {
    headers: { "content-type": "application/json" },
  });
}

async function fixtureObject(url: URL): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(url, "utf8")) as Record<string, unknown>;
}

function branchQuery(
  fixture: Record<string, unknown>,
  branch: "latest" | "people",
): string {
  const data = fixture.data as Record<string, unknown>;
  assert.equal(typeof data.query, "string");
  assert.ok(data[branch]);
  return data.query;
}

function firstHandle(fixture: Record<string, unknown>): string {
  const data = fixture.data as Record<string, unknown>;
  const people = data.people as { readonly items: readonly unknown[] };
  const first = people.items[0] as { readonly handle: unknown } | undefined;
  assert.equal(typeof first?.handle, "string");
  return first.handle;
}

async function smoke(
  base: string,
  tool?: string,
  input?: Record<string, unknown>,
): Promise<{ exitCode: number | null; output: string }> {
  const arguments_ = [
    "scripts/smoke-mcp.ts",
    "--url",
    `${base}/mcp`,
    ...(tool === undefined || input === undefined
      ? []
      : ["--tool", tool, "--input", JSON.stringify(input)]),
  ];

  return new Promise((resolve, reject) => {
    const child = spawn("./node_modules/.bin/tsx", arguments_, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (data) => (output += String(data)));
    child.stderr.on("data", (data) => (output += String(data)));
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode, output }));
  });
}

async function callTool(
  base: string,
  tool: string,
  input: Record<string, unknown>,
) {
  const client = new Client({
    name: "twitter-search-mcp-rc-verifier",
    version: "1.0.0",
  });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));

  try {
    await client.connect(transport);
    return await client.callTool({ name: tool, arguments: input });
  } finally {
    await client.close();
  }
}

async function httpStatuses(base: string) {
  const sameOrigin = await fetch(`${base}/mcp`, {
    method: "OPTIONS",
    headers: { origin: base },
  });
  assert.equal(sameOrigin.headers.get("access-control-allow-origin"), base);
  assert.equal(
    sameOrigin.headers.get("access-control-allow-methods"),
    "POST, OPTIONS",
  );

  return {
    health: (await fetch(`${base}/healthz`)).status,
    ready: (await fetch(`${base}/readyz`)).status,
    getMcp: (await fetch(`${base}/mcp`)).status,
    deleteMcp: (await fetch(`${base}/mcp`, { method: "DELETE" })).status,
    sse: (await fetch(`${base}/sse`)).status,
    optionsOriginless: (await fetch(`${base}/mcp`, { method: "OPTIONS" }))
      .status,
    optionsSameOrigin: sameOrigin.status,
    optionsCrossOrigin: (
      await fetch(`${base}/mcp`, {
        method: "OPTIONS",
        headers: { origin: "https://cross-origin.fixture.invalid" },
      })
    ).status,
  };
}

function serverBase(server: Server): string {
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function toPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

await main();
