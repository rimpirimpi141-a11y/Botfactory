-- ============================================================================
-- BOT FACTORY — Migration 0001: Complete Multi-Tenant D1 Relational Schema
-- Primary Database: Cloudflare D1 (SQLite-dialect distributed SQL)
-- ============================================================================

PRAGMA foreign_keys = ON;

-- 1. Platform Users (Creators, Bot Owners, and End-Users registered via Master Bot)
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  telegram_id TEXT NOT NULL UNIQUE,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  language_code TEXT DEFAULT 'en',
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'creator', 'admin', 'super_admin')),
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'starter', 'pro', 'enterprise')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'banned')),
  wizard_state TEXT, -- JSON serialized wizard progress for Master Bot
  last_active_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_users_status_plan ON users(status, plan);

-- 2. Bot Templates (Modular prebuilt templates + custom builder template)
CREATE TABLE IF NOT EXISTS bot_templates (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '1.0.0',
  default_config TEXT NOT NULL, -- JSON schema of default menus, commands, features
  required_plan TEXT NOT NULL DEFAULT 'free' CHECK (required_plan IN ('free', 'starter', 'pro', 'enterprise')),
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 3. Created Multi-Tenant Bots
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY, -- Internal unique bot ID used in /webhook/:botId
  owner_telegram_id TEXT NOT NULL,
  telegram_bot_id TEXT NOT NULL UNIQUE, -- Real Telegram numeric bot ID from getMe
  telegram_username TEXT NOT NULL UNIQUE, -- Real Telegram @username from getMe
  display_name TEXT NOT NULL,
  description TEXT DEFAULT '',
  token_encrypted TEXT NOT NULL, -- AES-GCM base64(iv + ciphertext)
  token_hash TEXT NOT NULL UNIQUE, -- SHA-256 hash to prevent duplicate registrations without storing plaintext
  webhook_secret TEXT NOT NULL, -- Secret sent by Telegram in X-Telegram-Bot-Api-Secret-Token
  webhook_url TEXT,
  webhook_status TEXT NOT NULL DEFAULT 'pending' CHECK (webhook_status IN ('pending', 'registered', 'verified', 'failed', 'disabled')),
  webhook_last_verified_at TEXT,
  webhook_last_error TEXT,
  template_id TEXT NOT NULL REFERENCES bot_templates(id),
  mode TEXT NOT NULL DEFAULT 'template' CHECK (mode IN ('template', 'custom')),
  status TEXT NOT NULL DEFAULT 'deploying' CHECK (status IN ('deploying', 'active', 'disabled', 'failed', 'deleted')),
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'starter', 'pro', 'enterprise')),
  total_updates INTEGER NOT NULL DEFAULT 0,
  total_users INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_bots_owner ON bots(owner_telegram_id);
CREATE INDEX IF NOT EXISTS idx_bots_status ON bots(status, webhook_status);
CREATE INDEX IF NOT EXISTS idx_bots_template ON bots(template_id);

-- 4. Bot Owners & Co-Owners mapping
CREATE TABLE IF NOT EXISTS bot_owners (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  telegram_id TEXT NOT NULL,
  ownership_role TEXT NOT NULL DEFAULT 'owner' CHECK (ownership_role IN ('owner', 'co_owner')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(bot_id, telegram_id)
);

-- 5. Per-Bot Admins (isolated per tenant bot)
CREATE TABLE IF NOT EXISTS admins (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  telegram_id TEXT NOT NULL,
  permissions TEXT NOT NULL DEFAULT '["all"]', -- JSON array of permissions
  added_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(bot_id, telegram_id)
);
CREATE INDEX IF NOT EXISTS idx_admins_bot ON admins(bot_id, telegram_id);

-- 6. Bot Configurations (Branding, Theme, Template Settings)
CREATE TABLE IF NOT EXISTS bot_configs (
  bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
  brand_title TEXT NOT NULL,
  welcome_message TEXT NOT NULL DEFAULT 'Welcome!',
  welcome_image_url TEXT,
  logo_url TEXT,
  footer_text TEXT DEFAULT '',
  support_username TEXT DEFAULT '',
  theme_id TEXT NOT NULL DEFAULT 'obsidian_neon',
  theme_config TEXT NOT NULL DEFAULT '{}', -- JSON
  template_settings TEXT NOT NULL DEFAULT '{}', -- JSON per-template settings (rewards, cooldowns, channels, etc.)
  force_join_channels TEXT NOT NULL DEFAULT '[]', -- JSON array of channel usernames/IDs
  promo_footer_enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 7. Bot Features (Enabled/disabled modular features per bot)
CREATE TABLE IF NOT EXISTS bot_features (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  feature_key TEXT NOT NULL,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  config TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(bot_id, feature_key)
);

-- 8. Custom Builder Menus (User & Admin menu trees per bot)
CREATE TABLE IF NOT EXISTS bot_menus (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  menu_key TEXT NOT NULL, -- e.g. 'main', 'admin', 'sub_services'
  parent_menu_key TEXT,
  title TEXT NOT NULL,
  message_text TEXT NOT NULL,
  image_url TEXT,
  menu_scope TEXT NOT NULL DEFAULT 'user' CHECK (menu_scope IN ('user', 'admin')),
  keyboard_type TEXT NOT NULL DEFAULT 'inline' CHECK (keyboard_type IN ('inline', 'reply')),
  columns INTEGER NOT NULL DEFAULT 2 CHECK (columns BETWEEN 1 AND 4),
  is_root INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(bot_id, menu_key)
);
CREATE INDEX IF NOT EXISTS idx_bot_menus_bot ON bot_menus(bot_id, menu_scope);

-- 9. Custom Builder Buttons (with native Telegram button style support)
CREATE TABLE IF NOT EXISTS bot_buttons (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  menu_id TEXT NOT NULL REFERENCES bot_menus(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  emoji TEXT DEFAULT '',
  button_type TEXT NOT NULL DEFAULT 'callback' CHECK (button_type IN ('callback', 'url', 'reply')),
  action_type TEXT NOT NULL CHECK (action_type IN ('submenu', 'message', 'url', 'feature', 'back', 'support')),
  action_payload TEXT NOT NULL DEFAULT '',
  row_index INTEGER NOT NULL DEFAULT 0,
  col_index INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  visibility TEXT NOT NULL DEFAULT 'all' CHECK (visibility IN ('all', 'users', 'admins', 'hidden')),
  style TEXT NOT NULL DEFAULT 'primary' CHECK (style IN ('primary', 'success', 'danger', 'default')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_bot_buttons_menu ON bot_buttons(menu_id, row_index, col_index);

-- 10. Tenant Bot End-Users (Strictly isolated by bot_id)
CREATE TABLE IF NOT EXISTS bot_end_users (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  telegram_id TEXT NOT NULL,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  points_balance REAL NOT NULL DEFAULT 0,
  referral_code TEXT NOT NULL,
  referred_by TEXT, -- telegram_id of referrer within same bot_id
  referral_count INTEGER NOT NULL DEFAULT 0,
  last_daily_bonus_at TEXT,
  state_json TEXT, -- JSON conversational step state within this bot
  is_blocked INTEGER NOT NULL DEFAULT 0, -- 1 if Telegram returned 403 bot blocked
  is_banned INTEGER NOT NULL DEFAULT 0,
  joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(bot_id, telegram_id),
  UNIQUE(bot_id, referral_code)
);
CREATE INDEX IF NOT EXISTS idx_end_users_bot_blocked ON bot_end_users(bot_id, is_blocked, is_banned);
CREATE INDEX IF NOT EXISTS idx_end_users_bot_points ON bot_end_users(bot_id, points_balance DESC);
CREATE INDEX IF NOT EXISTS idx_end_users_bot_refs ON bot_end_users(bot_id, referral_count DESC);

-- 11. Platform Subscriptions
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  user_telegram_id TEXT NOT NULL,
  plan TEXT NOT NULL CHECK (plan IN ('free', 'starter', 'pro', 'enterprise')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'cancelled')),
  max_bots INTEGER NOT NULL DEFAULT 2,
  max_broadcasts_per_day INTEGER NOT NULL DEFAULT 5,
  starts_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_telegram_id, status);

-- 12. Points & Ledger Transactions (Per Tenant Bot)
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  user_telegram_id TEXT NOT NULL,
  tx_type TEXT NOT NULL CHECK (tx_type IN ('referral_bonus', 'daily_bonus', 'giftcode', 'withdrawal_debit', 'withdrawal_refund', 'admin_credit', 'admin_debit', 'order_debit', 'order_refund', 'reward')),
  amount REAL NOT NULL,
  balance_after REAL NOT NULL,
  reference_id TEXT,
  description TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_transactions_bot_user ON transactions(bot_id, user_telegram_id, created_at DESC);

-- 13. Referrals Tracking (Anti-self-referral & duplicate claim protection)
CREATE TABLE IF NOT EXISTS referrals (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  referrer_telegram_id TEXT NOT NULL,
  referred_telegram_id TEXT NOT NULL,
  reward_points REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'credited' CHECK (status IN ('pending', 'credited', 'rejected')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(bot_id, referred_telegram_id),
  CHECK (referrer_telegram_id != referred_telegram_id)
);
CREATE INDEX IF NOT EXISTS idx_referrals_bot_referrer ON referrals(bot_id, referrer_telegram_id);

-- 14. Giftcodes & Redemptions
CREATE TABLE IF NOT EXISTS giftcodes (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  reward_points REAL NOT NULL CHECK (reward_points > 0),
  max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses > 0),
  used_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'exhausted', 'expired', 'disabled')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(bot_id, code)
);

CREATE TABLE IF NOT EXISTS giftcode_redemptions (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  giftcode_id TEXT NOT NULL REFERENCES giftcodes(id) ON DELETE CASCADE,
  user_telegram_id TEXT NOT NULL,
  points_awarded REAL NOT NULL,
  redeemed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(giftcode_id, user_telegram_id)
);

-- 15. Manual Withdrawal Requests (Points-based, admin-reviewed)
CREATE TABLE IF NOT EXISTS withdrawal_requests (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  user_telegram_id TEXT NOT NULL,
  amount REAL NOT NULL CHECK (amount > 0),
  payout_method TEXT NOT NULL,
  payout_details TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by TEXT,
  review_note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_withdrawals_bot_status ON withdrawal_requests(bot_id, status, created_at DESC);

-- 16. Digital Products & Product Orders (Template 5: Digital Product Bot)
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  category TEXT NOT NULL DEFAULT 'General',
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_points REAL NOT NULL DEFAULT 0 CHECK (price_points >= 0),
  delivery_type TEXT NOT NULL DEFAULT 'file_id' CHECK (delivery_type IN ('file_id', 'download_url', 'text_license')),
  delivery_payload TEXT NOT NULL, -- Telegram file_id or authorized link/text
  stock_count INTEGER NOT NULL DEFAULT -1, -- -1 = unlimited
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_products_bot_cat ON products(bot_id, category, is_active);

CREATE TABLE IF NOT EXISTS product_orders (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id),
  user_telegram_id TEXT NOT NULL,
  price_points REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'delivered' CHECK (status IN ('pending', 'delivered', 'cancelled', 'refunded')),
  delivery_note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_product_orders_bot_user ON product_orders(bot_id, user_telegram_id, created_at DESC);

-- 17. Services & Service Orders (Template 2: Email/Digital Services & Template 4: Legitimate SMM Services)
CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  category TEXT NOT NULL DEFAULT 'General',
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_points REAL NOT NULL DEFAULT 0 CHECK (price_points >= 0),
  min_quantity INTEGER NOT NULL DEFAULT 1,
  max_quantity INTEGER NOT NULL DEFAULT 1000,
  seller_telegram_id TEXT, -- Optional verified seller for marketplace submissions
  approval_status TEXT NOT NULL DEFAULT 'approved' CHECK (approval_status IN ('pending', 'approved', 'rejected')),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_services_bot_cat ON services(bot_id, category, approval_status, is_active);

CREATE TABLE IF NOT EXISTS service_orders (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  service_id TEXT NOT NULL REFERENCES services(id),
  user_telegram_id TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  target_details TEXT NOT NULL DEFAULT '',
  total_points REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled', 'refunded')),
  admin_note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_service_orders_bot_status ON service_orders(bot_id, status, created_at DESC);

-- 18. File Records (Template 6: File Store Bot)
CREATE TABLE IF NOT EXISTS file_records (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  file_code TEXT NOT NULL,
  telegram_file_id TEXT NOT NULL,
  file_unique_id TEXT,
  file_name TEXT NOT NULL,
  mime_type TEXT,
  file_size INTEGER DEFAULT 0,
  caption TEXT DEFAULT '',
  access_level TEXT NOT NULL DEFAULT 'public' CHECK (access_level IN ('public', 'force_join', 'admin_only')),
  download_count INTEGER NOT NULL DEFAULT 0,
  uploaded_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(bot_id, file_code)
);
CREATE INDEX IF NOT EXISTS idx_file_records_bot_name ON file_records(bot_id, file_name);

-- 19. Group Management Settings & Filters (Template 7: Group Manager Bot)
CREATE TABLE IF NOT EXISTS group_settings (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  chat_title TEXT DEFAULT '',
  welcome_text TEXT DEFAULT 'Welcome to the group, {name}!',
  rules_text TEXT DEFAULT 'Be respectful. No spam or unauthorized links.',
  banned_words TEXT NOT NULL DEFAULT '[]', -- JSON array
  anti_spam_enabled INTEGER NOT NULL DEFAULT 1,
  max_messages_per_minute INTEGER NOT NULL DEFAULT 12,
  messages_processed INTEGER NOT NULL DEFAULT 0,
  warnings_issued INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(bot_id, chat_id)
);

-- 20. Global & Per-Bot Broadcasts + Resumable Recipient Batches
CREATE TABLE IF NOT EXISTS broadcasts (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('global', 'single_bot', 'bot_group', 'selected_users')),
  target_bot_ids TEXT NOT NULL DEFAULT '[]', -- JSON array
  target_user_ids TEXT NOT NULL DEFAULT '[]', -- JSON array
  message_text TEXT NOT NULL,
  image_url TEXT,
  inline_buttons TEXT NOT NULL DEFAULT '[]', -- JSON array of { text, url, style }
  include_promo_footer INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'queued', 'running', 'paused', 'completed', 'cancelled', 'failed')),
  total_recipients INTEGER NOT NULL DEFAULT 0,
  delivered_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  blocked_count INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_broadcasts_status ON broadcasts(status, created_at DESC);

CREATE TABLE IF NOT EXISTS broadcast_recipients (
  id TEXT PRIMARY KEY,
  broadcast_id TEXT NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  user_telegram_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'blocked', 'skipped')),
  error_message TEXT,
  sent_at TEXT,
  UNIQUE(broadcast_id, bot_id, user_telegram_id)
);
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_queue ON broadcast_recipients(broadcast_id, status);

-- 21. Activity, Webhook Logs, System Logs, Usage Stats & Platform Settings
CREATE TABLE IF NOT EXISTS bot_activity (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  user_telegram_id TEXT,
  event_type TEXT NOT NULL,
  feature_key TEXT,
  duration_ms INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_bot_activity_bot_time ON bot_activity(bot_id, created_at DESC);

CREATE TABLE IF NOT EXISTS webhook_logs (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  update_id INTEGER,
  status_code INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_time ON webhook_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_bot ON webhook_logs(bot_id, created_at DESC);

CREATE TABLE IF NOT EXISTS system_logs (
  id TEXT PRIMARY KEY,
  level TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error', 'security', 'audit')),
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata TEXT DEFAULT '{}', -- JSON, strictly scrubbed of secrets
  actor_telegram_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_system_logs_level_time ON system_logs(level, created_at DESC);

CREATE TABLE IF NOT EXISTS platform_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL,
  description TEXT DEFAULT '',
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS usage_statistics (
  id TEXT PRIMARY KEY,
  stat_date TEXT NOT NULL, -- YYYY-MM-DD
  bot_id TEXT NOT NULL DEFAULT '__platform__',
  requests_count INTEGER NOT NULL DEFAULT 0,
  errors_count INTEGER NOT NULL DEFAULT 0,
  unique_users_count INTEGER NOT NULL DEFAULT 0,
  total_duration_ms INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(stat_date, bot_id)
);
CREATE INDEX IF NOT EXISTS idx_usage_stats_date ON usage_statistics(stat_date DESC);
