FROM node:20-alpine AS base

RUN apk add --no-cache curl tini

WORKDIR /app

# Install the 1Claw MCP server (local daemon mode). Best-effort: the chat UI
# talks to the daemon over the mounted socket directly, so the container is
# still healthy if the registry is unreachable at build time.
RUN npm install -g @1claw/mcp@latest || echo "WARN: @1claw/mcp install deferred to runtime"

# Baked-in chat UI (single Node http server + static HTML, zero deps).
COPY chat-ui /app/chat-ui

# Startup + health scripts
COPY entrypoint.sh /app/entrypoint.sh
COPY healthcheck.sh /app/healthcheck.sh
RUN chmod +x /app/entrypoint.sh /app/healthcheck.sh

# Module extension point: modules drop assets under /app/modules
RUN mkdir -p /app/modules /run/1claw

ENV NODE_ENV=production
ENV ONECLAW_LOCAL_VAULT=true
ENV ONECLAW_DAEMON_SOCKET=/run/1claw/daemon.sock
ENV CHAT_UI_PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
    CMD /app/healthcheck.sh

ENTRYPOINT ["tini", "--"]
CMD ["/app/entrypoint.sh"]
