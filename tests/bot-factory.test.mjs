/**
 * BOT FACTORY — End-to-End & Unit Test Suite (Node 22 native test runner)
 *
 * Uses Node's built-in DatabaseSync strictly as an in-memory D1 SQL test harness
 * running the ACTUAL /migrations/0001_initial_schema.sql and /migrations/0002_seed_templates.sql
 * against our Cloudflare Workers ES modules.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  decryptBotToken,
  encryptBotToken,
  generateBotId,
  generateWebhookSecret,
  hashBotToken,
  timingSafeEqual,
} from '../src/core/token-security.js';
import { validateBotTokenFormat, validateSafeUrl, isOwnerTelegramId } from '../src/utils/validation.js';
import {
  buildApprovalButtons,
  buildInlineKeyboard,
  buildMasterMainReplyKeyboard,
  buildReplyKeyboard,
  BUTTON_STYLES,
  inlineButton,
} from '../src/utils/keyboards.js';
import { routeRequest } from '../src/core/router.js';
import { createDbClient } from '../src/database/db.js';
import { verifyDatabaseSchema } from '../src/database/migrations.js';
import { createRepositories } from '../src/database/repositories.js';
import { deployTenantBot } from '../src/core/tenant-manager.js';
import { createTelegramClient } from '../src/core/telegram-api.js';
import { processBroadcastBatch, queueBroadcast } from '../src/admin/broadcast.js';
import { validateMenuTree, createDefaultCustomMenuTree } from '../src/builder/menu-builder.js';
import { redactString } from '../src/utils/logger.js';

/**
 * Creates a real SQL-backed D1 binding adapter for testing the actual SQL migrations & queries.
 */
function createTestD1() {
  const sqlite = new DatabaseSync(':memory:');
  const m1 = fs.readFileSync(path.resolve('migrations/0001_initial_schema.sql'), 'utf8');
  const m2 = fs.readFileSync(path.resolve('migrations/0002_seed_templates.sql'), 'utf8');
  sqlite.exec(m1);
  sqlite.exec(m2);

  function wrapStatement(sql, boundParams = []) {
    return {
      sql,
      boundParams,
      bind(...params) {
        return wrapStatement(sql, params);
      },
      async first() {
        const stmt = sqlite.prepare(sql);
        const row = stmt.get(...boundParams);
        return row ?? null;
      },
      async all() {
        const stmt = sqlite.prepare(sql);
        const results = stmt.all(...boundParams);
        return { results, meta: { changes: 0 } };
      },
      async run() {
        const stmt = sqlite.prepare(sql);
        const info = stmt.run(...boundParams);
        return { success: true, meta: { changes: info.changes } };
      },
    };
  }

  return {
    prepare(sql) {
      return wrapStatement(sql, []);
    },
    async batch(stmts) {
      const out = [];
      sqlite.exec('BEGIN');
      try {
        for (const s of stmts) {
          out.push(await s.run());
        }
        sqlite.exec('COMMIT');
        return out;
      } catch (err) {
        sqlite.exec('ROLLBACK');
        throw err;
      }
    },
  };
}

function createTestKV() {
  const store = new Map();
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, val) {
      store.set(key, String(val));
    },
    async delete(key) {
      store.delete(key);
    },
    _store: store,
  };
}

function createMockTelegramFetch(handlers = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : {};
    const match = String(url).match(/\/bot([^/]+)\/([A-Za-z0-9_]+)$/);
    const token = match?.[1] || '';
    const method = match?.[2] || '';
    calls.push({ token, method, body, url: String(url) });

    if (handlers[method]) {
      const custom = await handlers[method]({ token, body, calls });
      return new Response(JSON.stringify(custom.body), {
        status: custom.status || 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (method === 'getMe') {
      const botNumericId = Number(token.split(':')[0]) || 900001;
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            id: botNumericId,
            is_bot: true,
            first_name: `Bot ${botNumericId}`,
            username: `bot_${botNumericId}_test`,
          },
        }),
        { status: 200 }
      );
    }

    if (method === 'setWebhook') {
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }

    if (method === 'getWebhookInfo') {
      const lastSet = [...calls].reverse().find((c) => c.token === token && c.method === 'setWebhook');
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            url: lastSet?.body?.url || '',
            pending_update_count: 0,
            max_connections: 40,
          },
        }),
        { status: 200 }
      );
    }

    return new Response(
      JSON.stringify({ ok: true, result: { message_id: calls.length + 100 } }),
      { status: 200 }
    );
  };
  return { fetchImpl, calls };
}

const TEST_SECRET_KEY = btoa('12345678901234567890123456789012'); // 32 bytes base64

function buildTestEnv(overrides = {}) {
  return {
    DB: createTestD1(),
    KV: createTestKV(),
    ANALYTICS: { writeDataPoint: () => {} },
    WORKER_PUBLIC_URL: 'https://bot-factory.example.workers.dev',
    MASTER_BOT_USERNAME: 'RealBotFactoryMasterBot',
    MASTER_BOT_TOKEN: '111111111:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    MASTER_WEBHOOK_SECRET: 'master_secret_token_xyz_123456',
    TOKEN_ENCRYPTION_KEY: TEST_SECRET_KEY,
    ADMIN_TELEGRAM_ID: '777000111',
    ADMIN_API_KEY: 'owner_api_secret_key_999',
    ...overrides,
  };
}

// ============================================================================
// 1. TOKEN VALIDATION & AES-256-GCM ENCRYPTION / DECRYPTION
// ============================================================================
test('Token format validation rejects malformed tokens and accepts valid BotFather tokens', () => {
  assert.equal(validateBotTokenFormat('not-a-token').valid, false);
  assert.equal(validateBotTokenFormat('123:short').valid, false);
  const valid = validateBotTokenFormat('987654321:AAH_valid_Token_Payload_1234567890abcd');
  assert.equal(valid.valid, true);
  assert.equal(validateSafeUrl('javascript:alert(1)').valid, false);
  assert.equal(validateSafeUrl('https://t.me/mybot').valid, true);
});

test('AES-256-GCM encrypts with unique random IVs, decrypts accurately, and redacts in logs', async () => {
  const plaintext = '555666777:AAH_Super_Secret_BotFather_Token_987654';
  const enc1 = await encryptBotToken(plaintext, TEST_SECRET_KEY);
  const enc2 = await encryptBotToken(plaintext, TEST_SECRET_KEY);

  assert.notEqual(enc1, enc2, 'Unique random IV must produce distinct ciphertexts');
  assert.ok(enc1.startsWith('v1:'));
  assert.ok(!enc1.includes(plaintext));

  const dec1 = await decryptBotToken(enc1, TEST_SECRET_KEY);
  const dec2 = await decryptBotToken(enc2, TEST_SECRET_KEY);
  assert.equal(dec1, plaintext);
  assert.equal(dec2, plaintext);

  await assert.rejects(() => decryptBotToken(enc1, btoa('wrongkeywrongkeywrongkeywrongkey')));

  const hashA = await hashBotToken(plaintext);
  const hashB = await hashBotToken(plaintext);
  assert.equal(hashA, hashB);
  assert.equal(hashA.length, 64);

  assert.equal(timingSafeEqual('abc123', 'abc123'), true);
  assert.equal(timingSafeEqual('abc123', 'abc124'), false);
  assert.equal(redactString(`Error with token ${plaintext}`), 'Error with token [REDACTED_BOT_TOKEN]');
});

// ============================================================================
// 2. COLOURFUL TELEGRAM BUTTON SYSTEM (NATIVE `style` FIELD)
// ============================================================================
test('Colourful keyboard factory preserves native Telegram style fields on Inline & Reply keyboards', () => {
  const approval = buildApprovalButtons('ok:1', 'no:1');
  assert.equal(approval.inline_keyboard[0][0].style, 'success');
  assert.equal(approval.inline_keyboard[0][1].style, 'danger');

  const masterReply = buildMasterMainReplyKeyboard(true);
  assert.equal(masterReply.keyboard[0][0].style, 'success');
  assert.equal(masterReply.keyboard[0][1].style, 'primary');
  const ownerRow = masterReply.keyboard[masterReply.keyboard.length - 1];
  assert.equal(ownerRow[0].style, 'danger');

  // Arbitrary hex colors must NOT be emitted
  const customBtn = inlineButton({ text: 'Test', callbackData: 'x', style: '#ff00ff' });
  assert.equal(customBtn.style, undefined);

  const validReply = buildReplyKeyboard([[{ text: 'Action', style: BUTTON_STYLES.PRIMARY }]]);
  assert.equal(validReply.keyboard[0][0].style, 'primary');
});

// ============================================================================
// 3. D1 SCHEMA MIGRATIONS & SEEDED TEMPLATES
// ============================================================================
test('D1 migrations create all required tables and seed all 7 prebuilt templates + custom builder', async () => {
  const env = buildTestEnv();
  const db = createDbClient(env.DB);
  const health = await verifyDatabaseSchema(db);
  assert.equal(health.healthy, true);
  assert.equal(health.missingTables.length, 0);
  assert.equal(health.seededTemplates, 8);
});

// ============================================================================
// 4. WEBHOOK ROUTING, TENANT ISOLATION & DUPLICATE BOT PROTECTION
// ============================================================================
test('Multi-tenant webhook routing enforces secret verification and isolates tenant bots completely', async () => {
  const env = buildTestEnv();
  const db = createDbClient(env.DB);
  const repos = createRepositories(db, env);
  const { fetchImpl, calls } = createMockTelegramFetch();
  const telegram = createTelegramClient(fetchImpl);

  // Deploy Bot A (Refer & Earn) and Bot B (Tool Bot)
  const deployA = await deployTenantBot({
    env,
    repos,
    telegram,
    ownerTelegramId: '1001',
    rawToken: '2000001:AAH_TenantA_Valid_Token_1234567890abcdef',
    templateId: 'tpl_refer_earn',
    displayName: 'Alpha Rewards',
  });

  const deployB = await deployTenantBot({
    env,
    repos,
    telegram,
    ownerTelegramId: '2002',
    rawToken: '2000002:AAH_TenantB_Valid_Token_1234567890abcdef',
    templateId: 'tpl_tool_bot',
    displayName: 'Beta Tools',
  });

  assert.equal(deployA.bot.status, 'active');
  assert.equal(deployA.bot.webhook_status, 'verified');
  assert.equal(deployB.bot.status, 'active');
  assert.notEqual(deployA.bot.id, deployB.bot.id);

  // Duplicate bot registration must fail
  await assert.rejects(
    () =>
      deployTenantBot({
        env,
        repos,
        telegram,
        ownerTelegramId: '3003',
        rawToken: '2000001:AAH_TenantA_Valid_Token_1234567890abcdef',
        templateId: 'tpl_tool_bot',
        displayName: 'Duplicate Attempt',
      }),
    /already registered/i
  );

  // Wrong webhook secret MUST be rejected with 401
  const badReq = new Request(`https://bot-factory.example.workers.dev/webhook/${deployA.bot.id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'wrong_secret' },
    body: JSON.stringify({ update_id: 1, message: { chat: { id: 55 }, from: { id: 55, first_name: 'Alice' }, text: '/start' } }),
  });
  const badRes = await routeRequest(badReq, env, {}, { fetchImpl });
  assert.equal(badRes.status, 401);

  // Valid webhook for Bot A executes Refer & Earn using ONLY Bot A token
  const okReqA = new Request(`https://bot-factory.example.workers.dev/webhook/${deployA.bot.id}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': deployA.bot.webhook_secret,
    },
    body: JSON.stringify({
      update_id: 10,
      message: { chat: { id: 5001, type: 'private' }, from: { id: 5001, first_name: 'Alice' }, text: '/start' },
    }),
  });
  const resA = await routeRequest(okReqA, env, {}, { fetchImpl });
  assert.equal(resA.status, 200);

  // End-user 5001 exists ONLY in Bot A, NOT in Bot B (strict tenant isolation!)
  const inA = await repos.endUsers.get(deployA.bot.id, '5001');
  const inB = await repos.endUsers.get(deployB.bot.id, '5001');
  assert.ok(inA);
  assert.equal(inB, null);

  // Verify Bot A sent colourful reply keyboard with Refer & Earn buttons
  const sendMsgA = calls.find((c) => c.method === 'sendMessage' && c.body.chat_id === 5001);
  assert.ok(sendMsgA);
  assert.equal(sendMsgA.body.reply_markup.keyboard[0][0].style, 'success');
});

// ============================================================================
// 5. REFERRAL ABUSE PREVENTION (SELF-REFERRAL & DUPLICATE CLAIM)
// ============================================================================
test('Refer & Earn prevents self-referrals and duplicate referral claims', async () => {
  const env = buildTestEnv();
  const db = createDbClient(env.DB);
  const repos = createRepositories(db, env);
  const { fetchImpl } = createMockTelegramFetch();
  const telegram = createTelegramClient(fetchImpl);

  const deployed = await deployTenantBot({
    env,
    repos,
    telegram,
    ownerTelegramId: '1001',
    rawToken: '3000001:AAH_RefBot_Valid_Token_1234567890abcdefg',
    templateId: 'tpl_refer_earn',
    displayName: 'Ref Guard Bot',
  });

  await repos.endUsers.upsert(deployed.bot.id, { id: 8001, first_name: 'Referrer' });
  await repos.endUsers.upsert(deployed.bot.id, { id: 8002, first_name: 'Invitee' });

  // Self-referral blocked
  const selfRes = await repos.endUsers.recordReferral(deployed.bot.id, '8001', '8001', 25);
  assert.equal(selfRes.credited, false);
  assert.match(selfRes.reason, /Self-referrals/i);

  // First valid referral succeeds
  const firstRes = await repos.endUsers.recordReferral(deployed.bot.id, '8001', '8002', 25);
  assert.equal(firstRes.credited, true);
  assert.equal(firstRes.newBalance, 25);

  // Duplicate referral for same invitee blocked
  const dupRes = await repos.endUsers.recordReferral(deployed.bot.id, '8001', '8002', 25);
  assert.equal(dupRes.credited, false);
  assert.match(dupRes.reason, /already claimed/i);
});

// ============================================================================
// 6. GLOBAL BROADCAST BATCHING, PROMO DEEP LINK & 403 BLOCK HANDLING
// ============================================================================
test('Global broadcast batches across bots, appends real master bot deep link, and marks 403 blocked users', async () => {
  const env = buildTestEnv();
  const db = createDbClient(env.DB);
  const repos = createRepositories(db, env);

  // Simulate user 9002 having blocked the bot (403 Forbidden)
  const { fetchImpl, calls } = createMockTelegramFetch({
    sendMessage: async ({ body }) => {
      if (String(body.chat_id) === '9002') {
        return {
          status: 403,
          body: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' },
        };
      }
      return { status: 200, body: { ok: true, result: { message_id: 500 } } };
    },
  });
  const telegram = createTelegramClient(fetchImpl);

  const deployed = await deployTenantBot({
    env,
    repos,
    telegram,
    ownerTelegramId: '1001',
    rawToken: '4000001:AAH_BrcBot_Valid_Token_1234567890abcdefg',
    templateId: 'tpl_tool_bot',
    displayName: 'Broadcast Target Bot',
  });

  await repos.endUsers.upsert(deployed.bot.id, { id: 9001, first_name: 'ActiveUser' });
  await repos.endUsers.upsert(deployed.bot.id, { id: 9002, first_name: 'BlockedUser' });

  const draft = await repos.broadcasts.create({
    scope: 'global',
    messageText: 'Build your own Telegram bot today!',
    includePromoFooter: true,
    createdBy: env.ADMIN_TELEGRAM_ID,
  });

  const queued = await queueBroadcast({ env, repos, broadcastId: draft.id, actorTelegramId: env.ADMIN_TELEGRAM_ID });
  assert.equal(queued.total_recipients, 2);

  const batchResult = await processBroadcastBatch({ env, repos, telegram, broadcastId: draft.id, delayMs: 0 });
  assert.equal(batchResult.delivered, 1);
  assert.equal(batchResult.blocked, 1);
  assert.equal(batchResult.status, 'completed');

  // Verify promo CTA used real env.MASTER_BOT_USERNAME deep link
  const deliveredCall = calls.find((c) => c.method === 'sendMessage' && String(c.body.chat_id) === '9001');
  assert.ok(deliveredCall);
  assert.equal(
    deliveredCall.body.reply_markup.inline_keyboard[0][0].url,
    'https://t.me/RealBotFactoryMasterBot?start=create'
  );
  assert.equal(deliveredCall.body.reply_markup.inline_keyboard[0][0].style, 'success');

  // Verify blocked user was flagged in D1 so future broadcasts skip them
  const blockedRecord = await repos.endUsers.get(deployed.bot.id, '9002');
  assert.equal(blockedRecord.is_blocked, 1);
});

// ============================================================================
// 7. PERMISSION CHECKS & CUSTOM BUILDER ANTI-CODE-INJECTION
// ============================================================================
test('Owner API enforces Bearer authentication and Custom Builder blocks unsafe script payloads', async () => {
  const env = buildTestEnv();

  // Unauthenticated API call rejected
  const unauthRes = await routeRequest(new Request('https://bot-factory.example.workers.dev/api/dashboard/overview'), env, {});
  assert.equal(unauthRes.status, 401);

  // Authenticated Owner API call succeeds
  const authRes = await routeRequest(
    new Request('https://bot-factory.example.workers.dev/api/dashboard/overview', {
      headers: { Authorization: `Bearer ${env.ADMIN_API_KEY}` },
    }),
    env,
    {}
  );
  assert.equal(authRes.status, 200);
  const body = await authRes.json();
  assert.equal(body.ok, true);

  // Owner Telegram ID check
  assert.equal(isOwnerTelegramId('777000111', env), true);
  assert.equal(isOwnerTelegramId('999999999', env), false);

  // Custom Builder rejects arbitrary script/eval injection
  const starter = createDefaultCustomMenuTree('Safe Bot');
  assert.equal(validateMenuTree(starter).length, 3);

  const unsafeTree = structuredClone(starter);
  unsafeTree[0].buttons[0].actionType = 'message';
  unsafeTree[0].buttons[0].actionPayload = '<script>alert(1)</script>';
  assert.throws(() => validateMenuTree(unsafeTree), /forbidden script/i);
});

test('Internal bot ID and webhook secret generators satisfy security entropy and format constraints', () => {
  const id = generateBotId();
  assert.match(id, /^bot_[a-f0-9]{20}$/);
  const secret = generateWebhookSecret();
  assert.equal(secret.length, 64);
});
