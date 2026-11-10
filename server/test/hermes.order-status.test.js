import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Customer from '../src/models/Customer.js';
import Conversation from '../src/models/Conversation.js';
import Order from '../src/models/Order.js';
import hermesRouter from '../src/routes/hermes.js';

process.env.CAI_HOOK_SECRET = process.env.CAI_HOOK_SECRET || 'test-order-status-secret';

const HEADERS = {
  'Content-Type': 'application/json',
  'x-cai-hook-secret': process.env.CAI_HOOK_SECRET,
};

function stub(t, target, key, value) {
  const original = target[key];
  target[key] = value;
  t.after(() => { target[key] = original; });
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/hermes', hermesRouter);
  app.use((err, req, res, next) => res.status(err?.status || 500).json({ error: { message: err?.message || 'boom' } }));
  return app;
}

async function withServer(app, fn) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function mockStore(t, order) {
  stub(t, Customer, 'findOne', async () => ({ id: 'cust-1', _id: 'cust-1' }));
  stub(t, Conversation, 'findOne', () => ({
    sort: async () => ({ orderState: 'PAID' }),
  }));
  stub(t, Order, 'findOne', (filter = {}) => (
    filter.reference
      ? Promise.resolve(filter.reference === order.reference ? order : null)
      : { sort: async () => order }
  ));
}

test('order-status returns only the requesting chat order and requires the hook secret', async (t) => {
  const order = {
    reference: 'CAI-STATUS-1',
    chatId: '233111@s.whatsapp.net',
    status: 'PAID',
    amount: 30,
    amountMinor: 3000,
    currency: 'GHS',
    items: [{ productId: 'noodles', name: 'Noodles', quantity: 1, unitPrice: 30, lineTotal: 30 }],
    paymentUrl: 'https://paystack.test/pay/abc',
    paidAt: new Date('2026-01-01T00:00:00Z'),
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };
  mockStore(t, order);
  const app = makeApp();

  await withServer(app, async (base) => {
    const unauthorized = await fetch(`${base}/api/hermes/webhook/order-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: '233111@s.whatsapp.net' }),
    });
    assert.equal(unauthorized.status, 401);

    const ok = await fetch(`${base}/api/hermes/webhook/order-status`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ chat_id: '233111@s.whatsapp.net' }),
    });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.ok, true);
    assert.equal(body.reference, 'CAI-STATUS-1');
    assert.equal(body.status, 'PAID');
    assert.equal(body.conversationState, 'PAID');
  });
});

test('order-status cannot leak another chat order by reference', async (t) => {
  const order = {
    reference: 'CAI-STATUS-2',
    chatId: 'other@s.whatsapp.net',
    status: 'PAID',
    amount: 30,
    amountMinor: 3000,
    currency: 'GHS',
    items: [],
  };
  mockStore(t, order);
  const app = makeApp();

  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/hermes/webhook/order-status`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ chat_id: '233111@s.whatsapp.net', reference: 'CAI-STATUS-2' }),
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.match(body.error.message, /No order was found/i);
  });
});
