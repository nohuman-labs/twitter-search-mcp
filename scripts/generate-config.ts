import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../src/config/load.js";
import type { AppConfig } from "../src/config/schema.js";

const rateLimitNamespaceId = "00000000000000000000000000000000";

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

export async function generateServerlessArtifacts(
  configPath: string,
  outputDir: string,
): Promise<ServerlessArtifacts> {
  const config = await loadConfig(configPath);
  const artifacts = createArtifacts(config);
  await writeArtifacts(outputDir, artifacts);
  return artifacts;
}

function createArtifacts(config: AppConfig): ServerlessArtifacts {
  return {
    moduleSource: `import type { AppConfig } from "../src/config/schema.js";\n\nconst config = ${JSON.stringify(config, null, 2)} satisfies AppConfig;\n\nexport default config;\n`,
    wrangler: {
      name: "twitter-search-mcp",
      main: "../src/runtimes/cloudflare.ts",
      compatibility_date: "2026-08-28",
      compatibility_flags: ["nodejs_compat"],
      observability: { enabled: true },
      vars: { MCP_CONFIG: JSON.stringify(config) },
      ...(config.ratelimit.enabled
        ? {
            ratelimits: [
              {
                name: "MCP_RATE_LIMITER",
                namespace_id: rateLimitNamespaceId,
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

function windowSeconds(window: AppConfig["ratelimit"]["window"]): 10 | 60 {
  return window === "10s" ? 10 : 60;
}

async function writeArtifacts(
  outputDir: string,
  artifacts: ServerlessArtifacts,
): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  const suffix = `${process.pid}-${Date.now()}`;
  const configPath = join(outputDir, "config.ts");
  const wranglerPath = join(outputDir, "wrangler.jsonc");
  const temporaryConfigPath = `${configPath}.${suffix}.tmp`;
  const temporaryWranglerPath = `${wranglerPath}.${suffix}.tmp`;

  try {
    await Promise.all([
      writeFile(temporaryConfigPath, artifacts.moduleSource),
      writeFile(
        temporaryWranglerPath,
        `${JSON.stringify(artifacts.wrangler, null, 2)}\n`,
      ),
    ]);
    await rename(temporaryConfigPath, configPath);
    await rename(temporaryWranglerPath, wranglerPath);
  } finally {
    await Promise.all([
      rm(temporaryConfigPath, { force: true }),
      rm(temporaryWranglerPath, { force: true }),
    ]);
  }
}

async function runCli(): Promise<void> {
  const configPath = parseConfigPath(process.argv.slice(2));
  await generateServerlessArtifacts(configPath, ".generated");
}

function parseConfigPath(arguments_: readonly string[]): string {
  if (arguments_.length === 0) {
    return "mcp.config.yaml";
  }

  if (arguments_.length === 2 && arguments_[0] === "--config") {
    return arguments_[1];
  }

  throw new Error("Usage: generate-config [--config path]");
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await runCli();
}
