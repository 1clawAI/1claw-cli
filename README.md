# @1claw/cli (v0.41.0)

Command-line interface for [1Claw](https://1claw.xyz) — HSM-backed secret management for AI agents and humans.

Designed for CI/CD pipelines, DevOps workflows, and server environments.

**HTTP surface:** Commands call the Vault REST API. The authoritative contract is [@1claw/openapi-spec](https://www.npmjs.com/package/@1claw/openapi-spec) (`openapi.yaml` / `openapi.json`).

## Installation

### Homebrew (macOS / Linux)

```bash
brew install 1clawAI/tap/oneclaw
```

### npm

```bash
npm install -g @1claw/cli
```

Or use directly with npx:

```bash
npx @1claw/cli login
```

## Authentication

### Interactive login (recommended)

```bash
1claw login
```

Opens your browser to `1claw.xyz/cli/verify` where you confirm the login code. The CLI polls for approval and stores the token locally in `~/.config/1claw/`.

### Email/password login

```bash
1claw login --email
```

Prompts for email and password. Supports MFA if enabled on your account.

### CI/CD (non-interactive)

Set environment variables — no login command needed:

```bash
export ONECLAW_TOKEN="your-jwt"
# or
export ONECLAW_API_KEY="1ck_..."
```

## Quick Start

```bash
1claw login                # Authenticate via browser
1claw setup                # Auto-configure Claude, Cursor, VS Code, etc.
1claw import .env          # Import secrets from a .env file into your vault
```

## Commands

### Setup (AI Client Auto-Configuration)

Auto-detect and configure AI clients (Claude Desktop, Cursor, VS Code, Zed, Windsurf, Claude Code, Continue.dev) to use the 1Claw MCP server for runtime secret access.

```bash
1claw setup                            # Interactive: login, create agent + vault + policy, configure clients
1claw setup --client cursor            # Configure only Cursor
1claw setup --agent-key ocv_...        # Use a specific agent API key (skips provisioning)
1claw setup --project                  # Write MCP config to current project instead of global
1claw setup --skip-auth                # Skip authentication check
1claw setup --local                    # Configure for local daemon mode (no cloud)
```

When you choose "Create a new agent", `setup` provisions everything end-to-end:

1. Creates an agent with **Shroud LLM proxy** and **Intents API** (transaction signing) enabled
2. Lists your existing vaults or auto-creates a "default" vault
3. Creates a read + write access policy on `secrets/*` for the agent
4. Binds the agent to the vault via `vault_ids`
5. Configures each selected AI client's MCP config

If you provide an existing key (`--agent-key` or "Enter an existing key"), provisioning is skipped — the assumption is those resources already exist.

### Import (.env File)

Import secrets from a local `.env` file into a 1Claw vault.

```bash
1claw import .env                      # Import all keys from .env
1claw import .env.production \
  --prefix prod/                       # Add a path prefix to all keys
1claw import .env --dry-run            # Preview what would be imported
1claw import .env --force              # Overwrite existing secrets
1claw import .env --vault <id>         # Import to a specific vault
```

Handles standard `.env` syntax: `KEY=value`, single/double-quoted values, `export` prefix, comments, and multiline values.

### Auth

```bash
1claw login              # Browser-based login
1claw login --email      # Email/password login
1claw forgot-password    # Request password reset email (no login required)
1claw reset-password     # Set new password from email token (no login required)
1claw set-password       # Set a password (platform users who don't have one)
1claw change-email       # Change your email address (sends verification code)
1claw logout             # Clear stored credentials
1claw whoami             # Show current user info

# OIDC federation (RFC 8693 token exchange)
1claw auth federated-token \
  --audience https://api.anthropic.com    # Mint short-lived RS256 JWT for an external relying party
1claw auth federated-token \
  -a https://api.anthropic.com --raw      # Just the access_token, for `export` / pipes
1claw auth federated-token \
  -a https://api.anthropic.com \
  --subject-token "$ONECLAW_AGENT_API_KEY" # Override the default subject token (current login or env)
```

Password reset only applies to **email/password** accounts (not Google/SSO-only). After reset, open the link in the email (dashboard) or pass `--token` to `reset-password`.

`set-password` is for Platform API users provisioned via OIDC who don't have a password yet. `change-email` sends a 6-digit verification code to the new address and prompts you to enter it inline.

`auth federated-token` uses your current 1claw credential as the **subject_token** and asks 1claw (an OIDC issuer at `https://api.1claw.xyz`) for a short-lived **RS256** JWT scoped to the `audience`. The acting agent must have `federation_enabled = true` and the audience must be on its `federation_audiences` allowlist (set in the dashboard or via `agents.update`). Pair with `--raw` for shell pipelines, e.g. Anthropic Workload Identity Federation:

```bash
ANTHROPIC_OIDC=$(1claw auth federated-token -a https://api.anthropic.com --raw)
# exchange ANTHROPIC_OIDC at Anthropic's WIF endpoint for an sk-ant-oat01-... token
```

### Vaults

```bash
1claw vault list                    # List all vaults
1claw vault create my-vault         # Create a vault
1claw vault get <id>                # Get vault details
1claw vault delete <id>             # Delete a vault
1claw vault link <id>               # Set default vault for this machine
1claw vault unlink                  # Remove default vault
```

### Secrets

```bash
1claw secret list                              # List secrets (metadata only)
1claw secret list --prefix api-keys/           # Filter by prefix
1claw secret get <path>                        # Fetch decrypted value
1claw secret get <path> --quiet                # Raw value only (for piping)
1claw secret set <path> <value>                # Create/update a secret
1claw secret set <path> --type password        # With explicit type
echo "sk_live_..." | 1claw secret set <path> --stdin   # From stdin
1claw secret delete <path>                     # Soft-delete
1claw secret rotate <path> <new-value>         # New version
1claw secret describe <path>                   # Metadata without value
```

### Environment (CI/CD)

```bash
1claw env pull                                 # Pull secrets as .env format
1claw env pull --format json                   # As JSON
1claw env pull --format shell                  # As export statements
1claw env pull -o .env.local                   # Write to file
1claw env push .env                            # Push .env file to vault
1claw env run -- npm start                     # Run with secrets injected
1claw env run --prefix config/ -- ./deploy.sh  # Only inject matching secrets
1claw env run --no-cache -- npm start          # Skip local cache, always fetch from API
```

### Environment Cache (Offline Mode)

Cache secrets locally in an AES-256-GCM encrypted file for offline `env run`. The encryption key is derived from your authentication token.

```bash
1claw env cache                                # Download and cache secrets locally
1claw env cache --ttl 3600                     # Cache with 1-hour TTL (default: 300s)
1claw env cache-status                         # Show cache age, vault ID, secret count
1claw env cache-clear                          # Delete the local cache
```

When a valid cache exists, `env run` uses it automatically instead of calling the API. Use `--no-cache` on `env run` to bypass. Cache is stored at `~/.config/1claw/env-cache.enc` (mode `0600`).

### Agents

```bash
1claw agent list                               # List agents
1claw agent create my-agent                    # Create agent (api_key auth)
1claw agent create my-agent \
  --token-ttl 300 \                            # 5-minute token TTL
  --vault-ids <uuid1>,<uuid2>                  # Restrict to specific vaults
1claw agent get <id>                           # Agent details + SSH public key
1claw agent update <id> \
  --token-ttl 600 \                            # Update TTL
  --vault-ids <uuid> \                         # Update vault binding
  --shroud true \                              # Enable/disable Shroud LLM proxy
  --intents-api true \                         # Enable/disable Intents API
  --execution-intents true \                   # Enable/disable Execution Intents (Pro+)
  --execution-guardrails '{"allowed_hosts":["api.example.com"]}'
1claw agent delete <id>                        # Delete an agent
1claw agent token <id>                         # Generate agent JWT (api_key only)
1claw agent token <id> --quiet                 # Raw token (for piping)
1claw agent enroll my-agent \
  --email human@example.com                    # Self-enroll (no auth needed)
1claw agent create my-agent \
  --shroud \                                   # Enable Shroud LLM proxy
  --execution-intents \                        # Enable Execution Intents (Pro+)
  --tx-to-allowlist 0x... \                    # Transaction guardrails
  --tx-max-value 0.1 \
  --tx-daily-limit 1.0 \
  --tx-allowed-chains sepolia,base
```

The CLI's `agent create` always uses `auth_method=api_key` (default; returns an `ocv_` API key). To register an `mtls` or `oidc_client_credentials` agent, use the SDK or `POST /v1/agents` directly — those auth methods don't generate an API key.

All agents automatically receive an Ed25519 SSH keypair for future A2A messaging. The public key is shown in `agent get` output.

### Bankr dynamic key vending

Lease short-lived Bankr wallet API keys from your org's partner key (`BANKR_PARTNER_KEY` on Vault). **Privileged** — agents need explicit policy on `agents/{id}/bankr/*` in `__agent-keys`. Human callers receive `api_key` once; agent tokens omit it.

```bash
1claw agent bankr-key lease <agent-id>         # Default 15 min TTL
1claw agent bankr-key lease <agent-id> --ttl 600 --wallet wlt_abc123
1claw agent bankr-key list <agent-id>          # Active leases (no secrets)
1claw agent bankr-key revoke <agent-id> <lease-id>
```

### Execution Intents (bindings)

Manage named credential handles and execute HTTP/GraphQL intents through the Vault proxy. Requires **Pro+** tier and `execution_intents_enabled` on the agent.

```bash
# Enable on an agent
1claw agent update <agent-id> --execution-intents true
1claw agent update <agent-id> --execution-guardrails '{"allowed_hosts":["api.example.com"],"max_duration_ms":30000}'

# Bindings (human-only create/update/delete)
1claw agent binding create <agent-id> \
  --name github-api --type http \
  --config '{"base_url":"https://api.github.com","auth_type":"bearer"}' \
  --credential '{"token":"ghp_..."}'

# Use a vault secret as a live-pointer credential (resolved at execution time)
1claw agent binding create <agent-id> \
  --name stripe-api --type http \
  --config '{"base_url":"https://api.stripe.com","auth_type":"bearer"}' \
  --vault-ref <vault-id>:secrets/stripe-key

1claw agent binding list <agent-id>
1claw agent binding get <agent-id> <binding-id>
1claw agent binding update <agent-id> <binding-id> --guardrails '{"allowed_paths":["/repos/*"]}'
1claw agent binding update <agent-id> <binding-id> --vault-ref <vault-id>:secrets/new-key
1claw agent binding test <agent-id> <binding-id>
1claw agent binding rotate-credential <agent-id> <binding-id> --credential '{"token":"ghp_new"}'
1claw agent binding delete <agent-id> <binding-id>

# Execute (agent or human token with execution_intents claim)
1claw agent binding execute <agent-id> \
  --binding github-api --intent-type http \
  --params '{"method":"GET","path":"/user"}'

1claw agent binding executions <agent-id>   # Audit log
```

Use `--config-file`, `--guardrails-file`, `--credential-file`, or `--params-file` instead of inline JSON when needed.

**Credential sources:** Bindings support two credential modes:
- **Inline** (default): `--credential '{"token":"..."}'` — the value is stored in the `__agent-keys` vault.
- **Vault ref** (live pointer): `--vault-ref <vault-id>:<path>` — references an existing vault secret. The credential is resolved at execution time and always uses the latest version. Useful for secrets that rotate independently or are shared across multiple bindings.

You cannot use both `--credential` and `--vault-ref` on the same command.

### Transactions (Intents API)

Submit, sign, and inspect on-chain transactions for agents with Intents API enabled.

```bash
1claw agent tx submit <agent-id> \
  --to 0xRecipient \
  --value 0.01 \
  --chain sepolia                              # Sign + broadcast
1claw agent tx submit <agent-id> \
  --to 0xRecipient \
  --value 0.01 \
  --chain sepolia \
  --simulate                                   # Simulate before signing
1claw agent tx sign <agent-id> \
  --to 0xRecipient \
  --value 0.01 \
  --chain sepolia                              # Sign only (no broadcast)
1claw agent tx list <agent-id>                 # List recent transactions
1claw agent tx get <agent-id> <tx-id>          # Get transaction details
```

Common options for `submit` and `sign`:

| Flag | Description |
| ---- | ----------- |
| `--to <address>` | Destination address (required) |
| `--value <eth>` | Value in ETH (required) |
| `--chain <name>` | Chain name or ID (required) |
| `--data <hex>` | Hex-encoded calldata |
| `--signing-key-path <path>` | Vault path to signing key |
| `--nonce <n>` | Transaction nonce |
| `--gas-price <wei>` | Gas price in wei (legacy) |
| `--gas-limit <n>` | Gas limit |
| `--max-fee-per-gas <wei>` | EIP-1559 max fee per gas |
| `--max-priority-fee-per-gas <wei>` | EIP-1559 max priority fee |
| `--simulate` | Run Tenderly simulation first |
| `--json` | Output raw JSON |

`list` and `get` accept `--include-signed-tx` to include the raw signed transaction in the response.

**Non-EVM chains** (Bitcoin, Solana, XRP, Cardano, Tron) use the same `submit` / `sign` commands with chain-specific flags instead of `--to` / `--value`:

```bash
# Solana devnet — native SOL transfer (sign-only)
1claw agent tx sign <agent-id> \
  --chain solana-devnet \
  --to <recipient-base58> \
  --value 0.001

# Bitcoin testnet — fee rate optional (sat/vByte)
1claw agent tx submit <agent-id> \
  --chain bitcoin-testnet \
  --to <bech32-address> \
  --value 0.00001 \
  --fee-rate-sat-per-vbyte 5

# XRP — simple Payment with optional destination tag
1claw agent tx submit <agent-id> \
  --chain xrp-testnet \
  --to r... \
  --value 1 \
  --destination-tag 12345

# XRP — arbitrary XRPL transaction type via --xrpl-tx-json
# Supports 30+ types: TrustSet, OfferCreate, NFTokenMint, AMMCreate, EscrowCreate, etc.
1claw agent tx submit <agent-id> \
  --chain xrp \
  --xrpl-tx-json '{"TransactionType":"TrustSet","LimitAmount":{"currency":"USD","issuer":"rIssuer...","value":"100"}}'

# Tron — optional fee limit (sun)
1claw agent tx submit <agent-id> \
  --chain tron-shasta \
  --to T... \
  --value 1 \
  --fee-limit-sun 10000000

# Cardano preprod — optional TTL (slots)
1claw agent tx submit <agent-id> \
  --chain cardano-preprod \
  --to addr_test1... \
  --value 1.5 \
  --ttl 3600
```

Supported non-EVM chain names match the chain registry (`bitcoin`, `bitcoin-testnet`, `solana`, `solana-devnet`, `xrp`, `xrp-testnet`, `cardano`, `cardano-preprod`, `tron`, `tron-shasta`). SPL (Solana) and TRC-20 (Tron) token transfers accept `--token-mint` and `--token-decimals`.

### Signing Keys (Multi-Chain)

Manage per-agent multi-chain signing keys. Keys are generated server-side and stored in the vault — the private key never leaves the HSM.

```bash
1claw agent keys list <agent-id>               # List all signing keys
1claw agent keys create <agent-id> \
  --chain ethereum                             # Provision a key (secp256k1)
1claw agent keys create <agent-id> \
  --chain solana                               # Provision a key (ed25519)
1claw agent keys rotate <agent-id> \
  --chain ethereum                             # Rotate key (new version)
1claw agent keys delete <agent-id> \
  --chain ethereum                             # Deactivate key
1claw agent export-signing-key <agent-id> \
  --chain ethereum                             # Export private key (requires password)
```

Export requires re-authentication via your account password. The private key is displayed once and audit-logged.

Supported chains: `ethereum`, `bitcoin`, `solana`, `xrp`, `cardano`, `tron`. The curve is determined by the chain.

### Unified Signing (`agent sign`)

Sign messages, typed data, or raw transactions using the agent's multi-chain signing key.

```bash
# EIP-191 personal_sign
1claw agent sign <agent-id> \
  --intent-type personal_sign \
  --message 0x48656c6c6f                       # Hex-encoded message

# EIP-712 typed data
1claw agent sign <agent-id> \
  --intent-type typed_data \
  --typed-data ./permit.json                   # JSON file with EIP-712 payload

# Raw transaction (all EIP-2718 types: legacy, EIP-1559, EIP-4844, EIP-7702)
1claw agent sign <agent-id> \
  --intent-type transaction \
  --to 0xRecipient \
  --value 0.01 \
  --chain base \
  --tx-type 2                                  # EIP-1559
```

Common options for `agent sign`:

| Flag | Description |
| ---- | ----------- |
| `--intent-type <type>` | `personal_sign`, `typed_data`, or `transaction` (required) |
| `--chain <name>` | Chain name (default: `ethereum`) |
| `--signing-key-path <path>` | Override signing key vault path |
| `--message <hex>` | Hex-encoded message (personal_sign) |
| `--typed-data <file>` | Path to EIP-712 JSON file (typed_data) |
| `--to <address>` | Destination (transaction) |
| `--value <eth>` | Value in ETH (transaction) |
| `--tx-type <n>` | Transaction type 0–4 (transaction) |
| `--json` | Output raw JSON |

### Treasury Wallets

Multi-chain wallet generation for human users (replaces CDP embedded wallets). Private keys are stored in a per-org `__treasury-keys` vault with tier-appropriate MPC custody.

```bash
1claw treasury generate                         # Generate wallets for all supported chains
1claw treasury generate \
  --chains ethereum,solana,bitcoin              # Generate for specific chains only
1claw treasury list                             # List your treasury wallets
1claw treasury get <chain>                      # Get wallet details for a chain
1claw treasury balance <chain>                  # Get native + token balances
1claw treasury balance ethereum \
  --tokens 0xA0b8...eB48,0x6B17...71d0         # Include ERC-20 token balances
1claw treasury send <chain> \
  --to 0xRecipient --amount 0.01               # Send native currency (requires password)
1claw treasury send ethereum \
  --to 0xRecipient --amount 100 \
  --token 0xA0b8...eB48                        # Send ERC-20 tokens
1claw treasury swap <chain> \
  --sell-token native --buy-token 0xA0b8... \
  --amount 0.1 --slippage 1                    # Swap via DEX aggregator
1claw treasury export <chain> --password <pw>    # Export private key (audit-logged, requires password)
1claw treasury rotate <chain>                   # Rotate key (new keypair, old deactivated)
1claw treasury deactivate <chain>               # Deactivate wallet for a chain
```

Supported chains: `ethereum`, `bitcoin`, `solana`, `xrp`, `cardano`, `tron`. Requires Pro or higher billing tier for generate and rotate.

`send` and `swap` require re-authentication via account password (prompted interactively or via `--password`). Both operations are audit-logged.

### Treasury Proposals (Multisig)

Create, sign, and execute Safe multisig transaction proposals.

```bash
1claw treasury proposal create <treasury-id> \
  --to 0xRecipient --value 1000000000000000 \
  --chain ethereum                              # Create a proposal (value in wei)
1claw treasury proposal list <treasury-id>      # List proposals
1claw treasury proposal list <treasury-id> \
  --status pending                              # Filter by status
1claw treasury proposal get <treasury-id> <id>  # Get proposal + signatures
1claw treasury proposal sign <treasury-id> <id> \
  --signature 0x... --decision approve          # Approve with EIP-712 signature
1claw treasury proposal execute <treasury-id> <id>  # Force-execute if threshold met
1claw treasury proposal cancel <treasury-id> <id>   # Cancel pending proposal
```

### Policies

```bash
1claw policy list                              # List policies for default vault
1claw policy create \
  --principal-type agent \
  --principal-id <uuid> \
  --path "api-keys/*" \
  --permissions read,write                     # Create a policy
1claw policy delete <id>                       # Remove a policy
```

### Sharing

```bash
1claw share create <secret-id> --link          # Open share link
1claw share create <secret-id> --to user:<id>  # Share with a user
1claw share create <secret-id> --to agent:<id> # Share with an agent
1claw share list                               # List outbound shares
1claw share list --inbound                     # List inbound shares
1claw share accept <id>                        # Accept a share
1claw share decline <id>                       # Decline a share
1claw share revoke <id>                        # Revoke a share
```

### Billing

```bash
1claw billing status                           # Plan, usage, limits
1claw billing credits                          # Credit balance
1claw billing usage                            # Detailed usage table
1claw billing ledger                           # Credit transaction history
```

### Audit

```bash
1claw audit list                               # Recent audit events
1claw audit list --vault <id>                  # Filter by vault
1claw audit list --action secret.read          # Filter by action
```

### Webhooks

Register and manage event webhooks for your org.

```bash
1claw webhook create \
  --url https://example.com/hook \
  --events wallet.transfer.sent,proposal.created  # Register webhook
1claw webhook create \
  --url https://example.com/hook \
  --events agent.transaction.broadcast \
  --secret my-hmac-secret                         # With HMAC verification
1claw webhook list                                # List all webhooks
1claw webhook get <id>                            # Get webhook details
1claw webhook update <id> \
  --active false                                  # Disable a webhook
1claw webhook update <id> \
  --events proposal.signed,proposal.executed      # Change event subscriptions
1claw webhook delete <id>                         # Delete a webhook
```

Supported events: `wallet.transfer.sent`, `wallet.transfer.received`, `proposal.created`, `proposal.signed`, `proposal.executed`, `proposal.cancelled`, `agent.transaction.broadcast`, `agent.transaction.signed`, `signing_key.rotated`, `policy.created`, `policy.updated`, `policy.deleted`.

### Local OpenAI-compatible proxy

```bash
1claw proxy                                    # Start a local OpenAI-compatible proxy → Shroud (default :11434)
1claw proxy --port 8080                        # Use a specific port (auto-falls-forward if busy)
1claw proxy --provider anthropic               # Force a provider instead of auto-detecting from model
1claw proxy --shroud-url https://shroud.1claw.xyz   # Override Shroud endpoint
1claw proxy -v                                 # Verbose: log each proxied request
```

`1claw proxy` is for letting tools that only know how to talk to `localhost:11434` (e.g. Ollama-compatible clients) hit Shroud transparently. Auth is taken from `--agent-key` (`agent_id:api_key` or just `ocv_…`) or `ONECLAW_AGENT_API_KEY`. If the preferred port is busy, the CLI scans up to 32 higher ports automatically.

### MFA

```bash
1claw mfa status                               # Check 2FA status
1claw mfa enable                               # Set up TOTP 2FA
1claw mfa disable                              # Turn off 2FA
```

### Platform

Manage platform apps for developers building multi-tenant applications on top of 1Claw.

```bash
1claw platform create my-app my-slug           # Register a new platform app (returns plt_ key)
1claw platform list                            # List all platform apps in your org
1claw platform get <app-id>                    # Get platform app details
1claw platform update <app-id> --name new-name # Update app settings
1claw platform delete <app-id>                 # Delete a platform app
1claw platform rotate-key <app-id>             # Rotate the plt_ API key
1claw platform reissue-claim <connection-id>   # Reissue a claim URL (no re-provisioning)

# Template management
1claw platform templates list <app-id>         # List templates for an app
1claw platform templates create <app-id> <name> \
  --spec ./template.json                       # Create a template from JSON spec

# Connected users
1claw platform users list <app-id>             # List connected users for an app
1claw platform connected-apps                  # List apps connected to your account
```

### Approvals

Human-in-the-loop approval workflow for agent actions.

```bash
1claw approval list                            # List pending approval requests
1claw approval list --status approved          # Filter by status
1claw approval get <id>                        # Get approval request details
1claw approval decide <id> approve             # Approve a pending request
1claw approval decide <id> reject --reason "Not needed"  # Reject with a reason
```

### Devices

Manage registered mobile companion app devices.

```bash
1claw device list                              # List registered devices
1claw device revoke <device-id>                # Revoke a device
```

### Configuration

```bash
1claw config list                              # Show all config
1claw config get api-url                       # Get a value
1claw config set output-format json            # Set default output
```

## Local Vault (Offline, Encrypted)

Store secrets locally in an encrypted vault — no cloud required. Secrets are encrypted at rest with AES-256-GCM using a passphrase-derived key (PBKDF2, 100k iterations).

```bash
1claw local init                   # Create local vault with passphrase
1claw local add STRIPE_KEY         # Add secret (prompted, masked)
1claw local list                   # List secret names (never values)
1claw local get STRIPE_KEY         # Retrieve a value
1claw local rm STRIPE_KEY          # Remove a secret
1claw local import .env            # Import .env file into local vault
1claw local export -o .env         # Export as .env format
1claw local sync -v <vault-id>     # Push local secrets to cloud vault
1claw local sync --pull -v <id>    # Pull cloud secrets into local vault
1claw local status                 # Show vault info (count, sync status)
1claw local destroy                # Permanently delete local vault (prompts)
1claw local destroy --force        # Delete without the confirm prompt
1claw local reset                  # Alias for destroy
```

Vault file: `~/.config/1claw/local-vault.enc` (0600 permissions, safe to back up).

**Forgot your passphrase?** The vault is encrypted with a passphrase-derived key, so there is no recovery of the contents. To start over, run `1claw local destroy --force` (no passphrase required — it also stops any running daemon holding the old vault), then `1claw local init`.

## Local Daemon (Secret Proxy)

The daemon serves secrets over a Unix socket and injects them into HTTP requests without exposing values to the AI model. This provides a trust boundary: the model knows *which* secret to use and *where* to send it, but never sees the raw value.

```bash
# Start the daemon (unlocks vault, listens on socket)
1claw daemon start

# Manage per-secret policies (which hosts can receive each secret)
1claw daemon policy add STRIPE_KEY --hosts api.stripe.com --inject-as bearer
1claw daemon policy add OPENAI_KEY --hosts api.openai.com,*.openai.com --inject-as bearer
1claw daemon policy list
1claw daemon policy remove STRIPE_KEY

# Check daemon status
1claw daemon status

# Stop the daemon
1claw daemon stop
```

### Setup for Local Mode

Configure AI clients to use the daemon instead of the cloud API:

```bash
1claw setup --local
```

This sets `ONECLAW_LOCAL_VAULT=true` and `ONECLAW_DAEMON_SOCKET` in the MCP config, so the MCP server connects to the local daemon instead of `api.1claw.xyz`. The model uses `proxy_request` to make API calls with secrets injected — the secret value never enters the model's context.

### Architecture

```
AI Client (Claude, Cursor, etc.)
    └─ MCP Server (@1claw/mcp, local mode)
         └─ Unix Socket (/~/.config/1claw/daemon.sock)
              └─ 1claw Daemon (holds decrypted vault in memory)
                   ├─ Policy Engine (per-secret host allowlist)
                   └─ Secret Proxy (injects credentials into HTTP requests)
```

## Containerized Agent Runtime (`init --docker`)

`1claw init --docker` provisions a secure agent runtime inside a Docker container in one command. The container ships with the 1Claw MCP server and a lightweight chat UI. Crucially, the container **never receives the agent API key** — the host daemon injects credentials over a read-only Unix-socket mount, preserving the same trust boundary as local daemon mode.

```bash
1claw init --docker                          # Basic secure agent (chat LLM via Shroud)
1claw init --docker --module=ampersend       # With x402 payments
1claw init --docker --module=ampersend,onchain --port 8080
1claw init --docker --llm-provider anthropic --llm-model claude-3-5-haiku-latest
1claw init --docker --local                  # Fully offline — no cloud account, no LLM
1claw init --docker --list-modules           # List available modules
```

When the cloud is reachable, `init` provisions an agent + vault + read policy and stores the agent key in your local vault (the daemon injects it toward `*.1claw.xyz`). With `--local`, nothing touches the cloud. The base image is built from bundled assets if it isn't already present, so the flow works offline.

### Chat with an LLM through Shroud

In cloud mode (not `--local`), the embedded chat UI is wired to an LLM **through Shroud** — type a message and it routes via the host daemon, which injects the `X-Shroud-Agent-Key` header (the container never sees the key). Shroud inspects the prompt (redaction, PII, injection detection) and forwards to the provider.

- Pick the model with `--llm-provider` (default `openai`) and `--llm-model` (default per provider, e.g. `gpt-4o-mini`).
- `--local` mode has **no LLM** (no cloud agent → no Shroud credential); only the `/help`, `/secrets`, `/info`, and `/proxy` slash commands work.

**Where does the provider key come from?** Shroud resolves it in this order — pick whichever you prefer:

| Option | How | Where the key lives |
| --- | --- | --- |
| **1Claw Token Billing** | Enable LLM Token Billing for the org (Dashboard → Billing, or `POST /v1/billing/llm-token-billing/subscribe`). Shroud routes through the Stripe AI Gateway. | No provider key — billed to 1Claw |
| **1Claw vault** | `--llm-api-key <key>` (default `--llm-key-store cloud`) stores it at `providers/<provider>/api-key`; or store it yourself with `1claw secret put`. Shroud auto-fetches it with the agent JWT. | Your 1Claw cloud vault |
| **Local CLI vault (BYOK)** | `--llm-api-key <key> --llm-key-store local`, or `--llm-api-key-secret <name>` to reuse an existing local secret. The daemon injects it as the `X-Shroud-Api-Key` header. | Your local CLI vault (`~/.config/1claw`) |

```bash
# Bill model usage to 1Claw (no provider key):
1claw init --docker                                   # then enable LLM Token Billing

# Provider key stored in your 1Claw vault (Shroud auto-fetches):
1claw init --docker --llm-api-key sk-...               # --llm-key-store cloud (default)

# Provider key stored in the local CLI vault (daemon injects, container never sees it):
1claw init --docker --llm-api-key sk-... --llm-key-store local
1claw init --docker --llm-api-key-secret openai-key    # reuse an existing local secret
```

In every case the container **never receives the provider key** — it's resolved server-side by Shroud (cloud vault / token billing) or injected by the host daemon (local BYOK).

### How the container is built (architecture)

Every runtime is layered on the bundled base image `1claw/agent:stable`:

```
1claw/agent:stable           ← base image (bundled with the CLI)
 ├── node + the 1Claw MCP server (1claw-mcp)
 ├── chat UI (zero-dependency Node server on :3000)
 ├── entrypoint.sh            ← decides how credentials are brokered
 └── healthcheck.sh           ← drives the container's health status
        │
        ▼  (only when --module is used)
1claw-custom-<hash>:latest    ← FROM 1claw/agent:stable + one RUN/COPY/ENV block per module
```

- **Base image is built from bundled assets** (it works offline) and stamped with an `org.1claw.base-version` label. When the CLI ships new base assets, `init` notices the stale label and rebuilds `1claw/agent:stable` automatically.
- **Entrypoint is credential-aware, not mode-aware.** It keys off the mounted daemon socket:
  - **Daemon socket present** (the default for `init --docker`, cloud *and* `--local`) → the host daemon brokers every credential over the read-only socket mount; the key never enters the container.
  - **No socket** (a standalone deploy, e.g. Cloud Run via `1claw deploy`) → it requires `ONECLAW_AGENT_API_KEY` directly (from a Secret Manager mount).
- **Module startup hooks.** After the credential check, the entrypoint runs every executable `/app/modules/*/startup.sh`, then launches the chat UI (the container's health anchor) in the foreground. Modules drop their `startup.sh` via a `copy` entry (see below).
- **Run-time wiring.** `init` sets `ONECLAW_MODE`, `ONECLAW_DAEMON_SOCKET`, `ONECLAW_CONTAINER_MODULES`, and (when an LLM is wired) the `ONECLAW_SHROUD_*` vars, and bind-mounts `~/.config/1claw/daemon.sock → /run/1claw/daemon.sock:ro`.

### Modules & the template system

A **module** is a composable container extension declared by a `module.yaml` manifest. Each bundled module lives in its own directory inside the CLI (`src/modules/<name>/`) alongside any assets it copies in. When you pass `--module=<name>`, the CLI reads the manifest(s), resolves them into an ordered set, and **generates a Dockerfile** of the form `FROM 1claw/agent:stable` followed by one layer block per module.

**Manifest schema (`module.yaml`):**

| Field | Type | Purpose |
| --- | --- | --- |
| `name` | string (required) | Module name; the directory name is canonical. |
| `version` | string (required) | Used in the image content hash and layer comment. |
| `description` | string (required) | Shown by `--list-modules`. |
| `author`, `homepage` | string | Metadata. |
| `docker.apk` | string[] | Alpine packages → `RUN apk add --no-cache ...`. |
| `docker.packages` | string[] | npm packages → `RUN npm install -g ...`. |
| `docker.copy` | `{src,dest}[]` | Files copied from the module dir → `COPY modules/<name>/<src> <dest>` (`.sh` files are auto-`chmod +x`). |
| `docker.env` | map | `ENV KEY=value` lines (values with spaces are quoted). |
| `docker.ports` | string[] | Documented additional ports. |
| `required_secrets` | `{path,description,optional}[]` | Secrets the module expects (surfaced to the user). |
| `tools` | string[] | MCP tools the module advertises. |
| `depends` | string[] | Other modules pulled in automatically. |
| `conflicts` | string[] | Modules that cannot be combined. |

**Resolution rules** (`resolveModules`): requested names are loaded, then `depends` are pulled in recursively; the full set is checked for mutual `conflicts` (hard error); finally the set is **topologically sorted** (dependencies precede dependents) with **cycle detection**. The ordered `name@version` list is hashed (FNV-1a) to name the custom image `1claw-custom-<hash>:latest`, so identical module sets reuse the same reproducible image.

**Bundled modules:**

| Module | Description | Depends |
| --- | --- | --- |
| `ampersend` | x402 payment control layer (session keys, Base USDC) | — |
| `onchain` | Multi-chain signing + Intents API tools | — |
| `langchain` | LangChain / LangGraph agent runtime (Shroud-routed) | — |
| `elizaos` | ElizaOS character runtime with vault-backed secrets | — |
| `scaffold-agent` | Scaffold-ETH 2 dApp agent | `onchain` |

```bash
1claw init --docker --list-modules                 # Print the catalog
1claw init --docker --module=ampersend,onchain     # Compose two (deps + order auto-resolved)
```

### Authoring a module (extending)

Modules are bundled with the CLI, so adding one means dropping a directory into `src/modules/` (then rebuilding/publishing the CLI):

1. **Create the directory and manifest** — `src/modules/my-tool/module.yaml`:

```yaml
name: my-tool
version: 1.0.0
description: My custom agent capability.
author: you
docker:
  apk: [ripgrep]                 # optional Alpine packages
  packages: ["my-agent-sdk@latest"]  # optional global npm installs
  copy:
    - src: startup.sh            # files live next to module.yaml
      dest: /app/modules/my-tool/startup.sh
  env:
    MY_TOOL_ENABLED: "true"
required_secrets:
  - path: integrations/my-tool/api-key
    description: API key for my-tool (injected by the daemon)
    optional: true
depends: []                      # e.g. [onchain] to require another module
conflicts: []                    # e.g. [other-tool] to forbid combining
```

2. **Add any assets** referenced by `copy` (e.g. a `startup.sh`) in the same directory. A `startup.sh` is executed once at container boot — use it for one-time setup; keep secrets out of it (resolve them through the daemon at runtime).
3. **Build/run** — `1claw init --docker --module=my-tool`. The CLI stages `modules/my-tool/*` into the build context and emits the `RUN`/`COPY`/`ENV` layers.

**Don't want to modify the CLI?** Use **`1claw eject`** to export the generated `Dockerfile`, the module asset tree, and a `docker-compose.yaml` (daemon socket pre-wired), then edit the Dockerfile freely and build/publish it yourself with `1claw publish --context ./out --tag <user>/<image>:tag`. This is the supported path for fully custom images.

## Agent Templates (`spawn`)

`1claw spawn` creates a framework-specific AI agent from a pre-built template. Each template ships a Dockerfile, starter code, and entrypoint pre-wired with 1Claw MCP and Shroud. The container follows the same daemon-socket security model as `init --docker` — **the container never sees raw API keys.**

```bash
1claw spawn langchain                        # LangChain agent with Shroud LLM routing
1claw spawn crewai --llm-api-key sk-...      # CrewAI multi-agent crew with your API key
1claw spawn openai-agents --local            # OpenAI Agents SDK, fully offline
1claw spawn --list                           # List all available templates
1claw spawn --refresh                        # Force-refresh templates from GitHub
```

### Available templates

**Python:**

| Template | Framework |
|----------|-----------|
| `langchain` | LangChain / LangGraph |
| `crewai` | CrewAI |
| `openai-agents` | OpenAI Agents SDK |
| `agentkit` | Coinbase AgentKit |
| `smolagents` | HuggingFace smolagents |
| `llamaindex` | LlamaIndex |
| `pydantic-ai` | Pydantic AI |
| `agno` | Agno |
| `coder` | Coder |

**TypeScript:**

| Template | Framework |
|----------|-----------|
| `typescript-sdk` | @1claw/sdk + Vercel AI SDK |
| `mastra` | Mastra |
| `elizaos` | ElizaOS |

### LLM authentication

Templates support the same three LLM authentication methods as `init --docker`:

```bash
# BYOK — provider key stored in 1Claw vault (Shroud auto-fetches):
1claw spawn langchain --llm-api-key sk-...

# BYOK — provider key stored in local vault (daemon injects):
1claw spawn langchain --llm-api-key sk-... --llm-key-store local

# Token Billing — enable in Dashboard, no provider key needed:
1claw spawn langchain

# Anthropic WIF — OIDC federation (configure in Dashboard):
1claw spawn langchain --llm-provider anthropic
```

### Templates vs modules

- **Templates** (`1claw spawn <name>`) are complete project scaffolds — they include a Dockerfile, starter code (e.g. `agent.py`), and entrypoint. Use a template to bootstrap a new framework-specific agent.
- **Modules** (`1claw init --docker --module=<name>`) are composable Docker layers added on top of the base `1claw/agent:stable` image. Use modules to add capabilities (payments, on-chain tools) to the base agent.

You can combine both: spawn a template, then add modules with `init --docker --module=...` on the resulting container.

### Community templates

Templates live in the [`1clawAI/agent-templates`](https://github.com/1clawAI/agent-templates) repository. To contribute a new template, see the [CONTRIBUTING.md](https://github.com/1clawAI/agent-templates/blob/main/CONTRIBUTING.md) guide.

### Container state & lifecycle

Each container's state lives at `~/.config/1claw/containers/{name}.json` (mode `0600`) and is the source of truth for `info`, `start`, `restart`, `publish`, `eject`, and `deploy`. It records the agent/vault IDs, modules, port, image, and a persisted **run spec** (image, env var *names*, mounts, labels — never secret values) so `start`/`restart` can recreate a container that was removed.

### Managing containers

```bash
1claw containers list                  # List managed agent containers
1claw containers info <name>           # Show details
1claw containers logs <name>           # Tail logs
1claw containers start <name>          # Start a stopped container (recreates if removed)
1claw containers restart <name>        # Restart a container (recreates if removed)
1claw containers stop <name>           # Stop a container
1claw containers rm <name> [--force]   # Remove container + local state
```

### Publish & eject

```bash
1claw publish --name my-agent --tag <user>/my-agent:v1   # Rebuild + push
1claw publish --tag <user>/custom:latest                 # From ./Dockerfile
1claw publish --name my-agent --commit --tag <user>/m:c  # Snapshot a running container
1claw eject --name my-agent --output ./out               # Export Dockerfile + compose + module configs
```

### Cloud deploy (Google Cloud Run)

```bash
1claw publish --name my-agent --tag <user>/my-agent:v1   # Image must be in a registry first
1claw deploy --google-cloud --name my-agent              # Generate Terraform
1claw deploy --google-cloud --name my-agent --apply      # Generate + apply (needs TF_VAR_agent_api_key)
```

In cloud mode the container uses the agent key directly (injected from Secret Manager), not the host daemon.

## Global options

```bash
--json           # Force JSON output on any command
--api-url <url>  # Override API URL for this invocation
--version        # Print version
--help           # Show help
```

## Configuration

Config is stored in `~/.config/1claw/config.json`. Keys:

| Key             | Default                 | Description                                 |
| --------------- | ----------------------- | ------------------------------------------- |
| `api-url`       | `https://api.1claw.xyz` | API base URL                                |
| `output-format` | `table`                 | Default output: `table`, `json`, or `plain` |
| `default-vault` | (none)                  | Default vault ID for commands               |

## DPoP (Proof-of-Possession)

Enable [DPoP (RFC 9449)](https://datatracker.ietf.org/doc/html/rfc9449) to bind agent tokens to a persistent P-256 keypair. Stolen tokens are unusable without the matching private key.

```bash
export ONECLAW_DPOP=true
1claw agent token <id>     # Token exchange includes DPoP proof + public JWK
```

When `ONECLAW_DPOP=true` is set, the CLI:

1. Generates a P-256 ECDSA keypair on first use and persists it at `~/.config/1claw/dpop-key.json` (mode `0600`).
2. Sends the public JWK during token exchange (`POST /v1/auth/agent-token`).
3. Attaches a `DPoP` proof JWT header to every API request.

The keypair is reused across sessions. To rotate it, delete `~/.config/1claw/dpop-key.json` — a new keypair is generated on the next request. Any tokens bound to the old key become invalid.

## CI/CD examples

### GitHub Actions

```yaml
- name: Deploy with secrets
  env:
      ONECLAW_TOKEN: ${{ secrets.ONECLAW_TOKEN }}
      ONECLAW_VAULT_ID: ${{ secrets.ONECLAW_VAULT_ID }}
  run: |
      npx @1claw/cli env pull -o .env.production
      npm run deploy
```

### Docker

```dockerfile
RUN npm install -g @1claw/cli
CMD ["1claw", "env", "run", "--", "node", "server.js"]
```

### Shell script

```bash
#!/bin/bash
eval $(1claw env pull --format shell)
./my-app
```

## License

[MIT](./LICENSE)
