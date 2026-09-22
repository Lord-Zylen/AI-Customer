import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';

const HERMES_HOME = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');
const GATEWAY_STATE_PATH = process.env.HERMES_GATEWAY_STATE || path.join(HERMES_HOME, 'gateway_state.json');
const HERMES_BIN = process.env.HERMES_BIN || 'hermes';
// The Hermes gateway only rewrites gateway_state.json on lifecycle transitions
// and agent turn boundaries; the 30s heartbeat lives in a separate file
// (state/gateway.heartbeat). A healthy but idle gateway can therefore leave the
// state file untouched for a long time. Age alone is thus only a *suspicion*;
// the decisive signal is whether the recorded gateway PID is still alive and
// matches the recorded start_time (same PID-reuse guard Hermes itself uses).
const STATE_STALE_MS = Number(process.env.HERMES_STATE_STALE_MS) || 300000;

const UNAVAILABLE_MESSAGE = 'WhatsApp status is unavailable right now.';

let cachedState = { status: 'DISCONNECTED', qr: null, phone: null, updatedAt: null, error: null, managedBy: 'hermes' };

function stateIsStale(updatedAt) {
  const ts = Date.parse(updatedAt);
  return Number.isNaN(ts) ? true : Date.now() - ts > STATE_STALE_MS;
}

function processStartTimeTicks(pid) {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').trim().split(/\s+/);
    const startTime = Number(fields[21]);
    return Number.isNaN(startTime) ? null : startTime;
  } catch {
    return null;
  }
}

function processIsAlive(pid, startTime) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error?.code !== 'EPERM') return false;
  }
  if (startTime == null) return true;
  const current = processStartTimeTicks(pid);
  if (current == null) return true;
  const recorded = Number(startTime);
  return recorded > 0 && Math.abs(current - recorded) <= 0.001;
}

async function readGatewayState() {
  try {
    const raw = await readFile(GATEWAY_STATE_PATH, 'utf8');
    const data = JSON.parse(raw);
    const whatsapp = data?.platforms?.whatsapp;
    const connected = whatsapp?.state === 'connected' && data?.gateway_state === 'running';
    const stale = stateIsStale(data?.updated_at) && !processIsAlive(data?.pid, data?.start_time);
    const effectivelyConnected = connected && !stale;
    cachedState = {
      status: effectivelyConnected ? 'CONNECTED' : 'DISCONNECTED',
      qr: null,
      phone: null,
      updatedAt: data?.updated_at || null,
      stale,
      error: effectivelyConnected
        ? null
        : (stale ? 'The Hermes gateway stopped reporting status; check that it is running.' : (whatsapp?.error_message || 'Hermes gateway is not connected to WhatsApp yet.')),
      managedBy: 'hermes',
      gatewayState: data?.gateway_state || null,
    };
  } catch {
    cachedState = { ...cachedState, status: 'DISCONNECTED', qr: null, stale: true, error: UNAVAILABLE_MESSAGE, gatewayState: null };
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