import { z } from "zod";
import { decodeCursor, encodeCursor } from "../domain/cursor.js";
import { SafeError } from "../domain/errors.js";
import type {
  LookupProfileInput,
  Media,
  Post,
  Profile,
  ProfileResult,
  SearchPostsInput,
  SearchPostsResult,
  SearchProfilesInput,
  SearchProfilesResult,
  SearchResult,
} from "../domain/types.js";
import type { SearchProvider } from "./provider.js";

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type TwiteeProviderOptions = {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetch: FetchLike;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly maxPollAttempts?: number;
};

const paginationSchema = z
  .object({
    page: z.number().int().positive(),
    limit: z.number().int().positive(),
    totalPages: z.number().int().positive(),
    hasMore: z.boolean(),
  })
  .strict();

const profileItemSchema = z
  .object({
    handle: z.string().min(1),
    displayName: z.string().nullable(),
    avatarUrl: z.string().url().nullable(),
    bio: z.string().nullable(),
    followersCount: z.number().nullable(),
    verified: z.boolean().nullable(),
    rank: z.number().optional(),
    sourceUrl: z.string().url().nullable().optional(),
    collectedAt: z.string().datetime().nullable().optional(),
    fetchedAt: z.string().datetime().nullable().optional(),
  })
  .strict();

const mediaItemSchema = z
  .object({
    type: z.string().optional(),
    url: z.string().url().optional(),
    thumbnailUrl: z.string().url().optional(),
    altText: z.string().optional(),
    width: z.number().int().nonnegative().optional(),
    height: z.number().int().nonnegative().optional(),
    durationMs: z.number().int().nonnegative().optional(),
    source: z.literal("x").optional(),
  })
  .strict();

const postItemSchema = z
  .object({
    id: z.string().min(1),
    handle: z.string().min(1),
    displayName: z.string().nullable(),
    avatarUrl: z.string().url().nullable(),
    text: z.string().nullable(),
    postedAt: z.string().datetime(),
    likeCount: z.number().nullable(),
    repostCount: z.number().nullable(),
    replyCount: z.number().nullable(),
    quoteCount: z.number().nullable(),
    media: z.array(mediaItemSchema),
    sourceUrl: z.string().url().nullable().optional(),
    collectedAt: z.string().datetime().nullable().optional(),
    sensitiveLabel: z.string().nullable().optional(),
    isRepost: z.boolean().nullable().optional(),
    repostedByHandle: z.string().nullable().optional(),
    repostedByDisplayName: z.string().nullable().optional(),
    repostedByAvatarUrl: z.string().url().nullable().optional(),
  })
  .strict();

const branchSchema = <Item extends z.ZodType>(item: Item) =>
  z
    .object({
      generation: z.string().min(1),
      status: z.enum(["ready", "refreshing", "loading_more"]),
      materialized: z.boolean().optional(),
      pagination: paginationSchema,
      items: z.array(item),
    })
    .strict();

const envelopeSchema = <Item extends z.ZodType>(
  branch: "latest" | "people",
  item: Item,
) =>
  z
    .object({
      ok: z.literal(true),
      data: z
        .object({ query: z.string(), [branch]: branchSchema(item) })
        .strict(),
      error: z.null(),
      meta: z
        .object({
          requestId: z.string().min(1),
          generatedAt: z.string().datetime(),
        })
        .strict(),
    })
    .strict();

const errorEnvelopeSchema = z
  .object({
    ok: z.literal(false),
    data: z.null(),
    error: z
      .object({
        code: z.string().min(1),
        message: z.string().min(1),
        retryAfterSeconds: z.number().int().positive().optional(),
      })
      .strict(),
    meta: z
      .object({
        requestId: z.string().min(1),
        generatedAt: z.string().datetime(),
      })
      .strict(),
  })
  .strict();

const continuationSchema = z
  .object({ page: z.number().int().positive() })
  .strict();

const defaultPollAttempts = 5;
const pollIntervalMilliseconds = 2_000;

type Branch<Item> = {
  readonly generation: string;
  readonly status: "ready" | "refreshing" | "loading_more";
  readonly materialized?: boolean;
  readonly pagination: {
    readonly page: number;
    readonly limit: number;
    readonly totalPages: number;
    readonly hasMore: boolean;
  };
  readonly items: readonly Item[];
};

type Envelope<Item> = {
  readonly data: {
    readonly query: string;
    readonly latest?: Branch<Item>;
    readonly people?: Branch<Item>;
  };
  readonly meta: { readonly requestId: string; readonly generatedAt: string };
};

export function createTwiteeProvider(
  options: TwiteeProviderOptions,
): SearchProvider {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const maxPollAttempts = options.maxPollAttempts ?? defaultPollAttempts;

  if (!Number.isSafeInteger(maxPollAttempts) || maxPollAttempts < 1) {
    throw new SafeError(
      "CONFIG_INVALID",
      "Twitee poll attempts must be positive",
    );
  }

  const requestBranch = async <Item>(
    branch: "latest" | "people",
    query: string,
    page: number,
    limit: number,
    itemSchema: z.ZodType<Item>,
  ): Promise<{
    envelope: Envelope<Item>;
    branch: Branch<Item>;
    status: "ready" | "partial" | "pending";
  }> => {
    for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
      const response = await request(
        `${baseUrl}/api/search/${branch}`,
        { query, page, limit },
        attempt === 0 ? "foreground" : "retry",
      );
      const parsed = envelopeSchema(branch, itemSchema).safeParse(
        await readJson(response),
      );
      if (!parsed.success) {
        throw unavailable();
      }

      const envelope = {
        data: parsed.data.data,
        meta: parsed.data.meta,
      } as unknown as Envelope<Item>;
      const value =
        branch === "latest" ? envelope.data.latest : envelope.data.people;
      if (value === undefined) {
        throw unavailable();
      }
      if (value.status === "ready") {
        return { envelope, branch: value, status: "ready" };
      }
      if (value.items.length > 0) {
        return { envelope, branch: value, status: "partial" };
      }
      if (attempt + 1 === maxPollAttempts) {
        return { envelope, branch: value, status: "pending" };
      }
      await options.sleep(pollIntervalMilliseconds);
    }

    throw unavailable();
  };

  const request = async (
    url: string,
    body: { query: string; page: number; limit: number },
    purpose: "foreground" | "retry",
  ): Promise<Response> => {
    let response: Response;
    try {
      response = await options.fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Twitee-Request-Purpose": purpose,
          ...(options.token
            ? { Authorization: `Bearer ${options.token}` }
            : {}),
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw unavailable(error);
    }

    if (!response.ok) {
      const parsed = errorEnvelopeSchema.safeParse(await readJson(response));
      if (!parsed.success) {
        throw unavailable();
      }
      if (response.status === 429) {
        throw new SafeError(
          "UPSTREAM_RATE_LIMITED",
          "Twitee rate limit reached",
          {
            retry_after_seconds:
              retryAfter(response.headers) ??
              parsed.data.error.retryAfterSeconds,
          },
        );
      }
      throw unavailable();
    }

    return response;
  };

  const posts = async (input: SearchPostsInput): Promise<SearchPostsResult> => {
    const page = pageFor(input.cursor, "search_posts", input.query);
    const response = await requestBranch(
      "latest",
      input.query,
      page,
      input.limit,
      postItemSchema,
    );
    return result(
      response,
      response.branch.items.map(mapPost),
      "search_posts",
      input.query,
    );
  };

  const profiles = async (
    input: SearchProfilesInput,
  ): Promise<SearchProfilesResult> => {
    const page = pageFor(input.cursor, "search_profiles", input.query);
    const response = await requestBranch(
      "people",
      input.query,
      page,
      input.limit,
      profileItemSchema,
    );
    return result(
      response,
      response.branch.items.map(mapProfile),
      "search_profiles",
      input.query,
    );
  };

  return {
    id: "twitee",
    capabilities: {
      searchPosts: true,
      lookupProfile: true,
      searchProfiles: true,
    },
    searchPosts: posts,
    searchProfiles: profiles,
    lookupProfile: async (
      input: LookupProfileInput,
    ): Promise<ProfileResult> => {
      const query = exactHandle(input.handle);
      const response = await requestBranch(
        "people",
        query,
        1,
        1,
        profileItemSchema,
      );
      return {
        provider: "twitee",
        status: response.status,
        items: response.branch.items
          .filter((item) => item.handle.toLowerCase() === query.slice(1))
          .slice(0, 1)
          .map(mapProfile),
        pagination: { next_cursor: null, has_more: false },
        metadata: metadata(response.envelope),
      };
    },
  };
}

function pageFor(
  cursor: string | null,
  tool: "search_posts" | "search_profiles",
  query: string,
): number {
  if (cursor === null) {
    return 1;
  }
  const continuation = continuationSchema.safeParse(
    decodeCursor(cursor, { tool, provider: "twitee", query }),
  );
  if (!continuation.success) {
    throw new SafeError("INVALID_INPUT", "Invalid cursor");
  }
  return continuation.data.page;
}

function result<Item, Mapped>(
  response: {
    readonly envelope: Envelope<Item>;
    readonly branch: Branch<Item>;
    readonly status: "ready" | "partial" | "pending";
  },
  items: Mapped[],
  tool: "search_posts" | "search_profiles",
  query: string,
): SearchResult<Mapped> {
  return {
    provider: "twitee",
    status: response.status,
    items,
    pagination: {
      has_more: response.branch.pagination.hasMore,
      next_cursor: response.branch.pagination.hasMore
        ? encodeCursor({
            v: 1,
            tool,
            provider: "twitee",
            query,
            continuation: { page: response.branch.pagination.page + 1 },
          })
        : null,
    },
    metadata: metadata(response.envelope),
  };
}

function metadata(envelope: Envelope<unknown>) {
  return {
    request_id: envelope.meta.requestId,
    generated_at: envelope.meta.generatedAt,
  };
}

function mapProfile(item: z.infer<typeof profileItemSchema>): Profile {
  return {
    id: item.handle,
    handle: item.handle,
    name: item.displayName ?? item.handle,
    description: item.bio,
    profile_image_url: item.avatarUrl,
    verified: item.verified ?? false,
    followers_count: item.followersCount ?? 0,
    following_count: 0,
  };
}

function mapPost(item: z.infer<typeof postItemSchema>): Post {
  return {
    id: item.id,
    text: item.text ?? "",
    created_at: item.postedAt,
    author: mapProfile({
      handle: item.handle,
      displayName: item.displayName,
      avatarUrl: item.avatarUrl,
      bio: null,
      followersCount: null,
      verified: null,
    }),
    metrics: {
      reply_count: item.replyCount ?? 0,
      repost_count: item.repostCount ?? 0,
      like_count: item.likeCount ?? 0,
      quote_count: item.quoteCount ?? 0,
    },
    media: item.media.flatMap(mapMedia),
  };
}

function mapMedia(item: z.infer<typeof mediaItemSchema>): Media[] {
  if (!item.url) {
    return [];
  }
  return [
    {
      type: item.type ?? "unknown",
      url: item.url,
      preview_url: item.thumbnailUrl ?? null,
    },
  ];
}

function exactHandle(handle: string): string {
  const normalized = handle.trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/.test(normalized)) {
    throw new SafeError("INVALID_INPUT", "Invalid X handle");
  }
  return `@${normalized}`;
}

function retryAfter(headers: Headers): number | undefined {
  const value = headers.get("Retry-After");
  if (!value || !/^\d+$/.test(value)) {
    return undefined;
  }
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw unavailable(error);
  }
}

function unavailable(cause?: unknown): SafeError {
  return new SafeError(
    "UPSTREAM_UNAVAILABLE",
    "Twitee is temporarily unavailable",
    {
      cause,
    },
  );
}
