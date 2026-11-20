/**
 * Input validation & security sanitization helpers.
 * Strictly blocks arbitrary code execution patterns and malformed Telegram inputs.
 */

const BOT_TOKEN_PATTERN = /^\d{6,13}:[A-Za-z0-9_-]{30,64}$/;
const TELEGRAM_USERNAME_PATTERN = /^@?[A-Za-z][A-Za-z0-9_]{3,31}$/;
const SAFE_BOT_ID_PATTERN = /^bot_[a-z0-9]{12,32}$/;
const UNSAFE_CODE_PATTERNS = [
  /<\s*script/i,
  /javascript\s*:/i,
  /data\s*:\s*text\/html/i,
  /\beval\s*\(/i,
  /\bnew\s+Function\s*\(/i,
  /__proto__|constructor\s*\[|prototype\s*\[/i,
];

export function validateBotTokenFormat(token) {
  if (typeof token !== 'string') {
    return { valid: false, error: 'Bot token must be a string.' };
  }
  const trimmed = token.trim();
  if (!BOT_TOKEN_PATTERN.test(trimmed)) {
    return {
      valid: false,
      error: 'Invalid bot token format. Generate a valid token from @BotFather (e.g. 123456789:ABCdef...).',
    };
  }
  return { valid: true, token: trimmed };
}

export function validateBotId(botId) {
  return typeof botId === 'string' && SAFE_BOT_ID_PATTERN.test(botId);
}

export function validateSafeUrl(url) {
  if (!url || typeof url !== 'string') {
    return { valid: false, error: 'URL is required.' };
  }
  const trimmed = url.trim();
  if (UNSAFE_CODE_PATTERNS.some((p) => p.test(trimmed))) {
    return { valid: false, error: 'URL contains forbidden or unsafe patterns.' };
  }
  try {
    const parsed = new URL(trimmed);
    if (!['https:', 'http:'].includes(parsed.protocol)) {
      return { valid: false, error: 'Only http:// and https:// URLs are permitted.' };
    }
    return { valid: true, url: parsed.toString() };
  } catch {
    return { valid: false, error: 'Malformed URL.' };
  }
}

export function validateSupportUsername(input) {
  if (!input) return { valid: true, username: '' };
  const trimmed = String(input).trim();
  if (!TELEGRAM_USERNAME_PATTERN.test(trimmed)) {
    return { valid: false, error: 'Support username must be a valid Telegram handle (e.g. @YourSupport).' };
  }
  return { valid: true, username: trimmed.startsWith('@') ? trimmed : `@${trimmed}` };
}

export function sanitizeText(input, maxLength = 2000) {
  if (input === null || input === undefined) return '';
  let str = String(input).trim();
  if (str.length > maxLength) {
    str = str.slice(0, maxLength);
  }
  return str;
}

export function containsUnsafePayload(value) {
  if (typeof value !== 'string') return false;
  return UNSAFE_CODE_PATTERNS.some((pattern) => pattern.test(value));
}

export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function validateCallbackData(data) {
  if (typeof data !== 'string' || data.length === 0) return false;
  const bytes = new TextEncoder().encode(data).length;
  return bytes <= 64 && !containsUnsafePayload(data);
}

export function isOwnerTelegramId(telegramId, env) {
  if (!telegramId || !env?.ADMIN_TELEGRAM_ID) return false;
  return String(telegramId).trim() === String(env.ADMIN_TELEGRAM_ID).trim();
}
