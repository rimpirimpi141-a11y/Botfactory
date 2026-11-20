# BOT FACTORY — Build. Customize. Deploy.

A complete, production-ready **multi-tenant Telegram Bot Creation Platform** running on **Cloudflare Workers**, **Cloudflare D1**, **Cloudflare KV**, and **Cloudflare Analytics Engine**, paired with a dark-themed **React + TypeScript Owner Control Plane & Visual No-Code Bot Builder**.

One central Cloudflare Worker powers the **BOT FACTORY Master Bot** and every created tenant bot through isolated webhook endpoints (`/webhook/:botId`) with AES-256-GCM encrypted credentials, native colourful Telegram button styles (`success` / `primary` / `danger`), automated webhook verification, animated Telegram deployment progress, 7 modular prebuilt templates, a custom no-code menu/button builder, global resumable broadcasts, and Cloudflare infrastructure monitoring.

---

## Architecture Overview

- **Central Multi-Tenant Worker (`worker.js` + `src/core/router.js`)**:
  - `POST /webhook/master` — BOT FACTORY Master Bot (verified via `X-Telegram-Bot-Api-Secret-Token` against `MASTER_WEBHOOK_SECRET`).
  - `POST /webhook/:botId` — Isolated tenant bot execution engine (verified per-bot against `bots.webhook_secret`).
  - `GET /api/health` — Non-sensitive readiness & D1 schema health check.
  - `/api/*` — Owner Control Plane REST API (verified via constant-time `Authorization: Bearer <ADMIN_API_KEY>`).
  - `scheduled` Cron trigger (`*/2 * * * *`) — Resumes rate-limited Global Broadcast batches automatically.
- **Database (`migrations/0001_initial_schema.sql`, `migrations/0002_seed_templates.sql`)**:
  - **Cloudflare D1** is the authoritative relational source of truth across 28 normalized tables with foreign keys, unique constraints, and indexes.
  - **Cloudflare KV** caches hot tenant configurations (`tenant:cfg:<botId>`) with immediate invalidation on config/menu mutation, plus rate-limiting and webhook `update_id` deduplication.
  - **Cloudflare Analytics Engine** records per-tenant execution events (`env.ANALYTICS.writeDataPoint`).
- **Security**:
  - Bot tokens are validated via real Telegram `getMe`, fingerprinted via SHA-256 for duplicate prevention, and encrypted with **AES-256-GCM** using Web Crypto API (`TOKEN_ENCRYPTION_KEY` secret).
  - Structured logger (`src/utils/logger.js`) automatically redacts bot tokens, Bearer tokens, and secret fields before writing to console or `system_logs`.
  - Bots are marked `active` **only** after real `setWebhook` AND `getWebhookInfo` confirm exact URL matching.

---

## Project Structure

```text
/worker.js                             # Central Cloudflare Worker entrypoint (fetch + scheduled)
/wrangler.jsonc                        # Cloudflare Workers config (D1, KV, Analytics Engine, Cron)
/migrations/
  0001_initial_schema.sql              # Full multi-tenant D1 schema
  0002_seed_templates.sql              # Seeds 7 prebuilt templates, custom builder & defaults
/src/
  core/
    router.js                          # Webhook + Owner REST API router
    bot-engine.js                      # Isolated tenant runtime executor
    tenant-manager.js                  # KV-cached tenant loader & 10-step deployment pipeline
    webhook-manager.js                 # setWebhook, getWebhookInfo verification & secret header check
    telegram-api.js                    # Native fetch Telegram Bot API client (preserves button `style`)
    token-security.js                  # Web Crypto AES-256-GCM encryption & constant-time compare
    master-bot.js                      # BOT FACTORY Master Bot & 10-step guided wizard
  templates/
    index.js                           # Modular template registry
    refer-earn/index.js                # Template 1: Refer & Earn Bot
    email-services/index.js            # Template 2: Legitimate Email & Digital Services Marketplace
    tool-bot/index.js                  # Template 3: Modular Tool Bot
    smm-panel/index.js                 # Template 4: Legitimate SMM Services Panel Bot
    digital-products/index.js          # Template 5: Digital Product Store Bot
    file-store/index.js                # Template 6: File Store Bot
    group-manager/index.js             # Template 7: Group Management Bot
  builder/
    builder.js                         # Custom no-code bot runtime
    menu-builder.js                    # Multi-submenu tree validation & starter blueprint
    button-builder.js                  # Safe declarative button builder (no arbitrary code execution)
    theme-engine.js                    # Theme presets & branded Telegram HTML formatter
    preview.js                         # Live Telegram keyboard preview compiler
  admin/
    owner-panel.js                     # Telegram Super Admin Control Center (ADMIN_TELEGRAM_ID)
    user-management.js                 # User search, plan updates, suspend/restore
    bot-management.js                  # All-bots inspector, disable/enable, retry webhook, delete
    analytics.js                       # Cloudflare Analytics Engine + D1 application metrics
    broadcast.js                       # Global/targeted broadcast batching & 403 block handling
    cloudflare-monitor.js              # Official Cloudflare GraphQL & REST infrastructure monitor
  database/
    db.js                              # Parameterized D1 client wrapper
    migrations.js                      # Schema verifier
    repositories.js                    # Tenant-isolated D1 repositories
  utils/
    animations.js                      # Rate-limit-safe editMessageText progress engine
    keyboards.js                       # Colourful Telegram button factory (success/primary/danger)
    validation.js                      # Input, token, URL & anti-injection validation
    logger.js                          # Secret-redacting structured logger
    rate-limiter.js                    # KV sliding-window rate limiter & update deduplicator
  dashboard/                           # React + TypeScript Control Plane & Visual No-Code Builder
/tests/
  bot-factory.test.mjs                 # Automated Node 22 test suite
```

---

## Step-by-Step Cloudflare Setup & Deployment

> **Important:** No Cloudflare resource IDs or secrets are hardcoded in this repository. Follow the steps below to provision your own Cloudflare resources.

### 1. Prerequisites
- A Cloudflare account with Workers, D1, KV, and Analytics Engine enabled.
- Node.js 22+ and Wrangler CLI (`npm i -g wrangler` or `npx wrangler`).
- A Telegram Master Bot created via official **@BotFather** (`/newbot`).
- Your numeric Telegram User ID (obtain via `@userinfobot` or Telegram API) for `ADMIN_TELEGRAM_ID`.

### 2. Authenticate Wrangler
```bash
npx wrangler login
```

### 3. Create Cloudflare D1 Database & KV Namespace
```bash
npx wrangler d1 create bot_factory_db
npx wrangler kv namespace create BOT_FACTORY_KV
```
Copy the returned real `database_id` and KV `id` into `/wrangler.jsonc`, replacing:
- `REPLACE_WITH_YOUR_D1_DATABASE_ID`
- `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`

Also update the public `[vars]` in `/wrangler.jsonc`:
- `WORKER_PUBLIC_URL`: Your real deployed URL (e.g. `https://bot-factory.your-subdomain.workers.dev`)
- `MASTER_BOT_USERNAME`: Your real Master Bot username without `@`
- `ADMIN_TELEGRAM_ID`: Your numeric Telegram owner ID

### 4. Run Cloudflare D1 SQL Migrations
```bash
# Local testing D1
npm run db:migrate:local

# Production remote Cloudflare D1
npm run db:migrate:remote
```

### 5. Configure Encrypted Cloudflare Worker Secrets
Generate a 32-byte base64 AES-GCM encryption key and random secrets:
```bash
openssl rand -base64 32   # Use for TOKEN_ENCRYPTION_KEY
openssl rand -hex 32      # Use for MASTER_WEBHOOK_SECRET
openssl rand -hex 32      # Use for ADMIN_API_KEY
```

Store all secrets securely in Cloudflare (never commit to Git):
```bash
npx wrangler secret put MASTER_BOT_TOKEN
npx wrangler secret put MASTER_WEBHOOK_SECRET
npx wrangler secret put TOKEN_ENCRYPTION_KEY
npx wrangler secret put ADMIN_API_KEY
```

#### Optional Secrets (Cloudflare Infrastructure Monitor & Tool Bot AI Utility)
To enable official Cloudflare GraphQL & REST infrastructure metrics (Workers, D1, KV), create a least-privilege Cloudflare API Token with permissions:
- `Account` -> `Account Analytics` -> `Read`
- `Account` -> `Workers Scripts` -> `Read`
- `Account` -> `D1` -> `Read`
- `Account` -> `Workers KV Storage` -> `Read`

Then set:
```bash
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
npx wrangler secret put CLOUDFLARE_API_TOKEN
npx wrangler secret put CLOUDFLARE_D1_DATABASE_ID
npx wrangler secret put CLOUDFLARE_KV_NAMESPACE_ID
```

To enable the optional AI module inside Template 3 (Tool Bot):
```bash
npx wrangler secret put GEMINI_API_KEY
```

### 6. Deploy the Central Multi-Tenant Worker
```bash
npm run worker:deploy
```

### 7. Register & Verify the Master Bot Webhook
Either click **"Register & Verify Master Bot Webhook"** inside the React Control Plane (`Connect Worker` modal), OR run:
```bash
curl -X POST "https://bot-factory.YOUR-SUBDOMAIN.workers.dev/api/master/register-webhook" \
  -H "Authorization: Bearer YOUR_ADMIN_API_KEY"
```
This automatically calls Telegram `setWebhook` with `MASTER_WEBHOOK_SECRET` and verifies live registration via `getWebhookInfo`.

---

## Connecting the React Dashboard & GitHub Synchronization

1. Run the dashboard locally (`npm run dev` on port `3000`) or deploy the static `dist/` build to Cloudflare Pages (`npm run build`).
2. Click **Connect Worker** in the top bar, enter your deployed Worker HTTPS URL and your `ADMIN_API_KEY` (stored strictly in browser `sessionStorage`, never in source code).
3. For GitHub two-way synchronization from Google AI Studio Build Mode, ensure `.env` and `.wrangler/` remain gitignored — all secrets stay inside Cloudflare Secrets.

---

## Running Automated Tests

The test suite runs directly in Node 22 against the real SQL migration files and Cloudflare Workers ES modules:

```bash
npm test
```

Covered tests:
1. BotFather token format & URL validation
2. AES-256-GCM encryption/decryption (unique random IVs, wrong-key rejection, SHA-256 hashing, constant-time compare, secret log redaction)
3. Colourful Telegram button native `style` serialization (`success` / `primary` / `danger`) on both `InlineKeyboardButton` and `KeyboardButton`
4. Full D1 SQL migration schema & seeded templates verification
5. Multi-tenant webhook routing, secret header enforcement, duplicate registration blocking, and strict tenant data isolation
6. Refer & Earn anti-self-referral & duplicate referral claim prevention
7. Global broadcast resumable batching, real `MASTER_BOT_USERNAME` deep link CTA, and 403 blocked-user flagging
8. Owner Bearer API authentication & Custom Builder anti-script-injection validation

---

## Troubleshooting

- **`401 Unauthorized webhook signature`**: Ensure `MASTER_WEBHOOK_SECRET` matches the secret used when calling `/api/master/register-webhook`. For tenant bots, click **Verify & Enable** in Bot Fleet to re-register the webhook with the stored `webhook_secret`.
- **`D1 query failed` or `Migration Pending`**: Run `npm run db:migrate:remote` and verify `database_id` in `wrangler.jsonc`.
- **Cloudflare Monitor shows `Data unavailable`**: Confirm `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` are set via `wrangler secret put` with least-privilege read scopes. Application-level D1 counters still operate independently.
- **Colourful buttons appear standard in an older Telegram client**: BOT FACTORY emits official Telegram Bot API `style` values (`success`, `primary`, `danger`); older Telegram clients automatically fall back to standard buttons without error.
