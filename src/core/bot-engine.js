/**
 * Multi-Tenant Bot Execution Engine.
 *
 * Strictly isolates each tenant bot by `bot_id`, verifies active status,
 * deduplicates Telegram webhook retries, rate-limits abusive senders,
 * routes to the configured Template or Custom Builder runtime,
 * and records genuine D1 & Cloudflare Analytics Engine metrics.
 */

import { loadTenantRuntime } from './tenant-manager.js';
import { getTemplateHandler } from '../templates/index.js';
import { trackAnalyticsEvent } from '../admin/analytics.js';
import { checkRateLimit, isDuplicateWebhookUpdate } from '../utils/rate-limiter.js';
import { writeSystemLog } from '../utils/logger.js';

export async function processTenantUpdate({ env, repos, telegram, botId, update, requestSecretVerified = false }) {
  const startedAt = Date.now();

  if (!requestSecretVerified) {
    return { ok: false, status: 401, error: 'Webhook secret verification failed.' };
  }

  // Deduplicate Telegram retry deliveries
  if (await isDuplicateWebhookUpdate(env?.KV, botId, update?.update_id)) {
    return { ok: true, status: 200, deduplicated: true };
  }

  const runtime = await loadTenantRuntime({ env, repos, botId });
  if (!runtime) {
    return { ok: false, status: 404, error: 'Tenant bot not found.' };
  }

  const { bot, config, menus, token, cacheHit } = runtime;

  if (bot.status !== 'active') {
    await repos.stats.recordWebhook(botId, {
      updateId: update?.update_id,
      statusCode: 200,
      durationMs: Date.now() - startedAt,
      errorMessage: `Ignored update because bot status is ${bot.status}`,
    });
    return { ok: true, status: 200, ignored: true, reason: `bot_${bot.status}` };
  }

  const tgUser =
    update?.message?.from ||
    update?.callback_query?.from ||
    update?.chat_member?.from ||
    update?.my_chat_member?.from ||
    null;

  if (tgUser && !tgUser.is_bot) {
    const rl = await checkRateLimit(env?.KV, `usr:${botId}:${tgUser.id}`, 45, 60);
    if (!rl.allowed) {
      return { ok: true, status: 200, rateLimited: true };
    }
  }

  try {
    let endUser = null;
    let isNewUser = false;
    let isAdmin = false;

    if (tgUser && !tgUser.is_bot) {
      const upserted = await repos.endUsers.upsert(bot.id, tgUser);
      endUser = upserted.user;
      isNewUser = upserted.isNew;

      if (endUser?.is_banned) {
        return { ok: true, status: 200, ignored: true, reason: 'user_banned' };
      }

      isAdmin = await repos.bots.isBotAdmin(bot.id, tgUser.id);
    }

    const templateKey = bot.mode === 'custom' ? 'custom-builder' : bot.template_slug || bot.template_id;
    const templateEntry = getTemplateHandler(templateKey);

    await templateEntry.handle({
      env,
      bot,
      config,
      menus,
      token,
      telegram,
      repos,
      update,
      endUser,
      isNewUser,
      isAdmin,
    });

    const durationMs = Date.now() - startedAt;
    await Promise.all([
      repos.bots.incrementUpdates(bot.id),
      repos.stats.recordWebhook(bot.id, {
        updateId: update?.update_id,
        statusCode: 200,
        durationMs,
      }),
      repos.stats.recordActivity(bot.id, {
        userTelegramId: tgUser?.id,
        eventType: update?.callback_query ? 'callback_query' : 'message',
        featureKey: templateKey,
        durationMs,
      }),
    ]);

    trackAnalyticsEvent(env, {
      eventType: 'tenant_update',
      botId: bot.id,
      templateSlug: templateKey,
      statusCode: 200,
      durationMs,
      cacheHit,
    });

    return { ok: true, status: 200, durationMs, cacheHit };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    await repos.stats
      .recordWebhook(bot.id, {
        updateId: update?.update_id,
        statusCode: 500,
        durationMs,
        errorMessage: err?.message || 'Tenant update error',
      })
      .catch(() => {});

    await writeSystemLog(env, {
      level: 'error',
      source: 'bot-engine',
      message: `Error executing update for bot ${bot.id}: ${err?.message || 'unknown'}`,
      metadata: { botId: bot.id, updateId: update?.update_id },
      actorTelegramId: tgUser?.id,
    });

    trackAnalyticsEvent(env, {
      eventType: 'tenant_error',
      botId: bot.id,
      templateSlug: bot.template_slug || 'unknown',
      statusCode: 500,
      durationMs,
      cacheHit,
    });

    // Return 200 to Telegram so Telegram does not infinitely retry poison updates
    return { ok: false, status: 200, error: err?.message || 'Internal execution error' };
  }
}
