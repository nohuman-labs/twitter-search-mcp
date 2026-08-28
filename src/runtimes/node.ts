import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { pathToFileURL } from "node:url";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { loadConfig } from "../config/load.js";
import type { AppConfig } from "../config/schema.js";
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
import { createLogger, type Logger } from "../core/logging.js";
import { MemoryRateLimiter, type RateLimiter } from "../core/ratelimit.js";
import {
  createMcpServer,
  type McpServerDependencies,
  serverVersion,
} from "../core/server.js";
import { SafeError } from "../domain/errors.js";

export type NodeServerOptions = {
  readonly config: AppConfig;
  readonly host?: string;
  readonly port?: number;
  readonly dependencies?: McpServerDependencies;
  readonly rateLimiter?: RateLimiter;
  readonly logger?: Logger;
  readonly mcpServerFactory?: typeof createMcpServer;
  readonly transportFactory?: () => NodeStreamableHTTPServerTransport;
};

const defaultHost = "127.0.0.1";
const defaultPort = 3000;

export async function createNodeServer(
  options: NodeServerOptions,
): Promise<Server> {
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
  const dependencies = options.dependencies ?? { fetch: globalThis.fetch };
  const mcpServerFactory = options.mcpServerFactory ?? createMcpServer;
  const transportFactory =
    options.transportFactory ??
    (() =>
      new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      }));

  const server = createServer((request, response) => {
    void handleRequest({
      request,
      response,
      config: options.config,
      dependencies,
      rateLimiter,
      logger,
      mcpServerFactory,
      transportFactory,
    });
  });

  await listen(
    server,
    options.port ?? defaultPort,
    options.host ?? defaultHost,
  );
  return server;
}

type RequestContext = {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly config: AppConfig;
  readonly dependencies: McpServerDependencies;
  readonly rateLimiter: RateLimiter | undefined;
  readonly logger: Logger;
  readonly mcpServerFactory: typeof createMcpServer;
  readonly transportFactory: () => NodeStreamableHTTPServerTransport;
};

async function handleRequest(context: RequestContext): Promise<void> {
  const { request, response } = context;
  const url = requestUrl(request);

  if (request.method === "GET" && url.pathname === HEALTH_PATH) {
    await writeResponse(response, healthResponse(serverVersion));
    return;
  }

  if (request.method === "GET" && url.pathname === READY_PATH) {
    await writeResponse(response, readyResponse(serverVersion, true));
    return;
  }

  if (url.pathname !== MCP_PATH) {
    response.statusCode = 404;
    response.end();
    return;
  }

  if (request.method === "OPTIONS") {
    await handlePreflight(context, url);
    return;
  }

  if (request.method !== "POST") {
    response.writeHead(405, { Allow: "POST, OPTIONS" });
    response.end();
    return;
  }

  await handleMcpRequest(context, url);
}

async function handlePreflight(
  { request, response, logger }: RequestContext,
  url: URL,
): Promise<void> {
  try {
    validateOrigin(requestHeaders(request), url);
  } catch (error) {
    await writeSafeError(response, error);
    logger({ method: "OPTIONS", path: MCP_PATH, status: response.statusCode });
    return;
  }

  const origin = request.headers.origin;
  response.writeHead(204, {
    ...(typeof origin === "string"
      ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
      : {}),
    "Access-Control-Allow-Headers":
      "authorization, content-type, mcp-protocol-version",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  });
  response.end();
  logger({ method: "OPTIONS", path: MCP_PATH, status: 204 });
}

async function handleMcpRequest(
  {
    request,
    response,
    config,
    dependencies,
    rateLimiter,
    logger,
    mcpServerFactory,
    transportFactory,
  }: RequestContext,
  url: URL,
): Promise<void> {
  try {
    const headers = requestHeaders(request);
    validateOrigin(headers, url);
    await authorize(headers, config.access);

    if (rateLimiter !== undefined) {
      const key = await clientKey(
        config.access,
        request.socket.remoteAddress ?? "unknown",
      );
      const decision = await rateLimiter.take(key);
      if (!decision.allowed) {
        throw new SafeError("RATE_LIMITED", "Too many requests", {
          retry_after_seconds: decision.retryAfterSeconds,
        });
      }
    }

    const transport = transportFactory();
    let mcpServer: ReturnType<typeof createMcpServer> | undefined;
    const teardown = once(async () => {
      await Promise.allSettled([
        transport.close(),
        ...(mcpServer === undefined ? [] : [mcpServer.close()]),
      ]);
    });
    const abort = () => {
      void teardown();
    };
    request.once("aborted", abort);
    response.once("close", abort);

    try {
      mcpServer = mcpServerFactory(config, dependencies);
      await mcpServer.connect(transport);
      await transport.handleRequest(request, response);
      logger({ method: "POST", path: MCP_PATH, status: response.statusCode });
    } finally {
      request.off("aborted", abort);
      response.off("close", abort);
      await teardown();
    }
  } catch (error) {
    if (!response.writableEnded && !response.destroyed) {
      await writeSafeError(response, error);
    }
    logger({
      method: "POST",
      path: MCP_PATH,
      status: response.statusCode,
      ...(error instanceof SafeError ? { code: error.code } : {}),
    });
  }
}

function once(operation: () => Promise<void>): () => Promise<void> {
  let result: Promise<void> | undefined;
  return () => {
    result ??= operation();
    return result;
  };
}

function requestUrl(request: IncomingMessage): URL {
  return new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "localhost"}`,
  );
}

function requestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) {
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
  }
  return headers;
}

async function writeSafeError(
  response: ServerResponse,
  error: unknown,
): Promise<void> {
  const safeError = error instanceof SafeError ? error : undefined;
  const status = safeErrorStatus(safeError);
  response.writeHead(status, {
    "content-type": "application/json",
    ...(safeError?.code === "AUTH_REQUIRED"
      ? { "www-authenticate": "Bearer" }
      : {}),
    ...(safeError?.retry_after_seconds === undefined
      ? {}
      : { "retry-after": String(safeError.retry_after_seconds) }),
  });
  response.end(
    JSON.stringify(
      safeError?.toPublic() ?? {
        code: "UPSTREAM_UNAVAILABLE",
        message: "Request could not be completed",
      },
    ),
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

async function writeResponse(
  response: ServerResponse,
  source: Response,
): Promise<void> {
  const headers = Object.fromEntries(source.headers.entries());
  response.writeHead(source.status, headers);
  response.end(Buffer.from(await source.arrayBuffer()));
}

function windowMilliseconds(window: AppConfig["ratelimit"]["window"]): number {
  return window === "10s" ? 10_000 : 60_000;
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

type CliOptions = {
  readonly configPath: string;
  readonly host: string;
  readonly port: number;
};

function parseCli(arguments_: readonly string[]): CliOptions {
  let configPath = "mcp.config.yaml";
  let host = defaultHost;
  let port = defaultPort;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (value === undefined) {
      throw new Error(`Missing value for ${argument}`);
    }

    switch (argument) {
      case "--config":
        configPath = value;
        break;
      case "--host":
        host = value;
        break;
      case "--port":
        port = Number(value);
        if (!Number.isInteger(port) || port < 0 || port > 65_535) {
          throw new Error("--port must be an integer from 0 to 65535");
        }
        break;
      default:
        throw new Error(`Unknown option: ${argument}`);
    }
    index += 1;
  }

  return { configPath, host, port };
}

async function runCli(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  const config = await loadConfig(options.configPath);
  await createNodeServer({ config, host: options.host, port: options.port });
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void runCli();
}
