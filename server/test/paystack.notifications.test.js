import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PAYSTACK_SECRET_KEY = 'sk_test_unit_secret';
process.env.PAYSTACK_BASE_URL = 'https://paystack.test';
process.env.PAYMENT_NOTIFICATION_MAX_ATTEMPTS = '2';
process.env.PAYMENT_NOTIFICATION_LOCK_MS = '10000';

const { default: Order } = await import('../src/models/Order.js');
const {
  applyPaystackEvent,
  notifyCustomerPaid,
  retryPendingPaidNotifications,
} = await import('../src/services/paystack.service.js');

const originals = {
  orderFindOne: Order.findOne,
  orderFind: Order.find,
  orderFindOneAndUpdate: Order.findOneAndUpdate,
  orderFindById: Order.findById,
  orderFindByIdAndUpdate: Order.findByIdAndUpdate,
  fetch: globalThis.fetch,
};

let order;
let sendCalls;
let fetchResponse;

function applyUpdate(target, update) {
  for (const [key, value] of Object.entries(update.$set || {})) target[key] = value;
  for (const [key, value] of Object.entries(update.$inc || {})) target[key] = Number(target[key] || 0) + value;
  return target;
}

function matches(filter = {}) {
  if (filter._id && String(order._id) !== String(filter._id)) return false;
  if (filter.reference && order.reference !== filter.reference) return false;
  if (filter.status && filter.status.$ne === undefined && order.status !== filter.status) return false;
  if (filter.status?.$ne && order.status === filter.status.$ne) return false;
  if (filter.paidNotifiedAt === null && order.paidNotifiedAt != null) return false;
  if (filter.paidNotificationStatus?.$ne && order.paidNotificationStatus === filter.paidNotificationStatus.$ne) return false;
  if (filter.paidNotificationStatus === 'SENDING' && order.paidNotificationStatus !== 'SENDING') return false;
  if (filter.paidNotificationLastAttemptAt !== undefined
    && String(order.paidNotificationLastAttemptAt) !== String(filter.paidNotificationLastAttemptAt)) return false;
  if (Array.isArray(filter.$or)) {
    const accepted = filter.$or.some((clause) => {
      if (clause.paidNotificationStatus?.$in) return clause.paidNotificationStatus.$in.includes(order.paidNotificationStatus);
      if (clause.paidNotificationStatus?.$exists === false) return order.paidNotificationStatus === undefined;
      return false;
    });
    if (!accepted) return false;
  }
  return true;
}

function sender(impl = async () => ({ status: 'SENT', messageId: 'wamid-paid-1' })) {
  return async (chatId, text) => {
    sendCalls.push({ chatId, text });
    return impl(chatId, text);
  };
}

beforeEach(() => {
  sendCalls = [];
  order = {
    _id: 'order-1',
    id: 'order-1',
    reference: 'CAI-paid-1',
    status: 'PAID',
    chatId: '2348000000000',
    amount: 60,
    amountMinor: 6000,
    currency: 'GHS',
    paidNotifiedAt: null,
    paidNotificationStatus: 'PENDING',
    paidNotificationAttempts: 0,
    paidNotificationChatId: '',
    paidNotificationError: '',
  };
  Order.findOne = async (filter) => (matches(filter) ? order : null);
  Order.find = () => ({ sort: () => ({ limit: async () => [order] }) });
  Order.findOneAndUpdate = async (filter, update) => (matches(filter) ? applyUpdate(order, update) : null);
  Order.findById = async (id) => (String(order._id) === String(id) ? order : null);
  Order.findByIdAndUpdate = async (id, update) => (
    String(order._id) === String(id) ? applyUpdate(order, update) : null
  );
  fetchResponse = {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        status: true,
        data: { status: 'success', amount: 6000, currency: 'GHS', reference: 'CAI-paid-1' },
      });
    },
  };
  globalThis.fetch = async () => fetchResponse;
});

after(() => {
  Order.findOne = originals.orderFindOne;
  Order.find = originals.orderFind;
  Order.findOneAndUpdate = originals.orderFindOneAndUpdate;
  Order.findById = originals.orderFindById;
  Order.findByIdAndUpdate = originals.orderFindByIdAndUpdate;
  globalThis.fetch = originals.fetch;
});

test('verified payment sends exactly one confirmation with a real message id', async () => {
  const first = await notifyCustomerPaid(order, { sendMessage: sender() });
  assert.equal(first.paidNotificationStatus, 'SENT');
  assert.equal(first.paidNotificationMessageId, 'wamid-paid-1');
  assert.ok(first.paidNotifiedAt);
  assert.equal(sendCalls.length, 1);
  assert.match(sendCalls[0].text, /Payment received/);

  const second = await notifyCustomerPaid(order, { sendMessage: sender() });
  assert.equal(second.paidNotificationStatus, 'SENT');
  assert.equal(sendCalls.length, 1);
});

test('queued confirmation is recorded as unconfirmed and is not resent automatically', async () => {
  const result = await notifyCustomerPaid(order, {
    sendMessage: sender(async () => ({ status: 'QUEUED', messageId: '' })),
  });
  assert.equal(result.paidNotificationStatus, 'QUEUED');
  assert.ok(result.paidNotificationQueuedAt);
  assert.equal(result.paidNotificationMessageId, '');

  await notifyCustomerPaid(order, { sendMessage: sender() });
  assert.equal(sendCalls.length, 1);
});

test('delivery failure keeps the order PAID and allows a later retry', async () => {
  const failed = await notifyCustomerPaid(order, {
    sendMessage: sender(async () => { throw new Error('gateway offline'); }),
  });
  assert.equal(order.status, 'PAID');
  assert.equal(failed.paidNotificationStatus, 'FAILED');
  assert.match(failed.paidNotificationError, /gateway offline/);

  const retried = await notifyCustomerPaid(order, { sendMessage: sender() });
  assert.equal(order.status, 'PAID');
  assert.equal(retried.paidNotificationStatus, 'SENT');
  assert.equal(sendCalls.length, 2);
});

test('stale SENDING becomes UNKNOWN without resending until forced', async () => {
  order.paidNotificationStatus = 'SENDING';
  order.paidNotificationAttempts = 1;
  order.paidNotificationLastAttemptAt = new Date(Date.now() - 60 * 1000);

  const unknown = await notifyCustomerPaid(order, { sendMessage: sender() });
  assert.equal(unknown.paidNotificationStatus, 'UNKNOWN');
  assert.equal(sendCalls.length, 0);

  const forced = await notifyCustomerPaid(order, { sendMessage: sender(), force: true });
  assert.equal(forced.paidNotificationStatus, 'SENT');
  assert.equal(sendCalls.length, 1);
});

test('retry limit stops sends and never reverses payment', async () => {
  order.paidNotificationStatus = 'FAILED';
  order.paidNotificationAttempts = 2;

  const result = await notifyCustomerPaid(order, { sendMessage: sender() });
  assert.equal(order.status, 'PAID');
  assert.equal(result.paidNotificationStatus, 'FAILED');
  assert.match(result.paidNotificationError, /retry limit/i);
  assert.equal(sendCalls.length, 0);
});

test('charge.success marks PAID then sends the confirmation', async () => {
  order.status = 'INITIALIZED';
  order.paidNotificationStatus = undefined;
  const result = await applyPaystackEvent(
    { event: 'charge.success', data: { reference: order.reference } },
    { sendMessage: sender() },
  );

  assert.equal(result.handled, true);
  assert.equal(order.status, 'PAID');
  assert.equal(order.paidNotificationStatus, 'SENT');
  assert.equal(sendCalls.length, 1);
});

test('a duplicate charge.success webhook never sends a second confirmation', async () => {
  order.status = 'INITIALIZED';
  order.paidNotificationStatus = undefined;
  const sendMessage = sender();

  const first = await applyPaystackEvent(
    { event: 'charge.success', data: { reference: order.reference } },
    { sendMessage },
  );
  assert.equal(first.handled, true);
  assert.equal(order.status, 'PAID');
  assert.equal(order.paidNotificationStatus, 'SENT');
  assert.equal(sendCalls.length, 1);

  const second = await applyPaystackEvent(
    { event: 'charge.success', data: { reference: order.reference } },
    { sendMessage },
  );
  assert.equal(second.handled, true);
  assert.equal(second.alreadyPaid, true);
  assert.equal(order.status, 'PAID');
  assert.equal(order.paidNotificationStatus, 'SENT');
  assert.equal(sendCalls.length, 1);
});

test('an amount mismatch from a verified transaction never marks the order PAID', async () => {
  order.status = 'INITIALIZED';
  order.paidNotificationStatus = undefined;
  fetchResponse = {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        status: true,
        data: { status: 'success', amount: 5900, currency: 'GHS', reference: order.reference },
      });
    },
  };

  const result = await applyPaystackEvent(
    { event: 'charge.success', data: { reference: order.reference } },
    { sendMessage: sender() },
  );
  assert.equal(result.handled, true);
  assert.equal(result.mismatch, true);
  assert.equal(order.status, 'FAILED');
  assert.equal(sendCalls.length, 0);
});

test('a currency mismatch from a verified transaction never marks the order PAID', async () => {
  order.status = 'INITIALIZED';
  order.paidNotificationStatus = undefined;
  fetchResponse = {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        status: true,
        data: { status: 'success', amount: 6000, currency: 'NGN', reference: order.reference },
      });
    },
  };

  const result = await applyPaystackEvent(
    { event: 'charge.success', data: { reference: order.reference } },
    { sendMessage: sender() },
  );
  assert.equal(result.handled, true);
  assert.equal(result.mismatch, true);
  assert.equal(order.status, 'FAILED');
  assert.equal(sendCalls.length, 0);
});

test('a failed confirmation is retried by a later webhook without duplicate sends', async () => {
  order.status = 'INITIALIZED';
  order.paidNotificationStatus = undefined;
  const failing = sender(async () => { throw new Error('gateway offline'); });

  const first = await applyPaystackEvent(
    { event: 'charge.success', data: { reference: order.reference } },
    { sendMessage: failing },
  );
  assert.equal(first.handled, true);
  assert.equal(order.status, 'PAID');
  assert.equal(order.paidNotificationStatus, 'FAILED');
  assert.equal(sendCalls.length, 1);

  const retry = await applyPaystackEvent(
    { event: 'charge.success', data: { reference: order.reference } },
    { sendMessage: sender() },
  );
  assert.equal(retry.handled, true);
  assert.equal(retry.alreadyPaid, true);
  assert.equal(order.status, 'PAID');
  assert.equal(order.paidNotificationStatus, 'SENT');
  assert.equal(sendCalls.length, 2);

  const duplicate = await applyPaystackEvent(
    { event: 'charge.success', data: { reference: order.reference } },
    { sendMessage: sender() },
  );
  assert.equal(duplicate.alreadyPaid, true);
  assert.equal(order.paidNotificationStatus, 'SENT');
  assert.equal(sendCalls.length, 2);
});

test('the background recovery pass retries a stale failed confirmation', async () => {
  order.status = 'PAID';
  order.paidNotificationStatus = 'FAILED';
  order.paidNotificationAttempts = 1;
  order.paidNotificationLastAttemptAt = new Date(Date.now() - 2 * 60 * 1000);
  order.paidNotifiedAt = null;

  const result = await retryPendingPaidNotifications({ sendMessage: sender() });
  assert.equal(result.attempted, 1);
  assert.equal(order.status, 'PAID');
  assert.equal(order.paidNotificationStatus, 'SENT');
  assert.equal(sendCalls.length, 1);
});
