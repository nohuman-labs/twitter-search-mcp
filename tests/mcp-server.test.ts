import { expect, it } from "vitest";
import type { AppConfig } from "../src/config/schema.js";
import { createMcpServer } from "../src/core/server.js";

const config: AppConfig = {
  version: 1,
  access: { mode: "anonymous", token: "" },
  search: { default_provider: "x", allow_provider_override: true },
  providers: {
    twitee: { enabled: false, base_url: "https://twitee.test", token: "" },
    x: { enabled: true, base_url: "https://x.test", token: "token" },
  },
  ratelimit: { enabled: false, limit: 60, window: "1m" },
};

it("creates an X-only server with the approved identity and tools", () => {
  const server = createMcpServer(config, {
    fetch: async () => new Response(JSON.stringify({ data: [], meta: {} })),
  });
  const registered = server as unknown as {
    readonly server: {
      readonly _serverInfo: { readonly name: string; readonly version: string };
    };
    readonly _registeredTools: Record<string, unknown>;
  };

  expect(registered.server._serverInfo).toEqual({
    name: "twitter-search-mcp",
    version: "1.0.0",
  });
  expect(Object.keys(registered._registeredTools)).toEqual([
    "search_posts",
    "lookup_profile",
  ]);
});
