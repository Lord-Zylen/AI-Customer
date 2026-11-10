import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import hermesRouter from '../src/routes/hermes.js';

process.env.CAI_HOOK_SECRET = process.env.CAI_HOOK_SECRET || 'test-voice-hook-secret';

function sign(req) { req.set('x-cai-hook-secret', process.env.CAI_HOOK_SECRET); }

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/hermes', hermesRouter);
  app.use((err, req, res, next) => res.status(err?.status || 500).json({ error: { message: err?.message || 'boom' } }));
  return app;
}

async function withServer(app, fn) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise((r) => server.close(r)); }
}

test('hook secret required for voice/transcript gate payloads', async () => {
  const res = await fetch(`data:,`);
  // quick sanity: auth behavior is enforced by route; use real app
  const body = await withServer(makeApp(), async (base) => {
    const r = await fetch(`${base}/api/hermes/webhook/gate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'whatsapp', chat_id: 'x', is_voice: true, message_id: 'm1', transcript_status: 'success', message: 'hi' }),
    });
    return { status: r.status, json: await r.json() };
  });
  assert.equal(body.status, 401);
});

test('preferred message_id dedupe key is stable and differs from content key', async () => {
  const mp = await import('../src/services/message-processing.service.js');
  const a = mp.preferredInboundExternalId({ messageId: 'wam-abc', chatId: 'c1', content: 'hi' });
  const b = mp.preferredInboundExternalId({ messageId: 'wam-abc', chatId: 'c1', content: 'different' });
  const c = mp.preferredInboundExternalId({ messageId: null, chatId: 'c1', content: 'hi' });
  assert.equal(a, b);
  assert.match(a, /^wam:/);
  assert.notEqual(a, c);
  assert.match(c, /^in:/);
});

test('voice without transcript status requests enrichment, not fake decision', async () => {
  const result = await withServer(makeApp(), async (base) => {
    const r = await fetch(`${base}/api/hermes/webhook/gate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-cai-hook-secret': process.env.CAI_HOOK_SECRET },
      body: JSON.stringify({ platform: 'whatsapp', chat_id: '233000@s.whatsapp.net', is_voice: true, media_urls: ['/tmp/fake.ogg'], message_id: 'm2', message: '' }),
    });
    return r.json();
  });
  assert.equal(result.action, 'allow');
  assert.equal(result.needs_transcript, true);
});

test('preflight_only is side-effect light and does not require transcript', async () => {
  const result = await withServer(makeApp(), async (base) => {
    const r = await fetch(`${base}/api/hermes/webhook/gate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-cai-hook-secret': process.env.CAI_HOOK_SECRET },
      body: JSON.stringify({ platform: 'whatsapp', chat_id: '233111@s.whatsapp.net', preflight_only: true }),
    });
    return { status: r.status, json: await r.json() };
  });
  assert.equal(result.status, 200);
  assert.ok(['allow', 'skip'].includes(result.json.action));
  assert.equal(typeof result.json.eligible, 'boolean');
});
