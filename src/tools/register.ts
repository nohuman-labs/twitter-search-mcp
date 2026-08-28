import type { McpServer, ToolAnnotations } from "@modelcontextprotocol/server";
import { z } from "zod";
import { SafeError } from "../domain/errors.js";
import type {
  ProfileResult,
  SearchPostsResult,
  SearchProfilesResult,
} from "../domain/types.js";
import type { SearchProvider } from "../providers/provider.js";
import type { ProviderRegistry } from "../providers/registry.js";

const providerSchema = z.enum(["twitee", "x"]);
const querySchema = z.string().trim().min(1);
const limitSchema = z.number().int().positive().max(50).default(20);
const cursorSchema = z.string().min(1).optional();

export const searchPostsInputSchema = z.object({
  query: querySchema,
  provider: providerSchema.optional(),
  limit: limitSchema,
  cursor: cursorSchema,
});

export const lookupProfileInputSchema = z.object({
  handle: z
    .string()
    .trim()
    .regex(/^@?[a-z0-9_]{1,15}$/i),
  provider: providerSchema.optional(),
});

export const searchProfilesInputSchema = z.object({
  query: querySchema,
  provider: providerSchema.optional(),
  limit: limitSchema,
  cursor: cursorSchema,
});

const profileSchema = z.object({
  id: z.string(),
  handle: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  profile_image_url: z.string().url().nullable(),
  verified: z.boolean(),
  followers_count: z.number().nonnegative(),
  following_count: z.number().nonnegative(),
});

const mediaSchema = z.object({
  type: z.string(),
  url: z.string().url(),
  preview_url: z.string().url().nullable(),
});

const postSchema = z.object({
  id: z.string(),
  text: z.string(),
  created_at: z.string().datetime(),
  author: profileSchema,
  metrics: z.object({
    reply_count: z.number().nonnegative(),
    repost_count: z.number().nonnegative(),
    like_count: z.number().nonnegative(),
    quote_count: z.number().nonnegative(),
  }),
  media: z.array(mediaSchema),
});

const resultSchema = <Item extends z.ZodType>(item: Item) =>
  z.object({
    provider: providerSchema,
    status: z.enum(["ready", "pending", "partial"]),
    items: z.array(item),
    pagination: z.object({
      next_cursor: z.string().nullable(),
      has_more: z.boolean(),
    }),
    metadata: z.object({
      request_id: z.string().optional(),
      generated_at: z.string().datetime(),
    }),
  });

export const searchPostsOutputSchema = resultSchema(postSchema);
export const lookupProfileOutputSchema = resultSchema(profileSchema);
export const searchProfilesOutputSchema = resultSchema(profileSchema);

const readOnlyAnnotations: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
};

export type SearchToolsContext = {
  readonly registry: ProviderRegistry;
  readonly providers: readonly SearchProvider[];
};

type SearchPostsInput = z.infer<typeof searchPostsInputSchema>;
type LookupProfileInput = z.infer<typeof lookupProfileInputSchema>;
type SearchProfilesInput = z.infer<typeof searchProfilesInputSchema>;

export function registerSearchTools(
  server: McpServer,
  context: SearchToolsContext,
): void {
  if (supports(context.providers, "searchPosts")) {
    server.registerTool(
      "search_posts",
      {
        description:
          "Search recent X/Twitter posts through exactly one enabled provider. No fallback or merging.",
        inputSchema: searchPostsInputSchema,
        outputSchema: searchPostsOutputSchema,
        annotations: readOnlyAnnotations,
      },
      async (input) =>
        callTool(() => searchPosts(context, input as SearchPostsInput)),
    );
  }

  if (supports(context.providers, "lookupProfile")) {
    server.registerTool(
      "lookup_profile",
      {
        description:
          "Look up one exact X/Twitter profile through exactly one enabled provider. No fallback or merging.",
        inputSchema: lookupProfileInputSchema,
        outputSchema: lookupProfileOutputSchema,
        annotations: readOnlyAnnotations,
      },
      async (input) =>
        callTool(() => lookupProfile(context, input as LookupProfileInput)),
    );
  }

  if (supports(context.providers, "searchProfiles")) {
    server.registerTool(
      "search_profiles",
      {
        description:
          "Search X/Twitter profiles through exactly one enabled provider. No fallback or merging.",
        inputSchema: searchProfilesInputSchema,
        outputSchema: searchProfilesOutputSchema,
        annotations: readOnlyAnnotations,
      },
      async (input) =>
        callTool(() => searchProfiles(context, input as SearchProfilesInput)),
    );
  }
}

function supports(
  providers: readonly SearchProvider[],
  capability: keyof SearchProvider["capabilities"],
): boolean {
  return providers.some((provider) => provider.capabilities[capability]);
}

async function searchPosts(
  context: SearchToolsContext,
  input: SearchPostsInput,
): Promise<SearchPostsResult> {
  const provider = context.registry.resolve("search_posts", input.provider);
  return provider.searchPosts({
    query: input.query,
    limit: input.limit,
    cursor: input.cursor ?? null,
  });
}

async function lookupProfile(
  context: SearchToolsContext,
  input: LookupProfileInput,
): Promise<ProfileResult> {
  const provider = context.registry.resolve("lookup_profile", input.provider);
  return provider.lookupProfile({ handle: input.handle });
}

async function searchProfiles(
  context: SearchToolsContext,
  input: SearchProfilesInput,
): Promise<SearchProfilesResult> {
  const provider = context.registry.resolve("search_profiles", input.provider);
  if (provider.searchProfiles === undefined) {
    throw new SafeError(
      "CONFIG_INVALID",
      "Selected provider declares an unimplemented capability",
    );
  }
  return provider.searchProfiles({
    query: input.query,
    limit: input.limit,
    cursor: input.cursor ?? null,
  });
}

async function callTool(
  operation: () => Promise<
    SearchPostsResult | ProfileResult | SearchProfilesResult
  >,
) {
  try {
    return success(await operation());
  } catch (error) {
    if (error instanceof SafeError) {
      const publicError = error.toPublic();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(publicError) }],
        isError: true,
      };
    }
    throw error;
  }
}

function success(result: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result as Record<string, unknown>,
  };
}
