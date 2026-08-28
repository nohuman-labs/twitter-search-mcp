# Deploy to Kubernetes

Kubernetes is a Tier 2 template that runs the Node image with Kustomize. Rendering and manifest validation are part of the repository checks; apply only to a cluster you are authorized to change.

```sh
make deploy-k8s KUBE_CONTEXT=<context>
```

`KUBE_CONTEXT` is required. The Make target runs checks and diagnostics, then applies `deploy/kubernetes/overlays/example` with that exact context. Set the image name and tag in `deploy/kubernetes/overlays/example/kustomization.yaml` before deployment.

## Configuration and secrets

The tracked base ConfigMap is deliberately credential-free and Twitee-anonymous. It is appropriate only for that configuration. For X, bearer MCP access, or any non-empty token, replace the ConfigMap volume with a Secret volume that mounts one complete `mcp.config.yaml` at `/config/mcp.config.yaml`.

Do not inject individual token fields through environment variables: v1 has no environment interpolation. Keep the complete YAML private, and do not place it in the tracked ConfigMap, manifests, or a public overlay.

The manifest runs as a non-root user with a read-only root filesystem, memory-backed `/tmp`, and `/healthz`/`/readyz` probes. Each replica has its own in-memory rate-limit counter, so rate limiting is per replica and not global accounting.

Clients connect to the service ingress at `/mcp`; `POST` and `OPTIONS` are accepted, while `GET` and `DELETE` return `405`.
