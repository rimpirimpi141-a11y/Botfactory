/**
 * Owner Bot Fleet Management Controller.
 * Search bots, inspect webhook health & recent errors, disable, re-enable, retry webhook, delete.
 */

import {
  deleteTenantBot,
  disableTenantBot,
  enableAndVerifyTenantBot,
  loadTenantRuntime,
} from '../core/tenant-manager.js';
import { buildTenantWebhookUrl, inspectWebhookStatus } from '../core/webhook-manager.js';

export async function listAllBots(repos, filters = {}) {
  return repos.bots.listAll(filters);
}

export async function inspectBotDetail({ env, repos, telegram, botId }) {
  const runtime = await loadTenantRuntime({ env, repos, botId });
  if (!runtime) return null;

  const { rows: recentErrors } = await repos.db.all(
    `SELECT * FROM webhook_logs WHERE bot_id = ? AND (status_code >= 400 OR error_message IS NOT NULL) ORDER BY created_at DESC LIMIT 15`,
    [botId]
  );

  let liveWebhook = null;
  try {
    const expectedUrl = buildTenantWebhookUrl(env.WORKER_PUBLIC_URL, botId);
    liveWebhook = await inspectWebhookStatus({ telegram, token: runtime.token, expectedUrl });
  } catch (err) {
    liveWebhook = { verified: false, error: err?.message || 'Unable to inspect live webhook' };
  }

  // NEVER return token_encrypted or plaintext token
  const safeBot = { ...runtime.bot };
  delete safeBot.token_encrypted;
  delete safeBot.token_hash;
  delete safeBot.webhook_secret;

  return {
    bot: safeBot,
    config: runtime.config,
    menus: runtime.menus,
    liveWebhook,
    recentErrors,
  };
}

export async function ownerDisableBot({ env, repos, telegram, botId, actorTelegramId }) {
  return disableTenantBot({ env, repos, telegram, botId, actorTelegramId });
}

export async function ownerEnableAndRetryWebhook({ env, repos, telegram, botId, actorTelegramId }) {
  return enableAndVerifyTenantBot({ env, repos, telegram, botId, actorTelegramId });
}

export async function ownerDeleteBot({ env, repos, telegram, botId, actorTelegramId }) {
  return deleteTenantBot({ env, repos, telegram, botId, actorTelegramId });
}
