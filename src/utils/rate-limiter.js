/**
 * KV-backed rate limiter and duplicate webhook update_id deduplication.
 * Gracefully degrades with warning logs if KV binding is temporarily unavailable.
 */

export async function checkRateLimit(kv, key, maxRequests = 30, windowSeconds = 60) {
  if (!kv) {
    return { allowed: true, remaining: maxRequests, degraded: true };
  }

  const bucket = Math.floor(Date.now() / 1000 / windowSeconds);
  const kvKey = `rl:${key}:${bucket}`;

  try {
    const currentRaw = await kv.get(kvKey);
    const current = currentRaw ? parseInt(currentRaw, 10) : 0;

    if (current >= maxRequests) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: windowSeconds,
      };
    }

    await kv.put(kvKey, String(current + 1), {
      expirationTtl: Math.max(60, windowSeconds * 2),
    });

    return {
      allowed: true,
      remaining: Math.max(0, maxRequests - current - 1),
    };
  } catch {
    return { allowed: true, remaining: maxRequests, degraded: true };
  }
}

/**
 * Prevents duplicate processing of retried Telegram webhook deliveries
 * by tracking (botId, update_id) in KV for 10 minutes.
 */
export async function isDuplicateWebhookUpdate(kv, botId, updateId) {
  if (!kv || updateId === undefined || updateId === null) return false;
  const dedupeKey = `upd:${botId}:${updateId}`;
  try {
    const existing = await kv.get(dedupeKey);
    if (existing) {
      return true;
    }
    await kv.put(dedupeKey, '1', { expirationTtl: 600 });
    return false;
  } catch {
    return false;
  }
}
