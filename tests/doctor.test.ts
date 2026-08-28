import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo, Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config/schema.js";
import { createNodeServer } from "../src/runtimes/node.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

it("reports validated enabled providers and rate-limit scopes without tokens", async () => {
  const directory = await mkdtemp(join(tmpdir(), "twitter-search-mcp-"));
  directories.push(directory);
  const configPath = join(directory, "mcp.config.yaml");
  await writeFile(
    configPath,
    configYaml("http://127.0.0.1:1", "doctor-secret"),
  );

  const result = await runCli("scripts/doctor.ts", ["--config", configPath]);

  expect(result.exitCode).toBe(0);
  expect(result.output).toContain("Configuration: valid");
  expect(result.output).toContain(
    "Provider twitee: search_posts, lookup_profile, search_profiles",
  );
  expect(result.output).toContain(
    "Cloudflare: edge-local and eventually consistent",
  );
  expect(result.output).toContain("Node: per-process");
  expect(result.output).toContain("Kubernetes: per-replica");
  expect(result.output).toContain("Vercel: per-instance");
  expect(result.output).not.toContain("doctor-secret");
});

it("does not contact enabled providers unless connectivity is requested", async () => {
  let requests = 0;
  const upstream = createServer((_request, response) => {
    requests += 1;
    response.end();
  });
  await listen(upstream);
  const address = upstream.address() as AddressInfo;
  const directory = await mkdtemp(join(tmpdir(), "twitter-search-mcp-"));
  directories.push(directory);
  const configPath = join(directory, "mcp.config.yaml");
  await writeFile(
    configPath,
    configYaml(`http://127.0.0.1:${address.port}`, "doctor-secret"),
  );

  try {
    expect(
      (await runCli("scripts/doctor.ts", ["--config", configPath])).exitCode,
    ).toBe(0);
    expect(requests).toBe(0);

    const result = await runCli("scripts/doctor.ts", [
      "--config",
      configPath,
      "--connectivity",
    ]);
    expect(result.exitCode).toBe(0);
    expect(requests).toBe(1);
    expect(result.output).toContain("Connectivity twitee: reachable");
    expect(result.output).not.toContain("doctor-secret");
  } finally {
    await closeServer(upstream);
  }
});

it("rejects invalid configuration without exposing its token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "twitter-search-mcp-"));
  directories.push(directory);
  const configPath = join(directory, "mcp.config.yaml");
  await writeFile(
    configPath,
    configYaml("https://twitee.test", "doctor-secret").replace(
      "enabled: true",
      "enabled: false",
    ),
  );

  const result = await runCli("scripts/doctor.ts", ["--config", configPath]);

  expect(result.exitCode).not.toBe(0);
  expect(result.output).toContain("At least one provider must be enabled");
  expect(result.output).not.toContain("doctor-secret");
});

it("uses the MCP client to list tools and only calls caller-supplied fixture input", async () => {
  const smokeBearer = ["smoke", "secret"].join("-");
  const providerToken = ["provider", "secret"].join("-");
  const config: AppConfig = {
    version: 1,
    access: { mode: "bearer", token: smokeBearer },
    search: { default_provider: "x", allow_provider_override: true },
    providers: {
      twitee: { enabled: false, base_url: "https://twitee.test", token: "" },
      x: {
        enabled: true,
        base_url: "https://x.test",
        token: providerToken,
      },
    },
    ratelimit: { enabled: false, limit: 60, window: "1m" },
  };
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          data: [],
          meta: {},
        }),
      ),
  ) as typeof globalThis.fetch;
  const server = await createNodeServer({
    config,
    host: "127.0.0.1",
    port: 0,
    dependencies: { fetch },
  });
  const address = server.address() as AddressInfo;

  try {
    const result = await runCli("scripts/smoke-mcp.ts", [
      "--url",
      `http://127.0.0.1:${address.port}/mcp`,
      "--bearer",
      smokeBearer,
      "--tool",
      "search_posts",
      "--input",
      '{"query":"fixture","limit":1}',
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Tools: search_posts, lookup_profile");
    expect(result.output).toContain("Called tool: search_posts");
    expect(result.output).not.toContain(smokeBearer);
    expect(fetch).toHaveBeenCalledOnce();
  } finally {
    await closeServer(server);
  }
});

function configYaml(baseUrl: string, token: string): string {
  return `version: 1
access:
  mode: anonymous
  token: ""
search:
  default_provider: twitee
  allow_provider_override: true
providers:
  twitee:
    enabled: true
    base_url: ${baseUrl}
    token: ${token}
  x:
    enabled: false
    base_url: https://api.x.com
    token: ""
ratelimit:
  enabled: true
  limit: 60
  window: 1m
`;
}

function runCli(script: string, arguments_: readonly string[]) {
  return new Promise<{ exitCode: number | null; output: string }>((resolve) => {
    const child = spawn("./node_modules/.bin/tsx", [script, ...arguments_], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (data) => (output += data));
    child.stderr.on("data", (data) => (output += data));
    child.on("close", (exitCode) => resolve({ exitCode, output }));
  });
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", (error?: Error) =>
      error === undefined ? resolve() : reject(error),
    );
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}
