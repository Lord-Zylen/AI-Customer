import { Router } from 'express';
import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';
import { requireAuth } from '../middleware/auth.js';
import { sendWhatsAppMessage } from '../services/whatsapp.service.js';

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const filter =
      req.query.filter === 'human' ? { requiresHuman: true }
      : req.query.filter === 'active' ? { aiEnabled: true, status: { $ne: 'RESOLVED' } }
      : req.query.filter === 'resolved' ? { status: 'RESOLVED' } : {};
    const conversations = await Conversation.find(filter)
      .populate('customerId', 'name phone')
      .sort({ lastMessageAt: -1 })
      .limit(100);
    const lastMessages = await Message.find({ conversationId: { $in: conversations.map(c => c._id) } }).sort({ createdAt: -1 });
    const latest = Object.fromEntries(lastMessages.map(m => [String(m.conversationId), m]));
    res.json(conversations.map(c => ({ ...c.toObject(), lastMessage: latest[String(c._id)] || null })));
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const item = await Conversation.findById(req.params.id).populate('customerId', 'name phone email notes');
    if (!item) return res.status(404).json({ error: { message: 'Conversation not found.' } });
    res.json(item);
  } catch (e) { next(e); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const allowed = ['aiEnabled', 'status', 'requiresHuman', 'assignedTo'];
    const patch = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
    if (patch.aiEnabled === true) { patch.requiresHuman = false; if (!patch.status) patch.status = 'OPEN'; }
    if (patch.aiEnabled === false) { patch.requiresHuman = true; patch.status = 'HUMAN_REQUIRED'; }
    const item = await Conversation.findByIdAndUpdate(req.params.id, patch, { new: true, runValidators: true }).populate('customerId', 'name phone');
    if (!item) return res.status(404).json({ error: { message: 'Conversation not found.' } });
    res.json(item);
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
    try {
      await sendWhatsAppMessage(conversation.customerId?.phone, content);
    } catch (e) {
      return res.status(e.status || 502).json({ error: { message: `WhatsApp message not sent: ${e.message}` } });
    }
    const message = await Message.create({
      conversationId: conversation.id,
      customerId: conversation.customerId,
      content,
      direction: 'OUTBOUND',
      senderType: 'HUMAN',
    });
    conversation.lastMessageAt = new Date();
    conversation.requiresHuman = false;
    conversation.status = 'OPEN';
    await conversation.save();
    res.status(201).json(message);
  } catch (e) { next(e); }
});

export default router;