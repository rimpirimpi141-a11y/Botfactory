/**
 * Parameterized D1 Repositories for BOT FACTORY.
 * Enforces strict tenant isolation (every tenant query scopes by bot_id).
 */

import { isOwnerTelegramId } from '../utils/validation.js';
import { buildUserReferralCode, calculatePlanEntitlement } from '../core/plans-referrals.js';

export function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

export function createRepositories(db, env) {
  const users = {
    async upsertFromTelegram(tgUser) {
      const telegramId = String(tgUser.id);
      const role = isOwnerTelegramId(telegramId, env) ? 'super_admin' : 'user';
      const now = new Date().toISOString();
      const referralCode = buildUserReferralCode(telegramId);
      const existing = await this.getByTelegramId(telegramId);
      if (existing) {
        await db.run(
          `UPDATE users
           SET username = ?, first_name = ?, last_name = ?, language_code = ?,
               role = CASE WHEN ? = 'super_admin' THEN 'super_admin' ELSE role END,
               referral_code = COALESCE(referral_code, ?),
               last_active_at = ?, updated_at = ?
           WHERE telegram_id = ?`,
          [
            tgUser.username || null,
            tgUser.first_name || '',
            tgUser.last_name || '',
            tgUser.language_code || 'en',
            role,
            referralCode,
            now,
            now,
            telegramId,
          ]
        );
        const updated = await this.getByTelegramId(telegramId);
        return { ...updated, _isNewUser: false };
      }

      const id = newId('usr');
      await db.run(
        `INSERT INTO users (id, telegram_id, username, first_name, last_name, language_code, role, referral_code, last_active_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          telegramId,
          tgUser.username || null,
          tgUser.first_name || '',
          tgUser.last_name || '',
          tgUser.language_code || 'en',
          role,
          referralCode,
          now,
        ]
      );
      const created = await this.getByTelegramId(telegramId);
      return { ...created, _isNewUser: true };
    },

    async getByTelegramId(telegramId) {
      const { row } = await db.first(`SELECT * FROM users WHERE telegram_id = ?`, [String(telegramId)]);
      return row;
    },

    async getByReferralCode(code) {
      const clean = String(code || '').trim();
      if (!clean) return null;
      const { row } = await db.first(
        `SELECT * FROM users WHERE referral_code = ? OR telegram_id = ?`,
        [clean, clean.replace(/^BF/i, '')]
      );
      return row;
    },

    async countActiveBots(telegramId) {
      const { row } = await db.first(
        `SELECT COUNT(*) AS cnt FROM bots
         WHERE owner_telegram_id = ? AND status NOT IN ('deleted', 'failed')`,
        [String(telegramId)]
      );
      return Number(row?.cnt || 0);
    },

    async syncReferralMetrics(telegramId) {
      const tid = String(telegramId);
      const { row: cntRow } = await db.first(
        `SELECT COUNT(*) AS verified_count FROM platform_referrals
         WHERE referrer_telegram_id = ? AND status = 'verified'`,
        [tid]
      );
      const verified = Number(cntRow?.verified_count || 0);
      const current = await this.getByTelegramId(tid);
      if (!current) return null;

      let milestonePlan = 'free';
      if (verified >= 50) milestonePlan = 'enterprise';
      else if (verified >= 48) milestonePlan = 'pro';
      else if (verified >= 8) milestonePlan = 'starter';

      const planRank = { free: 0, starter: 1, pro: 2, enterprise: 3 };
      const nextPlan =
        (planRank[milestonePlan] ?? 0) > (planRank[current.plan] ?? 0) ? milestonePlan : current.plan;

      await db.run(
        `UPDATE users SET verified_referrals = ?, plan = ?, updated_at = ? WHERE telegram_id = ?`,
        [verified, nextPlan, new Date().toISOString(), tid]
      );
      return this.getByTelegramId(tid);
    },

    async adjustBotSlots(telegramId, bonusSlots) {
      const parsed = Math.max(-50, Math.min(1000, Math.trunc(Number(bonusSlots) || 0)));
      await db.run(
        `UPDATE users SET bonus_bot_slots = ?, updated_at = ? WHERE telegram_id = ?`,
        [parsed, new Date().toISOString(), String(telegramId)]
      );
      return this.getByTelegramId(telegramId);
    },

    async updateSupportSettings(telegramId, { supportUsername, supportMessage }) {
      await db.run(
        `UPDATE users SET support_username = ?, support_message = ?, updated_at = ? WHERE telegram_id = ?`,
        [String(supportUsername || '').trim(), String(supportMessage || '').trim().slice(0, 500), new Date().toISOString(), String(telegramId)]
      );
      return this.getByTelegramId(telegramId);
    },

    async setWizardState(telegramId, stateObj) {
      const serialized = stateObj ? JSON.stringify(stateObj) : null;
      await db.run(
        `UPDATE users SET wizard_state = ?, updated_at = ? WHERE telegram_id = ?`,
        [serialized, new Date().toISOString(), String(telegramId)]
      );
    },

    async getWizardState(telegramId) {
      const user = await this.getByTelegramId(telegramId);
      if (!user?.wizard_state) return null;
      try {
        return JSON.parse(user.wizard_state);
      } catch {
        return null;
      }
    },

    async search({ query = '', status = '', plan = '', limit = 50, offset = 0 } = {}) {
      const conditions = [];
      const params = [];
      if (query) {
        conditions.push(`(telegram_id LIKE ? OR username LIKE ? OR first_name LIKE ?)`);
        const like = `%${query}%`;
        params.push(like, like, like);
      }
      if (status) {
        conditions.push(`status = ?`);
        params.push(status);
      }
      if (plan) {
        conditions.push(`plan = ?`);
        params.push(plan);
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const { rows } = await db.all(
        `SELECT u.*,
                (SELECT COUNT(*) FROM bots b WHERE b.owner_telegram_id = u.telegram_id AND b.status != 'deleted') AS bot_count,
                (SELECT COUNT(*) FROM bots b WHERE b.owner_telegram_id = u.telegram_id AND b.status NOT IN ('deleted', 'failed')) AS active_bot_count
         FROM users u ${where}
         ORDER BY u.created_at DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );
      return rows.map((u) => ({
        ...u,
        entitlement: calculatePlanEntitlement(u, u.active_bot_count || 0),
      }));
    },

    async updatePlanAndStatus(telegramId, { plan, status, bonusBotSlots }) {
      const updates = [];
      const params = [];
      if (plan) {
        updates.push(`plan = ?`);
        params.push(plan);
      }
      if (status) {
        updates.push(`status = ?`);
        params.push(status);
      }
      if (bonusBotSlots !== undefined && bonusBotSlots !== null && bonusBotSlots !== '') {
        const parsed = Math.max(-50, Math.min(1000, Math.trunc(Number(bonusBotSlots) || 0)));
        updates.push(`bonus_bot_slots = ?`);
        params.push(parsed);
      }
      if (!updates.length) return null;
      updates.push(`updated_at = ?`);
      params.push(new Date().toISOString(), String(telegramId));
      await db.run(`UPDATE users SET ${updates.join(', ')} WHERE telegram_id = ?`, params);
      return this.getByTelegramId(telegramId);
    },
  };

  const templates = {
    async listActive() {
      const { rows } = await db.all(
        `SELECT * FROM bot_templates
         WHERE is_active = 1 AND COALESCE(is_coming_soon, 0) = 0 AND COALESCE(availability_status, 'active') = 'active'
         ORDER BY sort_order ASC`
      );
      return rows.map((r) => ({
        ...r,
        is_coming_soon: Boolean(r.is_coming_soon),
        availability_status: r.availability_status || (r.is_active ? 'active' : 'disabled'),
        default_config: safeJsonParse(r.default_config, {}),
      }));
    },

    async listAllForStudio() {
      const { rows } = await db.all(
        `SELECT t.*,
                (SELECT COUNT(*) FROM bots b WHERE b.template_id = t.id AND b.status != 'deleted') AS bots_created,
                (SELECT COUNT(*) FROM bots b WHERE b.template_id = t.id AND b.status = 'active') AS active_bots
         FROM bot_templates t
         ORDER BY t.sort_order ASC`
      );
      return rows.map((r) => ({
        ...r,
        is_coming_soon: Boolean(r.is_coming_soon),
        availability_status: r.availability_status || (r.is_coming_soon ? 'coming_soon' : r.is_active ? 'active' : 'disabled'),
        default_config: safeJsonParse(r.default_config, {}),
      }));
    },

    async getById(id) {
      const { row } = await db.first(`SELECT * FROM bot_templates WHERE id = ?`, [id]);
      if (!row) return null;
      return {
        ...row,
        is_coming_soon: Boolean(row.is_coming_soon),
        availability_status: row.availability_status || (row.is_coming_soon ? 'coming_soon' : row.is_active ? 'active' : 'disabled'),
        default_config: safeJsonParse(row.default_config, {}),
      };
    },

    async getBySlug(slug) {
      const { row } = await db.first(`SELECT * FROM bot_templates WHERE slug = ?`, [slug]);
      if (!row) return null;
      return {
        ...row,
        is_coming_soon: Boolean(row.is_coming_soon),
        availability_status: row.availability_status || (row.is_coming_soon ? 'coming_soon' : row.is_active ? 'active' : 'disabled'),
        default_config: safeJsonParse(row.default_config, {}),
      };
    },

    async updateTemplateAdmin(idOrSlug, { availabilityStatus, description, name }) {
      const existing = (await this.getById(idOrSlug)) || (await this.getBySlug(idOrSlug));
      if (!existing) throw new Error('Template not found.');
      if (existing.is_coming_soon && availabilityStatus && availabilityStatus !== 'coming_soon') {
        throw new Error('Coming Soon templates cannot be enabled until their real backend implementation is released.');
      }

      const nextStatus = availabilityStatus || existing.availability_status || 'active';
      const nextIsActive = nextStatus === 'active' && !existing.is_coming_soon ? 1 : 0;
      const nextDesc = description !== undefined ? String(description).trim() : existing.description;
      const nextName = name !== undefined ? String(name).trim() : existing.name;

      await db.run(
        `UPDATE bot_templates
         SET availability_status = ?, is_active = ?, description = ?, name = ?, updated_at = ?
         WHERE id = ?`,
        [nextStatus, nextIsActive, nextDesc, nextName, new Date().toISOString(), existing.id]
      );
      return this.getById(existing.id);
    },
  };

  const bots = {
    async create({
      id,
      ownerTelegramId,
      telegramBotId,
      telegramUsername,
      displayName,
      description,
      tokenEncrypted,
      tokenHash,
      webhookSecret,
      webhookUrl,
      templateId,
      mode = 'template',
      plan = 'free',
    }) {
      await db.run(
        `INSERT INTO bots (
          id, owner_telegram_id, telegram_bot_id, telegram_username, display_name,
          description, token_encrypted, token_hash, webhook_secret, webhook_url,
          webhook_status, template_id, mode, status, plan
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 'deploying', ?)`,
        [
          id,
          String(ownerTelegramId),
          String(telegramBotId),
          telegramUsername,
          displayName,
          description || '',
          tokenEncrypted,
          tokenHash,
          webhookSecret,
          webhookUrl,
          templateId,
          mode,
          plan,
        ]
      );

      await db.run(
        `INSERT OR IGNORE INTO bot_owners (id, bot_id, telegram_id, ownership_role) VALUES (?, ?, ?, 'owner')`,
        [newId('own'), id, String(ownerTelegramId)]
      );

      await db.run(
        `INSERT OR IGNORE INTO admins (id, bot_id, telegram_id, permissions, added_by) VALUES (?, ?, ?, '["all"]', ?)`,
        [newId('adm'), id, String(ownerTelegramId), String(ownerTelegramId)]
      );

      return this.getById(id);
    },

    async prepareRetryDeployment(
      botId,
      {
        telegramUsername,
        displayName,
        description,
        tokenEncrypted,
        tokenHash,
        webhookSecret,
        webhookUrl,
        templateId,
        mode = 'template',
        plan = 'free',
      }
    ) {
      const now = new Date().toISOString();
      await db.run(
        `UPDATE bots
         SET telegram_username = ?,
             display_name = ?,
             description = ?,
             token_encrypted = ?,
             token_hash = ?,
             webhook_secret = ?,
             webhook_url = ?,
             webhook_status = 'pending',
             webhook_last_error = NULL,
             template_id = ?,
             mode = ?,
             status = 'deploying',
             plan = ?,
             updated_at = ?
         WHERE id = ?`,
        [
          telegramUsername,
          displayName,
          description || '',
          tokenEncrypted,
          tokenHash,
          webhookSecret,
          webhookUrl,
          templateId,
          mode,
          plan,
          now,
          botId,
        ]
      );
      return this.getById(botId);
    },

    async getById(botId) {
      const { row } = await db.first(
        `SELECT b.*, t.slug AS template_slug, t.name AS template_name
         FROM bots b
         LEFT JOIN bot_templates t ON b.template_id = t.id
         WHERE b.id = ? AND b.status != 'deleted'`,
        [botId]
      );
      return row;
    },

    async findDuplicate(telegramBotId, tokenHash) {
      const { row } = await db.first(
        `SELECT id, owner_telegram_id, telegram_username, status
         FROM bots
         WHERE (telegram_bot_id = ? OR token_hash = ?) AND status != 'deleted'`,
        [String(telegramBotId), tokenHash]
      );
      return row;
    },

    async listByOwner(ownerTelegramId) {
      const { rows } = await db.all(
        `SELECT b.id, b.owner_telegram_id, b.telegram_bot_id, b.telegram_username,
                b.display_name, b.description, b.webhook_url, b.webhook_status,
                b.webhook_last_verified_at, b.webhook_last_error, b.template_id,
                t.slug AS template_slug, t.name AS template_name, b.mode, b.status,
                b.plan, b.total_updates, b.total_users, b.created_at, b.updated_at
         FROM bots b
         LEFT JOIN bot_templates t ON b.template_id = t.id
         WHERE b.owner_telegram_id = ? AND b.status != 'deleted'
         ORDER BY b.created_at DESC`,
        [String(ownerTelegramId)]
      );
      return rows;
    },

    async listAll({ query = '', status = '', templateId = '', limit = 100, offset = 0 } = {}) {
      const conditions = [`b.status != 'deleted'`];
      const params = [];
      if (query) {
        conditions.push(`(b.id LIKE ? OR b.telegram_username LIKE ? OR b.display_name LIKE ? OR b.owner_telegram_id LIKE ?)`);
        const like = `%${query}%`;
        params.push(like, like, like, like);
      }
      if (status) {
        conditions.push(`b.status = ?`);
        params.push(status);
      }
      if (templateId) {
        conditions.push(`b.template_id = ?`);
        params.push(templateId);
      }
      const { rows } = await db.all(
        `SELECT b.id, b.owner_telegram_id, b.telegram_bot_id, b.telegram_username,
                b.display_name, b.description, b.webhook_url, b.webhook_status,
                b.webhook_last_verified_at, b.webhook_last_error, b.template_id,
                t.slug AS template_slug, t.name AS template_name, b.mode, b.status,
                b.plan, b.total_updates, b.total_users, b.created_at, b.updated_at
         FROM bots b
         LEFT JOIN bot_templates t ON b.template_id = t.id
         WHERE ${conditions.join(' AND ')}
         ORDER BY b.created_at DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );
      return rows;
    },

    async updateWebhookVerification(botId, { webhookUrl, webhookStatus, botStatus, error = null }) {
      const now = new Date().toISOString();
      await db.run(
        `UPDATE bots
         SET webhook_url = COALESCE(?, webhook_url),
             webhook_status = ?,
             status = COALESCE(?, status),
             webhook_last_verified_at = CASE WHEN ? = 'verified' THEN ? ELSE webhook_last_verified_at END,
             webhook_last_error = ?,
             updated_at = ?
         WHERE id = ?`,
        [webhookUrl || null, webhookStatus, botStatus || null, webhookStatus, now, error, now, botId]
      );
      return this.getById(botId);
    },

    async setStatus(botId, status, webhookStatus = null) {
      const now = new Date().toISOString();
      await db.run(
        `UPDATE bots
         SET status = ?, webhook_status = COALESCE(?, webhook_status), updated_at = ?
         WHERE id = ?`,
        [status, webhookStatus, now, botId]
      );
      return this.getById(botId);
    },

    async softDelete(botId) {
      const now = new Date().toISOString();
      await db.run(
        `UPDATE bots SET status = 'deleted', webhook_status = 'disabled', updated_at = ? WHERE id = ?`,
        [now, botId]
      );
    },

    async incrementUpdates(botId) {
      await db.run(
        `UPDATE bots SET total_updates = total_updates + 1, updated_at = ? WHERE id = ?`,
        [new Date().toISOString(), botId]
      );
    },

    async isBotAdmin(botId, telegramId) {
      const { row } = await db.first(
        `SELECT 1 AS ok FROM admins WHERE bot_id = ? AND telegram_id = ?
         UNION
         SELECT 1 AS ok FROM bots WHERE id = ? AND owner_telegram_id = ?`,
        [botId, String(telegramId), botId, String(telegramId)]
      );
      return Boolean(row?.ok);
    },
  };

  const botConfigs = {
    async upsert(botId, cfg) {
      const now = new Date().toISOString();
      await db.run(
        `INSERT INTO bot_configs (
          bot_id, brand_title, welcome_message, welcome_image_url, logo_url,
          footer_text, support_username, theme_id, theme_config, template_settings,
          force_join_channels, promo_footer_enabled, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(bot_id) DO UPDATE SET
          brand_title = excluded.brand_title,
          welcome_message = excluded.welcome_message,
          welcome_image_url = excluded.welcome_image_url,
          logo_url = excluded.logo_url,
          footer_text = excluded.footer_text,
          support_username = excluded.support_username,
          theme_id = excluded.theme_id,
          theme_config = excluded.theme_config,
          template_settings = excluded.template_settings,
          force_join_channels = excluded.force_join_channels,
          promo_footer_enabled = excluded.promo_footer_enabled,
          updated_at = excluded.updated_at`,
        [
          botId,
          cfg.brandTitle || 'My Bot',
          cfg.welcomeMessage || 'Welcome!',
          cfg.welcomeImageUrl || null,
          cfg.logoUrl || null,
          cfg.footerText || '',
          cfg.supportUsername || '',
          cfg.themeId || 'obsidian_neon',
          JSON.stringify(cfg.themeConfig || {}),
          JSON.stringify(cfg.templateSettings || {}),
          JSON.stringify(cfg.forceJoinChannels || []),
          cfg.promoFooterEnabled === false ? 0 : 1,
          now,
        ]
      );
      return this.getByBotId(botId);
    },

    async getByBotId(botId) {
      const { row } = await db.first(`SELECT * FROM bot_configs WHERE bot_id = ?`, [botId]);
      if (!row) return null;
      return {
        botId: row.bot_id,
        brandTitle: row.brand_title,
        welcomeMessage: row.welcome_message,
        welcomeImageUrl: row.welcome_image_url,
        logoUrl: row.logo_url,
        footerText: row.footer_text,
        supportUsername: row.support_username,
        themeId: row.theme_id,
        themeConfig: safeJsonParse(row.theme_config, {}),
        templateSettings: safeJsonParse(row.template_settings, {}),
        forceJoinChannels: safeJsonParse(row.force_join_channels, []),
        promoFooterEnabled: Boolean(row.promo_footer_enabled),
        updatedAt: row.updated_at,
      };
    },
  };

  const menus = {
    async listByBotId(botId) {
      const { rows: menuRows } = await db.all(
        `SELECT * FROM bot_menus WHERE bot_id = ? ORDER BY sort_order ASC, created_at ASC`,
        [botId]
      );
      const { rows: buttonRows } = await db.all(
        `SELECT * FROM bot_buttons WHERE bot_id = ? ORDER BY row_index ASC, col_index ASC, position ASC`,
        [botId]
      );

      const byMenu = new Map();
      for (const b of buttonRows) {
        if (!byMenu.has(b.menu_id)) byMenu.set(b.menu_id, []);
        byMenu.get(b.menu_id).push({
          id: b.id,
          menuId: b.menu_id,
          label: b.label,
          emoji: b.emoji || '',
          buttonType: b.button_type,
          actionType: b.action_type,
          actionPayload: b.action_payload,
          row: b.row_index,
          col: b.col_index,
          position: b.position,
          visibility: b.visibility,
          style: b.style,
        });
      }

      return menuRows.map((m) => ({
        id: m.id,
        botId: m.bot_id,
        menuKey: m.menu_key,
        parentMenuKey: m.parent_menu_key,
        title: m.title,
        messageText: m.message_text,
        imageUrl: m.image_url,
        scope: m.menu_scope,
        keyboardType: m.keyboard_type,
        columns: m.columns,
        isRoot: Boolean(m.is_root),
        sortOrder: m.sort_order,
        buttons: byMenu.get(m.id) || [],
      }));
    },

    async replaceMenuTree(botId, menuList = []) {
      const stmts = [
        { sql: `DELETE FROM bot_buttons WHERE bot_id = ?`, params: [botId] },
        { sql: `DELETE FROM bot_menus WHERE bot_id = ?`, params: [botId] },
      ];

      menuList.forEach((menu, mIdx) => {
        const menuId = menu.id || newId('mnu');
        stmts.push({
          sql: `INSERT INTO bot_menus (
            id, bot_id, menu_key, parent_menu_key, title, message_text,
            image_url, menu_scope, keyboard_type, columns, is_root, sort_order
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [
            menuId,
            botId,
            menu.menuKey,
            menu.parentMenuKey || null,
            menu.title,
            menu.messageText,
            menu.imageUrl || null,
            menu.scope || 'user',
            menu.keyboardType || 'inline',
            Math.max(1, Math.min(4, Number(menu.columns) || 2)),
            menu.isRoot ? 1 : 0,
            menu.sortOrder ?? mIdx,
          ],
        });

        (menu.buttons || []).forEach((btn, bIdx) => {
          stmts.push({
            sql: `INSERT INTO bot_buttons (
              id, bot_id, menu_id, label, emoji, button_type, action_type,
              action_payload, row_index, col_index, position, visibility, style
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            params: [
              btn.id || newId('btn'),
              botId,
              menuId,
              btn.label,
              btn.emoji || '',
              btn.buttonType || (btn.actionType === 'url' ? 'url' : 'callback'),
              btn.actionType || 'message',
              btn.actionPayload || '',
              Number(btn.row ?? Math.floor(bIdx / (menu.columns || 2))),
              Number(btn.col ?? bIdx % (menu.columns || 2)),
              Number(btn.position ?? bIdx),
              btn.visibility || 'all',
              ['primary', 'success', 'danger', 'default'].includes(btn.style) ? btn.style : 'primary',
            ],
          });
        });
      });

      await db.batch(stmts);
      return this.listByBotId(botId);
    },
  };

  const endUsers = {
    async upsert(botId, tgUser) {
      const telegramId = String(tgUser.id);
      const now = new Date().toISOString();
      const existing = await this.get(botId, telegramId);
      if (existing) {
        await db.run(
          `UPDATE bot_end_users
           SET username = ?, first_name = ?, last_name = ?, is_blocked = 0, last_seen_at = ?
           WHERE bot_id = ? AND telegram_id = ?`,
          [tgUser.username || null, tgUser.first_name || '', tgUser.last_name || '', now, botId, telegramId]
        );
        return { user: await this.get(botId, telegramId), isNew: false };
      }

      const refCode = `REF${telegramId.slice(-5)}${crypto.randomUUID().replace(/-/g, '').slice(0, 4).toUpperCase()}`;
      await db.run(
        `INSERT INTO bot_end_users (id, bot_id, telegram_id, username, first_name, last_name, referral_code, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [newId('eu'), botId, telegramId, tgUser.username || null, tgUser.first_name || '', tgUser.last_name || '', refCode, now]
      );
      await db.run(
        `UPDATE bots SET total_users = (SELECT COUNT(*) FROM bot_end_users WHERE bot_id = ?) WHERE id = ?`,
        [botId, botId]
      );
      return { user: await this.get(botId, telegramId), isNew: true };
    },

    async get(botId, telegramId) {
      const { row } = await db.first(
        `SELECT * FROM bot_end_users WHERE bot_id = ? AND telegram_id = ?`,
        [botId, String(telegramId)]
      );
      return row;
    },

    async getByReferralCode(botId, code) {
      const { row } = await db.first(
        `SELECT * FROM bot_end_users WHERE bot_id = ? AND referral_code = ?`,
        [botId, String(code).trim()]
      );
      return row;
    },

    async setState(botId, telegramId, stateObj) {
      await db.run(
        `UPDATE bot_end_users SET state_json = ? WHERE bot_id = ? AND telegram_id = ?`,
        [stateObj ? JSON.stringify(stateObj) : null, botId, String(telegramId)]
      );
    },

    async adjustPoints(botId, telegramId, { delta, txType, referenceId = null, description = '' }) {
      const user = await this.get(botId, telegramId);
      if (!user) throw new Error('Bot user not found.');
      const nextBalance = Number((Number(user.points_balance || 0) + Number(delta)).toFixed(2));
      if (nextBalance < 0) {
        throw new Error('Insufficient points balance.');
      }
      await db.batch([
        {
          sql: `UPDATE bot_end_users SET points_balance = ? WHERE bot_id = ? AND telegram_id = ?`,
          params: [nextBalance, botId, String(telegramId)],
        },
        {
          sql: `INSERT INTO transactions (id, bot_id, user_telegram_id, tx_type, amount, balance_after, reference_id, description)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [newId('tx'), botId, String(telegramId), txType, Number(delta), nextBalance, referenceId, description],
        },
      ]);
      return nextBalance;
    },

    async recordReferral(botId, referrerTelegramId, referredTelegramId, rewardPoints) {
      if (String(referrerTelegramId) === String(referredTelegramId)) {
        return { credited: false, reason: 'Self-referrals are not allowed.' };
      }

      const { row: existingRef } = await db.first(
        `SELECT id FROM referrals WHERE bot_id = ? AND referred_telegram_id = ?`,
        [botId, String(referredTelegramId)]
      );
      if (existingRef) {
        return { credited: false, reason: 'Referral already claimed for this user.' };
      }

      const referrer = await this.get(botId, referrerTelegramId);
      if (!referrer || referrer.is_banned) {
        return { credited: false, reason: 'Referrer is invalid or ineligible.' };
      }

      const refId = newId('ref');
      await db.batch([
        {
          sql: `INSERT INTO referrals (id, bot_id, referrer_telegram_id, referred_telegram_id, reward_points, status)
                VALUES (?, ?, ?, ?, ?, 'credited')`,
          params: [refId, botId, String(referrerTelegramId), String(referredTelegramId), Number(rewardPoints)],
        },
        {
          sql: `UPDATE bot_end_users SET referred_by = ? WHERE bot_id = ? AND telegram_id = ?`,
          params: [String(referrerTelegramId), botId, String(referredTelegramId)],
        },
        {
          sql: `UPDATE bot_end_users SET referral_count = referral_count + 1 WHERE bot_id = ? AND telegram_id = ?`,
          params: [botId, String(referrerTelegramId)],
        },
      ]);

      const newBalance = await this.adjustPoints(botId, referrerTelegramId, {
        delta: Number(rewardPoints),
        txType: 'referral_bonus',
        referenceId: refId,
        description: `Referral reward for inviting user ${referredTelegramId}`,
      });

      return { credited: true, newBalance, referralId: refId };
    },

    async markBlocked(botId, telegramId) {
      await db.run(
        `UPDATE bot_end_users SET is_blocked = 1 WHERE bot_id = ? AND telegram_id = ?`,
        [botId, String(telegramId)]
      );
    },

    async leaderboard(botId, limit = 10) {
      const { rows } = await db.all(
        `SELECT telegram_id, username, first_name, referral_count, points_balance
         FROM bot_end_users
         WHERE bot_id = ? AND is_banned = 0
         ORDER BY referral_count DESC, points_balance DESC
         LIMIT ?`,
        [botId, limit]
      );
      return rows;
    },
  };

  const broadcasts = {
    async create({
      scope,
      targetBotIds = [],
      targetUserIds = [],
      messageText,
      imageUrl = null,
      inlineButtons = [],
      includePromoFooter = true,
      createdBy,
    }) {
      const id = newId('brc');
      await db.run(
        `INSERT INTO broadcasts (
          id, scope, target_bot_ids, target_user_ids, message_text, image_url,
          inline_buttons, include_promo_footer, status, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`,
        [
          id,
          scope,
          JSON.stringify(targetBotIds),
          JSON.stringify(targetUserIds),
          messageText,
          imageUrl,
          JSON.stringify(inlineButtons),
          includePromoFooter ? 1 : 0,
          String(createdBy),
        ]
      );
      return this.getById(id);
    },

    async getById(id) {
      const { row } = await db.first(`SELECT * FROM broadcasts WHERE id = ?`, [id]);
      if (!row) return null;
      return {
        ...row,
        target_bot_ids: safeJsonParse(row.target_bot_ids, []),
        target_user_ids: safeJsonParse(row.target_user_ids, []),
        inline_buttons: safeJsonParse(row.inline_buttons, []),
        include_promo_footer: Boolean(row.include_promo_footer),
      };
    },

    async list(limit = 50) {
      const { rows } = await db.all(`SELECT * FROM broadcasts ORDER BY created_at DESC LIMIT ?`, [limit]);
      return rows.map((row) => ({
        ...row,
        target_bot_ids: safeJsonParse(row.target_bot_ids, []),
        target_user_ids: safeJsonParse(row.target_user_ids, []),
        inline_buttons: safeJsonParse(row.inline_buttons, []),
        include_promo_footer: Boolean(row.include_promo_footer),
      }));
    },
  };

  const stats = {
    async recordWebhook(botId, { updateId = null, statusCode = 200, durationMs = 0, errorMessage = null }) {
      const today = new Date().toISOString().slice(0, 10);
      const isErr = statusCode >= 400 || Boolean(errorMessage) ? 1 : 0;
      await db.batch([
        {
          sql: `INSERT INTO webhook_logs (id, bot_id, update_id, status_code, duration_ms, error_message)
                VALUES (?, ?, ?, ?, ?, ?)`,
          params: [newId('wh'), botId, updateId, statusCode, Math.round(durationMs), errorMessage],
        },
        {
          sql: `INSERT INTO usage_statistics (id, stat_date, bot_id, requests_count, errors_count, total_duration_ms)
                VALUES (?, ?, ?, 1, ?, ?)
                ON CONFLICT(stat_date, bot_id) DO UPDATE SET
                  requests_count = requests_count + 1,
                  errors_count = errors_count + excluded.errors_count,
                  total_duration_ms = total_duration_ms + excluded.total_duration_ms,
                  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
          params: [newId('st'), today, botId, isErr, Math.round(durationMs)],
        },
      ]);
    },

    async recordActivity(botId, { userTelegramId = null, eventType, featureKey = null, durationMs = 0 }) {
      await db.run(
        `INSERT INTO bot_activity (id, bot_id, user_telegram_id, event_type, feature_key, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [newId('act'), botId, userTelegramId ? String(userTelegramId) : null, eventType, featureKey, Math.round(durationMs)]
      );
    },

    async getPlatformOverview() {
      const today = new Date().toISOString().slice(0, 10);
      const todayPrefix = `${today}%`;
      const monthPrefix = `${today.slice(0, 7)}%`;

      const [
        usersRes,
        botsRes,
        todayRes,
        monthRes,
        txRes,
        logsErrRes,
        dailySeriesRes,
        refRes,
      ] = await Promise.all([
        db.first(
          `SELECT COUNT(*) AS total_users,
                  SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_users,
                  SUM(CASE WHEN plan != 'free' THEN 1 ELSE 0 END) AS premium_users,
                  SUM(CASE WHEN plan = 'free' THEN 1 ELSE 0 END) AS free_users,
                  SUM(CASE WHEN plan = 'starter' THEN 1 ELSE 0 END) AS starter_users,
                  SUM(CASE WHEN plan = 'pro' THEN 1 ELSE 0 END) AS pro_users,
                  SUM(CASE WHEN plan = 'enterprise' THEN 1 ELSE 0 END) AS enterprise_users
           FROM users`
        ),
        db.first(
          `SELECT COUNT(*) AS total_bots,
                  SUM(CASE WHEN status = 'active' AND webhook_status = 'verified' THEN 1 ELSE 0 END) AS active_bots,
                  SUM(CASE WHEN status = 'disabled' THEN 1 ELSE 0 END) AS disabled_bots,
                  SUM(CASE WHEN status = 'failed' OR webhook_status = 'failed' THEN 1 ELSE 0 END) AS failed_deployments,
                  SUM(CASE WHEN created_at LIKE ? THEN 1 ELSE 0 END) AS bots_today,
                  SUM(CASE WHEN created_at LIKE ? THEN 1 ELSE 0 END) AS bots_month,
                  COALESCE(SUM(total_updates), 0) AS total_webhook_updates
           FROM bots WHERE status != 'deleted'`,
          [todayPrefix, monthPrefix]
        ),
        db.first(
          `SELECT COALESCE(SUM(requests_count), 0) AS requests_today,
                  COALESCE(SUM(errors_count), 0) AS errors_today,
                  COALESCE(SUM(total_duration_ms), 0) AS duration_today
           FROM usage_statistics WHERE stat_date = ?`,
          [today]
        ),
        db.first(
          `SELECT COALESCE(SUM(requests_count), 0) AS requests_month,
                  COALESCE(SUM(errors_count), 0) AS errors_month,
                  COALESCE(SUM(total_duration_ms), 0) AS duration_month
           FROM usage_statistics WHERE stat_date LIKE ?`,
          [monthPrefix]
        ),
        db.first(`SELECT COUNT(*) AS total_transactions FROM transactions`),
        db.first(`SELECT COUNT(*) AS worker_errors FROM webhook_logs WHERE status_code >= 400`),
        db.all(
          `SELECT stat_date, SUM(requests_count) AS requests, SUM(errors_count) AS errors
           FROM usage_statistics
           GROUP BY stat_date
           ORDER BY stat_date DESC
           LIMIT 14`
        ),
        db
          .first(
            `SELECT COUNT(*) AS total_referrals,
                    SUM(CASE WHEN status = 'verified' THEN 1 ELSE 0 END) AS verified_referrals,
                    SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_referrals
             FROM platform_referrals`
          )
          .catch(() => ({ row: { total_referrals: 0, verified_referrals: 0, pending_referrals: 0 } })),
      ]);

      const reqMonth = Number(monthRes.row?.requests_month || 0);
      const durMonth = Number(monthRes.row?.duration_month || 0);

      return {
        totalUsers: Number(usersRes.row?.total_users || 0),
        activeUsers: Number(usersRes.row?.active_users || 0),
        premiumUsers: Number(usersRes.row?.premium_users || 0),
        freeUsers: Number(usersRes.row?.free_users || 0),
        starterUsers: Number(usersRes.row?.starter_users || 0),
        proUsers: Number(usersRes.row?.pro_users || 0),
        enterpriseUsers: Number(usersRes.row?.enterprise_users || 0),
        totalReferrals: Number(refRes.row?.total_referrals || 0),
        verifiedReferrals: Number(refRes.row?.verified_referrals || 0),
        pendingReferrals: Number(refRes.row?.pending_referrals || 0),
        totalBots: Number(botsRes.row?.total_bots || 0),
        activeBots: Number(botsRes.row?.active_bots || 0),
        disabledBots: Number(botsRes.row?.disabled_bots || 0),
        failedDeployments: Number(botsRes.row?.failed_deployments || 0),
        botsCreatedToday: Number(botsRes.row?.bots_today || 0),
        botsCreatedThisMonth: Number(botsRes.row?.bots_month || 0),
        totalWebhookUpdates: Number(botsRes.row?.total_webhook_updates || 0),
        requestsToday: Number(todayRes.row?.requests_today || 0),
        requestsThisMonth: reqMonth,
        workerErrors: Number(logsErrRes.row?.worker_errors || 0),
        avgResponseTimeMs: reqMonth > 0 ? Math.round(durMonth / reqMonth) : null,
        totalTransactions: Number(txRes.row?.total_transactions || 0),
        dailySeries: (dailySeriesRes.rows || []).reverse(),
        lastUpdated: new Date().toISOString(),
      };
    },

    async getRecentLogs({ level = '', limit = 100 } = {}) {
      const where = level ? `WHERE level = ?` : '';
      const params = level ? [level, limit] : [limit];
      const { rows } = await db.all(
        `SELECT * FROM system_logs ${where} ORDER BY created_at DESC LIMIT ?`,
        params
      );
      return rows.map((r) => ({ ...r, metadata: safeJsonParse(r.metadata, {}) }));
    },

    async getSettings() {
      const { rows } = await db.all(`SELECT * FROM platform_settings ORDER BY setting_key ASC`);
      const map = {};
      for (const r of rows) {
        map[r.setting_key] = r.setting_value;
      }
      return { map, rows };
    },

    async setSetting(key, value, updatedBy = 'owner') {
      await db.run(
        `INSERT INTO platform_settings (setting_key, setting_value, updated_by, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(setting_key) DO UPDATE SET
           setting_value = excluded.setting_value,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
        [key, String(value), String(updatedBy), new Date().toISOString()]
      );
    },
  };

  const platformReferrals = {
    async getByReferred(referredTelegramId) {
      const { row } = await db.first(
        `SELECT * FROM platform_referrals WHERE referred_telegram_id = ?`,
        [String(referredTelegramId)]
      );
      return row;
    },

    async createVerified({ referrerTelegramId, referredTelegramId, reason = '' }) {
      const id = newId('pref');
      const now = new Date().toISOString();
      await db.batch([
        {
          sql: `INSERT INTO platform_referrals (id, referrer_telegram_id, referred_telegram_id, status, reason, verified_at, created_at)
                VALUES (?, ?, ?, 'verified', ?, ?, ?)`,
          params: [id, String(referrerTelegramId), String(referredTelegramId), reason, now, now],
        },
        {
          sql: `UPDATE users SET referred_by = ?, updated_at = ? WHERE telegram_id = ?`,
          params: [String(referrerTelegramId), now, String(referredTelegramId)],
        },
      ]);
      const { row } = await db.first(`SELECT * FROM platform_referrals WHERE id = ?`, [id]);
      return row;
    },

    async createPending({ referrerTelegramId, referredTelegramId, reason = 'Awaiting review' }) {
      const id = newId('pref');
      const now = new Date().toISOString();
      await db.run(
        `INSERT INTO platform_referrals (id, referrer_telegram_id, referred_telegram_id, status, reason, created_at)
         VALUES (?, ?, ?, 'pending', ?, ?)`,
        [id, String(referrerTelegramId), String(referredTelegramId), reason, now]
      );
      const { row } = await db.first(`SELECT * FROM platform_referrals WHERE id = ?`, [id]);
      return row;
    },

    async listByReferrer(referrerTelegramId, limit = 50) {
      const { rows } = await db.all(
        `SELECT r.*, u.username AS referred_username, u.first_name AS referred_first_name
         FROM platform_referrals r
         LEFT JOIN users u ON u.telegram_id = r.referred_telegram_id
         WHERE r.referrer_telegram_id = ?
         ORDER BY r.created_at DESC LIMIT ?`,
        [String(referrerTelegramId), limit]
      );
      return rows;
    },

    async countPendingByReferrer(referrerTelegramId) {
      const { row } = await db.first(
        `SELECT COUNT(*) AS cnt FROM platform_referrals WHERE referrer_telegram_id = ? AND status = 'pending'`,
        [String(referrerTelegramId)]
      );
      return Number(row?.cnt || 0);
    },

    async getSummary(referrerTelegramId) {
      const tid = String(referrerTelegramId);
      const [aggRes, recent] = await Promise.all([
        db.first(
          `SELECT COUNT(*) AS total,
                  SUM(CASE WHEN status = 'verified' THEN 1 ELSE 0 END) AS verified,
                  SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
                  SUM(CASE WHEN status = 'flagged' THEN 1 ELSE 0 END) AS flagged,
                  SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected
           FROM platform_referrals
           WHERE referrer_telegram_id = ?`,
          [tid]
        ),
        this.listByReferrer(tid, 10),
      ]);
      return {
        total: Number(aggRes.row?.total || 0),
        verified: Number(aggRes.row?.verified || 0),
        pending: Number(aggRes.row?.pending || 0),
        flagged: Number(aggRes.row?.flagged || 0),
        rejected: Number(aggRes.row?.rejected || 0),
        recent,
      };
    },

    async listAll({ status = '', limit = 100 } = {}) {
      const where = status ? `WHERE r.status = ?` : '';
      const params = status ? [status, limit] : [limit];
      const { rows } = await db.all(
        `SELECT r.*,
                ru.username AS referrer_username, ru.first_name AS referrer_first_name, ru.referral_code AS referral_code,
                tu.username AS referred_username, tu.first_name AS referred_first_name
         FROM platform_referrals r
         LEFT JOIN users ru ON ru.telegram_id = r.referrer_telegram_id
         LEFT JOIN users tu ON tu.telegram_id = r.referred_telegram_id
         ${where}
         ORDER BY r.created_at DESC LIMIT ?`,
        params
      );
      return rows;
    },

    async updateStatus(referralId, { status, reviewedBy, reason = '' }) {
      const { row: existing } = await db.first(`SELECT * FROM platform_referrals WHERE id = ?`, [referralId]);
      if (!existing) throw new Error('Referral record not found.');
      const now = new Date().toISOString();
      await db.run(
        `UPDATE platform_referrals
         SET status = ?, reviewed_by = ?, reason = COALESCE(NULLIF(?, ''), reason),
             verified_at = CASE WHEN ? = 'verified' THEN ? ELSE verified_at END
         WHERE id = ?`,
        [status, String(reviewedBy), reason, status, now, referralId]
      );
      await users.syncReferralMetrics(existing.referrer_telegram_id);
      const { row: updated } = await db.first(`SELECT * FROM platform_referrals WHERE id = ?`, [referralId]);
      return updated;
    },
  };

  const platformAdmins = {
    async list() {
      const { rows } = await db.all(
        `SELECT pa.*, u.username AS username
         FROM platform_admins pa
         LEFT JOIN users u ON u.telegram_id = pa.telegram_id
         ORDER BY pa.created_at DESC`
      );
      return rows.map((r) => ({
        ...r,
        status: 'active',
        permissions: safeJsonParse(r.permissions, []),
      }));
    },

    async getByTelegramId(telegramId) {
      const { row } = await db.first(
        `SELECT pa.*, u.username AS username
         FROM platform_admins pa
         LEFT JOIN users u ON u.telegram_id = pa.telegram_id
         WHERE pa.telegram_id = ?`,
        [String(telegramId)]
      );
      if (!row) return null;
      return { ...row, status: 'active', permissions: safeJsonParse(row.permissions, []) };
    },

    async isAuthorized(telegramId) {
      if (isOwnerTelegramId(telegramId, env)) return { authorized: true, isSuperAdmin: true, permissions: ['all'] };
      const record = await this.getByTelegramId(telegramId);
      if (!record) return { authorized: false, isSuperAdmin: false, permissions: [] };
      return { authorized: true, isSuperAdmin: false, role: record.role, permissions: record.permissions };
    },

    async upsert({ telegramId, role = 'admin', permissions = ['overview', 'users', 'bots', 'support', 'logs'], addedBy = 'owner' }) {
      const tid = String(telegramId).trim();
      if (!/^\d{4,20}$/.test(tid)) throw new Error('Valid numeric Telegram ID is required.');
      if (isOwnerTelegramId(tid, env)) {
        throw new Error('Super Admin permissions are immutable and cannot be modified here.');
      }
      const now = new Date().toISOString();
      const safePerms = Array.isArray(permissions)
        ? permissions
        : permissions && typeof permissions === 'object'
          ? Object.entries(permissions).filter(([, v]) => Boolean(v)).map(([k]) => k)
          : ['overview', 'users', 'bots', 'support', 'logs'];
      await db.run(
        `INSERT INTO platform_admins (id, telegram_id, role, permissions, added_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(telegram_id) DO UPDATE SET
           role = excluded.role,
           permissions = excluded.permissions,
           updated_at = excluded.updated_at`,
        [newId('padm'), tid, role === 'moderator' ? 'moderator' : 'admin', JSON.stringify(safePerms), String(addedBy), now, now]
      );
      return this.getByTelegramId(tid);
    },

    async add(opts) {
      return this.upsert(opts);
    },

    async remove(telegramId, actorTelegramId) {
      const tid = String(telegramId).trim();
      if (isOwnerTelegramId(tid, env)) {
        throw new Error('Super Admin cannot be removed or overridden by any admin.');
      }
      if (!isOwnerTelegramId(actorTelegramId, env)) {
        throw new Error('Only Super Admin can remove platform admins.');
      }
      await db.run(`DELETE FROM platform_admins WHERE telegram_id = ?`, [tid]);
      return { removed: true, telegramId: tid };
    },
  };

  const VALID_PAYMENT_ORDER_TYPES = new Set([
    'smm_deposit',
    'apk_order',
    'voucher_order',
    'digital_order',
    'custom_order',
  ]);

  const payments = {
    async createProof({
      botId,
      userTelegramId,
      endUserId,
      orderType,
      referenceType,
      referenceId = null,
      itemTitle = '',
      amount = 0,
      currency = 'INR',
      paymentMethod = 'upi_manual',
      utrNumber = '',
      screenshotFileId = null,
      proofFileId = null,
    }) {
      const id = newId('pay');
      const now = new Date().toISOString();
      const resolvedUserId = String(userTelegramId ?? endUserId ?? '');
      const rawType = String(orderType ?? referenceType ?? 'digital_order').trim();
      const normalizedType = VALID_PAYMENT_ORDER_TYPES.has(rawType)
        ? rawType
        : rawType === 'apk_purchase'
          ? 'apk_order'
          : rawType === 'voucher_purchase'
            ? 'voucher_order'
            : 'digital_order';
      const resolvedFileId = screenshotFileId ?? proofFileId ?? null;

      await db.run(
        `INSERT INTO payment_proofs (
          id, bot_id, user_telegram_id, order_type, reference_id, item_title,
          amount, currency, payment_method, utr_number, screenshot_file_id, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        [
          id,
          botId,
          resolvedUserId,
          normalizedType,
          referenceId,
          String(itemTitle).slice(0, 120),
          Number(amount || 0),
          currency,
          paymentMethod,
          String(utrNumber || '').trim().slice(0, 64),
          resolvedFileId,
          now,
          now,
        ]
      );
      const { row } = await db.first(`SELECT * FROM payment_proofs WHERE id = ?`, [id]);
      return row;
    },

    async getById(botId, proofId) {
      const { row } = await db.first(
        `SELECT * FROM payment_proofs WHERE id = ? AND bot_id = ?`,
        [proofId, botId]
      );
      return row;
    },

    async listPending(botId, limit = 20) {
      const { rows } = await db.all(
        `SELECT * FROM payment_proofs WHERE bot_id = ? AND status = 'pending' ORDER BY created_at ASC LIMIT ?`,
        [botId, limit]
      );
      return rows;
    },

    async listByUser(botId, userTelegramId, limit = 15) {
      const { rows } = await db.all(
        `SELECT * FROM payment_proofs WHERE bot_id = ? AND user_telegram_id = ? ORDER BY created_at DESC LIMIT ?`,
        [botId, String(userTelegramId), limit]
      );
      return rows;
    },

    /**
     * Atomically transitions a pending payment proof to approved.
     * Prevents duplicate approvals or double deliveries via conditional WHERE status = 'pending'.
     */
    async approveProof(botId, proofId, reviewedBy, reviewNote = 'Verified by admin') {
      const now = new Date().toISOString();
      const { meta } = await db.run(
        `UPDATE payment_proofs
         SET status = 'approved', reviewed_by = ?, review_note = ?, updated_at = ?
         WHERE id = ? AND bot_id = ? AND status = 'pending'`,
        [String(reviewedBy), reviewNote, now, proofId, botId]
      );
      if (!meta?.changes) {
        return { transitioned: false, approved: false, reason: 'Payment proof was already processed or not found.' };
      }
      const proof = await this.getById(botId, proofId);
      return { transitioned: true, approved: true, proof };
    },

    async rejectProof(botId, proofId, reviewedBy, reviewNote = 'Rejected by admin') {
      const now = new Date().toISOString();
      const { meta } = await db.run(
        `UPDATE payment_proofs
         SET status = 'rejected', reviewed_by = ?, review_note = ?, updated_at = ?
         WHERE id = ? AND bot_id = ? AND status = 'pending'`,
        [String(reviewedBy), reviewNote, now, proofId, botId]
      );
      if (!meta?.changes) {
        return { transitioned: false, rejected: false, reason: 'Payment proof was already processed or not found.' };
      }
      const proof = await this.getById(botId, proofId);
      return { transitioned: true, rejected: true, proof };
    },
  };

  const deployments = {
    async record({ botId = null, ownerTelegramId, templateId = null, stage, status, webhookUrl = null, errorMessage = null }) {
      try {
        await db.run(
          `INSERT INTO deployment_logs (id, bot_id, owner_telegram_id, template_id, stage, status, webhook_url, error_message)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [newId('dep'), botId, String(ownerTelegramId), templateId, stage, status, webhookUrl, errorMessage]
        );
      } catch {
        // Non-fatal if migration 0003 hasn't been applied on an older environment yet
      }
    },

    async listRecent(limit = 50) {
      try {
        const { rows } = await db.all(
          `SELECT d.*, t.slug AS template_slug, t.name AS template_name
           FROM deployment_logs d
           LEFT JOIN bot_templates t ON d.template_id = t.id
           ORDER BY d.created_at DESC LIMIT ?`,
          [limit]
        );
        return rows.map((r) => ({
          ...r,
          template_slug: r.template_slug || r.template_id || null,
          detail: r.error_message || r.webhook_url || r.stage || '',
        }));
      } catch {
        return [];
      }
    },
  };

  return {
    users,
    templates,
    bots,
    botConfigs,
    menus,
    endUsers,
    broadcasts,
    stats,
    platformReferrals,
    platformAdmins,
    payments,
    deployments,
    db,
  };
}

function safeJsonParse(str, fallback) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}
