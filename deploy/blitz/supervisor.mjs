// ============================================================================
// Customer AI — container process supervisor (Render, runs as PID 1)
//
// Starts the Customer AI Node backend, waits for /api/health, then starts the
// Hermes gateway (which spawns the WhatsApp Baileys bridge as its own child).
// Optionally starts the Hermes dashboard, which provides the WhatsApp pairing
// (QR) flow for platforms with no interactive console.
// - propagates SIGTERM/SIGINT/SIGHUP to both children (gateway first, so it
//   can flush the WhatsApp session; backend second)
// - exits non-zero if either critical service dies unexpectedly
// - kills lingerers only after a grace period
//
// No third-party dependencies (Node 22 stdlib only).
// ============================================================================

import { spawn } from 'node:child_process';

const HERMES_AGENT_DIR = '/opt/hermes-agent';
const GATEWAY_PY = '/opt/hermes-agent/venv/bin/python';
const HERMES_BIN = process.env.HERMES_BIN || '/home/customerai/.local/bin/hermes';
const HERMES_ENABLED = String(process.env.HERMES_ENABLED ?? 'true').toLowerCase() !== 'false';
// Opt-in (default off). The dashboard binds 0.0.0.0, so Hermes requires an auth
// provider (HERMES_DASHBOARD_BASIC_AUTH_* or HERMES_DASHBOARD_OAUTH_CLIENT_ID)
// to be configured or it refuses to start.
const HERMES_DASHBOARD_ENABLED = /^(true|1|yes)$/i.test(String(process.env.HERMES_DASHBOARD ?? '').trim());
const HERMES_DASHBOARD_PORT = Number(process.env.HERMES_DASHBOARD_PORT || 9119);
const PORT = process.env.PORT || 8080;
const BACKEND_WAIT_MS = Number(process.env.BACKEND_WAIT_MS || 120000);
const HEALTH_POLL_MS = 1000;
const GATEWAY_GRACE_MS = Number(process.env.GATEWAY_GRACE_MS || 70000);
const BACKEND_GRACE_MS = Number(process.env.BACKEND_GRACE_MS || 20000);

const children = new Map();
let stopping = false;

const ts = () => new Date().toISOString();
const log = (prefix, msg) => process.stdout.write(`[${ts()}] ${prefix} ${msg}\n`);

const makeLogger = (prefix) => (chunk) => {
  for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) log(prefix, line);
};

function startBackend() {
  log('supervisor', `starting Customer AI backend (node src/server.js, port ${PORT})`);
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: '/app/server',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', makeLogger('backend'));
  child.stderr.on('data', makeLogger('backend'));
  child.on('error', (err) => {
    log('supervisor', `Customer AI backend spawn error: ${err.message}`);
    shutdown(1);
  });
  child.on('exit', (code, signal) => {
    log('supervisor', `Customer AI backend exited (code=${code}, signal=${signal})`);
    if (!stopping) shutdown(1);
  });
  children.set('backend', child);
  return child;
}

function startGateway() {
  log('supervisor', 'starting Hermes gateway (python -m hermes_cli.main gateway run)');
  const child = spawn(GATEWAY_PY, ['-m', 'hermes_cli.main', 'gateway', 'run'], {
    cwd: HERMES_AGENT_DIR,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', makeLogger('hermes'));
  child.stderr.on('data', makeLogger('hermes'));
  child.on('error', (err) => {
    log('supervisor', `Hermes gateway spawn error: ${err.message}`);
    shutdown(1);
  });
  child.on('exit', (code, signal) => {
    log('supervisor', `Hermes gateway exited (code=${code}, signal=${signal})`);
    if (!stopping) shutdown(1);
  });
  children.set('gateway', child);
  return child;
}

// Third supervised child. Serves the Hermes dashboard, whose WhatsApp onboarding
// endpoints return the pairing QR as JSON. Runs only when explicitly enabled and
// authenticates with the normal Hermes dashboard auth (never --insecure).
function startDashboard() {
  log('supervisor', `starting Hermes dashboard (hermes dashboard, port ${HERMES_DASHBOARD_PORT})`);
  const child = spawn(
    HERMES_BIN,
    ['dashboard', '--host', '0.0.0.0', '--port', String(HERMES_DASHBOARD_PORT), '--no-open'],
    {
      cwd: HERMES_AGENT_DIR,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout.on('data', makeLogger('dashboard'));
  child.stderr.on('data', makeLogger('dashboard'));
  child.on('error', (err) => {
    log('supervisor', `Hermes dashboard spawn error: ${err.message}`);
    shutdown(1);
  });
  child.on('exit', (code, signal) => {
    log('supervisor', `Hermes dashboard exited (code=${code}, signal=${signal})`);
    if (!stopping) shutdown(1);
  });
  children.set('dashboard', child);
  return child;
}

async function waitForBackend() {
  const deadline = Date.now() + BACKEND_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.status === 200) {
        log('supervisor', `Customer AI backend healthy at http://127.0.0.1:${PORT}/api/health`);
        return true;
      }
    } catch {
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
  }
  return false;
}

function waitExit(child, graceMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    const hard = setTimeout(() => {
      log('supervisor', `grace period elapsed for pid ${child.pid}; sending SIGKILL`);
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      setTimeout(finish, 5000);
    }, graceMs);
    child.once('exit', () => {
      clearTimeout(hard);
      finish();
    });
  });
}

function shutdown(exitCode) {
  if (stopping) return;
  stopping = true;
  log('supervisor', `shutting down (container exit code ${exitCode})`);
  const gateway = children.get('gateway');
  const dashboard = children.get('dashboard');
  const backend = children.get('backend');
  (async () => {
    // Gateway first: its graceful shutdown flushes the WhatsApp session.
    if (gateway && gateway.exitCode === null) {
      log('supervisor', `sending SIGTERM to Hermes gateway (pid ${gateway.pid})`);
      try {
        gateway.kill('SIGTERM');
      } catch { /* already gone */ }
      await waitExit(gateway, GATEWAY_GRACE_MS);
    }
    if (dashboard && dashboard.exitCode === null) {
      log('supervisor', `sending SIGTERM to Hermes dashboard (pid ${dashboard.pid})`);
      try {
        dashboard.kill('SIGTERM');
      } catch { /* already gone */ }
      await waitExit(dashboard, BACKEND_GRACE_MS);
    }
    if (backend && backend.exitCode === null) {
      log('supervisor', `sending SIGTERM to Customer AI backend (pid ${backend.pid})`);
      try {
        backend.kill('SIGTERM');
      } catch { /* already gone */ }
      await waitExit(backend, BACKEND_GRACE_MS);
    }
    log('supervisor', 'shutdown complete');
    process.exit(exitCode);
  })();
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
process.on('SIGHUP', () => shutdown(0));

const backend = startBackend();
const healthy = await waitForBackend();

if (!healthy) {
  log('supervisor', `Customer AI backend did not reach /api/health within ${BACKEND_WAIT_MS}ms — exiting 1`);
  shutdown(1);
} else if (HERMES_ENABLED) {
  startGateway();
  if (HERMES_DASHBOARD_ENABLED) {
    startDashboard();
  } else {
    log('supervisor', 'HERMES_DASHBOARD is not enabled — skipping the Hermes dashboard');
  }
} else {
  log('supervisor', 'HERMES_ENABLED=false — skipping Hermes gateway (backend only)');
}