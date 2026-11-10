import test from 'node:test';
import assert from 'node:assert/strict';
import Customer from '../src/models/Customer.js';
import Conversation from '../src/models/Conversation.js';
import Message from '../src/models/Message.js';

process.env.REDIS_URL = '';
process.env.AI_API_KEY = '';

const { decideInbound, preflightInbound } = await import('../src/services/message-processing.service.js');

function stub(t, target, key, value) {
  const original = target[key];
  target[key] = value;
  t.after(() => { target[key] = original; });
}

function preflightMocks(t, conversation) {
  stub(t, Customer, 'findOne', () => ({
    select: () => ({ lean: async () => ({ _id: 'customer-1' }) }),
  }));
  stub(t, Conversation, 'findOne', () => ({
    sort: () => ({
      select: () => ({ lean: async () => conversation }),
    }),
  }));
}

function decideMocks(t, conversation, created) {
  stub(t, Customer, 'findOne', async () => ({ id: 'customer-1', _id: 'customer-1' }));
  stub(t, Conversation, 'findOne', () => ({ sort: async () => conversation }));
  stub(t, Message, 'findOne', () => ({ select: async () => null }));
  stub(t, Message, 'create', async (doc) => {
    created.push(doc);
    return { ...doc, save: async () => {} };
  });
  stub(t, Message, 'find', async () => {
    throw new Error('AI decision must not run while human handoff is active');
  });
}

test('voice preflight admits a human-required conversation so its transcript reaches the human', async (t) => {
  preflightMocks(t, { _id: 'conv-1', aiEnabled: true, requiresHuman: true, status: 'HUMAN_REQUIRED' });
  const result = await preflightInbound({ chatId: 'redacted@s.whatsapp.net' });
  assert.equal(result.eligible, true);
  assert.equal(result.action, 'allow');
  assert.equal(result.reason, 'HUMAN_REQUIRED');
  assert.equal(result.handoff, true);
});

test('voice preflight admits an AI-paused conversation instead of silently dropping the voice note', async (t) => {
  preflightMocks(t, { _id: 'conv-2', aiEnabled: false, requiresHuman: false, status: 'OPEN' });
  const result = await preflightInbound({ chatId: 'redacted@s.whatsapp.net' });
  assert.equal(result.eligible, true);
  assert.equal(result.action, 'allow');
  assert.equal(result.reason, 'AI_PAUSED');
  assert.equal(result.handoff, true);
});

test('voice inbound during handoff records the transcript and sends one holding acknowledgement', async (t) => {
  const created = [];
  const conversation = {
    id: 'conv-1',
    aiEnabled: true,
    requiresHuman: true,
    status: 'HUMAN_REQUIRED',
    save: async () => {},
  };
  decideMocks(t, conversation, created);
  const result = await decideInbound({
    chatId: 'redacted@s.whatsapp.net',
    name: 'Customer',
    content: 'Hi',
    externalId: 'wam:message-1',
    messageId: 'message-1',
    media: true,
    voice: true,
    transcriptStatus: 'success',
  });
  assert.equal(result.action, 'skip');
  assert.equal(result.reason, 'HUMAN_REQUIRED');
  assert.match(result.response, /team member/i);
  assert.equal(conversation.requiresHuman, true);
  assert.equal(conversation.status, 'HUMAN_REQUIRED');
  assert.equal(created.length, 1);
  assert.equal(created[0].content, 'Hi');
  assert.equal(created[0].direction, 'INBOUND');
});

test('voice inbound while AI is paused records the transcript and acknowledges the human handoff', async (t) => {
  const created = [];
  const conversation = {
    id: 'conv-2',
    aiEnabled: false,
    requiresHuman: false,
    status: 'OPEN',
    save: async () => {},
  };
  decideMocks(t, conversation, created);
  const result = await decideInbound({
    chatId: 'redacted@s.whatsapp.net',
    name: 'Customer',
    content: 'Hi',
    externalId: 'wam:message-3',
    messageId: 'message-3',
    media: true,
    voice: true,
    transcriptStatus: 'success',
  });
  assert.equal(result.action, 'skip');
  assert.equal(result.reason, 'AI_PAUSED');
  assert.match(result.response, /team member/i);
  assert.equal(conversation.requiresHuman, true);
  assert.equal(conversation.status, 'HUMAN_REQUIRED');
  assert.equal(created[0].content, 'Hi');
});

test('voice transcription failure is recorded for the human even when AI is paused', async (t) => {
  const created = [];
  const conversation = {
    id: 'conv-2',
    aiEnabled: false,
    requiresHuman: false,
    status: 'OPEN',
    save: async () => {},
  };
  decideMocks(t, conversation, created);
  const result = await decideInbound({
    chatId: 'redacted@s.whatsapp.net',
    name: 'Customer',
    content: '',
    externalId: 'wam:message-4',
    messageId: 'message-4',
    media: true,
    voice: true,
    transcriptStatus: 'empty',
  });
  assert.equal(result.action, 'skip');
  assert.equal(result.reason, 'VOICE_TRANSCRIPT_FAILED');
  assert.match(result.response, /couldn't clearly understand/i);
  assert.equal(conversation.requiresHuman, true);
  assert.equal(conversation.status, 'HUMAN_REQUIRED');
  assert.equal(created[0].content, '[Voice message]');
});

test('text inbound during handoff gets one acknowledgement and no AI reply', async (t) => {
  const created = [];
  const conversation = {
    id: 'conv-1',
    aiEnabled: true,
    requiresHuman: true,
    status: 'HUMAN_REQUIRED',
    save: async () => {},
  };
  decideMocks(t, conversation, created);
  const first = await decideInbound({
    chatId: 'redacted@s.whatsapp.net',
    name: 'Customer',
    content: 'Hi',
    externalId: 'wam:message-2',
    messageId: 'message-2',
    media: false,
    voice: false,
  });
  assert.equal(first.action, 'skip');
  assert.equal(first.reason, 'HUMAN_REQUIRED');
  assert.match(first.response, /team member/i);
  assert.equal(created.length, 1);
  assert.equal(created[0].content, 'Hi');

  const second = await decideInbound({
    chatId: 'redacted@s.whatsapp.net',
    name: 'Customer',
    content: 'Are you there?',
    externalId: 'wam:message-3',
    messageId: 'message-3',
    media: false,
    voice: false,
  });
  assert.equal(second.action, 'skip');
  assert.equal(second.response, undefined);
  assert.equal(created.length, 2);
});

function allowMocks(t, conversation, created, history = []) {
  stub(t, Customer, 'findOne', async () => ({ id: 'customer-1', _id: 'customer-1' }));
  stub(t, Conversation, 'findOne', () => ({ sort: async () => conversation }));
  stub(t, Message, 'findOne', () => ({ select: async () => null }));
  stub(t, Message, 'create', async (doc) => {
    const saved = { ...doc, aiIntent: null, aiConfidence: null, save: async () => {} };
    created.push(saved);
    return saved;
  });
  stub(t, Message, 'find', () => ({ sort: async () => history }));
}

test('a greeting is allowed through without creating an order or a human handoff', async (t) => {
  const created = [];
  const conversation = { id: 'conv-1', aiEnabled: true, requiresHuman: false, status: 'OPEN', save: async () => {} };
  allowMocks(t, conversation, created);
  const result = await decideInbound({
    chatId: 'redacted@s.whatsapp.net',
    name: 'Customer',
    content: 'Hi',
    externalId: 'wam:message-greet',
    messageId: 'message-greet',
  });
  assert.equal(result.action, 'allow');
  assert.equal(result.decision.intent, 'GREETING');
  assert.equal(result.decision.requiresHuman, false);
  assert.equal(conversation.orderDraft, undefined);
  assert.equal(conversation.orderState, undefined);
  assert.equal(created[0].aiIntent, 'GREETING');
});

test('a menu mention is remembered in structured conversation state', async (t) => {
  const created = [];
  const conversation = { id: 'conv-1', aiEnabled: true, requiresHuman: false, status: 'OPEN', save: async () => {} };
  allowMocks(t, conversation, created);
  const result = await decideInbound({
    chatId: 'redacted@s.whatsapp.net',
    name: 'Customer',
    content: 'How much is jollof?',
    externalId: 'wam:message-price',
    messageId: 'message-price',
  });
  assert.equal(result.action, 'allow');
  assert.equal(result.decision.intent, 'PRICE_ENQUIRY');
  assert.equal(conversation.lastDiscussedProductId, 'jollof_rice');
  assert.deepEqual(conversation.lastMentionedProductIds, ['jollof_rice']);
});

test('sensitive messages are recorded then handed off with the existing category', async (t) => {
  for (const [content, reason] of [['I want a refund', 'REFUND'], ['I want to speak to a human', 'UNKNOWN']]) {
    const created = [];
    const conversation = { id: 'conv-1', aiEnabled: true, requiresHuman: false, status: 'OPEN', save: async () => {} };
    allowMocks(t, conversation, created);
    const result = await decideInbound({
      chatId: 'redacted@s.whatsapp.net',
      name: 'Customer',
      content,
      externalId: `wam:${reason}`,
      messageId: reason,
    });
    assert.equal(result.action, 'skip', content);
    assert.equal(result.reason, 'HUMAN_REQUIRED', content);
    assert.match(result.response, /team member/i, content);
    assert.equal(conversation.requiresHuman, true, content);
    assert.equal(conversation.status, 'HUMAN_REQUIRED', content);
  }
});

test('a decision-layer/database failure hands off instead of replying unguarded', async (t) => {
  const created = [];
  const conversation = { id: 'conv-1', aiEnabled: true, requiresHuman: false, status: 'OPEN', save: async () => {} };
  stub(t, Customer, 'findOne', async () => ({ id: 'customer-1', _id: 'customer-1' }));
  stub(t, Conversation, 'findOne', () => ({ sort: async () => conversation }));
  stub(t, Message, 'findOne', () => ({ select: async () => null }));
  stub(t, Message, 'create', async (doc) => {
    const saved = { ...doc, save: async () => {} };
    created.push(saved);
    return saved;
  });
  stub(t, Message, 'find', () => ({ sort: async () => { throw new Error('database unavailable'); } }));

  const result = await decideInbound({
    chatId: 'redacted@s.whatsapp.net',
    name: 'Customer',
    content: 'How much is jollof?',
    externalId: 'wam:message-fail',
    messageId: 'message-fail',
  });
  assert.equal(result.action, 'skip');
  assert.equal(result.reason, 'HUMAN_REQUIRED');
  assert.match(result.response, /trouble/i);
  assert.equal(conversation.requiresHuman, true);
  assert.equal(conversation.handoffReason, 'UNKNOWN');
  assert.equal(created.length, 1);
});
