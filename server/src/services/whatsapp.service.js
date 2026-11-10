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

/**
 * Send through the Hermes-owned WhatsApp connection. `hermes send` reuses the
 * gateway's existing platform credentials/session, so Customer AI never opens a
 * second WhatsApp connection.
 *
 * Returns `{ status: 'SENT' | 'QUEUED', messageId }`:
 *   - SENT   the CLI reported success AND a real platform message id.
 *   - QUEUED the CLI accepted the send but reported no message id; delivery is
 *            not confirmed.
 * Anything else is thrown as a delivery failure. Only the caller's delivery
 * tracker may record success, and a missing id is never invented.
 *
 * Verified against the installed Hermes Agent v0.21.3 source: `hermes send
 * --json` emits the `send_message_tool` result, and the WhatsApp bridge send
 * path returns `{ success: true, messageId, messageIds }`. A successful bridge
 * response can legitimately omit `messageId`, so that case is QUEUED rather
 * than SENT.
 */
export async function sendWhatsAppMessage(to, text, { exec = execFile } = {}) {
  if (!to) throw Object.assign(new Error('A WhatsApp destination is required.'), { status: 400 });
  const jid = to.includes('@') ? to : `${to.replace(/\D/g, '')}@s.whatsapp.net`;
  const payload = await new Promise((resolve, reject) => {
    exec(HERMES_BIN, ['send', '--to', `whatsapp:${jid}`, '--json', '--', text], { timeout: 30000, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      let result = {};
      try { result = JSON.parse(stdout || '{}'); } catch { /* non-JSON output */ }
      if (err) {
        const detail = result?.error || (stderr || stdout || '').trim() || err.message;
        reject(Object.assign(new Error(`Hermes send failed: ${detail}`), { status: 502, providerResult: result }));
        return;
      }
      if (result?.error) {
        reject(Object.assign(new Error(`Hermes send failed: ${result.error}`), { status: 502, providerResult: result }));
        return;
      }
      if (result?.skipped) {
        reject(Object.assign(new Error(`Hermes skipped the message: ${result.reason || result.note || 'unknown reason'}`), { status: 502, providerResult: result }));
        return;
      }
      if (result?.success !== true) {
        reject(Object.assign(new Error('Hermes did not confirm the WhatsApp send.'), { status: 502, providerResult: result }));
        return;
      }
      resolve(result);
    });
  });
  const messageId = String(payload?.message_id ?? '').trim();
  return { status: messageId ? 'SENT' : 'QUEUED', messageId };
}