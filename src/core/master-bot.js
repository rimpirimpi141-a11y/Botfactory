/**
 * MASTER BOT — BOT FACTORY
 *
 * Full Telegram interface allowing creators to:
 * - Run the 10-step Guided Bot Creation Wizard (Prebuilt Templates or Custom Bot Builder)
 * - Validate BotFather tokens via real Telegram getMe (never redisplaying plaintext tokens)
 * - Customize branding, theme, support username, welcome image, and footer
 * - Preview live menu layout before deployment
 * - Deploy automatically with animated stage-by-stage progress messages (editMessageText)
 * - Manage created bots (inspect, verify/retry webhook, disable, enable, delete)
 * - Access Owner Super Admin Control Center when user ID matches ADMIN_TELEGRAM_ID
 */

import {
  deleteTenantBot,
  deployTenantBot,
  disableTenantBot,
  enableAndVerifyTenantBot,
  validateTokenForDeployment,
} from './tenant-manager.js';
import { createDefaultCustomMenuTree } from '../builder/menu-builder.js';
import { formatBrandedMessage, listThemePresets } from '../builder/theme-engine.js';
import { buildMenuRenderPayload } from '../builder/preview.js';
import {
  checkOwnerAuthorization,
  handleOwnerCallback,
  handleOwnerMessage,
  isOwnerMenuButton,
  renderOwnerControlCenter,
} from '../admin/owner-panel.js';
import { composeBroadcastPayload } from '../admin/broadcast.js';
import {
  attributePlatformReferral,
  buildMasterReferralLink,
  calculatePlanEntitlement,
  getPlanCatalog,
} from './plans-referrals.js';
import {
  buildBotLiveActionKeyboard,
  formatBotLiveSuccessCard,
  runAnimatedStages,
  withLoadingMessage,
} from '../utils/animations.js';
import {
  buildConfirmCancelKeyboard,
  buildInlineKeyboard,
  buildMasterMainReplyKeyboard,
  BUTTON_STYLES,
  inlineButton,
  MASTER_MAIN_BUTTONS,
} from '../utils/keyboards.js';
import { escapeHtml, validateSafeUrl, validateSupportUsername } from '../utils/validation.js';
import { isDuplicateWebhookUpdate } from '../utils/rate-limiter.js';

export async function handleMasterBotUpdate({ env, repos, telegram, update }) {
  const token = env.MASTER_BOT_TOKEN;
  if (!token) {
    throw new Error('MASTER_BOT_TOKEN secret is not configured.');
  }

  if (await isDuplicateWebhookUpdate(env?.KV, 'master', update?.update_id)) {
    return { ok: true, deduplicated: true };
  }

  const tgUser = update?.message?.from || update?.callback_query?.from;
  if (!tgUser || tgUser.is_bot) return { ok: true };

  const user = await repos.users.upsertFromTelegram(tgUser);
  const telegramId = String(tgUser.id);
  const ownerAuth = await checkOwnerAuthorization(repos, env, telegramId);
  const isOwner = ownerAuth.authorized;

  if (user.status === 'suspended' || user.status === 'banned') {
    const chatId = update?.message?.chat?.id || update?.callback_query?.message?.chat?.id;
    if (chatId) {
      await telegram.sendMessage(token, chatId, '🚫 Your BOT FACTORY account is currently suspended. Contact platform support.');
    }
    return { ok: true };
  }

  if (update.callback_query) {
    return handleMasterCallback({ env, repos, telegram, token, cb: update.callback_query, user, isOwner });
  }

  if (update.message) {
    return handleMasterMessage({ env, repos, telegram, token, msg: update.message, user, isOwner });
  }

  return { ok: true };
}

async function sendMasterHome({ repos, telegram, token, chatId, user, isOwner, referralNotice = '' }) {
  const activeBots = await repos.users.countActiveBots(user.telegram_id);
  const ent = calculatePlanEntitlement(user, activeBots);
  const slotsLabel = ent.isUnlimited ? `${ent.usedSlots} / Unlimited` : `${ent.usedSlots} / ${ent.botLimit}`;

  const welcome = [
    '<pre>╔══════════════════════════╗\n🏭 BOT FACTORY\nBuild. Customize. Deploy.\n╚══════════════════════════╝</pre>',
    '',
    `Welcome, <b>${escapeHtml(user.first_name || user.username || 'Builder')}</b>!`,
    'Build, customize, and deploy production multi-tenant Telegram bots on Cloudflare Workers with automatic webhook verification and colourful native keyboards.',
    referralNotice ? `\n${referralNotice}` : '',
    '',
    `• <b>Plan:</b> ${ent.planLabel} · <b>Bot Slots:</b> ${slotsLabel}`,
    `• <b>Verified Referrals:</b> ${ent.verifiedReferrals}`,
    `• <b>Account ID:</b> <code>${escapeHtml(user.telegram_id)}</code>`,
    '',
    '<i>Select any option from the colourful keyboard below.</i>',
  ]
    .filter((line) => line !== '')
    .join('\n');

  await telegram.sendMessage(token, chatId, welcome, {
    reply_markup: buildMasterMainReplyKeyboard(isOwner),
  });
}

async function handleMasterMessage({ env, repos, telegram, token, msg, user, isOwner }) {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const telegramId = String(user.telegram_id);

  if (text === '/cancel') {
    await repos.users.setWizardState(telegramId, null);
    await telegram.sendMessage(token, chatId, '✖️ Current action cancelled.', {
      reply_markup: buildMasterMainReplyKeyboard(isOwner),
    });
    return { ok: true };
  }

  if (text === '/start' || text.startsWith('/start ')) {
    await repos.users.setWizardState(telegramId, null);
    const startArg = text.split(/\s+/)[1] || '';

    let referralNotice = '';
    if (startArg.startsWith('ref_')) {
      const refCode = startArg.slice(4);
      const refRes = await attributePlatformReferral({
        repos,
        rawReferralCode: refCode,
        referredTgUser: msg.from,
        isNewUser: Boolean(user._isNewUser),
      });
      if (refRes.attributed) {
        referralNotice = '🎉 Referral verified! Your inviter earned +1 active bot creation slot.';
        const slotsText = refRes.entitlement.isUnlimited ? 'Unlimited' : String(refRes.entitlement.botLimit);
        await telegram
          .sendMessage(
            token,
            refRes.referrer.telegram_id,
            `🎉 <b>New Genuine Platform Referral!</b>\nVerified Referrals: <b>${refRes.entitlement.verifiedReferrals}</b>\nCurrent Plan: <b>${refRes.entitlement.planLabel}</b>\nActive Bot Slots: <b>${slotsText}</b>`
          )
          .catch(() => {});
      }
    }

    if (startArg === 'create') {
      await startCreateBotWizard({ env, repos, telegram, token, chatId, telegramId, user });
      return { ok: true };
    }
    await sendMasterHome({ repos, telegram, token, chatId, user, isOwner, referralNotice });
    return { ok: true };
  }

  const wizard = await repos.users.getWizardState(telegramId);

  // Route Owner Control Center 12-button native ReplyKeyboard & stateful owner inputs first
  if (isOwner && (isOwnerMenuButton(text) || wizard?.flow === 'owner_panel')) {
    const handled = await handleOwnerMessage({ env, repos, telegram, token, msg, user, wizard });
    if (handled) return { ok: true };
  }

  // Handle active Bot Creation / Add Support / Broadcast wizard input
  if (wizard && !text.startsWith('/') && !isMainMenuButton(text)) {
    return handleWizardTextStep({ env, repos, telegram, token, chatId, telegramId, text, wizard, isOwner });
  }

  switch (text) {
    case MASTER_MAIN_BUTTONS.CREATE_BOT:
      await startCreateBotWizard({ env, repos, telegram, token, chatId, telegramId, user });
      return { ok: true };

    case MASTER_MAIN_BUTTONS.MY_BOTS:
      await showUserBots({ repos, telegram, token, chatId, telegramId });
      return { ok: true };

    case MASTER_MAIN_BUTTONS.TEMPLATE_STUDIO:
    case '🎨 Theme Studio':
      await showTemplateStudio({ repos, telegram, token, chatId });
      return { ok: true };

    case MASTER_MAIN_BUTTONS.CUSTOM_BUILDER:
    case '🧩 Custom Bot Builder':
      await startCreateBotWizard({ env, repos, telegram, token, chatId, telegramId, user, forceCustom: true });
      return { ok: true };

    case MASTER_MAIN_BUTTONS.MY_STATS:
      await showCreatorStatistics({ repos, telegram, token, chatId, telegramId, user });
      return { ok: true };

    case MASTER_MAIN_BUTTONS.PLANS_FEATURES:
      await showPlansAndFeatures({ env, repos, telegram, token, chatId, user });
      return { ok: true };

    case MASTER_MAIN_BUTTONS.ACCOUNT_SETTINGS:
      await showAccountSettings({ repos, telegram, token, chatId, user, isOwner });
      return { ok: true };

    case MASTER_MAIN_BUTTONS.ADD_SUPPORT:
      await repos.users.setWizardState(telegramId, { flow: 'add_support', step: 'await_input' });
      await telegram.sendMessage(
        token,
        chatId,
        `<b>📢 Add Default Support Contact</b>\nCurrent Handle: <b>${escapeHtml(user.support_username || 'Not set')}</b>\n\nSend: <code>@YourSupportHandle | Optional support message</code>\nSend /cancel to abort.`
      );
      return { ok: true };

    case MASTER_MAIN_BUTTONS.HELP_SUPPORT:
    case '📢 Help & Support':
      await showHelpAndSupport({ repos, telegram, token, chatId, isOwner });
      return { ok: true };

    case MASTER_MAIN_BUTTONS.OWNER_CENTER:
    case '/owner':
      if (!isOwner) {
        await telegram.sendMessage(token, chatId, '🔒 Restricted to BOT FACTORY platform administrators.');
        return { ok: true };
      }
      await renderOwnerControlCenter({ env, repos, telegram, token, chatId });
      return { ok: true };

    default:
      await sendMasterHome({ repos, telegram, token, chatId, user, isOwner });
      return { ok: true };
  }
}

async function handleMasterCallback({ env, repos, telegram, token, cb, user, isOwner }) {
  const chatId = cb.message?.chat?.id;
  const data = cb.data || '';
  const telegramId = String(user.telegram_id);

  if (data.startsWith('owner:')) {
    return handleOwnerCallback({ env, repos, telegram, token, cb });
  }

  await telegram.answerCallbackQuery(token, cb.id).catch(() => {});

  if (data === 'mb:home') {
    await repos.users.setWizardState(telegramId, null);
    await sendMasterHome({ repos, telegram, token, chatId, user, isOwner });
    return { ok: true };
  }

  if (data === 'mb:create') {
    await startCreateBotWizard({ env, repos, telegram, token, chatId, telegramId, user });
    return { ok: true };
  }

  if (data === 'mb:my_bots') {
    await showUserBots({ repos, telegram, token, chatId, telegramId });
    return { ok: true };
  }

  if (data === 'mb:template_studio' || data === 'mb:theme_studio') {
    await showTemplateStudio({ repos, telegram, token, chatId });
    return { ok: true };
  }

  if (data === 'mb:builder') {
    await startCreateBotWizard({ env, repos, telegram, token, chatId, telegramId, user, forceCustom: true });
    return { ok: true };
  }

  if (data === 'mb:stats') {
    await showCreatorStatistics({ repos, telegram, token, chatId, telegramId, user });
    return { ok: true };
  }

  if (data === 'mb:plans') {
    await showPlansAndFeatures({ env, repos, telegram, token, chatId, user });
    return { ok: true };
  }

  if (data === 'mb:settings') {
    await showAccountSettings({ repos, telegram, token, chatId, user, isOwner });
    return { ok: true };
  }

  if (data === 'mb:add_support') {
    await repos.users.setWizardState(telegramId, { flow: 'add_support', step: 'await_input' });
    await telegram.sendMessage(token, chatId, 'Send: <code>@YourSupportHandle | Optional support message</code>');
    return { ok: true };
  }

  if (data === 'mb:help') {
    await showHelpAndSupport({ repos, telegram, token, chatId, isOwner });
    return { ok: true };
  }

  if (data.startsWith('mb:coming_soon:')) {
    await telegram.sendMessage(
      token,
      chatId,
      '🕒 <b>Coming Soon</b>\nThis template is currently under active development and cannot be deployed yet. Choose any of the 11 functional templates in Template Studio!'
    );
    return { ok: true };
  }

  if (data === 'mb:force_join_recheck') {
    await startCreateBotWizard({ env, repos, telegram, token, chatId, telegramId, user });
    return { ok: true };
  }

  // Wizard Step 2: Prebuilt vs Custom Builder
  if (data === 'wiz:mode:template') {
    const allTemplates = await repos.templates.listAllForStudio();
    const functional = allTemplates.filter(
      (t) => t.slug !== 'custom-builder' && Number(t.is_active) === 1 && Number(t.is_coming_soon) !== 1 && t.availability_status === 'active'
    );
    const comingSoon = allTemplates.filter((t) => Number(t.is_coming_soon) === 1 || t.availability_status === 'coming_soon');

    const rows = [];
    for (let i = 0; i < functional.length; i += 2) {
      const pair = functional.slice(i, i + 2).map((t) =>
        inlineButton({
          text: `📦 ${t.name}`,
          callbackData: `wiz:tpl:${t.slug}`,
          style: BUTTON_STYLES.PRIMARY,
        })
      );
      rows.push(pair);
    }
    for (const cs of comingSoon) {
      rows.push([
        inlineButton({
          text: `🕒 ${cs.name} (Coming Soon)`,
          callbackData: `mb:coming_soon:${cs.slug}`,
          style: BUTTON_STYLES.DANGER,
        }),
      ]);
    }
    rows.push([inlineButton({ text: '✖️ Cancel', callbackData: 'mb:home', style: BUTTON_STYLES.DANGER })]);

    await repos.users.setWizardState(telegramId, { flow: 'create_bot', step: 'select_template', mode: 'template' });
    await telegram.sendMessage(
      token,
      chatId,
      '<b>Step 3/10 — Select a Prebuilt Template</b>\n\nAll 11 functional templates are unlocked for every user. Choose your template:',
      { reply_markup: buildInlineKeyboard(rows) }
    );
    return { ok: true };
  }

  if (data === 'wiz:mode:custom') {
    await repos.users.setWizardState(telegramId, {
      flow: 'create_bot',
      step: 'await_token',
      mode: 'custom',
      templateSlug: 'custom-builder',
      templateName: 'Custom No-Code Bot',
    });
    await promptForBotToken({ telegram, token, chatId, templateName: 'Custom No-Code Bot' });
    return { ok: true };
  }

  // Wizard Step 3 -> Step 4 (Token)
  if (data.startsWith('wiz:tpl:')) {
    const slug = data.slice('wiz:tpl:'.length);
    const tpl = await repos.templates.getBySlug(slug);
    if (!tpl) {
      await telegram.sendMessage(token, chatId, '❌ Template not found.');
      return { ok: true };
    }
    if (Number(tpl.is_coming_soon) === 1 || tpl.availability_status === 'coming_soon') {
      await telegram.sendMessage(
        token,
        chatId,
        `🕒 <b>${escapeHtml(tpl.name)}</b> is marked <b>COMING SOON</b> and cannot be deployed yet.`
      );
      return { ok: true };
    }
    if (Number(tpl.is_active) !== 1 || tpl.availability_status !== 'active') {
      await telegram.sendMessage(
        token,
        chatId,
        `⚠️ <b>${escapeHtml(tpl.name)}</b> is currently ${escapeHtml(tpl.availability_status || 'disabled')}.`
      );
      return { ok: true };
    }
    await repos.users.setWizardState(telegramId, {
      flow: 'create_bot',
      step: 'await_token',
      mode: 'template',
      templateSlug: tpl.slug,
      templateId: tpl.id,
      templateName: tpl.name,
    });
    await promptForBotToken({ telegram, token, chatId, templateName: tpl.name });
    return { ok: true };
  }

  // Wizard Step 7: Theme selection -> Step 8 Preview + Step 9 Confirmation
  if (data.startsWith('wiz:theme:')) {
    const themeId = data.slice('wiz:theme:'.length);
    const wizard = await repos.users.getWizardState(telegramId);
    if (!wizard || wizard.flow !== 'create_bot') return { ok: true };

    const updated = {
      ...wizard,
      step: 'confirm_deploy',
      branding: { ...(wizard.branding || {}), themeId },
    };
    await repos.users.setWizardState(telegramId, updated);
    await sendWizardPreviewAndConfirm({ telegram, token, chatId, wizard: updated });
    return { ok: true };
  }

  // Wizard Step 10: Real Animated Automatic Deployment
  if (data === 'wiz:deploy_now') {
    const wizard = await repos.users.getWizardState(telegramId);
    if (!wizard || !wizard.rawToken) {
      await telegram.sendMessage(token, chatId, '⚠️ Deployment session expired. Start again via 🤖 Create New Bot.');
      return { ok: true };
    }
    await executeAnimatedDeployment({ env, repos, telegram, token, chatId, telegramId, wizard });
    return { ok: true };
  }

  // Manage individual user bot (strict ownership check!)
  if (data.startsWith('mb:bot:')) {
    const botId = data.slice('mb:bot:'.length);
    const bot = await repos.bots.getById(botId);
    if (!bot || (bot.owner_telegram_id !== telegramId && !isOwner)) {
      await telegram.sendMessage(token, chatId, '🔒 Bot not found or you do not own this bot.');
      return { ok: true };
    }
    await sendUserBotDetail({ telegram, token, chatId, bot });
    return { ok: true };
  }

  if (data.startsWith('mb:bot_disable:')) {
    const botId = data.slice('mb:bot_disable:'.length);
    const bot = await repos.bots.getById(botId);
    if (!bot || (bot.owner_telegram_id !== telegramId && !isOwner)) return { ok: true };
    await disableTenantBot({ env, repos, telegram, botId, actorTelegramId: telegramId });
    await telegram.sendMessage(token, chatId, `⏸ Bot @${escapeHtml(bot.telegram_username)} disabled and webhook removed.`);
    return { ok: true };
  }

  if (data.startsWith('mb:bot_enable:')) {
    const botId = data.slice('mb:bot_enable:'.length);
    const bot = await repos.bots.getById(botId);
    if (!bot || (bot.owner_telegram_id !== telegramId && !isOwner)) return { ok: true };
    try {
      const res = await enableAndVerifyTenantBot({ env, repos, telegram, botId, actorTelegramId: telegramId });
      await telegram.sendMessage(
        token,
        chatId,
        `🟢 Bot @${escapeHtml(bot.telegram_username)} is LIVE!\nVerified Webhook: <code>${escapeHtml(res.verification.webhookUrl)}</code>`
      );
    } catch (err) {
      await telegram.sendMessage(token, chatId, `❌ Webhook verification failed: ${escapeHtml(err.message)}`);
    }
    return { ok: true };
  }

  if (data.startsWith('mb:bot_del_ask:')) {
    const botId = data.slice('mb:bot_del_ask:'.length);
    const bot = await repos.bots.getById(botId);
    if (!bot || (bot.owner_telegram_id !== telegramId && !isOwner)) return { ok: true };
    await telegram.sendMessage(
      token,
      chatId,
      `⚠️ Are you sure you want to delete <b>@${escapeHtml(bot.telegram_username)}</b>?\nIts webhook will be removed immediately.`,
      { reply_markup: buildConfirmCancelKeyboard(`mb:bot_del_ok:${botId}`, `mb:bot:${botId}`, '🔴 Delete Bot', 'Cancel') }
    );
    return { ok: true };
  }

  if (data.startsWith('mb:bot_del_ok:')) {
    const botId = data.slice('mb:bot_del_ok:'.length);
    const bot = await repos.bots.getById(botId);
    if (!bot || (bot.owner_telegram_id !== telegramId && !isOwner)) return { ok: true };
    await deleteTenantBot({ env, repos, telegram, botId, actorTelegramId: telegramId });
    await telegram.sendMessage(token, chatId, `🗑 Bot @${escapeHtml(bot.telegram_username)} deleted.`);
    return { ok: true };
  }

  return { ok: true };
}

async function checkPlatformForceJoin({ repos, telegram, token, telegramId }) {
  const settings = await repos.stats.getSettings();
  if (settings.map.platform_force_join_enabled !== 'true') {
    return { ok: true, missing: [] };
  }
  let channels = [];
  try {
    channels = JSON.parse(settings.map.platform_force_join_channels || '[]');
  } catch {
    channels = [];
  }
  if (!Array.isArray(channels) || !channels.length) {
    return { ok: true, missing: [] };
  }

  const missing = [];
  for (const ch of channels) {
    const channelId = typeof ch === 'string' ? ch : ch.id || ch.username;
    if (!channelId) continue;
    try {
      const member = await telegram.getChatMember(token, channelId, telegramId);
      const memberStatus = member?.result?.status ?? member?.status;
      if (!memberStatus || ['left', 'kicked'].includes(memberStatus)) {
        missing.push(channelId);
      }
    } catch {
      missing.push(channelId);
    }
  }
  return { ok: missing.length === 0, missing };
}

async function startCreateBotWizard({ env, repos, telegram, token, chatId, telegramId, user, forceCustom = false }) {
  // 1. Real Platform Force Join Verification (when enabled by owner)
  const fj = await checkPlatformForceJoin({ repos, telegram, token, telegramId });
  if (!fj.ok) {
    const rows = fj.missing.map((ch) => {
      const handle = String(ch).replace(/^@/, '');
      return [
        inlineButton({
          text: `📢 Join ${ch}`,
          url: `https://t.me/${handle}`,
          style: BUTTON_STYLES.PRIMARY,
        }),
      ];
    });
    rows.push([
      inlineButton({
        text: '✅ I Joined — Verify Now',
        callbackData: 'mb:force_join_recheck',
        style: BUTTON_STYLES.SUCCESS,
      }),
    ]);
    await telegram.sendMessage(
      token,
      chatId,
      '🔒 <b>Channel Membership Required</b>\n\nJoin the required BOT FACTORY channel(s) below and tap <b>✅ I Joined — Verify Now</b> to continue:',
      { reply_markup: buildInlineKeyboard(rows) }
    );
    return;
  }

  // 2. Real Referral & Plan Bot Slot Check
  const activeCount = await repos.users.countActiveBots(telegramId);
  const refSummary = await repos.platformReferrals.getSummary(telegramId);
  const entitlement = calculatePlanEntitlement(
    { ...user, verified_referrals: refSummary.verified },
    activeCount,
    refSummary.pending
  );

  if (!entitlement.canCreateBot) {
    const refLink = buildMasterReferralLink(env, user.referral_code);
    await telegram.sendMessage(
      token,
      chatId,
      [
        '⚠️ <b>Bot Creation Slot Limit Reached</b>',
        '',
        `• <b>Current Plan:</b> ${entitlement.planLabel}`,
        `• <b>Active Bots:</b> ${entitlement.activeBotCount} / ${entitlement.maxBotsLabel}`,
        `• <b>Verified Referrals:</b> ${entitlement.verifiedReferrals}`,
        '',
        'Invite new creators with your personal referral link (+1 bot slot per verified referral, 8 = Starter, 48 = Pro, 50 = Enterprise Unlimited):',
        refLink ? `<code>${escapeHtml(refLink)}</code>` : `Referral Code: <code>${escapeHtml(user.referral_code || '')}</code>`,
      ].join('\n'),
      {
        reply_markup: buildInlineKeyboard([
          [inlineButton({ text: '💎 View Plans & Referrals', callbackData: 'mb:plans', style: BUTTON_STYLES.PRIMARY })],
          [inlineButton({ text: '📂 Manage Existing Bots', callbackData: 'mb:my_bots', style: BUTTON_STYLES.SUCCESS })],
        ]),
      }
    );
    return;
  }

  if (forceCustom) {
    await repos.users.setWizardState(telegramId, {
      flow: 'create_bot',
      step: 'await_token',
      mode: 'custom',
      templateSlug: 'custom-builder',
      templateName: 'Custom No-Code Bot',
    });
    await promptForBotToken({ telegram, token, chatId, templateName: 'Custom No-Code Bot' });
    return;
  }

  await repos.users.setWizardState(telegramId, { flow: 'create_bot', step: 'choose_mode' });
  await telegram.sendMessage(
    token,
    chatId,
    [
      '<b>Step 2/10 — Choose Creation Mode</b>',
      `Available Slots: <b>${entitlement.isUnlimited ? 'Unlimited' : `${entitlement.remainingSlots} remaining (${entitlement.activeBotCount}/${entitlement.maxBotsLabel})`}</b>`,
      '',
      'Launch instantly with any of the 11 Prebuilt Templates or build a bespoke bot with the Custom No-Code Bot Builder:',
    ].join('\n'),
    {
      reply_markup: buildInlineKeyboard([
        [
          inlineButton({ text: '📦 Prebuilt Templates', callbackData: 'wiz:mode:template', style: BUTTON_STYLES.SUCCESS }),
          inlineButton({ text: '🛠 Custom Bot Builder', callbackData: 'wiz:mode:custom', style: BUTTON_STYLES.PRIMARY }),
        ],
        [inlineButton({ text: '✖️ Cancel', callbackData: 'mb:home', style: BUTTON_STYLES.DANGER })],
      ]),
    }
  );
}

async function promptForBotToken({ telegram, token, chatId, templateName }) {
  await telegram.sendMessage(
    token,
    chatId,
    [
      `<b>Step 4/10 — Provide BotFather Token</b>`,
      `Selected: <b>${escapeHtml(templateName)}</b>`,
      '',
      '1. Open official <b>@BotFather</b> on Telegram and run <code>/newbot</code>.',
      '2. Copy the HTTP API token and paste it here.',
      '',
      '🔐 <i>Security Notice: Your token is validated via Telegram <code>getMe</code>, encrypted with AES-256-GCM, and never displayed again.</i>',
      'Send /cancel to abort.',
    ].join('\n')
  );
}

async function handleWizardTextStep({ env, repos, telegram, token, chatId, telegramId, text, wizard, isOwner }) {
  // Owner Global Broadcast text composition
  if (wizard.flow === 'owner_broadcast' && isOwner && wizard.step === 'await_message') {
    await repos.users.setWizardState(telegramId, null);
    const settings = await repos.stats.getSettings();
    const draft = await repos.broadcasts.create({
      scope: 'global',
      messageText: text,
      includePromoFooter: settings.map.promo_footer_enabled !== 'false',
      createdBy: telegramId,
    });
    const preview = composeBroadcastPayload({ broadcast: draft, env, settingsMap: settings.map });
    await telegram.sendMessage(
      token,
      chatId,
      `<b>📨 Broadcast Preview (Draft ${draft.id})</b>\n━━━━━━━━━━━━━━━━━━━━\n${preview.text}`,
      { reply_markup: preview.replyMarkup }
    );
    await telegram.sendMessage(
      token,
      chatId,
      'Confirm launching this Global Broadcast across all active BOT FACTORY bots?',
      { reply_markup: buildConfirmCancelKeyboard(`owner:brc_launch:${draft.id}`, 'owner:home', '🚀 Launch Global Broadcast', '✖️ Cancel') }
    );
    return { ok: true };
  }

  // Default Creator Support Contact wizard
  if (wizard.flow === 'add_support' && wizard.step === 'await_input') {
    const [handleRaw, messageRaw] = text.split('|').map((s) => s?.trim());
    const supCheck = validateSupportUsername(handleRaw || '');
    if (!supCheck.valid) {
      await telegram.sendMessage(
        token,
        chatId,
        `❌ ${escapeHtml(supCheck.error)}\nSend: <code>@YourSupportHandle | Optional support message</code> or /cancel.`
      );
      return { ok: true };
    }
    await repos.users.updateSupportSettings(telegramId, {
      supportUsername: supCheck.username,
      supportMessage: (messageRaw || '').slice(0, 300),
    });
    await repos.users.setWizardState(telegramId, null);
    await telegram.sendMessage(
      token,
      chatId,
      [
        '✅ <b>Default Support Contact Saved</b>',
        `• <b>Handle:</b> ${escapeHtml(supCheck.username || 'Cleared')}`,
        messageRaw ? `• <b>Support Note:</b> ${escapeHtml(messageRaw.slice(0, 300))}` : '',
        '',
        'This handle is now available as your default support identity across your BOT FACTORY workspace.',
      ]
        .filter(Boolean)
        .join('\n'),
      { reply_markup: buildMasterMainReplyKeyboard(isOwner) }
    );
    return { ok: true };
  }

  if (wizard.flow !== 'create_bot') return { ok: true };

  // Step 4 -> Step 5: Real Telegram getMe token validation
  if (wizard.step === 'await_token') {
    try {
      const validated = await validateTokenForDeployment({
        telegram,
        repos,
        rawToken: text,
        ownerTelegramId: telegramId,
        allowRetryFailed: true,
      });
      // Best effort: remove user's token message from chat history if permissions allow
      await repos.users.setWizardState(telegramId, {
        ...wizard,
        step: 'await_display_name',
        rawToken: validated.token, // scrubbed immediately upon deployment
        telegramBotId: validated.telegramBotId,
        telegramUsername: validated.telegramUsername,
      });

      await telegram.sendMessage(
        token,
        chatId,
        [
          `✅ <b>Token Verified via Telegram getMe!</b>`,
          `• <b>Username:</b> @${escapeHtml(validated.telegramUsername)}`,
          `• <b>Telegram Bot ID:</b> <code>${escapeHtml(validated.telegramBotId)}</code>`,
          '<i>Your token has been accepted and will not be echoed back.</i>',
          '',
          '<b>Step 5/10 — Bot Display Name</b>',
          'Send the brand display name for your bot (e.g. <code>Apex Rewards</code>):',
        ].join('\n')
      );
    } catch (err) {
      await telegram.sendMessage(
        token,
        chatId,
        `❌ <b>Token Validation Failed</b>\n${escapeHtml(err.message)}\n\nPlease paste a valid @BotFather token or send /cancel.`
      );
    }
    return { ok: true };
  }

  // Step 5 -> Step 6: Description
  if (wizard.step === 'await_display_name') {
    const displayName = text.slice(0, 64);
    await repos.users.setWizardState(telegramId, {
      ...wizard,
      step: 'await_description',
      displayName,
    });
    await telegram.sendMessage(
      token,
      chatId,
      `<b>Step 6/10 — Bot Description</b>\nDisplay Name: <b>${escapeHtml(displayName)}</b>\n\nSend a short description / welcome message for users:`
    );
    return { ok: true };
  }

  // Step 6 -> Optional Festive Bonus campaign setup OR Step 7a Branding
  if (wizard.step === 'await_description') {
    const description = text.slice(0, 400);
    if (wizard.templateSlug === 'festive-bonus') {
      await repos.users.setWizardState(telegramId, {
        ...wizard,
        step: 'await_festive_config',
        description,
      });
      await telegram.sendMessage(
        token,
        chatId,
        [
          '<b>🎉 Festive Bonus Campaign Setup</b>',
          'Configure your campaign details separated by <code>|</code> (or send <code>skip</code> for defaults):',
          '<code>Campaign Name | Bonus Reward | Min Referrals | Max Claims (0 = unlimited)</code>',
          '',
          'Example:',
          '<code>Diwali Mega Bonus | 100 | 3 | 500</code>',
        ].join('\n')
      );
      return { ok: true };
    }

    await repos.users.setWizardState(telegramId, {
      ...wizard,
      step: 'await_branding',
      description,
    });
    await telegram.sendMessage(
      token,
      chatId,
      [
        '<b>Step 7/10 — Branding Configuration</b>',
        'Send your branding details separated by <code>|</code> (or send <code>skip</code> for defaults):',
        '<code>Brand Title | Footer Text | @SupportHandle | Welcome Image URL (optional)</code>',
        '',
        'Example:',
        '<code>Nova Digital | Powered by Nova | @NovaSupport</code>',
      ].join('\n')
    );
    return { ok: true };
  }

  // Optional Festive Bonus campaign configuration step -> Step 7a Branding
  if (wizard.step === 'await_festive_config') {
    let templateConfig = {
      campaignName: 'Festive Celebration Bonus',
      rewardAmount: 50,
      minReferrals: 0,
      maxClaims: 0,
    };
    if (text.toLowerCase() !== 'skip') {
      const [campaignName, rewardStr, minRefStr, maxClaimsStr] = text.split('|').map((s) => s?.trim());
      if (campaignName) templateConfig.campaignName = campaignName.slice(0, 80);
      if (rewardStr && Number.isFinite(Number(rewardStr))) {
        templateConfig.rewardAmount = Math.max(1, Number(rewardStr));
      }
      if (minRefStr && Number.isFinite(Number(minRefStr))) {
        templateConfig.minReferrals = Math.max(0, Math.trunc(Number(minRefStr)));
      }
      if (maxClaimsStr && Number.isFinite(Number(maxClaimsStr))) {
        templateConfig.maxClaims = Math.max(0, Math.trunc(Number(maxClaimsStr)));
      }
    }
    await repos.users.setWizardState(telegramId, {
      ...wizard,
      step: 'await_branding',
      templateConfig,
    });
    await telegram.sendMessage(
      token,
      chatId,
      [
        `✅ Campaign configured: <b>${escapeHtml(templateConfig.campaignName)}</b> (Reward: ${templateConfig.rewardAmount}, Min Refs: ${templateConfig.minReferrals})`,
        '',
        '<b>Step 7/10 — Branding Configuration</b>',
        'Send your branding details separated by <code>|</code> (or send <code>skip</code> for defaults):',
        '<code>Brand Title | Footer Text | @SupportHandle | Welcome Image URL (optional)</code>',
      ].join('\n')
    );
    return { ok: true };
  }

  // Step 7a -> Step 7b: Theme Selection
  if (wizard.step === 'await_branding') {
    let branding = {
      brandTitle: wizard.displayName,
      welcomeMessage: wizard.description,
      footerText: '',
      supportUsername: '',
      welcomeImageUrl: null,
    };

    if (text.toLowerCase() !== 'skip') {
      const [brandTitle, footerText, supportRaw, imageUrlRaw] = text.split('|').map((s) => s?.trim());
      if (brandTitle) branding.brandTitle = brandTitle.slice(0, 80);
      if (footerText) branding.footerText = footerText.slice(0, 120);
      if (supportRaw) {
        const supCheck = validateSupportUsername(supportRaw);
        if (!supCheck.valid) {
          await telegram.sendMessage(token, chatId, `❌ ${escapeHtml(supCheck.error)} Try again or send <code>skip</code>.`);
          return { ok: true };
        }
        branding.supportUsername = supCheck.username;
      }
      if (imageUrlRaw) {
        const imgCheck = validateSafeUrl(imageUrlRaw);
        if (!imgCheck.valid) {
          await telegram.sendMessage(token, chatId, `❌ Welcome image URL invalid: ${escapeHtml(imgCheck.error)} Try again or send <code>skip</code>.`);
          return { ok: true };
        }
        branding.welcomeImageUrl = imgCheck.url;
      }
    }

    await repos.users.setWizardState(telegramId, {
      ...wizard,
      step: 'select_theme',
      branding,
    });

    const themeRows = listThemePresets().map((t) => [
      inlineButton({
        text: `${t.headerPrefix} ${t.name}`,
        callbackData: `wiz:theme:${t.id}`,
        style: t.defaultPrimaryStyle,
      }),
    ]);

    await telegram.sendMessage(
      token,
      chatId,
      '<b>Step 7/10 — Choose Your Bot Theme</b>\nSelect a visual style from Theme Studio:',
      { reply_markup: buildInlineKeyboard(themeRows) }
    );
    return { ok: true };
  }

  return { ok: true };
}

async function sendWizardPreviewAndConfirm({ telegram, token, chatId, wizard }) {
  const sampleMenus = createDefaultCustomMenuTree(wizard.branding?.brandTitle || wizard.displayName);
  const preview = buildMenuRenderPayload({
    menu: sampleMenus[0],
    config: {
      brandTitle: wizard.branding?.brandTitle || wizard.displayName,
      footerText: wizard.branding?.footerText || '',
      supportUsername: wizard.branding?.supportUsername || '',
      themeId: wizard.branding?.themeId || 'obsidian_neon',
    },
    isAdmin: true,
  });

  await telegram.sendMessage(
    token,
    chatId,
    `<b>Step 8/10 — Live Bot Menu Preview</b>\n\n${preview.text}`,
    { reply_markup: preview.replyMarkup }
  );

  const confirmText = [
    '<b>Step 9/10 — Deployment Confirmation</b>',
    '',
    `• <b>Target Bot:</b> @${escapeHtml(wizard.telegramUsername)}`,
    `• <b>Display Name:</b> ${escapeHtml(wizard.displayName)}`,
    `• <b>Template:</b> ${escapeHtml(wizard.templateName)}`,
    `• <b>Theme:</b> ${escapeHtml(wizard.branding?.themeId || 'obsidian_neon')}`,
    `• <b>Support:</b> ${escapeHtml(wizard.branding?.supportUsername || 'Not set')}`,
    '',
    'Tap <b>🚀 Deploy Automatically</b> to encrypt your token, write to Cloudflare D1, register your Telegram webhook, and verify live connectivity.',
  ].join('\n');

  await telegram.sendMessage(token, chatId, confirmText, {
    reply_markup: buildConfirmCancelKeyboard('wiz:deploy_now', 'mb:home', '🚀 Deploy Automatically', '✖️ Cancel'),
  });
}

async function executeAnimatedDeployment({ env, repos, telegram, token, chatId, telegramId, wizard }) {
  const customMenus = wizard.mode === 'custom' ? createDefaultCustomMenuTree(wizard.branding?.brandTitle || wizard.displayName) : null;
  let deployedResult = null;

  const stages = [
    {
      id: 'validate_credentials',
      label: '1/6 · Validating credentials via Telegram getMe...',
      doneLabel: '1/6 · Credentials validated',
      run: async () => {
        await validateTokenForDeployment({
          telegram,
          repos,
          rawToken: wizard.rawToken,
          ownerTelegramId: telegramId,
          allowRetryFailed: true,
        });
        return { validated: true };
      },
    },
    {
      id: 'prepare_config',
      label: '2/6 · Preparing bot configuration & encrypting token...',
      doneLabel: '2/6 · Configuration prepared & encrypted',
      run: async () => ({ ready: true }),
    },
    {
      id: 'deploy_pipeline',
      label: '3–5/6 · Saving D1 records, registering & verifying webhook...',
      doneLabel: '3–5/6 · D1 saved, webhook registered & verified via getWebhookInfo',
      run: async () => {
        deployedResult = await deployTenantBot({
          env,
          repos,
          telegram,
          ownerTelegramId: telegramId,
          rawToken: wizard.rawToken,
          templateId: wizard.templateSlug || wizard.templateId,
          mode: wizard.mode,
          displayName: wizard.displayName,
          description: wizard.description,
          branding: wizard.branding,
          customMenus,
          templateConfig: wizard.templateConfig || null,
        });
        return deployedResult;
      },
    },
    {
      id: 'activate_bot',
      label: '6/6 · Activating multi-tenant bot & scrubbing session...',
      doneLabel: '6/6 · Bot activated on Cloudflare Workers',
      run: async () => {
        // Immediately scrub plaintext token from wizard state!
        await repos.users.setWizardState(telegramId, null);
        return { cleaned: true };
      },
    },
  ];

  try {
    const { messageId } = await runAnimatedStages({
      telegram,
      token,
      chatId,
      title: `⚡ Deploying @${wizard.telegramUsername}`,
      stages,
      minStageIntervalMs: 700,
      retryCallbackData: 'wiz:deploy_now',
    });

    const card = formatBotLiveSuccessCard({
      botUsername: deployedResult.bot.telegram_username,
      displayName: deployedResult.bot.display_name,
      botId: deployedResult.bot.id,
      templateName: deployedResult.template.name,
      webhookUrl: deployedResult.verification.webhookUrl,
    });

    const kb = buildBotLiveActionKeyboard(deployedResult.bot.telegram_username, deployedResult.bot.id);
    if (messageId) {
      await telegram.editMessageText(token, chatId, messageId, card, { reply_markup: kb });
    } else {
      await telegram.sendMessage(token, chatId, card, { reply_markup: kb });
    }
  } catch {
    // Error card with Retry button was already rendered by runAnimatedStages
  }
}

async function showUserBots({ repos, telegram, token, chatId, telegramId }) {
  await withLoadingMessage({
    telegram,
    token,
    chatId,
    loadingText: 'Loading your created bots from D1...',
    action: async () => {
      const bots = await repos.bots.listByOwner(telegramId);
      if (!bots.length) {
        return {
          text: '<b>📂 My Created Bots</b>\n\nYou have not deployed any bots yet. Tap <b>🤖 Create New Bot</b> to launch your first verified bot!',
          replyMarkup: buildInlineKeyboard([
            [inlineButton({ text: '🤖 Create New Bot', callbackData: 'mb:create', style: BUTTON_STYLES.SUCCESS })],
          ]),
        };
      }
      const rows = bots.map((b) => [
        inlineButton({
          text: `${b.status === 'active' && b.webhook_status === 'verified' ? '🟢' : '🔴'} @${b.telegram_username} · ${b.template_name || b.mode}`,
          callbackData: `mb:bot:${b.id}`,
          style: b.status === 'active' ? BUTTON_STYLES.SUCCESS : BUTTON_STYLES.DANGER,
        }),
      ]);
      rows.push([inlineButton({ text: '🤖 Create Another Bot', callbackData: 'mb:create', style: BUTTON_STYLES.PRIMARY })]);
      return {
        text: `<b>📂 My Created Bots (${bots.length})</b>\nSelect a bot to inspect status, verify webhook, or manage:`,
        replyMarkup: buildInlineKeyboard(rows),
      };
    },
  });
}

async function sendUserBotDetail({ telegram, token, chatId, bot }) {
  const isLive = bot.status === 'active' && bot.webhook_status === 'verified';
  const text = [
    `<b>🤖 ${escapeHtml(bot.display_name)}</b> (@${escapeHtml(bot.telegram_username)})`,
    '',
    `• <b>Status:</b> ${isLive ? '🟢 ONLINE' : `🔴 ${bot.status.toUpperCase()}`}`,
    `• <b>Webhook:</b> ${bot.webhook_status.toUpperCase()}`,
    `• <b>Template:</b> ${escapeHtml(bot.template_name || bot.mode)}`,
    `• <b>Users:</b> ${bot.total_users} · <b>Updates:</b> ${bot.total_updates}`,
    `• <b>Bot ID:</b> <code>${bot.id}</code>`,
    bot.webhook_last_error ? `• <b>Last Error:</b> ${escapeHtml(bot.webhook_last_error)}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  await telegram.sendMessage(token, chatId, text, {
    reply_markup: buildInlineKeyboard([
      [
        inlineButton({ text: '🚀 Open Bot', url: `https://t.me/${bot.telegram_username}`, style: BUTTON_STYLES.SUCCESS }),
        inlineButton({ text: '🔄 Verify Webhook', callbackData: `mb:bot_enable:${bot.id}`, style: BUTTON_STYLES.PRIMARY }),
      ],
      [
        inlineButton({
          text: bot.status === 'active' ? '⏸ Disable Bot' : '▶️ Enable Bot',
          callbackData: bot.status === 'active' ? `mb:bot_disable:${bot.id}` : `mb:bot_enable:${bot.id}`,
          style: BUTTON_STYLES.PRIMARY,
        }),
        inlineButton({ text: '🔴 Delete Bot', callbackData: `mb:bot_del_ask:${bot.id}`, style: BUTTON_STYLES.DANGER }),
      ],
      [inlineButton({ text: '⬅️ Back to My Bots', callbackData: 'mb:my_bots', style: BUTTON_STYLES.PRIMARY })],
    ]),
  });
}

async function showTemplateStudio({ repos, telegram, token, chatId }) {
  const all = await repos.templates.listAllForStudio();
  const studioItems = all.filter((t) => t.slug !== 'custom-builder');
  const active = studioItems.filter((t) => Number(t.is_coming_soon) !== 1 && t.availability_status === 'active' && Number(t.is_active) === 1);
  const comingSoon = studioItems.filter((t) => Number(t.is_coming_soon) === 1 || t.availability_status === 'coming_soon');

  const lines = [
    `<b>🎨 BOT FACTORY Template Studio</b>`,
    `All <b>${active.length}</b> functional templates are included on every plan — zero template locks!`,
    '',
    '<b>✅ Production-Ready Templates:</b>',
    ...active.map((t, i) => `${i + 1}. <b>${escapeHtml(t.name)}</b> — <i>${escapeHtml(t.category)}</i>`),
  ];

  if (comingSoon.length) {
    lines.push('', '<b>🕒 Coming Soon:</b>');
    for (const cs of comingSoon) {
      lines.push(`• <b>${escapeHtml(cs.name)}</b> — <i>COMING SOON</i>`);
    }
  }

  const rows = [];
  for (let i = 0; i < active.length; i += 2) {
    rows.push(
      active.slice(i, i + 2).map((t) =>
        inlineButton({
          text: `🚀 ${t.name}`,
          callbackData: `wiz:tpl:${t.slug}`,
          style: BUTTON_STYLES.SUCCESS,
        })
      )
    );
  }
  for (const cs of comingSoon) {
    rows.push([
      inlineButton({
        text: `🕒 ${cs.name} (Coming Soon)`,
        callbackData: `mb:coming_soon:${cs.slug}`,
        style: BUTTON_STYLES.DANGER,
      }),
    ]);
  }
  rows.push([inlineButton({ text: '🧩 Open Custom Bot Builder', callbackData: 'mb:builder', style: BUTTON_STYLES.PRIMARY })]);

  await telegram.sendMessage(token, chatId, lines.join('\n'), {
    reply_markup: buildInlineKeyboard(rows),
  });
}

async function showCreatorStatistics({ repos, telegram, token, chatId, telegramId, user }) {
  await withLoadingMessage({
    telegram,
    token,
    chatId,
    loadingText: 'Fetching real-time statistics from D1...',
    action: async () => {
      const bots = await repos.bots.listByOwner(telegramId);
      const active = bots.filter((b) => b.status === 'active' && b.webhook_status === 'verified').length;
      const totalUsers = bots.reduce((s, b) => s + Number(b.total_users || 0), 0);
      const totalUpdates = bots.reduce((s, b) => s + Number(b.total_updates || 0), 0);
      const refSummary = await repos.platformReferrals.getSummary(telegramId);
      const entitlement = calculatePlanEntitlement(
        { ...user, verified_referrals: refSummary.verified },
        bots.filter((b) => ['active', 'deploying', 'disabled'].includes(b.status)).length,
        refSummary.pending
      );

      return {
        text: [
          '<b>📊 My Creator Statistics</b>',
          '',
          `• <b>Plan Tier:</b> ${entitlement.planLabel}`,
          `• <b>Bot Slots Used:</b> ${entitlement.activeBotCount} / ${entitlement.maxBotsLabel}`,
          `• <b>Verified Online Bots:</b> ${active}`,
          `• <b>Combined End-Users:</b> ${totalUsers}`,
          `• <b>Combined Webhook Updates:</b> ${totalUpdates}`,
          `• <b>Verified Referrals:</b> ${entitlement.verifiedReferrals} (Pending: ${entitlement.pendingReferrals})`,
        ].join('\n'),
        replyMarkup: buildInlineKeyboard([
          [
            inlineButton({ text: '📂 View My Bots', callbackData: 'mb:my_bots', style: BUTTON_STYLES.PRIMARY }),
            inlineButton({ text: '💎 Plans & Referrals', callbackData: 'mb:plans', style: BUTTON_STYLES.SUCCESS }),
          ],
        ]),
      };
    },
  });
}

async function showPlansAndFeatures({ env, repos, telegram, token, chatId, user }) {
  const telegramId = String(user.telegram_id);
  const activeBots = await repos.users.countActiveBots(telegramId);
  const refSummary = await repos.platformReferrals.getSummary(telegramId);
  const entitlement = calculatePlanEntitlement(
    { ...user, verified_referrals: refSummary.verified },
    activeBots,
    refSummary.pending
  );
  const refLink = buildMasterReferralLink(env, user.referral_code);
  const catalog = getPlanCatalog();

  const lines = [
    '<b>💎 BOT FACTORY — Plans & Referral Unlocks</b>',
    '',
    `• <b>Current Plan:</b> ${entitlement.planLabel}`,
    `• <b>Bot Slots:</b> ${entitlement.activeBotCount} / ${entitlement.maxBotsLabel} (${entitlement.isUnlimited ? 'Unlimited' : `${entitlement.remainingSlots} available`})`,
    `• <b>Verified Referrals:</b> ${entitlement.verifiedReferrals}`,
    `• <b>Pending Referrals:</b> ${entitlement.pendingReferrals}`,
    entitlement.nextMilestone
      ? `• <b>Next Milestone:</b> ${entitlement.nextMilestone.planLabel} (${entitlement.nextMilestone.remaining} more verified referrals -> ${entitlement.nextMilestone.reward})`
      : '• <b>Milestone Status:</b> Maximum ENTERPRISE Unlimited tier unlocked!',
    '',
    '<b>📈 Referral Milestone Tiers (+1 bot slot per verified referral):</b>',
    ...catalog.map(
      (p) =>
        `• <b>${p.name}</b> (${p.referralsRequired} refs) — ${p.maxBotsLabel} · ${p.summary}`
    ),
    '',
    '<b>🔗 Your Personal Referral Link:</b>',
    refLink ? `<code>${escapeHtml(refLink)}</code>` : `Referral Code: <code>${escapeHtml(user.referral_code || '')}</code>`,
    '<i>Every new unique user who joins BOT FACTORY through your link permanently grants +1 bot slot. All 11 templates are free on every tier!</i>',
  ];

  if (refSummary.recent?.length) {
    lines.push('', '<b>🕒 Recent Referrals:</b>');
    for (const r of refSummary.recent.slice(0, 5)) {
      const refName = r.referred_username || r.username;
      lines.push(`• ${refName ? `@${escapeHtml(refName)}` : `User ${escapeHtml(r.referred_telegram_id)}`} — <code>${escapeHtml(r.status)}</code>`);
    }
  }

  await telegram.sendMessage(token, chatId, lines.join('\n'), {
    reply_markup: buildInlineKeyboard([
      [
        inlineButton({ text: '🤖 Create New Bot', callbackData: 'mb:create', style: BUTTON_STYLES.SUCCESS }),
        inlineButton({ text: '📊 My Statistics', callbackData: 'mb:stats', style: BUTTON_STYLES.PRIMARY }),
      ],
    ]),
  });
}

async function showAccountSettings({ repos, telegram, token, chatId, user, isOwner }) {
  const telegramId = String(user.telegram_id);
  const activeBots = await repos.users.countActiveBots(telegramId);
  const refSummary = await repos.platformReferrals.getSummary(telegramId);
  const entitlement = calculatePlanEntitlement(
    { ...user, verified_referrals: refSummary.verified },
    activeBots,
    refSummary.pending
  );

  await telegram.sendMessage(
    token,
    chatId,
    [
      '<b>⚙️ Account Settings</b>',
      '',
      `• <b>Telegram ID:</b> <code>${escapeHtml(telegramId)}</code>`,
      `• <b>Username:</b> ${user.username ? `@${escapeHtml(user.username)}` : 'Not set'}`,
      `• <b>Role:</b> ${isOwner ? 'Platform Administrator' : 'Creator'}`,
      `• <b>Plan Tier:</b> ${entitlement.planLabel}`,
      `• <b>Bot Slots:</b> ${entitlement.activeBotCount} / ${entitlement.maxBotsLabel}`,
      `• <b>Referral Code:</b> <code>${escapeHtml(user.referral_code || '')}</code>`,
      `• <b>Default Support Contact:</b> ${escapeHtml(user.support_username || 'Not configured')}`,
      user.support_message ? `• <b>Support Note:</b> ${escapeHtml(user.support_message)}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    {
      reply_markup: buildInlineKeyboard([
        [inlineButton({ text: '📢 Update Support Contact', callbackData: 'mb:add_support', style: BUTTON_STYLES.PRIMARY })],
        [inlineButton({ text: '💎 Plans & Referral Link', callbackData: 'mb:plans', style: BUTTON_STYLES.SUCCESS })],
      ]),
    }
  );
}

async function showHelpAndSupport({ repos, telegram, token, chatId, isOwner }) {
  const settings = await repos.stats.getSettings();
  const supportUsername = settings.map.platform_support_username || '';
  const supportUrl = settings.map.platform_support_url || '';
  const supportInstructions = settings.map.platform_support_instructions || '';
  const supportAvailability = settings.map.platform_support_availability || '';
  const supportMsg =
    settings.map.platform_support_message ||
    'Need help creating or deploying your Telegram bot? Contact official BOT FACTORY support.';

  const rows = [];
  if (supportUrl && /^https?:\/\//i.test(supportUrl)) {
    rows.push([inlineButton({ text: '💬 Contact Official Support', url: supportUrl, style: BUTTON_STYLES.SUCCESS })]);
  } else if (supportUsername) {
    rows.push([
      inlineButton({
        text: `💬 Message ${supportUsername}`,
        url: `https://t.me/${supportUsername.replace(/^@/, '')}`,
        style: BUTTON_STYLES.SUCCESS,
      }),
    ]);
  }
  rows.push([inlineButton({ text: '🤖 Start Bot Creation Wizard', callbackData: 'mb:create', style: BUTTON_STYLES.PRIMARY })]);

  await telegram.sendMessage(
    token,
    chatId,
    [
      '<b>📣 BOT FACTORY — Help & Support</b>',
      '',
      escapeHtml(supportMsg),
      supportInstructions ? `\n<b>📋 Support Instructions:</b>\n${escapeHtml(supportInstructions)}` : '',
      '',
      supportUsername ? `• <b>Support Handle:</b> ${escapeHtml(supportUsername)}` : '• <b>Support Handle:</b> Configure in Owner Control Center -> Support Management',
      supportAvailability ? `• <b>Availability:</b> ${escapeHtml(supportAvailability)}` : '',
      '• <b>Quick Commands:</b> /start (Home) · /cancel (Abort wizard)',
      isOwner ? '• <b>Admin Command:</b> /owner (Owner Control Center)' : '',
    ]
      .filter(Boolean)
      .join('\n'),
    { reply_markup: buildInlineKeyboard(rows) }
  );
}

function isMainMenuButton(text) {
  return [
    ...Object.values(MASTER_MAIN_BUTTONS),
    '🎨 Theme Studio',
    '🧩 Custom Bot Builder',
    '📢 Help & Support',
  ].includes(text);
}
