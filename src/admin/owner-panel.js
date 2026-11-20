/**
 * Owner Super Admin Control Center (Telegram Interface).
 * Strictly gated by ADMIN_TELEGRAM_ID environment variable.
 */

import { getApplicationAnalytics } from './analytics.js';
import { getCloudflareInfrastructureMetrics } from './cloudflare-monitor.js';
import { processBroadcastBatch, queueBroadcast } from './broadcast.js';
import { ownerDeleteBot, ownerDisableBot, ownerEnableAndRetryWebhook } from './bot-management.js';
import { buildConfirmCancelKeyboard, buildInlineKeyboard, BUTTON_STYLES, inlineButton } from '../utils/keyboards.js';
import { escapeHtml, isOwnerTelegramId } from '../utils/validation.js';

export function buildOwnerDashboardKeyboard() {
  return buildInlineKeyboard([
    [
      inlineButton({ text: '👥 User Management', callbackData: 'owner:users', style: BUTTON_STYLES.PRIMARY }),
      inlineButton({ text: '🤖 All Bots', callbackData: 'owner:bots', style: BUTTON_STYLES.PRIMARY }),
    ],
    [
      inlineButton({ text: '📊 Platform Analytics', callbackData: 'owner:analytics', style: BUTTON_STYLES.PRIMARY }),
      inlineButton({ text: '☁️ Cloudflare Monitor', callbackData: 'owner:cf', style: BUTTON_STYLES.PRIMARY }),
    ],
    [
      inlineButton({ text: '📨 Global Broadcast', callbackData: 'owner:broadcast', style: BUTTON_STYLES.SUCCESS }),
      inlineButton({ text: '📜 System Logs', callbackData: 'owner:logs', style: BUTTON_STYLES.DEFAULT }),
    ],
    [
      inlineButton({ text: '⚙️ Global Settings', callbackData: 'owner:settings', style: BUTTON_STYLES.DEFAULT }),
      inlineButton({ text: '🚨 Emergency Controls', callbackData: 'owner:emergency', style: BUTTON_STYLES.DANGER }),
    ],
    [inlineButton({ text: '⬅️ Exit Owner Center', callbackData: 'mb:home', style: BUTTON_STYLES.DEFAULT })],
  ]);
}

export async function renderOwnerControlCenter({ env, repos, telegram, token, chatId }) {
  const analytics = await getApplicationAnalytics(repos);
  const ov = analytics.overview;

  const text = [
    '<pre>╔════════════════════════════╗\n👑 BOT FACTORY CONTROL CENTER\n╚════════════════════════════╝</pre>',
    '',
    `👥 <b>Registered Users:</b> ${ov.totalUsers} (Premium: ${ov.premiumUsers})`,
    `🤖 <b>Total Created Bots:</b> ${ov.totalBots}`,
    `🟢 <b>Active Verified Bots:</b> ${ov.activeBots}`,
    `⚪️ <b>Disabled Bots:</b> ${ov.disabledBots} · 🔴 <b>Failed:</b> ${ov.failedDeployments}`,
    `📨 <b>Total Webhook Updates:</b> ${ov.totalWebhookUpdates}`,
    `⚡ <b>Requests Today / Month:</b> ${ov.requestsToday} / ${ov.requestsThisMonth}`,
    `⚠️ <b>Worker Errors:</b> ${ov.workerErrors}`,
    `⏱ <b>Avg Response Time:</b> ${ov.avgResponseTimeMs !== null ? `${ov.avgResponseTimeMs} ms` : 'Data unavailable'}`,
    `💳 <b>Transactions Recorded:</b> ${ov.totalTransactions}`,
    '',
    `<i>Last updated: ${ov.lastUpdated.slice(0, 19).replace('T', ' ')} UTC</i>`,
  ].join('\n');

  await telegram.sendMessage(token, chatId, text, { reply_markup: buildOwnerDashboardKeyboard() });
}

export async function handleOwnerCallback({ env, repos, telegram, token, cb }) {
  const actorId = String(cb.from?.id || '');
  const chatId = cb.message?.chat?.id;
  const data = cb.data || '';

  if (!isOwnerTelegramId(actorId, env)) {
    await telegram.answerCallbackQuery(token, cb.id, { text: '🔒 Super Admin access required.', showAlert: true }).catch(() => {});
    return true;
  }

  await telegram.answerCallbackQuery(token, cb.id).catch(() => {});

  if (data === 'owner:home' || data === 'owner:analytics') {
    await renderOwnerControlCenter({ env, repos, telegram, token, chatId });
    return true;
  }

  if (data === 'owner:users') {
    const users = await repos.users.search({ limit: 10 });
    const lines = users
      .map((u) => `• <code>${u.telegram_id}</code> ${u.username ? `@${escapeHtml(u.username)}` : escapeHtml(u.first_name)} · <b>${u.plan}</b> · ${u.status} (${u.bot_count} bots)`)
      .join('\n');
    await telegram.sendMessage(
      token,
      chatId,
      `<b>👥 Platform Users (Latest 10)</b>\n\n${lines || 'No users registered yet.'}`,
      { reply_markup: buildOwnerDashboardKeyboard() }
    );
    return true;
  }

  if (data === 'owner:bots') {
    const bots = await repos.bots.listAll({ limit: 10 });
    if (!bots.length) {
      await telegram.sendMessage(token, chatId, 'No tenant bots deployed yet.', { reply_markup: buildOwnerDashboardKeyboard() });
      return true;
    }
    const rows = bots.map((b) => [
      inlineButton({
        text: `${b.status === 'active' ? '🟢' : '🔴'} @${b.telegram_username} (${b.template_slug || 'tpl'})`,
        callbackData: `owner:bot:${b.id}`,
        style: b.status === 'active' ? BUTTON_STYLES.SUCCESS : BUTTON_STYLES.DANGER,
      }),
    ]);
    rows.push([inlineButton({ text: '⬅️ Back', callbackData: 'owner:home', style: BUTTON_STYLES.PRIMARY })]);
    await telegram.sendMessage(token, chatId, '<b>🤖 All Deployed Tenant Bots</b>\nTap a bot to manage:', {
      reply_markup: buildInlineKeyboard(rows),
    });
    return true;
  }

  if (data.startsWith('owner:bot:')) {
    const botId = data.slice('owner:bot:'.length);
    const bot = await repos.bots.getById(botId);
    if (!bot) {
      await telegram.sendMessage(token, chatId, 'Bot not found.');
      return true;
    }
    const text = [
      `<b>🤖 Bot Inspector — @${escapeHtml(bot.telegram_username)}</b>`,
      `• <b>ID:</b> <code>${bot.id}</code>`,
      `• <b>Owner:</b> <code>${bot.owner_telegram_id}</code>`,
      `• <b>Template:</b> ${escapeHtml(bot.template_name || bot.template_id)}`,
      `• <b>Status:</b> ${bot.status.toUpperCase()} · Webhook: ${bot.webhook_status.toUpperCase()}`,
      `• <b>Users / Updates:</b> ${bot.total_users} / ${bot.total_updates}`,
      bot.webhook_last_error ? `• <b>Last Error:</b> ${escapeHtml(bot.webhook_last_error)}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    await telegram.sendMessage(token, chatId, text, {
      reply_markup: buildInlineKeyboard([
        [
          inlineButton({ text: '🔄 Retry Webhook', callbackData: `owner:bot_retry:${bot.id}`, style: BUTTON_STYLES.SUCCESS }),
          inlineButton({
            text: bot.status === 'active' ? '⏸ Disable Bot' : '▶️ Enable Bot',
            callbackData: bot.status === 'active' ? `owner:bot_disable:${bot.id}` : `owner:bot_retry:${bot.id}`,
            style: BUTTON_STYLES.PRIMARY,
          }),
        ],
        [
          inlineButton({ text: '🗑 Delete Bot', callbackData: `owner:bot_del_ask:${bot.id}`, style: BUTTON_STYLES.DANGER }),
          inlineButton({ text: '⬅️ Back', callbackData: 'owner:bots', style: BUTTON_STYLES.DEFAULT }),
        ],
      ]),
    });
    return true;
  }

  if (data.startsWith('owner:bot_disable:')) {
    const botId = data.slice('owner:bot_disable:'.length);
    await ownerDisableBot({ env, repos, telegram, botId, actorTelegramId: actorId });
    await telegram.sendMessage(token, chatId, `⏸ Bot <code>${botId}</code> disabled and webhook removed.`);
    return true;
  }

  if (data.startsWith('owner:bot_retry:')) {
    const botId = data.slice('owner:bot_retry:'.length);
    try {
      const res = await ownerEnableAndRetryWebhook({ env, repos, telegram, botId, actorTelegramId: actorId });
      await telegram.sendMessage(token, chatId, `✅ Bot <code>${botId}</code> re-enabled and webhook verified:\n<code>${escapeHtml(res.verification.webhookUrl)}</code>`);
    } catch (err) {
      await telegram.sendMessage(token, chatId, `❌ Webhook verification failed: ${escapeHtml(err.message)}`);
    }
    return true;
  }

  if (data.startsWith('owner:bot_del_ask:')) {
    const botId = data.slice('owner:bot_del_ask:'.length);
    await telegram.sendMessage(
      token,
      chatId,
      `⚠️ Confirm permanent deletion of bot <code>${botId}</code>? This removes its webhook and marks it deleted.`,
      { reply_markup: buildConfirmCancelKeyboard(`owner:bot_del_ok:${botId}`, `owner:bot:${botId}`, '🗑 Confirm Delete', 'Cancel') }
    );
    return true;
  }

  if (data.startsWith('owner:bot_del_ok:')) {
    const botId = data.slice('owner:bot_del_ok:'.length);
    await ownerDeleteBot({ env, repos, telegram, botId, actorTelegramId: actorId });
    await telegram.sendMessage(token, chatId, `🗑 Bot <code>${botId}</code> deleted.`);
    return true;
  }

  if (data === 'owner:cf') {
    const cf = await getCloudflareInfrastructureMetrics(env, repos);
    const w = cf.workers.data;
    const d1 = cf.d1.data;
    const kv = cf.kv.data;
    const text = [
      '<b>☁️ Cloudflare Infrastructure Monitor</b>',
      `<i>Last updated: ${cf.lastUpdated.slice(0, 19).replace('T', ' ')} UTC</i>`,
      '',
      '<b>Workers:</b>',
      w
        ? `• Daily / Monthly: ${w.dailyRequests} / ${w.monthlyRequests}\n• Errors: ${w.errors} · Success: ${w.successPercentage ?? 'N/A'}%`
        : `• Data unavailable (${escapeHtml(cf.workers.error || cf.message || 'Not configured')})`,
      '',
      '<b>D1 Database:</b>',
      d1
        ? `• Queries: ${d1.totalQueries} (Read: ${d1.readQueries}, Write: ${d1.writeQueries})\n• Rows Read / Written: ${d1.rowsRead} / ${d1.rowsWritten}`
        : `• Data unavailable (${escapeHtml(cf.d1.error || 'Not configured')})`,
      '',
      '<b>KV Storage:</b>',
      kv
        ? `• Reads / Writes: ${kv.reads} / ${kv.writes}\n• Keys: ${kv.keyCount ?? 'N/A'}`
        : `• Data unavailable (${escapeHtml(cf.kv.error || 'Not configured')})`,
    ].join('\n');
    await telegram.sendMessage(token, chatId, text, { reply_markup: buildOwnerDashboardKeyboard() });
    return true;
  }

  if (data === 'owner:broadcast') {
    await repos.users.setWizardState(actorId, { flow: 'owner_broadcast', step: 'await_message' });
    await telegram.sendMessage(
      token,
      chatId,
      '📨 <b>Global Broadcast Composer</b>\n\nSend the broadcast text message to preview before dispatching to eligible users across all active BOT FACTORY bots.\nSend /cancel to abort.'
    );
    return true;
  }

  if (data.startsWith('owner:brc_launch:')) {
    const brcId = data.slice('owner:brc_launch:'.length);
    const queued = await queueBroadcast({ env, repos, broadcastId: brcId, actorTelegramId: actorId });
    const firstBatch = await processBroadcastBatch({ env, repos, telegram, broadcastId: brcId });
    await telegram.sendMessage(
      token,
      chatId,
      `🚀 <b>Broadcast Dispatched</b>\nID: <code>${brcId}</code>\nTotal Eligible Recipients: <b>${queued.total_recipients}</b>\nBatch 1 Delivered: <b>${firstBatch.delivered || 0}</b> · Blocked: <b>${firstBatch.blocked || 0}</b> · Failed: <b>${firstBatch.failed || 0}</b>\nRemaining (Cron Resumable): <b>${firstBatch.remaining || 0}</b>`,
      { reply_markup: buildOwnerDashboardKeyboard() }
    );
    return true;
  }

  if (data === 'owner:logs') {
    const logs = await repos.stats.getRecentLogs({ limit: 10 });
    const lines = logs
      .map((l) => `• <b>[${l.level.toUpperCase()}]</b> ${escapeHtml(l.source)}: ${escapeHtml(l.message)}`)
      .join('\n');
    await telegram.sendMessage(token, chatId, `<b>📜 Recent System Logs (Redacted)</b>\n\n${lines || 'No logs yet.'}`, {
      reply_markup: buildOwnerDashboardKeyboard(),
    });
    return true;
  }

  if (data === 'owner:settings' || data === 'owner:emergency') {
    const settings = await repos.stats.getSettings();
    const maint = settings.map.maintenance_mode === 'true';
    const killBrc = settings.map.emergency_pause_broadcasts === 'true';
    const promo = settings.map.promo_footer_enabled !== 'false';
    await telegram.sendMessage(
      token,
      chatId,
      `<b>⚙️ Global Settings & Emergency Controls</b>\n• Maintenance Mode: <b>${maint ? 'ON' : 'OFF'}</b>\n• Broadcast Kill-Switch: <b>${killBrc ? 'PAUSED' : 'ACTIVE'}</b>\n• Promo Footer: <b>${promo ? 'ENABLED' : 'DISABLED'}</b>`,
      {
        reply_markup: buildInlineKeyboard([
          [
            inlineButton({
              text: maint ? '🟢 Disable Maintenance' : '🔴 Enable Maintenance',
              callbackData: 'owner:toggle:maintenance_mode',
              style: maint ? BUTTON_STYLES.SUCCESS : BUTTON_STYLES.DANGER,
            }),
          ],
          [
            inlineButton({
              text: killBrc ? '🟢 Resume Broadcasts' : '🚨 Pause All Broadcasts',
              callbackData: 'owner:toggle:emergency_pause_broadcasts',
              style: killBrc ? BUTTON_STYLES.SUCCESS : BUTTON_STYLES.DANGER,
            }),
          ],
          [
            inlineButton({
              text: promo ? 'Disable Promo Footer' : 'Enable Promo Footer',
              callbackData: 'owner:toggle:promo_footer_enabled',
              style: BUTTON_STYLES.PRIMARY,
            }),
          ],
          [inlineButton({ text: '⬅️ Back', callbackData: 'owner:home', style: BUTTON_STYLES.DEFAULT })],
        ]),
      }
    );
    return true;
  }

  if (data.startsWith('owner:toggle:')) {
    const key = data.slice('owner:toggle:'.length);
    const settings = await repos.stats.getSettings();
    const current = settings.map[key] === 'true';
    await repos.stats.setSetting(key, current ? 'false' : 'true', actorId);
    await telegram.sendMessage(token, chatId, `✅ Setting <code>${escapeHtml(key)}</code> updated to <b>${!current}</b>.`, {
      reply_markup: buildOwnerDashboardKeyboard(),
    });
    return true;
  }

  return false;
}
