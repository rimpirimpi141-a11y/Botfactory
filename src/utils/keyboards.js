/**
 * Centralized Colourful Telegram Keyboard Factory.
 *
 * Uses official Telegram Bot API native button styling (`style` field):
 * - 'success' -> GREEN button
 * - 'primary' -> BLUE button
 * - 'danger'  -> RED button
 * - undefined -> Default Telegram client button styling
 *
 * Supported on both InlineKeyboardButton and KeyboardButton.
 * Older Telegram clients that do not recognize `style` automatically fall back
 * to standard buttons without breaking functionality.
 */

export const BUTTON_STYLES = Object.freeze({
  SUCCESS: 'success', // Green
  PRIMARY: 'primary', // Blue
  DANGER: 'danger',   // Red
  DEFAULT: 'default',
});

const VALID_TELEGRAM_STYLES = new Set(['success', 'primary', 'danger']);

/**
 * Normalizes a requested style into a valid Telegram Bot API `style` value
 * or returns undefined for standard buttons. Never outputs arbitrary HEX strings.
 */
export function resolveTelegramStyle(style) {
  if (!style || typeof style !== 'string') return undefined;
  const normalized = style.toLowerCase().trim();
  return VALID_TELEGRAM_STYLES.has(normalized) ? normalized : undefined;
}

/**
 * Creates a single InlineKeyboardButton preserving the Telegram `style` field.
 */
export function inlineButton({ text, callbackData, url, style, webApp }) {
  const btn = {
    text: String(text).slice(0, 64),
  };

  if (url) {
    btn.url = url;
  } else if (webApp) {
    btn.web_app = { url: webApp };
  } else if (callbackData) {
    btn.callback_data = String(callbackData).slice(0, 64);
  }

  const tgStyle = resolveTelegramStyle(style);
  if (tgStyle) {
    btn.style = tgStyle;
  }

  return btn;
}

/**
 * Creates a single Reply KeyboardButton preserving the Telegram `style` field.
 */
export function replyButton({ text, style, requestContact, requestLocation }) {
  const btn = {
    text: String(text).slice(0, 64),
  };

  if (requestContact) btn.request_contact = true;
  if (requestLocation) btn.request_location = true;

  const tgStyle = resolveTelegramStyle(style);
  if (tgStyle) {
    btn.style = tgStyle;
  }

  return btn;
}

/**
 * Builds an InlineKeyboardMarkup from rows of button specs.
 */
export function buildInlineKeyboard(rows = []) {
  const inline_keyboard = rows
    .filter((row) => Array.isArray(row) && row.length > 0)
    .map((row) => row.map((spec) => (spec.callback_data || spec.url ? spec : inlineButton(spec))));

  return { inline_keyboard };
}

/**
 * Builds a ReplyKeyboardMarkup from rows of button specs.
 */
export function buildReplyKeyboard(rows = [], options = {}) {
  const keyboard = rows
    .filter((row) => Array.isArray(row) && row.length > 0)
    .map((row) => row.map((spec) => (typeof spec === 'string' ? replyButton({ text: spec }) : replyButton(spec))));

  return {
    keyboard,
    resize_keyboard: options.resize !== false,
    is_persistent: options.persistent !== false,
    one_time_keyboard: Boolean(options.oneTime),
    input_field_placeholder: options.placeholder ? String(options.placeholder).slice(0, 64) : undefined,
  };
}

/**
 * Arranges a flat list of buttons into a multi-column grid.
 */
export function chunkButtonsToRows(buttons, columns = 2) {
  const cols = Math.max(1, Math.min(4, Number(columns) || 2));
  const rows = [];
  for (let i = 0; i < buttons.length; i += cols) {
    rows.push(buttons.slice(i, i + cols));
  }
  return rows;
}

/**
 * Standardized colourful inline Approval / Rejection button row.
 */
export function buildApprovalButtons(approveCallback, rejectCallback, approveLabel = '✅ Approve', rejectLabel = '❌ Reject') {
  return buildInlineKeyboard([
    [
      inlineButton({ text: approveLabel, callbackData: approveCallback, style: BUTTON_STYLES.SUCCESS }),
      inlineButton({ text: rejectLabel, callbackData: rejectCallback, style: BUTTON_STYLES.DANGER }),
    ],
  ]);
}

/**
 * Standardized colourful confirmation keyboard (Confirm = green, Cancel = red).
 */
export function buildConfirmCancelKeyboard(confirmCallback, cancelCallback, confirmText = '✅ Confirm', cancelText = '✖️ Cancel') {
  return buildInlineKeyboard([
    [
      inlineButton({ text: confirmText, callbackData: confirmCallback, style: BUTTON_STYLES.SUCCESS }),
      inlineButton({ text: cancelText, callbackData: cancelCallback, style: BUTTON_STYLES.DANGER }),
    ],
  ]);
}

/**
 * Master Bot Main Reply Keyboard (Colourful native Telegram buttons).
 */
export function buildMasterMainReplyKeyboard(isOwner = false) {
  const rows = [
    [
      { text: '🤖 Create New Bot', style: BUTTON_STYLES.SUCCESS },
      { text: '📂 My Created Bots', style: BUTTON_STYLES.PRIMARY },
    ],
    [
      { text: '🎨 Theme Studio', style: BUTTON_STYLES.PRIMARY },
      { text: '🧩 Custom Bot Builder', style: BUTTON_STYLES.SUCCESS },
    ],
    [
      { text: '📊 My Statistics', style: BUTTON_STYLES.PRIMARY },
      { text: '💎 Plans & Features', style: BUTTON_STYLES.PRIMARY },
    ],
    [{ text: '📢 Help & Support', style: BUTTON_STYLES.DEFAULT }],
  ];

  if (isOwner) {
    rows.push([{ text: '👑 Owner Control Center', style: BUTTON_STYLES.DANGER }]);
  }

  return buildReplyKeyboard(rows, {
    resize: true,
    persistent: true,
    placeholder: 'Select a BOT FACTORY action...',
  });
}

/**
 * Master Bot Inline Main Dashboard Keyboard.
 */
export function buildMasterMainInlineKeyboard(isOwner = false) {
  const rows = [
    [
      inlineButton({ text: '🤖 Create New Bot', callbackData: 'mb:create', style: BUTTON_STYLES.SUCCESS }),
      inlineButton({ text: '📂 My Created Bots', callbackData: 'mb:my_bots', style: BUTTON_STYLES.PRIMARY }),
    ],
    [
      inlineButton({ text: '🎨 Theme Studio', callbackData: 'mb:theme_studio', style: BUTTON_STYLES.PRIMARY }),
      inlineButton({ text: '🧩 Custom Bot Builder', callbackData: 'mb:builder', style: BUTTON_STYLES.SUCCESS }),
    ],
    [
      inlineButton({ text: '📊 My Statistics', callbackData: 'mb:stats', style: BUTTON_STYLES.PRIMARY }),
      inlineButton({ text: '💎 Plans & Features', callbackData: 'mb:plans', style: BUTTON_STYLES.PRIMARY }),
    ],
    [inlineButton({ text: '📢 Help & Support', callbackData: 'mb:help', style: BUTTON_STYLES.DEFAULT })],
  ];

  if (isOwner) {
    rows.push([
      inlineButton({ text: '👑 Owner Control Center', callbackData: 'owner:home', style: BUTTON_STYLES.DANGER }),
    ]);
  }

  return buildInlineKeyboard(rows);
}
