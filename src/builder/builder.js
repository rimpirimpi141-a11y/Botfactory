/**
 * Custom No-Code Bot Runtime Engine.
 * Executes user-configured menus, submenus, messages, URLs, back navigation,
 * support routing, and safe built-in features directly from D1/KV configuration.
 */

import { buildMenuRenderPayload } from './preview.js';
import { createDefaultCustomMenuTree } from './menu-builder.js';
import { formatBrandedMessage } from './theme-engine.js';
import { buildInlineKeyboard, BUTTON_STYLES, inlineButton } from '../utils/keyboards.js';
import { escapeHtml } from '../utils/validation.js';

export async function handleCustomBuilderUpdate(ctx) {
  const { bot, config, menus, token, telegram, repos, update, endUser, isAdmin } = ctx;
  const activeMenus = menus && menus.length > 0 ? menus : createDefaultCustomMenuTree(config.brandTitle);
  const rootMenu = activeMenus.find((m) => m.isRoot && m.scope === 'user') || activeMenus[0];

  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message?.chat?.id;
    const messageId = cb.message?.message_id;
    const data = cb.data || '';

    await telegram.answerCallbackQuery(token, cb.id).catch(() => {});

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
      });
      return;
    }
  }

  if (update.message) {
    const msg = update.message;
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();

    if (text === '/start' || text === '/menu' || text.startsWith('/start ')) {
      await renderMenuMessage({ telegram, token, chatId, menu: rootMenu, config, isAdmin, edit: false });
      return;
    }

    if (text === '/admin') {
      if (!isAdmin) {
        await telegram.sendMessage(token, chatId, '🔒 Unauthorized. Admin permissions are required.');
        return;
      }
      const adminMenu = activeMenus.find((m) => m.scope === 'admin');
      if (adminMenu) {
        await renderMenuMessage({ telegram, token, chatId, menu: adminMenu, config, isAdmin: true, edit: false });
      } else {
        await telegram.sendMessage(token, chatId, `🛡 <b>Admin Mode Active</b>\nTotal Users: <b>${bot.total_users}</b>\nTotal Updates: <b>${bot.total_updates}</b>`);
      }
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
        });
        return;
      }
    }

    await renderMenuMessage({ telegram, token, chatId, menu: rootMenu, config, isAdmin, edit: false });
  }
}

async function executeButtonAction({ btn, currentMenu, activeMenus, rootMenu, ctx, chatId, messageId, endUser, isAdmin }) {
  const { bot, config, token, telegram, repos } = ctx;

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
      await executeSafeFeature({ featureKey: btn.actionPayload, ctx, chatId, endUser, isAdmin, backKey: currentMenu?.menuKey || rootMenu.menuKey });
      return;
    }
    default:
      return;
  }
}

async function executeSafeFeature({ featureKey, ctx, chatId, endUser, isAdmin, backKey }) {
  const { bot, config, token, telegram, repos } = ctx;
  const backKb = buildInlineKeyboard([
    [inlineButton({ text: '⬅️ Back', callbackData: `cb:menu:${backKey}`, style: BUTTON_STYLES.PRIMARY })],
  ]);

  if (featureKey === 'user_profile') {
    const text = formatBrandedMessage(config, {
      heading: '👤 Your Profile',
      body: [
        `• <b>User ID:</b> <code>${escapeHtml(endUser.telegram_id)}</code>`,
        `• <b>Username:</b> ${endUser.username ? `@${escapeHtml(endUser.username)}` : 'N/A'}`,
        `• <b>Balance:</b> <b>${Number(endUser.points_balance || 0)}</b> pts`,
        `• <b>Referrals:</b> <b>${Number(endUser.referral_count || 0)}</b>`,
        `• <b>Joined:</b> ${escapeHtml(String(endUser.joined_at || '').slice(0, 10))}`,
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
        `• <b>Webhook Status:</b> <code>${escapeHtml(bot.webhook_status)}</code>`,
      ].join('\n'),
    });
    await telegram.sendMessage(token, chatId, text, { reply_markup: backKb });
    return;
  }

  if (featureKey === 'referral_link') {
    const link = `https://t.me/${bot.telegram_username}?start=${endUser.referral_code}`;
    const text = formatBrandedMessage(config, {
      heading: '👥 Your Referral Link',
      body: `Share your unique invite link:\n<code>${escapeHtml(link)}</code>\n\nTotal Referrals: <b>${Number(endUser.referral_count || 0)}</b>`,
    });
    await telegram.sendMessage(token, chatId, text, { reply_markup: backKb });
    return;
  }

  const text = formatBrandedMessage(config, {
    heading: 'ℹ️ Help Overview',
    body: `Use the buttons below to navigate <b>${escapeHtml(config.brandTitle)}</b>. Send /start at any time to reopen the main menu.`,
  });
  await telegram.sendMessage(token, chatId, text, { reply_markup: backKb });
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
