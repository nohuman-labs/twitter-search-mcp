# Contributing

Thanks for improving the project. Keep changes narrow, preserve the provider-neutral contract, and add or update tests for behavior changes.

## Local workflow

Node.js 20 or newer, npm, and Make are required for the standard workflow.

```sh
make setup
make dev
make check
```

`make setup` runs `npm ci` and creates `mcp.config.yaml` only when it does not already exist. Do not replace someone else's private configuration. Keep tokens in that ignored YAML and out of test fixtures, logs, commits, and pull requests.

Useful commands:

```sh
make help
make build
make doctor
npm run doctor -- --connectivity
npm run smoke-mcp -- --url http://127.0.0.1:3000/mcp
make docker-build
make docker-run
make deploy-cloudflare
make deploy-vercel
make deploy-k8s KUBE_CONTEXT=<context>
make clean
```

`make doctor` is offline by default; connectivity checks require `--connectivity`. `make clean` removes only `dist`, `.generated`, and `coverage`; it never removes `mcp.config.yaml`.

`make deploy-k8s KUBE_CONTEXT=<context>` requires an explicit Kubernetes context. The deployment targets are real deployment commands: run them only with authority for the target environment.

## Tests and checks

Write the focused test first, observe it fail for the expected reason, make the smallest change to pass, then run the relevant test again. Finish with:

```sh
make check
git diff --check
```

Tests use deterministic Twitee and X fixtures. Pull requests must not call live providers, spend X API quota, or include private tokens. Use the smoke client only against a local server or a deployment you are authorized to test; its optional tool call reaches the configured provider.

## Contract boundaries

Core code may depend on configuration, domain, providers, and MCP tooling. Runtime adapters may depend on core. Core must not import a runtime adapter.

Provider selection is deliberate: one call uses one selected provider, with no fallback and no merged result set. Keep tool registration capability-aware: `search_profiles` is omitted whenever no enabled provider supports it. Cursor validation must continue to bind a cursor to its tool, provider, and normalized query.

Avoid adding v1 features outside the documented contract: no environment interpolation, multi-token access, per-client X credentials, global rate-limit accounting, or automatic provider substitution.

## Pull requests

Describe the user-visible behavior, the configuration or deployment impact, and the checks you ran. Update docs whenever commands, endpoint behavior, providers, deployment support, or token handling changes. Do not paste private YAML, generated serverless artifacts, Authorization headers, or token values into an issue, PR, or CI log.

Report security-sensitive issues through the process in [SECURITY.md](SECURITY.md), not a public issue.
