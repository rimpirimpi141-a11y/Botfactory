/**
 * TEMPLATE: TASK BOT
 *
 * STRICT SECURITY RULE:
 * - Users NEVER receive automatic balance credit upon uploading a screenshot proof.
 * - Every task submission enters `status = 'pending'` in D1 (`task_submissions`).
 * - Reward balance is credited ONLY when an authorized bot admin explicitly approves
 *   the submission (`WHERE id = ? AND bot_id = ? AND status = 'pending'`), preventing double rewards.
 * - Includes Balance tracking, Withdrawal Requests, and Template-Specific ReplyKeyboard Admin Panel.
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
  handleCommonTenantAdmin,
} from '../shared/tenant-admin.js';

export const TASK_BOT_META = {
  id: 'tpl_task_bot',
  slug: 'task-bot',
  name: 'Task Bot',
  category: 'Tasks & Micro-Rewards',
};

const ADMIN_EXTRA_BUTTONS = [
  { text: '➕ Create Task', style: BUTTON_STYLES.SUCCESS },
  { text: '🖼 Pending Task Proofs', style: BUTTON_STYLES.DANGER },
  { text: '💸 Pending Withdrawals', style: BUTTON_STYLES.PRIMARY },
  { text: '📝 Manage Tasks', style: BUTTON_STYLES.PRIMARY },
];

function buildUserKeyboard(isAdmin = false) {
  const rows = [
    [
      { text: '📝 Available Tasks', style: BUTTON_STYLES.SUCCESS },
      { text: '📋 My Submissions', style: BUTTON_STYLES.PRIMARY },
    ],
    [
      { text: '💰 Balance', style: BUTTON_STYLES.PRIMARY },
      { text: '💸 Withdraw', style: BUTTON_STYLES.SUCCESS },
    ],
    [{ text: '🎧 Support', style: BUTTON_STYLES.PRIMARY }],
  ];
  if (isAdmin) {
    rows.push([{ text: ADMIN_COMMON_LABELS.OPEN_ADMIN, style: BUTTON_STYLES.DANGER }]);
  }
  return buildReplyKeyboard(rows, { resize: true, persistent: true });
}

export async function handleTaskBotUpdate(ctx) {
  const { bot, config, token, telegram, repos, update, endUser, isAdmin } = ctx;
  const userKb = buildUserKeyboard(isAdmin);
  const adminKb = buildTenantAdminReplyKeyboard(ADMIN_EXTRA_BUTTONS);
  const currency = config.templateSettings?.currencyLabel || 'INR';
  const minWithdraw = Number(config.templateSettings?.minWithdrawalPoints || 100);

  if (update.callback_query) {
    return handleCallback(ctx, adminKb, currency);
  }

  const msg = update.message;
  if (!msg) return;
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const state = safeParse(endUser.state_json);

  const handledAdmin = await handleCommonTenantAdmin(ctx, {
    panelTitle: 'Task Bot Admin Panel',
    extraButtons: ADMIN_EXTRA_BUTTONS,
    userKeyboard: userKb,
    extraStatsSummary: async () => {
      const [tRes, sRes] = await Promise.all([
        repos.db.first(`SELECT COUNT(*) AS cnt FROM tasks WHERE bot_id = ? AND is_active = 1`, [bot.id]),
        repos.db.first(`SELECT COUNT(*) AS cnt FROM task_submissions WHERE bot_id = ? AND status = 'pending'`, [bot.id]),
      ]);
      return `• Active Tasks: <b>${Number(tRes.row?.cnt || 0)}</b>\n• Pending Screenshot Proofs: <b>${Number(sRes.row?.cnt || 0)}</b>`;
    },
  });
  if (handledAdmin) return;

  if (text === '/start') {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
    await telegram.sendMessage(
      token,
      chatId,
      formatBrandedMessage(config, {
        heading: '📝 Micro-Task & Rewards Desk',
        body: `${config.welcomeMessage || 'Complete available tasks, upload screenshot proof, and earn rewards after admin verification.'}\n\n💰 Current Balance: <b>${Number(endUser.points_balance || 0)} ${escapeHtml(currency)}</b>`,
      }),
      { reply_markup: userKb }
    );
    return;
  }

  // Handle user uploading screenshot proof for a task (NEVER auto-credits!)
  if (state?.step === 'submit_task_proof' && (msg.photo || (text && !text.startsWith('/')))) {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
    const { row: task } = await repos.db.first(
      `SELECT * FROM tasks WHERE id = ? AND bot_id = ? AND is_active = 1`,
      [state.taskId, bot.id]
    );
    if (!task) {
      await telegram.sendMessage(token, chatId, '❌ Task is no longer active.', { reply_markup: userKb });
      return;
    }

    const screenshotFileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : null;
    const proofText = screenshotFileId ? (msg.caption || 'Screenshot proof uploaded').trim() : text;
    const subId = newId('tsub');

    await repos.db.run(
      `INSERT INTO task_submissions (id, bot_id, task_id, user_telegram_id, screenshot_file_id, proof_text, reward_amount, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [subId, bot.id, task.id, endUser.telegram_id, screenshotFileId, proofText.slice(0, 500), task.reward_amount]
    );
    await repos.db.run(`UPDATE tasks SET submission_count = submission_count + 1 WHERE id = ?`, [task.id]);

    await telegram.sendMessage(
      token,
      chatId,
      `⏳ <b>Task Proof Submitted (Pending Verification)</b>\nSubmission ID: <code>${subId}</code>\nTask: <b>${escapeHtml(task.title)}</b>\nPotential Reward: <b>${task.reward_amount} ${escapeHtml(currency)}</b>\n\n<i>Rewards are credited strictly after an admin reviews and approves your proof.</i>`,
      { reply_markup: userKb }
    );

    await telegram
      .sendMessage(
        token,
        bot.owner_telegram_id,
        `🖼 <b>New Task Proof Pending Review</b>\nID: <code>${subId}</code>\nUser: <code>${endUser.telegram_id}</code>\nTask: <b>${escapeHtml(task.title)}</b>\nReward: <b>${task.reward_amount} ${escapeHtml(currency)}</b>\nProof: ${escapeHtml(proofText.slice(0, 250))}`,
        {
          reply_markup: buildApprovalButtons(
            `tsk:sub:approve:${subId}`,
            `tsk:sub:reject:${subId}`,
            '✅ Approve & Credit',
            '❌ Reject Proof'
          ),
        }
      )
      .catch(() => {});
    return;
  }

  // Handle user withdrawal request
  if (state?.step === 'withdraw_input' && !text.startsWith('/')) {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
    const [amountStr, ...destParts] = text.split('|');
    const amount = Number((amountStr || '').trim());
    const destination = destParts.join('|').trim();
    if (!Number.isFinite(amount) || amount < minWithdraw || !destination) {
      await telegram.sendMessage(
        token,
        chatId,
        `❌ Format: <code>Amount | UPI or Payout Details</code> (Minimum: <b>${minWithdraw} ${escapeHtml(currency)}</b>).`,
        { reply_markup: userKb }
      );
      return;
    }
    if (Number(endUser.points_balance || 0) < amount) {
      await telegram.sendMessage(token, chatId, '❌ Insufficient verified balance.', { reply_markup: userKb });
      return;
    }
    const wdId = newId('wd');
    await repos.endUsers.adjustPoints(bot.id, endUser.telegram_id, {
      delta: -amount,
      txType: 'withdrawal_debit',
      referenceId: wdId,
      description: `Task withdrawal request (${destination})`,
    });
    await repos.db.run(
      `INSERT INTO withdrawal_requests (id, bot_id, user_telegram_id, amount, payout_method, payout_details, status)
       VALUES (?, ?, ?, ?, 'manual', ?, 'pending')`,
      [wdId, bot.id, endUser.telegram_id, amount, destination]
    );
    await telegram.sendMessage(
      token,
      chatId,
      `⏳ <b>Withdrawal Requested</b>\nID: <code>${wdId}</code>\nAmount: <b>${amount} ${escapeHtml(currency)}</b>\nDestination: <code>${escapeHtml(destination)}</code>`,
      { reply_markup: userKb }
    );
    return;
  }

  // Admin: create new task
  if (isAdmin && state?.step === 'adm_create_task' && !text.startsWith('/')) {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, null);
    const [title, rewardStr, instructions] = text.split('|').map((s) => (s || '').trim());
    const reward = Number(rewardStr);
    if (!title || !Number.isFinite(reward) || reward <= 0) {
      await telegram.sendMessage(
        token,
        chatId,
        '❌ Format: <code>Task Title | Reward Amount | Instructions for proof</code>',
        { reply_markup: adminKb }
      );
      return;
    }
    const taskId = newId('tsk');
    await repos.db.run(
      `INSERT INTO tasks (id, bot_id, title, description, instructions, reward_amount, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [taskId, bot.id, title, instructions || '', instructions || 'Upload screenshot proof.', reward, endUser.telegram_id]
    );
    await telegram.sendMessage(
      token,
      chatId,
      `✅ Task <b>${escapeHtml(title)}</b> created (Reward: <b>${reward} ${escapeHtml(currency)}</b>, ID: <code>${taskId}</code>).`,
      { reply_markup: adminKb }
    );
    return;
  }

  // Template-specific Admin ReplyKeyboard actions
  if (isAdmin && text === '➕ Create Task') {
    await repos.endUsers.setState(bot.id, endUser.telegram_id, { scope: 'tenant_admin', step: 'adm_create_task' });
    await telegram.sendMessage(
      token,
      chatId,
      'Send new task details:\n<code>Task Title | Reward Amount | Step-by-step Instructions</code>',
      { reply_markup: buildCancelReplyKeyboard() }
    );
    return;
  }

  if (isAdmin && text === '📝 Manage Tasks') {
    const { rows } = await repos.db.all(
      `SELECT * FROM tasks WHERE bot_id = ? ORDER BY created_at DESC LIMIT 15`,
      [bot.id]
    );
    const body = rows.length
      ? rows.map((t) => `• <code>${t.id}</code> — <b>${escapeHtml(t.title)}</b> (${t.reward_amount} ${escapeHtml(currency)}) · ${t.is_active ? '✅ Active' : '⛔ Off'}`).join('\n')
      : '<i>No tasks created yet.</i>';
    await telegram.sendMessage(token, chatId, formatBrandedMessage(config, { heading: '📝 Task List', body }), {
      reply_markup: adminKb,
    });
    return;
  }

  if (isAdmin && text === '🖼 Pending Task Proofs') {
    const { rows } = await repos.db.all(
      `SELECT s.*, t.title AS task_title FROM task_submissions s JOIN tasks t ON s.task_id = t.id
       WHERE s.bot_id = ? AND s.status = 'pending' ORDER BY s.created_at ASC LIMIT 10`,
      [bot.id]
    );
    if (!rows.length) {
      await telegram.sendMessage(token, chatId, '✅ No pending task proofs.', { reply_markup: adminKb });
      return;
    }
    for (const s of rows) {
      await telegram.sendMessage(
        token,
        chatId,
        `🖼 <b>Submission</b> <code>${s.id}</code>\nTask: <b>${escapeHtml(s.task_title)}</b>\nUser: <code>${s.user_telegram_id}</code>\nReward: <b>${s.reward_amount} ${escapeHtml(currency)}</b>\nProof: ${escapeHtml(s.proof_text || 'Screenshot')}`,
        {
          reply_markup: buildApprovalButtons(
            `tsk:sub:approve:${s.id}`,
            `tsk:sub:reject:${s.id}`,
            '✅ Approve & Credit',
            '❌ Reject'
          ),
        }
      );
    }
    return;
  }

  if (isAdmin && text === '💸 Pending Withdrawals') {
    const { rows } = await repos.db.all(
      `SELECT * FROM withdrawal_requests WHERE bot_id = ? AND status = 'pending' ORDER BY created_at ASC LIMIT 10`,
      [bot.id]
    );
    if (!rows.length) {
      await telegram.sendMessage(token, chatId, '✅ No pending withdrawals.', { reply_markup: adminKb });
      return;
    }
    for (const w of rows) {
      await telegram.sendMessage(
        token,
        chatId,
        `💸 <b>Withdrawal</b> <code>${w.id}</code>\nUser: <code>${w.user_telegram_id}</code>\nAmount: <b>${w.amount} ${escapeHtml(currency)}</b>\nDestination: <code>${escapeHtml(w.payout_details)}</code>`,
        {
          reply_markup: buildApprovalButtons(
            `tsk:wd:approve:${w.id}`,
            `tsk:wd:reject:${w.id}`,
            '✅ Mark Paid',
            '❌ Reject & Refund'
          ),
        }
      );
    }
    return;
  }

  // User actions
  switch (text) {
    case '📝 Available Tasks': {
      const { rows } = await repos.db.all(
        `SELECT * FROM tasks WHERE bot_id = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 15`,
        [bot.id]
      );
      if (!rows.length) {
        await telegram.sendMessage(token, chatId, 'No active tasks available right now.', { reply_markup: userKb });
        return;
      }
      const kb = buildInlineKeyboard(
        rows.map((t) => [
          inlineButton({
            text: `📝 ${t.title} (+${t.reward_amount} ${currency})`,
            callbackData: `tsk:view:${t.id}`,
            style: BUTTON_STYLES.PRIMARY,
          }),
        ])
      );
      await telegram.sendMessage(
        token,
        chatId,
        formatBrandedMessage(config, { heading: '📝 Available Tasks', body: 'Select a task to view instructions and upload screenshot proof:' }),
        { reply_markup: kb }
      );
      return;
    }

    case '📋 My Submissions': {
      const { rows } = await repos.db.all(
        `SELECT s.*, t.title FROM task_submissions s JOIN tasks t ON s.task_id = t.id
         WHERE s.bot_id = ? AND s.user_telegram_id = ? ORDER BY s.created_at DESC LIMIT 12`,
        [bot.id, endUser.telegram_id]
      );
      const body = rows.length
        ? rows
            .map((s) => `• <code>${s.id}</code> — <b>${escapeHtml(s.title)}</b> (${s.reward_amount} ${escapeHtml(currency)}) · <b>${s.status.toUpperCase()}</b>`)
            .join('\n')
        : '<i>You have not submitted any task proofs yet.</i>';
      await telegram.sendMessage(token, chatId, formatBrandedMessage(config, { heading: '📋 My Task Submissions', body }), {
        reply_markup: userKb,
      });
      return;
    }

    case '💰 Balance': {
      await telegram.sendMessage(
        token,
        chatId,
        formatBrandedMessage(config, {
          heading: '💰 Verified Balance',
          body: `Available Balance: <b>${Number(endUser.points_balance || 0)} ${escapeHtml(currency)}</b>\nMinimum Withdrawal: <b>${minWithdraw} ${escapeHtml(currency)}</b>`,
        }),
        { reply_markup: userKb }
      );
      return;
    }

    case '💸 Withdraw': {
      await repos.endUsers.setState(bot.id, endUser.telegram_id, { step: 'withdraw_input' });
      await telegram.sendMessage(
        token,
        chatId,
        `💸 Send your withdrawal request:\n<code>Amount | UPI ID or Bank Details</code>\n(Min: <b>${minWithdraw} ${escapeHtml(currency)}</b>)`
      );
      return;
    }

    case '🎧 Support': {
      await telegram.sendMessage(
        token,
        chatId,
        formatBrandedMessage(config, {
          heading: '🎧 Task Support',
          body: config.supportUsername ? `Reach support at ${escapeHtml(config.supportUsername)}.` : 'Support handle not configured.',
        }),
        { reply_markup: userKb }
      );
    }
  }
}

async function handleCallback(ctx, adminKb, currency) {
  const { bot, config, token, telegram, repos, update, endUser, isAdmin } = ctx;
  const cb = update.callback_query;
  const chatId = cb.message?.chat?.id;
  const data = cb.data || '';
  await telegram.answerCallbackQuery(token, cb.id).catch(() => {});

  if (data.startsWith('tsk:view:')) {
    const taskId = data.slice('tsk:view:'.length);
    const { row: task } = await repos.db.first(`SELECT * FROM tasks WHERE id = ? AND bot_id = ? AND is_active = 1`, [taskId, bot.id]);
    if (!task) return;
    await telegram.sendMessage(
      token,
      chatId,
      formatBrandedMessage(config, {
        heading: `📝 ${task.title}`,
        body: `Reward: <b>${task.reward_amount} ${escapeHtml(currency)}</b>\n\n<b>Instructions:</b>\n${escapeHtml(task.instructions || task.description)}`,
      }),
      {
        reply_markup: buildInlineKeyboard([
          [inlineButton({ text: '📤 Upload Screenshot Proof', callbackData: `tsk:submit:${task.id}`, style: BUTTON_STYLES.SUCCESS })],
        ]),
      }
    );
    return;
  }

  if (data.startsWith('tsk:submit:')) {
    const taskId = data.slice('tsk:submit:'.length);
    await repos.endUsers.setState(bot.id, endUser.telegram_id, { step: 'submit_task_proof', taskId });
    await telegram.sendMessage(
      token,
      chatId,
      '📸 Upload your <b>screenshot proof</b> (photo with optional caption) or send your text proof now.\n<i>An admin must approve your proof before balance is credited.</i>'
    );
    return;
  }

  if (!isAdmin) return;

  if (data.startsWith('tsk:sub:approve:') || data.startsWith('tb:adm_approve:')) {
    const subId = data.startsWith('tsk:sub:approve:')
      ? data.slice('tsk:sub:approve:'.length)
      : data.slice('tb:adm_approve:'.length);
    const now = new Date().toISOString();
    const { meta } = await repos.db.run(
      `UPDATE task_submissions SET status = 'approved', reviewed_by = ?, updated_at = ?
       WHERE id = ? AND bot_id = ? AND status = 'pending'`,
      [endUser.telegram_id, now, subId, bot.id]
    );
    if (!meta?.changes) {
      await telegram.sendMessage(token, chatId, '⚠️ Task submission was already reviewed.', { reply_markup: adminKb });
      return;
    }
    const { row: sub } = await repos.db.first(`SELECT * FROM task_submissions WHERE id = ? AND bot_id = ?`, [subId, bot.id]);
    const nextBalance = await repos.endUsers.adjustPoints(bot.id, sub.user_telegram_id, {
      delta: Number(sub.reward_amount),
      txType: 'reward',
      referenceId: subId,
      description: `Approved task submission ${subId}`,
    });
    await telegram.sendMessage(
      token,
      chatId,
      `✅ Approved submission <code>${subId}</code> and credited <b>${sub.reward_amount} ${escapeHtml(currency)}</b> to user <code>${sub.user_telegram_id}</code>.`,
      { reply_markup: adminKb }
    );
    await telegram
      .sendMessage(
        token,
        sub.user_telegram_id,
        `🎉 Your task submission <code>${subId}</code> was <b>APPROVED</b>! +<b>${sub.reward_amount} ${escapeHtml(currency)}</b> credited. New Balance: <b>${nextBalance} ${escapeHtml(currency)}</b>.`
      )
      .catch(() => {});
    return;
  }

  if (data.startsWith('tsk:sub:reject:') || data.startsWith('tb:adm_reject:')) {
    const subId = data.startsWith('tsk:sub:reject:')
      ? data.slice('tsk:sub:reject:'.length)
      : data.slice('tb:adm_reject:'.length);
    const { meta } = await repos.db.run(
      `UPDATE task_submissions SET status = 'rejected', reviewed_by = ?, updated_at = ?
       WHERE id = ? AND bot_id = ? AND status = 'pending'`,
      [endUser.telegram_id, new Date().toISOString(), subId, bot.id]
    );
    if (!meta?.changes) {
      await telegram.sendMessage(token, chatId, '⚠️ Submission already reviewed.', { reply_markup: adminKb });
      return;
    }
    const { row: sub } = await repos.db.first(`SELECT * FROM task_submissions WHERE id = ? AND bot_id = ?`, [subId, bot.id]);
    await telegram
      .sendMessage(token, sub.user_telegram_id, `❌ Your task submission <code>${subId}</code> was rejected by admin.`)
      .catch(() => {});
    await telegram.sendMessage(token, chatId, `❌ Rejected task submission <code>${subId}</code>.`, { reply_markup: adminKb });
    return;
  }

  if (data.startsWith('tsk:wd:approve:')) {
    const wdId = data.slice('tsk:wd:approve:'.length);
    const { meta } = await repos.db.run(
      `UPDATE withdrawal_requests SET status = 'approved', reviewed_by = ?, updated_at = ?
       WHERE id = ? AND bot_id = ? AND status = 'pending'`,
      [endUser.telegram_id, new Date().toISOString(), wdId, bot.id]
    );
    if (!meta?.changes) {
      await telegram.sendMessage(token, chatId, '⚠️ Withdrawal already processed.', { reply_markup: adminKb });
      return;
    }
    const { row: wd } = await repos.db.first(`SELECT * FROM withdrawal_requests WHERE id = ? AND bot_id = ?`, [wdId, bot.id]);
    await telegram
      .sendMessage(token, wd.user_telegram_id, `✅ Your withdrawal <code>${wdId}</code> (${wd.amount} ${escapeHtml(currency)}) has been approved!`)
      .catch(() => {});
    await telegram.sendMessage(token, chatId, `✅ Withdrawal <code>${wdId}</code> marked approved.`, { reply_markup: adminKb });
    return;
  }

  if (data.startsWith('tsk:wd:reject:')) {
    const wdId = data.slice('tsk:wd:reject:'.length);
    const { meta } = await repos.db.run(
      `UPDATE withdrawal_requests SET status = 'rejected', reviewed_by = ?, updated_at = ?
       WHERE id = ? AND bot_id = ? AND status = 'pending'`,
      [endUser.telegram_id, new Date().toISOString(), wdId, bot.id]
    );
    if (!meta?.changes) {
      await telegram.sendMessage(token, chatId, '⚠️ Withdrawal already processed.', { reply_markup: adminKb });
      return;
    }
    const { row: wd } = await repos.db.first(`SELECT * FROM withdrawal_requests WHERE id = ? AND bot_id = ?`, [wdId, bot.id]);
    await repos.endUsers.adjustPoints(bot.id, wd.user_telegram_id, {
      delta: Number(wd.amount),
      txType: 'withdrawal_refund',
      referenceId: wdId,
      description: 'Rejected task withdrawal refunded',
    });
    await telegram
      .sendMessage(token, wd.user_telegram_id, `❌ Withdrawal <code>${wdId}</code> was rejected and refunded to your balance.`)
      .catch(() => {});
    await telegram.sendMessage(token, chatId, `❌ Withdrawal <code>${wdId}</code> rejected and refunded.`, { reply_markup: adminKb });
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
