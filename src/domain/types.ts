export type ToolName = "search_posts" | "lookup_profile" | "search_profiles";

export type ProviderId = "twitee" | "x";

export type SearchStatus = "ready" | "pending" | "partial";

export type Profile = {
  id: string;
  handle: string;
  name: string;
  description: string | null;
  profile_image_url: string | null;
  verified: boolean;
  followers_count: number;
  following_count: number;
};

export type Media = {
  type: string;
  url: string;
  preview_url: string | null;
};

export type Post = {
  id: string;
  text: string;
  created_at: string;
  author: Profile;
  metrics: {
    reply_count: number;
    repost_count: number;
    like_count: number;
    quote_count: number;
  };
  media: Media[];
};

export type SearchResult<T> = {
  provider: ProviderId;
  status: SearchStatus;
  items: T[];
  pagination: { next_cursor: string | null; has_more: boolean };
  metadata: { request_id?: string; generated_at: string };
};

export type SearchPostsInput = {
  query: string;
  limit: number;
  cursor: string | null;
};

export type LookupProfileInput = {
  handle: string;
};

export type SearchProfilesInput = {
  query: string;
  limit: number;
  cursor: string | null;
};

export type SearchPostsResult = SearchResult<Post>;

export type ProfileResult = SearchResult<Profile>;

export type SearchProfilesResult = SearchResult<Profile>;
