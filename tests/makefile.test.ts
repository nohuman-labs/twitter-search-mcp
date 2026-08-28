import { spawn } from "node:child_process";
import { expect, it } from "vitest";

it("requires an explicit Kubernetes context even for a dry run", async () => {
  const result = await runMake(["-n", "deploy-k8s"]);

  expect(result.exitCode).not.toBe(0);
  expect(result.output).toMatch(/KUBE_CONTEXT is required/);
});

it("preserves private configuration during setup", async () => {
  const result = await runMake(["-n", "setup"]);

  expect(result.exitCode).toBe(0);
  expect(result.output).toContain(
    "test -e mcp.config.yaml || cp mcp.config.example.yaml mcp.config.yaml",
  );
});

it("runs checks and diagnostics before platform deployment commands", async () => {
  const namespaceId = "1".repeat(32);
  const cloudflare = await runMake([
    "-n",
    "deploy-cloudflare",
    `CLOUDFLARE_RATE_LIMIT_NAMESPACE_ID=${namespaceId}`,
  ]);
  const vercel = await runMake(["-n", "deploy-vercel"]);

  for (const result of [cloudflare, vercel]) {
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("npm run check");
    expect(result.output).toContain("npm run doctor");
  }
  expect(cloudflare.output).toContain(
    "npx wrangler deploy --config .generated/wrangler.jsonc",
  );
  expect(cloudflare.output).toContain(
    `--rate-limit-namespace-id "${namespaceId}"`,
  );
  expect(vercel.output).toContain("npx vercel --prod");
});

it("limits clean to known build artifacts", async () => {
  const result = await runMake(["-n", "clean"]);

  expect(result.exitCode).toBe(0);
  expect(result.output).toContain("rm -rf dist .generated coverage");
  expect(result.output).not.toContain("mcp.config.yaml");
});

function runMake(arguments_: readonly string[]) {
  return new Promise<{ exitCode: number | null; output: string }>((resolve) => {
    const child = spawn("make", arguments_, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (data) => (output += data));
    child.stderr.on("data", (data) => (output += data));
    child.on("close", (exitCode) => resolve({ exitCode, output }));
  });
}
