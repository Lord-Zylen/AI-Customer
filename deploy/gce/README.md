# Customer AI — Google Compute Engine deployment

Target VM: `customer-ai-server` (`europe-west1-b`, Ubuntu 24.04, user
`wisest569`). The backend runs on `127.0.0.1:9119`; Nginx is the only public
HTTP surface. Hermes remains the only WhatsApp transport owner.

These files are deployment assets only. Do not run the `sudo` commands, open
firewall ports, pair WhatsApp, or switch Paystack to live mode without the
operator's approval.

## Files

| File | Purpose |
| --- | --- |
| `customer-ai.service` | systemd unit for the Node backend |
| `hermes-gateway.service` | systemd unit for the Hermes gateway |
| `customer-ai.conf` | Nginx reverse proxy for the full site (`/` → `127.0.0.1:9119`) |
| `../../.env.example` | shared environment template for both processes |

The root `Dockerfile` on this branch is Hermes-only and is **not** used here.
This deployment uses the repository directly with systemd + Nginx.

## 1. Install OS packages

```bash
sudo apt-get update
sudo apt-get install -y git curl build-essential python3 python3-venv \
  nginx certbot python3-certbot-nginx
node -v
npm -v
```

The backend unit assumes `node` is `/usr/bin/node`. If `command -v node` prints
another path (for example an nvm path), edit `ExecStart` in
`deploy/gce/customer-ai.service` before installing it.

## 2. Get the repository

```bash
cd /home/wisest569
git clone https://github.com/Lord-Zylen/AI-Customer.git AI-Customer
cd AI-Customer
git checkout hermes-only-blitz
```

If the repository already exists, update it instead of cloning again:

```bash
cd /home/wisest569/AI-Customer
git fetch origin
git checkout hermes-only-blitz
git pull --ff-only origin hermes-only-blitz
```

## 3. Install Hermes (pinned to the verified version)

Use the same pinned commit as the production Dockerfile (Hermes Agent `v0.21.3`,
`4716ec0ba4e212105f8f162c226f052b25f8a76b`). Do not run a local developer's
Hermes home or copy a real WhatsApp session to the VM.

```bash
mkdir -p /home/wisest569/.hermes
# Skip the clone if the checkout already exists.
if [ ! -d /home/wisest569/.hermes/hermes-agent/.git ]; then
  git clone https://github.com/NousResearch/hermes-agent.git /home/wisest569/.hermes/hermes-agent
fi
git -C /home/wisest569/.hermes/hermes-agent fetch --depth 1 origin \
  4716ec0ba4e212105f8f162c226f052b25f8a76b
git -C /home/wisest569/.hermes/hermes-agent checkout --detach FETCH_HEAD

cd /home/wisest569/.hermes/hermes-agent
curl -LsSf https://astral.sh/uv/install.sh | sh
/home/wisest569/.local/bin/uv venv /home/wisest569/.hermes/hermes-agent/venv --python python3
UV_PROJECT_ENVIRONMENT=/home/wisest569/.hermes/hermes-agent/venv \
  /home/wisest569/.local/bin/uv sync --extra all --locked
npm ci --prefix scripts/whatsapp-bridge
```

Create the `hermes` launcher used by the backend's `hermes send` path:

```bash
mkdir -p /home/wisest569/.local/bin
cat > /home/wisest569/.local/bin/hermes <<'EOF'
#!/usr/bin/env bash
unset PYTHONPATH PYTHONHOME
exec "$HOME/.hermes/hermes-agent/venv/bin/python" "$HOME/.hermes/hermes-agent/hermes" "$@"
EOF
chmod +x /home/wisest569/.local/bin/hermes
/home/wisest569/.local/bin/hermes --version
```

## 4. Install the Customer AI Hermes config, plugin and hook

```bash
cd /home/wisest569/AI-Customer
mkdir -p /home/wisest569/.hermes/plugins/customer-ai-gate \
         /home/wisest569/.hermes/hooks/customer_ai_tap
cp -a hermes/plugins/customer-ai-gate/. /home/wisest569/.hermes/plugins/customer-ai-gate/
cp -a hermes/hooks/customer_ai_tap/. /home/wisest569/.hermes/hooks/customer_ai_tap/

# Only seed the template when no config exists yet. If one exists, merge the
# provider/plugin/platform settings manually instead of overwriting it.
if [ ! -f /home/wisest569/.hermes/config.yaml ]; then
  cp hermes/configuration/config.yaml /home/wisest569/.hermes/config.yaml
fi
chmod 600 /home/wisest569/.hermes/config.yaml
```

The config must keep `plugins.enabled: [customer-ai-gate]`, the `custom:groq`
provider (`key_env: GROQ_API_KEY`), and `platforms.whatsapp.enabled: true`.
`WHATSAPP_HOME_CHANNEL` is supplied by `.env`, not hardcoded in the config.

## 5. Create the shared environment file

```bash
cd /home/wisest569/AI-Customer
# Never overwrite an existing .env: create it only when it is absent.
test -f .env || cp .env.example .env
chmod 600 .env
```

Edit `.env` and fill in the real values. Do **not** overwrite an existing `.env`
without approval. At minimum:

- `MONGODB_URI`
- `SESSION_SECRET` (long random string)
- `GROQ_API_KEY`
- `CAI_HOOK_SECRET` (same value for backend and Hermes — they share this file)
- `PAYSTACK_SECRET_KEY` (use a test key until live payments are approved)
- `PAYSTACK_DEFAULT_EMAIL` (a real business inbox)
- `ADMIN_EMAIL` / `ADMIN_PASSWORD` (only if seeding a new database)
- `CLIENT_ORIGIN` (the public URL, for example `https://customer-ai.example.com`)
- `WHATSAPP_HOME_CHANNEL` only if an operator chat should bypass the AI gate

Keep `PORT=9119`, `HOST=0.0.0.0`, `CAI_HOOK_BASE_URL=http://127.0.0.1:9119`, and
`PAYSTACK_CURRENCY=GHS` unless the catalogue changes. Redis is optional; leave
`REDIS_URL` blank to run without it.

## 6. Install Node dependencies and build the frontend

```bash
cd /home/wisest569/AI-Customer
npm ci --prefix server --omit=dev
npm ci --prefix client
npm run build --prefix client
```

The Express server serves `client/dist`, and Nginx proxies the whole site to the
backend, so no separate frontend host or `VITE_API_URL` is required. Make sure
`client/.env` does not contain an old `VITE_API_URL` pointing at another backend.

## 7. Seed the admin (new/empty database only)

```bash
cd /home/wisest569/AI-Customer
npm run seed --prefix server
```

**Warning:** `server/src/utils/seed.js` deletes all users, customers,
conversations, messages and business settings before seeding. Run it only on a
fresh empty database, never after real production data exists.

Then ensure the order uniqueness index exists (non-destructive):

```bash
npm run db:ensure-order-index --prefix server
```

Make sure the MongoDB Atlas network access list allows this VM's egress address
(or the Atlas project's approved range). Do not change Atlas networking without
approval.

## 8. Install and start systemd services

```bash
sudo cp /home/wisest569/AI-Customer/deploy/gce/customer-ai.service /etc/systemd/system/
sudo cp /home/wisest569/AI-Customer/deploy/gce/hermes-gateway.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now customer-ai
sudo systemctl status customer-ai --no-pager
```

Check the backend locally (MongoDB must be reachable for `200`):

```bash
curl -i http://127.0.0.1:9119/api/health
```

Do not start `hermes-gateway` until WhatsApp is paired. Hermes exits with code
`78` when WhatsApp is enabled but not paired; the unit is configured not to
restart-loop in that state.

## 9. Pair WhatsApp (one-time, no automatic linking)

Keep the public site closed until pairing is complete. Use an SSH tunnel to the
loopback-only Hermes dashboard:

```bash
# On your workstation:
ssh -L 9120:127.0.0.1:9120 wisest569@<vm-public-ip>

# On the VM:
/home/wisest569/.local/bin/hermes dashboard --host 127.0.0.1 --port 9120 --no-open
```

Open `http://127.0.0.1:9120` on your workstation, pair WhatsApp under Channels,
then stop the dashboard. The first dashboard start may build its web UI and can
take several minutes. The session is stored under
`/home/wisest569/.hermes/platforms/whatsapp/session/` and persists across
restarts. Never publish the QR or copy a developer session into this VM.

Then start the gateway:

```bash
sudo systemctl enable --now hermes-gateway
sudo journalctl -u hermes-gateway -f
```

The backend and gateway must both use `/home/wisest569/.hermes` and the same
`CAI_HOOK_SECRET`. The systemd units set this explicitly.

## 10. Configure Nginx and HTTPS

```bash
sudo cp /home/wisest569/AI-Customer/deploy/gce/customer-ai.conf \
  /etc/nginx/sites-available/customer-ai
sudo ln -sfn /etc/nginx/sites-available/customer-ai /etc/nginx/sites-enabled/customer-ai
# Disable Ubuntu's placeholder site so it cannot answer first on port 80.
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

Point DNS at the VM, then obtain TLS (Paystack webhooks need public HTTPS):

```bash
sudo certbot --nginx -d customer-ai.example.com
```

After HTTPS is active, set `CLIENT_ORIGIN=https://customer-ai.example.com` in
`.env`, then `sudo systemctl restart customer-ai`.

GCP firewall: allow inbound TCP `80` and `443` only, and only with approval. Do
**not** open `9119`; Nginx reaches it over loopback.

## 11. Post-deploy checks

```bash
curl -fsS https://customer-ai.example.com/api/health
sudo systemctl status customer-ai hermes-gateway nginx --no-pager
sudo journalctl -u customer-ai -n 100 --no-pager
sudo journalctl -u hermes-gateway -n 100 --no-pager
```

- Log in with the seeded admin account.
- Send a WhatsApp message from a non-operator number and confirm one reviewable
  reply; confirm a sensitive/low-confidence message goes to the human queue.
- In Paystack test mode, configure the webhook as
  `https://customer-ai.example.com/api/payments/paystack/webhook` and verify a
  test payment flips the order to `PAID` exactly once.
- Back up `/home/wisest569/.hermes` and rely on MongoDB Atlas backups. Losing the
  Hermes home can require re-pairing WhatsApp.
