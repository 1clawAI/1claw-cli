#!/bin/sh
# Ampersend module startup hook. Runs inside the container before the chat UI.
echo "[ampersend] x402 payment layer enabled (chain=base, asset=USDC)."
echo "[ampersend] Ensure 'integrations/ampersend/api-key' is available via your daemon policy."
