import { access, readFile } from "node:fs/promises";
import { expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

it("documents the canonical endpoint and no-fallback provider contract", async () => {
  const readme = await read("README.md");

  expect(readme).toContain("/mcp");
  expect(readme).toMatch(/never.*fallback/i);
  expect(readme).toContain("mcp.config.yaml");
  expect(readme).toMatch(/GET\s+\/mcp.*405/i);
  expect(readme).toMatch(/DELETE\s+\/mcp.*405/i);
  expect(readme).toMatch(/no.*\/sse/i);
});

it("documents the provider capabilities and configuration paths", async () => {
  const readme = await read("README.md");

  expect(readme).toMatch(
    /Twitee.*search_posts.*lookup_profile.*search_profiles/is,
  );
  expect(readme).toMatch(/X.*search_posts.*lookup_profile/is);
  expect(readme).toMatch(/X.*does not.*search_profiles/is);
  expect(readme).toMatch(/Twitee-only/i);
  expect(readme).toMatch(/X-only/i);
  expect(readme).toMatch(/dual-provider/i);
});

it("documents rejection for an override-disabled explicit provider", async () => {
  const readme = await read("README.md");

  expect(readme).toContain(
    "When a provider is omitted, the configured default is used.",
  );
  expect(readme).toContain(
    "When `allow_provider_override` is false, an explicit different provider is rejected; it is never changed to the default or another provider.",
  );
});

it("documents direct-token artifact handling and rotation", async () => {
  const security = await read("SECURITY.md");

  expect(security).toMatch(/generated artifact.*token/i);
  expect(security).toMatch(/rotate.*immediately/i);
  expect(security).toMatch(/never.*paste.*(config|token)/i);
  expect(security).toMatch(/no.*environment.*interpolation/i);
});

it("keeps contributor commands aligned with the Makefile", async () => {
  const contributing = await read("CONTRIBUTING.md");

  for (const command of [
    "make setup",
    "make dev",
    "make check",
    "make doctor",
    "make deploy-cloudflare",
    "make deploy-vercel",
    "make docker-build",
    "make docker-run",
    "make deploy-k8s KUBE_CONTEXT=<context>",
    "make clean",
  ]) {
    expect(contributing).toContain(command);
  }
});

it("ships every linked OSS document", async () => {
  for (const path of [
    "README.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "CODE_OF_CONDUCT.md",
    "CHANGELOG.md",
    "docs/architecture.md",
    "docs/providers.md",
    "docs/deployment/cloudflare.md",
    "docker.md",
    "kubernetes.md",
    "vercel.md",
  ]) {
    await expect(access(path)).resolves.toBeUndefined();
  }
});
