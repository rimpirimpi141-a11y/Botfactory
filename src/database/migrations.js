/**
 * D1 Migration & Schema Health Verifier.
 * Confirms all required tables and seeded templates are present in Cloudflare D1.
 */

export const REQUIRED_TABLES = [
  'users',
  'bots',
  'bot_templates',
  'bot_configs',
  'bot_features',
  'bot_menus',
  'bot_buttons',
  'bot_owners',
  'admins',
  'bot_end_users',
  'subscriptions',
  'transactions',
  'referrals',
  'giftcodes',
  'giftcode_redemptions',
  'withdrawal_requests',
  'products',
  'product_orders',
  'services',
  'service_orders',
  'file_records',
  'group_settings',
  'broadcasts',
  'broadcast_recipients',
  'bot_activity',
  'webhook_logs',
  'system_logs',
  'platform_settings',
  'usage_statistics',
];

export async function verifyDatabaseSchema(db) {
  const { rows, durationMs } = await db.all(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
  );
  const existing = new Set(rows.map((r) => r.name));
  const missing = REQUIRED_TABLES.filter((table) => !existing.has(table));

  let seededTemplates = 0;
  if (!missing.includes('bot_templates')) {
    const { row } = await db.first(`SELECT COUNT(*) AS count FROM bot_templates`);
    seededTemplates = Number(row?.count || 0);
  }

  return {
    healthy: missing.length === 0 && seededTemplates >= 7,
    tableCount: existing.size,
    missingTables: missing,
    seededTemplates,
    latencyMs: durationMs,
  };
}
