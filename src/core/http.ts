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

export function addCorsHeaders(
  responseHeaders: Headers,
  requestHeaders: Headers,
): void {
  const origin = requestHeaders.get("origin");
  if (origin === null) return;

  responseHeaders.set("Access-Control-Allow-Origin", origin);
  const vary = responseHeaders.get("Vary");
  const values =
    vary === null
      ? []
      : vary
          .split(",")
          .map((value) => value.trim())
          .filter((value) => value.length > 0);
  if (!values.some((value) => value.toLowerCase() === "origin")) {
    values.push("Origin");
  }
  responseHeaders.set("Vary", values.join(", "));
}

export function withCorsHeaders(
  response: Response,
  requestHeaders: Headers,
): Response {
  if (!requestHeaders.has("origin")) return response;

  const headers = new Headers(response.headers);
  addCorsHeaders(headers, requestHeaders);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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
