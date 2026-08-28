import { z } from "zod";
import { decodeCursor, encodeCursor } from "../domain/cursor.js";
import { SafeError } from "../domain/errors.js";
import type {
  LookupProfileInput,
  Post,
  Profile,
  ProfileResult,
  SearchPostsInput,
  SearchPostsResult,
} from "../domain/types.js";
import { type SearchProvider, withAbortDeadline } from "./provider.js";

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type XProviderOptions = {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetch: FetchLike;
  readonly requestTimeoutMs?: number;
};

const userSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  username: z.string().min(1),
  description: z.string().nullable().optional(),
  profile_image_url: z.string().url().nullable().optional(),
  verified: z.boolean().optional(),
  public_metrics: z
    .object({
      followers_count: z.number().nonnegative().optional(),
      following_count: z.number().nonnegative().optional(),
    })
    .optional(),
});

const mediaSchema = z.object({
  media_key: z.string().min(1),
  type: z.string().min(1),
  url: z.string().url().optional(),
  preview_image_url: z.string().url().optional(),
});

const postSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  created_at: z.string().datetime(),
  author_id: z.string().min(1),
  public_metrics: z.object({
    reply_count: z.number().nonnegative().optional(),
    retweet_count: z.number().nonnegative().optional(),
    like_count: z.number().nonnegative().optional(),
    quote_count: z.number().nonnegative().optional(),
  }),
  attachments: z
    .object({ media_keys: z.array(z.string().min(1)).optional() })
    .optional(),
});

const recentSearchSchema = z.object({
  data: z.array(postSchema).optional(),
  includes: z
    .object({
      users: z.array(userSchema).optional(),
      media: z.array(mediaSchema).optional(),
    })
    .optional(),
  meta: z.object({ next_token: z.string().min(1).optional() }),
});

const userLookupSchema = z.object({ data: userSchema });

const bufferedProfileSchema = z
  .object({
    id: z.string(),
    handle: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    profile_image_url: z.string().url().nullable(),
    verified: z.boolean(),
    followers_count: z.number().nonnegative(),
    following_count: z.number().nonnegative(),
  })
  .strict();

const bufferedPostSchema = z
  .object({
    id: z.string(),
    text: z.string(),
    created_at: z.string().datetime(),
    author: bufferedProfileSchema,
    metrics: z
      .object({
        reply_count: z.number().nonnegative(),
        repost_count: z.number().nonnegative(),
        like_count: z.number().nonnegative(),
        quote_count: z.number().nonnegative(),
      })
      .strict(),
    media: z.array(
      z
        .object({
          type: z.string(),
          url: z.string().url(),
          preview_url: z.string().url().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

const continuationSchema = z
  .object({
    next_token: z.string().min(1).optional(),
    buffer: z.array(bufferedPostSchema).optional(),
  })
  .strict()
  .refine(
    (continuation) =>
      continuation.next_token !== undefined ||
      (continuation.buffer?.length ?? 0) > 0,
  );

const postFields = "created_at,public_metrics,author_id,attachments";
const userFields =
  "id,name,username,description,profile_image_url,verified,public_metrics";
const mediaFields = "media_key,type,url,preview_image_url";
const minimumXResults = 10;
const maxResults = 50;
const defaultRequestTimeoutMilliseconds = 8_000;

export function createXProvider(options: XProviderOptions): SearchProvider {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const requestTimeoutMilliseconds =
    options.requestTimeoutMs ?? defaultRequestTimeoutMilliseconds;
  if (
    !Number.isSafeInteger(requestTimeoutMilliseconds) ||
    requestTimeoutMilliseconds < 1
  ) {
    throw new SafeError("CONFIG_INVALID", "X request timeout must be positive");
  }

  const request = async (
    path: string,
    params: URLSearchParams,
    signal: AbortSignal,
  ) => {
    let response: Response;
    try {
      response = await options.fetch(`${baseUrl}${path}?${params.toString()}`, {
        headers: { authorization: `Bearer ${options.token}` },
        signal,
      });
    } catch (error) {
      throw unavailable(error);
    }

    if (!response.ok) {
      if (response.status === 429) {
        throw new SafeError("UPSTREAM_RATE_LIMITED", "X rate limit reached", {
          retry_after_seconds: retryAfter(response.headers),
        });
      }
      throw unavailable();
    }

    return response;
  };

  return {
    id: "x",
    capabilities: {
      searchPosts: true,
      lookupProfile: true,
      searchProfiles: false,
    },
    searchPosts: async (input: SearchPostsInput): Promise<SearchPostsResult> =>
      bounded(input.signal, async (signal) => {
        const continuation = continuationFor(input.cursor, input.query);
        const limit = Math.min(input.limit, maxResults);
        if (continuation.buffer.length > 0) {
          return searchResult(
            input.query,
            limit,
            continuation.buffer,
            continuation.nextToken,
          );
        }
        const upstreamLimit = Math.max(minimumXResults, limit);
        const params = new URLSearchParams({
          query: input.query,
          max_results: String(upstreamLimit),
          expansions: "author_id,attachments.media_keys",
          "tweet.fields": postFields,
          "user.fields": userFields,
          "media.fields": mediaFields,
          ...(continuation.nextToken === undefined
            ? {}
            : { next_token: continuation.nextToken }),
        });
        const response = await request(
          "/2/tweets/search/recent",
          params,
          signal,
        );
        const parsed = recentSearchSchema.safeParse(await readJson(response));
        if (!parsed.success) {
          throw unavailable();
        }

        const users = new Map(
          (parsed.data.includes?.users ?? []).map((user) => [user.id, user]),
        );
        const media = new Map(
          (parsed.data.includes?.media ?? []).map((item) => [
            item.media_key,
            item,
          ]),
        );
        const available = (parsed.data.data ?? [])
          .slice(0, upstreamLimit)
          .map((post) => mapPost(post, users, media));

        return searchResult(
          input.query,
          limit,
          available,
          parsed.data.meta.next_token,
          response.headers,
        );
      }),
    lookupProfile: async (input: LookupProfileInput): Promise<ProfileResult> =>
      bounded(input.signal, async (signal) => {
        const username = exactHandle(input.handle);
        const params = new URLSearchParams({ "user.fields": userFields });
        const response = await request(
          `/2/users/by/username/${encodeURIComponent(username)}`,
          params,
          signal,
        );
        const parsed = userLookupSchema.safeParse(await readJson(response));
        if (!parsed.success) {
          throw unavailable();
        }

        return {
          provider: "x",
          status: "ready",
          items: [mapProfile(parsed.data.data)],
          pagination: { next_cursor: null, has_more: false },
          metadata: {
            ...(requestId(response.headers) === undefined
              ? {}
              : { request_id: requestId(response.headers) }),
            generated_at: new Date().toISOString(),
          },
        };
      }),
  };

  async function bounded<T>(
    signal: AbortSignal | undefined,
    operation: (requestSignal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    try {
      return await withAbortDeadline(
        signal,
        requestTimeoutMilliseconds,
        operation,
      );
    } catch (error) {
      if (error instanceof SafeError) throw error;
      throw unavailable(error);
    }
  }
}

function continuationFor(
  cursor: string | null,
  query: string,
): { nextToken?: string; buffer: Post[] } {
  if (cursor === null) {
    return { buffer: [] };
  }
  const continuation = continuationSchema.safeParse(
    decodeCursor(cursor, { tool: "search_posts", provider: "x", query }),
  );
  if (!continuation.success) {
    throw new SafeError("INVALID_INPUT", "Invalid cursor");
  }
  return {
    nextToken: continuation.data.next_token,
    buffer: continuation.data.buffer ?? [],
  };
}

function searchResult(
  query: string,
  limit: number,
  available: Post[],
  nextToken: string | undefined,
  headers?: Headers,
): SearchPostsResult {
  const items = available.slice(0, limit);
  const buffer = available.slice(limit);
  const hasMore = buffer.length > 0 || nextToken !== undefined;
  return {
    provider: "x",
    status: "ready",
    items,
    pagination: {
      has_more: hasMore,
      next_cursor: hasMore
        ? encodeCursor({
            v: 1,
            tool: "search_posts",
            provider: "x",
            query,
            continuation: {
              ...(nextToken === undefined ? {} : { next_token: nextToken }),
              ...(buffer.length === 0 ? {} : { buffer }),
            },
          })
        : null,
    },
    metadata: {
      ...(headers === undefined || requestId(headers) === undefined
        ? {}
        : { request_id: requestId(headers) }),
      generated_at: new Date().toISOString(),
    },
  };
}

function mapProfile(user: z.infer<typeof userSchema>): Profile {
  return {
    id: user.id,
    handle: user.username,
    name: user.name,
    description: user.description ?? null,
    profile_image_url: user.profile_image_url ?? null,
    verified: user.verified ?? false,
    followers_count: user.public_metrics?.followers_count ?? 0,
    following_count: user.public_metrics?.following_count ?? 0,
  };
}

function mapPost(
  post: z.infer<typeof postSchema>,
  users: ReadonlyMap<string, z.infer<typeof userSchema>>,
  media: ReadonlyMap<string, z.infer<typeof mediaSchema>>,
): Post {
  const author = users.get(post.author_id);
  if (author === undefined) {
    throw unavailable();
  }

  return {
    id: post.id,
    text: post.text,
    created_at: post.created_at,
    author: mapProfile(author),
    metrics: {
      reply_count: post.public_metrics.reply_count ?? 0,
      repost_count: post.public_metrics.retweet_count ?? 0,
      like_count: post.public_metrics.like_count ?? 0,
      quote_count: post.public_metrics.quote_count ?? 0,
    },
    media: (post.attachments?.media_keys ?? []).flatMap((key) => {
      const item = media.get(key);
      return item === undefined || item.url === undefined
        ? []
        : [
            {
              type: item.type,
              url: item.url,
              preview_url: item.preview_image_url ?? null,
            },
          ];
    }),
  };
}

function exactHandle(handle: string): string {
  const normalized = handle.trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/.test(normalized)) {
    throw new SafeError("INVALID_INPUT", "Invalid X handle");
  }
  return normalized;
}

function retryAfter(headers: Headers): number | undefined {
  const reset = headers.get("x-rate-limit-reset");
  if (reset === null || !/^\d+$/.test(reset)) {
    return undefined;
  }
  const timestamp = Number(reset);
  if (!Number.isSafeInteger(timestamp)) {
    return undefined;
  }
  return Math.max(1, Math.ceil(timestamp - Date.now() / 1_000));
}

function requestId(headers: Headers): string | undefined {
  return headers.get("x-request-id") ?? undefined;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw unavailable(error);
  }
}

function unavailable(cause?: unknown): SafeError {
  return new SafeError("UPSTREAM_UNAVAILABLE", "X is temporarily unavailable", {
    cause,
  });
}
