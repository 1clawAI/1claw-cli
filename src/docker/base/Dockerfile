# Base image pinned by digest, and the container runs as the node user.
#
# This said "Pin the major/minor tag; rebuild to pick up Alpine security
# updates. Digest pinning is maintained via Renovate/scheduled rebuilds of
# 1claw/agent." The Renovate half is now real -- renovate.json in the 1claw
# repo opens a PR per base-image digest -- so the digest is here rather than
# deferred. The rebuild half still applies: between Renovate PRs the base layer
# is frozen, and the `apk add` below still fetches current Alpine packages on
# top of it.
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS base

# Bumped by the CLI when bundled assets (chat UI, entrypoint) change, so an
# existing `1claw/agent:stable` is rebuilt instead of silently reused.
ARG ONECLAW_BASE_VERSION=dev
LABEL org.1claw.base-version=$ONECLAW_BASE_VERSION

RUN apk add --no-cache curl tini

WORKDIR /app

# Install the 1Claw MCP server (local daemon mode). Best-effort: the chat UI
# talks to the daemon over the mounted socket directly, so the container is
# still healthy if the registry is unreachable at build time.
RUN npm install -g @1claw/mcp@0.53.3 || echo "WARN: @1claw/mcp install deferred to runtime"

# Baked-in chat UI (single Node http server + static HTML, zero deps).
COPY chat-ui /app/chat-ui

# Startup + health scripts
COPY entrypoint.sh /app/entrypoint.sh
COPY healthcheck.sh /app/healthcheck.sh
RUN chmod +x /app/entrypoint.sh /app/healthcheck.sh

# Module extension point: modules drop assets under /app/modules
RUN mkdir -p /app/modules /run/1claw

# NOTE: mode (local vs cloud) and LLM wiring are passed at `docker run` time via
# -e flags by `1claw init`; nothing about the vault is baked into the image.
ENV NODE_ENV=production
ENV ONECLAW_DAEMON_SOCKET=/run/1claw/daemon.sock
ENV CHAT_UI_PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
    CMD /app/healthcheck.sh

# Drop privileges. This image runs a customer's agent and is reachable over
# the network; as root, any flaw in the agent starts with the ability to
# rewrite the image it is running from. The node images ship a `node` user for
# exactly this. Placed after the COPY/apk steps so the files stay root-owned
# and read-only to the agent.
USER node

ENTRYPOINT ["tini", "--"]
CMD ["/app/entrypoint.sh"]
