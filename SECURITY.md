# Security policy

## Reporting a vulnerability

Use GitHub's private vulnerability reporting feature for this repository when it is enabled. Repository owners should enable it in the repository security settings before public distribution. If it is not enabled, do not open a public issue with exploit details, tokens, private configuration, or generated artifacts; contact a repository maintainer through a private channel that the repository owner has explicitly published.

Include a minimal reproduction, affected version or commit, impact, and any safe mitigation. Do not include live credentials, private URLs, full private YAML, `.generated/config.ts`, `.generated/wrangler.jsonc`, Authorization headers, raw upstream responses, or logs that might contain them.

## Configuration and generated artifacts

`mcp.config.yaml` is private and Git-ignored. It can contain the shared MCP bearer token, a Twitee token, and an X bearer token. Version 1 reads tokens directly from YAML and has no environment-variable interpolation.

Cloudflare and Vercel deployments generate `.generated/config.ts` and `.generated/wrangler.jsonc` from that YAML. A generated artifact contains tokens, including the generated Wrangler `MCP_CONFIG` value. Treat those artifacts as secret material: do not commit, attach, publish, copy into tickets, or print them in CI output.

## If a token or artifact leaks

1. Rotate the affected token immediately. This includes the shared MCP bearer token and every provider token present in the leaked YAML or generated artifact.
2. Replace the value in the private deployment configuration and redeploy the affected runtime.
3. Remove the exposure from accessible issue text, logs, artifacts, or public storage where possible. Assume Git history, caches, and downloads may retain it.
4. Report the incident privately with sanitized evidence only. Never paste private config or token values into an issue, PR, report, or chat transcript.

Do not rely on redaction after publication as a substitute for rotation.

## Scope notes

The server redacts configured and supplied tokens from ordinary logs and safe errors, but operators are responsible for their deployment configuration and artifact retention. Rate limiting is an abuse guard with runtime-local scope; it is not a global quota, billing, or accounting control.

This project is not affiliated with or endorsed by X Corp or Twitee.
