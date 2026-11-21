/**
 * TEMPLATE 1: REFER & EARN BOT
 *
 * Points-based referral & engagement system with:
 * - Unique referral deep links & strict anti-self-referral / duplicate protection
 * - Daily bonus with configurable cooldown (hours)
 * - Giftcodes with expiry & max usage limits
 * - Manual admin-reviewed withdrawal requests (no real-money custody / no auto payouts)
 * - Referral leaderboard & transaction history
 * - Force-join channel verification via real Telegram getChatMember
 * - Full User + Admin colourful native Telegram keyboards
 */

import { formatBrandedMessage } from '../../builder/theme-engine.js';
import {
  buildApprovalButtons,
  buildInlineKeyboard,
  buildReplyKeyboard,
  BUTTON_STYLES,
  inlineButton,
} from '../../utils/keyboards.js';
import { newId } from '../../database/repositories.js';
import { escapeHtml } from '../../utils/validation.js';
import {
  ADMIN_COMMON_LABELS,
  buildCancelReplyKeyboard,
  buildTenantAdminReplyKeyboard,
  handleCommonTenantAdmin,
} from '../shared/tenant-admin.js';
import { invalidateTenantCache } from '../../core/tenant-manager.js';
import {
  buildForceJoinGateKeyboard,
  checkUserForceJoin,
  formatDestinationLabel,
  normalizeForceJoinList,
  resolveAndVerifyForceJoinDestination,
  upsertForceJoinDestination,
} from '../../core/force-join.js';

export const REFER_EARN_META = {
  id: 'tpl_refer_earn',
  slug: 'refer-earn',
  name: 'Refer & Earn Cash Bot',
  category: 'Growth & Rewards',
};

const ADMIN_EXTRA_BUTTONS = [
  { text: '💸 Manage Withdrawals', style: BUTTON_STYLES.DANGER },
  { text: '🎟 Create Giftcode', style: BUTTON_STYLES.SUCCESS },
  { text: '🎁 Bonus & Referral Rules', style: BUTTON_STYLES.PRIMARY },
  { text: '💰 Adjust User Balance', style: BUTTON_STYLES.SUCCESS },
];

function buildUserKeyboard(isAdmin = false) {
  const rows = [
    [
      { text: '💰 My Balance', style: BUTTON_STYLES.SUCCESS },
      { text: '👥 Refer & Earn', style: BUTTON_STYLES.PRIMARY },
    ],
    [
      { text: '🎁 Daily Bonus', style: BUTTON_STYLES.SUCCESS },
      { text: '🎟 Redeem Giftcode', style: BUTTON_STYLES.PRIMARY },
    ],
    [
      { text: '💸 Withdrawal Request', style: BUTTON_STYLES.PRIMARY },
      { text: '📊 My Statistics', style: BUTTON_STYLES.PRIMARY },
    ],
    [
      { text: '🏆 Leaderboard', style: BUTTON_STYLES.PRIMARY },
      { text: '📢 Join Channels', style: BUTTON_STYLES.SUCCESS },
    ],
    [{ text: '❓ Help', style: BUTTON_STYLES.PRIMARY }],
  ];
  if (isAdmin) {
    rows.push([{ text: ADMIN_COMMON_LABELS.OPEN_ADMIN, style: BUTTON_STYLES.DANGER }]);
  }
  return buildReplyKeyboard(rows, { resize: true, persistent: true });
}

function buildAdminKeyboard() {
  return buildTenantAdminReplyKeyboard(ADMIN_EXTRA_BUTTONS);
}

async function checkForceJoin({ telegram, token, channels = [], userId }) {
  const res = await checkUserForceJoin({
    telegram,
    token,
    destinations: channels,
    userId,
  });
  return { joined: res.passed, missing: res.missing, results: res.results };
}

export async function handleReferEarnUpdate(ctx) {
  const { bot, config, token, telegram, repos, update, endUser, isNewUser, isAdmin } = ctx;
  const settings = {
    referralReward: 25,
    dailyBonus: 10,
    dailyBonusCooldownHours: 24,
    minWithdrawalPoints: 100,
    currencyLabel: 'Points',
    ...(config.templateSettings || {}),
  };

  if (update.callback_query) {
    return handleCallback(ctx, settings);
  }

  const msg = update.message;
  if (!msg) return;
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const userState = endUser.state_json ? safeParse(endUser.state_json) : null;
  const userKb = buildUserKeyboard(isAdmin);
  const adminKb = buildAdminKeyboard();

  // Native ReplyKeyboard Common Tenant Admin Panel
  const handledCommon = await handleCommonTenantAdmin(ctx, {
    panelTitle: 'Refer & Earn Admin Panel',
    extraButtons: ADMIN_EXTRA_BUTTONS,
    userKeyboard: userKb,
    extraStatsSummary: async () => {
      const { row } = await repos.db.first(
        `SELECT COUNT(*) AS pending FROM withdrawal_requests WHERE bot_id = ? AND status = 'pending'`,
        [bot.id]
      );
      return `• Pending Payout Requests: <b>${Number(row?.pending || 0)}</b>`;
    },
  });
  if (handledCommon) return;

  // Template-specific Admin ReplyKeyboard shortcuts
  if (isAdmin && text === '💸 Manage Withdrawals') {
    const { rows } = await repos.db.all(
      `SELECT * FROM withdrawal_requests WHERE bot_id = ? AND status = 'pending' ORDER BY created_at ASC LIMIT 8`,
      [bot.id]
    );
    if (!rows.length) {
      await telegram.sendMessage(token, chatId, '✅ No pending withdrawal requests.', { reply_markup: adminKb });
      return;
    }
    for (const w of rows) {
      await telegram.sendMessage(
        token,
        chatId,
        `💸 <b>Withdrawal</b> <code>${w.id}</code>\nUser: <code>${w.user_telegram_id}</code>\nAmount: <b>${w.amount} ${escapeHtml(settings.currencyLabel)}</b>\nDestination: <code>${escapeHtml(w.payout_details)}</code>`,
        {
          reply_markup: buildApprovalButtons(
            `re:wdr:approve:${w.id}`,
            `re:wdr:reject:${w.id}`,
            '✅ Approve Payout',
            '❌ Reject & Refund'
          ),
        }
      );
    }
    return;
  }

  if (isAdmin && text === '🎟 Create Giftcode') {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, { step: 'adm_create_giftcode' });
    await telegram.sendMessage(
      token,
      chatId,
      '🎟 Send giftcode details:\n<code>CODE | RewardAmount | MaxUses | OptionalExpiry(YYYY-MM-DD or days)</code>',
      { reply_markup: buildCancelReplyKeyboard() }
    );
    return;
  }

  if (isAdmin && text === '🎁 Bonus & Referral Rules') {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, { step: 'adm_set_daily' });
    await telegram.sendMessage(
      token,
      chatId,
      `<b>🎁 Bonus & Referral Settings</b>\n• Daily Bonus: <b>${settings.dailyBonus}</b> every <b>${settings.dailyBonusCooldownHours}h</b>\n• Referral Reward: <b>${settings.referralReward}</b>\n• Min Withdrawal: <b>${settings.minWithdrawalPoints}</b>\n\nSend <code>DailyBonus | CooldownHours</code> (or just a number for Daily Bonus):`,
      { reply_markup: buildCancelReplyKeyboard() }
    );
    return;
  }

  if (isAdmin && text === '💰 Adjust User Balance') {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, { step: 'adm_adjust_points' });
    await telegram.sendMessage(
      token,
      chatId,
      '💰 Send: <code>USER_TELEGRAM_ID | +/-AMOUNT | Optional Reason</code>',
      { reply_markup: buildCancelReplyKeyboard() }
    );
    return;
  }

  // Handle /start with optional referral deep link
  if (text === '/start' || text.startsWith('/start ')) {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
    const startArg = text.split(/\s+/)[1] || '';

    let referralBanner = '';
    if (isNewUser && startArg) {
      const referrer = await repos.endUsers.getByReferralCode(bot.id, startArg);
      if (referrer) {
        const res = await repos.endUsers.recordReferral(
          bot.id,
          referrer.telegram_id,
          endUser.telegram_id,
          settings.referralReward
        );
        if (res.credited) {
          referralBanner = `\n\n🎉 Referral verified! Your inviter received <b>+${settings.referralReward} ${escapeHtml(settings.currencyLabel)}</b>.`;
          await telegram
            .sendMessage(
              token,
              referrer.telegram_id,
              `🎉 <b>New Referral Credited!</b>\nYou earned <b>+${settings.referralReward} ${escapeHtml(settings.currencyLabel)}</b>.\nNew Balance: <b>${res.newBalance}</b>`
            )
            .catch(() => {});
        }
      }
    }

    const forceCheck = await checkForceJoin({
      telegram,
      token,
      channels: config.forceJoinChannels,
      userId: endUser.telegram_id,
    });
    if (!forceCheck.joined && !isAdmin) {
      const missingLines = forceCheck.missing
        .map((d) => `• <b>${escapeHtml(formatDestinationLabel(d))}</b>`)
        .join('\n');
      await telegram.sendMessage(
        token,
        chatId,
        formatBrandedMessage(config, {
          heading: '📢 Channel Membership Required',
          body: `Please join the required channels/groups below to unlock all features, then tap <b>Verify Membership</b>:\n\n${missingLines}`,
        }),
        { reply_markup: buildForceJoinGateKeyboard(forceCheck.missing, 're:verify_join') }
      );
      return;
    }

    const body = `${config.welcomeMessage || 'Welcome to our Refer & Earn platform!'}${referralBanner}\n\n💰 Current Balance: <b>${Number(endUser.points_balance || 0)} ${escapeHtml(settings.currencyLabel)}</b>`;
    await telegram.sendMessage(token, chatId, formatBrandedMessage(config, { heading: 'Main Menu', body }), {
      reply_markup: buildUserKeyboard(isAdmin),
    });
    return;
  }

  // Handle conversational multi-step states
  if (userState && !text.startsWith('/')) {
    const handled = await handleStatefulInput(ctx, settings, userState, text);
    if (handled) return;
  }

  switch (text) {
    case '💰 My Balance': {
      const { rows: txs } = await repos.db.all(
        `SELECT tx_type, amount, balance_after, created_at FROM transactions WHERE bot_id = ? AND user_telegram_id = ? ORDER BY created_at DESC LIMIT 5`,
        [bot.id, endUser.telegram_id]
      );
      const txLines =
        txs.length > 0
          ? txs.map((t) => `• ${escapeHtml(t.tx_type)}: <b>${t.amount >= 0 ? '+' : ''}${t.amount}</b> (${String(t.created_at).slice(0, 10)})`).join('\n')
          : '<i>No transactions recorded yet.</i>';
      await telegram.sendMessage(
        token,
        chatId,
        formatBrandedMessage(config, {
          heading: '💰 My Balance',
          body: `Current Balance: <b>${Number(endUser.points_balance || 0)} ${escapeHtml(settings.currencyLabel)}</b>\nMinimum Withdrawal: <b>${settings.minWithdrawalPoints} ${escapeHtml(settings.currencyLabel)}</b>\n\n<b>Recent Ledger:</b>\n${txLines}`,
        }),
        { reply_markup: buildUserKeyboard(isAdmin) }
      );
      return;
    }

    case '👥 Refer & Earn': {
      const link = `https://t.me/${bot.telegram_username}?start=${endUser.referral_code}`;
      await telegram.sendMessage(
        token,
        chatId,
        formatBrandedMessage(config, {
          heading: '👥 Refer & Earn',
          body: [
            `Earn <b>${settings.referralReward} ${escapeHtml(settings.currencyLabel)}</b> for every verified new user who starts the bot using your link.`,
            '',
            `🔗 <b>Your Unique Referral Link:</b>`,
            `<code>${escapeHtml(link)}</code>`,
            '',
            `👥 Total Verified Referrals: <b>${Number(endUser.referral_count || 0)}</b>`,
            `<i>Self-referrals and duplicate accounts are automatically blocked.</i>`,
          ].join('\n'),
        }),
        {
          reply_markup: buildInlineKeyboard([
            [
              inlineButton({
                text: '📤 Share Referral Link',
                url: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(`Join ${config.brandTitle} and start earning rewards!`)}`,
                style: BUTTON_STYLES.SUCCESS,
              }),
            ],
          ]),
        }
      );
      return;
    }

    case '🎁 Daily Bonus': {
      const cooldownMs = Number(settings.dailyBonusCooldownHours || 24) * 3600 * 1000;
      const lastClaim = endUser.last_daily_bonus_at ? Date.parse(endUser.last_daily_bonus_at) : 0;
      const nowMs = Date.now();
      if (lastClaim && nowMs - lastClaim < cooldownMs) {
        const remainingMin = Math.ceil((cooldownMs - (nowMs - lastClaim)) / 60000);
        const hrs = Math.floor(remainingMin / 60);
        const mins = remainingMin % 60;
        await telegram.sendMessage(
          token,
          chatId,
          formatBrandedMessage(config, {
            heading: '⏳ Daily Bonus Cooldown',
            body: `You already claimed your daily bonus. Come back in <b>${hrs}h ${mins}m</b>.`,
          })
        );
        return;
      }

      const nowIso = new Date(nowMs).toISOString();
      await repos.db.run(
        `UPDATE bot_end_users SET last_daily_bonus_at = ? WHERE bot_id = ? AND telegram_id = ?`,
        [nowIso, bot.id, endUser.telegram_id]
      );
      const nextBalance = await repos.endUsers.adjustPoints(bot.id, endUser.telegram_id, {
        delta: Number(settings.dailyBonus),
        txType: 'daily_bonus',
        description: 'Daily bonus claim',
      });
      await telegram.sendMessage(
        token,
        chatId,
        formatBrandedMessage(config, {
          heading: '🎁 Daily Bonus Claimed!',
          body: `You received <b>+${settings.dailyBonus} ${escapeHtml(settings.currencyLabel)}</b>.\nNew Balance: <b>${nextBalance} ${escapeHtml(settings.currencyLabel)}</b>`,
        })
      );
      return;
    }

    case '🎟 Redeem Giftcode': {
      await repos.endUsers.setState(bot.id, endUser.telegram_id, { step: 'await_giftcode' });
      await telegram.sendMessage(
        token,
        chatId,
        formatBrandedMessage(config, {
          heading: '🎟 Redeem Giftcode',
          body: 'Send your giftcode now (for example: <code>WELCOME50</code>).\nSend /start to cancel.',
        })
      );
      return;
    }

    case '💸 Withdrawal Request': {
      const bal = Number(endUser.points_balance || 0);
      if (bal < Number(settings.minWithdrawalPoints)) {
        await telegram.sendMessage(
          token,
          chatId,
          formatBrandedMessage(config, {
            heading: '💸 Withdrawal Request',
            body: `Minimum points required: <b>${settings.minWithdrawalPoints} ${escapeHtml(settings.currencyLabel)}</b>.\nYour current balance: <b>${bal} ${escapeHtml(settings.currencyLabel)}</b>.`,
          })
        );
        return;
      }
      await repos.endUsers.setState(bot.id, endUser.telegram_id, { step: 'await_withdraw_amount' });
      await telegram.sendMessage(
        token,
        chatId,
        formatBrandedMessage(config, {
          heading: '💸 New Withdrawal Request',
          body: `Available Balance: <b>${bal} ${escapeHtml(settings.currencyLabel)}</b>\n\nEnter the amount of points to request (min ${settings.minWithdrawalPoints}):\n<i>Note: All withdrawal requests are reviewed manually by authorized bot admins.</i>`,
        })
      );
      return;
    }

    case '📊 My Statistics': {
      const { row: wStats } = await repos.db.first(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'approved' THEN amount ELSE 0 END) AS approved_sum
         FROM withdrawal_requests WHERE bot_id = ? AND user_telegram_id = ?`,
        [bot.id, endUser.telegram_id]
      );
      await telegram.sendMessage(
        token,
        chatId,
        formatBrandedMessage(config, {
          heading: '📊 My Statistics',
          body: [
            `• <b>Balance:</b> ${Number(endUser.points_balance || 0)} ${escapeHtml(settings.currencyLabel)}`,
            `• <b>Verified Referrals:</b> ${Number(endUser.referral_count || 0)}`,
            `• <b>Withdrawal Requests:</b> ${Number(wStats?.total || 0)}`,
            `• <b>Approved Total:</b> ${Number(wStats?.approved_sum || 0)} ${escapeHtml(settings.currencyLabel)}`,
            `• <b>Member Since:</b> ${escapeHtml(String(endUser.joined_at || '').slice(0, 10))}`,
          ].join('\n'),
        })
      );
      return;
    }

    case '🏆 Leaderboard': {
      const leaders = await repos.endUsers.leaderboard(bot.id, 10);
      const lines =
        leaders.length > 0
          ? leaders
              .map(
                (u, i) =>
                  `${i + 1}. <b>${escapeHtml(u.first_name || u.username || `User ${u.telegram_id.slice(-4)}`)}</b> — ${u.referral_count} refs · ${u.points_balance} pts`
              )
              .join('\n')
          : '<i>No leaderboard entries yet.</i>';
      await telegram.sendMessage(
        token,
        chatId,
        formatBrandedMessage(config, { heading: '🏆 Top Referrers', body: lines })
      );
      return;
    }

    case '📢 Join Channels': {
      const channels = config.forceJoinChannels || [];
      if (channels.length === 0) {
        await telegram.sendMessage(
          token,
          chatId,
          formatBrandedMessage(config, { heading: '📢 Official Channels', body: 'No required channels are configured right now.' })
        );
        return;
      }
      const kb = buildInlineKeyboard(
        channels.map((c) => [
          inlineButton({ text: `📢 ${c}`, url: `https://t.me/${String(c).replace(/^@/, '')}`, style: BUTTON_STYLES.PRIMARY }),
        ])
      );
      await telegram.sendMessage(
        token,
        chatId,
        formatBrandedMessage(config, { heading: '📢 Official Channels', body: 'Stay updated by joining our official channels below.' }),
        { reply_markup: kb }
      );
      return;
    }

    case '❓ Help': {
      await telegram.sendMessage(
        token,
        chatId,
        formatBrandedMessage(config, {
          heading: '❓ Help & Rules',
          body: [
            `1. Share your referral link to earn <b>${settings.referralReward} ${escapeHtml(settings.currencyLabel)}</b> per verified user.`,
            `2. Claim your Daily Bonus every ${settings.dailyBonusCooldownHours} hours.`,
            `3. Redeem promotional giftcodes shared by admins.`,
            `4. Submit points withdrawal requests for manual admin review.`,
            config.supportUsername ? `\nSupport: ${escapeHtml(config.supportUsername)}` : '',
          ].join('\n'),
        })
      );
      return;
    }

    case '🛡 Admin Dashboard':
    case '/admin': {
      if (!isAdmin) {
        await telegram.sendMessage(token, chatId, '🔒 Unauthorized. Admin permissions are required.');
        return;
      }
      await telegram.sendMessage(
        token,
        chatId,
        formatBrandedMessage(config, {
          heading: '🛡 Refer & Earn Admin Panel',
          body: 'Manage users, giftcodes, rewards, channels, and manual withdrawal approvals below.',
        }),
        { reply_markup: buildAdminKeyboard() }
      );
      return;
    }

    default: {
      await telegram.sendMessage(
        token,
        chatId,
        formatBrandedMessage(config, {
          heading: 'Menu Ready',
          body: 'Use the colourful keyboard buttons below to navigate.',
        }),
        { reply_markup: buildUserKeyboard(isAdmin) }
      );
    }
  }
}

async function handleStatefulInput(ctx, settings, state, text) {
  const { bot, config, token, telegram, repos, endUser, isAdmin } = ctx;
  const chatId = endUser.telegram_id;

  if (state.step === 'await_giftcode') {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
    const code = text.trim().toUpperCase();
    const { row: gc } = await repos.db.first(
      `SELECT * FROM giftcodes WHERE bot_id = ? AND UPPER(code) = ? AND status = 'active'`,
      [bot.id, code]
    );
    if (!gc) {
      await telegram.sendMessage(token, chatId, '❌ Invalid or inactive giftcode.');
      return true;
    }
    if (gc.expires_at && Date.parse(gc.expires_at) < Date.now()) {
      await repos.db.run(`UPDATE giftcodes SET status = 'expired' WHERE id = ?`, [gc.id]);
      await telegram.sendMessage(token, chatId, '⏰ This giftcode has expired.');
      return true;
    }
    if (gc.used_count >= gc.max_uses) {
      await repos.db.run(`UPDATE giftcodes SET status = 'exhausted' WHERE id = ?`, [gc.id]);
      await telegram.sendMessage(token, chatId, '❌ This giftcode has reached its maximum usage limit.');
      return true;
    }
    const { row: claimed } = await repos.db.first(
      `SELECT id FROM giftcode_redemptions WHERE giftcode_id = ? AND user_telegram_id = ?`,
      [gc.id, endUser.telegram_id]
    );
    if (claimed) {
      await telegram.sendMessage(token, chatId, '⚠️ You have already redeemed this giftcode.');
      return true;
    }

    await repos.db.batch([
      {
        sql: `INSERT INTO giftcode_redemptions (id, bot_id, giftcode_id, user_telegram_id, points_awarded) VALUES (?, ?, ?, ?, ?)`,
        params: [newId('gcr'), bot.id, gc.id, endUser.telegram_id, gc.reward_points],
      },
      {
        sql: `UPDATE giftcodes SET used_count = used_count + 1, status = CASE WHEN used_count + 1 >= max_uses THEN 'exhausted' ELSE 'active' END WHERE id = ?`,
        params: [gc.id],
      },
    ]);
    const bal = await repos.endUsers.adjustPoints(bot.id, endUser.telegram_id, {
      delta: gc.reward_points,
      txType: 'giftcode',
      referenceId: gc.id,
      description: `Redeemed giftcode ${gc.code}`,
    });
    await telegram.sendMessage(
      token,
      chatId,
      `🎉 <b>Giftcode Redeemed!</b>\nCode: <code>${escapeHtml(gc.code)}</code>\nCredited: <b>+${gc.reward_points} ${escapeHtml(settings.currencyLabel)}</b>\nNew Balance: <b>${bal}</b>`
    );
    return true;
  }

  if (state.step === 'await_withdraw_amount') {
    const amount = Number(text);
    if (!Number.isFinite(amount) || amount < Number(settings.minWithdrawalPoints)) {
      await telegram.sendMessage(token, chatId, `❌ Please enter a valid number >= ${settings.minWithdrawalPoints}.`);
      return true;
    }
    if (amount > Number(endUser.points_balance || 0)) {
      await telegram.sendMessage(token, chatId, '❌ Requested amount exceeds your current points balance.');
      return true;
    }
    await repos.endUsers.setState(bot.id, endUser.telegram_id, { step: 'await_withdraw_details', amount });
    await telegram.sendMessage(
      token,
      chatId,
      `Enter your reward delivery method and details (e.g. <code>Gift Card — email@example.com</code>):`
    );
    return true;
  }

  if (state.step === 'await_withdraw_details') {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
    const amount = Number(state.amount);
    const reqId = newId('wdr');
    const newBal = await repos.endUsers.adjustPoints(bot.id, endUser.telegram_id, {
      delta: -amount,
      txType: 'withdrawal_debit',
      referenceId: reqId,
      description: 'Withdrawal request hold',
    });
    await repos.db.run(
      `INSERT INTO withdrawal_requests (id, bot_id, user_telegram_id, amount, payout_method, payout_details, status)
       VALUES (?, ?, ?, ?, 'manual_review', ?, 'pending')`,
      [reqId, bot.id, endUser.telegram_id, amount, text.slice(0, 300)]
    );
    await telegram.sendMessage(
      token,
      chatId,
      `✅ <b>Withdrawal Request Submitted</b>\nRequest ID: <code>${reqId}</code>\nAmount: <b>${amount} ${escapeHtml(settings.currencyLabel)}</b>\nRemaining Balance: <b>${newBal}</b>\nStatus: <b>Pending Admin Review</b>`
    );

    // Notify bot owner with colourful Approve/Reject inline buttons
    await telegram
      .sendMessage(
        token,
        bot.owner_telegram_id,
        `💸 <b>New Withdrawal Request</b>\nID: <code>${reqId}</code>\nUser: <code>${endUser.telegram_id}</code> (${endUser.username ? `@${escapeHtml(endUser.username)}` : escapeHtml(endUser.first_name)})\nAmount: <b>${amount} ${escapeHtml(settings.currencyLabel)}</b>\nDetails: <code>${escapeHtml(text.slice(0, 300))}</code>`,
        { reply_markup: buildApprovalButtons(`re:wdr:approve:${reqId}`, `re:wdr:reject:${reqId}`) }
      )
      .catch(() => {});
    return true;
  }

  // Admin creation flows
  if (isAdmin && (state.step === 'adm_create_giftcode' || state.step === 'adm_new_gift')) {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
    const adminKb = buildTenantAdminReplyKeyboard(ADMIN_EXTRA_BUTTONS);
    const parts = text.includes('|') ? text.split('|').map((s) => s.trim()) : text.split(/\s+/);
    const code = (parts[0] || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    const rewardPoints = Number(parts[1]);
    const maxUses = Number(parts[2] || 10);
    const expiryRaw = parts[3] || '';
    if (!code || !Number.isFinite(rewardPoints) || rewardPoints <= 0 || !Number.isFinite(maxUses) || maxUses < 1) {
      await telegram.sendMessage(
        token,
        chatId,
        '❌ Invalid format. Use: <code>CODE | RewardAmount | MaxUses | OptionalExpiry</code> (e.g. <code>LAUNCH50 | 50 | 100 | 14</code>)',
        { reply_markup: adminKb }
      );
      return true;
    }
    let expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
    if (expiryRaw) {
      if (/^\d{4}-\d{2}-\d{2}/.test(expiryRaw)) {
        const d = new Date(expiryRaw);
        if (!Number.isNaN(d.getTime())) expiresAt = d.toISOString();
      } else if (Number.isFinite(Number(expiryRaw)) && Number(expiryRaw) > 0) {
        expiresAt = new Date(Date.now() + Number(expiryRaw) * 86400000).toISOString();
      }
    }
    await repos.db.run(
      `INSERT INTO giftcodes (id, bot_id, code, reward_points, max_uses, expires_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [newId('gc'), bot.id, code, rewardPoints, Math.floor(maxUses), expiresAt, endUser.telegram_id]
    );
    await telegram.sendMessage(
      token,
      chatId,
      `✅ <b>Giftcode Created</b>\nCode: <code>${code}</code>\nReward: <b>${rewardPoints}</b> pts\nMax Uses: <b>${Math.floor(maxUses)}</b>\nExpires: ${expiresAt.slice(0, 10)}`,
      { reply_markup: adminKb }
    );
    return true;
  }

  if (isAdmin && (state.step === 'adm_adjust_points' || state.step === 'adm_points')) {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
    const adminKb = buildTenantAdminReplyKeyboard(ADMIN_EXTRA_BUTTONS);
    const parts = text.includes('|') ? text.split('|').map((s) => s.trim()) : text.split(/\s+/);
    const targetUserId = parts[0] || '';
    const delta = Number(parts[1]);
    const reason = parts.slice(2).join(' ').trim();
    if (!targetUserId || !Number.isFinite(delta) || delta === 0) {
      await telegram.sendMessage(
        token,
        chatId,
        '❌ Format: <code>USER_TELEGRAM_ID | +/-AMOUNT | Reason</code> (e.g. <code>123456789 | 50 | Bonus</code>)',
        { reply_markup: adminKb }
      );
      return true;
    }
    try {
      const next = await repos.endUsers.adjustPoints(bot.id, targetUserId, {
        delta,
        txType: delta > 0 ? 'admin_credit' : 'admin_debit',
        description: reason || `Adjusted by admin ${endUser.telegram_id}`,
      });
      await telegram.sendMessage(
        token,
        chatId,
        `✅ User <code>${escapeHtml(targetUserId)}</code> balance updated to <b>${next}</b>.`,
        { reply_markup: adminKb }
      );
    } catch (err) {
      await telegram.sendMessage(token, chatId, `❌ ${escapeHtml(err.message)}`, { reply_markup: adminKb });
    }
    return true;
  }

  if (isAdmin && state.step === 'adm_set_channels') {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
    const adminKb = buildTenantAdminReplyKeyboard(ADMIN_EXTRA_BUTTONS);
    if (text.toLowerCase() === 'clear') {
      await repos.botConfigs.upsert(bot.id, { ...config, forceJoinChannels: [] });
      await invalidateTenantCache(ctx.env, bot.id);
      await telegram.sendMessage(token, chatId, '✅ Force-join channels cleared.', { reply_markup: adminKb });
      return true;
    }
    const resolved = await resolveAndVerifyForceJoinDestination({
      telegram,
      token,
      rawInput: text,
      botUsername: bot.telegram_username,
    });
    if (resolved.pendingPrivateLink) {
      await repos.botConfigs.upsert(bot.id, {
        ...config,
        templateSettings: {
          ...(config.templateSettings || {}),
          pendingForceJoinLink: {
            inviteUrl: resolved.inviteUrl,
            inviteCode: resolved.inviteCode,
            requestedBy: String(endUser.telegram_id),
            chatId: String(chatId),
            requestedAt: new Date().toISOString(),
          },
        },
      });
      await invalidateTenantCache(ctx.env, bot.id);
      await telegram.sendMessage(token, chatId, resolved.instructions, { reply_markup: adminKb });
      return true;
    }
    if (!resolved.ok) {
      await telegram.sendMessage(token, chatId, `❌ ${escapeHtml(resolved.error)}`, { reply_markup: adminKb });
      return true;
    }
    const updated = upsertForceJoinDestination(config.forceJoinChannels || [], resolved.destination);
    await repos.botConfigs.upsert(bot.id, { ...config, forceJoinChannels: updated });
    await invalidateTenantCache(ctx.env, bot.id);
    await telegram.sendMessage(
      token,
      chatId,
      `✅ Verified & added Force-Join destination: <b>${escapeHtml(formatDestinationLabel(resolved.destination))}</b> (<code>${escapeHtml(resolved.destination.chatId)}</code>)`,
      { reply_markup: adminKb }
    );
    return true;
  }

  if (isAdmin && (state.step === 'adm_set_daily' || state.step === 'adm_set_ref')) {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
    const adminKb = buildTenantAdminReplyKeyboard(ADMIN_EXTRA_BUTTONS);
    const parts = text.includes('|') ? text.split('|').map((s) => s.trim()) : [text.trim()];
    const val = Number(parts[0]);
    const cooldown = parts[1] !== undefined ? Number(parts[1]) : null;
    if (!Number.isFinite(val) || val < 0 || (cooldown !== null && (!Number.isFinite(cooldown) || cooldown < 1))) {
      await telegram.sendMessage(token, chatId, '❌ Enter a valid non-negative number (or <code>DailyBonus | CooldownHours</code>).', {
        reply_markup: adminKb,
      });
      return true;
    }
    const nextSettings = {
      ...(config.templateSettings || {}),
      [state.step === 'adm_set_daily' ? 'dailyBonus' : 'referralReward']: val,
      ...(state.step === 'adm_set_daily' && cooldown !== null ? { dailyBonusCooldownHours: cooldown } : {}),
    };
    await repos.botConfigs.upsert(bot.id, { ...config, templateSettings: nextSettings });
    await invalidateTenantCache(ctx.env, bot.id);
    await telegram.sendMessage(
      token,
      chatId,
      `✅ Reward setting updated to <b>${val}</b>${cooldown !== null ? ` (cooldown: <b>${cooldown}h</b>)` : ''}.`,
      { reply_markup: adminKb }
    );
    return true;
  }

  return false;
}

async function handleCallback(ctx, settings) {
  const { bot, config, token, telegram, repos, update, endUser, isAdmin } = ctx;
  const cb = update.callback_query;
  const chatId = cb.message?.chat?.id;
  const data = cb.data || '';
  await telegram.answerCallbackQuery(token, cb.id).catch(() => {});

  if (data === 're:verify_join') {
    const check = await checkForceJoin({
      telegram,
      token,
      channels: config.forceJoinChannels,
      userId: endUser.telegram_id,
    });
    if (!check.joined) {
      const missingLabels = check.missing.map((d) => escapeHtml(formatDestinationLabel(d))).join(', ');
      await telegram.sendMessage(token, chatId, `❌ Still missing membership in: <b>${missingLabels}</b>`, {
        reply_markup: buildForceJoinGateKeyboard(check.missing, 're:verify_join'),
      });
      return;
    }
    await telegram.sendMessage(token, chatId, '✅ Channel membership verified! Welcome aboard.', {
      reply_markup: buildUserKeyboard(isAdmin),
    });
    return;
  }

  if (!isAdmin) {
    await telegram.sendMessage(token, chatId, '🔒 Admin permissions required.');
    return;
  }

  if (data === 're:adm:dash' || data === 're:adm:stats') {
    const [uRes, wRes, gRes] = await Promise.all([
      repos.db.first(`SELECT COUNT(*) AS users, COALESCE(SUM(points_balance),0) AS total_pts, COALESCE(SUM(referral_count),0) AS total_refs FROM bot_end_users WHERE bot_id = ?`, [bot.id]),
      repos.db.first(`SELECT COUNT(*) AS pending FROM withdrawal_requests WHERE bot_id = ? AND status = 'pending'`, [bot.id]),
      repos.db.first(`SELECT COUNT(*) AS active_codes FROM giftcodes WHERE bot_id = ? AND status = 'active'`, [bot.id]),
    ]);
    await telegram.sendMessage(
      token,
      chatId,
      formatBrandedMessage(config, {
        heading: '📊 Bot Admin Statistics',
        body: [
          `• <b>Total Users:</b> ${Number(uRes.row?.users || 0)}`,
          `• <b>Total Referrals:</b> ${Number(uRes.row?.total_refs || 0)}`,
          `• <b>Points in Circulation:</b> ${Number(uRes.row?.total_pts || 0)}`,
          `• <b>Pending Withdrawals:</b> ${Number(wRes.row?.pending || 0)}`,
          `• <b>Active Giftcodes:</b> ${Number(gRes.row?.active_codes || 0)}`,
        ].join('\n'),
      }),
      { reply_markup: buildAdminKeyboard() }
    );
    return;
  }

  if (data === 're:adm:users') {
    const { rows } = await repos.db.all(
      `SELECT telegram_id, username, first_name, points_balance, referral_count FROM bot_end_users WHERE bot_id = ? ORDER BY joined_at DESC LIMIT 10`,
      [bot.id]
    );
    const lines = rows.map((u) => `• <code>${u.telegram_id}</code> ${u.username ? `@${escapeHtml(u.username)}` : escapeHtml(u.first_name)} — ${u.points_balance} pts (${u.referral_count} refs)`).join('\n');
    await telegram.sendMessage(token, chatId, `<b>👥 Recent Users</b>\n\n${lines || 'No users yet.'}`);
    return;
  }

  if (data === 're:adm:new_gift') {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, { step: 'adm_create_giftcode' });
    await telegram.sendMessage(token, chatId, 'Send giftcode details in format:\n<code>CODE POINTS MAX_USES [EXPIRY_DAYS]</code>\nExample: <code>BONUS25 25 50 7</code>');
    return;
  }

  if (data === 're:adm:points') {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, { step: 'adm_adjust_points' });
    await telegram.sendMessage(token, chatId, 'Send user ID and points delta:\n<code>USER_TELEGRAM_ID DELTA</code> (e.g. <code>987654321 100</code>)');
    return;
  }

  if (data === 're:adm:channels') {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, { step: 'adm_set_channels' });
    await telegram.sendMessage(token, chatId, 'Send channel usernames separated by spaces (e.g. <code>@ChannelOne @ChannelTwo</code>) or send <code>clear</code> to disable.');
    return;
  }

  if (data === 're:adm:set_daily') {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, { step: 'adm_set_daily' });
    await telegram.sendMessage(token, chatId, `Current Daily Bonus: <b>${settings.dailyBonus}</b>. Send the new daily bonus amount:`);
    return;
  }

  if (data === 're:adm:set_ref') {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, { step: 'adm_set_ref' });
    await telegram.sendMessage(token, chatId, `Current Referral Reward: <b>${settings.referralReward}</b>. Send the new referral reward amount:`);
    return;
  }

  if (data === 're:adm:settings') {
    const fjLabels = normalizeForceJoinList(config.forceJoinChannels || []).map((d) => formatDestinationLabel(d));
    await telegram.sendMessage(
      token,
      chatId,
      `<b>⚙️ Current Refer & Earn Settings</b>\n• Referral Reward: <b>${settings.referralReward}</b>\n• Daily Bonus: <b>${settings.dailyBonus}</b>\n• Cooldown: <b>${settings.dailyBonusCooldownHours}h</b>\n• Min Withdrawal: <b>${settings.minWithdrawalPoints}</b>\n• Force-Join: ${fjLabels.length ? escapeHtml(fjLabels.join(', ')) : 'Disabled'}`
    );
    return;
  }

  if (data === 're:adm:withdrawals') {
    const { rows } = await repos.db.all(
      `SELECT * FROM withdrawal_requests WHERE bot_id = ? AND status = 'pending' ORDER BY created_at ASC LIMIT 5`,
      [bot.id]
    );
    if (rows.length === 0) {
      await telegram.sendMessage(token, chatId, '✅ No pending withdrawal requests.');
      return;
    }
    for (const w of rows) {
      await telegram.sendMessage(
        token,
        chatId,
        `💸 <b>Pending Request</b> <code>${w.id}</code>\nUser: <code>${w.user_telegram_id}</code>\nAmount: <b>${w.amount}</b>\nDetails: <code>${escapeHtml(w.payout_details)}</code>`,
        { reply_markup: buildApprovalButtons(`re:wdr:approve:${w.id}`, `re:wdr:reject:${w.id}`) }
      );
    }
    return;
  }

  if (
    data.startsWith('re:wdr:approve:') ||
    data.startsWith('re:wdr:reject:') ||
    data.startsWith('re:wd:approve:') ||
    data.startsWith('re:wd:reject:')
  ) {
    const isApprove = data.includes(':approve:');
    const reqId = data.split(':')[3];
    const { row: w } = await repos.db.first(
      `SELECT * FROM withdrawal_requests WHERE id = ? AND bot_id = ?`,
      [reqId, bot.id]
    );
    if (!w || w.status !== 'pending') {
      await telegram.sendMessage(token, chatId, '⚠️ Request already processed or not found.');
      return;
    }

    const nextStatus = isApprove ? 'approved' : 'rejected';
    await repos.db.run(
      `UPDATE withdrawal_requests SET status = ?, reviewed_by = ?, updated_at = ? WHERE id = ?`,
      [nextStatus, endUser.telegram_id, new Date().toISOString(), reqId]
    );

    if (!isApprove) {
      await repos.endUsers.adjustPoints(bot.id, w.user_telegram_id, {
        delta: Number(w.amount),
        txType: 'withdrawal_refund',
        referenceId: reqId,
        description: 'Withdrawal request rejected — points refunded',
      });
    }

    await telegram.sendMessage(token, chatId, `${isApprove ? '✅ Approved' : '❌ Rejected & Refunded'} withdrawal <code>${reqId}</code>.`);
    await telegram
      .sendMessage(
        token,
        w.user_telegram_id,
        isApprove
          ? `✅ Your withdrawal request <code>${reqId}</code> for <b>${w.amount}</b> points was approved by an admin.`
          : `❌ Your withdrawal request <code>${reqId}</code> was declined and <b>${w.amount}</b> points were refunded to your balance.`
      )
      .catch(() => {});
  }
}

function safeParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}
