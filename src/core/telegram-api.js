/**
 * Real Telegram Bot API Client using native Fetch API (Cloudflare Workers compatible).
 *
 * - Explicitly preserves Telegram Bot API `style` ('success' | 'primary' | 'danger')
 *   on InlineKeyboardButton and KeyboardButton inside reply_markup.
 * - Handles Telegram rate limits (HTTP 429 retry_after) gracefully.
 * - Detects 403 Forbidden (bot blocked by user) cleanly for broadcast hygiene.
 * - NEVER logs bot tokens in errors or telemetry.
 */

import { redactString } from '../utils/logger.js';

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const DEFAULT_TELEGRAM_TIMEOUT_MS = 12000;

export class TelegramApiError extends Error {
  constructor(
    message,
    { status = 500, errorCode = null, retryAfter = null, isBlocked = false, isTimeout = false, method = '' } = {}
  ) {
    super(redactString(message));
    this.name = 'TelegramApiError';
    this.status = status;
    this.errorCode = errorCode;
    this.retryAfter = retryAfter;
    this.isBlocked = isBlocked;
    this.isTimeout = isTimeout;
    this.method = method;
  }
}

export function createTelegramClient(fetchImpl = globalThis.fetch, { timeoutMs: defaultTimeoutMs = DEFAULT_TELEGRAM_TIMEOUT_MS } = {}) {
  async function call(token, method, payload = {}, { maxRetries = 1, timeoutMs = defaultTimeoutMs } = {}) {
    if (!token) {
      throw new TelegramApiError('Telegram bot token is required.', { status: 400, method });
    }

    const url = `${TELEGRAM_API_BASE}/bot${token}/${method}`;
    let attempt = 0;

    while (attempt <= maxRetries) {
      attempt += 1;
      let response;
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const effectiveTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TELEGRAM_TIMEOUT_MS;
      const timer = controller ? setTimeout(() => controller.abort(), effectiveTimeout) : null;

      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(cleanUndefined(payload)),
          signal: controller?.signal,
        });
      } catch (networkErr) {
        const isAbort =
          networkErr?.name === 'AbortError' ||
          /aborted|timed?\s*out/i.test(String(networkErr?.message || ''));
        if (isAbort) {
          throw new TelegramApiError(
            `Network timeout calling Telegram ${method} after ${effectiveTimeout}ms. Please retry.`,
            {
              status: 504,
              errorCode: 504,
              isTimeout: true,
              method,
            }
          );
        }
        throw new TelegramApiError(`Network error calling Telegram ${method}: ${networkErr?.message || 'unreachable'}`, {
          status: 502,
          errorCode: 502,
          method,
        });
      } finally {
        if (timer) clearTimeout(timer);
      }

      let data;
      try {
        data = await response.json();
      } catch {
        throw new TelegramApiError(`Invalid JSON response from Telegram ${method} (HTTP ${response.status})`, {
          status: response.status,
          method,
        });
      }

      if (data?.ok) {
        return data;
      }

      const description = String(data?.description || `Telegram API error (${response.status})`);
      const errorCode = data?.error_code || response.status;
      const retryAfter = data?.parameters?.retry_after || null;
      const isBlocked =
        errorCode === 403 &&
        /blocked by the user|user is deactivated|chat not found|bot was kicked/i.test(description);

      // Handle Telegram 429 rate-limit politely when retry_after is small
      if (errorCode === 429 && retryAfter && retryAfter <= 5 && attempt <= maxRetries) {
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        continue;
      }

      throw new TelegramApiError(description, {
        status: response.status,
        errorCode,
        retryAfter,
        isBlocked,
        method,
      });
    }
  }

  return {
    call,

    getMe(token) {
      return call(token, 'getMe', {});
    },

    setWebhook(token, { url, secretToken, allowedUpdates, dropPendingUpdates = false }) {
      return call(token, 'setWebhook', {
        url,
        secret_token: secretToken,
        allowed_updates: allowedUpdates || ['message', 'callback_query', 'chat_member', 'my_chat_member'],
        drop_pending_updates: dropPendingUpdates,
        max_connections: 40,
      });
    },

    deleteWebhook(token, dropPendingUpdates = false) {
      return call(token, 'deleteWebhook', { drop_pending_updates: dropPendingUpdates });
    },

    getWebhookInfo(token) {
      return call(token, 'getWebhookInfo', {});
    },

    sendMessage(token, chatId, text, options = {}) {
      return call(token, 'sendMessage', {
        chat_id: chatId,
        text: String(text).slice(0, 4096),
        parse_mode: options.parse_mode ?? 'HTML',
        reply_markup: options.reply_markup,
        disable_web_page_preview: options.disable_web_page_preview ?? true,
        reply_to_message_id: options.reply_to_message_id,
      });
    },

    sendPhoto(token, chatId, photo, options = {}) {
      return call(token, 'sendPhoto', {
        chat_id: chatId,
        photo,
        caption: options.caption ? String(options.caption).slice(0, 1024) : undefined,
        parse_mode: options.parse_mode ?? 'HTML',
        reply_markup: options.reply_markup,
      });
    },

    sendDocument(token, chatId, document, options = {}) {
      return call(token, 'sendDocument', {
        chat_id: chatId,
        document,
        caption: options.caption ? String(options.caption).slice(0, 1024) : undefined,
        parse_mode: options.parse_mode ?? 'HTML',
        reply_markup: options.reply_markup,
      });
    },

    editMessageText(token, chatId, messageId, text, options = {}) {
      return call(token, 'editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: String(text).slice(0, 4096),
        parse_mode: options.parse_mode ?? 'HTML',
        reply_markup: options.reply_markup,
        disable_web_page_preview: options.disable_web_page_preview ?? true,
      });
    },

    answerCallbackQuery(token, callbackQueryId, { text, showAlert = false } = {}) {
      return call(token, 'answerCallbackQuery', {
        callback_query_id: callbackQueryId,
        text: text ? String(text).slice(0, 200) : undefined,
        show_alert: showAlert,
      });
    },

    sendChatAction(token, chatId, action = 'typing') {
      return call(token, 'sendChatAction', { chat_id: chatId, action });
    },

    getChatMember(token, chatId, userId) {
      return call(token, 'getChatMember', { chat_id: chatId, user_id: userId });
    },

    getFile(token, fileId) {
      return call(token, 'getFile', { file_id: fileId });
    },

    deleteMessage(token, chatId, messageId) {
      return call(token, 'deleteMessage', { chat_id: chatId, message_id: messageId });
    },

    restrictChatMember(token, chatId, userId, permissions, untilDate) {
      return call(token, 'restrictChatMember', {
        chat_id: chatId,
        user_id: userId,
        permissions,
        until_date: untilDate,
      });
    },
  };
}

function cleanUndefined(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(cleanUndefined);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      out[k] = cleanUndefined(v);
    }
  }
  return out;
}
