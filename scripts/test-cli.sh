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

# ── 1claw agent binding proxy, against a mock vault ─────────────────────────
#
# The proxy exists so a vendor CLI can run with no key on the machine. The
# properties that matter: the tool's own credential is dropped, not relayed;
# a vault refusal comes back as 403; a vault that is unreachable comes back as
# 502 (the tool stops); and an upstream response passes through with its
# status and body.
binding_proxy_e2e() {
  local mock="$(dirname "${BASH_SOURCE[0]}")/mock-execute-vault.mjs"
  PORT=4123 node "$mock" >/tmp/1claw-mockvault.log 2>&1 &
  local mock_pid=$!
  sleep 1
  ONECLAW_API_URL=http://127.0.0.1:4123 $CLI agent binding proxy bankr \
    --agent-key "00000000-0000-0000-0000-000000000001:ocv_test_key" --port 4124 --token 1cp_testtoken >/tmp/1claw-bproxy.log 2>&1 &
  local proxy_pid=$!
  sleep 1

  # BINDPROXY-M1: the port is only reachable with the per-run proxy token.
  local code
  code=$(curl -s -o /tmp/bproxy_noauth.json -w "%{http_code}" -X POST http://127.0.0.1:4124/agent/prompt \
        -H "X-API-Key: THIS_MUST_NOT_LEAK" -H "Content-Type: application/json" -d '{"prompt":"hi"}')
  if [[ "$code" == "401" ]] && grep -q proxy_unauthorized /tmp/bproxy_noauth.json; then
    PASSED=$((PASSED+1)); echo "  PASS binding proxy: no proxy token → 401, nothing forwarded"
  else
    FAILED=$((FAILED+1)); echo "  FAIL binding proxy no-token: HTTP $code $(cat /tmp/bproxy_noauth.json)"
  fi

  local out
  # The tool puts the proxy token where its real key would go; the vault's
  # binding credential replaces it upstream and the tool's headers are dropped.
  out=$(curl -s -X POST http://127.0.0.1:4124/agent/prompt \
        -H "X-API-Key: 1cp_testtoken" \
        -H "Content-Type: application/json" -d '{"prompt":"hi"}')
  if grep -q '"leaked_credential":false' <<<"$out" && grep -q '"path":"/agent/prompt"' <<<"$out" && grep -q '"binding":"bankr"' <<<"$out"; then
    PASSED=$((PASSED+1)); echo "  PASS binding proxy: request relayed through the binding, tool credential dropped"
  else
    FAILED=$((FAILED+1)); echo "  FAIL binding proxy relay: $out"
  fi

  local code
  code=$(curl -s -o /tmp/bproxy_denied.json -w "%{http_code}" -H "Authorization: Bearer 1cp_testtoken" http://127.0.0.1:4124/agent/denied)
  if [[ "$code" == "403" ]] && grep -q refused_by_1claw /tmp/bproxy_denied.json; then
    PASSED=$((PASSED+1)); echo "  PASS binding proxy: vault refusal → 403"
  else
    FAILED=$((FAILED+1)); echo "  FAIL binding proxy refusal: HTTP $code $(cat /tmp/bproxy_denied.json)"
  fi

  kill $mock_pid 2>/dev/null || true; sleep 0.5
  code=$(curl -s -o /tmp/bproxy_down.json -w "%{http_code}" -H "Authorization: Bearer 1cp_testtoken" http://127.0.0.1:4124/agent/prompt)
  if [[ "$code" == "502" ]] && grep -q vault_unreachable /tmp/bproxy_down.json; then
    PASSED=$((PASSED+1)); echo "  PASS binding proxy: vault unreachable → 502 (the tool stops)"
  else
    FAILED=$((FAILED+1)); echo "  FAIL binding proxy vault-down: HTTP $code $(cat /tmp/bproxy_down.json)"
  fi
  kill $proxy_pid 2>/dev/null || true
}
binding_proxy_e2e

# ── 1claw daemon proxy, against a real daemon and a mock upstream ───────────
#
# Local flavour of the binding proxy: the running daemon does the host
# allowlist and the injection from the local vault. Asserts the upstream saw
# the vault's key and not the tool's, and that a host outside the policy is
# refused.
daemon_proxy_e2e() {
  local here; here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local cfg; cfg="$(mktemp -d)"
  export ONECLAW_CONFIG_DIR="$cfg" ONECLAW_VAULT_PASSPHRASE="test-passphrase-123" ONECLAW_DAEMON_SOCKET="$cfg/daemon.sock"
  node "$here/seed-local-vault.mjs" >/dev/null || { echo "  FAIL daemon proxy: could not seed local vault"; FAILED=$((FAILED+1)); return; }
  PORT=4125 node "$here/mock-upstream.mjs" >/tmp/1claw-upstream.log 2>&1 &
  local up_pid=$!
  $CLI daemon start --foreground >/tmp/1claw-daemon.log 2>&1 &
  local d_pid=$!
  for i in $(seq 1 20); do [[ -S "$ONECLAW_DAEMON_SOCKET" ]] && break; sleep 0.25; done
  ONECLAW_PROXY_TOKEN=1cp_daemontest $CLI daemon proxy bankr-api-key --base-url http://127.0.0.1:4125 --port 4126 >/tmp/1claw-dproxy.log 2>&1 &
  local p_pid=$!
  sleep 1

  local out
  out=$(curl -s -X POST http://127.0.0.1:4126/agent/prompt -H "X-API-Key: 1cp_daemontest" -H "Content-Type: application/json" -d '{"prompt":"hi"}')
  if grep -q '"x_api_key":"bk_usr_FROM_THE_VAULT"' <<<"$out" && grep -q '"path":"/agent/prompt"' <<<"$out"; then
    PASSED=$((PASSED+1)); echo "  PASS daemon proxy: upstream got the vault's key, not the tool's"
  else
    FAILED=$((FAILED+1)); echo "  FAIL daemon proxy relay: $out"; tail -3 /tmp/1claw-dproxy.log /tmp/1claw-daemon.log
  fi

  ONECLAW_PROXY_TOKEN=1cp_daemontest $CLI daemon proxy bankr-api-key --base-url http://localhost:4125 --port 4127 >/tmp/1claw-dproxy2.log 2>&1 &
  local p2_pid=$!
  sleep 1
  local code
  code=$(curl -s -o /tmp/dproxy_denied.json -w "%{http_code}" -H "X-API-Key: 1cp_daemontest" http://127.0.0.1:4127/agent/prompt)
  if [[ "$code" == "403" ]] && grep -q refused_by_1claw /tmp/dproxy_denied.json; then
    PASSED=$((PASSED+1)); echo "  PASS daemon proxy: host outside the policy → 403"
  else
    FAILED=$((FAILED+1)); echo "  FAIL daemon proxy policy: HTTP $code $(cat /tmp/dproxy_denied.json)"
  fi

  kill $p_pid $p2_pid $d_pid $up_pid 2>/dev/null || true
  unset ONECLAW_CONFIG_DIR ONECLAW_VAULT_PASSPHRASE ONECLAW_DAEMON_SOCKET
  rm -rf "$cfg"
}
daemon_proxy_e2e

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
echo "=== 9. AI client detection/config unit tests ==="
if node --test scripts/test-ai-clients.mjs > /tmp/cli_ai_clients 2>&1; then
  echo "  OK   node --test scripts/test-ai-clients.mjs"
  ((PASSED++)) || true
else
  echo "  FAIL node --test scripts/test-ai-clients.mjs"
  ((FAILED++)) || true
  tail -30 /tmp/cli_ai_clients
fi

echo ""
echo "=== 10. Spawn Docker integration (optional) ==="
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
echo "=== 11. Local vault key derivation ==="
# v1 files used PBKDF2 at 100k iterations, which a GPU eats. v2 is scrypt.
# Both halves matter: a v1 file must still open, and nothing may be written as
# v1 again — so a file in daily use upgrades itself without anyone being asked.
if node scripts/test-local-vault-kdf.mjs; then
  PASSED=$((PASSED + 1))
else
  FAILED=$((FAILED + 1))
fi

echo ""
echo "=== 12. pay: session token goes to the API origin only ==="
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
# ── session token file mode, and a group-shared daemon socket ───────────────
#
# The config file holds the cloud session token. conf writes it atomically, so
# a chmod after login used to be undone by the next unrelated write; the mode
# is conf's own now. And --socket-group lets an agent run as its own user with
# access to the daemon but not to that file.
session_file_mode() {
  local cfg; cfg="$(mktemp -d)"
  local mode
  mode=$(ONECLAW_CONFIG_DIR="$cfg" node --input-type=module -e '
    import { setAuth, setDefaultVaultId } from "./dist/src/config.js";
    import { statSync } from "node:fs";
    setAuth({ token: "t", email: "e", userId: "u", orgId: "o" });
    setDefaultVaultId("v");
    console.log((statSync(process.env.ONECLAW_CONFIG_DIR + "/config.json").mode & 0o777).toString(8));')
  if [[ "$mode" == "600" ]]; then
    PASSED=$((PASSED+1)); echo "  PASS config: session file stays 0600 across writes"
  else
    FAILED=$((FAILED+1)); echo "  FAIL config: session file mode after a second write is $mode"
  fi
  rm -rf "$cfg"
}
session_file_mode

daemon_socket_group() {
  local cfg; cfg="$(mktemp -d)"
  export ONECLAW_CONFIG_DIR="$cfg" ONECLAW_VAULT_PASSPHRASE="test-passphrase-123" ONECLAW_DAEMON_SOCKET="$cfg/daemon.sock"
  node "$(dirname "${BASH_SOURCE[0]}")/seed-local-vault.mjs" >/dev/null
  $CLI daemon start --foreground --socket-group "$(id -g)" >/tmp/1claw-daemon-grp.log 2>&1 &
  local d_pid=$!
  for i in $(seq 1 20); do [[ -S "$ONECLAW_DAEMON_SOCKET" ]] && break; sleep 0.25; done
  local mode
  mode=$(stat -f '%Lp' "$ONECLAW_DAEMON_SOCKET" 2>/dev/null || stat -c '%a' "$ONECLAW_DAEMON_SOCKET")
  if [[ "$mode" == "660" ]]; then
    PASSED=$((PASSED+1)); echo "  PASS daemon: --socket-group sets the socket to 0660"
  else
    FAILED=$((FAILED+1)); echo "  FAIL daemon --socket-group: socket mode $mode"; tail -3 /tmp/1claw-daemon-grp.log
  fi
  kill $d_pid 2>/dev/null || true
  unset ONECLAW_CONFIG_DIR ONECLAW_VAULT_PASSPHRASE ONECLAW_DAEMON_SOCKET
  rm -rf "$cfg"
}
daemon_socket_group

echo "=== Summary: $PASSED passed, $FAILED failed ==="
[[ $FAILED -eq 0 ]]
