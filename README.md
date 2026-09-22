# Customer AI

Customer AI is a WhatsApp customer service workspace. Hermes triages messages, responds only from approved business data, and routes sensitive or uncertain cases to the human queue.

## Run locally

1. Copy `.env.example` to `.env` and set secrets and `MONGODB_URI`.
2. Run `npm run install:all`.
3. Run `npm run dev` and open `http://localhost:5173`.

The frontend is a WhatsApp inbox with a human-review queue, business settings that feed Hermes, a WhatsApp pairing screen, and a system-status page. The Express server exposes `/api/health`, the Hermes webhooks (`/api/hermes/webhook/gate`, `/api/hermes/webhook/event`, `/api/hermes/webhook/knowledge`), and the WhatsApp conversation APIs.

## Integration boundaries

WhatsApp is owned by the Hermes gateway (single connection). Hermes calls Customer AI's `pre_gateway_dispatch` plugin and mirror hooks (`~/.hermes/plugins/customer-ai-gate`, `~/.hermes/hooks/customer_ai_tap`), which POST to `/api/hermes/webhook/*`. Human replies from the dashboard are sent through the `hermes send` CLI via `server/src/services/whatsapp.service.js`.

## Production deployment

Target architecture (supported, native — no Docker required):

- **Vercel** serves `/client` (Vite React) with `VITE_API_URL` pointing at the VPS API.
- **VPS** runs the Node backend (`server/`, `node src/server.js`) behind Nginx (HTTPS) + the Hermes gateway as a systemd service. Hermes owns the WhatsApp session in its persistent `~/.hermes` directory; the bridge is spawned by the gateway.
- **MongoDB Atlas** stays external (`MONGODB_URI`).

Read `customer-ai-debug-report.txt` for the full runbook. Deployment templates:

- `client/vercel.json` — Vercel SPA routing; deploy with build `npm run build`, output `dist`.
- `deploy/systemd/customer-ai.service` — backend service.
- `deploy/systemd/hermes-gateway.service` — Hermes gateway service (spawns the WhatsApp bridge).
- `deploy/nginx/customer-ai.conf` — reverse proxy template (`https://api.example.com` → `127.0.0.1:5000`).
- `.env.example` — full production environment reference.

WhatsApp pairing happens **after** the VPS and Nginx are working, and only on the VPS's persistent Hermes directory. Never reset or copy the local session during deployment.
