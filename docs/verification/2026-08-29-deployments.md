# Deployment verification — 2026-08-29

This record contains sanitized deployment evidence for commit `aef3281`. It
does not contain tool queries, private YAML, tokens, authorization headers, or
generated configuration.

## Kubernetes

- Context: `orbstack` (the active `default` context was not modified)
- Namespace: `twitter-search-mcp`
- Deployment and Service: `twitter-search-mcp`
- Image: locally built `twitter-search-mcp:aef3281`
- Rollout: successful, one of one replica Ready, zero restarts
- Container controls: UID 10001, non-root, read-only root filesystem

Verified through a Service port-forward:

| Check | Result |
| --- | --- |
| `GET /healthz` | 200, ready true |
| `GET /readyz` | 200, ready true |
| `GET /mcp` | 405 with `Allow: POST, OPTIONS` |
| `GET /sse` | 404 |
| MCP initialize and `tools/list` | PASS |
| Advertised tools | `search_posts`, `lookup_profile`, `search_profiles` |

A live Twitee tool call reached the deployed MCP runtime but returned the safe
`UPSTREAM_UNAVAILABLE` result. An independent direct request to the configured
Twitee endpoint returned HTTP 502 from Cloudflare at the same time. The MCP
error log contained request ID, tool, provider, duration, outcome, count, and
safe code fields; it did not contain the search query.

## Cloudflare Workers

- Wrangler 4.127.0 dry-run: PASS
- Wrangler local Worker runtime: PASS
- Generated configuration: credential-free anonymous Twitee configuration
- Remote permanent deployment: PASS
- Public endpoint: `https://twitter-search-mcp.my-account-9e4.workers.dev/mcp`
- Worker version: `3714ed56-06dd-4573-89e8-1b1eb28646bc`
- Public source: `https://github.com/nohuman-labs/twitter-search-mcp`
- GitHub Actions deployment: `https://github.com/nohuman-labs/twitter-search-mcp/actions/runs/33223919463`

The local Worker runtime returned 200 from `/healthz` and `/readyz`, completed
MCP initialize and `tools/list`, advertised all three Twitee tools, returned 405
from `GET /mcp`, and returned 404 from `GET /sse`.

After the user configured an account-scoped Cloudflare API token, Wrangler
deployed the Worker to the user's permanent account. The remote endpoint
returned 200 from `/healthz` and `/readyz`, completed MCP initialize and
`tools/list`, advertised all three Twitee tools, returned 405 from `GET /mcp`,
and returned 404 from `GET /sse`.

A live remote Twitee tool call returned the safe MCP error while the Twitee
upstream intermittently returned HTTP 502. Independent direct checks also
observed both HTTP 200 and HTTP 502. The Worker deployment and MCP protocol
path were healthy; only the external provider result was unstable.

The first `main` workflow run loaded the account ID and API token from GitHub
Actions secrets, created the credential-free Twitee configuration, passed the
repository checks, and deployed the permanent Worker successfully.

## Remaining external requirements

- Twitee upstream recovery before a live Twitee search can return results.
- npm authentication before an optional npm package release can be created.
