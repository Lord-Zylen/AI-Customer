# Customer AI

Customer AI is a WhatsApp customer service workspace. Hermes triages messages, responds only from approved business data, and routes sensitive or uncertain cases to the human queue.

## Run locally

1. Copy `.env.example` to `.env` and set secrets and `MONGODB_URI`.
2. Run `npm run install:all`.
3. Run `npm run dev` and open `http://localhost:5173`.

The frontend is a WhatsApp inbox with a human-review queue, business settings that feed Hermes, a WhatsApp pairing screen, and a system-status page. The Express server exposes `/api/health`, `/api/hermes/process-message`, and the WhatsApp conversation APIs.

## Integration boundaries

`server/src/services/hermes.service.js` is the Hermes orchestration boundary; replace its rule-based starter with the Hermes SDK/configuration. Keep WhatsApp gateway code in a dedicated service and call the Hermes route after webhook validation.

## Deploy with WhatsApp QR pairing

1. Create `.env` from `.env.example`. Set strong, unique `SESSION_SECRET`, `POSTGRES_PASSWORD`, and `WHATSAPP_SETUP_TOKEN` values.
2. Start Customer AI and PostgreSQL: `docker compose up -d --build`.
3. Publish port `5000` through a TLS reverse proxy. Customer AI serves both the web app and `/api` from that port.
4. Open **WhatsApp setup** in Customer AI, enter the setup token, generate the QR code, then scan it in WhatsApp: **Settings → Linked devices → Link a device**.

The named `whatsapp_auth` Docker volume retains the WhatsApp session across deployment restarts. Do not delete it unless you intentionally want to pair a new account.

QR pairing uses Baileys and the WhatsApp Web protocol; it is not Meta’s official Business API. It is suitable for a consent-based operational account. For Meta-approved high-volume messaging, replace the adapter in `server/src/services/whatsapp.service.js` with WhatsApp Business Cloud API while preserving its interface.
