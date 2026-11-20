/**
 * TEMPLATE 7: GROUP MANAGEMENT BOT
 *
 * Moderation engine for Telegram Groups & Supergroups:
 * - Automated welcome messages for new_chat_members
 * - Configurable group /rules & /setrules
 * - Banned word filters (/addfilter, /delfilter, /filters) with real message deletion
 * - KV-backed anti-spam flood protection
 * - Real Telegram group admin verification via getChatMember
 * - Per-group moderation statistics (/stats)
 */

import { formatBrandedMessage } from '../../builder/theme-engine.js';
import { checkRateLimit } from '../../utils/rate-limiter.js';
import { newId } from '../../database/repositories.js';
import { escapeHtml } from '../../utils/validation.js';

export const GROUP_MANAGER_META = {
  id: 'tpl_group_manager',
  slug: 'group-manager',
  name: 'Group Management Bot',
  category: 'Community Moderation',
};

async function ensureGroupSettings(repos, botId, chat) {
  const chatId = String(chat.id);
  const { row } = await repos.db.first(
    `SELECT * FROM group_settings WHERE bot_id = ? AND chat_id = ?`,
    [botId, chatId]
  );
  if (row) {
    return { ...row, banned_words: safeParse(row.banned_words, []) };
  }
  await repos.db.run(
    `INSERT INTO group_settings (id, bot_id, chat_id, chat_title) VALUES (?, ?, ?, ?)`,
    [newId('grp'), botId, chatId, chat.title || 'Group']
  );
  const { row: created } = await repos.db.first(
    `SELECT * FROM group_settings WHERE bot_id = ? AND chat_id = ?`,
    [botId, chatId]
  );
  return { ...created, banned_words: safeParse(created?.banned_words, []) };
}

async function isGroupAdmin({ telegram, token, chatId, userId, isBotAdmin }) {
  if (isBotAdmin) return true;
  try {
    const res = await telegram.getChatMember(token, chatId, userId);
    return ['administrator', 'creator'].includes(res?.result?.status);
  } catch {
    return false;
  }
}

export async function handleGroupManagerUpdate(ctx) {
  const { env, bot, config, token, telegram, repos, update, isAdmin } = ctx;
  const msg = update.message;
  if (!msg) return;

  const chat = msg.chat;
  const chatId = chat.id;
  const isGroup = chat.type === 'group' || chat.type === 'supergroup';
  const text = (msg.text || '').trim();

  if (!isGroup) {
    await telegram.sendMessage(
      token,
      chatId,
      formatBrandedMessage(config, {
        heading: 'Group Management Bot',
        body: [
          'Add this bot to your Telegram group and grant Admin permissions (Delete Messages & Restrict Members).',
          '',
          '<b>Group Commands:</b>',
          '• <code>/rules</code> — Show group rules',
          '• <code>/setrules &lt;text&gt;</code> — Update group rules (Admins)',
          '• <code>/setwelcome &lt;text&gt;</code> — Customize welcome message using {name}',
          '• <code>/addfilter &lt;word&gt;</code> — Auto-delete banned keyword',
          '• <code>/delfilter &lt;word&gt;</code> — Remove banned keyword',
          '• <code>/filters</code> — List active filters',
          '• <code>/stats</code> — View group moderation statistics',
        ].join('\n'),
      })
    );
    return;
  }

  const grp = await ensureGroupSettings(repos, bot.id, chat);

  // Welcome new members
  if (Array.isArray(msg.new_chat_members) && msg.new_chat_members.length > 0) {
    for (const member of msg.new_chat_members) {
      if (member.is_bot) continue;
      const welcome = String(grp.welcome_text || 'Welcome, {name}!').replace(
        /\{name\}/gi,
        escapeHtml(member.first_name || member.username || 'Member')
      );
      await telegram.sendMessage(token, chatId, welcome).catch(() => {});
    }
    return;
  }

  await repos.db.run(
    `UPDATE group_settings SET messages_processed = messages_processed + 1, updated_at = ? WHERE id = ?`,
    [new Date().toISOString(), grp.id]
  );

  const senderId = String(msg.from?.id || '');
  const senderIsAdmin = await isGroupAdmin({ telegram, token, chatId, userId: senderId, isBotAdmin: isAdmin });

  // Non-admin anti-spam and banned-word enforcement
  if (!senderIsAdmin) {
    if (grp.anti_spam_enabled) {
      const rl = await checkRateLimit(
        env?.KV,
        `grp:${bot.id}:${chatId}:${senderId}`,
        Number(grp.max_messages_per_minute || 12),
        60
      );
      if (!rl.allowed) {
        await telegram.deleteMessage(token, chatId, msg.message_id).catch(() => {});
        await repos.db.run(`UPDATE group_settings SET warnings_issued = warnings_issued + 1 WHERE id = ?`, [grp.id]);
        await telegram
          .sendMessage(token, chatId, `⚠️ ${escapeHtml(msg.from?.first_name || 'User')}, please slow down — anti-spam protection is active.`)
          .catch(() => {});
        return;
      }
    }

    if (text && grp.banned_words.length > 0) {
      const lower = text.toLowerCase();
      const matched = grp.banned_words.find((w) => lower.includes(String(w).toLowerCase()));
      if (matched) {
        await telegram.deleteMessage(token, chatId, msg.message_id).catch(() => {});
        await repos.db.run(`UPDATE group_settings SET warnings_issued = warnings_issued + 1 WHERE id = ?`, [grp.id]);
        await telegram
          .sendMessage(token, chatId, `🛡 Message removed by group filter (${escapeHtml(msg.from?.first_name || 'User')}).`)
          .catch(() => {});
        return;
      }
    }
  }

  // Group Commands
  if (text === '/rules' || text.startsWith('/rules@')) {
    await telegram.sendMessage(token, chatId, `📜 <b>Group Rules</b>\n\n${escapeHtml(grp.rules_text)}`);
    return;
  }

  if (text === '/filters' || text.startsWith('/filters@')) {
    const list = grp.banned_words.length ? grp.banned_words.map((w) => `• <code>${escapeHtml(w)}</code>`).join('\n') : '<i>No word filters configured.</i>';
    await telegram.sendMessage(token, chatId, `🛡 <b>Active Word Filters</b>\n${list}`);
    return;
  }

  if (text === '/stats' || text.startsWith('/stats@')) {
    await telegram.sendMessage(
      token,
      chatId,
      `📊 <b>Group Moderation Statistics</b>\n• Group: <b>${escapeHtml(chat.title || String(chatId))}</b>\n• Messages Processed: <b>${Number(grp.messages_processed || 0) + 1}</b>\n• Moderation Actions: <b>${Number(grp.warnings_issued || 0)}</b>\n• Active Word Filters: <b>${grp.banned_words.length}</b>\n• Anti-Spam Limit: <b>${grp.max_messages_per_minute} msg/min</b>`
    );
    return;
  }

  // Admin-only group configuration commands
  if (text.startsWith('/setrules ')) {
    if (!senderIsAdmin) return;
    const nextRules = text.slice('/setrules '.length).trim().slice(0, 1500);
    await repos.db.run(`UPDATE group_settings SET rules_text = ?, updated_at = ? WHERE id = ?`, [
      nextRules,
      new Date().toISOString(),
      grp.id,
    ]);
    await telegram.sendMessage(token, chatId, '✅ Group rules updated.');
    return;
  }

  if (text.startsWith('/setwelcome ')) {
    if (!senderIsAdmin) return;
    const nextWelcome = text.slice('/setwelcome '.length).trim().slice(0, 1000);
    await repos.db.run(`UPDATE group_settings SET welcome_text = ?, updated_at = ? WHERE id = ?`, [
      nextWelcome,
      new Date().toISOString(),
      grp.id,
    ]);
    await telegram.sendMessage(token, chatId, '✅ Welcome message updated.');
    return;
  }

  if (text.startsWith('/addfilter ')) {
    if (!senderIsAdmin) return;
    const word = text.slice('/addfilter '.length).trim().toLowerCase().slice(0, 40);
    if (!word) return;
    const next = Array.from(new Set([...grp.banned_words, word]));
    await repos.db.run(`UPDATE group_settings SET banned_words = ?, updated_at = ? WHERE id = ?`, [
      JSON.stringify(next),
      new Date().toISOString(),
      grp.id,
    ]);
    await telegram.sendMessage(token, chatId, `✅ Added filter keyword: <code>${escapeHtml(word)}</code>`);
    return;
  }

  if (text.startsWith('/delfilter ')) {
    if (!senderIsAdmin) return;
    const word = text.slice('/delfilter '.length).trim().toLowerCase();
    const next = grp.banned_words.filter((w) => w.toLowerCase() !== word);
    await repos.db.run(`UPDATE group_settings SET banned_words = ?, updated_at = ? WHERE id = ?`, [
      JSON.stringify(next),
      new Date().toISOString(),
      grp.id,
    ]);
    await telegram.sendMessage(token, chatId, `✅ Removed filter keyword: <code>${escapeHtml(word)}</code>`);
  }
}

function safeParse(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}
