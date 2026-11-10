import { findMentionedProducts } from './product-catalog.js';

// Intents that must never be answered by the sales agent. They are routed to a
// human exactly once and then the conversation stays in handoff.
export const HUMAN_HANDOFF_INTENTS = new Set([
  'REFUND',
  'PAYMENT_DISPUTE',
  'COMPLAINT',
  'DISCOUNT_REQUEST',
  'LARGE_ORDER',
  'HUMAN_REQUEST',
  'UNKNOWN',
]);

// A confirmed/paid order must not be silently edited by the AI. The customer is
// routed to a human for changes, cancellations and refunds after payment.
const PAID_ORDER_STATES = new Set(['PAYMENT_PENDING', 'PAID', 'PROCESSING', 'COMPLETED']);

// How recent the assistant's confirmation prompt must be for a short reply ("yes")
// to count as the confirmation of that order rather than an unrelated message.
const CONFIRMATION_CONTEXT_MS = Math.max(60000, Number(process.env.ORDER_CONFIRMATION_CONTEXT_MS) || 30 * 60 * 1000);

const GREETING_PATTERN = /^(?:(?:hi|hello|hey)(?:\s+there)?|good\s+(?:morning|afternoon|evening))[\s!.,?]*$/i;
const GREETING_PREFIX_PATTERN = /^(?:hi|hello|hey|good\s+(?:morning|afternoon|evening))\b/i;
const GREETING_SMALLTALK_PATTERN = /^(?:hi|hello|hey)\b.*\b(?:how are you|how(?:'s| is) it going|good to see you)\b/i;

const REFUND_PATTERN = /\brefund\b|\bmoney back\b|\breturn (?:my|the) money\b|\breimburse(?:ment)?\b|\breverse (?:the |my )?payment\b|\bgive me back my money\b|\bmy money back\b/;
const COMPLAINT_PATTERN = /\bcomplain(?:t|ing)?\b|\bangry\b|\bterrible\b|\bawful\b|\bhorrible\b|\bunacceptable\b|\bdisappoint(?:ed|ing|ment)?\b|\bnot happy\b|\bunhappy\b|\bfrustrat(?:ed|ing|ion)?\b|\bworst\b|\bbad service\b|\bpoor service\b|\brude\b|\buseless\b|\b(?:order|delivery|food) (?:is|was) late\b|\bwaiting (?:for )?(?:so long|ages|hours)\b|\bcold food\b|\bfood (?:is|was) cold\b|\b(?:order|food) (?:is|was) (?:late|wrong|missing)\b|\bwrong order\b|\bmissing (?:item|food|order)\b|\bnever (?:received|got)\b|\bhaven'?t (?:received|got)\b|\bstill waiting\b|\bnot satisfied\b|\bnot (?:good|nice|fresh)\b|\btoo (?:cold|salty|dry)\b|\bdisgusting\b/;
const PAYMENT_DISPUTE_PATTERN = /\bcharged twice\b|\bdouble charge(?:d)?\b|\bduplicate charge\b|\bovercharg(?:e|ed)\b|\bwrong amount\b|\bdispute\b|\bfraud\b|\bscam(?:med)?\b|\bdeducted\b|\bdebited\b|\btook my money\b|\bpayment (?:failed|declined)\b|\bmy payment failed\b|\bi (?:have )?paid\b|\balready paid\b|\bi paid\b/;
const PAYMENT_STATUS_PATTERN = /\bpayment status\b|\b(?:transaction) status\b|\bdid (?:my|the) payment (?:go through|reflect|arrive|reach)\b|\bhas (?:my|the) payment (?:gone through|reflected|arrived)\b|\bhave you (?:received|got) my payment\b|\bis my payment (?:paid|confirmed|complete|completed)\b|\bpayment (?:went through|confirmed)\b|\bhow much did i pay\b/;
const PAYMENT_INFO_PATTERN = /\bhow (?:do|can|should) i pay\b|\bhow to pay\b|\bpayment methods?\b|\bpay on delivery\b|\bmobile money\b|\bmomo\b|\bpay with (?:cash|card|momo|mobile money)\b|\bpayment link\b|\bdo you accept (?:cash|card|momo|mobile money)\b/;
const ORDER_STATUS_PATTERN = /\bwhere(?:'s| is) my order\b|\border status\b|\bstatus of my order\b|\btrack(?:ing)? (?:my )?order\b|\bwhen (?:will|is) my order\b|\bis my order (?:ready|confirmed|done|completed|paid)\b|\bhas my order (?:been )?(?:ready|dispatched|delivered|confirmed)\b|\bdid (?:you|u) (?:send|deliver) my order\b|\bwhat did i order\b/;
const DISCOUNT_PATTERN = /\bdiscount\b|\bcheaper\b|\blower price\b|\bnegotiate\b|\bany deal\b|\bpromo(?:tion)?\b/;
const LARGE_ORDER_PATTERN = /\bbulk\b|\bwholesale\b|\blarge order\b|\b(?:[2-9]\d|\d{3,})\s*(?:bags?|packs?|plates?|portions?|orders?)\b/;
const HUMAN_REQUEST_PATTERN = /\b(?:real person|human|operator|representative|manager)\b|\bi (?:want|need) (?:an? )?agent\b|\b(?:speak|talk|chat) (?:to|with) (?:someone|somebody|a human|a person|an agent|the owner|the manager)\b|\bcall me\b|\bcontact me\b|\bcustomer support\b|\bsupport (?:team|agent)\b|\bkofi\b/;

const THANKS_PATTERN = /\b(?:thanks?|thank you|appreciate(?: it)?)\b/;
const GOODBYE_PATTERN = /\b(?:bye|goodbye|see you|good night)\b/;
const ORDER_CANCELLATION_PATTERN = /\bcancel\b|\bnever mind\b|\bforget (?:it|the order)\b|\bstop the order\b/;
const ORDER_MODIFICATION_PATTERN = /\b(?:add|remove|change|update|modify|swap|replace|delete|take out|instead)\b|\bmake\s+(?:the|it|that)\b/;
const ORDER_INTENT_PATTERN = /\b(?:i\s+(?:want|would like|'d like|will take|'ll take|need|will have|'ll have)|i(?:'d| would)\s+like|can i (?:get|order|have)|give me|send me|order|i(?:'m| am) (?:ordering|buying)|i(?:'ll| will) go with)\b/;
const REFERENCE_PATTERN = /\b(?:that one|this one|the other one|the other (?:option|item)|the same|same as before|(?:first|second|third|last) one)\b|^(?:that|it)\.?$/i;
const QUANTITY_PATTERN = /^(?:(?:can i (?:get|have)\s+)?(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)(?:\s+(?:packs?|plates?|portions?|orders?))?|(?:make it|i want|i(?:'ll| will) take)\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)(?:\s+(?:packs?|plates?|portions?|orders?))?)\s*[.!?]*$/;
const BARE_QUANTITY_PATTERN = /^(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)(?:\s+(?:packs?|plates?|portions?|orders?))?\s*[.!?]*$/;
const DECLINE_PATTERN = /\b(?:not yet|not now|no|nope|later|wait)\b/;
const AMBIGUOUS_PATTERN = /\b(?:maybe|perhaps|not sure|i think so|what do you mean|which one|i don't know)\b|^(?:ok|okay|yes|yeah|yep)\s*\?$/i;
const SHORT_YES_NO_PATTERN = /^(?:yes|yeah|yep|no|nope|maybe|perhaps|not yet|later)\s*[.!]*$/i;
const SMALLTALK_PATTERN = /\b(?:how are you|how(?:'s| is) it going|what(?:'s| is) up|nice|cool|great|i see|alright|ok|okay)\b/;

const AVAILABILITY_PATTERN = /\b(?:available|in stock|do you have|is there|any more|sold out)\b/;
const PRICE_PATTERN = /\bprice\b|\bcost\b|\bhow much\b|\btotal\b|\bgh[₵c]?\s*\d|\b\d+\s*(?:ghs|ghc|cedis?)\b|\bfor\s+(?:one|a)\s+pack\b/;
const DELIVERY_PATTERN = /\bdeliver(y|ies|ing|ed)?\b|\bdelivery\b/;
const BUSINESS_INFO_PATTERN = /\bwhere (?:are|is) (?:you|your (?:shop|store|restaurant|business))\b|\b(?:your )?(?:location|address)\b|\bopening (?:hours|times?)\b|\bare you open\b|\bwhat time (?:do|does) (?:you|the shop|the store) (?:open|close)\b|\b(?:open|close|closed|opening|closing)\b|\bcontact (?:details|info|information|number)\b|\bphone (?:number)?\b|\bwebsite\b|\binstagram\b|\bfacebook\b|\bsocial media\b|\bwho (?:owns|runs) (?:this|the)\b|\babout (?:you|your (?:shop|store|business|restaurant))\b|\byour name\b|\bwhat(?:'s| is) your name\b/;
const MENU_PATTERN = /\bmenu\b|\bfood\b|\bdish(?:es)?\b|\bitems?\b|\bsell(?:ing)?\b|\bserve(?:s|ing)?\b|\bpacks?\b|\brice\b|\bjollof\b|\bnoodles?\b|\bdrinks?\b|\bbeverages?\b|\bsnacks?\b|\bmeals?\b|\bwhat do you have\b|\bwhat can i (?:order|get)\b|\bwhat(?:'s| is) available\b|\boptions\b/;

const normalizeText = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * True only when the latest assistant message before this inbound explicitly asked
 * the customer to confirm the order, and that prompt is still recent. The current
 * inbound is ignored even though message-processing includes it in history.
 */
export function hasPendingOrderConfirmation(history = [], content = '') {
  const messages = Array.isArray(history) ? history : [];
  const current = normalizeText(content);
  let end = messages.length;
  if (end > 0 && messages[end - 1]?.direction === 'INBOUND' && normalizeText(messages[end - 1]?.content) === current) {
    end -= 1;
  }
  for (let index = end - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.senderType === 'SYSTEM') continue;
    if (message.direction !== 'OUTBOUND' || !['AI', 'HUMAN'].includes(message.senderType)) return false;
    const rawTime = message.createdAt ?? message.updatedAt;
    if (rawTime !== undefined && rawTime !== null) {
      const timestamp = new Date(rawTime).getTime();
      if (Number.isFinite(timestamp) && Date.now() - timestamp > CONFIRMATION_CONTEXT_MS) return false;
    }
    return CONFIRMATION_REQUEST_PATTERN.test(normalizeText(message.content));
  }
  return false;
}

// The previous outbound message must explicitly ask for the order confirmation. This
// prevents "yes" after an unrelated question (drinks, delivery address, etc.) from
// being treated as an order confirmation.
const CONFIRMATION_REQUEST_PATTERN = /\b(?:please|kindly)\s+confirm\s+(?:your|the|this)\s+order\b|\bconfirm\s+(?:your|the|this)\s+order\b|\breply\s+(?:with\s+)?(?:yes|confirm)(?:\s+to\s+(?:confirm|place)\s+(?:the|your)\s+order)?\b|\b(?:shall|should|may)\s+i\s+(?:go\s+ahead\s+and\s+)?(?:place|confirm|create)\s+(?:the|your)\s+order\b|\bwould\s+you\s+like\s+me\s+to\s+(?:place|confirm|create)\s+(?:the|your)\s+order\b|\bdo\s+you\s+want\s+me\s+to\s+(?:place|confirm|create)\s+(?:the|your)\s+order\b|\bgo\s+ahead\s+and\s+(?:place|confirm)\s+(?:the|your)\s+order\b|\bready\s+to\s+(?:place|confirm)\s+(?:the|your)\s+order\b/i;

// Whole-message confirmation replies only. A vague "yes" is handled separately and
// requires an active confirmation prompt; otherwise it must not create a payment.
const CONFIRMATION_MESSAGE_PATTERN = new RegExp(
  '^(?:(?:yes|yeah|yep|ok|okay|sure|alright)\\s*[,!.]?\\s*)?'
  + '(?:please\\s+)?'
  + '(?:'
  + 'confirm(?:ed)?(?:\\s+(?:(?:the|my|this)\\s+)?order)?'
  + '|i\\s+confirm(?:\\s+(?:(?:the|my|this)\\s+)?order)?'
  + '|proceed(?:\\s+with\\s+(?:(?:the|my)\\s+)?order)?'
  + '|go\\s+ahead(?:\\s+and\\s+(?:place|confirm|create|proceed)(?:\\s+(?:(?:the|my)\\s+)?order)?)?'
  + '|place\\s+(?:(?:the|my)\\s+)?order'
  + '|checkout'
  + '|i(?:\'m|\\s+am)\\s+ready\\s+to\\s+(?:pay|order)'
  + '|i(?:\'ll|\\s+will)\\s+take\\s+(?:it|them|the\\s+order)'
  + '|(?:yes|yeah|yep|ok|okay|sure|alright)\\s*,?\\s*please'
  + ')'
  + '(?:\\s+please)?\\s*[.!]*$',
  'i',
);
const SIMPLE_CONFIRMATION_PATTERN = /^(?:yes|yeah|yep|ok|okay|sure|alright)\s*[.!]*$/i;

export function handoffReasonForIntent(intent) {
  const normalized = String(intent || '');
  if (normalized === 'HUMAN_REQUEST') return 'UNKNOWN';
  return HUMAN_HANDOFF_INTENTS.has(normalized) ? normalized : null;
}

export function isHumanHandoffIntent(intent) {
  return Boolean(handoffReasonForIntent(intent));
}

/**
 * Deterministic intent classification. The Hermes agent is the only LLM in the
 * reply path: this function decides whether the message may reach that agent or
 * must be routed to a human. Confirmation wording is only recognised when an
 * active confirmation prompt exists, and sensitive intents always win.
 */
export function classifyIntent(text, { pendingOrder = false, hasDraft = false, orderState = 'IDLE' } = {}) {
  const normalized = normalizeText(text);
  const v = ` ${normalized} `;
  const paidOrder = PAID_ORDER_STATES.has(String(orderState || '').toUpperCase());

  if (REFUND_PATTERN.test(v)) return 'REFUND';
  if (COMPLAINT_PATTERN.test(v)) return 'COMPLAINT';
  if (PAYMENT_DISPUTE_PATTERN.test(v)) return 'PAYMENT_DISPUTE';
  if (PAYMENT_STATUS_PATTERN.test(v)) return 'PAYMENT_STATUS';
  if (HUMAN_REQUEST_PATTERN.test(v)) return 'HUMAN_REQUEST';
  if (DISCOUNT_PATTERN.test(v)) return 'DISCOUNT_REQUEST';
  if (LARGE_ORDER_PATTERN.test(v)) return 'LARGE_ORDER';

  // A paid/confirmed order may not be changed by the sales flow.
  if (paidOrder && (ORDER_CANCELLATION_PATTERN.test(v) || ORDER_MODIFICATION_PATTERN.test(v))) return 'HUMAN_REQUEST';

  if (ORDER_CANCELLATION_PATTERN.test(v)) return 'ORDER_CANCELLATION';
  // A modification after a confirmation invalidates the old confirmation. Check
  // this before confirmation so "yes, add a drink" is never a final confirmation.
  if (ORDER_MODIFICATION_PATTERN.test(v) && (hasDraft || pendingOrder)) return 'ORDER_MODIFICATION';
  if (ORDER_MODIFICATION_PATTERN.test(v) && !hasDraft && !pendingOrder) return 'AMBIGUOUS';
  if (ORDER_STATUS_PATTERN.test(v)) return 'ORDER_STATUS';
  if (PAYMENT_INFO_PATTERN.test(v)) return 'PAYMENT_INFO';
  if (pendingOrder && DECLINE_PATTERN.test(v)) return 'ORDER_DECLINED';
  if (pendingOrder && (CONFIRMATION_MESSAGE_PATTERN.test(normalized) || SIMPLE_CONFIRMATION_PATTERN.test(normalized))) {
    return 'ORDER_CONFIRMATION';
  }
  if (pendingOrder && AMBIGUOUS_PATTERN.test(normalized)) return 'AMBIGUOUS';
  if (PRICE_PATTERN.test(v)) return 'PRICE_ENQUIRY';
  if (AVAILABILITY_PATTERN.test(v)) return 'AVAILABILITY';
  if (DELIVERY_PATTERN.test(v)) return 'DELIVERY';
  if (THANKS_PATTERN.test(v)) return 'THANKS';
  if (GOODBYE_PATTERN.test(v)) return 'GOODBYE';
  if ((hasDraft || pendingOrder) && QUANTITY_PATTERN.test(normalized)) return 'ORDER_QUANTITY';
  if ((hasDraft || pendingOrder) && REFERENCE_PATTERN.test(normalized)) return 'ORDER_REFERENCE';
  if (BARE_QUANTITY_PATTERN.test(normalized)) return 'AMBIGUOUS';
  // These messages refer to a previous order or ask for a change, but without a
  // known draft the assistant must ask which order/item rather than hand off.
  if (REFERENCE_PATTERN.test(normalized) || ORDER_MODIFICATION_PATTERN.test(v)) return 'AMBIGUOUS';
  if (ORDER_INTENT_PATTERN.test(v)) return 'ORDER_INTENT';
  if (MENU_PATTERN.test(v)) return 'MENU';
  if (GREETING_PATTERN.test(normalized)) return 'GREETING';
  if (GREETING_SMALLTALK_PATTERN.test(normalized)) return 'GREETING';
  if (GREETING_PREFIX_PATTERN.test(normalized)) return 'GREETING';
  if (/\bhi\b|\bhello\b|\bgood morning\b/.test(v)) return 'GENERAL';
  if (SHORT_YES_NO_PATTERN.test(normalized) || AMBIGUOUS_PATTERN.test(normalized)) return 'AMBIGUOUS';
  if (SMALLTALK_PATTERN.test(v)) return 'GENERAL';
  if (BUSINESS_INFO_PATTERN.test(v)) return 'BUSINESS_INFO';
  return 'UNKNOWN';
}

/**
 * Decide whether the inbound message can reach the Hermes reply agent.
 *
 * This is intentionally deterministic. The previous implementation made a second
 * LLM call just to estimate confidence, which could hand a simple "Hi" to a human
 * when the provider timed out, and doubled latency/cost. Actual language
 * understanding and reply generation happen once in Hermes; this layer owns the
 * safety boundary and the structured order state.
 */
export async function generateAiDecision(content, history = [], { conversation = null } = {}) {
  const hasDraft = Boolean(conversation?.orderDraft?.items?.length);
  const orderState = conversation?.orderState || 'IDLE';
  const draftAwaitingConfirmation = hasDraft && orderState === 'AWAITING_CONFIRMATION';
  const pendingOrder = hasPendingOrderConfirmation(history, content) || draftAwaitingConfirmation;
  const intent = classifyIntent(content, { pendingOrder, hasDraft, orderState });
  const mentionedProductIds = findMentionedProducts(content).map(({ product }) => product.id);

  if (intent === 'ORDER_CONFIRMATION') {
    return {
      intent,
      confidence: 1,
      requiresHuman: false,
      response: null,
      reason: 'Deterministic order confirmation with an active pending order.',
      deterministic: true,
      mentionedProductIds,
    };
  }

  if (isHumanHandoffIntent(intent)) {
    return {
      intent,
      confidence: 1,
      requiresHuman: true,
      response: null,
      reason: handoffReasonForIntent(intent) === 'UNKNOWN' && intent === 'HUMAN_REQUEST'
        ? 'The customer asked for a human.'
        : 'This type of request requires a human.',
      deterministic: true,
      mentionedProductIds,
    };
  }

  return {
    intent,
    confidence: 1,
    requiresHuman: false,
    response: null,
    reason: 'Deterministic classification; the Hermes agent generates the reply.',
    deterministic: true,
    mentionedProductIds,
  };
}
