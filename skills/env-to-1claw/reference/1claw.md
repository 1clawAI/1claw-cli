# The 1Claw pieces this skill uses

Sourced from docs.1claw.co (October 2026). Verify flags with `--help` before recommending them; the CLI moves faster
than this file.

## Protect first

`1claw ignore` (new; check `1claw ignore --help`) writes these and encrypts the files. Without it, write them by hand:

| Agent | File | Rule |
|---|---|---|
| Claude Code | `.claude/settings.json` | `"permissions": {"deny": ["Read(**/.env)", "Read(**/.env.local)", "Read(**/.env.production)", "Read(**/*.env)"]}`. Deny beats allow, so don't deny `.env.*` (it would hide `.env.example`). `.claudeignore` has no effect. |
| Cursor | `.cursorignore` | `.env`, `.env.*`, `!.env.example` (gitignore syntax). Does not cover Cursor's terminal. |
| OpenCode | `opencode.json` | `"permission": {"read": {"*": "allow", "*.env": "deny", "*.env.*": "deny", "*.env.example": "allow"}}`: last match wins, so the allow goes last. |
| Windsurf / Devin | `.devinignore` (`.codeiumignore` still read) | gitignore syntax |
| Gemini CLI, Aider, Cline, JetBrains | `.geminiignore`, `.aiderignore`, `.clineignore`, `.aiexclude` | gitignore syntax |
| Codex | none per project | `deny` filesystem rules in a permissions profile in `~/.codex/config.toml` (the user's own file) |

No rule stops every shell read, which is why the file is encrypted as well.

## Identity: the service is an "agent"

In 1Claw an agent is "a bot, service, or runtime that needs scoped, audited access". A backend is one, so nothing about
this is AI-specific.

- Created by a human: dashboard → Agents, `1claw agent create <name>`, or a chart.
- Authenticates with its `ocv_…` API key: `POST /v1/auth/agent-token` → a JWT that lasts 900 s. The SDK renews it.
- Useful agent fields (set via `1claw agent update`, `PATCH /v1/agents/{id}`; human-only):
  - `environment` (`production`, …), `environment_locked: true`, `env_auto_resolve: true`
  - `intents_api_enabled: true` for class A; `shroud_enabled: true` and `shroud_config` for class B
  - guardrails: `tx_allowed_chains`, `tx_to_allowlist`, `tx_max_value`, `tx_daily_limit`, `tx_token_allowlist`
    (native major units; daily limit is per chain family). `per_environment_guardrails` overrides per environment, and
    the strictest value wins. Loosening a guardrail goes through approval
- Policies grant the agent paths in a vault (`read`, `write`), optionally conditioned on `environment_in`.
- OIDC federation (`federation_enabled`, `1claw auth federated-token`) can replace static keys for some audiences;
  documented for Anthropic. Don't promise it for a generic VPS.

## Class A: server-side signing (Intents API)

- Provision: `1claw agent keys create <agent> --chain ethereum` (HSM generates the key), or import an existing key:
  `1claw agent keys import` / `POST /v1/agents/{id}/signing-keys/{chain}/import` with `X-Auth-Confirm` (human-only,
  password re-auth, audit-logged). Rotate: `POST …/signing-keys/{chain}/rotate`.
- Sign and broadcast: `POST /v1/agents/{id}/transactions` (SDK `client.agents.submitTransaction(agentId, {...})`,
  CLI `1claw agent tx submit`). Sign only, broadcast yourself: `POST /v1/agents/{id}/transactions/sign` (CLI
  `1claw agent tx sign`). `simulate_first: true` runs a Tenderly simulation and refuses to sign a reverting tx.
- Routed through `shroud.1claw.co`, signing happens inside the TEE; `intents_require_tee` forces that.
- Chains: `GET /v1/chains`. EVM mainnets include Ethereum, Base, Optimism, Arbitrum, Polygon, BNB, Avalanche and about
  20 more. New chains are added by 1Claw admins (`POST /v1/admin/chains`), not by an org.
- Importing an existing key keeps the same address (contract roles keep working) but the key has already been
  exposed if it was in a leaked env. A fresh HSM key plus reassigning roles is the clean end state.

## Class B: Shroud

- Base URL `https://shroud.1claw.co/v1`, header `X-Shroud-Provider: openai|anthropic|google|…`.
- Auth: the agent key (`ocv_…`), `agent_id:api_key`, an agent JWT, or a router key `sk-shroud-v1-…` (minted by a human:
  `POST /v1/agents/{id}/router-keys`, optional `spend_cap_usd`; revoke with `DELETE …/router-keys/{key_id}`, effective
  within 60 s). Router keys let a stock OpenAI/Anthropic SDK work by changing only `apiKey` and `baseURL`.
- Provider key resolved from the vault at `providers/<provider>/api-key`; the agent needs read on that path.
- Limits per agent in `shroud_config`: `allowed_providers`, `allowed_models`, `max_requests_per_minute`,
  `max_requests_per_day`, `daily_budget_usd`, `max_tokens_per_request`. Re-mint the JWT after changing it.

## Classes D–E: vault env vars

- Per-key, envelope-encrypted, scoped to environments; `sensitive: true` makes them write-only for humans after
  creation. Resolution: org shared → vault → branch override.
- From a file, without anyone seeing values: `1claw env import [--plan import-plan.json]` (reads `.env.1claw` or
  `.env`; write-only by default; `--secrets KEYS` stores those as secrets for `--vault-ref` bindings instead).
- One value by hand: `1claw env add KEY production --sensitive` (prompts), the dashboard, or a `request_secret` link.
  Never pass a value on a command line you run.
- Service reads them: SDK `client.envVars.resolve(vaultId, "production")` at startup, or `GET /v1/vaults/{id}/env-vars/resolve`
  (with `env_auto_resolve` the environment comes from the agent's tag).
- Zero-code option: `1claw env run -e production -- <start command>` launches the process with the vars injected.
  Check whether your CLI version reads per-key env vars or the legacy path-based secrets before relying on it.
- Avoid `1claw env pull -o <file>` in production: it writes the values to disk, which is the thing being removed.
- Org setting `env.enforce_agent_environment_scope` stops an agent resolving other environments' vars.

## Class C: bindings

Paid plan. An execution-intent binding (`http`, `graphql`, `grpc`, `custom`, `postgres`, `redis`, `s3`, `smtp`, …) lets 1Claw
make the call and inject the credential; `guardrails.allowed_hosts` is required.

```bash
1claw agent binding create <agent-id> --name stripe --type http \
  --config '{"base_url":"https://api.stripe.com"}' \
  --guardrails '{"allowed_hosts":["api.stripe.com"]}' \
  --credential-from-env STRIPE_KEY          # read from .env.1claw/.env here, never printed
```

- How the vault injects it (`config.auth_type`): `bearer` (default) and `oauth2` send `Authorization: Bearer <token>`;
  `header` sends `config.auth_header` (default `X-API-Key`); `query` adds `config.auth_param` (default `api_key`);
  `basic` needs `{username, password}` (use `--credential-file`).
- Credential sources: **inline** (`--credential-from-env`, `--credential-file`) is stored write-only in `__agent-keys`.
  **`--vault-ref <vault>:<path>`** points at a vault secret (import it with `1claw env import --secrets KEY`); one secret
  can feed several bindings. Grant the agent `use` on that path, not `read`: `use` lets the vault inject it into the
  call, while `read` would also let the agent fetch the value. `private_key` / `ssh_key` secrets are refused as binding credentials.
- The app reaches the API through the binding: `1claw agent binding proxy <binding>` runs a local proxy for a vendor
  SDK/CLI (point its base URL at the proxy; no key on the machine), or call `1claw agent binding execute` / the execute
  API. Rotate with `1claw agent binding rotate-credential <agent> <binding> --credential-from-env KEY`.

## Charts

`1claw diff -f chart.yaml` (read-only), then `1claw apply -f chart.yaml`. Server-side reconcile (`POST /v1/org/apply`),
human-only.

```yaml
apiVersion: 1claw/v1
kind: Chart
metadata:
  name: payments-api            # lowercase, digits, hyphens
spec:
  vaults:
    - name: payments-api-prod
  agents:
    - name: payments-api-server
      description: Payments API, production
  policies:
    - vault_ref: payments-api-prod
      principal_ref: agent:payments-api-server
      paths: [app/**]
      permissions: [read]
```

What charts do and don't do:

- Create vaults, agents, policies, connectors and bindings, in dependency order. Unknown fields are errors, so run
  `diff` first.
- Never delete; never change guardrails, policy permissions or binding config in place (refused, with the endpoint
  that owns it). Agent flags like `intents_api_enabled`, `environment`, `shroud_config` and guardrails therefore go in
  the human steps (`1claw agent update …`), not the chart, unless `diff` accepts them.
- Credentials in a chart are pointers (`credential: {vault_ref, path}`), never values.
- State in `.1claw/apply-state.json`; commit it with the chart.
