import test from 'node:test';
import assert from 'node:assert/strict';

const { default: Order, ORDER_FINGERPRINT_INDEX_NAME } = await import('../src/models/Order.js');

test('the Order model declares the named partial unique fingerprint index', () => {
  const indexes = Order.schema.indexes();
  const entry = indexes.find(([keys]) => (
    Object.keys(keys).length === 1 && keys.fingerprint === 1
  ));
  assert.ok(entry, 'fingerprint index is missing from the schema');
  const [, options] = entry;
  assert.equal(options.name, ORDER_FINGERPRINT_INDEX_NAME);
  assert.equal(options.unique, true);
  assert.deepEqual(options.partialFilterExpression, {
    fingerprint: { $gt: '' },
    status: 'INITIALIZED',
  });
});

test('the existing unique Paystack reference index is preserved', () => {
  const indexes = Order.schema.indexes();
  const entry = indexes.find(([keys]) => Object.keys(keys).length === 1 && keys.reference === 1);
  assert.ok(entry, 'reference index is missing from the schema');
  assert.equal(entry[1].unique, true);
});

test('payment-link delivery tracks the uncertain outcome state', () => {
  const statusPath = Order.schema.path('paymentLinkStatus');
  assert.ok(statusPath.enumValues.includes('SENDING'));
  assert.ok(statusPath.enumValues.includes('QUEUED'));
  assert.ok(statusPath.enumValues.includes('UNKNOWN'));
});
