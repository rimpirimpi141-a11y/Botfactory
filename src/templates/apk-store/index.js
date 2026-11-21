/**
 * TEMPLATE: APK STORE BOT (Authorized Android App Distribution)
 *
 * - Categories, app listing, details, version & file size metadata
 * - Pricing, UPI QR / manual payment proof submission (UTR or screenshot)
 * - Manual Admin verification required before automatic APK delivery
 * - Order history & redownload for approved orders
 * - Dedicated ReplyKeyboard Tenant Admin Panel
 * - Policy notice: Authorized, developer-owned, or legitimately licensed builds only.
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

export const APK_STORE_META = {
  id: 'tpl_apk_store',
  slug: 'apk-store',
  name: 'APK Store Bot',
  category: 'App Distribution',
};

const ADMIN_EXTRA_BUTTONS = [
  { text: '📦 Add APK Listing', style: BUTTON_STYLES.SUCCESS },
  { text: '💳 Pending Payment Proofs', style: BUTTON_STYLES.DANGER },
  { text: '📱 Manage APKs', style: BUTTON_STYLES.PRIMARY },
];

function buildUserKeyboard(isAdmin = false) {
  const rows = [
    [
      { text: '📱 Browse APKs', style: BUTTON_STYLES.SUCCESS },
      { text: '📂 Categories', style: BUTTON_STYLES.PRIMARY },
    ],
    [
      { text: '🛒 My APK Orders', style: BUTTON_STYLES.PRIMARY },
      { text: '📥 My Downloads', style: BUTTON_STYLES.SUCCESS },
    ],
    [{ text: '🎧 Support', style: BUTTON_STYLES.PRIMARY }],
  ];
  if (isAdmin) {
    rows.push([{ text: ADMIN_COMMON_LABELS.OPEN_ADMIN, style: BUTTON_STYLES.DANGER }]);
  }
  return buildReplyKeyboard(rows, { resize: true, persistent: true });
}

export async function handleApkStoreUpdate(ctx) {
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

  // Common Tenant Admin Panel
  const handledAdmin = await handleCommonTenantAdmin(ctx, {
    panelTitle: 'APK Store Admin Panel',
    extraButtons: ADMIN_EXTRA_BUTTONS,
    includeUpiSetup: true,
    userKeyboard: userKb,
    extraStatsSummary: async () => {
      const { row } = await repos.db.first(
        `SELECT COUNT(*) AS apks FROM products WHERE bot_id = ? AND product_type = 'apk' AND is_active = 1`,
        [bot.id]
      );
      return `• Listed Authorized APKs: <b>${Number(row?.apks || 0)}</b>`;
    },
  });
  if (handledAdmin) return;

  if (text === '/start') {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
    await telegram.sendMessage(
      token,
      chatId,
      formatBrandedMessage(config, {
        heading: '📱 Authorized APK Store',
        body: `${config.welcomeMessage || 'Browse verified, authorized Android APK builds with version details and verified delivery.'}\n\n<i>Notice: Only authorized, developer-owned, or legitimately licensed APKs are distributed here.</i>`,
      }),
      { reply_markup: userKb }
    );
    return;
  }

  // Handle admin APK upload
  if (isAdmin && state?.step === 'apk_adm_upload_file' && msg.document) {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
    const id = newId('apk');
    await repos.db.run(
      `INSERT INTO products (id, bot_id, category, title, description, price_points, delivery_type, delivery_payload, product_type, version, file_size)
       VALUES (?, ?, ?, ?, ?, ?, 'file_id', ?, 'apk', ?, ?)`,
      [
        id,
        bot.id,
        state.category,
        state.title,
        state.description,
        state.price,
        msg.document.file_id,
        state.version || '1.0.0',
        formatBytes(msg.document.file_size),
      ]
    );
    await telegram.sendMessage(
      token,
      chatId,
      `✅ <b>APK Published!</b>\nID: <code>${id}</code>\nApp: <b>${escapeHtml(state.title)}</b> (v${escapeHtml(state.version || '1.0.0')})\nPrice: <b>${state.price} ${escapeHtml(currency)}</b>`,
      { reply_markup: adminKb }
    );
    return;
  }

  // Handle user payment proof submission (UTR text or screenshot photo)
  if (state?.step === 'apk_submit_proof' && (msg.photo || (text && !text.startsWith('/')))) {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
    const { row: app } = await repos.db.first(
      `SELECT * FROM products WHERE id = ? AND bot_id = ? AND is_active = 1`,
      [state.productId, bot.id]
    );
    if (!app) {
      await telegram.sendMessage(token, chatId, '❌ App listing no longer exists.', { reply_markup: userKb });
      return;
    }

    const screenshotFileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : null;
    const utrText = screenshotFileId ? (msg.caption || '').trim() : text;
    const orderId = newId('ord');
    await repos.db.run(
      `INSERT INTO product_orders (id, bot_id, product_id, user_telegram_id, price_points, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
      [orderId, bot.id, app.id, endUser.telegram_id, app.price_points]
    );

    const proof = await repos.payments.createProof({
      botId: bot.id,
      userTelegramId: endUser.telegram_id,
      orderType: 'apk_order',
      referenceId: orderId,
      itemTitle: app.title,
      amount: app.price_points,
      currency,
      paymentMethod: 'upi_manual',
      utrNumber: utrText,
      screenshotFileId,
    });

    await telegram.sendMessage(
      token,
      chatId,
      `⏳ <b>Payment Proof Submitted for Admin Review</b>\nOrder ID: <code>${orderId}</code>\nProof ID: <code>${proof.id}</code>\nApp: <b>${escapeHtml(app.title)}</b>\n\nYour APK download will be delivered automatically once an admin verifies your payment.`,
      { reply_markup: userKb }
    );

    await telegram
      .sendMessage(
        token,
        bot.owner_telegram_id,
        `💳 <b>New APK Payment Proof</b>\nProof: <code>${proof.id}</code>\nOrder: <code>${orderId}</code>\nUser: <code>${endUser.telegram_id}</code>\nApp: <b>${escapeHtml(app.title)}</b> (${app.price_points} ${escapeHtml(currency)})\nUTR/Note: <code>${escapeHtml(utrText || 'Screenshot attached')}</code>`,
        {
          reply_markup: buildApprovalButtons(
            `apk:pay:approve:${proof.id}`,
            `apk:pay:reject:${proof.id}`,
            '✅ Approve & Deliver APK',
            '❌ Reject Proof'
          ),
        }
      )
      .catch(() => {});
    return;
  }

  // Handle admin adding APK metadata
  if (isAdmin && state?.step === 'apk_adm_add_meta' && !text.startsWith('/')) {
    const [category, title, version, priceStr, description, deliveryPayload] = text.split('|').map((s) => (s || '').trim());
    const price = Number(priceStr);
    if (!category || !title || !Number.isFinite(price) || price < 0) {
      await telegram.sendMessage(
        token,
        chatId,
        '❌ Format:\n<code>Category | App Name | Version | Price | Description | FILE (or https://download-url)</code>',
        { reply_markup: buildCancelReplyKeyboard() }
      );
      return;
    }

    if (!deliveryPayload || deliveryPayload.toUpperCase() === 'FILE') {
      await repos.endUsers.setState(bot.id, endUser.telegram_id, {
        step: 'apk_adm_upload_file',
        category,
        title,
        version: version || '1.0.0',
        price,
        description: description || '',
      });
      await telegram.sendMessage(token, chatId, '📎 Now upload the authorized APK file (Document) to attach to this listing.', {
        reply_markup: buildCancelReplyKeyboard(),
      });
      return;
    }

    await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
    const id = newId('apk');
    await repos.db.run(
      `INSERT INTO products (id, bot_id, category, title, description, price_points, delivery_type, delivery_payload, product_type, version)
       VALUES (?, ?, ?, ?, ?, ?, 'download_url', ?, 'apk', ?)`,
      [id, bot.id, category, title, description || '', price, deliveryPayload, version || '1.0.0']
    );
    await telegram.sendMessage(
      token,
      chatId,
      `✅ APK <b>${escapeHtml(title)}</b> v${escapeHtml(version || '1.0.0')} added (ID: <code>${id}</code>).`,
      { reply_markup: adminKb }
    );
    return;
  }

  // Template-specific Admin ReplyKeyboard buttons
  if (isAdmin && text === '📦 Add APK Listing') {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, { scope: 'tenant_admin', step: 'apk_adm_add_meta' });
    await telegram.sendMessage(
      token,
      chatId,
      'Send APK details:\n<code>Category | App Name | Version | Price | Description | FILE (or authorized URL)</code>',
      { reply_markup: buildCancelReplyKeyboard() }
    );
    return;
  }

  if (isAdmin && text === '📱 Manage APKs') {
    const { rows } = await repos.db.all(
      `SELECT id, title, version, price_points, category FROM products WHERE bot_id = ? AND product_type = 'apk' AND is_active = 1 ORDER BY created_at DESC LIMIT 15`,
      [bot.id]
    );
    const body = rows.length
      ? rows.map((a) => `• <code>${a.id}</code> — <b>${escapeHtml(a.title)}</b> v${escapeHtml(a.version || '1.0')} (${a.price_points} ${escapeHtml(currency)})`).join('\n')
      : '<i>No APKs listed yet.</i>';
    await telegram.sendMessage(token, chatId, formatBrandedMessage(config, { heading: '📱 Active APK Listings', body }), {
      reply_markup: adminKb,
    });
    return;
  }

  if (isAdmin && text === '💳 Pending Payment Proofs') {
    const pending = await repos.payments.listPending(bot.id, 10);
    if (!pending.length) {
      await telegram.sendMessage(token, chatId, '✅ No pending payment proofs to verify.', { reply_markup: adminKb });
      return;
    }
    for (const p of pending) {
      await telegram.sendMessage(
        token,
        chatId,
        `💳 <b>Proof</b> <code>${p.id}</code>\nOrder: <code>${p.reference_id}</code>\nUser: <code>${p.user_telegram_id}</code>\nItem: <b>${escapeHtml(p.item_title)}</b>\nAmount: <b>${p.amount} ${escapeHtml(p.currency)}</b>\nUTR: <code>${escapeHtml(p.utr_number || 'Screenshot')}</code>`,
        {
          reply_markup: buildApprovalButtons(
            `apk:pay:approve:${p.id}`,
            `apk:pay:reject:${p.id}`,
            '✅ Approve & Deliver',
            '❌ Reject'
          ),
        }
      );
    }
    return;
  }

  // User buttons
  switch (text) {
    case '📱 Browse APKs': {
      const { rows } = await repos.db.all(
        `SELECT * FROM products WHERE bot_id = ? AND product_type = 'apk' AND is_active = 1 ORDER BY created_at DESC LIMIT 15`,
        [bot.id]
      );
      if (!rows.length) {
        await telegram.sendMessage(token, chatId, 'No APKs listed yet. Check back soon!', { reply_markup: userKb });
        return;
      }
      const kb = buildInlineKeyboard(
        rows.map((p) => [
          inlineButton({
            text: `📱 ${p.title} v${p.version || '1.0'} — ${Number(p.price_points) === 0 ? 'FREE' : `${p.price_points} ${currency}`}`,
            callbackData: `apk:view:${p.id}`,
            style: BUTTON_STYLES.PRIMARY,
          }),
        ])
      );
      await telegram.sendMessage(
        token,
        chatId,
        formatBrandedMessage(config, { heading: '📱 Available Authorized APKs', body: 'Select an app to view details or download:' }),
        { reply_markup: kb }
      );
      return;
    }

    case '📂 Categories': {
      const { rows } = await repos.db.all(
        `SELECT category, COUNT(*) AS count FROM products WHERE bot_id = ? AND product_type = 'apk' AND is_active = 1 GROUP BY category`,
        [bot.id]
      );
      if (!rows.length) {
        await telegram.sendMessage(token, chatId, 'No APK categories available yet.', { reply_markup: userKb });
        return;
      }
      const kb = buildInlineKeyboard(
        rows.map((r) => [
          inlineButton({ text: `📂 ${r.category} (${r.count})`, callbackData: `apk:cat:${r.category.slice(0, 40)}`, style: BUTTON_STYLES.PRIMARY }),
        ])
      );
      await telegram.sendMessage(token, chatId, '📂 <b>APK Categories</b>', { reply_markup: kb });
      return;
    }

    case '🛒 My APK Orders':
    case '📥 My Downloads': {
      const { rows } = await repos.db.all(
        `SELECT o.*, p.title, p.version FROM product_orders o JOIN products p ON o.product_id = p.id
         WHERE o.bot_id = ? AND o.user_telegram_id = ? ORDER BY o.created_at DESC LIMIT 10`,
        [bot.id, endUser.telegram_id]
      );
      if (!rows.length) {
        await telegram.sendMessage(token, chatId, 'You have no APK orders yet.', { reply_markup: userKb });
        return;
      }
      const delivered = rows.filter((r) => r.status === 'delivered');
      const summary = rows
        .map((o) => `• <code>${o.id}</code> — <b>${escapeHtml(o.title)}</b> · <b>${o.status.toUpperCase()}</b>`)
        .join('\n');
      const kb = delivered.length
        ? buildInlineKeyboard(
            delivered.map((o) => [
              inlineButton({ text: `📥 Download ${o.title}`, callbackData: `apk:dl:${o.id}`, style: BUTTON_STYLES.SUCCESS }),
            ])
          )
        : undefined;
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
          heading: '🎧 APK Store Support',
          body: config.supportUsername ? `Contact ${escapeHtml(config.supportUsername)} for order assistance.` : 'Support handle not configured yet.',
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

  if (data.startsWith('apk:cat:')) {
    const cat = data.slice('apk:cat:'.length);
    const { rows } = await repos.db.all(
      `SELECT * FROM products WHERE bot_id = ? AND product_type = 'apk' AND category = ? AND is_active = 1 LIMIT 12`,
      [bot.id, cat]
    );
    const kb = buildInlineKeyboard(
      rows.map((p) => [inlineButton({ text: `📱 ${p.title} (${p.price_points} ${currency})`, callbackData: `apk:view:${p.id}`, style: BUTTON_STYLES.PRIMARY })])
    );
    await telegram.sendMessage(token, chatId, `📂 <b>${escapeHtml(cat)}</b>`, { reply_markup: kb });
    return;
  }

  if (data.startsWith('apk:view:')) {
    const id = data.slice('apk:view:'.length);
    const { row: app } = await repos.db.first(`SELECT * FROM products WHERE id = ? AND bot_id = ?`, [id, bot.id]);
    if (!app) return;
    await telegram.sendMessage(
      token,
      chatId,
      formatBrandedMessage(config, {
        heading: `📱 ${app.title}`,
        body: [
          `• Category: <b>${escapeHtml(app.category)}</b>`,
          `• Version: <b>v${escapeHtml(app.version || '1.0.0')}</b>`,
          app.file_size ? `• Size: <b>${escapeHtml(app.file_size)}</b>` : null,
          `• Price: <b>${Number(app.price_points) === 0 ? 'FREE' : `${app.price_points} ${escapeHtml(currency)}`}</b>`,
          `\n${escapeHtml(app.description || 'Authorized APK build.')}`,
        ]
          .filter(Boolean)
          .join('\n'),
      }),
      {
        reply_markup: buildInlineKeyboard([
          [
            inlineButton({
              text: Number(app.price_points) === 0 ? '📥 Get Free APK' : `💳 Pay & Order (${app.price_points} ${currency})`,
              callbackData: `apk:buy:${app.id}`,
              style: BUTTON_STYLES.SUCCESS,
            }),
          ],
        ]),
      }
    );
    return;
  }

  if (data.startsWith('apk:buy:')) {
    const id = data.slice('apk:buy:'.length);
    const { row: app } = await repos.db.first(`SELECT * FROM products WHERE id = ? AND bot_id = ? AND is_active = 1`, [id, bot.id]);
    if (!app) return;

    // Free authorized APK can be delivered immediately
    if (Number(app.price_points) <= 0) {
      const orderId = newId('ord');
      await repos.db.run(
        `INSERT INTO product_orders (id, bot_id, product_id, user_telegram_id, price_points, status) VALUES (?, ?, ?, ?, 0, 'delivered')`,
        [orderId, bot.id, app.id, endUser.telegram_id]
      );
      await deliverApk(telegram, token, chatId, app, orderId);
      return;
    }

    // Paid APK: display UPI QR / instructions and prompt for UTR or screenshot proof
    const upi = buildUpiPaymentQr({
      upiId: config.templateSettings?.upiId,
      payeeName: config.templateSettings?.upiPayeeName || config.brandTitle || bot.display_name,
      amount: app.price_points,
      note: `APK ${app.title}`,
    });
    await repos.endUsers.setState(bot.id, endUser.telegram_id, { step: 'apk_submit_proof', productId: app.id });

    if (upi.configured) {
      await telegram
        .sendPhoto(token, chatId, upi.qrUrl, {
          caption: `💳 <b>UPI Payment — ${escapeHtml(app.title)}</b>\nAmount: <b>${app.price_points} ${escapeHtml(currency)}</b>\nUPI ID: <code>${escapeHtml(config.templateSettings.upiId)}</code>\n\nAfter paying, send your <b>UTR number</b> or upload a <b>payment screenshot</b> here. Download unlocks immediately after admin verification.`,
        })
        .catch(async () => {
          await telegram.sendMessage(
            token,
            chatId,
            `💳 <b>UPI Payment — ${escapeHtml(app.title)}</b>\nAmount: <b>${app.price_points} ${escapeHtml(currency)}</b>\nUPI ID: <code>${escapeHtml(config.templateSettings.upiId)}</code>\n\nSend your UTR number or payment screenshot for admin verification.`
          );
        });
    } else {
      await telegram.sendMessage(
        token,
        chatId,
        `💳 <b>Manual Payment Proof — ${escapeHtml(app.title)}</b>\nAmount: <b>${app.price_points} ${escapeHtml(currency)}</b>\n<i>Note: UPI ID is not configured by store admin yet. Contact support or submit your UTR/screenshot proof below.</i>`
      );
    }
    return;
  }

  if (data.startsWith('apk:dl:')) {
    const orderId = data.slice('apk:dl:'.length);
    const { row } = await repos.db.first(
      `SELECT o.id, o.status, p.title, p.delivery_type, p.delivery_payload
       FROM product_orders o JOIN products p ON o.product_id = p.id
       WHERE o.id = ? AND o.bot_id = ? AND o.user_telegram_id = ?`,
      [orderId, bot.id, endUser.telegram_id]
    );
    if (!row || row.status !== 'delivered') {
      await telegram.sendMessage(token, chatId, '⏳ Order is not yet verified for download.');
      return;
    }
    await deliverApk(telegram, token, chatId, row, row.id);
    return;
  }

  if (!isAdmin) return;

  if (data.startsWith('apk:pay:approve:')) {
    const proofId = data.slice('apk:pay:approve:'.length);
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
    const { row: app } = await repos.db.first(
      `SELECT p.* FROM product_orders o JOIN products p ON o.product_id = p.id WHERE o.id = ? AND o.bot_id = ?`,
      [proof.reference_id, bot.id]
    );
    if (app) {
      await deliverApk(telegram, token, proof.user_telegram_id, app, proof.reference_id).catch(() => {});
    }
    await telegram.sendMessage(
      token,
      chatId,
      `✅ Payment proof <code>${proof.id}</code> approved and APK delivered to user <code>${proof.user_telegram_id}</code>.`,
      { reply_markup: adminKb }
    );
    return;
  }

  if (data.startsWith('apk:pay:reject:')) {
    const proofId = data.slice('apk:pay:reject:'.length);
    const result = await repos.payments.rejectProof(bot.id, proofId, endUser.telegram_id);
    if (!result.transitioned) {
      await telegram.sendMessage(token, chatId, `⚠️ ${escapeHtml(result.reason)}`, { reply_markup: adminKb });
      return;
    }
    await repos.db.run(
      `UPDATE product_orders SET status = 'refunded' WHERE id = ? AND bot_id = ?`,
      [result.proof.reference_id, bot.id]
    );
    await telegram
      .sendMessage(token, result.proof.user_telegram_id, `❌ Your APK payment proof <code>${proofId}</code> was rejected by admin.`)
      .catch(() => {});
    await telegram.sendMessage(token, chatId, `❌ Payment proof <code>${proofId}</code> rejected.`, { reply_markup: adminKb });
  }
}

async function deliverApk(telegram, token, chatId, app, orderId) {
  if (app.delivery_type === 'file_id') {
    await telegram.sendDocument(token, chatId, app.delivery_payload, {
      caption: `📥 <b>${escapeHtml(app.title)}</b>\nOrder: <code>${orderId}</code>`,
    });
  } else {
    await telegram.sendMessage(
      token,
      chatId,
      `✅ <b>Verified APK Download Ready</b>\nApp: <b>${escapeHtml(app.title)}</b>\nOrder: <code>${orderId}</code>\nDownload Link:\n<code>${escapeHtml(app.delivery_payload)}</code>`
    );
  }
}

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(2)} MB`;
}

function safeParse(str) {
  if (!str) return null;
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}
