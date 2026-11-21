/**
 * Dynamic Admin Panel Generator for Custom No-Code Bots.
 *
 * Inspects a custom bot's configured menus, buttons, and branding settings and
 * automatically generates tailored Tenant Admin Panel modules & native ReplyKeyboard
 * buttons matching the bot's actual enabled capabilities.
 */

import { BUTTON_STYLES } from '../utils/keyboards.js';
import { buildTenantAdminReplyKeyboard } from '../templates/shared/tenant-admin.js';

export function detectCustomBotFeatures(menus = [], config = {}) {
  const buttons = [];
  for (const menu of Array.isArray(menus) ? menus : []) {
    for (const btn of menu?.buttons || []) {
      buttons.push(btn);
    }
  }

  let hasProducts = false;
  let hasOrders = false;
  let hasPayments = Boolean(config?.templateSettings?.upiId);
  let hasForms = false;
  let hasSupport = Boolean(config?.supportUsername);

  for (const btn of buttons) {
    const action = String(btn.actionType || '').toLowerCase();
    const payload = String(btn.actionPayload || '').toLowerCase();

    if (action === 'support') hasSupport = true;
    if (action === 'catalogue' || payload.startsWith('catalogue')) hasProducts = true;
    if (action === 'create_order' || payload.startsWith('create_order')) {
      hasProducts = true;
      hasOrders = true;
      hasPayments = true;
    }
    if (
      action === 'collect_input' ||
      action === 'submit_request' ||
      payload.startsWith('form:') ||
      payload.startsWith('submit_request:')
    ) {
      hasForms = true;
    }
  }

  return {
    hasProducts,
    hasOrders,
    hasPayments,
    hasForms,
    hasSupport,
  };
}

/**
 * Generates the Dynamic Admin Panel specification (modules list + native ReplyKeyboard).
 */
export function generateDynamicAdminSpec(menus = [], config = {}) {
  const features = detectCustomBotFeatures(menus, config);
  const extraButtons = [];
  const modules = [
    { key: 'dashboard', label: 'Dashboard & Live Stats', dynamic: false },
    { key: 'users', label: 'Users & Ban Control', dynamic: false },
    { key: 'broadcast', label: 'Bot Broadcast Center', dynamic: false },
    { key: 'admins', label: 'Admin Roles & Permissions', dynamic: false },
  ];

  if (features.hasProducts) {
    extraButtons.push({ text: '🛍 Manage Products', style: BUTTON_STYLES.SUCCESS });
    modules.push({ key: 'products', label: 'Manage Products / Catalogue', dynamic: true });
  }
  if (features.hasOrders) {
    extraButtons.push({ text: '📦 Manage Orders', style: BUTTON_STYLES.PRIMARY });
    modules.push({ key: 'orders', label: 'Manage Orders', dynamic: true });
  }
  if (features.hasPayments) {
    extraButtons.push({ text: '💳 Payment Verification', style: BUTTON_STYLES.DANGER });
    modules.push({ key: 'payments', label: 'Payment Verification & UPI', dynamic: true });
  }
  if (features.hasForms) {
    extraButtons.push({ text: '📥 Form Submissions', style: BUTTON_STYLES.SUCCESS });
    modules.push({ key: 'forms', label: 'Form & Request Submissions', dynamic: true });
  }
  if (features.hasSupport) {
    modules.push({ key: 'support', label: 'Support Desk Settings', dynamic: true });
  }

  const replyKeyboard = buildTenantAdminReplyKeyboard(extraButtons, {
    includeUpiSetup: features.hasPayments || features.hasOrders,
    placeholder: 'Dynamic Custom Bot Admin...',
  });

  return {
    features,
    modules,
    extraButtons,
    replyKeyboard,
  };
}
