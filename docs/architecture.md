# Architecture

The server exposes one stateless Streamable HTTP MCP endpoint at `/mcp`. It supports `POST` and `OPTIONS`; `GET` and `DELETE` return `405`. `/healthz` is liveness, `/readyz` is configuration/provider initialization readiness, and v1 has no `/sse` endpoint.

```text
MCP request
  -> access check
  -> rate-limit guard
  -> input validation
  -> provider resolution and capability check
  -> selected provider adapter
  -> normalized result and MCP response
```

The core owns configuration parsing, access, rate limiting interfaces, errors, opaque cursors, provider resolution, normalized contracts, and MCP tool registration. Provider adapters own upstream request construction, response parsing, upstream pagination, and conversion to normalized results. Runtime adapters own HTTP integration and runtime-specific rate-limit storage.

```text
core (config, domain, providers, tools, access)
  <- Cloudflare runtime
  <- Node runtime
  <- Vercel runtime

Docker and Kubernetes run the Node runtime.
```

Dependency direction is one way: runtime adapters may depend on core; core must not import a runtime adapter.

## Provider resolution and tools

Providers declare capabilities. Tool registration exposes a tool only when at least one enabled provider supports it:

- Twitee provides `search_posts`, `lookup_profile`, and `search_profiles`.
- X provides `search_posts` and `lookup_profile` only.
- X-only deployments omit `search_profiles` from `tools/list`.

The configuration default selects a provider when a request omits `provider`. When an override is supplied and allowed, it selects that exact provider. Resolution stops there: a call never falls back to another provider and never merges results. If the selected provider lacks the capability, the call returns `CAPABILITY_UNSUPPORTED`.

## Pagination and output

The MCP cursor is opaque but not secret. It carries provider continuation state and is bound to the tool name, selected provider, and normalized query. Twitee cursors carry the next page and result generation; stale generations are rejected. X cursors retain any rows not yet returned when the upstream minimum page size exceeds the requested limit. Reusing a cursor in a different context is rejected.

Results use one normalized shape: `provider`, `status`, `items`, `pagination`, and `metadata`. The common `limit` defaults to 20 and caps at 50. Results are available as structured MCP content and JSON text fallback.

## Security boundaries

Access is anonymous or a single shared bearer token. The bearer is deployment-owned; v1 has no MCP OAuth, multi-token identity, or per-client X credentials. Tokens come from private YAML, not environment interpolation.

Rate limiting sits before provider requests as an abuse guard. Its counter scope is runtime dependent and is not global quota or accounting. See [providers](providers.md) and the deployment guides for provider and runtime details.

Provider fetches inherit request cancellation and have an eight-second v1 deadline. The Node runtime rejects MCP request bodies larger than 1 MiB before the transport can buffer them.
