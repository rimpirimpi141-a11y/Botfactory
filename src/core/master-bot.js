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
import { handleOwnerCallback, renderOwnerControlCenter } from '../admin/owner-panel.js';
import { composeBroadcastPayload } from '../admin/broadcast.js';
import {
  buildBotLiveActionKeyboard,
  formatBotLiveSuccessCard,
  runAnimatedStages,
  withLoadingMessage,
} from '../utils/animations.js';
import {
  buildConfirmCancelKeyboard,
  buildInlineKeyboard,
  buildMasterMainInlineKeyboard,
  buildMasterMainReplyKeyboard,
  BUTTON_STYLES,
  inlineButton,
} from '../utils/keyboards.js';
import { escapeHtml, isOwnerTelegramId, validateSafeUrl, validateSupportUsername } from '../utils/validation.js';
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
  const isOwner = isOwnerTelegramId(telegramId, env);

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

async function sendMasterHome({ telegram, token, chatId, user, isOwner }) {
  const welcome = [
    '<pre>╔══════════════════════════╗\n🏭 BOT FACTORY\nBuild. Customize. Deploy.\n╚══════════════════════════╝</pre>',
    '',
    `Welcome, <b>${escapeHtml(user.first_name || user.username || 'Builder')}</b>!`,
    'Launch production multi-tenant Telegram bots on Cloudflare Workers with automatic webhook verification and colourful native buttons.',
    '',
    `• <b>Plan:</b> ${String(user.plan || 'free').toUpperCase()}`,
    `• <b>Account ID:</b> <code>${escapeHtml(user.telegram_id)}</code>`,
  ].join('\n');

  await telegram.sendMessage(token, chatId, welcome, {
    reply_markup: buildMasterMainReplyKeyboard(isOwner),
  });
  await telegram.sendMessage(token, chatId, 'Choose a quick action below:', {
    reply_markup: buildMasterMainInlineKeyboard(isOwner),
  });
}

async function handleMasterMessage({ env, repos, telegram, token, msg, user, isOwner }) {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const telegramId = String(user.telegram_id);

  if (text === '/cancel') {
    await repos.users.setWizardState(telegramId, null);
    await telegram.sendMessage(token, chatId, '✖️ Current wizard cancelled.', {
      reply_markup: buildMasterMainReplyKeyboard(isOwner),
    });
    return { ok: true };
  }

  if (text === '/start' || text.startsWith('/start ')) {
    await repos.users.setWizardState(telegramId, null);
    if (text === '/start create') {
      await startCreateBotWizard({ repos, telegram, token, chatId, telegramId });
      return { ok: true };
    }
    await sendMasterHome({ telegram, token, chatId, user, isOwner });
    return { ok: true };
  }

  // Handle active wizard input first
  const wizard = await repos.users.getWizardState(telegramId);
  if (wizard && !text.startsWith('/') && !isMainMenuButton(text)) {
    return handleWizardTextStep({ env, repos, telegram, token, chatId, telegramId, text, wizard, isOwner });
  }

  switch (text) {
    case '🤖 Create New Bot':
      await startCreateBotWizard({ repos, telegram, token, chatId, telegramId });
      return { ok: true };

    case '📂 My Created Bots':
      await showUserBots({ repos, telegram, token, chatId, telegramId });
      return { ok: true };

    case '🎨 Theme Studio':
      await showThemeStudio({ telegram, token, chatId });
      return { ok: true };

    case '🧩 Custom Bot Builder':
      await startCreateBotWizard({ repos, telegram, token, chatId, telegramId, forceCustom: true });
      return { ok: true };

    case '📊 My Statistics':
      await showCreatorStatistics({ repos, telegram, token, chatId, telegramId });
      return { ok: true };

    case '💎 Plans & Features':
      await showPlansAndFeatures({ telegram, token, chatId, user });
      return { ok: true };

    case '📢 Help & Support':
      await telegram.sendMessage(
        token,
        chatId,
        [
          '<b>📢 BOT FACTORY — Help & Support</b>',
          '',
          '1. Tap <b>🤖 Create New Bot</b> and pick a Prebuilt Template or the Custom Bot Builder.',
          '2. Create a bot token from official <b>@BotFather</b> using <code>/newbot</code>.',
          '3. Paste the token securely — BOT FACTORY validates it via Telegram <code>getMe</code>, encrypts it with AES-256-GCM, and never displays it again.',
          '4. Customize branding & theme, preview your menu, and deploy automatically with verified webhooks.',
          '',
          'Commands: <code>/start</code> · <code>/cancel</code>',
        ].join('\n')
      );
      return { ok: true };

    case '👑 Owner Control Center':
    case '/owner':
      if (!isOwner) {
        await telegram.sendMessage(token, chatId, '🔒 Restricted to the BOT FACTORY platform owner.');
        return { ok: true };
      }
      await renderOwnerControlCenter({ env, repos, telegram, token, chatId });
      return { ok: true };

    default:
      await sendMasterHome({ telegram, token, chatId, user, isOwner });
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
    await sendMasterHome({ telegram, token, chatId, user, isOwner });
    return { ok: true };
  }

  if (data === 'mb:create') {
    await startCreateBotWizard({ repos, telegram, token, chatId, telegramId });
    return { ok: true };
  }

  if (data === 'mb:my_bots') {
    await showUserBots({ repos, telegram, token, chatId, telegramId });
    return { ok: true };
  }

  if (data === 'mb:theme_studio') {
    await showThemeStudio({ telegram, token, chatId });
    return { ok: true };
  }

  if (data === 'mb:builder') {
    await startCreateBotWizard({ repos, telegram, token, chatId, telegramId, forceCustom: true });
    return { ok: true };
  }

  if (data === 'mb:stats') {
    await showCreatorStatistics({ repos, telegram, token, chatId, telegramId });
    return { ok: true };
  }

  if (data === 'mb:plans') {
    await showPlansAndFeatures({ telegram, token, chatId, user });
    return { ok: true };
  }

  if (data === 'mb:help') {
    await telegram.sendMessage(
      token,
      chatId,
      'Use <b>🤖 Create New Bot</b> to launch a verified bot in seconds. Send /cancel anytime to exit a wizard.'
    );
    return { ok: true };
  }

  // Wizard Step 2: Prebuilt vs Custom Builder
  if (data === 'wiz:mode:template') {
    const templates = (await repos.templates.listActive()).filter((t) => t.slug !== 'custom-builder');
    const rows = templates.map((t) => [
      inlineButton({
        text: `📦 ${t.name}`,
        callbackData: `wiz:tpl:${t.slug}`,
        style: BUTTON_STYLES.PRIMARY,
      }),
    ]);
    rows.push([inlineButton({ text: '✖️ Cancel', callbackData: 'mb:home', style: BUTTON_STYLES.DANGER })]);

    await repos.users.setWizardState(telegramId, { flow: 'create_bot', step: 'select_template', mode: 'template' });
    await telegram.sendMessage(
      token,
      chatId,
      '<b>Step 3/10 — Select a Prebuilt Template</b>\n\nChoose the modular template for your bot:',
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

async function startCreateBotWizard({ repos, telegram, token, chatId, telegramId, forceCustom = false }) {
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
    '<b>Step 2/10 — Choose Creation Mode</b>\n\nLaunch instantly with a Prebuilt Template or craft a bespoke bot using the Custom No-Code Bot Builder:',
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

  // Step 6 -> Step 7a: Branding (Support username & footer)
  if (wizard.step === 'await_description') {
    await repos.users.setWizardState(telegramId, {
      ...wizard,
      step: 'await_branding',
      description: text.slice(0, 400),
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
      id: 'init',
      label: '⚡ Initializing Bot Factory workspace...',
      doneLabel: 'Workspace initialized',
      run: async () => ({ ready: true }),
    },
    {
      id: 'deploy',
      label: '🔐 Encrypting credentials, persisting D1 & verifying Telegram webhook...',
      doneLabel: 'Credentials encrypted, D1 persisted & Telegram webhook verified',
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
        });
        return deployedResult;
      },
    },
    {
      id: 'finalize',
      label: '🧪 Finalizing live engine routing...',
      doneLabel: 'Live multi-tenant routing active',
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
      [inlineButton({ text: '⬅️ Back to My Bots', callbackData: 'mb:my_bots', style: BUTTON_STYLES.DEFAULT })],
    ]),
  });
}

async function showThemeStudio({ telegram, token, chatId }) {
  const themes = listThemePresets();
  const lines = themes.map((t) => `${t.headerPrefix} <b>${t.name}</b> — ID: <code>${t.id}</code>`).join('\n');
  await telegram.sendMessage(
    token,
    chatId,
    formatBrandedMessage(
      { brandTitle: 'BOT FACTORY Theme Studio', themeId: 'obsidian_neon' },
      {
        heading: '🎨 Available Visual Themes',
        body: `${lines}\n\nThemes apply automatically during Step 7 of bot creation or via the BOT FACTORY web dashboard.`,
      }
    )
  );
}

async function showCreatorStatistics({ repos, telegram, token, chatId, telegramId }) {
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

      return {
        text: [
          '<b>📊 My Creator Statistics</b>',
          '',
          `• <b>Total Created Bots:</b> ${bots.length}`,
          `• <b>Verified Online Bots:</b> ${active}`,
          `• <b>Combined End-Users:</b> ${totalUsers}`,
          `• <b>Combined Webhook Updates:</b> ${totalUpdates}`,
        ].join('\n'),
        replyMarkup: buildInlineKeyboard([
          [inlineButton({ text: '📂 View My Bots', callbackData: 'mb:my_bots', style: BUTTON_STYLES.PRIMARY })],
        ]),
      };
    },
  });
}

async function showPlansAndFeatures({ telegram, token, chatId, user }) {
  await telegram.sendMessage(
    token,
    chatId,
    [
      '<b>💎 BOT FACTORY — Plans & Capabilities</b>',
      `Your Current Plan: <b>${String(user.plan || 'free').toUpperCase()}</b>`,
      '',
      '• <b>FREE:</b> Up to 2 active bots, core templates, colourful buttons, automatic webhook verification.',
      '• <b>STARTER:</b> Up to 10 active bots, SMM Panel & Digital Commerce templates, priority KV caching.',
      '• <b>PRO:</b> Up to 50 active bots, unlimited Custom Builder submenus, advanced analytics.',
      '• <b>ENTERPRISE:</b> Unlimited tenant bots, custom domain worker routing, dedicated support.',
    ].join('\n')
  );
}

function isMainMenuButton(text) {
  return [
    '🤖 Create New Bot',
    '📂 My Created Bots',
    '🎨 Theme Studio',
    '🧩 Custom Bot Builder',
    '📊 My Statistics',
    '💎 Plans & Features',
    '📢 Help & Support',
    '👑 Owner Control Center',
  ].includes(text);
}
