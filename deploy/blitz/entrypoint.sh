#!/usr/bin/env bash
# ============================================================================
# Customer AI — container entrypoint (Blitz Cloud)
#
# 1. prepare HERMES_HOME (/home/customerai/.hermes, persistent storage)
# 2. seed Hermes config/plugin/hook templates on FIRST boot only
# 3. exec the Node process supervisor (PID 1) which starts Customer AI,
#    waits for /api/health, then starts the Hermes gateway (and its bridge).
# ============================================================================
set -euo pipefail

export HOME="${HOME:-/home/customerai}"
export HERMES_HOME="${HERMES_HOME:-/home/customerai/.hermes}"
export HERMES_BIN="${HERMES_BIN:-/home/customerai/.local/bin/hermes}"
export HERMES_GATEWAY_STATE="${HERMES_GATEWAY_STATE:-$HERMES_HOME/gateway_state.json}"
export PATH="/home/customerai/.local/bin:/opt/hermes-agent/venv/bin:$PATH"

SEED="/opt/customer-ai/hermes-config"

echo "[customer-ai] entrypoint: HERMES_HOME=${HERMES_HOME} HOST=${HOST:-0.0.0.0} PORT=${PORT:-8080}"

mkdir -p "$HERMES_HOME"

# --- First-boot seeding (idempotent; a restored volume is left untouched) --
if [ ! -f "$HERMES_HOME/config.yaml" ]; then
  echo "[customer-ai] first boot: seeding Hermes config into ${HERMES_HOME}"
  cp "$SEED/configuration/config.yaml" "$HERMES_HOME/config.yaml"
fi
if [ ! -d "$HERMES_HOME/plugins/customer-ai-gate" ]; then
  echo "[customer-ai] first boot: seeding customer-ai-gate plugin"
  mkdir -p "$HERMES_HOME/plugins"
  cp -R "$SEED/plugins/customer-ai-gate" "$HERMES_HOME/plugins/"
fi
if [ ! -d "$HERMES_HOME/hooks/customer_ai_tap" ]; then
  echo "[customer-ai] first boot: seeding customer_ai_tap hook"
  mkdir -p "$HERMES_HOME/hooks"
  cp -R "$SEED/hooks/customer_ai_tap" "$HERMES_HOME/hooks/"
fi

# Hermes runtime writable dirs (created here so the persistent volume is
# fully usable before the gateway starts).
mkdir -p "$HERMES_HOME/state" "$HERMES_HOME/logs" "$HERMES_HOME/pending_messages" \
         "$HERMES_HOME/whatsapp" "$HERMES_HOME/pairing"

echo "[customer-ai] entrypoint: starting supervisor"

# exec -> the supervisor becomes PID 1 and receives container signals.
exec node /app/supervisor.mjs