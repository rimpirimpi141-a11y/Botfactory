/**
 * Theme Engine & Branding Formatter for BOT FACTORY tenants.
 * Produces polished Telegram HTML cards with brand header, welcome copy,
 * support links, and configurable footer text.
 */

import { escapeHtml } from '../utils/validation.js';

export const THEME_PRESETS = Object.freeze({
  obsidian_neon: {
    id: 'obsidian_neon',
    name: 'Obsidian Neon',
    divider: '━━━━━━━━━━━━━━━━━━━━',
    bullet: '▸',
    headerPrefix: '⚡',
    defaultPrimaryStyle: 'primary',
    defaultSuccessStyle: 'success',
    defaultDangerStyle: 'danger',
  },
  emerald_vault: {
    id: 'emerald_vault',
    name: 'Emerald Vault',
    divider: '────────────────────',
    bullet: '◆',
    headerPrefix: '🛡',
    defaultPrimaryStyle: 'success',
    defaultSuccessStyle: 'success',
    defaultDangerStyle: 'danger',
  },
  arctic_slate: {
    id: 'arctic_slate',
    name: 'Arctic Slate',
    divider: '════════════════════',
    bullet: '•',
    headerPrefix: '💠',
    defaultPrimaryStyle: 'primary',
    defaultSuccessStyle: 'success',
    defaultDangerStyle: 'danger',
  },
  crimson_command: {
    id: 'crimson_command',
    name: 'Crimson Command',
    divider: '▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬',
    bullet: '▪',
    headerPrefix: '🔥',
    defaultPrimaryStyle: 'primary',
    defaultSuccessStyle: 'success',
    defaultDangerStyle: 'danger',
  },
});

export function getThemePreset(themeId) {
  return THEME_PRESETS[themeId] || THEME_PRESETS.obsidian_neon;
}

export function listThemePresets() {
  return Object.values(THEME_PRESETS);
}

/**
 * Formats a branded Telegram HTML message using the tenant's theme & branding config.
 */
export function formatBrandedMessage(config, { heading = '', body = '', includeFooter = true } = {}) {
  const theme = getThemePreset(config?.themeId);
  const brandTitle = escapeHtml(config?.brandTitle || 'BOT FACTORY Bot');
  const lines = [];

  lines.push(`${theme.headerPrefix} <b>${brandTitle}</b>`);
  if (heading) {
    lines.push(`<b>${escapeHtml(heading)}</b>`);
  }
  lines.push(theme.divider);

  if (body) {
    lines.push(body);
  }

  if (includeFooter) {
    const footerParts = [];
    if (config?.footerText) {
      footerParts.push(`<i>${escapeHtml(config.footerText)}</i>`);
    }
    if (config?.supportUsername) {
      footerParts.push(`Support: ${escapeHtml(config.supportUsername)}`);
    }
    if (footerParts.length > 0) {
      lines.push('', theme.divider, footerParts.join(' · '));
    }
  }

  return lines.join('\n');
}
