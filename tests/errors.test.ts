import { expect, it } from "vitest";
import { SafeError } from "../src/domain/errors.js";

it("serializes only safe error fields", () => {
  const error = new SafeError("UPSTREAM_UNAVAILABLE", "Unavailable", {
    cause: new Error("raw-secret"),
  });

  expect(JSON.stringify(error.toPublic())).not.toContain("raw-secret");
  expect(error.toPublic()).toEqual({
    code: "UPSTREAM_UNAVAILABLE",
    message: "Unavailable",
  });
});

it("includes a known retry delay without upstream details", () => {
  const error = new SafeError("UPSTREAM_RATE_LIMITED", "Try again later", {
    retry_after_seconds: 12,
    headers: { authorization: "Bearer raw-secret" },
    body: "raw-secret",
    url: "https://api.example.test/?token=raw-secret",
  });

  expect(error.toPublic()).toEqual({
    code: "UPSTREAM_RATE_LIMITED",
    message: "Try again later",
    retry_after_seconds: 12,
  });
  expect(JSON.stringify(error.toPublic())).not.toContain("raw-secret");
});
