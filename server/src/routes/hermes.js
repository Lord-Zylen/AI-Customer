import crypto from 'node:crypto';
import { Router } from 'express';
import {
  createConversationRecord,
  decideInbound,
  inboundDedupeKey,
  preflightInbound,
  preferredInboundExternalId,
  recordOutboundAi,
} from '../services/message-processing.service.js';
import {
  assertPaymentAllowed,
  getConversationContext,
  getLatestOrderStatus,
  markPaymentStarted,
  saveOrderDraft,
} from '../services/conversation-state.service.js';
import { createPaymentLink, getPaymentStatus } from '../services/paystack.service.js';
import { listProducts } from '../services/product-catalog.js';

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

router.get('/status', (req, res) => res.json({ secretConfigured: secretConfigured(), endpoints: ['webhook/gate', 'webhook/event', 'webhook/knowledge', 'webhook/conversation-context', 'webhook/order-draft', 'webhook/order-status', 'webhook/payment-link', 'webhook/payment-status'] }));

function textAndMedia(body) {
  const media = Array.isArray(body?.media_urls) && body.media_urls.length > 0;
  const content = (body?.message ?? body?.text ?? '').trim();
  const messageId = String(body?.message_id || '').trim() || null;
  const mediaTypes = Array.isArray(body?.media_types) ? body.media_types.map((v) => String(v || '').toLowerCase()) : [];
  const isVoice = body?.is_voice === true || mediaTypes.includes('ptt') || mediaTypes.includes('voice') || mediaTypes.includes('audio/ogg; codecs=opus');
  const transcriptStatus = String(body?.transcript_status || '').trim() || null;
  return { content, media, messageId, mediaTypes, isVoice, transcriptStatus };
}

router.post('/webhook/gate', requireHookSecret, async (req, res, next) => {
  try {
    const { platform, chat_id, user_id, user_name, preflight_only } = req.body || {};
    if (platform !== 'whatsapp' || !chat_id) {
      return res.status(400).json({ error: { message: 'Only whatsapp messages with a chat_id are supported.' } });
    }
    if (preflight_only === true) {
      const result = await preflightInbound({ chatId: chat_id });
      return res.json({ action: result.action, reason: result.reason, eligible: result.eligible });
    }
    const { content, media, messageId, mediaTypes, isVoice, transcriptStatus } = textAndMedia(req.body);
    if (!content && !media) return res.json({ action: 'allow', reason: 'No ingestible text or media; Hermes handles it normally.' });
    if (isVoice && !content && media && !['success', 'failed', 'empty', 'unsupported', 'timeout'].includes(transcriptStatus || '')) {
      // Voice metadata arrived without a transcript; the Hermes plugin must
      // transcribe eligible voice notes before final gate decision.
      return res.json({ action: 'allow', reason: 'Voice note requires transcript enrichment before decision.', needs_transcript: true });
    }
    const externalId = preferredInboundExternalId({ messageId, chatId: chat_id, content: isVoice ? `voice:${messageId || content}` : content });
    const result = await decideInbound({ chatId: chat_id, name: user_name || user_id, content, externalId, messageId, media, voice: isVoice, transcriptStatus });
    const payload = { action: result.action, reason: result.reason };
    if (result.response) payload.response = result.response;
    if (result.needs_transcript) payload.needs_transcript = true;
    res.json(payload);
  } catch (e) { next(e); }
});

router.post('/webhook/event', requireHookSecret, async (req, res, next) => {
  try {
    const { event, chat_id, user_id, user_name, session_id, message, message_id } = req.body || {};
    if (event === 'agent:start') {
      const content = String(message || '').trim();
      const externalId = preferredInboundExternalId({ messageId: message_id, chatId: chat_id, content });
      const recorded = content
        ? await createConversationRecord({ chatId: chat_id, name: user_name || user_id, content, externalId })
        : { created: false };
      if (recorded.created) {
        await decideInbound({ chatId: chat_id, name: user_name || user_id, content, externalId, messageId: message_id });
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
    // Prefer the most recently updated profile so a corrected business record wins
    // over any older duplicate; never let a proxy/browser cache serve stale menu data.
    const settings = await BusinessSettings.findOne().sort({ updatedAt: -1 }).lean();
    res.set('Cache-Control', 'no-store');
    // Prices come from the authoritative catalogue, not from free-text settings,
    // so the agent can only quote amounts the backend will actually charge.
    res.json({ settings: settings || {}, products: listProducts() });
  } catch (e) { next(e); }
});

router.get('/webhook/conversation-context', requireHookSecret, async (req, res, next) => {
  try {
    const chatId = String(req.query.chat_id || '').trim();
    if (!chatId) {
      return res.status(400).json({ error: { message: 'A WhatsApp chat_id is required.' } });
    }
    const context = await getConversationContext(chatId);
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, context });
  } catch (e) { next(e); }
});

router.post('/webhook/order-draft', requireHookSecret, async (req, res, next) => {
  try {
    const body = req.body || {};
    if (body.platform && body.platform !== 'whatsapp') {
      return res.status(400).json({ error: { message: 'Only whatsapp order drafts are supported.' } });
    }
    const chatId = String(body.chat_id || '').trim();
    if (!chatId) {
      return res.status(400).json({ error: { message: 'A WhatsApp chat_id is required.' } });
    }
    const saved = await saveOrderDraft({
      chatId,
      items: body.items,
      readyForConfirmation: body.ready_for_confirmation === true,
    });
    res.json({
      ok: true,
      state: saved.state,
      items: saved.quote.items,
      total: saved.quote.total,
      totalMinor: saved.quote.totalMinor,
      currency: saved.quote.currency,
      next_step: saved.state === 'AWAITING_CONFIRMATION'
        ? 'Show this itemised order and total, then ask the customer to confirm explicitly.'
        : 'Continue collecting or reviewing the order; do not ask for payment yet.',
    });
  } catch (e) {
    if (e?.status) return res.status(e.status).json({ error: { message: e.message } });
    next(e);
  }
});

router.post('/webhook/order-status', requireHookSecret, async (req, res, next) => {
  try {
    const chatId = String(req.body?.chat_id || '').trim();
    if (!chatId) {
      return res.status(400).json({ error: { message: 'A WhatsApp chat_id is required.' } });
    }
    const status = await getLatestOrderStatus({
      chatId,
      reference: String(req.body?.reference || '').trim(),
    });
    res.json({ ok: true, ...status });
  } catch (e) {
    if (e?.status) return res.status(e.status).json({ error: { message: e.message } });
    next(e);
  }
});

router.post('/webhook/payment-link', requireHookSecret, async (req, res, next) => {
  try {
    const body = req.body || {};
    if (body.platform && body.platform !== 'whatsapp') {
      return res.status(400).json({ error: { message: 'Only whatsapp payment links are supported.' } });
    }
    const chatId = String(body.chat_id || '').trim();
    // Financial boundary: the backend, not the LLM, verifies that this exact
    // basket was reviewed and explicitly confirmed by the customer.
    const guard = await assertPaymentAllowed({ chatId, items: body.items });
    const result = await createPaymentLink({
      chatId,
      sessionId: body.session_id || '',
      customerName: body.user_name || body.user_id || '',
      customerEmail: body.customer_email,
      amount: body.amount,
      currency: body.currency,
      description: body.description,
      items: body.items,
    });
    await markPaymentStarted(guard.conversation, result.reference);
    res.json({ ok: true, ...result });
  } catch (e) {
    if (e?.status) return res.status(e.status).json({ error: { message: e.message } });
    next(e);
  }
});

async function paymentStatus(req, res, next) {
  try {
    const reference = String(req.body?.reference || req.query?.reference || '').trim();
    if (!reference) {
      return res.status(400).json({ error: { message: 'A payment reference is required.' } });
    }
    const status = await getPaymentStatus(reference);
    res.json({ ok: true, ...status });
  } catch (e) {
    if (e?.status) return res.status(e.status).json({ error: { message: e.message } });
    next(e);
  }
}

router.post('/webhook/payment-status', requireHookSecret, paymentStatus);
router.get('/webhook/payment-status', requireHookSecret, paymentStatus);

export default router;
