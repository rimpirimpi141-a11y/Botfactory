/**
 * Central Multi-Tenant Cloudflare Worker Router.
 *
 * Routes:
 * - POST /webhook/master              -> BOT FACTORY Master Bot (secret-header verified)
 * - POST /webhook/:botId              -> Isolated Tenant Bot Engine (per-bot secret verified)
 * - GET  /api/health                  -> Non-sensitive infrastructure readiness check
 * - /api/*                            -> Owner Admin REST API (Bearer ADMIN_API_KEY verified)
 */

import { createDbClient } from '../database/db.js';
import { verifyDatabaseSchema } from '../database/migrations.js';
import { createRepositories } from '../database/repositories.js';
import { createTelegramClient } from './telegram-api.js';
import { processTenantUpdate } from './bot-engine.js';
import { handleMasterBotUpdate } from './master-bot.js';
import {
  deployTenantBot,
  invalidateTenantCache,
  validateTokenForDeployment,
} from './tenant-manager.js';
import { resolveAndVerifyForceJoinDestination } from './force-join.js';
import {
  buildMasterWebhookUrl,
  inspectWebhookStatus,
  MASTER_BOT_ALLOWED_UPDATES,
  registerAndVerifyWebhook,
  verifyWebhookSecretHeader,
} from './webhook-manager.js';
import { timingSafeEqual } from './token-security.js';
import { validateMenuTree } from '../builder/menu-builder.js';
import { listThemePresets } from '../builder/theme-engine.js';
import { getApplicationAnalytics } from '../admin/analytics.js';
import { getCloudflareInfrastructureMetrics } from '../admin/cloudflare-monitor.js';
import {
  buildMasterBotDeepLink,
  composeBroadcastPayload,
  processBroadcastBatch,
  queueBroadcast,
  updateBroadcastStatus,
} from '../admin/broadcast.js';
import {
  inspectBotDetail,
  listAllBots,
  ownerDeleteBot,
  ownerDisableBot,
  ownerEnableAndRetryWebhook,
} from '../admin/bot-management.js';
import { changeUserPlan, getUserProfileDetail, listUsers, setUserSuspension } from '../admin/user-management.js';
import { validateBotId } from '../utils/validation.js';
import { redactString, writeSystemLog } from '../utils/logger.js';

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env?.CORS_ALLOWED_ORIGINS || '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Telegram-Bot-Api-Secret-Token',
  };
}

function jsonResponse(data, status = 200, env = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(env),
    },
  });
}

function sanitizeBotForApi(bot) {
  if (!bot) return null;
  const safe = { ...bot };
  delete safe.token_encrypted;
  delete safe.token_hash;
  delete safe.webhook_secret;
  return safe;
}

function resolveWorkerPublicUrl(env, requestUrl) {
  const configured = String(env?.WORKER_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (configured && /^https:\/\/.+/i.test(configured) && !configured.includes('YOUR-SUBDOMAIN')) {
    return configured;
  }
  return requestUrl.origin.replace(/\/+$/, '');
}

function parseJsonSetting(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function verifyOwnerApiAuth(request, env) {
  const configuredKey = env?.ADMIN_API_KEY;
  if (!configuredKey) return { authorized: false, reason: 'ADMIN_API_KEY secret is not configured on this Worker.' };
  const authHeader = request.headers.get('Authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return { authorized: false, reason: 'Missing Authorization: Bearer <ADMIN_API_KEY> header.' };
  if (!timingSafeEqual(match[1].trim(), configuredKey.trim())) {
    return { authorized: false, reason: 'Invalid Admin API credentials.' };
  }
  return { authorized: true };
}

export async function routeRequest(request, env, ctx, { fetchImpl = globalThis.fetch, telegramTimeoutMs } = {}) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method.toUpperCase();

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(env) });
  }

  const telegram = createTelegramClient(
    fetchImpl,
    telegramTimeoutMs ? { timeoutMs: telegramTimeoutMs } : undefined
  );
  const workerPublicUrl = resolveWorkerPublicUrl(env, url);
  const expectedMasterWebhookUrl = /^https:\/\/.+/i.test(workerPublicUrl)
    ? buildMasterWebhookUrl(workerPublicUrl)
    : `${workerPublicUrl}/webhook/master`;

  // Public Health Endpoint (zero secrets leaked)
  if (method === 'GET' && (path === '/' || path === '/api/health')) {
    let dbHealth = { healthy: false, error: 'DB binding missing' };
    if (env?.DB) {
      try {
        const db = createDbClient(env.DB);
        dbHealth = await verifyDatabaseSchema(db);
      } catch (err) {
        dbHealth = { healthy: false, error: err?.message || 'D1 unreachable' };
      }
    }

    return jsonResponse(
      {
        service: 'BOT FACTORY',
        tagline: 'Build. Customize. Deploy.',
        status: dbHealth.healthy ? 'operational' : 'setup_required',
        timestamp: new Date().toISOString(),
        workerPublicUrl,
        expectedMasterWebhookUrl,
        bindings: {
          d1: dbHealth,
          kv: Boolean(env?.KV),
          analyticsEngine: Boolean(env?.ANALYTICS),
          masterBotConfigured: Boolean(env?.MASTER_BOT_TOKEN),
          masterWebhookSecretConfigured: Boolean(env?.MASTER_WEBHOOK_SECRET),
          encryptionKeyConfigured: Boolean(env?.TOKEN_ENCRYPTION_KEY),
          ownerIdConfigured: Boolean(env?.ADMIN_TELEGRAM_ID && !String(env.ADMIN_TELEGRAM_ID).includes('REPLACE_WITH')),
          adminApiKeyConfigured: Boolean(env?.ADMIN_API_KEY),
          cloudflareMetricsConfigured: Boolean(env?.CLOUDFLARE_ACCOUNT_ID && env?.CLOUDFLARE_API_TOKEN),
        },
        masterBotDeepLink: buildMasterBotDeepLink(env, 'create'),
      },
      200,
      env
    );
  }

  if (!env?.DB) {
    return jsonResponse(
      { ok: false, error: 'Cloudflare D1 binding (DB) is not configured. Run wrangler d1 create and update wrangler.jsonc.' },
      503,
      env
    );
  }

  const db = createDbClient(env.DB);
  const repos = createRepositories(db, env);

  // =========================================================================
  // 1. MASTER BOT WEBHOOK: POST /webhook/master
  // =========================================================================
  if (method === 'POST' && path === '/webhook/master') {
    if (!verifyWebhookSecretHeader(request, env?.MASTER_WEBHOOK_SECRET)) {
      await writeSystemLog(env, {
        level: 'security',
        source: 'router',
        message: 'Rejected /webhook/master request due to invalid X-Telegram-Bot-Api-Secret-Token',
      });
      return jsonResponse({ ok: false, error: 'Unauthorized webhook signature' }, 401, env);
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return jsonResponse({ ok: false, error: 'Invalid JSON payload' }, 400, env);
    }

    try {
      const result = await handleMasterBotUpdate({
        env: { ...env, WORKER_PUBLIC_URL: workerPublicUrl },
        repos,
        telegram,
        update,
      });
      return jsonResponse({ ok: true, result }, 200, env);
    } catch (err) {
      await writeSystemLog(env, {
        level: 'error',
        source: 'master-bot',
        message: err?.message || 'Master bot update failure',
      });
      return jsonResponse({ ok: false, error: 'Handled internal error' }, 200, env);
    }
  }

  // =========================================================================
  // 2. MULTI-TENANT BOT WEBHOOK: POST /webhook/:botId
  // =========================================================================
  const tenantMatch = path.match(/^\/webhook\/([^/]+)$/);
  if (method === 'POST' && tenantMatch) {
    const botId = tenantMatch[1];
    if (!validateBotId(botId)) {
      return jsonResponse({ ok: false, error: 'Invalid bot ID format' }, 400, env);
    }

    const bot = await repos.bots.getById(botId);
    if (!bot) {
      return jsonResponse({ ok: false, error: 'Unknown tenant bot' }, 404, env);
    }

    const secretOk = verifyWebhookSecretHeader(request, bot.webhook_secret);
    if (!secretOk) {
      await writeSystemLog(env, {
        level: 'security',
        source: 'router',
        message: `Rejected /webhook/${botId} due to invalid X-Telegram-Bot-Api-Secret-Token`,
        metadata: { botId },
      });
      return jsonResponse({ ok: false, error: 'Unauthorized webhook signature' }, 401, env);
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return jsonResponse({ ok: false, error: 'Invalid JSON payload' }, 400, env);
    }

    const res = await processTenantUpdate({
      env,
      repos,
      telegram,
      botId,
      update,
      requestSecretVerified: true,
    });
    return jsonResponse(res, res.status || 200, env);
  }

  // =========================================================================
  // 3. OWNER CONTROL PLANE REST API (/api/*)
  // =========================================================================
  if (path.startsWith('/api/')) {
    const auth = verifyOwnerApiAuth(request, env);
    if (!auth.authorized) {
      return jsonResponse({ ok: false, error: auth.reason }, 401, env);
    }

    const ownerId = String(env.ADMIN_TELEGRAM_ID || 'owner_api');

    try {
      // Master Bot Webhook Status (non-secret configuration & persisted last registration metadata)
      if (method === 'GET' && path === '/api/master/webhook-status') {
        const settings = await repos.stats.getSettings();
        const sMap = settings.map || {};
        const configuredUsername =
          sMap.master_bot_username ||
          (env.MASTER_BOT_USERNAME && !String(env.MASTER_BOT_USERNAME).includes('REPLACE_WITH')
            ? String(env.MASTER_BOT_USERNAME).replace(/^@/, '')
            : null);

        const basePayload = {
          ok: true,
          configuration: {
            masterBotTokenConfigured: Boolean(env.MASTER_BOT_TOKEN),
            masterWebhookSecretConfigured: Boolean(env.MASTER_WEBHOOK_SECRET),
            readyForRegistration: Boolean(env.MASTER_BOT_TOKEN && env.MASTER_WEBHOOK_SECRET),
            masterBotUsername: configuredUsername,
            workerPublicUrl,
            expectedWebhookUrl: expectedMasterWebhookUrl,
            allowedUpdates: MASTER_BOT_ALLOWED_UPDATES,
          },
          webhook: {
            status: sMap.master_webhook_last_status || 'not_registered',
            verified: sMap.master_webhook_last_status === 'verified',
            lastRegisteredAt: sMap.master_webhook_last_registered_at || null,
            lastVerifiedAt: sMap.master_webhook_last_verified_at || null,
            lastError: sMap.master_webhook_last_error || null,
            telegramResponse: parseJsonSetting(sMap.master_webhook_last_response),
          },
        };

        if (url.searchParams.get('live') === 'true' && env.MASTER_BOT_TOKEN) {
          const webhookUrl = buildMasterWebhookUrl(workerPublicUrl);
          const me = await telegram.getMe(env.MASTER_BOT_TOKEN);
          const inspection = await inspectWebhookStatus({
            telegram,
            token: env.MASTER_BOT_TOKEN,
            expectedUrl: webhookUrl,
          });
          const now = inspection.checkedAt;
          const mismatchErr =
            inspection.status === 'mismatch'
              ? `Webhook URL mismatch: Telegram reported "${inspection.actualUrl}" instead of "${webhookUrl}".`
              : inspection.lastErrorMessage || '';

          await Promise.all([
            repos.stats.setSetting('master_bot_username', me.result.username || '', ownerId),
            repos.stats.setSetting('master_webhook_last_verified_at', now, ownerId),
            repos.stats.setSetting('master_webhook_last_status', inspection.status, ownerId),
            repos.stats.setSetting('master_webhook_last_error', mismatchErr, ownerId),
            repos.stats.setSetting('master_webhook_last_response', JSON.stringify(inspection.telegramResponse), ownerId),
          ]);

          basePayload.configuration.masterBotUsername = me.result.username || basePayload.configuration.masterBotUsername;
          basePayload.webhook = {
            ...basePayload.webhook,
            status: inspection.status,
            verified: inspection.verified,
            lastVerifiedAt: now,
            lastError: mismatchErr || null,
            telegramResponse: inspection.telegramResponse,
            inspection,
          };
        }

        return jsonResponse(basePayload, 200, env);
      }

      // Master Bot Webhook — Manual One-Time Registration Only (Owner triggered)
      if (method === 'POST' && path === '/api/master/register-webhook') {
        if (!env.MASTER_BOT_TOKEN || !env.MASTER_WEBHOOK_SECRET) {
          return jsonResponse(
            {
              ok: false,
              status: 'configuration_missing',
              error: 'MASTER_BOT_TOKEN and MASTER_WEBHOOK_SECRET must be set via Cloudflare Worker secrets.',
            },
            400,
            env
          );
        }

        const webhookUrl = buildMasterWebhookUrl(workerPublicUrl);
        try {
          const me = await telegram.getMe(env.MASTER_BOT_TOKEN);
          const verification = await registerAndVerifyWebhook({
            telegram,
            token: env.MASTER_BOT_TOKEN,
            webhookUrl,
            secretToken: env.MASTER_WEBHOOK_SECRET,
            allowedUpdates: MASTER_BOT_ALLOWED_UPDATES,
          });

          const registeredAt = verification.verifiedAt;
          await Promise.all([
            repos.stats.setSetting('master_bot_username', me.result.username || '', ownerId),
            repos.stats.setSetting('master_webhook_last_registered_at', registeredAt, ownerId),
            repos.stats.setSetting('master_webhook_last_verified_at', registeredAt, ownerId),
            repos.stats.setSetting('master_webhook_last_status', 'verified', ownerId),
            repos.stats.setSetting('master_webhook_last_error', verification.lastErrorMessage || '', ownerId),
            repos.stats.setSetting('master_webhook_last_response', JSON.stringify(verification.telegramResponse), ownerId),
          ]);

          await writeSystemLog(env, {
            level: 'audit',
            source: 'master-webhook',
            message: `Manually registered and verified Master Bot @${me.result.username} webhook`,
            metadata: { webhookUrl, allowedUpdates: MASTER_BOT_ALLOWED_UPDATES },
            actorTelegramId: ownerId,
          });

          return jsonResponse(
            {
              ok: true,
              status: 'verified',
              verified: true,
              workerPublicUrl,
              expectedWebhookUrl: webhookUrl,
              lastRegisteredAt: registeredAt,
              lastVerifiedAt: registeredAt,
              bot: {
                id: me.result.id,
                username: me.result.username,
                first_name: me.result.first_name,
              },
              verification,
            },
            200,
            env
          );
        } catch (regErr) {
          const safeError = redactString(regErr?.message || 'Master Bot webhook registration failed');
          await Promise.all([
            repos.stats.setSetting('master_webhook_last_status', 'failed', ownerId),
            repos.stats.setSetting('master_webhook_last_error', safeError, ownerId),
          ]).catch(() => {});

          await writeSystemLog(env, {
            level: 'error',
            source: 'master-webhook',
            message: `Master Bot webhook registration failed: ${safeError}`,
            metadata: { expectedWebhookUrl: webhookUrl, method: regErr?.method || null },
            actorTelegramId: ownerId,
          });

          const httpStatus =
            regErr?.status === 504 ? 504 : regErr?.status >= 400 && regErr?.status < 600 ? regErr.status : 502;
          return jsonResponse(
            {
              ok: false,
              status: 'failed',
              verified: false,
              workerPublicUrl,
              expectedWebhookUrl: webhookUrl,
              error: safeError,
              errorCode: regErr?.errorCode || null,
              telegramMethod: regErr?.method || null,
            },
            httpStatus,
            env
          );
        }
      }

      // Master Bot Webhook — Manual Verification via Telegram getWebhookInfo
      if (method === 'POST' && path === '/api/master/verify-webhook') {
        if (!env.MASTER_BOT_TOKEN) {
          return jsonResponse(
            {
              ok: false,
              status: 'configuration_missing',
              error: 'MASTER_BOT_TOKEN must be configured via Cloudflare Worker secrets before verifying.',
            },
            400,
            env
          );
        }

        const webhookUrl = buildMasterWebhookUrl(workerPublicUrl);
        try {
          const settings = await repos.stats.getSettings();
          const me = await telegram.getMe(env.MASTER_BOT_TOKEN);
          const inspection = await inspectWebhookStatus({
            telegram,
            token: env.MASTER_BOT_TOKEN,
            expectedUrl: webhookUrl,
          });

          const verifiedAt = inspection.checkedAt;
          const readableError =
            inspection.status === 'mismatch'
              ? `Webhook URL mismatch: Telegram reports "${inspection.actualUrl}" instead of "${webhookUrl}".`
              : inspection.status === 'not_registered'
                ? 'Master Bot webhook is not currently registered with Telegram.'
                : inspection.lastErrorMessage || '';

          await Promise.all([
            repos.stats.setSetting('master_bot_username', me.result.username || '', ownerId),
            repos.stats.setSetting('master_webhook_last_verified_at', verifiedAt, ownerId),
            repos.stats.setSetting('master_webhook_last_status', inspection.status, ownerId),
            repos.stats.setSetting('master_webhook_last_error', readableError, ownerId),
            repos.stats.setSetting('master_webhook_last_response', JSON.stringify(inspection.telegramResponse), ownerId),
          ]);

          await writeSystemLog(env, {
            level: 'audit',
            source: 'master-webhook',
            message: `Verified Master Bot @${me.result.username} webhook status: ${inspection.status}`,
            metadata: { expectedWebhookUrl: webhookUrl, actualUrl: inspection.actualUrl, verified: inspection.verified },
            actorTelegramId: ownerId,
          });

          return jsonResponse(
            {
              ok: true,
              verified: inspection.verified,
              status: inspection.status,
              workerPublicUrl,
              expectedWebhookUrl: webhookUrl,
              lastRegisteredAt: settings.map?.master_webhook_last_registered_at || null,
              lastVerifiedAt: verifiedAt,
              error: readableError || null,
              bot: {
                id: me.result.id,
                username: me.result.username,
                first_name: me.result.first_name,
              },
              verification: inspection,
            },
            200,
            env
          );
        } catch (verErr) {
          const safeError = redactString(verErr?.message || 'Master Bot webhook verification failed');
          await writeSystemLog(env, {
            level: 'error',
            source: 'master-webhook',
            message: `Master Bot webhook verification failed: ${safeError}`,
            metadata: { expectedWebhookUrl: webhookUrl },
            actorTelegramId: ownerId,
          });
          const httpStatus =
            verErr?.status === 504 ? 504 : verErr?.status >= 400 && verErr?.status < 600 ? verErr.status : 502;
          return jsonResponse(
            {
              ok: false,
              verified: false,
              status: 'failed',
              workerPublicUrl,
              expectedWebhookUrl: webhookUrl,
              error: safeError,
              errorCode: verErr?.errorCode || null,
              telegramMethod: verErr?.method || null,
            },
            httpStatus,
            env
          );
        }
      }

      // Overview & Analytics
      if (method === 'GET' && path === '/api/dashboard/overview') {
        const analytics = await getApplicationAnalytics(repos);
        const settings = await repos.stats.getSettings();
        return jsonResponse(
          {
            ok: true,
            analytics,
            settings: settings.map,
            masterBotDeepLink: buildMasterBotDeepLink(env, 'create'),
            themes: listThemePresets(),
          },
          200,
          env
        );
      }

      // Templates (active list + full Studio management)
      if (method === 'GET' && path === '/api/templates') {
        const templates = await repos.templates.listActive();
        return jsonResponse({ ok: true, templates }, 200, env);
      }

      if (method === 'GET' && path === '/api/templates/all') {
        const templates = await repos.templates.listAllForStudio();
        return jsonResponse({ ok: true, templates }, 200, env);
      }

      const tplPatchMatch = path.match(/^\/api\/templates\/([^/]+)$/);
      if (method === 'PATCH' && tplPatchMatch) {
        const body = await request.json();
        const updated = await repos.templates.updateTemplateAdmin(tplPatchMatch[1], {
          availabilityStatus: body.availabilityStatus,
          description: body.description,
          name: body.name,
        });
        await writeSystemLog(env, {
          level: 'audit',
          source: 'api-templates',
          message: `Updated template ${updated.slug} status=${updated.availability_status}`,
          actorTelegramId: ownerId,
        });
        return jsonResponse({ ok: true, template: updated }, 200, env);
      }

      // Platform Referrals & Slot Entitlements Control
      if (method === 'GET' && path === '/api/referrals') {
        const referrals = await repos.platformReferrals.listAll({
          status: url.searchParams.get('status') || '',
          limit: Math.min(200, Number(url.searchParams.get('limit') || 100)),
        });
        return jsonResponse({ ok: true, referrals }, 200, env);
      }

      const refPatchMatch = path.match(/^\/api\/referrals\/([^/]+)$/);
      if (method === 'PATCH' && refPatchMatch) {
        const body = await request.json();
        if (!['verified', 'rejected', 'pending', 'flagged'].includes(body?.status)) {
          return jsonResponse({ ok: false, error: 'Status must be verified, rejected, flagged, or pending.' }, 400, env);
        }
        const updated = await repos.platformReferrals.updateStatus(refPatchMatch[1], {
          status: body.status,
          reviewedBy: ownerId,
          reason: body.reason || '',
        });
        return jsonResponse({ ok: true, referral: updated }, 200, env);
      }

      // Platform Admins RBAC (Super Admin is immutable)
      if (method === 'GET' && path === '/api/platform-admins') {
        const admins = await repos.platformAdmins.list();
        return jsonResponse(
          { ok: true, superAdminTelegramId: env.ADMIN_TELEGRAM_ID || null, admins },
          200,
          env
        );
      }

      if (method === 'POST' && path === '/api/platform-admins') {
        const body = await request.json();
        const admin = await repos.platformAdmins.upsert({
          telegramId: body?.telegramId,
          role: body?.role || 'admin',
          permissions: body?.permissions,
          addedBy: ownerId,
        });
        await writeSystemLog(env, {
          level: 'audit',
          source: 'api-admins',
          message: `Added/updated platform admin ${admin.telegram_id}`,
          actorTelegramId: ownerId,
        });
        return jsonResponse({ ok: true, admin }, 201, env);
      }

      const padmDelMatch = path.match(/^\/api\/platform-admins\/([^/]+)$/);
      if (method === 'DELETE' && padmDelMatch) {
        const res = await repos.platformAdmins.remove(padmDelMatch[1], ownerId);
        await writeSystemLog(env, {
          level: 'audit',
          source: 'api-admins',
          message: `Removed platform admin ${padmDelMatch[1]}`,
          actorTelegramId: ownerId,
        });
        return jsonResponse({ ok: true, ...res }, 200, env);
      }

      // Recent Deployment Logs
      if (method === 'GET' && path === '/api/deployments') {
        const deployments = await repos.deployments.listRecent(Math.min(100, Number(url.searchParams.get('limit') || 50)));
        return jsonResponse({ ok: true, deployments }, 200, env);
      }

      // Verify Master Bot Channel/Group Admin Rights for Platform Force Join (Public & Private aware)
      if (method === 'POST' && path === '/api/force-join/verify') {
        if (!env.MASTER_BOT_TOKEN) {
          return jsonResponse({ ok: false, error: 'MASTER_BOT_TOKEN is not configured.' }, 400, env);
        }
        const body = await request.json();
        const channel = String(body?.channel || '').trim();
        if (!channel) return jsonResponse({ ok: false, error: 'channel is required.' }, 400, env);

        const resolved = await resolveAndVerifyForceJoinDestination({
          telegram,
          token: env.MASTER_BOT_TOKEN,
          rawInput: channel,
          botUsername: env.MASTER_BOT_USERNAME || '',
        });

        if (resolved.pendingPrivateLink) {
          const pendingLink = {
            inviteUrl: resolved.inviteUrl,
            inviteCode: resolved.inviteCode,
            requestedBy: ownerId,
            chatId: ownerId,
            requestedAt: new Date().toISOString(),
          };
          await repos.stats.setSetting('platform_force_join_pending', JSON.stringify(pendingLink), ownerId);
          return jsonResponse(
            {
              ok: true,
              pendingPrivateLink: true,
              inviteUrl: resolved.inviteUrl,
              botUsername: resolved.botUsername,
              isAdmin: false,
              botIsAdmin: false,
              status: 'pending_private_link',
              message:
                'Private invite link saved as pending. Add the Master Bot to your private channel/group and promote it to Administrator to automatically link the numeric chat ID.',
            },
            200,
            env
          );
        }

        if (!resolved.ok) {
          return jsonResponse(
            {
              ok: false,
              channel,
              isAdmin: false,
              botIsAdmin: false,
              status: resolved.botStatus || 'error',
              error: resolved.error,
            },
            400,
            env
          );
        }

        return jsonResponse(
          {
            ok: true,
            channel: resolved.destination.chatId,
            destination: resolved.destination,
            memberStatus: resolved.destination.botStatus,
            status: resolved.destination.botStatus,
            isAdmin: true,
            botIsAdmin: true,
          },
          200,
          env
        );
      }

      // Validate Telegram Bot Token via real getMe
      if (method === 'POST' && path === '/api/bots/validate-token') {
        const body = await request.json();
        const validated = await validateTokenForDeployment({
          telegram,
          repos,
          rawToken: body?.token,
          ownerTelegramId: body?.ownerTelegramId || ownerId,
          allowRetryFailed: true,
        });
        // Never echo rawToken back!
        return jsonResponse(
          {
            ok: true,
            bot: {
              telegramBotId: validated.telegramBotId,
              telegramUsername: validated.telegramUsername,
              telegramFirstName: validated.telegramFirstName,
              retryBotId: validated.retryBotId || null,
            },
          },
          200,
          env
        );
      }

      // Deploy New Bot via real pipeline
      if (method === 'POST' && path === '/api/bots/deploy') {
        const body = await request.json();
        const stagesLog = [];
        const deployEnv = { ...env, WORKER_PUBLIC_URL: workerPublicUrl };
        const result = await deployTenantBot({
          env: deployEnv,
          repos,
          telegram,
          ownerTelegramId: body.ownerTelegramId || ownerId,
          rawToken: body.token,
          templateId: body.templateId || 'tpl_refer_earn',
          mode: body.mode || 'template',
          displayName: body.displayName,
          description: body.description || '',
          branding: body.branding || {},
          customMenus: body.customMenus ? validateMenuTree(body.customMenus) : null,
          templateConfig: body.templateConfig || null,
          onStage: async (stage, detail) => {
            stagesLog.push({ stage, detail, at: new Date().toISOString() });
          },
        });
        return jsonResponse(
          {
            ok: true,
            bot: sanitizeBotForApi(result.bot),
            template: result.template,
            verification: result.verification,
            retried: result.retried,
            stages: stagesLog,
          },
          201,
          env
        );
      }

      // List all bots
      if (method === 'GET' && path === '/api/bots') {
        const bots = await listAllBots(repos, {
          query: url.searchParams.get('q') || '',
          status: url.searchParams.get('status') || '',
          templateId: url.searchParams.get('templateId') || '',
        });
        return jsonResponse({ ok: true, bots }, 200, env);
      }

      // Single bot routes
      const botDetailMatch = path.match(/^\/api\/bots\/([^/]+)$/);
      if (botDetailMatch) {
        const botId = botDetailMatch[1];
        if (method === 'GET') {
          const detail = await inspectBotDetail({ env: { ...env, WORKER_PUBLIC_URL: workerPublicUrl }, repos, telegram, botId });
          if (!detail) return jsonResponse({ ok: false, error: 'Bot not found' }, 404, env);
          return jsonResponse({ ok: true, ...detail }, 200, env);
        }
        if (method === 'DELETE') {
          const res = await ownerDeleteBot({ env, repos, telegram, botId, actorTelegramId: ownerId });
          return jsonResponse({ ok: true, ...res }, 200, env);
        }
      }

      const botActionMatch = path.match(/^\/api\/bots\/([^/]+)\/(disable|enable|verify)$/);
      if (method === 'POST' && botActionMatch) {
        const [, botId, action] = botActionMatch;
        if (action === 'disable') {
          const bot = await ownerDisableBot({ env, repos, telegram, botId, actorTelegramId: ownerId });
          return jsonResponse({ ok: true, bot: sanitizeBotForApi(bot) }, 200, env);
        }
        const res = await ownerEnableAndRetryWebhook({
          env: { ...env, WORKER_PUBLIC_URL: workerPublicUrl },
          repos,
          telegram,
          botId,
          actorTelegramId: ownerId,
        });
        return jsonResponse({ ok: true, bot: sanitizeBotForApi(res.bot), verification: res.verification }, 200, env);
      }

      // Custom Builder Menus & Branding Persistence
      const builderMatch = path.match(/^\/api\/builder\/([^/]+)$/);
      if (builderMatch) {
        const botId = builderMatch[1];
        const bot = await repos.bots.getById(botId);
        if (!bot) return jsonResponse({ ok: false, error: 'Bot not found' }, 404, env);

        if (method === 'GET') {
          const [config, menus] = await Promise.all([
            repos.botConfigs.getByBotId(botId),
            repos.menus.listByBotId(botId),
          ]);
          return jsonResponse({ ok: true, botId, config, menus }, 200, env);
        }

        if (method === 'PUT') {
          const body = await request.json();
          let savedMenus = null;
          if (Array.isArray(body.menus)) {
            const validated = validateMenuTree(body.menus);
            savedMenus = await repos.menus.replaceMenuTree(botId, validated);
          }
          let savedConfig = null;
          if (body.config) {
            const existingCfg = (await repos.botConfigs.getByBotId(botId)) || {};
            savedConfig = await repos.botConfigs.upsert(botId, { ...existingCfg, ...body.config });
          }
          await invalidateTenantCache(env, botId);
          return jsonResponse({ ok: true, config: savedConfig, menus: savedMenus }, 200, env);
        }
      }

      // Users Management (with plan, suspension, and bot slot override + audit log)
      if (method === 'GET' && path === '/api/users') {
        const users = await listUsers(repos, {
          query: url.searchParams.get('q') || '',
          status: url.searchParams.get('status') || '',
          plan: url.searchParams.get('plan') || '',
        });
        return jsonResponse({ ok: true, users }, 200, env);
      }

      const userMatch = path.match(/^\/api\/users\/([^/]+)$/);
      if (userMatch) {
        const targetId = userMatch[1];
        if (method === 'GET') {
          const detail = await getUserProfileDetail(repos, targetId);
          if (!detail) return jsonResponse({ ok: false, error: 'User not found' }, 404, env);
          const referrals = await repos.platformReferrals.listByReferrer(targetId, 25);
          return jsonResponse({ ok: true, ...detail, referrals }, 200, env);
        }
        if (method === 'PATCH') {
          const body = await request.json();
          let updated = null;
          if (body.plan) {
            updated = await changeUserPlan({ env, repos, telegramId: targetId, plan: body.plan, actorTelegramId: ownerId });
          }
          if (typeof body.suspend === 'boolean') {
            updated = await setUserSuspension({ env, repos, telegramId: targetId, suspend: body.suspend, actorTelegramId: ownerId });
          }
          if (body.bonusBotSlots !== undefined && body.bonusBotSlots !== null) {
            updated = await repos.users.adjustBotSlots(targetId, body.bonusBotSlots);
            await writeSystemLog(env, {
              level: 'audit',
              source: 'api-users',
              message: `Adjusted user ${targetId} bonus_bot_slots to ${body.bonusBotSlots}`,
              actorTelegramId: ownerId,
            });
          }
          return jsonResponse({ ok: true, user: updated }, 200, env);
        }
      }

      // Broadcast Engine
      if (method === 'GET' && path === '/api/broadcasts') {
        const broadcasts = await repos.broadcasts.list(50);
        return jsonResponse(
          { ok: true, broadcasts, masterBotDeepLink: buildMasterBotDeepLink(env, 'create') },
          200,
          env
        );
      }

      if (method === 'POST' && path === '/api/broadcasts') {
        const body = await request.json();
        if (!body?.messageText || !String(body.messageText).trim()) {
          return jsonResponse({ ok: false, error: 'Broadcast messageText is required.' }, 400, env);
        }
        const draft = await repos.broadcasts.create({
          scope: body.scope || 'global',
          targetBotIds: body.targetBotIds || [],
          targetUserIds: body.targetUserIds || [],
          messageText: String(body.messageText).trim(),
          imageUrl: body.imageUrl || null,
          inlineButtons: body.inlineButtons || [],
          includePromoFooter: body.includePromoFooter !== false,
          createdBy: ownerId,
        });
        const settings = await repos.stats.getSettings();
        const preview = composeBroadcastPayload({ broadcast: draft, env, settingsMap: settings.map });
        return jsonResponse({ ok: true, broadcast: draft, preview }, 201, env);
      }

      const brcActionMatch = path.match(/^\/api\/broadcasts\/([^/]+)\/(launch|step|status)$/);
      if (brcActionMatch) {
        const [, broadcastId, action] = brcActionMatch;
        if (method === 'POST' && action === 'launch') {
          const queued = await queueBroadcast({ env, repos, broadcastId, actorTelegramId: ownerId });
          const firstBatch = await processBroadcastBatch({ env, repos, telegram, broadcastId });
          const refreshed = await repos.broadcasts.getById(broadcastId);
          return jsonResponse({ ok: true, broadcast: refreshed || queued, batch: firstBatch }, 200, env);
        }
        if (method === 'POST' && action === 'step') {
          const batch = await processBroadcastBatch({ env, repos, telegram, broadcastId });
          const refreshed = await repos.broadcasts.getById(broadcastId);
          return jsonResponse({ ok: true, broadcast: refreshed, batch }, 200, env);
        }
        if (method === 'PATCH' && action === 'status') {
          const body = await request.json();
          const updated = await updateBroadcastStatus({
            env,
            repos,
            broadcastId,
            status: body.status,
            actorTelegramId: ownerId,
          });
          return jsonResponse({ ok: true, broadcast: updated }, 200, env);
        }
      }

      // Cloudflare Infrastructure Monitor (Two-Layer)
      if (method === 'GET' && path === '/api/cloudflare/metrics') {
        const metrics = await getCloudflareInfrastructureMetrics(env, repos, fetchImpl);
        return jsonResponse({ ok: true, metrics }, 200, env);
      }

      // Redacted System Logs
      if (method === 'GET' && path === '/api/logs') {
        const logs = await repos.stats.getRecentLogs({
          level: url.searchParams.get('level') || '',
          limit: Math.min(200, Number(url.searchParams.get('limit') || 80)),
        });
        return jsonResponse({ ok: true, logs }, 200, env);
      }

      // Global Platform Settings
      if (method === 'GET' && path === '/api/settings') {
        const settings = await repos.stats.getSettings();
        return jsonResponse({ ok: true, settings: settings.map, rows: settings.rows }, 200, env);
      }

      if (method === 'PUT' && path === '/api/settings') {
        const body = await request.json();
        for (const [k, v] of Object.entries(body || {})) {
          await repos.stats.setSetting(k, v, ownerId);
        }
        const settings = await repos.stats.getSettings();
        return jsonResponse({ ok: true, settings: settings.map }, 200, env);
      }

      return jsonResponse({ ok: false, error: `Endpoint not found: ${method} ${path}` }, 404, env);
    } catch (err) {
      const safeError = redactString(err?.message || 'Internal Worker Error');
      await writeSystemLog(env, {
        level: 'error',
        source: 'api-router',
        message: `${method} ${path} failed: ${safeError}`,
      });
      const status =
        err?.status === 504 ? 504 : err?.status >= 400 && err?.status < 600 ? err.status : 400;
      return jsonResponse({ ok: false, error: safeError }, status, env);
    }
  }

  return jsonResponse({ ok: false, error: 'Route not found' }, 404, env);
}
