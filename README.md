# Customer AI

Customer AI is a WhatsApp customer service workspace. Hermes triages messages, responds only from approved business data, and routes sensitive or uncertain cases to the human queue.

## Run locally

1. Copy `.env.example` to `.env` and set secrets and `MONGODB_URI`.
2. Run `npm run install:all`.
3. Run `npm run dev` and open `http://localhost:5173`.

The frontend is a WhatsApp inbox with a human-review queue, business settings that feed Hermes, a WhatsApp pairing screen, and a system-status page. The Express server exposes `/api/health`, the Hermes webhooks (`/api/hermes/webhook/gate`, `/api/hermes/webhook/event`, `/api/hermes/webhook/knowledge`), and the WhatsApp conversation and human-queue APIs. In local development the backend binds `127.0.0.1:5000` by default (`HOST`, `PORT`).

## Integration boundaries

WhatsApp is owned by the Hermes gateway (single connection). Hermes calls Customer AI's `pre_gateway_dispatch` plugin and mirror hooks (`~/.hermes/plugins/customer-ai-gate`, `~/.hermes/hooks/customer_ai_tap`), which POST to `/api/hermes/webhook/*`. Human replies from the dashboard are sent through the `hermes send` CLI via `server/src/services/whatsapp.service.js` (`HERMES_BIN`). Customer AI never opens its own WhatsApp connection.

```
WhatsApp → Hermes bridge → customer-ai-gate → POST /api/hermes/webhook/gate
             → decideInbound() → allow/skip → Hermes agent → WhatsApp transport
             → customer_ai_tap → POST /api/hermes/webhook/event
Human queue reply → POST /api/conversations/:id/messages → `hermes send --to whatsapp:<jid>`
```

## Production Deployment (Render + Vercel)

The **primary** deployment target is Render (+ Vercel for the frontend). The frontend is served by Vercel; a single Render Docker web service runs the Node backend **plus** the Hermes gateway **plus** the WhatsApp bridge. MongoDB stays on Atlas; Redis stays on Redis Cloud — no datastore is installed in the container.

### A. Architecture

```
            ┌──────────────┐
            │    Vercel    │   React frontend (client/), SPA rewrites via vercel.json
            └──────┬───────┘
                   │ HTTPS (VITE_API_URL=https://<render-url>/api)
                   ▼
        ┌───────────────────────────┐
        │       Render web          │  one container (port = Render's PORT env)
        │  Customer AI (Node)       │
        │     ├ Hermes Gateway      │
        │     │   └ WhatsApp bridge │
        │     └ Persistent Disk     │  mounted at /app/data
        └─────────────┬─────────────┘
                      ▼
          MongoDB Atlas + Redis Cloud (external)
```

Hermes remains the **only** WhatsApp transport owner. Customer AI and Hermes must share the same container because the human-queue send path invokes the local Hermes CLI (`hermes send`).

### B. Deploy

- **Render**: use `render.yaml` (Blueprint) or create a manual **Docker** web service: Root Directory `/` (repo root), `Dockerfile`. Create a **Persistent Disk** and mount it at **`/app/data`** (this persists the Hermes home and the WhatsApp auth — losing it can require re-pairing WhatsApp).
- **Vercel**: Root Directory `client`, build `npm run build`, output `dist`, env `VITE_API_URL=https://<render-backend-public-url>/api`. `client/vercel.json` keeps the SPA rewrite working. No serverless functions; frontend only.

### C. Environment variables (set in the Render dashboard — names only, values never in git)

- Backend: `NODE_ENV`, `HOST` (`0.0.0.0`), `PORT` (set by Render, do not configure), `TRUST_PROXY`, `MONGODB_URI`, `REDIS_URL`, `SESSION_SECRET`, `AI_API_KEY`, `AI_MODEL`, `AI_CONFIDENCE_THRESHOLD`, `HERMES_ENABLED`, `HERMES_HOME`, `HERMES_GATEWAY_STATE`, `HERMES_BIN`, `HERMES_STATE_STALE_MS`, `WHATSAPP_AUTH_DIR`, `CAI_HOOK_SECRET`, `CAI_HOOK_BASE_URL`, `CLIENT_ORIGIN`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `SEED_PRINT_CREDENTIALS`, `WHATSAPP_SETUP_TOKEN`
- Hermes (same container): `GROQ_API_KEY`, `WHATSAPP_ENABLED`, `WHATSAPP_ALLOW_ALL_USERS`, `WHATSAPP_ALLOWED_USERS`, `WHATSAPP_HOME_CHANNEL`

`CAI_HOOK_BASE_URL` is optional: the container entrypoint derives `http://127.0.0.1:<PORT>` from Render's dynamic `PORT` when unset. See `.env.example` for the commented template.

### D. Persistent storage

The Render Persistent Disk mounts at **`/app/data`**. The image writes `$HERMES_HOME` (`/app/data/hermes`) and `$WHATSAPP_AUTH_DIR` (`/app/data/whatsapp-auth`) there. Render disks are not backed up — copy the volume externally if you need redundancy. First-boot seeding of `config.yaml`, the `customer-ai-gate` plugin and the `customer_ai_tap` hook is idempotent and only happens on an empty disk. Never copy the developer's local WhatsApp session into the image.

### E. Initial WhatsApp pairing

Hermes pairing runs from the container shell (Render exposes a shell in the service details). After pairing, the session lives under `$HERMES_HOME` on the persistent disk and survives restarts. Never expose the QR via an unauthenticated HTTP endpoint; the `/api/whatsapp/*` routes remain `409 "managed by Hermes"` and are not used for pairing.

### F. Health / secrets / logs

- Health: `GET /api/health` (`/api/health` on Render). DB-backed: returns `200` only when MongoDB is reachable; independent of WhatsApp connection state. Configure the Render health check to this path.
- Secrets: `MONGODB_URI`, `REDIS_URL`, `SESSION_SECRET`, `AI_API_KEY`, `GROQ_API_KEY`, `CAI_HOOK_SECRET`, `WHATSAPP_SETUP_TOKEN`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` in Render only. `CAI_HOOK_SECRET` must be identical for backend and Hermes (same container environment).
- CORS: set `CLIENT_ORIGIN=https://<vercel-domain>` (comma-separated for more). No-Origin requests (internal webhooks) keep working.
- Logs: prefixed `[supervisor]`, `[backend]`, `[hermes]` lines; connection strings are redacted in error logs; message contents are never logged.
- Fail-fast: if the persistent disk can't be mounted at `/app/data` or MongoDB is unreachable at boot, the supervisor exits non-zero so Render restarts and the logs state the cause.

## Legacy: Blitz Cloud deployment (superseded)

Blitz Cloud was the earlier deployment target. The sections below document that layout and its assumptions; the current target is **Render + Vercel** (see above). Keep the two methods separate.

### A. Architecture

```
            ┌──────────────┐
            │    Vercel    │   React frontend (client/)
            └──────┬───────┘
                   │ HTTPS
                   ▼
      ┌───────────────────────────┐
      │      Blitz Cloud          │  one container (port 8080)
      │  Customer AI (Node)       │
      │     ├ Hermes Gateway      │
      │     │   └ WhatsApp bridge │
      │     └ MongoDB client      │
      └─────────────┬─────────────┘
                    ▼
          MongoDB Atlas (external)
```

Hermes remains the **only** WhatsApp transport owner. Customer AI and Hermes must share the same container because the human-queue send path invokes the local Hermes CLI (`hermes send`).

### B. Repository configuration

Deploy the **repository root** to Blitz Cloud with **Dockerfile** build (root `Dockerfile`). Vercel deploys **only `client/`**.

- Blitz build: root `Dockerfile` → runs `/opt/customer-ai/entrypoint.sh` → Node process supervisor (`deploy/blitz/supervisor.mjs`) starts the backend, waits for `/api/health`, then starts the Hermes gateway (which spawns the WhatsApp bridge).
- The container runs as the non-root user `customerai` with **`uid 1000` / `gid 1000`** — Blitz Cloud runs every container as `--user 1000:1000` and Linux capabilities are dropped, so the image must start and run **without root** (no sudo, no runtime `chown`, no setuid, no privileged capabilities). The image targets **linux/amd64**. No systemd, no Nginx, no root, no local MongoDB.

### C. Environment variables

Set these in the **Blitz Cloud** application environment (names only — set real values in Blitz, never in git):

- Backend: `NODE_ENV`, `HOST`, `PORT`, `TRUST_PROXY`, `MONGODB_URI`, `SESSION_SECRET`, `AI_API_KEY`, `AI_MODEL`, `AI_CONFIDENCE_THRESHOLD`, `HERMES_ENABLED`, `HERMES_HOME`, `HERMES_GATEWAY_STATE`, `HERMES_BIN`, `HERMES_STATE_STALE_MS`, `CAI_HOOK_SECRET`, `CAI_HOOK_BASE_URL`, `CLIENT_ORIGIN`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `SEED_PRINT_CREDENTIALS`, `WHATSAPP_SETUP_TOKEN`
- Hermes (same container): `GROQ_API_KEY`, `WHATSAPP_ENABLED`, `WHATSAPP_ALLOW_ALL_USERS`, `WHATSAPP_ALLOWED_USERS`, `WHATSAPP_HOME_CHANNEL`

See `.env.example` for a commented template.

### D. Port

The container listens on **`8080`** (`PORT=8080`, `HOST=0.0.0.0`). Blitz routes public HTTPS to it. Do not bind `127.0.0.1` in production — Blitz needs to reach the container over its network.

### E. Persistent storage

**`/home/customerai/.hermes` MUST be backed by Blitz persistent storage.** It holds the Hermes/WhatsApp session, Hermes databases, logs and config. Losing this directory can require WhatsApp re-pairing. Attach a persistent volume/mount to that path in Blitz (attach the persistent directory to `/home/customerai/.hermes`). The image declares `VOLUME ["/home/customerai/.hermes"]` and ships an empty production Hermes home (the local developer's `~/.hermes` is never copied in). Configuration and plugin/hook seeds are written there automatically on first boot. Note: persistent folders are **not backed up by Blitz** — treat the persistent volume as the single non-redundant source of truth for the WhatsApp session, and export/copy it yourself if you need redundancy.

### F. Initial WhatsApp pairing

First deployment needs one interactive pairing of the WhatsApp account.

- The container's `~/.hermes` config, session and pairing directories support persistent Hermes authentication; after pairing, normal restarts do **not** require another QR scan (the pair persists in the volume).
- Hermes provides its official pairing flow via the `hermes` CLI (which the container resolves to `python -m hermes_cli.main gateway run` / `hermes gateway`). Completed pairing data is stored under `$HERMES_HOME`.
- `UNVERIFIED — initial Hermes WhatsApp pairing method on Blitz Cloud`: it is **not** yet known whether/how the one-time QR/link pairing can be performed on Blitz (this depends on whether Blitz exposes an interactive container shell, which is itself UNVERIFIED). **If no shell exists**: build the paired session inside a scratch container running the same image as uid 1000, then seed its `~/.hermes` contents into the Blitz persistent volume; the session format is the standard Hermes/Baileys one, so a session produced by the same Hermes version is compatible.
- Never expose the QR via an unauthenticated HTTP endpoint. The Customer AI `/api/whatsapp/*` pairing routes remain `409 "managed by Hermes"` and are **not** used for pairing. Never copy the developer's real local WhatsApp session into the image/volume for production.

### G. Vercel

- Root directory: `client`
- Build command: `npm run build`
- Output directory: `dist`
- Environment: `VITE_API_URL=https://<blitz-public-domain>/api`
- `client/vercel.json` keeps the SPA rewrite working.
- No serverless functions; frontend only.

### H. MongoDB Atlas

MongoDB is **external**. Blitz only runs the application container (no mongod inside). Set `MONGODB_URI` to the Atlas connection string with network access allowed for the Blitz Cloud egress IP(s).

### I. CORS

Set `CLIENT_ORIGIN=https://<vercel-domain>` (comma-separated list if more than one origin). No-Origin requests (internal Hermes→Customer AI webhooks over `http://127.0.0.1:8080`) keep working.

### J. Secrets

Configure these in Blitz and never commit them: `MONGODB_URI`, `SESSION_SECRET`, `AI_API_KEY`, `CAI_HOOK_SECRET`, `GROQ_API_KEY`, `WHATSAPP_SETUP_TOKEN`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`. CAI_HOOK_SECRET must be identical for the backend and Hermes (same container environment).

### K. Health check

Use `GET /api/health`. It reports DB health and is **independent of WhatsApp connection state** — a healthy backend with WhatsApp temporarily disconnected still reports healthy. The image also ships a Docker `HEALTHCHECK` against `/api/health`. Because the endpoint is DB-backed, a **reachable `MONGODB_URI` is required** for it to return `200`; without it the supervisor's readiness poll times out and the container exits 1 (correct fail-fast). The operator's backend-only smoke test (`HERMES_ENABLED=false`) therefore also needs `-e MONGODB_URI=<atlas-uri>`.

### L. Logs / troubleshooting

- Container logs show prefixed `[backend]`, `[hermes]`, and `[supervisor]` lines (startup, health, termination, failures). Secrets and message contents are never logged.
- `HERMES_STATE_STALE_MS`/gateway liveness: the dashboard trusts the gateway state file plus live-PID checks; a healthy idle gateway is **not** reported disconnected.
- If `/api/health` stays 503: check `MONGODB_URI` and Atlas network access.
- If the gate logs `gate returned HTTP ...; message not admitted (fail closed)`: check `CAI_HOOK_SECRET`/`CAI_HOOK_BASE_URL` — messages are deliberately dropped until the hook works.
- If no WhatsApp replies arrive: check Blitz persistent storage is mounted at `/home/customerai/.hermes` and whether pairing re-happened (see F).

### Blitz-specific assumptions (UNVERIFIED)

The Dockerfile uses standard Docker primitives — `EXPOSE 8080`, `HEALTHCHECK` on `/api/health`, `VOLUME ["/home/customerai/.hermes"]`, non-root uid/gid 1000. Public documentation for the configured Blitz Cloud platform was not available at preparation time, so the following **require manual confirmation in the Blitz Cloud console/dashboard**:

- Blitz runs the container as **UID/GID 1000**; the image is designed to start **without root** (this is what the Dockerfile enforces, and it must be re-confirmed on the actual Blitz runtime).
- The image must support the **linux/amd64** platform.
- Port **8080** is used by the container.
- `/home/customerai/.hermes` is declared persistent; persistent folders are **not backed up by Blitz**.
- **No Nginx is required** and **no systemd is required** (the container internally supervises its own processes; `deploy/systemd` and `deploy/nginx` are VPS-only, legacy).
- `UNVERIFIED — requires manual confirmation in Blitz Cloud`: that Blitz routes public HTTPS to the container's `8080` port.
- `UNVERIFIED — requires manual confirmation in Blitz Cloud`: the exact way to attach persistent storage and that it can be mounted at `/home/customerai/.hermes` with `uid 1000` (`customerai`) ownership/writability.
- `UNVERIFIED — requires manual confirmation in Blitz Cloud`: whether Blitz adopts the Docker `HEALTHCHECK` (if not, configure `/api/health` as the health check manually).
- `UNVERIFIED — initial Hermes WhatsApp pairing method on Blitz Cloud` (see F).

## Legacy VPS deployment (optional)

The repository also contains a traditional single-VPS deployment (systemd + Nginx) under `deploy/systemd/` and `deploy/nginx/`. **These are VPS-only and are NOT used by Blitz Cloud.** Keep the two deployment methods separate: if you use Blitz, ignore `deploy/systemd` and `deploy/nginx`. The `docker-compose.yml` (bundled local Mongo + Baileys-era auth volume) is also legacy and not part of the Blitz layout.