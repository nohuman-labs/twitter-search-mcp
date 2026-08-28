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
- Generated configuration: credential-free anonymous Twitee configuration
- Remote deployment: BLOCKED before upload

The local Wrangler session is not authenticated. The supported temporary
deployment path requested explicit acceptance of Cloudflare's Terms of Service
and Privacy Policy. The prompt was cancelled because accepting legal terms
requires the user's explicit action. No Worker was created or changed.

## Remaining external requirements

- Explicit user acceptance of Cloudflare's terms, or an authenticated Wrangler
  session, before a remote Worker can be deployed.
- Twitee upstream recovery before a live Twitee search can return results.
- GitHub repository ownership and npm authentication before public release
  artifacts can be created.
