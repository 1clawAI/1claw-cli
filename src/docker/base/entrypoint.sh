#!/bin/sh
# 1Claw agent container entrypoint.
#
# Credentials are brokered one of two ways:
#   daemon-brokered → a host daemon Unix socket is mounted at
#                     $ONECLAW_DAEMON_SOCKET. The daemon injects the agent key
#                     (and any provider keys) into outbound requests. The keys
#                     NEVER enter the container. Used by `1claw init --docker`
#                     for both cloud and local modes.
#   direct          → no daemon socket; the agent API key is provided directly
#                     via $ONECLAW_AGENT_API_KEY (e.g. a Secret Manager mount on
#                     Cloud Run via `1claw deploy`).
set -e

CHAT_UI_PORT="${CHAT_UI_PORT:-3000}"
DAEMON_SOCKET="${ONECLAW_DAEMON_SOCKET:-/run/1claw/daemon.sock}"

echo "─────────────────────────────────────────────"
echo " 1Claw agent container starting"
echo "   Agent ID:  ${ONECLAW_AGENT_ID:-not set}"
echo "   Modules:   ${ONECLAW_CONTAINER_MODULES:-none}"

if [ -S "$DAEMON_SOCKET" ]; then
    # Daemon socket present → host daemon brokers all credentials. This is the
    # default for `1claw init --docker` (cloud and local). The agent/provider
    # keys stay on the host and never enter the container.
    echo "   Mode:      ${ONECLAW_MODE:-cloud} (daemon socket)"
    echo "   Socket:    $DAEMON_SOCKET"
    echo "─────────────────────────────────────────────"
    # Start the MCP server in local daemon mode (best-effort).
    if command -v 1claw-mcp >/dev/null 2>&1; then
        ONECLAW_LOCAL_VAULT=true ONECLAW_DAEMON_SOCKET="$DAEMON_SOCKET" 1claw-mcp --local 2>/tmp/mcp.log &
    else
        echo "NOTE: @1claw/mcp not installed in image; chat UI uses the daemon directly."
    fi
elif [ "$ONECLAW_LOCAL_VAULT" = "true" ]; then
    # Local mode explicitly requested but no socket is mounted → misconfiguration.
    echo ""
    echo "ERROR: Daemon socket not found at $DAEMON_SOCKET"
    echo ""
    echo "The 1Claw daemon must be running on the host with the socket mounted:"
    echo "  1claw daemon start"
    echo "  docker run -v ~/.config/1claw/daemon.sock:/run/1claw/daemon.sock:ro ..."
    exit 1
else
    # No daemon socket → standalone deploy. The agent API key must be supplied
    # directly (e.g. Secret Manager mount).
    echo "   Mode:      cloud (direct agent API key)"
    if [ -z "$ONECLAW_AGENT_API_KEY" ]; then
        echo ""
        echo "ERROR: No daemon socket mounted and ONECLAW_AGENT_API_KEY is not set."
        echo ""
        echo "Either run via '1claw init --docker' (mounts the host daemon socket),"
        echo "or provide the key directly: -e ONECLAW_AGENT_API_KEY=... (or a Secret"
        echo "Manager mount)."
        exit 1
    fi
    echo "─────────────────────────────────────────────"
    if command -v 1claw-mcp >/dev/null 2>&1; then
        1claw-mcp 2>/tmp/mcp.log &
    fi
fi

# Run module startup hooks (each module may drop an executable startup.sh).
for hook in /app/modules/*/startup.sh; do
    if [ -x "$hook" ]; then
        echo "Running module hook: $hook"
        "$hook" || echo "WARN: module hook $hook exited non-zero"
    fi
done

# Start the chat UI (the container's health anchor) in the foreground.
echo "Ready: http://0.0.0.0:${CHAT_UI_PORT}"
exec node /app/chat-ui/server.js
