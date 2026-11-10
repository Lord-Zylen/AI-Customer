import mongoose from 'mongoose';

const OrderItem = new mongoose.Schema({
  productId: { type: String, default: '', trim: true },
  name: { type: String, required: true, trim: true },
  quantity: { type: Number, default: 1, min: 1 },
  unitPrice: { type: Number, default: 0, min: 0 },
  unitPriceMinor: { type: Number, default: 0, min: 0 },
  lineTotal: { type: Number, default: 0, min: 0 },
  lineTotalMinor: { type: Number, default: 0, min: 0 },
}, { _id: false });

const Order = new mongoose.Schema({
  reference: { type: String, required: true, unique: true, index: true },
  provider: { type: String, enum: ['PAYSTACK'], default: 'PAYSTACK' },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', index: true },
  conversationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', index: true },
  sessionId: { type: String, default: '', index: true },
  chatId: { type: String, default: '' },
  customerName: { type: String, default: '' },
  customerEmail: { type: String, default: '' },
  description: { type: String, default: '' },
  // Deterministic basket identity: chat/session + product ids + quantities +
  // trusted total + currency. Used instead of amount alone so two different
  // baskets that happen to cost the same never reuse each other's link.
  fingerprint: { type: String, default: '' },
  items: { type: [OrderItem], default: [] },
  amount: { type: Number, required: true, min: 0 },
  amountMinor: { type: Number, required: true, min: 1 },
  currency: { type: String, required: true, uppercase: true, default: 'GHS' },
  status: {
    type: String,
    enum: ['INITIALIZED', 'PAID', 'FAILED', 'ABANDONED'],
    default: 'INITIALIZED',
    index: true,
  },
  paymentUrl: { type: String, default: '' },
  accessCode: { type: String, default: '' },
  paidAt: Date,
  verifiedAt: Date,
  paidAmountMinor: Number,
  paidCurrency: { type: String, uppercase: true, default: '' },
  paymentChannel: { type: String, default: '' },
  paidNotifiedAt: Date,
  // Paid-notification delivery lifecycle, separate from payment truth. A failure
  // here never changes the PAID status or reverses the successful transaction.
  paidNotificationStatus: {
    type: String,
    enum: ['PENDING', 'SENDING', 'QUEUED', 'SENT', 'FAILED', 'UNKNOWN'],
    index: true,
  },
  paidNotificationChatId: { type: String, default: '' },
  paidNotificationAttempts: { type: Number, default: 0, min: 0 },
  paidNotificationLastAttemptAt: Date,
  paidNotificationSentAt: Date,
  paidNotificationQueuedAt: Date,
  paidNotificationMessageId: { type: String, default: '' },
  paidNotificationError: { type: String, default: '' },
  // Deterministic payment-link delivery tracking. The link is sent by the
  // backend through Hermes, not by the AI, so its lifecycle is stored here.
  paymentLinkStatus: {
    type: String,
    enum: ['PENDING', 'SENDING', 'QUEUED', 'SENT', 'FAILED', 'UNKNOWN'],
    default: 'PENDING',
    index: true,
  },
  paymentLinkChatId: { type: String, default: '' },
  paymentLinkAttempts: { type: Number, default: 0, min: 0 },
  paymentLinkLastAttemptAt: Date,
  paymentLinkSentAt: Date,
  paymentLinkQueuedAt: Date,
  paymentLinkMessageId: { type: String, default: '' },
  paymentLinkError: { type: String, default: '' },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  providerData: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

// At most one INITIALIZED order per basket fingerprint. PAID/FAILED/ABANDONED
// orders are outside the partial index, so a later repeat of the same basket is
// allowed after the previous one is settled. This is the concurrency guard for
// simultaneous link requests (the application also checks before creating).
// The name is shared with src/utils/ensure-order-indexes.js so the model and the
// explicit production migration can never disagree about the deployed index.
export const ORDER_FINGERPRINT_INDEX_NAME = 'fingerprint_1_initialized_unique';
Order.index(
  { fingerprint: 1 },
  {
    name: ORDER_FINGERPRINT_INDEX_NAME,
    unique: true,
    partialFilterExpression: {
      fingerprint: { $gt: '' },
      status: 'INITIALIZED',
    },
  },
);

export default mongoose.model('Order', Order);
