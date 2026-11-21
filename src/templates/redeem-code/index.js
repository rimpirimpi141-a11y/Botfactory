/**
 * TEMPLATE: REDEEM CODE BOT
 *
 * - Redeem code entry with validation (active, not expired, max claims not reached)
 * - Configurable referral requirement (`min_referrals`) verified against bot's end-user referrals
 * - Duplicate redemption protection (`UNIQUE(giftcode_id, user_telegram_id)`)
 * - Single & Bulk redeem code generation in native ReplyKeyboard Admin Panel
 * - Claim history & referral progress tracking
 */

import { formatBrandedMessage } from '../../builder/theme-engine.js';
import { buildReplyKeyboard, BUTTON_STYLES } from '../../utils/keyboards.js';
import { newId } from '../../database/repositories.js';
import { escapeHtml } from '../../utils/validation.js';
import {
  ADMIN_COMMON_LABELS,
  buildCancelReplyKeyboard,
  buildTenantAdminReplyKeyboard,
  handleCommonTenantAdmin,
} from '../shared/tenant-admin.js';

export const REDEEM_CODE_META = {
  id: 'tpl_redeem_code',
  slug: 'redeem-code',
  name: 'Redeem Code Bot',
  category: 'Codes & Giveaways',
};

const ADMIN_EXTRA_BUTTONS = [
  { text: '🎟 Create Single Code', style: BUTTON_STYLES.SUCCESS },
  { text: '⚡ Bulk Generate Codes', style: BUTTON_STYLES.PRIMARY },
  { text: '📋 Active Codes', style: BUTTON_STYLES.PRIMARY },
];

function buildUserKeyboard(isAdmin = false) {
  const rows = [
    [
      { text: '🎟 Redeem Code', style: BUTTON_STYLES.SUCCESS },
      { text: '👥 My Referrals', style: BUTTON_STYLES.PRIMARY },
    ],
    [
      { text: '📜 Claim History', style: BUTTON_STYLES.PRIMARY },
      { text: '💰 My Balance', style: BUTTON_STYLES.PRIMARY },
    ],
    [{ text: '🎧 Support', style: BUTTON_STYLES.PRIMARY }],
  ];
  if (isAdmin) {
    rows.push([{ text: ADMIN_COMMON_LABELS.OPEN_ADMIN, style: BUTTON_STYLES.DANGER }]);
  }
  return buildReplyKeyboard(rows, { resize: true, persistent: true });
}

export async function handleRedeemCodeUpdate(ctx) {
  const { bot, config, token, telegram, repos, update, endUser, isAdmin } = ctx;
  const userKb = buildUserKeyboard(isAdmin);
  const adminKb = buildTenantAdminReplyKeyboard(ADMIN_EXTRA_BUTTONS);
  const currency = config.templateSettings?.currencyLabel || 'Points';

  const msg = update.message;
  if (!msg) return;
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const state = safeParse(endUser.state_json);

  const handledAdmin = await handleCommonTenantAdmin(ctx, {
    panelTitle: 'Redeem Code Admin Panel',
    extraButtons: ADMIN_EXTRA_BUTTONS,
    userKeyboard: userKb,
    extraStatsSummary: async () => {
      const [cRes, rRes] = await Promise.all([
        repos.db.first(`SELECT COUNT(*) AS codes FROM giftcodes WHERE bot_id = ? AND status = 'active'`, [bot.id]),
        repos.db.first(`SELECT COUNT(*) AS claims FROM giftcode_redemptions WHERE bot_id = ?`, [bot.id]),
      ]);
      return `• Active Codes: <b>${Number(cRes.row?.codes || 0)}</b>\n• Total Redemptions: <b>${Number(rRes.row?.claims || 0)}</b>`;
    },
  });
  if (handledAdmin) return;

  // Handle /start with optional referral deep-link
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
        heading: '🎟 Redeem Code Hub',
        body: `${config.welcomeMessage || 'Enter a valid redeem code to claim instant rewards. Check your referral progress if a code requires referrals.'}\n\n• Balance: <b>${Number(endUser.points_balance || 0)} ${escapeHtml(currency)}</b>\n• Your Referrals: <b>${Number(endUser.referral_count || 0)}</b>`,
      }),
      { reply_markup: userKb }
    );
    return;
  }

  // User redeeming a code
  if (state?.step === 'enter_redeem_code' && !text.startsWith('/')) {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
    const result = await redeemCodeForUser({ repos, botId: bot.id, endUser, rawCode: text });
    if (!result.ok) {
      await telegram.sendMessage(token, chatId, `❌ ${escapeHtml(result.error)}`, { reply_markup: userKb });
      return;
    }
    await telegram.sendMessage(
      token,
      chatId,
      `🎉 <b>Code Redeemed Successfully!</b>\nCode: <code>${escapeHtml(result.code)}</code>\nReward: <b>+${result.reward} ${escapeHtml(currency)}</b>\nNew Balance: <b>${result.newBalance} ${escapeHtml(currency)}</b>`,
      { reply_markup: userKb }
    );
    return;
  }

  // Admin: single code creation -> CODE | REWARD | MAX_CLAIMS | MIN_REFERRALS | [YYYY-MM-DD EXPIRY]
  if (isAdmin && state?.step === 'adm_single_code' && !text.startsWith('/')) {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
    const [codeRaw, rewardStr, maxStr, minRefStr, expiresAt] = text.split('|').map((s) => (s || '').trim());
    const code = (codeRaw || '').toUpperCase().replace(/\s+/g, '');
    const reward = Number(rewardStr);
    const maxUses = Math.max(1, Number(maxStr) || 1);
    const minRefs = Math.max(0, Number(minRefStr) || 0);
    if (!code || !Number.isFinite(reward) || reward <= 0) {
      await telegram.sendMessage(
        token,
        chatId,
        '❌ Format: <code>CODE | Reward | MaxClaims | MinReferrals | OptionalExpiry(YYYY-MM-DD)</code>',
        { reply_markup: adminKb }
      );
      return;
    }
    await repos.db.run(
      `INSERT INTO giftcodes (id, bot_id, code, reward_points, max_uses, min_referrals, expires_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId('gft'), bot.id, code, reward, maxUses, minRefs, expiresAt || null, endUser.telegram_id]
    );
    await telegram.sendMessage(
      token,
      chatId,
      `✅ Redeem code <code>${escapeHtml(code)}</code> created!\n• Reward: <b>${reward} ${escapeHtml(currency)}</b>\n• Max Claims: <b>${maxUses}</b>\n• Min Referrals: <b>${minRefs}</b>\n• Expiry: <b>${escapeHtml(expiresAt || 'No expiry')}</b>`,
      { reply_markup: adminKb }
    );
    return;
  }

  // Admin: bulk code generation -> PREFIX | COUNT(max 25) | REWARD | MIN_REFERRALS
  if (isAdmin && state?.step === 'adm_bulk_codes' && !text.startsWith('/')) {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
    const [prefixRaw, countStr, rewardStr, minRefStr] = text.split('|').map((s) => (s || '').trim());
    const prefix = (prefixRaw || 'RDM').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    const count = Math.max(1, Math.min(25, Math.trunc(Number(countStr) || 5)));
    const reward = Number(rewardStr);
    const minRefs = Math.max(0, Math.trunc(Number(minRefStr) || 0));
    if (!Number.isFinite(reward) || reward <= 0) {
      await telegram.sendMessage(
        token,
        chatId,
        '❌ Format: <code>PREFIX | Count(1-25) | Reward | MinReferrals</code>',
        { reply_markup: adminKb }
      );
      return;
    }
    const generated = [];
    const stmts = [];
    for (let i = 0; i < count; i++) {
      const code = `${prefix}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
      generated.push(code);
      stmts.push({
        sql: `INSERT INTO giftcodes (id, bot_id, code, reward_points, max_uses, min_referrals, created_by)
              VALUES (?, ?, ?, ?, 1, ?, ?)`,
        params: [newId('gft'), bot.id, code, reward, minRefs, endUser.telegram_id],
      });
    }
    await repos.db.batch(stmts);
    await telegram.sendMessage(
      token,
      chatId,
      `⚡ <b>Generated ${generated.length} Unique Redeem Codes</b> (Reward: ${reward}, Min Refs: ${minRefs}):\n\n${generated.map((c) => `<code>${c}</code>`).join('\n')}`,
      { reply_markup: adminKb }
    );
    return;
  }

  // Admin ReplyKeyboard actions
  if (isAdmin && text === '🎟 Create Single Code') {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, { scope: 'tenant_admin', step: 'adm_single_code' });
    await telegram.sendMessage(
      token,
      chatId,
      'Send single code specs:\n<code>CODE | Reward | MaxClaims | MinReferrals | OptionalExpiry(YYYY-MM-DD)</code>',
      { reply_markup: buildCancelReplyKeyboard() }
    );
    return;
  }

  if (isAdmin && text === '⚡ Bulk Generate Codes') {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, { scope: 'tenant_admin', step: 'adm_bulk_codes' });
    await telegram.sendMessage(
      token,
      chatId,
      'Send bulk generator specs:\n<code>PREFIX | Count(1-25) | Reward | MinReferrals</code>',
      { reply_markup: buildCancelReplyKeyboard() }
    );
    return;
  }

  if (isAdmin && text === '📋 Active Codes') {
    const { rows } = await repos.db.all(
      `SELECT code, reward_points, used_count, max_uses, COALESCE(min_referrals, 0) AS min_referrals, expires_at
       FROM giftcodes WHERE bot_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 20`,
      [bot.id]
    );
    const body = rows.length
      ? rows
          .map(
            (c) =>
              `• <code>${escapeHtml(c.code)}</code> — ${c.reward_points} ${escapeHtml(currency)} · ${c.used_count}/${c.max_uses} used · Min Refs: ${c.min_referrals}`
          )
          .join('\n')
      : '<i>No active redeem codes yet.</i>';
    await telegram.sendMessage(token, chatId, formatBrandedMessage(config, { heading: '📋 Active Redeem Codes', body }), {
      reply_markup: adminKb,
    });
    return;
  }

  // User actions
  switch (text) {
    case '🎟 Redeem Code': {
      await repos.endUsers.setState(bot.id, endUser.telegram_id, { step: 'enter_redeem_code' });
      await telegram.sendMessage(token, chatId, '🎟 Send your redeem code now:');
      return;
    }

    case '👥 My Referrals': {
      const link = `https://t.me/${bot.telegram_username}?start=${endUser.referral_code}`;
      await telegram.sendMessage(
        token,
        chatId,
        formatBrandedMessage(config, {
          heading: '👥 Your Referral Link',
          body: `Invite friends to unlock referral-gated redeem codes!\n\n• Verified Referrals: <b>${Number(endUser.referral_count || 0)}</b>\n• Link: <code>${escapeHtml(link)}</code>`,
        }),
        { reply_markup: userKb }
      );
      return;
    }

    case '📜 Claim History': {
      const { rows } = await repos.db.all(
        `SELECT r.redeemed_at, g.code, g.reward_points
         FROM giftcode_redemptions r JOIN giftcodes g ON r.giftcode_id = g.id
         WHERE r.bot_id = ? AND r.user_telegram_id = ? ORDER BY r.redeemed_at DESC LIMIT 15`,
        [bot.id, endUser.telegram_id]
      );
      const body = rows.length
        ? rows.map((r) => `• <code>${escapeHtml(r.code)}</code> — <b>+${r.reward_points} ${escapeHtml(currency)}</b>`).join('\n')
        : '<i>No codes redeemed yet.</i>';
      await telegram.sendMessage(token, chatId, formatBrandedMessage(config, { heading: '📜 Claim History', body }), {
        reply_markup: userKb,
      });
      return;
    }

    case '💰 My Balance': {
      await telegram.sendMessage(
        token,
        chatId,
        formatBrandedMessage(config, {
          heading: '💰 Balance',
          body: `Total Balance: <b>${Number(endUser.points_balance || 0)} ${escapeHtml(currency)}</b>`,
        }),
        { reply_markup: userKb }
      );
      return;
    }

    case '🎧 Support': {
      await telegram.sendMessage(
        token,
        chatId,
        formatBrandedMessage(config, {
          heading: '🎧 Support',
          body: config.supportUsername ? `Contact ${escapeHtml(config.supportUsername)}.` : 'Support not configured.',
        }),
        { reply_markup: userKb }
      );
    }
  }
}

/**
 * Reusable, directly testable redeem code validation & claim executor.
 */
export async function redeemCodeForUser({ repos, botId, endUser, endUserId, rawCode, code: codeArg }) {
  const fail = (msg) => ({ ok: false, error: msg, reason: msg });

  const code = String(rawCode ?? codeArg ?? '').trim().toUpperCase();
  if (!code) return fail('Please enter a valid redeem code.');

  let resolvedEndUser = endUser;
  if (!resolvedEndUser && endUserId) {
    const { row } = await repos.db.first(
      `SELECT * FROM bot_end_users WHERE bot_id = ? AND telegram_id = ?`,
      [botId, String(endUserId)]
    );
    resolvedEndUser = row;
  }
  if (!resolvedEndUser) {
    return fail('User profile not found for this bot.');
  }

  const { row: gc } = await repos.db.first(
    `SELECT * FROM giftcodes WHERE bot_id = ? AND code = ? AND status = 'active'`,
    [botId, code]
  );
  if (!gc) return fail('Invalid or inactive redeem code.');

  if (gc.expires_at && new Date(gc.expires_at).getTime() < Date.now()) {
    return fail('This redeem code has expired.');
  }
  const usedCount = Number(gc.used_count || 0);
  const maxUses = Number(gc.max_uses || 1);
  if (usedCount >= maxUses) {
    return fail('This redeem code has reached its maximum claim limit.');
  }

  const requiredRefs = Number(gc.min_referrals || 0);
  const userRefs = Number(resolvedEndUser.referral_count || 0);
  if (userRefs < requiredRefs) {
    return fail(`This code requires at least ${requiredRefs} referrals (you currently have ${userRefs}).`);
  }

  const { row: already } = await repos.db.first(
    `SELECT id FROM giftcode_redemptions WHERE giftcode_id = ? AND user_telegram_id = ?`,
    [gc.id, resolvedEndUser.telegram_id]
  );
  if (already) {
    return fail('You have already redeemed this code.');
  }

  const rewardPoints = Number(gc.reward_points || 0);
  await repos.db.batch([
    {
      sql: `INSERT INTO giftcode_redemptions (id, bot_id, giftcode_id, user_telegram_id, points_awarded)
            VALUES (?, ?, ?, ?, ?)`,
      params: [newId('red'), botId, gc.id, resolvedEndUser.telegram_id, rewardPoints],
    },
    {
      sql: `UPDATE giftcodes
            SET used_count = used_count + 1,
                status = CASE WHEN used_count + 1 >= max_uses THEN 'exhausted' ELSE status END
            WHERE id = ?`,
      params: [gc.id],
    },
  ]);

  const newBalance = await repos.endUsers.adjustPoints(botId, resolvedEndUser.telegram_id, {
    delta: rewardPoints,
    txType: 'giftcode',
    referenceId: gc.id,
    description: `Redeemed code ${gc.code}`,
  });

  return { ok: true, code: gc.code, reward: rewardPoints, newBalance };
}

function safeParse(str) {
  if (!str) return null;
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}
