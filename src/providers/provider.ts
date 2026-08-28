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

export async function withAbortDeadline<T>(
  parentSignal: AbortSignal | undefined,
  timeoutMilliseconds: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(new Error("Provider request aborted")),
      { once: true },
    );
  });
  const abortFromParent = () => controller.abort();
  if (parentSignal?.aborted) {
    controller.abort();
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  }
  const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds);

  try {
    return await Promise.race([operation(controller.signal), aborted]);
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}
