// ============================================================================
// HERMES-ONLY container process supervisor (Blitz, runs as PID 1)
//
// Starts exactly two Hermes processes:
//
//   1. the DASHBOARD (`hermes dashboard --host 0.0.0.0 --port $PORT --no-open`)
//      — the public web interface and the ONLY way to pair WhatsApp in a
//      headless container. It is CRITICAL: if it dies the container exits
//      non-zero so the platform restarts it.
//
//   2. the GATEWAY (`python -m hermes_cli.main gateway run --external-supervisor`)
//      — connects messaging platforms (the WhatsApp Baileys bridge is spawned
//      by the gateway itself as a child process).
//
// THE UNPAIRED CASE (the whole point of this deployment):
// On a first boot WhatsApp is enabled but there is no creds.json, so the
// gateway's WhatsApp preflight fails and Hermes exits 78
// (GATEWAY_FATAL_CONFIG_EXIT_CODE — "WhatsApp enabled but not paired"). That
// is a PARKED state, not a crash: this supervisor keeps the container alive,
// keeps the dashboard serving, and retries the gateway. Once creds.json lands
// in $HERMES_HOME/platforms/whatsapp/session the next attempt connects.
//
// WhatsApp is NOT disabled to make the container look healthy — the config
// keeps it enabled and the dashboard owns pairing.
//
// Exit-code contract (verified against hermes_cli/gateway/run_startup.py and
// gateway/restart.py in the pinned Hermes commit):
//   78  GATEWAY_FATAL_CONFIG_EXIT_CODE — fatal config, e.g. not paired.
//       systemd's RestartPreventExitStatus / s6's 125 marker. We park and
//       retry on a slow cadence instead of hot-looping.
//   75  GATEWAY_SERVICE_RESTART_EXIT_CODE — a service restart was requested
//       (e.g. the dashboard's post-pairing `hermes gateway restart` sends
//       SIGUSR1, or `/restart`). Restart immediately, no backoff.
//    0  clean stop (e.g. gateway.scale_to_zero idle timeout). Restart shortly.
//
// No third-party dependencies (Node 22 stdlib only). Secrets are never logged.
// ============================================================================

import { spawn } from 'node:child_process';

// Paths are env-overridable purely so the same supervisor can be exercised
// outside the image (the image sets them explicitly and they never change
// there). Defaults match the Dockerfile.
const HERMES_AGENT_DIR = process.env.HERMES_AGENT_DIR || '/opt/hermes-agent';
const GATEWAY_PY = process.env.HERMES_GATEWAY_PY || `${HERMES_AGENT_DIR}/venv/bin/python`;
const HERMES_BIN = process.env.HERMES_BIN || '/home/hermesai/.local/bin/hermes';

const truthy = (v, dflt = false) => {
  if (v === undefined || v === null || String(v).trim() === '') return dflt;
  return /^(true|1|yes|on)$/i.test(String(v).trim());
};
const intEnv = (name, dflt) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

// --- Dashboard ---------------------------------------------------------------
const DASHBOARD_ENABLED = truthy(process.env.HERMES_DASHBOARD_ENABLED, true);
const DASHBOARD_HOST = process.env.HERMES_DASHBOARD_HOST || '0.0.0.0';
const DASHBOARD_PORT = intEnv('HERMES_DASHBOARD_PORT', 9119);

// --- Gateway -----------------------------------------------------------------
const GATEWAY_ENABLED = truthy(process.env.HERMES_GATEWAY_ENABLED, true);
// The web UI is prebuilt in the image (HERMES_WEB_DIST), so the dashboard must
// never try to `npm install` + `vite build` at runtime — that would block the
// bind indefinitely. --skip-build makes the runtime build a no-op and fails
// loudly if the dist is missing, instead of hanging.
const GATEWAY_ARGS = ['-m', 'hermes_cli.main', 'gateway', 'run', '--external-supervisor'];

// Exit codes Hermes uses (gateway/restart.py). Named here so the intent of
// every branch below is obvious at the call site.
const EXIT_FATAL_CONFIG = 78;
const EXIT_SERVICE_RESTART = 75;

// --- Restart policy ----------------------------------------------------------
// Parked (unpaired): retry often enough that pairing feels immediate, slow
// enough to avoid a hot loop against an unpairable account.
const PARK_RETRY_MS = intEnv('GATEWAY_PARK_RETRY_MS', 30000);
// Genuine crash: exponential backoff, capped.
const CRASH_BACKOFF_BASE_MS = intEnv('GATEWAY_BACKOFF_BASE_MS', 15000);
const CRASH_BACKOFF_MAX_MS = intEnv('GATEWAY_BACKOFF_MAX_MS', 300000);
// A gateway that stayed up this long is considered healthy; reset the backoff.
const HEALTHY_UPTIME_MS = intEnv('GATEWAY_HEALTHY_UPTIME_MS', 300000);
// Grace given to the gateway to flush the WhatsApp session on shutdown.
const GATEWAY_GRACE_MS = intEnv('GATEWAY_GRACE_MS', 70000);
const DASHBOARD_GRACE_MS = intEnv('DASHBOARD_GRACE_MS', 20000);

const children = new Map();
let stopping = false;

const ts = () => new Date().toISOString();
const log = (prefix, msg) => process.stdout.write(`[${ts()}] ${prefix} ${msg}\n`);

const makeLogger = (prefix) => (chunk) => {
  for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) log(prefix, line);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitExit(child, graceMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
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
      await waitExit(dashboard, DASHBOARD_GRACE_MS);
    }
    log('supervisor', 'shutdown complete');
    process.exit(exitCode);
  })();
}

// --- Dashboard (critical) ----------------------------------------------------
function startDashboard() {
  log(
    'supervisor',
    `starting Hermes dashboard (hermes dashboard --host ${DASHBOARD_HOST} --port ${DASHBOARD_PORT} --no-open)`,
  );
  const child = spawn(
    HERMES_BIN,
    ['dashboard', '--host', DASHBOARD_HOST, '--port', String(DASHBOARD_PORT), '--no-open', '--skip-build'],
    { cwd: HERMES_AGENT_DIR, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout.on('data', makeLogger('dashboard'));
  child.stderr.on('data', makeLogger('dashboard'));
  child.on('error', (err) => {
    log('supervisor', `Hermes dashboard spawn error: ${err.message}`);
    shutdown(1);
  });
  child.on('exit', (code, signal) => {
    log('supervisor', `Hermes dashboard exited (code=${code}, signal=${signal})`);
    if (stopping) return;
    // The dashboard IS the deliverable of this deployment (it is the pairing
    // UI and the public surface). If it dies the deployment has failed —
    // exit non-zero and let the platform restart the container rather than
    // lingering as a "healthy" service with no reachable interface.
    log('supervisor', 'the Hermes dashboard is the deployment\'s public surface — exiting 1 so the platform restarts it');
    shutdown(1);
  });
  children.set('dashboard', child);
  return child;
}

// --- Gateway (supervised, never fatal) ---------------------------------------
let crashBackoffMs = CRASH_BACKOFF_BASE_MS;

function classifyExit(code, signal) {
  if (signal) return 'signal';
  if (code === EXIT_FATAL_CONFIG) return 'fatal-config';
  if (code === EXIT_SERVICE_RESTART) return 'service-restart';
  if (code === 0) return 'clean';
  return 'crash';
}

function startGatewayOnce() {
  return new Promise((resolve) => {
    log('supervisor', 'starting Hermes gateway (python -m hermes_cli.main gateway run --external-supervisor)');
    const child = spawn(GATEWAY_PY, GATEWAY_ARGS, {
      cwd: HERMES_AGENT_DIR,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.set('gateway', child);
    const startedAt = Date.now();

    child.stdout.on('data', makeLogger('hermes'));
    child.stderr.on('data', makeLogger('hermes'));
    child.on('error', (err) => {
      log('supervisor', `Hermes gateway spawn error: ${err.message}`);
      resolve({ code: null, signal: null, error: err.message });
    });
    child.once('exit', (code, signal) => {
      const uptimeMs = Date.now() - startedAt;
      if (uptimeMs >= HEALTHY_UPTIME_MS) crashBackoffMs = CRASH_BACKOFF_BASE_MS;
      log('supervisor', `Hermes gateway exited (code=${code}, signal=${signal}, uptime=${Math.round(uptimeMs / 1000)}s)`);
      resolve({ code, signal, uptimeMs });
    });
  });
}

async function superviseGateway() {
  while (!stopping) {
    const result = await startGatewayOnce();
    if (stopping) return;

    const kind = classifyExit(result.code, result.signal);
    if (kind === 'service-restart') {
      log('supervisor', 'gateway asked for a service restart (exit 75) — restarting now');
      continue;
    }
    if (kind === 'fatal-config') {
      // Almost always "WhatsApp enabled but not paired". Park, do not crash:
      // the dashboard stays up and the operator pairs from it. The next
      // attempt picks up creds.json automatically.
      log(
        'supervisor',
        `gateway parked (exit ${EXIT_FATAL_CONFIG}: fatal config, normally "WhatsApp enabled but not paired"). ` +
          `Retrying in ${Math.round(PARK_RETRY_MS / 1000)}s — pair WhatsApp from the dashboard (Channels) in the meantime.`,
      );
      await sleep(PARK_RETRY_MS);
      continue;
    }
    if (kind === 'clean') {
      // e.g. gateway.scale_to_zero idle exit. Come back shortly.
      log('supervisor', `gateway exited cleanly — restarting in ${Math.round(CRASH_BACKOFF_BASE_MS / 1000)}s`);
      crashBackoffMs = CRASH_BACKOFF_BASE_MS;
      await sleep(CRASH_BACKOFF_BASE_MS);
      continue;
    }
    if (kind === 'signal' && result.signal === 'SIGUSR1') {
      // A graceful drain requested by `hermes gateway restart` (the dashboard
      // does this right after WhatsApp onboarding). The gateway already
      // flushed; come straight back so it reconnects with the new creds.json.
      log('supervisor', 'gateway drained on SIGUSR1 (restart requested) — restarting now');
      continue;
    }

    // Genuine crash or unknown exit: back off, but never take the container
    // down — the dashboard must keep serving.
    log('supervisor', `gateway crashed (code=${result.code}, signal=${result.signal}) — retrying in ${Math.round(crashBackoffMs / 1000)}s`);
    await sleep(crashBackoffMs);
    crashBackoffMs = Math.min(crashBackoffMs * 2, CRASH_BACKOFF_MAX_MS);
  }
}

// --- Startup -----------------------------------------------------------------
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
process.on('SIGHUP', () => shutdown(0));

log('supervisor', `HERMES-ONLY deployment — no Customer AI backend, no MongoDB, no Redis, no frontend`);
log('supervisor', `dashboard: ${DASHBOARD_HOST}:${DASHBOARD_PORT} (readiness: http://127.0.0.1:${DASHBOARD_PORT}/api/health)`);
log('supervisor', `HERMES_HOME=${process.env.HERMES_HOME || '/app/data/hermes'}`);

if (DASHBOARD_ENABLED) {
  startDashboard();
} else {
  // A Hermes-only deployment with no dashboard has no pairing UI, which is the
  // entire point of this test. Refuse rather than ship a silent dead service.
  log('supervisor', 'FATAL: HERMES_DASHBOARD_ENABLED is false, but WhatsApp pairing in a headless container requires the dashboard. Set it to true.');
  process.exit(1);
}

if (GATEWAY_ENABLED) {
  // Fire and forget: the gateway loop is long-lived and self-restarting.
  superviseGateway().catch((err) => {
    log('supervisor', `gateway supervisor loop crashed: ${err?.message || err}`);
  });
} else {
  log('supervisor', 'HERMES_GATEWAY_ENABLED is false — running the dashboard only (WhatsApp will not connect).');
}
