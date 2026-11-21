/**
 * TEMPLATE 6: FILE STORE BOT
 *
 * Indexed file distribution bot:
 * - Admin uploads any document -> receives unique deep-link share URL (?start=file_CODE)
 * - Users search indexed files, inspect file info, and retrieve authorized files
 * - Configurable access levels (public, force_join, admin_only)
 * - Download counters & user statistics
 */

import { formatBrandedMessage } from '../../builder/theme-engine.js';
import {
  buildInlineKeyboard,
  buildReplyKeyboard,
  BUTTON_STYLES,
  inlineButton,
} from '../../utils/keyboards.js';
import {
  buildForceJoinGateKeyboard,
  checkUserForceJoin,
  formatDestinationLabel,
} from '../../core/force-join.js';
import { newId } from '../../database/repositories.js';
import { escapeHtml } from '../../utils/validation.js';

export const FILE_STORE_META = {
  id: 'tpl_file_store',
  slug: 'file-store',
  name: 'File Store Bot',
  category: 'Media & Distribution',
};

function buildKeyboard(isAdmin = false) {
  const rows = [
    [
      { text: '📂 Browse Files', style: BUTTON_STYLES.PRIMARY },
      { text: '🔎 Search Files', style: BUTTON_STYLES.SUCCESS },
    ],
    [
      { text: '📊 Store Stats', style: BUTTON_STYLES.PRIMARY },
      { text: '❓ Help', style: BUTTON_STYLES.DEFAULT },
    ],
  ];
  if (isAdmin) {
    rows.push([{ text: '📤 Upload / Index File', style: BUTTON_STYLES.DANGER }]);
  }
  return buildReplyKeyboard(rows, { resize: true, persistent: true });
}

export async function handleFileStoreUpdate(ctx) {
  const { bot, config, token, telegram, repos, update, endUser, isAdmin } = ctx;

  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message?.chat?.id;
    const data = cb.data || '';
    await telegram.answerCallbackQuery(token, cb.id).catch(() => {});

    if (data.startsWith('fs:get:')) {
      const code = data.slice('fs:get:'.length);
      await sendFileByCode(ctx, chatId, code);
    }
    return;
  }

  const msg = update.message;
  if (!msg) return;
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const state = endUser.state_json ? safeParse(endUser.state_json) : null;

  // Admin document indexing
  if (isAdmin && msg.document) {
    const fileCode = `F${crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
    const doc = msg.document;
    const accessLevel = (config.forceJoinChannels || []).length > 0 ? 'force_join' : 'public';
    await repos.db.run(
      `INSERT INTO file_records (id, bot_id, file_code, telegram_file_id, file_unique_id, file_name, mime_type, file_size, caption, access_level, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId('fil'),
        bot.id,
        fileCode,
        doc.file_id,
        doc.file_unique_id || null,
        doc.file_name || `file_${fileCode}`,
        doc.mime_type || 'application/octet-stream',
        doc.file_size || 0,
        (msg.caption || '').slice(0, 500),
        accessLevel,
        endUser.telegram_id,
      ]
    );
    const deepLink = `https://t.me/${bot.telegram_username}?start=file_${fileCode}`;
    await telegram.sendMessage(
      token,
      chatId,
      formatBrandedMessage(config, {
        heading: '✅ File Indexed',
        body: `• <b>Name:</b> ${escapeHtml(doc.file_name || fileCode)}\n• <b>Code:</b> <code>${fileCode}</code>\n• <b>Access:</b> ${accessLevel}\n• <b>Share Link:</b>\n<code>${escapeHtml(deepLink)}</code>`,
      })
    );
    return;
  }

  if (text.startsWith('/start file_')) {
    const code = text.slice('/start file_'.length).trim();
    await sendFileByCode(ctx, chatId, code);
    return;
  }

  if (text === '/start') {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
    await telegram.sendMessage(
      token,
      chatId,
      formatBrandedMessage(config, {
        heading: 'Indexed File Store',
        body: config.welcomeMessage || 'Search or browse indexed files below. Admins can send any document directly to index it.',
      }),
      { reply_markup: buildKeyboard(isAdmin) }
    );
    return;
  }

  if (state?.step === 'search_files' && !text.startsWith('/')) {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
    const like = `%${text}%`;
    const { rows } = await repos.db.all(
      `SELECT * FROM file_records WHERE bot_id = ? AND (file_name LIKE ? OR caption LIKE ? OR file_code LIKE ?) ORDER BY created_at DESC LIMIT 10`,
      [bot.id, like, like, like]
    );
    if (!rows.length) {
      await telegram.sendMessage(token, chatId, `No indexed files matched "<b>${escapeHtml(text)}</b>".`);
      return;
    }
    const kb = buildInlineKeyboard(
      rows.map((f) => [
        inlineButton({ text: `📄 ${f.file_name} (${f.download_count} dl)`, callbackData: `fs:get:${f.file_code}`, style: BUTTON_STYLES.SUCCESS }),
      ])
    );
    await telegram.sendMessage(token, chatId, `🔎 <b>Matching Files (${rows.length})</b>`, { reply_markup: kb });
    return;
  }

  switch (text) {
    case '📂 Browse Files': {
      const { rows } = await repos.db.all(
        `SELECT * FROM file_records WHERE bot_id = ? ORDER BY created_at DESC LIMIT 12`,
        [bot.id]
      );
      if (!rows.length) {
        await telegram.sendMessage(token, chatId, 'No files indexed yet.');
        return;
      }
      const kb = buildInlineKeyboard(
        rows.map((f) => [
          inlineButton({ text: `📄 ${f.file_name}`, callbackData: `fs:get:${f.file_code}`, style: BUTTON_STYLES.PRIMARY }),
        ])
      );
      await telegram.sendMessage(token, chatId, formatBrandedMessage(config, { heading: '📂 Recent Indexed Files', body: 'Tap any file to download:' }), {
        reply_markup: kb,
      });
      return;
    }

    case '🔎 Search Files': {
      await repos.endUsers.setState(bot.id, endUser.telegram_id, { step: 'search_files' });
      await telegram.sendMessage(token, chatId, 'Send a filename keyword or file code to search:');
      return;
    }

    case '📊 Store Stats': {
      const { row } = await repos.db.first(
        `SELECT COUNT(*) AS files, COALESCE(SUM(download_count),0) AS downloads, COALESCE(SUM(file_size),0) AS bytes FROM file_records WHERE bot_id = ?`,
        [bot.id]
      );
      await telegram.sendMessage(
        token,
        chatId,
        formatBrandedMessage(config, {
          heading: '📊 File Store Metrics',
          body: `• <b>Indexed Files:</b> ${Number(row?.files || 0)}\n• <b>Total Downloads:</b> ${Number(row?.downloads || 0)}\n• <b>Indexed Volume:</b> ${(Number(row?.bytes || 0) / 1048576).toFixed(2)} MB`,
        })
      );
      return;
    }

    case '📤 Upload / Index File': {
      if (!isAdmin) return;
      await telegram.sendMessage(token, chatId, '📎 Send any Telegram Document (with optional caption) right now to index it and generate a shareable deep link.');
      return;
    }

    case '❓ Help': {
      await telegram.sendMessage(
        token,
        chatId,
        formatBrandedMessage(config, {
          heading: '❓ File Store Help',
          body: 'Use Browse or Search to retrieve indexed files. Share links open directly inside Telegram.',
        })
      );
    }
  }
}

async function sendFileByCode(ctx, chatId, code) {
  const { bot, config, token, telegram, repos, endUser, isAdmin } = ctx;
  const { row: file } = await repos.db.first(
    `SELECT * FROM file_records WHERE bot_id = ? AND file_code = ?`,
    [bot.id, code]
  );
  if (!file) {
    await telegram.sendMessage(token, chatId, '❌ File not found.');
    return;
  }
  if (file.access_level === 'admin_only' && !isAdmin) {
    await telegram.sendMessage(token, chatId, '🔒 This file is restricted to bot admins.');
    return;
  }
  if (file.access_level === 'force_join' && !isAdmin && (config.forceJoinChannels || []).length > 0) {
    const fjCheck = await checkUserForceJoin({
      telegram,
      token,
      destinations: config.forceJoinChannels,
      userId: endUser.telegram_id,
    });
    if (!fjCheck.passed) {
      const labels = fjCheck.missing.map((d) => `• <b>${escapeHtml(formatDestinationLabel(d))}</b>`).join('\n');
      await telegram.sendMessage(
        token,
        chatId,
        `📢 Please join the required channel(s) below first to access this file:\n\n${labels}`,
        { reply_markup: buildForceJoinGateKeyboard(fjCheck.missing, 'fj:verify') }
      );
      return;
    }
  }

  await repos.db.run(`UPDATE file_records SET download_count = download_count + 1 WHERE id = ?`, [file.id]);
  await telegram.sendDocument(token, chatId, file.telegram_file_id, {
    caption: `📄 <b>${escapeHtml(file.file_name)}</b>\n${file.caption ? `${escapeHtml(file.caption)}\n` : ''}Downloads: <b>${Number(file.download_count) + 1}</b>`,
  });
}

function safeParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}
