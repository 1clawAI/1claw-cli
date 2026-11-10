# Classifying a variable

Decide from what the code does with the value, not from its name. The name is a hint; the call site is the evidence.
Each name gets exactly one class.

| # | Class | How to recognise it | Target in 1Claw | Host holds afterwards |
|---|---|---|---|---|
| A | **Wallet / signing key** | Passed to `privateKeyToAccount`, `new Wallet`, `Keypair.fromSecretKey`, `mnemonicToAccount`, a signer used for `writeContract` / `sendTransaction`; names like `*_PRIVATE_KEY`, `MNEMONIC`, `SIGNER_*`, `DEPLOYER_*` | Server-side signing: the key is imported (or generated) as the agent's signing key; the code calls 1Claw to sign. Guardrails: per-tx max, daily limit, recipient and contract allowlists, chain allowlist | Nothing |
| B | **Model provider key** | Passed to an OpenAI / Anthropic / Google / OpenRouter / Groq client, or sent as `Authorization` to a model API | Shroud: the provider key lives in the vault at `providers/<provider>/api-key`; the code points its client at `https://shroud.1claw.co/v1`. Limits in `shroud_config` (`allowed_models`, `daily_budget_usd`, rate limits) | The agent credential (or a router key) |
| C | **Third-party API key** | Sent to one external host (Stripe, Telegram, Alchemy, Resend, an RPC provider key embedded in a URL) | A **binding**: 1Claw makes the call and injects the credential, limited by `allowed_hosts`. Created with `--credential-from-env KEY`, the credential is inline and write-only. Fallback when the code can't go through a binding: a vault env var | Nothing (binding); the value in memory (fallback) |
| D | **Database / cache connection string** | Passed to `new Pool`, `drizzle`, `PrismaClient`, `new Redis`, `postgres()` | Vault env var (`sensitive`), resolved at startup | The value in process memory |
| E | **App secret** | The app's own signing/encryption material: `JWT_SECRET`, session/cookie secrets, HMAC keys, game salts, admin tokens and passwords | Vault env var (`sensitive`), resolved at startup. Rotate on cut-over. If it falls back to a literal when unset, fix the code to fail at startup | The value in process memory |
| F | **Not a secret** | Ports, chain ids, contract addresses, public RPC URLs without a key, feature flags, `NODE_ENV`, anything `NEXT_PUBLIC_` / `VITE_` (already shipped to browsers) | Stays as plain config (env or a committed config file). Optionally a non-sensitive vault env var, for one place to change it | Itself, which is fine |
| G | **The 1Claw bootstrap** | `ONECLAW_AGENT_API_KEY` (added by this migration) | The one credential the host keeps. Scoped by policy to exactly this service's paths and actions. Revocable | Itself |

## Judgement calls

- **A beats everything.** If a name signs transactions, it's class A even if it's also used elsewhere. A wallet key in
  memory is a different order of risk from a database URL: anyone who reads it can drain the wallet from anywhere,
  forever, and no log will show it.
- **Class A needs the chain to be supported.** Check `GET /v1/chains` for the service's chain id. If the chain is
  missing, server signing isn't available for it today, and the honest options are:
  1. Ask 1Claw to add the chain (an admin action on their side), and keep the key out of env in the meantime by
     storing it as a vault secret fetched at startup (class D/E treatment). This is better than an env var, but not
     the end state, and the proposal must say so.
  2. Restructure so the hot key holds little: a low-balance hot wallet the service signs with, topped up from a cold
     wallet that never touches the server. This limits the loss regardless of where the key lives.
  Do both when the funds matter.
- **A key-sized hardcoded fallback is class A or E *and* a finding.** The literal is in git history. Removing it from
  the code does not un-leak it: the key must be retired (funds moved, roles reassigned) or the secret rotated.
- **Test keys** (`E2E_*`, `*_TEST_*`, used only under `test/` or `scripts/`): leave them out of the production plan.
  Note them, and check they're testnet-only.
- **Two names, one secret** (`DATABASE_URL` and `DATABASE_PUBLIC_URL`): one vault entry per real value. A "public"
  connection URL that reaches the production database from the internet is a finding of its own.
- **RPC URLs**: a bare public endpoint is class F; one with a key in the path or query (`…/v2/<key>`) is class C.
- **Admin passwords and tokens compared in code** (`if (password !== process.env.ADMIN_PASSWORD)`): class E, and
  worth a note. A shared static admin secret is weaker than per-user auth, whatever stores it.

## The protection table (goes in every proposal)

Fill one row per class present in the service:

| Class | If the platform's env storage leaks (the Railway case) | If someone runs code on the host |
|---|---|---|
| A, signed via 1Claw | Nothing to steal | Can request signatures only within guardrails, every one logged, until the agent is revoked. Cannot take the key |
| A, fallback (vault secret at startup) | Nothing to steal | Gets the key |
| B, via Shroud | Nothing to steal | Can make model calls only within `shroud_config` limits, until revoked. Cannot take the provider key |
| C, binding (inline credential) | Nothing to steal | Can make calls to the allowed hosts through 1Claw, logged. Cannot take the credential |
| C, binding (`--vault-ref`) | Nothing to steal | Same, but the agent needs read on the secret's path today, so it could fetch the raw value (issue #14; a `use` permission fixes it) |
| C/D/E, fetched at startup or just in time | Nothing to steal | Gets the values in memory |
| G, the agent key | Gets exactly what its policies allow, until revoked | Same |

The host-compromise column is why classes D and E still need their own hygiene: least-privilege database users,
network restrictions, and rotation.
