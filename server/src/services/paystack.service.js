import crypto from 'node:crypto';
import Customer from '../models/Customer.js';
import Conversation from '../models/Conversation.js';
import Order from '../models/Order.js';
import { assertAmountMatches, buildOrderQuote, CURRENCY, orderFingerprint, PricingError } from './product-catalog.js';
import { sendWhatsAppMessage } from './whatsapp.service.js';

const DEFAULT_PAYSTACK_BASE_URL = 'https://api.paystack.co';
const PAYSTACK_BASE_URL = (process.env.PAYSTACK_BASE_URL || DEFAULT_PAYSTACK_BASE_URL).replace(/\/+$/, '');
const PAYSTACK_KEY_PATTERN = /^sk_(?:test|live)_[A-Za-z0-9_-]{8,}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Reuse a still-payable link for the same chat/amount instead of creating a second
// transaction when the agent retries or the customer asks for the link again.
const LINK_REUSE_MS = Number(process.env.PAYSTACK_LINK_REUSE_MS || 30 * 60 * 1000);
// Payment links are delivered by the backend, not the AI. Claims and retry
// limits prevent duplicate WhatsApp messages when the agent retries a tool call.
const DELIVERY_MAX_ATTEMPTS = Math.max(1, Number(process.env.PAYMENT_LINK_MAX_DELIVERY_ATTEMPTS) || 5);
const DELIVERY_LOCK_MS = Math.max(10000, Number(process.env.PAYMENT_LINK_DELIVERY_LOCK_MS) || 60000);
// Successful-payment notifications use the same claim/limit discipline but are
// tracked independently so a WhatsApp failure can never affect the PAID state.
const NOTIFICATION_MAX_ATTEMPTS = Math.max(1, Number(process.env.PAYMENT_NOTIFICATION_MAX_ATTEMPTS) || 5);
const NOTIFICATION_LOCK_MS = Math.max(10000, Number(process.env.PAYMENT_NOTIFICATION_LOCK_MS) || 60000);
const NOTIFICATION_RETRY_AFTER_MS = Math.max(10000, Number(process.env.PAYMENT_NOTIFICATION_RETRY_AFTER_MS) || 60000);
const NOTIFICATION_RETRY_INTERVAL_MS = Math.max(15000, Number(process.env.PAYMENT_NOTIFICATION_RETRY_INTERVAL_MS) || 60000);

const CURRENCY_SYMBOLS = { GHS: 'GH₵', NGN: '₦', ZAR: 'R', KES: 'KSh', USD: '$' };

export class PaystackError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'PaystackError';
    this.status = status;
  }
}

function parseHttpUrl(value) {
  try {
    const url = new URL(String(value));
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * Validate payment configuration without ever returning or logging its values.
 * Missing configuration is distinct from invalid configuration so operations can
 * tell an unconfigured deployment from a misconfigured one.
 */
export function validatePaystackConfig(env = process.env) {
  const errors = [];
  const secret = String(env.PAYSTACK_SECRET_KEY ?? '').trim();
  if (!secret) {
    errors.push('PAYSTACK_SECRET_KEY is not configured.');
  } else if (!PAYSTACK_KEY_PATTERN.test(secret)) {
    errors.push('PAYSTACK_SECRET_KEY must be a Paystack secret key beginning with sk_test_ or sk_live_.');
  }

  const currency = String(env.PAYSTACK_CURRENCY ?? CURRENCY).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    errors.push('PAYSTACK_CURRENCY must be a 3-letter ISO currency code.');
  } else if (currency !== CURRENCY) {
    errors.push(`PAYSTACK_CURRENCY must be ${CURRENCY} for the server-side catalogue.`);
  }

  const callbackUrl = String(env.PAYSTACK_CALLBACK_URL ?? '').trim();
  if (callbackUrl && !parseHttpUrl(callbackUrl)) {
    errors.push('PAYSTACK_CALLBACK_URL must be a valid http(s) URL.');
  }

  const defaultEmail = String(env.PAYSTACK_DEFAULT_EMAIL ?? '').trim();
  if (defaultEmail && !EMAIL_PATTERN.test(defaultEmail)) {
    errors.push('PAYSTACK_DEFAULT_EMAIL must be a valid email address.');
  }

  const baseUrl = String(env.PAYSTACK_BASE_URL ?? '').trim();
  if (baseUrl && !parseHttpUrl(baseUrl)) {
    errors.push('PAYSTACK_BASE_URL must be a valid http(s) URL.');
  }

  const timeoutRaw = String(env.PAYSTACK_TIMEOUT_MS ?? '').trim();
  if (timeoutRaw) {
    const timeout = Number(timeoutRaw);
    if (!Number.isFinite(timeout) || timeout <= 0) {
      errors.push('PAYSTACK_TIMEOUT_MS must be a positive number.');
    }
  }

  const configured = Boolean(secret);
  const status = !configured ? 'MISSING' : (errors.length ? 'INVALID' : 'VALID');
  return { status, configured, valid: errors.length === 0, errors };
}

export function assertPaystackConfigured(env = process.env) {
  const config = validatePaystackConfig(env);
  if (config.valid) return config;
  const message = config.status === 'MISSING'
    ? 'Paystack is not configured. Set PAYSTACK_SECRET_KEY.'
    : `Paystack configuration is invalid: ${config.errors[0]}`;
  throw new PaystackError(message, 503);
}

export function paystackConfigured() {
  return validatePaystackConfig().valid;
}

export function normalizeCurrency(value) {
  const currency = String(value || process.env.PAYSTACK_CURRENCY || CURRENCY).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new PaystackError('currency must be a 3-letter ISO code.', 400);
  return currency;
}

export function toMinorUnits(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) throw new PaystackError('amount must be a positive number.', 400);
  const minor = Math.round(value * 100);
  if (!Number.isSafeInteger(minor) || minor < 1) throw new PaystackError('amount is too small or too large.', 400);
  return { amount: Number(value.toFixed(2)), amountMinor: minor };
}

function normalizeEmail(value) {
  const provided = String(value || '').trim();
  if (provided) {
    if (!EMAIL_PATTERN.test(provided)) throw new PaystackError('customer_email must be a valid email address.', 400);
    return provided.toLowerCase();
  }
  const fallback = String(process.env.PAYSTACK_DEFAULT_EMAIL || 'orders@example.com').trim();
  if (!EMAIL_PATTERN.test(fallback)) throw new PaystackError('PAYSTACK_DEFAULT_EMAIL is not a valid email address.', 503);
  return fallback.toLowerCase();
}

function newReference() {
  return `CAI-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

function formatMoney(amount, currency) {
  const code = String(currency || 'GHS').toUpperCase();
  const symbol = CURRENCY_SYMBOLS[code];
  const value = Number(amount || 0).toFixed(2);
  return symbol ? `${symbol}${value}` : `${value} ${code}`;
}

async function paystackRequest(path, { method = 'POST', body } = {}) {
  assertPaystackConfigured();
  const secret = (process.env.PAYSTACK_SECRET_KEY || '').trim();
  const timeout = Number(process.env.PAYSTACK_TIMEOUT_MS || 15000);
  const init = {
    method,
    headers: { Authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(Number.isFinite(timeout) ? timeout : 15000),
  };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(`${PAYSTACK_BASE_URL}${path}`, init);
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new PaystackError('Paystack did not respond in time. Please try again.', 504);
    }
    throw new PaystackError('Could not reach Paystack. Please try again.', 502);
  }
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { /* non-JSON error body */ }
  if (!response.ok || payload?.status === false) {
    throw new PaystackError(payload?.message || `Paystack request failed (HTTP ${response.status}).`, 502);
  }
  return payload;
}

/**
 * Verify a transaction directly with Paystack. This is the only trusted source of
 * payment truth; a customer saying "I paid" or a webhook body alone is never enough.
 */
export async function verifyTransaction(reference) {
  const ref = String(reference || '').trim();
  if (!ref) throw new PaystackError('A payment reference is required.', 400);
  const payload = await paystackRequest(`/transaction/verify/${encodeURIComponent(ref)}`, { method: 'GET' });
  const data = payload?.data;
  if (!data) throw new PaystackError('Paystack did not return transaction details.', 502);
  return data;
}

/**
 * The amount/currency Paystack reports must match what the order expects. Paystack
 * reports amounts in minor units (pesewas for GHS).
 */
export function paymentMatchesOrder(order, data) {
  const expectedMinor = Number(order?.amountMinor);
  const paidMinor = Number(data?.amount);
  const expectedCurrency = String(order?.currency || '').toUpperCase();
  const paidCurrency = String(data?.currency || '').toUpperCase();
  return (
    Number.isFinite(expectedMinor) && expectedMinor > 0
    && Number.isFinite(paidMinor) && paidMinor === expectedMinor
    && Boolean(expectedCurrency) && paidCurrency === expectedCurrency
  );
}

/**
 * Interpret the Hermes sender's already-normalised outcome. A SENT result is only
 * trusted when Hermes returned a real platform message id; success/queued without
 * an id stays QUEUED (accepted, not proven delivered). Anything else is a failure
 * and must never be recorded as sent or given an invented id.
 */
function readSendOutcome(result, label) {
  const messageId = String(result?.messageId ?? '').trim();
  if (result?.status === 'SENT' && messageId) return { status: 'SENT', messageId };
  if (result?.status === 'SENT' || result?.status === 'QUEUED') return { status: 'QUEUED', messageId: '' };
  throw new Error(`Hermes did not confirm ${label}.`);
}

function paidMessage(order) {
  return [
    'Payment received — thank you!',
    '',
    `Order: ${order.reference}`,
    `Amount paid: ${formatMoney(order.amount, order.currency)}`,
    '',
    'Your payment has been confirmed and your order is now being processed.',
    'We will keep you updated. Thank you for choosing us!',
  ].join('\n');
}

export function paidNotificationSummary(order) {
  const status = order?.paidNotificationStatus || (order?.paidNotifiedAt ? 'SENT' : 'PENDING');
  return {
    status,
    chat_id: order?.paidNotificationChatId || order?.chatId || '',
    attempts: Number(order?.paidNotificationAttempts || 0),
    sent_at: order?.paidNotificationSentAt || null,
    queued_at: order?.paidNotificationQueuedAt || null,
    message_id: order?.paidNotificationMessageId || '',
    error: order?.paidNotificationError || '',
  };
}

async function recordPaidNotificationFailure(order, error, { uncertain = false } = {}) {
  const message = String(error || 'WhatsApp notification delivery failed.').slice(0, 500);
  const status = uncertain ? 'UNKNOWN' : 'FAILED';
  const updated = await Order.findOneAndUpdate(
    { _id: order._id, status: 'PAID' },
    {
      $set: {
        paidNotificationStatus: status,
        paidNotificationError: message,
        paidNotificationLastAttemptAt: new Date(),
        paidNotifiedAt: null,
      },
    },
    { new: true },
  ).catch(() => null);
  console.error(`[paystack] payment confirmation ${status.toLowerCase()} for ${order.reference}: ${message}`);
  return updated || { ...order, paidNotificationStatus: status, paidNotificationError: message, paidNotifiedAt: null };
}

/**
 * Send the verified-payment confirmation at most once per successful lifecycle.
 * A delivery failure never alters the PAID status. Stale SENDING outcomes are
 * marked UNKNOWN instead of blindly resending, because the earlier message may
 * already have reached the customer.
 */
export async function notifyCustomerPaid(order, { sendMessage, force = false } = {}) {
  if (!order?._id) return null;
  const send = sendMessage || sendWhatsAppMessage;
  const currentStatus = order.paidNotificationStatus;

  if (['SENT', 'QUEUED'].includes(currentStatus)) return order;
  // Legacy orders used paidNotifiedAt as the only claim. Never resend those.
  if (!currentStatus && order.paidNotifiedAt) return order;
  if (currentStatus === 'UNKNOWN' && !force) return order;

  const chatId = String(order.chatId || order.paidNotificationChatId || '').trim();
  if (!chatId) return recordPaidNotificationFailure(order, 'No WhatsApp chat id is associated with this paid order; no confirmation was sent.');

  if (Number(order.paidNotificationAttempts || 0) >= NOTIFICATION_MAX_ATTEMPTS) {
    const updated = await Order.findOneAndUpdate(
      { _id: order._id, status: 'PAID', paidNotificationStatus: { $ne: 'SENT' } },
      {
        $set: {
          paidNotificationStatus: 'FAILED',
          paidNotificationError: `Notification retry limit (${NOTIFICATION_MAX_ATTEMPTS}) reached.`,
          paidNotificationLastAttemptAt: new Date(),
        },
      },
      { new: true },
    ).catch(() => null);
    return updated || {
      ...order,
      paidNotificationStatus: 'FAILED',
      paidNotificationError: `Notification retry limit (${NOTIFICATION_MAX_ATTEMPTS}) reached.`,
    };
  }

  const staleBefore = new Date(Date.now() - NOTIFICATION_LOCK_MS);
  if (currentStatus === 'SENDING' && !force) {
    const lastAttempt = order.paidNotificationLastAttemptAt ? new Date(order.paidNotificationLastAttemptAt).getTime() : 0;
    if (!Number.isFinite(lastAttempt) || lastAttempt >= staleBefore.getTime()) return order;
    const unknown = await Order.findOneAndUpdate(
      {
        _id: order._id,
        status: 'PAID',
        paidNotificationStatus: 'SENDING',
        paidNotificationLastAttemptAt: order.paidNotificationLastAttemptAt,
      },
      {
        $set: {
          paidNotificationStatus: 'UNKNOWN',
          paidNotificationError: 'The previous notification attempt ended without a recorded result; automatic retry was suppressed to avoid a duplicate.',
        },
      },
      { new: true },
    ).catch(() => null);
    if (unknown) console.error(`[paystack] payment confirmation outcome unknown for ${order.reference}; manual retry required`);
    return unknown || order;
  }

  const claimStatuses = force ? ['PENDING', 'FAILED', 'UNKNOWN'] : ['PENDING', 'FAILED'];
  const claimed = await Order.findOneAndUpdate(
    {
      _id: order._id,
      status: 'PAID',
      paidNotifiedAt: null,
      $or: [
        { paidNotificationStatus: { $in: claimStatuses } },
        { paidNotificationStatus: { $exists: false } },
      ],
    },
    {
      $set: {
        paidNotificationStatus: 'SENDING',
        paidNotificationLastAttemptAt: new Date(),
        paidNotificationChatId: chatId,
        paidNotificationError: '',
      },
      $inc: { paidNotificationAttempts: 1 },
    },
    { new: true },
  );
  if (!claimed) {
    const latest = await Order.findById(order._id).catch(() => null);
    return latest || order;
  }

  try {
    const result = await send(chatId, paidMessage(claimed));
    const { status, messageId } = readSendOutcome(result, 'the payment confirmation send');

    const now = new Date();
    const set = {
      paidNotificationStatus: status,
      paidNotificationError: '',
      paidNotificationMessageId: messageId,
      paidNotifiedAt: now,
    };
    if (status === 'SENT') set.paidNotificationSentAt = now;
    else set.paidNotificationQueuedAt = now;
    const updated = await Order.findByIdAndUpdate(claimed._id, { $set: set }, { new: true });
    console.log(`[paystack] payment confirmation ${status.toLowerCase()} for ${claimed.reference}`);
    return updated || { ...claimed, ...set };
  } catch (error) {
    return recordPaidNotificationFailure(claimed, error?.message || 'WhatsApp notification delivery failed.');
  }
}

async function markOrderPaid(order, verifiedData, { sendMessage } = {}) {
  if (order.status === 'PAID') return { order, justPaid: false, alreadyPaid: true };

  if (!paymentMatchesOrder(order, verifiedData)) {
    console.error(
      `[paystack] amount/currency mismatch for ${order.reference}: expected ${order.amountMinor} ${order.currency}, `
      + `got ${verifiedData?.amount} ${verifiedData?.currency}; refusing to mark paid`,
    );
    const failed = await Order.findOneAndUpdate(
      { _id: order._id, status: { $ne: 'PAID' } },
      {
        $set: {
          status: 'FAILED',
          providerData: verifiedData || {},
          metadata: { ...(order.metadata || {}), paymentMismatch: true },
        },
      },
      { new: true },
    );
    return { order: failed || order, justPaid: false, mismatch: true };
  }

  const updated = await Order.findOneAndUpdate(
    { _id: order._id, status: { $ne: 'PAID' } },
    {
      $set: {
        status: 'PAID',
        paidAt: new Date(),
        verifiedAt: new Date(),
        paidAmountMinor: Number(verifiedData.amount),
        paidCurrency: String(verifiedData.currency || '').toUpperCase(),
        paymentChannel: String(verifiedData.channel || ''),
        providerData: verifiedData || {},
        paidNotifiedAt: null,
        paidNotificationStatus: 'PENDING',
        paidNotificationChatId: String(order.chatId || '').trim(),
        paidNotificationAttempts: 0,
        paidNotificationError: '',
      },
    },
    { new: true },
  );

  if (!updated) {
    // Another worker won the race; never process/notify twice.
    const current = await Order.findById(order._id);
    return { order: current || order, justPaid: false, alreadyPaid: true };
  }

  console.log(`[paystack] order ${updated.reference} marked PAID`);
  if (updated.conversationId) {
    // Context-only mirror of the authoritative Order status. A failure here must
    // never affect the verified PAID transition.
    await Conversation.updateOne(
      { _id: updated.conversationId },
      { $set: { orderState: 'PAID', lastOrderReference: updated.reference } },
    ).catch(() => {});
  }
  await notifyCustomerPaid(updated, { sendMessage });
  return { order: updated, justPaid: true };
}

function deliverySummary(order) {
  const status = order?.paymentLinkStatus || 'PENDING';
  return {
    status,
    attempts: Number(order?.paymentLinkAttempts || 0),
    sent_at: order?.paymentLinkSentAt || null,
    queued_at: order?.paymentLinkQueuedAt || null,
    message_id: order?.paymentLinkMessageId || '',
    error: order?.paymentLinkError || '',
  };
}

function paymentLinkMessage(order) {
  const lines = ['Thanks! Here is your order:', '', 'Your order:'];
  for (const item of order.items || []) {
    const lineTotal = item.lineTotal ?? (Number(item.unitPrice || 0) * Number(item.quantity || 0));
    lines.push(`${item.quantity} × ${item.name} — ${formatMoney(lineTotal, order.currency)}`);
  }
  lines.push(
    '',
    `Total: ${formatMoney(order.amount, order.currency)}`,
    `Order reference: ${order.reference}`,
    '',
    'Please complete your payment using this secure Paystack link:',
    '',
    order.paymentUrl,
    '',
    'Your order will be confirmed once your payment is verified.',
    '',
    'Thank you for ordering!',
  );
  return lines.join('\n');
}

async function recordDeliveryFailure(order, error) {
  const message = String(error || 'WhatsApp delivery failed.').slice(0, 500);
  const updated = await Order.findByIdAndUpdate(
    order._id,
    { $set: { paymentLinkStatus: 'FAILED', paymentLinkError: message, paymentLinkLastAttemptAt: new Date() } },
    { new: true },
  ).catch(() => null);
  console.error(`[paystack] payment link delivery failed for ${order.reference}: ${message}`);
  return updated || { ...order, paymentLinkStatus: 'FAILED', paymentLinkError: message };
}

/**
 * Send the payment link through the existing Hermes WhatsApp path. Delivery is
 * claimed atomically and tracked on the order so a retried tool call cannot send
 * the same link twice. A delivery failure never changes the order's payment
 * status or discards the already-created Paystack transaction.
 */
async function deliverPaymentLink(order, { sendMessage, force = false } = {}) {
  const send = sendMessage || sendWhatsAppMessage;
  const alreadyDelivered = ['SENT', 'QUEUED'].includes(order?.paymentLinkStatus);
  if (alreadyDelivered) return order;

  const chatId = String(order?.chatId || order?.paymentLinkChatId || '').trim();
  if (!order || !chatId) {
    const error = 'No WhatsApp chat id is associated with this order; the payment link was not sent.';
    return order ? recordDeliveryFailure(order, error) : order;
  }
  if (!order.paymentUrl) {
    return recordDeliveryFailure(order, 'No Paystack payment URL is available; the payment link was not sent.');
  }
  if (Number(order.paymentLinkAttempts || 0) >= DELIVERY_MAX_ATTEMPTS) {
    const message = `Delivery retry limit (${DELIVERY_MAX_ATTEMPTS}) reached; the payment URL remains available.`;
    const updated = await Order.findByIdAndUpdate(
      order._id,
      { $set: { paymentLinkStatus: 'FAILED', paymentLinkError: message, paymentLinkLastAttemptAt: new Date() } },
      { new: true },
    ).catch(() => null);
    return updated || { ...order, paymentLinkStatus: 'FAILED', paymentLinkError: message };
  }

  const staleBefore = new Date(Date.now() - DELIVERY_LOCK_MS);
  if (order.paymentLinkStatus === 'SENDING') {
    const lastAttempt = order.paymentLinkLastAttemptAt ? new Date(order.paymentLinkLastAttemptAt).getTime() : 0;
    const stale = !Number.isFinite(lastAttempt) || lastAttempt < staleBefore.getTime();
    if (!stale) return order; // another request currently owns the send
    if (!force) {
      // The previous send may already have reached the customer. Never resend an
      // uncertain outcome automatically; preserve the URL and leave recovery to an
      // explicit operator retry.
      const unknown = await Order.findOneAndUpdate(
        {
          _id: order._id,
          paymentLinkStatus: 'SENDING',
          paymentLinkLastAttemptAt: order.paymentLinkLastAttemptAt,
        },
        {
          $set: {
            paymentLinkStatus: 'UNKNOWN',
            paymentLinkError: 'The previous delivery attempt ended without a recorded result; automatic retry was suppressed to avoid a duplicate.',
          },
        },
        { new: true },
      ).catch(() => null);
      if (unknown) console.error(`[paystack] payment link delivery outcome unknown for ${order.reference}; manual retry required`);
      return unknown || order;
    }
  }

  // UNKNOWN is deliberately excluded from automatic retries: the earlier message
  // may have been delivered. A forced/controlled retry is the only way past it.
  if (order.paymentLinkStatus === 'UNKNOWN' && !force) return order;

  const claimStatuses = force
    ? ['PENDING', 'FAILED', 'UNKNOWN', 'SENDING']
    : ['PENDING', 'FAILED'];
  const claimed = await Order.findOneAndUpdate(
    {
      _id: order._id,
      $or: [
        { paymentLinkStatus: { $in: claimStatuses } },
        { paymentLinkStatus: { $exists: false } },
      ],
    },
    {
      $set: {
        paymentLinkStatus: 'SENDING',
        paymentLinkLastAttemptAt: new Date(),
        paymentLinkChatId: chatId,
        paymentLinkError: '',
      },
      $inc: { paymentLinkAttempts: 1 },
    },
    { new: true },
  );
  if (!claimed) {
    // Another request owns delivery (or it already succeeded); report its state.
    const latest = await Order.findById(order._id).catch(() => null);
    return latest || order;
  }

  try {
    const result = await send(chatId, paymentLinkMessage(claimed));
    // The installed CLI only proves delivery when it returns success plus a real
    // platform message id. Success without an id is accepted/queued, not SENT.
    const { status, messageId } = readSendOutcome(result, 'the payment-link send');
    const set = {
      paymentLinkStatus: status,
      paymentLinkError: '',
      paymentLinkMessageId: messageId,
    };
    if (status === 'SENT') set.paymentLinkSentAt = new Date();
    else set.paymentLinkQueuedAt = new Date();
    const updated = await Order.findByIdAndUpdate(claimed._id, { $set: set }, { new: true });
    console.log(`[paystack] payment link ${status.toLowerCase()} for ${claimed.reference}`);
    return updated || { ...claimed, ...set };
  } catch (error) {
    return recordDeliveryFailure(claimed, error?.message || 'WhatsApp delivery failed.');
  }
}

function summarizeOrder(order, extra = {}) {
  const delivery = deliverySummary(order);
  return {
    order_id: order.id,
    reference: order.reference,
    status: order.status,
    payment_url: order.paymentUrl || '',
    amount: order.amount,
    amountMinor: order.amountMinor,
    currency: order.currency,
    items: (order.items || []).map((item) => ({
      productId: item.productId || '',
      name: item.name,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      lineTotal: item.lineTotal,
    })),
    delivery,
    // Only a real Hermes message id proves delivery to the customer. QUEUED is
    // accepted-but-unconfirmed and must never be reported as successfully sent.
    payment_link_sent: delivery.status === 'SENT',
    payment_link_accepted: ['SENT', 'QUEUED'].includes(delivery.status),
    payment_link_queued: delivery.status === 'QUEUED',
    payment_link_outcome_unknown: delivery.status === 'UNKNOWN',
    paid_notification: paidNotificationSummary(order),
    paid_at: order.paidAt || null,
    ...extra,
  };
}

export async function createPaymentLink(orderRequest = {}, { sendMessage } = {}) {
  assertPaystackConfigured();
  const {
    chatId = '',
    sessionId = '',
    customerName = '',
    customerEmail = '',
    amount,
    currency,
    description = '',
    items = [],
  } = orderRequest || {};

  // The backend, not the caller, decides what an order costs. Only catalogue
  // product IDs and quantities are taken from the request; any supplied prices or
  // total are ignored and (for `amount`) must agree with the trusted total.
  const quote = buildOrderQuote(items);
  assertAmountMatches(quote.totalMinor, amount);
  if (currency !== undefined && currency !== null && String(currency).trim() !== '') {
    const requestedCurrency = normalizeCurrency(currency);
    if (requestedCurrency !== quote.currency) {
      throw new PricingError(`currency must be ${quote.currency} for these products.`, 400);
    }
  }
  const majorAmount = quote.total;
  const amountMinor = quote.totalMinor;
  const normalizedCurrency = quote.currency;
  const email = normalizeEmail(customerEmail);
  const orderItems = quote.items;

  // A fingerprint captures the actual basket, not just its total, so 1×Jollof +
  // 1×Fried Rice (GH₵60) never reuses 2×Jollof (also GH₵60).
  const fingerprint = (chatId || sessionId)
    ? orderFingerprint({ chatId, sessionId, quote })
    : '';
  const reuseWindowStart = new Date(Date.now() - (Number.isFinite(LINK_REUSE_MS) ? LINK_REUSE_MS : 30 * 60 * 1000));
  const linkIsFresh = (existing) => {
    const ts = new Date(existing?.createdAt || 0).getTime();
    return Number.isFinite(ts) && ts >= reuseWindowStart.getTime();
  };

  // Idempotency: only a still-payable link for the exact same basket may be reused.
  if (fingerprint) {
    const reuseFilter = {
      status: 'INITIALIZED',
      paymentUrl: { $ne: '' },
      fingerprint,
      amountMinor,
      currency: normalizedCurrency,
      createdAt: { $gte: reuseWindowStart },
    };
    if (chatId) reuseFilter.chatId = chatId;
    else reuseFilter.sessionId = sessionId;
    const existing = await Order.findOne(reuseFilter).sort({ createdAt: -1 });
    if (existing) {
      console.log(`[paystack] reusing payment link ${existing.reference} for ${chatId || sessionId}`);
      const delivered = await deliverPaymentLink(existing, { sendMessage });
      return { ...summarizeOrder(delivered), reused: true };
    }

    // A partial unique index only allows one INITIALIZED order per fingerprint.
    // Retire an expired pending order first so a fresh basket can be created.
    const blocking = await Order.findOne({ fingerprint, status: 'INITIALIZED' }).sort({ createdAt: -1 });
    if (blocking && !linkIsFresh(blocking)) {
      await Order.updateOne(
        { _id: blocking._id, status: 'INITIALIZED' },
        { $set: { status: 'ABANDONED' } },
      ).catch(() => {});
    }
  }

  const reference = newReference();

  const customer = chatId ? await Customer.findOne({ phone: chatId }) : null;
  const conversation = customer
    ? await Conversation.findOne({ customerId: customer.id, status: { $ne: 'RESOLVED' } }).sort({ updatedAt: -1 })
    : null;

  const metadata = {
    source: 'customer-ai',
    chat_id: chatId,
    session_id: sessionId,
    customer_name: customerName,
    description: String(description || '').slice(0, 300),
    items: orderItems,
  };

  const payload = {
    email,
    amount: amountMinor,
    currency: normalizedCurrency,
    reference,
    metadata,
  };
  const callbackUrl = (process.env.PAYSTACK_CALLBACK_URL || '').trim();
  if (callbackUrl) payload.callback_url = callbackUrl;

  const orderDoc = {
    reference,
    customerId: customer?.id,
    conversationId: conversation?.id,
    sessionId,
    chatId,
    customerName: customerName || customer?.name || '',
    customerEmail: email,
    description: String(description || '').slice(0, 300),
    fingerprint,
    items: orderItems,
    amount: majorAmount,
    amountMinor,
    currency: normalizedCurrency,
    status: 'INITIALIZED',
    metadata,
  };

  // Persist the order first (pending payment) so a failed initialization is auditable
  // and the customer can safely retry with a fresh reference. The partial unique
  // index on fingerprint turns simultaneous identical requests into one order.
  let order;
  try {
    order = await Order.create(orderDoc);
  } catch (error) {
    if (error?.code !== 11000 || !fingerprint) throw error;
    const existing = await Order.findOne({ fingerprint, status: 'INITIALIZED' }).sort({ createdAt: -1 });
    if (existing?.paymentUrl && linkIsFresh(existing)) {
      console.log(`[paystack] concurrent request reused payment link ${existing.reference}`);
      const delivered = await deliverPaymentLink(existing, { sendMessage });
      return { ...summarizeOrder(delivered), reused: true };
    }
    if (existing?.paymentUrl) {
      // Expired pending order still holding the unique index: retire and retry once.
      await Order.updateOne(
        { _id: existing._id, status: 'INITIALIZED' },
        { $set: { status: 'ABANDONED' } },
      ).catch(() => {});
      order = await Order.create(orderDoc);
    } else if (existing) {
      // Another request is currently initializing this exact basket. Do not start
      // a second Paystack transaction for it.
      throw new PaystackError('A payment link for this order is already being created. Please try again shortly.', 409);
    } else {
      throw error;
    }
  }

  let initialized;
  try {
    initialized = await paystackRequest('/transaction/initialize', { method: 'POST', body: payload });
  } catch (error) {
    await Order.updateOne(
      { _id: order._id },
      { $set: { status: 'FAILED', providerData: { error: String(error.message || 'Payment initialization failed.') } } },
    ).catch(() => {});
    console.error(`[paystack] initialization failed for ${reference}: ${error.message}`);
    throw error;
  }

  const data = initialized?.data || {};
  if (!data.authorization_url) {
    await Order.updateOne(
      { _id: order._id },
      { $set: { status: 'FAILED', providerData: { error: 'Paystack did not return an authorization URL.' } } },
    ).catch(() => {});
    throw new PaystackError('Paystack did not return a payment link.', 502);
  }

  order.paymentUrl = data.authorization_url;
  order.accessCode = data.access_code || '';
  order.providerData = { authorization_url: data.authorization_url, access_code: data.access_code || '' };
  await order.save();

  console.log(`[paystack] initialized ${reference} for ${formatMoney(majorAmount, normalizedCurrency)}`);
  const delivered = await deliverPaymentLink(order, { sendMessage });
  return summarizeOrder(delivered);
}

/**
 * Operator-controlled retry of the deterministic payment-link WhatsApp delivery.
 * A failed delivery is retried directly; an UNKNOWN (possibly already delivered)
 * outcome requires `force` so it is never resent blindly. This never creates a
 * second Paystack transaction: the existing payment URL is reused.
 */
export async function retryPaymentLinkDelivery(reference, { force = false, sendMessage } = {}) {
  const ref = String(reference || '').trim();
  if (!ref) throw new PaystackError('A payment reference is required.', 400);
  const order = await Order.findOne({ reference: ref }).sort({ createdAt: -1 });
  if (!order) throw new PaystackError('Order not found for that reference.', 404);
  if (order.status === 'PAID') {
    throw new PaystackError('This order is already paid; no payment link should be sent.', 409);
  }
  if (order.paymentLinkStatus === 'UNKNOWN' && !force) {
    throw new PaystackError('The previous delivery outcome is uncertain. Confirm with the customer, then retry with force.', 409);
  }
  const delivered = await deliverPaymentLink(order, { sendMessage, force });
  return summarizeOrder(delivered);
}

export function verifyPaystackSignature(rawBody, signature) {
  const secret = (process.env.PAYSTACK_SECRET_KEY || '').trim();
  if (!secret || !PAYSTACK_KEY_PATTERN.test(secret) || !signature) return false;
  const expected = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
  const provided = Buffer.from(String(signature));
  const wanted = Buffer.from(expected);
  return provided.length === wanted.length && crypto.timingSafeEqual(provided, wanted);
}

/**
 * Handle a Paystack webhook. `charge.success` is never trusted on its own: the
 * transaction is re-verified with Paystack before any order becomes PAID.
 */
export async function applyPaystackEvent(event, { sendMessage } = {}) {
  const type = String(event?.event || '');
  const reference = String(event?.data?.reference || '');
  if (!reference) return { handled: false, reason: 'Webhook carried no reference.' };

  const order = await Order.findOne({ reference });
  if (!order) {
    console.warn(`[paystack] webhook for unknown reference ${reference}`);
    return { handled: false, reason: 'Unknown order reference.' };
  }

  if (type === 'charge.success') {
    if (order.status === 'PAID') {
      // Retry a previously failed confirmation send; the claim makes this a no-op
      // once the customer has been notified.
      await notifyCustomerPaid(order, { sendMessage });
      return { handled: true, alreadyPaid: true, order };
    }
    const verified = await verifyTransaction(reference);
    if (String(verified?.status) !== 'success') {
      console.warn(`[paystack] webhook says success but verification returned ${verified?.status} for ${reference}`);
      return { handled: false, reason: `Transaction status is ${verified?.status || 'unknown'}.` };
    }
    return { handled: true, ...(await markOrderPaid(order, verified, { sendMessage })) };
  }

  if (type === 'charge.failed') {
    if (order.status === 'PAID') {
      return { handled: true, alreadyPaid: true, order };
    }
    const updated = await Order.findOneAndUpdate(
      { _id: order._id, status: { $ne: 'PAID' } },
      { $set: { status: 'FAILED', providerData: event?.data || {} } },
      { new: true },
    );
    return { handled: true, order: updated || order };
  }

  return { handled: false, reason: `Ignored event ${type}.` };
}

/**
 * Return the real payment status for an order. When the order is still pending the
 * transaction is re-checked with Paystack so a missed webhook cannot leave it stuck.
 */
export async function getPaymentStatus(reference, { sendMessage } = {}) {
  const ref = String(reference || '').trim();
  if (!ref) throw new PaystackError('A payment reference is required.', 400);
  const order = await Order.findOne({ reference: ref });
  if (!order) throw new PaystackError('Order not found for that reference.', 404);
  if (order.status === 'PAID') {
    await notifyCustomerPaid(order, { sendMessage });
    return summarizeOrder(order);
  }

  let verified = null;
  try {
    verified = await verifyTransaction(ref);
  } catch (error) {
    console.error(`[paystack] status check failed for ${ref}: ${error.message}`);
  }

  if (verified && String(verified.status) === 'success') {
    const result = await markOrderPaid(order, verified, { sendMessage });
    return summarizeOrder(result.order || order, { provider_status: verified.status });
  }
  if (verified && ['failed', 'reversed'].includes(String(verified.status))) {
    const updated = await Order.findOneAndUpdate(
      { _id: order._id, status: { $ne: 'PAID' } },
      { $set: { status: 'FAILED', providerData: verified } },
      { new: true },
    );
    return summarizeOrder(updated || order, { provider_status: verified.status });
  }
  if (verified && String(verified.status) === 'abandoned') {
    const updated = await Order.findOneAndUpdate(
      { _id: order._id, status: { $ne: 'PAID' } },
      { $set: { status: 'ABANDONED', providerData: verified } },
      { new: true },
    );
    return summarizeOrder(updated || order, { provider_status: verified.status });
  }
  return summarizeOrder(order, { provider_status: verified?.status || null });
}

/**
 * Operator-controlled retry for a PAID order's WhatsApp confirmation. `force` is
 * required for UNKNOWN outcomes because an earlier message may already have been
 * delivered. This never changes payment state.
 */
export async function retryPaidNotification(reference, { force = false, sendMessage } = {}) {
  const ref = String(reference || '').trim();
  if (!ref) throw new PaystackError('A payment reference is required.', 400);
  const order = await Order.findOne({ reference: ref });
  if (!order) throw new PaystackError('Order not found for that reference.', 404);
  if (order.status !== 'PAID') {
    throw new PaystackError('Only a verified PAID order can send a payment confirmation.', 409);
  }
  const updated = await notifyCustomerPaid(order, { force, sendMessage });
  return paidNotificationSummary(updated || order);
}

/**
 * Lightweight recovery for notification delivery failures. It only picks up
 * PENDING/FAILED notifications whose lock is stale; UNKNOWN/SENDING outcomes are
 * left for an explicit operator retry so uncertain sends are not duplicated.
 */
export async function retryPendingPaidNotifications({ limit = 20, sendMessage } = {}) {
  const cutoff = new Date(Date.now() - NOTIFICATION_RETRY_AFTER_MS);
  const orders = await Order.find({
    status: 'PAID',
    paidNotificationStatus: { $in: ['PENDING', 'FAILED'] },
    paidNotificationAttempts: { $lt: NOTIFICATION_MAX_ATTEMPTS },
    $or: [
      { paidNotificationLastAttemptAt: { $exists: false } },
      { paidNotificationLastAttemptAt: { $lt: cutoff } },
    ],
  }).sort({ paidNotificationLastAttemptAt: 1 }).limit(Math.max(1, Number(limit) || 20));

  let attempted = 0;
  for (const order of orders) {
    await notifyCustomerPaid(order, { sendMessage });
    attempted += 1;
  }
  return { attempted };
}

export function startPaidNotificationRetryLoop({ intervalMs } = {}) {
  const interval = Math.max(15000, Number(intervalMs) || NOTIFICATION_RETRY_INTERVAL_MS);
  const timer = setInterval(() => {
    retryPendingPaidNotifications()
      .then(({ attempted }) => {
        if (attempted > 0) console.log(`[paystack] retried ${attempted} payment confirmation(s)`);
      })
      .catch((error) => console.error(`[paystack] payment notification retry failed: ${error.message}`));
  }, interval);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}
