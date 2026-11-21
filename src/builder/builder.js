/**
 * Custom No-Code Bot Runtime Engine + Dynamic Admin Panel Executor.
 *
 * Executes user-configured menus, submenus, messages, URLs, forms (`collect_input` / `submit_request`),
 * custom catalogues/orders, payment proofs, and an automatically generated Dynamic Admin Panel
 * directly from D1/KV configuration.
 */

import { buildMenuRenderPayload } from './preview.js';
import { createDefaultCustomMenuTree } from './menu-builder.js';
import { formatBrandedMessage } from './theme-engine.js';
import { generateDynamicAdminSpec } from './dynamic-admin.js';
import {
  buildApprovalButtons,
  buildInlineKeyboard,
  BUTTON_STYLES,
  inlineButton,
} from '../utils/keyboards.js';
import { escapeHtml } from '../utils/validation.js';
import { newId } from '../database/repositories.js';
import {
  buildCancelReplyKeyboard,
  buildUpiPaymentQr,
  handleCommonTenantAdmin,
} from '../templates/shared/tenant-admin.js';

export async function handleCustomBuilderUpdate(ctx) {
  const { bot, config, menus, token, telegram, repos, update, endUser, isAdmin } = ctx;
  const activeMenus = menus && menus.length > 0 ? menus : createDefaultCustomMenuTree(config.brandTitle);
  const rootMenu = activeMenus.find((m) => m.isRoot && m.scope === 'user') || activeMenus[0];
  const dynamicAdmin = generateDynamicAdminSpec(activeMenus, config);
  const currency = config.templateSettings?.currencyLabel || 'INR';

  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message?.chat?.id;
    const messageId = cb.message?.message_id;
    const data = cb.data || '';

    await telegram.answerCallbackQuery(token, cb.id).catch(() => {});

    // Dynamic custom order payment & admin proof callbacks
    if (data.startsWith('cb:order:buy:')) {
      const prodId = data.slice('cb:order:buy:'.length);
      const { row: prod } = await repos.db.first(
        `SELECT * FROM products WHERE id = ? AND bot_id = ? AND is_active = 1`,
        [prodId, bot.id]
      );
      if (!prod) return;
      const upi = buildUpiPaymentQr({
        upiId: config.templateSettings?.upiId,
        payeeName: config.templateSettings?.upiPayeeName || config.brandTitle || bot.display_name,
        amount: prod.price_points,
        note: prod.title,
      });
      await repos.endUsers.setState(bot.id, endUser.telegram_id, {
        step: 'cb_order_proof',
        productId: prod.id,
      });
      if (upi.configured) {
        await telegram
          .sendPhoto(token, chatId, upi.qrUrl, {
            caption: `💳 <b>Order: ${escapeHtml(prod.title)}</b> (${prod.price_points} ${escapeHtml(currency)})\nUPI ID: <code>${escapeHtml(config.templateSettings.upiId)}</code>\nSend your UTR number or payment screenshot for admin verification.`,
          })
          .catch(() =>
            telegram.sendMessage(
              token,
              chatId,
              `💳 <b>Order: ${escapeHtml(prod.title)}</b>\nUPI ID: <code>${escapeHtml(config.templateSettings.upiId)}</code>\nSend your UTR number or screenshot.`
            )
          );
      } else {
        await telegram.sendMessage(
          token,
          chatId,
          `📦 <b>Order: ${escapeHtml(prod.title)}</b> (${prod.price_points} ${escapeHtml(currency)})\nSend your order details or payment proof note below:`
        );
      }
      return;
    }

    if (isAdmin && data.startsWith('cb:pay:approve:')) {
      const proofId = data.slice('cb:pay:approve:'.length);
      const res = await repos.payments.approveProof(bot.id, proofId, endUser.telegram_id);
      if (!res.transitioned) {
        await telegram.sendMessage(token, chatId, `⚠️ ${escapeHtml(res.reason)}`, { reply_markup: dynamicAdmin.replyKeyboard });
        return;
      }
      await repos.db.run(
        `UPDATE product_orders SET status = 'delivered' WHERE id = ? AND bot_id = ?`,
        [res.proof.reference_id, bot.id]
      );
      await telegram
        .sendMessage(token, res.proof.user_telegram_id, `✅ Your order <code>${res.proof.reference_id}</code> (${escapeHtml(res.proof.item_title)}) has been approved!`)
        .catch(() => {});
      await telegram.sendMessage(token, chatId, `✅ Approved payment proof <code>${proofId}</code>.`, {
        reply_markup: dynamicAdmin.replyKeyboard,
      });
      return;
    }

    if (isAdmin && data.startsWith('cb:pay:reject:')) {
      const proofId = data.slice('cb:pay:reject:'.length);
      const res = await repos.payments.rejectProof(bot.id, proofId, endUser.telegram_id);
      if (!res.transitioned) {
        await telegram.sendMessage(token, chatId, `⚠️ ${escapeHtml(res.reason)}`, { reply_markup: dynamicAdmin.replyKeyboard });
        return;
      }
      await telegram
        .sendMessage(token, res.proof.user_telegram_id, `❌ Payment proof <code>${proofId}</code> was rejected by admin.`)
        .catch(() => {});
      await telegram.sendMessage(token, chatId, `❌ Rejected proof <code>${proofId}</code>.`, {
        reply_markup: dynamicAdmin.replyKeyboard,
      });
      return;
    }

    if (data.startsWith('cb:menu:')) {
      const targetKey = data.slice('cb:menu:'.length);
      const targetMenu = activeMenus.find((m) => m.menuKey === targetKey);
      if (!targetMenu) return;
      if (targetMenu.scope === 'admin' && !isAdmin) {
        await telegram.answerCallbackQuery(token, cb.id, { text: 'Admin access required.', showAlert: true }).catch(() => {});
        return;
      }
      await renderMenuMessage({ telegram, token, chatId, messageId, menu: targetMenu, config, isAdmin, edit: true });
      return;
    }

    if (data.startsWith('cb:btn:')) {
      const btnId = data.slice('cb:btn:'.length);
      let foundMenu = null;
      let foundBtn = null;
      for (const m of activeMenus) {
        const match = (m.buttons || []).find((b) => b.id === btnId);
        if (match) {
          foundMenu = m;
          foundBtn = match;
          break;
        }
      }
      if (!foundBtn) return;

      if (foundBtn.visibility === 'admins' && !isAdmin) {
        await telegram.sendMessage(token, chatId, '🔒 This action is restricted to bot administrators.');
        return;
      }

      await executeButtonAction({
        btn: foundBtn,
        currentMenu: foundMenu,
        activeMenus,
        rootMenu,
        ctx,
        chatId,
        messageId,
        endUser,
        isAdmin,
        currency,
      });
      return;
    }
  }

  if (update.message) {
    const msg = update.message;
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();
    const state = safeParse(endUser.state_json);

    // Dynamic Native ReplyKeyboard Admin Panel
    const rootRendered = buildMenuRenderPayload({ menu: rootMenu, config, isAdmin });
    const handledCommonAdmin = await handleCommonTenantAdmin(ctx, {
      panelTitle: `${config.brandTitle || bot.display_name} Dynamic Admin`,
      extraButtons: dynamicAdmin.extraButtons,
      includeUpiSetup: dynamicAdmin.features.hasPayments || dynamicAdmin.features.hasOrders,
      userKeyboard: rootRendered.replyMarkup,
      extraStatsSummary: async () => {
        const activeModules = dynamicAdmin.modules.map((m) => m.label).join(', ');
        return `• Dynamic Modules: <b>${escapeHtml(activeModules)}</b>`;
      },
    });
    if (handledCommonAdmin) return;

    // Handle Dynamic Admin Panel actions
    if (isAdmin && state?.step === 'cb_adm_add_prod' && !text.startsWith('/')) {
      await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
      const [category, title, priceStr, description] = text.split('|').map((s) => (s || '').trim());
      const price = Number(priceStr);
      if (!category || !title || !Number.isFinite(price)) {
        await telegram.sendMessage(token, chatId, '❌ Format: <code>Category | Title | Price | Description</code>', {
          reply_markup: dynamicAdmin.replyKeyboard,
        });
        return;
      }
      await repos.db.run(
        `INSERT INTO products (id, bot_id, category, title, description, price_points, delivery_type, delivery_payload, product_type)
         VALUES (?, ?, ?, ?, ?, ?, 'text_license', 'Order confirmed', 'digital')`,
        [newId('prd'), bot.id, category, title, description || '', price]
      );
      await telegram.sendMessage(token, chatId, `✅ Added catalogue item <b>${escapeHtml(title)}</b> (${price} ${escapeHtml(currency)}).`, {
        reply_markup: dynamicAdmin.replyKeyboard,
      });
      return;
    }

    if (isAdmin && text === '🛍 Manage Products') {
      await repos.endUsers.setState(bot.id, endUser.telegram_id, { scope: 'tenant_admin', step: 'cb_adm_add_prod' });
      const { rows } = await repos.db.all(`SELECT title, price_points, category FROM products WHERE bot_id = ? AND is_active = 1 LIMIT 10`, [bot.id]);
      const list = rows.length ? rows.map((p) => `• [${escapeHtml(p.category)}] <b>${escapeHtml(p.title)}</b> (${p.price_points})`).join('\n') : '<i>No items yet.</i>';
      await telegram.sendMessage(
        token,
        chatId,
        `<b>🛍 Manage Products</b>\n${list}\n\nSend <code>Category | Title | Price | Description</code> to add a new item:`,
        { reply_markup: buildCancelReplyKeyboard() }
      );
      return;
    }

    if (isAdmin && text === '📦 Manage Orders') {
      const { rows } = await repos.db.all(
        `SELECT o.id, o.user_telegram_id, o.status, o.price_points, p.title
         FROM product_orders o LEFT JOIN products p ON o.product_id = p.id
         WHERE o.bot_id = ? ORDER BY o.created_at DESC LIMIT 12`,
        [bot.id]
      );
      const body = rows.length
        ? rows.map((o) => `• <code>${o.id}</code> — <b>${escapeHtml(o.title || 'Item')}</b> (User <code>${o.user_telegram_id}</code>) · <b>${o.status.toUpperCase()}</b>`).join('\n')
        : '<i>No custom bot orders yet.</i>';
      await telegram.sendMessage(token, chatId, formatBrandedMessage(config, { heading: '📦 Manage Orders', body }), {
        reply_markup: dynamicAdmin.replyKeyboard,
      });
      return;
    }

    if (isAdmin && text === '💳 Payment Verification') {
      const pending = await repos.payments.listPending(bot.id, 10);
      if (!pending.length) {
        await telegram.sendMessage(token, chatId, '✅ No pending payment proofs.', { reply_markup: dynamicAdmin.replyKeyboard });
        return;
      }
      for (const p of pending) {
        await telegram.sendMessage(
          token,
          chatId,
          `💳 <b>Proof</b> <code>${p.id}</code>\nUser: <code>${p.user_telegram_id}</code>\nItem: <b>${escapeHtml(p.item_title)}</b> (${p.amount} ${escapeHtml(p.currency)})\nUTR: <code>${escapeHtml(p.utr_number || 'Screenshot')}</code>`,
          { reply_markup: buildApprovalButtons(`cb:pay:approve:${p.id}`, `cb:pay:reject:${p.id}`, '✅ Approve', '❌ Reject') }
        );
      }
      return;
    }

    if (isAdmin && text === '📥 Form Submissions') {
      const { rows } = await repos.db.all(
        `SELECT * FROM form_submissions WHERE bot_id = ? ORDER BY created_at DESC LIMIT 12`,
        [bot.id]
      );
      const body = rows.length
        ? rows
            .map(
              (f) =>
                `• <code>${f.id}</code> [<b>${escapeHtml(f.form_title)}</b>] User <code>${f.user_telegram_id}</code>:\n  ${escapeHtml(f.payload_text.slice(0, 140))}`
            )
            .join('\n\n')
        : '<i>No form submissions received yet.</i>';
      await telegram.sendMessage(token, chatId, formatBrandedMessage(config, { heading: '📥 Form Submissions', body }), {
        reply_markup: dynamicAdmin.replyKeyboard,
      });
      return;
    }

    // Handle user stateful form / order proof submission
    if (state?.step === 'cb_collect_form' && !text.startsWith('/')) {
      await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
      const subId = newId('frm');
      await repos.db.run(
        `INSERT INTO form_submissions (id, bot_id, user_telegram_id, form_key, form_title, payload_text, status)
         VALUES (?, ?, ?, ?, ?, ?, 'new')`,
        [subId, bot.id, endUser.telegram_id, state.formKey || 'general', state.formTitle || 'Request', text.slice(0, 1500)]
      );
      await telegram.sendMessage(
        token,
        chatId,
        `✅ <b>Submission Received!</b>\nReference: <code>${subId}</code>\nThank you — an admin will review your submission.`
      );
      await telegram
        .sendMessage(
          token,
          bot.owner_telegram_id,
          `📥 <b>New Form Submission</b> (<code>${subId}</code>)\nForm: <b>${escapeHtml(state.formTitle || 'Request')}</b>\nFrom: <code>${endUser.telegram_id}</code>\nMessage:\n${escapeHtml(text.slice(0, 500))}`
        )
        .catch(() => {});
      return;
    }

    if (state?.step === 'cb_order_proof' && (msg.photo || (text && !text.startsWith('/')))) {
      await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
      const { row: prod } = await repos.db.first(`SELECT * FROM products WHERE id = ? AND bot_id = ?`, [state.productId, bot.id]);
      if (!prod) return;
      const orderId = newId('ord');
      await repos.db.run(
        `INSERT INTO product_orders (id, bot_id, product_id, user_telegram_id, price_points, status) VALUES (?, ?, ?, ?, ?, 'pending')`,
        [orderId, bot.id, prod.id, endUser.telegram_id, prod.price_points]
      );
      const screenshotFileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : null;
      const utr = screenshotFileId ? (msg.caption || '').trim() : text;
      const proof = await repos.payments.createProof({
        botId: bot.id,
        userTelegramId: endUser.telegram_id,
        orderType: 'custom_order',
        referenceId: orderId,
        itemTitle: prod.title,
        amount: prod.price_points,
        currency,
        utrNumber: utr,
        screenshotFileId,
      });
      await telegram.sendMessage(
        token,
        chatId,
        `⏳ <b>Order & Proof Submitted</b>\nOrder: <code>${orderId}</code>\nProof: <code>${proof.id}</code>\nAwaiting admin verification.`
      );
      await telegram
        .sendMessage(
          token,
          bot.owner_telegram_id,
          `💳 <b>Custom Bot Order Proof</b>\nOrder: <code>${orderId}</code>\nItem: <b>${escapeHtml(prod.title)}</b>\nUTR/Note: <code>${escapeHtml(utr || 'Screenshot')}</code>`,
          { reply_markup: buildApprovalButtons(`cb:pay:approve:${proof.id}`, `cb:pay:reject:${proof.id}`, '✅ Approve', '❌ Reject') }
        )
        .catch(() => {});
      return;
    }

    if (text === '/start' || text === '/menu' || text.startsWith('/start ')) {
      await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
      await renderMenuMessage({ telegram, token, chatId, menu: rootMenu, config, isAdmin, edit: false });
      return;
    }

    // Match reply keyboard button labels safely
    for (const m of activeMenus) {
      const matched = (m.buttons || []).find((b) => {
        const rendered = b.emoji ? `${b.emoji} ${b.label}` : b.label;
        return rendered === text || b.label === text;
      });
      if (matched) {
        if (matched.visibility === 'admins' && !isAdmin) {
          await telegram.sendMessage(token, chatId, '🔒 Admin permission required.');
          return;
        }
        await executeButtonAction({
          btn: matched,
          currentMenu: m,
          activeMenus,
          rootMenu,
          ctx,
          chatId,
          messageId: null,
          endUser,
          isAdmin,
          currency,
        });
        return;
      }
    }

    await renderMenuMessage({ telegram, token, chatId, menu: rootMenu, config, isAdmin, edit: false });
  }
}

async function executeButtonAction({ btn, currentMenu, activeMenus, rootMenu, ctx, chatId, messageId, endUser, isAdmin, currency }) {
  const { config, token, telegram } = ctx;

  switch (btn.actionType) {
    case 'submenu': {
      const target = activeMenus.find((m) => m.menuKey === btn.actionPayload);
      if (!target) return;
      if (target.scope === 'admin' && !isAdmin) {
        await telegram.sendMessage(token, chatId, '🔒 Admin permission required.');
        return;
      }
      await renderMenuMessage({ telegram, token, chatId, messageId, menu: target, config, isAdmin, edit: Boolean(messageId) });
      return;
    }
    case 'back': {
      const targetKey = btn.actionPayload || currentMenu?.parentMenuKey || rootMenu.menuKey;
      const target = activeMenus.find((m) => m.menuKey === targetKey) || rootMenu;
      await renderMenuMessage({ telegram, token, chatId, messageId, menu: target, config, isAdmin, edit: Boolean(messageId) });
      return;
    }
    case 'message': {
      const backKey = currentMenu?.menuKey || rootMenu.menuKey;
      const body = formatBrandedMessage(config, {
        heading: btn.label,
        body: escapeHtml(btn.actionPayload || 'No content configured.'),
      });
      const kb = buildInlineKeyboard([
        [inlineButton({ text: '⬅️ Back', callbackData: `cb:menu:${backKey}`, style: BUTTON_STYLES.PRIMARY })],
      ]);
      if (messageId) {
        await telegram.editMessageText(token, chatId, messageId, body, { reply_markup: kb }).catch(() =>
          telegram.sendMessage(token, chatId, body, { reply_markup: kb })
        );
      } else {
        await telegram.sendMessage(token, chatId, body, { reply_markup: kb });
      }
      return;
    }
    case 'support': {
      const handle = config.supportUsername || 'Not configured';
      const note = btn.actionPayload || 'Contact our support desk for assistance.';
      const body = formatBrandedMessage(config, {
        heading: '🎧 Support & Assistance',
        body: `${escapeHtml(note)}\n\nSupport Contact: <b>${escapeHtml(handle)}</b>`,
      });
      const rows = [];
      if (config.supportUsername) {
        const cleanHandle = config.supportUsername.replace(/^@/, '');
        rows.push([
          inlineButton({ text: '💬 Message Support', url: `https://t.me/${cleanHandle}`, style: BUTTON_STYLES.SUCCESS }),
        ]);
      }
      rows.push([
        inlineButton({ text: '⬅️ Back', callbackData: `cb:menu:${currentMenu?.menuKey || rootMenu.menuKey}`, style: BUTTON_STYLES.PRIMARY }),
      ]);
      await telegram.sendMessage(token, chatId, body, { reply_markup: buildInlineKeyboard(rows) });
      return;
    }
    case 'feature': {
      await executeSafeFeature({
        featureKey: btn.actionPayload,
        btnLabel: btn.label,
        ctx,
        chatId,
        endUser,
        isAdmin,
        backKey: currentMenu?.menuKey || rootMenu.menuKey,
        currency,
      });
      return;
    }
    default:
      return;
  }
}

async function executeSafeFeature({ featureKey, btnLabel, ctx, chatId, endUser, isAdmin, backKey, currency }) {
  const { bot, config, token, telegram, repos } = ctx;
  const backKb = buildInlineKeyboard([
    [inlineButton({ text: '⬅️ Back', callbackData: `cb:menu:${backKey}`, style: BUTTON_STYLES.PRIMARY })],
  ]);

  if (featureKey.startsWith('info:')) {
    const infoText = featureKey.slice(5);
    await telegram.sendMessage(
      token,
      chatId,
      formatBrandedMessage(config, { heading: btnLabel || 'ℹ️ Information', body: escapeHtml(infoText) }),
      { reply_markup: backKb }
    );
    return;
  }

  if (featureKey.startsWith('form:') || featureKey.startsWith('submit_request:')) {
    const parts = featureKey.split(':');
    const formKey = parts[1] || 'request';
    const prompt = parts.slice(2).join(':') || `Please send your response for ${btnLabel}:`;
    await repos.endUsers.setState(bot.id, endUser.telegram_id, {
      step: 'cb_collect_form',
      formKey,
      formTitle: btnLabel || formKey,
    });
    await telegram.sendMessage(
      token,
      chatId,
      formatBrandedMessage(config, { heading: btnLabel || '📥 Submit Information', body: escapeHtml(prompt) })
    );
    return;
  }

  if (featureKey.startsWith('catalogue') || featureKey.startsWith('create_order')) {
    const { rows } = await repos.db.all(
      `SELECT * FROM products WHERE bot_id = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 12`,
      [bot.id]
    );
    if (!rows.length) {
      await telegram.sendMessage(
        token,
        chatId,
        'No catalogue items have been added yet. Bot admins can add items via /admin -> 🛍 Manage Products.',
        { reply_markup: backKb }
      );
      return;
    }
    const kb = buildInlineKeyboard([
      ...rows.map((p) => [
        inlineButton({
          text: `🛍 ${p.title} — ${p.price_points} ${currency}`,
          callbackData: `cb:order:buy:${p.id}`,
          style: BUTTON_STYLES.SUCCESS,
        }),
      ]),
      [inlineButton({ text: '⬅️ Back', callbackData: `cb:menu:${backKey}`, style: BUTTON_STYLES.PRIMARY })],
    ]);
    await telegram.sendMessage(
      token,
      chatId,
      formatBrandedMessage(config, { heading: btnLabel || '🛍 Catalogue', body: 'Select an item to place an order:' }),
      { reply_markup: kb }
    );
    return;
  }

  if (featureKey === 'user_profile') {
    const text = formatBrandedMessage(config, {
      heading: '👤 Your Profile',
      body: [
        `• <b>User ID:</b> <code>${escapeHtml(endUser.telegram_id)}</code>`,
        `• <b>Username:</b> ${endUser.username ? `@${escapeHtml(endUser.username)}` : 'N/A'}`,
        `• <b>Balance:</b> <b>${Number(endUser.points_balance || 0)}</b>`,
        `• <b>Referrals:</b> <b>${Number(endUser.referral_count || 0)}</b>`,
      ].join('\n'),
    });
    await telegram.sendMessage(token, chatId, text, { reply_markup: backKb });
    return;
  }

  if (featureKey === 'bot_stats') {
    if (!isAdmin) {
      await telegram.sendMessage(token, chatId, '🔒 Bot statistics are restricted to admins.');
      return;
    }
    const { row } = await repos.db.first(
      `SELECT COUNT(*) AS users, SUM(CASE WHEN is_blocked = 1 THEN 1 ELSE 0 END) AS blocked FROM bot_end_users WHERE bot_id = ?`,
      [bot.id]
    );
    const text = formatBrandedMessage(config, {
      heading: '📊 Bot Statistics',
      body: [
        `• <b>Bot:</b> @${escapeHtml(bot.telegram_username)}`,
        `• <b>Total Users:</b> <b>${Number(row?.users || 0)}</b>`,
        `• <b>Blocked Users:</b> <b>${Number(row?.blocked || 0)}</b>`,
        `• <b>Webhook Updates:</b> <b>${Number(bot.total_updates || 0)}</b>`,
      ].join('\n'),
    });
    await telegram.sendMessage(token, chatId, text, { reply_markup: backKb });
    return;
  }

  if (featureKey === 'referral_link') {
    const link = `https://t.me/${bot.telegram_username}?start=${endUser.referral_code}`;
    await telegram.sendMessage(
      token,
      chatId,
      formatBrandedMessage(config, {
        heading: '👥 Your Referral Link',
        body: `Share your unique invite link:\n<code>${escapeHtml(link)}</code>\n\nTotal Referrals: <b>${Number(endUser.referral_count || 0)}</b>`,
      }),
      { reply_markup: backKb }
    );
    return;
  }

  await telegram.sendMessage(
    token,
    chatId,
    formatBrandedMessage(config, {
      heading: 'ℹ️ Help Overview',
      body: `Use the buttons below to navigate <b>${escapeHtml(config.brandTitle)}</b>. Send /start at any time to reopen the main menu.`,
    }),
    { reply_markup: backKb }
  );
}

async function renderMenuMessage({ telegram, token, chatId, messageId, menu, config, isAdmin, edit }) {
  const rendered = buildMenuRenderPayload({ menu, config, isAdmin });
  if (rendered.imageUrl && !edit) {
    await telegram
      .sendPhoto(token, chatId, rendered.imageUrl, {
        caption: rendered.text.slice(0, 1020),
        reply_markup: rendered.replyMarkup,
      })
      .catch(() => telegram.sendMessage(token, chatId, rendered.text, { reply_markup: rendered.replyMarkup }));
    return;
  }

  if (edit && messageId && menu.keyboardType === 'inline') {
    await telegram
      .editMessageText(token, chatId, messageId, rendered.text, { reply_markup: rendered.replyMarkup })
      .catch(() => telegram.sendMessage(token, chatId, rendered.text, { reply_markup: rendered.replyMarkup }));
    return;
  }

  await telegram.sendMessage(token, chatId, rendered.text, { reply_markup: rendered.replyMarkup });
}

function safeParse(str) {
  if (!str) return null;
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}
