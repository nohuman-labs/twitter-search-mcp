import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

it.each([
  ["Node startup", "src/runtimes/node.ts", "Configuration is invalid"],
  [
    "generator",
    "scripts/generate-config.ts",
    "Configuration generation failed",
  ],
])(
  "sanitizes malformed YAML at the %s boundary",
  async (_name, script, message) => {
    const directory = await mkdtemp(join(tmpdir(), "twitter-search-mcp-cli-"));
    directories.push(directory);
    const configPath = join(directory, "mcp.config.yaml");
    const marker = `private-${crypto.randomUUID()}`;
    await writeFile(configPath, `version: 1\n${marker}: [`);

    const result = await runCli(script, ["--config", configPath]);

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain(message);
    expect(result.output).not.toContain(marker);
    expect(result.output).not.toContain(`${marker}: [`);
  },
);

function runCli(script: string, arguments_: readonly string[]) {
  return new Promise<{ exitCode: number | null; output: string }>((resolve) => {
    const child = spawn("./node_modules/.bin/tsx", [script, ...arguments_], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (data) => (output += String(data)));
    child.stderr.on("data", (data) => (output += String(data)));
    child.on("close", (exitCode) => resolve({ exitCode, output }));
  });
}
