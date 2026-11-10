import mongoose from 'mongoose';

const OrderDraftItem = new mongoose.Schema({
  productId: { type: String, required: true, trim: true },
  quantity: { type: Number, required: true, min: 1 },
}, { _id: false });

const OrderDraft = new mongoose.Schema({
  items: { type: [OrderDraftItem], default: [] },
  totalMinor: { type: Number, default: 0, min: 0 },
  total: { type: Number, default: 0, min: 0 },
  currency: { type: String, default: 'GHS', uppercase: true },
  updatedAt: Date,
}, { _id: false });

const OrderConfirmation = new mongoose.Schema({
  confirmedAt: Date,
  expiresAt: Date,
  draftSignature: { type: String, default: '' },
  consumedAt: Date,
}, { _id: false });

const Conversation = new mongoose.Schema({
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
  channel: { type: String, default: 'WHATSAPP' },
  status: { type: String, enum: ['OPEN', 'HUMAN_REQUIRED', 'RESOLVED'], default: 'OPEN', index: true },
  aiEnabled: { type: Boolean, default: true },
  requiresHuman: { type: Boolean, default: false },
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  lastMessageAt: { type: Date, default: Date.now, index: true },
  // Structured conversation context. This is deliberately owned by the backend,
  // not the model, so order references and confirmation state cannot be invented.
  lastIntent: { type: String, default: '' },
  lastIntentAt: Date,
  lastDiscussedProductId: { type: String, default: '' },
  // Every catalogue item mentioned in the latest inbound message. Unlike
  // lastDiscussedProductId this keeps both rice options when the customer only
  // says "rice", so the agent can ask which one instead of guessing.
  lastMentionedProductIds: { type: [String], default: [] },
  orderState: {
    type: String,
    enum: ['IDLE', 'BROWSING_MENU', 'COLLECTING_ORDER', 'AWAITING_CONFIRMATION', 'CONFIRMED', 'PAYMENT_PENDING', 'PAID', 'CANCELLED'],
    default: 'IDLE',
    index: true,
  },
  orderDraft: { type: OrderDraft, default: undefined },
  orderConfirmation: { type: OrderConfirmation, default: undefined },
  lastOrderReference: { type: String, default: '' },
  handoffReason: { type: String, default: '' },
  handoffAt: Date,
  handoffAcknowledgedAt: Date,
  handoffResolvedAt: Date,
}, { timestamps: true });

export default mongoose.model('Conversation', Conversation);
