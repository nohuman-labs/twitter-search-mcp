import { expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config/schema.js";
import { SafeError } from "../src/domain/errors.js";
import type { SearchPostsResult } from "../src/domain/types.js";
import type { SearchProvider } from "../src/providers/provider.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import {
  registerSearchTools,
  type SearchToolsContext,
  searchPostsInputSchema,
} from "../src/tools/register.js";

type RegisteredTool = {
  readonly name: string;
  readonly config: {
    readonly annotations?: unknown;
    readonly description?: string;
  };
  readonly handler: (input: Record<string, unknown>) => Promise<unknown>;
};

const config = (defaultProvider: "twitee" | "x"): AppConfig => ({
  version: 1,
  access: { mode: "anonymous", token: "" },
  search: { default_provider: defaultProvider, allow_provider_override: true },
  providers: {
    twitee: {
      enabled: defaultProvider === "twitee",
      base_url: "https://twitee.test",
      token: "",
    },
    x: {
      enabled: defaultProvider === "x",
      base_url: "https://x.test",
      token: "token",
    },
  },
  ratelimit: { enabled: false, limit: 60, window: "1m" },
});

const result: SearchPostsResult = {
  provider: "twitee",
  status: "ready",
  items: [],
  pagination: { next_cursor: null, has_more: false },
  metadata: { generated_at: "2026-08-28T00:00:00.000Z" },
};

const provider = (
  id: SearchProvider["id"],
  searchPosts: SearchProvider["searchPosts"] = async () => result,
): SearchProvider => ({
  id,
  capabilities: {
    searchPosts: true,
    lookupProfile: true,
    searchProfiles: id === "twitee",
  },
  searchPosts,
  lookupProfile: async () => ({ ...result, items: [] }),
  ...(id === "twitee"
    ? { searchProfiles: async () => ({ ...result, items: [] }) }
    : {}),
});

const context = (
  defaultProvider: "twitee" | "x",
  providers: readonly SearchProvider[],
): SearchToolsContext => ({
  registry: new ProviderRegistry(config(defaultProvider), providers),
  providers,
});

function captureTools(context: SearchToolsContext): RegisteredTool[] {
  const tools: RegisteredTool[] = [];
  registerSearchTools(
    {
      registerTool: (
        name: string,
        toolConfig: RegisteredTool["config"],
        handler: RegisteredTool["handler"],
      ) => {
        tools.push({ name, config: toolConfig, handler });
      },
    } as never,
    context,
  );
  return tools;
}

function tool(tools: readonly RegisteredTool[], name: string): RegisteredTool {
  const found = tools.find((entry) => entry.name === name);
  if (found === undefined) {
    throw new Error(`Missing ${name}`);
  }
  return found;
}

it("omits search_profiles for X-only", () => {
  const registerTool = vi.fn();
  registerSearchTools({ registerTool } as never, context("x", [provider("x")]));

  expect(registerTool.mock.calls.map(([name]) => name)).toEqual([
    "search_posts",
    "lookup_profile",
  ]);
});

it("returns structured content and an equal JSON fallback", async () => {
  const call = tool(
    captureTools(context("twitee", [provider("twitee")])),
    "search_posts",
  );

  const response = await call.handler({ query: "mcp", limit: 20 });
  const result = response as {
    readonly content: readonly { readonly text: string }[];
    readonly structuredContent: unknown;
  };

  expect(result.structuredContent).toMatchObject({
    provider: "twitee",
    status: "ready",
  });
  expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
});

it("uses the common default and maximum search limit", () => {
  expect(searchPostsInputSchema.parse({ query: "mcp" })).toMatchObject({
    query: "mcp",
    limit: 20,
  });
  expect(() =>
    searchPostsInputSchema.parse({ query: "mcp", limit: 51 }),
  ).toThrow();
});

it("returns only a safe public error when provider resolution fails", async () => {
  const searchPosts = vi.fn(async () => result);
  const disabled = config("x");
  disabled.providers.x.enabled = false;
  const tools = captureTools({
    registry: new ProviderRegistry(disabled, [provider("x", searchPosts)]),
    providers: [provider("x", searchPosts)],
  });

  const response = (await tool(tools, "search_posts").handler({
    query: "mcp",
    cursor: "not-a-cursor",
  })) as {
    readonly isError: boolean;
    readonly content: readonly { readonly text: string }[];
  };

  expect(response.isError).toBe(true);
  expect(JSON.parse(response.content[0].text)).toEqual({
    code: "PROVIDER_DISABLED",
    message: "Selected provider is disabled",
  });
  expect(searchPosts).not.toHaveBeenCalled();
});

it("does not expose SafeError causes", async () => {
  const tools = captureTools(
    context("twitee", [
      provider("twitee", async () => {
        throw new SafeError("UPSTREAM_UNAVAILABLE", "Unavailable", {
          cause: new Error("raw-upstream-secret"),
        });
      }),
    ]),
  );

  const response = (await tool(tools, "search_posts").handler({
    query: "mcp",
  })) as {
    readonly content: readonly { readonly text: string }[];
  };

  expect(response.content[0].text).not.toContain("raw-upstream-secret");
});

it("returns a generic safe error for unexpected provider failures", async () => {
  const tools = captureTools(
    context("twitee", [
      provider("twitee", async () => {
        throw new Error("unexpected-sensitive-marker");
      }),
    ]),
  );

  const response = (await tool(tools, "search_posts").handler({
    query: "mcp",
  })) as {
    readonly isError: boolean;
    readonly content: readonly { readonly text: string }[];
  };

  expect(response.isError).toBe(true);
  expect(JSON.parse(response.content[0].text)).toEqual({
    code: "UPSTREAM_UNAVAILABLE",
    message: "Search provider is temporarily unavailable",
  });
  expect(response.content[0].text).not.toContain("unexpected-sensitive-marker");
});
