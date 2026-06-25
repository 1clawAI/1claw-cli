#!/bin/sh
curl -sf "http://localhost:${CHAT_UI_PORT:-3000}/health" >/dev/null || exit 1
