/**
 * Modular Template Registry.
 * Registers all 11 functional Template Studio templates + backward-compatible legacy templates + Custom Bot Builder.
 * Coming Soon templates (`hosting-bot`, `own-bot-cloner`) are intentionally NOT registered as deployable runtime handlers.
 */

import { handleReferEarnUpdate, REFER_EARN_META } from './refer-earn/index.js';
import { handleSmmPanelUpdate, SMM_PANEL_META } from './smm-panel/index.js';
import { handleToolBotUpdate, TOOL_BOT_META } from './tool-bot/index.js';
import { handleApkStoreUpdate, APK_STORE_META } from './apk-store/index.js';
import { handleChannelAutomationUpdate, CHANNEL_AUTOMATION_META } from './channel-automation/index.js';
import { handleYonoVoucherUpdate, YONO_VOUCHER_META } from './yono-voucher/index.js';
import { handleShoppingVoucherUpdate, SHOPPING_VOUCHER_META } from './shopping-voucher/index.js';
import { handleTaskBotUpdate, TASK_BOT_META } from './task-bot/index.js';
import { handleRedeemCodeUpdate, REDEEM_CODE_META } from './redeem-code/index.js';
import { handleFestiveBonusUpdate, FESTIVE_BONUS_META } from './festive-bonus/index.js';
import { handleDigitalProductsUpdate, DIGITAL_PRODUCTS_META } from './digital-products/index.js';
import { handleEmailServicesUpdate, EMAIL_SERVICES_META } from './email-services/index.js';
import { handleFileStoreUpdate, FILE_STORE_META } from './file-store/index.js';
import { handleGroupManagerUpdate, GROUP_MANAGER_META } from './group-manager/index.js';
import { handleCustomBuilderUpdate } from '../builder/builder.js';

export const TEMPLATE_HANDLERS = Object.freeze({
  // 11 Functional Template Studio Templates
  'refer-earn': { meta: REFER_EARN_META, handle: handleReferEarnUpdate },
  'smm-panel': { meta: SMM_PANEL_META, handle: handleSmmPanelUpdate },
  'tool-bot': { meta: TOOL_BOT_META, handle: handleToolBotUpdate },
  'apk-store': { meta: APK_STORE_META, handle: handleApkStoreUpdate },
  'channel-automation': { meta: CHANNEL_AUTOMATION_META, handle: handleChannelAutomationUpdate },
  'yono-voucher': { meta: YONO_VOUCHER_META, handle: handleYonoVoucherUpdate },
  'shopping-voucher': { meta: SHOPPING_VOUCHER_META, handle: handleShoppingVoucherUpdate },
  'task-bot': { meta: TASK_BOT_META, handle: handleTaskBotUpdate },
  'redeem-code': { meta: REDEEM_CODE_META, handle: handleRedeemCodeUpdate },
  'festive-bonus': { meta: FESTIVE_BONUS_META, handle: handleFestiveBonusUpdate },
  'digital-products': { meta: DIGITAL_PRODUCTS_META, handle: handleDigitalProductsUpdate },
  'digital-store': { meta: DIGITAL_PRODUCTS_META, handle: handleDigitalProductsUpdate },

  // Legacy backward-compatible templates (preserved for existing deployed bots)
  'email-services': { meta: EMAIL_SERVICES_META, handle: handleEmailServicesUpdate },
  'file-store': { meta: FILE_STORE_META, handle: handleFileStoreUpdate },
  'group-manager': { meta: GROUP_MANAGER_META, handle: handleGroupManagerUpdate },

  // Custom No-Code Bot Builder + Dynamic Admin Panel
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
