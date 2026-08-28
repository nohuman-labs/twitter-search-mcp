import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { generateServerlessArtifacts } from "../scripts/generate-config.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

it("maps a one-minute limit to a Workers simple binding", async () => {
  const { configPath, outputDir } = await fixture({
    ratelimit: { enabled: true, limit: 60, window: "1m" },
  });

  const artifacts = await generateServerlessArtifacts(configPath, outputDir);

  expect(artifacts.wrangler.ratelimits?.[0]?.simple).toEqual({
    limit: 60,
    period: 60,
  });
});

it("writes configured tokens only to the ignored generated module", async () => {
  const xToken = crypto.randomUUID();
  const { configPath, outputDir } = await fixture({
    providers: {
      x: { enabled: true, base_url: "https://x.test", token: xToken },
    },
  });

  const artifacts = await generateServerlessArtifacts(configPath, outputDir);

  expect(artifacts.moduleSource).toContain(xToken);
  expect(artifacts.wrangler.vars.MCP_CONFIG).toContain(xToken);
  await expect(readFile(join(outputDir, "config.ts"), "utf8")).resolves.toBe(
    artifacts.moduleSource,
  );
  await expect(isGitIgnored(".generated/config.ts")).resolves.toBe(true);
});

it("leaves existing artifacts intact when YAML validation fails", async () => {
  const { configPath, outputDir } = await fixture();
  await mkdir(outputDir);
  await writeFile(join(outputDir, "config.ts"), "previous config");
  await writeFile(join(outputDir, "wrangler.jsonc"), "previous wrangler");
  await writeFile(configPath, "version: 1\naccess: [");

  await expect(
    generateServerlessArtifacts(configPath, outputDir),
  ).rejects.toThrow();
  await expect(readFile(join(outputDir, "config.ts"), "utf8")).resolves.toBe(
    "previous config",
  );
  await expect(
    readFile(join(outputDir, "wrangler.jsonc"), "utf8"),
  ).resolves.toBe("previous wrangler");
});

async function fixture(
  overrides: Record<string, unknown> = {},
): Promise<{ configPath: string; outputDir: string }> {
  const directory = await mkdtemp(join(tmpdir(), "twitter-search-mcp-"));
  directories.push(directory);
  const configPath = join(directory, "mcp.config.yaml");
  const outputDir = join(directory, ".generated");
  const config = merge(
    {
      version: 1,
      access: { mode: "anonymous", token: "" },
      search: { default_provider: "twitee", allow_provider_override: true },
      providers: {
        twitee: { enabled: true, base_url: "https://twitee.test", token: "" },
        x: { enabled: false, base_url: "https://x.test", token: "" },
      },
      ratelimit: { enabled: false, limit: 60, window: "1m" },
    },
    overrides,
  );
  await writeFile(configPath, JSON.stringify(config));
  return { configPath, outputDir };
}

function merge(
  target: Record<string, unknown>,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const existing = target[key];
      target[key] = merge(
        existing !== null &&
          typeof existing === "object" &&
          !Array.isArray(existing)
          ? { ...existing }
          : {},
        value as Record<string, unknown>,
      );
    } else {
      target[key] = value;
    }
  }
  return target;
}

async function isGitIgnored(path: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["check-ignore", "-q", path]);
    return true;
  } catch {
    return false;
  }
}
