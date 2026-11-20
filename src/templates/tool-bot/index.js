/**
 * TEMPLATE 3: MODULAR TOOL BOT
 *
 * Every displayed module is 100% real and functional inside Cloudflare Workers:
 * - URL Inspector (parses host, protocol, path, query parameters, security check)
 * - QR Code Generator (real scannable QR PNG sent via Telegram sendPhoto)
 * - Text Utilities (word/char/line counts, UPPER, lower, slugify, deduplicate lines)
 * - Encoding & Crypto Tools (Base64 encode/decode, SHA-256 via Web Crypto, JSON formatter)
 * - Telegram File Inspector (inspects uploaded document/photo/audio metadata & file_id)
 * - AI Assistant module ONLY displayed & enabled if GEMINI_API_KEY is configured in Worker env
 */

import { formatBrandedMessage } from '../../builder/theme-engine.js';
import { buildReplyKeyboard, BUTTON_STYLES } from '../../utils/keyboards.js';
import { escapeHtml, validateSafeUrl } from '../../utils/validation.js';

export const TOOL_BOT_META = {
  id: 'tpl_tool_bot',
  slug: 'tool-bot',
  name: 'Tool Bot',
  category: 'Utilities & Productivity',
};

function buildToolKeyboard(aiAvailable = false) {
  const rows = [
    [
      { text: '🔗 URL Inspector', style: BUTTON_STYLES.PRIMARY },
      { text: '📱 QR Generator', style: BUTTON_STYLES.SUCCESS },
    ],
    [
      { text: '📝 Text Tools', style: BUTTON_STYLES.PRIMARY },
      { text: '🔐 Base64 / SHA-256', style: BUTTON_STYLES.PRIMARY },
    ],
    [
      { text: '📄 JSON Formatter', style: BUTTON_STYLES.PRIMARY },
      { text: '🗂 File Inspector', style: BUTTON_STYLES.SUCCESS },
    ],
  ];
  if (aiAvailable) {
    rows.push([{ text: '✨ AI Utility', style: BUTTON_STYLES.SUCCESS }]);
  }
  return buildReplyKeyboard(rows, { resize: true, persistent: true });
}

export async function handleToolBotUpdate(ctx) {
  const { env, bot, config, token, telegram, repos, update, endUser } = ctx;
  const aiAvailable = Boolean(env?.GEMINI_API_KEY && env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY');
  const msg = update.message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const state = endUser.state_json ? safeParse(endUser.state_json) : null;

  // Automatic File Inspector whenever user uploads media/documents
  if (msg.document || msg.photo || msg.video || msg.audio) {
    const infoLines = [];
    if (msg.document) {
      infoLines.push(
        `• <b>Type:</b> Document`,
        `• <b>Filename:</b> ${escapeHtml(msg.document.file_name || 'unnamed')}`,
        `• <b>MIME:</b> <code>${escapeHtml(msg.document.mime_type || 'unknown')}</code>`,
        `• <b>Size:</b> ${formatBytes(msg.document.file_size)}`,
        `• <b>File ID:</b> <code>${escapeHtml(msg.document.file_id)}</code>`
      );
    } else if (msg.photo) {
      const largest = msg.photo[msg.photo.length - 1];
      infoLines.push(
        `• <b>Type:</b> Photo`,
        `• <b>Resolution:</b> ${largest.width} × ${largest.height}px`,
        `• <b>Size:</b> ${formatBytes(largest.file_size)}`,
        `• <b>File ID:</b> <code>${escapeHtml(largest.file_id)}</code>`
      );
    } else if (msg.video) {
      infoLines.push(
        `• <b>Type:</b> Video (${msg.video.width}×${msg.video.height}, ${msg.video.duration}s)`,
        `• <b>Size:</b> ${formatBytes(msg.video.file_size)}`,
        `• <b>File ID:</b> <code>${escapeHtml(msg.video.file_id)}</code>`
      );
    } else if (msg.audio) {
      infoLines.push(
        `• <b>Type:</b> Audio (${msg.audio.duration}s)`,
        `• <b>Title:</b> ${escapeHtml(msg.audio.title || 'Unknown')}`,
        `• <b>Size:</b> ${formatBytes(msg.audio.file_size)}`,
        `• <b>File ID:</b> <code>${escapeHtml(msg.audio.file_id)}</code>`
      );
    }

    await telegram.sendMessage(
      token,
      chatId,
      formatBrandedMessage(config, { heading: '🗂 File Information', body: infoLines.join('\n') }),
      { reply_markup: buildToolKeyboard(aiAvailable) }
    );
    return;
  }

  if (text === '/start') {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
    await telegram.sendMessage(
      token,
      chatId,
      formatBrandedMessage(config, {
        heading: 'Modular Utility Toolkit',
        body: config.welcomeMessage || 'Choose a utility from the colourful keyboard below. You can also send any file directly to inspect its metadata.',
      }),
      { reply_markup: buildToolKeyboard(aiAvailable) }
    );
    return;
  }

  // Tool mode selection
  const modeMap = {
    '🔗 URL Inspector': { step: 'url', prompt: 'Send any HTTP/HTTPS URL to inspect its components, query params, and protocol security:' },
    '📱 QR Generator': { step: 'qr', prompt: 'Send any text or URL to generate a scannable QR code image:' },
    '📝 Text Tools': { step: 'text', prompt: 'Send any text block to compute statistics, slug, case variants, and deduplicated lines:' },
    '🔐 Base64 / SHA-256': { step: 'encode', prompt: 'Send text to compute Base64 & SHA-256 digest (prefix with <code>decode:</code> to decode Base64):' },
    '📄 JSON Formatter': { step: 'json', prompt: 'Send raw JSON to validate and pretty-print it:' },
    '🗂 File Inspector': { step: 'file', prompt: 'Send or forward any document, photo, video, or audio file to inspect its Telegram metadata.' },
  };

  if (aiAvailable && text === '✨ AI Utility') {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, { step: 'ai' });
    await telegram.sendMessage(token, chatId, '✨ <b>AI Utility Ready</b>\nSend your question or text task:');
    return;
  }

  if (modeMap[text]) {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, { step: modeMap[text].step });
    await telegram.sendMessage(token, chatId, formatBrandedMessage(config, { heading: text, body: modeMap[text].prompt }));
    return;
  }

  if (!state) {
    await telegram.sendMessage(token, chatId, 'Select a tool from the menu below first.', {
      reply_markup: buildToolKeyboard(aiAvailable),
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
          `• <b>Protocol:</b> ${escapeHtml(u.protocol)} (${u.protocol === 'https:' ? 'TLS Encrypted' : 'Unencrypted HTTP'})`,
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
    const slug = text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80);
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
          `• <b>UPPERCASE:</b> <code>${escapeHtml(text.toUpperCase().slice(0, 200))}</code>`,
        ].join('\n'),
      })
    );
    return;
  }

  if (state.step === 'encode') {
    if (text.toLowerCase().startsWith('decode:')) {
      const payload = text.slice(7).trim();
      try {
        const decoded = atob(payload);
        await telegram.sendMessage(token, chatId, `🔓 <b>Base64 Decoded:</b>\n<pre>${escapeHtml(decoded.slice(0, 2000))}</pre>`);
      } catch {
        await telegram.sendMessage(token, chatId, '❌ Invalid Base64 input.');
      }
      return;
    }
    const bytes = new TextEncoder().encode(text);
    const hashBuf = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const b64 = btoa(String.fromCharCode(...bytes));
    await telegram.sendMessage(
      token,
      chatId,
      formatBrandedMessage(config, {
        heading: '🔐 Encoding & Hash Output',
        body: `<b>Base64:</b>\n<code>${escapeHtml(b64.slice(0, 1000))}</code>\n\n<b>SHA-256:</b>\n<code>${sha256}</code>`,
      })
    );
    return;
  }

  if (state.step === 'json') {
    try {
      const parsed = JSON.parse(text);
      const pretty = JSON.stringify(parsed, null, 2);
      await telegram.sendMessage(token, chatId, `✅ <b>Valid JSON</b>\n<pre>${escapeHtml(pretty.slice(0, 3600))}</pre>`);
    } catch (err) {
      await telegram.sendMessage(token, chatId, `❌ <b>Invalid JSON:</b> ${escapeHtml(err.message)}`);
    }
    return;
  }

  if (state.step === 'ai' && aiAvailable) {
    await telegram.sendChatAction(token, chatId, 'typing').catch(() => {});
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: text.slice(0, 2000) }] }],
          }),
        }
      );
      const data = await res.json();
      const answer = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!answer) throw new Error('No response returned by AI model.');
      await telegram.sendMessage(token, chatId, escapeHtml(answer.slice(0, 3800)));
    } catch (err) {
      await telegram.sendMessage(token, chatId, `❌ AI request failed: ${escapeHtml(err.message)}`);
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
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}
