import type {
  LookupProfileInput,
  ProfileResult,
  ProviderId,
  SearchPostsInput,
  SearchPostsResult,
  SearchProfilesInput,
  SearchProfilesResult,
} from "../domain/types.js";

export type ProviderCapabilities = {
  searchPosts: boolean;
  lookupProfile: boolean;
  searchProfiles: boolean;
};

export interface SearchProvider {
  readonly id: ProviderId;
  readonly capabilities: ProviderCapabilities;
  searchPosts(input: SearchPostsInput): Promise<SearchPostsResult>;
  lookupProfile(input: LookupProfileInput): Promise<ProfileResult>;
  searchProfiles?(input: SearchProfilesInput): Promise<SearchProfilesResult>;
}
