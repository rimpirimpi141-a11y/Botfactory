/**
 * Template Structural Catalog & Builder Defaults.
 * Mirrors the real modular templates implemented in /src/templates/* and seeded in D1.
 */

import type { BuilderMenu } from './api';

export interface TemplateBlueprint {
  id: string;
  slug: string;
  name: string;
  category: string;
  requiredPlan: 'free' | 'starter' | 'pro';
  description: string;
  complianceNote: string;
  userButtons: Array<{ text: string; style: 'success' | 'primary' | 'danger' | 'default' }>;
  adminCapabilities: string[];
  d1TablesUsed: string[];
}

export const TEMPLATE_CATALOG: TemplateBlueprint[] = [
  {
    id: 'tpl_refer_earn',
    slug: 'refer-earn',
    name: 'Refer & Earn Bot',
    category: 'Growth & Rewards',
    requiredPlan: 'free',
    description:
      'Points-based referral engine with unique deep links, strict anti-self-referral guards, 24h daily bonus cooldowns, giftcodes, force-join channel checks, leaderboard, and manual admin withdrawal approval.',
    complianceNote: 'Points-based ledger with manual admin review. No automated bank/UPI payouts or real-money custody.',
    userButtons: [
      { text: '💰 My Balance', style: 'success' },
      { text: '👥 Refer & Earn', style: 'primary' },
      { text: '🎁 Daily Bonus', style: 'success' },
      { text: '🎟 Redeem Giftcode', style: 'primary' },
      { text: '💸 Withdrawal Request', style: 'primary' },
      { text: '📊 My Statistics', style: 'primary' },
      { text: '🏆 Leaderboard', style: 'primary' },
      { text: '📢 Join Channels', style: 'default' },
      { text: '❓ Help', style: 'default' },
    ],
    adminCapabilities: [
      'Dashboard & Bot Statistics',
      'Create Giftcodes with Expiry & Max Uses',
      'Approve / Reject Withdrawals (Auto-Refund on Reject)',
      'Adjust User Points & Referral / Daily Settings',
      'Manage Force-Join Channels',
    ],
    d1TablesUsed: ['bot_end_users', 'referrals', 'transactions', 'giftcodes', 'giftcode_redemptions', 'withdrawal_requests'],
  },
  {
    id: 'tpl_email_services',
    slug: 'email-services',
    name: 'Email & Digital Services Marketplace',
    category: 'Services Marketplace',
    requiredPlan: 'free',
    description:
      'Structured marketplace for legitimate email infrastructure setup (SPF/DKIM/DMARC), deliverability audits, newsletter workflows, and digital subscriptions with seller moderation.',
    complianceNote: 'Strictly prohibits credential/account resale, passwords, OTPs, or cookies via automatic compliance filtering.',
    userButtons: [
      { text: '🛒 Browse Services', style: 'success' },
      { text: '📤 Sell Services', style: 'primary' },
      { text: '📁 My Orders', style: 'primary' },
      { text: '💰 Balance / Deposit', style: 'success' },
      { text: '👥 Referrals', style: 'primary' },
      { text: '🎁 Rewards', style: 'primary' },
      { text: '⚙️ Settings', style: 'default' },
      { text: '❓ Help', style: 'default' },
      { text: '🛡 Admin Panel', style: 'danger' },
    ],
    adminCapabilities: [
      'Publish & Manage Legitimate Listings',
      'Approve / Reject Seller Submissions',
      'Fulfill or Refund Service Orders',
      'Marketplace Credit Volume & Order Metrics',
    ],
    d1TablesUsed: ['services', 'service_orders', 'bot_end_users', 'transactions'],
  },
  {
    id: 'tpl_tool_bot',
    slug: 'tool-bot',
    name: 'Tool Bot',
    category: 'Utilities & Productivity',
    requiredPlan: 'free',
    description:
      'Production utility bot executing real Cloudflare Worker tools: URL parser, scannable QR generator, text analyzer, Base64/SHA-256 encoder, JSON validator, Telegram file metadata inspector, and optional AI utility when GEMINI_API_KEY is set.',
    complianceNote: 'Displays only implemented, live-functional modules. AI button appears exclusively when GEMINI_API_KEY is configured.',
    userButtons: [
      { text: '🔗 URL Inspector', style: 'primary' },
      { text: '📱 QR Generator', style: 'success' },
      { text: '📝 Text Tools', style: 'primary' },
      { text: '🔐 Base64 / SHA-256', style: 'primary' },
      { text: '📄 JSON Formatter', style: 'primary' },
      { text: '🗂 File Inspector', style: 'success' },
    ],
    adminCapabilities: [
      'Zero external dependencies for crypto/text/JSON tools',
      'Direct Telegram document/photo/video/audio file_id inspection',
      'Conditional AI assistant gating via Worker Secret',
    ],
    d1TablesUsed: ['bot_end_users', 'bot_activity'],
  },
  {
    id: 'tpl_smm_panel',
    slug: 'smm-panel',
    name: 'SMM Services Panel Bot',
    category: 'Marketing Services',
    requiredPlan: 'starter',
    description:
      'Agency order desk for legitimate social media marketing packages: content calendars, paid ad setup, creative strategy, order status lookup, credit ledger, and support.',
    complianceNote: 'Legitimate marketing services only. Rejects fake followers, bot likes, or platform manipulation.',
    userButtons: [
      { text: '📦 Services', style: 'success' },
      { text: '🛒 New Order', style: 'primary' },
      { text: '📁 My Orders', style: 'primary' },
      { text: '🔎 Order Status', style: 'primary' },
      { text: '💰 Account Balance', style: 'success' },
      { text: '📜 Order History', style: 'default' },
      { text: '🎧 Support', style: 'default' },
    ],
    adminCapabilities: [
      'Add Legitimate Marketing Packages',
      'Transition Orders: Pending -> In Progress -> Completed / Refunded',
      'Automated Client Status Notifications',
    ],
    d1TablesUsed: ['services', 'service_orders', 'bot_end_users', 'transactions'],
  },
  {
    id: 'tpl_digital_products',
    slug: 'digital-products',
    name: 'Digital Product Store Bot',
    category: 'Digital Commerce',
    requiredPlan: 'free',
    description:
      'Authorized digital storefront supporting categories, keyword search, instant Telegram file_id or license delivery, order history, and redownload access.',
    complianceNote: 'Authorized digital goods, templates, ebooks, and license keys only.',
    userButtons: [
      { text: '🛍 Product Catalogue', style: 'success' },
      { text: '📂 Categories', style: 'primary' },
      { text: '🔎 Search Products', style: 'primary' },
      { text: '🛒 My Orders', style: 'primary' },
      { text: '📥 My Purchases', style: 'success' },
      { text: '🎧 Support', style: 'default' },
    ],
    adminCapabilities: [
      'Upload Products Directly via Telegram Document Attachment',
      'Manage Categories, Pricing & Authorized Delivery Payloads',
      'Track Revenue Volume & Order Fulfillment',
    ],
    d1TablesUsed: ['products', 'product_orders', 'bot_end_users', 'transactions'],
  },
  {
    id: 'tpl_file_store',
    slug: 'file-store',
    name: 'File Store Bot',
    category: 'Media & Distribution',
    requiredPlan: 'free',
    description:
      'Indexed Telegram file repository generating shareable deep-link codes (?start=file_CODE), keyword search, force-join protection, and download statistics.',
    complianceNote: 'Enforces public, force_join, or admin_only access rules per indexed file.',
    userButtons: [
      { text: '📂 Browse Files', style: 'primary' },
      { text: '🔎 Search Files', style: 'success' },
      { text: '📊 Store Stats', style: 'primary' },
      { text: '❓ Help', style: 'default' },
      { text: '📤 Upload / Index File', style: 'danger' },
    ],
    adminCapabilities: [
      'Zero-friction Document Upload -> Instant Deep Link Generation',
      'Force-Join Channel Verification Before File Dispatch',
      'Download Counters & Indexed Volume Metrics',
    ],
    d1TablesUsed: ['file_records', 'bot_end_users'],
  },
  {
    id: 'tpl_group_manager',
    slug: 'group-manager',
    name: 'Group Management Bot',
    category: 'Community Moderation',
    requiredPlan: 'free',
    description:
      'Telegram Group & Supergroup moderator with custom member welcomes, rules management, banned-word auto-deletion, KV anti-spam flood limits, and moderation metrics.',
    complianceNote: 'Verifies real Telegram group administrator roles via getChatMember before executing admin commands.',
    userButtons: [
      { text: '/rules — View Group Rules', style: 'primary' },
      { text: '/filters — Active Word Filters', style: 'primary' },
      { text: '/stats — Moderation Metrics', style: 'success' },
      { text: '/addfilter — Add Banned Word', style: 'danger' },
    ],
    adminCapabilities: [
      'Customizable Welcome Messages with {name} interpolation',
      'Real-time Message Deletion on Banned Keywords',
      'KV-Backed Per-User Flood Protection',
    ],
    d1TablesUsed: ['group_settings', 'bot_activity'],
  },
];

export const THEME_OPTIONS = [
  { id: 'obsidian_neon', name: 'Obsidian Neon', accent: '#3B82F6', divider: '━━━━━━━━━━━━━━━━━━━━' },
  { id: 'emerald_vault', name: 'Emerald Vault', accent: '#10B981', divider: '────────────────────' },
  { id: 'arctic_slate', name: 'Arctic Slate', accent: '#38BDF8', divider: '════════════════════' },
  { id: 'crimson_command', name: 'Crimson Command', accent: '#EF4444', divider: '▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬' },
];

export const DEFAULT_BUILDER_MENUS: BuilderMenu[] = [
  {
    menuKey: 'main',
    parentMenuKey: null,
    title: 'Main Menu',
    messageText: 'Welcome! Choose an action from the colourful menu below.',
    imageUrl: null,
    scope: 'user',
    keyboardType: 'inline',
    columns: 2,
    isRoot: true,
    buttons: [
      {
        id: 'btn_create',
        label: 'Get Started',
        emoji: '🚀',
        actionType: 'submenu',
        actionPayload: 'sub_services',
        row: 0,
        col: 0,
        position: 0,
        visibility: 'all',
        style: 'success',
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
        style: 'primary',
      },
      {
        id: 'btn_support',
        label: 'Support Desk',
        emoji: '🎧',
        actionType: 'support',
        actionPayload: 'Our team typically responds within 1 hour.',
        row: 1,
        col: 0,
        position: 2,
        visibility: 'all',
        style: 'primary',
      },
      {
        id: 'btn_admin',
        label: 'Admin Panel',
        emoji: '🛡',
        actionType: 'submenu',
        actionPayload: 'admin_console',
        row: 1,
        col: 1,
        position: 3,
        visibility: 'admins',
        style: 'danger',
      },
    ],
  },
  {
    menuKey: 'sub_services',
    parentMenuKey: 'main',
    title: 'Services & Information',
    messageText: 'Explore our offerings or visit our official documentation.',
    imageUrl: null,
    scope: 'user',
    keyboardType: 'inline',
    columns: 2,
    isRoot: false,
    buttons: [
      {
        id: 'btn_about',
        label: 'Platform Info',
        emoji: 'ℹ️',
        actionType: 'message',
        actionPayload: 'Hosted on BOT FACTORY multi-tenant Cloudflare Workers.',
        row: 0,
        col: 0,
        position: 0,
        visibility: 'all',
        style: 'primary',
      },
      {
        id: 'btn_back',
        label: 'Back to Main',
        emoji: '⬅️',
        actionType: 'back',
        actionPayload: 'main',
        row: 0,
        col: 1,
        position: 1,
        visibility: 'all',
        style: 'danger',
      },
    ],
  },
  {
    menuKey: 'admin_console',
    parentMenuKey: 'main',
    title: 'Admin Console',
    messageText: 'Restricted administrator controls and live bot counters.',
    imageUrl: null,
    scope: 'admin',
    keyboardType: 'inline',
    columns: 2,
    isRoot: false,
    buttons: [
      {
        id: 'btn_adm_stats',
        label: 'Live Statistics',
        emoji: '📊',
        actionType: 'feature',
        actionPayload: 'bot_stats',
        row: 0,
        col: 0,
        position: 0,
        visibility: 'admins',
        style: 'success',
      },
      {
        id: 'btn_adm_exit',
        label: 'Return Home',
        emoji: '⬅️',
        actionType: 'back',
        actionPayload: 'main',
        row: 0,
        col: 1,
        position: 1,
        visibility: 'admins',
        style: 'danger',
      },
    ],
  },
];
