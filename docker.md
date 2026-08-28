# Run with Docker

Docker is a Tier 1 path and runs the Node runtime. Configure a private `mcp.config.yaml` first:

```sh
make setup
make docker-build
make docker-run
```

`make docker-build` produces the local image `twitter-search-mcp:latest`. `make docker-run` starts `deploy/docker/compose.yaml`, exposes port 3000, and mounts `./mcp.config.yaml` read-only at `/config/mcp.config.yaml`.

Connect an MCP client to `http://127.0.0.1:3000/mcp`. Verify local health with:

```sh
curl -fsS http://127.0.0.1:3000/healthz
curl -fsS http://127.0.0.1:3000/readyz
npm run smoke-mcp -- --url http://127.0.0.1:3000/mcp
```

The container uses a read-only filesystem, a tmpfs `/tmp`, dropped Linux capabilities, and no-new-privileges. The Node rate limiter is in memory and per process; it is an abuse guard, not global quota/accounting.

The mounted YAML may contain tokens. Do not bake it into an image, commit it, or publish it with image artifacts. The Node runtime reads YAML at startup and does not interpolate environment variables in v1.
