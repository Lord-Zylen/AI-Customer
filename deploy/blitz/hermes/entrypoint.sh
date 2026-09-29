#!/usr/bin/env bash
# ============================================================================
# HERMES-ONLY container entrypoint (Blitz Cloud test deployment)
#
# Runs the Hermes gateway + the Hermes dashboard. It does NOT start the
# Customer AI Node backend (no node server.js), needs no MongoDB, no Redis and
# no frontend build.
#
#   1. prepare the persistent tree (/app/data/hermes — Hermes home) and fail
#      fast when it is missing or unwritable
#   2. seed the Hermes config template into $HERMES_HOME on FIRST boot only
#   3. exec the Node process supervisor (PID 1), which owns the gateway and the
#      dashboard
#
# Secrets are only ever read from the environment. This script never prints an
# API key, password or token — only variable NAMES and non-secret values.
# ============================================================================
set -euo pipefail

export HOME="${HOME:-/home/hermesai}"
export HERMES_HOME="${HERMES_HOME:-/app/data/hermes}"
export HERMES_BIN="${HERMES_BIN:-/home/hermesai/.local/bin/hermes}"
export HERMES_WEB_DIST="${HERMES_WEB_DIST:-/opt/hermes-agent/hermes_cli/web_dist}"
export PATH="/home/hermesai/.local/bin:/opt/hermes-agent/venv/bin:$PATH"

# The dashboard is the ONLY public surface. It binds 0.0.0.0 (never 127.0.0.1)
# so the platform's router can reach it. Hermes reads the port from
# --port; HERMES_DASHBOARD_PORT is the operator-facing knob and matches the
# name used by the upstream Hermes s6 dashboard service.
export HERMES_DASHBOARD_HOST="${HERMES_DASHBOARD_HOST:-0.0.0.0}"
export HERMES_DASHBOARD_PORT="${HERMES_DASHBOARD_PORT:-9119}"
export HERMES_DASHBOARD_ENABLED="${HERMES_DASHBOARD_ENABLED:-true}"

# WhatsApp is intentionally left ENABLED even on a first, unpaired boot. The
# gateway then exits with code 78 ("WhatsApp enabled but not paired") and the
# supervisor parks it and retries; the dashboard stays up and owns the pairing
# flow. Disabling WhatsApp here would only fake a healthy container.
export WHATSAPP_ENABLED="${WHATSAPP_ENABLED:-true}"

RUNTIME_DIR="${HERMES_RUNTIME_DIR:-/opt/hermes-runtime}"
SEED_CONFIG="$RUNTIME_DIR/config.yaml"

# The platform's persistent volume is mounted here. HERMES_HOME lives under it,
# so a single volume keeps the config, the databases and the WhatsApp session
# together. Overridable only so this script can be exercised outside a
# container; the image always uses /app/data.
DATA_DIR="${HERMES_DATA_DIR:-/app/data}"

echo "[hermes] entrypoint: HERMES_HOME=${HERMES_HOME}"
echo "[hermes] entrypoint: dashboard host=${HERMES_DASHBOARD_HOST} port=${HERMES_DASHBOARD_PORT}"
echo "[hermes] entrypoint: WHATSAPP_ENABLED=${WHATSAPP_ENABLED}"

# --- Binary preflight (fail fast, never half-start) --------------------------
# A missing hermes launcher or gateway interpreter would otherwise surface as a
# confusing spawn error a minute later.
if [ ! -x "$HERMES_BIN" ]; then
  echo "[hermes] FATAL: hermes launcher not executable at ${HERMES_BIN}." >&2
  exit 1
fi
if [ ! -x /opt/hermes-agent/venv/bin/python ] && [ ! -x "${HERMES_GATEWAY_PY:-/opt/hermes-agent/venv/bin/python}" ]; then
  echo "[hermes] FATAL: Hermes venv python not found at /opt/hermes-agent/venv/bin/python." >&2
  exit 1
fi

# --- Dashboard auth preflight (fail fast, never start a wide-open dashboard) --
# A non-loopback bind ALWAYS requires a DashboardAuthProvider — Hermes refuses
# to start otherwise, and `--insecure` is a documented no-op since the June
# 2026 hardening. Failing here gives a one-line actionable error instead of a
# Hermes stack trace 30s later. Only NAMES are echoed, never values.
if [ "$HERMES_DASHBOARD_HOST" != "127.0.0.1" ] && [ "$HERMES_DASHBOARD_HOST" != "localhost" ]; then
  if [ -z "${HERMES_DASHBOARD_BASIC_AUTH_USERNAME:-}" ] && [ -z "${HERMES_DASHBOARD_OAUTH_CLIENT_ID:-}" ]; then
    echo "[hermes] FATAL: dashboard host ${HERMES_DASHBOARD_HOST} is not loopback, so Hermes REQUIRES a dashboard auth provider." >&2
    echo "[hermes]        Set HERMES_DASHBOARD_BASIC_AUTH_USERNAME and HERMES_DASHBOARD_BASIC_AUTH_PASSWORD" >&2
    echo "[hermes]        (plus HERMES_DASHBOARD_BASIC_AUTH_SECRET for stable sessions), or HERMES_DASHBOARD_OAUTH_CLIENT_ID." >&2
    echo "[hermes]        There is no unauthenticated public-dashboard option (--insecure does not bypass it)." >&2
    exit 1
  fi
fi
# The provider is only registered when a username is paired with a password.
if [ -n "${HERMES_DASHBOARD_BASIC_AUTH_USERNAME:-}" ] && [ -z "${HERMES_DASHBOARD_BASIC_AUTH_PASSWORD:-}" ] && [ -z "${HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH:-}" ]; then
  echo "[hermes] FATAL: HERMES_DASHBOARD_BASIC_AUTH_USERNAME is set but no password is." >&2
  echo "[hermes]        Set HERMES_DASHBOARD_BASIC_AUTH_PASSWORD (or _PASSWORD_HASH)." >&2
  exit 1
fi

# --- Persistent-storage preparation (fail fast, never retry silently) --------
# This directory is the platform's persistent volume. If the mount is missing
# or not writable by this container user, the WhatsApp pairing and the Hermes
# databases cannot persist — crash loudly instead of silently re-pairing on
# every restart.
if [ "$(id -u)" -eq 0 ]; then
  mkdir -p "$DATA_DIR" "$HERMES_HOME"
  chown -R hermesai:hermesai "$DATA_DIR" 2>/dev/null || true
else
  for d in "$DATA_DIR" "$HERMES_HOME"; do
    mkdir -p "$d" 2>/dev/null \
      || { echo "[hermes] FATAL: cannot create persistent dir ${d} (read-only? no persistent volume mounted at ${DATA_DIR}, or it is not writable by uid $(id -u)). Fix the platform volume mount/ownership and redeploy." >&2; exit 1; }
  done
fi

# --- First-boot config seeding (idempotent; a restored volume is untouched) ---
if [ ! -f "$HERMES_HOME/config.yaml" ]; then
  if [ -f "$SEED_CONFIG" ]; then
    echo "[hermes] first boot: seeding Hermes config into ${HERMES_HOME}/config.yaml"
    cp "$SEED_CONFIG" "$HERMES_HOME/config.yaml"
    chmod 600 "$HERMES_HOME/config.yaml" || true
  else
    echo "[hermes] WARN: no config template at ${SEED_CONFIG}; Hermes will use its defaults."
  fi
else
  echo "[hermes] config.yaml already present in ${HERMES_HOME} — leaving it untouched."
fi

# Hermes runtime writable dirs. Created here so the persistent volume is fully
# usable before the gateway or dashboard starts.
mkdir -p "$HERMES_HOME/state" "$HERMES_HOME/logs" "$HERMES_HOME/pending_messages" \
         "$HERMES_HOME/platforms/whatsapp/session" "$HERMES_HOME/pairing" \
         "$HERMES_HOME/cache"

# The WhatsApp Baileys session lives in
# $HERMES_HOME/platforms/whatsapp/session/creds.json. Log whether it exists —
# presence only, never contents.
if [ -f "$HERMES_HOME/platforms/whatsapp/session/creds.json" ]; then
  echo "[hermes] WhatsApp session found — the gateway should connect on start."
else
  echo "[hermes] No WhatsApp session yet — pair it from the dashboard under Channels."
fi

echo "[hermes] entrypoint: starting supervisor"

# exec -> the supervisor becomes PID 1 and receives container signals.
exec node "$RUNTIME_DIR/supervisor.mjs"
