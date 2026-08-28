import { z } from "zod";

const providerSchema = z
  .object({
    enabled: z.boolean(),
    base_url: z.url(),
    token: z.string(),
  })
  .strict();

function validateCrossFields(
  config: AppConfig,
  context: z.RefinementCtx,
): void {
  const enabledProviders = Object.entries(config.providers).filter(
    ([, provider]) => provider.enabled,
  );

  if (enabledProviders.length === 0) {
    context.addIssue({
      code: "custom",
      message: "At least one provider must be enabled",
    });
  }

  if (!config.providers[config.search.default_provider].enabled) {
    context.addIssue({
      code: "custom",
      message: "Default provider must be enabled",
    });
  }

  if (config.providers.x.enabled && config.providers.x.token.length === 0) {
    context.addIssue({
      code: "custom",
      message: "X token is required when X is enabled",
    });
  }

  if (config.access.mode === "bearer" && config.access.token.length === 0) {
    context.addIssue({
      code: "custom",
      message: "access token is required for bearer access",
    });
  }
}

export const appConfigSchema = z
  .object({
    version: z.literal(1),
    access: z
      .object({ mode: z.enum(["anonymous", "bearer"]), token: z.string() })
      .strict(),
    search: z
      .object({
        default_provider: z.enum(["twitee", "x"]),
        allow_provider_override: z.boolean(),
      })
      .strict(),
    providers: z.object({ twitee: providerSchema, x: providerSchema }).strict(),
    ratelimit: z
      .object({
        enabled: z.boolean(),
        limit: z.number().int().positive(),
        window: z.enum(["10s", "1m"]),
      })
      .strict(),
  })
  .strict()
  .superRefine(validateCrossFields);

export type AppConfig = z.infer<typeof appConfigSchema>;

export const parseConfig = (value: unknown): AppConfig =>
  appConfigSchema.parse(value);
