/**
 * Custom No-Code Menu & Submenu Tree Builder.
 * Validates menu hierarchy, columns, scopes (user/admin), and buttons before saving to D1.
 */

import { validateButtonDefinition } from './button-builder.js';
import { containsUnsafePayload, sanitizeText, validateSafeUrl } from '../utils/validation.js';
import { BUTTON_STYLES } from '../utils/keyboards.js';

export function validateMenuTree(rawMenus = []) {
  if (!Array.isArray(rawMenus) || rawMenus.length === 0) {
    throw new Error('At least one root menu is required.');
  }
  if (rawMenus.length > 30) {
    throw new Error('Maximum of 30 menus per bot is permitted.');
  }

  const seenKeys = new Set();
  const validatedMenus = rawMenus.map((rawMenu, idx) => {
    const menuKey = sanitizeText(rawMenu?.menuKey, 40).replace(/[^a-zA-Z0-9_-]/g, '_');
    if (!menuKey) {
      throw new Error(`Menu #${idx + 1} must have a valid menuKey.`);
    }
    if (seenKeys.has(menuKey)) {
      throw new Error(`Duplicate menuKey "${menuKey}".`);
    }
    seenKeys.add(menuKey);

    const title = sanitizeText(rawMenu?.title, 80);
    const messageText = sanitizeText(rawMenu?.messageText, 2500);
    if (!title || !messageText) {
      throw new Error(`Menu "${menuKey}" requires both title and messageText.`);
    }
    if (containsUnsafePayload(title) || containsUnsafePayload(messageText)) {
      throw new Error(`Menu "${menuKey}" contains forbidden script content.`);
    }

    let imageUrl = null;
    if (rawMenu?.imageUrl) {
      const check = validateSafeUrl(rawMenu.imageUrl);
      if (!check.valid) throw new Error(`Menu "${menuKey}" imageUrl invalid: ${check.error}`);
      imageUrl = check.url;
    }

    const columns = Math.max(1, Math.min(4, Number(rawMenu?.columns) || 2));
    const scope = rawMenu?.scope === 'admin' ? 'admin' : 'user';
    const keyboardType = rawMenu?.keyboardType === 'reply' ? 'reply' : 'inline';
    const buttons = (rawMenu?.buttons || []).slice(0, 40).map((b, bIdx) => validateButtonDefinition(b, bIdx));

    return {
      id: rawMenu?.id || `mnu_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
      menuKey,
      parentMenuKey: rawMenu?.parentMenuKey ? sanitizeText(rawMenu.parentMenuKey, 40) : null,
      title,
      messageText,
      imageUrl,
      scope,
      keyboardType,
      columns,
      isRoot: Boolean(rawMenu?.isRoot || idx === 0),
      sortOrder: idx,
      buttons,
    };
  });

  // Verify submenu targets exist
  for (const menu of validatedMenus) {
    for (const btn of menu.buttons) {
      if (btn.actionType === 'submenu' && !seenKeys.has(btn.actionPayload)) {
        throw new Error(`Button "${btn.label}" in menu "${menu.menuKey}" points to missing submenu "${btn.actionPayload}".`);
      }
    }
  }

  return validatedMenus;
}

/**
 * Generates a starter multi-menu custom bot blueprint with colourful buttons.
 */
export function createDefaultCustomMenuTree(brandTitle = 'My Custom Bot') {
  return [
    {
      menuKey: 'main',
      parentMenuKey: null,
      title: `${brandTitle} — Main Menu`,
      messageText: `Welcome to ${brandTitle}! Choose an option below to get started.`,
      imageUrl: null,
      scope: 'user',
      keyboardType: 'inline',
      columns: 2,
      isRoot: true,
      buttons: [
        {
          id: 'btn_services',
          label: 'Explore Offerings',
          emoji: '🚀',
          actionType: 'submenu',
          actionPayload: 'sub_offerings',
          row: 0,
          col: 0,
          position: 0,
          visibility: 'all',
          style: BUTTON_STYLES.SUCCESS,
        },
        {
          id: 'btn_profile',
          label: 'My Profile',
          emoji: '👤',
          actionType: 'feature',
          actionPayload: 'user_profile',
          row: 0,
          col: 1,
          position: 1,
          visibility: 'all',
          style: BUTTON_STYLES.PRIMARY,
        },
        {
          id: 'btn_support',
          label: 'Contact Support',
          emoji: '🎧',
          actionType: 'support',
          actionPayload: 'Reach our support team anytime.',
          row: 1,
          col: 0,
          position: 2,
          visibility: 'all',
          style: BUTTON_STYLES.PRIMARY,
        },
        {
          id: 'btn_admin',
          label: 'Admin Panel',
          emoji: '🛡',
          actionType: 'submenu',
          actionPayload: 'admin_main',
          row: 1,
          col: 1,
          position: 3,
          visibility: 'admins',
          style: BUTTON_STYLES.DANGER,
        },
      ],
    },
    {
      menuKey: 'sub_offerings',
      parentMenuKey: 'main',
      title: 'Offerings & Info',
      messageText: 'Browse our available features and information below.',
      imageUrl: null,
      scope: 'user',
      keyboardType: 'inline',
      columns: 2,
      isRoot: false,
      buttons: [
        {
          id: 'btn_about',
          label: 'About Us',
          emoji: 'ℹ️',
          actionType: 'message',
          actionPayload: 'Powered by BOT FACTORY multi-tenant infrastructure.',
          row: 0,
          col: 0,
          position: 0,
          visibility: 'all',
          style: BUTTON_STYLES.PRIMARY,
        },
        {
          id: 'btn_back_main',
          label: 'Back to Main',
          emoji: '⬅️',
          actionType: 'back',
          actionPayload: 'main',
          row: 1,
          col: 0,
          position: 1,
          visibility: 'all',
          style: BUTTON_STYLES.DANGER,
        },
      ],
    },
    {
      menuKey: 'admin_main',
      parentMenuKey: 'main',
      title: 'Admin Console',
      messageText: 'Authorized bot administrators can inspect live bot statistics here.',
      imageUrl: null,
      scope: 'admin',
      keyboardType: 'inline',
      columns: 2,
      isRoot: false,
      buttons: [
        {
          id: 'btn_adm_stats',
          label: 'Bot Statistics',
          emoji: '📊',
          actionType: 'feature',
          actionPayload: 'bot_stats',
          row: 0,
          col: 0,
          position: 0,
          visibility: 'admins',
          style: BUTTON_STYLES.SUCCESS,
        },
        {
          id: 'btn_adm_back',
          label: 'Exit Admin',
          emoji: '⬅️',
          actionType: 'back',
          actionPayload: 'main',
          row: 0,
          col: 1,
          position: 1,
          visibility: 'admins',
          style: BUTTON_STYLES.DANGER,
        },
      ],
    },
  ];
}
