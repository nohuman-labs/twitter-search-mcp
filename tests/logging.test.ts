import { expect, it, vi } from "vitest";
import { createLogger } from "../src/core/logging.js";

function captureLog(
  logger: ReturnType<typeof createLogger>,
  fields: Record<string, unknown>,
): string {
  const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
  logger(fields);
  const line = output.mock.calls[0]?.[0];
  output.mockRestore();
  return String(line);
}

it("redacts configured and supplied tokens recursively", () => {
  const output = captureLog(createLogger(["configured", "supplied"]), {
    authorization: "Bearer supplied",
    cause: { upstreamToken: "configured" },
  });

  expect(output).not.toContain("configured");
  expect(output).not.toContain("supplied");
  expect(JSON.parse(output)).toEqual({
    authorization: "[REDACTED]",
    cause: { upstreamToken: "[REDACTED]" },
  });
});

it("writes structured request fields but excludes queries", () => {
  const output = captureLog(createLogger([]), {
    requestId: "request-1",
    tool: "search_posts",
    provider: "x",
    durationMs: 14,
    status: "ok",
    count: 2,
    query: "private search",
  });

  expect(JSON.parse(output)).toEqual({
    requestId: "request-1",
    tool: "search_posts",
    provider: "x",
    durationMs: 14,
    status: "ok",
    count: 2,
  });
});
