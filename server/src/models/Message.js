import mongoose from 'mongoose';
const Message = new mongoose.Schema({
  conversationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true, index: true },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
  content: { type: String, required: true, trim: true, maxlength: 5000 },
  direction: { type: String, enum: ['INBOUND', 'OUTBOUND'], required: true },
  senderType: { type: String, enum: ['CUSTOMER', 'AI', 'HUMAN', 'SYSTEM'], required: true },
  aiConfidence: Number,
  aiIntent: String,
  externalId: { type: String, unique: true, sparse: true, index: true }
}, { timestamps: true });
export default mongoose.model('Message', Message);