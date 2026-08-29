import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import * as rootExports from "../src/index.js";
import * as nodeExports from "../src/runtimes/node.js";

const execFileAsync = promisify(execFile);

type PackageExports = Record<
  string,
  { readonly types?: string; readonly import?: string }
>;

type Workflow = {
  readonly on: {
    readonly push: {
      readonly branches?: readonly string[];
      readonly tags?: readonly string[];
    };
    readonly workflow_dispatch?: Record<string, never>;
  };
  readonly concurrency?: {
    readonly group?: string;
    readonly "cancel-in-progress"?: boolean;
  };
  readonly permissions: Record<string, string>;
  readonly jobs: Record<string, WorkflowJob>;
};

type WorkflowJob = {
  readonly env?: Record<string, string>;
  readonly environment?: string;
  readonly needs?: string;
  readonly permissions?: Record<string, string>;
  readonly steps?: readonly WorkflowStep[];
  readonly strategy?: {
    readonly matrix?: { readonly node?: readonly number[] };
  };
};

type WorkflowStep = {
  readonly id?: string;
  readonly if?: string;
  readonly name?: string;
  readonly run?: string;
};

describe("published package", () => {
  it("keeps filesystem configuration loading on the Node-only export", () => {
    expect("loadConfig" in rootExports).toBe(false);
    expect("loadConfig" in nodeExports).toBe(true);
  });

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

  it("keeps Node 20 metadata aligned with the locked production graph", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8"));
    const lock = JSON.parse(await readFile("package-lock.json", "utf8")) as {
      packages: Record<
        string,
        { dev?: boolean; engines?: { node?: string }; version?: string }
      >;
    };
    const require = createRequire(import.meta.url);
    const { satisfies } = require("semver") as {
      satisfies(version: string, range: string): boolean;
    };
    const incompatible = Object.entries(lock.packages)
      .filter(
        ([path, metadata]) =>
          path !== "" &&
          metadata.dev !== true &&
          metadata.engines?.node !== undefined &&
          !satisfies("20.0.0", metadata.engines.node),
      )
      .map(([path, metadata]) => `${path}@${metadata.version}`);

    expect(pkg.engines.node).toBe(">=20");
    expect(pkg.dependencies.agents).toBeUndefined();
    expect(pkg.devDependencies.agents).toBe("0.22.0");
    expect(incompatible).toEqual([]);
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
    const cloudflareSteps = testJob.steps?.filter(
      (step) =>
        step.run === "npm run generate:config" ||
        step.run ===
          "npx wrangler deploy --dry-run --config .generated/wrangler.jsonc",
    );
    expect(cloudflareSteps).toHaveLength(2);
    expect(
      cloudflareSteps?.every((step) => step.if === "matrix.node == 22"),
    ).toBe(true);
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
    const cloudflareSteps = workflow.jobs.test.steps?.filter(
      (step) =>
        step.run === "npm run generate:config" ||
        step.run ===
          "npx wrangler deploy --dry-run --config .generated/wrangler.jsonc",
    );

    expect(workflow.on.push.tags).toEqual(["v*"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    const tagConcurrencyGroup = ["release-", "$", "{{ github.ref }}"].join("");
    expect(workflow.concurrency).toEqual({
      group: tagConcurrencyGroup,
      "cancel-in-progress": false,
    });
    expect(cloudflareSteps).toHaveLength(2);
    expect(
      cloudflareSteps?.every((step) => step.if === "matrix.node == 22"),
    ).toBe(true);
    expect(publishJob.environment).toBe("release");
    expect(publishJob.permissions).toEqual({
      contents: "write",
      packages: "write",
      "id-token": "write",
    });
  });

  it("deploys the credential-free default to Cloudflare from main", async () => {
    const workflow = await workflowAt(
      ".github/workflows/deploy-cloudflare.yml",
    );
    const deploy = workflow.jobs.deploy;
    const tokenSecret = ["$", "{{ secrets.CLOUDFLARE_API_TOKEN }}"].join("");
    const accountSecret = ["$", "{{ secrets.CLOUDFLARE_ACCOUNT_ID }}"].join("");

    expect(workflow.on.push.branches).toEqual(["main"]);
    expect(workflow.on.workflow_dispatch).toEqual({});
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({
      group: "cloudflare-production",
      "cancel-in-progress": false,
    });
    expect(deploy.env).toEqual({
      CLOUDFLARE_API_TOKEN: tokenSecret,
      CLOUDFLARE_ACCOUNT_ID: accountSecret,
    });
    expect(deploy.steps?.map((step) => step.run)).toEqual(
      expect.arrayContaining([
        "npm ci",
        "cp mcp.config.example.yaml mcp.config.yaml",
        "make deploy-cloudflare",
      ]),
    );
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
      (step) => step.name === "Resolve npm publication state",
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
    expect(versionCheck).toContain('package_name="$(node -p');
    expect(versionCheck).toContain('package_version="$(node -p');
    expect(versionCheck).toContain(
      'sh scripts/release-state.sh npm "$package_name" "$package_version"',
    );
  });

  it("resumes npm, GHCR, and GitHub Release publication idempotently", async () => {
    const workflow = await workflowAt(".github/workflows/release.yml");
    const steps = workflow.jobs.publish.steps ?? [];
    const npmState = steps.find(
      (step) => step.name === "Resolve npm publication state",
    );
    const npmPublish = steps.find(
      (step) => step.name === "Publish npm package with provenance",
    );
    const imageState = steps.find(
      (step) => step.name === "Resolve existing GHCR tags",
    );
    const imageRepair = steps.find(
      (step) => step.name === "Restore a missing GHCR tag",
    );
    const imageBuild = steps.find(
      (step) => step.name === "Build and publish a new GHCR image",
    );
    const release = steps.find(
      (step) => step.name === "Create or update the GitHub Release",
    );

    expect(npmState?.run).toContain("scripts/release-state.sh npm");
    expect(npmPublish?.if).toContain(
      "steps.npm_state.outputs.publish == 'true'",
    );
    expect(imageState?.run).toContain(
      'scripts/release-state.sh image "$IMAGE" "$VERSION" "$SHA_TAG"',
    );
    expect(imageRepair?.run).toContain("docker buildx imagetools create");
    expect(imageBuild?.if).toContain(
      "steps.image_state.outputs.build == 'true'",
    );
    expect(release?.run).toContain(
      'scripts/release-state.sh release "$GITHUB_REF_NAME" release-notes.md',
    );
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
