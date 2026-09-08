#!/usr/bin/env bash
# Test CLI functionality: help smoke tests, unauthenticated behavior, config, and optional live API tests.
set -e

CLI="${CLI:-node dist/bin/1claw.js}"
FAILED=0
PASSED=0
TEST_TMP_DIRS=()

cleanup_test_artifacts() {
  # Docker containers/images from unit + integration tests
  for name in test-agent test-template-agent 1claw-test-spawn-smoke; do
    docker rm -f "$name" 2>/dev/null || true
  done
  docker rmi -f 1claw-test-spawn-smoke:ci 2>/dev/null || true
  for t in langchain crewai openai-agents agentkit smolagents llamaindex pydantic-ai agno coder typescript-sdk mastra elizaos; do
    docker rmi -f "test-$t" 2>/dev/null || true
  done
  # Isolated config dirs created during this run
  for dir in "${TEST_TMP_DIRS[@]}"; do
    [[ -n "$dir" && -d "$dir" ]] && rm -rf "$dir"
  done
}

trap cleanup_test_artifacts EXIT
cleanup_test_artifacts

run() {
  if $CLI "$@" > /tmp/cli_out 2> /tmp/cli_err; then
    echo "  OK   $*"
    ((PASSED++)) || true
    return 0
  else
    echo "  FAIL $* (exit $?)"
    ((FAILED++)) || true
    cat /tmp/cli_err 2>/dev/null | head -3
    return 1
  fi
}

run_expect_fail() {
  if $CLI "$@" > /tmp/cli_out 2> /tmp/cli_err; then
    echo "  FAIL (expected failure) $*"
    ((FAILED++)) || true
    return 1
  else
    echo "  OK   (expected fail) $*"
    ((PASSED++)) || true
    return 0
  fi
}

run_contains() {
  local want="$1"; shift
  if $CLI "$@" > /tmp/cli_out 2> /tmp/cli_err; then
    if grep -q "$want" /tmp/cli_out /tmp/cli_err 2>/dev/null; then
      echo "  OK   $* (output contains '$want')"
      ((PASSED++)) || true
      return 0
    fi
  fi
  echo "  FAIL $* (expected output containing '$want')"
  ((FAILED++)) || true
  cat /tmp/cli_out /tmp/cli_err 2>/dev/null | head -5
  return 1
}

# Expect command to fail (non-zero exit) and stderr/stdout to contain this string
run_fail_contains() {
  local want="$1"; shift
  $CLI "$@" > /tmp/cli_out 2> /tmp/cli_err || true
  if grep -q "$want" /tmp/cli_out /tmp/cli_err 2>/dev/null; then
    echo "  OK   (fail + message) $*"
    ((PASSED++)) || true
    return 0
  fi
  echo "  FAIL $* (expected failure with '$want')"
  ((FAILED++)) || true
  cat /tmp/cli_out /tmp/cli_err 2>/dev/null | head -5
  return 1
}

echo "=== 1. Version and help (smoke) ==="
run --version
# ── 1claw pay, end to end against the mock paywall ──────────────────────────
#
# The dev signer never contacts the vault and produces a header no paywall would
# honour, so this exercises the flow — challenge capture, the paid retry, the
# refetch cap — without a funded agent or a chain. The cap in particular has a
# real failure mode (an endless authorize prompt) and cannot be checked against
# a signer that always succeeds.
pay_e2e() {
  local root; root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
  local paywall="$root/examples/x402-pay-cli/paywall.mjs"
  [[ -f "$paywall" ]] || { echo "  SKIP pay e2e (example missing)"; return 0; }

  PORT=4122 node "$paywall" >/tmp/1claw-paywall.log 2>&1 &
  local pid=$!
  sleep 1

  local out
  out=$(ONECLAW_PAY_DEV=1 $CLI pay --agent smoke http://localhost:4122/premium 2>&1 || true)
  if grep -q "the answer is 42" <<<"$out"; then
    PASSED=$((PASSED+1)); echo "  PASS pay: 402 → sign → paid retry"
  else
    FAILED=$((FAILED+1)); echo "  FAIL pay e2e: $out"
  fi

  out=$(ONECLAW_PAY_DEV=1 ONECLAW_PAY_DEV_EXPIRE=5 $CLI pay --agent smoke \
        http://localhost:4122/premium 2>&1 || true)
  if grep -q "closed 2 times" <<<"$out"; then
    PASSED=$((PASSED+1)); echo "  PASS pay: gives up after 2 refetch cycles"
  else
    FAILED=$((FAILED+1)); echo "  FAIL pay refetch cap: $out"
  fi

  kill $pid 2>/dev/null || true
}
pay_e2e

run --help
run login --help
run logout --help
run whoami --help
run vault --help
run vault list --help
run vault create --help
run vault link --help
run secret --help
run secret list --help
run secret get --help
run secret set --help
run secret delete --help
run env --help
run env pull --help
run env push --help
run env run --help
run agent --help
run agent list --help
run agent bankr-key --help
run agent bankr-key lease --help
run agent bankr-key list --help
run agent bankr-key revoke --help
run pay --help
run policy --help
run policy list --help
run share --help
run share list --help
run billing --help
run billing status --help
run audit --help
run audit list --help
run mfa --help
run mfa status --help
run config --help
run config list --help
run init --help
run spawn --help
run publish --help
run eject --help
run containers --help
run containers list --help
run deploy --help
run_contains "ampersend" init --list-modules
run_contains "onchain" init --list-modules
run_contains "langchain" spawn --list
run_contains "crewai" spawn --list
run_contains "openai-agents" spawn --list
run_contains "agentkit" spawn --list
run_contains "smolagents" spawn --list
run_contains "llamaindex" spawn --list
run_contains "pydantic-ai" spawn --list
run_contains "agno" spawn --list
run_contains "coder" spawn --list
run_contains "typescript-sdk" spawn --list
run_contains "mastra" spawn --list
run_contains "elizaos" spawn --list
run_fail_contains "Unknown template" spawn not-a-real-framework

echo ""
echo "=== 2. Unauthenticated (expect clear errors) ==="
# Use isolated config dir so whoami/vault list etc. see no stored token (env alone may not suffice — CLI reads ~/.config/1claw)
SAVE_TOKEN="${ONECLAW_TOKEN:-}"; SAVE_KEY="${ONECLAW_API_KEY:-}"
SAVE_CONFIG_DIR="${ONECLAW_CONFIG_DIR:-}"
TEST_AUTH_DIR="$(mktemp -d 2>/dev/null || echo /tmp/1claw-test-$$)"
TEST_TMP_DIRS+=("$TEST_AUTH_DIR")
export ONECLAW_CONFIG_DIR="$TEST_AUTH_DIR"
unset ONECLAW_TOKEN ONECLAW_API_KEY
run_fail_contains "Not authenticated" whoami
run_fail_contains "Not authenticated" vault list
run_fail_contains "Not authenticated" secret list
run_fail_contains "Not authenticated" agent list
run_fail_contains "Not authenticated" billing status
unset ONECLAW_CONFIG_DIR
[[ -n "$SAVE_TOKEN" ]] && export ONECLAW_TOKEN="$SAVE_TOKEN"
[[ -n "$SAVE_KEY" ]] && export ONECLAW_API_KEY="$SAVE_KEY"
[[ -n "$SAVE_CONFIG_DIR" ]] && export ONECLAW_CONFIG_DIR="$SAVE_CONFIG_DIR"

echo ""
echo "=== 3. Config (no auth required) ==="
run config list
run config get api-url
run config get output-format

echo ""
echo "=== 4. Logout (idempotent) ==="
run logout
run logout

echo ""
echo "=== 5. JSON output flag ==="
run --json config list
# vault list with --json fails without auth; use isolated config so no stored token
SAVE_T="${ONECLAW_TOKEN:-}"; SAVE_K="${ONECLAW_API_KEY:-}"; SAVE_CD="${ONECLAW_CONFIG_DIR:-}"
TEST_JSON_DIR="$(mktemp -d 2>/dev/null || echo /tmp/1claw-json-$$)"
TEST_TMP_DIRS+=("$TEST_JSON_DIR")
export ONECLAW_CONFIG_DIR="$TEST_JSON_DIR"
unset ONECLAW_TOKEN ONECLAW_API_KEY
run_expect_fail --json vault list
unset ONECLAW_CONFIG_DIR
[[ -n "$SAVE_T" ]] && export ONECLAW_TOKEN="$SAVE_T"
[[ -n "$SAVE_K" ]] && export ONECLAW_API_KEY="$SAVE_K"
[[ -n "$SAVE_CD" ]] && export ONECLAW_CONFIG_DIR="$SAVE_CD" || unset ONECLAW_CONFIG_DIR

echo ""
if [[ -n "$ONECLAW_TOKEN" || -n "$ONECLAW_API_KEY" ]]; then
  echo "=== 6. Live API (token set) ==="
  export ONECLAW_VAULT_ID="${ONECLAW_VAULT_ID:-}"
  run vault list
  if [[ -n "$ONECLAW_VAULT_ID" ]]; then
    run secret list
    run secret set cli-test/hello "world"
    run secret get cli-test/hello --quiet
    run secret describe cli-test/hello
    run secret delete cli-test/hello -y
  else
    echo "  SKIP secret/vault-scoped tests (set ONECLAW_VAULT_ID for full integration)"
  fi
  run agent list
  run billing status
  run audit list --limit 2
else
  echo "=== 6. Live API ==="
  echo "  SKIP (set ONECLAW_TOKEN or ONECLAW_API_KEY and optionally ONECLAW_VAULT_ID for integration tests)"
fi

echo ""
echo "=== 7. Docker feature unit tests ==="
if node --test scripts/test-docker.mjs > /tmp/cli_unit 2>&1; then
  echo "  OK   node --test scripts/test-docker.mjs"
  ((PASSED++)) || true
else
  echo "  FAIL node --test scripts/test-docker.mjs"
  ((FAILED++)) || true
  tail -20 /tmp/cli_unit
fi

echo ""
echo "=== 8. Spawn template unit tests ==="
if node --test scripts/test-spawn-templates.mjs > /tmp/cli_spawn 2>&1; then
  echo "  OK   node --test scripts/test-spawn-templates.mjs"
  ((PASSED++)) || true
else
  echo "  FAIL node --test scripts/test-spawn-templates.mjs"
  ((FAILED++)) || true
  tail -30 /tmp/cli_spawn
fi

echo ""
echo "=== 9. Spawn Docker integration (optional) ==="
if [[ "${ONECLAW_TEST_DOCKER:-}" == "1" ]]; then
  if docker info >/dev/null 2>&1; then
    if ONECLAW_TEST_DOCKER=1 node --test scripts/test-spawn-docker.mjs > /tmp/cli_spawn_docker 2>&1; then
      echo "  OK   ONECLAW_TEST_DOCKER=1 node --test scripts/test-spawn-docker.mjs"
      ((PASSED++)) || true
    else
      echo "  FAIL ONECLAW_TEST_DOCKER=1 node --test scripts/test-spawn-docker.mjs"
      ((FAILED++)) || true
      tail -30 /tmp/cli_spawn_docker
    fi
  else
    echo "  SKIP ONECLAW_TEST_DOCKER=1 but Docker daemon is not running"
  fi
else
  echo "  SKIP (set ONECLAW_TEST_DOCKER=1 to build/run langchain container smoke test)"
fi

echo ""
echo "=== 10. Local vault key derivation ==="
# v1 files used PBKDF2 at 100k iterations, which a GPU eats. v2 is scrypt.
# Both halves matter: a v1 file must still open, and nothing may be written as
# v1 again — so a file in daily use upgrades itself without anyone being asked.
if node scripts/test-local-vault-kdf.mjs; then
  PASSED=$((PASSED + 1))
else
  FAILED=$((FAILED + 1))
fi

echo ""
echo "=== 11. pay: session token goes to the API origin only ==="
# A payment clears the paywall; it is not a login. The paid retry must still
# authenticate, or an org paying its own overage gets a 401 after paying.
# The token must never reach a third-party paywall.
if node -e '
import("./dist/src/commands/pay/challenge.js").then((m) => {
  const API = "https://api.1claw.co";
  const cases = [
    ["https://api.1claw.co/v1/vaults", true, "own API: needed, or the paid retry 401s"],
    ["https://api.1claw.co:443/v1/vaults", true, "default port is the same origin"],
    ["http://api.1claw.co/v1/vaults", false, "scheme differs: not the same origin"],
    ["https://api.1claw.co.evil.test/x", false, "prefix confusion: must not leak"],
    ["https://evil.test/?u=https://api.1claw.co", false, "url in query: must not leak"],
    ["https://paywall.example/article", false, "stranger paywall: must not leak"],
    ["not a url", false, "unparseable: must not leak"],
  ];
  let bad = 0;
  for (const [url, want, why] of cases) {
    const got = m.mayForwardToken(url, API);
    if (got !== want) { console.error("  " + url + " -> " + got + ", want " + want + " (" + why + ")"); bad++; }
  }
  process.exit(bad ? 1 : 0);
}).catch((e) => { console.error(e.message); process.exit(1); });
' 2>/tmp/cli_err; then
  echo "  OK   mayForwardToken origin rule"
  ((PASSED++)) || true
else
  echo "  FAIL mayForwardToken origin rule"
  head -8 /tmp/cli_err
  ((FAILED++)) || true
fi

echo ""
echo "=== Summary: $PASSED passed, $FAILED failed ==="
[[ $FAILED -eq 0 ]]
