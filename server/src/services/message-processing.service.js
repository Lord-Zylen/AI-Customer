import crypto from 'node:crypto';
import Customer from '../models/Customer.js';
import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';
import { generateAiDecision } from './ai.service.js';

const NORMALIZE_LEN = 400;
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

export async function createConversationRecord({ chatId, name, content, externalId, media = false }) {
  const text = coerceContent(content);
  if (!chatId || (!text && !media)) {
    return { conversation: null, inbound: null, customer: null, created: false, reason: 'Nothing ingestible was received.' };
  }
  const customer = await ensureCustomer({ phone: chatId, name });
  const conversation = await findOpenConversation(customer.id);
  const { inbound, created } = await createInboundIdempotent({ conversation, customer, content: text || '[Media message]', externalId });
  conversation.lastMessageAt = new Date();
  await conversation.save();
  return { customer, conversation, inbound, created };
}

export async function decideInbound({ chatId, name, content, externalId, media = false }) {
  const { customer, conversation, inbound, created, reason } = await createConversationRecord({ chatId, name, content, externalId, media });
  if (!inbound) return { action: 'allow', reason: reason || 'AI decision unavailable; let Hermes handle it.', conversation: null, inbound: null, decision: null };
  if (!conversation.aiEnabled) {
    conversation.requiresHuman = true;
    conversation.status = 'HUMAN_REQUIRED';
    await conversation.save();
    return { action: 'skip', reason: 'AI_PAUSED', conversation, inbound, decision: { intent: null, confidence: 0, requiresHuman: true } };
  }
  let decision = null;
  if (created || !inbound.aiIntent) {
    const history = await Message.find({ conversationId: conversation.id }).sort({ createdAt: 1 });
    decision = await generateAiDecision(content, history);
    inbound.aiIntent = decision.intent;
    inbound.aiConfidence = decision.confidence;
    await inbound.save();
  }
  const needsHuman = decision ? decision.requiresHuman : Boolean(conversation.requiresHuman);
  if (needsHuman) {
    conversation.requiresHuman = true;
    conversation.status = 'HUMAN_REQUIRED';
    await conversation.save();
    return { action: 'skip', reason: 'HUMAN_REQUIRED', conversation, inbound, decision };
  }
  return { action: 'allow', reason: 'AI reply permitted by policy.', conversation, inbound, decision };
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