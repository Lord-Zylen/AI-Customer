# Hermes-only deployment (Blitz test)

A **separate, isolated** container image that runs **only Hermes** — the
gateway and the dashboard — so Blitz can be tested for exactly one thing:

> **Hermes dashboard → publicly reachable through Blitz → WhatsApp paired**

It deliberately contains **no Customer AI**. The combined Customer AI + Hermes
production deployment is untouched and keeps working.

---

## 1. What this is

| | Combined (production) | This test deployment |
|---|---|---|
| Root `Dockerfile` | `Dockerfile` (unchanged) | `deploy/blitz/hermes/Dockerfile` |
| Customer AI Node backend | yes (`server/src/server.js`) | **no** |
| MongoDB / Redis | required | **not required** |
| Vite frontend bundle | yes | **no** (only Hermes' own dashboard SPA) |
| Hermes gateway | yes | yes |
| Hermes dashboard | opt-in | **always on** |
| Supervisor | `deploy/blitz/supervisor.mjs` | `deploy/blitz/hermes/supervisor.mjs` |
| Entrypoint | `deploy/blitz/entrypoint.sh` | `deploy/blitz/hermes/entrypoint.sh` |
| Hermes config seed | `hermes/configuration/config.yaml` | `deploy/blitz/hermes/config.yaml` |
| Public port | `8080` | `9119` |

### Why the config template differs from `hermes/configuration/config.yaml`

The only behavioural difference is `plugins.enabled`. The combined config
enables `customer-ai-gate`, which POSTs every inbound WhatsApp message to the
Customer AI decision webhook. That backend does not run in this image, and the
plugin is **default-deny** when `CAI_HOOK_SECRET` is absent — so leaving it
enabled here would silently swallow every inbound message. It is `[]` in this
template. `hermes/configuration/config.yaml` itself is **not modified**.

### Files

```
deploy/blitz/hermes/
├── Dockerfile                        Hermes-only image (3 stages)
├── entrypoint.sh                     PID-1 prep: /app/data, config seed, exec
├── supervisor.mjs                    PID 1: gateway + dashboard supervision
├── config.yaml                       Hermes-only config seed (no customer-ai-gate)
├── .env.example                      the COMPLETE env list (names only)
├── use-as-blitz-root.sh              swap the root Dockerfile (with backup)
├── restore-production-dockerfile.sh  undo that swap
└── README.md                         this file
```

---

## 2. Architecture

One non-root container (`hermesai`, uid/gid 1000) running two supervised
children:

```
Blitz router ──HTTPS──► 0.0.0.0:9119  Hermes dashboard   (PUBLIC, only port)
                                  └──► WhatsApp pairing / QR flow
                                        
                      Hermes gateway                    (internal)
                        └── WhatsApp Baileys bridge     (internal, loopback)
```

* `entrypoint.sh` → prepares `/app/data`, seeds the config on first boot, then
  `exec node supervisor.mjs` so **Node is PID 1** and receives SIGTERM directly.
* `supervisor.mjs` starts the **dashboard** (critical: if it dies, the container
  exits non-zero so the platform restarts it) and the **gateway** (never fatal:
  see §6).
* Node is present for three real reasons: the WhatsApp Baileys bridge, Hermes'
  own dashboard SPA build, and the supervisor. It is **not** there to serve
  Customer AI.
* The WhatsApp bridge's HTTP port stays loopback-only. **9119 is the only
  exposed port.**

### Image build

Three stages, one pinned Hermes clone reused by all of them:

1. `hermes-src` — `git clone` + checkout of the pinned commit
   (`4716ec0ba4e212105f8f162c226f052b25f8a76b`, the same pin production uses).
2. `dashboard-build` — `npm ci --workspace ui-tui --workspace web
   --include-workspace-root --include=dev` then `npm run build -w web`.
   `hermes dashboard` builds this SPA *before it binds* and the build is
   `fatal=True`, so it is prebuilt here and exported via `HERMES_WEB_DIST`.
3. final — `uv venv` + `uv sync --extra all --locked` (Python 3.11), the
   WhatsApp bridge's `npm ci` (Baileys), the prebuilt SPA, and the runtime
   files.

**Not installed:** MongoDB, Redis, Express, Mongoose, `redis`, the Customer AI
server, the Customer AI Vite client.

---

## 3. What to configure in Blitz

Create a **separate application/project** for the test. Do not repoint the
production one.

**1. Make the Hermes Dockerfile the root one.** Blitz auto-detects the
repository-root `Dockerfile`, so either:

*Option A — a separate branch (recommended, keeps production untouched):*

```bash
git checkout -b hermes-only-blitz
./deploy/blitz/hermes/use-as-blitz-root.sh
git add -A && git commit -m "chore: point root Dockerfile at the Hermes-only image (Blitz test)"
git push -u origin hermes-only-blitz     # then create the Blitz project from THIS branch
```

*Option B — swap locally, test, swap back:*

```bash
./deploy/blitz/hermes/use-as-blitz-root.sh
# ... test on Blitz ...
./deploy/blitz/hermes/restore-production-dockerfile.sh
```

The swap keeps a byte-exact backup and is verified to round-trip
(`git status` shows the root `Dockerfile` unmodified after restore).

**2. In the Blitz application settings:**

| Setting | Value |
|---|---|
| Build method | Dockerfile |
| Dockerfile | `./Dockerfile` (after the swap) |
| Port | **9119** |
| Health check | `/api/health` (optional — the image ships a `HEALTHCHECK`) |
| Persistent volume | mount at **`/app/data`** |
| Env vars | see §4 |

> If your Blitz project lets you set a custom Dockerfile path directly, use
> `./deploy/blitz/hermes/Dockerfile` and skip the swap entirely. The build
> **context must be the repository root** either way, because the Dockerfile
> copies `deploy/blitz/hermes/*` from it.

---

## 4. Environment variables

The **complete** list. Full documentation is in `.env.example` next to this file.

### Required

| Variable | Why |
|---|---|
| `HERMES_DASHBOARD_BASIC_AUTH_USERNAME` | Login name for the dashboard. |
| `HERMES_DASHBOARD_BASIC_AUTH_PASSWORD` | Login password. **A `0.0.0.0` dashboard cannot run without an auth provider** — Hermes refuses to start, and `--insecure` does not bypass it (June 2026 hardening). There is no unauthenticated public-dashboard option. |
| `GROQ_API_KEY` | The AI provider. Matched by `providers.groq.key_env` in the config. Without it the container is healthy and pairing works, but every reply 401s. |

### Recommended

| Variable | Why |
|---|---|
| `HERMES_DASHBOARD_BASIC_AUTH_SECRET` | A stable random string (32+ bytes). Without it Hermes generates a random per-process signing key and **every restart logs you out**. |
| `WHATSAPP_ENABLED` | `true` (the image default). WhatsApp stays enabled on an unpaired boot on purpose. |

### Optional (image defaults are already correct)

`HERMES_DASHBOARD_HOST` (`0.0.0.0`), `HERMES_DASHBOARD_PORT` (`9119`),
`HERMES_DASHBOARD_ENABLED` (`true`), `HERMES_HOME` (`/app/data/hermes`),
`GATEWAY_PARK_RETRY_MS` (`30000`), `GATEWAY_BACKOFF_BASE_MS` (`15000`),
`GATEWAY_BACKOFF_MAX_MS` (`300000`), `GATEWAY_GRACE_MS` (`70000`),
`GATEWAY_ENABLED` (`true`), `WHATSAPP_HOME_CHANNEL`.

### Explicitly NOT needed

`MONGODB_URI`, `REDIS_URL`, `SESSION_SECRET`, `AI_API_KEY`, `CAI_HOOK_SECRET`,
`CAI_HOOK_BASE_URL`, `CLIENT_ORIGIN`, `VITE_API_URL`, `TRUST_PROXY`, `HOST`,
`PORT`, `ADMIN_*`. Nothing in this image reads them.

### Secret handling

* Never commit secrets. `.env` is in `.dockerignore` and `.gitignore`.
* Nothing is baked into the image — no `ARG`/`ENV` default holds a secret.
* Neither `entrypoint.sh` nor `supervisor.mjs` ever prints a value, only
  variable names and non-secret settings.
* Rotate the dashboard password if it is ever exposed: the dashboard is a full
  Hermes control panel (config, keys, sessions, files).

---

## 5. Persistent storage

Attach a persistent volume at **`/app/data`**. Nothing else needs persisting.

```
/app/data/hermes/                         <- HERMES_HOME (the whole point of the volume)
├── config.yaml                           seeded on first boot; yours to edit after
├── platforms/whatsapp/session/creds.json <- WhatsApp credentials  ** BACK THIS UP **
├── platforms/whatsapp/session/app_state.json
├── state.db  shared-state.db  kanban.db
├── sessions/  logs/  cache/  cron/  memories/
```

* The **first** deployment must start with **no** `creds.json` so you can pair
  from the dashboard. The image ships an empty Hermes home; the local
  `~/.hermes` is never copied in.
* If the platform also supports a second mount, `/app/data/whatsapp-auth` is
  created for parity with the combined deployment but Hermes does not require
  it.
* Losing `/app/data` means re-pairing WhatsApp. Export a copy of
  `platforms/whatsapp/session/` somewhere safe.

---

## 6. Health, and the unpaired case

`HEALTHCHECK` polls Hermes' own auth-exempt endpoint:

```
GET http://127.0.0.1:$HERMES_DASHBOARD_PORT/api/health
→ 200 {"ok":true,"version":"0.21.3","auth_required":true}
```

**Healthy means "Hermes is running". It does NOT mean "WhatsApp is paired."**
There is no fake probe and no probe that reports pairing.

### What happens before you pair

WhatsApp stays **enabled**. The gateway's WhatsApp preflight finds no
`creds.json` and Hermes exits with code **78**
(`GATEWAY_FATAL_CONFIG_EXIT_CODE`):

```
[Whatsapp] WhatsApp is enabled but not paired (no creds.json at
/app/data/hermes/platforms/whatsapp/session/creds.json).
Pair from the dashboard or run `hermes whatsapp`; remove WHATSAPP_ENABLED …
[supervisor] gateway parked (exit 78: fatal config, normally "WhatsApp enabled
but not paired"). Retrying in 30s — pair WhatsApp from the dashboard (Channels)
in the meantime.
```

`supervisor.mjs` **parks** the gateway and retries every `GATEWAY_PARK_RETRY_MS`.
The container stays up and the dashboard stays reachable. WhatsApp is *not*
disabled to make the container look healthy.

Gateway exit-code contract the supervisor implements:

| Exit | Meaning | Supervisor action |
|---|---|---|
| `78` | fatal config (normally unpaired) | park, retry in 30s |
| `75` | service restart requested | restart immediately |
| `0` | clean stop (e.g. scale-to-zero idle) | restart shortly |
| other / signal | crash | exponential backoff, 15s → 300s cap |

The dashboard is treated as critical: if it exits, the container exits 1 so the
platform restarts it rather than lingering with no reachable interface.

---

## 7. First-time WhatsApp pairing (exact procedure)

Hermes' CLI pairing wizard (`hermes whatsapp`) calls `_require_tty("whatsapp")`,
so it **cannot** run in a headless container. The dashboard is the supported
headless path.

1. Deploy. The container comes up `healthy`; the gateway is parked, waiting.
2. Open the dashboard: `https://<your-blitz-domain>/`.
   `/` redirects to `/login` (302).
3. Log in with `HERMES_DASHBOARD_BASIC_AUTH_USERNAME` / `_PASSWORD`.
4. Go to **Channels** (URL path `/channels`).
5. Find the **WhatsApp** card and start the setup/onboarding flow.
6. Scan the QR code (or open the `https://wa.me/settings/linked_devices#…`
   link) with the phone: **WhatsApp → Settings → Linked devices → Link a
   device**.
7. The card turns to **Connected**. `creds.json` is written to
   `/app/data/hermes/platforms/whatsapp/session/`.
8. Within ~30s the supervisor's next gateway attempt passes the preflight and
   the gateway connects. The dashboard also asks Hermes to restart the gateway
   itself; either path lands on the same place.

Equivalent API calls, if you prefer to script it:

```bash
# log in and keep the session cookie
curl -s -c cj.txt -X POST "$DASH/auth/password-login" \
  -H 'Content-Type: application/json' \
  -d '{"provider":"basic","username":"<user>","password":"<password>"}'

# start pairing
curl -s -b cj.txt -X POST "$DASH/api/messaging/whatsapp/onboarding/start" \
  -H 'Content-Type: application/json' -d '{"mode":"self-chat"}'
# → {"pairing_id":"…","status":"installing", …}

# poll for the QR / connection
curl -s -b cj.txt "$DASH/api/messaging/whatsapp/onboarding/<pairing_id>"

# give up / clean up
curl -s -b cj.txt -X DELETE "$DASH/api/messaging/whatsapp/onboarding/<pairing_id>"
```

---

## 8. Verify the deployment

```bash
# 1. container is up and the dashboard is serving Hermes
curl -s https://<domain>/api/health
# {"ok":true,"version":"0.21.3","auth_required":true}

# 2. it is gated, not wide open
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://<domain>/
# 302 https://<domain>/login?next=%2F

# 3. only the dashboard port is public
ss -ltn | grep 9119        # inside the container: 0.0.0.0:9119

# 4. the gateway is parked, not crashing the container
#    (look for "gateway parked (exit 78" in the logs)

# 5. after pairing: the gateway connects and the parked message stops
```

Locally, with Docker:

```bash
docker build -f deploy/blitz/hermes/Dockerfile -t hermes-blitz:test .
docker volume create hermes-test-data
docker run --rm --name hermes-test -p 9119:9119 \
  -v hermes-test-data:/app/data \
  -e HERMES_DASHBOARD_BASIC_AUTH_USERNAME=admin \
  -e HERMES_DASHBOARD_BASIC_AUTH_PASSWORD='<a test password>' \
  -e HERMES_DASHBOARD_BASIC_AUTH_SECRET='<32+ random bytes>' \
  -e GROQ_API_KEY='<key>' \
  hermes-blitz:test
curl -s http://127.0.0.1:9119/api/health
```

Use a throwaway volume — **never** mount the real `~/.hermes` or a real
paired session into a test.

---

## 9. Troubleshooting

**The container exits immediately with a dashboard auth FATAL.**
A `0.0.0.0` bind requires an auth provider. Set
`HERMES_DASHBOARD_BASIC_AUTH_USERNAME` + `_PASSWORD`. `--insecure` does not
bypass this. Check you did not set the username without a password.

**`Refusing to bind dashboard to 0.0.0.0 — the auth gate engages …`**
Same cause, reported by Hermes instead of the entrypoint (e.g. the entrypoint
preflight was bypassed). Set the auth variables.

**The dashboard never binds; the log only says `Building web UI…`.**
The web SPA was not prebuilt, so Hermes is running `npm install` + `vite
build` at startup, which cannot finish in the container. Confirm the image was
built with the `dashboard-build` stage and that `HERMES_WEB_DIST` points at a
directory containing `index.html`.

**`cannot create persistent dir /app/data`**
No persistent volume is mounted at `/app/data`, or it is not writable by uid
1000. Fix the mount/ownership in the platform and redeploy.

**The dashboard is up but every reply fails with 401.**
`GROQ_API_KEY` is missing or wrong. The container is still healthy — that is
why the health probe says nothing about the model.

**`WhatsApp enabled but not paired` and it never clears.**
That is the expected pre-pairing state. Go to the dashboard → Channels and
finish pairing. If you already paired, confirm
`/app/data/hermes/platforms/whatsapp/session/creds.json` exists and is
readable by uid 1000, and watch for the next `starting Hermes gateway` line.

**Pairing QR expires / session is stuck.**
Restart pairing from Channels. Pairings are time-limited; the API returns
`status: "expired"` after the TTL. Deleting the session directory
(`platforms/whatsapp/session/`) forces a clean re-pair.

**WhatsApp connects then immediately disconnects.**
Usually an expired/invalid session. Re-pair from Channels.

**The gateway is parked but the container is not restarted by the platform.**
It should not be: exit 78 is handled in-process. If you see the *container*
exiting, the **dashboard** died — check the `dashboard` log lines, they are
prefixed separately from `hermes`.

**Still seeing `Customer AI API listening on …` in the logs.**
You are running the production image. The root `Dockerfile` is the combined
one — run `./deploy/blitz/hermes/use-as-blitz-root.sh` and redeploy.

---

## 10. Verified vs unverified

**Verified locally** (real Hermes 0.21.3, pinned commit, temp `HERMES_HOME`):
entrypoint start-up and config seeding; first-boot vs. restored-volume
behaviour; dashboard binds `0.0.0.0` and serves on 9119; `/api/health` returns
200 unauthenticated; `/` 302s to `/login`; password login; the WhatsApp
onboarding API returning a real `wa.me` linking code; the gateway exiting 78
while unpaired; the supervisor parking and retrying indefinitely; the
container staying up and healthy; graceful SIGTERM shutdown with no leftover
processes; the auth and unwritable-persistent-dir fail-fast paths; the root
Dockerfile swap/restore round-trip.

**Not verified here** (no Docker daemon on this machine — the socket is
`root:root` with no `docker` group and `sudo` needs a password): the image
build itself, the resulting image size, the `uv sync` / `npm ci` / `vite build`
steps inside the build, and the real Blitz deploy. Those are the first things
to check when you run it on Blitz.
