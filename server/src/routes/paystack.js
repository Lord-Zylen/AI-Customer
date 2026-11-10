import { Router, raw } from 'express';
import { applyPaystackEvent, verifyPaystackSignature } from '../services/paystack.service.js';

const router = Router();

router.post('/webhook', raw({ type: 'application/json' }), async (req, res, next) => {
  try {
    const signature = req.get('x-paystack-signature') || '';
    if (!Buffer.isBuffer(req.body) || !verifyPaystackSignature(req.body, signature)) {
      return res.status(401).json({ error: { message: 'Invalid Paystack signature.' } });
    }
    let event = {};
    try { event = JSON.parse(req.body.toString('utf8') || '{}'); } catch { return res.sendStatus(200); }
    const result = await applyPaystackEvent(event);
    if (result?.alreadyPaid) {
      console.log(`[paystack] duplicate webhook ignored for ${event?.data?.reference}`);
    }
    res.sendStatus(200);
  } catch (e) {
    // Non-2xx makes Paystack retry transient failures (for example a verification
    // request that could not reach Paystack). The event is safe to replay: order
    // transitions are idempotent and amount/currency are re-checked.
    console.error(`[paystack] webhook processing failed: ${e.message}`);
    next(e);
  }
});

export default router;
