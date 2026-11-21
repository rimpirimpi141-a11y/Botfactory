/**
 * Shared Independent Tenant Bot ReplyKeyboard Admin Panel & Legitimate UPI Helpers.
 *
 * DESIGN RULES:
 * - Native ReplyKeyboard at the bottom of the Telegram screen (NEVER InlineKeyboard for admin menus).
 * - Every button has a vibrant native Telegram style ('success' | 'primary' | 'danger') — zero unstyled buttons.
 * - Strict tenant isolation: EVERY query scopes strictly by `bot.id`.
 * - Each template passes its own `extraButtons` (template-specific admin sections) and `onExtraAction`.
 * - Legitimate UPI QR helper generates real `upi://pay?...` QR images and ALWAYS requires
 *   admin payment proof verification before delivery or crediting balance.
 */

import { formatBrandedMessage } from '../../builder/theme-engine.js';
import { buildReplyKeyboard, BUTTON_STYLES, chunkButtonsToRows } from '../../utils/keyboards.js';
import { escapeHtml, validateSupportUsername } from '../../utils/validation.js';
import { invalidateTenantCache } from '../../core/tenant-manager.js';
import {
  checkUserForceJoin,
  formatDestinationLabel,
  formatForceJoinSummaryHtml,
  normalizeForceJoinList,
  removeForceJoinDestination,
  resolveAndVerifyForceJoinDestination,
  reverifyForceJoinDestinations,
  upsertForceJoinDestination,
} from '../../core/force-join.js';
import { runAnimatedOperation } from '../../utils/animations.js';
import { newId } from '../../database/repositories.js';

export const ADMIN_COMMON_LABELS = Object.freeze({
  OPEN_ADMIN: '🛡 Admin Panel',
  DASHBOARD: '📊 Admin Dashboard',
  USERS: '👥 User List',
  SEARCH_USER: '🔍 Search User',
  BAN_UNBAN: '🚫 Ban / Unban',
  BROADCAST: '📢 Broadcast',
  ADMINS: '👮 Manage Admins',
  FORCE_JOIN: '📣 Force Join',
  SUPPORT: '🆘 Support Settings',
  STATS: '📈 Bot Statistics',
  LOGS: '📋 Activity Logs',
  SETTINGS: '⚙️ Bot Settings',
  UPI_CONFIG: '💳 UPI / Payment Setup',
  BACK_TO_USER: '🏠 Back to User Menu',
  CANCEL: '✖️ Cancel Action',
});

/**
 * Generates a standards-compliant `upi://pay` URI and scannable QR PNG URL.
 * IMPORTANT: Never simulates or confirms payment automatically.
 */
export function buildUpiPaymentQr({ upiId, payeeName = 'Merchant', amount = 0, note = '' }) {
  const cleanUpi = String(upiId || '').trim();
  if (!cleanUpi || !cleanUpi.includes('@')) {
    return { configured: false, upiUri: null, qrUrl: null };
  }
  const params = new URLSearchParams();
  params.set('pa', cleanUpi);
  params.set('pn', String(payeeName || 'Merchant').slice(0, 40));
  if (Number(amount) > 0) params.set('am', Number(amount).toFixed(2));
  params.set('cu', 'INR');
  if (note) params.set('tn', String(note).slice(0, 50));

  const upiUri = `upi://pay?${params.toString()}`;
  const qrUrl = `https://quickchart.io/qr?size=420&margin=2&text=${encodeURIComponent(upiUri)}`;
  return { configured: true, upiUri, qrUrl };
}

/**
 * Builds the colourful native ReplyKeyboard for any tenant bot's Admin Panel.
 */
export function buildTenantAdminReplyKeyboard(extraButtons = [], options = {}) {
  const templateRows = chunkButtonsToRows(
    extraButtons.map((btn) => ({
      text: btn.text,
      style: btn.style || BUTTON_STYLES.SUCCESS,
    })),
    2
  );

  const coreRows = [
    [
      { text: ADMIN_COMMON_LABELS.DASHBOARD, style: BUTTON_STYLES.PRIMARY },
      { text: ADMIN_COMMON_LABELS.STATS, style: BUTTON_STYLES.PRIMARY },
    ],
    [
      { text: ADMIN_COMMON_LABELS.USERS, style: BUTTON_STYLES.PRIMARY },
      { text: ADMIN_COMMON_LABELS.SEARCH_USER, style: BUTTON_STYLES.PRIMARY },
    ],
    [
      { text: ADMIN_COMMON_LABELS.BAN_UNBAN, style: BUTTON_STYLES.DANGER },
      { text: ADMIN_COMMON_LABELS.BROADCAST, style: BUTTON_STYLES.SUCCESS },
    ],
    [
      { text: ADMIN_COMMON_LABELS.ADMINS, style: BUTTON_STYLES.PRIMARY },
      { text: ADMIN_COMMON_LABELS.FORCE_JOIN, style: BUTTON_STYLES.PRIMARY },
    ],
    [
      { text: ADMIN_COMMON_LABELS.SUPPORT, style: BUTTON_STYLES.PRIMARY },
      options.includeUpiSetup
        ? { text: ADMIN_COMMON_LABELS.UPI_CONFIG, style: BUTTON_STYLES.SUCCESS }
        : { text: ADMIN_COMMON_LABELS.LOGS, style: BUTTON_STYLES.PRIMARY },
    ],
    [
      ...(options.includeUpiSetup ? [{ text: ADMIN_COMMON_LABELS.LOGS, style: BUTTON_STYLES.PRIMARY }] : []),
      { text: ADMIN_COMMON_LABELS.SETTINGS, style: BUTTON_STYLES.PRIMARY },
    ],
    [{ text: ADMIN_COMMON_LABELS.BACK_TO_USER, style: BUTTON_STYLES.DANGER }],
  ].filter((row) => row.length > 0);

  return buildReplyKeyboard([...templateRows, ...coreRows], {
    resize: true,
    persistent: true,
    placeholder: options.placeholder || 'Tenant Admin Panel...',
  });
}

export function buildCancelReplyKeyboard() {
  return buildReplyKeyboard([[{ text: ADMIN_COMMON_LABELS.CANCEL, style: BUTTON_STYLES.DANGER }]], {
    resize: true,
    persistent: true,
    placeholder: 'Send input or tap Cancel Action...',
  });
}

/**
 * Handles all common Tenant Admin Panel commands, buttons, and stateful inputs.
 * Returns `true` if the update was handled by the common Admin Panel engine.
 */
export async function handleCommonTenantAdmin(ctx, {
  panelTitle = 'Admin Panel',
  extraButtons = [],
  includeUpiSetup = false,
  userKeyboard,
  extraStatsSummary = null,
}) {
  const { env, bot, config, token, telegram, repos, update, endUser, isAdmin } = ctx;
  const msg = update.message;
  if (!isAdmin || !msg) return false;

  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const state = safeParse(endUser.state_json);
  const adminKb = buildTenantAdminReplyKeyboard(extraButtons, { includeUpiSetup });

  // Cancel any in-progress admin wizard step cleanly
  if (text === ADMIN_COMMON_LABELS.CANCEL && state?.scope === 'tenant_admin') {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
    await telegram.sendMessage(token, chatId, '✖️ Admin action cancelled.', { reply_markup: adminKb });
    return true;
  }

  // Exit Admin Panel back to user ReplyKeyboard
  if (text === ADMIN_COMMON_LABELS.BACK_TO_USER) {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
    await telegram.sendMessage(
      token,
      chatId,
      formatBrandedMessage(config, {
        heading: config.brandTitle || bot.display_name,
        body: 'Returned to the user menu.',
      }),
      { reply_markup: userKeyboard }
    );
    return true;
  }

  // Open Admin Panel
  if (text === ADMIN_COMMON_LABELS.OPEN_ADMIN || text === '/admin' || text === ADMIN_COMMON_LABELS.DASHBOARD) {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
    const [uRes, bRes, pRes] = await Promise.all([
      repos.db.first(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN is_banned = 1 THEN 1 ELSE 0 END) AS banned FROM bot_end_users WHERE bot_id = ?`,
        [bot.id]
      ),
      repos.db.first(`SELECT COUNT(*) AS admins FROM admins WHERE bot_id = ?`, [bot.id]),
      repos.db
        .first(`SELECT COUNT(*) AS pending_proofs FROM payment_proofs WHERE bot_id = ? AND status = 'pending'`, [bot.id])
        .catch(() => ({ row: { pending_proofs: 0 } })),
    ]);

    const extraLine = extraStatsSummary ? `\n${await extraStatsSummary()}` : '';
    await telegram.sendMessage(
      token,
      chatId,
      formatBrandedMessage(config, {
        heading: `🛡 ${panelTitle}`,
        body: [
          `<b>Bot:</b> @${escapeHtml(bot.telegram_username)} (<code>${bot.id}</code>)`,
          `• Total Users: <b>${Number(uRes.row?.total || 0)}</b> (Banned: ${Number(uRes.row?.banned || 0)})`,
          `• Bot Admins: <b>${Number(bRes.row?.admins || 0)}</b>`,
          `• Pending Payment Proofs: <b>${Number(pRes.row?.pending_proofs || 0)}</b>`,
          `• Force Join Channels: <b>${(config.forceJoinChannels || []).length}</b>`,
          `• Support Handle: <b>${escapeHtml(config.supportUsername || 'Not configured')}</b>`,
          extraLine,
        ]
          .filter(Boolean)
          .join('\n'),
      }),
      { reply_markup: adminKb }
    );
    return true;
  }

  // Handle stateful common admin inputs
  if (state?.scope === 'tenant_admin' && !text.startsWith('/')) {
    if (state.step === 'search_user') {
      await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
      const like = `%${text}%`;
      const { rows } = await repos.db.all(
        `SELECT telegram_id, username, first_name, points_balance, referral_count, is_banned
         FROM bot_end_users
         WHERE bot_id = ? AND (telegram_id LIKE ? OR username LIKE ? OR first_name LIKE ?)
         LIMIT 10`,
        [bot.id, like, like, like]
      );
      const body = rows.length
        ? rows
            .map(
              (u) =>
                `• <code>${u.telegram_id}</code> ${u.username ? `@${escapeHtml(u.username)}` : escapeHtml(u.first_name || 'User')} — Bal: <b>${Number(u.points_balance || 0)}</b> | Refs: <b>${u.referral_count || 0}</b> | ${u.is_banned ? '🚫 Banned' : '✅ Active'}`
            )
            .join('\n')
        : '<i>No matching users found in this bot.</i>';
      await telegram.sendMessage(token, chatId, formatBrandedMessage(config, { heading: '🔍 User Search Results', body }), {
        reply_markup: adminKb,
      });
      return true;
    }

    if (state.step === 'ban_unban_input') {
      const targetId = text.replace(/[^0-9]/g, '');
      if (!targetId) {
        await telegram.sendMessage(token, chatId, '❌ Send a valid numeric Telegram user ID.', {
          reply_markup: buildCancelReplyKeyboard(),
        });
        return true;
      }
      if (targetId === String(bot.owner_telegram_id)) {
        await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
        await telegram.sendMessage(token, chatId, '🚫 The bot owner cannot be banned.', { reply_markup: adminKb });
        return true;
      }
      const target = await repos.endUsers.get(bot.id, targetId);
      if (!target) {
        await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
        await telegram.sendMessage(token, chatId, `❌ User <code>${targetId}</code> not found in this bot.`, {
          reply_markup: adminKb,
        });
        return true;
      }
      const nextBan = target.is_banned ? 0 : 1;
      await repos.endUsers.setState(bot.id, endUser.telegram_id, {
        scope: 'tenant_admin',
        step: 'ban_unban_confirm',
        targetId,
        nextBan,
      });
      await telegram.sendMessage(
        token,
        chatId,
        `⚠️ Confirm <b>${nextBan ? 'BAN' : 'UNBAN'}</b> for user <code>${targetId}</code>?\nReply <b>CONFIRM</b> to proceed or tap Cancel Action.`,
        { reply_markup: buildCancelReplyKeyboard() }
      );
      return true;
    }

    if (state.step === 'ban_unban_confirm') {
      await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
      if (text.toUpperCase() !== 'CONFIRM') {
        await telegram.sendMessage(token, chatId, '✖️ Confirmation not received. Action aborted.', { reply_markup: adminKb });
        return true;
      }
      await repos.db.run(
        `UPDATE bot_end_users SET is_banned = ? WHERE bot_id = ? AND telegram_id = ?`,
        [state.nextBan, bot.id, state.targetId]
      );
      await repos.stats.recordActivity(bot.id, {
        userTelegramId: endUser.telegram_id,
        eventType: state.nextBan ? 'admin_ban_user' : 'admin_unban_user',
        featureKey: state.targetId,
      });
      await telegram.sendMessage(
        token,
        chatId,
        `✅ User <code>${state.targetId}</code> is now <b>${state.nextBan ? 'BANNED' : 'ACTIVE'}</b>.`,
        { reply_markup: adminKb }
      );
      return true;
    }

    if (state.step === 'broadcast_message') {
      await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
      const { rows: recipients } = await repos.db.all(
        `SELECT telegram_id FROM bot_end_users WHERE bot_id = ? AND is_banned = 0 AND is_blocked = 0 LIMIT 200`,
        [bot.id]
      );
      let sent = 0;
      let failed = 0;
      for (const r of recipients) {
        try {
          await telegram.sendMessage(
            token,
            r.telegram_id,
            formatBrandedMessage(config, { heading: '📢 Announcement', body: escapeHtml(text) })
          );
          sent += 1;
        } catch (err) {
          failed += 1;
          if (err?.status === 403) {
            await repos.endUsers.markBlocked(bot.id, r.telegram_id).catch(() => {});
          }
        }
      }
      await repos.stats.recordActivity(bot.id, {
        userTelegramId: endUser.telegram_id,
        eventType: 'admin_broadcast',
        featureKey: `sent:${sent}:failed:${failed}`,
      });
      await telegram.sendMessage(
        token,
        chatId,
        `✅ <b>Bot Broadcast Finished</b>\n• Recipients: <b>${recipients.length}</b>\n• Delivered: <b>${sent}</b>\n• Failed/Blocked: <b>${failed}</b>`,
        { reply_markup: adminKb }
      );
      return true;
    }

    if (state.step === 'manage_admins') {
      await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
      const [action, rawId] = text.split(/\s+/);
      const targetId = String(rawId || '').replace(/[^0-9]/g, '');
      if (!['add', 'remove'].includes((action || '').toLowerCase()) || !targetId) {
        await telegram.sendMessage(
          token,
          chatId,
          '❌ Use format: <code>add 123456789</code> or <code>remove 123456789</code>.',
          { reply_markup: adminKb }
        );
        return true;
      }
      if (action.toLowerCase() === 'add') {
        await repos.db.run(
          `INSERT OR IGNORE INTO admins (id, bot_id, telegram_id, permissions, added_by) VALUES (?, ?, ?, '["all"]', ?)`,
          [newId('adm'), bot.id, targetId, endUser.telegram_id]
        );
        await telegram.sendMessage(token, chatId, `✅ Added <code>${targetId}</code> as an admin for this bot.`, {
          reply_markup: adminKb,
        });
      } else {
        if (targetId === String(bot.owner_telegram_id)) {
          await telegram.sendMessage(token, chatId, '🚫 The primary bot owner cannot be removed.', {
            reply_markup: adminKb,
          });
          return true;
        }
        await repos.db.run(`DELETE FROM admins WHERE bot_id = ? AND telegram_id = ?`, [bot.id, targetId]);
        await telegram.sendMessage(token, chatId, `✅ Removed admin <code>${targetId}</code> from this bot.`, {
          reply_markup: adminKb,
        });
      }
      return true;
    }

    if (state.step === 'force_join_input') {
      await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
      const lower = text.toLowerCase();
      const existing = normalizeForceJoinList(config.forceJoinChannels || []);

      if (lower === 'clear') {
        const nextTemplateSettings = { ...(config.templateSettings || {}) };
        delete nextTemplateSettings.pendingForceJoinLink;
        await repos.botConfigs.upsert(bot.id, {
          ...config,
          forceJoinChannels: [],
          templateSettings: nextTemplateSettings,
        });
        await invalidateTenantCache(env, bot.id);
        await telegram.sendMessage(
          token,
          chatId,
          '✅ All Force Join destinations and pending private links have been cleared for this bot.',
          { reply_markup: adminKb }
        );
        return true;
      }

      if (lower.startsWith('remove ')) {
        const target = text.slice(7).trim();
        const { removed, destinations } = removeForceJoinDestination(existing, target);
        if (!removed) {
          await telegram.sendMessage(
            token,
            chatId,
            `❌ Could not find a Force Join destination matching <code>${escapeHtml(target)}</code>.\nUse the destination number (e.g. <code>remove 1</code>), <code>@username</code>, or chat ID.`,
            { reply_markup: adminKb }
          );
          return true;
        }
        await repos.botConfigs.upsert(bot.id, { ...config, forceJoinChannels: destinations });
        await invalidateTenantCache(env, bot.id);
        await telegram.sendMessage(
          token,
          chatId,
          `✅ Removed <b>${escapeHtml(formatDestinationLabel(removed))}</b> (<code>${escapeHtml(removed.chatId)}</code>).\n\n${formatForceJoinSummaryHtml(destinations, config.templateSettings?.pendingForceJoinLink)}`,
          { reply_markup: adminKb }
        );
        return true;
      }

      if (lower === 'reverify') {
        if (existing.length === 0) {
          await telegram.sendMessage(token, chatId, 'ℹ️ No Force Join destinations configured to re-verify.', {
            reply_markup: adminKb,
          });
          return true;
        }
        const { messageId, result } = await runAnimatedOperation({
          telegram,
          token,
          chatId,
          title: '🔍 Re-Verifying Force Join Access',
          minStepIntervalMs: 500,
          steps: [
            {
              label: `Checking bot admin rights across ${existing.length} destination(s)...`,
              doneLabel: 'Telegram admin permissions inspected',
              run: () => reverifyForceJoinDestinations({ telegram, token, destinations: existing }),
            },
            {
              label: 'Updating verified status in Cloudflare D1...',
              doneLabel: 'Verification statuses saved',
              run: async (rev) => {
                await repos.botConfigs.upsert(bot.id, { ...config, forceJoinChannels: rev.destinations });
                await invalidateTenantCache(env, bot.id);
                return rev;
              },
            },
          ],
        });

        const reportLines = result.summary.map(
          (item, i) =>
            `${i + 1}. ${item.ok ? '✅' : '❌'} <b>${escapeHtml(formatDestinationLabel(item.destination))}</b> (<code>${escapeHtml(item.destination.chatId)}</code>) — <b>${escapeHtml(item.status)}</b>${item.error ? `\n   <i>${escapeHtml(item.error)}</i>` : ''}`
        );
        const reportText = `<b>🔍 Force Join Re-Verification Report</b>\n\n${reportLines.join('\n')}`;
        if (messageId) {
          await telegram.editMessageText(token, chatId, messageId, reportText).catch(() => {});
          await telegram.sendMessage(token, chatId, 'Use the Admin Panel below to manage destinations.', {
            reply_markup: adminKb,
          });
        } else {
          await telegram.sendMessage(token, chatId, reportText, { reply_markup: adminKb });
        }
        return true;
      }

      if (lower === 'test' || lower.startsWith('test ')) {
        const testUserId = text.slice(4).trim().replace(/[^0-9]/g, '') || String(endUser.telegram_id);
        if (existing.length === 0) {
          await telegram.sendMessage(token, chatId, 'ℹ️ Add at least one Force Join destination before testing.', {
            reply_markup: adminKb,
          });
          return true;
        }
        const check = await checkUserForceJoin({
          telegram,
          token,
          destinations: existing,
          userId: testUserId,
        });
        const lines = check.results.map(
          (r, i) =>
            `${i + 1}. ${r.joined ? '✅' : '❌'} <b>${escapeHtml(formatDestinationLabel(r.destination))}</b> (<code>${escapeHtml(r.destination.chatId)}</code>) — status: <b>${escapeHtml(r.status)}</b>${r.status === 'restricted' ? ` (is_member: ${Boolean(r.isMember)})` : ''}${r.error ? ` · <i>${escapeHtml(r.error)}</i>` : ''}`
        );
        await telegram.sendMessage(
          token,
          chatId,
          `<b>🧪 Membership Test for User <code>${escapeHtml(testUserId)}</code></b>\nOverall Result: <b>${check.passed ? '✅ PASSED' : '❌ BLOCKED'}</b>\n\n${lines.join('\n')}`,
          { reply_markup: adminKb }
        );
        return true;
      }

      // Add a public or private Force Join destination (strip optional "add " prefix)
      const rawDestination = lower.startsWith('add ') ? text.slice(4).trim() : text;
      const { messageId, result: resolved } = await runAnimatedOperation({
        telegram,
        token,
        chatId,
        title: '📣 Verifying Force Join Destination',
        minStepIntervalMs: 500,
        steps: [
          {
            label: 'Parsing Telegram username / URL & verifying admin permissions...',
            doneLabel: 'Destination verified via Telegram Bot API',
            run: () =>
              resolveAndVerifyForceJoinDestination({
                telegram,
                token,
                rawInput: rawDestination,
                botUsername: bot.telegram_username,
              }),
          },
        ],
      });

      if (resolved.pendingPrivateLink) {
        const pendingLink = {
          inviteUrl: resolved.inviteUrl,
          inviteCode: resolved.inviteCode,
          requestedBy: String(endUser.telegram_id),
          chatId: String(chatId),
          requestedAt: new Date().toISOString(),
        };
        await repos.botConfigs.upsert(bot.id, {
          ...config,
          templateSettings: {
            ...(config.templateSettings || {}),
            pendingForceJoinLink: pendingLink,
          },
        });
        await invalidateTenantCache(env, bot.id);
        if (messageId) {
          await telegram.editMessageText(token, chatId, messageId, resolved.instructions).catch(() => {});
          await telegram.sendMessage(token, chatId, '⏳ Waiting for Telegram admin promotion update...', {
            reply_markup: adminKb,
          });
        } else {
          await telegram.sendMessage(token, chatId, resolved.instructions, { reply_markup: adminKb });
        }
        return true;
      }

      if (!resolved.ok) {
        const errCard = `❌ <b>Force Join Verification Failed</b>\n\n${escapeHtml(resolved.error)}`;
        if (messageId) {
          await telegram.editMessageText(token, chatId, messageId, errCard).catch(() => {});
          await telegram.sendMessage(token, chatId, 'Destination was NOT saved. Fix the issue above and try again.', {
            reply_markup: adminKb,
          });
        } else {
          await telegram.sendMessage(token, chatId, errCard, { reply_markup: adminKb });
        }
        return true;
      }

      const updated = upsertForceJoinDestination(existing, resolved.destination);
      const nextTemplateSettings = { ...(config.templateSettings || {}) };
      if (resolved.destination.isPrivate && nextTemplateSettings.pendingForceJoinLink) {
        delete nextTemplateSettings.pendingForceJoinLink;
      }
      await repos.botConfigs.upsert(bot.id, {
        ...config,
        forceJoinChannels: updated,
        templateSettings: nextTemplateSettings,
      });
      await invalidateTenantCache(env, bot.id);

      const d = resolved.destination;
      const okCard = [
        `✅ <b>Force Join Destination Verified & Saved!</b>`,
        `• <b>Name:</b> ${escapeHtml(d.title)}`,
        `• <b>Type:</b> ${d.isPrivate ? '🔐 Private' : '🌐 Public'} ${escapeHtml(d.chatType)}`,
        `• <b>Numeric Chat ID:</b> <code>${escapeHtml(d.chatId)}</code>`,
        `• <b>Join URL:</b> <code>${escapeHtml(d.inviteUrl || '')}</code>`,
        `• <b>Bot Admin Status:</b> ${escapeHtml(d.botStatus.toUpperCase())}`,
        '',
        `Total active destinations: <b>${updated.length}</b>`,
      ].join('\n');

      if (messageId) {
        await telegram.editMessageText(token, chatId, messageId, okCard).catch(() => {});
        await telegram.sendMessage(token, chatId, '✅ Force Join configuration is now live.', {
          reply_markup: adminKb,
        });
      } else {
        await telegram.sendMessage(token, chatId, okCard, { reply_markup: adminKb });
      }
      return true;
    }

    if (state.step === 'support_input') {
      await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
      const check = validateSupportUsername(text === 'clear' ? '' : text);
      if (!check.valid) {
        await telegram.sendMessage(token, chatId, `❌ ${escapeHtml(check.error)}`, { reply_markup: adminKb });
        return true;
      }
      await repos.botConfigs.upsert(bot.id, { ...config, supportUsername: check.username });
      await invalidateTenantCache(env, bot.id);
      await telegram.sendMessage(
        token,
        chatId,
        check.username
          ? `✅ Support username updated to <b>${escapeHtml(check.username)}</b>.`
          : '✅ Support username cleared.',
        { reply_markup: adminKb }
      );
      return true;
    }

    if (state.step === 'upi_setup_input') {
      await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
      const [upiId, payeeName, instructions] = text.split('|').map((s) => (s || '').trim());
      if (!upiId || !upiId.includes('@')) {
        await telegram.sendMessage(
          token,
          chatId,
          '❌ Invalid format. Send:\n<code>merchant@upi | Payee Name | Optional payment instructions</code>',
          { reply_markup: adminKb }
        );
        return true;
      }
      const nextSettings = {
        ...(config.templateSettings || {}),
        upiId,
        upiPayeeName: payeeName || config.brandTitle || bot.display_name,
        paymentInstructions:
          instructions ||
          'Scan the UPI QR or pay to the UPI ID, then submit your UTR number or payment screenshot for admin verification.',
      };
      await repos.botConfigs.upsert(bot.id, { ...config, templateSettings: nextSettings });
      await invalidateTenantCache(env, bot.id);
      await telegram.sendMessage(
        token,
        chatId,
        `✅ <b>UPI Payment Configuration Saved</b>\n• UPI ID: <code>${escapeHtml(upiId)}</code>\n• Payee: <b>${escapeHtml(nextSettings.upiPayeeName)}</b>\n\nAll payments require manual admin verification before delivery.`,
        { reply_markup: adminKb }
      );
      return true;
    }

    if (state.step === 'welcome_msg_input') {
      await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
      await repos.botConfigs.upsert(bot.id, { ...config, welcomeMessage: text.slice(0, 1200) });
      await invalidateTenantCache(env, bot.id);
      await telegram.sendMessage(token, chatId, '✅ Bot welcome message updated and cache invalidated.', {
        reply_markup: adminKb,
      });
      return true;
    }
  }

  // Direct Admin ReplyKeyboard button handlers
  switch (text) {
    case ADMIN_COMMON_LABELS.USERS: {
      const { rows } = await repos.db.all(
        `SELECT telegram_id, username, first_name, points_balance, referral_count, is_banned
         FROM bot_end_users WHERE bot_id = ? ORDER BY joined_at DESC LIMIT 20`,
        [bot.id]
      );
      const body = rows.length
        ? rows
            .map(
              (u, i) =>
                `${i + 1}. <code>${u.telegram_id}</code> ${u.username ? `@${escapeHtml(u.username)}` : escapeHtml(u.first_name || 'User')} · Bal: <b>${Number(u.points_balance || 0)}</b> · ${u.is_banned ? '🚫' : '✅'}`
            )
            .join('\n')
        : '<i>No users have started this bot yet.</i>';
      await telegram.sendMessage(token, chatId, formatBrandedMessage(config, { heading: '👥 Recent Bot Users (Top 20)', body }), {
        reply_markup: adminKb,
      });
      return true;
    }

    case ADMIN_COMMON_LABELS.SEARCH_USER: {
      await repos.endUsers.setState(bot.id, endUser.telegram_id, { scope: 'tenant_admin', step: 'search_user' });
      await telegram.sendMessage(token, chatId, '🔍 Send a Telegram User ID, username, or first name to search:', {
        reply_markup: buildCancelReplyKeyboard(),
      });
      return true;
    }

    case ADMIN_COMMON_LABELS.BAN_UNBAN: {
      await repos.endUsers.setState(bot.id, endUser.telegram_id, { scope: 'tenant_admin', step: 'ban_unban_input' });
      await telegram.sendMessage(token, chatId, '🚫 Send the numeric Telegram ID of the user to Ban or Unban:', {
        reply_markup: buildCancelReplyKeyboard(),
      });
      return true;
    }

    case ADMIN_COMMON_LABELS.BROADCAST: {
      await repos.endUsers.setState(bot.id, endUser.telegram_id, { scope: 'tenant_admin', step: 'broadcast_message' });
      await telegram.sendMessage(
        token,
        chatId,
        '📢 Send the announcement message to broadcast to all active users of this bot:',
        { reply_markup: buildCancelReplyKeyboard() }
      );
      return true;
    }

    case ADMIN_COMMON_LABELS.ADMINS: {
      const { rows } = await repos.db.all(`SELECT telegram_id, permissions FROM admins WHERE bot_id = ?`, [bot.id]);
      const list = rows.map((r) => `• <code>${r.telegram_id}</code>`).join('\n') || 'None';
      await repos.endUsers.setState(bot.id, endUser.telegram_id, { scope: 'tenant_admin', step: 'manage_admins' });
      await telegram.sendMessage(
        token,
        chatId,
        `<b>👮 Bot Admins</b>\n${list}\n\nSend <code>add TELEGRAM_ID</code> or <code>remove TELEGRAM_ID</code>:`,
        { reply_markup: buildCancelReplyKeyboard() }
      );
      return true;
    }

    case ADMIN_COMMON_LABELS.FORCE_JOIN: {
      const summary = formatForceJoinSummaryHtml(
        config.forceJoinChannels || [],
        config.templateSettings?.pendingForceJoinLink || null
      );
      await repos.endUsers.setState(bot.id, endUser.telegram_id, { scope: 'tenant_admin', step: 'force_join_input' });
      await telegram.sendMessage(
        token,
        chatId,
        [
          '<b>📣 Force Join Management (Public & Private)</b>',
          '',
          summary,
          '',
          '<b>Supported Actions:</b>',
          '• <b>Add Public:</b> <code>@username</code> or <code>https://t.me/username</code>',
          '• <b>Add Private:</b> <code>https://t.me/+INVITECODE</code> or <code>https://t.me/joinchat/CODE</code>',
          '• <b>Remove:</b> <code>remove 1</code> or <code>remove @username</code>',
          '• <b>Re-verify Admin Access:</b> <code>reverify</code>',
          '• <b>Test Membership:</b> <code>test</code> or <code>test USER_ID</code>',
          '• <b>Clear All:</b> <code>clear</code>',
        ].join('\n'),
        { reply_markup: buildCancelReplyKeyboard() }
      );
      return true;
    }

    case ADMIN_COMMON_LABELS.SUPPORT: {
      await repos.endUsers.setState(bot.id, endUser.telegram_id, { scope: 'tenant_admin', step: 'support_input' });
      await telegram.sendMessage(
        token,
        chatId,
        `<b>🆘 Support Settings</b>\nCurrent: <b>${escapeHtml(config.supportUsername || 'Not configured')}</b>\n\nSend the new <code>@support_username</code> (or <code>clear</code>):`,
        { reply_markup: buildCancelReplyKeyboard() }
      );
      return true;
    }

    case ADMIN_COMMON_LABELS.UPI_CONFIG: {
      const curUpi = config.templateSettings?.upiId || 'Not configured';
      const curPayee = config.templateSettings?.upiPayeeName || config.brandTitle || bot.display_name;
      await repos.endUsers.setState(bot.id, endUser.telegram_id, { scope: 'tenant_admin', step: 'upi_setup_input' });
      await telegram.sendMessage(
        token,
        chatId,
        `<b>💳 UPI / Payment Setup</b>\nCurrent UPI ID: <code>${escapeHtml(curUpi)}</code>\nPayee: <b>${escapeHtml(curPayee)}</b>\n\nSend: <code>merchant@upi | Payee Name | Payment Instructions</code>`,
        { reply_markup: buildCancelReplyKeyboard() }
      );
      return true;
    }

    case ADMIN_COMMON_LABELS.STATS: {
      const [uRes, txRes, actRes] = await Promise.all([
        repos.db.first(`SELECT COUNT(*) AS users, COALESCE(SUM(points_balance),0) AS points FROM bot_end_users WHERE bot_id = ?`, [bot.id]),
        repos.db.first(`SELECT COUNT(*) AS txs FROM transactions WHERE bot_id = ?`, [bot.id]),
        repos.db.first(`SELECT COUNT(*) AS events FROM bot_activity WHERE bot_id = ?`, [bot.id]),
      ]);
      const extraLine = extraStatsSummary ? `\n${await extraStatsSummary()}` : '';
      await telegram.sendMessage(
        token,
        chatId,
        formatBrandedMessage(config, {
          heading: '📈 Live Bot Statistics',
          body: [
            `• Registered End-Users: <b>${Number(uRes.row?.users || 0)}</b>`,
            `• Total User Balances: <b>${Number(uRes.row?.points || 0)}</b>`,
            `• Ledger Transactions: <b>${Number(txRes.row?.txs || 0)}</b>`,
            `• Webhook Updates Handled: <b>${Number(bot.total_updates || 0)}</b>`,
            `• Logged Activity Events: <b>${Number(actRes.row?.events || 0)}</b>`,
            extraLine,
          ]
            .filter(Boolean)
            .join('\n'),
        }),
        { reply_markup: adminKb }
      );
      return true;
    }

    case ADMIN_COMMON_LABELS.LOGS: {
      const { rows } = await repos.db.all(
        `SELECT event_type, feature_key, user_telegram_id, created_at
         FROM bot_activity WHERE bot_id = ? ORDER BY created_at DESC LIMIT 12`,
        [bot.id]
      );
      const body = rows.length
        ? rows
            .map(
              (r) =>
                `• <b>${escapeHtml(r.event_type)}</b> ${r.feature_key ? `(${escapeHtml(r.feature_key)})` : ''} — User <code>${r.user_telegram_id || 'sys'}</code>`
            )
            .join('\n')
        : '<i>No activity logged yet.</i>';
      await telegram.sendMessage(token, chatId, formatBrandedMessage(config, { heading: '📋 Recent Activity Logs', body }), {
        reply_markup: adminKb,
      });
      return true;
    }

    case ADMIN_COMMON_LABELS.SETTINGS: {
      await repos.endUsers.setState(bot.id, endUser.telegram_id, { scope: 'tenant_admin', step: 'welcome_msg_input' });
      await telegram.sendMessage(
        token,
        chatId,
        `<b>⚙️ Bot Settings</b>\nCurrent Welcome Message:\n${config.welcomeMessage || 'Default'}\n\nSend a new welcome message text (HTML supported), or tap Cancel Action:`,
        { reply_markup: buildCancelReplyKeyboard() }
      );
      return true;
    }

    default:
      return false;
  }
}

function safeParse(str) {
  if (!str) return null;
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}
