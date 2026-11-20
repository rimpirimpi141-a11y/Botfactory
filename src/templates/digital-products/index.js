/**
 * TEMPLATE 5: DIGITAL PRODUCT STORE BOT
 *
 * Authorized digital goods storefront supporting:
 * - Product Catalogue, Categories, Keyword Search
 * - Instant delivery via Telegram file_id, authorized download URL, or text license
 * - Order & Purchase History, Support, and full Admin inventory management
 */

import { formatBrandedMessage } from '../../builder/theme-engine.js';
import {
  buildInlineKeyboard,
  buildReplyKeyboard,
  BUTTON_STYLES,
  inlineButton,
} from '../../utils/keyboards.js';
import { newId } from '../../database/repositories.js';
import { escapeHtml } from '../../utils/validation.js';

export const DIGITAL_PRODUCTS_META = {
  id: 'tpl_digital_products',
  slug: 'digital-products',
  name: 'Digital Product Store Bot',
  category: 'Digital Commerce',
};

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
      { text: '🎧 Support', style: BUTTON_STYLES.DEFAULT },
    ],
  ];
  if (isAdmin) {
    rows.push([{ text: '🛡 Store Admin', style: BUTTON_STYLES.DANGER }]);
  }
  return buildReplyKeyboard(rows, { resize: true, persistent: true });
}

export async function handleDigitalProductsUpdate(ctx) {
  const { bot, config, token, telegram, repos, update, endUser, isAdmin } = ctx;

  if (update.callback_query) {
    return handleCallback(ctx);
  }

  const msg = update.message;
  if (!msg) return;
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const state = endUser.state_json ? safeParse(endUser.state_json) : null;

  if (text === '/start') {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
    await telegram.sendMessage(
      token,
      chatId,
      formatBrandedMessage(config, {
        heading: 'Digital Product Store',
        body: `${config.welcomeMessage || 'Explore authorized ebooks, templates, UI kits, and digital downloads with instant delivery.'}\n\n💰 Credits Balance: <b>${Number(endUser.points_balance || 0)}</b>`,
      }),
      { reply_markup: buildUserKeyboard(isAdmin) }
    );
    return;
  }

  // Handle admin attaching a product file directly
  if (isAdmin && state?.step === 'adm_upload_file' && msg.document) {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
    const prodId = newId('prd');
    await repos.db.run(
      `INSERT INTO products (id, bot_id, category, title, description, price_points, delivery_type, delivery_payload)
       VALUES (?, ?, ?, ?, ?, ?, 'file_id', ?)`,
      [prodId, bot.id, state.category, state.title, state.description, state.price, msg.document.file_id]
    );
    await telegram.sendMessage(
      token,
      chatId,
      `✅ <b>Product Published!</b>\nID: <code>${prodId}</code>\nTitle: <b>${escapeHtml(state.title)}</b>\nPrice: <b>${state.price}</b> cr\nDelivery: Instant Telegram File`
    );
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
        await telegram.sendMessage(token, chatId, `No digital products matched "<b>${escapeHtml(text)}</b>".`);
        return;
      }
      const kb = buildInlineKeyboard(
        rows.map((p) => [
          inlineButton({ text: `${p.title} — ${p.price_points} cr`, callbackData: `dp:view:${p.id}`, style: BUTTON_STYLES.PRIMARY }),
        ])
      );
      await telegram.sendMessage(token, chatId, `🔎 <b>Search Results (${rows.length})</b>`, { reply_markup: kb });
      return;
    }

    if (isAdmin && state.step === 'adm_add_product_meta') {
      // Format: Category | Title | Price | Description | [Optional Delivery Text/URL or "FILE"]
      const parts = text.split('|').map((s) => s.trim());
      const [category, title, priceStr, description, deliveryPayload] = parts;
      const price = Number(priceStr);
      if (!category || !title || !Number.isFinite(price) || price < 0) {
        await telegram.sendMessage(
          token,
          chatId,
          '❌ Format: <code>Category | Title | Price | Description | FILE (or URL/license text)</code>'
        );
        return;
      }
      if (!deliveryPayload || deliveryPayload.toUpperCase() === 'FILE') {
        await repos.endUsers.setState(bot.id, endUser.telegram_id, {
          step: 'adm_upload_file',
          category,
          title,
          price,
          description: description || '',
        });
        await telegram.sendMessage(token, chatId, '📎 Now upload the authorized digital file (Document) to attach to this product.');
        return;
      }

      await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
      const deliveryType = /^https?:\/\//i.test(deliveryPayload) ? 'download_url' : 'text_license';
      const prodId = newId('prd');
      await repos.db.run(
        `INSERT INTO products (id, bot_id, category, title, description, price_points, delivery_type, delivery_payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [prodId, bot.id, category, title, description || '', price, deliveryType, deliveryPayload]
      );
      await telegram.sendMessage(token, chatId, `✅ Product <b>${escapeHtml(title)}</b> created (ID: <code>${prodId}</code>).`);
      return;
    }
  }

  switch (text) {
    case '🛍 Product Catalogue': {
      const { rows } = await repos.db.all(
        `SELECT * FROM products WHERE bot_id = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 12`,
        [bot.id]
      );
      if (!rows.length) {
        await telegram.sendMessage(token, chatId, 'No digital products listed yet. Store admins can add products via Store Admin.');
        return;
      }
      const kb = buildInlineKeyboard(
        rows.map((p) => [
          inlineButton({ text: `🛍 ${p.title} — ${p.price_points} cr`, callbackData: `dp:view:${p.id}`, style: BUTTON_STYLES.PRIMARY }),
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
        await telegram.sendMessage(token, chatId, 'No categories available yet.');
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
        `SELECT o.*, p.title, p.delivery_type, p.delivery_payload FROM product_orders o
         JOIN products p ON o.product_id = p.id
         WHERE o.bot_id = ? AND o.user_telegram_id = ? ORDER BY o.created_at DESC LIMIT 10`,
        [bot.id, endUser.telegram_id]
      );
      if (!rows.length) {
        await telegram.sendMessage(token, chatId, 'You have no purchases yet.');
        return;
      }
      const kb = buildInlineKeyboard(
        rows.map((o) => [
          inlineButton({ text: `📥 Redownload: ${o.title}`, callbackData: `dp:dl:${o.id}`, style: BUTTON_STYLES.SUCCESS }),
        ])
      );
      const summary = rows.map((o) => `• <code>${o.id}</code> — <b>${escapeHtml(o.title)}</b> (${o.price_points} cr)`).join('\n');
      await telegram.sendMessage(token, chatId, formatBrandedMessage(config, { heading: text, body: summary }), {
        reply_markup: kb,
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
        })
      );
      return;
    }

    case '🛡 Store Admin':
    case '/admin': {
      if (!isAdmin) return;
      await telegram.sendMessage(
        token,
        chatId,
        formatBrandedMessage(config, { heading: '🛡 Digital Store Admin', body: 'Manage products, files, orders, and customers.' }),
        {
          reply_markup: buildInlineKeyboard([
            [
              inlineButton({ text: '➕ Add Product', callbackData: 'dp:adm:add', style: BUTTON_STYLES.SUCCESS }),
              inlineButton({ text: '📊 Store Stats', callbackData: 'dp:adm:stats', style: BUTTON_STYLES.PRIMARY }),
            ],
          ]),
        }
      );
    }
  }
}

async function handleCallback(ctx) {
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
        inlineButton({ text: `${p.title} — ${p.price_points} cr`, callbackData: `dp:view:${p.id}`, style: BUTTON_STYLES.PRIMARY }),
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
        body: `Category: <b>${escapeHtml(p.category)}</b>\nPrice: <b>${p.price_points} Credits</b>\n\n${escapeHtml(p.description || 'Instant digital delivery.')}`,
      }),
      {
        reply_markup: buildInlineKeyboard([
          [inlineButton({ text: `✅ Purchase (${p.price_points} cr)`, callbackData: `dp:buy:${p.id}`, style: BUTTON_STYLES.SUCCESS })],
        ]),
      }
    );
    return;
  }

  if (data.startsWith('dp:buy:')) {
    const prodId = data.slice('dp:buy:'.length);
    const { row: p } = await repos.db.first(`SELECT * FROM products WHERE id = ? AND bot_id = ? AND is_active = 1`, [prodId, bot.id]);
    if (!p) return;
    if (Number(endUser.points_balance || 0) < Number(p.price_points)) {
      await telegram.sendMessage(token, chatId, `❌ Insufficient credits. Needed: <b>${p.price_points}</b>.`);
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
      `SELECT o.id, p.title, p.delivery_type, p.delivery_payload FROM product_orders o JOIN products p ON o.product_id = p.id
       WHERE o.id = ? AND o.bot_id = ? AND o.user_telegram_id = ?`,
      [orderId, bot.id, endUser.telegram_id]
    );
    if (!o) return;
    await deliverProduct(telegram, token, chatId, o, o.id);
    return;
  }

  if (!isAdmin) return;

  if (data === 'dp:adm:add') {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, { step: 'adm_add_product_meta' });
    await telegram.sendMessage(
      token,
      chatId,
      'Send product details:\n<code>Category | Title | Price | Description | FILE (or download URL / license key)</code>'
    );
    return;
  }

  if (data === 'dp:adm:stats') {
    const [pRes, oRes] = await Promise.all([
      repos.db.first(`SELECT COUNT(*) AS count FROM products WHERE bot_id = ? AND is_active = 1`, [bot.id]),
      repos.db.first(`SELECT COUNT(*) AS orders, COALESCE(SUM(price_points),0) AS revenue FROM product_orders WHERE bot_id = ?`, [bot.id]),
    ]);
    await telegram.sendMessage(
      token,
      chatId,
      `<b>📊 Digital Store Stats</b>\n• Active Products: <b>${Number(pRes.row?.count || 0)}</b>\n• Completed Orders: <b>${Number(oRes.row?.orders || 0)}</b>\n• Total Credits Volume: <b>${Number(oRes.row?.revenue || 0)}</b>`
    );
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
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}
