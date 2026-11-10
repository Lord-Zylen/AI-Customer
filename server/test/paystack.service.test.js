import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.PAYSTACK_SECRET_KEY = 'sk_test_unit_secret';

const {
  assertPaystackConfigured,
  createPaymentLink,
  paymentMatchesOrder,
  paystackConfigured,
  toMinorUnits,
  validatePaystackConfig,
  verifyPaystackSignature,
} = await import('../src/services/paystack.service.js');

const order = { amountMinor: 6000, currency: 'GHS' };

test('toMinorUnits converts GHS major units to pesewas', () => {
  assert.deepEqual(toMinorUnits(60), { amount: 60, amountMinor: 6000 });
  assert.deepEqual(toMinorUnits('12.5'), { amount: 12.5, amountMinor: 1250 });
});

test('toMinorUnits rejects non-positive / invalid amounts', () => {
  assert.throws(() => toMinorUnits(0));
  assert.throws(() => toMinorUnits(-1));
  assert.throws(() => toMinorUnits('not-a-number'));
});

test('paymentMatchesOrder accepts an exact amount and currency match', () => {
  assert.equal(paymentMatchesOrder(order, { amount: 6000, currency: 'GHS' }), true);
});

test('paymentMatchesOrder rejects a short payment', () => {
  assert.equal(paymentMatchesOrder(order, { amount: 5900, currency: 'GHS' }), false);
});

test('paymentMatchesOrder rejects an overpayment', () => {
  assert.equal(paymentMatchesOrder(order, { amount: 6100, currency: 'GHS' }), false);
});

test('paymentMatchesOrder rejects a currency mismatch', () => {
  assert.equal(paymentMatchesOrder(order, { amount: 6000, currency: 'NGN' }), false);
});

test('verifyPaystackSignature accepts a valid HMAC and rejects tampering', () => {
  const raw = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: 'CAI-1' } }));
  const valid = crypto.createHmac('sha512', 'sk_test_unit_secret').update(raw).digest('hex');
  assert.equal(verifyPaystackSignature(raw, valid), true);
  assert.equal(verifyPaystackSignature(Buffer.from('{"event":"charge.failed"}'), valid), false);
  assert.equal(verifyPaystackSignature(raw, ''), false);
});

test('config validation distinguishes missing, invalid and valid Paystack settings', () => {
  const valid = validatePaystackConfig({
    PAYSTACK_SECRET_KEY: 'sk_test_12345678',
    PAYSTACK_CURRENCY: 'GHS',
    PAYSTACK_DEFAULT_EMAIL: 'orders@example.com',
  });
  assert.equal(valid.status, 'VALID');
  assert.equal(valid.valid, true);
  assert.equal(valid.configured, true);

  const missing = validatePaystackConfig({});
  assert.equal(missing.status, 'MISSING');
  assert.equal(missing.configured, false);
  assert.equal(missing.valid, false);

  const invalid = validatePaystackConfig({
    PAYSTACK_SECRET_KEY: 'not-a-paystack-key',
    PAYSTACK_CURRENCY: 'NGN',
    PAYSTACK_CALLBACK_URL: 'javascript:alert(1)',
    PAYSTACK_DEFAULT_EMAIL: 'not-an-email',
    PAYSTACK_TIMEOUT_MS: '0',
  });
  assert.equal(invalid.status, 'INVALID');
  assert.equal(invalid.valid, false);
  assert.equal(invalid.errors.length, 5);
});

test('assertPaystackConfigured throws a safe 503 without exposing configuration', () => {
  assert.throws(
    () => assertPaystackConfigured({ PAYSTACK_SECRET_KEY: 'bad' }),
    (error) => error.status === 503 && /configuration is invalid/i.test(error.message) && !/bad/.test(error.message),
  );
});

test('payment initialization cannot proceed with missing Paystack configuration', async () => {
  const original = process.env.PAYSTACK_SECRET_KEY;
  delete process.env.PAYSTACK_SECRET_KEY;
  try {
    assert.equal(paystackConfigured(), false);
    await assert.rejects(
      createPaymentLink({
        chatId: '2348000000000',
        items: [{ productId: 'jollof_rice', quantity: 1 }],
      }, { sendMessage: async () => { throw new Error('must not send'); } }),
      (error) => error.status === 503 && /not configured/i.test(error.message),
    );
  } finally {
    process.env.PAYSTACK_SECRET_KEY = original;
  }
});

test('payment initialization cannot proceed with invalid Paystack configuration', async () => {
  const original = process.env.PAYSTACK_SECRET_KEY;
  process.env.PAYSTACK_SECRET_KEY = 'not-a-paystack-key';
  try {
    assert.equal(paystackConfigured(), false);
    await assert.rejects(
      createPaymentLink({
        chatId: '2348000000000',
        items: [{ productId: 'jollof_rice', quantity: 1 }],
      }, { sendMessage: async () => { throw new Error('must not send'); } }),
      (error) => error.status === 503
        && /configuration is invalid/i.test(error.message)
        && !error.message.includes('not-a-paystack-key'),
    );
  } finally {
    process.env.PAYSTACK_SECRET_KEY = original;
  }
});

test('webhook signature verification fails closed when the secret is missing', () => {
  const original = process.env.PAYSTACK_SECRET_KEY;
  delete process.env.PAYSTACK_SECRET_KEY;
  try {
    assert.equal(verifyPaystackSignature(Buffer.from('{}'), 'deadbeef'), false);
  } finally {
    process.env.PAYSTACK_SECRET_KEY = original;
  }
});
