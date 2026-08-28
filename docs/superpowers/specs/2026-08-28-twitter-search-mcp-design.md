# Twitter Search MCP Design

Date: 2026-08-28
Status: Approved design
License: MIT

## 1. Purpose

`twitter-search-mcp` is an open-source, self-hosted MCP server for searching X/Twitter content. It provides one provider-neutral MCP contract backed by Twitee, the official X API, or both.

The project prioritizes portability and explicit operator choice:

- Twitee is enabled and selected by default in the example configuration.
- Twitee and X are peer provider adapters inside the architecture.
- Operators may enable Twitee, X, or both.
- A tool call never falls back to another provider and never merges providers automatically.
- The same core behavior runs on Cloudflare Workers, Node/Docker, Kubernetes, Vercel, and compatible platforms.

The repository is independent from the Twitee application and from `agent-company`. It does not copy Twitee crawler or storage internals; it calls Twitee through its public-compatible HTTP API.

## 2. Goals

Version 1 must:

1. Expose stateless MCP tools over Streamable HTTP.
2. Support `search_posts`, `lookup_profile`, and `search_profiles`.
3. Support Twitee and X through isolated adapters.
4. Let the operator select enabled providers and the default provider in YAML.
5. Support anonymous or single-token bearer access.
6. Provide simple ingress rate limiting without claiming exact global accounting.
7. Run from Cloudflare Workers, Node/Docker, Kubernetes, and Vercel.
8. Export portable Web Standard and Node handlers for additional platforms.
9. Provide a Makefile as the primary contributor and operator interface.
10. Publish source releases, an npm package, and a GHCR image under SemVer.

## 3. Non-goals

Version 1 will not:

- Merge or rank results across providers.
- Automatically fall back from one provider to another.
- Support per-client X credentials or BYOK.
- Support multiple named MCP bearer tokens.
- Implement MCP OAuth.
- Implement provider spending budgets or monetary accounting.
- Guarantee a globally exact rate limit across regions or replicas.
- Provide an admin UI, remote configuration, or hot reload on serverless platforms.
- Use MCP Tasks, Durable Objects, D1, or a queue for search execution.
- Promise first-class adapters for every hosting platform.
- Implement fuzzy profile search through X when the X API lacks that capability.

## 4. User and deployment model

The project supports three documented deployment models without encoding a hidden `deployment.profile` setting:

- Personal: commonly anonymous with rate limiting disabled.
- Team: commonly bearer-protected with rate limiting enabled.
- Public: anonymous or bearer-protected with rate limiting enabled.

These are example configurations, not runtime profiles. The effective YAML always states the actual access and rate-limit behavior.

Example files:

```text
examples/
  personal.config.yaml
  team.config.yaml
  public.config.yaml
```

## 5. Configuration contract

The canonical configuration is `mcp.config.yaml`.

```yaml
version: 1

access:
  mode: anonymous # anonymous | bearer
  token: ""

search:
  default_provider: twitee
  allow_provider_override: true

providers:
  twitee:
    enabled: true
    base_url: https://twitee.co
    token: ""

  x:
    enabled: false
    base_url: https://api.x.com
    token: your-x-bearer-token

ratelimit:
  enabled: false
  limit: 60
  window: 1m
```

Rules:

- At least one provider must be enabled.
- `search.default_provider` must name an enabled provider.
- Every provider has an explicit `base_url` and `token` field.
- Twitee permits an empty token by default.
- X requires a non-empty bearer token when enabled.
- `access.token` is required only when `access.mode` is `bearer`.
- `search.allow_provider_override: false` rejects a requested provider that differs from the default.
- `ratelimit.window` accepts `10s` or `1m` in version 1 so the common contract maps to Cloudflare's simple binding.
- Unknown fields fail validation rather than being silently ignored.
- Provider and access tokens are read directly from YAML. Version 1 does not interpolate environment variables.

The tracked `mcp.config.example.yaml` contains no real token. The real `mcp.config.yaml` is ignored by Git. Because Workers and Vercel build a generated configuration module, their deployment artifact contains the configured token. This is an explicitly accepted version 1 trade-off. Documentation must warn operators not to commit, publish, log, or share their private YAML or generated artifacts.

## 6. Provider model

Providers implement one contract and declare capabilities.

```ts
interface SearchProvider {
  readonly id: string;
  readonly capabilities: {
    searchPosts: boolean;
    lookupProfile: boolean;
    searchProfiles: boolean;
  };

  searchPosts(input: SearchPostsInput): Promise<SearchPostsResult>;
  lookupProfile(input: LookupProfileInput): Promise<ProfileResult>;
  searchProfiles?(input: SearchProfilesInput): Promise<SearchProfilesResult>;
}
```

Provider adapters own upstream request construction, response parsing, upstream pagination, upstream errors, and conversion to normalized core types. They do not own MCP transport, access control, or rate limiting.

### 6.1 Twitee adapter

The Twitee adapter targets a Twitee-compatible base URL and uses:

- `POST /api/search/latest` for `search_posts`.
- `POST /api/search/people` for `search_profiles`.
- Exact-handle People search for `lookup_profile`.

The compatible request body is `{ query, page, limit }`. The adapter consumes the Twitee success/error envelope and the branch fields `items`, `generation`, `pagination`, and `status`.

Twitee may return `ready`, `refreshing`, or `loading_more`. The adapter performs bounded polling for at most approximately eight seconds:

- Completed data becomes `ready`.
- Existing data while refresh continues becomes `partial`.
- No data before the bound expires becomes `pending`.

The adapter does not expose crawler/provider cursors from Twitee internals.

### 6.2 X adapter

The X adapter uses the configured X-compatible base URL and the deployment-owned bearer token.

- `search_posts` calls the recent search endpoint.
- `lookup_profile` calls lookup by username.
- `search_profiles` is unsupported because X does not provide the same fuzzy people-search capability used by Twitee.

The adapter requests only fields needed by the normalized result, including post creation time, public metrics, author data, and media data. It uses the upstream `next_token` for pagination and retains upstream rate-limit reset information when reporting errors.

X Recent Search scope, entitlement, pricing, and rate limits remain properties of the operator's X account. The MCP server does not model or promise them.

## 7. MCP tools

### 7.1 `search_posts`

```ts
type SearchPostsInput = {
  query: string;
  provider?: string;
  limit?: number;
  cursor?: string;
};
```

Searches recent posts using exactly one provider.

### 7.2 `lookup_profile`

```ts
type LookupProfileInput = {
  handle: string;
  provider?: string;
};
```

Looks up one exact X/Twitter handle. Input normalization accepts a plain username or a leading `@` and rejects non-profile X URLs and invalid handles.

### 7.3 `search_profiles`

```ts
type SearchProfilesInput = {
  query: string;
  provider?: string;
  limit?: number;
  cursor?: string;
};
```

Performs fuzzy profile search only through providers that declare the capability.

### 7.4 Registration and provider resolution

- A tool is registered only when at least one enabled provider supports it.
- With X alone, `search_profiles` is absent from `tools/list`.
- With Twitee alone or Twitee and X together, all three tools are present.
- When a tool supports more than one enabled provider, `provider` selects one explicitly.
- When `provider` is omitted, the configured default is used.
- If the default lacks the requested capability, the call returns `CAPABILITY_UNSUPPORTED`; it does not silently select another provider.
- Provider override policy is enforced before any upstream request.

### 7.5 Pagination

The MCP contract uses an opaque `cursor`:

- Twitee cursors carry the next page and generation.
- X cursors carry the upstream next token.
- The cursor is bound to the tool, provider, and normalized query.
- A cursor used with a different context is rejected.

The opaque encoding is an implementation detail. It prevents clients from depending on provider pagination formats; it is not treated as a secret or authorization boundary.

### 7.6 Normalized output

Tool results include both MCP `structuredContent` and a JSON text fallback.

```ts
type SearchResult<T> = {
  provider: string;
  status: "ready" | "pending" | "partial";
  items: T[];
  pagination: {
    next_cursor: string | null;
    has_more: boolean;
  };
  metadata: {
    request_id?: string;
    generated_at: string;
  };
};
```

The common limit defaults to 20 and has a maximum of 50. Provider adapters may request a different legal upstream page size internally but must honor the common result bound.

## 8. Request flow

```text
MCP request
  -> access check
  -> rate limit
  -> input schema validation
  -> provider resolution and capability check
  -> provider adapter
  -> normalized response
  -> output schema validation
  -> structured MCP result
```

The server is stateless from the MCP transport perspective. A search call does not create a durable MCP session or background task.

## 9. HTTP endpoint contract

Every supported runtime exposes the same canonical MCP URL:

```text
https://<host>/mcp
```

The version 1 HTTP surface is:

```text
POST    /mcp       MCP Streamable HTTP requests
OPTIONS /mcp       CORS preflight when required
GET     /mcp       405 Method Not Allowed
DELETE  /mcp       405 Method Not Allowed

GET     /healthz   Process and runtime liveness
GET     /readyz    Configuration and provider initialization readiness
```

Endpoint rules:

- The MCP server is stateless and does not open a standalone SSE stream, so `GET /mcp` returns 405.
- The server does not create transport sessions, so `DELETE /mcp` returns 405.
- Version 1 does not expose a legacy `/sse` endpoint.
- Vercel rewrites its platform function path so clients still connect to `/mcp`, not `/api/mcp`.
- Providers do not receive separate MCP endpoints. Twitee and X are selected through configuration and tool arguments.
- Bearer access control and rate limiting apply to `/mcp` requests.
- `OPTIONS /mcp`, `/healthz`, and `/readyz` do not require bearer access.
- Health responses expose only generic status and version information, never configuration values, provider tokens, or access tokens.
- Origin-less requests remain valid for non-browser MCP clients.
- Requests that contain an `Origin` header must pass runtime Origin validation before MCP dispatch.

## 10. Access control

Version 1 supports:

- `anonymous`: no MCP credential is required.
- `bearer`: every MCP request must contain the single configured bearer token.

The bearer comparison must avoid ordinary early-exit string comparison. Logs and errors must never include the supplied or configured token.

The access interface must permit a later multi-token implementation without changing provider or tool contracts. Multi-token identity and MCP OAuth are outside version 1.

## 11. Rate limiting

The YAML surface is deliberately small:

```yaml
ratelimit:
  enabled: true
  limit: 60
  window: 1m
```

Rate-limit keys are derived as follows:

- Anonymous mode uses the best trustworthy client address supplied by the runtime adapter.
- Bearer mode uses a one-way hash of the configured bearer credential, never the raw token.

Runtime semantics:

- Cloudflare uses the Workers Rate Limiting binding. Its counter is edge-location-local, permissive, and eventually consistent.
- Long-lived Node/Docker uses an in-memory per-process limiter.
- Kubernetes with multiple replicas has independent per-process counters.
- Serverless Node/Vercel instances do not provide a durable global counter in version 1.

The feature is an abuse/burst guard, not exact quota or accounting. Documentation and `make doctor` must not describe it as globally consistent. A future distributed backend may be added without changing the YAML's simple limit/window fields.

## 12. Runtime architecture

The core uses TypeScript and Web Standard APIs. Platform-specific APIs appear only in runtime adapters.

```text
Core: configuration, MCP tools, providers, normalization, auth, errors
  +-- Cloudflare Worker adapter
  +-- Node HTTP adapter
  +-- Vercel adapter

Docker and Kubernetes run the Node adapter.
```

Entrypoints:

```text
src/runtimes/cloudflare.ts
src/runtimes/node.ts
src/runtimes/vercel.ts
```

- Cloudflare uses the stateless `createMcpHandler` Streamable HTTP path.
- Node uses the official stateless Streamable HTTP server transport.
- Vercel adapts the Web Standard handler to a Vercel Function.
- The package exports `createMcpServer(config)`, a Web Standard fetch handler factory, and a Node handler factory.

Workers and Vercel validate YAML during build and generate a configuration module. Node validates YAML at process startup and accepts `--config <path>`.

## 13. Repository structure

The project begins as one npm package rather than a monorepo.

```text
twitter-search-mcp/
  mcp.config.example.yaml
  src/
    config/
      schema.ts
      load.ts
    providers/
      provider.ts
      twitee.ts
      x.ts
    tools/
      search-posts.ts
      lookup-profile.ts
      search-profiles.ts
    core/
      server.ts
      auth.ts
      ratelimit.ts
      errors.ts
    runtimes/
      cloudflare.ts
      node.ts
      vercel.ts
  deploy/
    docker/
    kubernetes/
  examples/
  tests/
  Makefile
  package.json
```

Files stay separated by responsibility. Platform adapters may depend on core; core may not import platform adapters.

## 14. Deployment support

Support is tiered by verified behavior:

- Tier 1: Cloudflare Workers and Node/Docker. CI requires integration smoke tests.
- Tier 2: Kubernetes and Vercel. The repository provides official templates and smoke tests.
- Portable: Web Standard and Node exports support Railway, Render, Fly.io, Deno-compatible runtimes, and later platforms where their runtime APIs are compatible.

The project does not claim support for a platform until a repeatable smoke test exists.

Kubernetes version 1 uses plain manifests/Kustomize rather than Helm. Images are published to GHCR for tagged releases.

## 15. Makefile interface

The Makefile is a thin wrapper over npm scripts and platform CLIs.

```text
make help
make setup
make dev
make check
make build
make doctor
make deploy-cloudflare
make deploy-vercel
make docker-build
make docker-run
make deploy-k8s KUBE_CONTEXT=<context>
make clean
```

Rules:

- `make setup` runs dependency installation and copies the example config only when the private config is absent.
- Deploy targets run checks and diagnostics first.
- Kubernetes deployment requires an explicit `KUBE_CONTEXT`; it never silently uses the current context.
- `make clean` removes only known generated/build artifacts and never removes private config or user data.
- npm scripts remain available for systems without Make.

## 16. Errors

Tool-level errors use stable normalized codes:

```text
INVALID_INPUT
PROVIDER_DISABLED
CAPABILITY_UNSUPPORTED
AUTH_REQUIRED
RATE_LIMITED
UPSTREAM_RATE_LIMITED
UPSTREAM_UNAVAILABLE
CONFIG_INVALID
```

Errors may include `retry_after_seconds` when known. Raw upstream error bodies are not returned when they may contain credentials or implementation details. Upstream 429 responses retain safe reset/retry metadata.

## 17. Observability and health

- Logs are structured JSON to stdout or the platform log sink.
- Logs include request ID, tool, provider, duration, outcome, and result count.
- Search queries are not logged by default. An explicit debug setting may enable them in a later version.
- Tokens and Authorization headers are always redacted.
- `/healthz` reports process/runtime health.
- `/readyz` reports configuration and provider initialization readiness without calling upstream services on every request.
- `make doctor` validates configuration and may perform explicit upstream connectivity checks.

## 18. Testing and release gates

Required automated verification:

- Unit tests for strict YAML validation, cursor binding, bearer access, token redaction, and rate limiting.
- Provider contract tests using deterministic Twitee and X fixtures.
- MCP client integration tests for all registered tools and structured output schemas.
- Runtime smoke tests for Workers, Node, and Vercel.
- Docker container smoke test.
- Kubernetes manifest validation.
- Tests that confirm X-only deployments omit `search_profiles`.
- Tests that confirm provider override policy never triggers fallback.
- Regression tests proving secrets do not appear in logs or ordinary errors.

Pull-request CI does not call live providers. Live Twitee/X tests are manually triggered because they depend on external availability and may consume quota or credits.

A release requires `make check`, Tier 1 smoke tests, and successful packaging.

## 19. OSS distribution and governance

The repository is licensed under MIT and includes:

- README with quick starts for Twitee-only, X-only, and dual-provider deployments.
- CONTRIBUTING guide.
- SECURITY policy with private vulnerability reporting instructions.
- Code of Conduct.
- Architecture and provider contract documentation.
- Trademark disclaimer stating the project is not affiliated with or endorsed by X Corp or Twitee.

Each SemVer release publishes:

- A GitHub Release and changelog.
- A GHCR image tagged with the version and immutable digest.
- The `twitter-search-mcp` npm package, or a scoped package if the unscoped name is unavailable.
- Stable Cloudflare and Vercel deployment templates tied to a release rather than `main`.

## 20. Success criteria

Version 1 is complete when:

1. A new user can clone the repository, run `make setup`, keep Twitee enabled, and connect an MCP client locally without authentication.
2. A user can enable X in YAML, provide a deployment-owned bearer token, and use X without changing tool contracts.
3. A dual-provider deployment defaults to Twitee and uses X only when the client explicitly requests it and overrides are allowed.
4. All three tools work through Twitee; X supports post search and exact profile lookup; unsupported fuzzy X profile search is not advertised.
5. The same provider contract tests pass through the Cloudflare and Node Tier 1 runtimes.
6. Docker, Kubernetes, and Vercel deployment paths are documented and smoke-tested according to their support tier.
7. Access tokens and provider tokens do not appear in repository-tracked config, logs, health responses, or normal tool errors.
8. Rate limiting behaves according to each documented runtime scope without claiming global accuracy.
9. A tagged release produces GitHub, GHCR, and npm artifacts.
10. Cloudflare, Node, Kubernetes, and Vercel deployments expose the canonical MCP endpoint at `/mcp` with the documented stateless method behavior.
