import crypto from 'node:crypto';
import Customer from '../models/Customer.js';
import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';
import { generateAiDecision } from './ai.service.js';

const NORMALIZE_LEN = 400;

const normalize = (value) => String(value || '').trim().toLowerCase().slice(0, NORMALIZE_LEN);

export function inboundDedupeKey(chatId, content) {
  return `in:${crypto.createHash('sha1').update(`${chatId}|${normalize(content)}`).digest('hex')}`;
}

export function outboundDedupeKey(sessionId, response) {
  return `ai:${crypto.createHash('sha1').update(`${sessionId}|${normalize(response)}`).digest('hex')}`;
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
  if (!chatId || (!content && !media)) {
    return { conversation: null, inbound: null, customer: null, created: false, reason: 'Nothing ingestible was received.' };
  }
  const customer = await ensureCustomer({ phone: chatId, name });
  const conversation = await findOpenConversation(customer.id);
  const { inbound, created } = await createInboundIdempotent({ conversation, customer, content: content || '[Media message]', externalId });
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
  const customer = await Customer.findOne({ phone: chatId });
  if (!customer) return { message: null, reason: 'Unknown customer; skipping.' };
  const conversation = await Conversation.findOne({ customerId: customer.id, status: { $ne: 'RESOLVED' } }).sort({ updatedAt: -1 });
  if (!conversation) return { message: null, reason: 'Unknown conversation; skipping.' };
  const externalId = outboundDedupeKey(sessionId, response);
  const existing = await Message.findOne({ externalId }).select('_id');
  if (existing) return { message: existing };
  const message = await Message.create({ conversationId: conversation.id, customerId: customer.id, content: response, direction: 'OUTBOUND', senderType: 'AI', aiIntent: intent, aiConfidence: confidence, externalId });
  conversation.lastMessageAt = new Date();
  await conversation.save();
  return { message };
}

export async function processIncomingCustomerMessage({ phone, content, name }) {
  if (!phone || !content) throw Object.assign(new Error('Phone and message content are required.'), { status: 400 });
  return decideInbound({ chatId: phone, name, content, externalId: inboundDedupeKey(phone, content) });
}