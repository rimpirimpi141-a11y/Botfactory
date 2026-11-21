/**
 * Custom No-Code Button Builder & Validator.
 * Supports safe declarative actions only — strictly prevents arbitrary code execution.
 *
 * Extended builder actions (`info`, `collect_input`, `catalogue`, `create_order`, `submit_request`)
 * are validated and normalized cleanly into `actionType: 'feature'` with structured payloads
 * so existing Cloudflare D1 schema constraints remain 100% backward compatible.
 */

import { BUTTON_STYLES, inlineButton, replyButton } from '../utils/keyboards.js';
import { containsUnsafePayload, sanitizeText, validateSafeUrl } from '../utils/validation.js';

export const ALLOWED_ACTION_TYPES = Object.freeze([
  'submenu',
  'message',
  'url',
  'feature',
  'back',
  'support',
  'info',
  'collect_input',
  'catalogue',
  'create_order',
  'submit_request',
]);

export const ALLOWED_SAFE_FEATURES = Object.freeze([
  'user_profile',
  'bot_stats',
  'referral_link',
  'support_contact',
  'help_overview',
]);

const EXTENDED_FEATURE_PREFIXES = ['info:', 'form:', 'catalogue:', 'create_order:', 'submit_request:'];

export const ALLOWED_STYLES = Object.freeze([
  BUTTON_STYLES.PRIMARY,
  BUTTON_STYLES.SUCCESS,
  BUTTON_STYLES.DANGER,
  BUTTON_STYLES.DEFAULT,
]);

export const ALLOWED_VISIBILITY = Object.freeze(['all', 'users', 'admins', 'hidden']);

function isValidFeaturePayload(payload) {
  if (ALLOWED_SAFE_FEATURES.includes(payload)) return true;
  if (payload === 'catalogue' || payload === 'create_order') return true;
  return EXTENDED_FEATURE_PREFIXES.some((prefix) => payload.startsWith(prefix));
}

export function validateButtonDefinition(rawButton, index = 0) {
  const label = sanitizeText(rawButton?.label, 48);
  if (!label) {
    throw new Error(`Button #${index + 1} requires a non-empty label.`);
  }

  const emoji = sanitizeText(rawButton?.emoji || '', 8);
  const rawAction = String(rawButton?.actionType || 'message').trim();
  if (!ALLOWED_ACTION_TYPES.includes(rawAction)) {
    throw new Error(`Unsupported button action type "${rawAction}".`);
  }

  let actionType = rawAction;
  let actionPayload = sanitizeText(rawButton?.actionPayload || '', 1200);
  if (containsUnsafePayload(actionPayload) || containsUnsafePayload(label)) {
    throw new Error(`Button "${label}" contains forbidden script or unsafe payload.`);
  }

  // Normalize extended interactive actions safely into D1-compatible `feature` payloads
  if (rawAction === 'info') {
    actionType = 'feature';
    actionPayload = `info:${actionPayload || label}`;
  } else if (rawAction === 'collect_input') {
    actionType = 'feature';
    const key = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 24) || 'input';
    actionPayload = actionPayload.startsWith('form:')
      ? actionPayload
      : `form:${key}:${actionPayload || `Please send your response for ${label}:`}`;
  } else if (rawAction === 'submit_request') {
    actionType = 'feature';
    const key = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 24) || 'request';
    actionPayload = actionPayload.startsWith('submit_request:')
      ? actionPayload
      : `submit_request:${key}:${actionPayload || `Describe your ${label} request below:`}`;
  } else if (rawAction === 'catalogue') {
    actionType = 'feature';
    actionPayload = actionPayload.startsWith('catalogue:')
      ? actionPayload
      : `catalogue:${actionPayload || 'all'}`;
  } else if (rawAction === 'create_order') {
    actionType = 'feature';
    actionPayload = actionPayload.startsWith('create_order:')
      ? actionPayload
      : `create_order:${actionPayload || 'all'}`;
  }

  if (actionType === 'url') {
    const urlCheck = validateSafeUrl(actionPayload);
    if (!urlCheck.valid) {
      throw new Error(`Button "${label}" URL error: ${urlCheck.error}`);
    }
  }

  if (actionType === 'feature' && !isValidFeaturePayload(actionPayload)) {
    throw new Error(`Button "${label}" references unknown safe feature "${actionPayload}".`);
  }

  const style =
    rawButton?.style && rawButton.style !== BUTTON_STYLES.DEFAULT && ALLOWED_STYLES.includes(rawButton.style)
      ? rawButton.style
      : BUTTON_STYLES.PRIMARY;
  const visibility = ALLOWED_VISIBILITY.includes(rawButton?.visibility) ? rawButton.visibility : 'all';
  const buttonType = actionType === 'url' ? 'url' : rawButton?.buttonType === 'reply' ? 'reply' : 'callback';

  return {
    id: rawButton?.id || `btn_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
    label,
    emoji,
    buttonType,
    actionType,
    actionPayload,
    row: Number.isInteger(rawButton?.row) ? Math.max(0, rawButton.row) : Math.floor(index / 2),
    col: Number.isInteger(rawButton?.col) ? Math.max(0, rawButton.col) : index % 2,
    position: Number.isInteger(rawButton?.position) ? rawButton.position : index,
    visibility,
    style,
  };
}

/**
 * Converts a validated builder button into a Telegram InlineKeyboardButton or KeyboardButton
 * preserving native Telegram `style`.
 */
export function compileBuilderButton(btn, keyboardType = 'inline') {
  const text = btn.emoji ? `${btn.emoji} ${btn.label}` : btn.label;

  if (keyboardType === 'reply' && btn.actionType !== 'url') {
    return replyButton({ text, style: btn.style });
  }

  if (btn.actionType === 'url') {
    return inlineButton({ text, url: btn.actionPayload, style: btn.style });
  }

  const callbackData = `cb:btn:${btn.id}`;
  return inlineButton({ text, callbackData, style: btn.style });
}
