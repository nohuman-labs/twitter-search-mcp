import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.js";
import { parseConfig } from "../src/config/schema.js";

const base = {
  version: 1,
  access: { mode: "anonymous", token: "" },
  search: { default_provider: "twitee", allow_provider_override: true },
  providers: {
    twitee: { enabled: true, base_url: "https://twitee.co", token: "" },
    x: { enabled: false, base_url: "https://api.x.com", token: "" },
  },
  ratelimit: { enabled: false, limit: 60, window: "1m" },
};

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

it("accepts the Twitee default", () =>
  expect(parseConfig(base).version).toBe(1));
it("rejects unknown fields", () =>
  expect(() => parseConfig({ ...base, mystery: true })).toThrow());
it("requires X token when enabled", () => {
  const value = structuredClone(base);
  value.providers.x.enabled = true;
  expect(() => parseConfig(value)).toThrow(/X token/);
});
it("requires token for bearer access", () =>
  expect(() =>
    parseConfig({ ...base, access: { mode: "bearer", token: "" } }),
  ).toThrow(/access token/));
it("accepts only 10s or 1m", () =>
  expect(() =>
    parseConfig({
      ...base,
      ratelimit: { enabled: true, limit: 1, window: "5m" },
    }),
  ).toThrow());
it("loads and validates YAML configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "twitter-search-mcp-"));
  directories.push(directory);
  const path = join(directory, "mcp.config.yaml");
  await writeFile(path, JSON.stringify(base));

  await expect(loadConfig(path)).resolves.toEqual(base);
});
