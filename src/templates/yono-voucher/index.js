/**
 * TEMPLATE: YONO VOUCHER BOT
 *
 * - Strictly distributes REAL admin-added voucher inventory from D1 (`vouchers` where `voucher_kind = 'yono'`)
 * - NEVER fabricates, guesses, or mocks voucher codes
 * - Enforces stock limits, optional referral eligibility, duplicate claim protection, and admin approval queue
 * - Dedicated ReplyKeyboard Tenant Admin Panel
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

export const YONO_VOUCHER_META = {
  id: 'tpl_yono_voucher',
  slug: 'yono-voucher',
  name: 'Yono Voucher Bot',
  category: 'Vouchers & Perks',
};

const ADMIN_EXTRA_BUTTONS = [
  { text: '➕ Add Yono Voucher Stock', style: BUTTON_STYLES.SUCCESS },
  { text: '⏳ Pending Claims', style: BUTTON_STYLES.DANGER },
  { text: '🎟 Manage Inventory', style: BUTTON_STYLES.PRIMARY },
];

function buildUserKeyboard(isAdmin = false) {
  const rows = [
    [
      { text: '🎟 Available Vouchers', style: BUTTON_STYLES.SUCCESS },
      { text: '📜 My Voucher Claims', style: BUTTON_STYLES.PRIMARY },
    ],
    [
      { text: '👥 Referral Progress', style: BUTTON_STYLES.PRIMARY },
      { text: '🎧 Support', style: BUTTON_STYLES.PRIMARY },
    ],
  ];
  if (isAdmin) {
    rows.push([{ text: ADMIN_COMMON_LABELS.OPEN_ADMIN, style: BUTTON_STYLES.DANGER }]);
  }
  return buildReplyKeyboard(rows, { resize: true, persistent: true });
}

export async function handleYonoVoucherUpdate(ctx) {
  const { bot, config, token, telegram, repos, update, endUser, isAdmin } = ctx;
  const userKb = buildUserKeyboard(isAdmin);
  const adminKb = buildTenantAdminReplyKeyboard(ADMIN_EXTRA_BUTTONS);

  if (update.callback_query) {
    return handleCallback(ctx, adminKb);
  }

  const msg = update.message;
  if (!msg) return;
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const state = safeParse(endUser.state_json);

  const handledAdmin = await handleCommonTenantAdmin(ctx, {
    panelTitle: 'Yono Voucher Admin Panel',
    extraButtons: ADMIN_EXTRA_BUTTONS,
    userKeyboard: userKb,
    extraStatsSummary: async () => {
      const [vRes, cRes] = await Promise.all([
        repos.db.first(`SELECT COALESCE(SUM(stock_count), 0) AS stock FROM vouchers WHERE bot_id = ? AND voucher_kind = 'yono' AND is_active = 1`, [bot.id]),
        repos.db.first(`SELECT COUNT(*) AS pending FROM voucher_claims WHERE bot_id = ? AND status = 'pending'`, [bot.id]),
      ]);
      return `• Available Stock Units: <b>${Number(vRes.row?.stock || 0)}</b>\n• Pending Claims: <b>${Number(cRes.row?.pending || 0)}</b>`;
    },
  });
  if (handledAdmin) return;

  if (text.startsWith('/start')) {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
    const startArg = text.split(/\s+/)[1] || '';
    if (startArg && ctx.isNewUser) {
      const referrer = await repos.endUsers.getByReferralCode(bot.id, startArg);
      if (referrer) await repos.endUsers.recordReferral(bot.id, referrer.telegram_id, endUser.telegram_id, 0);
    }
    await telegram.sendMessage(
      token,
      chatId,
      formatBrandedMessage(config, {
        heading: '🎟 Yono Voucher Desk',
        body: config.welcomeMessage || 'Browse real, admin-verified Yono vouchers currently in stock and track your claims.',
      }),
      { reply_markup: userKb }
    );
    return;
  }

  // Admin: add real voucher inventory -> Title | VoucherCode | Stock | MinReferrals | Description
  if (isAdmin && state?.step === 'yono_adm_add' && !text.startsWith('/')) {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
    const [title, code, stockStr, minRefStr, description] = text.split('|').map((s) => (s || '').trim());
    const stock = Math.max(1, Math.trunc(Number(stockStr) || 1));
    const minRefs = Math.max(0, Math.trunc(Number(minRefStr) || 0));
    if (!title || !code) {
      await telegram.sendMessage(
        token,
        chatId,
        '❌ Format: <code>Voucher Title | RealVoucherCode | StockCount | MinReferrals | Description</code>',
        { reply_markup: adminKb }
      );
      return;
    }
    const id = newId('vch');
    await repos.db.run(
      `INSERT INTO vouchers (id, bot_id, voucher_kind, category, title, description, voucher_code, price, stock_count, requires_approval, min_referrals, created_by)
       VALUES (?, ?, 'yono', 'Yono', ?, ?, ?, 0, ?, 1, ?, ?)`,
      [id, bot.id, title, description || '', code, stock, minRefs, endUser.telegram_id]
    );
    await telegram.sendMessage(
      token,
      chatId,
      `✅ Added Yono Voucher <b>${escapeHtml(title)}</b> (Stock: <b>${stock}</b>, Min Refs: <b>${minRefs}</b>, ID: <code>${id}</code>).`,
      { reply_markup: adminKb }
    );
    return;
  }

  // Admin ReplyKeyboard actions
  if (isAdmin && text === '➕ Add Yono Voucher Stock') {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, { scope: 'tenant_admin', step: 'yono_adm_add' });
    await telegram.sendMessage(
      token,
      chatId,
      'Send real voucher inventory details:\n<code>Title | VoucherCode | StockCount | MinReferrals | Description</code>',
      { reply_markup: buildCancelReplyKeyboard() }
    );
    return;
  }

  if (isAdmin && text === '🎟 Manage Inventory') {
    const { rows } = await repos.db.all(
      `SELECT id, title, stock_count, min_referrals, is_active FROM vouchers WHERE bot_id = ? AND voucher_kind = 'yono' ORDER BY created_at DESC LIMIT 15`,
      [bot.id]
    );
    const body = rows.length
      ? rows.map((v) => `• <code>${v.id}</code> — <b>${escapeHtml(v.title)}</b> · Stock: <b>${v.stock_count}</b> · Min Refs: ${v.min_referrals}`).join('\n')
      : '<i>No voucher stock configured yet.</i>';
    await telegram.sendMessage(token, chatId, formatBrandedMessage(config, { heading: '🎟 Yono Voucher Inventory', body }), {
      reply_markup: adminKb,
    });
    return;
  }

  if (isAdmin && text === '⏳ Pending Claims') {
    const { rows } = await repos.db.all(
      `SELECT c.*, v.title FROM voucher_claims c JOIN vouchers v ON c.voucher_id = v.id
       WHERE c.bot_id = ? AND v.voucher_kind = 'yono' AND c.status = 'pending' ORDER BY c.created_at ASC LIMIT 10`,
      [bot.id]
    );
    if (!rows.length) {
      await telegram.sendMessage(token, chatId, '✅ No pending voucher claims.', { reply_markup: adminKb });
      return;
    }
    for (const c of rows) {
      await telegram.sendMessage(
        token,
        chatId,
        `🎟 <b>Claim</b> <code>${c.id}</code>\nVoucher: <b>${escapeHtml(c.title)}</b>\nUser: <code>${c.user_telegram_id}</code>`,
        {
          reply_markup: buildApprovalButtons(
            `yono:approve:${c.id}`,
            `yono:reject:${c.id}`,
            '✅ Approve & Deliver',
            '❌ Reject Claim'
          ),
        }
      );
    }
    return;
  }

  // User actions
  switch (text) {
    case '🎟 Available Vouchers': {
      const { rows } = await repos.db.all(
        `SELECT * FROM vouchers WHERE bot_id = ? AND voucher_kind = 'yono' AND is_active = 1 AND stock_count > 0 ORDER BY created_at DESC LIMIT 12`,
        [bot.id]
      );
      if (!rows.length) {
        await telegram.sendMessage(token, chatId, 'No Yono vouchers are currently in stock. Check back when admin adds new stock.', {
          reply_markup: userKb,
        });
        return;
      }
      const kb = buildInlineKeyboard(
        rows.map((v) => [
          inlineButton({
            text: `🎟 ${v.title} (Stock: ${v.stock_count})`,
            callbackData: `yono:claim:${v.id}`,
            style: BUTTON_STYLES.SUCCESS,
          }),
        ])
      );
      await telegram.sendMessage(
        token,
        chatId,
        formatBrandedMessage(config, { heading: '🎟 In-Stock Yono Vouchers', body: 'Select a voucher to submit a claim request:' }),
        { reply_markup: kb }
      );
      return;
    }

    case '📜 My Voucher Claims': {
      const { rows } = await repos.db.all(
        `SELECT c.*, v.title FROM voucher_claims c JOIN vouchers v ON c.voucher_id = v.id
         WHERE c.bot_id = ? AND c.user_telegram_id = ? ORDER BY c.created_at DESC LIMIT 12`,
        [bot.id, endUser.telegram_id]
      );
      const body = rows.length
        ? rows
            .map(
              (c) =>
                `• <code>${c.id}</code> — <b>${escapeHtml(c.title)}</b> · <b>${c.status.toUpperCase()}</b>${c.delivered_code ? `\n  Code: <code>${escapeHtml(c.delivered_code)}</code>` : ''}`
            )
            .join('\n')
        : '<i>You have not claimed any vouchers yet.</i>';
      await telegram.sendMessage(token, chatId, formatBrandedMessage(config, { heading: '📜 My Voucher Claims', body }), {
        reply_markup: userKb,
      });
      return;
    }

    case '👥 Referral Progress': {
      const link = `https://t.me/${bot.telegram_username}?start=${endUser.referral_code}`;
      await telegram.sendMessage(
        token,
        chatId,
        formatBrandedMessage(config, {
          heading: '👥 Referral Eligibility',
          body: `Your Referrals: <b>${Number(endUser.referral_count || 0)}</b>\nShare Link: <code>${escapeHtml(link)}</code>`,
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
          body: config.supportUsername ? `Contact ${escapeHtml(config.supportUsername)}.` : 'Support handle not configured.',
        }),
        { reply_markup: userKb }
      );
    }
  }
}

async function handleCallback(ctx, adminKb) {
  const { bot, token, telegram, repos, update, endUser, isAdmin } = ctx;
  const cb = update.callback_query;
  const chatId = cb.message?.chat?.id;
  const data = cb.data || '';
  await telegram.answerCallbackQuery(token, cb.id).catch(() => {});

  if (data.startsWith('yono:claim:')) {
    const voucherId = data.slice('yono:claim:'.length);
    const { row: v } = await repos.db.first(
      `SELECT * FROM vouchers WHERE id = ? AND bot_id = ? AND is_active = 1 AND stock_count > 0`,
      [voucherId, bot.id]
    );
    if (!v) {
      await telegram.sendMessage(token, chatId, '❌ This voucher is out of stock.');
      return;
    }
    if (Number(endUser.referral_count || 0) < Number(v.min_referrals || 0)) {
      await telegram.sendMessage(
        token,
        chatId,
        `❌ Eligibility not met: requires <b>${v.min_referrals}</b> referrals (you have <b>${endUser.referral_count || 0}</b>).`
      );
      return;
    }
    const { row: dup } = await repos.db.first(
      `SELECT id FROM voucher_claims WHERE bot_id = ? AND voucher_id = ? AND user_telegram_id = ?`,
      [bot.id, v.id, endUser.telegram_id]
    );
    if (dup) {
      await telegram.sendMessage(token, chatId, '⚠️ You have already claimed or requested this voucher.');
      return;
    }

    const claimId = newId('vcl');
    await repos.db.run(
      `INSERT INTO voucher_claims (id, bot_id, voucher_id, user_telegram_id, status) VALUES (?, ?, ?, ?, 'pending')`,
      [claimId, bot.id, v.id, endUser.telegram_id]
    );
    await telegram.sendMessage(
      token,
      chatId,
      `⏳ <b>Voucher Claim Submitted</b>\nClaim ID: <code>${claimId}</code>\nVoucher: <b>${escapeHtml(v.title)}</b>\nAwaiting admin verification before delivery.`
    );
    await telegram
      .sendMessage(
        token,
        bot.owner_telegram_id,
        `🎟 <b>New Yono Voucher Claim</b>\nClaim: <code>${claimId}</code>\nUser: <code>${endUser.telegram_id}</code>\nVoucher: <b>${escapeHtml(v.title)}</b>`,
        { reply_markup: buildApprovalButtons(`yono:approve:${claimId}`, `yono:reject:${claimId}`, '✅ Approve & Deliver', '❌ Reject') }
      )
      .catch(() => {});
    return;
  }

  if (!isAdmin) return;

  if (data.startsWith('yono:approve:')) {
    const claimId = data.slice('yono:approve:'.length);
    const { row: claim } = await repos.db.first(
      `SELECT c.*, v.title, v.voucher_code, v.stock_count FROM voucher_claims c JOIN vouchers v ON c.voucher_id = v.id
       WHERE c.id = ? AND c.bot_id = ? AND c.status = 'pending'`,
      [claimId, bot.id]
    );
    if (!claim) {
      await telegram.sendMessage(token, chatId, '⚠️ Claim already processed.', { reply_markup: adminKb });
      return;
    }
    if (Number(claim.stock_count || 0) <= 0) {
      await telegram.sendMessage(token, chatId, '❌ Voucher is out of stock. Restock before approving.', { reply_markup: adminKb });
      return;
    }
    const now = new Date().toISOString();
    const { meta } = await repos.db.run(
      `UPDATE voucher_claims SET status = 'delivered', delivered_code = ?, reviewed_by = ?, updated_at = ?
       WHERE id = ? AND bot_id = ? AND status = 'pending'`,
      [claim.voucher_code, endUser.telegram_id, now, claimId, bot.id]
    );
    if (!meta?.changes) return;
    await repos.db.run(`UPDATE vouchers SET stock_count = MAX(0, stock_count - 1) WHERE id = ?`, [claim.voucher_id]);
    await telegram
      .sendMessage(
        token,
        claim.user_telegram_id,
        `🎉 <b>Voucher Delivered!</b>\nVoucher: <b>${escapeHtml(claim.title)}</b>\nCode: <code>${escapeHtml(claim.voucher_code)}</code>`
      )
      .catch(() => {});
    await telegram.sendMessage(token, chatId, `✅ Approved & delivered voucher claim <code>${claimId}</code>.`, {
      reply_markup: adminKb,
    });
    return;
  }

  if (data.startsWith('yono:reject:')) {
    const claimId = data.slice('yono:reject:'.length);
    const { meta } = await repos.db.run(
      `UPDATE voucher_claims SET status = 'rejected', reviewed_by = ?, updated_at = ?
       WHERE id = ? AND bot_id = ? AND status = 'pending'`,
      [endUser.telegram_id, new Date().toISOString(), claimId, bot.id]
    );
    if (!meta?.changes) {
      await telegram.sendMessage(token, chatId, '⚠️ Claim already processed.', { reply_markup: adminKb });
      return;
    }
    await telegram.sendMessage(token, chatId, `❌ Rejected voucher claim <code>${claimId}</code>.`, { reply_markup: adminKb });
  }
}

function safeParse(str) {
  if (!str) return null;
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}
