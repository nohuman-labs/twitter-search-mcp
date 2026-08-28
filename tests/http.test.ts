import { expect, it } from "vitest";
import {
  HEALTH_PATH,
  healthResponse,
  MCP_PATH,
  READY_PATH,
  readyResponse,
  validateOrigin,
} from "../src/core/http.js";

it("defines the canonical HTTP paths", () => {
  expect({ MCP_PATH, HEALTH_PATH, READY_PATH }).toEqual({
    MCP_PATH: "/mcp",
    HEALTH_PATH: "/healthz",
    READY_PATH: "/readyz",
  });
});

it("allows originless non-browser clients", () => {
  expect(() =>
    validateOrigin(new Headers(), "https://mcp.example.test/mcp"),
  ).not.toThrow();
});

it("allows an HTTP origin whose host matches the request host", () => {
  expect(() =>
    validateOrigin(
      new Headers({ origin: "http://mcp.example.test" }),
      "https://mcp.example.test/mcp",
    ),
  ).not.toThrow();
});

it("rejects a cross-origin browser request", () => {
  expect(() =>
    validateOrigin(
      new Headers({ origin: "https://other.example.test" }),
      "https://mcp.example.test/mcp",
    ),
  ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
});

it("rejects malformed, opaque, and non-HTTP origins", () => {
  for (const origin of ["null", "not a url", "file:///tmp/page"]) {
    expect(() =>
      validateOrigin(new Headers({ origin }), "https://mcp.example.test/mcp"),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
  }
});

it("returns generic health JSON without configuration details", async () => {
  const health = await healthResponse("1.2.3").json();
  const ready = await readyResponse("1.2.3", true).json();

  expect(health).toEqual({
    service: "twitter-search-mcp",
    version: "1.2.3",
    ready: true,
  });
  expect(ready).toEqual(health);
});
