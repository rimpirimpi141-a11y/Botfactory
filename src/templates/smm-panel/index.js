/**
 * TEMPLATE 4: LEGITIMATE SMM PANEL BOT
 *
 * Supports legitimate social media marketing services ONLY (content creation,
 * campaign management, creative design, paid ads setup, analytics audits).
 * Prohibits fake followers, bot engagement, or platform manipulation.
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

export const SMM_PANEL_META = {
  id: 'tpl_smm_panel',
  slug: 'smm-panel',
  name: 'SMM Services Panel Bot',
  category: 'Marketing Services',
};

const FAKE_ENGAGEMENT_REGEX = /\b(fake\s*followers|bot\s*likes|buy\s*views|spam\s*comments|click\s*farm)\b/i;

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
      { text: '📜 Order History', style: BUTTON_STYLES.DEFAULT },
    ],
    [{ text: '🎧 Support', style: BUTTON_STYLES.DEFAULT }],
  ];
  if (isAdmin) {
    rows.push([{ text: '🛡 Admin Console', style: BUTTON_STYLES.DANGER }]);
  }
  return buildReplyKeyboard(rows, { resize: true, persistent: true });
}

export async function handleSmmPanelUpdate(ctx) {
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
        heading: 'Social Media Marketing Agency Desk',
        body: `${config.welcomeMessage || 'Order legitimate content strategy, ad campaign setup, and social analytics packages.'}\n\n💰 Account Balance: <b>${Number(endUser.points_balance || 0)} Credits</b>`,
      }),
      { reply_markup: buildUserKeyboard(isAdmin) }
    );
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
        await telegram.sendMessage(token, chatId, '❌ Order ID not found.');
        return;
      }
      await telegram.sendMessage(
        token,
        chatId,
        `🔎 <b>Order Status</b>\nID: <code>${ord.id}</code>\nService: <b>${escapeHtml(ord.title)}</b>\nQuantity: <b>${ord.quantity}</b>\nStatus: <b>${ord.status.toUpperCase()}</b>\nNotes: ${escapeHtml(ord.admin_note || 'In queue')}`
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
        await telegram.sendMessage(token, chatId, `❌ Insufficient balance. Required: <b>${svc.price_points}</b> credits.`);
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
        `✅ <b>Campaign Order Created</b>\nOrder ID: <code>${orderId}</code>\nService: <b>${escapeHtml(svc.title)}</b>\nStatus: <b>PENDING</b>`
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
        await telegram.sendMessage(token, chatId, '🚫 Rejected: Only legitimate marketing services are allowed (no fake followers/engagement).');
        return;
      }
      const [category, title, priceStr, description] = text.split('|').map((s) => s?.trim());
      const price = Number(priceStr);
      if (!category || !title || !Number.isFinite(price)) {
        await telegram.sendMessage(token, chatId, '❌ Format: <code>Category | Title | Price | Description</code>');
        return;
      }
      await repos.db.run(
        `INSERT INTO services (id, bot_id, category, title, description, price_points, approval_status)
         VALUES (?, ?, ?, ?, ?, ?, 'approved')`,
        [newId('svc'), bot.id, category, title, description || '', price]
      );
      await telegram.sendMessage(token, chatId, `✅ Marketing service <b>${escapeHtml(title)}</b> added.`);
      return;
    }
  }

  switch (text) {
    case '📦 Services':
    case '🛒 New Order': {
      const { rows } = await repos.db.all(
        `SELECT * FROM services WHERE bot_id = ? AND is_active = 1 AND approval_status = 'approved' ORDER BY category, title LIMIT 12`,
        [bot.id]
      );
      if (!rows.length) {
        await telegram.sendMessage(token, chatId, 'No marketing packages configured yet. Admins can add services via Admin Console.');
        return;
      }
      const buttons = rows.map((s) => [
        inlineButton({ text: `${s.title} (${s.price_points} cr)`, callbackData: `smm:pick:${s.id}`, style: BUTTON_STYLES.PRIMARY }),
      ]);
      await telegram.sendMessage(
        token,
        chatId,
        formatBrandedMessage(config, { heading: '📦 Legitimate Marketing Packages', body: 'Select a service package to place a new order:' }),
        { reply_markup: buildInlineKeyboard(buttons) }
      );
      return;
    }

    case '📁 My Orders':
    case '📜 Order History': {
      const { rows } = await repos.db.all(
        `SELECT o.*, s.title FROM service_orders o JOIN services s ON o.service_id = s.id
         WHERE o.bot_id = ? AND o.user_telegram_id = ? ORDER BY o.created_at DESC LIMIT 10`,
        [bot.id, endUser.telegram_id]
      );
      const body = rows.length
        ? rows.map((o) => `• <code>${o.id}</code> — <b>${escapeHtml(o.title)}</b> · <b>${o.status.toUpperCase()}</b>`).join('\n')
        : '<i>No orders found.</i>';
      await telegram.sendMessage(token, chatId, formatBrandedMessage(config, { heading: text, body }));
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
          body: `Available Credits: <b>${Number(endUser.points_balance || 0)}</b>`,
        })
      );
      return;
    }

    case '🎧 Support': {
      await telegram.sendMessage(
        token,
        chatId,
        formatBrandedMessage(config, {
          heading: '🎧 Account Support',
          body: config.supportUsername
            ? `Message our marketing desk at <b>${escapeHtml(config.supportUsername)}</b>.`
            : 'Support handle not configured yet.',
        })
      );
      return;
    }

    case '🛡 Admin Console':
    case '/admin': {
      if (!isAdmin) return;
      await telegram.sendMessage(
        token,
        chatId,
        formatBrandedMessage(config, { heading: '🛡 SMM Admin Console', body: 'Manage legitimate marketing packages and orders.' }),
        {
          reply_markup: buildInlineKeyboard([
            [
              inlineButton({ text: '➕ Add Service', callbackData: 'smm:adm:add', style: BUTTON_STYLES.SUCCESS }),
              inlineButton({ text: '📁 Active Orders', callbackData: 'smm:adm:orders', style: BUTTON_STYLES.PRIMARY }),
            ],
            [inlineButton({ text: '📊 Statistics', callbackData: 'smm:adm:stats', style: BUTTON_STYLES.DEFAULT })],
          ]),
        }
      );
    }
  }
}

async function handleCallback(ctx) {
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

  if (data === 'smm:adm:add') {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, { step: 'adm_new_service' });
    await telegram.sendMessage(token, chatId, 'Send package details:\n<code>Category | Title | Price | Description</code>');
    return;
  }

  if (data === 'smm:adm:orders') {
    const { rows } = await repos.db.all(
      `SELECT o.*, s.title FROM service_orders o JOIN services s ON o.service_id = s.id WHERE o.bot_id = ? AND o.status IN ('pending', 'in_progress') LIMIT 5`,
      [bot.id]
    );
    if (!rows.length) {
      await telegram.sendMessage(token, chatId, '✅ No open orders.');
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
    await telegram.sendMessage(token, chatId, `✅ Order <code>${orderId}</code> updated to <b>${nextStatus.toUpperCase()}</b>.`);
    await telegram
      .sendMessage(token, ord.user_telegram_id, `📦 Your order <code>${orderId}</code> status is now: <b>${nextStatus.toUpperCase()}</b>.`)
      .catch(() => {});
    return;
  }

  if (data === 'smm:adm:stats') {
    const { row } = await repos.db.first(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed, COALESCE(SUM(total_points),0) AS volume FROM service_orders WHERE bot_id = ?`,
      [bot.id]
    );
    await telegram.sendMessage(
      token,
      chatId,
      `<b>📊 SMM Desk Statistics</b>\n• Total Orders: <b>${Number(row?.total || 0)}</b>\n• Completed: <b>${Number(row?.completed || 0)}</b>\n• Volume: <b>${Number(row?.volume || 0)} Credits</b>`
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
