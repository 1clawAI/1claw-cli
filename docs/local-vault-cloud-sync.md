# Design: Local Vault with Cloud Sync

**Status:** Proposal  
**Author:** 1Claw Engineering  
**Date:** 2026-06-22  
**Related:** Cloak adoption plan, `1claw setup` / `1claw import` features

## Problem

Users who want the Cloak-like "local-first" experience currently must choose
between local `.env` files (insecure, no encryption) or the full 1Claw cloud
vault (requires internet). There is no middle ground: an encrypted local store
that can optionally sync to the cloud.

## Goals

1. Zero-cloud-dependency secret storage for local development
2. Encrypted at rest with user-controlled passphrase
3. One-command migration path to 1Claw cloud vault
4. Local MCP mode so agents can use secrets without cloud connectivity
5. Compatible with the existing `1claw env run` workflow

## Non-Goals

- Replacing the cloud vault for production/team use cases
- Multi-user access to a local vault
- Building a full Cloak-equivalent daemon with UDS peer auth (Phase C)

## Architecture Options

### Option A: Encrypted JSON file (Recommended for MVP)

Simple AES-256-GCM encrypted JSON file at `~/.config/1claw/local-vault.enc`.

**Pros:**
- Zero external dependencies (Node.js `crypto` module only)
- Trivial to implement (~200 lines)
- Easy to backup, inspect metadata, debug
- Already proven in the `local-cache.ts` implementation

**Cons:**
- Entire vault decrypted into memory on every read
- No versioning or rollback resistance
- No concurrent access protection

**Wire format:**
```
[version:1][salt:16][iv:12][tag:16][ciphertext]
```

Key derivation: `PBKDF2(passphrase, salt, 100000, sha256) -> 256-bit key`

**Data structure (plaintext JSON):**
```json
{
  "version": 1,
  "created_at": "2026-06-22T10:00:00Z",
  "updated_at": "2026-06-22T10:30:00Z",
  "secrets": {
    "STRIPE_KEY": {
      "value": "sk_test_...",
      "type": "api_key",
      "created_at": "2026-06-22T10:00:00Z",
      "updated_at": "2026-06-22T10:00:00Z",
      "synced_to_cloud": false,
      "cloud_vault_id": null,
      "cloud_path": null
    }
  }
}
```

### Option B: SQLite + per-record AEAD (Cloak-like)

SQLite WAL database with per-record encryption, similar to Cloak's architecture.

**Pros:**
- Per-record encryption (only accessed secrets are decrypted)
- Version history per secret
- Concurrent read safety via WAL
- Rollback resistance with monotonic counter

**Cons:**
- Requires `better-sqlite3` npm dependency (native addon, build complexity)
- Significantly more code (~800+ lines)
- Overkill for single-user local dev use case
- Build/install friction on some platforms

### Option C: OS Keychain integration

Store secrets in macOS Keychain / Linux Secret Service directly.

**Pros:**
- OS-level encryption, hardware-backed on macOS (Secure Enclave)
- No custom crypto code
- Familiar trust model

**Cons:**
- Platform-specific implementation (macOS Keychain API vs D-Bus)
- No bulk operations (slow for `env run` with many secrets)
- Hard to sync/export
- Linux support varies (GNOME Keyring vs KWallet vs none)

### Recommendation

**Option A (encrypted JSON)** for MVP. It covers the core use case with
minimal complexity. If users demand per-record encryption or version
history, evolve to Option B later. The `local-cache.ts` already demonstrates
the crypto pattern.

## CLI Commands

```
1claw local init              # Create local vault with passphrase
1claw local add <name>        # Add a secret (prompted, masked input)
1claw local list              # List secret names (never values)
1claw local get <name>        # Retrieve a secret value
1claw local rm <name>         # Remove a secret
1claw local import <file>     # Import .env file into local vault
1claw local export            # Export as .env format (prompted passphrase)
1claw local sync              # Push local secrets to cloud vault
1claw local sync --pull       # Pull cloud secrets into local vault
1claw local status            # Show vault info (count, last sync, etc.)
```

## Sync Model

One-way push is the default (`local sync`). Bidirectional sync is opt-in
(`local sync --pull`).

**Conflict resolution (bidirectional):**
- Cloud wins by default (cloud is the source of truth for teams)
- `--local-wins` flag to prefer local values
- `--interactive` flag to prompt per-conflict

**Sync tracking:**
Each local secret stores `synced_to_cloud`, `cloud_vault_id`, and
`cloud_path`. After a successful push, these are updated. On pull,
secrets are matched by path name.

## MCP Integration

`1claw setup --local` would configure AI clients to use the MCP server
in a local-vault mode:

```json
{
  "mcpServers": {
    "1claw": {
      "command": "npx",
      "args": ["-y", "@1claw/mcp"],
      "env": {
        "ONECLAW_LOCAL_VAULT": "~/.config/1claw/local-vault.enc"
      }
    }
  }
}
```

The MCP server would need a new code path that reads from the local
vault file instead of the cloud API. This requires changes to
`packages/mcp/src/client.ts` to support a `LocalVaultClient`
implementation.

## Security Considerations

1. **Passphrase strength:** Enforce minimum 8 characters, warn on weak
   passphrases via zxcvbn or similar.
2. **Memory handling:** Zero secrets from memory after use (limited by
   JS garbage collection — acknowledged limitation vs Rust's `Secret<T>`).
3. **File permissions:** 0600 on vault file, warn if permissions are wrong.
4. **No telemetry:** Local vault operations never contact the network
   unless explicitly syncing.
5. **Backup safety:** `.enc` file is safe to back up (encrypted), but
   users should be warned about cloud backup services (iCloud, Dropbox)
   that may sync the file.

## Migration Path

```
# Day 1: User stores secrets locally
1claw local init
1claw local import .env

# Day 2: User sets up AI client with local vault
1claw setup --local

# Day 7: User decides to use cloud vault
1claw login
1claw local sync --vault <id>

# Now secrets are in both places. Cloud becomes primary.
1claw setup  # reconfigures MCP for cloud mode
```

## Open Questions

1. Should `local sync` require explicit `--vault` every time, or remember
   the last-synced vault?
2. Should we support encrypting the local vault with the OS keychain instead
   of a passphrase (avoiding passphrase prompts)?
3. Is there demand for a `1claw local run <command>` that works like
   `env run` but from the local vault?
4. Should the local vault format be compatible with Cloak's `vault.cloak`
   so users can migrate between tools?
