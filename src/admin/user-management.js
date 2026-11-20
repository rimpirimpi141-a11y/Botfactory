/**
 * Owner User Management Controller.
 * Search users, inspect profile + bots, update subscription plan, suspend or restore accounts.
 */

import { writeSystemLog } from '../utils/logger.js';

export async function listUsers(repos, filters = {}) {
  return repos.users.search(filters);
}

export async function getUserProfileDetail(repos, telegramId) {
  const user = await repos.users.getByTelegramId(telegramId);
  if (!user) return null;
  const bots = await repos.bots.listByOwner(telegramId);
  const { rows: logs } = await repos.db.all(
    `SELECT id, level, source, message, created_at FROM system_logs WHERE actor_telegram_id = ? ORDER BY created_at DESC LIMIT 15`,
    [String(telegramId)]
  );
  return { user, bots, recentActivity: logs };
}

export async function changeUserPlan({ env, repos, telegramId, plan, actorTelegramId }) {
  if (!['free', 'starter', 'pro', 'enterprise'].includes(plan)) {
    throw new Error('Invalid subscription plan.');
  }
  const updated = await repos.users.updatePlanAndStatus(telegramId, { plan });
  await writeSystemLog(env, {
    level: 'audit',
    source: 'user-management',
    message: `Updated user ${telegramId} plan to ${plan}`,
    metadata: { telegramId, plan },
    actorTelegramId,
  });
  return updated;
}

export async function setUserSuspension({ env, repos, telegramId, suspend, actorTelegramId }) {
  const nextStatus = suspend ? 'suspended' : 'active';
  const updated = await repos.users.updatePlanAndStatus(telegramId, { status: nextStatus });
  await writeSystemLog(env, {
    level: 'security',
    source: 'user-management',
    message: `${suspend ? 'Suspended' : 'Restored'} user account ${telegramId}`,
    metadata: { telegramId, status: nextStatus },
    actorTelegramId,
  });
  return updated;
}
