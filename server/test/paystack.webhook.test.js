import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Isolated simulation only: test signing secret, mocked Paystack verification,
// mocked Order model, mocked Hermes delivery. No real Paystack API calls, no
// real WhatsApp sends, no real customer/sandbox order fixtures.
process.env.PAYSTACK_SECRET_KEY = 'sk_test_simulated_webhook_secret';
process.env.PAYSTACK_BASE_URL = 'https://paystack.test.invalid';

const { default: Order } = await import('../src/models/Order.js');
const {
  applyPaystackEvent,
  verifyPaystackSignature,
} = await import('../src/services/paystack.service.js');

const REAL_SANDBOX_REFERENCE = 'CAI-1794071887140-daadb7a6';
const TEST_REF = 'CAI-test-sim-3000-ghs';

const originals = {
  orderFindOne: Order.findOne,
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

function makeTestOrder(overrides = {}) {
  return {
    _id: 'sim-order-1',
    id: 'sim-order-1',
    reference: TEST_REF,
    status: 'INITIALIZED',
    chatId: '233000000000@s.whatsapp.net',
    items: [{ productId: 'jollof_rice', name: 'Jollof Rice', quantity: 1, unitPriceMinor: 3000, lineTotalMinor: 3000 }],
    amount: 30,
    amountMinor: 3000,
    currency: 'GHS',
    paidAt: null,
    paidNotificationStatus: undefined,
    paidNotificationAttempts: 0,
    paidNotifiedAt: null,
    ...overrides,
  };
}

function sender(impl = async () => ({ status: 'SENT', messageId: 'wamid-sim-1' })) {
  return async (chatId, text) => {
    sendCalls.push({ chatId, text });
    return impl(chatId, text);
  };
}

function paystackVerify(data) {
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({ status: true, data });
    },
  };
}

function successEvent(reference = TEST_REF) {
  return { event: 'charge.success', data: { reference } };
}

function signRaw(rawBody) {
  return crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(rawBody).digest('hex');
}

beforeEach(() => {
  assert.notEqual(TEST_REF, REAL_SANDBOX_REFERENCE, 'test must never target the real sandbox order');
  sendCalls = [];
  order = makeTestOrder();
  Order.findOne = async (filter) => (matches(filter) ? order : null);
  Order.findOneAndUpdate = async (filter, update) => (matches(filter) ? applyUpdate(order, update) : null);
  Order.findById = async (id) => (String(order._id) === String(id) ? order : null);
  Order.findByIdAndUpdate = async (id, update) => (
    String(order._id) === String(id) ? applyUpdate(order, update) : null
  );
  fetchResponse = paystackVerify({ status: 'success', amount: 3000, currency: 'GHS', reference: TEST_REF });
  globalThis.fetch = async () => fetchResponse;
});

after(() => {
  Order.findOne = originals.orderFindOne;
  Order.findOneAndUpdate = originals.orderFindOneAndUpdate;
  Order.findById = originals.orderFindById;
  Order.findByIdAndUpdate = originals.orderFindByIdAndUpdate;
  globalThis.fetch = originals.fetch;
});

test('signature: valid HMAC SHA512 is accepted for a simulated webhook body', () => {
  const raw = Buffer.from(JSON.stringify(successEvent()));
  assert.equal(verifyPaystackSignature(raw, signRaw(raw)), true);
});

test('security: missing webhook signature is rejected', () => {
  const raw = Buffer.from(JSON.stringify(successEvent()));
  assert.equal(verifyPaystackSignature(raw, ''), false);
  assert.equal(verifyPaystackSignature(raw, undefined), false);
});

test('security: invalid webhook signature is rejected', () => {
  const raw = Buffer.from(JSON.stringify(successEvent()));
  assert.equal(verifyPaystackSignature(raw, 'deadbeef'), false);
  assert.equal(verifyPaystackSignature(raw, signRaw(Buffer.from('{"tampered":true}'))), false);
});

test('successful payment: valid charge.success + verified transaction marks PAID and records notification', async () => {
  const result = await applyPaystackEvent(successEvent(), { sendMessage: sender() });

  assert.equal(result.handled, true);
  assert.equal(result.alreadyPaid, undefined);
  assert.equal(order.status, 'PAID');
  assert.ok(order.paidAt instanceof Date || typeof order.paidAt === 'string');
  assert.equal(order.paidAmountMinor, 3000);
  assert.equal(order.paidCurrency, 'GHS');
  assert.equal(order.paidNotificationStatus, 'SENT');
  assert.equal(order.paidNotificationMessageId, 'wamid-sim-1');
  assert.equal(sendCalls.length, 1);
  assert.match(sendCalls[0].text, /CAI-test-sim-3000-ghs/);
  assert.notEqual(order.reference, REAL_SANDBOX_REFERENCE);
});

test('security: incorrect amount never marks the order PAID', async () => {
  fetchResponse = paystackVerify({ status: 'success', amount: 2900, currency: 'GHS', reference: TEST_REF });
  const result = await applyPaystackEvent(successEvent(), { sendMessage: sender() });

  assert.equal(result.handled, true);
  assert.equal(result.mismatch, true);
  assert.equal(order.status, 'FAILED');
  assert.equal(order.paidAt, null);
  assert.equal(sendCalls.length, 0);
});

test('security: incorrect currency never marks the order PAID', async () => {
  fetchResponse = paystackVerify({ status: 'success', amount: 3000, currency: 'NGN', reference: TEST_REF });
  const result = await applyPaystackEvent(successEvent(), { sendMessage: sender() });

  assert.equal(result.handled, true);
  assert.equal(result.mismatch, true);
  assert.equal(order.status, 'FAILED');
  assert.equal(order.paidAt, null);
  assert.equal(sendCalls.length, 0);
});

test('security: incorrect/unknown transaction reference is not applied to any order', async () => {
  const result = await applyPaystackEvent(successEvent('CAI-does-not-exist'), { sendMessage: sender() });

  assert.equal(result.handled, false);
  assert.match(result.reason, /unknown/i);
  assert.equal(order.status, 'INITIALIZED');
  assert.equal(sendCalls.length, 0);
});

test('security: Paystack verification returning failed never marks the order PAID', async () => {
  fetchResponse = paystackVerify({ status: 'failed', amount: 3000, currency: 'GHS', reference: TEST_REF });
  const result = await applyPaystackEvent(successEvent(), { sendMessage: sender() });

  assert.equal(result.handled, false);
  assert.match(result.reason, /failed/i);
  assert.equal(order.status, 'INITIALIZED');
  assert.equal(order.paidAt, null);
  assert.equal(sendCalls.length, 0);
});

test('idempotency: duplicate successful webhook causes only one paid transition and no duplicate confirmation', async () => {
  const sendMessage = sender();
  const first = await applyPaystackEvent(successEvent(), { sendMessage });
  const paidAt = order.paidAt;

  assert.equal(first.handled, true);
  assert.equal(order.status, 'PAID');
  assert.equal(order.paidNotificationStatus, 'SENT');
  assert.equal(sendCalls.length, 1);

  const second = await applyPaystackEvent(successEvent(), { sendMessage });
  assert.equal(second.handled, true);
  assert.equal(second.alreadyPaid, true);
  assert.equal(order.status, 'PAID');
  assert.equal(String(order.paidAt), String(paidAt));
  assert.equal(order.paidNotificationStatus, 'SENT');
  assert.equal(sendCalls.length, 1);

  const third = await applyPaystackEvent(successEvent(), { sendMessage });
  assert.equal(third.alreadyPaid, true);
  assert.equal(sendCalls.length, 1);
});

test('notification safety: failed Hermes notification is not reported as SENT and order stays PAID', async () => {
  await applyPaystackEvent(successEvent(), {
    sendMessage: sender(async () => { throw new Error('gateway offline'); }),
  });

  assert.equal(order.status, 'PAID');
  assert.equal(order.paidNotificationStatus, 'FAILED');
  assert.notEqual(order.paidNotificationStatus, 'SENT');
  assert.equal(order.paidNotificationMessageId || '', '');
  assert.match(order.paidNotificationError, /gateway offline/);
});

test('notification safety: uncertain WhatsApp delivery is handled safely (not reported as SENT)', async () => {
  await applyPaystackEvent(successEvent(), {
    sendMessage: sender(async () => ({ status: 'QUEUED', messageId: '' })),
  });

  assert.equal(order.status, 'PAID');
  assert.equal(order.paidNotificationStatus, 'QUEUED');
  assert.notEqual(order.paidNotificationStatus, 'SENT');
  assert.equal(order.paidNotificationMessageId, '');
  assert.ok(order.paidNotificationQueuedAt);

  // A later duplicate webhook must not fabricate a SENT confirmation.
  await applyPaystackEvent(successEvent(), { sendMessage: sender() });
  assert.equal(order.paidNotificationStatus, 'QUEUED');
  assert.equal(sendCalls.length, 1);
});

test('fabricated events cannot affect the real sandbox order reference', async () => {
  // No test ever looks up the real sandbox reference; simulate an unknown lookup.
  Order.findOne = async (filter) => (filter.reference === REAL_SANDBOX_REFERENCE ? null : (matches(filter) ? order : null));
  const result = await applyPaystackEvent(successEvent(REAL_SANDBOX_REFERENCE), { sendMessage: sender() });
  assert.equal(result.handled, false);
  assert.equal(sendCalls.length, 0);
});
