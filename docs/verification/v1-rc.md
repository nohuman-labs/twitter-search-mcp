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
| Override disabled | The official smoke client failed the call; a parallel MCP protocol assertion verified public code `INVALID_INPUT` and message `Provider override is not allowed` | 0 | 0 |

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

## Final pre-commit staged-tree gate

On 2026-08-28, after the RC evidence changes were staged and with no unstaged
change, the final pre-commit tree gate ran in this order:

1. `git status --short` listed only the two staged RC evidence paths:
   `docs/verification/v1-rc.md` and `tests/rc-fixture-matrix.ts`.
2. `git diff --check` exited 0 with no output. A supplementary
   `git diff --cached --check` also exited 0 so the staged patch itself was
   checked directly.
3. `make check` exited 0: Biome checked 62 files without changes, TypeScript
   passed, and Vitest passed 107 tests in 22 files.

The commit was created immediately after this ordered gate without modifying
the staged tree.

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

## Final fix-wave re-verification

Commit `af4722d` addressed the final whole-branch review on 2026-08-28. This
section supersedes the earlier local test counts while retaining the original
Vercel blocker evidence.

| Command or check | Outcome | Sanitized summary |
| --- | --- | --- |
| Focused runtime regressions | PASS | 31 tests covered Node Host/body/abort/CORS behavior, Worker binding/real-handler/abort/CORS behavior, and Vercel abort/CORS behavior. |
| Focused provider and tool regressions | PASS | 34 tests covered X buffering, Twitee generations, provider deadlines, request-signal propagation, and overlapping-token redaction. |
| Focused config and deployment regressions | PASS | 20 tests covered clean check configuration, sanitized YAML CLI failures, explicit Cloudflare namespaces, Make wiring, and operator documentation. |
| Focused release and package regressions | PASS | 18 tests covered the Node 20 production graph, package contents, per-tag concurrency, and resumable npm/GHCR/GitHub Release states with stubbed commands. |
| Node.js 20 container check | PASS | A clean Debian-based Node 20.20.2 environment passed all 144 tests and the production build. Cloudflare-only development packages emitted engine warnings, so Wrangler generation/dry-run steps are explicitly restricted to the Node 22 matrix leg; the locked production graph has no Node 20 engine conflict. |
| Fresh detached-checkout `npm ci`, `make check`, and `make build` | PASS | The ignored generated module was absent before the run; `make check` created the credential-free fallback, Biome and TypeScript passed, and 144 tests in 25 files passed. The tracked tree remained clean. |
| Existing generated-config preservation | PASS | A digest-only before/after comparison was identical across `make check`; no private/generated deploy configuration was overwritten or printed. |
| `npm pack --dry-run --json` inspection | PASS | Prepack build completed; 43 files were selected and no private config, generated config, tests, or scripts were present. |
| Docker build and `tests/container-smoke.sh` | PASS | The final-fix image built and passed non-root, read-only, health, and readiness checks. |
| Kustomize render | PASS | The example overlay rendered locally without a cluster operation. |
| Wrangler dry-run | PASS | Both the limiter-disabled example and the enabled public example bundled without deployment; the latter reported the explicit `1001` binding at 60 requests per 10 seconds. |
| `tests/rc-fixture-matrix.ts` | PASS | Twitee-only, X-only, dual-provider routing, override rejection, and the fixture HTTP matrix passed without live provider calls. |

The Vercel application build was not retried: its existing structured blocker
remains `project_settings_required`, and no login, link, pull, project creation,
deployment, publication, tag, push, or live provider operation was performed.
The release candidate therefore remains not fully externally verified.
