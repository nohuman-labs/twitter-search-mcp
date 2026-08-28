import { Buffer } from "node:buffer";
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

export const encodeCursor = (cursor: Cursor): string =>
  Buffer.from(JSON.stringify(cursorSchema.parse(cursor))).toString("base64url");

export const decodeCursor = (
  cursor: string,
  context: { tool: ToolName; provider: ProviderId; query: string },
): Cursor["continuation"] => {
  let value: unknown;

  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
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
