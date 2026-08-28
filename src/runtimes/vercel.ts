import { createMcpHandler } from "mcp-handler";
import type { AppConfig } from "../config/schema.js";
import { authorize } from "../core/access.js";
import { clientKey } from "../core/client-key.js";
import { MCP_PATH, validateOrigin } from "../core/http.js";
import { createLogger, type Logger } from "../core/logging.js";
import { MemoryRateLimiter, type RateLimiter } from "../core/ratelimit.js";
import {
  type McpServerDependencies,
  registerMcpServer,
  serverVersion,
} from "../core/server.js";
import { SafeError } from "../domain/errors.js";

export type VercelHandler = (request: Request) => Promise<Response>;

export type VercelHandlerOptions = {
  readonly config: AppConfig;
  readonly dependencies?: McpServerDependencies;
  readonly rateLimiter?: RateLimiter;
  readonly logger?: Logger;
  readonly mcpHandler?: VercelHandler;
};

export function createVercelHandler(
  options: VercelHandlerOptions,
): VercelHandler {
  const dependencies = options.dependencies ?? { fetch: globalThis.fetch };
  const rateLimiter = options.config.ratelimit.enabled
    ? (options.rateLimiter ??
      new MemoryRateLimiter({
        limit: options.config.ratelimit.limit,
        windowMs: windowMilliseconds(options.config.ratelimit.window),
      }))
    : undefined;
  const logger =
    options.logger ??
    createLogger([
      options.config.access.token,
      options.config.providers.twitee.token,
      options.config.providers.x.token,
    ]);
  const mcpHandler =
    options.mcpHandler ??
    createMcpHandler(
      (server) => registerMcpServer(server, options.config, dependencies),
      {
        serverInfo: { name: "twitter-search-mcp", version: serverVersion },
        maxSubscriptions: 0,
      },
    );

  return async (request) => {
    if (request.method === "OPTIONS") {
      return handlePreflight(request, logger);
    }

    if (request.method !== "POST") {
      return new Response(null, {
        status: 405,
        headers: { Allow: "POST, OPTIONS" },
      });
    }

    try {
      validateOrigin(request.headers, request.url);
      await authorize(request.headers, options.config.access);
      await enforceRateLimit(request, options.config, rateLimiter);
      const response = await mcpHandler(request);
      logger({ method: "POST", path: MCP_PATH, status: response.status });
      return response;
    } catch (error) {
      const response = safeErrorResponse(error);
      logger({
        method: "POST",
        path: MCP_PATH,
        status: response.status,
        ...(error instanceof SafeError ? { code: error.code } : {}),
      });
      return response;
    }
  };
}

function handlePreflight(request: Request, logger: Logger): Response {
  try {
    validateOrigin(request.headers, request.url);
  } catch (error) {
    const response = safeErrorResponse(error);
    logger({
      method: "OPTIONS",
      path: MCP_PATH,
      status: response.status,
      ...(error instanceof SafeError ? { code: error.code } : {}),
    });
    return response;
  }

  const origin = request.headers.get("origin");
  const response = new Response(null, {
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
  logger({ method: "OPTIONS", path: MCP_PATH, status: response.status });
  return response;
}

async function enforceRateLimit(
  request: Request,
  config: AppConfig,
  rateLimiter: RateLimiter | undefined,
): Promise<void> {
  if (rateLimiter === undefined) {
    return;
  }

  const decision = await rateLimiter.take(
    await clientKey(config.access, clientAddress(request)),
  );
  if (!decision.allowed) {
    throw new SafeError("RATE_LIMITED", "Too many requests", {
      retry_after_seconds: decision.retryAfterSeconds,
    });
  }
}

function clientAddress(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown"
  );
}

function windowMilliseconds(window: AppConfig["ratelimit"]["window"]): number {
  return window === "10s" ? 10_000 : 60_000;
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
