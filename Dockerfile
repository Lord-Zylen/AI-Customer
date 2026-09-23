# syntax=docker/dockerfile:1

# ============================================================================
# Customer AI — Render production image
#
# One non-root container (uid/gid 1000) running:
#   1. Customer AI Node backend   (HOST=0.0.0.0, PORT from Render's PORT env)
#   2. Hermes gateway             (python -m hermes_cli.main gateway run)
#   3. Hermes WhatsApp bridge     (spawned by the gateway as a child process)
#
# PERSISTENCE (CRITICAL): attach a Render Persistent Disk at /app/data. The
# Hermes home ($HERMES_HOME=/app/data/hermes) and WhatsApp auth
# ($WHATSAPP_AUTH_DIR=/app/data/whatsapp-auth) live there. Losing that
# directory can require re-pairing WhatsApp. The image ships an EMPTY Hermes
# home — never a local session.
#
# Build:  docker build -t customer-ai-render:test .
# Run:    docker run --rm --user 1000:1000 \
#          -p 8080:8080 \
#          -v customer-ai-test:/app/data \
#          -e NODE_ENV=production -e HOST=0.0.0.0 -e PORT=8080 -e TRUST_PROXY=1 \
#          -e MONGODB_URI=<atlas-uri> -e REDIS_URL=<redis-cloud-url> \
#          -e CLIENT_ORIGIN=https://<vercel-domain> \
#          -e CAI_HOOK_SECRET=<secret> \
#          # /api/health is DB-backed: 200 only when MongoDB is reachable;
#          # omit MONGODB_URI => 503 => the supervisor exits after the wait.
#          -e HERMES_HOME=/app/data/hermes -e HERMES_ENABLED=false \
#          customer-ai-render:test
#
# All secrets are injected as environment variables at runtime — never baked
# into the image.
# ============================================================================

# --- Stage 1: build the Vercel frontend bundle (optional static serve) ----
FROM node:22-bookworm-slim AS client-build
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# --- Stage 2: final production image ---------------------------------------
FROM node:22-bookworm-slim

# Pinned Hermes core — the exact commit of the verified local install
# (hermes-agent v0.21.3, gateway code_sha 4716ec0ba4e212105f8f162c226f052b25f8a76b).
ARG HERMES_REPO=https://github.com/NousResearch/hermes-agent.git
ARG HERMES_COMMIT=4716ec0ba4e212105f8f162c226f052b25f8a76b

ENV DEBIAN_FRONTEND=noninteractive
ENV HOME=/home/customerai
ENV NODE_ENV=production
ENV HOST=0.0.0.0
# Render injects its own PORT at runtime (the container listens on $PORT).
# 8080 is the readiness/health fallback for local Docker runs.
ENV PORT=8080
ENV HERMES_HOME=/app/data/hermes
ENV HERMES_BIN=/home/customerai/.local/bin/hermes
ENV HERMES_GATEWAY_STATE=/app/data/hermes/gateway_state.json
ENV WHATSAPP_AUTH_DIR=/app/data/whatsapp-auth
# CAI_HOOK_BASE_URL is NOT hardcoded here: the entrypoint derives it from $PORT
# if the operator did not set it explicitly (Render's PORT is dynamic).
ENV PATH=/home/customerai/.local/bin:/opt/hermes-agent/venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# System deps: Python 3.11 (Hermes venv, requires-python >=3.11,<3.14),
# git + curl (pinned Hermes checkout, uv installer), passwd (usermod/groupmod).
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv git curl ca-certificates passwd \
    && rm -rf /var/lib/apt/lists/*

# Pinned Hermes core into /opt/hermes-agent (the read-only-ish install tree:
# Hermes mirrors nothing here at runtime except the writable bridge dir).
RUN export GIT_TERMINAL_PROMPT=0 \
    && git clone --no-checkout --depth 1 "${HERMES_REPO}" /opt/hermes-agent \
    && git -C /opt/hermes-agent fetch --depth 1 origin "${HERMES_COMMIT}" \
    && git -C /opt/hermes-agent checkout --detach FETCH_HEAD

# ----------------------------------------------------------------------------
# Runtime user — UID/GID 1000 (Blitz Cloud runs every container as 1000:1000
# with Linux capabilities dropped; the image must start without root).
#
# The Node base image already ships a user with uid 1000 / gid 1000 (`node`),
# so reuse that uid/gid rather than creating a new one: rename `node` to
# `customerai` and move its home to /home/customerai. The build fails loudly
# if the base image ever stops providing uid/gid 1000.
# ----------------------------------------------------------------------------
RUN usermod --login customerai --home /home/customerai --move-home node \
    && groupmod --new-name customerai node \
    && id customerai \
    && test "$(id -u customerai)" -eq 1000 \
    && test "$(id -g customerai)" -eq 1000

# Runtime write paths:
#   - /app/data*                    persistent (Render Persistent Disk): Hermes
#                                   home + WhatsApp auth — created & pre-owned
#                                   here so the non-root runtime can write them.
#   - /home/customerai*             owned by customerai (uid 1000)
#   - /opt/hermes-agent             owned by customerai (incl. the writable
#                                   WhatsApp-bridge dir and its node_modules)
#   - /opt/customer-ai, /app        read-only at runtime, customerai-owned
#   - /tmp, /var/tmp               world-writable (Hermes/Node temp)
# The only root-owned tree (from the build-time `npm ci`) is
# /app/server/node_modules, which is read-only at runtime.
RUN mkdir -p /opt/customer-ai/hermes-config /opt/customer-ai/bridge /app /app/data/hermes /app/data/whatsapp-auth \
    && chown -R customerai:customerai /opt/hermes-agent /opt/customer-ai /app /home/customerai

WORKDIR /app/server
COPY --chown=customerai:customerai server/package*.json ./
RUN npm ci --omit=dev
RUN chown -R customerai:customerai /home/customerai
COPY --chown=customerai:customerai server/src ./src
# Hermes plugin/hook/config templates (seeded into HERMES_HOME on first boot).
COPY --chown=customerai:customerai hermes/ /opt/customer-ai/hermes-config/
# Container entrypoint + process supervisor.
COPY --chown=customerai:customerai deploy/blitz/entrypoint.sh /opt/customer-ai/entrypoint.sh
COPY --chown=customerai:customerai deploy/blitz/supervisor.mjs /app/supervisor.mjs
# Optional static frontend bundle (Vercel is the real frontend host).
COPY --from=client-build --chown=customerai:customerai /app/client/dist /app/client/dist

USER customerai
WORKDIR /opt/hermes-agent

# Hermes Python deps — mirrors the verified setup-hermes.sh path:
# hash-verified via the project's uv.lock (uv sync --extra all --locked).
RUN curl -LsSf https://astral.sh/uv/install.sh | sh \
    && ~/.local/bin/uv venv /opt/hermes-agent/venv --python 3.11 \
    && UV_PROJECT_ENVIRONMENT=/opt/hermes-agent/venv ~/.local/bin/uv sync --extra all --locked

# WhatsApp bridge Node deps, pinned via the bridge's package-lock.json
# (Baileys). The bridge dir stays customerai-writable, so Hermes uses it
# in place and never needs a runtime npm install.
RUN npm ci --prefix /opt/hermes-agent/scripts/whatsapp-bridge

# `hermes` CLI launcher (mirrors the verified ~/.local/bin/hermes).
RUN printf '#!/usr/bin/env bash\nunset PYTHONPATH PYTHONHOME\nexec /opt/hermes-agent/venv/bin/python /opt/hermes-agent/hermes "$@"\n' \
      > /home/customerai/.local/bin/hermes \
    && chmod +x /home/customerai/.local/bin/hermes

EXPOSE 8080

# Persistence is provided by a Render Persistent Disk mounted at /app/data
# (see render.yaml). No Docker VOLUME: a VOLUME instruction would make
# Render/Docker allocate an anonymous volume that can shadow the mounted
# disk. The image ships no session data; the local developer's ~/.hermes is
# never copied in.

# /api/health is DB-backed but independent of WhatsApp being connected.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"

CMD ["/opt/customer-ai/entrypoint.sh"]