import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../src/config/load.js";
import type { AppConfig } from "../src/config/schema.js";
import { SafeError } from "../src/domain/errors.js";

type WranglerConfig = {
  readonly name: string;
  readonly main: string;
  readonly compatibility_date: string;
  readonly compatibility_flags: readonly ["nodejs_compat"];
  readonly observability: { readonly enabled: true };
  readonly vars: { readonly MCP_CONFIG: string };
  readonly ratelimits?: readonly [
    {
      readonly name: "MCP_RATE_LIMITER";
      readonly namespace_id: string;
      readonly simple: { readonly limit: number; readonly period: 10 | 60 };
    },
  ];
};

export type ServerlessArtifacts = {
  readonly moduleSource: string;
  readonly wrangler: WranglerConfig;
};

type Rename = (from: string, to: string) => Promise<void>;

export type GenerateConfigOptions = {
  readonly rename?: Rename;
  readonly rateLimitNamespaceId?: string;
};

export async function generateServerlessArtifacts(
  configPath: string,
  outputDir: string,
  options: GenerateConfigOptions = {},
): Promise<ServerlessArtifacts> {
  const config = await loadConfig(configPath);
  const artifacts = createArtifacts(config, options.rateLimitNamespaceId);
  await writeArtifacts(outputDir, artifacts, options.rename ?? rename);
  return artifacts;
}

function createArtifacts(
  config: AppConfig,
  rateLimitNamespaceId: string | undefined,
): ServerlessArtifacts {
  const namespaceId = config.ratelimit.enabled
    ? validRateLimitNamespace(rateLimitNamespaceId)
    : undefined;
  return {
    moduleSource: `import type { AppConfig } from "../src/config/schema.js";\n\nconst config = ${JSON.stringify(config, null, 2)} satisfies AppConfig;\n\nexport default config;\n`,
    wrangler: {
      name: "twitter-search-mcp",
      main: "../src/runtimes/cloudflare.ts",
      compatibility_date: "2026-08-28",
      compatibility_flags: ["nodejs_compat"],
      observability: { enabled: true },
      vars: { MCP_CONFIG: JSON.stringify(config) },
      ...(namespaceId !== undefined
        ? {
            ratelimits: [
              {
                name: "MCP_RATE_LIMITER",
                namespace_id: namespaceId,
                simple: {
                  limit: config.ratelimit.limit,
                  period: windowSeconds(config.ratelimit.window),
                },
              },
            ],
          }
        : {}),
    },
  };
}

function validRateLimitNamespace(value: string | undefined): string {
  const namespaceId = value?.trim();
  if (
    namespaceId === undefined ||
    namespaceId.length === 0 ||
    /^0+$/.test(namespaceId) ||
    /placeholder|replace/i.test(namespaceId)
  ) {
    throw new SafeError(
      "CONFIG_INVALID",
      "A non-placeholder Cloudflare rate-limit namespace is required",
    );
  }
  return namespaceId;
}

function windowSeconds(window: AppConfig["ratelimit"]["window"]): 10 | 60 {
  return window === "10s" ? 10 : 60;
}

async function writeArtifacts(
  outputDir: string,
  artifacts: ServerlessArtifacts,
  renameFile: Rename,
): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  const suffix = `${process.pid}-${Date.now()}`;
  const configPath = join(outputDir, "config.ts");
  const wranglerPath = join(outputDir, "wrangler.jsonc");
  const publications = await Promise.all([
    createPublication(configPath, `${configPath}.${suffix}.tmp`),
    createPublication(wranglerPath, `${wranglerPath}.${suffix}.tmp`),
  ]);

  let publicationError: unknown;
  try {
    await Promise.all([
      writeFile(publications[0].temporaryPath, artifacts.moduleSource),
      writeFile(
        publications[1].temporaryPath,
        `${JSON.stringify(artifacts.wrangler, null, 2)}\n`,
      ),
    ]);
    await backupPublications(publications, renameFile);
    await publishPublications(publications, renameFile);
  } catch (error) {
    publicationError = error;
    try {
      await rollbackPublications(publications, renameFile);
    } catch {
      // Preserve the publication failure for callers.
    }
  }

  try {
    await cleanupPublications(publications);
  } catch (error) {
    if (publicationError === undefined) {
      throw error;
    }
  }

  if (publicationError !== undefined) {
    throw publicationError;
  }
}

type Publication = {
  readonly targetPath: string;
  readonly temporaryPath: string;
  readonly backupPath: string;
  readonly hadPreviousArtifact: boolean;
  backedUp: boolean;
  published: boolean;
};

async function createPublication(
  targetPath: string,
  temporaryPath: string,
): Promise<Publication> {
  return {
    targetPath,
    temporaryPath,
    backupPath: `${temporaryPath}.backup`,
    hadPreviousArtifact: await exists(targetPath),
    backedUp: false,
    published: false,
  };
}

async function backupPublications(
  publications: readonly Publication[],
  renameFile: Rename,
): Promise<void> {
  for (const publication of publications) {
    if (publication.hadPreviousArtifact) {
      await renameFile(publication.targetPath, publication.backupPath);
      publication.backedUp = true;
    }
  }
}

async function publishPublications(
  publications: readonly Publication[],
  renameFile: Rename,
): Promise<void> {
  for (const publication of publications) {
    await renameFile(publication.temporaryPath, publication.targetPath);
    publication.published = true;
  }
}

async function rollbackPublications(
  publications: readonly Publication[],
  renameFile: Rename,
): Promise<void> {
  for (const publication of [...publications].reverse()) {
    if (publication.published) {
      await rm(publication.targetPath, { force: true });
    }
    if (publication.backedUp) {
      await renameFile(publication.backupPath, publication.targetPath);
    }
  }
}

async function cleanupPublications(
  publications: readonly Publication[],
): Promise<void> {
  await Promise.all(
    publications.flatMap((publication) => [
      rm(publication.temporaryPath, { force: true }),
      rm(publication.backupPath, { force: true }),
    ]),
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function runCli(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  await generateServerlessArtifacts(options.configPath, ".generated", {
    rateLimitNamespaceId: options.rateLimitNamespaceId,
  });
}

function parseArguments(arguments_: readonly string[]): {
  configPath: string;
  rateLimitNamespaceId?: string;
} {
  let configPath = "mcp.config.yaml";
  let rateLimitNamespaceId: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (value === undefined) {
      throw new Error(
        "Usage: generate-config [--config path] [--rate-limit-namespace-id id]",
      );
    }
    if (argument === "--config") {
      configPath = value;
    } else if (argument === "--rate-limit-namespace-id") {
      rateLimitNamespaceId = value;
    } else {
      throw new Error(
        "Usage: generate-config [--config path] [--rate-limit-namespace-id id]",
      );
    }
    index += 1;
  }
  return { configPath, rateLimitNamespaceId };
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await runCli().catch(() => {
    console.error("Configuration generation failed");
    process.exitCode = 1;
  });
}
