import { createMcpHandler } from "agents/mcp/server";
import { type AppConfig, parseConfig } from "../config/schema.js";
import { authorize } from "../core/access.js";
import { clientKey } from "../core/client-key.js";
import {
  HEALTH_PATH,
  healthResponse,
  MCP_PATH,
  READY_PATH,
  readyResponse,
  validateOrigin,
} from "../core/http.js";
import type { RateLimiter } from "../core/ratelimit.js";
import { createMcpServer, serverVersion } from "../core/server.js";
import { SafeError } from "../domain/errors.js";

export type CloudflareEnv = {
  readonly MCP_CONFIG?: string;
  readonly MCP_RATE_LIMITER?: RateLimit;
};

type McpHandler = {
  fetch(request: Request): Promise<Response>;
};

export type CloudflareWorkerOptions = {
  readonly config: AppConfig;
  readonly mcpHandler?: McpHandler;
};

export type CloudflareWorker = {
  fetch(request: Request, env: CloudflareEnv): Promise<Response>;
};

export function createCloudflareWorker(
  options: CloudflareWorkerOptions,
): CloudflareWorker {
  const mcpHandler =
    options.mcpHandler ??
    createMcpHandler(
      () => createMcpServer(options.config, { fetch: globalThis.fetch }),
      {
        route: MCP_PATH,
        responseMode: "json",
        corsOptions: false,
        allowedOriginHostnames: "*",
        legacy: "stateless",
      },
    );

  return {
    fetch: async (request, env) =>
      handleRequest(request, env, options.config, mcpHandler),
  };
}

class CloudflareRateLimiter implements RateLimiter {
  constructor(
    private readonly binding: RateLimit,
    private readonly retryAfterSeconds: number,
  ) {}

  async take(key: string) {
    const result = await this.binding.limit({ key });
    return result.success
      ? { allowed: true as const }
      : { allowed: false as const, retryAfterSeconds: this.retryAfterSeconds };
  }
}

async function handleRequest(
  request: Request,
  env: CloudflareEnv,
  config: AppConfig,
  mcpHandler: McpHandler,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === HEALTH_PATH) {
    return healthResponse(serverVersion);
  }

  if (request.method === "GET" && url.pathname === READY_PATH) {
    return readyResponse(serverVersion, true);
  }

  if (url.pathname !== MCP_PATH) {
    return new Response(null, { status: 404 });
  }

  if (request.method === "OPTIONS") {
    return handlePreflight(request, url);
  }

  if (request.method !== "POST") {
    return new Response(null, {
      status: 405,
      headers: { Allow: "POST, OPTIONS" },
    });
  }

  try {
    validateOrigin(request.headers, url);
    await authorize(request.headers, config.access);
    await enforceRateLimit(request, env, config);
    return await mcpHandler.fetch(request);
  } catch (error) {
    return safeErrorResponse(error);
  }
}

function handlePreflight(request: Request, url: URL): Response {
  try {
    validateOrigin(request.headers, url);
  } catch (error) {
    return safeErrorResponse(error);
  }

  const origin = request.headers.get("origin");
  return new Response(null, {
    status: 204,
    headers: {
      ...(origin === null
        ? {}
        : { "Access-Control-Allow-Origin": origin, Vary: "Origin" }),
      "Access-Control-Allow-Headers":
        "authorization, content-type, mcp-protocol-version",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
  });
}

async function enforceRateLimit(
  request: Request,
  env: CloudflareEnv,
  config: AppConfig,
): Promise<void> {
  if (!config.ratelimit.enabled || env.MCP_RATE_LIMITER === undefined) {
    return;
  }

  const limiter = new CloudflareRateLimiter(
    env.MCP_RATE_LIMITER,
    windowSeconds(config.ratelimit.window),
  );
  const decision = await limiter.take(
    await clientKey(
      config.access,
      request.headers.get("cf-connecting-ip") ?? "unknown",
    ),
  );
  if (!decision.allowed) {
    throw new SafeError("RATE_LIMITED", "Too many requests", {
      retry_after_seconds: decision.retryAfterSeconds,
    });
  }
}

function windowSeconds(window: AppConfig["ratelimit"]["window"]): number {
  return window === "10s" ? 10 : 60;
}

function safeErrorResponse(error: unknown): Response {
  const safeError = error instanceof SafeError ? error : undefined;
  return new Response(
    JSON.stringify(
      safeError?.toPublic() ?? {
        code: "UPSTREAM_UNAVAILABLE",
        message: "Request could not be completed",
      },
    ),
    {
      status: safeErrorStatus(safeError),
      headers: {
        "content-type": "application/json",
        ...(safeError?.code === "AUTH_REQUIRED"
          ? { "www-authenticate": "Bearer" }
          : {}),
        ...(safeError?.retry_after_seconds === undefined
          ? {}
          : { "retry-after": String(safeError.retry_after_seconds) }),
      },
    },
  );
}

function safeErrorStatus(error: SafeError | undefined): number {
  switch (error?.code) {
    case "AUTH_REQUIRED":
      return 401;
    case "INVALID_INPUT":
      return 400;
    case "RATE_LIMITED":
      return 429;
    default:
      return 500;
  }
}

export default {
  fetch: async (request, env) => {
    try {
      const config = parseConfig(JSON.parse(env.MCP_CONFIG ?? ""));
      return await createCloudflareWorker({ config }).fetch(request, env);
    } catch (error) {
      return safeErrorResponse(error);
    }
  },
} satisfies ExportedHandler<CloudflareEnv>;
