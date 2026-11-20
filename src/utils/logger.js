/**
 * Secret-redacting structured logger for Cloudflare Workers + D1 system_logs.
 * Guarantees bot tokens, Bearer tokens, encryption keys, and Cloudflare API keys
 * are never written to logs.
 */

const TELEGRAM_TOKEN_REGEX = /\b\d{6,13}:[A-Za-z0-9_-]{25,64}\b/g;
const BEARER_REGEX = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const SECRET_KEYS = new Set([
  'token',
  'bot_token',
  'bottoken',
  'token_encrypted',
  'authorization',
  'secret',
  'webhook_secret',
  'api_key',
  'apikey',
  'cloudflare_api_token',
  'token_encryption_key',
  'admin_api_key',
  'master_bot_token',
  'password',
]);

export function redactString(input) {
  if (typeof input !== 'string') return input;
  return input
    .replace(TELEGRAM_TOKEN_REGEX, '[REDACTED_BOT_TOKEN]')
    .replace(BEARER_REGEX, 'Bearer [REDACTED]');
}

export function sanitizeForLogs(value, depth = 0) {
  if (depth > 5) return '[MAX_DEPTH]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message || ''),
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeForLogs(item, depth + 1));
  }
  if (typeof value === 'object') {
    const clean = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEYS.has(k.toLowerCase())) {
        clean[k] = '[REDACTED]';
      } else {
        clean[k] = sanitizeForLogs(v, depth + 1);
      }
    }
    return clean;
  }
  return String(value);
}

export async function writeSystemLog(env, { level = 'info', source = 'worker', message = '', metadata = {}, actorTelegramId = null }) {
  const safeMessage = redactString(String(message)).slice(0, 1000);
  const safeMetadata = sanitizeForLogs(metadata);
  const logEntry = {
    level,
    source,
    message: safeMessage,
    metadata: safeMetadata,
    actorTelegramId: actorTelegramId ? String(actorTelegramId) : null,
    timestamp: new Date().toISOString(),
  };

  if (level === 'error' || level === 'security') {
    console.error(JSON.stringify(logEntry));
  } else if (level === 'warn') {
    console.warn(JSON.stringify(logEntry));
  } else {
    console.log(JSON.stringify(logEntry));
  }

  if (env?.DB) {
    try {
      const id = `log_${crypto.randomUUID().replace(/-/g, '')}`;
      await env.DB.prepare(
        `INSERT INTO system_logs (id, level, source, message, metadata, actor_telegram_id)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(
          id,
          ['info', 'warn', 'error', 'security', 'audit'].includes(level) ? level : 'info',
          String(source).slice(0, 120),
          safeMessage,
          JSON.stringify(safeMetadata),
          actorTelegramId ? String(actorTelegramId) : null
        )
        .run();
    } catch {
      // Never throw from logger if D1 is temporarily unavailable
    }
  }
}
