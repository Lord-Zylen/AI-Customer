import Customer from '../models/Customer.js';
import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';
import Order from '../models/Order.js';
import {
  buildOrderQuote,
  findMentionedProducts,
  getProduct,
  listProducts,
} from './product-catalog.js';

// A confirmation is short-lived because it is tied to the order the customer
// actually reviewed. If they come back much later, the basket must be reviewed
// and confirmed again rather than silently reusing an old confirmation.
const CONFIRMATION_TTL_MS = Math.max(
  60000,
  Number(process.env.ORDER_CONFIRMATION_TTL_MS) || 15 * 60 * 1000,
);
const CONTEXT_MESSAGE_LIMIT = 10;
const CONTEXT_MESSAGE_MAX_CHARS = 600;

export class OrderStateError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.name = 'OrderStateError';
    this.status = status;
  }
}

function canonicalItems(items = []) {
  return [...items]
    .map((item) => ({
      productId: String(item?.productId || '').trim().toLowerCase(),
      quantity: Number(item?.quantity),
    }))
    .filter((item) => item.productId && Number.isInteger(item.quantity) && item.quantity > 0)
    .sort((a, b) => (a.productId < b.productId ? -1 : (a.productId > b.productId ? 1 : 0)));
}

export function itemsSignature(items = []) {
  return JSON.stringify(canonicalItems(items));
}

export async function findOpenConversationForChat(chatId) {
  const identity = String(chatId || '').trim();
  if (!identity) return null;
  const customer = await Customer.findOne({ phone: identity });
  if (!customer) return null;
  return Conversation.findOne({
    customerId: customer._id || customer.id,
    status: { $ne: 'RESOLVED' },
  }).sort({ updatedAt: -1 });
}

function draftQuote(conversation) {
  const items = conversation?.orderDraft?.items || [];
  if (!items.length) return null;
  try {
    return buildOrderQuote(items);
  } catch {
    return null;
  }
}

function assertAiOwnsConversation(conversation) {
  if (!conversation) {
    throw new OrderStateError('No open conversation was found for this customer. Ask the customer to start the order again.', 409);
  }
  if (conversation.status === 'RESOLVED' || conversation.requiresHuman
    || conversation.status === 'HUMAN_REQUIRED' || conversation.aiEnabled === false) {
    throw new OrderStateError('A team member is already handling this conversation. The AI cannot change the order or start payment.', 409);
  }
}

/**
 * Remember which catalogue item(s) the customer mentioned so later references
 * ("is it available?", "that one", "make it two") can be resolved deterministically.
 * A generic "rice" is ambiguous, so it keeps both rice options and clears any
 * stale specific item; the agent must ask which rice.
 */
export function recordMentionedProducts(conversation, text) {
  if (!conversation) return conversation;
  const mentions = findMentionedProducts(text);
  if (!mentions.length) return conversation;
  conversation.lastMentionedProductIds = [...new Set(mentions.map(({ product }) => product.id))];
  const specific = mentions.filter((mention) => mention.specific);
  if (specific.length === 1) {
    conversation.lastDiscussedProductId = specific[0].product.id;
  } else if (specific.length > 1) {
    conversation.lastDiscussedProductId = specific[specific.length - 1].product.id;
  } else {
    // Only a generic "rice" was mentioned. Do not let a stale previous item make
    // "is it available?" look specific; the agent should ask which rice.
    conversation.lastDiscussedProductId = '';
  }
  return conversation;
}

export function applyDecisionToConversation(conversation, decision) {
  if (!conversation || !decision?.intent) return conversation;
  const now = new Date();
  conversation.lastIntent = decision.intent;
  conversation.lastIntentAt = now;

  const hasDraft = Array.isArray(conversation.orderDraft?.items) && conversation.orderDraft.items.length > 0;
  if (decision.intent === 'ORDER_CONFIRMATION' && hasDraft) {
    try {
      const quote = buildOrderQuote(conversation.orderDraft.items);
      conversation.orderState = 'CONFIRMED';
      conversation.orderConfirmation = {
        confirmedAt: now,
        expiresAt: new Date(now.getTime() + CONFIRMATION_TTL_MS),
        draftSignature: itemsSignature(quote.items),
        consumedAt: undefined,
      };
    } catch {
      // Corrupt/legacy draft: do not create a false confirmation. The agent will
      // have to save a valid draft again.
      conversation.orderState = 'COLLECTING_ORDER';
      conversation.orderConfirmation = undefined;
    }
  } else if (decision.intent === 'ORDER_MODIFICATION' && hasDraft) {
    // Changing the basket invalidates any previous confirmation.
    conversation.orderConfirmation = undefined;
    conversation.orderState = 'COLLECTING_ORDER';
  } else if (decision.intent === 'ORDER_CANCELLATION') {
    conversation.orderConfirmation = undefined;
    conversation.orderDraft = undefined;
    conversation.orderState = 'CANCELLED';
    conversation.lastDiscussedProductId = '';
  }
  return conversation;
}

export async function saveOrderDraft({ chatId, items, readyForConfirmation = false }) {
  const conversation = await findOpenConversationForChat(chatId);
  assertAiOwnsConversation(conversation);
  const quote = buildOrderQuote(items);

  // While a payment link is pending, only the exact same basket is idempotent.
  // A different basket needs a human because it is a change to an order the
  // customer already confirmed.
  if (conversation.orderState === 'PAYMENT_PENDING') {
    const pending = draftQuote(conversation);
    if (pending && itemsSignature(quote.items) === itemsSignature(pending.items)) {
      return { conversation, quote: pending, state: conversation.orderState, existing: true };
    }
    throw new OrderStateError('A payment link is already pending for this order. A team member must help change it.', 409);
  }

  const draftItems = quote.items.map((item) => ({
    productId: item.productId,
    quantity: item.quantity,
  }));
  conversation.orderDraft = {
    items: draftItems,
    totalMinor: quote.totalMinor,
    total: quote.total,
    currency: quote.currency,
    updatedAt: new Date(),
  };
  conversation.orderState = readyForConfirmation ? 'AWAITING_CONFIRMATION' : 'COLLECTING_ORDER';
  conversation.orderConfirmation = undefined;
  conversation.lastDiscussedProductId = draftItems[draftItems.length - 1].productId;
  await conversation.save();
  return { conversation, quote, state: conversation.orderState };
}

/**
 * Enforce the financial boundary for creating a payment link. The caller may only
 * start payment for the exact basket the customer was shown and explicitly
 * confirmed. Prices and totals are still calculated by buildOrderQuote.
 */
export async function assertPaymentAllowed({ chatId, items }) {
  const identity = String(chatId || '').trim();
  if (!identity) {
    throw new OrderStateError('A WhatsApp chat id is required before a payment link can be created.', 400);
  }
  const conversation = await findOpenConversationForChat(identity);
  assertAiOwnsConversation(conversation);
  const quote = buildOrderQuote(items);
  const draft = draftQuote(conversation);
  if (!draft) {
    throw new OrderStateError('There is no reviewed order to pay for yet. Build the order and ask the customer to confirm it first.', 409);
  }
  if (itemsSignature(quote.items) !== itemsSignature(draft.items)) {
    conversation.orderConfirmation = undefined;
    conversation.orderState = 'COLLECTING_ORDER';
    await conversation.save();
    throw new OrderStateError('The requested items do not match the order the customer reviewed. Please confirm the updated order again.', 409);
  }

  // An already-created, still-payable order may reuse its link without a second
  // confirmation. The basket still has to match the reviewed draft above.
  if (conversation.orderState === 'PAYMENT_PENDING' && conversation.lastOrderReference) {
    return { conversation, quote, existingOrder: true };
  }

  if (conversation.orderState !== 'CONFIRMED' || !conversation.orderConfirmation?.confirmedAt) {
    throw new OrderStateError('Please ask the customer to confirm the final order before creating a payment link.', 409);
  }
  if (conversation.orderConfirmation.consumedAt) {
    throw new OrderStateError('This confirmed order has already been used. Review the order again before creating another link.', 409);
  }
  const expiresAt = new Date(conversation.orderConfirmation.expiresAt || 0).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) {
    conversation.orderConfirmation = undefined;
    conversation.orderState = 'AWAITING_CONFIRMATION';
    await conversation.save();
    throw new OrderStateError('The customer’s order confirmation has expired. Please ask them to confirm the order again.', 409);
  }
  return { conversation, quote, existingOrder: false };
}

export async function markPaymentStarted(conversation, reference) {
  if (!conversation) return conversation;
  conversation.orderState = 'PAYMENT_PENDING';
  conversation.lastOrderReference = String(reference || conversation.lastOrderReference || '');
  if (conversation.orderConfirmation) {
    conversation.orderConfirmation.consumedAt = new Date();
  }
  await conversation.save();
  return conversation;
}

export async function getConversationContext(chatId) {
  const conversation = await findOpenConversationForChat(chatId);
  const empty = {
    exists: false,
    chatId: String(chatId || ''),
    conversation: null,
    draft: null,
    recentMessages: [],
    latestOrder: null,
  };
  if (!conversation) return empty;

  const rawMessages = await Message.find({ conversationId: conversation._id || conversation.id })
    .sort({ createdAt: -1 })
    .limit(CONTEXT_MESSAGE_LIMIT);
  const recentMessages = [...rawMessages].reverse().map((message) => ({
    direction: message.direction,
    senderType: message.senderType,
    content: String(message.content || '').slice(0, CONTEXT_MESSAGE_MAX_CHARS),
    createdAt: message.createdAt || null,
  }));

  const latestOrder = await Order.findOne({ chatId: String(chatId || '').trim() })
    .sort({ createdAt: -1 })
    .select('reference status amount currency items paidAt createdAt');
  const draft = draftQuote(conversation);
  const lastProduct = getProduct(conversation.lastDiscussedProductId);
  const confirmation = conversation.orderConfirmation;

  return {
    exists: true,
    chatId: String(chatId || ''),
    conversation: {
      status: conversation.status,
      aiEnabled: conversation.aiEnabled,
      requiresHuman: Boolean(conversation.requiresHuman),
      orderState: conversation.orderState || 'IDLE',
      lastIntent: conversation.lastIntent || '',
      lastDiscussedProductId: conversation.lastDiscussedProductId || '',
      lastDiscussedProduct: lastProduct ? {
        id: lastProduct.id,
        name: lastProduct.name,
        price: lastProduct.priceMinor / 100,
        currency: lastProduct.currency,
      } : null,
      lastMentionedProductIds: Array.isArray(conversation.lastMentionedProductIds)
        ? conversation.lastMentionedProductIds
        : [],
      handoffReason: conversation.handoffReason || '',
      handoffAt: conversation.handoffAt || null,
      lastOrderReference: conversation.lastOrderReference || '',
      confirmation: confirmation?.confirmedAt ? {
        confirmed: true,
        confirmedAt: confirmation.confirmedAt,
        expiresAt: confirmation.expiresAt || null,
        consumed: Boolean(confirmation.consumedAt),
      } : null,
    },
    draft: draft ? {
      items: draft.items,
      totalMinor: draft.totalMinor,
      total: draft.total,
      currency: draft.currency,
      readyForConfirmation: conversation.orderState === 'AWAITING_CONFIRMATION',
    } : null,
    catalog: listProducts(),
    recentMessages,
    latestOrder: latestOrder || null,
    paymentStatus: latestOrder?.status || null,
  };
}

/**
 * Look up the latest order for a WhatsApp chat. This is read-only and scoped to
 * the chat supplied by the authenticated Hermes hook, so one customer can never
 * inspect another customer's order.
 */
export async function getLatestOrderStatus({ chatId, reference = '' } = {}) {
  const identity = String(chatId || '').trim();
  if (!identity) throw new OrderStateError('A WhatsApp chat id is required.', 400);
  const ref = String(reference || '').trim();
  const order = ref
    ? await Order.findOne({ reference: ref })
    : await Order.findOne({ chatId: identity }).sort({ createdAt: -1 });
  if (!order || String(order.chatId || '') !== identity) {
    throw new OrderStateError('No order was found for this chat.', 404);
  }
  const conversation = await findOpenConversationForChat(identity);
  return {
    reference: order.reference,
    status: order.status,
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
    paymentUrl: order.paymentUrl || '',
    paidAt: order.paidAt || null,
    createdAt: order.createdAt || null,
    conversationState: conversation?.orderState || 'IDLE',
  };
}
