import test from 'node:test';
import assert from 'node:assert/strict';

const {
  assertAmountMatches,
  buildOrderQuote,
  findMentionedProducts,
  getProduct,
  listProducts,
  orderFingerprint,
  PricingError,
} = await import('../src/services/product-catalog.js');

test('catalogue exposes the three fixed products at GH₵30', () => {
  const products = listProducts();
  assert.deepEqual(products.map((p) => p.id).sort(), ['fried_rice', 'jollof_rice', 'noodles']);
  for (const product of products) {
    assert.equal(product.priceMinor, 3000);
    assert.equal(product.price, 30);
    assert.equal(product.currency, 'GHS');
  }
  assert.equal(getProduct('jollof_rice').name, 'Jollof Rice');
  assert.equal(getProduct('unknown'), null);
});

test('buildOrderQuote prices an order in integer pesewas', () => {
  const quote = buildOrderQuote([
    { productId: 'jollof_rice', quantity: 2 },
    { productId: 'noodles', quantity: 1 },
  ]);
  assert.equal(quote.totalMinor, 9000);
  assert.equal(quote.total, 90);
  assert.equal(quote.currency, 'GHS');
  assert.deepEqual(quote.items.map((i) => [i.productId, i.quantity, i.unitPriceMinor, i.lineTotalMinor]), [
    ['jollof_rice', 2, 3000, 6000],
    ['noodles', 1, 3000, 3000],
  ]);
});

test('buildOrderQuote ignores any client-supplied prices', () => {
  const quote = buildOrderQuote([
    { productId: 'fried_rice', quantity: 1, unitPrice: 0, unit_price: 0.01, price: 1 },
  ]);
  assert.equal(quote.totalMinor, 3000);
  assert.equal(quote.items[0].unitPriceMinor, 3000);
});

test('buildOrderQuote merges duplicate lines without exceeding a sane quantity', () => {
  const quote = buildOrderQuote([
    { productId: 'jollof_rice', quantity: 1 },
    { productId: 'jollof_rice', quantity: 2 },
  ]);
  assert.equal(quote.items.length, 1);
  assert.equal(quote.items[0].quantity, 3);
  assert.equal(quote.totalMinor, 9000);
});

test('buildOrderQuote rejects empty, malformed and unknown baskets', () => {
  for (const items of [undefined, null, [], 'jollof', [{}], [{ productId: 'pizza', quantity: 1 }], [{ productId: '', quantity: 1 }], [null], [[1, 2]]]) {
    assert.throws(() => buildOrderQuote(items), PricingError);
  }
});

test('buildOrderQuote rejects non-positive, fractional, string and excessive quantities', () => {
  for (const quantity of [0, -1, 1.5, '2', null, undefined, true, 51]) {
    assert.throws(
      () => buildOrderQuote([{ productId: 'jollof_rice', quantity }]),
      (error) => error instanceof PricingError && error.status === 400,
      `quantity ${String(quantity)} should be rejected`,
    );
  }
});

test('orderFingerprint is stable for the same basket regardless of item order or fake prices', () => {
  const a = buildOrderQuote([
    { productId: 'jollof_rice', quantity: 1, unitPrice: 0.01 },
    { productId: 'noodles', quantity: 2 },
  ]);
  const b = buildOrderQuote([
    { productId: 'noodles', quantity: 2, price: 1 },
    { productId: 'jollof_rice', quantity: 1 },
  ]);
  assert.equal(
    orderFingerprint({ chatId: 'chat-1', quote: a }),
    orderFingerprint({ chatId: 'chat-1', quote: b }),
  );
});

test('orderFingerprint changes for basket, quantity, customer, total and currency changes', () => {
  const base = buildOrderQuote([{ productId: 'jollof_rice', quantity: 2 }]);
  const original = orderFingerprint({ chatId: 'chat-1', quote: base });

  const differentBasket = buildOrderQuote([
    { productId: 'jollof_rice', quantity: 1 },
    { productId: 'fried_rice', quantity: 1 },
  ]);
  assert.equal(differentBasket.totalMinor, base.totalMinor);
  assert.notEqual(orderFingerprint({ chatId: 'chat-1', quote: differentBasket }), original);

  const differentQuantity = buildOrderQuote([{ productId: 'jollof_rice', quantity: 1 }]);
  assert.notEqual(orderFingerprint({ chatId: 'chat-1', quote: differentQuantity }), original);
  assert.notEqual(orderFingerprint({ chatId: 'chat-2', quote: base }), original);
  assert.notEqual(orderFingerprint({ sessionId: 'session-1', quote: base }), original);

  const differentCurrency = { ...base, currency: 'NGN' };
  assert.notEqual(orderFingerprint({ chatId: 'chat-1', quote: differentCurrency }), original);
  const differentTotal = { ...base, totalMinor: base.totalMinor + 1 };
  assert.notEqual(orderFingerprint({ chatId: 'chat-1', quote: differentTotal }), original);
});

test('orderFingerprint requires an identity and a valid quote', () => {
  const quote = buildOrderQuote([{ productId: 'jollof_rice', quantity: 1 }]);
  assert.throws(() => orderFingerprint({ quote }), PricingError);
  assert.throws(() => orderFingerprint({ chatId: 'chat-1' }), PricingError);
  assert.throws(() => orderFingerprint({ chatId: 'chat-1', quote: { items: [], totalMinor: '0', currency: 'GHS' } }), PricingError);
});

test('assertAmountMatches accepts only the exact trusted total', () => {
  assert.doesNotThrow(() => assertAmountMatches(6000, 60));
  assert.doesNotThrow(() => assertAmountMatches(6000, '60'));
  assert.doesNotThrow(() => assertAmountMatches(6000, '60.00'));
  assert.doesNotThrow(() => assertAmountMatches(6000, undefined));
  assert.throws(() => assertAmountMatches(6000, 59.99), PricingError);
  assert.throws(() => assertAmountMatches(6000, 0.01), PricingError);
  assert.throws(() => assertAmountMatches(6000, 6000), PricingError);
  assert.throws(() => assertAmountMatches(6000, 'not-a-number'), PricingError);
  assert.throws(() => assertAmountMatches(6000, true), PricingError);
  assert.throws(() => assertAmountMatches(6000, 60.005), PricingError);
});


test('mention tracking distinguishes specific items from an ambiguous rice reference', () => {
  assert.deepEqual(findMentionedProducts('How much is jollof?').map((m) => m.product.id), ['jollof_rice']);
  assert.deepEqual(findMentionedProducts('I want fried rice and noodles').map((m) => m.product.id), ['fried_rice', 'noodles']);

  const rice = findMentionedProducts('How much is rice?');
  assert.deepEqual(rice.map((m) => m.product.id), ['jollof_rice', 'fried_rice']);
  assert.equal(rice.every((m) => m.specific === false), true);

  const jollof = findMentionedProducts('I would like two packs of jollof rice');
  assert.equal(jollof.length, 1);
  assert.equal(jollof[0].product.id, 'jollof_rice');
  assert.equal(jollof[0].specific, true);
  assert.deepEqual(findMentionedProducts('Do you deliver to Kumasi?'), []);
});
