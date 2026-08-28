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
import type { SearchProvider } from "./provider.js";

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type XProviderOptions = {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetch: FetchLike;
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

const continuationSchema = z.object({ next_token: z.string().min(1) }).strict();

const postFields = "created_at,public_metrics,author_id,attachments";
const userFields =
  "id,name,username,description,profile_image_url,verified,public_metrics";
const mediaFields = "media_key,type,url,preview_image_url";
const minimumXResults = 10;
const maxResults = 50;

export function createXProvider(options: XProviderOptions): SearchProvider {
  const baseUrl = options.baseUrl.replace(/\/$/, "");

  const request = async (path: string, params: URLSearchParams) => {
    let response: Response;
    try {
      response = await options.fetch(`${baseUrl}${path}?${params.toString()}`, {
        headers: { authorization: `Bearer ${options.token}` },
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
    searchPosts: async (
      input: SearchPostsInput,
    ): Promise<SearchPostsResult> => {
      const nextToken = continuationFor(input.cursor, input.query);
      const limit = Math.min(input.limit, maxResults);
      const upstreamLimit = Math.max(minimumXResults, limit);
      const params = new URLSearchParams({
        query: input.query,
        max_results: String(upstreamLimit),
        expansions: "author_id,attachments.media_keys",
        "tweet.fields": postFields,
        "user.fields": userFields,
        "media.fields": mediaFields,
        ...(nextToken === undefined ? {} : { next_token: nextToken }),
      });
      const response = await request("/2/tweets/search/recent", params);
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
      const items = (parsed.data.data ?? [])
        .slice(0, limit)
        .map((post) => mapPost(post, users, media));
      const next = parsed.data.meta.next_token;

      return {
        provider: "x",
        status: "ready",
        items,
        pagination: {
          has_more: next !== undefined,
          next_cursor:
            next === undefined
              ? null
              : encodeCursor({
                  v: 1,
                  tool: "search_posts",
                  provider: "x",
                  query: input.query,
                  continuation: { next_token: next },
                }),
        },
        metadata: {
          ...(requestId(response.headers) === undefined
            ? {}
            : { request_id: requestId(response.headers) }),
          generated_at: new Date().toISOString(),
        },
      };
    },
    lookupProfile: async (
      input: LookupProfileInput,
    ): Promise<ProfileResult> => {
      const username = exactHandle(input.handle);
      const params = new URLSearchParams({ "user.fields": userFields });
      const response = await request(
        `/2/users/by/username/${encodeURIComponent(username)}`,
        params,
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
    },
  };
}

function continuationFor(
  cursor: string | null,
  query: string,
): string | undefined {
  if (cursor === null) {
    return undefined;
  }
  const continuation = continuationSchema.safeParse(
    decodeCursor(cursor, { tool: "search_posts", provider: "x", query }),
  );
  if (!continuation.success) {
    throw new SafeError("INVALID_INPUT", "Invalid cursor");
  }
  return continuation.data.next_token;
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
