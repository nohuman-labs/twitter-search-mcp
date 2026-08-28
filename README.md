# Twitter Search MCP

A self-hosted MCP server for searching X/Twitter content through Twitee, the official X API, or both. It is licensed under MIT.

Start locally with the Twitee default:

```sh
make setup
make dev
```

Connect an MCP client to `http://127.0.0.1:3000/mcp`. The canonical endpoint is always `/mcp`, including Vercel deployments. It accepts `POST` and `OPTIONS`; `GET /mcp` and `DELETE /mcp` return `405`. There is no `/sse` endpoint. Use `GET /healthz` for liveness and `GET /readyz` for readiness.

`make setup` creates `mcp.config.yaml` from the credential-free example only when it is absent. Keep that private YAML out of Git.

## Providers and tools

| Provider | `search_posts` | `lookup_profile` | `search_profiles` |
| --- | --- | --- | --- |
| Twitee | yes | yes | yes |
| X | yes | yes | no |

Twitee is the default in the example configuration, not a privileged architecture path. A call uses exactly one provider: it never attempts a fallback to another provider and never merges results. When a provider is omitted, the configured default is used. An explicit different provider is accepted only when `allow_provider_override` is true. When `allow_provider_override` is false, an explicit different provider is rejected; it is never changed to the default or another provider. An X-only deployment does not advertise `search_profiles`.

See [provider details](docs/providers.md) and [architecture](docs/architecture.md) for the contract, including opaque cursors bound to the tool, provider, and query.

## Configuration

Configuration is strict YAML in `mcp.config.yaml`. Tokens are read directly from that file in v1; environment-variable interpolation is not supported. At least one provider must be enabled, the default provider must be enabled, X requires a bearer token when enabled, and bearer MCP access requires a token.

### Twitee-only

This is the local default. Copy `mcp.config.example.yaml` or use `make setup` and retain its Twitee section. Set `allow_provider_override: false` if clients must not select another enabled provider.

```yaml
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
    token: ""
```

### X-only

Use a deployment-owned X bearer token. X supports `search_posts` and exact-handle `lookup_profile`; it does not support fuzzy `search_profiles`.

```yaml
search:
  default_provider: x
  allow_provider_override: false
providers:
  twitee:
    enabled: false
    base_url: https://twitee.co
    token: ""
  x:
    enabled: true
    base_url: https://api.x.com
    token: REPLACE_WITH_X_BEARER_TOKEN
```

### Dual-provider

Enable both providers, keep Twitee as the default, and let clients opt into X explicitly.

```yaml
search:
  default_provider: twitee
  allow_provider_override: true
providers:
  twitee:
    enabled: true
    base_url: https://twitee.co
    token: ""
  x:
    enabled: true
    base_url: https://api.x.com
    token: REPLACE_WITH_X_BEARER_TOKEN
```

`access.mode` is either `anonymous` or `bearer`. Bearer access uses one shared, deployment-owned MCP token. The example [personal](examples/personal.config.yaml), [team](examples/team.config.yaml), and [public](examples/public.config.yaml) files contain no credentials.

## Run and verify

```sh
make dev
make doctor
npm run doctor -- --connectivity
npm run smoke-mcp -- --url http://127.0.0.1:3000/mcp
npm run smoke-mcp -- --url http://127.0.0.1:3000/mcp --tool search_posts --input '{"query":"MCP","limit":1}'
```

`make doctor` validates local configuration without calling providers. `--connectivity` is opt-in and sends only a `HEAD` request to each configured provider base URL. The smoke client lists tools by default; its optional sample call uses a small, safe input but may contact the configured upstream provider. Add `--bearer <token>` for bearer-protected deployments.

## Deployment

Cloudflare Workers and Node/Docker are Tier 1 paths. Kubernetes and Vercel are Tier 2 templates. Use the documented commands rather than copying generated output:

```sh
make deploy-cloudflare
# With Cloudflare rate limiting enabled:
make deploy-cloudflare CLOUDFLARE_RATE_LIMIT_NAMESPACE_ID=1001
make docker-build
make docker-run
make deploy-k8s KUBE_CONTEXT=<context>
make deploy-vercel
```

The deploy targets run checks and diagnostics first. Read [Cloudflare](docs/deployment/cloudflare.md), [Docker](docker.md), [Kubernetes](kubernetes.md), and [Vercel](vercel.md) before deploying.

## Rate limiting

Rate limiting is an abuse/burst guard, not quota or global accounting.

| Runtime | Scope |
| --- | --- |
| Cloudflare | edge-local and eventually consistent |
| Node/Docker | per process |
| Kubernetes | per replica |
| Vercel | per instance |

Enable it with a `10s` or `1m` window in `mcp.config.yaml`. Cloudflare requires the generated `MCP_RATE_LIMITER` binding and an explicit `CLOUDFLARE_RATE_LIMIT_NAMESPACE_ID`; generation refuses missing or placeholder namespaces when rate limiting is enabled.

## Token handling

The ignored `mcp.config.yaml` can contain access and provider tokens. Cloudflare and Vercel run `npm run generate:config`, which embeds that complete configuration in `.generated/config.ts` and `.generated/wrangler.jsonc`; those generated artifacts contain tokens too. Do not commit, publish, upload, log, or share either the private YAML or generated artifacts. If one leaks, rotate the affected token immediately. See [SECURITY.md](SECURITY.md).

## Contributing and status

Run `make check` before opening a contribution. [CONTRIBUTING.md](CONTRIBUTING.md) explains the local workflow; [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) sets community expectations; [CHANGELOG.md](CHANGELOG.md) records release notes.

This project is not affiliated with, endorsed by, or sponsored by X Corp or Twitee. X and Twitter are used here only to describe compatible services and APIs.
