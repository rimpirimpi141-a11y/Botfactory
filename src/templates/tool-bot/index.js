/**
 * TEMPLATE: TOOL BOT (Upgraded)
 *
 * 100% real utilities inside Cloudflare Workers:
 * - Image-to-Link / File Info (calls Telegram `getFile` to inspect file path & metadata safely without exposing bot token)
 * - QR Code Generator (scannable QR PNG via sendPhoto)
 * - UPI QR Generator (generates `upi://pay?...` QR code ONLY — explicitly states it never confirms payment)
 * - URL Inspector, Text Tools, Base64 / SHA-256, JSON Formatter
 * - Enable / Disable Tool Toggles via Native ReplyKeyboard Tenant Admin Panel
 */

import { formatBrandedMessage } from '../../builder/theme-engine.js';
import { buildReplyKeyboard, BUTTON_STYLES } from '../../utils/keyboards.js';
import { escapeHtml, validateSafeUrl } from '../../utils/validation.js';
import { invalidateTenantCache } from '../../core/tenant-manager.js';
import {
  ADMIN_COMMON_LABELS,
  buildCancelReplyKeyboard,
  buildTenantAdminReplyKeyboard,
  buildUpiPaymentQr,
  handleCommonTenantAdmin,
} from '../shared/tenant-admin.js';

export const TOOL_BOT_META = {
  id: 'tpl_tool_bot',
  slug: 'tool-bot',
  name: 'Tool Bot',
  category: 'Utilities & Productivity',
};

const ALL_TOOL_KEYS = ['image_link', 'qr_generator', 'upi_qr', 'url_tools', 'text_tools', 'encoding_tools', 'file_info'];

const ADMIN_EXTRA_BUTTONS = [{ text: '🧩 Toggle Tool Modules', style: BUTTON_STYLES.SUCCESS }];

function getEnabledTools(config) {
  const configured = config?.templateSettings?.enabledModules;
  if (Array.isArray(configured) && configured.length > 0) return new Set(configured);
  return new Set(ALL_TOOL_KEYS);
}

function buildToolKeyboard(enabledSet, isAdmin = false) {
  const buttons = [];
  if (enabledSet.has('qr_generator')) buttons.push({ text: '📱 QR Generator', style: BUTTON_STYLES.SUCCESS });
  if (enabledSet.has('upi_qr')) buttons.push({ text: '💳 UPI QR Generator', style: BUTTON_STYLES.SUCCESS });
  if (enabledSet.has('image_link')) buttons.push({ text: '🖼 Image / File Info', style: BUTTON_STYLES.PRIMARY });
  if (enabledSet.has('url_tools')) buttons.push({ text: '🔗 URL Inspector', style: BUTTON_STYLES.PRIMARY });
  if (enabledSet.has('text_tools')) buttons.push({ text: '📝 Text Tools', style: BUTTON_STYLES.PRIMARY });
  if (enabledSet.has('encoding_tools')) buttons.push({ text: '🔐 Base64 / SHA-256', style: BUTTON_STYLES.PRIMARY });
  buttons.push({ text: '📄 JSON Formatter', style: BUTTON_STYLES.PRIMARY });

  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }
  if (isAdmin) {
    rows.push([{ text: ADMIN_COMMON_LABELS.OPEN_ADMIN, style: BUTTON_STYLES.DANGER }]);
  }
  return buildReplyKeyboard(rows, { resize: true, persistent: true });
}

export async function handleToolBotUpdate(ctx) {
  const { env, bot, config, token, telegram, repos, update, endUser, isAdmin } = ctx;
  const msg = update.message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const state = safeParse(endUser.state_json);
  const enabledSet = getEnabledTools(config);
  const userKb = buildToolKeyboard(enabledSet, isAdmin);
  const adminKb = buildTenantAdminReplyKeyboard(ADMIN_EXTRA_BUTTONS);

  const handledAdmin = await handleCommonTenantAdmin(ctx, {
    panelTitle: 'Tool Bot Admin Panel',
    extraButtons: ADMIN_EXTRA_BUTTONS,
    userKeyboard: userKb,
    extraStatsSummary: async () => `• Active Utility Modules: <b>${enabledSet.size}/${ALL_TOOL_KEYS.length}</b>`,
  });
  if (handledAdmin) return;

  // Admin: toggle tool module
  if (isAdmin && state?.step === 'tool_adm_toggle' && !text.startsWith('/')) {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
    const key = text.toLowerCase().trim();
    if (!ALL_TOOL_KEYS.includes(key)) {
      await telegram.sendMessage(
        token,
        chatId,
        `❌ Unknown module. Valid keys: <code>${ALL_TOOL_KEYS.join(', ')}</code>`,
        { reply_markup: adminKb }
      );
      return;
    }
    const next = new Set(enabledSet);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    await repos.botConfigs.upsert(bot.id, {
      ...config,
      templateSettings: { ...(config.templateSettings || {}), enabledModules: Array.from(next) },
    });
    await invalidateTenantCache(env, bot.id);
    await telegram.sendMessage(
      token,
      chatId,
      `✅ Module <code>${key}</code> is now <b>${next.has(key) ? 'ENABLED' : 'DISABLED'}</b>.`,
      { reply_markup: adminKb }
    );
    return;
  }

  if (isAdmin && text === '🧩 Toggle Tool Modules') {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, { scope: 'tenant_admin', step: 'tool_adm_toggle' });
    const list = ALL_TOOL_KEYS.map((k) => `• <code>${k}</code>: ${enabledSet.has(k) ? '✅ ON' : '⛔ OFF'}`).join('\n');
    await telegram.sendMessage(
      token,
      chatId,
      `<b>🧩 Tool Modules</b>\n${list}\n\nSend a module key to toggle it ON/OFF:`,
      { reply_markup: buildCancelReplyKeyboard() }
    );
    return;
  }

  // Automatic Image/File Inspector & Telegram File Path Info (never exposes bot token!)
  if (msg.document || msg.photo || msg.video || msg.audio) {
    const infoLines = [];
    let fileId = null;
    if (msg.document) {
      fileId = msg.document.file_id;
      infoLines.push(
        `• <b>Type:</b> Document`,
        `• <b>Filename:</b> ${escapeHtml(msg.document.file_name || 'unnamed')}`,
        `• <b>MIME:</b> <code>${escapeHtml(msg.document.mime_type || 'unknown')}</code>`,
        `• <b>Size:</b> ${formatBytes(msg.document.file_size)}`,
        `• <b>Telegram File ID:</b> <code>${escapeHtml(fileId)}</code>`
      );
    } else if (msg.photo) {
      const largest = msg.photo[msg.photo.length - 1];
      fileId = largest.file_id;
      infoLines.push(
        `• <b>Type:</b> Image / Photo`,
        `• <b>Resolution:</b> ${largest.width} × ${largest.height}px`,
        `• <b>Size:</b> ${formatBytes(largest.file_size)}`,
        `• <b>Telegram File ID:</b> <code>${escapeHtml(fileId)}</code>`
      );
    } else if (msg.video) {
      fileId = msg.video.file_id;
      infoLines.push(
        `• <b>Type:</b> Video (${msg.video.width}×${msg.video.height}, ${msg.video.duration}s)`,
        `• <b>Size:</b> ${formatBytes(msg.video.file_size)}`,
        `• <b>Telegram File ID:</b> <code>${escapeHtml(fileId)}</code>`
      );
    } else if (msg.audio) {
      fileId = msg.audio.file_id;
      infoLines.push(
        `• <b>Type:</b> Audio (${msg.audio.duration}s)`,
        `• <b>Size:</b> ${formatBytes(msg.audio.file_size)}`,
        `• <b>Telegram File ID:</b> <code>${escapeHtml(fileId)}</code>`
      );
    }

    if (fileId && typeof telegram.getFile === 'function') {
      try {
        const gf = await telegram.getFile(token, fileId);
        if (gf?.result?.file_path) {
          infoLines.push(
            `• <b>Telegram File Path:</b> <code>${escapeHtml(gf.result.file_path)}</code>`,
            `<i>Security note: Direct Telegram CDN URLs contain bot tokens and are intentionally never exposed in chat. Configure an external image host (R2/CDN) to publish public direct URLs.</i>`
          );
        }
      } catch {
        // Non-fatal
      }
    }

    await telegram.sendMessage(
      token,
      chatId,
      formatBrandedMessage(config, { heading: '🖼 Image & File Inspector', body: infoLines.join('\n') }),
      { reply_markup: userKb }
    );
    return;
  }

  if (text === '/start') {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
    await telegram.sendMessage(
      token,
      chatId,
      formatBrandedMessage(config, {
        heading: '🛠️ Modular Utility Toolkit',
        body: config.welcomeMessage || 'Choose a utility below, or upload any photo/document directly to inspect its Telegram metadata.',
      }),
      { reply_markup: userKb }
    );
    return;
  }

  const modeMap = {
    '🔗 URL Inspector': { step: 'url', prompt: 'Send any HTTP/HTTPS URL to inspect host, path, query params, and protocol:' },
    '📱 QR Generator': { step: 'qr', prompt: 'Send any text or URL to generate a scannable QR code image:' },
    '💳 UPI QR Generator': {
      step: 'upi_qr',
      prompt: 'Send UPI details to generate a scannable UPI QR code:\n<code>merchant@upi | Payee Name | Amount(optional) | Note(optional)</code>\n\n<i>Note: Generates a standard upi://pay QR code only; does not verify bank settlement.</i>',
    },
    '🖼 Image / File Info': { step: 'file', prompt: 'Upload or forward any photo, document, video, or audio file to inspect its Telegram metadata & file path.' },
    '📝 Text Tools': { step: 'text', prompt: 'Send any text block for word/char counts, slug, uppercase, and unique lines:' },
    '🔐 Base64 / SHA-256': { step: 'encode', prompt: 'Send text for Base64 & SHA-256 hash (prefix with <code>decode:</code> to decode Base64):' },
    '📄 JSON Formatter': { step: 'json', prompt: 'Send raw JSON to validate and pretty-print it:' },
  };

  if (modeMap[text]) {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, { step: modeMap[text].step });
    await telegram.sendMessage(token, chatId, formatBrandedMessage(config, { heading: text, body: modeMap[text].prompt }));
    return;
  }

  if (!state) {
    await telegram.sendMessage(token, chatId, 'Select a tool from the colourful menu below.', { reply_markup: userKb });
    return;
  }

  if (state.step === 'upi_qr') {
    const [upiId, payeeName, amountStr, note] = text.split('|').map((s) => (s || '').trim());
    const amount = amountStr ? Number(amountStr) : 0;
    const upi = buildUpiPaymentQr({ upiId, payeeName: payeeName || 'Payee', amount: Number.isFinite(amount) ? amount : 0, note });
    if (!upi.configured) {
      await telegram.sendMessage(token, chatId, '❌ Invalid UPI ID. Format: <code>name@upi | Payee Name | Amount | Note</code>');
      return;
    }
    await telegram
      .sendPhoto(token, chatId, upi.qrUrl, {
        caption: `💳 <b>UPI QR Generated</b>\n• UPI ID: <code>${escapeHtml(upiId)}</code>\n• Payee: <b>${escapeHtml(payeeName || 'Payee')}</b>${amount > 0 ? `\n• Amount: <b>₹${amount.toFixed(2)}</b>` : ''}\n• URI: <code>${escapeHtml(upi.upiUri)}</code>\n\n<i>Disclaimer: QR code only. Always verify receipt in your bank/UPI app.</i>`,
      })
      .catch(async () => {
        await telegram.sendMessage(token, chatId, `💳 <b>UPI Payment URI</b>\n<code>${escapeHtml(upi.upiUri)}</code>`);
      });
    return;
  }

  if (state.step === 'url') {
    const check = validateSafeUrl(text);
    if (!check.valid) {
      await telegram.sendMessage(token, chatId, `❌ ${escapeHtml(check.error)}`);
      return;
    }
    const u = new URL(check.url);
    const params = Array.from(u.searchParams.entries());
    const paramText = params.length
      ? params.map(([k, v]) => `  • <code>${escapeHtml(k)}</code> = <code>${escapeHtml(v)}</code>`).join('\n')
      : '  <i>None</i>';
    await telegram.sendMessage(
      token,
      chatId,
      formatBrandedMessage(config, {
        heading: '🔗 URL Analysis',
        body: [
          `• <b>Protocol:</b> ${escapeHtml(u.protocol)}`,
          `• <b>Host:</b> <code>${escapeHtml(u.host)}</code>`,
          `• <b>Path:</b> <code>${escapeHtml(u.pathname)}</code>`,
          `• <b>Query Params (${params.length}):</b>\n${paramText}`,
        ].join('\n'),
      })
    );
    return;
  }

  if (state.step === 'qr') {
    const qrUrl = `https://quickchart.io/qr?size=420&margin=2&text=${encodeURIComponent(text.slice(0, 600))}`;
    await telegram.sendPhoto(token, chatId, qrUrl, {
      caption: `📱 <b>QR Code Generated</b>\nPayload: <code>${escapeHtml(text.slice(0, 120))}</code>`,
    });
    return;
  }

  if (state.step === 'text') {
    const words = text.split(/\s+/).filter(Boolean).length;
    const lines = text.split(/\r?\n/);
    const uniqueLines = Array.from(new Set(lines.map((l) => l.trim()).filter(Boolean)));
    const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
    await telegram.sendMessage(
      token,
      chatId,
      formatBrandedMessage(config, {
        heading: '📝 Text Analysis',
        body: [
          `• <b>Characters:</b> ${text.length}`,
          `• <b>Words:</b> ${words}`,
          `• <b>Lines:</b> ${lines.length} (${uniqueLines.length} unique)`,
          `• <b>Slug:</b> <code>${escapeHtml(slug || 'n/a')}</code>`,
        ].join('\n'),
      })
    );
    return;
  }

  if (state.step === 'encode') {
    if (text.toLowerCase().startsWith('decode:')) {
      try {
        const decoded = atob(text.slice(7).trim());
        await telegram.sendMessage(token, chatId, `🔓 <b>Base64 Decoded:</b>\n<pre>${escapeHtml(decoded.slice(0, 2000))}</pre>`);
      } catch {
        await telegram.sendMessage(token, chatId, '❌ Invalid Base64 input.');
      }
      return;
    }
    const bytes = new TextEncoder().encode(text);
    const hashBuf = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, '0')).join('');
    const b64 = btoa(String.fromCharCode(...bytes));
    await telegram.sendMessage(
      token,
      chatId,
      formatBrandedMessage(config, {
        heading: '🔐 Encoding & Hash',
        body: `<b>Base64:</b>\n<code>${escapeHtml(b64.slice(0, 1000))}</code>\n\n<b>SHA-256:</b>\n<code>${sha256}</code>`,
      })
    );
    return;
  }

  if (state.step === 'json') {
    try {
      const pretty = JSON.stringify(JSON.parse(text), null, 2);
      await telegram.sendMessage(token, chatId, `✅ <b>Valid JSON</b>\n<pre>${escapeHtml(pretty.slice(0, 3600))}</pre>`);
    } catch (err) {
      await telegram.sendMessage(token, chatId, `❌ <b>Invalid JSON:</b> ${escapeHtml(err.message)}`);
    }
  }
}

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(2)} MB`;
}

function safeParse(str) {
  if (!str) return null;
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}
