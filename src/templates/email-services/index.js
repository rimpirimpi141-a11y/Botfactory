/**
 * TEMPLATE 2: EMAIL & DIGITAL SERVICES MARKETPLACE BOT
 *
 * STRICT COMPLIANCE POLICY:
 * Supports legitimate email infrastructure services, domain/DNS/SPF/DKIM setup,
 * newsletter automation, digital subscriptions, and consulting ONLY.
 * Explicitly prohibits compromised credentials, account resale, passwords, OTPs, or cookies.
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

export const EMAIL_SERVICES_META = {
  id: 'tpl_email_services',
  slug: 'email-services',
  name: 'Email & Digital Services Marketplace',
  category: 'Services Marketplace',
};

const PROHIBITED_TERMS = /\b(gmail\s+account|hacked|cracked|otp\s*bypass|stealer|cookie\s*log|stolen\s*password|credential\s*dump|aged\s*gmail)\b/i;

function buildUserKeyboard(isAdmin = false) {
  const rows = [
    [
      { text: '🛒 Browse Services', style: BUTTON_STYLES.SUCCESS },
      { text: '📤 Sell Services', style: BUTTON_STYLES.PRIMARY },
    ],
    [
      { text: '📁 My Orders', style: BUTTON_STYLES.PRIMARY },
      { text: '💰 Balance / Deposit', style: BUTTON_STYLES.SUCCESS },
    ],
    [
      { text: '👥 Referrals', style: BUTTON_STYLES.PRIMARY },
      { text: '🎁 Rewards', style: BUTTON_STYLES.PRIMARY },
    ],
    [
      { text: '⚙️ Settings', style: BUTTON_STYLES.DEFAULT },
      { text: '❓ Help', style: BUTTON_STYLES.DEFAULT },
    ],
  ];
  if (isAdmin) {
    rows.push([{ text: '🛡 Admin Panel', style: BUTTON_STYLES.DANGER }]);
  }
  return buildReplyKeyboard(rows, { resize: true, persistent: true });
}

export async function handleEmailServicesUpdate(ctx) {
  const { bot, config, token, telegram, repos, update, endUser, isAdmin } = ctx;

  if (update.callback_query) {
    return handleCallback(ctx);
  }

  const msg = update.message;
  if (!msg) return;
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const state = endUser.state_json ? safeParse(endUser.state_json) : null;

  if (text === '/start' || text.startsWith('/start ')) {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
    await telegram.sendMessage(
      token,
      chatId,
      formatBrandedMessage(config, {
        heading: 'Email & Digital Services Marketplace',
        body: `${config.welcomeMessage || 'Browse verified email setup, deliverability, newsletter, and digital services.'}\n\n💰 Credits Balance: <b>${Number(endUser.points_balance || 0)}</b>`,
      }),
      { reply_markup: buildUserKeyboard(isAdmin) }
    );
    return;
  }

  if (state && !text.startsWith('/')) {
    if (state.step === 'submit_service' || state.step === 'adm_add_service') {
      await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
      if (PROHIBITED_TERMS.test(text)) {
        await telegram.sendMessage(
          token,
          chatId,
          '🚫 Listing rejected by compliance policy. Selling accounts, passwords, OTPs, or credentials is strictly prohibited. Only legitimate digital/email services are allowed.'
        );
        return;
      }
      // Format: Category | Title | Price | Description
      const [category, title, priceStr, description] = text.split('|').map((s) => s?.trim());
      const price = Number(priceStr);
      if (!category || !title || !Number.isFinite(price) || price < 0) {
        await telegram.sendMessage(
          token,
          chatId,
          '❌ Invalid format. Use:\n<code>Category | Service Title | Price | Description</code>\nExample: <code>Deliverability | SPF/DKIM/DMARC Audit | 50 | Full DNS email authentication setup</code>'
        );
        return;
      }
      const svcId = newId('svc');
      const approvalStatus = isAdmin ? 'approved' : 'pending';
      await repos.db.run(
        `INSERT INTO services (id, bot_id, category, title, description, price_points, seller_telegram_id, approval_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [svcId, bot.id, category.slice(0, 60), title.slice(0, 120), (description || '').slice(0, 500), price, endUser.telegram_id, approvalStatus]
      );

      if (isAdmin) {
        await telegram.sendMessage(token, chatId, `✅ Service <b>${escapeHtml(title)}</b> published immediately (ID: <code>${svcId}</code>).`);
      } else {
        await telegram.sendMessage(token, chatId, `✅ Submission received (<code>${svcId}</code>). Pending admin compliance review.`);
        await telegram
          .sendMessage(
            token,
            bot.owner_telegram_id,
            `📥 <b>New Service Submission</b>\nID: <code>${svcId}</code>\nCategory: ${escapeHtml(category)}\nTitle: <b>${escapeHtml(title)}</b>\nPrice: <b>${price}</b> credits\nDescription: ${escapeHtml(description || 'N/A')}`,
            { reply_markup: buildApprovalButtons(`es:svc:approve:${svcId}`, `es:svc:reject:${svcId}`) }
          )
          .catch(() => {});
      }
      return;
    }

    if (state.step === 'order_details') {
      await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
      const { row: svc } = await repos.db.first(
        `SELECT * FROM services WHERE id = ? AND bot_id = ? AND approval_status = 'approved' AND is_active = 1`,
        [state.serviceId, bot.id]
      );
      if (!svc) {
        await telegram.sendMessage(token, chatId, '❌ Service is no longer available.');
        return;
      }
      if (Number(endUser.points_balance || 0) < Number(svc.price_points)) {
        await telegram.sendMessage(token, chatId, `❌ Insufficient balance. Needed: <b>${svc.price_points}</b> credits.`);
        return;
      }
      const orderId = newId('ord');
      await repos.endUsers.adjustPoints(bot.id, endUser.telegram_id, {
        delta: -Number(svc.price_points),
        txType: 'order_debit',
        referenceId: orderId,
        description: `Service order: ${svc.title}`,
      });
      await repos.db.run(
        `INSERT INTO service_orders (id, bot_id, service_id, user_telegram_id, quantity, target_details, total_points, status)
         VALUES (?, ?, ?, ?, 1, ?, ?, 'pending')`,
        [orderId, bot.id, svc.id, endUser.telegram_id, text.slice(0, 400), svc.price_points]
      );
      await telegram.sendMessage(
        token,
        chatId,
        `✅ <b>Order Placed!</b>\nOrder ID: <code>${orderId}</code>\nService: <b>${escapeHtml(svc.title)}</b>\nCharged: <b>${svc.price_points}</b> credits\nStatus: <b>Pending Fulfillment</b>`
      );
      await telegram
        .sendMessage(
          token,
          bot.owner_telegram_id,
          `🛒 <b>New Service Order</b> <code>${orderId}</code>\nService: ${escapeHtml(svc.title)}\nBuyer: <code>${endUser.telegram_id}</code>\nBrief: ${escapeHtml(text.slice(0, 300))}`,
          { reply_markup: buildApprovalButtons(`es:ord:done:${orderId}`, `es:ord:cancel:${orderId}`, '✅ Mark Completed', '❌ Cancel & Refund') }
        )
        .catch(() => {});
      return;
    }
  }

  switch (text) {
    case '🛒 Browse Services': {
      const { rows } = await repos.db.all(
        `SELECT * FROM services WHERE bot_id = ? AND approval_status = 'approved' AND is_active = 1 ORDER BY created_at DESC LIMIT 12`,
        [bot.id]
      );
      if (rows.length === 0) {
        await telegram.sendMessage(
          token,
          chatId,
          formatBrandedMessage(config, {
            heading: '🛒 Service Catalogue',
            body: 'No approved services are listed yet. Admins can add legitimate digital/email services from the Admin Panel.',
          })
        );
        return;
      }
      const buttons = rows.map((s) => [
        inlineButton({
          text: `${s.title} — ${s.price_points} cr`,
          callbackData: `es:view:${s.id}`,
          style: BUTTON_STYLES.PRIMARY,
        }),
      ]);
      await telegram.sendMessage(
        token,
        chatId,
        formatBrandedMessage(config, {
          heading: '🛒 Verified Digital & Email Services',
          body: 'Select a service below to inspect details and place an order:',
        }),
        { reply_markup: buildInlineKeyboard(buttons) }
      );
      return;
    }

    case '📤 Sell Services': {
      await repos.endUsers.setState(bot.id, endUser.telegram_id, { step: 'submit_service' });
      await telegram.sendMessage(
        token,
        chatId,
        formatBrandedMessage(config, {
          heading: '📤 Submit a Legitimate Service Listing',
          body: 'Send your listing in the format:\n<code>Category | Service Title | Price | Description</code>\n\n<i>Only legitimate email setup, deliverability, newsletter, and digital services are accepted. Account/credential resale is forbidden.</i>',
        })
      );
      return;
    }

    case '📁 My Orders': {
      const { rows } = await repos.db.all(
        `SELECT o.*, s.title FROM service_orders o JOIN services s ON o.service_id = s.id
         WHERE o.bot_id = ? AND o.user_telegram_id = ? ORDER BY o.created_at DESC LIMIT 10`,
        [bot.id, endUser.telegram_id]
      );
      const body =
        rows.length > 0
          ? rows.map((o) => `• <code>${o.id}</code> — <b>${escapeHtml(o.title)}</b> (${o.total_points} cr) · <b>${o.status.toUpperCase()}</b>`).join('\n')
          : '<i>You have not placed any service orders yet.</i>';
      await telegram.sendMessage(token, chatId, formatBrandedMessage(config, { heading: '📁 My Orders', body }));
      return;
    }

    case '💰 Balance / Deposit': {
      await telegram.sendMessage(
        token,
        chatId,
        formatBrandedMessage(config, {
          heading: '💰 Credits Balance',
          body: `Current Balance: <b>${Number(endUser.points_balance || 0)} Credits</b>\n\nCredits are added by verified admins or earned via referrals & loyalty rewards. ${config.supportUsername ? `Contact ${escapeHtml(config.supportUsername)} for invoice top-ups.` : ''}`,
        })
      );
      return;
    }

    case '👥 Referrals': {
      const link = `https://t.me/${bot.telegram_username}?start=${endUser.referral_code}`;
      await telegram.sendMessage(
        token,
        chatId,
        formatBrandedMessage(config, {
          heading: '👥 Partner Referrals',
          body: `Invite clients using your link:\n<code>${escapeHtml(link)}</code>\nTotal Referrals: <b>${Number(endUser.referral_count || 0)}</b>`,
        })
      );
      return;
    }

    case '🎁 Rewards': {
      await telegram.sendMessage(
        token,
        chatId,
        formatBrandedMessage(config, {
          heading: '🎁 Loyalty Rewards',
          body: `Referrals Completed: <b>${Number(endUser.referral_count || 0)}</b>\nCurrent Credits: <b>${Number(endUser.points_balance || 0)}</b>\nActive promotions are announced by the marketplace admin.`,
        })
      );
      return;
    }

    case '⚙️ Settings': {
      await telegram.sendMessage(
        token,
        chatId,
        formatBrandedMessage(config, {
          heading: '⚙️ Account Settings',
          body: `User ID: <code>${endUser.telegram_id}</code>\nUsername: ${endUser.username ? `@${escapeHtml(endUser.username)}` : 'Not set'}\nNotifications: Enabled`,
        })
      );
      return;
    }

    case '❓ Help': {
      await telegram.sendMessage(
        token,
        chatId,
        formatBrandedMessage(config, {
          heading: '❓ Marketplace Help',
          body: `Browse verified digital & email services, submit legitimate service offerings for admin review, and track orders in real time.${config.supportUsername ? `\n\nSupport: ${escapeHtml(config.supportUsername)}` : ''}`,
        })
      );
      return;
    }

    case '🛡 Admin Panel':
    case '/admin': {
      if (!isAdmin) {
        await telegram.sendMessage(token, chatId, '🔒 Unauthorized. Admin permissions are required.');
        return;
      }
      await telegram.sendMessage(
        token,
        chatId,
        formatBrandedMessage(config, {
          heading: '🛡 Marketplace Admin Panel',
          body: 'Manage listings, approve seller submissions, process orders, and view statistics.',
        }),
        {
          reply_markup: buildInlineKeyboard([
            [
              inlineButton({ text: '➕ Add Service', callbackData: 'es:adm:add', style: BUTTON_STYLES.SUCCESS }),
              inlineButton({ text: '📥 Review Submissions', callbackData: 'es:adm:pending', style: BUTTON_STYLES.PRIMARY }),
            ],
            [
              inlineButton({ text: '📁 Pending Orders', callbackData: 'es:adm:orders', style: BUTTON_STYLES.PRIMARY }),
              inlineButton({ text: '📊 Statistics', callbackData: 'es:adm:stats', style: BUTTON_STYLES.DEFAULT }),
            ],
          ]),
        }
      );
      return;
    }
  }
}

async function handleCallback(ctx) {
  const { bot, config, token, telegram, repos, update, endUser, isAdmin } = ctx;
  const cb = update.callback_query;
  const chatId = cb.message?.chat?.id;
  const data = cb.data || '';
  await telegram.answerCallbackQuery(token, cb.id).catch(() => {});

  if (data.startsWith('es:view:')) {
    const svcId = data.slice('es:view:'.length);
    const { row: svc } = await repos.db.first(
      `SELECT * FROM services WHERE id = ? AND bot_id = ?`,
      [svcId, bot.id]
    );
    if (!svc) return;
    await telegram.sendMessage(
      token,
      chatId,
      formatBrandedMessage(config, {
        heading: svc.title,
        body: `Category: <b>${escapeHtml(svc.category)}</b>\nPrice: <b>${svc.price_points} Credits</b>\n\n${escapeHtml(svc.description || 'Verified digital service.')}`,
      }),
      {
        reply_markup: buildInlineKeyboard([
          [inlineButton({ text: '🛒 Order Now', callbackData: `es:order:${svc.id}`, style: BUTTON_STYLES.SUCCESS })],
        ]),
      }
    );
    return;
  }

  if (data.startsWith('es:order:')) {
    const svcId = data.slice('es:order:'.length);
    await repos.endUsers.setState(bot.id, endUser.telegram_id, { step: 'order_details', serviceId: svcId });
    await telegram.sendMessage(token, chatId, 'Send your project requirements / domain or target details to place this order:');
    return;
  }

  if (!isAdmin) return;

  if (data === 'es:adm:add') {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, { step: 'adm_add_service' });
    await telegram.sendMessage(token, chatId, 'Send new service in format:\n<code>Category | Service Title | Price | Description</code>');
    return;
  }

  if (data === 'es:adm:pending') {
    const { rows } = await repos.db.all(
      `SELECT * FROM services WHERE bot_id = ? AND approval_status = 'pending' LIMIT 5`,
      [bot.id]
    );
    if (!rows.length) {
      await telegram.sendMessage(token, chatId, '✅ No pending seller submissions.');
      return;
    }
    for (const s of rows) {
      await telegram.sendMessage(
        token,
        chatId,
        `<b>${escapeHtml(s.title)}</b> (${escapeHtml(s.category)}) — ${s.price_points} cr\n${escapeHtml(s.description)}`,
        { reply_markup: buildApprovalButtons(`es:svc:approve:${s.id}`, `es:svc:reject:${s.id}`) }
      );
    }
    return;
  }

  if (data.startsWith('es:svc:approve:') || data.startsWith('es:svc:reject:')) {
    const approve = data.startsWith('es:svc:approve:');
    const svcId = data.split(':')[3];
    await repos.db.run(
      `UPDATE services SET approval_status = ?, updated_at = ? WHERE id = ? AND bot_id = ?`,
      [approve ? 'approved' : 'rejected', new Date().toISOString(), svcId, bot.id]
    );
    await telegram.sendMessage(token, chatId, approve ? `✅ Service <code>${svcId}</code> approved and live.` : `❌ Service <code>${svcId}</code> rejected.`);
    return;
  }

  if (data === 'es:adm:orders') {
    const { rows } = await repos.db.all(
      `SELECT o.*, s.title FROM service_orders o JOIN services s ON o.service_id = s.id WHERE o.bot_id = ? AND o.status = 'pending' LIMIT 5`,
      [bot.id]
    );
    if (!rows.length) {
      await telegram.sendMessage(token, chatId, '✅ No pending orders.');
      return;
    }
    for (const o of rows) {
      await telegram.sendMessage(
        token,
        chatId,
        `Order <code>${o.id}</code>\nService: <b>${escapeHtml(o.title)}</b>\nBuyer: <code>${o.user_telegram_id}</code>\nDetails: ${escapeHtml(o.target_details)}`,
        { reply_markup: buildApprovalButtons(`es:ord:done:${o.id}`, `es:ord:cancel:${o.id}`, '✅ Complete', '❌ Refund') }
      );
    }
    return;
  }

  if (data.startsWith('es:ord:done:') || data.startsWith('es:ord:cancel:')) {
    const done = data.startsWith('es:ord:done:');
    const orderId = data.split(':')[3];
    const { row: ord } = await repos.db.first(
      `SELECT * FROM service_orders WHERE id = ? AND bot_id = ?`,
      [orderId, bot.id]
    );
    if (!ord || ord.status !== 'pending') return;
    await repos.db.run(
      `UPDATE service_orders SET status = ?, updated_at = ? WHERE id = ?`,
      [done ? 'completed' : 'refunded', new Date().toISOString(), orderId]
    );
    if (!done) {
      await repos.endUsers.adjustPoints(bot.id, ord.user_telegram_id, {
        delta: Number(ord.total_points),
        txType: 'order_refund',
        referenceId: orderId,
        description: 'Service order refunded',
      });
    }
    await telegram.sendMessage(token, chatId, done ? `✅ Order <code>${orderId}</code> marked completed.` : `❌ Order <code>${orderId}</code> refunded.`);
    await telegram
      .sendMessage(token, ord.user_telegram_id, done ? `✅ Your service order <code>${orderId}</code> has been completed!` : `❌ Your order <code>${orderId}</code> was cancelled and refunded.`)
      .catch(() => {});
    return;
  }

  if (data === 'es:adm:stats') {
    const [sRes, oRes] = await Promise.all([
      repos.db.first(`SELECT COUNT(*) AS listings FROM services WHERE bot_id = ? AND approval_status = 'approved'`, [bot.id]),
      repos.db.first(`SELECT COUNT(*) AS orders, COALESCE(SUM(total_points),0) AS volume FROM service_orders WHERE bot_id = ?`, [bot.id]),
    ]);
    await telegram.sendMessage(
      token,
      chatId,
      `<b>📊 Marketplace Statistics</b>\n• Approved Services: <b>${Number(sRes.row?.listings || 0)}</b>\n• Total Orders: <b>${Number(oRes.row?.orders || 0)}</b>\n• Total Credit Volume: <b>${Number(oRes.row?.volume || 0)}</b>`
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
