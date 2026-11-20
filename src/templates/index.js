/**
 * Modular Template Registry.
 * New bot templates register here without modifying the core bot engine or router.
 */

import { handleReferEarnUpdate, REFER_EARN_META } from './refer-earn/index.js';
import { handleEmailServicesUpdate, EMAIL_SERVICES_META } from './email-services/index.js';
import { handleToolBotUpdate, TOOL_BOT_META } from './tool-bot/index.js';
import { handleSmmPanelUpdate, SMM_PANEL_META } from './smm-panel/index.js';
import { handleDigitalProductsUpdate, DIGITAL_PRODUCTS_META } from './digital-products/index.js';
import { handleFileStoreUpdate, FILE_STORE_META } from './file-store/index.js';
import { handleGroupManagerUpdate, GROUP_MANAGER_META } from './group-manager/index.js';
import { handleCustomBuilderUpdate } from '../builder/builder.js';

export const TEMPLATE_HANDLERS = Object.freeze({
  'refer-earn': { meta: REFER_EARN_META, handle: handleReferEarnUpdate },
  'email-services': { meta: EMAIL_SERVICES_META, handle: handleEmailServicesUpdate },
  'tool-bot': { meta: TOOL_BOT_META, handle: handleToolBotUpdate },
  'smm-panel': { meta: SMM_PANEL_META, handle: handleSmmPanelUpdate },
  'digital-products': { meta: DIGITAL_PRODUCTS_META, handle: handleDigitalProductsUpdate },
  'file-store': { meta: FILE_STORE_META, handle: handleFileStoreUpdate },
  'group-manager': { meta: GROUP_MANAGER_META, handle: handleGroupManagerUpdate },
  'custom-builder': {
    meta: {
      id: 'tpl_custom_builder',
      slug: 'custom-builder',
      name: 'Custom No-Code Bot',
      category: 'Custom Architecture',
    },
    handle: handleCustomBuilderUpdate,
  },
});

export function getTemplateHandler(slugOrId) {
  if (!slugOrId) return TEMPLATE_HANDLERS['custom-builder'];
  if (TEMPLATE_HANDLERS[slugOrId]) return TEMPLATE_HANDLERS[slugOrId];
  const byId = Object.values(TEMPLATE_HANDLERS).find((t) => t.meta.id === slugOrId);
  return byId || TEMPLATE_HANDLERS['custom-builder'];
}
