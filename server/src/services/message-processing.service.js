import crypto from 'node:crypto';
import Customer from '../models/Customer.js';
import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';
import { generateAiDecision, handoffReasonForIntent } from './ai.service.js';
import { applyDecisionToConversation, recordMentionedProducts } from './conversation-state.service.js';
import { addHuman, clearProcessing, currentRateFor, markProcessing, pushInbound } from './redis.service.js';

const NORMALIZE_LEN = 400;
const HANDOFF_ACK = "I've received your message and passed it to a team member. They'll reply here shortly.";
const HANDOFF_FAILURE_ACK = "I'm having a little trouble right now, so I've passed your message to a team member. They'll reply here shortly.";
// Message.content has a mongoose maxlength of 5000, but validation throws
// instead of truncating. Hermes agent:end responses (and raw inbound text) can
// exceed that, so coerce to a trimmed string and cap before storing. The
// dedupe key is derived from the 400-char normalize() slice, so truncating the
// stored content never changes message identity.
const MAX_CONTENT_LEN = 5000;

const normalize = (value) => String(value || '').trim().toLowerCase().slice(0, NORMALIZE_LEN);
const coerceContent = (value) => String(value ?? '').trim().slice(0, MAX_CONTENT_LEN);

export function inboundDedupeKey(chatId, content) {
  return `in:${crypto.createHash('sha1').update(`${chatId}|${normalize(content)}`).digest('hex')}`;
}

export function preferredInboundExternalId({ messageId, chatId, content }) {
  const stable = String(messageId || '').trim();
  if (stable) return `wam:${crypto.createHash('sha1').update(stable).digest('hex')}`;
  return inboundDedupeKey(chatId, content);
}

export function outboundDedupeKey(sessionId, response) {
  return `ai:${crypto.createHash('sha1').update(`${sessionId}|${normalize(response)}`).digest('hex')}`;
}

export function humanOutboundDedupeKey(conversationId, content) {
  return `hum:${crypto.createHash('sha1').update(`${conversationId}|${normalize(content)}`).digest('hex')}`;
}

async function ensureCustomer({ phone, name }) {
  let customer = await Customer.findOne({ phone });
  if (!customer) customer = await Customer.create({ phone, name: name || 'WhatsApp customer' });
  return customer;
}

async function findOpenConversation(customerId) {
  const conversation = await Conversation.findOne({ customerId, status: { $ne: 'RESOLVED' } }).sort({ updatedAt: -1 });
  if (conversation) return conversation;
  return Conversation.create({ customerId });
}

/**
 * Move a conversation into human handling exactly once. The first handoff gets a
 * single acknowledgement; later messages are preserved without another customer-
 * visible notice or a duplicate human-queue notification.
 */
async function markHuman(conversation, { chatId, reason, ackText = HANDOFF_ACK, alwaysAck = false }) {
  const firstHandoff = !(conversation.requiresHuman || conversation.status === 'HUMAN_REQUIRED');
  if (firstHandoff) {
    conversation.requiresHuman = true;
    conversation.status = 'HUMAN_REQUIRED';
    conversation.handoffReason = String(reason || 'HUMAN_REQUIRED').slice(0, 120);
    conversation.handoffAt = new Date();
  } else if (!conversation.handoffReason) {
    conversation.handoffReason = String(reason || 'HUMAN_REQUIRED').slice(0, 120);
  }

  // Re-publish on every handoff message. The Redis structures are idempotent
  // (set/hash), and this repairs the human queue if Redis was unavailable during
  // the first handoff. It never creates a duplicate customer-visible notice.
  await addHuman(conversation.id, {
    chatId,
    reason: conversation.handoffReason,
    updatedAt: new Date().toISOString(),
  });

  let response;
  if (ackText && (alwaysAck || !conversation.handoffAcknowledgedAt)) {
    response = ackText;
    if (!conversation.handoffAcknowledgedAt) conversation.handoffAcknowledgedAt = new Date();
  }
  await conversation.save();
  return response;
}

async function createInboundIdempotent({ conversation, customer, content, externalId }) {
  if (externalId) {
    const existing = await Message.findOne({ externalId }).select('_id');
    if (existing) return { inbound: existing, created: false };
  }
  try {
    const inbound = await Message.create({ conversationId: conversation.id, customerId: customer.id, content, direction: 'INBOUND', senderType: 'CUSTOMER', externalId });
    return { inbound, created: true };
  } catch (err) {
    if (err?.code === 11000 && externalId) {
      const existing = await Message.findOne({ externalId });
      if (existing) return { inbound: existing, created: false };
    }
    throw err;
  }
}

export async function createConversationRecord({ chatId, name, content, externalId, messageType = null, voice = false, media = false }) {
  const text = coerceContent(content);
  if (!chatId || (!text && !media)) {
    return { conversation: null, inbound: null, customer: null, created: false, reason: 'Nothing ingestible was received.' };
  }
  const customer = await ensureCustomer({ phone: chatId, name });
  const conversation = await findOpenConversation(customer.id);
  const stored = text || (voice ? '[Voice message]' : '[Media message]');
  const { inbound, created } = await createInboundIdempotent({ conversation, customer, content: stored, externalId });
  if (created && (messageType || voice) && !inbound.metadata) {
    // Message schema has no metadata field today; keep stored content meaningful.
  }
  conversation.lastMessageAt = new Date();
  await conversation.save();
  return { customer, conversation, inbound, created };
}

/**
 * Safe pre-flight for voice handling: checks whether the sender may have a
 * transcript processed without creating records, incrementing rate limits,
 * tracking inbound state, or running the AI decision. Human-required and
 * AI-paused conversations still admit STT so the transcript reaches the human;
 * the final gate records it and blocks the AI reply. Rate limiting and full
 * decisioning happen on the real transcript-bearing inbound.
 */
export async function preflightInbound({ chatId }) {
  if (!chatId) return { eligible: false, action: 'skip', reason: 'INVALID_CHAT' };
  try {
    const customer = await Customer.findOne({ phone: chatId }).select('_id').lean();
    if (!customer) return { eligible: true, action: 'allow', reason: 'No existing conversation; eligible for voice processing.' };
    const conversation = await Conversation.findOne({ customerId: customer._id || customer.id, status: { $ne: 'RESOLVED' } }).sort({ updatedAt: -1 }).select('aiEnabled requiresHuman status').lean();
    if (!conversation) return { eligible: true, action: 'allow', reason: 'No open conversation; eligible for voice processing.' };
    // Human-handled conversations still need the transcript so the owner can see
    // what the customer said. The final gate records it and blocks the AI reply.
    if (!conversation.aiEnabled) return { eligible: true, action: 'allow', reason: 'AI_PAUSED', handoff: true, conversationId: String(conversation._id || '') };
    if (conversation.requiresHuman || conversation.status === 'HUMAN_REQUIRED') return { eligible: true, action: 'allow', reason: 'HUMAN_REQUIRED', handoff: true, conversationId: String(conversation._id || '') };
    return { eligible: true, action: 'allow', reason: 'Conversation eligible for voice processing.', conversationId: String(conversation._id || '') };
  } catch (err) {
    // Fail closed operationally, but do not let a DB lookup failure break the
    // authenticated preflight contract; final gate still performs full checks.
    return { eligible: true, action: 'allow', reason: 'Preflight lookup unavailable; final gate will decide.' };
  }
}

export async function decideInbound({ chatId, name, content, externalId, messageId = null, media = false, voice = false, transcriptStatus = null }) {
  const messageType = voice ? 'voice_note' : (media ? 'media' : 'text');
  const resolvedExternalId = externalId || preferredInboundExternalId({ messageId, chatId, content: voice ? `voice:${messageId || content}` : content });
  const { customer, conversation, inbound, created, reason } = await createConversationRecord({ chatId, name, content, externalId: resolvedExternalId, media, voice, messageType });
  if (!inbound) return { action: 'allow', reason: reason || 'AI decision unavailable; let Hermes handle it.', conversation: null, inbound: null, decision: null };
  if (created) {
    await trackInbound(chatId, content, resolvedExternalId);
    const rate = await currentRateFor(chatId);
    if (rate.limited) {
      const response = await markHuman(conversation, { chatId, reason: 'RATE_LIMITED' });
      return { action: 'skip', reason: 'RATE_LIMITED', conversation, inbound, decision: { intent: null, confidence: 0, requiresHuman: true }, response };
    }
  }
  if (voice && transcriptStatus && transcriptStatus !== 'success') {
    const failureReply = "I couldn't clearly understand your voice note. Please resend it or type your request, and a team member can assist if needed.";
    await markHuman(conversation, {
      chatId,
      reason: 'VOICE_TRANSCRIPT_FAILED',
      ackText: failureReply,
      alwaysAck: true,
    });
    return {
      action: 'skip',
      reason: 'VOICE_TRANSCRIPT_FAILED',
      conversation,
      inbound,
      decision: { intent: null, confidence: 0, requiresHuman: true, reason: 'Voice transcript unavailable.' },
      response: failureReply,
    };
  }
  if (!conversation.aiEnabled) {
    const response = await markHuman(conversation, { chatId, reason: 'AI_PAUSED' });
    return {
      action: 'skip',
      reason: 'AI_PAUSED',
      conversation,
      inbound,
      decision: { intent: null, confidence: 0, requiresHuman: true },
      response,
    };
  }
  // Human handoff is sticky. A new inbound message must never re-enable the AI
  // just because a low-risk message (for example "Hi") was classified as safe.
  if (conversation.requiresHuman || conversation.status === 'HUMAN_REQUIRED') {
    const response = await markHuman(conversation, { chatId, reason: 'HUMAN_REQUIRED' });
    return {
      action: 'skip',
      reason: 'HUMAN_REQUIRED',
      conversation,
      inbound,
      decision: { intent: null, confidence: 0, requiresHuman: true },
      response,
    };
  }
  let decision = null;
  if (created || !inbound.aiIntent) {
    try {
      const history = await Message.find({ conversationId: conversation.id }).sort({ createdAt: 1 });
      decision = await generateAiDecision(content, history, { conversation });
    } catch (error) {
      // Preserve the inbound message and hand the conversation to a human rather
      // than letting a decision failure become an unguarded AI reply.
      decision = {
        intent: null,
        confidence: 0,
        requiresHuman: true,
        response: null,
        reason: 'The AI decision layer was unavailable.',
        failed: true,
      };
    }
    inbound.aiIntent = decision.intent;
    inbound.aiConfidence = decision.confidence;
    await inbound.save();
  }
  // Context tracking is independent of the reply path. It lets a later "is it
  // available?" or "that one" resolve to the item the customer just mentioned.
  recordMentionedProducts(conversation, content);
  if (decision) applyDecisionToConversation(conversation, decision);
  const needsHuman = decision ? decision.requiresHuman : Boolean(conversation.requiresHuman);
  if (needsHuman) {
    const reason = handoffReasonForIntent(decision?.intent)
      || (decision?.intent ? decision?.reason : 'UNKNOWN')
      || 'UNKNOWN';
    const ackText = decision?.failed ? HANDOFF_FAILURE_ACK : HANDOFF_ACK;
    const response = await markHuman(conversation, { chatId, reason, ackText });
    return { action: 'skip', reason: 'HUMAN_REQUIRED', conversation, inbound, decision, response };
  }
  await conversation.save();
  if (created) await clearProcessing(resolvedExternalId);
  return { action: 'allow', reason: 'AI reply permitted by policy.', conversation, inbound, decision };
}

async function trackInbound(chatId, content, externalId) {
  const at = new Date().toISOString();
  await markProcessing(externalId, { chatId, at });
  await pushInbound({ externalId, chatId, snippet: coerceContent(content).slice(0, 200), at });
}

export async function recordOutboundAi({ chatId, response, sessionId, intent = null, confidence = null }) {
  if (!chatId || !response || !sessionId) return { message: null, reason: 'Incomplete agent:end payload.' };
  const content = coerceContent(response);
  if (!content) return { message: null, reason: 'agent:end carried no reply text.' };
  const customer = await Customer.findOne({ phone: chatId });
  if (!customer) return { message: null, reason: 'Unknown customer; skipping.' };
  const conversation = await Conversation.findOne({ customerId: customer.id, status: { $ne: 'RESOLVED' } }).sort({ updatedAt: -1 });
  if (!conversation) return { message: null, reason: 'Unknown conversation; skipping.' };
  const externalId = outboundDedupeKey(sessionId, content);
  const existing = await Message.findOne({ externalId }).select('_id');
  if (existing) return { message: existing };
  try {
    const message = await Message.create({ conversationId: conversation.id, customerId: customer.id, content, direction: 'OUTBOUND', senderType: 'AI', aiIntent: intent, aiConfidence: confidence, externalId });
    conversation.lastMessageAt = new Date();
    await conversation.save();
    return { message };
  } catch (err) {
    // Concurrent agent:end delivers (Hermes retries, dedupe in-flight duplicate)
    // can land on the same content at the same time; treat the loser as a no-op.
    if (err?.code === 11000 && externalId) {
      const already = await Message.findOne({ externalId });
      if (already) return { message: already };
    }
    throw err;
  }
}