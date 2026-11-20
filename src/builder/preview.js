/**
 * Live Telegram Menu Preview Renderer.
 * Compiles a custom menu + branding config into exact Telegram HTML text + reply_markup
 * respecting button visibility, rows, columns, and native Telegram button styles.
 */

import { compileBuilderButton } from './button-builder.js';
import { formatBrandedMessage } from './theme-engine.js';
import { buildInlineKeyboard, buildReplyKeyboard, chunkButtonsToRows } from '../utils/keyboards.js';
import { escapeHtml } from '../utils/validation.js';

export function buildMenuRenderPayload({ menu, config, isAdmin = false }) {
  const visibleButtons = (menu.buttons || [])
    .filter((btn) => {
      if (btn.visibility === 'hidden') return false;
      if (btn.visibility === 'admins' && !isAdmin) return false;
      if (btn.visibility === 'users' && isAdmin) return true;
      return true;
    })
    .sort((a, b) => (a.row - b.row) || (a.col - b.col) || (a.position - b.position));

  // Group explicitly by row if rows are assigned, otherwise chunk by menu.columns
  const hasExplicitRows = visibleButtons.some((b) => typeof b.row === 'number');
  let compiledRows = [];

  if (hasExplicitRows) {
    const rowMap = new Map();
    for (const btn of visibleButtons) {
      const r = btn.row ?? 0;
      if (!rowMap.has(r)) rowMap.set(r, []);
      rowMap.get(r).push(compileBuilderButton(btn, menu.keyboardType));
    }
    compiledRows = Array.from(rowMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, items]) => items);
  } else {
    const compiled = visibleButtons.map((b) => compileBuilderButton(b, menu.keyboardType));
    compiledRows = chunkButtonsToRows(compiled, menu.columns || 2);
  }

  const replyMarkup =
    menu.keyboardType === 'reply'
      ? buildReplyKeyboard(compiledRows, { resize: true, persistent: true })
      : buildInlineKeyboard(compiledRows);

  const text = formatBrandedMessage(config, {
    heading: menu.title,
    body: escapeHtml(menu.messageText),
  });

  return {
    text,
    imageUrl: menu.imageUrl || null,
    replyMarkup,
  };
}
