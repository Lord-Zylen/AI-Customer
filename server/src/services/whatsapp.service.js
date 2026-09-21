import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const HERMES_HOME = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');
const GATEWAY_STATE_PATH = process.env.HERMES_GATEWAY_STATE || path.join(HERMES_HOME, 'gateway_state.json');
const HERMES_BIN = process.env.HERMES_BIN || 'hermes';

let cachedState = { status: 'DISCONNECTED', qr: null, phone: null, updatedAt: null, error: null, managedBy: 'hermes' };

async function readGatewayState() {
  try {
    const raw = await readFile(GATEWAY_STATE_PATH, 'utf8');
    const data = JSON.parse(raw);
    const whatsapp = data?.platforms?.whatsapp;
    const connected = whatsapp?.state === 'connected' && data?.gateway_state === 'running';
    cachedState = {
      status: connected ? 'CONNECTED' : 'DISCONNECTED',
      qr: null,
      phone: null,
      updatedAt: data?.updated_at || null,
      error: connected ? null : (whatsapp?.error_message || 'Hermes gateway is not connected to WhatsApp yet.'),
      managedBy: 'hermes',
      gatewayState: data?.gateway_state || null,
    };
  } catch {
    cachedState = { ...cachedState, status: 'DISCONNECTED', qr: null, error: null, gatewayState: null };
  }
  return cachedState;
}

export async function getWhatsAppStatus() {
  return readGatewayState();
}

export function getWhatsAppQr() {
  return null;
}

export async function connectWhatsApp() {
  throw Object.assign(new Error('WhatsApp is managed by the Hermes gateway; use Hermes to pair and connect it.'), { status: 409 });
}

export async function disconnectWhatsApp() {
  throw Object.assign(new Error('WhatsApp is managed by the Hermes gateway; it cannot be disconnected from Customer AI.'), { status: 409 });
}

export async function resetWhatsAppSession() {
  throw Object.assign(new Error('WhatsApp is managed by the Hermes gateway; reset its session from Hermes.'), { status: 409 });
}

export async function sendWhatsAppMessage(to, text) {
  if (!to) throw Object.assign(new Error('A WhatsApp destination is required.'), { status: 400 });
  const jid = to.includes('@') ? to : `${to.replace(/\D/g, '')}@s.whatsapp.net`;
  await new Promise((resolve, reject) => {
    execFile(HERMES_BIN, ['send', '--to', `whatsapp:${jid}`, text], { timeout: 30000, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = (stderr || stdout || '').trim();
        reject(Object.assign(new Error(`Hermes send failed: ${detail || err.message}`), { status: 502 }));
        return;
      }
      resolve();
    });
  });
}