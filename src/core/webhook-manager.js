/**
 * Automatic Telegram Webhook Manager.
 *
 * - Builds tenant webhook URLs: https://YOUR-WORKER.workers.dev/webhook/<BOT_ID>
 * - Registers webhook via Telegram setWebhook with X-Telegram-Bot-Api-Secret-Token.
 * - Immediately verifies via getWebhookInfo before declaring a bot LIVE.
 * - Validates incoming webhook secret headers using constant-time comparison.
 */

import { timingSafeEqual } from './token-security.js';

export function buildTenantWebhookUrl(workerPublicUrl, botId) {
  if (!workerPublicUrl || !/^https:\/\/.+/i.test(workerPublicUrl.trim())) {
    throw new Error('WORKER_PUBLIC_URL must be a valid HTTPS URL (e.g. https://bot-factory.your-subdomain.workers.dev).');
  }
  const base = workerPublicUrl.trim().replace(/\/+$/, '');
  return `${base}/webhook/${botId}`;
}

export function buildMasterWebhookUrl(workerPublicUrl) {
  if (!workerPublicUrl || !/^https:\/\/.+/i.test(workerPublicUrl.trim())) {
    throw new Error('WORKER_PUBLIC_URL must be a valid HTTPS URL.');
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
 * Registers AND verifies a Telegram webhook.
 * Returns { verified: true, webhookUrl, info } ONLY if getWebhookInfo confirms exact URL match.
 */
export async function registerAndVerifyWebhook({ telegram, token, webhookUrl, secretToken }) {
  await telegram.setWebhook(token, {
    url: webhookUrl,
    secretToken,
    dropPendingUpdates: false,
  });

  const infoRes = await telegram.getWebhookInfo(token);
  const info = infoRes?.result || {};

  if (info.url !== webhookUrl) {
    throw new Error(
      `Webhook verification mismatch: Telegram reported "${info.url || 'empty'}" instead of "${webhookUrl}".`
    );
  }

  return {
    verified: true,
    webhookUrl: info.url,
    pendingUpdateCount: info.pending_update_count || 0,
    lastErrorMessage: info.last_error_message || null,
    lastErrorDate: info.last_error_date || null,
    maxConnections: info.max_connections || 40,
  };
}

/**
 * Checks current webhook health via real Telegram getWebhookInfo.
 */
export async function inspectWebhookStatus({ telegram, token, expectedUrl }) {
  const infoRes = await telegram.getWebhookInfo(token);
  const info = infoRes?.result || {};
  const matches = Boolean(info.url && info.url === expectedUrl);

  return {
    verified: matches,
    actualUrl: info.url || '',
    expectedUrl,
    pendingUpdateCount: info.pending_update_count || 0,
    lastErrorMessage: info.last_error_message || null,
    lastErrorDate: info.last_error_date || null,
  };
}

/**
 * Removes webhook cleanly when disabling or deleting a bot.
 */
export async function removeWebhook({ telegram, token }) {
  await telegram.deleteWebhook(token, false);
  return { removed: true };
}
