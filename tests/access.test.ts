import { expect, it } from "vitest";
import { authorize } from "../src/core/access.js";
import { clientKey } from "../src/core/client-key.js";

it("rejects a wrong shared bearer token", async () => {
  await expect(
    authorize(new Headers({ authorization: "Bearer wrong" }), {
      mode: "bearer",
      token: "correct",
    }),
  ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
});

it("accepts the configured shared bearer token", async () => {
  await expect(
    authorize(new Headers({ authorization: "Bearer correct" }), {
      mode: "bearer",
      token: "correct",
    }),
  ).resolves.toBeUndefined();
});

it("allows anonymous requests without an authorization header", async () => {
  await expect(
    authorize(new Headers(), { mode: "anonymous", token: "" }),
  ).resolves.toBeUndefined();
});

it("uses a fixed-length digest instead of the bearer token as its client key", async () => {
  const key = await clientKey(
    { mode: "bearer", token: "correct" },
    "trusted-address",
  );

  expect(key).toHaveLength(64);
  expect(key).not.toContain("correct");
  expect(key).not.toContain("trusted-address");
});

it("uses the runtime-vetted address as the anonymous client key", async () => {
  await expect(
    clientKey({ mode: "anonymous", token: "" }, "203.0.113.7"),
  ).resolves.toBe("203.0.113.7");
});
