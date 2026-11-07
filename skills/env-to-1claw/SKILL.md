---
name: env-to-1claw
description: Redesign a project's environment-variable secrets as a 1Claw setup (vault, agent identity, policies, Shroud, server-side signing) without ever reading the secret values. Reads variable names from .env.example or the code, works out what each one is for, proposes what each should become, and applies it only after approval. Use when someone wants to move a service off .env files or platform env vars into 1Claw, after a hosting-platform breach, when hardening a backend that holds API or wallet keys, or asks "what should this .env look like with 1Claw?".
---

# env-to-1claw

Turn a service's `.env` into a 1Claw setup where the host holds one revocable credential and nothing worth stealing
on its own. Third-party API keys become **bindings**: the app or agent calls the API through 1Claw and never holds
the key. The rest become vault env vars the app reads at start-up. The output is a proposal a human approves, then
`1claw apply`, the import and the bindings, then code changes. Never a silent migration.

The CLI does the value-moving, so you never touch a value:

| Command | What it does | Safe for you to run |
|---|---|---|
| `1claw env names` | Every env var the project uses, by name, with where it's used and why | yes: never reads a value |
| `1claw ignore` | Agent ignore rules + `.gitignore`, then `.env` → `.env.1claw` (encrypted, key in the vault) | yes: prints names only |
| `1claw env import --plan f` | With `app` in the plan, does the whole migration: agent, access, env vars, bindings, removes the encrypted file, writes `.env` with only the access key | yes: prints names only |
| `1claw agent binding create … --credential-from-env KEY` | One more binding later, for an existing agent | yes: prints names only |
| `1claw ignore restore`, `secret get`, `env pull` | Put values on screen or disk | **no**: never run these |

This skill ships with the CLI (`1claw ignore` installs it), so these commands match it. If you got the skill elsewhere
and `1claw env names` is missing, ask the human to update `@1claw/cli`.

## Rules that do not bend

1. **Never read a secret value.** Do not open `.env`, `.env.local`, `.env.production`, `*.env` or backups of them. Do
   not run anything that prints the environment: `printenv`, `env`, `cat .env`, `node -e 'console.log(process.env)'`,
   `railway variables`, `vercel env pull`, `fly secrets list --show`, `docker inspect`, `/proc/*/environ`. Names come from
   templates and code only (step 1). If a step seems to need a value, it is a step for the human.
2. **Values move through the CLI or the human, never through you.** `1claw env import` and `--credential-from-env`
   carry values from the protected file to the vault inside their own process; you may run them because their output
   is names only. Otherwise the human enters values (dashboard, `1claw env add`, a `request_secret` link). You never put
   a value in a command line, a file you write, or a message.
3. **Propose, then stop.** Nothing is created in 1Claw, and no code changes, until the human has read the proposal and
   said go. `1claw diff` is fine before approval: it's read-only. `1claw apply` is not.
4. **Say what is not protected.** Every proposal has the protection table (step 4). A plan that sounds safer than it
   is does more harm than the `.env` it replaces.
5. **Check, don't assume.** Chain support, Shroud providers, plan-tier features and CLI flags change. Verify each one
   the plan depends on (step 3) and write down what you couldn't verify.

## Keep it short

For one app, the whole job is: read the names, write `import-plan.json` and a short `PROPOSAL.md`, stop, then one
`1claw env import --plan` after "go". Don't do separate dry runs, read the CLI's help or explore unrelated files. The chat
summary at each stop is under ten lines. Never search the repo for values: search for names only, in code.

## Workflow

### 0. Protect first

Before anything else, take the env files away from agents, you included: `1claw ignore`. It asks the human which vault
to use, so if the project has no `.1claw/project.json` yet, ask them to run `! 1claw ignore` themselves. It writes Claude Code / Cursor / OpenCode rules plus any other agent it finds, adds env files to
`.gitignore`, and replaces each real env file with an encrypted `.env*.1claw`. Run `1claw ignore status` to confirm.
`.env.example` stays readable on purpose.

### 1. Inventory names

```bash
1claw env names
```

It prints every name, including those listed by an encrypted `.env.1claw` the project reads, where (file:line, with long literals masked), what the surrounding code does
with it ("signals"), which real env files exist (never opened), and two warnings:

- **⚠ HARDCODED FALLBACK**: the code falls back to a long literal when the variable is unset. Treat that literal as
  a leaked secret: it is in the repo and every clone of it. If it is key-sized hex next to signing code, it is a wallet
  key. Say so at the top of the proposal; it outranks everything else in it.
- **falls back to a default literal**: the app runs with a value nobody configured (`MINE_SALT || 'DEFAULT_SALT'`).
  For anything security-relevant, the fix is to fail at startup instead.

Then read the code at the listed sites. Signals are hints. A key read in `config.ts` and used in `chain.ts` shows no
signal on its own line, so follow the property it's assigned to.

Drop names that aren't the project's: CI and tooling variables, test-only (`E2E_*`, used only under `test/`), and
anything only in scripts the service doesn't run. List what you dropped and why.

### 2. Classify each name

Use [reference/classify.md](reference/classify.md). Each name gets exactly one class and a target. The target decides
the shape of the whole plan, so get the wallet-key and model-key classes right before anything else.

For every third-party API key (class C), design the binding: its host allowlist (`allowed_hosts`, required), base URL,
`auth_type` (`bearer`, `header` + `auth_header`, `query` + `auth_param`), and which agent owns it. Then the code change:
the call goes through the binding (`1claw agent binding proxy <binding>` for a vendor SDK, or the execute API) instead
of reading the key. If the code can't go through a binding (an SDK that must hold the key in-process), say so and fall
back to an env var, with that row in the protection table.

### 3. Check what the plan depends on

Run what applies. All are read-only.

- 1Claw access: `1claw agent list` (CLI, after `1claw login`), or the MCP `list_vaults` tool. If neither works, the proposal is still useful;
  mark the checks as unverified.
- **Signing chains**: `GET https://api.1claw.co/v1/chains` (needs a 1Claw token; it answers 401 without one). If the service's chain (by chain id) is not listed, server
  signing can't be used for it today. Adding a chain is a 1Claw admin action, not an org setting. Say so plainly and use
  the fallback in classify.md, don't paper over it.
- Shroud provider support for each model provider used ([supported models](https://docs.1claw.co/docs/reference/shroud-supported-models)).
- Plan tier for anything tier-gated (bindings are paid-plan; Cedar policies Team+).
- `1claw env --help` and `1claw apply --help` for the flags you're about to recommend.

### 4. Write the proposal

Create `1claw-migration/` in the project with:

- `PROPOSAL.md` from [templates/proposal.md](templates/proposal.md): findings first (hardcoded keys, exposed files),
  then the per-name table, the protection table, human steps, code changes, rollout, rollback, and what was not
  verified.
- `import-plan.json`: the whole migration, names only. `app` makes the CLI create the app's agent and finish the job:
  ```json
  {"app": {"name": "<folder name>", "environment": "production"},
   "vars": {"DATABASE_URL": {"to": "env"},
            "PORT": {"to": "env", "sensitive": false},
            "STRIPE_KEY": {"to": "binding", "binding": {"name": "stripe", "base_url": "https://api.stripe.com", "url_env": "STRIPE_URL"}}}}
  ```
  `url_env` is the variable the app reads for that API's base URL; `1claw env run` points it at a local proxy, and sets the
  key variable to a throwaway proxy token, so a code that already reads both needs no change. Hosts default to the
  base URL's host (`allowed_hosts` to widen; `auth_type`, `auth_header`, `auth_param` for non-bearer APIs). A name marked
  `skip` keeps the encrypted file alive, so skip only what the human must still recover.
- `chart.yaml`, only for several services sharing vaults (see [reference/1claw.md](reference/1claw.md#charts)). For one app, the plan is enough.
- `human-steps.md`, only if there are any: every action only a person can do, in order, each with the exact command or dashboard path.
  Value entry, signing-key import, guardrails, router keys, funds moves, rotating the old values at their source.

Then stop and summarise in chat: the top findings, what the host will hold afterwards, and what remains exposed if
the host itself is compromised.

### 5. After approval

1. If you wrote a chart: `1claw diff -f 1claw-migration/chart.yaml`, show it, then `1claw apply -f …`.
2. `1claw env import --plan 1claw-migration/import-plan.json`. It replaces any value already in the vault with the one
   from the file, removes old env var copies of binding keys, and deletes the encrypted file and its key itself, so
   don't delete those by hand. Relay each line, including failures. It leaves `.env` with
   only the access key; you can't read it, and don't try. If an agent with that name already exists, tell the human: its
   key can't be recovered, so they delete it or you rename `app.name`.
3. If there are human steps (signing keys, guardrails, funds, router keys), hand them over. Wait for the human to confirm. Check by
   name only (`1claw env ls production`, `1claw agent binding list <agent>`, `list_secrets`): never fetch a value to
   "verify".
4. Make any code changes on a branch, as the proposal listed them; often there are none. The app now starts with
   `1claw env run -- <start command>`: it uses only the agent key in `.env`, and starts the binding proxies itself.
5. Rewrite `.env.example` as the app's new configuration: **access to a vault, not a list of values**. One access line
   (the app's 1Claw identity), plain config, and a comment for every former secret saying where it lives now. No
   values. For example:

   ```bash
   # Acme Shop's environment, after 1Claw: access to a vault, not a list of secrets.

   # Who this app is in 1Claw. The only credential on the host: scoped by policy, revocable in a minute.
   ONECLAW_AGENT_API_KEY=

   # Where the secrets went
   # DATABASE_URL, JWT_SECRET → vault env vars (production), loaded at start by `1claw env run`
   # STRIPE_API_KEY           → binding stripe: 1Claw adds it upstream, only for api.stripe.com; never on this host
   # STRIPE_URL               → set by `1claw env run` to the binding's local proxy
   ```

   Show it to the human at the end: it is the clearest picture of what changed.
6. Cut-over: deploy, check the service starts and one real operation succeeds (a read, a signed test transaction on
   the smallest amount), then the human rotates or revokes every old value at its source and deletes the old env
   files and platform variables. Until that last step, the old values still work for whoever has them.

## What this skill will not do

- Move funds, import keys, or set guardrails. Those are human-only in 1Claw (the API returns 403 to agents) and they
  should be.
- Promise that the app's own secrets are safe from a compromised host. They are fetched into memory; see the
  protection table.
- Delete anything on the old platform. The human does that after cut-over.
