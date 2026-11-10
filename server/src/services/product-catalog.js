import crypto from 'node:crypto';

// Authoritative product catalogue. This is the single source of truth for the
// prices charged through Paystack. Prices are stored as integer pesewas so the
// order total never depends on floating-point arithmetic.
//
// The catalogue is intentionally in code (not the database) for this stage: the
// menu is fixed, it cannot be edited by the AI or a customer, and there is no
// admin interface to keep in sync.

export const CURRENCY = 'GHS';
export const MAX_ITEM_QUANTITY = 50;

const PRODUCTS = Object.freeze({
  jollof_rice: Object.freeze({ id: 'jollof_rice', name: 'Jollof Rice', priceMinor: 3000, currency: CURRENCY }),
  fried_rice: Object.freeze({ id: 'fried_rice', name: 'Fried Rice', priceMinor: 3000, currency: CURRENCY }),
  noodles: Object.freeze({ id: 'noodles', name: 'Noodles', priceMinor: 3000, currency: CURRENCY }),
});

// Customer-friendly aliases used only for deterministic context tracking. They
// never alter prices or availability; they just let the backend remember which
// product a later "is it available?" / "that one" refers to.
const PRODUCT_ALIASES = Object.freeze({
  jollof_rice: ['jollof rice', 'jollof'],
  fried_rice: ['fried rice', 'fried'],
  noodles: ['noodles', 'noodle'],
});
const RICE_PRODUCT_IDS = ['jollof_rice', 'fried_rice'];

export class PricingError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'PricingError';
    this.status = status;
  }
}

export function getProduct(productId) {
  return PRODUCTS[String(productId || '')] || null;
}

export function listProducts() {
  return Object.values(PRODUCTS).map((product) => ({
    id: product.id,
    name: product.name,
    price: product.priceMinor / 100,
    priceMinor: product.priceMinor,
    currency: product.currency,
  }));
}

function normalizedText(value) {
  return ` ${String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
}

/**
 * Deterministically find catalogue products mentioned in a customer message.
 *
 * A specific item ("jollof", "fried rice", "noodles") yields that product. A
 * generic "rice" yields both rice products marked `specific: false` so callers
 * can ask which one instead of guessing. Results are ordered by where they first
 * appear in the message.
 */
export function findMentionedProducts(value) {
  const text = normalizedText(value);
  const found = new Map();
  for (const [productId, aliases] of Object.entries(PRODUCT_ALIASES)) {
    const product = PRODUCTS[productId];
    for (const alias of aliases) {
      const index = text.indexOf(` ${alias} `);
      if (index === -1) continue;
      if (!found.has(productId) || index < found.get(productId).index) {
        found.set(productId, { product, index, specific: true });
      }
    }
  }
  if (![...found.keys()].some((id) => RICE_PRODUCT_IDS.includes(id))) {
    const riceIndex = text.indexOf(' rice ');
    if (riceIndex !== -1) {
      for (const productId of RICE_PRODUCT_IDS) {
        if (!found.has(productId)) {
          found.set(productId, { product: PRODUCTS[productId], index: riceIndex, specific: false });
        }
      }
    }
  }
  return [...found.values()].sort((a, b) => a.index - b.index);
}

function normalizeProductId(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new PricingError('Each item must include a productId.', 400);
  }
  return value.trim().toLowerCase();
}

function validateQuantity(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new PricingError('Each item quantity must be a positive whole number.', 400);
  }
  if (value > MAX_ITEM_QUANTITY) {
    throw new PricingError(`Each item quantity cannot exceed ${MAX_ITEM_QUANTITY}.`, 400);
  }
  return value;
}

/**
 * Validate an untrusted basket and build a trusted order snapshot.
 *
 * Input: [{ productId, quantity }, ...]. Any supplied prices (unitPrice,
 * unit_price, price) are deliberately ignored; only the catalogue price is used.
 *
 * Output: { items, totalMinor, total, currency }
 *   - totalMinor is the authoritative integer amount in pesewas.
 *   - total is a display-only major-unit representation derived from totalMinor.
 */
export function buildOrderQuote(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new PricingError('Order must contain at least one item.', 400);
  }
  if (items.length > 50) {
    throw new PricingError('Order contains too many item lines.', 400);
  }

  const quantities = new Map();
  for (const raw of items) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new PricingError('Each order item must be an object with productId and quantity.', 400);
    }
    const productId = normalizeProductId(raw.productId);
    const product = getProduct(productId);
    if (!product) {
      throw new PricingError(`Unknown product "${productId}".`, 400);
    }
    const quantity = validateQuantity(raw.quantity);
    const merged = (quantities.get(productId) || 0) + quantity;
    if (merged > MAX_ITEM_QUANTITY) {
      throw new PricingError(`Each item quantity cannot exceed ${MAX_ITEM_QUANTITY}.`, 400);
    }
    quantities.set(productId, merged);
  }

  let totalMinor = 0;
  const snapshot = [];
  for (const [productId, quantity] of quantities) {
    const product = PRODUCTS[productId];
    const unitPriceMinor = product.priceMinor;
    const lineTotalMinor = unitPriceMinor * quantity;
    totalMinor += lineTotalMinor;
    snapshot.push({
      productId,
      name: product.name,
      quantity,
      unitPriceMinor,
      unitPrice: unitPriceMinor / 100,
      lineTotalMinor,
      lineTotal: lineTotalMinor / 100,
    });
  }

  return {
    items: snapshot,
    totalMinor,
    total: totalMinor / 100,
    currency: CURRENCY,
  };
}

/**
 * Deterministic identity for an order basket. Two requests share a fingerprint
 * only when the same chat/session orders the same products in the same
 * quantities at the same trusted total and currency. Client-supplied prices are
 * never part of the quote, so they can never change the fingerprint.
 */
export function orderFingerprint({ chatId = '', sessionId = '', quote } = {}) {
  if (!quote || !Array.isArray(quote.items) || !Number.isInteger(quote.totalMinor) || !quote.currency) {
    throw new PricingError('A valid order quote is required to fingerprint an order.', 400);
  }
  const identity = chatId ? `chat:${chatId}` : (sessionId ? `session:${sessionId}` : '');
  if (!identity) {
    throw new PricingError('A customer/chat identity is required to fingerprint an order.', 400);
  }
  const items = [...quote.items]
    .sort((a, b) => (a.productId < b.productId ? -1 : (a.productId > b.productId ? 1 : 0)))
    .map((item) => [item.productId, item.quantity]);
  return crypto.createHash('sha256').update(JSON.stringify({
    version: 1,
    identity,
    currency: quote.currency,
    totalMinor: quote.totalMinor,
    items,
  })).digest('hex');
}

function formatMinor(minor) {
  return (minor / 100).toFixed(2);
}

/**
 * Compatibility guard for callers that still send an `amount`. The supplied
 * value is never used as the charge; it only has to agree with the trusted
 * total. Mismatches are rejected so a manipulated amount cannot pass silently.
 */
export function assertAmountMatches(totalMinor, suppliedAmount) {
  if (suppliedAmount === undefined || suppliedAmount === null || suppliedAmount === '') return;
  const value = Number(suppliedAmount);
  if (!Number.isFinite(value) || typeof suppliedAmount === 'boolean') {
    throw new PricingError('amount must be a valid number.', 400);
  }
  const rawMinor = value * 100;
  const suppliedMinor = Math.round(rawMinor);
  if (!Number.isSafeInteger(suppliedMinor)) {
    throw new PricingError('amount is too small or too large.', 400);
  }
  if (Math.abs(rawMinor - suppliedMinor) > 1e-6) {
    throw new PricingError('amount must not have more than 2 decimal places.', 400);
  }
  if (suppliedMinor !== totalMinor) {
    throw new PricingError(
      `amount does not match the trusted order total of GHS ${formatMinor(totalMinor)}.`,
      400,
    );
  }
}
