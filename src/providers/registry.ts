import type { AppConfig } from "../config/schema.js";
import { SafeError } from "../domain/errors.js";
import type { ProviderId, ToolName } from "../domain/types.js";
import type { SearchProvider } from "./provider.js";

const capabilityForTool = {
  search_posts: "searchPosts",
  lookup_profile: "lookupProfile",
  search_profiles: "searchProfiles",
} as const;

export class ProviderRegistry {
  readonly #providers: Map<ProviderId, SearchProvider>;

  constructor(
    private readonly config: AppConfig,
    providers: readonly SearchProvider[],
  ) {
    this.#providers = new Map(
      providers.map((provider) => [provider.id, provider]),
    );
  }

  resolve(tool: ToolName, override?: ProviderId): SearchProvider {
    const providerId = override ?? this.config.search.default_provider;

    if (
      override !== undefined &&
      override !== this.config.search.default_provider &&
      !this.config.search.allow_provider_override
    ) {
      throw new SafeError("INVALID_INPUT", "Provider override is not allowed");
    }

    if (!this.config.providers[providerId].enabled) {
      throw new SafeError("PROVIDER_DISABLED", "Selected provider is disabled");
    }

    const provider = this.#providers.get(providerId);
    if (provider === undefined) {
      throw new SafeError(
        "CONFIG_INVALID",
        "Selected provider is not configured",
      );
    }

    if (!provider.capabilities[capabilityForTool[tool]]) {
      throw new SafeError(
        "CAPABILITY_UNSUPPORTED",
        "Selected provider does not support this capability",
      );
    }

    return provider;
  }
}
