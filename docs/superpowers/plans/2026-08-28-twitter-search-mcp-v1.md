# Twitter Search MCP v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and release a stateless, self-hosted Twitter Search MCP server with Twitee and X providers across Cloudflare Workers, Node/Docker, Kubernetes, and Vercel.

**Architecture:** A provider-neutral TypeScript core owns strict configuration, normalized search contracts, MCP tools, auth, cursors, and safe errors. Thin runtime adapters own HTTP transport and runtime-scoped rate limiting; Twitee is the example default but has no privileged core path.

**Tech Stack:** Node.js 20+, TypeScript 7, MCP SDK v2 (`@modelcontextprotocol/server` and `@modelcontextprotocol/node` 2.0.0), Cloudflare Agents SDK 0.22, Zod 4, YAML 2, Vitest 4, Biome 2, Wrangler 4, Vercel `mcp-handler` 2, Docker, Kustomize, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-28-twitter-search-mcp-design.md`

## Global Constraints

- Canonical MCP URL is `/mcp`; no `/sse`; stateless `GET /mcp` and `DELETE /mcp` return 405.
- Tools are exactly `search_posts`, `lookup_profile`, and `search_profiles`.
- A call uses exactly one provider; never fallback and never merge.
- Twitee, X, or both may be enabled; tracked examples default to Twitee.
- `search_profiles` is not advertised when no enabled provider supports it.
- Configuration is strict YAML; tokens are read directly from ignored private YAML, never environment variables in v1.
- Tracked examples contain no credential; private and generated config remain ignored.
- Access modes are `anonymous` and one shared `bearer` token.
- Rate limiting is an abuse guard, not exact global accounting.
- Common page size defaults to 20 and is capped at 50.
- Core uses Web Standard APIs and never imports runtime adapters.
- Pull-request CI never calls live Twitee or X.
- Logs, errors, health output, npm packages, and Git history never expose real tokens.

---

## Planned File Structure

```text
package.json, package-lock.json       package metadata and exact lock
tsconfig.json, vitest.config.ts       strict build and test config
biome.json, .gitignore, LICENSE       quality, exclusions, MIT license
mcp.config.example.yaml               credential-free canonical config
examples/*.config.yaml                personal/team/public examples
src/config/*                          strict YAML schema and loader
src/domain/*                          normalized types, errors, cursors
src/providers/*                       provider interface, registry, Twitee, X
src/tools/register.ts                 capability-aware tool registration
src/core/*                            MCP server, auth, rate limit, HTTP, logs
src/runtimes/node.ts                  Node Streamable HTTP
src/runtimes/cloudflare.ts            Workers adapter
src/runtimes/vercel.ts                Vercel Web handler
api/*.ts, vercel.json                 canonical Vercel routes
scripts/*                             config generator, doctor, smoke client
.generated/*                          ignored serverless artifacts
deploy/docker/*                       production image and compose
deploy/kubernetes/*                   Kustomize manifests
tests/fixtures/*, tests/*.test.ts      deterministic verification
Makefile                              thin command wrapper
.github/workflows/*                   CI and release
README.md and OSS policy docs         usage, security, governance
```

---

### Task 1: Foundation and strict YAML configuration

**Files:**
- Create: `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `biome.json`, `.gitignore`, `LICENSE`
- Create: `mcp.config.example.yaml`, `examples/personal.config.yaml`, `examples/team.config.yaml`, `examples/public.config.yaml`
- Create: `src/config/schema.ts`, `src/config/load.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: `AppConfig`, `parseConfig(value: unknown): AppConfig`, `loadConfig(path: string): Promise<AppConfig>`.
- Produces: exact v1 provider IDs `twitee | x`.

- [ ] **Step 1: Initialize ESM package and install pinned dependency families**

```bash
npm init -y
npm install @modelcontextprotocol/server@2.0.0 @modelcontextprotocol/node@2.0.0 agents@0.22.0 mcp-handler@2.1.1 zod@4.4.3 yaml@2.9.0 hono@4.13.5 @hono/node-server@2.1.1
npm install -D typescript@7.0.2 vitest@4.1.11 @biomejs/biome@2.5.11 wrangler@4.127.0 tsx @types/node
```

Set `type: module`, `engines.node: >=20`, MIT license, npm build/check/dev/doctor scripts, and package exports for core, Node, and Vercel. Configure strict TypeScript, Vitest, and Biome.

- [ ] **Step 2: Write failing strict-config tests**

```ts
const base = {
  version: 1,
  access: { mode: "anonymous", token: "" },
  search: { default_provider: "twitee", allow_provider_override: true },
  providers: {
    twitee: { enabled: true, base_url: "https://twitee.co", token: "" },
    x: { enabled: false, base_url: "https://api.x.com", token: "" },
  },
  ratelimit: { enabled: false, limit: 60, window: "1m" },
};

it("accepts the Twitee default", () => expect(parseConfig(base).version).toBe(1));
it("rejects unknown fields", () => expect(() => parseConfig({ ...base, mystery: true })).toThrow());
it("requires X token when enabled", () => {
  const value = structuredClone(base);
  value.providers.x.enabled = true;
  expect(() => parseConfig(value)).toThrow(/X token/);
});
it("requires token for bearer access", () =>
  expect(() => parseConfig({ ...base, access: { mode: "bearer", token: "" } })).toThrow(/access token/));
it("accepts only 10s or 1m", () =>
  expect(() => parseConfig({ ...base, ratelimit: { enabled: true, limit: 1, window: "5m" } })).toThrow());
```

- [ ] **Step 3: Run tests and confirm missing-module failure**

Run: `npx vitest run tests/config.test.ts`

Expected: FAIL because `src/config/schema.ts` does not exist.

- [ ] **Step 4: Implement strict schema and YAML loader**

```ts
const providerSchema = z.object({
  enabled: z.boolean(), base_url: z.url(), token: z.string(),
}).strict();

export const appConfigSchema = z.object({
  version: z.literal(1),
  access: z.object({ mode: z.enum(["anonymous", "bearer"]), token: z.string() }).strict(),
  search: z.object({
    default_provider: z.enum(["twitee", "x"]),
    allow_provider_override: z.boolean(),
  }).strict(),
  providers: z.object({ twitee: providerSchema, x: providerSchema }).strict(),
  ratelimit: z.object({
    enabled: z.boolean(), limit: z.number().int().positive(), window: z.enum(["10s", "1m"]),
  }).strict(),
}).strict().superRefine(validateCrossFields);

export type AppConfig = z.infer<typeof appConfigSchema>;
export const parseConfig = (value: unknown): AppConfig => appConfigSchema.parse(value);
```

`validateCrossFields` enforces at least one enabled provider, enabled default, X token when X is enabled, and bearer token in bearer mode. `loadConfig` uses `node:fs/promises`, `YAML.parse`, then `parseConfig`.

- [ ] **Step 5: Add credential-free examples, verify, and commit**

Add `mcp.config.yaml`, `.generated/`, `dist/`, and `coverage/` to `.gitignore`. Run `npm run check && git diff --check`; expected PASS and no non-empty token in tracked YAML.

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts biome.json .gitignore LICENSE mcp.config.example.yaml examples src/config tests/config.test.ts
git commit -m "feat: add strict YAML configuration"
```

---

### Task 2: Domain types, safe errors, cursors, and provider registry

**Files:**
- Create: `src/domain/types.ts`, `src/domain/errors.ts`, `src/domain/cursor.ts`
- Create: `src/providers/provider.ts`, `src/providers/registry.ts`
- Test: `tests/cursor.test.ts`, `tests/errors.test.ts`, `tests/provider-registry.test.ts`

**Interfaces:**
- Produces: `Post`, `Profile`, `SearchResult<T>`, normalized inputs, and `SearchProvider`.
- Produces: `SafeError`, `encodeCursor`, `decodeCursor`, `ProviderRegistry.resolve`.
- Consumes: `AppConfig`.

- [ ] **Step 1: Write failing cursor/error/registry tests**

```ts
it("binds cursors to provider, tool, and query", () => {
  const cursor = encodeCursor({ v: 1, tool: "search_posts", provider: "x", query: "cats", continuation: "n1" });
  expect(() => decodeCursor(cursor, { tool: "search_posts", provider: "x", query: "dogs" })).toThrow(/context/i);
});

it("does not fallback when the default lacks a capability", () => {
  const registry = registryWithDefaultXAndTwitee();
  expect(() => registry.resolve("search_profiles")).toThrowError(expect.objectContaining({ code: "CAPABILITY_UNSUPPORTED" }));
});

it("serializes only safe error fields", () => {
  const error = new SafeError("UPSTREAM_UNAVAILABLE", "Unavailable", { cause: new Error("raw-secret") });
  expect(JSON.stringify(error.toPublic())).not.toContain("raw-secret");
});
```

- [ ] **Step 2: Run tests and confirm undefined exports**

Run: `npx vitest run tests/cursor.test.ts tests/errors.test.ts tests/provider-registry.test.ts`

Expected: FAIL because the domain modules do not exist.

- [ ] **Step 3: Implement normalized contracts and safe errors**

```ts
export type ToolName = "search_posts" | "lookup_profile" | "search_profiles";
export type ProviderId = "twitee" | "x";
export type SearchStatus = "ready" | "pending" | "partial";
export type SearchResult<T> = {
  provider: ProviderId;
  status: SearchStatus;
  items: T[];
  pagination: { next_cursor: string | null; has_more: boolean };
  metadata: { request_id?: string; generated_at: string };
};
```

Define the eight spec error codes. `SafeError.toPublic()` returns only `code`, `message`, and optional `retry_after_seconds`; it never returns `cause`, headers, URL query parameters, or upstream bodies.

- [ ] **Step 4: Implement cursor and registry without fallback**

Encode validated JSON as base64url. Decode with Zod and compare exact normalized context. Implement `SearchProvider.capabilities` and registry resolution in this order: override policy, enabled provider, requested capability. Stop after the selected provider; do not inspect alternatives.

- [ ] **Step 5: Verify and commit**

Run: `npm run check && git diff --check`

```bash
git add src/domain src/providers/provider.ts src/providers/registry.ts tests/cursor.test.ts tests/errors.test.ts tests/provider-registry.test.ts
git commit -m "feat: define provider-neutral search domain"
```

---

### Task 3: Twitee-compatible provider

**Files:**
- Create: `src/providers/twitee.ts`
- Create: `tests/fixtures/twitee/latest-ready.json`, `people-ready.json`, `latest-pending.json`, `error-429.json`
- Test: `tests/twitee-provider.test.ts`

**Interfaces:**
- Produces: `createTwiteeProvider({ baseUrl, token, fetch, sleep, maxPollAttempts }): SearchProvider`.
- Consumes: normalized types, cursors, and `SafeError`.

- [ ] **Step 1: Write failing Twitee contract tests**

```ts
it("maps latest results and continuation", async () => {
  const fetch = fixtureFetch("latest-ready.json");
  const provider = createTwiteeProvider({ baseUrl: "https://twitee.test", token: "", fetch, sleep: async () => {} });
  const result = await provider.searchPosts({ query: "mcp", limit: 20, cursor: null });
  expect(fetch).toHaveBeenCalledWith("https://twitee.test/api/search/latest", expect.objectContaining({ method: "POST" }));
  expect(result.items[0]).toMatchObject({ id: "1900", author: { handle: "openai" } });
});

it("returns pending after bounded empty polling", async () => {
  const provider = createTwiteeProvider({ ...options, fetch: alwaysPendingFetch(), sleep: async () => {}, maxPollAttempts: 3 });
  expect((await provider.searchPosts({ query: "new", limit: 20, cursor: null })).status).toBe("pending");
});
```

- [ ] **Step 2: Run tests and confirm missing factory**

Run: `npx vitest run tests/twitee-provider.test.ts`

Expected: FAIL because `createTwiteeProvider` is undefined.

- [ ] **Step 3: Implement strict Twitee envelope parsing and normalization**

POST `{ query, page, limit }` to `/api/search/latest` or `/api/search/people`. Send Authorization only for non-empty token. Parse `ok/data/error/meta`, branch items, generation, pagination, and status with Zod before mapping posts/profiles.

- [ ] **Step 4: Implement exact lookup, bounded polling, and safe errors**

Normalize exact handles to `@handle`. First request uses `X-Twitee-Request-Purpose: foreground`; retries use `retry`. Map refreshing materialized data to `partial`, exhausted empty work to `pending`, 429 to `UPSTREAM_RATE_LIMITED`, and retryable failure to `UPSTREAM_UNAVAILABLE` without raw bodies.

- [ ] **Step 5: Verify fixtures and commit**

Run: `npx vitest run tests/twitee-provider.test.ts && npm run check`

```bash
git add src/providers/twitee.ts tests/twitee-provider.test.ts tests/fixtures/twitee
git commit -m "feat: add Twitee search provider"
```

---

### Task 4: X API provider

**Files:**
- Create: `src/providers/x.ts`
- Create: `tests/fixtures/x/recent-search.json`, `user-lookup.json`, `error-429.json`
- Test: `tests/x-provider.test.ts`

**Interfaces:**
- Produces: `createXProvider({ baseUrl, token, fetch }): SearchProvider` with `searchProfiles: false`.
- Consumes: normalized types, cursors, and `SafeError`.

- [ ] **Step 1: Write failing X contract tests**

```ts
it("uses configured URL and bearer token", async () => {
  const fetch = fixtureFetch("recent-search.json");
  const provider = createXProvider({ baseUrl: "https://x.test", token: "x-secret", fetch });
  await provider.searchPosts({ query: "mcp", limit: 20, cursor: null });
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining("https://x.test/2/tweets/search/recent"),
    expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer x-secret" }) }));
});
it("does not claim fuzzy people search", () => expect(createXProvider(options).capabilities.searchProfiles).toBe(false));
```

- [ ] **Step 2: Run tests and confirm missing adapter**

Run: `npx vitest run tests/x-provider.test.ts`

Expected: FAIL because `src/providers/x.ts` does not exist.

- [ ] **Step 3: Implement recent search with required fields and expansions**

Call `/2/tweets/search/recent` with creation time, public metrics, author/media expansions, max results, and optional next token. Build author/media maps from `includes`; cap normalized output at 50.

- [ ] **Step 4: Implement exact user lookup and rate-limit mapping**

Call `/2/users/by/username/:username`; normalize optional `@`; reject invalid handles before fetch. Convert `x-rate-limit-reset` into `retryAfterSeconds`. Never return raw X error bodies.

- [ ] **Step 5: Verify fixtures and commit**

Run: `npx vitest run tests/x-provider.test.ts && npm run check`

```bash
git add src/providers/x.ts tests/x-provider.test.ts tests/fixtures/x
git commit -m "feat: add X API search provider"
```

---

### Task 5: Capability-aware MCP tools and server factory

**Files:**
- Create: `src/tools/register.ts`, `src/core/server.ts`, `src/index.ts`
- Test: `tests/tools.test.ts`, `tests/mcp-server.test.ts`

**Interfaces:**
- Produces: `createMcpServer(config, dependencies): McpServer`, `registerSearchTools(server, context): void`.
- Consumes: provider registry and normalized results.

- [ ] **Step 1: Write failing tool-registration tests**

```ts
it("omits search_profiles for X-only", () => {
  const registerTool = vi.fn();
  registerSearchTools({ registerTool } as never, xOnlyContext());
  expect(registerTool.mock.calls.map(([name]) => name)).toEqual(["search_posts", "lookup_profile"]);
});

it("returns structured content and JSON fallback", async () => {
  const call = captureTool("search_posts", twiteeContext());
  const result = await call({ query: "mcp", limit: 20 });
  expect(result.structuredContent).toMatchObject({ provider: "twitee", status: "ready" });
  expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
});
```

- [ ] **Step 2: Run tests and confirm registration exports are missing**

Run: `npx vitest run tests/tools.test.ts tests/mcp-server.test.ts`

Expected: FAIL because the tool registrar and server factory do not exist.

- [ ] **Step 3: Register all supported tools with full schemas**

Use Zod input/output schemas, descriptions that state exactly-one-provider/no-fallback behavior, and read-only/idempotent annotations. Default limit to 20 and cap at 50. Resolve provider before cursor decoding. Convert `SafeError` to `isError: true` containing only safe public fields.

```ts
server.registerTool("search_posts", {
  description: "Search recent X/Twitter posts through exactly one enabled provider. No fallback or merging.",
  inputSchema: searchPostsInputSchema,
  outputSchema: searchPostsOutputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, async input => toToolResult(await context.searchPosts(input)));
```

- [ ] **Step 4: Build server factory and public exports**

Instantiate enabled providers from validated config, build the registry, register supported tools, and use identity `{ name: "twitter-search-mcp", version }`. Export config/domain/provider contracts and handler factories from `src/index.ts`.

- [ ] **Step 5: Verify and commit**

Run: `npm run check && git diff --check`

```bash
git add src/tools src/core/server.ts src/index.ts tests/tools.test.ts tests/mcp-server.test.ts
git commit -m "feat: expose provider-aware MCP tools"
```

---

### Task 6: Access, redacted logging, HTTP rules, and simple rate limiting

**Files:**
- Create: `src/core/access.ts`, `src/core/client-key.ts`, `src/core/http.ts`, `src/core/logging.ts`, `src/core/ratelimit.ts`
- Test: `tests/access.test.ts`, `tests/http.test.ts`, `tests/logging.test.ts`, `tests/ratelimit.test.ts`

**Interfaces:**
- Produces: `authorize`, `clientKey`, `validateOrigin`, generic health responses, `RateLimiter`, `MemoryRateLimiter`, and `createLogger`.
- Consumes: `AppConfig` and `SafeError`.

- [ ] **Step 1: Write failing security and limiter tests**

```ts
it("rejects a wrong shared bearer token", () => {
  expect(() => authorize(new Headers({ authorization: "Bearer wrong" }), { mode: "bearer", token: "correct" }))
    .toThrowError(expect.objectContaining({ code: "AUTH_REQUIRED" }));
});

it("redacts configured and supplied tokens recursively", () => {
  const output = captureLog(createLogger(["configured", "supplied"]), { authorization: "Bearer supplied", cause: "configured" });
  expect(output).not.toContain("configured");
  expect(output).not.toContain("supplied");
});

it("rejects after the per-process limit", async () => {
  const limiter = new MemoryRateLimiter({ limit: 2, windowMs: 60_000, now: () => 0 });
  expect((await limiter.take("client")).allowed).toBe(true);
  expect((await limiter.take("client")).allowed).toBe(true);
  expect(await limiter.take("client")).toMatchObject({ allowed: false, retryAfterSeconds: 60 });
});
```

- [ ] **Step 2: Run tests and confirm missing modules**

Run: `npx vitest run tests/access.test.ts tests/http.test.ts tests/logging.test.ts tests/ratelimit.test.ts`

Expected: FAIL because core ingress helpers do not exist.

- [ ] **Step 3: Implement bearer verification, redaction, and client keys**

Use Web Crypto SHA-256 digests for fixed-length bearer comparison and limiter keys. Anonymous runtime adapters supply a vetted address. Never use or log raw tokens as keys. Logger output includes request ID, tool, provider, duration, status, and count but excludes queries by default.

- [ ] **Step 4: Implement HTTP rules and limiter interface**

```ts
export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };
export interface RateLimiter { take(key: string): Promise<RateLimitDecision>; }
```

Define `/mcp`, `/healthz`, and `/readyz` constants. Health JSON exposes only service/version/readiness. Reject malformed, opaque, or cross-origin browser Origin headers; allow Origin-less server clients. Implement a fixed-window per-process map with injected clock and opportunistic expiry.

- [ ] **Step 5: Verify secret regression suite and commit**

Run: `npm run check && git diff --check`

```bash
git add src/core/access.ts src/core/client-key.ts src/core/http.ts src/core/logging.ts src/core/ratelimit.ts tests/access.test.ts tests/http.test.ts tests/logging.test.ts tests/ratelimit.test.ts
git commit -m "feat: secure and limit MCP ingress"
```

---

### Task 7: Node runtime and canonical endpoints

**Files:**
- Create: `src/runtimes/node.ts`
- Test: `tests/node-runtime.test.ts`

**Interfaces:**
- Produces: `createNodeServer(options): Promise<http.Server>` and CLI flags `--config`, `--host`, `--port`.
- Consumes: Node MCP transport, server factory, auth, rate, Origin, and health helpers.

- [ ] **Step 1: Write failing endpoint tests on an ephemeral port**

```ts
it("mounts canonical stateless routes", async () => {
  const server = await createNodeServer({ config: testConfig(), host: "127.0.0.1", port: 0 });
  const base = serverAddress(server);
  expect((await fetch(`${base}/healthz`)).status).toBe(200);
  expect((await fetch(`${base}/readyz`)).status).toBe(200);
  expect((await fetch(`${base}/mcp`)).status).toBe(405);
  expect((await fetch(`${base}/sse`)).status).toBe(404);
  await closeServer(server);
});
```

- [ ] **Step 2: Run test and confirm missing runtime**

Run: `npx vitest run tests/node-runtime.test.ts`

Expected: FAIL because `createNodeServer` does not exist.

- [ ] **Step 3: Implement route gates and fresh stateless transports**

For each `POST /mcp`, validate Origin, authorize, rate-limit, construct a fresh `McpServer` and `NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })`, connect, and delegate. Route `OPTIONS` before auth. GET/DELETE return 405 with `Allow: POST, OPTIONS`.

- [ ] **Step 4: Add MCP protocol and bearer integration tests**

Use the official MCP client against the ephemeral server. Assert `tools/list`, a fixture-backed `search_posts` call, 401 without bearer, success with correct bearer, and no secret in captured logs.

- [ ] **Step 5: Verify graceful shutdown and commit**

Run: `npx vitest run tests/node-runtime.test.ts && npm run check`

```bash
git add src/runtimes/node.ts tests/node-runtime.test.ts package.json
git commit -m "feat: add Node Streamable HTTP runtime"
```

---

### Task 8: Cloudflare runtime and generated configuration

**Files:**
- Create: `scripts/generate-config.ts`, `src/runtimes/cloudflare.ts`
- Generate/ignore: `.generated/config.ts`, `.generated/wrangler.jsonc`
- Test: `tests/generate-config.test.ts`, `tests/cloudflare-runtime.test.ts`

**Interfaces:**
- Produces: `generateServerlessArtifacts(configPath, outputDir)` and default Worker fetch export.
- Consumes: `createMcpHandler`, common server factory, and optional `MCP_RATE_LIMITER` binding.

- [ ] **Step 1: Write failing generation and binding tests**

```ts
it("maps 1m to the Workers simple binding", async () => {
  const artifacts = await generateFromFixture({ ratelimit: { enabled: true, limit: 60, window: "1m" } });
  expect(artifacts.wrangler.ratelimits[0].simple).toEqual({ limit: 60, period: 60 });
});

it("writes token only to ignored generated output", async () => {
  const artifacts = await generateFromFixture({ xToken: "secret-x" });
  expect(artifacts.moduleSource).toContain("secret-x");
  expect(await isGitIgnored(".generated/config.ts")).toBe(true);
});
```

- [ ] **Step 2: Run tests and confirm generator/runtime absence**

Run: `npx vitest run tests/generate-config.test.ts tests/cloudflare-runtime.test.ts`

Expected: FAIL because generator and Worker entrypoint do not exist.

- [ ] **Step 3: Generate typed module and Wrangler JSON atomically**

Validate YAML before writing. Emit `config satisfies AppConfig` and Wrangler JSON containing entrypoint, current compatibility date, observability, and an optional `ratelimits` binding named `MCP_RATE_LIMITER`. Map 10s to 10 and 1m to 60. Write temporary files then rename so partial artifacts never survive failure.

- [ ] **Step 4: Implement Worker routing and native limiter adapter**

Use `createMcpHandler(factory, { route: "/mcp", responseMode: "json", legacy: "stateless" })`. Apply health, method, Origin, bearer, and rate gates outside it. The binding adapter calls `env.MCP_RATE_LIMITER.limit({ key })`; denial uses the configured window as approximate retry delay and docs retain edge-local/eventually-consistent semantics.

- [ ] **Step 5: Dry-run Wrangler, verify, and commit**

Run: `npm run generate:config && npx wrangler deploy --dry-run --config .generated/wrangler.jsonc && npm run check`

```bash
git add scripts/generate-config.ts src/runtimes/cloudflare.ts tests/generate-config.test.ts tests/cloudflare-runtime.test.ts .gitignore package.json
git commit -m "feat: add Cloudflare Worker runtime"
```

---

### Task 9: Vercel runtime and canonical rewrites

**Files:**
- Create: `src/runtimes/vercel.ts`, `api/mcp.ts`, `api/healthz.ts`, `api/readyz.ts`, `vercel.json`
- Test: `tests/vercel-runtime.test.ts`

**Interfaces:**
- Produces: a Web-standard stateless handler mounted at canonical public paths.
- Consumes: generated config, `mcp-handler` v2, common MCP registrar, and core ingress helpers.

- [ ] **Step 1: Write failing Vercel route tests**

```ts
it("rewrites canonical MCP and health paths", async () => {
  const config = JSON.parse(await readFile("vercel.json", "utf8"));
  expect(config.rewrites).toContainEqual({ source: "/mcp", destination: "/api/mcp" });
  expect(config.rewrites).toContainEqual({ source: "/healthz", destination: "/api/healthz" });
});

it("keeps stateless GET and DELETE at 405", async () => {
  expect((await vercelHandler(new Request("https://example.test/mcp"))).status).toBe(405);
});
```

- [ ] **Step 2: Run tests and confirm files are absent**

Run: `npx vitest run tests/vercel-runtime.test.ts`

Expected: FAIL because the Vercel handler and config do not exist.

- [ ] **Step 3: Implement Web handler with per-instance rate scope**

Use `mcp-handler` v2 to create a fresh stateless SDK v2 server per request. Apply common Origin, access, and rate gates before dispatch. Use `MemoryRateLimiter`; do not label it global or durable. Export Vercel Fetch handlers from `api/mcp.ts` and generic health handlers from the other functions.

- [ ] **Step 4: Add canonical rewrites and build verification**

```json
{
  "rewrites": [
    { "source": "/mcp", "destination": "/api/mcp" },
    { "source": "/healthz", "destination": "/api/healthz" },
    { "source": "/readyz", "destination": "/api/readyz" }
  ]
}
```

Run `npx vercel build` with the credential-free example copied to the ignored config path.

- [ ] **Step 5: Verify and commit**

Run: `npx vitest run tests/vercel-runtime.test.ts && npm run check`

```bash
git add src/runtimes/vercel.ts api vercel.json tests/vercel-runtime.test.ts package.json
git commit -m "feat: add Vercel MCP runtime"
```

---

### Task 10: Docker image and Kubernetes manifests

**Files:**
- Create: `deploy/docker/Dockerfile`, `deploy/docker/compose.yaml`, `.dockerignore`
- Create: `deploy/kubernetes/base/deployment.yaml`, `service.yaml`, `configmap.yaml`, `kustomization.yaml`
- Create: `deploy/kubernetes/overlays/example/kustomization.yaml`
- Test: `tests/container-smoke.sh`, `tests/kubernetes-manifests.test.ts`

**Interfaces:**
- Produces: non-root Node image on port 3000 and Kustomize deployment mounting `/config/mcp.config.yaml`.
- Consumes: Node runtime and YAML config.

- [ ] **Step 1: Write failing manifest security tests**

```ts
it("runs non-root and mounts YAML read-only", async () => {
  const deployment = await loadYaml("deploy/kubernetes/base/deployment.yaml");
  const container = deployment.spec.template.spec.containers[0];
  expect(container.securityContext).toMatchObject({
    allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, runAsNonRoot: true,
  });
  expect(container.volumeMounts).toContainEqual(expect.objectContaining({ mountPath: "/config", readOnly: true }));
});
```

- [ ] **Step 2: Run tests and confirm manifests are absent**

Run: `npx vitest run tests/kubernetes-manifests.test.ts`

Expected: FAIL because deployment files do not exist.

- [ ] **Step 3: Implement multi-stage non-root image and compose**

Use `node:22-alpine` build/runtime stages, `npm ci`, `npm run build:node`, production dependencies, numeric non-root UID, port 3000, and command:

```text
node dist/node.js --config /config/mcp.config.yaml --host 0.0.0.0 --port 3000
```

Compose bind-mounts private YAML read-only.

- [ ] **Step 4: Implement Kustomize resources, probes, and explicit config mount**

Use one base replica, ClusterIP Service, liveness `/healthz`, readiness `/readyz`, resource requests/limits, and a credential-free Twitee ConfigMap. X/bearer documentation must replace the ConfigMap with a Secret-mounted file before deployment.

- [ ] **Step 5: Build, smoke, validate, and commit**

Run: `docker build -f deploy/docker/Dockerfile -t twitter-search-mcp:test . && sh tests/container-smoke.sh twitter-search-mcp:test && kubectl kustomize deploy/kubernetes/overlays/example >/dev/null && npm run check`

```bash
git add deploy .dockerignore tests/container-smoke.sh tests/kubernetes-manifests.test.ts
git commit -m "feat: add Docker and Kubernetes deployment"
```

---

### Task 11: Makefile, diagnostics, and MCP smoke client

**Files:**
- Create: `Makefile`, `scripts/doctor.ts`, `scripts/smoke-mcp.ts`
- Test: `tests/doctor.test.ts`, `tests/makefile.test.ts`

**Interfaces:**
- Produces: approved Make targets, non-mutating doctor, and endpoint smoke command.
- Consumes: config loader, provider factories, and runtime commands.

- [ ] **Step 1: Write failing Makefile safety tests**

```ts
it("requires explicit Kubernetes context", async () => {
  const result = await run("make", ["-n", "deploy-k8s"]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout + result.stderr).toMatch(/KUBE_CONTEXT is required/);
});

it("setup never overwrites private config", async () => {
  expect(await makefileText()).toMatch(/test -e mcp\.config\.yaml \|\| cp mcp\.config\.example\.yaml mcp\.config\.yaml/);
});
```

- [ ] **Step 2: Run tests and confirm commands are missing**

Run: `npx vitest run tests/doctor.test.ts tests/makefile.test.ts`

Expected: FAIL because Makefile and scripts do not exist.

- [ ] **Step 3: Implement doctor and smoke scripts**

`doctor` validates YAML, reports enabled providers/capabilities without tokens, reports runtime rate-limit scope, and calls upstream only with `--connectivity`. `smoke-mcp` accepts URL and optional bearer argument, lists tools, calls caller-supplied fixture-safe input, and never prints the token.

- [ ] **Step 4: Implement thin Make targets**

Targets: `help`, `setup`, `dev`, `check`, `build`, `doctor`, `deploy-cloudflare`, `deploy-vercel`, `docker-build`, `docker-run`, `deploy-k8s`, `clean`. Deploy targets depend on `check doctor`. `deploy-k8s` validates non-empty `KUBE_CONTEXT`; `clean` removes only `dist`, `.generated`, and `coverage`.

- [ ] **Step 5: Verify dry runs and commit**

Run: `make help && make setup && make check && make doctor && make -n deploy-cloudflare && make -n deploy-vercel`

```bash
git add Makefile scripts/doctor.ts scripts/smoke-mcp.ts tests/doctor.test.ts tests/makefile.test.ts package.json
git commit -m "feat: add Make-based operator workflow"
```

---

### Task 12: OSS documentation and security guidance

**Files:**
- Create: `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`
- Create: `docs/architecture.md`, `docs/providers.md`, `docs/deployment/cloudflare.md`, `docker.md`, `kubernetes.md`, `vercel.md`
- Test: `tests/docs.test.ts`

**Interfaces:**
- Produces: complete Twitee-only, X-only, and dual-provider user paths.
- Consumes: exact behavior and commands from Tasks 1-11.

- [ ] **Step 1: Write failing documentation contract tests**

```ts
it("documents endpoint and no-fallback contract", async () => {
  const readme = await readFile("README.md", "utf8");
  expect(readme).toContain("/mcp");
  expect(readme).toMatch(/never.*fallback/i);
  expect(readme).toContain("mcp.config.yaml");
});

it("warns that YAML and serverless artifacts contain tokens", async () => {
  expect(await readFile("SECURITY.md", "utf8")).toMatch(/generated artifact.*token/i);
});
```

- [ ] **Step 2: Run tests and confirm docs are missing**

Run: `npx vitest run tests/docs.test.ts`

Expected: FAIL because OSS docs do not exist.

- [ ] **Step 3: Write README and deployment guides**

Include `make setup`, three provider configurations, `make dev`, MCP client URL, capability table, official deploy commands, rate-limit scope table, and direct-token artifact trade-off. State the project is not affiliated with or endorsed by X Corp or Twitee.

- [ ] **Step 4: Write contributor, security, conduct, architecture, and provider docs**

Security covers private reporting, accidental-commit rotation, private YAML exclusion, generated artifact handling, and sanitized reports. Architecture records dependency direction, capability registration, cursor binding, and no-fallback invariant.

- [ ] **Step 5: Verify links/content and commit**

Run: `npx vitest run tests/docs.test.ts && npm run check`

```bash
git add README.md CONTRIBUTING.md SECURITY.md CODE_OF_CONDUCT.md CHANGELOG.md docs tests/docs.test.ts
git commit -m "docs: add OSS usage and security guides"
```

---

### Task 13: CI, npm/GHCR packaging, and release automation

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/release.yml`
- Modify: `package.json`, `package-lock.json`
- Test: `tests/package-contract.test.ts`

**Interfaces:**
- Produces: reproducible PR gates and tagged GitHub/npm/GHCR releases.
- Consumes: Make targets, builds, Dockerfile, package exports, and smoke tests.

- [ ] **Step 1: Write failing package contract tests**

```ts
it("publishes only built package and public docs", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  expect(pkg.files).toEqual(expect.arrayContaining(["dist", "README.md", "LICENSE"]));
  expect(pkg.files).not.toContain("mcp.config.yaml");
});

it("uses MCP SDK v2 package split", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  expect(pkg.dependencies["@modelcontextprotocol/server"]).toBe("2.0.0");
  expect(pkg.dependencies["@modelcontextprotocol/sdk"]).toBeUndefined();
});
```

- [ ] **Step 2: Run tests and confirm publish fields are incomplete**

Run: `npx vitest run tests/package-contract.test.ts`

Expected: FAIL until package allowlist/exports and workflows exist.

- [ ] **Step 3: Implement PR CI matrix**

Use Node 20 and 22. Run `npm ci`, copy example config, `make check`, all runtime builds, Wrangler dry-run, Docker build/smoke, and Kustomize validation. Do not provide live provider tokens.

- [ ] **Step 4: Implement tagged release workflow**

On `v*`: require tag equals package version, run all gates, inspect `npm pack`, publish npm with provenance, push GHCR tags for version and commit SHA, record image digest, and create GitHub Release from changelog. The unscoped npm name returned 404 on 2026-08-28; recheck immediately before the first publish and switch to `@<owner>/twitter-search-mcp` if it is no longer available. Use protected GitHub environments for publishing.

- [ ] **Step 5: Verify packaging and commit**

Run: `npm pack --dry-run && npx vitest run tests/package-contract.test.ts && npm run check && docker build -f deploy/docker/Dockerfile -t twitter-search-mcp:release-test .`

```bash
git add .github package.json package-lock.json tests/package-contract.test.ts
git commit -m "ci: add verified OSS release pipeline"
```

---

### Task 14: Full-system release-candidate verification

**Files:**
- Create: `docs/verification/v1-rc.md`
- Modify: only owning files for failures discovered by this task.

**Interfaces:**
- Produces: sanitized evidence that every spec success criterion is met.
- Consumes: all previous tasks.

- [ ] **Step 1: Run complete local gate**

```bash
make setup
make check
make build
make doctor
npm pack --dry-run
docker build -f deploy/docker/Dockerfile -t twitter-search-mcp:rc .
sh tests/container-smoke.sh twitter-search-mcp:rc
kubectl kustomize deploy/kubernetes/overlays/example >/dev/null
npx wrangler deploy --dry-run --config .generated/wrangler.jsonc
npx vercel build
```

Expected: all exit 0; npm pack excludes private/generated config; no live provider call occurs.

- [ ] **Step 2: Exercise Node MCP endpoint against fixtures**

Start Node with deterministic fixture upstreams. Use `scripts/smoke-mcp.ts` to verify all three Twitee tools, `GET /mcp` 405, `/sse` 404, and health 200.

- [ ] **Step 3: Exercise X-only and dual-provider matrices**

X-only advertises only post search and exact lookup. Dual mode defaults to Twitee, explicit X uses X, and override-disabled calls reject X without invoking either adapter. Capture adapter call counts as evidence.

- [ ] **Step 4: Record sanitized verification and fix every failure**

Write command, date, runtime, outcome, and sanitized summary. Exclude queries, private YAML, tokens, Authorization headers, and generated modules. Fix in the owning task's files; rerun the smallest failure then `make check`.

- [ ] **Step 5: Commit the verified release candidate**

Run: `git status --short && git diff --check && make check`

```bash
git add docs/verification/v1-rc.md
git add -u
git commit -m "chore: verify v1 release candidate"
```
