import Groq from 'groq-sdk';
import BusinessSettings from '../models/BusinessSettings.js';

const sensitive = ['REFUND', 'PAYMENT_DISPUTE', 'COMPLAINT', 'DISCOUNT_REQUEST', 'LARGE_ORDER', 'UNKNOWN'];
const FALLBACK_MODELS = ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile'];
const classify = (text) => {
  const v = ` ${text.toLowerCase()} `;
  if (/\brefund\b|money back/.test(v)) return 'REFUND';
  if (/complain|angry|terrible/.test(v)) return 'COMPLAINT';
  if (/\bpaid\b|\bpayment\b|\bcharged\b/.test(v)) return 'PAYMENT_DISPUTE';
  if (/\bdiscount\b/.test(v)) return 'DISCOUNT_REQUEST';
  if (/\bbulk\b|\bwholesale\b|[3-9]\d bags/.test(v)) return 'LARGE_ORDER';
  if (/\bprice\b|\bcost\b|\bhow much\b/.test(v)) return 'PRICE_ENQUIRY';
  if (/\bdeliver(y|ies|ing|ed)?\b/.test(v)) return 'DELIVERY';
  if (/\bhi\b|\bhello\b|\bgood morning\b/.test(v)) return 'GENERAL';
  return 'UNKNOWN';
};

function modelCandidates() {
  const configured = (process.env.AI_MODEL || '').trim();
  return [...new Set([configured, ...FALLBACK_MODELS].filter(Boolean))];
}

export async function generateAiDecision(content, history = []) {
  const intent = classify(content);
  const threshold = Number(process.env.AI_CONFIDENCE_THRESHOLD || 0.75);
  if (!process.env.AI_API_KEY) return { intent, confidence: 0, requiresHuman: true, response: null, reason: 'Groq AI is not configured.' };
  if (sensitive.includes(intent)) return { intent, confidence: 0.96, requiresHuman: true, response: null, reason: 'This type of request requires a human.' };
  try {
    let settings = {};
    try { settings = await BusinessSettings.findOne().lean() || {}; } catch { /* knowledge is best-effort; the AI can still answer with caveats */ }
    const groq = new Groq({ apiKey: process.env.AI_API_KEY });
    const prompt = `You are Customer AI. Respond only with business knowledge below and current conversation. Never invent prices, stock, delivery fees, payment terms, refunds, order status, or policies. If information is missing, say a human representative will assist. Return JSON with confidence (0-1) and response.\nBusiness knowledge: ${JSON.stringify(settings)}\nRecent messages: ${history.slice(-8).map(m => `${m.senderType}: ${m.content}`).join('\n')}\nCustomer: ${content}`;
    let out;
    let lastError = null;
    for (const model of modelCandidates()) {
      try {
        out = await groq.chat.completions.create({
          model,
          messages: [{ role: 'system', content: 'Output valid JSON only.' }, { role: 'user', content: prompt }],
          temperature: 0.2,
          response_format: { type: 'json_object' },
        });
        break;
      } catch (err) {
        lastError = err;
        if (err?.status !== 404 && err?.status !== 401 && err?.status !== 403) throw err;
      }
    }
    if (!out) throw lastError || new Error('All AI models failed.');
    const parsed = JSON.parse(out.choices[0]?.message?.content || '{}');
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
    return {
      intent,
      confidence,
      requiresHuman: confidence < threshold || !parsed.response,
      response: confidence >= threshold ? String(parsed.response) : null,
      reason: confidence < threshold ? 'AI confidence is below the configured threshold.' : null,
    };
  } catch {
    return { intent, confidence: 0, requiresHuman: true, response: null, reason: 'AI processing failed; conversation requires human review.' };
  }
}