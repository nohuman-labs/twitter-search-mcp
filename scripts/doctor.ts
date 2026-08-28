import { pathToFileURL } from "node:url";
import { ZodError } from "zod";
import { loadConfig } from "../src/config/load.js";
import type { AppConfig } from "../src/config/schema.js";
import type { SearchProvider } from "../src/providers/provider.js";
import { createTwiteeProvider } from "../src/providers/twitee.js";
import { createXProvider } from "../src/providers/x.js";

type DoctorOptions = {
  readonly configPath: string;
  readonly connectivity: boolean;
};

async function run(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const config = await loadConfig(options.configPath);
  const providers = createProviders(config);

  console.log("Configuration: valid");
  for (const provider of providers) {
    console.log(
      `Provider ${provider.id}: ${capabilities(provider).join(", ")}`,
    );
  }
  console.log(
    `Rate limiting: ${config.ratelimit.enabled ? `enabled (${config.ratelimit.limit} per ${config.ratelimit.window})` : "disabled"}`,
  );
  if (config.ratelimit.enabled) {
    console.log("Configured rate-limit deployment scopes and limitations:");
    console.log(
      "Cloudflare: requires generated MCP_RATE_LIMITER binding; edge-local and eventually consistent",
    );
    console.log("Node: per-process");
    console.log("Kubernetes: per-replica");
    console.log("Vercel: per-instance");
  }

  if (options.connectivity) {
    const results = await Promise.all(
      providers.map(async (provider) => ({
        provider: provider.id,
        reachable: await checkConnectivity(
          config.providers[provider.id].base_url,
        ),
      })),
    );
    for (const result of results) {
      console.log(
        `Connectivity ${result.provider}: ${result.reachable ? "reachable" : "unreachable"}`,
      );
    }
    if (results.some((result) => !result.reachable)) {
      process.exitCode = 1;
    }
  }
}

function createProviders(config: AppConfig): SearchProvider[] {
  const neverFetch: typeof fetch = async () => {
    throw new Error("Doctor does not query providers without --connectivity");
  };
  const providers: SearchProvider[] = [];

  if (config.providers.twitee.enabled) {
    providers.push(
      createTwiteeProvider({
        baseUrl: config.providers.twitee.base_url,
        token: config.providers.twitee.token,
        fetch: neverFetch,
        sleep: async () => {},
      }),
    );
  }
  if (config.providers.x.enabled) {
    providers.push(
      createXProvider({
        baseUrl: config.providers.x.base_url,
        token: config.providers.x.token,
        fetch: neverFetch,
      }),
    );
  }

  return providers;
}

function capabilities(provider: SearchProvider): string[] {
  return [
    ...(provider.capabilities.searchPosts ? ["search_posts"] : []),
    ...(provider.capabilities.lookupProfile ? ["lookup_profile"] : []),
    ...(provider.capabilities.searchProfiles ? ["search_profiles"] : []),
  ];
}

async function checkConnectivity(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(baseUrl, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function parseArguments(arguments_: readonly string[]): DoctorOptions {
  let configPath = "mcp.config.yaml";
  let connectivity = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--connectivity") {
      connectivity = true;
      continue;
    }
    if (argument === "--config" && arguments_[index + 1] !== undefined) {
      configPath = arguments_[index + 1];
      index += 1;
      continue;
    }
    throw new Error("Usage: doctor [--config path] [--connectivity]");
  }

  return { configPath, connectivity };
}

function reportFailure(error: unknown): void {
  if (error instanceof ZodError) {
    console.error(
      `Configuration: invalid\n${[...new Set(error.issues.map((issue) => issue.message))].join("\n")}`,
    );
    return;
  }
  console.error("Doctor failed without exposing configuration values");
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await run().catch((error: unknown) => {
    reportFailure(error);
    process.exitCode = 1;
  });
}
