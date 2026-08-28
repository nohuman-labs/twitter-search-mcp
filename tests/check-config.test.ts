import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ensureCheckConfig } from "../scripts/ensure-check-config.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

it("creates a credential-free typecheck module only when it is absent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "twitter-search-mcp-check-"));
  directories.push(directory);
  const outputPath = join(directory, ".generated", "config.ts");

  await ensureCheckConfig("mcp.config.example.yaml", outputPath);

  const source = await readFile(outputPath, "utf8");
  expect(source).toContain("satisfies AppConfig");
  expect(source).toContain('"default_provider": "twitee"');
});

it("does not read configuration or overwrite an existing generated module", async () => {
  const directory = await mkdtemp(join(tmpdir(), "twitter-search-mcp-check-"));
  directories.push(directory);
  const configPath = join(directory, "malformed.yaml");
  const outputPath = join(directory, ".generated", "config.ts");
  const marker = `private-${crypto.randomUUID()}`;
  await writeFile(configPath, `${marker}: [`);
  await ensureCheckConfig("mcp.config.example.yaml", outputPath);
  await writeFile(outputPath, marker);

  await ensureCheckConfig(configPath, outputPath);

  await expect(readFile(outputPath, "utf8")).resolves.toBe(marker);
});
