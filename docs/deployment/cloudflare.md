# Deploy to Cloudflare Workers

Cloudflare Workers is a Tier 1 deployment path. From a private configured checkout, deploy with:

```sh
make deploy-cloudflare
```

This runs `make check`, `make doctor`, `npm run generate:config`, and then:

```sh
npx wrangler deploy --config .generated/wrangler.jsonc
```

The generated configuration uses current Wrangler-compatible JSONC, `nodejs_compat`, and the project compatibility date. Do not hand-edit `.generated/wrangler.jsonc`; change `mcp.config.yaml` and regenerate it instead.

## Tokens and generated configuration

The generated `MCP_CONFIG` value and `.generated/config.ts` contain the complete private YAML, including tokens. Keep `.generated/` ignored and out of commits, CI logs, issue attachments, and release uploads. There is no environment-variable interpolation in v1. If generated output or private YAML leaks, rotate every affected token immediately; see [SECURITY.md](../../SECURITY.md).

## Rate limiting

When `ratelimit.enabled` is true, generation adds an `MCP_RATE_LIMITER` Workers Rate Limiting binding. Its namespace ID is intentionally a placeholder in generated output. Replace that placeholder with the namespace ID for the enabled rate limiter before deployment. Do not enable Cloudflare rate limiting with the placeholder unchanged.

The Workers binding is edge-location-local, permissive, and eventually consistent. It is an abuse guard, not global quota or accounting.

## Endpoint

Connect clients to `https://<worker-host>/mcp`. The route accepts `POST` and `OPTIONS`; `GET` and `DELETE` return `405`. Health endpoints are `/healthz` and `/readyz`.
