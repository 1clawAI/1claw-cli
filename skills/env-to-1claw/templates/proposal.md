# <service>: from env vars to 1Claw

_Proposal, <date>. Nothing has been created or changed yet._

## Read this first

<!-- Findings that need action regardless of the migration, most urgent first. Examples:
- config.ts falls back to a hardcoded, key-sized literal for SIGNER_PRIVATE_KEY. Treat that key as public:
  move the funds it controls and reassign its contract roles, then remove the fallback.
- .env and .env.production exist in the repo folder (not read). Confirm they're not committed: `git log --all -- .env`.
- The service's chain (<name>, chain ID <id>) is not in 1Claw's signing chain list: see "Signing" below. -->

## What the host holds today → afterwards

| | Today | After |
|---|---|---|
| Secrets on the host | <n> values in env | `ONECLAW_AGENT_API_KEY` |
| Wallet keys on the host | <names> | none (or: see Signing) |

## Every variable

| Name | Used for (file:line) | Class | Becomes | Who sets the value |
|---|---|---|---|---|
| | | | | |

Dropped from the plan (not the service's): <names and why>.

## What this protects, and what it doesn't

<!-- The protection table from classify.md, rows for the classes present. Then two sentences on what a host
compromise still gets, in this service's terms. -->

## Signing

<!-- Class A only. Chain supported? Import vs fresh key. Proposed guardrails with numbers and the reasoning
(typical payout, largest legitimate payout, daily volume). Hot/cold split if funds matter. -->

## 1Claw setup

- `chart.yaml`: <vaults, agent, policies>. `1claw diff` output: <paste, or "not run: no 1Claw access">.
- `human-steps.md`: <count> steps, in order.

## Code changes

<!-- File by file: what changes and why. Keep each small: startup env resolve, Shroud base URL, signing call.
Note any fallback-literal removals and "fail at startup if missing" additions. -->

## Rollout

1. Create 1Claw resources (`apply`), human enters values and keys.
2. Deploy the new code alongside, check one real operation of each kind.
3. Switch traffic.
4. Human rotates every old value at its source; delete old env files and platform variables.

## Rollback

<!-- Until step 4, the old env values still work: redeploy the previous build. After step 4, rollback means
re-entering new values in env, so do step 4 only once 1-3 have run cleanly for <period>. -->

## Not verified

<!-- Each assumption the plan rests on that you could not check, and how to check it. -->
