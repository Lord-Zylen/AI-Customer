import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PAYSTACK_SECRET_KEY = 'sk_test_unit_secret';
process.env.PAYSTACK_BASE_URL = 'https://paystack.test';

const { default: Customer } = await import('../src/models/Customer.js');
const { default: Conversation } = await import('../src/models/Conversation.js');
const { default: Order } = await import('../src/models/Order.js');
const { createPaymentLink, retryPaymentLinkDelivery } = await import('../src/services/paystack.service.js');
const { buildOrderQuote, orderFingerprint, PricingError } = await import('../src/services/product-catalog.js');

const originals = {
  customerFindOne: Customer.findOne,
  conversationFindOne: Conversation.findOne,
  orderFindOne: Order.findOne,
  orderCreate: Order.create,
  orderUpdateOne: Order.updateOne,
  orderFindOneAndUpdate: Order.findOneAndUpdate,
  orderFindById: Order.findById,
  orderFindByIdAndUpdate: Order.findByIdAndUpdate,
  fetch: globalThis.fetch,
};

let orders;
let fetchBodies;
let sendCalls;
let nextId;
let fetchResponse;

function applyUpdate(order, update) {
  for (const [key, value] of Object.entries(update.$set || {})) order[key] = value;
  for (const [key, value] of Object.entries(update.$inc || {})) order[key] = Number(order[key] || 0) + value;
  return order;
}

function matches(order, filter = {}) {
  if (filter._id && String(order._id) !== String(filter._id)) return false;
  if (filter.reference && order.reference !== filter.reference) return false;
  if (filter.fingerprint !== undefined && order.fingerprint !== filter.fingerprint) return false;
  if (filter.status && order.status !== filter.status) return false;
  if (filter.currency && order.currency !== filter.currency) return false;
  if (filter.amountMinor !== undefined && order.amountMinor !== filter.amountMinor) return false;
  if (filter.chatId !== undefined && order.chatId !== filter.chatId) return false;
  if (filter.sessionId !== undefined && order.sessionId !== filter.sessionId) return false;
  if (filter.paymentUrl?.$ne !== undefined && order.paymentUrl === filter.paymentUrl.$ne) return false;
  if (filter.createdAt?.$gte && new Date(order.createdAt) < new Date(filter.createdAt.$gte)) return false;
  if (typeof filter.paymentLinkStatus === 'string' && order.paymentLinkStatus !== filter.paymentLinkStatus) return false;
  if (filter.paymentLinkStatus?.$in && !filter.paymentLinkStatus.$in.includes(order.paymentLinkStatus)) return false;
  if (filter.paymentLinkLastAttemptAt !== undefined) {
    if (filter.paymentLinkLastAttemptAt?.$lt) {
      if (!(new Date(order.paymentLinkLastAttemptAt) < new Date(filter.paymentLinkLastAttemptAt.$lt))) return false;
    } else if (String(order.paymentLinkLastAttemptAt) !== String(filter.paymentLinkLastAttemptAt)) {
      return false;
    }
  }
  if (Array.isArray(filter.$or)) {
    const any = filter.$or.some((clause) => {
      if (clause.paymentLinkStatus?.$in) return clause.paymentLinkStatus.$in.includes(order.paymentLinkStatus);
      if (clause.paymentLinkStatus?.$exists === false) return order.paymentLinkStatus === undefined;
      if (clause.paymentLinkStatus === 'SENDING') {
        return order.paymentLinkStatus === 'SENDING'
          && (!clause.paymentLinkLastAttemptAt?.$lt
            || new Date(order.paymentLinkLastAttemptAt) < new Date(clause.paymentLinkLastAttemptAt.$lt));
      }
      return false;
    });
    if (!any) return false;
  }
  return true;
}

function findMatching(filter) {
  return [...orders]
    .filter((order) => matches(order, filter))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
}

async function createOrderObject(doc) {
  if (doc.fingerprint && orders.some((o) => o.status === 'INITIALIZED' && o.fingerprint === doc.fingerprint)) {
    throw Object.assign(new Error('duplicate key'), { code: 11000 });
  }
  const order = {
    _id: `order-${nextId += 1}`,
    id: `order-${nextId}`,
    createdAt: new Date(),
    status: 'INITIALIZED',
    paymentUrl: '',
    paymentLinkStatus: 'PENDING',
    paymentLinkAttempts: 0,
    ...doc,
    async save() { return this; },
  };
  orders.push(order);
  return order;
}

function existingOrder(overrides = {}) {
  const quote = buildOrderQuote(overrides.items || [{ productId: 'jollof_rice', quantity: 2 }]);
  const chatId = overrides.chatId ?? '2348000000000';
  const sessionId = overrides.sessionId ?? '';
  return {
    _id: `existing-${nextId += 1}`,
    id: `existing-${nextId}`,
    createdAt: new Date(),
    status: 'INITIALIZED',
    reference: 'CAI-existing',
    chatId,
    sessionId,
    fingerprint: orderFingerprint({ chatId, sessionId, quote }),
    items: quote.items,
    amount: quote.total,
    amountMinor: quote.totalMinor,
    currency: quote.currency,
    paymentUrl: 'https://paystack.test/pay/existing',
    paymentLinkStatus: 'PENDING',
    paymentLinkAttempts: 0,
    ...overrides,
  };
}

beforeEach(() => {
  orders = [];
  fetchBodies = [];
  sendCalls = [];
  nextId = 0;
  fetchResponse = {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        status: true,
        data: {
          authorization_url: 'https://paystack.test/pay/abc',
          access_code: 'access-abc',
        },
      });
    },
  };

  Customer.findOne = async () => null;
  Conversation.findOne = () => ({ sort: async () => null });
  Order.findOne = (filter) => ({ sort: async () => findMatching(filter) });
  Order.create = async (doc) => createOrderObject(doc);
  Order.updateOne = async (filter, update) => {
    const order = findMatching(filter);
    if (order) applyUpdate(order, update);
    return { acknowledged: true };
  };
  Order.findOneAndUpdate = async (filter, update) => {
    const order = findMatching(filter);
    if (!order) return null;
    return applyUpdate(order, update);
  };
  Order.findById = async (id) => orders.find((order) => String(order._id) === String(id)) || null;
  Order.findByIdAndUpdate = async (id, update) => {
    const order = orders.find((entry) => String(entry._id) === String(id));
    if (!order) return null;
    return applyUpdate(order, update);
  };

  globalThis.fetch = async (url, init) => {
    fetchBodies.push({ url, body: JSON.parse(init.body) });
    return fetchResponse;
  };
});

after(() => {
  Customer.findOne = originals.customerFindOne;
  Conversation.findOne = originals.conversationFindOne;
  Order.findOne = originals.orderFindOne;
  Order.create = originals.orderCreate;
  Order.updateOne = originals.orderUpdateOne;
  Order.findOneAndUpdate = originals.orderFindOneAndUpdate;
  Order.findById = originals.orderFindById;
  Order.findByIdAndUpdate = originals.orderFindByIdAndUpdate;
  globalThis.fetch = originals.fetch;
});

function sender(impl = async () => ({ status: 'SENT', messageId: 'wamid-1' })) {
  return async (chatId, text) => {
    sendCalls.push({ chatId, text });
    return impl(chatId, text);
  };
}

test('createPaymentLink charges the catalogue total and sends the exact link through Hermes', async () => {
  const sendMessage = sender();
  const result = await createPaymentLink({
    chatId: '2348000000000',
    items: [
      { productId: 'jollof_rice', quantity: 2 },
      { productId: 'noodles', quantity: 1, unitPrice: 0.01 },
    ],
  }, { sendMessage });

  assert.equal(fetchBodies[0].body.amount, 9000);
  assert.equal(result.amount, 90);
  assert.equal(result.delivery.status, 'SENT');
  assert.equal(result.payment_link_sent, true);

  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].chatId, '2348000000000');
  const message = sendCalls[0].text;
  assert.match(message, /https:\/\/paystack\.test\/pay\/abc/);
  assert.match(message, new RegExp(result.reference));
  assert.match(message, /2 × Jollof Rice — GH₵60\.00/);
  assert.match(message, /1 × Noodles — GH₵30\.00/);
  assert.match(message, /Total: GH₵90\.00/);
});

test('createPaymentLink rejects a mismatched client amount without calling Paystack', async () => {
  await assert.rejects(
    createPaymentLink({
      chatId: '2348000000000',
      amount: 1,
      items: [{ productId: 'jollof_rice', quantity: 2 }],
    }, { sendMessage: sender() }),
    (error) => error instanceof PricingError && error.status === 400,
  );
  assert.equal(fetchBodies.length, 0);
  assert.equal(orders.length, 0);
});

test('createPaymentLink accepts a matching legacy amount and forces the catalogue currency', async () => {
  const result = await createPaymentLink({
    chatId: '2348000000000',
    amount: 60,
    currency: 'GHS',
    items: [{ productId: 'fried_rice', quantity: 2 }],
  }, { sendMessage: sender() });
  assert.equal(fetchBodies[0].body.amount, 6000);
  assert.equal(result.amountMinor, 6000);
});

test('createPaymentLink rejects a conflicting currency', async () => {
  await assert.rejects(
    createPaymentLink({
      chatId: '2348000000000',
      currency: 'NGN',
      items: [{ productId: 'fried_rice', quantity: 1 }],
    }, { sendMessage: sender() }),
    (error) => error instanceof PricingError && /GHS/.test(error.message),
  );
  assert.equal(fetchBodies.length, 0);
});

test('createPaymentLink rejects a manipulated or invalid basket', async () => {
  for (const items of [
    [],
    [{ productId: 'pizza', quantity: 1 }],
    [{ productId: 'jollof_rice', quantity: 0 }],
    [{ productId: 'jollof_rice', quantity: 1.5 }],
    [{ productId: 'jollof_rice', quantity: '2' }],
  ]) {
    await assert.rejects(
      createPaymentLink({ chatId: '2348000000000', items }, { sendMessage: sender() }),
      PricingError,
    );
  }
  assert.equal(fetchBodies.length, 0);
  assert.equal(orders.length, 0);
});

test('identical basket from the same customer reuses the existing link and retries delivery', async () => {
  const existing = existingOrder();
  orders.push(existing);

  const result = await createPaymentLink({
    chatId: existing.chatId,
    items: [{ productId: 'jollof_rice', quantity: 2 }],
  }, { sendMessage: sender() });

  assert.equal(result.reused, true);
  assert.equal(result.reference, existing.reference);
  assert.equal(fetchBodies.length, 0);
  assert.equal(sendCalls.length, 1);
  assert.equal(existing.paymentLinkStatus, 'SENT');
});

test('different basket with an identical total does not reuse the existing link', async () => {
  const existing = existingOrder({ items: [{ productId: 'jollof_rice', quantity: 2 }] });
  orders.push(existing);

  const result = await createPaymentLink({
    chatId: existing.chatId,
    items: [
      { productId: 'jollof_rice', quantity: 1 },
      { productId: 'fried_rice', quantity: 1 },
    ],
  }, { sendMessage: sender() });

  assert.equal(result.amountMinor, 6000);
  assert.notEqual(result.reference, existing.reference);
  assert.equal(result.reused, undefined);
  assert.equal(fetchBodies.length, 1);
  assert.equal(orders.length, 2);
  assert.notEqual(orders[0].fingerprint, orders[1].fingerprint);
});

test('different quantity does not reuse the existing link', async () => {
  const existing = existingOrder({ items: [{ productId: 'jollof_rice', quantity: 2 }] });
  orders.push(existing);

  const result = await createPaymentLink({
    chatId: existing.chatId,
    items: [{ productId: 'jollof_rice', quantity: 1 }],
  }, { sendMessage: sender() });

  assert.notEqual(result.reference, existing.reference);
  assert.notEqual(result.amountMinor, existing.amountMinor);
  assert.equal(fetchBodies.length, 1);
});

test('different customer does not reuse the existing link', async () => {
  const existing = existingOrder({ chatId: '2348111111111' });
  orders.push(existing);

  const result = await createPaymentLink({
    chatId: '2348222222222',
    items: [{ productId: 'jollof_rice', quantity: 2 }],
  }, { sendMessage: sender() });

  assert.notEqual(result.reference, existing.reference);
  assert.equal(fetchBodies.length, 1);
});

test('expired pending link is retired and not reused', async () => {
  const existing = existingOrder({ createdAt: new Date(Date.now() - 60 * 60 * 1000) });
  orders.push(existing);

  const result = await createPaymentLink({
    chatId: existing.chatId,
    items: [{ productId: 'jollof_rice', quantity: 2 }],
  }, { sendMessage: sender() });

  assert.notEqual(result.reference, existing.reference);
  assert.equal(existing.status, 'ABANDONED');
  assert.equal(fetchBodies.length, 1);
});

test('concurrent duplicate creation does not start a second Paystack transaction', async () => {
  const quote = buildOrderQuote([{ productId: 'jollof_rice', quantity: 2 }]);
  const fingerprint = orderFingerprint({ chatId: '2348000000000', quote });
  const inFlight = {
    ...existingOrder(),
    paymentUrl: '',
    fingerprint,
  };
  orders.push(inFlight);

  await assert.rejects(
    createPaymentLink({
      chatId: '2348000000000',
      items: [{ productId: 'jollof_rice', quantity: 2 }],
    }, { sendMessage: sender() }),
    (error) => error?.status === 409,
  );
  assert.equal(fetchBodies.length, 0);
  assert.equal(sendCalls.length, 0);
});

test('two simultaneous identical requests create one order and one Paystack transaction', async () => {
  const args = {
    chatId: '2348000000000',
    items: [{ productId: 'jollof_rice', quantity: 2 }],
  };
  const results = await Promise.allSettled([
    createPaymentLink(args, { sendMessage: sender() }),
    createPaymentLink(args, { sendMessage: sender() }),
  ]);

  const fulfilled = results.filter((result) => result.status === 'fulfilled');
  const rejected = results.filter((result) => result.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.status, 409);
  assert.equal(fetchBodies.length, 1);
  assert.equal(orders.length, 1);
  assert.equal(sendCalls.length, 1);
});

test('a failed Paystack initialization leaves no reusable order and does not send', async () => {
  fetchResponse = {
    ok: true,
    status: 200,
    async text() { return JSON.stringify({ status: true, data: {} }); },
  };

  await assert.rejects(
    createPaymentLink({
      chatId: '2348000000000',
      items: [{ productId: 'jollof_rice', quantity: 1 }],
    }, { sendMessage: sender() }),
    /payment link/i,
  );

  assert.equal(orders.length, 1);
  assert.equal(orders[0].status, 'FAILED');
  assert.equal(sendCalls.length, 0);

  fetchResponse = {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({ status: true, data: { authorization_url: 'https://paystack.test/pay/retry' } });
    },
  };
  const retry = await createPaymentLink({
    chatId: '2348000000000',
    items: [{ productId: 'jollof_rice', quantity: 1 }],
  }, { sendMessage: sender() });
  assert.equal(retry.reused, undefined);
  assert.equal(fetchBodies.length, 2);
  assert.equal(orders.length, 2);
});

test('a Hermes delivery failure is recorded but keeps the payment link recoverable', async () => {
  const result = await createPaymentLink({
    chatId: '2348000000000',
    items: [{ productId: 'jollof_rice', quantity: 1 }],
  }, { sendMessage: sender(async () => { throw new Error('gateway offline'); }) });

  assert.equal(result.delivery.status, 'FAILED');
  assert.equal(result.payment_link_sent, false);
  assert.match(result.delivery.error, /gateway offline/);
  assert.equal(result.payment_url, 'https://paystack.test/pay/abc');
  assert.equal(orders[0].status, 'INITIALIZED');
  assert.equal(orders[0].paymentLinkStatus, 'FAILED');
});

test('retrying a failed delivery reuses the order and does not create another Paystack transaction', async () => {
  const failSender = sender(async () => { throw new Error('temporary failure'); });
  const first = await createPaymentLink({
    chatId: '2348000000000',
    items: [{ productId: 'jollof_rice', quantity: 1 }],
  }, { sendMessage: failSender });
  assert.equal(first.delivery.status, 'FAILED');
  assert.equal(fetchBodies.length, 1);

  const second = await createPaymentLink({
    chatId: '2348000000000',
    items: [{ productId: 'jollof_rice', quantity: 1 }],
  }, { sendMessage: sender() });

  assert.equal(second.reused, true);
  assert.equal(second.delivery.status, 'SENT');
  assert.equal(fetchBodies.length, 1);
  assert.equal(sendCalls.length, 2);
});

test('a previously successful delivery is not sent again', async () => {
  const first = await createPaymentLink({
    chatId: '2348000000000',
    items: [{ productId: 'jollof_rice', quantity: 1 }],
  }, { sendMessage: sender() });
  assert.equal(first.delivery.status, 'SENT');
  assert.equal(sendCalls.length, 1);

  const second = await createPaymentLink({
    chatId: '2348000000000',
    items: [{ productId: 'jollof_rice', quantity: 1 }],
  }, { sendMessage: sender() });

  assert.equal(second.reused, true);
  assert.equal(second.delivery.status, 'SENT');
  assert.equal(second.payment_link_sent, true);
  assert.equal(sendCalls.length, 1);
  assert.equal(fetchBodies.length, 1);
});

test('queued payment link is accepted but never reported as sent', async () => {
  const result = await createPaymentLink({
    chatId: '2348000000000',
    items: [{ productId: 'jollof_rice', quantity: 1 }],
  }, { sendMessage: sender(async () => ({ status: 'QUEUED', messageId: '' })) });

  assert.equal(result.delivery.status, 'QUEUED');
  assert.equal(result.payment_link_sent, false);
  assert.equal(result.payment_link_accepted, true);
  assert.equal(result.payment_link_queued, true);
  assert.equal(result.delivery.message_id, '');
  assert.ok(orders[0].paymentLinkQueuedAt);
  assert.equal(orders[0].paymentLinkSentAt, undefined);

  const retry = await createPaymentLink({
    chatId: '2348000000000',
    items: [{ productId: 'jollof_rice', quantity: 1 }],
  }, { sendMessage: sender() });
  assert.equal(retry.reused, true);
  assert.equal(retry.delivery.status, 'QUEUED');
  assert.equal(sendCalls.length, 1);
  assert.equal(fetchBodies.length, 1);
});

test('a fresh SENDING lock is not resent by a concurrent request', async () => {
  const existing = existingOrder({
    paymentLinkStatus: 'SENDING',
    paymentLinkAttempts: 1,
    paymentLinkLastAttemptAt: new Date(),
  });
  orders.push(existing);

  const result = await createPaymentLink({
    chatId: existing.chatId,
    items: [{ productId: 'jollof_rice', quantity: 2 }],
  }, { sendMessage: sender() });

  assert.equal(result.reused, true);
  assert.equal(result.delivery.status, 'SENDING');
  assert.equal(sendCalls.length, 0);
  assert.equal(fetchBodies.length, 0);
});

test('a stale SENDING lock becomes UNKNOWN instead of being blindly resent', async () => {
  const existing = existingOrder({
    paymentLinkStatus: 'SENDING',
    paymentLinkAttempts: 1,
    paymentLinkLastAttemptAt: new Date(Date.now() - 2 * 60 * 1000),
  });
  orders.push(existing);

  const result = await createPaymentLink({
    chatId: existing.chatId,
    items: [{ productId: 'jollof_rice', quantity: 2 }],
  }, { sendMessage: sender() });

  assert.equal(result.reused, true);
  assert.equal(result.delivery.status, 'UNKNOWN');
  assert.equal(result.payment_link_sent, false);
  assert.equal(result.payment_link_outcome_unknown, true);
  assert.match(result.delivery.error, /without a recorded result/i);
  assert.equal(existing.paymentLinkStatus, 'UNKNOWN');
  assert.equal(sendCalls.length, 0);
  assert.equal(fetchBodies.length, 0);
});

test('an UNKNOWN delivery requires a forced retry, which reuses the existing URL', async () => {
  const existing = existingOrder({
    paymentLinkStatus: 'UNKNOWN',
    paymentLinkAttempts: 1,
    paymentLinkError: 'previous outcome unknown',
  });
  orders.push(existing);

  await assert.rejects(
    retryPaymentLinkDelivery(existing.reference, { sendMessage: sender() }),
    (error) => error?.status === 409 && /uncertain/i.test(error.message),
  );
  assert.equal(sendCalls.length, 0);

  const result = await retryPaymentLinkDelivery(existing.reference, {
    force: true,
    sendMessage: sender(),
  });

  assert.equal(result.reference, existing.reference);
  assert.equal(result.delivery.status, 'SENT');
  assert.equal(result.payment_link_sent, true);
  assert.equal(result.payment_url, 'https://paystack.test/pay/existing');
  assert.equal(existing.paymentLinkStatus, 'SENT');
  assert.equal(sendCalls.length, 1);
  assert.match(sendCalls[0].text, /https:\/\/paystack\.test\/pay\/existing/);
  assert.equal(fetchBodies.length, 0);
});

test('missing chat id prevents sending and records a clear delivery error', async () => {
  const result = await createPaymentLink({
    sessionId: 'session-1',
    items: [{ productId: 'jollof_rice', quantity: 1 }],
  }, { sendMessage: sender() });

  assert.equal(result.delivery.status, 'FAILED');
  assert.match(result.delivery.error, /chat id/i);
  assert.equal(result.payment_link_sent, false);
  assert.equal(sendCalls.length, 0);
  assert.equal(result.payment_url, 'https://paystack.test/pay/abc');
});

test('missing payment URL prevents sending', async () => {
  fetchResponse = {
    ok: true,
    status: 200,
    async text() { return JSON.stringify({ status: true, data: {} }); },
  };
  await assert.rejects(
    createPaymentLink({
      chatId: '2348000000000',
      items: [{ productId: 'jollof_rice', quantity: 1 }],
    }, { sendMessage: sender() }),
    /payment link/i,
  );
  assert.equal(sendCalls.length, 0);
});
