/**
 * TEMPLATE: SHOPPING VOUCHER BOT (Legitimate Retail Gift Vouchers)
 *
 * - Categories (Amazon, Flipkart, Brand Gift Cards, etc.)
 * - Real admin-added voucher stock & pricing (`vouchers` where `voucher_kind = 'shopping'`)
 * - UPI QR / manual payment proof submission (UTR or screenshot)
 * - Manual Admin verification required before voucher code delivery
 * - Duplicate-approval protection & purchase history
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
  buildUpiPaymentQr,
  handleCommonTenantAdmin,
} from '../shared/tenant-admin.js';

export const SHOPPING_VOUCHER_META = {
  id: 'tpl_shopping_voucher',
  slug: 'shopping-voucher',
  name: 'Shopping Voucher Bot',
  category: 'Vouchers & Commerce',
};

const ADMIN_EXTRA_BUTTONS = [
  { text: '➕ Add Shopping Voucher', style: BUTTON_STYLES.SUCCESS },
  { text: '💳 Pending Voucher Proofs', style: BUTTON_STYLES.DANGER },
  { text: '🛍 Voucher Stock', style: BUTTON_STYLES.PRIMARY },
];

function buildUserKeyboard(isAdmin = false) {
  const rows = [
    [
      { text: '🛍 Browse Vouchers', style: BUTTON_STYLES.SUCCESS },
      { text: '📂 Brands & Categories', style: BUTTON_STYLES.PRIMARY },
    ],
    [
      { text: '📜 Purchase History', style: BUTTON_STYLES.PRIMARY },
      { text: '🎧 Support', style: BUTTON_STYLES.PRIMARY },
    ],
  ];
  if (isAdmin) {
    rows.push([{ text: ADMIN_COMMON_LABELS.OPEN_ADMIN, style: BUTTON_STYLES.DANGER }]);
  }
  return buildReplyKeyboard(rows, { resize: true, persistent: true });
}

export async function handleShoppingVoucherUpdate(ctx) {
  const { bot, config, token, telegram, repos, update, endUser, isAdmin } = ctx;
  const userKb = buildUserKeyboard(isAdmin);
  const adminKb = buildTenantAdminReplyKeyboard(ADMIN_EXTRA_BUTTONS, { includeUpiSetup: true });
  const currency = config.templateSettings?.currencyLabel || 'INR';

  if (update.callback_query) {
    return handleCallback(ctx, adminKb, currency);
  }

  const msg = update.message;
  if (!msg) return;
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const state = safeParse(endUser.state_json);

  const handledAdmin = await handleCommonTenantAdmin(ctx, {
    panelTitle: 'Shopping Voucher Admin Panel',
    extraButtons: ADMIN_EXTRA_BUTTONS,
    includeUpiSetup: true,
    userKeyboard: userKb,
    extraStatsSummary: async () => {
      const { row } = await repos.db.first(
        `SELECT COALESCE(SUM(stock_count), 0) AS stock FROM vouchers WHERE bot_id = ? AND voucher_kind = 'shopping' AND is_active = 1`,
        [bot.id]
      );
      return `• Shopping Voucher Stock: <b>${Number(row?.stock || 0)}</b>`;
    },
  });
  if (handledAdmin) return;

  if (text === '/start') {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
    await telegram.sendMessage(
      token,
      chatId,
      formatBrandedMessage(config, {
        heading: '🛍 Shopping Voucher Store',
        body: config.welcomeMessage || 'Purchase legitimate brand shopping vouchers (Amazon, Flipkart, and more) with verified payment proof delivery.',
      }),
      { reply_markup: userKb }
    );
    return;
  }

  // Handle user submitting payment proof (UTR or screenshot)
  if (state?.step === 'shopv_submit_proof' && (msg.photo || (text && !text.startsWith('/')))) {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
    const { row: v } = await repos.db.first(
      `SELECT * FROM vouchers WHERE id = ? AND bot_id = ? AND is_active = 1 AND stock_count > 0`,
      [state.voucherId, bot.id]
    );
    if (!v) {
      await telegram.sendMessage(token, chatId, '❌ This voucher is no longer in stock.', { reply_markup: userKb });
      return;
    }

    const screenshotFileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : null;
    const utr = screenshotFileId ? (msg.caption || '').trim() : text;
    const proof = await repos.payments.createProof({
      botId: bot.id,
      userTelegramId: endUser.telegram_id,
      orderType: 'voucher_order',
      referenceId: v.id,
      itemTitle: `${v.category} — ${v.title}`,
      amount: v.price,
      currency,
      paymentMethod: 'upi_manual',
      utrNumber: utr,
      screenshotFileId,
    });

    await telegram.sendMessage(
      token,
      chatId,
      `⏳ <b>Payment Proof Submitted</b>\nProof ID: <code>${proof.id}</code>\nVoucher: <b>${escapeHtml(v.title)}</b> (${v.price} ${escapeHtml(currency)})\nYour voucher code will be delivered automatically after admin verification.`,
      { reply_markup: userKb }
    );

    await telegram
      .sendMessage(
        token,
        bot.owner_telegram_id,
        `💳 <b>Shopping Voucher Payment Proof</b>\nProof: <code>${proof.id}</code>\nUser: <code>${endUser.telegram_id}</code>\nVoucher: <b>${escapeHtml(v.title)}</b> (${v.price} ${escapeHtml(currency)})\nUTR: <code>${escapeHtml(utr || 'Screenshot')}</code>`,
        {
          reply_markup: buildApprovalButtons(
            `shv:pay:approve:${proof.id}`,
            `shv:pay:reject:${proof.id}`,
            '✅ Approve & Deliver Voucher',
            '❌ Reject'
          ),
        }
      )
      .catch(() => {});
    return;
  }

  // Admin: add shopping voucher -> Brand | Title | Price | Stock | RealVoucherCode
  if (isAdmin && state?.step === 'shopv_adm_add' && !text.startsWith('/')) {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
    const [brand, title, priceStr, stockStr, code] = text.split('|').map((s) => (s || '').trim());
    const price = Number(priceStr);
    const stock = Math.max(1, Math.trunc(Number(stockStr) || 1));
    if (!brand || !title || !Number.isFinite(price) || price < 0 || !code) {
      await telegram.sendMessage(
        token,
        chatId,
        '❌ Format: <code>Brand(Amazon/Flipkart) | Voucher Title | Price | Stock | RealVoucherCode</code>',
        { reply_markup: adminKb }
      );
      return;
    }
    const id = newId('shv');
    await repos.db.run(
      `INSERT INTO vouchers (id, bot_id, voucher_kind, category, title, voucher_code, price, stock_count, requires_approval, created_by)
       VALUES (?, ?, 'shopping', ?, ?, ?, ?, ?, 1, ?)`,
      [id, bot.id, brand, title, code, price, stock, endUser.telegram_id]
    );
    await telegram.sendMessage(
      token,
      chatId,
      `✅ Added Shopping Voucher <b>${escapeHtml(title)}</b> (${escapeHtml(brand)} · ${price} ${escapeHtml(currency)} · Stock: ${stock}).`,
      { reply_markup: adminKb }
    );
    return;
  }

  // Admin ReplyKeyboard actions
  if (isAdmin && text === '➕ Add Shopping Voucher') {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, { scope: 'tenant_admin', step: 'shopv_adm_add' });
    await telegram.sendMessage(
      token,
      chatId,
      'Send shopping voucher inventory:\n<code>Brand | Voucher Title | Price | Stock | RealVoucherCode</code>',
      { reply_markup: buildCancelReplyKeyboard() }
    );
    return;
  }

  if (isAdmin && text === '🛍 Voucher Stock') {
    const { rows } = await repos.db.all(
      `SELECT id, category, title, price, stock_count FROM vouchers WHERE bot_id = ? AND voucher_kind = 'shopping' ORDER BY created_at DESC LIMIT 15`,
      [bot.id]
    );
    const body = rows.length
      ? rows.map((v) => `• <code>${v.id}</code> [${escapeHtml(v.category)}] <b>${escapeHtml(v.title)}</b> — ${v.price} ${escapeHtml(currency)} · Stock: <b>${v.stock_count}</b>`).join('\n')
      : '<i>No shopping vouchers in stock yet.</i>';
    await telegram.sendMessage(token, chatId, formatBrandedMessage(config, { heading: '🛍 Shopping Voucher Stock', body }), {
      reply_markup: adminKb,
    });
    return;
  }

  if (isAdmin && text === '💳 Pending Voucher Proofs') {
    const pending = await repos.payments.listPending(bot.id, 10);
    if (!pending.length) {
      await telegram.sendMessage(token, chatId, '✅ No pending payment proofs.', { reply_markup: adminKb });
      return;
    }
    for (const p of pending) {
      await telegram.sendMessage(
        token,
        chatId,
        `💳 <b>Proof</b> <code>${p.id}</code>\nUser: <code>${p.user_telegram_id}</code>\nItem: <b>${escapeHtml(p.item_title)}</b>\nAmount: <b>${p.amount} ${escapeHtml(p.currency)}</b>\nUTR: <code>${escapeHtml(p.utr_number || 'Screenshot')}</code>`,
        { reply_markup: buildApprovalButtons(`shv:pay:approve:${p.id}`, `shv:pay:reject:${p.id}`, '✅ Approve & Deliver', '❌ Reject') }
      );
    }
    return;
  }

  // User actions
  switch (text) {
    case '🛍 Browse Vouchers': {
      const { rows } = await repos.db.all(
        `SELECT * FROM vouchers WHERE bot_id = ? AND voucher_kind = 'shopping' AND is_active = 1 AND stock_count > 0 ORDER BY category, price LIMIT 15`,
        [bot.id]
      );
      if (!rows.length) {
        await telegram.sendMessage(token, chatId, 'No shopping vouchers are currently in stock.', { reply_markup: userKb });
        return;
      }
      const kb = buildInlineKeyboard(
        rows.map((v) => [
          inlineButton({
            text: `🛍 [${v.category}] ${v.title} — ${v.price} ${currency}`,
            callbackData: `shv:buy:${v.id}`,
            style: BUTTON_STYLES.PRIMARY,
          }),
        ])
      );
      await telegram.sendMessage(
        token,
        chatId,
        formatBrandedMessage(config, { heading: '🛍 Shopping Vouchers', body: 'Select a voucher to view UPI payment details:' }),
        { reply_markup: kb }
      );
      return;
    }

    case '📂 Brands & Categories': {
      const { rows } = await repos.db.all(
        `SELECT category, COUNT(*) AS cnt FROM vouchers WHERE bot_id = ? AND voucher_kind = 'shopping' AND is_active = 1 AND stock_count > 0 GROUP BY category`,
        [bot.id]
      );
      if (!rows.length) {
        await telegram.sendMessage(token, chatId, 'No voucher brands listed yet.', { reply_markup: userKb });
        return;
      }
      const kb = buildInlineKeyboard(
        rows.map((r) => [
          inlineButton({ text: `📂 ${r.category} (${r.cnt})`, callbackData: `shv:cat:${r.category.slice(0, 40)}`, style: BUTTON_STYLES.PRIMARY }),
        ])
      );
      await telegram.sendMessage(token, chatId, '📂 <b>Select a Brand</b>', { reply_markup: kb });
      return;
    }

    case '📜 Purchase History': {
      const { rows } = await repos.db.all(
        `SELECT * FROM payment_proofs WHERE bot_id = ? AND user_telegram_id = ? AND order_type = 'voucher_order' ORDER BY created_at DESC LIMIT 10`,
        [bot.id, endUser.telegram_id]
      );
      const body = rows.length
        ? rows.map((p) => `• <code>${p.id}</code> — <b>${escapeHtml(p.item_title)}</b> (${p.amount} ${escapeHtml(p.currency)}) · <b>${p.status.toUpperCase()}</b>`).join('\n')
        : '<i>No voucher purchases yet.</i>';
      await telegram.sendMessage(token, chatId, formatBrandedMessage(config, { heading: '📜 Purchase History', body }), {
        reply_markup: userKb,
      });
      return;
    }

    case '🎧 Support': {
      await telegram.sendMessage(
        token,
        chatId,
        formatBrandedMessage(config, {
          heading: '🎧 Voucher Support',
          body: config.supportUsername ? `Contact ${escapeHtml(config.supportUsername)}.` : 'Support handle not configured.',
        }),
        { reply_markup: userKb }
      );
    }
  }
}

async function handleCallback(ctx, adminKb, currency) {
  const { bot, config, token, telegram, repos, update, endUser, isAdmin } = ctx;
  const cb = update.callback_query;
  const chatId = cb.message?.chat?.id;
  const data = cb.data || '';
  await telegram.answerCallbackQuery(token, cb.id).catch(() => {});

  if (data.startsWith('shv:cat:')) {
    const cat = data.slice('shv:cat:'.length);
    const { rows } = await repos.db.all(
      `SELECT * FROM vouchers WHERE bot_id = ? AND voucher_kind = 'shopping' AND category = ? AND is_active = 1 AND stock_count > 0`,
      [bot.id, cat]
    );
    const kb = buildInlineKeyboard(
      rows.map((v) => [
        inlineButton({ text: `🛍 ${v.title} — ${v.price} ${currency}`, callbackData: `shv:buy:${v.id}`, style: BUTTON_STYLES.SUCCESS }),
      ])
    );
    await telegram.sendMessage(token, chatId, `📂 <b>${escapeHtml(cat)} Vouchers</b>`, { reply_markup: kb });
    return;
  }

  if (data.startsWith('shv:buy:')) {
    const voucherId = data.slice('shv:buy:'.length);
    const { row: v } = await repos.db.first(
      `SELECT * FROM vouchers WHERE id = ? AND bot_id = ? AND is_active = 1 AND stock_count > 0`,
      [voucherId, bot.id]
    );
    if (!v) {
      await telegram.sendMessage(token, chatId, '❌ Out of stock.');
      return;
    }
    const upi = buildUpiPaymentQr({
      upiId: config.templateSettings?.upiId,
      payeeName: config.templateSettings?.upiPayeeName || config.brandTitle || bot.display_name,
      amount: v.price,
      note: `Voucher ${v.title}`,
    });
    await repos.endUsers.setState(bot.id, endUser.telegram_id, { step: 'shopv_submit_proof', voucherId: v.id });

    if (upi.configured) {
      await telegram
        .sendPhoto(token, chatId, upi.qrUrl, {
          caption: `💳 <b>Pay for ${escapeHtml(v.title)}</b>\nAmount: <b>${v.price} ${escapeHtml(currency)}</b>\nUPI ID: <code>${escapeHtml(config.templateSettings.upiId)}</code>\n\nSend your <b>UTR number</b> or upload a <b>payment screenshot</b> here for verification.`,
        })
        .catch(async () => {
          await telegram.sendMessage(
            token,
            chatId,
            `💳 <b>Pay for ${escapeHtml(v.title)}</b>\nAmount: <b>${v.price} ${escapeHtml(currency)}</b>\nUPI ID: <code>${escapeHtml(config.templateSettings.upiId)}</code>\n\nSend your UTR number or payment screenshot.`
          );
        });
    } else {
      await telegram.sendMessage(
        token,
        chatId,
        `💳 <b>Order ${escapeHtml(v.title)}</b> (${v.price} ${escapeHtml(currency)})\n<i>UPI ID not configured by store admin yet. Submit your UTR/screenshot proof or contact support.</i>`
      );
    }
    return;
  }

  if (!isAdmin) return;

  if (data.startsWith('shv:pay:approve:')) {
    const proofId = data.slice('shv:pay:approve:'.length);
    const result = await repos.payments.approveProof(bot.id, proofId, endUser.telegram_id);
    if (!result.transitioned) {
      await telegram.sendMessage(token, chatId, `⚠️ ${escapeHtml(result.reason)}`, { reply_markup: adminKb });
      return;
    }
    const { proof } = result;
    const { row: v } = await repos.db.first(`SELECT * FROM vouchers WHERE id = ? AND bot_id = ?`, [proof.reference_id, bot.id]);
    if (v && Number(v.stock_count) > 0) {
      await repos.db.run(`UPDATE vouchers SET stock_count = MAX(0, stock_count - 1) WHERE id = ?`, [v.id]);
      await telegram
        .sendMessage(
          token,
          proof.user_telegram_id,
          `🎉 <b>Shopping Voucher Delivered!</b>\nItem: <b>${escapeHtml(v.title)}</b>\nVoucher Code: <code>${escapeHtml(v.voucher_code)}</code>`
        )
        .catch(() => {});
    }
    await telegram.sendMessage(
      token,
      chatId,
      `✅ Approved proof <code>${proofId}</code> and delivered voucher to user <code>${proof.user_telegram_id}</code>.`,
      { reply_markup: adminKb }
    );
    return;
  }

  if (data.startsWith('shv:pay:reject:')) {
    const proofId = data.slice('shv:pay:reject:'.length);
    const result = await repos.payments.rejectProof(bot.id, proofId, endUser.telegram_id);
    if (!result.transitioned) {
      await telegram.sendMessage(token, chatId, `⚠️ ${escapeHtml(result.reason)}`, { reply_markup: adminKb });
      return;
    }
    await telegram
      .sendMessage(token, result.proof.user_telegram_id, `❌ Your voucher payment proof <code>${proofId}</code> was rejected.`)
      .catch(() => {});
    await telegram.sendMessage(token, chatId, `❌ Rejected proof <code>${proofId}</code>.`, { reply_markup: adminKb });
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
