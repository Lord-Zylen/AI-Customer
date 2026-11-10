import { Router } from 'express';
import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';
import { requireAuth } from '../middleware/auth.js';
import { sendWhatsAppMessage } from '../services/whatsapp.service.js';
import { humanOutboundDedupeKey } from '../services/message-processing.service.js';
import { addHuman, removeHuman } from '../services/redis.service.js';

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const filter =
      req.query.filter === 'human' ? { requiresHuman: true }
      : req.query.filter === 'active' ? { aiEnabled: true, status: { $ne: 'RESOLVED' } }
      : req.query.filter === 'resolved' ? { status: 'RESOLVED' } : {};
    const conversations = await Conversation.find(filter)
      .populate('customerId', 'name phone email notes')
      .populate('assignedTo', 'name')
      .sort({ lastMessageAt: -1 })
      .limit(100);
    // Ascending order means the final write for each conversation is its newest
    // message. Previously the descending query let the oldest message win.
    const lastMessages = await Message.find({ conversationId: { $in: conversations.map(c => c._id) } }).sort({ createdAt: 1 });
    const latest = {};
    for (const message of lastMessages) latest[String(message.conversationId)] = message;
    res.json(conversations.map(c => ({ ...c.toObject(), lastMessage: latest[String(c._id)] || null })));
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const item = await Conversation.findById(req.params.id).populate('customerId', 'name phone email notes').populate('assignedTo', 'name');
    if (!item) return res.status(404).json({ error: { message: 'Conversation not found.' } });
    res.json(item);
  } catch (e) { next(e); }
});

export function normalizeConversationPatch(raw = {}) {
  const allowed = ['aiEnabled', 'status', 'requiresHuman', 'assignedTo'];
  const patch = Object.fromEntries(Object.entries(raw).filter(([k]) => allowed.includes(k)));
  if (patch.status) patch.status = String(patch.status).toUpperCase();

  if (patch.aiEnabled === true) {
    patch.requiresHuman = false;
    patch.status = 'OPEN';
    patch.handoffReason = '';
    patch.handoffAt = null;
    patch.handoffAcknowledgedAt = null;
    patch.handoffResolvedAt = new Date();
  } else if (patch.aiEnabled === false) {
    patch.requiresHuman = true;
    patch.status = 'HUMAN_REQUIRED';
    patch.handoffReason = 'MANUAL';
    patch.handoffAt = new Date();
    patch.handoffAcknowledgedAt = null;
  }

  if (patch.status === 'RESOLVED') {
    patch.requiresHuman = false;
    patch.handoffReason = '';
    patch.handoffAcknowledgedAt = null;
    patch.handoffResolvedAt = new Date();
  } else if (patch.status === 'HUMAN_REQUIRED') {
    patch.requiresHuman = true;
    patch.handoffReason = patch.handoffReason || 'MANUAL';
    patch.handoffAt = patch.handoffAt || new Date();
  } else if (patch.status === 'OPEN') {
    // Opening a conversation and leaving requiresHuman stale would immediately
    // re-handoff the next inbound. Treat OPEN as a real AI re-enable unless the
    // caller explicitly asks to keep human handling.
    if (patch.requiresHuman === undefined) patch.requiresHuman = false;
    if (patch.requiresHuman === false) {
      patch.handoffReason = '';
      patch.handoffAcknowledgedAt = null;
      patch.handoffResolvedAt = new Date();
    }
  }

  if (patch.requiresHuman === true && patch.status !== 'RESOLVED') {
    patch.status = 'HUMAN_REQUIRED';
    patch.handoffReason = patch.handoffReason || 'MANUAL';
    patch.handoffAt = patch.handoffAt || new Date();
  }
  return patch;
}

router.patch('/:id', async (req, res, next) => {
  try {
    const patch = normalizeConversationPatch(req.body);
    const item = await Conversation.findByIdAndUpdate(req.params.id, patch, { new: true, runValidators: true })
      .populate('customerId', 'name phone email notes')
      .populate('assignedTo', 'name');
    if (!item) return res.status(404).json({ error: { message: 'Conversation not found.' } });
    if (item.requiresHuman && item.status !== 'RESOLVED') {
      await addHuman(item.id, { chatId: item.customerId?.phone || '', reason: item.handoffReason || 'MANUAL', updatedAt: new Date().toISOString() });
    } else {
      await removeHuman(item.id);
    }
    res.json(item);
  } catch (e) { next(e); }
});

// Assign the conversation to the authenticated dashboard user. Safe when the
// conversation is already assigned: assigning to the same user is a no-op
// (no duplicate assignment state), and assigning to a different user simply
// moves the assignment. The conversation stays in the human queue until a
// human actually replies; assignment alone does not change its status.
router.post('/:id/assign', async (req, res, next) => {
  try {
    const item = await Conversation.findById(req.params.id);
    if (!item) return res.status(404).json({ error: { message: 'Conversation not found.' } });
    if (!String(item.assignedTo || '') || String(item.assignedTo) !== String(req.user.id)) {
      item.assignedTo = req.user.id;
      await item.save();
    }
    const updated = await Conversation.findById(req.params.id)
      .populate('customerId', 'name phone email notes')
      .populate('assignedTo', 'name');
    const lastMessage = await Message.findOne({ conversationId: updated._id }).sort({ createdAt: -1 });
    res.json({ ...updated.toObject(), lastMessage: lastMessage || null });
  } catch (e) { next(e); }
});

router.get('/:id/messages', async (req, res, next) => {
  try {
    res.json(await Message.find({ conversationId: req.params.id }).sort({ createdAt: 1 }));
  } catch (e) { next(e); }
});

router.post('/:id/messages', async (req, res, next) => {
  try {
    const conversation = await Conversation.findById(req.params.id).populate('customerId', 'phone');
    if (!conversation) return res.status(404).json({ error: { message: 'Conversation not found.' } });
    const content = String(req.body.content || '').trim();
    if (!content) return res.status(400).json({ error: { message: 'Message content is required.' } });
    const externalId = humanOutboundDedupeKey(conversation.id, content);
    const existing = await Message.findOne({ externalId });
    if (existing) return res.json(existing);
    let message;
    try {
      message = await Message.create({
        conversationId: conversation.id,
        customerId: conversation.customerId,
        content,
        direction: 'OUTBOUND',
        senderType: 'HUMAN',
        externalId,
      });
    } catch (err) {
      if (err?.code === 11000) {
        const existingDup = await Message.findOne({ externalId });
        if (existingDup) return res.json(existingDup);
      }
      throw err;
    }
    try {
      await sendWhatsAppMessage(conversation.customerId?.phone, content);
    } catch (e) {
      await Message.deleteOne({ _id: message._id });
      return res.status(e.status || 502).json({ error: { message: `WhatsApp message not sent: ${e.message}` } });
    }
    conversation.lastMessageAt = new Date();
    conversation.requiresHuman = false;
    conversation.status = 'OPEN';
    conversation.handoffReason = '';
    conversation.handoffAcknowledgedAt = null;
    conversation.handoffResolvedAt = new Date();
    // A human takeover invalidates any order confirmation the AI obtained before
    // the handoff. The draft is kept for context, but payment needs a new confirm.
    conversation.orderConfirmation = undefined;
    await conversation.save();
    await removeHuman(conversation.id);
    res.status(201).json(message);
  } catch (e) { next(e); }
});

export default router;