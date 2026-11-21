/**
 * TEMPLATE: CHANNEL AUTOMATION BOT
 *
 * - Connect Telegram channels with REAL `getChatMember` admin permission verification
 * - Schedule formatted posts (HTML/Markdown) to D1 (`scheduled_posts`)
 * - Automatic posting via Cloudflare Worker cron (`dispatchDueScheduledPosts`) or manual "Dispatch Due Now"
 * - Queue management & cancellation
 * - Optional Secretary Mode (forwards approved admin text directly to connected channels)
 * - Dedicated ReplyKeyboard Tenant Admin Panel
 */

import { formatBrandedMessage } from '../../builder/theme-engine.js';
import {
  buildInlineKeyboard,
  buildReplyKeyboard,
  BUTTON_STYLES,
  inlineButton,
} from '../../utils/keyboards.js';
import { resolveAndVerifyForceJoinDestination } from '../../core/force-join.js';
import { newId } from '../../database/repositories.js';
import { escapeHtml } from '../../utils/validation.js';
import {
  ADMIN_COMMON_LABELS,
  buildCancelReplyKeyboard,
  buildTenantAdminReplyKeyboard,
  handleCommonTenantAdmin,
} from '../shared/tenant-admin.js';
import { decryptBotToken } from '../../core/token-security.js';
import { invalidateTenantCache } from '../../core/tenant-manager.js';

export const CHANNEL_AUTOMATION_META = {
  id: 'tpl_channel_automation',
  slug: 'channel-automation',
  name: 'Channel Automation Bot',
  category: 'Publishing & Channels',
};

const ADMIN_EXTRA_BUTTONS = [
  { text: '📡 Connect Channel', style: BUTTON_STYLES.SUCCESS },
  { text: '📅 Schedule Post', style: BUTTON_STYLES.PRIMARY },
  { text: '📋 Scheduled Queue', style: BUTTON_STYLES.PRIMARY },
  { text: '🚀 Dispatch Due Posts', style: BUTTON_STYLES.SUCCESS },
  { text: '🤖 Toggle Secretary Mode', style: BUTTON_STYLES.PRIMARY },
];

function buildUserKeyboard(isAdmin = false) {
  const rows = [
    [
      { text: '📡 Connected Channels', style: BUTTON_STYLES.PRIMARY },
      { text: '📅 Upcoming Posts', style: BUTTON_STYLES.SUCCESS },
    ],
    [{ text: '🎧 Support', style: BUTTON_STYLES.PRIMARY }],
  ];
  if (isAdmin) {
    rows.push([{ text: ADMIN_COMMON_LABELS.OPEN_ADMIN, style: BUTTON_STYLES.DANGER }]);
  }
  return buildReplyKeyboard(rows, { resize: true, persistent: true });
}

export async function handleChannelAutomationUpdate(ctx) {
  const { env, bot, config, token, telegram, repos, update, endUser, isAdmin } = ctx;
  const userKb = buildUserKeyboard(isAdmin);
  const adminKb = buildTenantAdminReplyKeyboard(ADMIN_EXTRA_BUTTONS);

  if (update.callback_query) {
    return handleCallback(ctx, adminKb);
  }

  const msg = update.message;
  if (!msg) return;
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const state = safeParse(endUser.state_json);

  const handledAdmin = await handleCommonTenantAdmin(ctx, {
    panelTitle: 'Channel Automation Admin',
    extraButtons: ADMIN_EXTRA_BUTTONS,
    userKeyboard: userKb,
    extraStatsSummary: async () => {
      const [cRes, pRes] = await Promise.all([
        repos.db.first(`SELECT COUNT(*) AS cnt FROM connected_channels WHERE bot_id = ? AND verified_admin = 1`, [bot.id]),
        repos.db.first(`SELECT COUNT(*) AS cnt FROM scheduled_posts WHERE bot_id = ? AND status = 'scheduled'`, [bot.id]),
      ]);
      return `• Verified Channels: <b>${Number(cRes.row?.cnt || 0)}</b>\n• Scheduled Queue: <b>${Number(pRes.row?.cnt || 0)}</b>`;
    },
  });
  if (handledAdmin) return;

  if (text === '/start') {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
    await telegram.sendMessage(
      token,
      chatId,
      formatBrandedMessage(config, {
        heading: '📡 Channel Automation Desk',
        body: config.welcomeMessage || 'Schedule, format, and publish Telegram channel posts automatically once the bot is verified as a channel administrator.',
      }),
      { reply_markup: userKb }
    );
    return;
  }

  // Admin: connect a channel with REAL getChat + getChatMember admin permission verification
  if (isAdmin && state?.step === 'ch_connect_input' && !text.startsWith('/')) {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, null);

    const resolved = await resolveAndVerifyForceJoinDestination({
      telegram,
      token,
      rawInput: text,
      botUsername: bot.telegram_username,
    });

    if (resolved.pendingPrivateLink) {
      await telegram.sendMessage(
        token,
        chatId,
        `🔐 Private channel invite links cannot be looked up via <code>getChat</code> alone.\nAdd @${escapeHtml(bot.telegram_username)} as Administrator to your private channel, then send its numeric ID paired with the invite link:\n<code>-100YOUR_CHANNEL_ID | ${escapeHtml(resolved.inviteUrl)}</code>`,
        { reply_markup: adminKb }
      );
      return;
    }

    if (!resolved.ok) {
      await telegram.sendMessage(
        token,
        chatId,
        `❌ <b>Channel Verification Failed</b>\n${escapeHtml(resolved.error)}`,
        { reply_markup: adminKb }
      );
      return;
    }

    const d = resolved.destination;
    const id = newId('chn');
    await repos.db.run(
      `INSERT INTO connected_channels (id, bot_id, channel_id, channel_username, channel_title, verified_admin, connected_by)
       VALUES (?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(bot_id, channel_id) DO UPDATE SET verified_admin = 1, channel_username = excluded.channel_username, channel_title = excluded.channel_title`,
      [id, bot.id, d.chatId, d.username ? `@${d.username}` : '', d.title, endUser.telegram_id]
    );
    await telegram.sendMessage(
      token,
      chatId,
      `✅ <b>Channel Verified & Connected!</b>\n• <b>Channel:</b> ${escapeHtml(d.title)}\n• <b>Chat ID:</b> <code>${escapeHtml(d.chatId)}</code>\n• <b>Admin Permission:</b> Verified (<b>${escapeHtml(d.botStatus)}</b>)`,
      { reply_markup: adminKb }
    );
    return;
  }

  // Admin: schedule a post -> CHANNEL | YYYY-MM-DD HH:MM (or NOW) | POST CONTENT
  if (isAdmin && state?.step === 'ch_schedule_input' && !text.startsWith('/')) {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
    const [channelRefRaw, timeRaw, ...bodyParts] = text.split('|');
    const channelRef = (channelRefRaw || '').trim();
    const timeStr = (timeRaw || '').trim();
    const postText = bodyParts.join('|').trim();
    if (!channelRef || !timeStr || !postText) {
      await telegram.sendMessage(
        token,
        chatId,
        '❌ Format:\n<code>@YourChannel | 2026-12-01 14:30 (or NOW) | Your formatted post message</code>',
        { reply_markup: adminKb }
      );
      return;
    }

    const { row: ch } = await repos.db.first(
      `SELECT * FROM connected_channels WHERE bot_id = ? AND channel_id = ? AND verified_admin = 1`,
      [bot.id, channelRef]
    );
    if (!ch) {
      await telegram.sendMessage(
        token,
        chatId,
        `❌ Channel <code>${escapeHtml(channelRef)}</code> is not connected & verified. Connect it first via 📡 Connect Channel.`,
        { reply_markup: adminKb }
      );
      return;
    }

    const scheduledFor =
      timeStr.toUpperCase() === 'NOW'
        ? new Date().toISOString()
        : new Date(timeStr.replace(' ', 'T') + (timeStr.includes('Z') ? '' : 'Z')).toISOString();

    if (Number.isNaN(new Date(scheduledFor).getTime())) {
      await telegram.sendMessage(token, chatId, '❌ Invalid date/time format. Use <code>YYYY-MM-DD HH:MM</code> (UTC) or <code>NOW</code>.', {
        reply_markup: adminKb,
      });
      return;
    }

    const postId = newId('pst');
    await repos.db.run(
      `INSERT INTO scheduled_posts (id, bot_id, channel_id, post_text, scheduled_for, status, created_by)
       VALUES (?, ?, ?, ?, ?, 'scheduled', ?)`,
      [postId, bot.id, ch.channel_id, postText, scheduledFor, endUser.telegram_id]
    );

    if (timeStr.toUpperCase() === 'NOW') {
      const dispatch = await dispatchSinglePost({ telegram, repos, token, postId, botId: bot.id });
      await telegram.sendMessage(
        token,
        chatId,
        dispatch.ok
          ? `✅ Post <code>${postId}</code> published immediately to <code>${escapeHtml(ch.channel_id)}</code>!`
          : `❌ Publish failed: ${escapeHtml(dispatch.error)}`,
        { reply_markup: adminKb }
      );
      return;
    }

    await telegram.sendMessage(
      token,
      chatId,
      `📅 <b>Post Scheduled!</b>\nID: <code>${postId}</code>\nChannel: <code>${escapeHtml(ch.channel_id)}</code>\nScheduled UTC: <code>${escapeHtml(scheduledFor)}</code>`,
      { reply_markup: adminKb }
    );
    return;
  }

  // Admin ReplyKeyboard actions
  if (isAdmin && text === '📡 Connect Channel') {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, { scope: 'tenant_admin', step: 'ch_connect_input' });
    await telegram.sendMessage(
      token,
      chatId,
      '📡 Add this bot as an <b>Administrator</b> in your Telegram channel, then send the channel <code>@username</code> or numeric <code>-100...</code> ID:',
      { reply_markup: buildCancelReplyKeyboard() }
    );
    return;
  }

  if (isAdmin && text === '📅 Schedule Post') {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, { scope: 'tenant_admin', step: 'ch_schedule_input' });
    await telegram.sendMessage(
      token,
      chatId,
      '📅 Send post details:\n<code>@YourChannel | YYYY-MM-DD HH:MM (UTC) or NOW | Post text (HTML supported)</code>',
      { reply_markup: buildCancelReplyKeyboard() }
    );
    return;
  }

  if (isAdmin && text === '📋 Scheduled Queue') {
    const { rows } = await repos.db.all(
      `SELECT * FROM scheduled_posts WHERE bot_id = ? AND status = 'scheduled' ORDER BY scheduled_for ASC LIMIT 12`,
      [bot.id]
    );
    if (!rows.length) {
      await telegram.sendMessage(token, chatId, '✅ No scheduled posts in queue.', { reply_markup: adminKb });
      return;
    }
    const body = rows
      .map((p) => `• <code>${p.id}</code> -> <b>${escapeHtml(p.channel_id)}</b> at <code>${escapeHtml(p.scheduled_for)}</code>`)
      .join('\n');
    const kb = buildInlineKeyboard(
      rows.slice(0, 6).map((p) => [
        inlineButton({ text: `❌ Cancel ${p.id}`, callbackData: `ch:cancel:${p.id}`, style: BUTTON_STYLES.DANGER }),
      ])
    );
    await telegram.sendMessage(token, chatId, formatBrandedMessage(config, { heading: '📋 Scheduled Queue', body }), {
      reply_markup: kb,
    });
    return;
  }

  if (isAdmin && text === '🚀 Dispatch Due Posts') {
    const { rows } = await repos.db.all(
      `SELECT id FROM scheduled_posts WHERE bot_id = ? AND status = 'scheduled' AND scheduled_for <= ? LIMIT 15`,
      [bot.id, new Date().toISOString()]
    );
    let sent = 0;
    let failed = 0;
    for (const p of rows) {
      const res = await dispatchSinglePost({ telegram, repos, token, postId: p.id, botId: bot.id });
      if (res.ok) sent += 1;
      else failed += 1;
    }
    await telegram.sendMessage(
      token,
      chatId,
      `🚀 <b>Due Posts Dispatch Complete</b>\n• Published: <b>${sent}</b>\n• Failed: <b>${failed}</b>`,
      { reply_markup: adminKb }
    );
    return;
  }

  if (isAdmin && text === '🤖 Toggle Secretary Mode') {
    const current = Boolean(config.templateSettings?.secretaryMode);
    const next = !current;
    await repos.botConfigs.upsert(bot.id, {
      ...config,
      templateSettings: { ...(config.templateSettings || {}), secretaryMode: next },
    });
    await invalidateTenantCache(env, bot.id);
    await telegram.sendMessage(
      token,
      chatId,
      `🤖 Secretary Mode is now <b>${next ? 'ENABLED' : 'DISABLED'}</b>.\n${next ? 'Direct text messages you send here (outside menus/commands) will automatically publish to your verified connected channels.' : 'Automatic forwarding paused.'}`,
      { reply_markup: adminKb }
    );
    return;
  }

  // User actions
  switch (text) {
    case '📡 Connected Channels': {
      const { rows } = await repos.db.all(
        `SELECT channel_id, verified_admin FROM connected_channels WHERE bot_id = ?`,
        [bot.id]
      );
      const body = rows.length
        ? rows.map((c) => `• <code>${escapeHtml(c.channel_id)}</code> — ${c.verified_admin ? '✅ Verified Admin' : '⚠️ Unverified'}`).join('\n')
        : '<i>No channels connected yet.</i>';
      await telegram.sendMessage(token, chatId, formatBrandedMessage(config, { heading: '📡 Connected Channels', body }), {
        reply_markup: userKb,
      });
      return;
    }

    case '📅 Upcoming Posts': {
      const { rows } = await repos.db.all(
        `SELECT id, channel_id, scheduled_for, status FROM scheduled_posts WHERE bot_id = ? ORDER BY scheduled_for DESC LIMIT 10`,
        [bot.id]
      );
      const body = rows.length
        ? rows.map((p) => `• <code>${p.id}</code> · ${escapeHtml(p.channel_id)} · <b>${p.status.toUpperCase()}</b>`).join('\n')
        : '<i>No scheduled posts found.</i>';
      await telegram.sendMessage(token, chatId, formatBrandedMessage(config, { heading: '📅 Posts Schedule', body }), {
        reply_markup: userKb,
      });
      return;
    }

    case '🎧 Support': {
      await telegram.sendMessage(
        token,
        chatId,
        formatBrandedMessage(config, {
          heading: '🎧 Support',
          body: config.supportUsername ? `Contact ${escapeHtml(config.supportUsername)}.` : 'Support not configured.',
        }),
        { reply_markup: userKb }
      );
      return;
    }
  }

  // Secretary Mode: forward verified admin messages directly to all verified connected channels
  if (isAdmin && config.templateSettings?.secretaryMode && !state && text && !text.startsWith('/')) {
    const { rows: channels } = await repos.db.all(
      `SELECT channel_id FROM connected_channels WHERE bot_id = ? AND verified_admin = 1`,
      [bot.id]
    );
    if (!channels.length) {
      await telegram.sendMessage(
        token,
        chatId,
        '⚠️ Secretary Mode is enabled, but no verified channels are connected yet. Use <b>📡 Connect Channel</b> first.',
        { reply_markup: adminKb }
      );
      return;
    }
    let published = 0;
    let failed = 0;
    for (const ch of channels) {
      try {
        const res = await telegram.sendMessage(token, ch.channel_id, text, { parse_mode: 'HTML' });
        const msgId = res?.result?.message_id ? String(res.result.message_id) : null;
        await repos.db.run(
          `INSERT INTO scheduled_posts (id, bot_id, channel_id, post_text, scheduled_for, status, telegram_message_id, sent_at, created_by)
           VALUES (?, ?, ?, ?, ?, 'sent', ?, ?, ?)`,
          [newId('sec'), bot.id, ch.channel_id, text, new Date().toISOString(), msgId, new Date().toISOString(), endUser.telegram_id]
        );
        published += 1;
      } catch {
        failed += 1;
      }
    }
    await telegram.sendMessage(
      token,
      chatId,
      `🤖 <b>Secretary Mode Dispatched</b>\n• Published to <b>${published}</b> channel(s)${failed ? `\n• Failed: <b>${failed}</b>` : ''}`,
      { reply_markup: adminKb }
    );
  }
}

async function handleCallback(ctx, adminKb) {
  const { bot, token, telegram, repos, update, isAdmin } = ctx;
  const cb = update.callback_query;
  const chatId = cb.message?.chat?.id;
  const data = cb.data || '';
  await telegram.answerCallbackQuery(token, cb.id).catch(() => {});
  if (!isAdmin) return;

  if (data.startsWith('ch:cancel:')) {
    const postId = data.slice('ch:cancel:'.length);
    await repos.db.run(
      `UPDATE scheduled_posts SET status = 'cancelled' WHERE id = ? AND bot_id = ? AND status = 'scheduled'`,
      [postId, bot.id]
    );
    await telegram.sendMessage(token, chatId, `❌ Scheduled post <code>${postId}</code> cancelled.`, { reply_markup: adminKb });
  }
}

export async function dispatchSinglePost({ telegram, repos, token, postId, botId }) {
  const { row: post } = await repos.db.first(
    `SELECT * FROM scheduled_posts WHERE id = ? AND bot_id = ? AND status = 'scheduled'`,
    [postId, botId]
  );
  if (!post) return { ok: false, error: 'Post not found or already processed.' };

  try {
    const sentRes = await telegram.sendMessage(token, post.channel_id, post.post_text, {
      parse_mode: post.parse_mode || 'HTML',
    });
    const msgId = sentRes?.result?.message_id ? String(sentRes.result.message_id) : null;
    await repos.db.run(
      `UPDATE scheduled_posts SET status = 'sent', telegram_message_id = ?, sent_at = ? WHERE id = ?`,
      [msgId, new Date().toISOString(), post.id]
    );
    return { ok: true, messageId: msgId };
  } catch (err) {
    await repos.db.run(
      `UPDATE scheduled_posts SET status = 'failed', last_error = ? WHERE id = ?`,
      [err.message || 'Send failed', post.id]
    );
    return { ok: false, error: err.message || 'Send failed' };
  }
}

/**
 * Called by Cloudflare Worker `scheduled()` cron to publish due scheduled posts across active bots.
 */
export async function dispatchDueScheduledPosts({ env, repos, telegram, limit = 20 }) {
  let rows = [];
  try {
    const res = await repos.db.all(
      `SELECT p.id, p.bot_id, b.token_encrypted
       FROM scheduled_posts p
       JOIN bots b ON b.id = p.bot_id
       WHERE p.status = 'scheduled' AND p.scheduled_for <= ? AND b.status = 'active'
       ORDER BY p.scheduled_for ASC LIMIT ?`,
      [new Date().toISOString(), limit]
    );
    rows = res.rows || [];
  } catch {
    return { processed: 0, sent: 0, failed: 0 };
  }

  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const token = await decryptBotToken(row.token_encrypted, env.TOKEN_ENCRYPTION_KEY);
      const res = await dispatchSinglePost({ telegram, repos, token, postId: row.id, botId: row.bot_id });
      if (res.ok) sent += 1;
      else failed += 1;
    } catch {
      failed += 1;
    }
  }
  return { processed: rows.length, sent, failed };
}

function safeParse(str) {
  if (!str) return null;
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}
