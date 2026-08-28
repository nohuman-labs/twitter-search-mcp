import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { decodeCursor } from "../src/domain/cursor.js";
import { createTwiteeProvider } from "../src/providers/twitee.js";

const fixture = async (name: string): Promise<unknown> =>
  JSON.parse(
    await readFile(
      new URL(`./fixtures/twitee/${name}`, import.meta.url),
      "utf8",
    ),
  );

const responseFor = async (name: string, status = 200) =>
  new Response(JSON.stringify(await fixture(name)), { status });

it("maps latest results and an opaque continuation", async () => {
  const fetch = vi.fn(async () => responseFor("latest-ready.json"));
  const provider = createTwiteeProvider({
    baseUrl: "https://twitee.test",
    token: "",
    fetch,
    sleep: async () => {},
  });

  const result = await provider.searchPosts({
    query: "mcp",
    limit: 20,
    cursor: null,
  });

  expect(fetch).toHaveBeenCalledWith(
    "https://twitee.test/api/search/latest",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ query: "mcp", page: 1, limit: 20 }),
      headers: expect.not.objectContaining({
        Authorization: expect.anything(),
      }),
    }),
  );
  expect(result).toMatchObject({
    provider: "twitee",
    status: "ready",
    items: [
      {
        id: "1900",
        text: "MCP is here",
        author: { id: "openai", handle: "openai", name: "OpenAI" },
        metrics: { like_count: 12, repost_count: 3 },
        media: [
          {
            type: "image",
            url: "https://cdn.twitee.test/mcp.jpg",
            preview_url: "https://cdn.twitee.test/mcp-thumb.jpg",
          },
        ],
      },
    ],
    metadata: {
      request_id: "request-1",
      generated_at: "2026-08-28T00:00:01.000Z",
    },
  });
  expect(result.pagination.has_more).toBe(true);
  expect(
    decodeCursor(result.pagination.next_cursor ?? "", {
      tool: "search_posts",
      provider: "twitee",
      query: "mcp",
    }),
  ).toEqual({ page: 2, generation: "search:query-1:request-1:7" });
});

it("uses an opaque cursor for the next latest page", async () => {
  const fetch = vi.fn(async () => responseFor("latest-ready.json"));
  const provider = createTwiteeProvider({
    baseUrl: "https://twitee.test/",
    token: "",
    fetch,
    sleep: async () => {},
  });
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

  expect(fetch).toHaveBeenLastCalledWith(
    "https://twitee.test/api/search/latest",
    expect.objectContaining({
      body: JSON.stringify({ query: "mcp", page: 2, limit: 20 }),
    }),
  );
});

it("rejects a latest cursor when Twitee changes generation", async () => {
  const firstPayload = await fixture("latest-ready.json");
  const nextPayload = structuredClone(firstPayload) as {
    data: { latest: { generation: string } };
  };
  nextPayload.data.latest.generation = "replacement-generation";
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(firstPayload)))
    .mockResolvedValueOnce(new Response(JSON.stringify(nextPayload)));
  const provider = createTwiteeProvider({
    baseUrl: "https://twitee.test",
    token: "",
    fetch,
    sleep: async () => {},
  });
  const first = await provider.searchPosts({
    query: "mcp",
    limit: 20,
    cursor: null,
  });

  await expect(
    provider.searchPosts({
      query: "mcp",
      limit: 20,
      cursor: first.pagination.next_cursor,
    }),
  ).rejects.toMatchObject({
    code: "INVALID_INPUT",
    message: "Cursor generation is no longer current",
  });
});

it("carries generation through fuzzy profile pagination", async () => {
  const payload = (await fixture("people-ready.json")) as {
    data: {
      people: {
        generation: string;
        pagination: { totalPages: number; hasMore: boolean };
      };
    };
  };
  payload.data.people.pagination.totalPages = 2;
  payload.data.people.pagination.hasMore = true;
  const fetch = vi.fn(async () => new Response(JSON.stringify(payload)));
  const provider = createTwiteeProvider({
    baseUrl: "https://twitee.test",
    token: "",
    fetch,
    sleep: async () => {},
  });

  const first = await provider.searchProfiles?.({
    query: "open",
    limit: 2,
    cursor: null,
  });
  expect(
    decodeCursor(first?.pagination.next_cursor ?? "", {
      tool: "search_profiles",
      provider: "twitee",
      query: "open",
    }),
  ).toEqual({
    page: 2,
    generation: "search:query-2:request-2:7",
  });

  await provider.searchProfiles?.({
    query: "open",
    limit: 2,
    cursor: first?.pagination.next_cursor ?? null,
  });
  expect(fetch).toHaveBeenLastCalledWith(
    "https://twitee.test/api/search/people",
    expect.objectContaining({
      body: JSON.stringify({ query: "open", page: 2, limit: 2 }),
    }),
  );
});

it("rejects a fuzzy profile cursor when Twitee changes generation", async () => {
  const firstPayload = (await fixture("people-ready.json")) as {
    data: {
      people: {
        generation: string;
        pagination: { totalPages: number; hasMore: boolean };
      };
    };
  };
  firstPayload.data.people.pagination.totalPages = 2;
  firstPayload.data.people.pagination.hasMore = true;
  const nextPayload = structuredClone(firstPayload);
  nextPayload.data.people.generation = "replacement-generation";
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(firstPayload)))
    .mockResolvedValueOnce(new Response(JSON.stringify(nextPayload)));
  const provider = createTwiteeProvider({
    baseUrl: "https://twitee.test",
    token: "",
    fetch,
    sleep: async () => {},
  });
  const first = await provider.searchProfiles?.({
    query: "open",
    limit: 2,
    cursor: null,
  });

  await expect(
    provider.searchProfiles?.({
      query: "open",
      limit: 2,
      cursor: first?.pagination.next_cursor ?? null,
    }),
  ).rejects.toMatchObject({
    code: "INVALID_INPUT",
    message: "Cursor generation is no longer current",
  });
});

it("times out a hanging Twitee request within its bounded poll window", async () => {
  let upstreamSignal: AbortSignal | undefined;
  const provider = createTwiteeProvider({
    baseUrl: "https://twitee.test",
    token: "",
    requestTimeoutMs: 10,
    fetch: async (_input, init) => {
      upstreamSignal = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        const fallback = setTimeout(
          () => reject(new Error("raw-twitee-timeout-marker")),
          150,
        );
        upstreamSignal?.addEventListener(
          "abort",
          () => {
            clearTimeout(fallback);
            reject(new Error("raw-twitee-abort-marker"));
          },
          { once: true },
        );
      });
    },
    sleep: async () => {},
  });
  const startedAt = Date.now();

  const error = await provider
    .searchPosts({ query: "mcp", limit: 20, cursor: null })
    .catch((caught: unknown) => caught);

  expect(Date.now() - startedAt).toBeLessThan(100);
  expect(upstreamSignal?.aborted).toBe(true);
  expect(error).toMatchObject({
    code: "UPSTREAM_UNAVAILABLE",
    message: "Twitee is temporarily unavailable",
  });
  expect(JSON.stringify(error.toPublic())).not.toContain("raw-twitee");
});

it("normalizes an exact handle lookup and maps a profile", async () => {
  const fetch = vi.fn(async () => responseFor("people-ready.json"));
  const provider = createTwiteeProvider({
    baseUrl: "https://twitee.test",
    token: "token",
    fetch,
    sleep: async () => {},
  });

  const result = await provider.lookupProfile({ handle: " OpenAI " });

  expect(fetch).toHaveBeenCalledWith(
    "https://twitee.test/api/search/people",
    expect.objectContaining({
      body: JSON.stringify({ query: "@openai", page: 1, limit: 1 }),
      headers: expect.objectContaining({
        Authorization: "Bearer token",
        "X-Twitee-Request-Purpose": "foreground",
      }),
    }),
  );
  expect(result.items).toEqual([
    {
      id: "openai",
      handle: "openai",
      name: "OpenAI",
      description: "AI research and deployment",
      profile_image_url: "https://cdn.twitee.test/openai.jpg",
      verified: true,
      followers_count: 1000,
      following_count: 0,
    },
  ]);
});

it("returns pending after bounded empty polling", async () => {
  const fetch = vi.fn(async () => responseFor("latest-pending.json"));
  const sleep = vi.fn(async () => {});
  const provider = createTwiteeProvider({
    baseUrl: "https://twitee.test",
    token: "",
    fetch,
    sleep,
    maxPollAttempts: 3,
  });

  const result = await provider.searchPosts({
    query: "new",
    limit: 20,
    cursor: null,
  });

  expect(result.status).toBe("pending");
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(sleep).toHaveBeenCalledTimes(2);
  expect(
    fetch.mock.calls.map(([, init]) => (init as RequestInit).headers),
  ).toEqual([
    expect.objectContaining({ "X-Twitee-Request-Purpose": "foreground" }),
    expect.objectContaining({ "X-Twitee-Request-Purpose": "retry" }),
    expect.objectContaining({ "X-Twitee-Request-Purpose": "retry" }),
  ]);
});

it("returns partial when nonempty work is still loading", async () => {
  const payload = await fixture("latest-ready.json");
  const data = structuredClone(payload) as {
    data: { latest: { status: string; materialized: boolean } };
  };
  data.data.latest.status = "loading_more";
  data.data.latest.materialized = false;
  const fetch = vi.fn(async () => new Response(JSON.stringify(data)));
  const provider = createTwiteeProvider({
    baseUrl: "https://twitee.test",
    token: "",
    fetch,
    sleep: async () => {},
  });

  expect(
    (await provider.searchPosts({ query: "mcp", limit: 20, cursor: null }))
      .status,
  ).toBe("partial");
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("does not return a near-match profile for an exact lookup", async () => {
  const payload = await fixture("people-ready.json");
  const data = structuredClone(payload) as {
    data: { people: { items: Array<{ handle: string }> } };
  };
  data.data.people.items = data.data.people.items.filter(
    (profile) => profile.handle !== "openai",
  );
  const provider = createTwiteeProvider({
    baseUrl: "https://twitee.test",
    token: "",
    fetch: async () => new Response(JSON.stringify(data)),
    sleep: async () => {},
  });

  const result = await provider.lookupProfile({ handle: "openai" });

  expect(result.status).toBe("ready");
  expect(result.items).toEqual([]);
});

it("maps Twitee rate limits without exposing the upstream body", async () => {
  const provider = createTwiteeProvider({
    baseUrl: "https://twitee.test",
    token: "",
    fetch: async () => {
      const response = await responseFor("error-429.json", 429);
      response.headers.set("Retry-After", "17");
      return response;
    },
    sleep: async () => {},
  });

  await expect(
    provider.searchPosts({ query: "mcp", limit: 20, cursor: null }),
  ).rejects.toMatchObject({
    code: "UPSTREAM_RATE_LIMITED",
    retry_after_seconds: 17,
  });
  await expect(
    provider.searchPosts({ query: "mcp", limit: 20, cursor: null }),
  ).rejects.not.toThrow("secret upstream diagnostic");
});

it("rejects malformed rate-limit envelopes as unavailable", async () => {
  const provider = createTwiteeProvider({
    baseUrl: "https://twitee.test",
    token: "",
    fetch: async () =>
      new Response(JSON.stringify({ ok: false, error: "malformed" }), {
        status: 429,
      }),
    sleep: async () => {},
  });

  await expect(
    provider.searchPosts({ query: "mcp", limit: 20, cursor: null }),
  ).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
});
