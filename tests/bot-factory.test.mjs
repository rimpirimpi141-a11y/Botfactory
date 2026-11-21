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
  buildOwnerControlReplyKeyboard,
  buildReplyKeyboard,
  BUTTON_STYLES,
  inlineButton,
  MASTER_MAIN_BUTTONS,
  OWNER_CONTROL_BUTTONS,
} from '../src/utils/keyboards.js';
import { routeRequest } from '../src/core/router.js';
import { createDbClient } from '../src/database/db.js';
import { verifyDatabaseSchema } from '../src/database/migrations.js';
import { createRepositories } from '../src/database/repositories.js';
import { deployTenantBot } from '../src/core/tenant-manager.js';
import { createTelegramClient } from '../src/core/telegram-api.js';
import { processBroadcastBatch, queueBroadcast } from '../src/admin/broadcast.js';
import { validateMenuTree, createDefaultCustomMenuTree } from '../src/builder/menu-builder.js';
import { generateDynamicAdminSpec } from '../src/builder/dynamic-admin.js';
import { attributePlatformReferral, calculatePlanEntitlement } from '../src/core/plans-referrals.js';
import { redeemCodeForUser } from '../src/templates/redeem-code/index.js';
import { evaluateCampaignEligibility } from '../src/templates/festive-bonus/index.js';
import { dispatchDueScheduledPosts } from '../src/templates/channel-automation/index.js';
import { getCloudflareInfrastructureMetrics } from '../src/admin/cloudflare-monitor.js';
import { redactString } from '../src/utils/logger.js';
import {
  buildForceJoinGateKeyboard,
  checkUserForceJoin,
  parseForceJoinInput,
  resolveAndVerifyForceJoinDestination,
  reverifyForceJoinDestinations,
} from '../src/core/force-join.js';
import { runAnimatedOperation } from '../src/utils/animations.js';

/**
 * Creates a real SQL-backed D1 binding adapter for testing the actual SQL migrations & queries.
 */
function createTestD1() {
  const sqlite = new DatabaseSync(':memory:');
  const m1 = fs.readFileSync(path.resolve('migrations/0001_initial_schema.sql'), 'utf8');
  const m2 = fs.readFileSync(path.resolve('migrations/0002_seed_templates.sql'), 'utf8');
  const m3 = fs.readFileSync(path.resolve('migrations/0003_platform_upgrade.sql'), 'utf8');
  sqlite.exec(m1);
  sqlite.exec(m2);
  sqlite.exec(m3);

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
test('D1 migrations 0001-0003 create all required + upgrade tables and seed all Template Studio templates', async () => {
  const env = buildTestEnv();
  const db = createDbClient(env.DB);
  const health = await verifyDatabaseSchema(db);
  assert.equal(health.healthy, true);
  assert.equal(health.upgrade0003Applied, true);
  assert.equal(health.missingTables.length, 0);
  assert.equal(health.missingUpgradeTables.length, 0);
  assert.ok(health.seededTemplates >= 17, `Expected >= 17 seeded templates, got ${health.seededTemplates}`);
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
  assert.deepEqual(setCall.body.allowed_updates, ['message', 'callback_query', 'chat_member', 'my_chat_member']);

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

// ============================================================================
// 12. PLATFORM REFERRALS, ANTI-ABUSE & EXACT PLAN MILESTONES (0 / 8 / 48 / 50)
// ============================================================================
test('Platform referral attribution enforces anti-abuse rules and exact plan milestones (0, 5, 8, 48, 50)', async () => {
  // Pure milestone calculation checks
  const e0 = calculatePlanEntitlement({ plan: 'free', verified_referrals: 0, bonus_bot_slots: 0 }, 0);
  assert.equal(e0.plan, 'free');
  assert.equal(e0.maxBots, 2);

  const e5 = calculatePlanEntitlement({ plan: 'free', verified_referrals: 5, bonus_bot_slots: 0 }, 0);
  assert.equal(e5.plan, 'free');
  assert.equal(e5.maxBots, 7);

  const e8 = calculatePlanEntitlement({ plan: 'free', verified_referrals: 8, bonus_bot_slots: 0 }, 0);
  assert.equal(e8.plan, 'starter');
  assert.equal(e8.maxBots, 10);

  const e48 = calculatePlanEntitlement({ plan: 'free', verified_referrals: 48, bonus_bot_slots: 0 }, 0);
  assert.equal(e48.plan, 'pro');
  assert.equal(e48.maxBots, 50);

  const e50 = calculatePlanEntitlement({ plan: 'free', verified_referrals: 50, bonus_bot_slots: 0 }, 20);
  assert.equal(e50.plan, 'enterprise');
  assert.equal(e50.isUnlimited, true);
  assert.equal(e50.maxBots, null);
  assert.equal(e50.canCreateBot, true);

  // Real D1 anti-abuse checks
  const env = buildTestEnv();
  const db = createDbClient(env.DB);
  const repos = createRepositories(db, env);

  const referrer = await repos.users.upsertFromTelegram({ id: 40001, username: 'creator_one', first_name: 'One' });
  const invitee = await repos.users.upsertFromTelegram({ id: 40002, username: 'creator_two', first_name: 'Two' });

  // Self-referral blocked
  const selfAttempt = await attributePlatformReferral({
    repos,
    referrerCode: referrer.referral_code,
    referredUser: { id: 40001, username: 'creator_one', is_bot: false },
    isNewUser: true,
  });
  assert.equal(selfAttempt.attributed, false);
  assert.match(selfAttempt.reason, /self/i);

  // Bot account blocked
  const botAttempt = await attributePlatformReferral({
    repos,
    referrerCode: referrer.referral_code,
    referredUser: { id: 40099, username: 'fake_bot', is_bot: true },
    isNewUser: true,
  });
  assert.equal(botAttempt.attributed, false);
  assert.match(botAttempt.reason, /bot/i);

  // Existing user (not new) blocked
  const existingAttempt = await attributePlatformReferral({
    repos,
    referrerCode: referrer.referral_code,
    referredUser: { id: 40002, username: 'creator_two', is_bot: false },
    isNewUser: false,
  });
  assert.equal(existingAttempt.attributed, false);

  // Legitimate new user attribution succeeds once
  const validAttr = await attributePlatformReferral({
    repos,
    referrerCode: referrer.referral_code,
    referredUser: { id: 40002, username: 'creator_two', is_bot: false },
    isNewUser: true,
  });
  assert.equal(validAttr.attributed, true);

  // Duplicate attribution blocked
  const dupAttr = await attributePlatformReferral({
    repos,
    referrerCode: referrer.referral_code,
    referredUser: { id: 40002, username: 'creator_two', is_bot: false },
    isNewUser: true,
  });
  assert.equal(dupAttr.attributed, false);

  const updatedReferrer = await repos.users.getByTelegramId('40001');
  assert.equal(Number(updatedReferrer.verified_referrals), 1);
  assert.equal(invitee.telegram_id, '40002');
});

// ============================================================================
// 13. BACKEND BOT SLOT ENFORCEMENT (BLOCKS 3RD BOT ON 0-REF FREE ACCOUNT)
// ============================================================================
test('Backend enforces 2-bot FREE slot limit, unlocks 3rd slot after 1 verified referral, and never deletes existing bots on limit reduction', async () => {
  const env = buildTestEnv();
  const db = createDbClient(env.DB);
  const repos = createRepositories(db, env);
  const { fetchImpl } = createMockTelegramFetch();
  const telegram = createTelegramClient(fetchImpl);

  await repos.users.upsertFromTelegram({ id: 51001, username: 'slot_tester', first_name: 'Slot' });

  // Bot 1 & Bot 2 succeed
  await deployTenantBot({
    env,
    repos,
    telegram,
    ownerTelegramId: '51001',
    rawToken: '7100001:AAH_SlotBotOne_ValidToken_1234567890abcdef',
    templateId: 'tpl_tool_bot',
    displayName: 'Slot Bot 1',
  });
  await deployTenantBot({
    env,
    repos,
    telegram,
    ownerTelegramId: '51001',
    rawToken: '7100002:AAH_SlotBotTwo_ValidToken_1234567890abcdef',
    templateId: 'tpl_apk_store',
    displayName: 'Slot Bot 2',
  });

  // Bot 3 MUST be blocked by server-side slot enforcement
  await assert.rejects(
    () =>
      deployTenantBot({
        env,
        repos,
        telegram,
        ownerTelegramId: '51001',
        rawToken: '7100003:AAH_SlotBotThree_ValidToken_1234567890abcd',
        templateId: 'tpl_task_bot',
        displayName: 'Slot Bot 3',
      }),
    /slot limit reached/i
  );

  // Grant +1 verified referral -> now 3 slots available -> Bot 3 succeeds!
  const creator = await repos.users.getByTelegramId('51001');
  await repos.users.upsertFromTelegram({ id: 51002, username: 'ref_friend', first_name: 'Friend' });
  await attributePlatformReferral({
    repos,
    referrerCode: creator.referral_code,
    referredUser: { id: 51002, username: 'ref_friend', is_bot: false },
    isNewUser: true,
  });

  const bot3 = await deployTenantBot({
    env,
    repos,
    telegram,
    ownerTelegramId: '51001',
    rawToken: '7100003:AAH_SlotBotThree_ValidToken_1234567890abcd',
    templateId: 'tpl_task_bot',
    displayName: 'Slot Bot 3',
  });
  assert.equal(bot3.bot.status, 'active');

  // Owner reduces bonus slots to -2 -> existing 3 bots are NEVER deleted, only new creation is blocked
  await repos.users.adjustBotSlots('51001', -2);
  const existing = await repos.bots.listByOwner('51001');
  assert.equal(existing.length, 3);
});

// ============================================================================
// 14. MASTER BOT 9-BUTTON COLOURFUL REPLY KEYBOARD & OWNER 12-SECTION RBAC
// ============================================================================
test('Master Bot renders exact 9 colourful native ReplyKeyboard buttons with zero unstyled buttons and Owner Control Center enforces RBAC', async () => {
  const userKb = buildMasterMainReplyKeyboard(false);
  const userButtons = userKb.keyboard.flat();
  assert.equal(userButtons.length, 9);
  for (const btn of userButtons) {
    assert.ok(['success', 'primary', 'danger'].includes(btn.style), `Button "${btn.text}" must have colourful style`);
  }

  const ownerKb = buildOwnerControlReplyKeyboard();
  const ownerButtons = ownerKb.keyboard.flat();
  assert.equal(ownerButtons.length, Object.keys(OWNER_CONTROL_BUTTONS).length);
  for (const btn of ownerButtons) {
    assert.ok(['success', 'primary', 'danger'].includes(btn.style), `Owner button "${btn.text}" must have colourful style`);
  }

  // Verify Master Bot /start sends single welcome with ReplyKeyboard (no duplicate inline main menu)
  const workerUrl = 'https://botfactory.rimpirimpi141.workers.dev';
  const env = buildTestEnv({ WORKER_PUBLIC_URL: workerUrl });
  const { fetchImpl, calls } = createMockTelegramFetch();

  const startRes = await routeRequest(
    new Request(`${workerUrl}/webhook/master`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': env.MASTER_WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        update_id: 5001,
        message: { chat: { id: 88001, type: 'private' }, from: { id: 88001, first_name: 'Nova' }, text: '/start' },
      }),
    }),
    env,
    {},
    { fetchImpl }
  );
  assert.equal(startRes.status, 200);
  const sent = calls.filter((c) => c.method === 'sendMessage' && c.body.chat_id === 88001);
  assert.equal(sent.length, 1, 'Master Bot /start must send a single welcome message with ReplyKeyboard');
  assert.ok(Array.isArray(sent[0].body.reply_markup.keyboard));
  assert.equal(sent[0].body.reply_markup.inline_keyboard, undefined);

  // Verify Super Admin protection in platform_admins repo
  const db = createDbClient(env.DB);
  const repos = createRepositories(db, env);
  await repos.platformAdmins.add({ telegramId: '88002', username: 'mod_user', addedBy: env.ADMIN_TELEGRAM_ID });
  const admins = await repos.platformAdmins.list();
  assert.equal(admins.length, 1);

  // Ordinary admin / anyone cannot remove Super Admin
  await assert.rejects(
    () => repos.platformAdmins.remove(env.ADMIN_TELEGRAM_ID, env.ADMIN_TELEGRAM_ID),
    /super admin/i
  );
});

// ============================================================================
// 15. TEMPLATE STUDIO COMING SOON ENFORCEMENT
// ============================================================================
test('Template Studio exposes 11 functional templates + 2 Coming Soon templates and strictly blocks Coming Soon deployment', async () => {
  const env = buildTestEnv();
  const db = createDbClient(env.DB);
  const repos = createRepositories(db, env);
  const { fetchImpl } = createMockTelegramFetch();
  const telegram = createTelegramClient(fetchImpl);

  const all = await repos.templates.listAllForStudio();
  const hosting = all.find((t) => t.slug === 'hosting-bot');
  const cloner = all.find((t) => t.slug === 'own-bot-cloner');
  assert.ok(hosting && Number(hosting.is_coming_soon) === 1);
  assert.ok(cloner && Number(cloner.is_coming_soon) === 1);

  for (const slug of ['hosting-bot', 'own-bot-cloner']) {
    await assert.rejects(
      () =>
        deployTenantBot({
          env,
          repos,
          telegram,
          ownerTelegramId: '52001',
          rawToken: '7200001:AAH_ComingSoonTest_ValidToken_1234567890ab',
          templateId: slug,
          displayName: 'Should Fail',
        }),
      /coming soon/i
    );
  }
});

// ============================================================================
// 16. ATOMIC PAYMENT PROOF APPROVAL & TASK BOT NO AUTO-CREDIT
// ============================================================================
test('Payment proof approval is strictly atomic (blocks double approval) and Task Bot never auto-credits on screenshot upload', async () => {
  const env = buildTestEnv();
  const db = createDbClient(env.DB);
  const repos = createRepositories(db, env);
  const { fetchImpl } = createMockTelegramFetch();
  const telegram = createTelegramClient(fetchImpl);

  const deployed = await deployTenantBot({
    env,
    repos,
    telegram,
    ownerTelegramId: '53001',
    rawToken: '7300001:AAH_TaskAndPayBot_ValidToken_1234567890abc',
    templateId: 'tpl_task_bot',
    displayName: 'Task Verification Bot',
  });

  await repos.endUsers.upsert(deployed.bot.id, { id: 91001, first_name: 'WorkerUser' });

  // 1. Payment proof atomic approval prevents double delivery
  const proof = await repos.payments.createProof({
    botId: deployed.bot.id,
    endUserId: '91001',
    referenceType: 'product_order',
    referenceId: 'ord_1',
    amount: 199,
    utrNumber: 'UTR9988776655',
    proofFileId: 'AgACAgIAAxkBA_test_screenshot',
  });
  const firstApprove = await repos.payments.approveProof(deployed.bot.id, proof.id, '53001');
  assert.equal(firstApprove.approved, true);
  const secondApprove = await repos.payments.approveProof(deployed.bot.id, proof.id, '53001');
  assert.equal(secondApprove.approved, false);

  // 2. Task submission stays pending with 0 balance until explicit admin approval
  await db.run(
    `INSERT INTO tasks (id, bot_id, title, description, reward_amount, max_submissions, submission_count, is_active, created_by, created_at)
     VALUES ('task_001', ?, 'Follow Official Channel', 'Upload screenshot proof', 40, 10, 0, 1, '53001', datetime('now'))`,
    [deployed.bot.id]
  );
  await db.run(
    `INSERT INTO task_submissions (id, bot_id, task_id, user_telegram_id, screenshot_file_id, reward_amount, status, created_at)
     VALUES ('sub_001', ?, 'task_001', '91001', 'AgAC_proof_1', 40, 'pending', datetime('now'))`,
    [deployed.bot.id]
  );

  // Balance MUST still be 0 after screenshot submission!
  const beforeBalance = await repos.endUsers.get(deployed.bot.id, '91001');
  assert.equal(Number(beforeBalance.points_balance), 0);

  // Admin approves via real webhook callback -> balance credits atomically once
  const workerUrl = 'https://botfactory.rimpirimpi141.workers.dev';
  const approveReq = () =>
    routeRequest(
      new Request(`${workerUrl}/webhook/${deployed.bot.id}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': deployed.bot.webhook_secret,
        },
        body: JSON.stringify({
          update_id: Math.floor(Math.random() * 100000) + 100,
          callback_query: {
            id: 'cb_task_approve',
            from: { id: 53001, first_name: 'Owner' },
            message: { chat: { id: 53001, type: 'private' }, message_id: 77 },
            data: 'tb:adm_approve:sub_001',
          },
        }),
      }),
      env,
      {},
      { fetchImpl }
    );

  const r1 = await approveReq();
  assert.equal(r1.status, 200);
  const afterFirst = await repos.endUsers.get(deployed.bot.id, '91001');
  assert.equal(Number(afterFirst.points_balance), 40);

  // Duplicate tap must NOT credit again
  const r2 = await approveReq();
  assert.equal(r2.status, 200);
  const afterSecond = await repos.endUsers.get(deployed.bot.id, '91001');
  assert.equal(Number(afterSecond.points_balance), 40);
});

// ============================================================================
// 17. REDEEM CODE BOT & FESTIVE BONUS ELIGIBILITY RULES
// ============================================================================
test('Redeem Code Bot enforces min_referrals, max claims, expiry, and duplicate prevention; Festive Bonus enforces date window & referrals', async () => {
  const env = buildTestEnv();
  const db = createDbClient(env.DB);
  const repos = createRepositories(db, env);
  const { fetchImpl } = createMockTelegramFetch();
  const telegram = createTelegramClient(fetchImpl);

  const deployed = await deployTenantBot({
    env,
    repos,
    telegram,
    ownerTelegramId: '54001',
    rawToken: '7400001:AAH_RedeemCodeBot_ValidToken_1234567890abc',
    templateId: 'tpl_redeem_code',
    displayName: 'Redeem Vault Bot',
  });

  await repos.endUsers.upsert(deployed.bot.id, { id: 92001, first_name: 'Claimer' });
  await db.run(
    `INSERT INTO giftcodes (id, bot_id, code, reward_points, max_uses, used_count, min_referrals, expires_at, status, created_by, created_at)
     VALUES ('gc_ref', ?, 'REFONLY50', 50, 1, 0, 2, '2099-01-01T00:00:00Z', 'active', '54001', datetime('now'))`,
    [deployed.bot.id]
  );

  // Fails when user has 0 referrals (< 2 required)
  const denied = await redeemCodeForUser({ db, repos, botId: deployed.bot.id, endUserId: '92001', code: 'REFONLY50' });
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /referral/i);

  // Grant 2 referrals -> redemption succeeds once, duplicate blocked
  await db.run(`UPDATE bot_end_users SET referral_count = 2 WHERE bot_id = ? AND telegram_id = '92001'`, [
    deployed.bot.id,
  ]);
  const allowed = await redeemCodeForUser({ db, repos, botId: deployed.bot.id, endUserId: '92001', code: 'REFONLY50' });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.reward, 50);

  const dup = await redeemCodeForUser({ db, repos, botId: deployed.bot.id, endUserId: '92001', code: 'REFONLY50' });
  assert.equal(dup.ok, false);

  // Festive Bonus eligibility rules
  const now = new Date('2026-10-20T12:00:00Z');
  const ended = evaluateCampaignEligibility({
    campaign: { startDate: '2026-10-01T00:00:00Z', endDate: '2026-10-15T00:00:00Z', minReferrals: 0, maxClaims: 100 },
    userReferralCount: 5,
    totalClaims: 10,
    alreadyClaimed: false,
    now,
  });
  assert.equal(ended.eligible, false);
  assert.match(ended.reason, /ended/i);

  const okFestive = evaluateCampaignEligibility({
    campaign: { startDate: '2026-10-01T00:00:00Z', endDate: '2026-10-30T00:00:00Z', minReferrals: 2, maxClaims: 100 },
    userReferralCount: 3,
    totalClaims: 10,
    alreadyClaimed: false,
    now,
  });
  assert.equal(okFestive.eligible, true);
});

// ============================================================================
// 18. CHANNEL AUTOMATION ADMIN VERIFICATION & CRON DISPATCHER
// ============================================================================
test('Channel Automation verifies real bot admin permission via getChatMember and dispatches scheduled posts via cron', async () => {
  const env = buildTestEnv();
  const db = createDbClient(env.DB);
  const repos = createRepositories(db, env);
  const { fetchImpl, calls } = createMockTelegramFetch({
    getChatMember: async ({ body }) => ({
      status: 200,
      body: { ok: true, result: { status: body.chat_id === '@AdminChannel' ? 'administrator' : 'member' } },
    }),
  });
  const telegram = createTelegramClient(fetchImpl);

  const deployed = await deployTenantBot({
    env,
    repos,
    telegram,
    ownerTelegramId: '55001',
    rawToken: '7500001:AAH_ChannelAutoBot_ValidToken_1234567890ab',
    templateId: 'tpl_channel_automation',
    displayName: 'Channel Scheduler Bot',
  });

  // Insert connected channel & due scheduled post
  await db.run(
    `INSERT INTO connected_channels (id, bot_id, channel_id, channel_title, verified_admin, connected_by, created_at)
     VALUES ('ch_1', ?, '@AdminChannel', 'Official Channel', 1, '55001', datetime('now'))`,
    [deployed.bot.id]
  );
  await db.run(
    `INSERT INTO scheduled_posts (id, bot_id, channel_id, post_text, scheduled_for, status, created_by, created_at)
     VALUES ('post_1', ?, '@AdminChannel', 'Scheduled launch announcement!', '2020-01-01T00:00:00.000Z', 'scheduled', '55001', datetime('now'))`,
    [deployed.bot.id]
  );

  const dispatchRes = await dispatchDueScheduledPosts({ env, db, repos, telegram });
  assert.equal(dispatchRes.sent, 1);
  const channelCall = calls.find((c) => c.method === 'sendMessage' && c.body.chat_id === '@AdminChannel');
  assert.ok(channelCall, 'Scheduled post must be sent to @AdminChannel');

  const { row: postRow } = await db.first(`SELECT status FROM scheduled_posts WHERE id = 'post_1'`);
  assert.equal(postRow.status, 'sent');
});

// ============================================================================
// 19. CUSTOM BUILDER DYNAMIC ADMIN GENERATOR & TWO-LAYER CLOUDFLARE MONITOR
// ============================================================================
test('Custom Builder dynamically generates matching Admin Panel modules and Cloudflare Monitor cleanly separates Layer 1 vs Layer 2', async () => {
  const menus = [
    {
      menuKey: 'main',
      title: 'Storefront',
      messageText: 'Welcome',
      buttons: [
        { id: 'b1', label: 'Shop', emoji: '🛍', actionType: 'feature', actionPayload: 'catalogue:all', style: 'success' },
        { id: 'b2', label: 'Order', emoji: '📦', actionType: 'feature', actionPayload: 'create_order:all', style: 'primary' },
        { id: 'b3', label: 'Apply', emoji: '📝', actionType: 'feature', actionPayload: 'form:Send email', style: 'primary' },
        { id: 'b4', label: 'Help', emoji: '🆘', actionType: 'support', actionPayload: 'Support', style: 'primary' },
      ],
    },
  ];

  const dynamicSpec = generateDynamicAdminSpec(menus);
  const labels = dynamicSpec.replyKeyboard.keyboard.flat().map((b) => b.text);
  assert.ok(labels.includes('🛍 Manage Products'));
  assert.ok(labels.includes('📦 Manage Orders'));
  assert.ok(labels.includes('💳 Payment Verification'));
  assert.ok(labels.includes('📥 Form Submissions'));
  assert.ok(labels.includes('🆘 Support Settings'));
  for (const btn of dynamicSpec.replyKeyboard.keyboard.flat()) {
    assert.ok(['success', 'primary', 'danger'].includes(btn.style));
  }

  // Two-Layer Cloudflare Monitor without CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID
  const env = buildTestEnv();
  const db = createDbClient(env.DB);
  const repos = createRepositories(db, env);
  const cf = await getCloudflareInfrastructureMetrics(env, repos);
  assert.equal(cf.applicationHealth.status, 'healthy');
  assert.equal(cf.applicationHealth.d1.healthy, true);
  assert.equal(cf.applicationHealth.kv.healthy, true);
  assert.equal(cf.accountMetrics.configured, false);
  assert.equal(cf.accountMetrics.message, 'Account-level metrics are not configured.');
});

// ============================================================================
// 20. MASTER BOT 9-BUTTON HANDLERS END-TO-END
// ============================================================================
test('Master Bot handles Template Studio, My Statistics, Plans & Features, Account Settings, and Help & Support cleanly', async () => {
  const workerUrl = 'https://botfactory.rimpirimpi141.workers.dev';
  const env = buildTestEnv({ WORKER_PUBLIC_URL: workerUrl, MASTER_BOT_USERNAME: 'BotFactoryMasterBot' });
  const { fetchImpl, calls } = createMockTelegramFetch();

  let updateId = 8000;
  const sendMasterText = async (text) => {
    updateId += 1;
    const res = await routeRequest(
      new Request(`${workerUrl}/webhook/master`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': env.MASTER_WEBHOOK_SECRET,
        },
        body: JSON.stringify({
          update_id: updateId,
          message: { chat: { id: 94001, type: 'private' }, from: { id: 94001, username: 'builder94', first_name: 'Aria' }, text },
        }),
      }),
      env,
      {},
      { fetchImpl }
    );
    assert.equal(res.status, 200);
  };

  await sendMasterText('/start');
  await sendMasterText('🧩 Template Studio');
  await sendMasterText('📊 My Statistics');
  await sendMasterText('💎 Plans & Features');
  await sendMasterText('⚙️ Account Settings');
  await sendMasterText('📣 Help & Support');

  const messages = calls
    .filter((c) => (c.method === 'sendMessage' || c.method === 'editMessageText') && c.body.chat_id === 94001)
    .map((c) => c.body.text);
  assert.ok(messages.some((m) => /Template Studio/i.test(m) && /COMING SOON/i.test(m)), 'Template Studio must list Coming Soon items');
  assert.ok(messages.some((m) => /Statistics/i.test(m)), 'My Statistics must render');
  assert.ok(
    messages.some((m) => /Plans &amp; Referral|Plans & Referral/i.test(m) && /https:\/\/t\.me\/BotFactoryMasterBot\?start=/i.test(m)),
    'Plans & Features must show personal referral link'
  );
  assert.ok(messages.some((m) => /Account Settings/i.test(m)), 'Account Settings must render');
  assert.ok(messages.some((m) => /Help &amp; Support|Help & Support/i.test(m)), 'Help & Support must render');
});

// ============================================================================
// 21. REFER & EARN ADMIN + TENANT ADMIN USER LIST + SMM DEPOSIT + FESTIVE CLAIM + SECRETARY MODE
// ============================================================================
test('Tenant templates execute real D1 transactions cleanly (Refer & Earn, Tenant Admin Users, SMM Deposit, Festive Bonus, Channel Secretary Mode)', async () => {
  const workerUrl = 'https://botfactory.rimpirimpi141.workers.dev';
  const env = buildTestEnv({ WORKER_PUBLIC_URL: workerUrl });
  const db = createDbClient(env.DB);
  const repos = createRepositories(db, env);
  const { fetchImpl, calls } = createMockTelegramFetch();
  const telegram = createTelegramClient(fetchImpl);

  // Give owner 58001 bonus slots so we can deploy 4 template bots in one test
  await repos.users.upsertFromTelegram({ id: 58001, username: 'multi_owner', first_name: 'Multi' });
  await repos.users.adjustBotSlots('58001', 10);

  const sendTenantUpdate = async (bot, payload) => {
    const res = await routeRequest(
      new Request(`${workerUrl}/webhook/${bot.id}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': bot.webhook_secret,
        },
        body: JSON.stringify(payload),
      }),
      env,
      {},
      { fetchImpl }
    );
    assert.equal(res.status, 200);
  };

  // A. Refer & Earn + Tenant Admin 👥 User List (verifies joined_at fix & admin giftcode creation)
  const reBot = (
    await deployTenantBot({
      env,
      repos,
      telegram,
      ownerTelegramId: '58001',
      rawToken: '7800001:AAH_ReferEarnTest_ValidToken_1234567890ab',
      templateId: 'tpl_refer_earn',
      displayName: 'RE Test Bot',
    })
  ).bot;

  await sendTenantUpdate(reBot, {
    update_id: 9001,
    message: { chat: { id: 58001, type: 'private' }, from: { id: 58001, first_name: 'Multi' }, text: '👥 User List' },
  });
  await sendTenantUpdate(reBot, {
    update_id: 9002,
    message: { chat: { id: 58001, type: 'private' }, from: { id: 58001, first_name: 'Multi' }, text: '🎟 Create Giftcode' },
  });
  await sendTenantUpdate(reBot, {
    update_id: 9003,
    message: { chat: { id: 58001, type: 'private' }, from: { id: 58001, first_name: 'Multi' }, text: 'BONUS25 | 25 | 5 | 14' },
  });
  const { row: createdGc } = await db.first(`SELECT code, reward_points FROM giftcodes WHERE bot_id = ? AND code = 'BONUS25'`, [reBot.id]);
  assert.equal(createdGc?.code, 'BONUS25');
  assert.equal(Number(createdGc?.reward_points), 25);

  // B. SMM Panel deposit proof approval (verifies tx_type = 'admin_credit' satisfies CHECK constraint)
  const smmBot = (
    await deployTenantBot({
      env,
      repos,
      telegram,
      ownerTelegramId: '58001',
      rawToken: '7800002:AAH_SmmPanelTest_ValidToken_1234567890abc',
      templateId: 'tpl_smm_panel',
      displayName: 'SMM Test Bot',
    })
  ).bot;
  await repos.endUsers.upsert(smmBot.id, { id: 95001, first_name: 'Buyer' });
  const smmProof = await repos.payments.createProof({
    botId: smmBot.id,
    userTelegramId: '95001',
    orderType: 'smm_deposit',
    referenceId: 'dep_1',
    amount: 250,
    utrNumber: 'UTR555444333',
  });
  await sendTenantUpdate(smmBot, {
    update_id: 9010,
    callback_query: {
      id: 'cb_smm_dep',
      from: { id: 58001, first_name: 'Multi' },
      message: { chat: { id: 58001, type: 'private' }, message_id: 12 },
      data: `smm:dep:approve:${smmProof.id}`,
    },
  });
  const buyerAfterSmm = await repos.endUsers.get(smmBot.id, '95001');
  assert.equal(Number(buyerAfterSmm.points_balance), 250);

  // C. Festive Bonus claim + max claims enforcement (verifies tx_type = 'reward' + reference_id = 'festive_bonus')
  const festBot = (
    await deployTenantBot({
      env,
      repos,
      telegram,
      ownerTelegramId: '58001',
      rawToken: '7800003:AAH_FestiveTest_ValidToken_1234567890abcd',
      templateId: 'tpl_festive_bonus',
      displayName: 'Diwali Bonus Bot',
      templateConfig: { campaignName: 'Diwali 2026', rewardAmount: 75, minReferrals: 0, maxClaimsPerUser: 1 },
    })
  ).bot;
  await sendTenantUpdate(festBot, {
    update_id: 9020,
    message: { chat: { id: 96001, type: 'private' }, from: { id: 96001, first_name: 'FestUser' }, text: '🎁 Claim Festive Bonus' },
  });
  await sendTenantUpdate(festBot, {
    update_id: 9021,
    message: { chat: { id: 96001, type: 'private' }, from: { id: 96001, first_name: 'FestUser' }, text: '🎁 Claim Festive Bonus' },
  });
  const festUser = await repos.endUsers.get(festBot.id, '96001');
  assert.equal(Number(festUser.points_balance), 75, 'Second festive claim must be blocked by maxClaimsPerUser = 1');

  // D. Channel Automation Secretary Mode forwarding
  const chBot = (
    await deployTenantBot({
      env,
      repos,
      telegram,
      ownerTelegramId: '58001',
      rawToken: '7800004:AAH_ChannelSecTest_ValidToken_1234567890a',
      templateId: 'tpl_channel_automation',
      displayName: 'Channel Sec Bot',
    })
  ).bot;
  await db.run(
    `INSERT INTO connected_channels (id, bot_id, channel_id, channel_title, verified_admin, connected_by, created_at)
     VALUES ('ch_sec', ?, '@SecretaryChannel', 'Sec Channel', 1, '58001', datetime('now'))`,
    [chBot.id]
  );
  await sendTenantUpdate(chBot, {
    update_id: 9030,
    message: { chat: { id: 58001, type: 'private' }, from: { id: 58001, first_name: 'Multi' }, text: '🤖 Toggle Secretary Mode' },
  });
  await sendTenantUpdate(chBot, {
    update_id: 9031,
    message: { chat: { id: 58001, type: 'private' }, from: { id: 58001, first_name: 'Multi' }, text: 'Breaking update from Secretary Mode!' },
  });
  const forwarded = calls.find(
    (c) => c.method === 'sendMessage' && c.body.chat_id === '@SecretaryChannel' && /Secretary Mode/.test(c.body.text)
  );
  assert.ok(forwarded, 'Secretary Mode must forward admin message directly to verified connected channel');
});

// ============================================================================
// 26. FORCE JOIN INPUT PARSER — ALL FORMATS + MALFORMED REJECTION (NO "@https://")
// ============================================================================
test('Force Join parser handles public/private channels & groups and never prepends @ to URLs', () => {
  // 1. Public channel @username
  const p1 = parseForceJoinInput('@OfficialUpdates');
  assert.equal(p1.ok, true);
  assert.equal(p1.kind, 'public');
  assert.equal(p1.username, 'OfficialUpdates');
  assert.equal(p1.handle, '@OfficialUpdates');
  assert.equal(p1.joinUrl, 'https://t.me/OfficialUpdates');

  // 2. Public channel URL (https://t.me/channelusername)
  const p2 = parseForceJoinInput('https://t.me/public_channel_1');
  assert.equal(p2.ok, true);
  assert.equal(p2.kind, 'public');
  assert.equal(p2.handle, '@public_channel_1');
  assert.equal(p2.joinUrl, 'https://t.me/public_channel_1');

  // 3. Public channel post URL (https://t.me/channelusername/123)
  const p3 = parseForceJoinInput('https://t.me/news_channel/456');
  assert.equal(p3.ok, true);
  assert.equal(p3.kind, 'public');
  assert.equal(p3.username, 'news_channel');
  assert.equal(p3.joinUrl, 'https://t.me/news_channel');

  // 4. Public group URL
  const p4 = parseForceJoinInput('t.me/community_group');
  assert.equal(p4.ok, true);
  assert.equal(p4.kind, 'public');
  assert.equal(p4.handle, '@community_group');

  // 5. Private channel/group invite link https://t.me/+INVITECODE (MUST NOT prepend @!)
  const p5 = parseForceJoinInput('https://t.me/+AbCdEf123456_xyz');
  assert.equal(p5.ok, true);
  assert.equal(p5.kind, 'private_invite');
  assert.equal(p5.inviteUrl, 'https://t.me/+AbCdEf123456_xyz');
  assert.equal(p5.inviteUrl.startsWith('@'), false);

  // 6. Legacy private invite link https://t.me/joinchat/INVITECODE
  const p6 = parseForceJoinInput('https://t.me/joinchat/LegacyInviteHash99');
  assert.equal(p6.ok, true);
  assert.equal(p6.kind, 'private_invite');
  assert.equal(p6.inviteUrl, 'https://t.me/joinchat/LegacyInviteHash99');

  // 7. Numeric chat_id & explicit chat_id | invite pair
  const p7 = parseForceJoinInput('-1001987654321 | https://t.me/+PairInvite99');
  assert.equal(p7.ok, true);
  assert.equal(p7.kind, 'chat_id_with_invite');
  assert.equal(p7.chatId, '-1001987654321');
  assert.equal(p7.inviteUrl, 'https://t.me/+PairInvite99');

  // 8. Malformed / non-Telegram / @https:// links rejected with helpful errors
  assert.equal(parseForceJoinInput('@https://t.me/+AbCdEf123').ok, false);
  assert.equal(parseForceJoinInput('https://google.com/channel').ok, false);
  assert.equal(parseForceJoinInput('https://t.me/').ok, false);
  assert.equal(parseForceJoinInput('https://t.me/+bad').ok, false);
  assert.equal(parseForceJoinInput('https://t.me/c/123456789/10').ok, false);
  assert.equal(parseForceJoinInput('@ab').ok, false);
});

// ============================================================================
// 27. FORCE JOIN PUBLIC RESOLUTION, ADMIN VERIFICATION & NON-ADMIN REJECTION
// ============================================================================
test('Force Join resolves public chats via getChat, verifies bot admin via getChatMember, and rejects non-admin bots', async () => {
  const { fetchImpl, calls } = createMockTelegramFetch({
    getChat: async ({ body }) => {
      if (body.chat_id === '@VerifiedPub') {
        return {
          body: {
            ok: true,
            result: { id: -1001122334455, type: 'channel', title: 'Verified Public Channel', username: 'VerifiedPub' },
          },
        };
      }
      if (body.chat_id === '@NotAdminGroup') {
        return {
          body: {
            ok: true,
            result: { id: -1005544332211, type: 'supergroup', title: 'Non-Admin Group', username: 'NotAdminGroup' },
          },
        };
      }
      return { status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: chat not found' } };
    },
    getChatMember: async ({ body }) => {
      if (String(body.chat_id) === '-1001122334455') {
        return { body: { ok: true, result: { status: 'administrator' } } };
      }
      return { body: { ok: true, result: { status: 'member' } } };
    },
  });
  const telegram = createTelegramClient(fetchImpl);
  const token = '8810001:AAH_ForceJoinPubTest_ValidToken_123456789';

  // Public URL resolves numeric chat_id and verifies administrator status
  const okRes = await resolveAndVerifyForceJoinDestination({
    telegram,
    token,
    rawInput: 'https://t.me/VerifiedPub/789',
    botUsername: 'tenant_test_bot',
  });
  assert.equal(okRes.ok, true);
  assert.equal(okRes.destination.chatId, '-1001122334455');
  assert.equal(okRes.destination.username, 'VerifiedPub');
  assert.equal(okRes.destination.inviteUrl, 'https://t.me/VerifiedPub');
  assert.equal(okRes.destination.isPrivate, false);
  assert.equal(okRes.destination.verified, true);
  // Ensure getChat was called with '@VerifiedPub' (NEVER '@https://...')
  assert.ok(calls.some((c) => c.method === 'getChat' && c.body.chat_id === '@VerifiedPub'));

  // Bot not admin -> rejected honestly, never silently saved
  const nonAdminRes = await resolveAndVerifyForceJoinDestination({
    telegram,
    token,
    rawInput: 'https://t.me/NotAdminGroup',
    botUsername: 'tenant_test_bot',
  });
  assert.equal(nonAdminRes.ok, false);
  assert.equal(nonAdminRes.needsAdmin, true);
  assert.match(nonAdminRes.error, /Administrator/i);

  // Private invite link -> never passed to getChat, returns honest pendingPrivateLink instructions
  const privRes = await resolveAndVerifyForceJoinDestination({
    telegram,
    token,
    rawInput: 'https://t.me/+PrivateSecretCode88',
    botUsername: 'tenant_test_bot',
  });
  assert.equal(privRes.ok, false);
  assert.equal(privRes.pendingPrivateLink, true);
  assert.equal(privRes.inviteUrl, 'https://t.me/+PrivateSecretCode88');
  assert.equal(
    calls.some((c) => c.method === 'getChat' && String(c.body.chat_id).includes('PrivateSecretCode88')),
    false,
    'Private invite links must NEVER be sent to Telegram getChat'
  );
});

// ============================================================================
// 28. FORCE JOIN PRIVATE LINKING VIA my_chat_member + MEMBERSHIP CHECKING
//     (creator, administrator, member, restricted is_member true/false, left, kicked)
//     + MULTI-TENANT ISOLATION + MULTI-CHANNEL ADD/REMOVE/CLEAR/REVERIFY
// ============================================================================
test('Private Force Join links via my_chat_member, enforces numeric chat_id membership statuses, and isolates tenants', async () => {
  const env = buildTestEnv();
  const db = createDbClient(env.DB);
  const repos = createRepositories(db, env);

  const memberStatuses = new Map([
    ['-100999888777:70001', { status: 'creator' }],
    ['-100999888777:70002', { status: 'administrator' }],
    ['-100999888777:70003', { status: 'member' }],
    ['-100999888777:70004', { status: 'restricted', is_member: true }],
    ['-100999888777:70005', { status: 'restricted', is_member: false }],
    ['-100999888777:70006', { status: 'left' }],
    ['-100999888777:70007', { status: 'kicked' }],
  ]);

  const { fetchImpl, calls } = createMockTelegramFetch({
    getChat: async ({ body }) => {
      if (String(body.chat_id) === '-100999888777') {
        return { body: { ok: true, result: { id: -100999888777, type: 'channel', title: 'VIP Private Club' } } };
      }
      if (body.chat_id === '@SecondPublicCh' || String(body.chat_id) === '-100222333444') {
        return {
          body: { ok: true, result: { id: -100222333444, type: 'channel', title: 'Second Public', username: 'SecondPublicCh' } },
        };
      }
      return { status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: chat not found' } };
    },
    getChatMember: async ({ body }) => {
      const key = `${body.chat_id}:${body.user_id}`;
      // Bot itself is administrator in both channels
      if (String(body.user_id) === '8900001' || String(body.user_id) === '8900002') {
        return { body: { ok: true, result: { status: 'administrator' } } };
      }
      if (memberStatuses.has(key)) {
        return { body: { ok: true, result: memberStatuses.get(key) } };
      }
      return { body: { ok: true, result: { status: 'left' } } };
    },
  });

  const telegram = createTelegramClient(fetchImpl);
  await repos.users.upsertFromTelegram({ id: 59001, username: 'tenant_owner', first_name: 'Tenant' });

  // Deploy Bot A (APK Store) and Bot B (SMM Panel) to verify strict per-tenant isolation
  const botA = (
    await deployTenantBot({
      env,
      repos,
      telegram,
      ownerTelegramId: '59001',
      rawToken: '8900001:AAH_TenantBotA_ValidToken_1234567890abcdef',
      templateId: 'tpl_apk_store',
      displayName: 'APK Tenant A',
    })
  ).bot;

  const botB = (
    await deployTenantBot({
      env,
      repos,
      telegram,
      ownerTelegramId: '59001',
      rawToken: '8900002:AAH_TenantBotB_ValidToken_1234567890abcdef',
      templateId: 'tpl_smm_panel',
      displayName: 'SMM Tenant B',
    })
  ).bot;

  const sendUpdate = (bot, update) =>
    routeRequest(
      new Request(`https://bot-factory.example.workers.dev/webhook/${bot.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': bot.webhook_secret },
        body: JSON.stringify(update),
      }),
      env,
      {},
      { fetchImpl }
    );

  // Step 1: Tenant admin opens Force Join & submits private invite link https://t.me/+VipSecret999
  await sendUpdate(botA, {
    update_id: 95001,
    message: { chat: { id: 59001, type: 'private' }, from: { id: 59001, first_name: 'Tenant' }, text: '📣 Force Join' },
  });
  await sendUpdate(botA, {
    update_id: 95002,
    message: {
      chat: { id: 59001, type: 'private' },
      from: { id: 59001, first_name: 'Tenant' },
      text: 'https://t.me/+VipSecret999',
    },
  });

  // Verify pending link was stored (NOT falsely saved as active verified destination yet!)
  const cfgPending = await repos.botConfigs.getByBotId(botA.id);
  assert.equal(cfgPending.forceJoinChannels.length, 0, 'Private link must NOT be saved as active until my_chat_member arrives');
  assert.equal(cfgPending.templateSettings.pendingForceJoinLink.inviteUrl, 'https://t.me/+VipSecret999');

  // Step 2: Telegram sends my_chat_member when admin adds Bot A to private channel & promotes to admin
  await sendUpdate(botA, {
    update_id: 95003,
    my_chat_member: {
      chat: { id: -100999888777, type: 'channel', title: 'VIP Private Club' },
      from: { id: 59001, first_name: 'Tenant' },
      date: Math.floor(Date.now() / 1000),
      old_chat_member: { user: { id: 8900001, is_bot: true }, status: 'left' },
      new_chat_member: { user: { id: 8900001, is_bot: true }, status: 'administrator' },
    },
  });

  const cfgLinked = await repos.botConfigs.getByBotId(botA.id);
  assert.equal(cfgLinked.forceJoinChannels.length, 1);
  assert.equal(cfgLinked.forceJoinChannels[0].chatId, '-100999888777');
  assert.equal(cfgLinked.forceJoinChannels[0].inviteUrl, 'https://t.me/+VipSecret999');
  assert.equal(cfgLinked.forceJoinChannels[0].isPrivate, true);
  assert.equal(cfgLinked.forceJoinChannels[0].verified, true);
  assert.equal(cfgLinked.templateSettings.pendingForceJoinLink, undefined);

  // Step 3: Verify all 6 Telegram member statuses (creator/admin/member/restricted+is_member pass; restricted!is_member/left/kicked fail)
  for (const passId of ['70001', '70002', '70003', '70004']) {
    const check = await checkUserForceJoin({
      telegram,
      token: '8900001:AAH_TenantBotA_ValidToken_1234567890abcdef',
      destinations: cfgLinked.forceJoinChannels,
      userId: passId,
    });
    assert.equal(check.passed, true, `User ${passId} should pass Force Join`);
  }
  for (const failId of ['70005', '70006', '70007']) {
    const check = await checkUserForceJoin({
      telegram,
      token: '8900001:AAH_TenantBotA_ValidToken_1234567890abcdef',
      destinations: cfgLinked.forceJoinChannels,
      userId: failId,
    });
    assert.equal(check.passed, false, `User ${failId} must be blocked by Force Join`);
  }

  // Step 4: Non-member (70006) messaging Bot A gets Join button with valid private invite URL (NOT @https://...)
  const resBlocked = await sendUpdate(botA, {
    update_id: 95004,
    message: { chat: { id: 70006, type: 'private' }, from: { id: 70006, first_name: 'LeftUser' }, text: '/start' },
  });
  const blockedJson = await resBlocked.json();
  assert.equal(blockedJson.forceJoinBlocked, true);
  const gateCall = [...calls].reverse().find((c) => c.method === 'sendMessage' && c.body.chat_id === 70006);
  const joinBtn = gateCall?.body?.reply_markup?.inline_keyboard?.[0]?.[0];
  assert.equal(joinBtn?.url, 'https://t.me/+VipSecret999', 'Private Join button must use stored valid private invite URL');

  // Step 5: Strict Tenant Isolation — same user (70006) on Bot B is NOT blocked by Bot A's Force Join!
  const resBotB = await sendUpdate(botB, {
    update_id: 95005,
    message: { chat: { id: 70006, type: 'private' }, from: { id: 70006, first_name: 'LeftUser' }, text: '/start' },
  });
  const botBJson = await resBotB.json();
  assert.notEqual(botBJson.forceJoinBlocked, true, 'Bot A Force Join config must never leak into Bot B');

  // Step 6: Add second public channel + reverify + remove + clear
  await sendUpdate(botA, {
    update_id: 95006,
    message: { chat: { id: 59001, type: 'private' }, from: { id: 59001, first_name: 'Tenant' }, text: '📣 Force Join' },
  });
  await sendUpdate(botA, {
    update_id: 95007,
    message: {
      chat: { id: 59001, type: 'private' },
      from: { id: 59001, first_name: 'Tenant' },
      text: 'https://t.me/SecondPublicCh',
    },
  });
  const cfgTwo = await repos.botConfigs.getByBotId(botA.id);
  assert.equal(cfgTwo.forceJoinChannels.length, 2, 'Tenant must support multiple Force Join destinations');

  const revRes = await reverifyForceJoinDestinations({
    telegram,
    token: '8900001:AAH_TenantBotA_ValidToken_1234567890abcdef',
    destinations: cfgTwo.forceJoinChannels,
  });
  assert.equal(revRes.summary.every((s) => s.ok), true);

  // Remove first destination
  await sendUpdate(botA, {
    update_id: 95008,
    message: { chat: { id: 59001, type: 'private' }, from: { id: 59001, first_name: 'Tenant' }, text: '📣 Force Join' },
  });
  await sendUpdate(botA, {
    update_id: 95009,
    message: { chat: { id: 59001, type: 'private' }, from: { id: 59001, first_name: 'Tenant' }, text: 'remove 1' },
  });
  const cfgOne = await repos.botConfigs.getByBotId(botA.id);
  assert.equal(cfgOne.forceJoinChannels.length, 1);
  assert.equal(cfgOne.forceJoinChannels[0].username, 'SecondPublicCh');

  // Clear all
  await sendUpdate(botA, {
    update_id: 95010,
    message: { chat: { id: 59001, type: 'private' }, from: { id: 59001, first_name: 'Tenant' }, text: '📣 Force Join' },
  });
  await sendUpdate(botA, {
    update_id: 95011,
    message: { chat: { id: 59001, type: 'private' }, from: { id: 59001, first_name: 'Tenant' }, text: 'clear' },
  });
  const cfgCleared = await repos.botConfigs.getByBotId(botA.id);
  assert.equal(cfgCleared.forceJoinChannels.length, 0);

  // Join button builder sanity for public vs private
  const kb = buildForceJoinGateKeyboard(cfgTwo.forceJoinChannels, 'fj:verify');
  assert.equal(kb.inline_keyboard[0][0].url, 'https://t.me/+VipSecret999');
  assert.equal(kb.inline_keyboard[1][0].url, 'https://t.me/SecondPublicCh');
});

// ============================================================================
// 29. OWNER CONTROL CENTER — STRICT ACCESS CONTROL, PRIVATE FORCE JOIN & FIXES
// ============================================================================
test('Owner Control Center rejects unauthorized users, validates missing users, and supports Master Bot private Force Join linking', async () => {
  const env = buildTestEnv();
  const db = createDbClient(env.DB);
  const repos = createRepositories(db, env);

  const { fetchImpl, calls } = createMockTelegramFetch({
    getChat: async ({ body }) => {
      if (body.chat_id === '@MasterOfficial') {
        return {
          body: { ok: true, result: { id: -100777666555, type: 'channel', title: 'BOT FACTORY Official', username: 'MasterOfficial' } },
        };
      }
      return { status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: chat not found' } };
    },
    getChatMember: async () => ({ body: { ok: true, result: { status: 'administrator' } } }),
  });

  const postMaster = (update) =>
    routeRequest(
      new Request('https://bot-factory.example.workers.dev/webhook/master', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': env.MASTER_WEBHOOK_SECRET,
        },
        body: JSON.stringify(update),
      }),
      env,
      {},
      { fetchImpl }
    );

  // 1. Unauthorized normal user trying /owner and Owner ReplyKeyboard button is strictly rejected
  await postMaster({
    update_id: 96001,
    message: { chat: { id: 333001, type: 'private' }, from: { id: 333001, first_name: 'Intruder' }, text: '/owner' },
  });
  await postMaster({
    update_id: 96002,
    message: {
      chat: { id: 333001, type: 'private' },
      from: { id: 333001, first_name: 'Intruder' },
      text: OWNER_CONTROL_BUTTONS.MANAGE_USERS,
    },
  });
  const intruderMsgs = calls.filter((c) => c.method === 'sendMessage' && c.body.chat_id === 333001);
  assert.equal(intruderMsgs.length, 2);
  assert.ok(intruderMsgs.every((m) => /Unauthorized|Restricted/i.test(m.body.text)));

  // 2. Super Admin opens Manage Users, attempts plan update on non-existent user -> honest not-found error
  const ownerId = Number(env.ADMIN_TELEGRAM_ID);
  await postMaster({
    update_id: 96003,
    message: { chat: { id: ownerId, type: 'private' }, from: { id: ownerId, first_name: 'Owner' }, text: OWNER_CONTROL_BUTTONS.MANAGE_USERS },
  });
  await postMaster({
    update_id: 96004,
    message: { chat: { id: ownerId, type: 'private' }, from: { id: ownerId, first_name: 'Owner' }, text: 'plan 999999999 pro' },
  });
  const notFoundReply = [...calls].reverse().find((c) => c.method === 'sendMessage' && c.body.chat_id === ownerId);
  assert.match(notFoundReply.body.text, /not found/i);

  // 3. Stale wizard state is cleared when tapping another Owner section (CF Monitor)
  await postMaster({
    update_id: 96005,
    message: { chat: { id: ownerId, type: 'private' }, from: { id: ownerId, first_name: 'Owner' }, text: OWNER_CONTROL_BUTTONS.CF_MONITOR },
  });
  const clearedWizard = await repos.users.getWizardState(String(ownerId));
  assert.equal(clearedWizard, null, 'Switching to non-stateful Owner section must clear previous wizard state');

  // 4. Master Bot private Force Join linking via my_chat_member
  await postMaster({
    update_id: 96006,
    message: { chat: { id: ownerId, type: 'private' }, from: { id: ownerId, first_name: 'Owner' }, text: OWNER_CONTROL_BUTTONS.FORCE_JOIN },
  });
  await postMaster({
    update_id: 96007,
    message: {
      chat: { id: ownerId, type: 'private' },
      from: { id: ownerId, first_name: 'Owner' },
      text: 'add https://t.me/+MasterPrivLink88',
    },
  });
  await postMaster({
    update_id: 96008,
    my_chat_member: {
      chat: { id: -100555444333, type: 'channel', title: 'BOT FACTORY Private VIP' },
      from: { id: ownerId, first_name: 'Owner' },
      date: Math.floor(Date.now() / 1000),
      old_chat_member: { user: { id: 111111111, is_bot: true }, status: 'left' },
      new_chat_member: { user: { id: 111111111, is_bot: true }, status: 'administrator' },
    },
  });

  const settingsAfter = await repos.stats.getSettings();
  const savedPlatformFj = JSON.parse(settingsAfter.map.platform_force_join_channels || '[]');
  assert.equal(savedPlatformFj.length, 1);
  assert.equal(savedPlatformFj[0].chatId, '-100555444333');
  assert.equal(savedPlatformFj[0].inviteUrl, 'https://t.me/+MasterPrivLink88');
  assert.equal(savedPlatformFj[0].verified, true);
});

// ============================================================================
// 30. TELEGRAM SINGLE-MESSAGE ANIMATION ENGINE (ANTI-SPAM VERIFICATION)
// ============================================================================
test('Telegram animated progress helper updates a single message via editMessageText without spamming sendMessage', async () => {
  const { fetchImpl, calls } = createMockTelegramFetch();
  const telegram = createTelegramClient(fetchImpl);
  const token = '8880001:AAH_AnimTest_ValidToken_1234567890abcdefg';

  const { messageId, result } = await runAnimatedOperation({
    telegram,
    token,
    chatId: 50001,
    title: '⚡ Testing Progress Animation',
    minStepIntervalMs: 10,
    steps: [
      { label: 'Step 1', doneLabel: 'Step 1 complete', run: async () => ({ a: 1 }) },
      { label: 'Step 2', doneLabel: 'Step 2 complete', run: async (prev) => ({ ...prev, b: 2 }) },
      { label: 'Step 3', doneLabel: 'Step 3 complete', run: async (prev) => ({ ...prev, c: 3 }) },
    ],
  });

  assert.ok(messageId);
  assert.deepEqual(result, { a: 1, b: 2, c: 3 });

  const sends = calls.filter((c) => c.method === 'sendMessage');
  const edits = calls.filter((c) => c.method === 'editMessageText');
  assert.equal(sends.length, 1, 'Must send ONLY 1 initial progress message (zero chat spam)');
  assert.equal(edits.length, 2, 'Subsequent steps must edit the exact same message_id');
  assert.ok(edits.every((e) => e.body.message_id === messageId));
});



