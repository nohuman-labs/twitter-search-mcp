# V1 release-candidate verification

Status: **not fully verified**. All local deterministic gates passed except the
Vercel build, which is externally blocked because this checkout has no local
Vercel project settings. No project was linked, pulled, created, or deployed.

## Verification context

- Date: 2026-08-28
- Start time: 2026-08-28T09:17:25Z
- Host runtime: Node.js 26.4.0, npm 11.17.0
- Container runtime: Docker 29.4.0 using the local OrbStack builder
- Deployment tooling: kubectl client 1.33.9, Wrangler 4.127.0, Vercel CLI 59.9.1
- Scope: local fixture-injected release-candidate verification only

No live Twitee or X request was made. Provider behavior used injected fetch
adapters backed by repository fixtures and non-routable fixture hostnames. This
record intentionally excludes tool inputs, credentials, authorization headers,
private configuration, generated source, and upstream response bodies.

## Passed

| Command or check | Outcome | Sanitized summary |
| --- | --- | --- |
| `make setup` | PASS | Installed the locked dependency tree with zero reported vulnerabilities. The existing ignored local config was present before setup and its digest was unchanged afterward. |
| `make check` | PASS | Biome, TypeScript, and 107 tests in 22 files passed. |
| `make build` | PASS | The production TypeScript build completed. |
| `make doctor` | PASS | The credential-free example configuration was valid; Twitee advertised all three approved capabilities. Connectivity mode was not enabled. |
| `npm pack --dry-run` | PASS | Prepack build completed; 43 package files were selected. Private YAML and generated configuration were absent. |
| `docker build -f deploy/docker/Dockerfile -t twitter-search-mcp:rc .` | PASS | Built the local RC image from the pinned Node base image. |
| `sh tests/container-smoke.sh twitter-search-mcp:rc` | PASS | Verified the non-root image user, read-only container start, `/healthz`, and `/readyz`. |
| `kubectl kustomize deploy/kubernetes/overlays/example >/dev/null` | PASS | The example Kubernetes overlay rendered locally. No cluster operation occurred. |
| `npx wrangler deploy --dry-run --config .generated/wrangler.jsonc` | PASS | Wrangler bundled the Worker and exited in dry-run mode. No deployment occurred. |
| `./node_modules/.bin/tsx tests/rc-fixture-matrix.ts` | PASS | The official smoke client exercised the deterministic Node MCP matrices and the harness verified HTTP status behavior and adapter call counts. |
| Focused tracked-tree and packed-archive credential-signature scan | PASS | Zero high-confidence credential signatures were found. Candidate values were never printed. |
| Pack manifest inspection | PASS | The archive contained 43 files and zero private or generated configuration entries. |
| `git status --short --ignored` inspection | PASS | Generated config, build output, dependency installation, the preserved local config, and pre-existing SDD artifacts were ignored. No ignored artifact was staged. |

### Fixture MCP and HTTP evidence

The official `scripts/smoke-mcp.ts` client produced these deterministic results:

| Matrix | Advertised/called behavior | Twitee adapter calls | X adapter calls |
| --- | --- | ---: | ---: |
| Twitee-only | Advertised and successfully called `search_posts`, `lookup_profile`, and `search_profiles` | 3 | 0 |
| X-only | Advertised only `search_posts` and `lookup_profile` | 0 | 0 |
| Dual-provider | An omitted provider used the Twitee default; an explicit X selection used X | 1 | 1 |
| Override disabled | Explicit X selection was rejected before provider dispatch | 0 | 0 |

The same fixture-backed Node server returned:

| Request | Status |
| --- | ---: |
| `GET /healthz` | 200 |
| `GET /readyz` | 200 |
| `GET /mcp` | 405 |
| `DELETE /mcp` | 405 |
| `GET /sse` | 404 |
| Originless `OPTIONS /mcp` | 204 |
| Same-origin `OPTIONS /mcp` | 204, with the approved origin and methods headers |
| Cross-origin `OPTIONS /mcp` | 400 |

## Failed

No deterministic local build, test, fixture, packaging, container, Kubernetes,
or Cloudflare dry-run gate failed.

## External blockers

| Command | Outcome | Sanitized blocker |
| --- | --- | --- |
| `CI=1 npx vercel build` | BLOCKED | The CLI returned an application-level `project_settings_required` error because no local project settings exist. The process itself exited 0, so its structured error was treated as authoritative rather than as a successful build. |
| Clean temporary CLI home retry with Vercel CLI 59.9.1 | BLOCKED | The same `project_settings_required` error occurred without local CLI credentials. This proves the blocker is missing local project settings, not a usable authenticated local session. |

Resolving this blocker requires project-owned Vercel settings obtained through
an authorized link or pull operation. That remote-state action was outside this
verification scope. The Vercel application build therefore did not run, and the
release candidate must not be described as fully verified.

## Not exercised

- Live Twitee or X connectivity and live provider results
- A Vercel application build after obtaining project-owned settings
- Any publish, tag, push, deployment, project creation, project link, config
  pull, cluster apply, or production smoke test
