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

// ============================================================================
// 8. MASTER BOT — MANUAL WEBHOOK REGISTRATION & VERIFICATION
// ============================================================================
test('Master Bot manual webhook registration sets exact URL, secret_token, allowed_updates, verifies via getWebhookInfo, and leaks zero secrets', async () => {
  const workerUrl = 'https://botfactory.rimpirimpi141.workers.dev';
  const env = buildTestEnv({ WORKER_PUBLIC_URL: workerUrl });
  const { fetchImpl, calls } = createMockTelegramFetch();

  // Before registration, status should report not_registered & ready configuration
  const beforeRes = await routeRequest(
    new Request(`${workerUrl}/api/master/webhook-status`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${env.ADMIN_API_KEY}` },
    }),
    env,
    {},
    { fetchImpl }
  );
  assert.equal(beforeRes.status, 200);
  const beforeBody = await beforeRes.json();
  assert.equal(beforeBody.ok, true);
  assert.equal(beforeBody.configuration.workerPublicUrl, workerUrl);
  assert.equal(beforeBody.configuration.expectedWebhookUrl, `${workerUrl}/webhook/master`);
  assert.equal(beforeBody.configuration.masterBotTokenConfigured, true);
  assert.equal(beforeBody.configuration.masterWebhookSecretConfigured, true);
  assert.equal(beforeBody.webhook.status, 'not_registered');

  // Trigger manual Master Bot webhook registration
  const regRes = await routeRequest(
    new Request(`${workerUrl}/api/master/register-webhook`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.ADMIN_API_KEY}` },
    }),
    env,
    {},
    { fetchImpl }
  );
  assert.equal(regRes.status, 200);
  const regText = await regRes.text();
  const regBody = JSON.parse(regText);

  assert.equal(regBody.ok, true);
  assert.equal(regBody.verified, true);
  assert.equal(regBody.status, 'verified');
  assert.equal(regBody.verification.webhookUrl, `${workerUrl}/webhook/master`);
  assert.ok(regBody.lastRegisteredAt);

  // Verify exact Telegram setWebhook call parameters
  const setCall = calls.find((c) => c.method === 'setWebhook');
  assert.ok(setCall, 'Expected setWebhook to be called');
  assert.equal(setCall.body.url, `${workerUrl}/webhook/master`);
  assert.equal(setCall.body.secret_token, env.MASTER_WEBHOOK_SECRET);
  assert.deepEqual(setCall.body.allowed_updates, ['message', 'callback_query']);

  // Verify getWebhookInfo was called AFTER setWebhook
  const infoCallIndex = calls.findIndex((c) => c.method === 'getWebhookInfo');
  const setCallIndex = calls.findIndex((c) => c.method === 'setWebhook');
  assert.ok(infoCallIndex > setCallIndex, 'getWebhookInfo must be called after setWebhook');

  // Ensure MASTER_BOT_TOKEN and MASTER_WEBHOOK_SECRET are NEVER exposed in frontend response
  assert.ok(!regText.includes(env.MASTER_BOT_TOKEN), 'MASTER_BOT_TOKEN must never appear in response');
  assert.ok(!regText.includes(env.MASTER_WEBHOOK_SECRET), 'MASTER_WEBHOOK_SECRET must never appear in response');

  // Persisted status endpoint reflects verified state and last registration timestamp
  const afterRes = await routeRequest(
    new Request(`${workerUrl}/api/master/webhook-status`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${env.ADMIN_API_KEY}` },
    }),
    env,
    {},
    { fetchImpl }
  );
  assert.equal(afterRes.status, 200);
  const afterText = await afterRes.text();
  const afterBody = JSON.parse(afterText);
  assert.equal(afterBody.webhook.status, 'verified');
  assert.equal(afterBody.webhook.verified, true);
  assert.equal(afterBody.webhook.lastRegisteredAt, regBody.lastRegisteredAt);
  assert.ok(!afterText.includes(env.MASTER_BOT_TOKEN));
  assert.ok(!afterText.includes(env.MASTER_WEBHOOK_SECRET));
});

test('Master Bot manual verification detects exact match and URL mismatch cleanly', async () => {
  const workerUrl = 'https://botfactory.rimpirimpi141.workers.dev';
  const env = buildTestEnv({ WORKER_PUBLIC_URL: workerUrl });

  // 1. Mismatch scenario: Telegram reports an outdated URL
  const mismatchMock = createMockTelegramFetch({
    getWebhookInfo: async () => ({
      status: 200,
      body: {
        ok: true,
        result: {
          url: 'https://old-worker.example.workers.dev/webhook/master',
          pending_update_count: 3,
          max_connections: 40,
          allowed_updates: ['message', 'callback_query'],
        },
      },
    }),
  });

  const mismatchRes = await routeRequest(
    new Request(`${workerUrl}/api/master/verify-webhook`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.ADMIN_API_KEY}` },
    }),
    env,
    {},
    { fetchImpl: mismatchMock.fetchImpl }
  );
  assert.equal(mismatchRes.status, 200);
  const mismatchBody = await mismatchRes.json();
  assert.equal(mismatchBody.verified, false);
  assert.equal(mismatchBody.status, 'mismatch');
  assert.match(mismatchBody.error, /mismatch/i);

  // Registration must also fail if getWebhookInfo does not match the registered URL
  const badRegRes = await routeRequest(
    new Request(`${workerUrl}/api/master/register-webhook`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.ADMIN_API_KEY}` },
    }),
    env,
    {},
    { fetchImpl: mismatchMock.fetchImpl }
  );
  assert.equal(badRegRes.status, 502);
  const badRegBody = await badRegRes.json();
  assert.equal(badRegBody.ok, false);
  assert.equal(badRegBody.status, 'failed');
  assert.match(badRegBody.error, /mismatch/i);

  // 2. Exact match scenario: Telegram reports the exact expected URL
  const matchMock = createMockTelegramFetch({
    getWebhookInfo: async () => ({
      status: 200,
      body: {
        ok: true,
        result: {
          url: `${workerUrl}/webhook/master`,
          pending_update_count: 0,
          max_connections: 40,
          allowed_updates: ['message', 'callback_query'],
        },
      },
    }),
  });

  const matchRes = await routeRequest(
    new Request(`${workerUrl}/api/master/verify-webhook`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.ADMIN_API_KEY}` },
    }),
    env,
    {},
    { fetchImpl: matchMock.fetchImpl }
  );
  assert.equal(matchRes.status, 200);
  const matchBody = await matchRes.json();
  assert.equal(matchBody.verified, true);
  assert.equal(matchBody.status, 'verified');
});

// ============================================================================
// 9. TENANT BOTS — AUTOMATIC WEBHOOK, UNIQUE SECRETS & API CREDENTIAL SAFETY
// ============================================================================
test('Tenant bot automatic webhook uses /webhook/{botId}, unique secret per bot, verifies before active, and strips secrets from all API responses', async () => {
  const workerUrl = 'https://botfactory.rimpirimpi141.workers.dev';
  const env = buildTestEnv({ WORKER_PUBLIC_URL: workerUrl });
  const { fetchImpl, calls } = createMockTelegramFetch();

  const token1 = '6100001:AAH_AutoTenantOne_ValidToken_1234567890abc';
  const token2 = '6100002:AAH_AutoTenantTwo_ValidToken_1234567890abc';

  const deployRes1 = await routeRequest(
    new Request(`${workerUrl}/api/bots/deploy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.ADMIN_API_KEY}` },
      body: JSON.stringify({
        token: token1,
        templateId: 'tpl_refer_earn',
        displayName: 'Auto Tenant One',
        ownerTelegramId: '5010',
      }),
    }),
    env,
    {},
    { fetchImpl }
  );
  assert.equal(deployRes1.status, 201);
  const deployText1 = await deployRes1.text();
  const deployBody1 = JSON.parse(deployText1);

  const deployRes2 = await routeRequest(
    new Request(`${workerUrl}/api/bots/deploy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.ADMIN_API_KEY}` },
      body: JSON.stringify({
        token: token2,
        templateId: 'tpl_tool_bot',
        displayName: 'Auto Tenant Two',
        ownerTelegramId: '5020',
      }),
    }),
    env,
    {},
    { fetchImpl }
  );
  assert.equal(deployRes2.status, 201);
  const deployBody2 = JSON.parse(await deployRes2.text());

  // Verify exact tenant webhook URLs and active status only after verification
  assert.equal(deployBody1.bot.status, 'active');
  assert.equal(deployBody1.bot.webhook_status, 'verified');
  assert.equal(deployBody1.verification.webhookUrl, `${workerUrl}/webhook/${deployBody1.bot.id}`);
  assert.equal(deployBody2.verification.webhookUrl, `${workerUrl}/webhook/${deployBody2.bot.id}`);

  // Verify setWebhook was called with unique secrets per tenant bot
  const setCalls = calls.filter((c) => c.method === 'setWebhook');
  assert.equal(setCalls.length, 2);
  assert.equal(setCalls[0].body.url, `${workerUrl}/webhook/${deployBody1.bot.id}`);
  assert.equal(setCalls[1].body.url, `${workerUrl}/webhook/${deployBody2.bot.id}`);
  assert.ok(setCalls[0].body.secret_token.length === 64);
  assert.ok(setCalls[1].body.secret_token.length === 64);
  assert.notEqual(setCalls[0].body.secret_token, setCalls[1].body.secret_token);
  assert.notEqual(setCalls[0].body.secret_token, env.MASTER_WEBHOOK_SECRET);

  // Verify NO bot token or webhook secret is exposed in deploy, disable, enable, list, or detail APIs
  assert.equal(deployBody1.bot.token_encrypted, undefined);
  assert.equal(deployBody1.bot.token_hash, undefined);
  assert.equal(deployBody1.bot.webhook_secret, undefined);
  assert.ok(!deployText1.includes(token1));
  assert.ok(!deployText1.includes(setCalls[0].body.secret_token));

  const disableRes = await routeRequest(
    new Request(`${workerUrl}/api/bots/${deployBody1.bot.id}/disable`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.ADMIN_API_KEY}` },
    }),
    env,
    {},
    { fetchImpl }
  );
  const disableBody = await disableRes.json();
  assert.equal(disableBody.bot.token_encrypted, undefined);
  assert.equal(disableBody.bot.webhook_secret, undefined);

  const enableRes = await routeRequest(
    new Request(`${workerUrl}/api/bots/${deployBody1.bot.id}/enable`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.ADMIN_API_KEY}` },
    }),
    env,
    {},
    { fetchImpl }
  );
  const enableBody = await enableRes.json();
  assert.equal(enableBody.bot.status, 'active');
  assert.equal(enableBody.bot.token_encrypted, undefined);
  assert.equal(enableBody.bot.webhook_secret, undefined);

  // Verify token is stored encrypted (never plaintext) in D1
  const db = createDbClient(env.DB);
  const repos = createRepositories(db, env);
  const rawDbRow = await repos.bots.getById(deployBody1.bot.id);
  assert.ok(rawDbRow.token_encrypted.startsWith('v1:'));
  assert.ok(!rawDbRow.token_encrypted.includes(token1));
});

// ============================================================================
// 10. FAILURE HANDLING, SAFE RETRY & DUPLICATE PROTECTION
// ============================================================================
test('Failed setWebhook or verification mismatch does not activate bot, records error, and allows safe retry without duplicates', async () => {
  const workerUrl = 'https://botfactory.rimpirimpi141.workers.dev';
  const env = buildTestEnv({ WORKER_PUBLIC_URL: workerUrl });
  const db = createDbClient(env.DB);
  const repos = createRepositories(db, env);
  const rawToken = '6200001:AAH_RetryableBot_ValidToken_1234567890abcd';

  // Attempt 1: setWebhook fails with Telegram 400 error
  const failSetMock = createMockTelegramFetch({
    setWebhook: async () => ({
      status: 400,
      body: { ok: false, error_code: 400, description: 'Bad Request: failed to resolve host' },
    }),
  });
  await assert.rejects(
    () =>
      deployTenantBot({
        env,
        repos,
        telegram: createTelegramClient(failSetMock.fetchImpl),
        ownerTelegramId: '8881',
        rawToken,
        templateId: 'tpl_tool_bot',
        displayName: 'Retry Bot',
      }),
    /failed to resolve host/i
  );

  // Verify bot was NOT marked active and meaningful error was saved
  let allBots = await repos.bots.listAll();
  assert.equal(allBots.length, 1);
  const firstBotId = allBots[0].id;
  assert.equal(allBots[0].status, 'failed');
  assert.equal(allBots[0].webhook_status, 'failed');
  assert.match(allBots[0].webhook_last_error, /failed to resolve host/i);

  // Another user trying to steal/duplicate the failed bot token is BLOCKED
  const okMock = createMockTelegramFetch();
  await assert.rejects(
    () =>
      deployTenantBot({
        env,
        repos,
        telegram: createTelegramClient(okMock.fetchImpl),
        ownerTelegramId: '9999',
        rawToken,
        templateId: 'tpl_tool_bot',
        displayName: 'Unauthorized Hijack Attempt',
      }),
    /already registered/i
  );

  // Attempt 2: Same owner retries safely — getWebhookInfo returns mismatch (still must NOT activate)
  const mismatchMock = createMockTelegramFetch({
    getWebhookInfo: async () => ({
      status: 200,
      body: { ok: true, result: { url: 'https://wrong.example.com/webhook/other', pending_update_count: 0 } },
    }),
  });
  await assert.rejects(
    () =>
      deployTenantBot({
        env,
        repos,
        telegram: createTelegramClient(mismatchMock.fetchImpl),
        ownerTelegramId: '8881',
        rawToken,
        templateId: 'tpl_tool_bot',
        displayName: 'Retry Bot',
      }),
    /verification mismatch/i
  );

  allBots = await repos.bots.listAll();
  assert.equal(allBots.length, 1, 'Safe retry must NOT create duplicate bot rows');
  assert.equal(allBots[0].id, firstBotId);
  assert.equal(allBots[0].status, 'failed');
  assert.match(allBots[0].webhook_last_error, /mismatch/i);

  // Attempt 3: Same owner retries when Telegram succeeds -> reuses bot ID and activates cleanly!
  const successRetry = await deployTenantBot({
    env,
    repos,
    telegram: createTelegramClient(okMock.fetchImpl),
    ownerTelegramId: '8881',
    rawToken,
    templateId: 'tpl_tool_bot',
    displayName: 'Retry Bot',
  });
  assert.equal(successRetry.retried, true);
  assert.equal(successRetry.bot.id, firstBotId);
  assert.equal(successRetry.bot.status, 'active');
  assert.equal(successRetry.bot.webhook_status, 'verified');

  allBots = await repos.bots.listAll();
  assert.equal(allBots.length, 1, 'Database must still contain exactly one bot row after safe retry');

  // Once active, even the same owner cannot create a duplicate deployment
  await assert.rejects(
    () =>
      deployTenantBot({
        env,
        repos,
        telegram: createTelegramClient(okMock.fetchImpl),
        ownerTelegramId: '8881',
        rawToken,
        templateId: 'tpl_tool_bot',
        displayName: 'Duplicate Active Attempt',
      }),
    /already registered/i
  );
});

// ============================================================================
// 11. NETWORK TIMEOUT & TENANT WEBHOOK SECRET HEADER ISOLATION
// ============================================================================
test('Network timeout during Telegram webhook registration returns clean 504 error and never activates bot', async () => {
  const workerUrl = 'https://botfactory.rimpirimpi141.workers.dev';
  const env = buildTestEnv({ WORKER_PUBLIC_URL: workerUrl });

  const hangingFetch = async (url, init = {}) => {
    const match = String(url).match(/\/bot([^/]+)\/([A-Za-z0-9_]+)$/);
    const method = match?.[2] || '';
    if (method === 'getMe') {
      return new Response(
        JSON.stringify({ ok: true, result: { id: 6300001, is_bot: true, first_name: 'Timeout Bot', username: 'timeout_bot' } }),
        { status: 200 }
      );
    }
    // Hang until AbortController fires
    return new Promise((_, reject) => {
      init.signal?.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  };

  const res = await routeRequest(
    new Request(`${workerUrl}/api/bots/deploy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.ADMIN_API_KEY}` },
      body: JSON.stringify({
        token: '6300001:AAH_TimeoutBot_ValidToken_1234567890abcdef',
        templateId: 'tpl_tool_bot',
        displayName: 'Timeout Bot',
      }),
    }),
    env,
    {},
    { fetchImpl: hangingFetch, telegramTimeoutMs: 40 }
  );
  assert.equal(res.status, 504);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /timeout/i);

  // Confirm bot was NOT activated in D1
  const db = createDbClient(env.DB);
  const repos = createRepositories(db, env);
  const bots = await repos.bots.listAll();
  assert.equal(bots.length, 1);
  assert.equal(bots[0].status, 'failed');
  assert.equal(bots[0].webhook_status, 'failed');
  assert.match(bots[0].webhook_last_error, /timeout/i);
});

test('Incoming tenant webhook rejects missing, wrong, master, and cross-tenant secrets with 401', async () => {
  const workerUrl = 'https://botfactory.rimpirimpi141.workers.dev';
  const env = buildTestEnv({ WORKER_PUBLIC_URL: workerUrl });
  const db = createDbClient(env.DB);
  const repos = createRepositories(db, env);
  const { fetchImpl } = createMockTelegramFetch();
  const telegram = createTelegramClient(fetchImpl);

  const botA = await deployTenantBot({
    env,
    repos,
    telegram,
    ownerTelegramId: '7001',
    rawToken: '6400001:AAH_SecTenantA_ValidToken_1234567890abcdef',
    templateId: 'tpl_tool_bot',
    displayName: 'Sec Tenant A',
  });
  const botB = await deployTenantBot({
    env,
    repos,
    telegram,
    ownerTelegramId: '7002',
    rawToken: '6400002:AAH_SecTenantB_ValidToken_1234567890abcdef',
    templateId: 'tpl_tool_bot',
    displayName: 'Sec Tenant B',
  });

  const payload = JSON.stringify({
    update_id: 901,
    message: { chat: { id: 12345, type: 'private' }, from: { id: 12345, first_name: 'Tester' }, text: '/start' },
  });

  // 1. Missing header -> 401
  const missingRes = await routeRequest(
    new Request(`${workerUrl}/webhook/${botA.bot.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    }),
    env,
    {},
    { fetchImpl }
  );
  assert.equal(missingRes.status, 401);

  // 2. Master Bot secret used on Tenant Bot -> 401
  const masterSecretRes = await routeRequest(
    new Request(`${workerUrl}/webhook/${botA.bot.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': env.MASTER_WEBHOOK_SECRET },
      body: payload,
    }),
    env,
    {},
    { fetchImpl }
  );
  assert.equal(masterSecretRes.status, 401);

  // 3. Bot B's secret used on Bot A's webhook -> 401
  const crossTenantRes = await routeRequest(
    new Request(`${workerUrl}/webhook/${botA.bot.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': botB.bot.webhook_secret },
      body: payload,
    }),
    env,
    {},
    { fetchImpl }
  );
  assert.equal(crossTenantRes.status, 401);

  // 4. Bot A's own secret -> 200 OK
  const validRes = await routeRequest(
    new Request(`${workerUrl}/webhook/${botA.bot.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': botA.bot.webhook_secret },
      body: payload,
    }),
    env,
    {},
    { fetchImpl }
  );
  assert.equal(validRes.status, 200);
});
