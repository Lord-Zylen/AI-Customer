import { Router } from 'express';
import Order from '../models/Order.js';
import { requireAuth } from '../middleware/auth.js';
import { retryPaidNotification, retryPaymentLinkDelivery } from '../services/paystack.service.js';

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const filter = req.query.status ? { status: String(req.query.status).toUpperCase() } : {};
    const orders = await Order.find(filter)
      .populate('customerId', 'name phone')
      .sort({ createdAt: -1 })
      .limit(100);
    res.json(orders);
  } catch (e) { next(e); }
});

router.get('/:reference', async (req, res, next) => {
  try {
    const order = await Order.findOne({ reference: req.params.reference })
      .populate('customerId', 'name phone')
      .populate('conversationId', 'status');
    if (!order) return res.status(404).json({ error: { message: 'Order not found.' } });
    res.json(order);
  } catch (e) { next(e); }
});

// Controlled retry of payment-link delivery. It reuses the existing Paystack URL
// and never initializes another transaction. `force` is required when the prior
// outcome is UNKNOWN (the earlier message may already have been delivered).
router.post('/:reference/payment-link/retry', async (req, res, next) => {
  try {
    const delivery = await retryPaymentLinkDelivery(req.params.reference, {
      force: req.body?.force === true,
    });
    res.json({ ok: true, ...delivery });
  } catch (e) {
    if (e?.status) return res.status(e.status).json({ error: { message: e.message } });
    next(e);
  }
});

// Controlled retry for a PAID order whose WhatsApp confirmation failed. `force`
// is required to retry an UNKNOWN outcome (the previous send may have succeeded).
router.post('/:reference/notification/retry', async (req, res, next) => {
  try {
    const notification = await retryPaidNotification(req.params.reference, {
      force: req.body?.force === true,
    });
    res.json({ ok: true, notification });
  } catch (e) {
    if (e?.status) return res.status(e.status).json({ error: { message: e.message } });
    next(e);
  }
});

export default router;
