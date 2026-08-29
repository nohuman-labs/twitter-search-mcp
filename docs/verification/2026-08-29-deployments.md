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
- Remote temporary deployment: PASS
- Public endpoint: `https://twitter-search-mcp.extreme-daemonosaurus.workers.dev/mcp`
- Worker version: `f8e0351a-ac24-4dd5-9bac-9c321c4e1291`

The local Worker runtime returned 200 from `/healthz` and `/readyz`, completed
MCP initialize and `tools/list`, advertised all three Twitee tools, returned 405
from `GET /mcp`, and returned 404 from `GET /sse`.

After the user explicitly accepted Cloudflare's Terms of Service and Privacy
Policy, Wrangler created a temporary preview account and deployed the Worker.
The remote endpoint returned 200 from `/healthz` and `/readyz`, completed MCP
initialize and `tools/list`, advertised all three Twitee tools, returned 405
from `GET /mcp`, 404 from `GET /sse`, and 204 from originless
`OPTIONS /mcp`. Worker startup time was 87 ms.

A live remote Twitee tool call returned the safe MCP error because the Twitee
upstream remained HTTP 502. The Worker deployment and MCP protocol path were
healthy; only the external provider result was unavailable.

## Remaining external requirements

- Claim the temporary Worker into the user's Cloudflare account before its
  claim window expires; the claim URL is intentionally not stored here.
- Twitee upstream recovery before a live Twitee search can return results.
- GitHub repository ownership and npm authentication before public release
  artifacts can be created.
