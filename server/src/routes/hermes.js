import crypto from 'node:crypto';
import { Router } from 'express';
import {
  createConversationRecord,
  decideInbound,
  inboundDedupeKey,
  recordOutboundAi,
} from '../services/message-processing.service.js';
import { triageMessage } from '../services/hermes.service.js';

const router = Router();

function secretConfigured() {
  return Boolean(process.env.CAI_HOOK_SECRET);
}

function verifySecret(req) {
  const provided = req.get('x-cai-hook-secret') || '';
  const expected = process.env.CAI_HOOK_SECRET || '';
  if (!provided || provided.length !== expected.length) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return crypto.timingSafeEqual(a, b);
}

function requireHookSecret(req, res, next) {
  if (!secretConfigured()) {
    return res.status(503).json({ error: { message: 'Hermes integration requires CAI_HOOK_SECRET to be configured on the server.' } });
  }
  if (!req.get('x-cai-hook-secret') || !verifySecret(req)) {
    return res.status(401).json({ error: { message: 'Invalid Hermes hook secret.' } });
  }
  next();
}

router.get('/status', (req, res) => res.json({ secretConfigured: secretConfigured(), endpoints: ['webhook/gate', 'webhook/event', 'webhook/knowledge'] }));

router.post('/process-message', async (req, res, next) => {
  try { res.json(await triageMessage(req.body)); } catch (e) { next(e); }
});

function textAndMedia(body) {
  const media = Array.isArray(body?.media_urls) && body.media_urls.length > 0;
  const content = (body?.message ?? body?.text ?? '').trim();
  return { content, media };
}

router.post('/webhook/gate', requireHookSecret, async (req, res, next) => {
  try {
    const { platform, chat_id, user_id, user_name } = req.body || {};
    if (platform !== 'whatsapp' || !chat_id) {
      return res.status(400).json({ error: { message: 'Only whatsapp messages with a chat_id are supported.' } });
    }
    const { content, media } = textAndMedia(req.body);
    if (!content && !media) return res.json({ action: 'allow', reason: 'No ingestible text or media; Hermes handles it normally.' });
    const result = await decideInbound({ chatId: chat_id, name: user_name || user_id, content, externalId: inboundDedupeKey(chat_id, content), media });
    res.json({ action: result.action, reason: result.reason });
  } catch (e) { next(e); }
});

router.post('/webhook/event', requireHookSecret, async (req, res, next) => {
  try {
    const { event, chat_id, user_id, user_name, session_id, message } = req.body || {};
    if (event === 'agent:start') {
      const content = String(message || '').trim();
      const recorded = content
        ? await createConversationRecord({ chatId: chat_id, name: user_name || user_id, content, externalId: inboundDedupeKey(chat_id, content) })
        : { created: false };
      if (recorded.created) {
        await decideInbound({ chatId: chat_id, name: user_name || user_id, content, externalId: inboundDedupeKey(chat_id, content) });
      }
      return res.json({ ok: true, recorded: Boolean(recorded.created) });
    }
    if (event === 'agent:end') {
      const outbound = await recordOutboundAi({ chatId: chat_id, response: req.body?.response, sessionId: session_id });
      return res.json({ ok: true, recorded: Boolean(outbound.message) });
    }
    return res.json({ ok: true, ignored: true });
  } catch (e) { next(e); }
});

router.get('/webhook/knowledge', requireHookSecret, async (req, res, next) => {
  try {
    const { default: BusinessSettings } = await import('../models/BusinessSettings.js');
    const settings = await BusinessSettings.findOne().lean();
    res.json({ settings: settings || {} });
  } catch (e) { next(e); }
});

export default router;