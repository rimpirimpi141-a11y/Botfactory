/**
 * BOT FACTORY Owner Control Center (Telegram Native ReplyKeyboard Interface).
 *
 * Strictly gated by Super Admin (ADMIN_TELEGRAM_ID) and authorized Platform Admins (`platform_admins`).
 * Ordinary platform admins can NEVER remove, demote, or override Super Admin.
 * Uses native colourful ReplyKeyboard at the bottom of Telegram — all 12 Owner Control Center sections.
 */

import { getApplicationAnalytics } from './analytics.js';
import { getCloudflareInfrastructureMetrics } from './cloudflare-monitor.js';
import { processBroadcastBatch, queueBroadcast } from './broadcast.js';
import { ownerDeleteBot, ownerDisableBot, ownerEnableAndRetryWebhook } from './bot-management.js';
import {
  buildApprovalButtons,
  buildConfirmCancelKeyboard,
  buildInlineKeyboard,
  buildMasterMainReplyKeyboard,
  buildOwnerControlReplyKeyboard,
  BUTTON_STYLES,
  inlineButton,
  OWNER_CONTROL_BUTTONS,
} from '../utils/keyboards.js';
import { escapeHtml, isOwnerTelegramId, validateSupportUsername } from '../utils/validation.js';
import { writeSystemLog } from '../utils/logger.js';

export function buildOwnerDashboardKeyboard() {
  return buildOwnerControlReplyKeyboard();
}

export function isOwnerMenuButton(text) {
  return Object.values(OWNER_CONTROL_BUTTONS).includes(text);
}

export async function checkOwnerAuthorization(repos, env, telegramId) {
  if (isOwnerTelegramId(telegramId, env)) {
    return { authorized: true, isSuperAdmin: true, permissions: ['all'] };
  }
  if (repos?.platformAdmins) {
    return repos.platformAdmins.isAuthorized(telegramId);
  }
  return { authorized: false, isSuperAdmin: false, permissions: [] };
}

export async function renderOwnerControlCenter({ env, repos, telegram, token, chatId }) {
  const analytics = await getApplicationAnalytics(repos);
  const ov = analytics.overview;

  const text = [
    '<pre>╔════════════════════════════╗\n👑 OWNER CONTROL CENTER\nBOT FACTORY Platform Admin\n╚════════════════════════════╝</pre>',
    '',
    `👥 <b>Users:</b> ${ov.totalUsers} total · ${ov.activeUsers ?? ov.totalUsers} active`,
    `💎 <b>Plans:</b> FREE ${ov.freeUsers ?? 0} · STARTER ${ov.starterUsers ?? 0} · PRO ${ov.proUsers ?? 0} · ENT ${ov.enterpriseUsers ?? 0}`,
    `🤝 <b>Platform Referrals:</b> ${ov.verifiedReferrals ?? 0} verified · ${ov.pendingReferrals ?? 0} pending`,
    `🤖 <b>Bots:</b> ${ov.totalBots} total · 🟢 ${ov.activeBots} active · ⚪️ ${ov.disabledBots} disabled · 🔴 ${ov.failedDeployments} failed`,
    `📈 <b>New Bots:</b> ${ov.botsCreatedToday ?? 0} today · ${ov.botsCreatedThisMonth ?? 0} this month`,
    `⚡ <b>Webhook Requests:</b> ${ov.requestsToday} today · ${ov.requestsThisMonth} month · Errors: ${ov.workerErrors}`,
    '',
    `<i>Use the 12 Owner Control Center buttons below. Updated ${ov.lastUpdated.slice(0, 19).replace('T', ' ')} UTC.</i>`,
  ].join('\n');

  await telegram.sendMessage(token, chatId, text, { reply_markup: buildOwnerControlReplyKeyboard() });
}

/**
 * Handles all 12 Owner Control Center native ReplyKeyboard buttons & stateful owner prompts.
 * Returns true if the message was handled by the Owner Control Center.
 */
export async function handleOwnerMessage({ env, repos, telegram, token, msg, user, wizard }) {
  const actorId = String(user.telegram_id);
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  const auth = await checkOwnerAuthorization(repos, env, actorId);
  if (!auth.authorized) {
    if (isOwnerMenuButton(text)) {
      await telegram.sendMessage(token, chatId, '🔒 Unauthorized. Owner Control Center access is restricted.');
      return true;
    }
    return false;
  }

  // Exit Owner Control Center back to 9-button Master Bot User Panel
  if (text === OWNER_CONTROL_BUTTONS.EXIT_OWNER) {
    await repos.users.setWizardState(actorId, null);
    await telegram.sendMessage(token, chatId, '⬅️ Exited Owner Control Center.', {
      reply_markup: buildMasterMainReplyKeyboard(true),
    });
    return true;
  }

  // Stateful Owner workflows
  if (wizard?.flow === 'owner_panel' && !text.startsWith('/') && !isOwnerMenuButton(text)) {
    return handleOwnerStatefulInput({ env, repos, telegram, token, chatId, actorId, text, wizard, auth });
  }

  switch (text) {
    case OWNER_CONTROL_BUTTONS.OVERVIEW: {
      await repos.users.setWizardState(actorId, null);
      await renderOwnerControlCenter({ env, repos, telegram, token, chatId });
      return true;
    }

    case OWNER_CONTROL_BUTTONS.MANAGE_USERS: {
      const users = await repos.users.search({ limit: 12 });
      const lines = users
        .map(
          (u) =>
            `• <code>${u.telegram_id}</code> ${u.username ? `@${escapeHtml(u.username)}` : escapeHtml(u.first_name || 'User')} · <b>${String(u.plan || 'free').toUpperCase()}</b> · Refs: ${u.verified_referrals || 0} · Bots: ${u.bot_count || 0} · ${u.status}`
        )
        .join('\n');
      await repos.users.setWizardState(actorId, { flow: 'owner_panel', step: 'manage_user_cmd' });
      await telegram.sendMessage(
        token,
        chatId,
        [
          '<b>👥 Manage Users (Latest 12)</b>',
          lines || '<i>No users registered yet.</i>',
          '',
          '<b>Quick Commands (reply now or tap another section):</b>',
          '• <code>search query</code> — Search by ID or username',
          '• <code>plan TELEGRAM_ID starter|pro|enterprise|free</code>',
          '• <code>slots TELEGRAM_ID +5</code> — Adjust bonus bot slots',
          '• <code>ban TELEGRAM_ID</code> or <code>unban TELEGRAM_ID</code>',
        ].join('\n'),
        { reply_markup: buildOwnerControlReplyKeyboard() }
      );
      return true;
    }

    case OWNER_CONTROL_BUTTONS.ALL_BOTS: {
      const bots = await repos.bots.listAll({ limit: 12 });
      if (!bots.length) {
        await telegram.sendMessage(token, chatId, 'No tenant bots deployed yet.', {
          reply_markup: buildOwnerControlReplyKeyboard(),
        });
        return true;
      }
      const rows = bots.map((b) => [
        inlineButton({
          text: `${b.status === 'active' && b.webhook_status === 'verified' ? '🟢' : '🔴'} @${b.telegram_username} (${b.template_slug || b.mode})`,
          callbackData: `owner:bot:${b.id}`,
          style: b.status === 'active' ? BUTTON_STYLES.SUCCESS : BUTTON_STYLES.DANGER,
        }),
      ]);
      await telegram.sendMessage(
        token,
        chatId,
        `<b>🤖 All Created Bots (${bots.length} shown)</b>\nSelect a bot below to inspect safely (tokens never shown), disable, retry webhook, or delete:`,
        { reply_markup: buildInlineKeyboard(rows) }
      );
      return true;
    }

    case OWNER_CONTROL_BUTTONS.TEMPLATE_MGMT: {
      const templates = await repos.templates.listAllForStudio();
      const lines = templates
        .map(
          (t) =>
            `• <code>${escapeHtml(t.slug)}</code> — <b>${escapeHtml(t.name)}</b> [${String(t.availability_status || 'active').toUpperCase()}] · Bots: ${t.bots_created || 0}`
        )
        .join('\n');
      await repos.users.setWizardState(actorId, { flow: 'owner_panel', step: 'template_cmd' });
      await telegram.sendMessage(
        token,
        chatId,
        [
          '<b>🧩 Template Management (13 Studio Cards)</b>',
          lines,
          '',
          'Reply <code>slug active|disabled|maintenance</code> to update a functional template (Coming Soon stays locked).',
        ].join('\n'),
        { reply_markup: buildOwnerControlReplyKeyboard() }
      );
      return true;
    }

    case OWNER_CONTROL_BUTTONS.BROADCAST_CENTER: {
      await repos.users.setWizardState(actorId, { flow: 'owner_broadcast', step: 'await_message' });
      await telegram.sendMessage(
        token,
        chatId,
        '<b>📢 Broadcast Center</b>\n\nSend the broadcast text message to preview before dispatching to eligible users across active BOT FACTORY bots.\nSend /cancel to abort.',
        { reply_markup: buildOwnerControlReplyKeyboard() }
      );
      return true;
    }

    case OWNER_CONTROL_BUTTONS.FORCE_JOIN: {
      const settings = await repos.stats.getSettings();
      const enabled = settings.map.platform_force_join_enabled === 'true';
      let channels = [];
      try {
        channels = JSON.parse(settings.map.platform_force_join_channels || '[]');
      } catch {
        channels = [];
      }
      await repos.users.setWizardState(actorId, { flow: 'owner_panel', step: 'force_join_cmd' });
      await telegram.sendMessage(
        token,
        chatId,
        [
          '<b>📣 Platform Force Join Settings</b>',
          `• Status: <b>${enabled ? 'ENABLED' : 'DISABLED'}</b>`,
          `• Channels: <b>${channels.length ? escapeHtml(channels.join(', ')) : 'None'}</b>`,
          '',
          'Commands: <code>toggle</code> · <code>add @Channel</code> · <code>remove @Channel</code> · <code>clear</code>',
        ].join('\n'),
        { reply_markup: buildOwnerControlReplyKeyboard() }
      );
      return true;
    }

    case OWNER_CONTROL_BUTTONS.SUPPORT_MGMT: {
      const settings = await repos.stats.getSettings();
      await repos.users.setWizardState(actorId, { flow: 'owner_panel', step: 'support_cmd' });
      await telegram.sendMessage(
        token,
        chatId,
        [
          '<b>🆘 Platform Support Management</b>',
          `• Support Username: <b>${escapeHtml(settings.map.platform_support_username || 'Not configured')}</b>`,
          `• Message: ${escapeHtml(settings.map.platform_support_message || '')}`,
          `• Availability: ${escapeHtml(settings.map.platform_support_availability || '')}`,
          '',
          'Send: <code>@SupportHandle | Welcome message | Availability hours</code>',
        ].join('\n'),
        { reply_markup: buildOwnerControlReplyKeyboard() }
      );
      return true;
    }

    case OWNER_CONTROL_BUTTONS.PLANS_REFERRALS: {
      const refs = await repos.platformReferrals.listAll({ limit: 15 });
      const pending = refs.filter((r) => r.status === 'pending');
      const lines = refs
        .slice(0, 10)
        .map(
          (r) =>
            `• <code>${r.id}</code> — Referrer <code>${r.referrer_telegram_id}</code> -> User <code>${r.referred_telegram_id}</code> [<b>${r.status.toUpperCase()}</b>]`
        )
        .join('\n');
      await telegram.sendMessage(
        token,
        chatId,
        [
          '<b>💎 Plans & Referral Control</b>',
          'Milestones: FREE (2 base +1/ref) · 8 refs -> STARTER (10) · 48 refs -> PRO (50) · 50 refs -> ENTERPRISE (Unlimited)',
          '',
          `<b>Recent Referrals (${refs.length} shown, ${pending.length} pending):</b>`,
          lines || '<i>No platform referrals recorded yet.</i>',
        ].join('\n'),
        { reply_markup: buildOwnerControlReplyKeyboard() }
      );
      for (const p of pending.slice(0, 5)) {
        await telegram.sendMessage(
          token,
          chatId,
          `⏳ Pending Referral <code>${p.id}</code>\nReferrer: <code>${p.referrer_telegram_id}</code> -> Referred: <code>${p.referred_telegram_id}</code>`,
          {
            reply_markup: buildApprovalButtons(
              `owner:ref:verify:${p.id}`,
              `owner:ref:reject:${p.id}`,
              '✅ Verify Referral',
              '❌ Reject Referral'
            ),
          }
        );
      }
      return true;
    }

    case OWNER_CONTROL_BUTTONS.ADMIN_MGMT: {
      const admins = await repos.platformAdmins.list();
      const lines = admins
        .map((a) => `• <code>${a.telegram_id}</code> (${escapeHtml(a.role)}) — Perms: ${escapeHtml((a.permissions || []).join(', '))}`)
        .join('\n');
      await repos.users.setWizardState(actorId, { flow: 'owner_panel', step: 'admin_mgmt_cmd' });
      await telegram.sendMessage(
        token,
        chatId,
        [
          '<b>👮 Platform Admin Management</b>',
          `• Super Admin (Immutable): <code>${escapeHtml(String(env.ADMIN_TELEGRAM_ID || 'Not set'))}</code>`,
          '',
          '<b>Authorized Platform Admins:</b>',
          lines || '<i>None added yet.</i>',
          '',
          auth.isSuperAdmin
            ? 'Commands: <code>add TELEGRAM_ID</code> or <code>remove TELEGRAM_ID</code>'
            : '<i>Only Super Admin can add or remove platform admins.</i>',
        ].join('\n'),
        { reply_markup: buildOwnerControlReplyKeyboard() }
      );
      return true;
    }

    case OWNER_CONTROL_BUTTONS.CF_MONITOR: {
      await sendCloudflareMonitorMessage({ env, repos, telegram, token, chatId });
      return true;
    }

    case OWNER_CONTROL_BUTTONS.ACTIVITY_LOGS: {
      const logs = await repos.stats.getRecentLogs({ limit: 12 });
      const lines = logs
        .map((l) => `• [${l.level.toUpperCase()}] <b>${escapeHtml(l.source)}</b>: ${escapeHtml(l.message.slice(0, 110))}`)
        .join('\n');
      await telegram.sendMessage(
        token,
        chatId,
        `<b>📋 Recent Activity & Audit Logs</b>\n\n${lines || '<i>No logs recorded yet.</i>'}`,
        { reply_markup: buildOwnerControlReplyKeyboard() }
      );
      return true;
    }

    case OWNER_CONTROL_BUTTONS.PLATFORM_SETTINGS: {
      const settings = await repos.stats.getSettings();
      const lines = [
        `• Promo Footer: <b>${settings.map.promo_footer_enabled}</b>`,
        `• Maintenance Mode: <b>${settings.map.maintenance_mode}</b>`,
        `• Broadcast Emergency Pause: <b>${settings.map.emergency_pause_broadcasts}</b>`,
        `• Broadcast Batch Size: <b>${settings.map.broadcast_batch_size}</b>`,
      ].join('\n');
      await telegram.sendMessage(token, chatId, `<b>⚙️ Platform Settings</b>\n\n${lines}`, {
        reply_markup: buildInlineKeyboard([
          [
            inlineButton({
              text: settings.map.maintenance_mode === 'true' ? '✅ Disable Maintenance' : '🚧 Enable Maintenance',
              callbackData: 'owner:toggle_maint',
              style: BUTTON_STYLES.DANGER,
            }),
            inlineButton({
              text: settings.map.emergency_pause_broadcasts === 'true' ? '▶️ Resume Broadcasts' : '🛑 Pause Broadcasts',
              callbackData: 'owner:toggle_brc_pause',
              style: BUTTON_STYLES.PRIMARY,
            }),
          ],
          [
            inlineButton({
              text: settings.map.promo_footer_enabled === 'true' ? '🔕 Disable Promo Footer' : '🔔 Enable Promo Footer',
              callbackData: 'owner:toggle_promo',
              style: BUTTON_STYLES.SUCCESS,
            }),
          ],
        ]),
      });
      return true;
    }

    default:
      return false;
  }
}

async function handleOwnerStatefulInput({ env, repos, telegram, token, chatId, actorId, text, wizard, auth }) {
  const kb = buildOwnerControlReplyKeyboard();

  if (wizard.step === 'manage_user_cmd') {
    const parts = text.split(/\s+/);
    const cmd = (parts[0] || '').toLowerCase();
    if (cmd === 'search') {
      const q = parts.slice(1).join(' ');
      const found = await repos.users.search({ query: q, limit: 10 });
      const lines = found
        .map(
          (u) =>
            `• <code>${u.telegram_id}</code> ${u.username ? `@${escapeHtml(u.username)}` : ''} · <b>${String(u.plan).toUpperCase()}</b> · Refs: ${u.verified_referrals || 0} · Bonus Slots: ${u.bonus_bot_slots || 0} · ${u.status}`
        )
        .join('\n');
      await telegram.sendMessage(token, chatId, `<b>🔍 User Search ("${escapeHtml(q)}")</b>\n${lines || '<i>No matches.</i>'}`, { reply_markup: kb });
      return true;
    }
    if (cmd === 'plan' && parts[1] && ['free', 'starter', 'pro', 'enterprise'].includes((parts[2] || '').toLowerCase())) {
      const tid = parts[1].replace(/[^0-9]/g, '');
      const plan = parts[2].toLowerCase();
      await repos.users.updatePlanAndStatus(tid, { plan });
      await writeSystemLog(env, { level: 'audit', source: 'owner-panel', message: `Changed user ${tid} plan to ${plan}`, actorTelegramId: actorId });
      await telegram.sendMessage(token, chatId, `✅ User <code>${tid}</code> plan updated to <b>${plan.toUpperCase()}</b>.`, { reply_markup: kb });
      return true;
    }
    if (cmd === 'slots' && parts[1] && parts[2] !== undefined) {
      const tid = parts[1].replace(/[^0-9]/g, '');
      const bonus = Number(parts[2]);
      if (!Number.isFinite(bonus)) {
        await telegram.sendMessage(token, chatId, '❌ Invalid slot number. Example: <code>slots 123456 5</code>', { reply_markup: kb });
        return true;
      }
      await repos.users.adjustBotSlots(tid, bonus);
      await writeSystemLog(env, { level: 'audit', source: 'owner-panel', message: `Adjusted user ${tid} bonus_bot_slots to ${bonus}`, actorTelegramId: actorId });
      await telegram.sendMessage(token, chatId, `✅ User <code>${tid}</code> bonus bot slots set to <b>${bonus}</b> (audit logged).`, { reply_markup: kb });
      return true;
    }
    if ((cmd === 'ban' || cmd === 'unban') && parts[1]) {
      const tid = parts[1].replace(/[^0-9]/g, '');
      if (isOwnerTelegramId(tid, env)) {
        await telegram.sendMessage(token, chatId, '🚫 Super Admin cannot be banned.', { reply_markup: kb });
        return true;
      }
      await repos.users.updatePlanAndStatus(tid, { status: cmd === 'ban' ? 'suspended' : 'active' });
      await writeSystemLog(env, { level: 'audit', source: 'owner-panel', message: `${cmd} user ${tid}`, actorTelegramId: actorId });
      await telegram.sendMessage(token, chatId, `✅ User <code>${tid}</code> is now <b>${cmd === 'ban' ? 'SUSPENDED' : 'ACTIVE'}</b>.`, { reply_markup: kb });
      return true;
    }
    await telegram.sendMessage(token, chatId, '❌ Unrecognized command. Use <code>search</code>, <code>plan</code>, <code>slots</code>, <code>ban</code>, or <code>unban</code>.', { reply_markup: kb });
    return true;
  }

  if (wizard.step === 'template_cmd') {
    const [slug, statusRaw] = text.split(/\s+/);
    const status = (statusRaw || '').toLowerCase();
    if (!slug || !['active', 'disabled', 'maintenance'].includes(status)) {
      await telegram.sendMessage(token, chatId, '❌ Format: <code>template-slug active|disabled|maintenance</code>', { reply_markup: kb });
      return true;
    }
    try {
      const updated = await repos.templates.updateTemplateAdmin(slug, { availabilityStatus: status });
      await writeSystemLog(env, { level: 'audit', source: 'owner-panel', message: `Set template ${updated.slug} status to ${status}`, actorTelegramId: actorId });
      await telegram.sendMessage(token, chatId, `✅ Template <b>${escapeHtml(updated.name)}</b> updated to <b>${status.toUpperCase()}</b>.`, { reply_markup: kb });
    } catch (err) {
      await telegram.sendMessage(token, chatId, `❌ ${escapeHtml(err.message)}`, { reply_markup: kb });
    }
    return true;
  }

  if (wizard.step === 'force_join_cmd') {
    const settings = await repos.stats.getSettings();
    let channels = [];
    try {
      channels = JSON.parse(settings.map.platform_force_join_channels || '[]');
    } catch {
      channels = [];
    }
    const lower = text.toLowerCase();
    if (lower === 'toggle') {
      const next = settings.map.platform_force_join_enabled === 'true' ? 'false' : 'true';
      await repos.stats.setSetting('platform_force_join_enabled', next, actorId);
      await telegram.sendMessage(token, chatId, `✅ Platform Force Join is now <b>${next === 'true' ? 'ENABLED' : 'DISABLED'}</b>.`, { reply_markup: kb });
      return true;
    }
    if (lower === 'clear') {
      await repos.stats.setSetting('platform_force_join_channels', '[]', actorId);
      await telegram.sendMessage(token, chatId, '✅ Platform Force Join channels cleared.', { reply_markup: kb });
      return true;
    }
    if (lower.startsWith('remove ')) {
      const ch = text.slice(7).trim();
      channels = channels.filter((c) => c.toLowerCase() !== ch.toLowerCase());
      await repos.stats.setSetting('platform_force_join_channels', JSON.stringify(channels), actorId);
      await telegram.sendMessage(token, chatId, `✅ Removed ${escapeHtml(ch)}. Remaining: ${escapeHtml(channels.join(', ') || 'None')}`, { reply_markup: kb });
      return true;
    }
    if (lower.startsWith('add ')) {
      const raw = text.slice(4).trim();
      const ch = raw.startsWith('@') || /^-100\d+$/.test(raw) ? raw : `@${raw.replace(/^@/, '')}`;
      let checkMsg = '';
      try {
        const me = await telegram.getMe(token);
        const member = await telegram.getChatMember(token, ch, me.result.id);
        checkMsg = ['administrator', 'creator'].includes(member?.result?.status)
          ? '\n✅ Master Bot admin access verified via Telegram getChatMember.'
          : `\n⚠️ Master Bot status in ${escapeHtml(ch)} is "${escapeHtml(member?.result?.status || 'unknown')}". Promote it to Admin!`;
      } catch (err) {
        checkMsg = `\n⚠️ Verification warning: ${escapeHtml(err.message || 'channel unreachable')}`;
      }
      if (!channels.includes(ch)) channels.push(ch);
      await repos.stats.setSetting('platform_force_join_channels', JSON.stringify(channels), actorId);
      await telegram.sendMessage(token, chatId, `✅ Added <b>${escapeHtml(ch)}</b> to platform Force Join.${checkMsg}`, { reply_markup: kb });
      return true;
    }
    await telegram.sendMessage(token, chatId, '❌ Use <code>toggle</code>, <code>add @Channel</code>, <code>remove @Channel</code>, or <code>clear</code>.', { reply_markup: kb });
    return true;
  }

  if (wizard.step === 'support_cmd') {
    const [handleRaw, message, availability] = text.split('|').map((s) => (s || '').trim());
    const check = validateSupportUsername(handleRaw || '');
    if (!check.valid) {
      await telegram.sendMessage(token, chatId, `❌ ${escapeHtml(check.error)}`, { reply_markup: kb });
      return true;
    }
    await repos.stats.setSetting('platform_support_username', check.username, actorId);
    if (message) await repos.stats.setSetting('platform_support_message', message, actorId);
    if (availability) await repos.stats.setSetting('platform_support_availability', availability, actorId);
    await telegram.sendMessage(token, chatId, `✅ Platform Support updated: <b>${escapeHtml(check.username || 'Cleared')}</b>.`, { reply_markup: kb });
    return true;
  }

  if (wizard.step === 'admin_mgmt_cmd') {
    if (!auth.isSuperAdmin) {
      await telegram.sendMessage(token, chatId, '🔒 Only the Super Admin can modify Platform Admins.', { reply_markup: kb });
      return true;
    }
    const [cmd, rawId] = text.split(/\s+/);
    const targetId = String(rawId || '').replace(/[^0-9]/g, '');
    if (!['add', 'remove'].includes((cmd || '').toLowerCase()) || !targetId) {
      await telegram.sendMessage(token, chatId, '❌ Format: <code>add TELEGRAM_ID</code> or <code>remove TELEGRAM_ID</code>', { reply_markup: kb });
      return true;
    }
    try {
      if (cmd.toLowerCase() === 'add') {
        await repos.platformAdmins.upsert({ telegramId: targetId, addedBy: actorId });
        await writeSystemLog(env, { level: 'audit', source: 'owner-panel', message: `Added platform admin ${targetId}`, actorTelegramId: actorId });
        await telegram.sendMessage(token, chatId, `✅ Added <code>${targetId}</code> as Platform Admin.`, { reply_markup: kb });
      } else {
        await repos.platformAdmins.remove(targetId, actorId);
        await writeSystemLog(env, { level: 'audit', source: 'owner-panel', message: `Removed platform admin ${targetId}`, actorTelegramId: actorId });
        await telegram.sendMessage(token, chatId, `✅ Removed Platform Admin <code>${targetId}</code>.`, { reply_markup: kb });
      }
    } catch (err) {
      await telegram.sendMessage(token, chatId, `❌ ${escapeHtml(err.message)}`, { reply_markup: kb });
    }
    return true;
  }

  return false;
}

async function sendCloudflareMonitorMessage({ env, repos, telegram, token, chatId }) {
  const cf = await getCloudflareInfrastructureMetrics(env, repos);
  const app = cf.applicationHealth;
  const acct = cf.accountMetrics;
  const text = [
    '<b>☁️ Cloudflare Infrastructure Monitor</b>',
    `<i>Checked: ${cf.lastUpdated.slice(0, 19).replace('T', ' ')} UTC</i>`,
    '',
    `<b>Layer 1 — Application Health (${app.status.toUpperCase()})</b>`,
    `• Worker: <b>${app.worker.healthy ? 'Healthy' : 'Issue'}</b> (${escapeHtml(app.worker.scriptName)})`,
    `• D1 Database: <b>${app.d1.healthy ? 'Connected' : 'Error'}</b> (${app.d1.tableCount} tables · ${app.d1.latencyMs ?? 'N/A'} ms)`,
    `• KV Cache: <b>${app.kv.healthy ? 'Connected' : app.kv.bound ? 'Issue' : 'Not Bound'}</b> (${app.kv.latencyMs ?? 'N/A'} ms)`,
    `• Analytics Engine: <b>${app.analyticsEngine.bound ? 'Bound' : 'Not Bound'}</b>`,
    `• Master Webhook: <b>${escapeHtml(app.masterWebhook.status.toUpperCase())}</b>`,
    `• Tenant Bots: <b>${app.tenantWebhooks.verifiedActive}</b> verified / <b>${app.tenantWebhooks.failedDeployments}</b> failed / <b>${app.tenantWebhooks.disabledBots}</b> disabled`,
    '',
    '<b>Layer 2 — Cloudflare Account Metrics</b>',
    acct.configured
      ? `• Workers Monthly Reqs: <b>${acct.workers.data?.monthlyRequests ?? 'N/A'}</b> · D1 Queries: <b>${acct.d1.data?.totalQueries ?? 'N/A'}</b> · KV Reads: <b>${acct.kv.data?.reads ?? 'N/A'}</b>`
      : `• <i>${escapeHtml(acct.message)}</i>`,
  ].join('\n');

  await telegram.sendMessage(token, chatId, text, { reply_markup: buildOwnerControlReplyKeyboard() });
}

export async function handleOwnerCallback({ env, repos, telegram, token, cb }) {
  const actorId = String(cb.from?.id || '');
  const chatId = cb.message?.chat?.id;
  const data = cb.data || '';

  const auth = await checkOwnerAuthorization(repos, env, actorId);
  if (!auth.authorized) {
    await telegram.answerCallbackQuery(token, cb.id, { text: '🔒 Owner Admin access required.', showAlert: true }).catch(() => {});
    return true;
  }

  await telegram.answerCallbackQuery(token, cb.id).catch(() => {});

  if (data === 'owner:home' || data === 'owner:analytics') {
    await renderOwnerControlCenter({ env, repos, telegram, token, chatId });
    return true;
  }

  if (data.startsWith('owner:ref:verify:') || data.startsWith('owner:ref:reject:')) {
    const isVerify = data.startsWith('owner:ref:verify:');
    const refId = data.split(':')[3];
    const updated = await repos.platformReferrals.updateStatus(refId, {
      status: isVerify ? 'verified' : 'rejected',
      reviewedBy: actorId,
    });
    await telegram.sendMessage(
      token,
      chatId,
      `${isVerify ? '✅ Verified' : '❌ Rejected'} referral <code>${refId}</code> (Referrer: <code>${updated.referrer_telegram_id}</code>).`,
      { reply_markup: buildOwnerControlReplyKeyboard() }
    );
    return true;
  }

  if (data.startsWith('owner:bot:')) {
    const botId = data.slice('owner:bot:'.length);
    const bot = await repos.bots.getById(botId);
    if (!bot) {
      await telegram.sendMessage(token, chatId, 'Bot not found.');
      return true;
    }
    const text = [
      `<b>🤖 Bot Inspector — @${escapeHtml(bot.telegram_username)}</b>`,
      `• <b>ID:</b> <code>${bot.id}</code>`,
      `• <b>Owner:</b> <code>${bot.owner_telegram_id}</code>`,
      `• <b>Template:</b> ${escapeHtml(bot.template_name || bot.template_id)}`,
      `• <b>Status:</b> ${bot.status.toUpperCase()} · Webhook: ${bot.webhook_status.toUpperCase()}`,
      `• <b>Users / Updates:</b> ${bot.total_users} / ${bot.total_updates}`,
      bot.webhook_last_error ? `• <b>Last Error:</b> ${escapeHtml(bot.webhook_last_error)}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    await telegram.sendMessage(token, chatId, text, {
      reply_markup: buildInlineKeyboard([
        [
          inlineButton({ text: '🔄 Retry Webhook', callbackData: `owner:bot_retry:${bot.id}`, style: BUTTON_STYLES.SUCCESS }),
          inlineButton({
            text: bot.status === 'active' ? '⏸ Disable Bot' : '▶️ Enable Bot',
            callbackData: bot.status === 'active' ? `owner:bot_disable:${bot.id}` : `owner:bot_retry:${bot.id}`,
            style: BUTTON_STYLES.PRIMARY,
          }),
        ],
        [inlineButton({ text: '🗑 Delete Bot', callbackData: `owner:bot_del_ask:${bot.id}`, style: BUTTON_STYLES.DANGER })],
      ]),
    });
    return true;
  }

  if (data.startsWith('owner:bot_disable:')) {
    const botId = data.slice('owner:bot_disable:'.length);
    await ownerDisableBot({ env, repos, telegram, botId, actorTelegramId: actorId });
    await telegram.sendMessage(token, chatId, `⏸ Bot <code>${botId}</code> disabled and webhook removed.`, {
      reply_markup: buildOwnerControlReplyKeyboard(),
    });
    return true;
  }

  if (data.startsWith('owner:bot_retry:')) {
    const botId = data.slice('owner:bot_retry:'.length);
    try {
      const res = await ownerEnableAndRetryWebhook({ env, repos, telegram, botId, actorTelegramId: actorId });
      await telegram.sendMessage(
        token,
        chatId,
        `✅ Bot <code>${botId}</code> re-enabled and webhook verified:\n<code>${escapeHtml(res.verification.webhookUrl)}</code>`,
        { reply_markup: buildOwnerControlReplyKeyboard() }
      );
    } catch (err) {
      await telegram.sendMessage(token, chatId, `❌ Webhook verification failed: ${escapeHtml(err.message)}`, {
        reply_markup: buildOwnerControlReplyKeyboard(),
      });
    }
    return true;
  }

  if (data.startsWith('owner:bot_del_ask:')) {
    const botId = data.slice('owner:bot_del_ask:'.length);
    await telegram.sendMessage(
      token,
      chatId,
      `⚠️ Confirm permanent deletion of bot <code>${botId}</code>?`,
      { reply_markup: buildConfirmCancelKeyboard(`owner:bot_del_ok:${botId}`, `owner:bot:${botId}`, '🗑 Confirm Delete', 'Cancel') }
    );
    return true;
  }

  if (data.startsWith('owner:bot_del_ok:')) {
    const botId = data.slice('owner:bot_del_ok:'.length);
    await ownerDeleteBot({ env, repos, telegram, botId, actorTelegramId: actorId });
    await telegram.sendMessage(token, chatId, `🗑 Bot <code>${botId}</code> deleted.`, {
      reply_markup: buildOwnerControlReplyKeyboard(),
    });
    return true;
  }

  if (data.startsWith('owner:brc_launch:')) {
    const broadcastId = data.slice('owner:brc_launch:'.length);
    const queued = await queueBroadcast({ env, repos, broadcastId, actorTelegramId: actorId });
    const firstBatch = await processBroadcastBatch({ env, repos, telegram, broadcastId });
    await telegram.sendMessage(
      token,
      chatId,
      `🚀 <b>Broadcast Dispatched</b>\nID: <code>${broadcastId}</code>\nTotal Recipients Queued: <b>${queued.totalRecipients}</b>\nFirst Batch Sent: <b>${firstBatch.sent}</b> · Failed: <b>${firstBatch.failed}</b>`,
      { reply_markup: buildOwnerControlReplyKeyboard() }
    );
    return true;
  }

  if (data === 'owner:toggle_maint') {
    const cur = (await repos.stats.getSettings()).map.maintenance_mode === 'true';
    await repos.stats.setSetting('maintenance_mode', String(!cur), actorId);
    await telegram.sendMessage(token, chatId, `🚧 Maintenance mode is now <b>${!cur ? 'ENABLED' : 'DISABLED'}</b>.`, {
      reply_markup: buildOwnerControlReplyKeyboard(),
    });
    return true;
  }

  if (data === 'owner:toggle_brc_pause') {
    const cur = (await repos.stats.getSettings()).map.emergency_pause_broadcasts === 'true';
    await repos.stats.setSetting('emergency_pause_broadcasts', String(!cur), actorId);
    await telegram.sendMessage(token, chatId, `🛑 Global Broadcast Emergency Pause is now <b>${!cur ? 'ACTIVE' : 'CLEARED'}</b>.`, {
      reply_markup: buildOwnerControlReplyKeyboard(),
    });
    return true;
  }

  if (data === 'owner:toggle_promo') {
    const cur = (await repos.stats.getSettings()).map.promo_footer_enabled === 'true';
    await repos.stats.setSetting('promo_footer_enabled', String(!cur), actorId);
    await telegram.sendMessage(token, chatId, `🔔 Promotional Broadcast Footer is now <b>${!cur ? 'ENABLED' : 'DISABLED'}</b>.`, {
      reply_markup: buildOwnerControlReplyKeyboard(),
    });
    return true;
  }

  return false;
}
