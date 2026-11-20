-- ============================================================================
-- BOT FACTORY — Migration 0002: Seed Prebuilt Bot Templates & Platform Defaults
-- ============================================================================

INSERT OR IGNORE INTO bot_templates (id, slug, name, category, description, version, default_config, required_plan, is_active, sort_order) VALUES
(
  'tpl_refer_earn',
  'refer-earn',
  'Refer & Earn Bot',
  'Growth & Rewards',
  'Points-based referral rewards, daily bonus cooldowns, giftcode redemption, referral leaderboard, force-join channels, and manual admin withdrawal review.',
  '1.0.0',
  '{"referralReward":25,"dailyBonus":10,"dailyBonusCooldownHours":24,"minWithdrawalPoints":100,"currencyLabel":"Points","forceJoinChannels":[]}',
  'free',
  1,
  1
),
(
  'tpl_email_services',
  'email-services',
  'Email & Digital Services Marketplace',
  'Services Marketplace',
  'Legitimate email setup, deliverability consulting, custom domain inbox management, newsletter services, digital subscriptions, order tracking, referrals, and admin review.',
  '1.0.0',
  '{"currencyLabel":"Credits","allowSellerSubmissions":true,"referralBonusCredits":15,"compliancePolicy":"Legitimate digital & email infrastructure services only."}',
  'free',
  1,
  2
),
(
  'tpl_tool_bot',
  'tool-bot',
  'Tool Bot',
  'Utilities & Productivity',
  'Modular utility toolkit featuring URL analysis, QR code generator, text transformation, Base64/JSON/Hash helpers, Telegram file inspector, and optional AI assistant when API key is configured.',
  '1.0.0',
  '{"enabledModules":["url_tools","qr_generator","text_tools","encoding_tools","file_info"],"aiEnabled":false}',
  'free',
  1,
  3
),
(
  'tpl_smm_panel',
  'smm-panel',
  'SMM Services Panel Bot',
  'Marketing Services',
  'Legitimate social media marketing agency interface for content planning, ad campaign setup, analytics audits, order placement, status tracking, balance ledger, and support.',
  '1.0.0',
  '{"currencyLabel":"Credits","compliancePolicy":"Legitimate social media marketing services only. No fake engagement."}',
  'starter',
  1,
  4
),
(
  'tpl_digital_products',
  'digital-products',
  'Digital Product Store Bot',
  'Digital Commerce',
  'Authorized digital goods storefront with categories, keyword search, instant Telegram file_id or license delivery, purchase history, customer support, and admin inventory control.',
  '1.0.0',
  '{"currencyLabel":"Credits","instantDelivery":true,"allowSearch":true}',
  'free',
  1,
  5
),
(
  'tpl_file_store',
  'file-store',
  'File Store Bot',
  'Media & Distribution',
  'Indexed Telegram file repository with deep-link file codes, search, file metadata inspection, force-join channel protection, download analytics, and admin uploads.',
  '1.0.0',
  '{"defaultAccessLevel":"public","forceJoinChannels":[]}',
  'free',
  1,
  6
),
(
  'tpl_group_manager',
  'group-manager',
  'Group Management Bot',
  'Community Moderation',
  'Automated Telegram group welcome messages, customizable rules, banned-word filters, anti-spam flood protection, admin commands, and group moderation statistics.',
  '1.0.0',
  '{"antiSpamEnabled":true,"maxMessagesPerMinute":12,"welcomeEnabled":true}',
  'free',
  1,
  7
),
(
  'tpl_custom_builder',
  'custom-builder',
  'Custom No-Code Bot',
  'Custom Architecture',
  'Visual no-code menu, submenu, and colourful Telegram button builder with custom branding, URL links, text responses, support routing, and safe feature triggers.',
  '1.0.0',
  '{"columns":2,"keyboardType":"inline"}',
  'free',
  1,
  8
);

-- Default Platform Settings
INSERT OR IGNORE INTO platform_settings (setting_key, setting_value, description) VALUES
('promo_footer_enabled', 'true', 'Append BOT FACTORY promotional footer to eligible broadcasts'),
('promo_footer_text', '🤖 Create your own Telegram bot easily with BOT FACTORY.', 'Configurable promotional footer message'),
('promo_button_text', '🚀 Create Your Bot', 'Inline button text for promotional CTA'),
('broadcast_batch_size', '25', 'Max Telegram messages dispatched per batch tick to respect rate limits'),
('broadcast_delay_ms', '50', 'Minimum delay in ms between broadcast sends'),
('maintenance_mode', 'false', 'Pause new bot deployments during maintenance'),
('emergency_pause_broadcasts', 'false', 'Emergency kill-switch halting all running broadcast queues'),
('max_free_bots_per_user', '2', 'Maximum active bots allowed on the free plan');
