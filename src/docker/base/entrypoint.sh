#!/bin/sh
# 1Claw agent container entrypoint.
# Supports two modes:
#   local  (ONECLAW_LOCAL_VAULT=true)  → credentials injected by the host daemon
#                                         over the mounted Unix socket. The key
#                                         NEVER enters the container.
#   cloud  (ONECLAW_LOCAL_VAULT=false) → the agent API key is provided directly
#                                         (e.g. via a Secret Manager mount).
set -e

CHAT_UI_PORT="${CHAT_UI_PORT:-3000}"

echo "─────────────────────────────────────────────"
echo " 1Claw agent container starting"
echo "   Agent ID:  ${ONECLAW_AGENT_ID:-not set}"
echo "   Modules:   ${ONECLAW_CONTAINER_MODULES:-none}"

if [ "$ONECLAW_LOCAL_VAULT" = "true" ]; then
    echo "   Mode:      local (daemon socket)"
    echo "   Socket:    $ONECLAW_DAEMON_SOCKET"
    if [ ! -S "$ONECLAW_DAEMON_SOCKET" ]; then
        echo ""
        echo "ERROR: Daemon socket not found at $ONECLAW_DAEMON_SOCKET"
        echo ""
        echo "The 1Claw daemon must be running on the host with the socket mounted:"
        echo "  1claw daemon start"
        echo "  docker run -v ~/.config/1claw/daemon.sock:/run/1claw/daemon.sock:ro ..."
        exit 1
    fi
    echo "─────────────────────────────────────────────"
    # Start the MCP server in local daemon mode (best-effort).
    if command -v 1claw-mcp >/dev/null 2>&1; then
        ONECLAW_LOCAL_VAULT=true 1claw-mcp --local 2>/tmp/mcp.log &
    else
        echo "NOTE: @1claw/mcp not installed in image; chat UI uses the daemon directly."
    fi
else
    echo "   Mode:      cloud (agent API key)"
    if [ -z "$ONECLAW_AGENT_API_KEY" ]; then
        echo ""
        echo "ERROR: ONECLAW_AGENT_API_KEY is not set (cloud mode)."
        echo "Provide it via a Secret Manager mount or -e ONECLAW_AGENT_API_KEY=..."
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
