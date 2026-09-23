#!/usr/bin/env bash
# ============================================================================
# Customer AI — container entrypoint (Render)
#
# 1. prepare HERMES_HOME (/app/data/hermes, Render Persistent Disk) and
#    WHATSAPP_AUTH_DIR (/app/data/whatsapp-auth)
# 2. derive CAI_HOOK_BASE_URL from $PORT when not set explicitly (Render's
#    PORT is dynamic — the old hardcoded 127.0.0.1:8080 breaks on Render)
# 3. seed Hermes config/plugin/hook templates on FIRST boot only
# 4. exec the Node process supervisor (PID 1) which starts Customer AI,
#    waits for /api/health, then starts the Hermes gateway (and its bridge).
# ============================================================================
set -euo pipefail

export HOME="${HOME:-/home/customerai}"
export HERMES_HOME="${HERMES_HOME:-/app/data/hermes}"
export HERMES_BIN="${HERMES_BIN:-/home/customerai/.local/bin/hermes}"
export HERMES_GATEWAY_STATE="${HERMES_GATEWAY_STATE:-$HERMES_HOME/gateway_state.json}"
export WHATSAPP_AUTH_DIR="${WHATSAPP_AUTH_DIR:-/app/data/whatsapp-auth}"
export PATH="/home/customerai/.local/bin:/opt/hermes-agent/venv/bin:$PATH"

# Render always injects PORT; fall back to 8080 for local Docker runs. The
# Customer AI backend must answer on $PORT, so the Hermes plugin/hook must
# call back on the same port.
export PORT="${PORT:-8080}"
export HOST="${HOST:-0.0.0.0}"
if [ -z "${CAI_HOOK_BASE_URL:-}" ]; then
  export CAI_HOOK_BASE_URL="http://127.0.0.1:${PORT}"
  echo "[customer-ai] entrypoint: CAI_HOOK_BASE_URL not set — deriving ${CAI_HOOK_BASE_URL}"
fi

SEED="/opt/customer-ai/hermes-config"

echo "[customer-ai] entrypoint: HERMES_HOME=${HERMES_HOME} WHATSAPP_AUTH_DIR=${WHATSAPP_AUTH_DIR} HOST=${HOST} PORT=${PORT}"

# --- Persistent-storage preparation (fail-fast, never retry silently) --------
# These live on the Render Persistent Disk mounted at /app/data. If the mount
# is missing or not writable by this container user the WhatsApp pairing and
# Hermes databases cannot persist — crash loudly instead of silently re-pairing
# on every restart.
if [ "$(id -u)" -eq 0 ]; then
  mkdir -p /app/data /app/data/hermes /app/data/whatsapp-auth
  chown -R customerai:customerai /app/data
else
  for d in /app/data "$HERMES_HOME" "$WHATSAPP_AUTH_DIR"; do
    mkdir -p "$d" 2>/dev/null \
      || { echo "[customer-ai] FATAL: cannot create persistent dir ${d} (read-only? Render Persistent Disk not mounted at /app/data, or it is not writable by uid $(id -u)). Fix the Render disk mount/ownership and redeploy." >&2; exit 1; }
  done
fi

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
# WHATSAPP_AUTH_DIR kept as a dedicated auth directory under /app/data.
mkdir -p "$WHATSAPP_AUTH_DIR"

echo "[customer-ai] entrypoint: starting supervisor"

# exec -> the supervisor becomes PID 1 and receives container signals.
exec node /app/supervisor.mjs