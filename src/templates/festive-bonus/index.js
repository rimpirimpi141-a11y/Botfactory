/**
 * TEMPLATE: FESTIVE BONUS BOT (Configurable Seasonal / Event Bonus Campaign)
 *
 * - Fully configurable campaign fields (no hardcoded single festival):
 *     * campaignName
 *     * welcomeMessage
 *     * rewardAmount & currencyLabel
 *     * minReferrals
 *     * forceJoinChannels (verified via Telegram getChatMember)
 *     * startDate / endDate (ISO dates enforced on claim)
 *     * maxClaimsPerUser (enforced via transactions table)
 * - Dedicated ReplyKeyboard Tenant Admin Panel with live Campaign Editor
 */

import { formatBrandedMessage } from '../../builder/theme-engine.js';
import { buildReplyKeyboard, BUTTON_STYLES } from '../../utils/keyboards.js';
import { escapeHtml } from '../../utils/validation.js';
import { invalidateTenantCache } from '../../core/tenant-manager.js';
import { checkUserForceJoin, formatDestinationLabel } from '../../core/force-join.js';
import {
  ADMIN_COMMON_LABELS,
  buildCancelReplyKeyboard,
  buildTenantAdminReplyKeyboard,
  handleCommonTenantAdmin,
} from '../shared/tenant-admin.js';

export const FESTIVE_BONUS_META = {
  id: 'tpl_festive_bonus',
  slug: 'festive-bonus',
  name: 'Festive Bonus Bot',
  category: 'Campaigns & Giveaways',
};

const ADMIN_EXTRA_BUTTONS = [
  { text: '🎉 Configure Campaign', style: BUTTON_STYLES.SUCCESS },
  { text: '📊 Campaign Summary', style: BUTTON_STYLES.PRIMARY },
];

function buildUserKeyboard(isAdmin = false) {
  const rows = [
    [
      { text: '🎁 Claim Festive Bonus', style: BUTTON_STYLES.SUCCESS },
      { text: '👥 Referral Progress', style: BUTTON_STYLES.PRIMARY },
    ],
    [
      { text: '✅ Check Eligibility', style: BUTTON_STYLES.PRIMARY },
      { text: '📜 Claim History', style: BUTTON_STYLES.PRIMARY },
    ],
    [{ text: '🎧 Support', style: BUTTON_STYLES.PRIMARY }],
  ];
  if (isAdmin) {
    rows.push([{ text: ADMIN_COMMON_LABELS.OPEN_ADMIN, style: BUTTON_STYLES.DANGER }]);
  }
  return buildReplyKeyboard(rows, { resize: true, persistent: true });
}

export async function handleFestiveBonusUpdate(ctx) {
  const { env, bot, config, token, telegram, repos, update, endUser, isAdmin } = ctx;
  const userKb = buildUserKeyboard(isAdmin);
  const adminKb = buildTenantAdminReplyKeyboard(ADMIN_EXTRA_BUTTONS);
  const settings = config.templateSettings || {};
  const campaignName = settings.campaignName || config.brandTitle || 'Festive Bonus Campaign';
  const rewardAmount = Number(settings.rewardAmount ?? 50);
  const currency = settings.currencyLabel || 'Points';
  const minReferrals = Number(settings.minReferrals ?? 0);
  const maxClaimsPerUser = Math.max(1, Number(settings.maxClaimsPerUser ?? 1));
  const startDate = settings.startDate || '';
  const endDate = settings.endDate || '';

  const msg = update.message;
  if (!msg) return;
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const state = safeParse(endUser.state_json);

  const handledAdmin = await handleCommonTenantAdmin(ctx, {
    panelTitle: `${campaignName} Admin`,
    extraButtons: ADMIN_EXTRA_BUTTONS,
    userKeyboard: userKb,
    extraStatsSummary: async () => {
      const { row } = await repos.db.first(
        `SELECT COUNT(*) AS claims, COALESCE(SUM(amount), 0) AS distributed
         FROM transactions WHERE bot_id = ? AND tx_type = 'reward' AND reference_id = 'festive_bonus'`,
        [bot.id]
      );
      return `• Campaign: <b>${escapeHtml(campaignName)}</b>\n• Claims Issued: <b>${Number(row?.claims || 0)}</b> (${Number(row?.distributed || 0)} ${escapeHtml(currency)})`;
    },
  });
  if (handledAdmin) return;

  if (text.startsWith('/start')) {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
    const startArg = text.split(/\s+/)[1] || '';
    if (startArg && ctx.isNewUser) {
      const referrer = await repos.endUsers.getByReferralCode(bot.id, startArg);
      if (referrer) {
        await repos.endUsers.recordReferral(bot.id, referrer.telegram_id, endUser.telegram_id, 0);
      }
    }
    await telegram.sendMessage(
      token,
      chatId,
      formatBrandedMessage(config, {
        heading: `🎉 ${campaignName}`,
        body: [
          config.welcomeMessage || `Welcome to ${campaignName}! Complete the eligibility checklist to claim your festive bonus.`,
          `\n• Bonus Reward: <b>${rewardAmount} ${escapeHtml(currency)}</b>`,
          `• Required Referrals: <b>${minReferrals}</b> (Yours: <b>${Number(endUser.referral_count || 0)}</b>)`,
          startDate || endDate ? `• Window: <b>${escapeHtml(startDate || 'Now')}</b> to <b>${escapeHtml(endDate || 'Open')}</b>` : null,
        ]
          .filter(Boolean)
          .join('\n'),
      }),
      { reply_markup: userKb }
    );
    return;
  }

  // Admin: update campaign configuration -> CampaignName | Reward | MinRefs | MaxClaims | StartDate(YYYY-MM-DD) | EndDate(YYYY-MM-DD)
  if (isAdmin && state?.step === 'fest_adm_config' && !text.startsWith('/')) {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
    const [cName, rStr, minRefStr, maxCStr, sDate, eDate] = text.split('|').map((s) => (s || '').trim());
    const nextReward = Number(rStr);
    if (!cName || !Number.isFinite(nextReward) || nextReward <= 0) {
      await telegram.sendMessage(
        token,
        chatId,
        '❌ Format:\n<code>Campaign Name | RewardAmount | MinReferrals | MaxClaims | StartDate(YYYY-MM-DD or -) | EndDate(YYYY-MM-DD or -)</code>',
        { reply_markup: adminKb }
      );
      return;
    }
    const nextSettings = {
      ...settings,
      campaignName: cName,
      rewardAmount: nextReward,
      minReferrals: Math.max(0, Math.trunc(Number(minRefStr) || 0)),
      maxClaimsPerUser: Math.max(1, Math.trunc(Number(maxCStr) || 1)),
      startDate: sDate && sDate !== '-' ? sDate : '',
      endDate: eDate && eDate !== '-' ? eDate : '',
    };
    await repos.botConfigs.upsert(bot.id, { ...config, templateSettings: nextSettings });
    await invalidateTenantCache(env, bot.id);
    await telegram.sendMessage(
      token,
      chatId,
      `✅ <b>Campaign Updated!</b>\n• Name: <b>${escapeHtml(cName)}</b>\n• Reward: <b>${nextReward} ${escapeHtml(currency)}</b>\n• Min Referrals: <b>${nextSettings.minReferrals}</b>\n• Max Claims/User: <b>${nextSettings.maxClaimsPerUser}</b>\n• Window: <b>${escapeHtml(nextSettings.startDate || 'Immediate')}</b> -> <b>${escapeHtml(nextSettings.endDate || 'Open')}</b>`,
      { reply_markup: adminKb }
    );
    return;
  }

  // Admin ReplyKeyboard actions
  if (isAdmin && text === '🎉 Configure Campaign') {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, { scope: 'tenant_admin', step: 'fest_adm_config' });
    await telegram.sendMessage(
      token,
      chatId,
      `<b>🎉 Configure Festive Campaign</b>\nCurrent: <b>${escapeHtml(campaignName)}</b> (${rewardAmount} ${escapeHtml(currency)}, ${minReferrals} refs)\n\nSend:\n<code>Campaign Name | RewardAmount | MinReferrals | MaxClaims | StartDate(YYYY-MM-DD or -) | EndDate(YYYY-MM-DD or -)</code>`,
      { reply_markup: buildCancelReplyKeyboard() }
    );
    return;
  }

  if (isAdmin && text === '📊 Campaign Summary') {
    const { row } = await repos.db.first(
      `SELECT COUNT(*) AS claims, COALESCE(SUM(amount), 0) AS total_reward FROM transactions WHERE bot_id = ? AND tx_type = 'reward' AND reference_id = 'festive_bonus'`,
      [bot.id]
    );
    await telegram.sendMessage(
      token,
      chatId,
      formatBrandedMessage(config, {
        heading: `📊 ${campaignName}`,
        body: [
          `• Reward per Claim: <b>${rewardAmount} ${escapeHtml(currency)}</b>`,
          `• Referral Requirement: <b>${minReferrals}</b>`,
          `• Max Claims/User: <b>${maxClaimsPerUser}</b>`,
          `• Start Date: <b>${escapeHtml(startDate || 'Immediate')}</b>`,
          `• End Date: <b>${escapeHtml(endDate || 'No End Date')}</b>`,
          `• Total Claims Distributed: <b>${Number(row?.claims || 0)}</b> (${Number(row?.total_reward || 0)} ${escapeHtml(currency)})`,
        ].join('\n'),
      }),
      { reply_markup: adminKb }
    );
    return;
  }

  // User actions
  switch (text) {
    case '✅ Check Eligibility': {
      const check = await evaluateCampaignEligibility({ repos, telegram, token, bot, config, endUser });
      await telegram.sendMessage(
        token,
        chatId,
        formatBrandedMessage(config, {
          heading: '✅ Campaign Eligibility Check',
          body: check.eligible
            ? `🎉 You are <b>ELIGIBLE</b> to claim <b>${rewardAmount} ${escapeHtml(currency)}</b>!\nTap <b>🎁 Claim Festive Bonus</b> below.`
            : `⚠️ <b>Not Yet Eligible:</b>\n${check.reasons.map((r) => `• ${escapeHtml(r)}`).join('\n')}`,
        }),
        { reply_markup: userKb }
      );
      return;
    }

    case '🎁 Claim Festive Bonus': {
      const check = await evaluateCampaignEligibility({ repos, telegram, token, bot, config, endUser });
      if (!check.eligible) {
        await telegram.sendMessage(
          token,
          chatId,
          `❌ <b>Cannot Claim Yet</b>\n${check.reasons.map((r) => `• ${escapeHtml(r)}`).join('\n')}`,
          { reply_markup: userKb }
        );
        return;
      }

      const newBalance = await repos.endUsers.adjustPoints(bot.id, endUser.telegram_id, {
        delta: rewardAmount,
        txType: 'reward',
        referenceId: 'festive_bonus',
        description: `${campaignName} bonus claim`,
      });

      await telegram.sendMessage(
        token,
        chatId,
        `🎉 <b>Festive Bonus Claimed!</b>\nCampaign: <b>${escapeHtml(campaignName)}</b>\nReward: <b>+${rewardAmount} ${escapeHtml(currency)}</b>\nNew Balance: <b>${newBalance} ${escapeHtml(currency)}</b>`,
        { reply_markup: userKb }
      );
      return;
    }

    case '👥 Referral Progress': {
      const link = `https://t.me/${bot.telegram_username}?start=${endUser.referral_code}`;
      await telegram.sendMessage(
        token,
        chatId,
        formatBrandedMessage(config, {
          heading: '👥 Campaign Referral Progress',
          body: `• Your Referrals: <b>${Number(endUser.referral_count || 0)}</b> / <b>${minReferrals}</b> required\n• Share Link: <code>${escapeHtml(link)}</code>`,
        }),
        { reply_markup: userKb }
      );
      return;
    }

    case '📜 Claim History': {
      const { rows } = await repos.db.all(
        `SELECT amount, description, created_at FROM transactions
         WHERE bot_id = ? AND user_telegram_id = ? AND tx_type = 'reward' AND reference_id = 'festive_bonus'
         ORDER BY created_at DESC LIMIT 10`,
        [bot.id, endUser.telegram_id]
      );
      const body = rows.length
        ? rows.map((r) => `• +<b>${r.amount} ${escapeHtml(currency)}</b> — ${escapeHtml(r.description)}`).join('\n')
        : '<i>No festive bonus claims yet.</i>';
      await telegram.sendMessage(token, chatId, formatBrandedMessage(config, { heading: '📜 Bonus Claim History', body }), {
        reply_markup: userKb,
      });
      return;
    }

    case '🎧 Support': {
      await telegram.sendMessage(
        token,
        chatId,
        formatBrandedMessage(config, {
          heading: '🎧 Campaign Support',
          body: config.supportUsername ? `Reach support at ${escapeHtml(config.supportUsername)}.` : 'Support not configured.',
        }),
        { reply_markup: userKb }
      );
    }
  }
}

export function evaluateCampaignEligibility(params) {
  if (params && params.campaign && !params.repos) {
    const { campaign, userReferralCount = 0, totalClaims = 0, alreadyClaimed = false, now: nowArg } = params;
    const reasons = [];
    const now = nowArg ? new Date(nowArg).getTime() : Date.now();
    if (campaign.startDate && new Date(campaign.startDate).getTime() > now) {
      reasons.push(`Campaign has not started yet (starts ${campaign.startDate}).`);
    }
    if (campaign.endDate) {
      const endTs = String(campaign.endDate).includes('T')
        ? new Date(campaign.endDate).getTime()
        : new Date(`${campaign.endDate}T23:59:59Z`).getTime();
      if (endTs < now) {
        reasons.push(`Campaign has ended (ended ${campaign.endDate}).`);
      }
    }
    const minRefs = Number(campaign.minReferrals ?? 0);
    if (Number(userReferralCount) < minRefs) {
      reasons.push(`Requires ${minRefs} referrals (you have ${Number(userReferralCount)}).`);
    }
    if (campaign.maxClaims && Number(totalClaims) >= Number(campaign.maxClaims)) {
      reasons.push('Campaign total claim cap has been reached.');
    }
    if (alreadyClaimed) {
      reasons.push('You have already claimed this campaign bonus.');
    }
    return { eligible: reasons.length === 0, reason: reasons[0] || null, reasons };
  }

  return evaluateCampaignEligibilityAsync(params);
}

async function evaluateCampaignEligibilityAsync({ repos, telegram, token, bot, config, endUser, now: nowArg }) {
  const settings = config?.templateSettings || {};
  const minReferrals = Number(settings.minReferrals ?? 0);
  const maxClaimsPerUser = Math.max(1, Number(settings.maxClaimsPerUser ?? 1));
  const startDate = settings.startDate || '';
  const endDate = settings.endDate || '';
  const channels = Array.isArray(config?.forceJoinChannels) ? config.forceJoinChannels : [];

  const reasons = [];
  const now = nowArg ? new Date(nowArg).getTime() : Date.now();
  if (startDate && new Date(startDate).getTime() > now) {
    reasons.push(`Campaign has not started yet (starts ${startDate}).`);
  }
  if (endDate) {
    const endTs = endDate.includes('T') ? new Date(endDate).getTime() : new Date(`${endDate}T23:59:59Z`).getTime();
    if (endTs < now) {
      reasons.push(`Campaign has ended (ended ${endDate}).`);
    }
  }
  if (Number(endUser.referral_count || 0) < minReferrals) {
    reasons.push(`Requires ${minReferrals} referrals (you have ${Number(endUser.referral_count || 0)}).`);
  }

  const { row: claimsRow } = await repos.db.first(
    `SELECT COUNT(*) AS cnt FROM transactions WHERE bot_id = ? AND user_telegram_id = ? AND tx_type = 'reward' AND reference_id = 'festive_bonus'`,
    [bot.id, endUser.telegram_id]
  );
  if (Number(claimsRow?.cnt || 0) >= maxClaimsPerUser) {
    reasons.push(`You have already reached the claim limit (${maxClaimsPerUser}).`);
  }

  if (channels.length > 0) {
    const fjCheck = await checkUserForceJoin({
      telegram,
      token,
      destinations: channels,
      userId: endUser.telegram_id,
    });
    if (!fjCheck.passed) {
      for (const missingDest of fjCheck.missing) {
        reasons.push(`Please join required channel/group ${formatDestinationLabel(missingDest)}.`);
      }
    }
  }

  return { eligible: reasons.length === 0, reason: reasons[0] || null, reasons };
}

function safeParse(str) {
  if (!str) return null;
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}
