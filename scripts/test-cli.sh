#!/usr/bin/env bash
# Test CLI functionality: help smoke tests, unauthenticated behavior, config, and optional live API tests.
set -e

CLI="${CLI:-node dist/bin/1claw.js}"
FAILED=0
PASSED=0

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

echo ""
echo "=== 2. Unauthenticated (expect clear errors) ==="
run_fail_contains "Not authenticated" whoami
run_fail_contains "Not authenticated" vault list
run_fail_contains "Not authenticated" secret list
run_fail_contains "Not authenticated" agent list
run_fail_contains "Not authenticated" billing status

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
run_expect_fail --json vault list

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
echo "=== Summary: $PASSED passed, $FAILED failed ==="
[[ $FAILED -eq 0 ]]
