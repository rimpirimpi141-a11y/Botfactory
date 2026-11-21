/**
 * Template Studio Catalog, Plan Tiers & Builder Defaults.
 * Mirrors the 11 functional modular templates + 2 Coming Soon templates implemented in /src/templates/* and seeded in D1.
 * Zero templates are locked by referral tier — referrals strictly increase bot creation slots & plan tier.
 */

import type { BuilderMenu } from './api';

export interface TemplateBlueprint {
  id: string;
  slug: string;
  name: string;
  category: string;
  requiredPlan: 'free';
  availabilityStatus: 'active' | 'coming_soon';
  isComingSoon: boolean;
  description: string;
  complianceNote: string;
  userButtons: Array<{ text: string; style: 'success' | 'primary' | 'danger' }>;
  adminReplyButtons: Array<{ text: string; style: 'success' | 'primary' | 'danger' }>;
  adminCapabilities: string[];
  d1TablesUsed: string[];
}

export interface PlanTierCatalogItem {
  id: 'free' | 'starter' | 'pro' | 'enterprise';
  name: string;
  referralsRequired: number;
  baseBots: number | null;
  maxBotsLabel: string;
  slotFormula: string;
  highlights: string[];
}

export const PLAN_TIERS: PlanTierCatalogItem[] = [
  {
    id: 'free',
    name: 'FREE',
    referralsRequired: 0,
    baseBots: 2,
    maxBotsLabel: '2 Base Bots (+1 / verified ref)',
    slotFormula: '2 + verified_referrals',
    highlights: [
      '2 bot creation slots included immediately on signup',
      '+1 permanent bot slot per verified unique referral',
      'All 11 functional Template Studio bots unlocked',
      'Custom No-Code Bot Builder + Dynamic Admin Panel',
    ],
  },
  {
    id: 'starter',
    name: 'STARTER',
    referralsRequired: 8,
    baseBots: 10,
    maxBotsLabel: '10 Bot Slots',
    slotFormula: 'Unlocked automatically at 8 verified referrals',
    highlights: [
      '10 active multi-tenant Telegram bot slots',
      'All 11 templates + UPI QR payment proof verification',
      'Dedicated native ReplyKeyboard Admin Panel per bot',
      'Automatic webhook verification & KV config caching',
    ],
  },
  {
    id: 'pro',
    name: 'PRO',
    referralsRequired: 48,
    baseBots: 50,
    maxBotsLabel: '50 Bot Slots',
    slotFormula: 'Unlocked automatically at 48 verified referrals',
    highlights: [
      '50 active multi-tenant Telegram bot slots',
      'Unlimited Custom Builder submenus & form capture',
      'Scheduled Channel Automation via Cloudflare Cron',
      'Full D1 analytics & real-time activity logs',
    ],
  },
  {
    id: 'enterprise',
    name: 'ENTERPRISE',
    referralsRequired: 50,
    baseBots: null,
    maxBotsLabel: 'Unlimited Bots',
    slotFormula: 'Unlocked automatically at 50 verified referrals (overrides lower tiers)',
    highlights: [
      'Unlimited multi-tenant Telegram bot creation slots',
      'Priority multi-tenant Worker routing & broadcast dispatch',
      'Full Owner & Creator support tooling',
      'Permanent milestone unlock without recurring fees',
    ],
  },
];

export const TEMPLATE_CATALOG: TemplateBlueprint[] = [
  {
    id: 'tpl_refer_earn',
    slug: 'refer-earn',
    name: 'Refer & Earn Bot',
    category: 'Growth & Rewards',
    requiredPlan: 'free',
    availabilityStatus: 'active',
    isComingSoon: false,
    description:
      'Points-based referral engine with unique deep links, strict anti-self-referral guards, 24h daily bonus cooldowns, giftcodes, real Force-Join channel checks, leaderboard, and manual admin withdrawal approval.',
    complianceNote: 'Points-based ledger with manual admin review and auto-refund on rejection. No automated bank/UPI payouts.',
    userButtons: [
      { text: '💰 My Balance', style: 'success' },
      { text: '👥 Refer & Earn', style: 'primary' },
      { text: '🎁 Daily Bonus', style: 'success' },
      { text: '🎟 Redeem Giftcode', style: 'primary' },
      { text: '💸 Withdrawal Request', style: 'primary' },
      { text: '📊 My Statistics', style: 'primary' },
      { text: '🏆 Leaderboard', style: 'primary' },
      { text: '📢 Join Channels', style: 'success' },
      { text: '🆘 Support', style: 'primary' },
    ],
    adminReplyButtons: [
      { text: '📊 Bot Analytics', style: 'primary' },
      { text: '💸 Pending Withdrawals', style: 'danger' },
      { text: '🎟 Create Giftcode', style: 'success' },
      { text: '👥 Users & Balances', style: 'primary' },
      { text: '📢 Force Join', style: 'primary' },
      { text: '📣 Broadcast Users', style: 'success' },
    ],
    adminCapabilities: [
      'Native ReplyKeyboard Tenant Admin Panel (/admin)',
      'Create Giftcodes with Expiry, Max Uses & Min Referrals',
      'Approve / Reject Withdrawals (Atomic Auto-Refund on Reject)',
      'Adjust User Points, Referral Reward & Daily Bonus Rules',
      'Real getChatMember Force-Join Enforcement',
    ],
    d1TablesUsed: ['bot_end_users', 'referrals', 'transactions', 'giftcodes', 'giftcode_redemptions', 'withdrawal_requests'],
  },
  {
    id: 'tpl_apk_store',
    slug: 'apk-store',
    name: 'APK Store Bot',
    category: 'Apps & Distribution',
    requiredPlan: 'free',
    availabilityStatus: 'active',
    isComingSoon: false,
    description:
      'Authorized Android APK & app catalogue supporting categories, keyword search, version/size metadata, instant Telegram document file_id delivery, free/paid UPI QR verification, and download analytics.',
    complianceNote: 'Authorized APK files and software packages uploaded by the bot owner only.',
    userButtons: [
      { text: '📱 Browse APKs', style: 'success' },
      { text: '📂 Categories', style: 'primary' },
      { text: '🔎 Search APKs', style: 'primary' },
      { text: '📥 My Downloads', style: 'success' },
      { text: '🆘 Support', style: 'primary' },
    ],
    adminReplyButtons: [
      { text: '➕ Upload APK', style: 'success' },
      { text: '📱 Manage APKs', style: 'primary' },
      { text: '💳 Payment Proofs', style: 'danger' },
      { text: '📊 Bot Analytics', style: 'primary' },
      { text: '📢 Force Join', style: 'primary' },
      { text: '📣 Broadcast Users', style: 'success' },
    ],
    adminCapabilities: [
      'Upload APK via Telegram Document Attachment (stores file_id, version, size)',
      'Free Instant Download or Paid UPI QR Payment Verification',
      'Category Management, Download Counters & Force Join Gate',
      'Atomic Payment Proof Approval -> Automatic APK Delivery',
    ],
    d1TablesUsed: ['products', 'product_orders', 'payment_proofs', 'bot_end_users'],
  },
  {
    id: 'tpl_smm_panel',
    slug: 'smm-panel',
    name: 'SMM Panel Bot',
    category: 'Marketing Services',
    requiredPlan: 'free',
    availabilityStatus: 'active',
    isComingSoon: false,
    description:
      'Marketing agency order desk for legitimate social media campaigns, creative calendars, ad setup, UPI QR wallet deposit proof verification, external provider API configuration, and order status notifications.',
    complianceNote: 'Legitimate marketing services only. Wallet deposits require explicit manual admin verification of UPI UTR/screenshot proof.',
    userButtons: [
      { text: '📦 Services', style: 'success' },
      { text: '🛒 New Order', style: 'primary' },
      { text: '📁 My Orders', style: 'primary' },
      { text: '🔎 Order Status', style: 'primary' },
      { text: '💰 Deposit Balance', style: 'success' },
      { text: '🆘 Support', style: 'primary' },
    ],
    adminReplyButtons: [
      { text: '➕ Add Service', style: 'success' },
      { text: '📦 Manage Orders', style: 'primary' },
      { text: '💳 Verify Deposits', style: 'danger' },
      { text: '🔌 Provider API', style: 'primary' },
      { text: '📊 Bot Analytics', style: 'primary' },
      { text: '📣 Broadcast Users', style: 'success' },
    ],
    adminCapabilities: [
      'Add & Edit Marketing Service Packages in D1',
      'UPI QR Deposit Proof Verification (Atomic Credit on Approval)',
      'Order Lifecycle: Pending -> In Progress -> Completed / Refunded',
      'Optional External Provider API URL Configuration',
    ],
    d1TablesUsed: ['services', 'service_orders', 'payment_proofs', 'bot_end_users', 'transactions'],
  },
  {
    id: 'tpl_task_bot',
    slug: 'task-bot',
    name: 'Task Bot',
    category: 'Growth & Rewards',
    requiredPlan: 'free',
    availabilityStatus: 'active',
    isComingSoon: false,
    description:
      'Micro-task & community mission bot where users browse active tasks, submit screenshot or text proofs, track review status, and receive rewards strictly after manual admin verification.',
    complianceNote: 'Zero auto-crediting on screenshot upload. Balance increases ONLY when an admin atomically approves a pending submission.',
    userButtons: [
      { text: '📋 Available Tasks', style: 'success' },
      { text: '📤 My Submissions', style: 'primary' },
      { text: '💰 My Balance', style: 'success' },
      { text: '💸 Withdraw', style: 'primary' },
      { text: '🆘 Support', style: 'primary' },
    ],
    adminReplyButtons: [
      { text: '➕ Create Task', style: 'success' },
      { text: '🧐 Review Proofs', style: 'danger' },
      { text: '📋 Manage Tasks', style: 'primary' },
      { text: '💸 Withdrawals', style: 'primary' },
      { text: '📊 Bot Analytics', style: 'primary' },
      { text: '📣 Broadcast Users', style: 'success' },
    ],
    adminCapabilities: [
      'Create Tasks with Reward Amount, Max Completions & Proof Instructions',
      'Review Pending Screenshot / Text Proofs with Approve & Reject Buttons',
      'Atomic Approval Prevents Duplicate Reward Crediting',
      'Withdrawal Requests & Force Join Support',
    ],
    d1TablesUsed: ['tasks', 'task_submissions', 'bot_end_users', 'transactions', 'withdrawal_requests'],
  },
  {
    id: 'tpl_redeem_code',
    slug: 'redeem-code',
    name: 'Redeem Code Bot',
    category: 'Rewards & Loyalty',
    requiredPlan: 'free',
    availabilityStatus: 'active',
    isComingSoon: false,
    description:
      'Promo code & loyalty reward distributor enforcing expiry timestamps, maximum claim caps, duplicate claim locks, minimum referral requirements, and bulk code generation.',
    complianceNote: 'Server-side D1 uniqueness and atomic claim counters prevent double redemption.',
    userButtons: [
      { text: '🎟 Redeem Code', style: 'success' },
      { text: '👥 My Referrals', style: 'primary' },
      { text: '📜 Claim History', style: 'primary' },
      { text: '💰 My Rewards', style: 'success' },
      { text: '🆘 Support', style: 'primary' },
    ],
    adminReplyButtons: [
      { text: '➕ Create Code', style: 'success' },
      { text: '⚡ Bulk Generate', style: 'primary' },
      { text: '🎟 Active Codes', style: 'primary' },
      { text: '📊 Claim Stats', style: 'primary' },
      { text: '📢 Force Join', style: 'primary' },
      { text: '📣 Broadcast Users', style: 'success' },
    ],
    adminCapabilities: [
      'Create Single or Bulk Random Redeem Codes',
      'Enforce Min Referrals, Expiry Date & Max Claims per Code',
      'Block Duplicate Claims per User in D1',
      'Export / View Active Redemption Telemetry',
    ],
    d1TablesUsed: ['giftcodes', 'giftcode_redemptions', 'referrals', 'bot_end_users', 'transactions'],
  },
  {
    id: 'tpl_channel_automation',
    slug: 'channel-automation',
    name: 'Channel Automation Bot',
    category: 'Publishing & Channels',
    requiredPlan: 'free',
    availabilityStatus: 'active',
    isComingSoon: false,
    description:
      'Automated Telegram channel publisher that verifies real bot administrator permissions via getChatMember before linking, supports instant posting, inline CTA buttons, and Cloudflare Cron scheduled posts.',
    complianceNote: 'Refuses channel connection unless Telegram getChatMember confirms the tenant bot is an administrator.',
    userButtons: [
      { text: '📢 Connected Channels', style: 'primary' },
      { text: '📝 Schedule Post', style: 'success' },
      { text: '🚀 Instant Post', style: 'success' },
      { text: '🗓 Scheduled Queue', style: 'primary' },
      { text: '🆘 Support', style: 'primary' },
    ],
    adminReplyButtons: [
      { text: '➕ Connect Channel', style: 'success' },
      { text: '📝 New Post', style: 'success' },
      { text: '🗓 View Queue', style: 'primary' },
      { text: '📢 Channels List', style: 'primary' },
      { text: '📊 Bot Analytics', style: 'primary' },
      { text: '⚙️ Bot Settings', style: 'primary' },
    ],
    adminCapabilities: [
      'Verify Bot Admin Status via Real Telegram getChatMember',
      'Instant Publishing with Optional Inline CTA Link Button',
      'Scheduled Post Queue Dispatched Automatically by Worker Cron',
      'Per-Post Delivery Status & Error Audit Tracking',
    ],
    d1TablesUsed: ['connected_channels', 'scheduled_posts', 'bot_end_users'],
  },
  {
    id: 'tpl_yono_voucher',
    slug: 'yono-voucher',
    name: 'Yono All Game Voucher Bot',
    category: 'Vouchers & Codes',
    requiredPlan: 'free',
    availabilityStatus: 'active',
    isComingSoon: false,
    description:
      'Real admin-uploaded gaming voucher inventory system with category browsing, optional UPI QR verification or free claim, strict single-claim enforcement, and zero fabricated codes.',
    complianceNote: 'Distributes exclusively real voucher codes uploaded by the tenant admin. Never auto-generates fake voucher codes.',
    userButtons: [
      { text: '🎮 Browse Vouchers', style: 'success' },
      { text: '🎟 My Claimed Codes', style: 'primary' },
      { text: '💳 Buy Voucher', style: 'success' },
      { text: '🆘 Support', style: 'primary' },
    ],
    adminReplyButtons: [
      { text: '➕ Add Vouchers', style: 'success' },
      { text: '📦 Stock Inventory', style: 'primary' },
      { text: '💳 Payment Proofs', style: 'danger' },
      { text: '📊 Claim History', style: 'primary' },
      { text: '📢 Force Join', style: 'primary' },
      { text: '📣 Broadcast Users', style: 'success' },
    ],
    adminCapabilities: [
      'Upload Real Voucher Stock in Bulk (Game | Title | Price | Code)',
      'Track Available vs Claimed Inventory in D1',
      'Atomic Claiming Prevents Duplicate Code Assignment',
      'UPI QR Proof Verification for Paid Vouchers',
    ],
    d1TablesUsed: ['vouchers', 'voucher_claims', 'payment_proofs', 'bot_end_users'],
  },
  {
    id: 'tpl_shopping_voucher',
    slug: 'shopping-voucher',
    name: 'Shopping Voucher Bot',
    category: 'Vouchers & Codes',
    requiredPlan: 'free',
    availabilityStatus: 'active',
    isComingSoon: false,
    description:
      'Brand-categorized shopping voucher & gift card storefront featuring UPI QR payment proof submission, UTR tracking, real admin stock inventory, and verified delivery history.',
    complianceNote: 'Only real admin-supplied vouchers are delivered, strictly after manual payment proof approval.',
    userButtons: [
      { text: '🛍 Brand Vouchers', style: 'success' },
      { text: '📦 My Orders', style: 'primary' },
      { text: '🎟 My Vouchers', style: 'success' },
      { text: '🆘 Support', style: 'primary' },
    ],
    adminReplyButtons: [
      { text: '➕ Add Brand Stock', style: 'success' },
      { text: '💳 Payment Proofs', style: 'danger' },
      { text: '📦 Manage Orders', style: 'primary' },
      { text: '📊 Stock Overview', style: 'primary' },
      { text: '📢 Force Join', style: 'primary' },
      { text: '📣 Broadcast Users', style: 'success' },
    ],
    adminCapabilities: [
      'Organize Real Vouchers by Brand & Denomination',
      'Dynamic UPI Payment QR Generation + Proof Submission',
      'Manual Approve / Reject with Instant Voucher Dispatch',
      'Full Order & Claim Audit Trail in D1',
    ],
    d1TablesUsed: ['vouchers', 'voucher_claims', 'payment_proofs', 'bot_end_users'],
  },
  {
    id: 'tpl_tool_bot',
    slug: 'tool-bot',
    name: 'Tool Bot',
    category: 'Utilities & Productivity',
    requiredPlan: 'free',
    availabilityStatus: 'active',
    isComingSoon: false,
    description:
      'Production Cloudflare Worker utility suite: URL parser, UPI & standard QR generator, text analyzer, Base64/SHA-256 crypto, JSON formatter, real Telegram getFile inspector, and admin module toggles.',
    complianceNote: 'Executes 100% real Worker computations and Telegram getFile metadata without ever leaking bot tokens.',
    userButtons: [
      { text: '🔗 URL Inspector', style: 'primary' },
      { text: '📱 QR & UPI QR', style: 'success' },
      { text: '📝 Text Tools', style: 'primary' },
      { text: '🔐 Base64 / SHA-256', style: 'primary' },
      { text: '📄 JSON Formatter', style: 'primary' },
      { text: '🗂 File Inspector', style: 'success' },
    ],
    adminReplyButtons: [
      { text: '🧩 Toggle Modules', style: 'primary' },
      { text: '📊 Bot Analytics', style: 'primary' },
      { text: '👥 Manage Users', style: 'primary' },
      { text: '📢 Force Join', style: 'primary' },
      { text: '📣 Broadcast Users', style: 'success' },
      { text: '⚙️ Bot Settings', style: 'primary' },
    ],
    adminCapabilities: [
      'Enable / Disable Individual Utility Modules Live',
      'Real UPI Payment QR Code Builder (upi://pay?...)',
      'Real Telegram getFile Path & Size Metadata Inspector',
      'Native ReplyKeyboard Admin Panel & Force Join',
    ],
    d1TablesUsed: ['bot_end_users', 'bot_activity'],
  },
  {
    id: 'tpl_digital_products',
    slug: 'digital-products',
    name: 'Digital Product Store Bot',
    category: 'Digital Commerce',
    requiredPlan: 'free',
    availabilityStatus: 'active',
    isComingSoon: false,
    description:
      'Authorized digital goods storefront supporting categories, keyword search, UPI QR payment verification with UTR/screenshot upload, atomic admin approval, and instant Telegram file_id or license delivery.',
    complianceNote: 'Authorized digital templates, ebooks, and license keys. Paid items deliver strictly after admin payment proof approval.',
    userButtons: [
      { text: '🛍 Product Catalogue', style: 'success' },
      { text: '📂 Categories', style: 'primary' },
      { text: '🔎 Search Products', style: 'primary' },
      { text: '🛒 My Orders', style: 'primary' },
      { text: '📥 My Purchases', style: 'success' },
      { text: '🆘 Support', style: 'primary' },
    ],
    adminReplyButtons: [
      { text: '➕ Add Product', style: 'success' },
      { text: '💳 Payment Proofs', style: 'danger' },
      { text: '📦 Manage Orders', style: 'primary' },
      { text: '📊 Store Analytics', style: 'primary' },
      { text: '📢 Force Join', style: 'primary' },
      { text: '📣 Broadcast Users', style: 'success' },
    ],
    adminCapabilities: [
      'Upload Products Directly via Telegram Document Attachment',
      'UPI QR Payment Generation & Manual Proof Verification Queue',
      'Atomic Approval Prevents Double Delivery',
      'Permanent Redownload Access for Verified Buyers',
    ],
    d1TablesUsed: ['products', 'product_orders', 'payment_proofs', 'bot_end_users', 'transactions'],
  },
  {
    id: 'tpl_festive_bonus',
    slug: 'festive-bonus',
    name: 'Festive Bonus Bot',
    category: 'Campaigns & Events',
    requiredPlan: 'free',
    availabilityStatus: 'active',
    isComingSoon: false,
    description:
      'Configurable seasonal bonus campaign engine (Diwali, Eid, Holi, New Year, custom events) with configurable campaign title, start/end dates, minimum referrals, Force Join gate, and max claim caps.',
    complianceNote: 'Enforces real date windows, referral thresholds, and single-claim uniqueness per user in D1.',
    userButtons: [
      { text: '🎉 Claim Festive Bonus', style: 'success' },
      { text: '👥 Invite Friends', style: 'primary' },
      { text: '📅 Campaign Rules', style: 'primary' },
      { text: '🏆 My Bonus Status', style: 'success' },
      { text: '🆘 Support', style: 'primary' },
    ],
    adminReplyButtons: [
      { text: '🎉 Campaign Config', style: 'success' },
      { text: '📊 Claim Metrics', style: 'primary' },
      { text: '👥 Eligible Users', style: 'primary' },
      { text: '📢 Force Join', style: 'primary' },
      { text: '📣 Broadcast Users', style: 'success' },
      { text: '⚙️ Bot Settings', style: 'primary' },
    ],
    adminCapabilities: [
      'Configure Event Name, Reward Amount & Start/End Dates',
      'Set Minimum Referral Requirement & Max Global Claim Cap',
      'Enforce Real Force-Join Channel Verification Before Claim',
      'Single-Claim Guarantee & Live Campaign Claim Counter',
    ],
    d1TablesUsed: ['bot_end_users', 'referrals', 'transactions', 'giftcode_redemptions'],
  },
  {
    id: 'tpl_hosting_bot',
    slug: 'hosting-bot',
    name: 'Hosting Bot',
    category: 'Developer Infrastructure',
    requiredPlan: 'free',
    availabilityStatus: 'coming_soon',
    isComingSoon: true,
    description:
      'Managed edge deployment & runtime status automation bot for hosting panels. Currently under engineering review and disabled for deployment.',
    complianceNote: 'Marked COMING SOON — deployment is strictly blocked at UI, Master Bot, and backend API layers.',
    userButtons: [
      { text: '☁️ Coming Soon', style: 'primary' },
    ],
    adminReplyButtons: [],
    adminCapabilities: ['Planned: Runtime telemetry, plan provisioning & webhook alerts'],
    d1TablesUsed: ['bot_templates'],
  },
  {
    id: 'tpl_own_bot_cloner',
    slug: 'own-bot-cloner',
    name: 'Own Bot Cloner',
    category: 'Multi-Tenant Resale',
    requiredPlan: 'free',
    availabilityStatus: 'coming_soon',
    isComingSoon: true,
    description:
      'White-label sub-factory bot allowing creators to launch branded clone portals. Currently under engineering review and disabled for deployment.',
    complianceNote: 'Marked COMING SOON — deployment is strictly blocked at UI, Master Bot, and backend API layers.',
    userButtons: [
      { text: '🧬 Coming Soon', style: 'primary' },
    ],
    adminReplyButtons: [],
    adminCapabilities: ['Planned: Sub-tenant provisioning, revenue splits & branded onboarding'],
    d1TablesUsed: ['bot_templates'],
  },
];

export const FUNCTIONAL_TEMPLATES = TEMPLATE_CATALOG.filter((t) => !t.isComingSoon);

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
        id: 'btn_catalogue',
        label: 'Browse Catalogue',
        emoji: '🛍',
        actionType: 'feature',
        actionPayload: 'catalogue:all',
        row: 0,
        col: 0,
        position: 0,
        visibility: 'all',
        style: 'success',
      },
      {
        id: 'btn_form',
        label: 'Submit Request',
        emoji: '📝',
        actionType: 'feature',
        actionPayload: 'form:Tell us what you need and our team will reply:',
        row: 0,
        col: 1,
        position: 1,
        visibility: 'all',
        style: 'primary',
      },
      {
        id: 'btn_services',
        label: 'Info & Details',
        emoji: 'ℹ️',
        actionType: 'submenu',
        actionPayload: 'sub_services',
        row: 1,
        col: 0,
        position: 2,
        visibility: 'all',
        style: 'primary',
      },
      {
        id: 'btn_support',
        label: 'Support Desk',
        emoji: '🆘',
        actionType: 'support',
        actionPayload: 'Our team typically responds within 1 hour.',
        row: 1,
        col: 1,
        position: 3,
        visibility: 'all',
        style: 'primary',
      },
    ],
  },
  {
    menuKey: 'sub_services',
    parentMenuKey: 'main',
    title: 'Services & Information',
    messageText: 'Explore our offerings or place an order directly.',
    imageUrl: null,
    scope: 'user',
    keyboardType: 'inline',
    columns: 2,
    isRoot: false,
    buttons: [
      {
        id: 'btn_about',
        label: 'Platform Info',
        emoji: '📌',
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
];
