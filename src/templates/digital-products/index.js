/**
 * TEMPLATE: DIGITAL STORE BOT (Upgraded — backward-compatible with `digital-products`)
 *
 * - Categories, keyword search, pricing & stock counts
 * - Supports BOTH instant Credits checkout AND Legitimate UPI QR + UTR/Screenshot Payment Proof Verification
 * - Manual Admin verification required for UPI proof orders before automatic digital delivery
 * - Duplicate-approval protection (`WHERE status = 'pending'`)
 * - Dedicated Native ReplyKeyboard Tenant Admin Panel
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

export const DIGITAL_PRODUCTS_META = {
  id: 'tpl_digital_products',
  slug: 'digital-products',
  name: 'Digital Store Bot',
  category: 'Digital Commerce',
};

const ADMIN_EXTRA_BUTTONS = [
  { text: '➕ Add Product', style: BUTTON_STYLES.SUCCESS },
  { text: '💳 Pending Payment Proofs', style: BUTTON_STYLES.DANGER },
  { text: '🛍 Manage Products', style: BUTTON_STYLES.PRIMARY },
];

function buildUserKeyboard(isAdmin = false) {
  const rows = [
    [
      { text: '🛍 Product Catalogue', style: BUTTON_STYLES.SUCCESS },
      { text: '📂 Categories', style: BUTTON_STYLES.PRIMARY },
    ],
    [
      { text: '🔎 Search Products', style: BUTTON_STYLES.PRIMARY },
      { text: '🛒 My Orders', style: BUTTON_STYLES.PRIMARY },
    ],
    [
      { text: '📥 My Purchases', style: BUTTON_STYLES.SUCCESS },
      { text: '🎧 Support', style: BUTTON_STYLES.PRIMARY },
    ],
  ];
  if (isAdmin) {
    rows.push([{ text: ADMIN_COMMON_LABELS.OPEN_ADMIN, style: BUTTON_STYLES.DANGER }]);
  }
  return buildReplyKeyboard(rows, { resize: true, persistent: true });
}

export async function handleDigitalProductsUpdate(ctx) {
  const { bot, config, token, telegram, repos, update, endUser, isAdmin } = ctx;
  const userKb = buildUserKeyboard(isAdmin);
  const adminKb = buildTenantAdminReplyKeyboard(ADMIN_EXTRA_BUTTONS, { includeUpiSetup: true });
  const currency = config.templateSettings?.currencyLabel || 'INR';

  if (update.callback_query) {
    return handleCallback(ctx, userKb, adminKb, currency);
  }

  const msg = update.message;
  if (!msg) return;
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const state = safeParse(endUser.state_json);

  const handledAdmin = await handleCommonTenantAdmin(ctx, {
    panelTitle: 'Digital Store Admin Panel',
    extraButtons: ADMIN_EXTRA_BUTTONS,
    includeUpiSetup: true,
    userKeyboard: userKb,
    extraStatsSummary: async () => {
      const [pRes, oRes] = await Promise.all([
        repos.db.first(`SELECT COUNT(*) AS cnt FROM products WHERE bot_id = ? AND is_active = 1`, [bot.id]),
        repos.db.first(`SELECT COUNT(*) AS cnt FROM product_orders WHERE bot_id = ? AND status = 'delivered'`, [bot.id]),
      ]);
      return `• Active Products: <b>${Number(pRes.row?.cnt || 0)}</b>\n• Delivered Orders: <b>${Number(oRes.row?.cnt || 0)}</b>`;
    },
  });
  if (handledAdmin) return;

  if (text === '/start') {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
    await telegram.sendMessage(
      token,
      chatId,
      formatBrandedMessage(config, {
        heading: '🛍 Digital Product Store',
        body: `${config.welcomeMessage || 'Explore digital templates, ebooks, licenses, and downloads with verified instant delivery.'}\n\n💰 Credits Balance: <b>${Number(endUser.points_balance || 0)} ${escapeHtml(currency)}</b>`,
      }),
      { reply_markup: userKb }
    );
    return;
  }

  // Handle admin attaching a product file directly
  if (isAdmin && state?.step === 'adm_upload_file' && msg.document) {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
    const prodId = newId('prd');
    await repos.db.run(
      `INSERT INTO products (id, bot_id, category, title, description, price_points, delivery_type, delivery_payload, product_type)
       VALUES (?, ?, ?, ?, ?, ?, 'file_id', ?, 'digital')`,
      [prodId, bot.id, state.category, state.title, state.description, state.price, msg.document.file_id]
    );
    await telegram.sendMessage(
      token,
      chatId,
      `✅ <b>Product Published!</b>\nID: <code>${prodId}</code>\nTitle: <b>${escapeHtml(state.title)}</b>\nPrice: <b>${state.price} ${escapeHtml(currency)}</b>`,
      { reply_markup: adminKb }
    );
    return;
  }

  // Handle user UPI payment proof submission (UTR or screenshot photo)
  if (state?.step === 'dp_submit_proof' && (msg.photo || (text && !text.startsWith('/')))) {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
    const { row: prod } = await repos.db.first(
      `SELECT * FROM products WHERE id = ? AND bot_id = ? AND is_active = 1`,
      [state.productId, bot.id]
    );
    if (!prod) {
      await telegram.sendMessage(token, chatId, '❌ Product is no longer available.', { reply_markup: userKb });
      return;
    }

    const screenshotFileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : null;
    const utr = screenshotFileId ? (msg.caption || '').trim() : text;
    const orderId = newId('ord');
    await repos.db.run(
      `INSERT INTO product_orders (id, bot_id, product_id, user_telegram_id, price_points, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
      [orderId, bot.id, prod.id, endUser.telegram_id, prod.price_points]
    );

    const proof = await repos.payments.createProof({
      botId: bot.id,
      userTelegramId: endUser.telegram_id,
      orderType: 'digital_order',
      referenceId: orderId,
      itemTitle: prod.title,
      amount: prod.price_points,
      currency,
      paymentMethod: 'upi_manual',
      utrNumber: utr,
      screenshotFileId,
    });

    await telegram.sendMessage(
      token,
      chatId,
      `⏳ <b>Payment Proof Submitted</b>\nOrder ID: <code>${orderId}</code>\nProof ID: <code>${proof.id}</code>\nProduct: <b>${escapeHtml(prod.title)}</b>\nYour digital download will unlock automatically after admin approval.`,
      { reply_markup: userKb }
    );

    await telegram
      .sendMessage(
        token,
        bot.owner_telegram_id,
        `💳 <b>Digital Store Payment Proof</b>\nProof: <code>${proof.id}</code>\nOrder: <code>${orderId}</code>\nUser: <code>${endUser.telegram_id}</code>\nProduct: <b>${escapeHtml(prod.title)}</b> (${prod.price_points} ${escapeHtml(currency)})\nUTR: <code>${escapeHtml(utr || 'Screenshot')}</code>`,
        { reply_markup: buildApprovalButtons(`dp:pay:approve:${proof.id}`, `dp:pay:reject:${proof.id}`, '✅ Approve & Deliver', '❌ Reject') }
      )
      .catch(() => {});
    return;
  }

  if (state && !text.startsWith('/')) {
    if (state.step === 'search_products') {
      await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
      const like = `%${text}%`;
      const { rows } = await repos.db.all(
        `SELECT * FROM products WHERE bot_id = ? AND is_active = 1 AND (title LIKE ? OR description LIKE ? OR category LIKE ?) LIMIT 10`,
        [bot.id, like, like, like]
      );
      if (!rows.length) {
        await telegram.sendMessage(token, chatId, `No digital products matched "<b>${escapeHtml(text)}</b>".`, { reply_markup: userKb });
        return;
      }
      const kb = buildInlineKeyboard(
        rows.map((p) => [
          inlineButton({ text: `${p.title} — ${p.price_points} ${currency}`, callbackData: `dp:view:${p.id}`, style: BUTTON_STYLES.PRIMARY }),
        ])
      );
      await telegram.sendMessage(token, chatId, `🔎 <b>Search Results (${rows.length})</b>`, { reply_markup: kb });
      return;
    }

    if (isAdmin && state.step === 'adm_add_product_meta') {
      const [category, title, priceStr, description, deliveryPayload] = text.split('|').map((s) => (s || '').trim());
      const price = Number(priceStr);
      if (!category || !title || !Number.isFinite(price) || price < 0) {
        await telegram.sendMessage(
          token,
          chatId,
          '❌ Format: <code>Category | Title | Price | Description | FILE (or URL/license text)</code>',
          { reply_markup: buildCancelReplyKeyboard() }
        );
        return;
      }
      if (!deliveryPayload || deliveryPayload.toUpperCase() === 'FILE') {
        await repos.endUsers.setState(bot.id, endUser.telegram_id, {
          scope: 'tenant_admin',
          step: 'adm_upload_file',
          category,
          title,
          price,
          description: description || '',
        });
        await telegram.sendMessage(token, chatId, '📎 Now upload the authorized digital file (Document) to attach.', {
          reply_markup: buildCancelReplyKeyboard(),
        });
        return;
      }

      await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
      const deliveryType = /^https?:\/\//i.test(deliveryPayload) ? 'download_url' : 'text_license';
      const prodId = newId('prd');
      await repos.db.run(
        `INSERT INTO products (id, bot_id, category, title, description, price_points, delivery_type, delivery_payload, product_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'digital')`,
        [prodId, bot.id, category, title, description || '', price, deliveryType, deliveryPayload]
      );
      await telegram.sendMessage(token, chatId, `✅ Product <b>${escapeHtml(title)}</b> created (ID: <code>${prodId}</code>).`, {
        reply_markup: adminKb,
      });
      return;
    }
  }

  // Admin ReplyKeyboard actions
  if (isAdmin && text === '➕ Add Product') {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, { scope: 'tenant_admin', step: 'adm_add_product_meta' });
    await telegram.sendMessage(
      token,
      chatId,
      'Send product details:\n<code>Category | Title | Price | Description | FILE (or download URL / license key)</code>',
      { reply_markup: buildCancelReplyKeyboard() }
    );
    return;
  }

  if (isAdmin && text === '🛍 Manage Products') {
    const { rows } = await repos.db.all(
      `SELECT id, category, title, price_points FROM products WHERE bot_id = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 15`,
      [bot.id]
    );
    const body = rows.length
      ? rows.map((p) => `• <code>${p.id}</code> [${escapeHtml(p.category)}] <b>${escapeHtml(p.title)}</b> — ${p.price_points} ${escapeHtml(currency)}`).join('\n')
      : '<i>No digital products listed yet.</i>';
    await telegram.sendMessage(token, chatId, formatBrandedMessage(config, { heading: '🛍 Digital Products', body }), {
      reply_markup: adminKb,
    });
    return;
  }

  if (isAdmin && text === '💳 Pending Payment Proofs') {
    const pending = await repos.payments.listPending(bot.id, 10);
    if (!pending.length) {
      await telegram.sendMessage(token, chatId, '✅ No pending payment proofs.', { reply_markup: adminKb });
      return;
    }
    for (const p of pending) {
      await telegram.sendMessage(
        token,
        chatId,
        `💳 <b>Proof</b> <code>${p.id}</code>\nOrder: <code>${p.reference_id}</code>\nUser: <code>${p.user_telegram_id}</code>\nProduct: <b>${escapeHtml(p.item_title)}</b> (${p.amount} ${escapeHtml(p.currency)})\nUTR: <code>${escapeHtml(p.utr_number || 'Screenshot')}</code>`,
        { reply_markup: buildApprovalButtons(`dp:pay:approve:${p.id}`, `dp:pay:reject:${p.id}`, '✅ Approve & Deliver', '❌ Reject') }
      );
    }
    return;
  }

  // User buttons
  switch (text) {
    case '🛍 Product Catalogue': {
      const { rows } = await repos.db.all(
        `SELECT * FROM products WHERE bot_id = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 12`,
        [bot.id]
      );
      if (!rows.length) {
        await telegram.sendMessage(token, chatId, 'No digital products listed yet.', { reply_markup: userKb });
        return;
      }
      const kb = buildInlineKeyboard(
        rows.map((p) => [
          inlineButton({ text: `🛍 ${p.title} — ${p.price_points} ${currency}`, callbackData: `dp:view:${p.id}`, style: BUTTON_STYLES.PRIMARY }),
        ])
      );
      await telegram.sendMessage(
        token,
        chatId,
        formatBrandedMessage(config, { heading: '🛍 Digital Product Catalogue', body: 'Choose a product to inspect or purchase:' }),
        { reply_markup: kb }
      );
      return;
    }

    case '📂 Categories': {
      const { rows } = await repos.db.all(
        `SELECT category, COUNT(*) AS count FROM products WHERE bot_id = ? AND is_active = 1 GROUP BY category ORDER BY category`,
        [bot.id]
      );
      if (!rows.length) {
        await telegram.sendMessage(token, chatId, 'No categories available yet.', { reply_markup: userKb });
        return;
      }
      const kb = buildInlineKeyboard(
        rows.map((r) => [
          inlineButton({ text: `📂 ${r.category} (${r.count})`, callbackData: `dp:cat:${r.category.slice(0, 40)}`, style: BUTTON_STYLES.PRIMARY }),
        ])
      );
      await telegram.sendMessage(token, chatId, formatBrandedMessage(config, { heading: '📂 Categories', body: 'Select a category:' }), {
        reply_markup: kb,
      });
      return;
    }

    case '🔎 Search Products': {
      await repos.endUsers.setState(bot.id, endUser.telegram_id, { step: 'search_products' });
      await telegram.sendMessage(token, chatId, 'Send a keyword to search our digital catalogue:');
      return;
    }

    case '🛒 My Orders':
    case '📥 My Purchases': {
      const { rows } = await repos.db.all(
        `SELECT o.*, p.title FROM product_orders o JOIN products p ON o.product_id = p.id
         WHERE o.bot_id = ? AND o.user_telegram_id = ? ORDER BY o.created_at DESC LIMIT 10`,
        [bot.id, endUser.telegram_id]
      );
      if (!rows.length) {
        await telegram.sendMessage(token, chatId, 'You have no orders yet.', { reply_markup: userKb });
        return;
      }
      const delivered = rows.filter((o) => o.status === 'delivered');
      const kb = delivered.length
        ? buildInlineKeyboard(
            delivered.map((o) => [
              inlineButton({ text: `📥 Download: ${o.title}`, callbackData: `dp:dl:${o.id}`, style: BUTTON_STYLES.SUCCESS }),
            ])
          )
        : undefined;
      const summary = rows.map((o) => `• <code>${o.id}</code> — <b>${escapeHtml(o.title)}</b> (${o.price_points} ${escapeHtml(currency)}) · <b>${o.status.toUpperCase()}</b>`).join('\n');
      await telegram.sendMessage(token, chatId, formatBrandedMessage(config, { heading: text, body: summary }), {
        reply_markup: kb || userKb,
      });
      return;
    }

    case '🎧 Support': {
      await telegram.sendMessage(
        token,
        chatId,
        formatBrandedMessage(config, {
          heading: '🎧 Store Support',
          body: config.supportUsername ? `Contact ${escapeHtml(config.supportUsername)} for order help.` : 'Support handle not configured.',
        }),
        { reply_markup: userKb }
      );
    }
  }
}

async function handleCallback(ctx, userKb, adminKb, currency) {
  const { bot, config, token, telegram, repos, update, endUser, isAdmin } = ctx;
  const cb = update.callback_query;
  const chatId = cb.message?.chat?.id;
  const data = cb.data || '';
  await telegram.answerCallbackQuery(token, cb.id).catch(() => {});

  if (data.startsWith('dp:cat:')) {
    const cat = data.slice('dp:cat:'.length);
    const { rows } = await repos.db.all(
      `SELECT * FROM products WHERE bot_id = ? AND category = ? AND is_active = 1 LIMIT 12`,
      [bot.id, cat]
    );
    const kb = buildInlineKeyboard(
      rows.map((p) => [
        inlineButton({ text: `${p.title} — ${p.price_points} ${currency}`, callbackData: `dp:view:${p.id}`, style: BUTTON_STYLES.PRIMARY }),
      ])
    );
    await telegram.sendMessage(token, chatId, `📂 <b>${escapeHtml(cat)}</b>`, { reply_markup: kb });
    return;
  }

  if (data.startsWith('dp:view:')) {
    const prodId = data.slice('dp:view:'.length);
    const { row: p } = await repos.db.first(`SELECT * FROM products WHERE id = ? AND bot_id = ?`, [prodId, bot.id]);
    if (!p) return;
    await telegram.sendMessage(
      token,
      chatId,
      formatBrandedMessage(config, {
        heading: p.title,
        body: `Category: <b>${escapeHtml(p.category)}</b>\nPrice: <b>${p.price_points} ${escapeHtml(currency)}</b>\n\n${escapeHtml(p.description || 'Verified digital delivery.')}`,
      }),
      {
        reply_markup: buildInlineKeyboard([
          [inlineButton({ text: `💳 Pay via UPI QR (${p.price_points} ${currency})`, callbackData: `dp:upi:${p.id}`, style: BUTTON_STYLES.SUCCESS })],
          [inlineButton({ text: `💰 Pay with Balance (${p.price_points} ${currency})`, callbackData: `dp:buy:${p.id}`, style: BUTTON_STYLES.PRIMARY })],
        ]),
      }
    );
    return;
  }

  if (data.startsWith('dp:upi:')) {
    const prodId = data.slice('dp:upi:'.length);
    const { row: p } = await repos.db.first(`SELECT * FROM products WHERE id = ? AND bot_id = ? AND is_active = 1`, [prodId, bot.id]);
    if (!p) return;
    const upi = buildUpiPaymentQr({
      upiId: config.templateSettings?.upiId,
      payeeName: config.templateSettings?.upiPayeeName || config.brandTitle || bot.display_name,
      amount: p.price_points,
      note: p.title,
    });
    await repos.endUsers.setState(bot.id, endUser.telegram_id, { step: 'dp_submit_proof', productId: p.id });
    if (upi.configured) {
      await telegram
        .sendPhoto(token, chatId, upi.qrUrl, {
          caption: `💳 <b>UPI Payment — ${escapeHtml(p.title)}</b>\nAmount: <b>${p.price_points} ${escapeHtml(currency)}</b>\nUPI ID: <code>${escapeHtml(config.templateSettings.upiId)}</code>\n\nSend your <b>UTR number</b> or upload a <b>payment screenshot</b>. Product unlocks automatically after admin verification.`,
        })
        .catch(async () => {
          await telegram.sendMessage(
            token,
            chatId,
            `💳 <b>UPI Payment — ${escapeHtml(p.title)}</b>\nUPI ID: <code>${escapeHtml(config.templateSettings.upiId)}</code>\nSend your UTR number or payment screenshot.`
          );
        });
    } else {
      await telegram.sendMessage(
        token,
        chatId,
        `💳 <b>Manual Payment Proof — ${escapeHtml(p.title)}</b> (${p.price_points} ${escapeHtml(currency)})\n<i>UPI ID not configured by store admin yet. Submit your UTR/screenshot proof or contact support.</i>`
      );
    }
    return;
  }

  if (data.startsWith('dp:buy:')) {
    const prodId = data.slice('dp:buy:'.length);
    const { row: p } = await repos.db.first(`SELECT * FROM products WHERE id = ? AND bot_id = ? AND is_active = 1`, [prodId, bot.id]);
    if (!p) return;
    if (Number(endUser.points_balance || 0) < Number(p.price_points)) {
      await telegram.sendMessage(token, chatId, `❌ Insufficient balance. Needed: <b>${p.price_points} ${escapeHtml(currency)}</b>. Use UPI QR checkout instead.`);
      return;
    }
    const orderId = newId('ord');
    if (Number(p.price_points) > 0) {
      await repos.endUsers.adjustPoints(bot.id, endUser.telegram_id, {
        delta: -Number(p.price_points),
        txType: 'order_debit',
        referenceId: orderId,
        description: `Purchased digital product: ${p.title}`,
      });
    }
    await repos.db.run(
      `INSERT INTO product_orders (id, bot_id, product_id, user_telegram_id, price_points, status) VALUES (?, ?, ?, ?, ?, 'delivered')`,
      [orderId, bot.id, p.id, endUser.telegram_id, p.price_points]
    );
    await deliverProduct(telegram, token, chatId, p, orderId);
    return;
  }

  if (data.startsWith('dp:dl:')) {
    const orderId = data.slice('dp:dl:'.length);
    const { row: o } = await repos.db.first(
      `SELECT o.id, o.status, p.title, p.delivery_type, p.delivery_payload FROM product_orders o JOIN products p ON o.product_id = p.id
       WHERE o.id = ? AND o.bot_id = ? AND o.user_telegram_id = ?`,
      [orderId, bot.id, endUser.telegram_id]
    );
    if (!o || o.status !== 'delivered') {
      await telegram.sendMessage(token, chatId, '⏳ Order is awaiting admin verification.');
      return;
    }
    await deliverProduct(telegram, token, chatId, o, o.id);
    return;
  }

  if (!isAdmin) return;

  if (data.startsWith('dp:pay:approve:')) {
    const proofId = data.slice('dp:pay:approve:'.length);
    const result = await repos.payments.approveProof(bot.id, proofId, endUser.telegram_id);
    if (!result.transitioned) {
      await telegram.sendMessage(token, chatId, `⚠️ ${escapeHtml(result.reason)}`, { reply_markup: adminKb });
      return;
    }
    const { proof } = result;
    await repos.db.run(
      `UPDATE product_orders SET status = 'delivered' WHERE id = ? AND bot_id = ?`,
      [proof.reference_id, bot.id]
    );
    const { row: p } = await repos.db.first(
      `SELECT p.* FROM product_orders o JOIN products p ON o.product_id = p.id WHERE o.id = ? AND o.bot_id = ?`,
      [proof.reference_id, bot.id]
    );
    if (p) {
      await deliverProduct(telegram, token, proof.user_telegram_id, p, proof.reference_id).catch(() => {});
    }
    await telegram.sendMessage(token, chatId, `✅ Approved proof <code>${proofId}</code> and delivered product.`, { reply_markup: adminKb });
    return;
  }

  if (data.startsWith('dp:pay:reject:')) {
    const proofId = data.slice('dp:pay:reject:'.length);
    const result = await repos.payments.rejectProof(bot.id, proofId, endUser.telegram_id);
    if (!result.transitioned) {
      await telegram.sendMessage(token, chatId, `⚠️ ${escapeHtml(result.reason)}`, { reply_markup: adminKb });
      return;
    }
    await repos.db.run(`UPDATE product_orders SET status = 'refunded' WHERE id = ? AND bot_id = ?`, [result.proof.reference_id, bot.id]);
    await telegram.sendMessage(token, result.proof.user_telegram_id, `❌ Payment proof <code>${proofId}</code> was rejected by admin.`).catch(() => {});
    await telegram.sendMessage(token, chatId, `❌ Rejected proof <code>${proofId}</code>.`, { reply_markup: adminKb });
  }
}

async function deliverProduct(telegram, token, chatId, product, orderId) {
  if (product.delivery_type === 'file_id') {
    await telegram.sendDocument(token, chatId, product.delivery_payload, {
      caption: `📥 <b>${escapeHtml(product.title)}</b>\nOrder ID: <code>${orderId}</code>`,
    });
  } else {
    await telegram.sendMessage(
      token,
      chatId,
      `✅ <b>Delivery Ready — ${escapeHtml(product.title)}</b>\nOrder ID: <code>${orderId}</code>\n\n<code>${escapeHtml(product.delivery_payload)}</code>`
    );
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
