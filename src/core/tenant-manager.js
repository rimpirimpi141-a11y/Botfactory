/**
 * Multi-Tenant Configuration & Deployment Manager.
 *
 * - Cloudflare D1 is the authoritative source of truth.
 * - Cloudflare KV caches hot tenant configuration (with explicit invalidation on write).
 * - Orchestrates real 10-step bot deployment with token validation, duplicate check,
 *   AES-GCM encryption, D1 persistence, setWebhook, and getWebhookInfo verification.
 */

import {
  decryptBotToken,
  encryptBotToken,
  generateBotId,
  generateWebhookSecret,
  hashBotToken,
} from './token-security.js';
import { buildTenantWebhookUrl, registerAndVerifyWebhook, removeWebhook } from './webhook-manager.js';
import { validateBotTokenFormat, validateSafeUrl, validateSupportUsername } from '../utils/validation.js';
import { writeSystemLog } from '../utils/logger.js';

const TENANT_CACHE_TTL_SECONDS = 300; // 5 minutes, invalidated immediately on mutation

function tenantCacheKey(botId) {
  return `tenant:cfg:${botId}`;
}

export async function invalidateTenantCache(env, botId) {
  if (!env?.KV || !botId) return;
  try {
    await env.KV.delete(tenantCacheKey(botId));
  } catch {
    // Non-fatal cache invalidation failure
  }
}

/**
 * Loads a tenant bot + branding config + menus, using KV cache when available
 * and falling back cleanly to D1. Decrypts the bot token in memory for the current request only.
 */
export async function loadTenantRuntime({ env, repos, botId }) {
  let cached = null;
  let cacheHit = false;

  if (env?.KV) {
    try {
      const raw = await env.KV.get(tenantCacheKey(botId));
      if (raw) {
        cached = JSON.parse(raw);
        cacheHit = true;
      }
    } catch {
      cached = null;
    }
  }

  let botRecord = cached?.bot || null;
  let configRecord = cached?.config || null;
  let menuTree = cached?.menus || null;

  if (!botRecord) {
    botRecord = await repos.bots.getById(botId);
    if (!botRecord) return null;

    configRecord = (await repos.botConfigs.getByBotId(botId)) || {
      botId,
      brandTitle: botRecord.display_name,
      welcomeMessage: `Welcome to ${botRecord.display_name}!`,
      welcomeImageUrl: null,
      logoUrl: null,
      footerText: '',
      supportUsername: '',
      themeId: 'obsidian_neon',
      themeConfig: {},
      templateSettings: {},
      forceJoinChannels: [],
      promoFooterEnabled: true,
    };
    menuTree = await repos.menus.listByBotId(botId);

    if (env?.KV) {
      try {
        await env.KV.put(
          tenantCacheKey(botId),
          JSON.stringify({ bot: botRecord, config: configRecord, menus: menuTree }),
          { expirationTtl: TENANT_CACHE_TTL_SECONDS }
        );
      } catch {
        // KV write failure must never block tenant execution
      }
    }
  }

  const decryptedToken = await decryptBotToken(botRecord.token_encrypted, env.TOKEN_ENCRYPTION_KEY);

  return {
    bot: botRecord,
    config: configRecord,
    menus: menuTree,
    token: decryptedToken,
    cacheHit,
  };
}

/**
 * Validates a Telegram bot token via real Telegram getMe + checks for duplicate registration.
 * When `allowRetryFailed` is true and the existing failed record belongs to the same owner,
 * returns `retryBotId` so deployment can safely retry without creating duplicate rows.
 */
export async function validateTokenForDeployment({
  telegram,
  repos,
  rawToken,
  ownerTelegramId = null,
  allowRetryFailed = false,
}) {
  const format = validateBotTokenFormat(rawToken);
  if (!format.valid) {
    throw new Error(format.error);
  }

  const meRes = await telegram.getMe(format.token);
  const botInfo = meRes?.result;
  if (!botInfo?.id || !botInfo?.username || !botInfo?.is_bot) {
    throw new Error('Telegram getMe did not return a valid bot account.');
  }

  const tokenHash = await hashBotToken(format.token);
  const duplicate = await repos.bots.findDuplicate(String(botInfo.id), tokenHash);
  let retryBotId = null;

  if (duplicate) {
    const sameOwner = ownerTelegramId !== null && String(duplicate.owner_telegram_id) === String(ownerTelegramId);

    if (duplicate.status === 'failed' && allowRetryFailed && sameOwner) {
      retryBotId = duplicate.id;
    } else if (duplicate.status === 'deploying') {
      throw new Error(
        `Deployment for @${botInfo.username} (${duplicate.id}) is already in progress. Please wait a moment before retrying.`
      );
    } else {
      throw new Error(
        `Bot @${botInfo.username} is already registered on BOT FACTORY (ID: ${duplicate.id}). Delete or manage the existing instance instead.`
      );
    }
  }

  return {
    token: format.token,
    tokenHash,
    telegramBotId: String(botInfo.id),
    telegramUsername: botInfo.username,
    telegramFirstName: botInfo.first_name || botInfo.username,
    retryBotId,
  };
}

/**
 * Complete real multi-tenant bot deployment pipeline.
 * Only marks bot ACTIVE after setWebhook + getWebhookInfo succeed.
 * Safely retries existing failed deployments owned by the same creator without duplicating records.
 */
export async function deployTenantBot({
  env,
  repos,
  telegram,
  ownerTelegramId,
  rawToken,
  templateId,
  mode = 'template',
  displayName,
  description = '',
  branding = {},
  customMenus = null,
  onStage = null,
}) {
  const notify = async (stage, detail = '') => {
    if (typeof onStage === 'function') {
      await onStage(stage, detail);
    }
  };

  // Stage 1: Validate token via real Telegram getMe
  await notify('validate_token', 'Contacting Telegram getMe...');
  const validated = await validateTokenForDeployment({
    telegram,
    repos,
    rawToken,
    ownerTelegramId,
    allowRetryFailed: true,
  });

  // Stage 2: Check template & owner quotas
  await notify('load_template', 'Loading template definition...');
  const template = (await repos.templates.getById(templateId)) || (await repos.templates.getBySlug(templateId));
  if (!template) {
    throw new Error(`Template "${templateId}" not found.`);
  }

  const owner = await repos.users.getByTelegramId(ownerTelegramId);
  if (owner?.status === 'suspended' || owner?.status === 'banned') {
    throw new Error('Your account is currently suspended and cannot deploy new bots.');
  }

  const settings = await repos.stats.getSettings();
  if (settings.map.maintenance_mode === 'true' && owner?.role !== 'super_admin') {
    throw new Error('BOT FACTORY is currently in maintenance mode. Please retry shortly.');
  }

  // Validate optional branding URLs and support handle
  if (branding.welcomeImageUrl) {
    const check = validateSafeUrl(branding.welcomeImageUrl);
    if (!check.valid) throw new Error(`Welcome image URL invalid: ${check.error}`);
  }
  if (branding.logoUrl) {
    const check = validateSafeUrl(branding.logoUrl);
    if (!check.valid) throw new Error(`Logo URL invalid: ${check.error}`);
  }
  const supportCheck = validateSupportUsername(branding.supportUsername || '');
  if (!supportCheck.valid) {
    throw new Error(supportCheck.error);
  }

  // Stage 3: Encrypt bot token with AES-256-GCM and generate unique per-bot webhook secret
  await notify('encrypt_credentials', 'Encrypting credentials with AES-256-GCM...');
  const tokenEncrypted = await encryptBotToken(validated.token, env.TOKEN_ENCRYPTION_KEY);
  const botId = validated.retryBotId || generateBotId();
  const webhookSecret = generateWebhookSecret();
  const webhookUrl = buildTenantWebhookUrl(env.WORKER_PUBLIC_URL, botId);
  const resolvedMode = template.slug === 'custom-builder' ? 'custom' : mode;

  // Stage 4: Persist bot & configuration in Cloudflare D1 (update in-place when safely retrying a failed deploy)
  await notify(
    'save_database',
    validated.retryBotId ? 'Updating failed deployment record in D1 for safe retry...' : 'Persisting tenant configuration to D1...'
  );

  if (validated.retryBotId) {
    await repos.bots.prepareRetryDeployment(botId, {
      telegramUsername: validated.telegramUsername,
      displayName: displayName || validated.telegramFirstName,
      description,
      tokenEncrypted,
      tokenHash: validated.tokenHash,
      webhookSecret,
      webhookUrl,
      templateId: template.id,
      mode: resolvedMode,
      plan: owner?.plan || 'free',
    });
  } else {
    await repos.bots.create({
      id: botId,
      ownerTelegramId: String(ownerTelegramId),
      telegramBotId: validated.telegramBotId,
      telegramUsername: validated.telegramUsername,
      displayName: displayName || validated.telegramFirstName,
      description,
      tokenEncrypted,
      tokenHash: validated.tokenHash,
      webhookSecret,
      webhookUrl,
      templateId: template.id,
      mode: resolvedMode,
      plan: owner?.plan || 'free',
    });
  }

  await repos.botConfigs.upsert(botId, {
    brandTitle: branding.brandTitle || displayName || validated.telegramFirstName,
    welcomeMessage:
      branding.welcomeMessage ||
      `Welcome to <b>${displayName || validated.telegramFirstName}</b>! Choose an option from the menu below.`,
    welcomeImageUrl: branding.welcomeImageUrl || null,
    logoUrl: branding.logoUrl || null,
    footerText: branding.footerText || '',
    supportUsername: supportCheck.username,
    themeId: branding.themeId || 'obsidian_neon',
    themeConfig: branding.themeConfig || {},
    templateSettings: {
      ...template.default_config,
      ...(branding.templateSettings || {}),
    },
    forceJoinChannels: branding.forceJoinChannels || [],
    promoFooterEnabled: branding.promoFooterEnabled !== false,
  });

  if (Array.isArray(customMenus) && customMenus.length > 0) {
    await repos.menus.replaceMenuTree(botId, customMenus);
  }

  // Stage 5 & 6: Automatically register and verify webhook through Telegram API
  await notify('register_webhook', 'Registering tenant Telegram webhook...');
  try {
    const verification = await registerAndVerifyWebhook({
      telegram,
      token: validated.token,
      webhookUrl,
      secretToken: webhookSecret,
    });

    await notify('verify_webhook', 'Webhook verified with Telegram getWebhookInfo...');
    const activeBot = await repos.bots.updateWebhookVerification(botId, {
      webhookUrl: verification.webhookUrl,
      webhookStatus: 'verified',
      botStatus: 'active',
      error: verification.lastErrorMessage,
    });

    await invalidateTenantCache(env, botId);
    await writeSystemLog(env, {
      level: 'audit',
      source: 'tenant-manager',
      message: `${validated.retryBotId ? 'Retried and verified' : 'Deployed and verified'} bot @${validated.telegramUsername} (${botId})`,
      metadata: { botId, templateId: template.id, webhookUrl, retried: Boolean(validated.retryBotId) },
      actorTelegramId: ownerTelegramId,
    });

    return {
      bot: activeBot,
      template,
      verification,
      retried: Boolean(validated.retryBotId),
    };
  } catch (webhookErr) {
    await repos.bots.updateWebhookVerification(botId, {
      webhookUrl,
      webhookStatus: 'failed',
      botStatus: 'failed',
      error: webhookErr?.message || 'Webhook registration failed',
    });
    await invalidateTenantCache(env, botId);
    await writeSystemLog(env, {
      level: 'error',
      source: 'tenant-manager',
      message: `Webhook registration failed for ${botId}: ${webhookErr?.message}`,
      metadata: { botId },
      actorTelegramId: ownerTelegramId,
    });
    throw webhookErr;
  }
}

export async function disableTenantBot({ env, repos, telegram, botId, actorTelegramId }) {
  const runtime = await loadTenantRuntime({ env, repos, botId });
  if (!runtime) throw new Error('Bot not found.');

  await removeWebhook({ telegram, token: runtime.token }).catch(() => {});
  const updated = await repos.bots.setStatus(botId, 'disabled', 'disabled');
  await invalidateTenantCache(env, botId);
  await writeSystemLog(env, {
    level: 'audit',
    source: 'tenant-manager',
    message: `Disabled bot @${runtime.bot.telegram_username} (${botId})`,
    metadata: { botId },
    actorTelegramId,
  });
  return updated;
}

export async function enableAndVerifyTenantBot({ env, repos, telegram, botId, actorTelegramId }) {
  const runtime = await loadTenantRuntime({ env, repos, botId });
  if (!runtime) throw new Error('Bot not found.');

  const webhookUrl = buildTenantWebhookUrl(env.WORKER_PUBLIC_URL, botId);

  try {
    const verification = await registerAndVerifyWebhook({
      telegram,
      token: runtime.token,
      webhookUrl,
      secretToken: runtime.bot.webhook_secret,
    });

    const updated = await repos.bots.updateWebhookVerification(botId, {
      webhookUrl: verification.webhookUrl,
      webhookStatus: 'verified',
      botStatus: 'active',
      error: verification.lastErrorMessage,
    });
    await invalidateTenantCache(env, botId);
    await writeSystemLog(env, {
      level: 'audit',
      source: 'tenant-manager',
      message: `Re-enabled and verified bot @${runtime.bot.telegram_username} (${botId})`,
      metadata: { botId, webhookUrl },
      actorTelegramId,
    });
    return { bot: updated, verification };
  } catch (webhookErr) {
    await repos.bots.updateWebhookVerification(botId, {
      webhookUrl,
      webhookStatus: 'failed',
      botStatus: 'failed',
      error: webhookErr?.message || 'Webhook retry verification failed',
    });
    await invalidateTenantCache(env, botId);
    await writeSystemLog(env, {
      level: 'error',
      source: 'tenant-manager',
      message: `Webhook retry failed for ${botId}: ${webhookErr?.message}`,
      metadata: { botId },
      actorTelegramId,
    });
    throw webhookErr;
  }
}

export async function deleteTenantBot({ env, repos, telegram, botId, actorTelegramId }) {
  const runtime = await loadTenantRuntime({ env, repos, botId });
  if (!runtime) throw new Error('Bot not found.');

  await removeWebhook({ telegram, token: runtime.token }).catch(() => {});
  await repos.bots.softDelete(botId);
  await invalidateTenantCache(env, botId);
  await writeSystemLog(env, {
    level: 'audit',
    source: 'tenant-manager',
    message: `Deleted bot @${runtime.bot.telegram_username} (${botId})`,
    metadata: { botId },
    actorTelegramId,
  });
  return { deleted: true, botId };
}
