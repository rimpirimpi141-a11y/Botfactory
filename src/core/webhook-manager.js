/**
 * Automatic Telegram Webhook Manager.
 *
 * - Builds tenant webhook URLs: https://YOUR-WORKER.workers.dev/webhook/<BOT_ID>
 * - Registers webhook via Telegram setWebhook with X-Telegram-Bot-Api-Secret-Token.
 * - Immediately verifies via getWebhookInfo before declaring a bot LIVE.
 * - Validates incoming webhook secret headers using constant-time comparison.
 */

import { timingSafeEqual } from './token-security.js';

export const MASTER_BOT_ALLOWED_UPDATES = ['message', 'callback_query', 'chat_member', 'my_chat_member'];
export const DEFAULT_TENANT_ALLOWED_UPDATES = ['message', 'callback_query', 'chat_member', 'my_chat_member'];

export function buildTenantWebhookUrl(workerPublicUrl, botId) {
  if (!workerPublicUrl || !/^https:\/\/.+/i.test(workerPublicUrl.trim())) {
    throw new Error('WORKER_PUBLIC_URL must be a valid HTTPS URL (e.g. https://botfactory.rimpirimpi141.workers.dev).');
  }
  const base = workerPublicUrl.trim().replace(/\/+$/, '');
  return `${base}/webhook/${botId}`;
}

export function buildMasterWebhookUrl(workerPublicUrl) {
  if (!workerPublicUrl || !/^https:\/\/.+/i.test(workerPublicUrl.trim())) {
    throw new Error('WORKER_PUBLIC_URL must be a valid HTTPS URL (e.g. https://botfactory.rimpirimpi141.workers.dev).');
  }
  const base = workerPublicUrl.trim().replace(/\/+$/, '');
  return `${base}/webhook/master`;
}

/**
 * Constant-time verification of Telegram's X-Telegram-Bot-Api-Secret-Token header.
 */
export function verifyWebhookSecretHeader(request, expectedSecret) {
  if (!expectedSecret) return false;
  const received = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!received) return false;
  return timingSafeEqual(received, expectedSecret);
}

/**
 * Produces a strictly non-sensitive view of Telegram's getWebhookInfo result.
 * Never includes bot tokens or webhook secret tokens.
 */
export function sanitizeWebhookInfo(info = {}) {
  return {
    url: info.url || '',
    has_custom_certificate: Boolean(info.has_custom_certificate),
    pending_update_count: Number(info.pending_update_count || 0),
    ip_address: info.ip_address || null,
    last_error_date: info.last_error_date || null,
    last_error_message: info.last_error_message || null,
    last_synchronization_error_date: info.last_synchronization_error_date || null,
    max_connections: Number(info.max_connections || 40),
    allowed_updates: Array.isArray(info.allowed_updates) ? info.allowed_updates : [],
  };
}

/**
 * Registers AND verifies a Telegram webhook.
 * Returns { verified: true, webhookUrl, ... } ONLY if getWebhookInfo confirms exact URL match.
 */
export async function registerAndVerifyWebhook({
  telegram,
  token,
  webhookUrl,
  secretToken,
  allowedUpdates = DEFAULT_TENANT_ALLOWED_UPDATES,
}) {
  if (!secretToken || String(secretToken).trim().length < 8) {
    throw new Error('A secure webhook secret token is required before registering a Telegram webhook.');
  }

  const setRes = await telegram.setWebhook(token, {
    url: webhookUrl,
    secretToken,
    allowedUpdates,
    dropPendingUpdates: false,
  });

  const infoRes = await telegram.getWebhookInfo(token);
  const info = sanitizeWebhookInfo(infoRes?.result || {});

  if (info.url !== webhookUrl) {
    throw new Error(
      `Webhook verification mismatch: Telegram reported "${info.url || 'empty'}" instead of "${webhookUrl}".`
    );
  }

  const verifiedAt = new Date().toISOString();

  return {
    verified: true,
    status: 'verified',
    webhookUrl: info.url,
    expectedUrl: webhookUrl,
    allowedUpdates: info.allowed_updates.length > 0 ? info.allowed_updates : allowedUpdates,
    pendingUpdateCount: info.pending_update_count,
    lastErrorMessage: info.last_error_message,
    lastErrorDate: info.last_error_date,
    maxConnections: info.max_connections,
    hasCustomCertificate: info.has_custom_certificate,
    ipAddress: info.ip_address,
    verifiedAt,
    telegramResponse: {
      setWebhookOk: Boolean(setRes?.ok),
      setWebhookDescription: setRes?.description || 'Webhook was set',
      webhookInfo: info,
    },
  };
}

/**
 * Checks current webhook health via real Telegram getWebhookInfo.
 */
export async function inspectWebhookStatus({ telegram, token, expectedUrl }) {
  const infoRes = await telegram.getWebhookInfo(token);
  const info = sanitizeWebhookInfo(infoRes?.result || {});
  const matches = Boolean(info.url && info.url === expectedUrl);
  const status = matches ? 'verified' : info.url ? 'mismatch' : 'not_registered';

  return {
    verified: matches,
    status,
    actualUrl: info.url,
    expectedUrl,
    allowedUpdates: info.allowed_updates,
    pendingUpdateCount: info.pending_update_count,
    lastErrorMessage: info.last_error_message,
    lastErrorDate: info.last_error_date,
    maxConnections: info.max_connections,
    hasCustomCertificate: info.has_custom_certificate,
    ipAddress: info.ip_address,
    checkedAt: new Date().toISOString(),
    telegramResponse: {
      ok: Boolean(infoRes?.ok),
      webhookInfo: info,
    },
  };
}

/**
 * Removes webhook cleanly when disabling or deleting a bot.
 */
export async function removeWebhook({ telegram, token }) {
  await telegram.deleteWebhook(token, false);
  return { removed: true };
}
