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
 * Exact 9 User Panel buttons for the Master Bot native ReplyKeyboard.
 */
export const MASTER_MAIN_BUTTONS = Object.freeze({
  CREATE_BOT: '🤖 Create New Bot',
  MY_BOTS: '📂 My Created Bots',
  TEMPLATE_STUDIO: '🧩 Template Studio',
  CUSTOM_BUILDER: '🛠️ Custom Bot Builder',
  MY_STATS: '📊 My Statistics',
  PLANS_FEATURES: '💎 Plans & Features',
  ACCOUNT_SETTINGS: '⚙️ Account Settings',
  ADD_SUPPORT: '📢 Add Support',
  HELP_SUPPORT: '📣 Help & Support',
  OWNER_CENTER: '👑 Owner Control Center',
});

/**
 * Exact 12 Owner Control Center native ReplyKeyboard sections.
 */
export const OWNER_CONTROL_BUTTONS = Object.freeze({
  OVERVIEW: '📊 Platform Overview',
  MANAGE_USERS: '👥 Manage Users',
  ALL_BOTS: '🤖 All Created Bots',
  TEMPLATE_MGMT: '🧩 Template Management',
  BROADCAST_CENTER: '📢 Broadcast Center',
  FORCE_JOIN: '📣 Force Join Settings',
  SUPPORT_MGMT: '🆘 Support Management',
  PLANS_REFERRALS: '💎 Plans & Referral Control',
  ADMIN_MGMT: '👮 Admin Management',
  CF_MONITOR: '☁️ Cloudflare Monitor',
  ACTIVITY_LOGS: '📋 Activity Logs',
  PLATFORM_SETTINGS: '⚙️ Platform Settings',
  EXIT_OWNER: '⬅️ Exit Owner Center',
});

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
 * Master Bot Main Native ReplyKeyboard — Exact 9 Vibrant User Buttons (+ Owner Control Center for Admins).
 * Zero unstyled/hollow buttons; every button carries an explicit native Telegram colour style.
 */
export function buildMasterMainReplyKeyboard(isOwner = false) {
  const rows = [
    [
      { text: MASTER_MAIN_BUTTONS.CREATE_BOT, style: BUTTON_STYLES.SUCCESS },
      { text: MASTER_MAIN_BUTTONS.MY_BOTS, style: BUTTON_STYLES.PRIMARY },
    ],
    [
      { text: MASTER_MAIN_BUTTONS.TEMPLATE_STUDIO, style: BUTTON_STYLES.PRIMARY },
      { text: MASTER_MAIN_BUTTONS.CUSTOM_BUILDER, style: BUTTON_STYLES.SUCCESS },
    ],
    [
      { text: MASTER_MAIN_BUTTONS.MY_STATS, style: BUTTON_STYLES.PRIMARY },
      { text: MASTER_MAIN_BUTTONS.PLANS_FEATURES, style: BUTTON_STYLES.PRIMARY },
    ],
    [
      { text: MASTER_MAIN_BUTTONS.ACCOUNT_SETTINGS, style: BUTTON_STYLES.PRIMARY },
      { text: MASTER_MAIN_BUTTONS.ADD_SUPPORT, style: BUTTON_STYLES.SUCCESS },
    ],
    [{ text: MASTER_MAIN_BUTTONS.HELP_SUPPORT, style: BUTTON_STYLES.PRIMARY }],
  ];

  if (isOwner) {
    rows.push([{ text: MASTER_MAIN_BUTTONS.OWNER_CENTER, style: BUTTON_STYLES.DANGER }]);
  }

  return buildReplyKeyboard(rows, {
    resize: true,
    persistent: true,
    placeholder: 'BOT FACTORY — Build. Customize. Deploy.',
  });
}

/**
 * Owner Control Center Native ReplyKeyboard — Exact 12 Vibrant Sections + Exit button.
 */
export function buildOwnerControlReplyKeyboard() {
  return buildReplyKeyboard(
    [
      [
        { text: OWNER_CONTROL_BUTTONS.OVERVIEW, style: BUTTON_STYLES.PRIMARY },
        { text: OWNER_CONTROL_BUTTONS.MANAGE_USERS, style: BUTTON_STYLES.PRIMARY },
      ],
      [
        { text: OWNER_CONTROL_BUTTONS.ALL_BOTS, style: BUTTON_STYLES.SUCCESS },
        { text: OWNER_CONTROL_BUTTONS.TEMPLATE_MGMT, style: BUTTON_STYLES.PRIMARY },
      ],
      [
        { text: OWNER_CONTROL_BUTTONS.BROADCAST_CENTER, style: BUTTON_STYLES.SUCCESS },
        { text: OWNER_CONTROL_BUTTONS.FORCE_JOIN, style: BUTTON_STYLES.PRIMARY },
      ],
      [
        { text: OWNER_CONTROL_BUTTONS.SUPPORT_MGMT, style: BUTTON_STYLES.PRIMARY },
        { text: OWNER_CONTROL_BUTTONS.PLANS_REFERRALS, style: BUTTON_STYLES.SUCCESS },
      ],
      [
        { text: OWNER_CONTROL_BUTTONS.ADMIN_MGMT, style: BUTTON_STYLES.DANGER },
        { text: OWNER_CONTROL_BUTTONS.CF_MONITOR, style: BUTTON_STYLES.PRIMARY },
      ],
      [
        { text: OWNER_CONTROL_BUTTONS.ACTIVITY_LOGS, style: BUTTON_STYLES.PRIMARY },
        { text: OWNER_CONTROL_BUTTONS.PLATFORM_SETTINGS, style: BUTTON_STYLES.PRIMARY },
      ],
      [{ text: OWNER_CONTROL_BUTTONS.EXIT_OWNER, style: BUTTON_STYLES.DANGER }],
    ],
    {
      resize: true,
      persistent: true,
      placeholder: 'BOT FACTORY Owner Control Center...',
    }
  );
}

/**
 * Preserved export for backward compatibility (kept colourful, zero unstyled buttons).
 */
export function buildMasterMainInlineKeyboard(isOwner = false) {
  const rows = [
    [
      inlineButton({ text: MASTER_MAIN_BUTTONS.CREATE_BOT, callbackData: 'mb:create', style: BUTTON_STYLES.SUCCESS }),
      inlineButton({ text: MASTER_MAIN_BUTTONS.MY_BOTS, callbackData: 'mb:my_bots', style: BUTTON_STYLES.PRIMARY }),
    ],
    [
      inlineButton({ text: MASTER_MAIN_BUTTONS.TEMPLATE_STUDIO, callbackData: 'mb:template_studio', style: BUTTON_STYLES.PRIMARY }),
      inlineButton({ text: MASTER_MAIN_BUTTONS.CUSTOM_BUILDER, callbackData: 'mb:builder', style: BUTTON_STYLES.SUCCESS }),
    ],
    [
      inlineButton({ text: MASTER_MAIN_BUTTONS.MY_STATS, callbackData: 'mb:stats', style: BUTTON_STYLES.PRIMARY }),
      inlineButton({ text: MASTER_MAIN_BUTTONS.PLANS_FEATURES, callbackData: 'mb:plans', style: BUTTON_STYLES.PRIMARY }),
    ],
    [
      inlineButton({ text: MASTER_MAIN_BUTTONS.ACCOUNT_SETTINGS, callbackData: 'mb:settings', style: BUTTON_STYLES.PRIMARY }),
      inlineButton({ text: MASTER_MAIN_BUTTONS.ADD_SUPPORT, callbackData: 'mb:add_support', style: BUTTON_STYLES.SUCCESS }),
    ],
    [inlineButton({ text: MASTER_MAIN_BUTTONS.HELP_SUPPORT, callbackData: 'mb:help', style: BUTTON_STYLES.PRIMARY })],
  ];

  if (isOwner) {
    rows.push([
      inlineButton({ text: MASTER_MAIN_BUTTONS.OWNER_CENTER, callbackData: 'owner:home', style: BUTTON_STYLES.DANGER }),
    ]);
  }

  return buildInlineKeyboard(rows);
}
