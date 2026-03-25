# @1claw/cli

Command-line interface for [1Claw](https://1claw.xyz) — HSM-backed secret management for AI agents and humans.

Designed for CI/CD pipelines, DevOps workflows, and server environments.

**HTTP surface:** Commands call the Vault REST API. The authoritative contract is [@1claw/openapi-spec](https://www.npmjs.com/package/@1claw/openapi-spec) (`openapi.yaml` / `openapi.json`).

## Installation

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

## Commands

### Auth

```bash
1claw login              # Browser-based login
1claw login --email      # Email/password login
1claw forgot-password    # Request password reset email (no login required)
1claw reset-password     # Set new password from email token (no login required)
1claw logout             # Clear stored credentials
1claw whoami             # Show current user info
```

Password reset only applies to **email/password** accounts (not Google/SSO-only). After reset, open the link in the email (dashboard) or pass `--token` to `reset-password`.

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
```

### Agents

```bash
1claw agent list                               # List agents
1claw agent create my-agent                    # Create agent (default: api_key auth)
1claw agent create my-agent \
  --auth-method mtls \                         # mTLS auth (no API key generated)
  --client-cert-fingerprint <sha256-hex>       # Client certificate fingerprint
1claw agent create my-agent \
  --auth-method oidc_client_credentials \      # OIDC auth (no API key generated)
  --oidc-issuer https://accounts.google.com \  # OIDC issuer URL
  --oidc-client-id <client-id>                 # OIDC client ID
1claw agent create my-agent \
  --token-ttl 300 \                            # 5-minute token TTL
  --vault-ids <uuid1>,<uuid2>                  # Restrict to specific vaults
1claw agent get <id>                           # Agent details + SSH public key
1claw agent update <id> \
  --token-ttl 600 \                            # Update TTL
  --vault-ids <uuid> \                         # Update vault binding
  --shroud true \                              # Enable/disable Shroud LLM proxy
  --intents-api true                           # Enable/disable Intents API
1claw agent delete <id>                        # Delete an agent
1claw agent token <id>                         # Generate agent JWT (api_key only)
1claw agent token <id> --quiet                 # Raw token (for piping)
1claw agent enroll my-agent \
  --email human@example.com                    # Self-enroll (no auth needed)
1claw agent create my-agent \
  --shroud \                                   # Enable Shroud LLM proxy
  --tx-to-allowlist 0x... \                    # Transaction guardrails
  --tx-max-value 0.1 \
  --tx-daily-limit 1.0 \
  --tx-allowed-chains sepolia,base
```

All agents automatically receive an Ed25519 SSH keypair for future A2A messaging. The public key is shown in `agent get` output.

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

### MFA

```bash
1claw mfa status                               # Check 2FA status
1claw mfa enable                               # Set up TOTP 2FA
1claw mfa disable                              # Turn off 2FA
```

### Configuration

```bash
1claw config list                              # Show all config
1claw config get api-url                       # Get a value
1claw config set output-format json            # Set default output
```

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
