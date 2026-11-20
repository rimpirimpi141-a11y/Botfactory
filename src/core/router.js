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
import { buildMasterWebhookUrl, registerAndVerifyWebhook, verifyWebhookSecretHeader } from './webhook-manager.js';
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
import { writeSystemLog } from '../utils/logger.js';

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

export async function routeRequest(request, env, ctx, { fetchImpl = globalThis.fetch } = {}) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method.toUpperCase();

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(env) });
  }

  const telegram = createTelegramClient(fetchImpl);

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
        bindings: {
          d1: dbHealth,
          kv: Boolean(env?.KV),
          analyticsEngine: Boolean(env?.ANALYTICS),
          masterBotConfigured: Boolean(env?.MASTER_BOT_TOKEN),
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
      const result = await handleMasterBotUpdate({ env, repos, telegram, update });
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
      // Master Bot Webhook auto-registration
      if (method === 'POST' && path === '/api/master/register-webhook') {
        if (!env.MASTER_BOT_TOKEN || !env.MASTER_WEBHOOK_SECRET) {
          return jsonResponse(
            { ok: false, error: 'MASTER_BOT_TOKEN and MASTER_WEBHOOK_SECRET must be set via wrangler secret put.' },
            400,
            env
          );
        }
        const webhookUrl = buildMasterWebhookUrl(env.WORKER_PUBLIC_URL);
        const me = await telegram.getMe(env.MASTER_BOT_TOKEN);
        const verification = await registerAndVerifyWebhook({
          telegram,
          token: env.MASTER_BOT_TOKEN,
          webhookUrl,
          secretToken: env.MASTER_WEBHOOK_SECRET,
        });
        return jsonResponse({ ok: true, bot: me.result, verification }, 200, env);
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

      // Templates
      if (method === 'GET' && path === '/api/templates') {
        const templates = await repos.templates.listActive();
        return jsonResponse({ ok: true, templates }, 200, env);
      }

      // Validate Telegram Bot Token via real getMe
      if (method === 'POST' && path === '/api/bots/validate-token') {
        const body = await request.json();
        const validated = await validateTokenForDeployment({
          telegram,
          repos,
          rawToken: body?.token,
        });
        // Never echo rawToken back!
        return jsonResponse(
          {
            ok: true,
            bot: {
              telegramBotId: validated.telegramBotId,
              telegramUsername: validated.telegramUsername,
              telegramFirstName: validated.telegramFirstName,
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
        const result = await deployTenantBot({
          env,
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
          onStage: async (stage, detail) => {
            stagesLog.push({ stage, detail, at: new Date().toISOString() });
          },
        });
        const safeBot = { ...result.bot };
        delete safeBot.token_encrypted;
        delete safeBot.token_hash;
        delete safeBot.webhook_secret;
        return jsonResponse(
          { ok: true, bot: safeBot, template: result.template, verification: result.verification, stages: stagesLog },
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
          const detail = await inspectBotDetail({ env, repos, telegram, botId });
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
          return jsonResponse({ ok: true, bot }, 200, env);
        }
        const res = await ownerEnableAndRetryWebhook({ env, repos, telegram, botId, actorTelegramId: ownerId });
        return jsonResponse({ ok: true, ...res }, 200, env);
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

      // Users Management
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
          return jsonResponse({ ok: true, ...detail }, 200, env);
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

      // Cloudflare Infrastructure Monitor
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
      await writeSystemLog(env, {
        level: 'error',
        source: 'api-router',
        message: `${method} ${path} failed: ${err?.message || 'Unknown error'}`,
      });
      return jsonResponse({ ok: false, error: err?.message || 'Internal Worker Error' }, 400, env);
    }
  }

  return jsonResponse({ ok: false, error: 'Route not found' }, 404, env);
}
