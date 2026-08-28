export const safeErrorCodes = [
  "INVALID_INPUT",
  "PROVIDER_DISABLED",
  "CAPABILITY_UNSUPPORTED",
  "AUTH_REQUIRED",
  "RATE_LIMITED",
  "UPSTREAM_RATE_LIMITED",
  "UPSTREAM_UNAVAILABLE",
  "CONFIG_INVALID",
] as const;

export type SafeErrorCode = (typeof safeErrorCodes)[number];

type SafeErrorOptions = {
  cause?: unknown;
  retry_after_seconds?: number;
  headers?: unknown;
  body?: unknown;
  url?: unknown;
};

export class SafeError extends Error {
  readonly code: SafeErrorCode;
  readonly retry_after_seconds?: number;

  constructor(
    code: SafeErrorCode,
    message: string,
    options: SafeErrorOptions = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "SafeError";
    this.code = code;
    this.retry_after_seconds = options.retry_after_seconds;
  }

  toPublic(): {
    code: SafeErrorCode;
    message: string;
    retry_after_seconds?: number;
  } {
    return {
      code: this.code,
      message: this.message,
      ...(this.retry_after_seconds === undefined
        ? {}
        : { retry_after_seconds: this.retry_after_seconds }),
    };
  }
}
