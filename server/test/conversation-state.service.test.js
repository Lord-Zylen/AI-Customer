import test from 'node:test';
import assert from 'node:assert/strict';
import Customer from '../src/models/Customer.js';
import Conversation from '../src/models/Conversation.js';
import Message from '../src/models/Message.js';
import Order from '../src/models/Order.js';

process.env.AI_API_KEY = '';

const {
  applyDecisionToConversation,
  assertPaymentAllowed,
  getConversationContext,
  getLatestOrderStatus,
  itemsSignature,
  markPaymentStarted,
  recordMentionedProducts,
  OrderStateError,
  saveOrderDraft,
} = await import('../src/services/conversation-state.service.js');
const { buildOrderQuote } = await import('../src/services/product-catalog.js');

function stub(t, target, key, value) {
  const original = target[key];
  target[key] = value;
  t.after(() => { target[key] = original; });
}

function conversation(overrides = {}) {
  return {
    id: 'conv-1',
    _id: 'conv-1',
    status: 'OPEN',
    aiEnabled: true,
    requiresHuman: false,
    orderState: 'IDLE',
    lastIntent: '',
    lastDiscussedProductId: '',
    save: async function save() { this.saved = true; },
    ...overrides,
  };
}

function mockConversation(t, conv) {
  stub(t, Customer, 'findOne', async () => ({ id: 'cust-1', _id: 'cust-1' }));
  stub(t, Conversation, 'findOne', () => ({ sort: async () => conv }));
}

test('saveOrderDraft validates and stores the complete basket with backend totals', async (t) => {
  const conv = conversation();
  mockConversation(t, conv);
  const saved = await saveOrderDraft({
    chatId: 'redacted@s.whatsapp.net',
    items: [{ productId: 'jollof_rice', quantity: 2 }, { productId: 'noodles', quantity: 1 }],
    readyForConfirmation: true,
  });
  assert.equal(saved.state, 'AWAITING_CONFIRMATION');
  assert.equal(saved.quote.total, 90);
  assert.equal(conv.orderState, 'AWAITING_CONFIRMATION');
  assert.equal(conv.orderDraft.totalMinor, 9000);
  assert.deepEqual(conv.orderDraft.items, [
    { productId: 'jollof_rice', quantity: 2 },
    { productId: 'noodles', quantity: 1 },
  ]);
  assert.equal(conv.lastDiscussedProductId, 'noodles');
  assert.equal(conv.saved, true);
});

test('applyDecisionToConversation creates a short-lived confirmation only for the reviewed draft', () => {
  const conv = conversation({
    orderState: 'AWAITING_CONFIRMATION',
    orderDraft: { items: [{ productId: 'fried_rice', quantity: 2 }] },
    orderConfirmation: undefined,
  });
  applyDecisionToConversation(conv, { intent: 'ORDER_CONFIRMATION' });
  assert.equal(conv.orderState, 'CONFIRMED');
  assert.ok(conv.orderConfirmation.confirmedAt);
  assert.equal(conv.orderConfirmation.draftSignature, itemsSignature(buildOrderQuote(conv.orderDraft.items).items));
});

test('order modifications invalidate a confirmation and cancellations clear the draft', () => {
  const modified = conversation({
    orderState: 'CONFIRMED',
    orderDraft: { items: [{ productId: 'jollof_rice', quantity: 1 }] },
    orderConfirmation: { confirmedAt: new Date(), expiresAt: new Date(Date.now() + 60000) },
  });
  applyDecisionToConversation(modified, { intent: 'ORDER_MODIFICATION' });
  assert.equal(modified.orderState, 'COLLECTING_ORDER');
  assert.equal(modified.orderConfirmation, undefined);

  const cancelled = conversation({
    orderState: 'AWAITING_CONFIRMATION',
    orderDraft: { items: [{ productId: 'jollof_rice', quantity: 1 }] },
  });
  applyDecisionToConversation(cancelled, { intent: 'ORDER_CANCELLATION' });
  assert.equal(cancelled.orderState, 'CANCELLED');
  assert.equal(cancelled.orderDraft, undefined);
});

test('payment is rejected without a draft, without confirmation, or for a different basket', async (t) => {
  const noDraft = conversation();
  mockConversation(t, noDraft);
  await assert.rejects(
    assertPaymentAllowed({ chatId: 'redacted@s.whatsapp.net', items: [{ productId: 'jollof_rice', quantity: 1 }] }),
    (error) => error instanceof OrderStateError && /no reviewed order/i.test(error.message),
  );

  const notConfirmed = conversation({
    orderState: 'AWAITING_CONFIRMATION',
    orderDraft: { items: [{ productId: 'jollof_rice', quantity: 1 }] },
  });
  mockConversation(t, notConfirmed);
  await assert.rejects(
    assertPaymentAllowed({ chatId: 'redacted@s.whatsapp.net', items: [{ productId: 'jollof_rice', quantity: 1 }] }),
    (error) => error instanceof OrderStateError && /confirm the final order/i.test(error.message),
  );

  const changed = conversation({
    orderState: 'CONFIRMED',
    orderDraft: { items: [{ productId: 'jollof_rice', quantity: 1 }] },
    orderConfirmation: { confirmedAt: new Date(), expiresAt: new Date(Date.now() + 60000) },
  });
  mockConversation(t, changed);
  await assert.rejects(
    assertPaymentAllowed({ chatId: 'redacted@s.whatsapp.net', items: [{ productId: 'fried_rice', quantity: 1 }] }),
    (error) => error instanceof OrderStateError && /do not match/i.test(error.message),
  );
  assert.equal(changed.orderState, 'COLLECTING_ORDER');
  assert.equal(changed.orderConfirmation, undefined);
});

test('payment is allowed only for the exact confirmed basket and consumed once started', async (t) => {
  const conv = conversation({
    orderState: 'CONFIRMED',
    orderDraft: { items: [{ productId: 'jollof_rice', quantity: 2 }] },
    orderConfirmation: {
      confirmedAt: new Date(),
      expiresAt: new Date(Date.now() + 60000),
      draftSignature: itemsSignature(buildOrderQuote([{ productId: 'jollof_rice', quantity: 2 }]).items),
    },
  });
  mockConversation(t, conv);
  const allowed = await assertPaymentAllowed({
    chatId: 'redacted@s.whatsapp.net',
    items: [{ productId: 'jollof_rice', quantity: 2 }],
  });
  assert.equal(allowed.quote.total, 60);

  await markPaymentStarted(conv, 'CAI-1');
  assert.equal(conv.orderState, 'PAYMENT_PENDING');
  assert.equal(conv.lastOrderReference, 'CAI-1');
  assert.ok(conv.orderConfirmation.consumedAt);

  const reuse = await assertPaymentAllowed({
    chatId: 'redacted@s.whatsapp.net',
    items: [{ productId: 'jollof_rice', quantity: 2 }],
  });
  assert.equal(reuse.existingOrder, true);
});

test('expired confirmation is cleared and must be obtained again', async (t) => {
  const conv = conversation({
    orderState: 'CONFIRMED',
    orderDraft: { items: [{ productId: 'noodles', quantity: 1 }] },
    orderConfirmation: { confirmedAt: new Date(Date.now() - 3600000), expiresAt: new Date(Date.now() - 60000) },
  });
  mockConversation(t, conv);
  await assert.rejects(
    assertPaymentAllowed({ chatId: 'redacted@s.whatsapp.net', items: [{ productId: 'noodles', quantity: 1 }] }),
    (error) => error instanceof OrderStateError && /expired/i.test(error.message),
  );
  assert.equal(conv.orderState, 'AWAITING_CONFIRMATION');
  assert.equal(conv.orderConfirmation, undefined);
});

test('conversation context is scoped to the chat and includes recent messages, draft and latest order', async (t) => {
  const conv = conversation({
    orderState: 'AWAITING_CONFIRMATION',
    lastIntent: 'ORDER_QUANTITY',
    lastDiscussedProductId: 'fried_rice',
    orderDraft: {
      items: [{ productId: 'fried_rice', quantity: 2 }],
      totalMinor: 6000,
      total: 60,
      currency: 'GHS',
    },
  });
  mockConversation(t, conv);
  stub(t, Message, 'find', () => ({
    sort: () => ({
      limit: async () => [
        { direction: 'OUTBOUND', senderType: 'AI', content: 'That is GH₵60.', createdAt: new Date('2026-01-01T10:01:00Z') },
        { direction: 'INBOUND', senderType: 'CUSTOMER', content: 'Two fried rice', createdAt: new Date('2026-01-01T10:00:00Z') },
      ],
    }),
  }));
  stub(t, Order, 'findOne', () => ({
    sort: () => ({
      select: async () => ({ reference: 'CAI-1', status: 'INITIALIZED' }),
    }),
  }));

  const context = await getConversationContext('redacted@s.whatsapp.net');
  assert.equal(context.exists, true);
  assert.equal(context.conversation.orderState, 'AWAITING_CONFIRMATION');
  assert.equal(context.conversation.lastDiscussedProductId, 'fried_rice');
  assert.equal(context.draft.total, 60);
  assert.equal(context.draft.readyForConfirmation, true);
  assert.equal(context.recentMessages.length, 2);
  assert.equal(context.recentMessages[0].content, 'Two fried rice');
  assert.equal(context.latestOrder.reference, 'CAI-1');
});


test('mentioned products are remembered without guessing an ambiguous rice reference', () => {
  const conv = conversation({ lastDiscussedProductId: 'noodles' });
  recordMentionedProducts(conv, 'How much is jollof rice?');
  assert.equal(conv.lastDiscussedProductId, 'jollof_rice');
  assert.deepEqual(conv.lastMentionedProductIds, ['jollof_rice']);

  recordMentionedProducts(conv, 'What about rice?');
  assert.equal(conv.lastDiscussedProductId, '');
  assert.deepEqual(conv.lastMentionedProductIds, ['jollof_rice', 'fried_rice']);

  recordMentionedProducts(conv, 'Thanks');
  assert.equal(conv.lastDiscussedProductId, '');
});

test('order drafts and payment links are blocked while a human owns the conversation', async (t) => {
  const handedOff = conversation({ requiresHuman: true, status: 'HUMAN_REQUIRED' });
  mockConversation(t, handedOff);
  await assert.rejects(
    saveOrderDraft({ chatId: 'redacted@s.whatsapp.net', items: [{ productId: 'jollof_rice', quantity: 1 }] }),
    (error) => error instanceof OrderStateError && /team member/i.test(error.message),
  );
  await assert.rejects(
    assertPaymentAllowed({ chatId: 'redacted@s.whatsapp.net', items: [{ productId: 'jollof_rice', quantity: 1 }] }),
    (error) => error instanceof OrderStateError && /team member/i.test(error.message),
  );
});

test('a pending payment link can be re-read idempotently but not changed by the AI', async (t) => {
  const conv = conversation({
    orderState: 'PAYMENT_PENDING',
    orderDraft: { items: [{ productId: 'jollof_rice', quantity: 1 }] },
    lastOrderReference: 'CAI-1',
  });
  mockConversation(t, conv);

  const same = await saveOrderDraft({
    chatId: 'redacted@s.whatsapp.net',
    items: [{ productId: 'jollof_rice', quantity: 1 }],
  });
  assert.equal(same.existing, true);
  assert.equal(same.state, 'PAYMENT_PENDING');

  await assert.rejects(
    saveOrderDraft({ chatId: 'redacted@s.whatsapp.net', items: [{ productId: 'noodles', quantity: 1 }] }),
    (error) => error instanceof OrderStateError && /payment link is already pending/i.test(error.message),
  );
});

test('order status lookup is scoped to the requesting chat', async (t) => {
  const order = {
    reference: 'CAI-77',
    chatId: 'redacted@s.whatsapp.net',
    status: 'PAID',
    amount: 30,
    amountMinor: 3000,
    currency: 'GHS',
    items: [{ productId: 'noodles', name: 'Noodles', quantity: 1, unitPrice: 30, lineTotal: 30 }],
    paymentUrl: 'https://paystack.test/pay/abc',
    paidAt: new Date('2026-01-01T00:00:00Z'),
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };
  stub(t, Order, 'findOne', (filter = {}) => (
    filter.reference
      ? Promise.resolve(filter.reference === 'CAI-77' ? order : null)
      : { sort: async () => order }
  ));
  mockConversation(t, conversation({ orderState: 'PAID' }));

  const status = await getLatestOrderStatus({ chatId: 'redacted@s.whatsapp.net' });
  assert.equal(status.reference, 'CAI-77');
  assert.equal(status.status, 'PAID');
  assert.equal(status.conversationState, 'PAID');
  assert.equal(status.items[0].name, 'Noodles');

  const otherOrder = { ...order, chatId: 'other@s.whatsapp.net' };
  stub(t, Order, 'findOne', async () => otherOrder);
  await assert.rejects(
    getLatestOrderStatus({ chatId: 'redacted@s.whatsapp.net', reference: 'CAI-77' }),
    (error) => error instanceof OrderStateError && error.status === 404,
  );
});
