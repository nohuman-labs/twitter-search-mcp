import type { AppConfig } from "../config/schema.js";
import { SafeError } from "../domain/errors.js";

export type AccessConfig = AppConfig["access"];

export async function authorize(
  headers: Headers,
  access: AccessConfig,
): Promise<void> {
  if (access.mode === "anonymous") {
    return;
  }

  const suppliedToken = bearerToken(headers.get("authorization"));
  if (suppliedToken === undefined) {
    throw authRequired();
  }

  const [suppliedDigest, configuredDigest] = await Promise.all([
    bearerDigest(suppliedToken),
    bearerDigest(access.token),
  ]);

  if (!equalDigests(suppliedDigest, configuredDigest)) {
    throw authRequired();
  }
}

export async function bearerDigest(token: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
  );
}

function bearerToken(authorization: string | null): string | undefined {
  if (authorization === null) {
    return undefined;
  }

  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  return match?.[1];
}

function equalDigests(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }

  return difference === 0;
}

function authRequired(): SafeError {
  return new SafeError("AUTH_REQUIRED", "Authentication required");
}
