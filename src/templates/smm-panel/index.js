/**
 * TEMPLATE: SMM PANEL BOT (Upgraded)
 *
 * - Legitimate social media marketing services ONLY (no fake followers/engagement)
 * - Service catalogue, order placement, order status tracking, order history
 * - Deposit requests via UPI QR + UTR/screenshot payment proof verification -> Admin Approval credits balance
 * - Optional External SMM Provider API URL configuration (honest status when not configured)
 * - Dedicated Native ReplyKeyboard Tenant Admin Panel (zero hollow buttons)
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
import { escapeHtml, validateSafeUrl } from '../../utils/validation.js';
import { invalidateTenantCache } from '../../core/tenant-manager.js';
import {
  ADMIN_COMMON_LABELS,
  buildCancelReplyKeyboard,
  buildTenantAdminReplyKeyboard,
  buildUpiPaymentQr,
  handleCommonTenantAdmin,
} from '../shared/tenant-admin.js';

export const SMM_PANEL_META = {
  id: 'tpl_smm_panel',
  slug: 'smm-panel',
  name: 'SMM Panel Bot',
  category: 'Marketing Services',
};

const FAKE_ENGAGEMENT_REGEX = /\b(fake\s*followers|bot\s*likes|buy\s*views|spam\s*comments|click\s*farm)\b/i;

const ADMIN_EXTRA_BUTTONS = [
  { text: '➕ Add Service', style: BUTTON_STYLES.SUCCESS },
  { text: '📁 Open Orders', style: BUTTON_STYLES.PRIMARY },
  { text: '💳 Pending Deposits', style: BUTTON_STYLES.DANGER },
  { text: '🔌 Provider API Config', style: BUTTON_STYLES.PRIMARY },
];

function buildUserKeyboard(isAdmin = false) {
  const rows = [
    [
      { text: '📦 Services', style: BUTTON_STYLES.SUCCESS },
      { text: '🛒 New Order', style: BUTTON_STYLES.PRIMARY },
    ],
    [
      { text: '📁 My Orders', style: BUTTON_STYLES.PRIMARY },
      { text: '🔎 Order Status', style: BUTTON_STYLES.PRIMARY },
    ],
    [
      { text: '💰 Account Balance', style: BUTTON_STYLES.SUCCESS },
      { text: '💳 Add Funds', style: BUTTON_STYLES.SUCCESS },
    ],
    [{ text: '🎧 Support', style: BUTTON_STYLES.PRIMARY }],
  ];
  if (isAdmin) {
    rows.push([{ text: ADMIN_COMMON_LABELS.OPEN_ADMIN, style: BUTTON_STYLES.DANGER }]);
  }
  return buildReplyKeyboard(rows, { resize: true, persistent: true });
}

export async function handleSmmPanelUpdate(ctx) {
  const { env, bot, config, token, telegram, repos, update, endUser, isAdmin } = ctx;
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
    panelTitle: 'SMM Panel Admin',
    extraButtons: ADMIN_EXTRA_BUTTONS,
    includeUpiSetup: true,
    userKeyboard: userKb,
    extraStatsSummary: async () => {
      const { row } = await repos.db.first(
        `SELECT COUNT(*) AS open_orders FROM service_orders WHERE bot_id = ? AND status IN ('pending', 'in_progress')`,
        [bot.id]
      );
      const apiConfigured = Boolean(config.templateSettings?.providerApiUrl);
      return `• Open Orders: <b>${Number(row?.open_orders || 0)}</b>\n• External Provider API: <b>${apiConfigured ? 'Configured' : 'Not Configured (Manual Mode)'}</b>`;
    },
  });
  if (handledAdmin) return;

  if (text === '/start') {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
    await telegram.sendMessage(
      token,
      chatId,
      formatBrandedMessage(config, {
        heading: 'Social Media Marketing Agency Desk',
        body: `${config.welcomeMessage || 'Order legitimate content strategy, ad campaign setup, and social analytics packages.'}\n\n💰 Balance: <b>${Number(endUser.points_balance || 0)} ${escapeHtml(currency)}</b>`,
      }),
      { reply_markup: userKb }
    );
    return;
  }

  // Handle user deposit proof submission (Amount | UTR or screenshot photo)
  if (state?.step === 'smm_deposit_proof' && (msg.photo || (text && !text.startsWith('/')))) {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
    const screenshotFileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : null;
    const raw = screenshotFileId ? (msg.caption || '') : text;
    const [amountStr, utrPart] = raw.split('|').map((s) => (s || '').trim());
    const amount = Number(amountStr);
    if (!Number.isFinite(amount) || amount <= 0) {
      await telegram.sendMessage(
        token,
        chatId,
        '❌ Send deposit proof in format: <code>Amount | UTR Number</code> (or attach a screenshot with caption <code>Amount | UTR</code>).',
        { reply_markup: userKb }
      );
      return;
    }
    const proof = await repos.payments.createProof({
      botId: bot.id,
      userTelegramId: endUser.telegram_id,
      orderType: 'smm_deposit',
      itemTitle: 'SMM Wallet Deposit',
      amount,
      currency,
      paymentMethod: 'upi_manual',
      utrNumber: utrPart || 'Screenshot',
      screenshotFileId,
    });
    await telegram.sendMessage(
      token,
      chatId,
      `⏳ <b>Deposit Proof Submitted</b>\nProof ID: <code>${proof.id}</code>\nAmount: <b>${amount} ${escapeHtml(currency)}</b>\nYour balance will be credited once an admin verifies the payment.`,
      { reply_markup: userKb }
    );
    await telegram
      .sendMessage(
        token,
        bot.owner_telegram_id,
        `💳 <b>SMM Deposit Proof</b>\nID: <code>${proof.id}</code>\nUser: <code>${endUser.telegram_id}</code>\nAmount: <b>${amount} ${escapeHtml(currency)}</b>\nUTR: <code>${escapeHtml(utrPart || 'Screenshot')}</code>`,
        { reply_markup: buildApprovalButtons(`smm:dep:approve:${proof.id}`, `smm:dep:reject:${proof.id}`, '✅ Approve & Credit', '❌ Reject') }
      )
      .catch(() => {});
    return;
  }

  if (state && !text.startsWith('/')) {
    if (state.step === 'lookup_order') {
      await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
      const { row: ord } = await repos.db.first(
        `SELECT o.*, s.title FROM service_orders o JOIN services s ON o.service_id = s.id
         WHERE o.id = ? AND o.bot_id = ? AND (o.user_telegram_id = ? OR ? = 1)`,
        [text.trim(), bot.id, endUser.telegram_id, isAdmin ? 1 : 0]
      );
      if (!ord) {
        await telegram.sendMessage(token, chatId, '❌ Order ID not found.', { reply_markup: userKb });
        return;
      }
      await telegram.sendMessage(
        token,
        chatId,
        `🔎 <b>Order Status</b>\nID: <code>${ord.id}</code>\nService: <b>${escapeHtml(ord.title)}</b>\nQuantity: <b>${ord.quantity}</b>\nStatus: <b>${ord.status.toUpperCase()}</b>\nNotes: ${escapeHtml(ord.admin_note || 'In queue')}`,
        { reply_markup: userKb }
      );
      return;
    }

    if (state.step === 'place_order_brief') {
      await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
      const { row: svc } = await repos.db.first(
        `SELECT * FROM services WHERE id = ? AND bot_id = ? AND is_active = 1`,
        [state.serviceId, bot.id]
      );
      if (!svc) return;
      if (Number(endUser.points_balance || 0) < Number(svc.price_points)) {
        await telegram.sendMessage(
          token,
          chatId,
          `❌ Insufficient balance. Required: <b>${svc.price_points} ${escapeHtml(currency)}</b>. Tap 💳 Add Funds to submit a deposit.`,
          { reply_markup: userKb }
        );
        return;
      }
      const orderId = newId('smm');
      await repos.endUsers.adjustPoints(bot.id, endUser.telegram_id, {
        delta: -Number(svc.price_points),
        txType: 'order_debit',
        referenceId: orderId,
        description: `SMM Package: ${svc.title}`,
      });
      await repos.db.run(
        `INSERT INTO service_orders (id, bot_id, service_id, user_telegram_id, quantity, target_details, total_points, status)
         VALUES (?, ?, ?, ?, 1, ?, ?, 'pending')`,
        [orderId, bot.id, svc.id, endUser.telegram_id, text.slice(0, 500), svc.price_points]
      );
      await telegram.sendMessage(
        token,
        chatId,
        `✅ <b>Campaign Order Created</b>\nOrder ID: <code>${orderId}</code>\nService: <b>${escapeHtml(svc.title)}</b>\nStatus: <b>PENDING</b>`,
        { reply_markup: userKb }
      );
      await telegram
        .sendMessage(
          token,
          bot.owner_telegram_id,
          `📦 <b>New SMM Order</b> <code>${orderId}</code>\nService: ${escapeHtml(svc.title)}\nClient: <code>${endUser.telegram_id}</code>\nBrief: ${escapeHtml(text.slice(0, 300))}`,
          {
            reply_markup: buildInlineKeyboard([
              [
                inlineButton({ text: '🔄 In Progress', callbackData: `smm:st:in_progress:${orderId}`, style: BUTTON_STYLES.PRIMARY }),
                inlineButton({ text: '✅ Complete', callbackData: `smm:st:completed:${orderId}`, style: BUTTON_STYLES.SUCCESS }),
              ],
              [inlineButton({ text: '❌ Cancel & Refund', callbackData: `smm:st:refunded:${orderId}`, style: BUTTON_STYLES.DANGER })],
            ]),
          }
        )
        .catch(() => {});
      return;
    }

    if (isAdmin && state.step === 'adm_new_service') {
      await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
      if (FAKE_ENGAGEMENT_REGEX.test(text)) {
        await telegram.sendMessage(token, chatId, '🚫 Rejected: Only legitimate marketing services are allowed.', { reply_markup: adminKb });
        return;
      }
      const [category, title, priceStr, description] = text.split('|').map((s) => (s || '').trim());
      const price = Number(priceStr);
      if (!category || !title || !Number.isFinite(price)) {
        await telegram.sendMessage(token, chatId, '❌ Format: <code>Category | Title | Price | Description</code>', { reply_markup: adminKb });
        return;
      }
      await repos.db.run(
        `INSERT INTO services (id, bot_id, category, title, description, price_points, approval_status)
         VALUES (?, ?, ?, ?, ?, ?, 'approved')`,
        [newId('svc'), bot.id, category, title, description || '', price]
      );
      await telegram.sendMessage(token, chatId, `✅ Marketing service <b>${escapeHtml(title)}</b> added.`, { reply_markup: adminKb });
      return;
    }

    if (isAdmin && state.step === 'adm_provider_api') {
      await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
      if (text.toLowerCase() === 'clear') {
        await repos.botConfigs.upsert(bot.id, {
          ...config,
          templateSettings: { ...(config.templateSettings || {}), providerApiUrl: '', providerApiKeyConfigured: false },
        });
        await invalidateTenantCache(env, bot.id);
        await telegram.sendMessage(token, chatId, '✅ External SMM Provider API cleared (manual order mode active).', { reply_markup: adminKb });
        return;
      }
      const check = validateSafeUrl(text);
      if (!check.valid) {
        await telegram.sendMessage(token, chatId, `❌ Invalid API endpoint URL: ${escapeHtml(check.error)}`, { reply_markup: adminKb });
        return;
      }
      await repos.botConfigs.upsert(bot.id, {
        ...config,
        templateSettings: { ...(config.templateSettings || {}), providerApiUrl: check.url },
      });
      await invalidateTenantCache(env, bot.id);
      await telegram.sendMessage(
        token,
        chatId,
        `✅ External Provider API Endpoint saved:\n<code>${escapeHtml(check.url)}</code>\n<i>Note: Provider API keys must be stored as server-side secrets, never in plain text chats.</i>`,
        { reply_markup: adminKb }
      );
      return;
    }
  }

  // Template-specific Admin ReplyKeyboard actions
  if (isAdmin && text === '➕ Add Service') {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, { scope: 'tenant_admin', step: 'adm_new_service' });
    await telegram.sendMessage(token, chatId, 'Send service details:\n<code>Category | Title | Price | Description</code>', {
      reply_markup: buildCancelReplyKeyboard(),
    });
    return;
  }

  if (isAdmin && text === '📁 Open Orders') {
    const { rows } = await repos.db.all(
      `SELECT o.*, s.title FROM service_orders o JOIN services s ON o.service_id = s.id WHERE o.bot_id = ? AND o.status IN ('pending', 'in_progress') LIMIT 8`,
      [bot.id]
    );
    if (!rows.length) {
      await telegram.sendMessage(token, chatId, '✅ No open SMM orders.', { reply_markup: adminKb });
      return;
    }
    for (const o of rows) {
      await telegram.sendMessage(
        token,
        chatId,
        `Order <code>${o.id}</code> (${o.status})\n${escapeHtml(o.title)}\nBrief: ${escapeHtml(o.target_details)}`,
        { reply_markup: buildApprovalButtons(`smm:st:completed:${o.id}`, `smm:st:refunded:${o.id}`, '✅ Complete', '❌ Refund') }
      );
    }
    return;
  }

  if (isAdmin && text === '💳 Pending Deposits') {
    const pending = await repos.payments.listPending(bot.id, 10);
    if (!pending.length) {
      await telegram.sendMessage(token, chatId, '✅ No pending deposit proofs.', { reply_markup: adminKb });
      return;
    }
    for (const p of pending) {
      await telegram.sendMessage(
        token,
        chatId,
        `💳 <b>Deposit Proof</b> <code>${p.id}</code>\nUser: <code>${p.user_telegram_id}</code>\nAmount: <b>${p.amount} ${escapeHtml(p.currency)}</b>\nUTR: <code>${escapeHtml(p.utr_number || 'Screenshot')}</code>`,
        { reply_markup: buildApprovalButtons(`smm:dep:approve:${p.id}`, `smm:dep:reject:${p.id}`, '✅ Approve & Credit', '❌ Reject') }
      );
    }
    return;
  }

  if (isAdmin && text === '🔌 Provider API Config') {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, { scope: 'tenant_admin', step: 'adm_provider_api' });
    await telegram.sendMessage(
      token,
      chatId,
      `<b>🔌 External SMM Provider API</b>\nCurrent Endpoint: <code>${escapeHtml(config.templateSettings?.providerApiUrl || 'Not configured')}</code>\n\nSend a valid HTTPS Provider API endpoint URL (or <code>clear</code>):`,
      { reply_markup: buildCancelReplyKeyboard() }
    );
    return;
  }

  // User buttons
  switch (text) {
    case '📦 Services':
    case '🛒 New Order': {
      const { rows } = await repos.db.all(
        `SELECT * FROM services WHERE bot_id = ? AND is_active = 1 AND approval_status = 'approved' ORDER BY category, title LIMIT 12`,
        [bot.id]
      );
      if (!rows.length) {
        await telegram.sendMessage(token, chatId, 'No marketing packages configured yet.', { reply_markup: userKb });
        return;
      }
      const buttons = rows.map((s) => [
        inlineButton({ text: `${s.title} (${s.price_points} ${currency})`, callbackData: `smm:pick:${s.id}`, style: BUTTON_STYLES.PRIMARY }),
      ]);
      await telegram.sendMessage(
        token,
        chatId,
        formatBrandedMessage(config, { heading: '📦 Marketing Packages', body: 'Select a package to place an order:' }),
        { reply_markup: buildInlineKeyboard(buttons) }
      );
      return;
    }

    case '📁 My Orders': {
      const { rows } = await repos.db.all(
        `SELECT o.*, s.title FROM service_orders o JOIN services s ON o.service_id = s.id
         WHERE o.bot_id = ? AND o.user_telegram_id = ? ORDER BY o.created_at DESC LIMIT 10`,
        [bot.id, endUser.telegram_id]
      );
      const body = rows.length
        ? rows.map((o) => `• <code>${o.id}</code> — <b>${escapeHtml(o.title)}</b> · <b>${o.status.toUpperCase()}</b>`).join('\n')
        : '<i>No orders found.</i>';
      await telegram.sendMessage(token, chatId, formatBrandedMessage(config, { heading: '📁 My Orders', body }), { reply_markup: userKb });
      return;
    }

    case '🔎 Order Status': {
      await repos.endUsers.setState(bot.id, endUser.telegram_id, { step: 'lookup_order' });
      await telegram.sendMessage(token, chatId, 'Send your Order ID (e.g. <code>smm_...</code>) to check live status:');
      return;
    }

    case '💰 Account Balance': {
      await telegram.sendMessage(
        token,
        chatId,
        formatBrandedMessage(config, {
          heading: '💰 Account Balance',
          body: `Available Balance: <b>${Number(endUser.points_balance || 0)} ${escapeHtml(currency)}</b>`,
        }),
        { reply_markup: userKb }
      );
      return;
    }

    case '💳 Add Funds': {
      const upi = buildUpiPaymentQr({
        upiId: config.templateSettings?.upiId,
        payeeName: config.templateSettings?.upiPayeeName || config.brandTitle || bot.display_name,
        amount: 0,
        note: 'SMM Wallet Deposit',
      });
      await repos.endUsers.setState(bot.id, endUser.telegram_id, { step: 'smm_deposit_proof' });
      if (upi.configured) {
        await telegram
          .sendPhoto(token, chatId, upi.qrUrl, {
            caption: `💳 <b>Add Funds via UPI</b>\nUPI ID: <code>${escapeHtml(config.templateSettings.upiId)}</code>\n\nAfter paying, send <code>Amount | UTR Number</code> (or upload screenshot with caption <code>Amount | UTR</code>). Balance credits after admin verification.`,
          })
          .catch(async () => {
            await telegram.sendMessage(
              token,
              chatId,
              `💳 <b>Add Funds via UPI</b>\nUPI ID: <code>${escapeHtml(config.templateSettings.upiId)}</code>\nSend <code>Amount | UTR Number</code> after paying.`
            );
          });
      } else {
        await telegram.sendMessage(
          token,
          chatId,
          '💳 <b>Submit Deposit Proof</b>\n<i>Note: UPI ID is not configured yet. Contact support or send <code>Amount | Reference/UTR</code> for manual admin verification.</i>'
        );
      }
      return;
    }

    case '🎧 Support': {
      await telegram.sendMessage(
        token,
        chatId,
        formatBrandedMessage(config, {
          heading: '🎧 Account Support',
          body: config.supportUsername ? `Message our desk at <b>${escapeHtml(config.supportUsername)}</b>.` : 'Support handle not configured yet.',
        }),
        { reply_markup: userKb }
      );
    }
  }
}

async function handleCallback(ctx, adminKb, currency) {
  const { bot, token, telegram, repos, update, endUser, isAdmin } = ctx;
  const cb = update.callback_query;
  const chatId = cb.message?.chat?.id;
  const data = cb.data || '';
  await telegram.answerCallbackQuery(token, cb.id).catch(() => {});

  if (data.startsWith('smm:pick:')) {
    const svcId = data.slice('smm:pick:'.length);
    await repos.endUsers.setState(bot.id, endUser.telegram_id, { step: 'place_order_brief', serviceId: svcId });
    await telegram.sendMessage(token, chatId, 'Send your campaign link, brand handle, and campaign objectives:');
    return;
  }

  if (!isAdmin) return;

  if (data.startsWith('smm:dep:approve:')) {
    const proofId = data.slice('smm:dep:approve:'.length);
    const result = await repos.payments.approveProof(bot.id, proofId, endUser.telegram_id);
    if (!result.transitioned) {
      await telegram.sendMessage(token, chatId, `⚠️ ${escapeHtml(result.reason)}`, { reply_markup: adminKb });
      return;
    }
    const { proof } = result;
    const nextBal = await repos.endUsers.adjustPoints(bot.id, proof.user_telegram_id, {
      delta: Number(proof.amount),
      txType: 'admin_credit',
      referenceId: proof.id,
      description: `Verified SMM deposit (${proof.utr_number || 'proof'})`,
    });
    await telegram
      .sendMessage(token, proof.user_telegram_id, `✅ Deposit <code>${proof.id}</code> verified! +<b>${proof.amount} ${escapeHtml(currency)}</b> credited. Balance: <b>${nextBal}</b>.`)
      .catch(() => {});
    await telegram.sendMessage(token, chatId, `✅ Approved deposit <code>${proof.id}</code>.`, { reply_markup: adminKb });
    return;
  }

  if (data.startsWith('smm:dep:reject:')) {
    const proofId = data.slice('smm:dep:reject:'.length);
    const result = await repos.payments.rejectProof(bot.id, proofId, endUser.telegram_id);
    if (!result.transitioned) {
      await telegram.sendMessage(token, chatId, `⚠️ ${escapeHtml(result.reason)}`, { reply_markup: adminKb });
      return;
    }
    await telegram
      .sendMessage(token, result.proof.user_telegram_id, `❌ Deposit proof <code>${proofId}</code> was rejected by admin.`)
      .catch(() => {});
    await telegram.sendMessage(token, chatId, `❌ Rejected deposit proof <code>${proofId}</code>.`, { reply_markup: adminKb });
    return;
  }

  if (data.startsWith('smm:st:')) {
    const [, , nextStatus, orderId] = data.split(':');
    const { row: ord } = await repos.db.first(`SELECT * FROM service_orders WHERE id = ? AND bot_id = ?`, [orderId, bot.id]);
    if (!ord) return;
    await repos.db.run(`UPDATE service_orders SET status = ?, updated_at = ? WHERE id = ?`, [nextStatus, new Date().toISOString(), orderId]);
    if (nextStatus === 'refunded' && ord.status !== 'refunded') {
      await repos.endUsers.adjustPoints(bot.id, ord.user_telegram_id, {
        delta: Number(ord.total_points),
        txType: 'order_refund',
        referenceId: orderId,
        description: 'SMM order refunded',
      });
    }
    await telegram.sendMessage(token, chatId, `✅ Order <code>${orderId}</code> updated to <b>${nextStatus.toUpperCase()}</b>.`, { reply_markup: adminKb });
    await telegram
      .sendMessage(token, ord.user_telegram_id, `📦 Your order <code>${orderId}</code> status is now: <b>${nextStatus.toUpperCase()}</b>.`)
      .catch(() => {});
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
