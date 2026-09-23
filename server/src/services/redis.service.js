import { createClient } from 'redis';

const NAMESPACE = 'customer-ai';

const positiveInt = (value, fallback) => {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const cfg = {
  get url() {
    return (process.env.REDIS_URL || '').trim();
  },
  get enabled() {
    return this.url.length > 0;
  },
  get queueTtlSec() {
    return positiveInt(process.env.REDIS_QUEUE_TTL, 3600);
  },
  get processingTtlSec() {
    return positiveInt(process.env.REDIS_PROCESSING_TTL, 120);
  },
  get humanTtlSec() {
    return positiveInt(process.env.REDIS_HUMAN_TTL, 7 * 24 * 60 * 60);
  },
  get rateLimit() {
    return positiveInt(process.env.REDIS_RATE_LIMIT, 60);
  },
  get rateWindowSec() {
    return positiveInt(process.env.REDIS_RATE_WINDOW_SEC, 60);
  },
};

let client = null;
let lastErrorAt = 0;
let nextAttemptAt = 0;
const CONNECT_TIMEOUT_MS = 3000;
const RETRY_BACKOFF_MS = 10000;

function safeError(error) {
  const raw = String(error?.message || error || '').trim();
  if (!raw) return 'unknown redis error';
  if (raw.includes(cfg.url) && cfg.url) return raw.replace(cfg.url, 'redis://<redacted>');
  return raw.replace(/redis:\/\/[^\s]+/g, 'redis://<redacted>');
}

function logErrorOnce(error) {
  const now = Date.now();
  if (now - lastErrorAt < 60000) return;
  lastErrorAt = now;
  console.error(`[redis] ${safeError(error)}`);
}

async function ensure() {
  if (!cfg.enabled) return null;
  if (client && client.isReady && client.isOpen) return client;
  if (!client) {
    try {
      client = createClient({ url: cfg.url, disableOfflineQueue: true });
      client.on('error', logErrorOnce);
    } catch (error) {
      logErrorOnce(error);
      client = null;
      return null;
    }
  }
  if (Date.now() < nextAttemptAt) return client.isReady && client.isOpen ? client : null;
  const timeout = new Promise((resolve) => {
    setTimeout(resolve, CONNECT_TIMEOUT_MS);
  });
  try {
    await Promise.race([client.connect(), timeout]);
  } catch (error) {
    logErrorOnce(error);
  }
  if (!(client.isReady && client.isOpen)) nextAttemptAt = Date.now() + RETRY_BACKOFF_MS;
  return client.isReady && client.isOpen ? client : null;
}

const keys = {
  inboundQueue: () => `${NAMESPACE}:queue:inbound`,
  processing: (token) => `${NAMESPACE}:processing:${token}`,
  rateLimit: (chatId) => `${NAMESPACE}:ratelimit:${chatId}`,
  humanQueue: () => `${NAMESPACE}:queue:human`,
  humanMeta: (conversationId) => `${NAMESPACE}:human:${conversationId}`,
};

export function redisStatus() {
  if (!cfg.enabled) return 'NOT CONFIGURED';
  if (client && client.isReady) return 'CONNECTED';
  return client ? 'RECONNECTING' : 'ERROR';
}

export async function redisPing() {
  const c = await ensure();
  if (!c) return null;
  try {
    return await c.ping();
  } catch (error) {
    logErrorOnce(error);
    return null;
  }
}

export async function redisHealthStatus() {
  if (!cfg.enabled) return 'NOT CONFIGURED';
  const pong = await redisPing();
  if (pong === 'PONG') return 'CONNECTED';
  return redisStatus();
}

export async function pushInbound(envelope) {
  const c = await ensure();
  if (!c) return false;
  try {
    const serialized = JSON.stringify(envelope);
    if (serialized.length > 1024) return false;
    await c.multi().lPush(keys.inboundQueue(), serialized).expire(keys.inboundQueue(), cfg.queueTtlSec).exec();
    return true;
  } catch (error) {
    logErrorOnce(error);
    return false;
  }
}

export async function inboundQueueLength() {
  const c = await ensure();
  if (!c) return null;
  try {
    return await c.lLen(keys.inboundQueue());
  } catch (error) {
    logErrorOnce(error);
    return null;
  }
}

export async function markProcessing(token, meta) {
  const c = await ensure();
  if (!c) return false;
  try {
    await c.setEx(keys.processing(token), cfg.processingTtlSec, JSON.stringify(meta));
    return true;
  } catch (error) {
    logErrorOnce(error);
    return false;
  }
}

export async function clearProcessing(token) {
  const c = await ensure();
  if (!c) return false;
  try {
    await c.del(keys.processing(token));
    return true;
  } catch (error) {
    logErrorOnce(error);
    return false;
  }
}

export async function currentRateFor(chatId) {
  const c = await ensure();
  if (!c) return { count: 0, limited: false };
  const k = keys.rateLimit(chatId);
  try {
    const count = await c.incr(k);
    if (count === 1) await c.expire(k, cfg.rateWindowSec);
    return { count, limited: count > cfg.rateLimit };
  } catch (error) {
    logErrorOnce(error);
    return { count: 0, limited: false };
  }
}

export async function addHuman(conversationId, meta) {
  const c = await ensure();
  if (!c) return false;
  try {
    await c
      .multi()
      .sAdd(keys.humanQueue(), String(conversationId))
      .hSet(keys.humanMeta(conversationId), meta)
      .expire(keys.humanMeta(conversationId), cfg.humanTtlSec)
      .exec();
    return true;
  } catch (error) {
    logErrorOnce(error);
    return false;
  }
}

export async function removeHuman(conversationId) {
  const c = await ensure();
  if (!c) return false;
  try {
    await c.multi().sRem(keys.humanQueue(), String(conversationId)).del(keys.humanMeta(conversationId)).exec();
    return true;
  } catch (error) {
    logErrorOnce(error);
    return false;
  }
}

export async function humanQueueSize() {
  const c = await ensure();
  if (!c) return null;
  try {
    return await c.sCard(keys.humanQueue());
  } catch (error) {
    logErrorOnce(error);
    return null;
  }
}

export async function closeRedis() {
  if (client && client.isOpen) {
    try {
      await client.quit();
    } catch {
      /* already closed */
    }
  }
  client = null;
}