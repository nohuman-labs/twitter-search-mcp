import { z } from "zod";
import { SafeError } from "./errors.js";
import type { ProviderId, ToolName } from "./types.js";

const cursorSchema = z
  .object({
    v: z.literal(1),
    tool: z.enum(["search_posts", "lookup_profile", "search_profiles"]),
    provider: z.enum(["twitee", "x"]),
    query: z.string(),
    continuation: z.json(),
  })
  .strict();

export type Cursor = z.infer<typeof cursorSchema>;

export type CursorContext = Pick<Cursor, "tool" | "provider" | "query">;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

const encodeBase64Url = (value: string): string => {
  const bytes = textEncoder.encode(value);
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
};

const decodeBase64Url = (value: string): string => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Invalid base64url");
  }

  const padded = `${value.replaceAll("-", "+").replaceAll("_", "/")}${"=".repeat((4 - (value.length % 4)) % 4)}`;
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));

  return textDecoder.decode(bytes);
};

export const encodeCursor = (cursor: Cursor): string =>
  encodeBase64Url(JSON.stringify(cursorSchema.parse(cursor)));

export const decodeCursor = (
  cursor: string,
  context: { tool: ToolName; provider: ProviderId; query: string },
): Cursor["continuation"] => {
  let value: unknown;

  try {
    value = JSON.parse(decodeBase64Url(cursor));
  } catch {
    throw new SafeError("INVALID_INPUT", "Invalid cursor");
  }

  const parsed = cursorSchema.safeParse(value);
  if (!parsed.success) {
    throw new SafeError("INVALID_INPUT", "Invalid cursor");
  }

  if (
    parsed.data.tool !== context.tool ||
    parsed.data.provider !== context.provider ||
    parsed.data.query !== context.query
  ) {
    throw new SafeError(
      "INVALID_INPUT",
      "Cursor context does not match request",
    );
  }

  return parsed.data.continuation;
};
