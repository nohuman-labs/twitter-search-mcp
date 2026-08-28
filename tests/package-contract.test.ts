import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const execFileAsync = promisify(execFile);

type PackageExports = Record<
  string,
  { readonly types?: string; readonly import?: string }
>;

type Workflow = {
  readonly on: { readonly push: { readonly tags: readonly string[] } };
  readonly permissions: Record<string, string>;
  readonly jobs: Record<string, WorkflowJob>;
};

type WorkflowJob = {
  readonly environment?: string;
  readonly needs?: string;
  readonly permissions?: Record<string, string>;
  readonly steps?: readonly WorkflowStep[];
  readonly strategy?: {
    readonly matrix?: { readonly node?: readonly number[] };
  };
};

type WorkflowStep = { readonly name?: string; readonly run?: string };

describe("published package", () => {
  it("publishes only built runtime files and the required public documents", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8"));

    expect(pkg.files).toEqual(["dist", "README.md", "LICENSE"]);

    const packedPaths = await npmPackPaths();
    expect(packedPaths).toContain("package.json");
    expect(packedPaths).toContain("README.md");
    expect(packedPaths).toContain("LICENSE");
    expect(packedPaths.some((path) => path.startsWith("dist/"))).toBe(true);
    expect(
      packedPaths.every(
        (path) =>
          path === "package.json" ||
          path === "README.md" ||
          path === "LICENSE" ||
          path.startsWith("dist/"),
      ),
    ).toBe(true);
  });

  it("ships every declared export from the built package", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8"));
    const packedPaths = await npmPackPaths();

    for (const target of Object.values(pkg.exports as PackageExports)) {
      for (const exportedPath of [target.types, target.import]) {
        if (!exportedPath) continue;
        const relativePath = exportedPath.replace(/^\.\//, "");

        await expect(access(relativePath)).resolves.toBeUndefined();
        expect(packedPaths).toContain(relativePath);
      }
    }
  });

  it("uses the MCP SDK v2 package split", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8"));

    expect(pkg.dependencies["@modelcontextprotocol/server"]).toBe("2.0.0");
    expect(pkg.dependencies["@modelcontextprotocol/sdk"]).toBeUndefined();
  });

  it("keeps pull-request verification credential-free and avoids repeated image builds", async () => {
    const workflow = await workflowAt(".github/workflows/ci.yml");
    const testJob = workflow.jobs.test;
    const containerJob = workflow.jobs.container;

    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(testJob.strategy?.matrix?.node).toEqual([20, 22]);
    expect(testJob.steps?.map((step) => step.run)).toEqual(
      expect.arrayContaining([
        "cp mcp.config.example.yaml mcp.config.yaml",
        "make check",
        "make build",
        "npm run generate:config",
        "npx wrangler deploy --dry-run --config .generated/wrangler.jsonc",
      ]),
    );
    expect(containerJob.needs).toBe("test");
    expect(containerJob.steps?.map((step) => step.run)).toEqual(
      expect.arrayContaining([
        "docker build -f deploy/docker/Dockerfile -t twitter-search-mcp:ci .",
        "sh tests/container-smoke.sh twitter-search-mcp:ci",
        "kubectl kustomize deploy/kubernetes/overlays/example >/dev/null",
      ]),
    );
  });

  it("limits publishing to protected tagged releases", async () => {
    const workflow = await workflowAt(".github/workflows/release.yml");
    const publishJob = workflow.jobs.publish;

    expect(workflow.on.push.tags).toEqual(["v*"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(publishJob.environment).toBe("release");
    expect(publishJob.permissions).toEqual({
      contents: "write",
      packages: "write",
      "id-token": "write",
    });
  });

  it("prepares and inspects the exact package version before publishing", async () => {
    const workflow = await workflowAt(".github/workflows/release.yml");
    const steps = workflow.jobs.publish.steps ?? [];
    const commands = steps.map((step) => step.run ?? "");
    const installIndex = commands.indexOf("npm ci");
    const buildIndex = commands.indexOf("npm run build");
    const packIndex = commands.indexOf(
      "npm pack --dry-run --ignore-scripts --json",
    );
    const checkIndex = steps.findIndex(
      (step) =>
        step.name === "Check whether this release version already exists",
    );
    const publishIndex = commands.findIndex((command) =>
      command.includes(
        "npm publish --provenance --access public --ignore-scripts",
      ),
    );
    const versionCheck = steps[checkIndex]?.run;

    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(buildIndex).toBeGreaterThan(installIndex);
    expect(packIndex).toBeGreaterThan(buildIndex);
    expect(checkIndex).toBeGreaterThan(packIndex);
    expect(publishIndex).toBeGreaterThan(checkIndex);
    expect(versionCheck).toContain(
      'npm view "$package_name@$package_version" version --json',
    );
    expect(versionCheck).toContain('if [ "$status" -eq 0 ]; then');
    expect(versionCheck).toContain("grep -q 'E404'");
  });
});

async function npmPackPaths(): Promise<string[]> {
  const { stdout } = await execFileAsync("npm", [
    "pack",
    "--dry-run",
    "--json",
  ]);
  const [{ files }] = JSON.parse(stdout) as Array<{
    files: Array<{ path: string }>;
  }>;
  return files.map((file) => file.path);
}

async function workflowAt(path: string): Promise<Workflow> {
  return parse(await readFile(path, "utf8")) as Workflow;
}
