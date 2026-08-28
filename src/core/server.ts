import { McpServer } from "@modelcontextprotocol/server";
import packageMetadata from "../../package.json" with { type: "json" };
import type { AppConfig } from "../config/schema.js";
import type { SearchProvider } from "../providers/provider.js";
import { ProviderRegistry } from "../providers/registry.js";
import { createTwiteeProvider } from "../providers/twitee.js";
import { createXProvider } from "../providers/x.js";
import { registerSearchTools } from "../tools/register.js";
import { createLogger, type Logger } from "./logging.js";

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type McpServerDependencies = {
  readonly fetch: FetchLike;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly logger?: Logger;
};

export const serverVersion = packageMetadata.version;

export function createMcpServer(
  config: AppConfig,
  dependencies: McpServerDependencies,
): McpServer {
  const server = new McpServer({
    name: "twitter-search-mcp",
    version: serverVersion,
  });

  registerMcpServer(server, config, dependencies);
  return server;
}

export function registerMcpServer(
  server: McpServer,
  config: AppConfig,
  dependencies: McpServerDependencies,
): void {
  const providers = createProviders(config, dependencies);
  registerSearchTools(server, {
    registry: new ProviderRegistry(config, providers),
    providers,
    logger:
      dependencies.logger ??
      createLogger([
        config.access.token,
        config.providers.twitee.token,
        config.providers.x.token,
      ]),
  });
}

function createProviders(
  config: AppConfig,
  dependencies: McpServerDependencies,
): SearchProvider[] {
  const providers: SearchProvider[] = [];

  if (config.providers.twitee.enabled) {
    providers.push(
      createTwiteeProvider({
        baseUrl: config.providers.twitee.base_url,
        token: config.providers.twitee.token,
        fetch: dependencies.fetch,
        sleep: dependencies.sleep ?? ((milliseconds) => delay(milliseconds)),
      }),
    );
  }

  if (config.providers.x.enabled) {
    providers.push(
      createXProvider({
        baseUrl: config.providers.x.base_url,
        token: config.providers.x.token,
        fetch: dependencies.fetch,
      }),
    );
  }

  return providers;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
