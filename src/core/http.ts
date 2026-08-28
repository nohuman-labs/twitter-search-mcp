import { SafeError } from "../domain/errors.js";

export const MCP_PATH = "/mcp";
export const HEALTH_PATH = "/healthz";
export const READY_PATH = "/readyz";

const service = "twitter-search-mcp";

type HealthPayload = {
  readonly service: string;
  readonly version: string;
  readonly ready: boolean;
};

export function validateOrigin(
  headers: Headers,
  requestUrl: string | URL,
): void {
  if (!headers.has("origin")) {
    return;
  }

  const origin = headers.get("origin");
  if (origin === null) {
    throw invalidOrigin();
  }

  let originUrl: URL;
  let targetUrl: URL;
  try {
    originUrl = new URL(origin);
    targetUrl = new URL(requestUrl);
  } catch {
    throw invalidOrigin();
  }

  if (
    (originUrl.protocol !== "http:" && originUrl.protocol !== "https:") ||
    originUrl.origin !== origin ||
    originUrl.host !== targetUrl.host
  ) {
    throw invalidOrigin();
  }
}

export function healthResponse(version: string): Response {
  return jsonHealth({ service, version, ready: true });
}

export function readyResponse(version: string, ready: boolean): Response {
  return jsonHealth({ service, version, ready }, ready ? 200 : 503);
}

function jsonHealth(payload: HealthPayload, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function invalidOrigin(): SafeError {
  return new SafeError("INVALID_INPUT", "Invalid origin");
}
