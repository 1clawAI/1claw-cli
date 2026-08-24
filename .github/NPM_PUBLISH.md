# npm publish (CI)

Publish uses **npm Trusted Publishing** (GitHub OIDC), not long-lived tokens.

## One-time npmjs.com setup (per package)

For `@1claw/cli` → Package settings → **Trusted Publisher** → GitHub Actions:

| Field | Value |
|--------|--------|
| Organization / User | `1clawAI` |
| Repository | `1claw-cli` |
| Workflow filename | `publish.yml` |
| Environment | `npm` |

Do **not** store `NPM_TOKEN` in this repo unless rotating a granular **Automation** token with publish access to `@1claw/*`. A stale `NPM_TOKEN` is mapped by `setup-node` to `NODE_AUTH_TOKEN` and causes misleading **E404** errors on publish.

## Re-run after a tag

```bash
gh workflow run "Publish to npm" --repo 1clawAI/1claw-cli --ref main
```
