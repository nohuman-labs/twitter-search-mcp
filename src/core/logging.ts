export type LogFields = Record<string, unknown>;
export type Logger = (fields: LogFields) => void;

export function createLogger(tokens: readonly string[]): Logger {
  const redactionTokens = tokens.filter((token) => token.length > 0);

  return (fields) => {
    console.log(JSON.stringify(redact(fields, redactionTokens, new WeakSet())));
  };
}

function redact(
  value: unknown,
  tokens: readonly string[],
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "string") {
    return redactString(value, tokens);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, tokens, seen));
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return "[CIRCULAR]";
  }
  seen.add(value);

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey === "query") {
      continue;
    }
    if (
      normalizedKey.includes("authorization") ||
      normalizedKey.includes("token")
    ) {
      result[key] = "[REDACTED]";
      continue;
    }
    result[key] = redact(item, tokens, seen);
  }

  return result;
}

function redactString(value: string, tokens: readonly string[]): string {
  return tokens.reduce(
    (redacted, token) => redacted.split(token).join("[REDACTED]"),
    value,
  );
}
