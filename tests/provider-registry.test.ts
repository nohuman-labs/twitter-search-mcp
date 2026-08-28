import { expect, it } from "vitest";
import type { AppConfig } from "../src/config/schema.js";
import type { SearchProvider } from "../src/providers/provider.js";
import { ProviderRegistry } from "../src/providers/registry.js";

const config: AppConfig = {
  version: 1,
  access: { mode: "anonymous", token: "" },
  search: { default_provider: "x", allow_provider_override: true },
  providers: {
    twitee: { enabled: true, base_url: "https://twitee.test", token: "" },
    x: { enabled: true, base_url: "https://x.test", token: "token" },
  },
  ratelimit: { enabled: false, limit: 60, window: "1m" },
};

const provider = (
  id: SearchProvider["id"],
  capabilities: SearchProvider["capabilities"],
): SearchProvider => ({
  id,
  capabilities,
  searchPosts: async () => {
    throw new Error("not called");
  },
  lookupProfile: async () => {
    throw new Error("not called");
  },
});

const registryWithDefaultXAndTwitee = () =>
  new ProviderRegistry(config, [
    provider("x", {
      searchPosts: true,
      lookupProfile: true,
      searchProfiles: false,
    }),
    provider("twitee", {
      searchPosts: true,
      lookupProfile: true,
      searchProfiles: true,
    }),
  ]);

it("does not fallback when the default lacks a capability", () => {
  const registry = registryWithDefaultXAndTwitee();

  expect(() => registry.resolve("search_profiles")).toThrowError(
    expect.objectContaining({ code: "CAPABILITY_UNSUPPORTED" }),
  );
});

it("rejects disabled selected providers before checking capabilities", () => {
  const disabledX = structuredClone(config);
  disabledX.providers.x.enabled = false;
  const registry = new ProviderRegistry(disabledX, [
    provider("x", {
      searchPosts: true,
      lookupProfile: true,
      searchProfiles: true,
    }),
  ]);

  expect(() => registry.resolve("search_profiles", "x")).toThrowError(
    expect.objectContaining({ code: "PROVIDER_DISABLED" }),
  );
});

it("enforces the provider override policy before checking the provider", () => {
  const overridesDisabled = structuredClone(config);
  overridesDisabled.search.allow_provider_override = false;
  const registry = new ProviderRegistry(overridesDisabled, [
    provider("x", {
      searchPosts: true,
      lookupProfile: true,
      searchProfiles: true,
    }),
    provider("twitee", {
      searchPosts: true,
      lookupProfile: true,
      searchProfiles: true,
    }),
  ]);

  expect(() => registry.resolve("search_posts", "twitee")).toThrowError(
    expect.objectContaining({ code: "INVALID_INPUT" }),
  );
});
