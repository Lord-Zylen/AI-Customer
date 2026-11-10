import { Router } from 'express';
import { databaseStatus } from '../services/database.service.js';
import { getWhatsAppStatus } from '../services/whatsapp.service.js';
import { redisHealthStatus } from '../services/redis.service.js';
import { validatePaystackConfig } from '../services/paystack.service.js';

const router = Router();
router.get('/status', async (req, res) => {
  try {
    const whatsapp = await getWhatsAppStatus();
    const paystack = validatePaystackConfig();
    const hermes = whatsapp.managedBy === 'hermes'
      ? (whatsapp.gatewayState === 'running' ? 'CONNECTED' : 'NOT CONNECTED')
      : (process.env.HERMES_ENABLED === 'true' ? 'CONFIGURED' : 'NOT CONFIGURED');
    res.json({
      backend: 'CONNECTED',
      mongodb: databaseStatus(),
      redis: await redisHealthStatus(),
      groq: (process.env.GROQ_API_KEY || process.env.AI_API_KEY) ? 'CONFIGURED' : 'NOT CONFIGURED',
      aiDecision: 'DETERMINISTIC',
      paystack: paystack.status,
      hermes,
      whatsapp: whatsapp.status === 'CONNECTED' ? 'CONNECTED' : 'NOT CONNECTED',
      managedBy: whatsapp.managedBy,
    });
  } catch {
    res.status(502).json({ error: { message: 'Status is unavailable right now.' } });
  }
});
export default router;