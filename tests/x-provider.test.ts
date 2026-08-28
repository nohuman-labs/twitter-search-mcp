import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { decodeCursor } from "../src/domain/cursor.js";
import { createXProvider } from "../src/providers/x.js";

const fixture = async (name: string): Promise<unknown> =>
  JSON.parse(
    await readFile(new URL(`./fixtures/x/${name}`, import.meta.url), "utf8"),
  );

const fixtureFetch = (name: string) =>
  vi.fn(async () => new Response(JSON.stringify(await fixture(name))));

const options = () => ({
  baseUrl: "https://x.test",
  token: "x-secret",
  fetch: fixtureFetch("recent-search.json"),
});

it("uses the configured URL, bearer token, and required post fields", async () => {
  const fetch = fixtureFetch("recent-search.json");
  const provider = createXProvider({
    baseUrl: "https://x.test/",
    token: "x-secret",
    fetch,
  });

  await provider.searchPosts({ query: "mcp", limit: 20, cursor: null });

  const [url, init] = fetch.mock.calls[0] ?? [];
  expect(url).toBeTypeOf("string");
  const request = new URL(url as string);
  expect(request.origin + request.pathname).toBe(
    "https://x.test/2/tweets/search/recent",
  );
  expect(request.searchParams.get("query")).toBe("mcp");
  expect(request.searchParams.get("max_results")).toBe("20");
  expect(request.searchParams.get("expansions")).toBe(
    "author_id,attachments.media_keys",
  );
  expect(request.searchParams.get("tweet.fields")).toBe(
    "created_at,public_metrics,author_id,attachments",
  );
  expect(request.searchParams.get("user.fields")).toBe(
    "id,name,username,description,profile_image_url,verified,public_metrics",
  );
  expect(request.searchParams.get("media.fields")).toBe(
    "media_key,type,url,preview_image_url",
  );
  expect((init as RequestInit).headers).toMatchObject({
    authorization: "Bearer x-secret",
  });
});

it("uses X's legal minimum page size while honoring a smaller result limit", async () => {
  const fetch = fixtureFetch("recent-search.json");
  const provider = createXProvider({ ...options(), fetch });

  const result = await provider.searchPosts({
    query: "mcp",
    limit: 3,
    cursor: null,
  });

  const [url] = fetch.mock.calls[0] ?? [];
  expect(new URL(url as string).searchParams.get("max_results")).toBe("10");
  expect(result.items.length).toBeLessThanOrEqual(3);
});

it("buffers the unused part of an X page without gaps or duplicates", async () => {
  const payload = (await fixture("recent-search.json")) as {
    data: Array<Record<string, unknown>>;
    meta: { next_token?: string };
  };
  const firstPage = structuredClone(payload);
  firstPage.data = Array.from({ length: 10 }, (_, index) => ({
    ...payload.data[0],
    id: String(index),
  }));
  firstPage.meta.next_token = "page-2";
  const secondPage = structuredClone(payload);
  secondPage.data = Array.from({ length: 10 }, (_, index) => ({
    ...payload.data[0],
    id: String(index + 10),
  }));
  secondPage.meta = {};
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(firstPage)))
    .mockResolvedValueOnce(new Response(JSON.stringify(secondPage)));
  const provider = createXProvider({ ...options(), fetch });

  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const result = await provider.searchPosts({
      query: "mcp",
      limit: 3,
      cursor,
    });
    seen.push(...result.items.map((item) => item.id));
    cursor = result.pagination.next_cursor;
  } while (cursor !== null);

  expect(seen).toEqual(Array.from({ length: 20 }, (_, index) => String(index)));
  expect(new Set(seen).size).toBe(seen.length);
  expect(fetch).toHaveBeenCalledTimes(2);
  const secondUrl = new URL(fetch.mock.calls[1]?.[0] as string);
  expect(secondUrl.searchParams.get("next_token")).toBe("page-2");
});

it("times out a hanging X request and exposes only a safe error", async () => {
  let upstreamSignal: AbortSignal | undefined;
  const provider = createXProvider({
    ...options(),
    requestTimeoutMs: 10,
    fetch: async (_input, init) => {
      upstreamSignal = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        const fallback = setTimeout(
          () => reject(new Error("raw-x-timeout-marker")),
          150,
        );
        upstreamSignal?.addEventListener(
          "abort",
          () => {
            clearTimeout(fallback);
            reject(new Error("raw-x-abort-marker"));
          },
          { once: true },
        );
      });
    },
  });
  const startedAt = Date.now();

  const error = await provider
    .searchPosts({ query: "mcp", limit: 20, cursor: null })
    .catch((caught: unknown) => caught);

  expect(Date.now() - startedAt).toBeLessThan(100);
  expect(upstreamSignal?.aborted).toBe(true);
  expect(error).toMatchObject({
    code: "UPSTREAM_UNAVAILABLE",
    message: "X is temporarily unavailable",
  });
  expect(JSON.stringify(error.toPublic())).not.toContain("raw-x");
});

it("fails promptly when the caller signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const provider = createXProvider({
    ...options(),
    requestTimeoutMs: 250,
    fetch: async () => await new Promise<Response>(() => {}),
  });
  const startedAt = Date.now();

  await expect(
    provider.searchPosts({
      query: "mcp",
      limit: 20,
      cursor: null,
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  expect(Date.now() - startedAt).toBeLessThan(100);
});

it("normalizes posts, caps output, and wraps the X continuation", async () => {
  const payload = (await fixture("recent-search.json")) as {
    data: unknown[];
  };
  payload.data = Array.from({ length: 51 }, (_, index) => ({
    ...(payload.data[0] as object),
    id: String(index),
  }));
  const provider = createXProvider({
    ...options(),
    fetch: vi.fn(async () => new Response(JSON.stringify(payload))),
  });

  const result = await provider.searchPosts({
    query: "mcp",
    limit: 50,
    cursor: null,
  });

  expect(result).toMatchObject({
    provider: "x",
    status: "ready",
    pagination: { has_more: true },
  });
  expect(result.items[0]).toMatchObject({
    id: "0",
    text: "MCP is here",
    created_at: "2026-08-28T00:00:00.000Z",
    author: {
      id: "42",
      handle: "openai",
      name: "OpenAI",
      description: "AI research and deployment",
      profile_image_url: "https://cdn.x.test/openai.jpg",
      verified: true,
      followers_count: 1000,
      following_count: 10,
    },
    metrics: {
      reply_count: 2,
      repost_count: 3,
      like_count: 12,
      quote_count: 1,
    },
    media: [
      {
        type: "photo",
        url: "https://cdn.x.test/mcp.jpg",
        preview_url: "https://cdn.x.test/mcp-thumb.jpg",
      },
    ],
  });
  expect(result.items).toHaveLength(50);
  expect(result.pagination.next_cursor).not.toContain("next-secret-token");
  expect(
    decodeCursor(result.pagination.next_cursor ?? "", {
      tool: "search_posts",
      provider: "x",
      query: "mcp",
    }),
  ).toEqual({ next_token: "next-secret-token" });
});

it("sends an opaque cursor continuation only for its matching query", async () => {
  const fetch = fixtureFetch("recent-search.json");
  const provider = createXProvider({ ...options(), fetch });
  const first = await provider.searchPosts({
    query: "mcp",
    limit: 20,
    cursor: null,
  });

  await provider.searchPosts({
    query: "mcp",
    limit: 20,
    cursor: first.pagination.next_cursor,
  });

  const [url] = fetch.mock.calls[1] ?? [];
  expect(new URL(url as string).searchParams.get("next_token")).toBe(
    "next-secret-token",
  );
  await expect(
    provider.searchPosts({
      query: "other",
      limit: 20,
      cursor: first.pagination.next_cursor,
    }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
});

it("normalizes exact handles for profile lookup", async () => {
  const fetch = fixtureFetch("user-lookup.json");
  const provider = createXProvider({ ...options(), fetch });

  const result = await provider.lookupProfile({ handle: " @OpenAI " });

  const [url, init] = fetch.mock.calls[0] ?? [];
  expect(url).toBe(
    "https://x.test/2/users/by/username/openai?user.fields=id%2Cname%2Cusername%2Cdescription%2Cprofile_image_url%2Cverified%2Cpublic_metrics",
  );
  expect((init as RequestInit).headers).toMatchObject({
    authorization: "Bearer x-secret",
  });
  expect(result).toMatchObject({
    provider: "x",
    status: "ready",
    items: [
      {
        id: "42",
        handle: "openai",
        name: "OpenAI",
        followers_count: 1000,
        following_count: 10,
      },
    ],
    pagination: { next_cursor: null, has_more: false },
  });
});

it("rejects invalid profile handles before calling X", async () => {
  const fetch = fixtureFetch("user-lookup.json");
  const provider = createXProvider({ ...options(), fetch });

  await expect(
    provider.lookupProfile({ handle: "https://x.com/openai" }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  expect(fetch).not.toHaveBeenCalled();
});

it("maps X rate limits without exposing the upstream error body", async () => {
  const reset = Math.floor(Date.now() / 1000) + 19;
  const provider = createXProvider({
    ...options(),
    fetch: async () => {
      const response = new Response(
        JSON.stringify(await fixture("error-429.json")),
        {
          status: 429,
        },
      );
      response.headers.set("x-rate-limit-reset", String(reset));
      return response;
    },
  });

  await expect(
    provider.searchPosts({ query: "mcp", limit: 20, cursor: null }),
  ).rejects.toMatchObject({
    code: "UPSTREAM_RATE_LIMITED",
    retry_after_seconds: expect.any(Number),
  });
  await expect(
    provider.searchPosts({ query: "mcp", limit: 20, cursor: null }),
  ).rejects.not.toThrow("secret upstream diagnostic");
});

it("does not claim fuzzy people search", () => {
  expect(createXProvider(options()).capabilities.searchProfiles).toBe(false);
  expect(createXProvider(options()).searchProfiles).toBeUndefined();
});
