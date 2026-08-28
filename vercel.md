# Deploy to Vercel

Vercel is a Tier 2 path. Deploy from a private configured checkout with:

```sh
make deploy-vercel
```

The target runs checks and diagnostics, generates serverless configuration, then runs `npx vercel --prod`. `vercel.json` rewrites `/mcp`, `/healthz`, and `/readyz` to their API function paths, so clients must still use `https://<deployment-host>/mcp`, not `/api/mcp`.

The generated configuration contains tokens: `.generated/config.ts` and generated Wrangler data must never be committed, printed in logs, or attached to a report. Vercel reads the generated configuration in v1; it does not support environment-variable interpolation for these fields. Rotate affected tokens immediately if private YAML or generated output leaks.

Vercel's in-memory rate limiter is per instance. It is an abuse guard rather than durable global quota or accounting. `POST` and `OPTIONS` are supported at `/mcp`; `GET` and `DELETE` return `405`.

The Vercel local API and package build paths are covered by repository tests. A `vercel build` CLI verification has not been established in this environment because local Vercel authentication is invalid; do not treat this guide as proof that a production Vercel deployment has been verified. Run a deployment and smoke test in the target Vercel account.
