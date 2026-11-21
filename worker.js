/**
 * BOT FACTORY — Central Multi-Tenant Cloudflare Worker Entry Point.
 *
 * One shared Worker serves:
 * - Master Bot webhook (/webhook/master)
 * - Every created tenant bot (/webhook/:botId) with strict tenant isolation
 * - Owner Control Plane REST API (/api/*)
 * - Scheduled Cron handler for resumable rate-limited Global Broadcasts AND Channel Automation scheduled posts
 */

import { routeRequest } from './src/core/router.js';
import { createDbClient } from './src/database/db.js';
import { createRepositories } from './src/database/repositories.js';
import { createTelegramClient } from './src/core/telegram-api.js';
import { processBroadcastBatch } from './src/admin/broadcast.js';
import { dispatchDueScheduledPosts } from './src/templates/channel-automation/index.js';
import { writeSystemLog } from './src/utils/logger.js';

export default {
  async fetch(request, env, ctx) {
    return routeRequest(request, env, ctx);
  },

  async scheduled(_event, env, ctx) {
    if (!env?.DB) return;
    ctx.waitUntil(
      (async () => {
        try {
          const db = createDbClient(env.DB);
          const repos = createRepositories(db, env);
          const telegram = createTelegramClient();
          await processBroadcastBatch({ env, repos, telegram });
          await dispatchDueScheduledPosts({ env, repos, telegram, limit: 20 });
        } catch (err) {
          await writeSystemLog(env, {
            level: 'error',
            source: 'cron-worker',
            message: err?.message || 'Scheduled cron tick failed',
          });
        }
      })()
    );
  },
};
