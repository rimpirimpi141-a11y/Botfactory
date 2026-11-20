/**
 * Usage Analytics Engine.
 * - Writes real event points to Cloudflare Workers Analytics Engine (env.ANALYTICS) when bound.
 * - Aggregates real D1 application-level counters (never fabricated).
 */

export function trackAnalyticsEvent(env, { eventType, botId = 'platform', templateSlug = 'none', statusCode = 200, durationMs = 0, cacheHit = false }) {
  if (!env?.ANALYTICS || typeof env.ANALYTICS.writeDataPoint !== 'function') {
    return false;
  }

  try {
    env.ANALYTICS.writeDataPoint({
      blobs: [String(eventType), String(botId), String(templateSlug), cacheHit ? 'hit' : 'miss'],
      doubles: [Number(statusCode) || 200, Number(durationMs) || 0, 1],
      indexes: [String(botId).slice(0, 32)],
    });
    return true;
  } catch {
    return false;
  }
}

export async function getApplicationAnalytics(repos) {
  const overview = await repos.stats.getPlatformOverview();
  const { rows: topBots } = await repos.db.all(
    `SELECT b.id, b.telegram_username, b.display_name, t.name AS template_name,
            b.total_users, b.total_updates, b.status, b.webhook_status
     FROM bots b
     LEFT JOIN bot_templates t ON b.template_id = t.id
     WHERE b.status != 'deleted'
     ORDER BY b.total_updates DESC
     LIMIT 10`
  );

  const { rows: featureBreakdown } = await repos.db.all(
    `SELECT COALESCE(feature_key, event_type) AS feature, COUNT(*) AS count
     FROM bot_activity
     WHERE created_at >= datetime('now', '-30 days')
     GROUP BY COALESCE(feature_key, event_type)
     ORDER BY count DESC
     LIMIT 12`
  );

  const { row: uniqueActive } = await repos.db.first(
    `SELECT COUNT(DISTINCT user_telegram_id) AS count
     FROM bot_activity
     WHERE user_telegram_id IS NOT NULL AND created_at >= datetime('now', '-30 days')`
  );

  return {
    source: 'd1_application_counters',
    overview,
    uniqueActiveUsers30d: Number(uniqueActive?.count || 0),
    topBots,
    featureBreakdown,
    lastUpdated: new Date().toISOString(),
  };
}
