-- ============================================================================
-- BOT FACTORY — Migration 0003: Complete Platform Upgrade
-- Preserves all existing tables, encrypted credentials, users, and tenant bots.
-- Adds:
--   * Platform-level referral attribution & slot entitlement columns/tables
--   * Multi-admin RBAC (platform_admins) protecting Super Admin
--   * Template Studio availability_status & is_coming_soon + 13 studio templates
--   * Payment proof verification workflow (payment_proofs)
--   * Task Bot (tasks, task_submissions)
--   * Yono & Shopping Voucher Bots (vouchers, voucher_claims)
--   * Channel Automation Bot (connected_channels, scheduled_posts)
--   * Custom Bot Builder submissions (form_submissions)
--   * Deployment audit logs (deployment_logs)
-- ============================================================================

PRAGMA foreign_keys = ON;

-- 1. Extend users table for platform referrals, bonus slots, and user support info
ALTER TABLE users ADD COLUMN referral_code TEXT;
ALTER TABLE users ADD COLUMN referred_by TEXT;
ALTER TABLE users ADD COLUMN verified_referrals INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN bonus_bot_slots INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN support_username TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN support_message TEXT DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code);

-- 2. Extend bot_templates for availability status & Coming Soon state
ALTER TABLE bot_templates ADD COLUMN availability_status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE bot_templates ADD COLUMN is_coming_soon INTEGER NOT NULL DEFAULT 0;

-- 3. Extend giftcodes for Redeem Code Bot referral eligibility
ALTER TABLE giftcodes ADD COLUMN min_referrals INTEGER NOT NULL DEFAULT 0;

-- 4. Extend products for APK Store & Digital Store metadata
ALTER TABLE products ADD COLUMN product_type TEXT NOT NULL DEFAULT 'digital';
ALTER TABLE products ADD COLUMN version TEXT DEFAULT '';
ALTER TABLE products ADD COLUMN file_size TEXT DEFAULT '';

-- 5. Platform-Level Referrals (Strictly separate from tenant bot referrals)
-- Referrals ONLY govern bot creation slot limits & plan milestones, NEVER template access.
CREATE TABLE IF NOT EXISTS platform_referrals (
  id TEXT PRIMARY KEY,
  referrer_telegram_id TEXT NOT NULL,
  referred_telegram_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'verified' CHECK (status IN ('pending', 'verified', 'rejected')),
  reason TEXT DEFAULT '',
  reviewed_by TEXT,
  verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (referrer_telegram_id != referred_telegram_id)
);
CREATE INDEX IF NOT EXISTS idx_platform_referrals_referrer ON platform_referrals(referrer_telegram_id, status);

-- 6. Platform Admins (Owner Control Center RBAC; Super Admin via ADMIN_TELEGRAM_ID is immutable)
CREATE TABLE IF NOT EXISTS platform_admins (
  id TEXT PRIMARY KEY,
  telegram_id TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'moderator')),
  permissions TEXT NOT NULL DEFAULT '["overview","users","bots","support","logs"]',
  added_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_platform_admins_tg ON platform_admins(telegram_id);

-- 7. Unified Legitimate Payment Proofs (UPI QR / UTR / Screenshot -> Manual Admin Verification)
CREATE TABLE IF NOT EXISTS payment_proofs (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  user_telegram_id TEXT NOT NULL,
  order_type TEXT NOT NULL CHECK (order_type IN ('digital_order', 'apk_order', 'voucher_order', 'smm_deposit', 'custom_order')),
  reference_id TEXT,
  item_title TEXT NOT NULL DEFAULT '',
  amount REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'INR',
  payment_method TEXT NOT NULL DEFAULT 'upi_manual',
  utr_number TEXT DEFAULT '',
  screenshot_file_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by TEXT,
  review_note TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_payment_proofs_bot_status ON payment_proofs(bot_id, status, created_at DESC);

-- 8. Task Bot Tables (Screenshot proof submission -> Manual Admin Approval -> Balance Credit)
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  reward_amount REAL NOT NULL DEFAULT 0,
  max_submissions INTEGER NOT NULL DEFAULT 0,
  submission_count INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_bot ON tasks(bot_id, is_active);

CREATE TABLE IF NOT EXISTS task_submissions (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_telegram_id TEXT NOT NULL,
  screenshot_file_id TEXT,
  proof_text TEXT DEFAULT '',
  reward_amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by TEXT,
  review_note TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_task_submissions_bot_status ON task_submissions(bot_id, status, created_at DESC);

-- 9. Voucher Inventory & Claims (Yono Voucher Bot & Shopping Voucher Bot — real stock only)
CREATE TABLE IF NOT EXISTS vouchers (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  voucher_kind TEXT NOT NULL DEFAULT 'yono' CHECK (voucher_kind IN ('yono', 'shopping')),
  category TEXT NOT NULL DEFAULT 'General',
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  voucher_code TEXT NOT NULL,
  price REAL NOT NULL DEFAULT 0,
  stock_count INTEGER NOT NULL DEFAULT 1,
  requires_approval INTEGER NOT NULL DEFAULT 1,
  min_referrals INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_vouchers_bot ON vouchers(bot_id, voucher_kind, is_active);

CREATE TABLE IF NOT EXISTS voucher_claims (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  voucher_id TEXT NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  user_telegram_id TEXT NOT NULL,
  payment_proof_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'delivered', 'rejected')),
  delivered_code TEXT,
  reviewed_by TEXT,
  review_note TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(bot_id, voucher_id, user_telegram_id)
);
CREATE INDEX IF NOT EXISTS idx_voucher_claims_bot_status ON voucher_claims(bot_id, status);

-- 10. Channel Automation Bot (Connected Channels & Scheduled Posts)
CREATE TABLE IF NOT EXISTS connected_channels (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  channel_username TEXT DEFAULT '',
  channel_title TEXT DEFAULT '',
  verified_admin INTEGER NOT NULL DEFAULT 0,
  secretary_mode INTEGER NOT NULL DEFAULT 0,
  connected_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(bot_id, channel_id)
);

CREATE TABLE IF NOT EXISTS scheduled_posts (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  post_text TEXT NOT NULL,
  media_file_id TEXT,
  parse_mode TEXT NOT NULL DEFAULT 'HTML',
  scheduled_for TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'sent', 'failed', 'cancelled')),
  telegram_message_id TEXT,
  last_error TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_scheduled_posts_due ON scheduled_posts(status, scheduled_for);

-- 11. Custom Bot Builder Form Submissions (for collect_input / submit_request + Dynamic Admin Panel)
CREATE TABLE IF NOT EXISTS form_submissions (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  user_telegram_id TEXT NOT NULL,
  form_key TEXT NOT NULL,
  form_title TEXT NOT NULL DEFAULT 'Request',
  payload_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'reviewed', 'resolved', 'rejected')),
  reviewed_by TEXT,
  review_note TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_form_submissions_bot ON form_submissions(bot_id, status, created_at DESC);

-- 12. Deployment Audit Trail (Real deployment stages & retry errors)
CREATE TABLE IF NOT EXISTS deployment_logs (
  id TEXT PRIMARY KEY,
  bot_id TEXT,
  owner_telegram_id TEXT NOT NULL,
  template_id TEXT,
  stage TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'succeeded', 'failed', 'retried')),
  webhook_url TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_deployment_logs_created ON deployment_logs(created_at DESC);

-- ============================================================================
-- Seed & Update Template Studio (11 Functional + 2 Coming Soon = 13 Cards)
-- All functional templates have required_plan = 'free' so referrals NEVER lock
-- template categories (referrals strictly govern bot creation slots & plans).
-- ============================================================================

UPDATE bot_templates
SET name = 'Refer & Earn Cash Bot',
    category = 'Growth & Rewards',
    description = 'Referral link generation, referral bonus rewards, daily check-in bonus, balance tracking, payout method management, withdrawal requests, and full ReplyKeyboard Admin Panel.',
    required_plan = 'free',
    availability_status = 'active',
    is_coming_soon = 0,
    is_active = 1,
    sort_order = 1,
    version = '2.0.0',
    default_config = '{"referralReward":25,"dailyBonus":10,"dailyBonusCooldownHours":24,"minWithdrawalPoints":100,"currencyLabel":"INR","payoutMethods":["UPI","Bank Transfer","PayPal"],"forceJoinChannels":[]}'
WHERE id = 'tpl_refer_earn';

UPDATE bot_templates
SET name = 'SMM Panel Bot',
    category = 'Marketing Services',
    description = 'Legitimate social media marketing storefront with service categories, order placement, order status tracking, deposit requests with payment proof verification, external SMM API provider config, and ReplyKeyboard Admin Panel.',
    required_plan = 'free',
    availability_status = 'active',
    is_coming_soon = 0,
    is_active = 1,
    sort_order = 2,
    version = '2.0.0',
    default_config = '{"currencyLabel":"INR","upiId":"","upiPayeeName":"","providerApiUrl":"","providerApiKeyConfigured":false,"compliancePolicy":"Legitimate social media marketing services only."}'
WHERE id = 'tpl_smm_panel';

UPDATE bot_templates
SET name = 'Tool Bot',
    category = 'Utilities & Productivity',
    description = 'Modular utility toolkit with image-to-direct-link / Telegram file info, QR code generator, UPI QR generator (upi://pay QR only), text formatting, URL analyzer, Base64/JSON/Hash helpers, and admin module toggles.',
    required_plan = 'free',
    availability_status = 'active',
    is_coming_soon = 0,
    is_active = 1,
    sort_order = 3,
    version = '2.0.0',
    default_config = '{"enabledModules":["image_link","qr_generator","upi_qr","text_tools","url_tools","encoding_tools","file_info"],"aiEnabled":false}'
WHERE id = 'tpl_tool_bot';

UPDATE bot_templates
SET name = 'Digital Store Bot',
    category = 'Digital Commerce',
    description = 'Digital products storefront with categories, pricing, stock counts, UPI QR + UTR/screenshot payment proof submission, admin approval before automatic digital delivery, and order history.',
    required_plan = 'free',
    availability_status = 'active',
    is_coming_soon = 0,
    is_active = 1,
    sort_order = 11,
    version = '2.0.0',
    default_config = '{"currencyLabel":"INR","upiId":"","upiPayeeName":"","paymentInstructions":"Scan the UPI QR or pay to the configured UPI ID, then submit your UTR or payment screenshot for admin verification.","requireManualApproval":true}'
WHERE id = 'tpl_digital_products';

-- Ensure legacy compatible templates stay active and accessible
UPDATE bot_templates
SET required_plan = 'free', availability_status = 'active', is_coming_soon = 0, sort_order = 20
WHERE id IN ('tpl_email_services', 'tpl_file_store', 'tpl_group_manager');

UPDATE bot_templates
SET required_plan = 'free', availability_status = 'active', is_coming_soon = 0, sort_order = 14, version = '2.0.0'
WHERE id = 'tpl_custom_builder';

-- Seed the 7 new Functional Template Studio cards + 2 Coming Soon cards
INSERT OR IGNORE INTO bot_templates (
  id, slug, name, category, description, version, default_config, required_plan, is_active, availability_status, is_coming_soon, sort_order
) VALUES
(
  'tpl_apk_store',
  'apk-store',
  'APK Store Bot',
  'App Distribution',
  'Authorized Android APK distribution storefront with categories, app versions & details, UPI QR/manual payment proof submission, admin approval before automatic download delivery, and order history.',
  '2.0.0',
  '{"currencyLabel":"INR","upiId":"","upiPayeeName":"","policyNotice":"Authorized, developer-owned, or legitimately licensed APK builds only.","requireManualApproval":true}',
  'free',
  1,
  'active',
  0,
  4
),
(
  'tpl_channel_automation',
  'channel-automation',
  'Channel Automation Bot',
  'Publishing & Channels',
  'Connect Telegram channels with real bot admin permission verification, schedule formatted posts, automatic scheduled dispatch, queue management, and optional secretary posting mode.',
  '2.0.0',
  '{"defaultParseMode":"HTML","secretaryMode":false,"timezone":"UTC"}',
  'free',
  1,
  'active',
  0,
  5
),
(
  'tpl_yono_voucher',
  'yono-voucher',
  'Yono Voucher Bot',
  'Vouchers & Perks',
  'Real admin-managed voucher inventory with stock counts, eligibility verification, admin approval queue, duplicate claim protection, and user claim history. Never fabricates voucher codes.',
  '2.0.0',
  '{"requireApproval":true,"minReferrals":0,"policyNotice":"Real admin-added voucher inventory only."}',
  'free',
  1,
  'active',
  0,
  6
),
(
  'tpl_shopping_voucher',
  'shopping-voucher',
  'Shopping Voucher Bot',
  'Vouchers & Commerce',
  'Legitimate shopping voucher storefront (Amazon, Flipkart, brand gift cards) with categories, stock, pricing, UPI QR payment proof verification, delivery upon admin approval, and purchase history.',
  '2.0.0',
  '{"currencyLabel":"INR","upiId":"","upiPayeeName":"","brands":["Amazon","Flipkart","Myntra","General"],"requireApproval":true}',
  'free',
  1,
  'active',
  0,
  7
),
(
  'tpl_task_bot',
  'task-bot',
  'Task Bot',
  'Tasks & Micro-Rewards',
  'Micro-task platform where users browse active tasks, upload screenshot proof, track pending/approved/rejected submissions, earn balance strictly after admin approval, and request withdrawals.',
  '2.0.0',
  '{"currencyLabel":"INR","minWithdrawalPoints":100,"payoutMethods":["UPI","Bank Transfer"],"autoCreditAllowed":false}',
  'free',
  1,
  'active',
  0,
  8
),
(
  'tpl_redeem_code',
  'redeem-code',
  'Redeem Code Bot',
  'Codes & Giveaways',
  'Redeem code distribution bot with single & bulk code generation, configurable referral requirements, expiry dates, max claim limits, duplicate redemption prevention, and claim history.',
  '2.0.0',
  '{"currencyLabel":"Points","defaultMinReferrals":0,"defaultMaxRedemptions":1}',
  'free',
  1,
  'active',
  0,
  9
),
(
  'tpl_festive_bonus',
  'festive-bonus',
  'Festive Bonus Bot',
  'Campaigns & Giveaways',
  'Configurable seasonal & festive bonus campaign bot with campaign name, welcome message, reward amount, referral requirement, force-join channel checks, start/end dates, and claim limits.',
  '2.0.0',
  '{"campaignName":"Festive Bonus Campaign","rewardAmount":50,"currencyLabel":"Points","minReferrals":0,"maxClaimsPerUser":1,"startDate":"","endDate":"","forceJoinChannels":[]}',
  'free',
  1,
  'active',
  0,
  10
),
(
  'tpl_hosting_bot',
  'hosting-bot',
  'Hosting Bot',
  'Infrastructure',
  'Managed bot & server hosting automation storefront. Currently under development — visible in Template Studio as Coming Soon.',
  '0.0.0',
  '{"comingSoon":true}',
  'free',
  0,
  'coming_soon',
  1,
  12
),
(
  'tpl_own_bot_cloner',
  'own-bot-cloner',
  'Own Bot Cloner',
  'White-Label',
  'White-label sub-factory bot cloner for agencies and partners. Currently under development — visible in Template Studio as Coming Soon.',
  '0.0.0',
  '{"comingSoon":true}',
  'free',
  0,
  'coming_soon',
  1,
  13
);

-- Seed New Platform Settings Defaults
INSERT OR IGNORE INTO platform_settings (setting_key, setting_value, description) VALUES
('platform_support_username', '', 'Official BOT FACTORY support @username shown in Help & Support'),
('platform_support_message', 'Need assistance with your bots, deployments, or referrals? Reach out to our official support desk.', 'Help & Support welcome text'),
('platform_support_instructions', 'Include your Telegram ID and Bot ID when requesting support.', 'Contact instructions for users'),
('platform_support_availability', 'Daily, 09:00–21:00 UTC', 'Support team availability window'),
('platform_force_join_enabled', 'false', 'Require users to join configured platform channels before creating bots'),
('platform_force_join_channels', '[]', 'JSON array of required platform Telegram channel usernames or IDs');
