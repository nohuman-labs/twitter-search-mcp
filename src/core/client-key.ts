import type { AccessConfig } from "./access.js";
import { bearerDigest } from "./access.js";

export async function clientKey(
  access: AccessConfig,
  vettedAddress: string,
): Promise<string> {
  if (access.mode === "anonymous") {
    return vettedAddress;
  }

  return toHex(await bearerDigest(access.token));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
