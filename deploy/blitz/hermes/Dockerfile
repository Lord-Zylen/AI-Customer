# syntax=docker/dockerfile:1

# ============================================================================
# HERMES-ONLY image — Blitz Cloud test deployment
#
# PURPOSE: prove that Blitz can run the Hermes gateway + Hermes dashboard and
# expose the dashboard publicly so WhatsApp can be paired. The Customer AI Node
# backend is deliberately NOT part of this image: no `server/`, no `client/`,
# no Express, no MongoDB, no Redis, no Vite bundle, no `server/src/server.js`.
#
# This file is INDEPENDENT of the production repository-root `Dockerfile`
# (Customer AI + Hermes combined). Nothing here modifies, replaces or is
# required by that file; both can coexist in the same repository.
#
# WHAT RUNS (exactly two processes, both Hermes):
#   1. Hermes dashboard  — `hermes dashboard --host 0.0.0.0 --port $PORT`.
#      Serves the web UI on 9119 and hosts the WhatsApp pairing (QR) flow.
#   2. Hermes gateway    — `python -m hermes_cli.main gateway run
#      --external-supervisor`. Connects messaging platforms (WhatsApp bridge).
#
# PERSISTENCE (CRITICAL): attach persistent storage at /app/data. The Hermes
# home ($HERMES_HOME=/app/data/hermes) lives there and the WhatsApp Baileys
# session is $HERMES_HOME/platforms/whatsapp/session/creds.json. Losing /app/data
# means re-pairing WhatsApp. The image ships an EMPTY Hermes home — never a
# local session, never a local creds.json.
#
# Build (context MUST be the repository root — the Dockerfile copies
# deploy/blitz/hermes/* from it):
#   docker build -f deploy/blitz/hermes/Dockerfile -t hermes-blitz:test .
#
# Run:
#   docker run --rm --name hermes-test \
#     -p 9119:9119 \
#     -v hermes-test-data:/app/data \
#     -e HERMES_DASHBOARD_BASIC_AUTH_USERNAME=<user> \
#     -e HERMES_DASHBOARD_BASIC_AUTH_PASSWORD=<secret> \
#     -e HERMES_DASHBOARD_BASIC_AUTH_SECRET=<secret> \
#     -e GROQ_API_KEY=<secret> \
#     -e WHATSAPP_ENABLED=true \
#     hermes-blitz:test
#
# All secrets are injected as environment variables at runtime — never baked
# into the image, never copied from .env, never printed in logs.
# ============================================================================

# Pinned Hermes core — the exact commit the production image and the verified
# local install use (hermes-agent v0.21.3, code_sha
# 4716ec0ba4e212105f8f162c226f052b25f8a76b). Same pin, same install path.
ARG HERMES_REPO=https://github.com/NousResearch/hermes-agent.git
ARG HERMES_COMMIT=4716ec0ba4e212105f8f162c226f052b25f8a76b

# --- Stage 1: the pinned Hermes source tree ----------------------------------
# Cloned once and reused by both later stages so the (slow) clone is a single
# layer-cached step and the commit is provably identical everywhere.
FROM node:22-bookworm-slim AS hermes-src
ARG HERMES_REPO
ARG HERMES_COMMIT
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN export GIT_TERMINAL_PROMPT=0 \
    && git clone --no-checkout --depth 1 "${HERMES_REPO}" /opt/hermes-agent \
    && git -C /opt/hermes-agent fetch --depth 1 origin "${HERMES_COMMIT}" \
    && git -C /opt/hermes-agent checkout --detach FETCH_HEAD \
    && git -C /opt/hermes-agent reset --hard "${HERMES_COMMIT}" \
    && git -C /opt/hermes-agent rev-parse HEAD \
    && test -f /opt/hermes-agent/hermes_cli/main.py \
    && test -f /opt/hermes-agent/scripts/whatsapp-bridge/bridge.js
WORKDIR /opt/hermes-agent

# --- Stage 2: build the Hermes dashboard web UI ------------------------------
# `hermes dashboard` builds the web UI BEFORE it binds (main_dashboard.py calls
# _build_web_ui(), fatal=True). That build is a blocking `npm install` +
# `vite build` of the `web` workspace. Doing it here keeps runtime startup
# deterministic and lets us export HERMES_WEB_DIST so the runtime build is a
# no-op (main_dashboard.py:808+ reads the override and skips the build).
#
# This is HERMES's own dashboard SPA, not the Customer AI Vite frontend — it is
# the UI the operator pairs WhatsApp through, so it is required, not optional.
FROM hermes-src AS dashboard-build
# Force `file:` workspace deps to install as symlinks (npm >=10 default; set
# explicitly as defense-in-depth, matching the upstream Hermes Dockerfile).
ENV npm_config_install_links=false
# --include=dev is REQUIRED, not politeness: npm treats NODE_ENV=production as
# omit=dev, and the whole build toolchain (typescript, vite, plugins, vitest,
# qrcode types) lives in web's devDependencies — without it `tsc -b` fails with
# ~91 errors. Hermes guards the same trap the same way: main_web_build.py
# always appends --include=dev to every npm invocation.
# The workspace closure mirrors main_web_build.py::_web_npm_install_context
# (ui-tui + web + --include-workspace-root).
RUN npm ci --workspace ui-tui --workspace web --include-workspace-root --include=dev \
  && npm run build -w web \
  && test -f hermes_cli/web_dist/index.html

# --- Stage 3: final Hermes-only image ----------------------------------------
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV HOME=/home/hermesai
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
ENV npm_config_install_links=false

# --- Runtime configuration ---------------------------------------------------
# HERMES_HOME is the persistent store: config.yaml, the SQLite state DBs, logs,
# and the WhatsApp session all live under it.
ENV HERMES_HOME=/app/data/hermes
ENV HERMES_BIN=/home/hermesai/.local/bin/hermes
# NOTE: HERMES_GATEWAY_STATE is intentionally NOT set. It is a Customer AI
# backend variable (server/src/services/whatsapp.service.js reads it); Hermes
# itself never reads it.

# The dashboard binds 0.0.0.0 so Blitz can route public HTTPS to it.
# deploy/blitz/hermes/entrypoint.sh reads these two and passes them to
# `hermes dashboard --host/--port`. Same names the upstream Hermes s6 dashboard
# service uses, so an operator who knows that image is already at home.
ENV HERMES_DASHBOARD_HOST=0.0.0.0
ENV HERMES_DASHBOARD_PORT=9119
ENV HERMES_DASHBOARD_ENABLED=true

# We are the gateway's supervisor: in-chat restarts and the dashboard's
# post-pairing `hermes gateway restart` must exit back to THIS process instead
# of forking a detached replacement. Same contract systemd/launchd/s6 use.
ENV HERMES_GATEWAY_EXTERNAL_SUPERVISOR=1

# Prebuilt dashboard SPA from stage 2 — makes the runtime web-UI build a no-op.
ENV HERMES_WEB_DIST=/opt/hermes-agent/hermes_cli/web_dist

ENV PATH=/home/hermesai/.local/bin:/opt/hermes-agent/venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# System deps: Python 3.11 (Hermes venv; requires-python >=3.11,<3.14),
# git (pinned checkout in stage 1, plus `hermes update` / doctor), curl (uv),
# ca-certificates, passwd (usermod/groupmod).
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv git curl ca-certificates passwd \
    && rm -rf /var/lib/apt/lists/*

# The pinned Hermes tree, byte-identical to what stage 1 verified.
COPY --from=hermes-src /opt/hermes-agent /opt/hermes-agent

# ----------------------------------------------------------------------------
# Runtime user — UID/GID 1000.
# The Node base image already ships uid/gid 1000 (`node`), so rename rather
# than create one. The build fails loudly if the base image ever stops
# providing uid/gid 1000. This matches how the production image prepares for
# platforms that run every container as 1000:1000 with capabilities dropped.
# ----------------------------------------------------------------------------
RUN usermod --login hermesai --home /home/hermesai --move-home node \
    && groupmod --new-name hermesai node \
    && id hermesai \
    && test "$(id -u hermesai)" -eq 1000 \
    && test "$(id -g hermesai)" -eq 1000

# Runtime write paths:
#   - /app/data*     persistent (Blitz volume): Hermes home + WhatsApp session
#   - /home/hermesai, /opt/hermes-agent, /app   owned by hermesai
# The WhatsApp bridge dir must stay writable — Hermes runs the Baileys bridge
# in place and never does a runtime npm install (the tree is not read-only, but
# a runtime install would be slow and network-dependent on first connect).
RUN mkdir -p /app/data/hermes /app/data/whatsapp-auth /opt/hermes-runtime \
    && chown -R hermesai:hermesai /opt/hermes-agent /opt/hermes-runtime /app /home/hermesai

WORKDIR /opt/hermes-agent
USER hermesai

# Hermes Python deps — identical installation path to the production image
# (hash-verified via the project's uv.lock: `uv sync --extra all --locked`).
RUN curl -LsSf https://astral.sh/uv/install.sh | sh \
    && ~/.local/bin/uv venv /opt/hermes-agent/venv --python 3.11 \
    && UV_PROJECT_ENVIRONMENT=/opt/hermes-agent/venv ~/.local/bin/uv sync --extra all --locked

# WhatsApp bridge Node deps, pinned via the bridge's own package-lock.json
# (Baileys). Baked so the first `connect()` never needs a runtime npm install.
RUN npm ci --prefix /opt/hermes-agent/scripts/whatsapp-bridge

# Dashboard SPA, prebuilt in stage 2.
COPY --from=dashboard-build --chown=hermesai:hermesai /opt/hermes-agent/hermes_cli/web_dist /opt/hermes-agent/hermes_cli/web_dist

# Container entrypoint + process supervisor.
COPY --chown=hermesai:hermesai deploy/blitz/hermes/entrypoint.sh /opt/hermes-runtime/entrypoint.sh
# entrypoint.sh is committed with mode 100644 (non-executable); COPY preserves
# that and execve() would fail with EACCES. Make it executable in the image.
RUN chmod +x /opt/hermes-runtime/entrypoint.sh
COPY --chown=hermesai:hermesai deploy/blitz/hermes/supervisor.mjs /opt/hermes-runtime/supervisor.mjs

# Hermes config template, seeded into $HERMES_HOME/config.yaml on FIRST boot
# only. A restored/persistent HERMES_HOME is never overwritten.
COPY --chown=hermesai:hermesai deploy/blitz/hermes/config.yaml /opt/hermes-runtime/config.yaml

# `hermes` CLI launcher.
RUN mkdir -p /home/hermesai/.local/bin \
    && printf '#!/usr/bin/env bash\nunset PYTHONPATH PYTHONHOME\nexec /opt/hermes-agent/venv/bin/python /opt/hermes-agent/hermes "$@"\n' \
      > /home/hermesai/.local/bin/hermes \
    && chmod +x /home/hermesai/.local/bin/hermes \
    && chown -R hermesai:hermesai /home/hermesai/.local

# 9119 is the ONLY exposed port. The WhatsApp bridge and the gateway stay
# internal (the bridge's HTTP port is loopback-only by default); the dashboard
# is the single public web interface.
EXPOSE 9119

# Persistence is provided by the platform's persistent volume mounted at
# /app/data. No Docker VOLUME instruction: an anonymous volume would shadow the
# mounted disk. The image ships no session data.

# Readiness = the dashboard process is serving HTTP. `/api/health` is Hermes'
# own auth-exempt liveness endpoint (hermes_cli/dashboard_auth/public_paths.py)
# and returns {"ok":true,"version":...,"auth_required":...}. It says NOTHING
# about WhatsApp pairing: a healthy container means "Hermes is running", NOT
# "WhatsApp is paired". No fake probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD node -e "const p=process.env.HERMES_DASHBOARD_PORT||9119;fetch('http://127.0.0.1:'+p+'/api/health').then(r=>r.json()).then(j=>process.exit(j&&j.ok?0:1)).catch(()=>process.exit(1))"

# ENTRYPOINT (not CMD) so container startup is owned by this file and survives
# an operator-supplied container command. The script ends with
# `exec node /opt/hermes-runtime/supervisor.mjs`, so Node is PID 1 and receives
# SIGTERM/SIGINT directly.
ENTRYPOINT ["/opt/hermes-runtime/entrypoint.sh"]
