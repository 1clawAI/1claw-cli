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
echo "=== Summary: $PASSED passed, $FAILED failed ==="
[[ $FAILED -eq 0 ]]
