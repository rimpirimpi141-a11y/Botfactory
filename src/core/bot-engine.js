/**
 * Multi-Tenant Bot Execution Engine.
 *
 * Strictly isolates each tenant bot by `bot_id`, verifies active status,
 * deduplicates Telegram webhook retries, rate-limits abusive senders,
 * routes to the configured Template or Custom Builder runtime,
 * and records genuine D1 & Cloudflare Analytics Engine metrics.
 */

import { invalidateTenantCache, loadTenantRuntime } from './tenant-manager.js';
import {
  buildForceJoinGateKeyboard,
  checkUserForceJoin,
  formatDestinationLabel,
  handleForceJoinChatMemberUpdate,
  normalizeForceJoinList,
} from './force-join.js';
import { formatBrandedMessage } from '../builder/theme-engine.js';
import { getTemplateHandler } from '../templates/index.js';
import { trackAnalyticsEvent } from '../admin/analytics.js';
import { checkRateLimit, isDuplicateWebhookUpdate } from '../utils/rate-limiter.js';
import { escapeHtml } from '../utils/validation.js';
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

    // 1. Private Force Join auto-linking via Telegram my_chat_member / chat_member updates
    if (update?.my_chat_member || update?.chat_member) {
      const pendingLink = config?.templateSettings?.pendingForceJoinLink || null;
      const fjEvent = await handleForceJoinChatMemberUpdate({
        telegram,
        token,
        update,
        pendingLink,
        existingDestinations: config?.forceJoinChannels || [],
        botUsername: bot.telegram_username,
      });

      if (fjEvent.handled) {
        if (fjEvent.action === 'linked') {
          const nextTemplateSettings = { ...(config?.templateSettings || {}) };
          delete nextTemplateSettings.pendingForceJoinLink;
          await repos.botConfigs.upsert(bot.id, {
            ...config,
            forceJoinChannels: fjEvent.destinations,
            templateSettings: nextTemplateSettings,
          });
          await invalidateTenantCache(env, bot.id);
          await repos.stats.recordActivity(bot.id, {
            userTelegramId: pendingLink?.requestedBy || bot.owner_telegram_id,
            eventType: 'force_join_linked',
            featureKey: fjEvent.destination.chatId,
          });
        } else if (fjEvent.action === 'demoted') {
          await repos.botConfigs.upsert(bot.id, {
            ...config,
            forceJoinChannels: fjEvent.destinations,
          });
          await invalidateTenantCache(env, bot.id);
        }

        const notifyTarget = fjEvent.notifyChatId || bot.owner_telegram_id;
        if (notifyTarget && fjEvent.message) {
          await telegram.sendMessage(token, notifyTarget, fjEvent.message).catch(() => {});
        }

        const durationMs = Date.now() - startedAt;
        await Promise.all([
          repos.bots.incrementUpdates(bot.id),
          repos.stats.recordWebhook(bot.id, {
            updateId: update?.update_id,
            statusCode: 200,
            durationMs,
          }),
        ]);
        return { ok: true, status: 200, durationMs, cacheHit, forceJoinAction: fjEvent.action };
      }
    }

    // 2. Universal Force Join verification callback across ALL tenant templates
    const fjDestinations = normalizeForceJoinList(config?.forceJoinChannels || []);
    if (update?.callback_query?.data === 'fj:verify' && endUser) {
      const cb = update.callback_query;
      const chatId = cb.message?.chat?.id;
      const messageId = cb.message?.message_id;
      await telegram.answerCallbackQuery(token, cb.id, { text: 'Checking channel membership...' }).catch(() => {});

      const check = await checkUserForceJoin({
        telegram,
        token,
        destinations: fjDestinations,
        userId: endUser.telegram_id,
      });

      if (!check.passed) {
        const missingText = check.missing.map((d) => `• <b>${escapeHtml(formatDestinationLabel(d))}</b>`).join('\n');
        const failBody = formatBrandedMessage(config, {
          heading: '📢 Membership Still Pending',
          body: `Please join all required channels/groups below and tap <b>Verify Membership</b> again:\n\n${missingText}`,
        });
        const kb = buildForceJoinGateKeyboard(check.missing, 'fj:verify');
        if (messageId && chatId) {
          await telegram
            .editMessageText(token, chatId, messageId, failBody, { reply_markup: kb })
            .catch(() => telegram.sendMessage(token, chatId, failBody, { reply_markup: kb }));
        } else if (chatId) {
          await telegram.sendMessage(token, chatId, failBody, { reply_markup: kb });
        }
        return { ok: true, status: 200, forceJoinBlocked: true };
      }

      const passBody = formatBrandedMessage(config, {
        heading: '✅ Membership Verified!',
        body: 'Thank you for joining! Send /start to open the main menu.',
      });
      if (messageId && chatId) {
        await telegram
          .editMessageText(token, chatId, messageId, passBody)
          .catch(() => telegram.sendMessage(token, chatId, passBody));
      } else if (chatId) {
        await telegram.sendMessage(token, chatId, passBody);
      }
      return { ok: true, status: 200, forceJoinVerified: true };
    }

    // 3. Centralized per-tenant Force Join gate for all non-admin end-users
    //    (Allows refer-earn `/start ref_...` to attribute the referral first before enforcing its gate,
    //     and skips re:verify_join which refer-earn handles directly with the same engine.)
    if (fjDestinations.length > 0 && endUser && !isAdmin) {
      const incomingText = (update?.message?.text || '').trim();
      const incomingCb = update?.callback_query?.data || '';
      const isReferEarnReferralStart =
        templateKey === 'refer-earn' && incomingText.startsWith('/start ');
      const isReferEarnVerifyCb = templateKey === 'refer-earn' && incomingCb === 're:verify_join';
      const isPrivateChat =
        (update?.message?.chat?.type || update?.callback_query?.message?.chat?.type || 'private') === 'private';

      if (isPrivateChat && !isReferEarnReferralStart && !isReferEarnVerifyCb && (update?.message || update?.callback_query)) {
        const check = await checkUserForceJoin({
          telegram,
          token,
          destinations: fjDestinations,
          userId: endUser.telegram_id,
        });

        if (!check.passed) {
          const targetChatId = update?.message?.chat?.id || update?.callback_query?.message?.chat?.id;
          if (update?.callback_query) {
            await telegram
              .answerCallbackQuery(token, update.callback_query.id, {
                text: 'Please join the required channel(s) first.',
                showAlert: false,
              })
              .catch(() => {});
          }
          if (targetChatId) {
            const missingLines = check.missing
              .map((d) => `• <b>${escapeHtml(formatDestinationLabel(d))}</b>`)
              .join('\n');
            await telegram.sendMessage(
              token,
              targetChatId,
              formatBrandedMessage(config, {
                heading: '📢 Channel Membership Required',
                body: `To access <b>${escapeHtml(config.brandTitle || bot.display_name)}</b>, please join the required channel(s)/group(s) below and tap <b>✅ I Joined — Verify Membership</b>:\n\n${missingLines}`,
              }),
              { reply_markup: buildForceJoinGateKeyboard(check.missing, 'fj:verify') }
            );
          }
          const durationMs = Date.now() - startedAt;
          await Promise.all([
            repos.bots.incrementUpdates(bot.id),
            repos.stats.recordWebhook(bot.id, {
              updateId: update?.update_id,
              statusCode: 200,
              durationMs,
            }),
          ]);
          return { ok: true, status: 200, durationMs, cacheHit, forceJoinBlocked: true };
        }
      }
    }

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
