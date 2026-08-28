# Providers

Configure providers in the private `mcp.config.yaml`. The application reads exactly one provider per tool call. It never falls back to another provider and never merges result sets.

| Provider | `search_posts` | `lookup_profile` | `search_profiles` | Authentication |
| --- | --- | --- | --- | --- |
| Twitee | yes | yes | yes | optional configured token |
| X | yes | yes | no | deployment-owned bearer token required when enabled |

## Twitee

The Twitee adapter uses a Twitee-compatible base URL. It calls latest post search and people search and performs exact-handle lookup through People search. A search can return `ready`, `partial`, or `pending` while Twitee data is refreshed. Provider-internal pagination is converted to the MCP cursor.

## X

The X adapter uses the configured X-compatible API base URL and deployment-owned bearer token. It supports recent post search and exact username lookup. It does not expose `search_profiles`, because the X API does not provide the equivalent fuzzy people-search capability. An X-only configuration therefore does not register `search_profiles`.

X API search scope, entitlement, pricing, and upstream rate limits belong to the operator's X account. This server neither manages provider spending nor promises an X quota.

## Selecting a provider

Use `search.default_provider` for calls without a `provider` input. Set `search.allow_provider_override: false` to reject any different requested provider. With both providers enabled, a request can select X explicitly:

```json
{
  "query": "MCP",
  "provider": "x",
  "limit": 20
}
```

If a cursor is supplied, it must be reused with the same tool, provider, and normalized query. See [architecture](architecture.md) for the resolution and cursor invariants.

This project is not affiliated with or endorsed by X Corp or Twitee.
