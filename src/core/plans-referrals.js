/**
 * Platform-Level Plans & Referral-Based Bot Creation Limit Engine.
 *
 * STRICT BUSINESS RULES:
 * 1. Referrals ONLY increase bot creation slot limits & plan tier.
 *    Referrals NEVER lock or gate template categories — all active templates are open to everyone.
 * 2. Default Free Tier: 2 active bots (0 referrals).
 * 3. Each genuine verified referral increases bot creation limit by +1:
 *      limit = 2 + verifiedReferrals (+ any admin bonus_bot_slots)
 * 4. Milestone Plans:
 *      - FREE:       0–7 referrals   -> 2 to 9 active bots (base 2 + 1 per referral)
 *      - STARTER:    8–47 referrals  -> 10 to 49 active bots (milestone at 8 referrals = 10 slots)
 *      - PRO:        48–49 referrals -> 50 to 51 active bots (milestone at 48 referrals = 50 slots)
 *      - ENTERPRISE: 50+ referrals   -> UNLIMITED active bots (takes priority over lower milestones)
 * 5. Anti-abuse:
 *      - Unique Telegram IDs only
 *      - New users only (existing users cannot retroactively claim a referrer)
 *      - No self-referrals
 *      - No duplicate referral attribution
 *      - Obvious bot accounts (`is_bot === true`) rejected
 *      - Permanent referral attribution stored in `platform_referrals`
 * 6. Existing bots are NEVER automatically deleted if a user's limit is reduced;
 *    new bot creation is simply blocked until active bots are within limit.
 */

export const PLAN_TIERS = Object.freeze({
  free: {
    id: 'free',
    name: 'FREE',
    minReferrals: 0,
    referralsRequired: 0,
    baseBotLimit: 2,
    maxBotsLabel: '2 active bots (+1 / ref)',
    isUnlimited: false,
    badge: 'Default Tier',
    summary: '2 active bots included by default. Every verified referral adds +1 active bot slot.',
    highlights: [
      'Up to 2 active bots by default (+1 per verified referral)',
      'Core available templates (all 11 functional templates unlocked)',
      'Colourful Telegram buttons',
      'Automatic webhook verification',
      'Custom Bot Builder + Dynamic Admin Panel',
    ],
  },
  starter: {
    id: 'starter',
    name: 'STARTER',
    minReferrals: 8,
    referralsRequired: 8,
    baseBotLimit: 10,
    maxBotsLabel: '10 active bots',
    isUnlimited: false,
    badge: '8 Referrals Milestone',
    summary: 'Unlocked automatically at 8 verified referrals (10 active bot slots, continuing +1 per referral).',
    highlights: [
      'Up to 10 active bots (base 2 + 8 verified referrals)',
      'SMM and Digital Commerce capabilities',
      'Priority KV caching',
      'Independent ReplyKeyboard Admin Panel per bot',
      'UPI QR & payment proof verification workflows',
    ],
  },
  pro: {
    id: 'pro',
    name: 'PRO',
    minReferrals: 48,
    referralsRequired: 48,
    baseBotLimit: 50,
    maxBotsLabel: '50 active bots',
    isUnlimited: false,
    badge: '48 Referrals Milestone',
    summary: 'Unlocked automatically at 48 verified referrals (50 active bot slots).',
    highlights: [
      'Up to 50 active bots (base 2 + 48 verified referrals)',
      'Unlimited Custom Builder submenus (subject to abuse protection)',
      'Advanced analytics & multi-bot broadcast tools',
      'Channel automation scheduling & voucher inventory tools',
      'Full Template Studio + Dynamic Admin Panels',
    ],
  },
  enterprise: {
    id: 'enterprise',
    name: 'ENTERPRISE',
    minReferrals: 50,
    referralsRequired: 50,
    baseBotLimit: null,
    maxBotsLabel: 'Unlimited bots',
    isUnlimited: true,
    badge: '50 Referrals Milestone',
    summary: 'Unlocked automatically at 50 verified referrals — Unlimited tenant bot creation slots.',
    highlights: [
      'Unlimited tenant bots (takes priority over lower milestones)',
      'Custom domain worker routing when configured',
      'Dedicated support & full platform observability',
      'All 11 functional Template Studio categories & Custom Builder',
      'Dedicated broadcast queues & multi-admin bot control',
    ],
  },
});

export function getPlanCatalog() {
  return [PLAN_TIERS.free, PLAN_TIERS.starter, PLAN_TIERS.pro, PLAN_TIERS.enterprise];
}

/**
 * Computes authoritative plan tier & active bot creation slot entitlement.
 * Enterprise (50+ verified referrals or explicit enterprise plan) ALWAYS takes priority.
 */
export function calculatePlanEntitlement(user = {}, activeBotCount = 0, pendingReferrals = 0) {
  const verifiedReferrals = Math.max(0, Number(user?.verified_referrals || 0));
  const bonusSlots = Number(user?.bonus_bot_slots || 0);
  const storedPlan = String(user?.plan || 'free').toLowerCase();
  const isSuperAdmin = user?.role === 'super_admin';

  // Milestone resolution (50 referrals = Enterprise takes highest priority)
  let milestonePlan = 'free';
  if (verifiedReferrals >= 50) {
    milestonePlan = 'enterprise';
  } else if (verifiedReferrals >= 48) {
    milestonePlan = 'pro';
  } else if (verifiedReferrals >= 8) {
    milestonePlan = 'starter';
  }

  const planRank = { free: 0, starter: 1, pro: 2, enterprise: 3 };
  const effectivePlan =
    isSuperAdmin || (planRank[storedPlan] ?? 0) > (planRank[milestonePlan] ?? 0)
      ? isSuperAdmin
        ? 'enterprise'
        : storedPlan
      : milestonePlan;

  const isUnlimited = effectivePlan === 'enterprise' || verifiedReferrals >= 50 || isSuperAdmin;

  let botLimit = null;
  if (!isUnlimited) {
    // Base formula: 2 default + 1 per verified referral
    const referralBasedSlots = 2 + verifiedReferrals;
    // Manual admin plan upgrade guarantees at least that plan's floor
    const planFloor = PLAN_TIERS[effectivePlan]?.baseBotLimit ?? 2;
    botLimit = Math.max(0, Math.max(referralBasedSlots, planFloor) + bonusSlots);
  }

  const usedSlots = Math.max(0, Number(activeBotCount || 0));
  const remainingSlots = isUnlimited ? null : Math.max(0, botLimit - usedSlots);
  const canCreateBot = isUnlimited ? true : usedSlots < botLimit;
  const maxBotsLabel = isUnlimited ? 'Unlimited' : String(botLimit);

  let nextMilestone = null;
  if (verifiedReferrals < 8) {
    const remaining = 8 - verifiedReferrals;
    nextMilestone = {
      plan: 'STARTER',
      planLabel: 'STARTER',
      targetReferrals: 8,
      targetSlots: 10,
      remainingReferrals: remaining,
      remaining,
      reward: '10 active bot slots',
    };
  } else if (verifiedReferrals < 48) {
    const remaining = 48 - verifiedReferrals;
    nextMilestone = {
      plan: 'PRO',
      planLabel: 'PRO',
      targetReferrals: 48,
      targetSlots: 50,
      remainingReferrals: remaining,
      remaining,
      reward: '50 active bot slots',
    };
  } else if (verifiedReferrals < 50) {
    const remaining = 50 - verifiedReferrals;
    nextMilestone = {
      plan: 'ENTERPRISE',
      planLabel: 'ENTERPRISE',
      targetReferrals: 50,
      targetSlots: 'Unlimited',
      remainingReferrals: remaining,
      remaining,
      reward: 'Unlimited tenant bot slots',
    };
  }

  return {
    plan: effectivePlan,
    planLabel: PLAN_TIERS[effectivePlan]?.name || 'FREE',
    isUnlimited,
    botLimit,
    maxBots: botLimit,
    maxBotsLabel,
    bonusSlots,
    bonusBotSlots: bonusSlots,
    usedSlots,
    activeBotCount: usedSlots,
    remainingSlots,
    canCreateBot,
    verifiedReferrals,
    pendingReferrals: Math.max(0, Number(pendingReferrals || 0)),
    nextMilestone,
  };
}

/**
 * Generates a deterministic, URL-safe platform referral code for a Telegram user.
 */
export function buildUserReferralCode(telegramId) {
  const clean = String(telegramId).replace(/[^0-9a-zA-Z]/g, '');
  return `BF${clean}`;
}

/**
 * Builds the Master Bot deep-link referral URL for a user.
 * Accepts either a username string or a Cloudflare Worker `env` object.
 */
export function buildMasterReferralLink(masterBotUsernameOrEnv, referralCode) {
  const rawUsername =
    masterBotUsernameOrEnv && typeof masterBotUsernameOrEnv === 'object'
      ? masterBotUsernameOrEnv.MASTER_BOT_USERNAME
      : masterBotUsernameOrEnv;
  const username = String(rawUsername || '').replace(/^@/, '').trim();
  if (!username || username.includes('REPLACE_WITH') || !referralCode) return null;
  return `https://t.me/${username}?start=ref_${encodeURIComponent(referralCode)}`;
}

/**
 * Attributes a platform-level referral with strict anti-abuse enforcement.
 * Only triggers for brand-new platform users arriving via `/start ref_<CODE>`.
 */
export async function attributePlatformReferral({
  repos,
  rawReferralCode,
  referrerCode,
  referredTgUser,
  referredUser,
  isNewUser,
}) {
  const code = String(rawReferralCode ?? referrerCode ?? '').trim().replace(/^ref_/i, '');
  if (!code) return { attributed: false, reason: 'Empty referral code.' };

  const targetUser = referredTgUser || referredUser;
  if (!targetUser || (!targetUser.id && !targetUser.telegram_id)) {
    return { attributed: false, reason: 'Referred Telegram user identity is required.' };
  }

  if (targetUser?.is_bot) {
    return { attributed: false, reason: 'Bot accounts are not eligible for referrals.' };
  }

  const referredTelegramId = String(targetUser.id ?? targetUser.telegram_id);
  if (!isNewUser) {
    return { attributed: false, reason: 'Only brand-new BOT FACTORY users can be attributed to a referrer.' };
  }

  const referrer = await repos.users.getByReferralCode(code);
  if (!referrer) {
    return { attributed: false, reason: 'Referral link is invalid or referrer was not found.' };
  }

  if (String(referrer.telegram_id) === referredTelegramId) {
    return { attributed: false, reason: 'Self-referrals are not permitted.' };
  }

  if (referrer.status === 'banned' || referrer.status === 'suspended') {
    return { attributed: false, reason: 'Referrer account is currently restricted.' };
  }

  const existing = await repos.platformReferrals.getByReferred(referredTelegramId);
  if (existing) {
    return { attributed: false, reason: 'This user has already been attributed permanently.' };
  }

  const record = await repos.platformReferrals.createVerified({
    referrerTelegramId: referrer.telegram_id,
    referredTelegramId,
  });

  const updatedReferrer = await repos.users.syncReferralMetrics(referrer.telegram_id);
  const activeBots = await repos.users.countActiveBots(referrer.telegram_id);
  const entitlement = calculatePlanEntitlement(updatedReferrer, activeBots);

  return {
    attributed: true,
    referral: record,
    referrer: updatedReferrer,
    entitlement,
  };
}
