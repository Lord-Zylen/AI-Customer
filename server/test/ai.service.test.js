import test from 'node:test';
import assert from 'node:assert/strict';

process.env.AI_API_KEY = '';

const {
  classifyIntent,
  generateAiDecision,
  hasPendingOrderConfirmation,
} = await import('../src/services/ai.service.js');

function message(direction, senderType, content, ageMs = 0) {
  return {
    direction,
    senderType,
    content,
    createdAt: new Date(Date.now() - ageMs),
  };
}

function historyWithPrompt(prompt = 'Please confirm your order by replying YES.', ageMs = 0) {
  return [
    message('INBOUND', 'CUSTOMER', 'Two jollof rice please', 60000),
    message('OUTBOUND', 'AI', prompt, ageMs),
    message('INBOUND', 'CUSTOMER', 'yes', 0),
  ];
}

test('pending confirmation requires a recent explicit confirmation prompt', () => {
  assert.equal(hasPendingOrderConfirmation(historyWithPrompt(), 'yes'), true);
  assert.equal(
    hasPendingOrderConfirmation(historyWithPrompt('Would you like a drink with that?'), 'yes'),
    false,
  );
  assert.equal(
    hasPendingOrderConfirmation(historyWithPrompt('Please confirm your order by replying YES.', 31 * 60 * 1000), 'yes'),
    false,
  );
});

test('confirmation wording is deterministic only with a pending order', () => {
  assert.equal(classifyIntent('yes'), 'AMBIGUOUS');
  assert.equal(classifyIntent('yes', { pendingOrder: true }), 'ORDER_CONFIRMATION');
  assert.equal(classifyIntent('Please confirm the order.', { pendingOrder: true }), 'ORDER_CONFIRMATION');
  assert.equal(classifyIntent('proceed', { pendingOrder: true }), 'ORDER_CONFIRMATION');
  assert.equal(classifyIntent('yes refund', { pendingOrder: true }), 'REFUND');
});

test('classification keeps menu, delivery and real payment status paths distinct', () => {
  assert.equal(classifyIntent('What is on the menu?'), 'MENU');
  assert.equal(classifyIntent('How much is jollof rice?'), 'PRICE_ENQUIRY');
  assert.equal(classifyIntent('Do you deliver?'), 'DELIVERY');
  assert.equal(classifyIntent('Did my payment go through?'), 'PAYMENT_STATUS');
  assert.equal(classifyIntent('I paid already'), 'PAYMENT_DISPUTE');
});

test('greeting-only messages are distinguished from menu, price and order messages', () => {
  assert.equal(classifyIntent('Hi'), 'GREETING');
  assert.equal(classifyIntent('Hello there!'), 'GREETING');
  assert.equal(classifyIntent('Good morning.'), 'GREETING');
  assert.equal(classifyIntent('Hi, what do you sell?'), 'MENU');
  assert.equal(classifyIntent('How much is fried rice?'), 'PRICE_ENQUIRY');
  assert.equal(classifyIntent('I want jollof rice'), 'ORDER_INTENT');
});

test('generateAiDecision bypasses the model for a valid order confirmation', async () => {
  const decision = await generateAiDecision('yes', historyWithPrompt());
  assert.equal(decision.intent, 'ORDER_CONFIRMATION');
  assert.equal(decision.requiresHuman, false);
  assert.equal(decision.deterministic, true);
  assert.equal(decision.confidence, 1);
});

test('draft awaiting confirmation can confirm even if the outbound prompt record is missing', async () => {
  const decision = await generateAiDecision('yes', [], {
    conversation: {
      orderState: 'AWAITING_CONFIRMATION',
      orderDraft: { items: [{ productId: 'fried_rice', quantity: 2 }] },
    },
  });
  assert.equal(decision.intent, 'ORDER_CONFIRMATION');
  assert.equal(decision.deterministic, true);
});

test('greetings, menu, availability, references and closings are classified for natural replies', () => {
  assert.equal(classifyIntent('Hello, how are you?'), 'GREETING');
  assert.equal(classifyIntent('Hi, I want to order'), 'ORDER_INTENT');
  assert.equal(classifyIntent('Show me your menu.'), 'MENU');
  assert.equal(classifyIntent('What about noodles?'), 'MENU');
  assert.equal(classifyIntent('Is fried rice available?'), 'AVAILABILITY');
  assert.equal(classifyIntent('Is GH₵30 for one pack?'), 'PRICE_ENQUIRY');
  assert.equal(classifyIntent('I want rice.'), 'ORDER_INTENT');
  assert.equal(classifyIntent('How much?'), 'PRICE_ENQUIRY');
  assert.equal(classifyIntent('Order jollof and noodles.'), 'ORDER_INTENT');
  assert.equal(classifyIntent('Thank you.'), 'THANKS');
});

test('quantities, references and modifications require and use draft context', () => {
  assert.equal(classifyIntent('I want two.'), 'ORDER_INTENT');
  assert.equal(classifyIntent('I want two.', { hasDraft: true }), 'ORDER_QUANTITY');
  assert.equal(classifyIntent('I want that one.', { hasDraft: true }), 'ORDER_REFERENCE');
  assert.equal(classifyIntent('Same as before.', { hasDraft: true }), 'ORDER_REFERENCE');
  assert.equal(classifyIntent('Add another.', { hasDraft: true }), 'ORDER_MODIFICATION');
  assert.equal(classifyIntent('Remove one.', { hasDraft: true }), 'ORDER_MODIFICATION');
  assert.equal(classifyIntent('Make the jollof two.', { hasDraft: true }), 'ORDER_MODIFICATION');
  assert.equal(classifyIntent('Can I change my order?', { pendingOrder: true }), 'ORDER_MODIFICATION');
  assert.equal(classifyIntent('Yes please add a drink.', { pendingOrder: true }), 'ORDER_MODIFICATION');
});

test('ambiguous replies during confirmation ask for clarification instead of confirming or escalating', () => {
  assert.equal(classifyIntent('maybe', { pendingOrder: true }), 'AMBIGUOUS');
  assert.equal(classifyIntent('Ok?', { pendingOrder: true }), 'AMBIGUOUS');
  assert.equal(classifyIntent('Not yet.', { pendingOrder: true }), 'ORDER_DECLINED');
});

test('bare yes/no and references without an active order are clarified, not escalated', () => {
  assert.equal(classifyIntent('yes'), 'AMBIGUOUS');
  assert.equal(classifyIntent('no'), 'AMBIGUOUS');
  assert.equal(classifyIntent('same as before'), 'AMBIGUOUS');
  assert.equal(classifyIntent('add another'), 'AMBIGUOUS');
  assert.equal(classifyIntent('can i change my order?'), 'AMBIGUOUS');
});

test('ordinary smalltalk remains conversational instead of triggering a human handoff', () => {
  assert.equal(classifyIntent('How are you?'), 'GENERAL');
  assert.equal(classifyIntent('What is up?'), 'GENERAL');
  assert.equal(classifyIntent('Ok'), 'GENERAL');
  assert.equal(classifyIntent('Great, thanks!'), 'THANKS');
});

test('generateAiDecision still escalates sensitive wording despite a pending order', async () => {
  const decision = await generateAiDecision('yes refund', historyWithPrompt());
  assert.equal(decision.intent, 'REFUND');
  assert.equal(decision.requiresHuman, true);
});

test('all documented explicit confirmation phrases are deterministic', () => {
  const phrases = [
    'Yes.',
    'Yes, confirm.',
    'I confirm.',
    'Proceed.',
    'Place the order.',
    'Go ahead.',
    'Yes, go ahead and place the order.',
    'Yes, please proceed with my order.',
    'Yes please.',
  ];
  for (const phrase of phrases) {
    assert.equal(classifyIntent(phrase, { pendingOrder: true }), 'ORDER_CONFIRMATION', phrase);
  }
});

test('ambiguous or unrelated messages are not confirmations even with a pending prompt', () => {
  for (const phrase of [
    'Maybe.',
    'Yes please add a drink.',
    'Can I change my order?',
    'What is the total?',
    'Not yet.',
    'Ok?',
  ]) {
    assert.notEqual(classifyIntent(phrase, { pendingOrder: true }), 'ORDER_CONFIRMATION', phrase);
  }
});

test('confirmation without an active prompt is not treated as an order confirmation', async () => {
  assert.equal(classifyIntent('yes, confirm'), 'UNKNOWN');
  const decision = await generateAiDecision('yes, confirm', [
    message('INBOUND', 'CUSTOMER', 'Two jollof rice please', 60000),
  ]);
  assert.notEqual(decision.intent, 'ORDER_CONFIRMATION');
  assert.equal(decision.requiresHuman, true);
});

test('payment status questions reach the agent while disputes still hand off', async () => {
  const status = await generateAiDecision('yes what is my payment status', historyWithPrompt());
  assert.equal(status.intent, 'PAYMENT_STATUS');
  assert.equal(status.requiresHuman, false);

  const dispute = await generateAiDecision('yes I already paid', historyWithPrompt());
  assert.equal(dispute.intent, 'PAYMENT_DISPUTE');
  assert.equal(dispute.requiresHuman, true);
});

test('human-handoff conditions take precedence over a pending confirmation', async () => {
  const cases = [
    ['yes refund please', 'REFUND'],
    ['yes I have a complaint', 'COMPLAINT'],
    ['yes I was charged twice', 'PAYMENT_DISPUTE'],
    ['yes I already paid', 'PAYMENT_DISPUTE'],
    ['yes give me a discount', 'DISCOUNT_REQUEST'],
    ['yes I want 20 packs', 'LARGE_ORDER'],
  ];
  for (const [text, intent] of cases) {
    const decision = await generateAiDecision(text, historyWithPrompt());
    assert.equal(decision.intent, intent, text);
    assert.equal(decision.requiresHuman, true, text);
  }
});

test('deterministic decisions let safe conversational intents reach the agent', async () => {
  const cases = [
    ['Hi', 'GREETING'],
    ['What do you sell?', 'MENU'],
    ['How much is jollof?', 'PRICE_ENQUIRY'],
    ['Is fried rice available?', 'AVAILABILITY'],
    ['Where are you located?', 'BUSINESS_INFO'],
    ['Are you open?', 'BUSINESS_INFO'],
    ['How do I pay?', 'PAYMENT_INFO'],
    ['Where is my order?', 'ORDER_STATUS'],
    ['The food was cold', 'COMPLAINT'],
    ['The food was not good', 'COMPLAINT'],
    ['I want my money back', 'REFUND'],
    ['Can I speak to a human?', 'HUMAN_REQUEST'],
  ];
  for (const [text, intent] of cases) {
    const decision = await generateAiDecision(text, []);
    assert.equal(decision.intent, intent, text);
    assert.equal(decision.requiresHuman, intent === 'COMPLAINT' || intent === 'REFUND' || intent === 'HUMAN_REQUEST', text);
    assert.equal(decision.deterministic, true, text);
  }
});

test('availability and prices are never answered by inventing a new menu item', async () => {
  const decision = await generateAiDecision('Do you sell pizza?', []);
  assert.equal(decision.requiresHuman, false);
  assert.equal(typeof decision.response, 'object');
  assert.equal(decision.response, null);
});

test('generic rice references are tracked as ambiguous while a specific item is remembered', async () => {
  const jollof = await generateAiDecision('How much is jollof?', []);
  assert.deepEqual(jollof.mentionedProductIds, ['jollof_rice']);

  const rice = await generateAiDecision('How much is rice?', []);
  assert.deepEqual(rice.mentionedProductIds, ['jollof_rice', 'fried_rice']);
});

test('paid order changes are handed to a human instead of modifying the order', async () => {
  for (const orderState of ['PAYMENT_PENDING', 'PAID']) {
    const decision = await generateAiDecision('Change my order to two noodles', [], {
      conversation: {
        orderState,
        orderDraft: { items: [{ productId: 'jollof_rice', quantity: 1 }] },
      },
    });
    assert.equal(decision.intent, 'HUMAN_REQUEST', orderState);
    assert.equal(decision.requiresHuman, true, orderState);
  }
});

test('the request-human category maps to the existing UNKNOWN handoff category', async () => {
  const { handoffReasonForIntent, isHumanHandoffIntent } = await import('../src/services/ai.service.js');
  assert.equal(handoffReasonForIntent('HUMAN_REQUEST'), 'UNKNOWN');
  assert.equal(handoffReasonForIntent('REFUND'), 'REFUND');
  assert.equal(handoffReasonForIntent('PAYMENT_STATUS'), null);
  assert.equal(isHumanHandoffIntent('UNKNOWN'), true);
  assert.equal(isHumanHandoffIntent('GREETING'), false);
});

test('safe intents do not depend on an AI provider being configured', async () => {
  const previous = process.env.AI_API_KEY;
  process.env.AI_API_KEY = '';
  try {
    const greeting = await generateAiDecision('Hello', []);
    assert.equal(greeting.requiresHuman, false);
    assert.equal(greeting.intent, 'GREETING');
  } finally {
    process.env.AI_API_KEY = previous;
  }
});
