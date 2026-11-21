/**
 * Reusable Telegram Animation & Live Progress Engine.
 *
 * Uses editMessageText + sendChatAction with rate-limit-safe intervals (600-900ms).
 * Progress bars reflect ACTUAL completed backend stages — never fake percentages.
 */

import { buildInlineKeyboard, BUTTON_STYLES, inlineButton } from './keyboards.js';
import { escapeHtml } from './validation.js';

const SPINNER_FRAMES = ['◐', '◓', '◑', '◒'];

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function renderProgressBar(completedSteps, totalSteps, width = 12) {
  const safeTotal = Math.max(1, totalSteps);
  const clamped = Math.max(0, Math.min(completedSteps, safeTotal));
  const filled = Math.round((clamped / safeTotal) * width);
  const empty = Math.max(0, width - filled);
  const percent = Math.round((clamped / safeTotal) * 100);
  return `${'█'.repeat(filled)}${'░'.repeat(empty)} ${percent}%`;
}

/**
 * Formats a multi-stage live deployment/task card showing completed, active, and pending stages.
 */
export function formatStageProgressMessage({ title, stages, currentIndex, frameIndex = 0, detail = '' }) {
  const spinner = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length];
  const bar = renderProgressBar(currentIndex, stages.length);
  const lines = [
    `<b>${escapeHtml(title)}</b>`,
    `<code>${bar}</code>`,
    '',
  ];

  stages.forEach((stage, idx) => {
    if (idx < currentIndex) {
      lines.push(`✅ ${escapeHtml(stage.doneLabel || stage.label)}`);
    } else if (idx === currentIndex) {
      lines.push(`${spinner} <b>${escapeHtml(stage.label)}</b>`);
    } else {
      lines.push(`▫️ <i>${escapeHtml(stage.pendingLabel || stage.label)}</i>`);
    }
  });

  if (detail) {
    lines.push('', `<i>${escapeHtml(detail)}</i>`);
  }

  return lines.join('\n');
}

/**
 * Executes an ordered array of real async stages while updating a Telegram progress
 * message cleanly at controlled intervals (>= 650ms between edits).
 *
 * Each stage: { id, label, doneLabel, run: async (ctx) => result }
 * If any stage throws, immediately displays an error card with retry action and rethrows.
 */
export async function runAnimatedStages({
  telegram,
  token,
  chatId,
  title = '⚡ BOT FACTORY — Deploying Bot',
  stages = [],
  minStageIntervalMs = 650,
  retryCallbackData = null,
}) {
  await telegram.sendChatAction(token, chatId, 'typing').catch(() => {});

  const initialText = formatStageProgressMessage({
    title,
    stages,
    currentIndex: 0,
    frameIndex: 0,
  });

  const sent = await telegram.sendMessage(token, chatId, initialText, { parse_mode: 'HTML' });
  const messageId = sent?.result?.message_id;

  const context = { results: {} };

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    const startedAt = Date.now();

    if (messageId && i > 0) {
      const stageText = formatStageProgressMessage({
        title,
        stages,
        currentIndex: i,
        frameIndex: i,
      });
      await telegram.editMessageText(token, chatId, messageId, stageText, { parse_mode: 'HTML' }).catch(() => {});
    }

    try {
      const result = await stage.run(context);
      context.results[stage.id] = result;

      // Keep UI transitions legible and respect Telegram rate limits (650ms min cadence)
      const elapsed = Date.now() - startedAt;
      if (elapsed < minStageIntervalMs && i < stages.length - 1) {
        await sleep(minStageIntervalMs - elapsed);
      }
    } catch (err) {
      const errorCard = formatErrorAnimationCard({
        stageLabel: stage.label,
        errorMessage: err?.message || 'Unexpected deployment error.',
      });
      const replyMarkup = retryCallbackData
        ? buildInlineKeyboard([
            [
              inlineButton({ text: '🔄 Retry Deployment', callbackData: retryCallbackData, style: BUTTON_STYLES.PRIMARY }),
              inlineButton({ text: '🏠 Main Menu', callbackData: 'mb:home', style: BUTTON_STYLES.DANGER }),
            ],
          ])
        : undefined;

      if (messageId) {
        await telegram
          .editMessageText(token, chatId, messageId, errorCard, {
            parse_mode: 'HTML',
            reply_markup: replyMarkup,
          })
          .catch(() => {});
      }
      throw err;
    }
  }

  return { messageId, results: context.results };
}

/**
 * Formats the final verified live deployment card.
 * ONLY call after real Telegram setWebhook + getWebhookInfo verification succeeds.
 */
export function formatBotLiveSuccessCard({ botUsername, displayName, botId, templateName, webhookUrl }) {
  const safeUser = escapeHtml(botUsername);
  const safeName = escapeHtml(displayName);
  const safeTpl = escapeHtml(templateName);
  return [
    '<pre>╔══════════════════════╗\n🟢 BOT IS LIVE!\n╚══════════════════════╝</pre>',
    '',
    `🤖 <b>${safeName}</b> (@${safeUser}) has been deployed and verified.`,
    '',
    `• <b>Status:</b> ONLINE`,
    `• <b>Webhook:</b> CONNECTED & VERIFIED`,
    `• <b>Engine:</b> ACTIVE`,
    `• <b>Template:</b> ${safeTpl}`,
    `• <b>Bot ID:</b> <code>${escapeHtml(botId)}</code>`,
    `• <b>Endpoint:</b> <code>${escapeHtml(webhookUrl)}</code>`,
  ].join('\n');
}

export function buildBotLiveActionKeyboard(botUsername, botId) {
  return buildInlineKeyboard([
    [
      inlineButton({ text: '🚀 OPEN YOUR BOT', url: `https://t.me/${botUsername}`, style: BUTTON_STYLES.SUCCESS }),
      inlineButton({ text: '⚙️ MANAGE BOT', callbackData: `mb:bot:${botId}`, style: BUTTON_STYLES.PRIMARY }),
    ],
    [inlineButton({ text: '📂 My Created Bots', callbackData: 'mb:my_bots', style: BUTTON_STYLES.DEFAULT })],
  ]);
}

export function formatErrorAnimationCard({ stageLabel, errorMessage }) {
  return [
    '<pre>╔══════════════════════╗\n🔴 DEPLOYMENT FAILED\n╚══════════════════════╝</pre>',
    '',
    `❌ <b>Failed Stage:</b> ${escapeHtml(stageLabel)}`,
    `⚠️ <b>Reason:</b> ${escapeHtml(errorMessage)}`,
    '',
    'No bot was marked live. Verify your token or configuration and retry.',
  ].join('\n');
}

/**
 * Short transition loading message for statistics / config fetches (single edit, rate-limit friendly).
 */
export async function withLoadingMessage({ telegram, token, chatId, loadingText, action, minDelayMs = 550 }) {
  await telegram.sendChatAction(token, chatId, 'typing').catch(() => {});
  const sent = await telegram.sendMessage(token, chatId, `⏳ <b>${escapeHtml(loadingText)}</b>`, {
    parse_mode: 'HTML',
  });
  const messageId = sent?.result?.message_id;
  const startedAt = Date.now();

  try {
    const { text, replyMarkup } = await action();
    const elapsed = Date.now() - startedAt;
    if (elapsed < minDelayMs) {
      await sleep(minDelayMs - elapsed);
    }
    if (messageId) {
      await telegram.editMessageText(token, chatId, messageId, text, {
        parse_mode: 'HTML',
        reply_markup: replyMarkup,
      });
    } else {
      await telegram.sendMessage(token, chatId, text, {
        parse_mode: 'HTML',
        reply_markup: replyMarkup,
      });
    }
    return { messageId };
  } catch (err) {
    const errText = `❌ <b>Operation Failed</b>\n\n${escapeHtml(err?.message || 'Unexpected error')}`;
    if (messageId) {
      await telegram.editMessageText(token, chatId, messageId, errText, { parse_mode: 'HTML' }).catch(() => {});
    }
    throw err;
  }
}

/**
 * Lightweight single-message multi-step animation for Force Join verification,
 * bot settings updates, and template operations. Never spams multiple messages;
 * edits a single progress message with controlled 550-750ms spacing.
 */
export async function runAnimatedOperation({
  telegram,
  token,
  chatId,
  title,
  steps = [],
  minStepIntervalMs = 550,
  finalReplyMarkup,
  existingMessageId = null,
}) {
  await telegram.sendChatAction(token, chatId, 'typing').catch(() => {});

  let messageId = existingMessageId;
  const firstText = formatStageProgressMessage({
    title,
    stages: steps,
    currentIndex: 0,
    frameIndex: 0,
  });

  if (messageId) {
    await telegram.editMessageText(token, chatId, messageId, firstText, { parse_mode: 'HTML' }).catch(() => {});
  } else {
    const sent = await telegram.sendMessage(token, chatId, firstText, { parse_mode: 'HTML' });
    messageId = sent?.result?.message_id || null;
  }

  let finalResult = null;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const startedAt = Date.now();

    if (messageId && i > 0) {
      const nextText = formatStageProgressMessage({
        title,
        stages: steps,
        currentIndex: i,
        frameIndex: i,
      });
      await telegram.editMessageText(token, chatId, messageId, nextText, { parse_mode: 'HTML' }).catch(() => {});
    }

    finalResult = await step.run(finalResult);
    const elapsed = Date.now() - startedAt;
    if (elapsed < minStepIntervalMs && i < steps.length - 1) {
      await sleep(minStepIntervalMs - elapsed);
    }
  }

  return { messageId, result: finalResult, finalReplyMarkup };
}

