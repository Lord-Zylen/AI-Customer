import { Router } from 'express';
import { databaseStatus } from '../services/database.service.js';
import { getWhatsAppStatus } from '../services/whatsapp.service.js';

const router = Router();
router.get('/status', async (req, res) => {
  const whatsapp = await getWhatsAppStatus();
  const hermes = whatsapp.managedBy === 'hermes'
    ? (whatsapp.gatewayState === 'running' ? 'CONNECTED' : 'NOT CONNECTED')
    : (process.env.HERMES_ENABLED === 'true' ? 'CONFIGURED' : 'NOT CONFIGURED');
  res.json({
    backend: 'CONNECTED',
    mongodb: databaseStatus(),
    groq: process.env.AI_API_KEY ? 'CONFIGURED' : 'NOT CONFIGURED',
    hermes,
    whatsapp: whatsapp.status === 'CONNECTED' ? 'CONNECTED' : 'NOT CONNECTED',
    managedBy: whatsapp.managedBy,
  });
});
export default router;