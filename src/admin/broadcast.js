/**
 * Global & Targeted Broadcast Engine for BOT FACTORY.
 *
 * Capabilities:
 * - Global broadcast across all active tenant bots, single bot, bot groups, or selected users
 * - Text & image broadcasts with colourful inline CTA buttons
 * - Configurable BOT FACTORY promotional footer using REAL env.MASTER_BOT_USERNAME
 *   (https://t.me/<MASTER_BOT_USERNAME>?start=create) — NEVER hardcodes a fake username
 * - Deduplicated eligible recipient queue (only users who initiated the bot and are not blocked/banned)
 * - Resumable rate-limited batches, pause/resume/cancel, 403 blocked-user marking, and audit logs
 */

import { decryptBotToken } from '../core/token-security.js';
import { buildInlineKeyboard, BUTTON_STYLES, inlineButton } from '../utils/keyboards.js';
import { newId } from '../database/repositories.js';
import { writeSystemLog } from '../utils/logger.js';
import { escapeHtml, validateSafeUrl } from '../utils/validation.js';

export function buildMasterBotDeepLink(env, startParam = 'create') {
  const username = String(env?.MASTER_BOT_USERNAME || '').trim().replace(/^@/, '');
  if (!username || username.includes('REPLACE_WITH')) {
    return null;
  }
  return `https://t.me/${username}?start=${encodeURIComponent(startParam)}`;
}

export function composeBroadcastPayload({ broadcast, env, settingsMap = {} }) {
  let finalText = String(broadcast.message_text || '').trim();
  const rows = [];

  // Custom inline CTA buttons
  for (const btn of broadcast.inline_buttons || []) {
    if (!btn?.text || !btn?.url) continue;
    const urlCheck = validateSafeUrl(btn.url);
    if (!urlCheck.valid) continue;
    rows.push([
      inlineButton({
        text: btn.text,
        url: urlCheck.url,
        style: btn.style || BUTTON_STYLES.PRIMARY,
      }),
    ]);
  }

  // Optional owner-configurable promotional footer + real Master Bot deep link
  const globalPromoEnabled = settingsMap.promo_footer_enabled !== 'false';
  if (broadcast.include_promo_footer && globalPromoEnabled) {
    const footerText =
      settingsMap.promo_footer_text || '🤖 Create your own Telegram bot easily with BOT FACTORY.';
    const promoBtnText = settingsMap.promo_button_text || '🚀 Create Your Bot';
    const deepLink = buildMasterBotDeepLink(env, 'create');

    finalText = `${finalText}\n\n━━━━━━━━━━━━━━━━━━━━\n<i>${escapeHtml(footerText)}</i>`;
    if (deepLink) {
      rows.push([
        inlineButton({
          text: promoBtnText,
          url: deepLink,
          style: BUTTON_STYLES.SUCCESS,
        }),
      ]);
    }
  }

  return {
    text: finalText,
    imageUrl: broadcast.image_url || null,
    replyMarkup: rows.length > 0 ? buildInlineKeyboard(rows) : undefined,
  };
}

/**
 * Prepares and queues a broadcast by snapshotting eligible, non-blocked recipients
 * into `broadcast_recipients` (with UNIQUE deduplication).
 */
export async function queueBroadcast({ env, repos, broadcastId, actorTelegramId }) {
  const broadcast = await repos.broadcasts.getById(broadcastId);
  if (!broadcast) throw new Error('Broadcast not found.');
  if (['running', 'completed'].includes(broadcast.status)) {
    throw new Error(`Broadcast is already ${broadcast.status}.`);
  }

  const settings = await repos.stats.getSettings();
  if (settings.map.emergency_pause_broadcasts === 'true') {
    throw new Error('Emergency broadcast kill-switch is active. Disable it in Global Settings before launching.');
  }

  // Build eligible recipient query strictly scoped to users who started active bots
  let recipientRows = [];
  if (broadcast.scope === 'global') {
    const { rows } = await repos.db.all(
      `SELECT eu.bot_id, eu.telegram_id
       FROM bot_end_users eu
       JOIN bots b ON b.id = eu.bot_id
       WHERE b.status = 'active' AND b.webhook_status = 'verified'
         AND eu.is_blocked = 0 AND eu.is_banned = 0`
    );
    recipientRows = rows;
  } else if (broadcast.scope === 'single_bot' || broadcast.scope === 'bot_group') {
    const botIds = (broadcast.target_bot_ids || []).filter(Boolean);
    if (!botIds.length) throw new Error('At least one target bot ID is required.');
    const placeholders = botIds.map(() => '?').join(',');
    const { rows } = await repos.db.all(
      `SELECT eu.bot_id, eu.telegram_id
       FROM bot_end_users eu
       JOIN bots b ON b.id = eu.bot_id
       WHERE eu.bot_id IN (${placeholders}) AND b.status = 'active'
         AND eu.is_blocked = 0 AND eu.is_banned = 0`,
      botIds
    );
    recipientRows = rows;
  } else if (broadcast.scope === 'selected_users') {
    const userIds = (broadcast.target_user_ids || []).map(String).filter(Boolean);
    if (!userIds.length) throw new Error('At least one target user Telegram ID is required.');
    const placeholders = userIds.map(() => '?').join(',');
    const { rows } = await repos.db.all(
      `SELECT eu.bot_id, eu.telegram_id
       FROM bot_end_users eu
       JOIN bots b ON b.id = eu.bot_id
       WHERE eu.telegram_id IN (${placeholders}) AND b.status = 'active'
         AND eu.is_blocked = 0 AND eu.is_banned = 0`,
      userIds
    );
    recipientRows = rows;
  }

  // Deduplicate (bot_id, telegram_id) before batch insert
  const seen = new Set();
  const insertStmts = [];
  for (const r of recipientRows) {
    const key = `${r.bot_id}:${r.telegram_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    insertStmts.push({
      sql: `INSERT OR IGNORE INTO broadcast_recipients (id, broadcast_id, bot_id, user_telegram_id, status)
            VALUES (?, ?, ?, ?, 'pending')`,
      params: [newId('brcr'), broadcastId, r.bot_id, String(r.telegram_id)],
    });
  }

  // Insert in chunks of 50 statements for D1 batch limits
  for (let i = 0; i < insertStmts.length; i += 50) {
    await repos.db.batch(insertStmts.slice(i, i + 50));
  }

  const totalRecipients = seen.size;
  const now = new Date().toISOString();
  const nextStatus = totalRecipients === 0 ? 'completed' : 'running';

  await repos.db.run(
    `UPDATE broadcasts
     SET status = ?, total_recipients = ?, started_at = ?, completed_at = CASE WHEN ? = 'completed' THEN ? ELSE NULL END, updated_at = ?
     WHERE id = ?`,
    [nextStatus, totalRecipients, now, nextStatus, now, now, broadcastId]
  );

  await writeSystemLog(env, {
    level: 'audit',
    source: 'broadcast',
    message: `Queued broadcast ${broadcastId} (${broadcast.scope}) for ${totalRecipients} eligible recipients`,
    metadata: { broadcastId, scope: broadcast.scope, totalRecipients },
    actorTelegramId,
  });

  return repos.broadcasts.getById(broadcastId);
}

/**
 * Processes a resumable, rate-limited batch of pending recipients for active broadcasts.
 * Invoked immediately upon launch and resumed cleanly by Cloudflare Workers Cron Trigger.
 */
export async function processBroadcastBatch({ env, repos, telegram, broadcastId = null, batchSize = 25, delayMs = 45 }) {
  const settings = await repos.stats.getSettings();
  if (settings.map.emergency_pause_broadcasts === 'true') {
    return { processed: 0, skippedReason: 'emergency_pause_active' };
  }

  const effectiveBatch = Math.max(1, Math.min(50, Number(settings.map.broadcast_batch_size || batchSize)));
  const effectiveDelay = Math.max(0, Math.min(500, Number(settings.map.broadcast_delay_ms ?? delayMs)));

  const targetBroadcast = broadcastId
    ? await repos.broadcasts.getById(broadcastId)
    : (
        await repos.db.first(
          `SELECT id FROM broadcasts WHERE status = 'running' ORDER BY created_at ASC LIMIT 1`
        )
      ).row?.id
      ? await repos.broadcasts.getById(
          (
            await repos.db.first(
              `SELECT id FROM broadcasts WHERE status = 'running' ORDER BY created_at ASC LIMIT 1`
            )
          ).row.id
        )
      : null;

  if (!targetBroadcast || targetBroadcast.status !== 'running') {
    return { processed: 0, status: targetBroadcast?.status || 'idle' };
  }

  const { rows: pending } = await repos.db.all(
    `SELECT br.*, b.token_encrypted, b.status AS bot_status
     FROM broadcast_recipients br
     JOIN bots b ON b.id = br.bot_id
     WHERE br.broadcast_id = ? AND br.status = 'pending'
     LIMIT ?`,
    [targetBroadcast.id, effectiveBatch]
  );

  if (pending.length === 0) {
    await repos.db.run(
      `UPDATE broadcasts SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?`,
      [new Date().toISOString(), new Date().toISOString(), targetBroadcast.id]
    );
    return { processed: 0, broadcastId: targetBroadcast.id, status: 'completed' };
  }

  const payload = composeBroadcastPayload({
    broadcast: targetBroadcast,
    env,
    settingsMap: settings.map,
  });

  const tokenCache = new Map();
  let delivered = 0;
  let failed = 0;
  let blocked = 0;

  for (const recipient of pending) {
    if (recipient.bot_status !== 'active') {
      await repos.db.run(
        `UPDATE broadcast_recipients SET status = 'skipped', error_message = 'Bot inactive' WHERE id = ?`,
        [recipient.id]
      );
      continue;
    }

    let token = tokenCache.get(recipient.bot_id);
    if (!token) {
      try {
        token = await decryptBotToken(recipient.token_encrypted, env.TOKEN_ENCRYPTION_KEY);
        tokenCache.set(recipient.bot_id, token);
      } catch {
        await repos.db.run(
          `UPDATE broadcast_recipients SET status = 'failed', error_message = 'Token decrypt failed' WHERE id = ?`,
          [recipient.id]
        );
        failed += 1;
        continue;
      }
    }

    try {
      if (payload.imageUrl) {
        await telegram.sendPhoto(token, recipient.user_telegram_id, payload.imageUrl, {
          caption: payload.text.slice(0, 1020),
          reply_markup: payload.replyMarkup,
        });
      } else {
        await telegram.sendMessage(token, recipient.user_telegram_id, payload.text, {
          reply_markup: payload.replyMarkup,
        });
      }

      await repos.db.run(
        `UPDATE broadcast_recipients SET status = 'sent', sent_at = ? WHERE id = ?`,
        [new Date().toISOString(), recipient.id]
      );
      delivered += 1;
    } catch (err) {
      if (err?.isBlocked) {
        await repos.endUsers.markBlocked(recipient.bot_id, recipient.user_telegram_id);
        await repos.db.run(
          `UPDATE broadcast_recipients SET status = 'blocked', error_message = ? WHERE id = ?`,
          [err.message.slice(0, 200), recipient.id]
        );
        blocked += 1;
      } else {
        await repos.db.run(
          `UPDATE broadcast_recipients SET status = 'failed', error_message = ? WHERE id = ?`,
          [(err?.message || 'Send failed').slice(0, 200), recipient.id]
        );
        failed += 1;
      }
    }

    if (effectiveDelay > 0) {
      await new Promise((r) => setTimeout(r, effectiveDelay));
    }
  }

  const { row: remaining } = await repos.db.first(
    `SELECT COUNT(*) AS count FROM broadcast_recipients WHERE broadcast_id = ? AND status = 'pending'`,
    [targetBroadcast.id]
  );

  const isDone = Number(remaining?.count || 0) === 0;
  const now = new Date().toISOString();
  await repos.db.run(
    `UPDATE broadcasts
     SET delivered_count = delivered_count + ?,
         failed_count = failed_count + ?,
         blocked_count = blocked_count + ?,
         status = CASE WHEN ? = 1 THEN 'completed' ELSE status END,
         completed_at = CASE WHEN ? = 1 THEN ? ELSE completed_at END,
         updated_at = ?
     WHERE id = ?`,
    [delivered, failed, blocked, isDone ? 1 : 0, isDone ? 1 : 0, now, now, targetBroadcast.id]
  );

  return {
    broadcastId: targetBroadcast.id,
    processed: pending.length,
    delivered,
    failed,
    blocked,
    remaining: Number(remaining?.count || 0),
    status: isDone ? 'completed' : 'running',
  };
}

export async function updateBroadcastStatus({ env, repos, broadcastId, status, actorTelegramId }) {
  if (!['paused', 'running', 'cancelled'].includes(status)) {
    throw new Error('Invalid broadcast status transition.');
  }
  await repos.db.run(
    `UPDATE broadcasts SET status = ?, updated_at = ? WHERE id = ?`,
    [status, new Date().toISOString(), broadcastId]
  );
  await writeSystemLog(env, {
    level: 'audit',
    source: 'broadcast',
    message: `Broadcast ${broadcastId} set to ${status}`,
    metadata: { broadcastId, status },
    actorTelegramId,
  });
  return repos.broadcasts.getById(broadcastId);
}
