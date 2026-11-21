/**
 * Two-Layer Cloudflare Infrastructure Monitor.
 *
 * LAYER 1 — APPLICATION HEALTH (Works immediately via existing Worker bindings — NO Cloudflare API token required):
 * - Worker runtime responsiveness
 * - Cloudflare D1 connectivity, schema integrity, and query latency
 * - Cloudflare KV connectivity (real read/write/delete probe)
 * - Cloudflare Analytics Engine binding status
 * - Master Bot webhook status (from D1)
 * - Tenant Bot webhook health summary (verified / failed / disabled)
 * - Application errors & recent deployments
 *
 * LAYER 2 — CLOUDFLARE ACCOUNT METRICS (Optional — requires CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN):
 * - Workers, D1, and KV account-level GraphQL metrics
 * - When credentials are absent, explicitly reports "Account-level metrics are not configured."
 *   WITHOUT marking a healthy application as broken or failed!
 */

import { verifyDatabaseSchema } from '../database/migrations.js';

const CF_GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';
const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

async function queryCloudflareGraphQL(apiToken, query, variables, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(CF_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`Cloudflare GraphQL returned HTTP ${res.status}`);
  }
  const body = await res.json();
  if (Array.isArray(body?.errors) && body.errors.length > 0) {
    throw new Error(body.errors[0]?.message || 'Cloudflare GraphQL query error');
  }
  return body?.data || null;
}

async function probeKvBinding(kv) {
  if (!kv) {
    return { bound: false, healthy: false, latencyMs: null, detail: 'KV binding not attached' };
  }
  const start = Date.now();
  const key = 'health:ping';
  const marker = String(start);
  try {
    await kv.put(key, marker, { expirationTtl: 60 });
    const readBack = await kv.get(key);
    await kv.delete(key).catch(() => {});
    return {
      bound: true,
      healthy: readBack === marker,
      latencyMs: Date.now() - start,
      detail: readBack === marker ? 'Read/write verified' : 'KV write/read mismatch',
    };
  } catch (err) {
    return {
      bound: true,
      healthy: false,
      latencyMs: Date.now() - start,
      detail: err?.message || 'KV probe failed',
    };
  }
}

export async function getCloudflareInfrastructureMetrics(env, repos, fetchImpl = globalThis.fetch) {
  const checkedAt = new Date().toISOString();

  // =========================================================================
  // LAYER 1: APPLICATION HEALTH (Always Live via Worker Bindings)
  // =========================================================================
  const [appMetrics, schemaHealth, kvProbe, settingsRes, recentDeployments] = await Promise.all([
    repos.stats.getPlatformOverview(),
    verifyDatabaseSchema(repos.db).catch((err) => ({
      healthy: false,
      tableCount: 0,
      missingTables: [],
      seededTemplates: 0,
      latencyMs: null,
      error: err?.message || 'D1 check failed',
    })),
    probeKvBinding(env?.KV),
    repos.stats.getSettings().catch(() => ({ map: {} })),
    repos.deployments ? repos.deployments.listRecent(10) : Promise.resolve([]),
  ]);

  const sMap = settingsRes.map || {};
  const d1Healthy = Boolean(schemaHealth?.healthy);
  const overallAppHealthy = d1Healthy && (kvProbe.bound ? kvProbe.healthy : true);

  const applicationHealth = {
    status: overallAppHealthy ? 'healthy' : 'degraded',
    checkedAt,
    worker: {
      healthy: true,
      scriptName: env?.CLOUDFLARE_WORKER_SCRIPT_NAME || 'botfactory',
      publicUrl: env?.WORKER_PUBLIC_URL || 'https://botfactory.rimpirimpi141.workers.dev',
    },
    d1: {
      bound: Boolean(env?.DB),
      healthy: d1Healthy,
      latencyMs: schemaHealth?.latencyMs ?? null,
      tableCount: schemaHealth?.tableCount ?? 0,
      seededTemplates: schemaHealth?.seededTemplates ?? 0,
      upgrade0003Applied: Boolean(schemaHealth?.upgrade0003Applied),
      missingTables: schemaHealth?.missingTables || [],
    },
    kv: kvProbe,
    analyticsEngine: {
      bound: Boolean(env?.ANALYTICS),
      status: env?.ANALYTICS ? 'bound_write_active' : 'not_bound',
    },
    masterWebhook: {
      status: sMap.master_webhook_last_status || 'not_registered',
      verified: sMap.master_webhook_last_status === 'verified',
      lastRegisteredAt: sMap.master_webhook_last_registered_at || null,
      lastVerifiedAt: sMap.master_webhook_last_verified_at || null,
      lastError: sMap.master_webhook_last_error || null,
    },
    tenantWebhooks: {
      totalBots: appMetrics.totalBots,
      verifiedActive: appMetrics.activeBots,
      failedDeployments: appMetrics.failedDeployments,
      disabledBots: appMetrics.disabledBots,
    },
    applicationErrors: appMetrics.workerErrors,
    recentDeployments,
  };

  const applicationCounters = {
    source: 'Cloudflare D1 (Application-Level)',
    requestsToday: appMetrics.requestsToday,
    requestsThisMonth: appMetrics.requestsThisMonth,
    workerErrors: appMetrics.workerErrors,
    avgResponseTimeMs: appMetrics.avgResponseTimeMs,
    totalWebhookUpdates: appMetrics.totalWebhookUpdates,
  };

  // =========================================================================
  // LAYER 2: CLOUDFLARE ACCOUNT METRICS (Optional API Credentials)
  // =========================================================================
  const accountId = env?.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = env?.CLOUDFLARE_API_TOKEN;
  const scriptName = env?.CLOUDFLARE_WORKER_SCRIPT_NAME || 'botfactory';
  const d1DatabaseId = env?.CLOUDFLARE_D1_DATABASE_ID || '';
  const kvNamespaceId = env?.CLOUDFLARE_KV_NAMESPACE_ID || '';

  if (!accountId || !apiToken) {
    const accountMetrics = {
      configured: false,
      status: 'not_configured',
      message: 'Account-level metrics are not configured.',
      detail:
        'Application Health above is fully live via Worker bindings. Add optional CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN secrets to view account-wide Cloudflare GraphQL billing & quota telemetry.',
      workers: { status: 'unavailable', data: null },
      d1: { status: 'unavailable', data: null },
      kv: { status: 'unavailable', data: null },
    };

    return {
      // Layer 1 & Layer 2 structured objects
      applicationHealth,
      accountMetrics,
      // Backward-compatible top-level properties
      configured: false,
      status: 'unavailable',
      message: accountMetrics.message,
      lastUpdated: checkedAt,
      applicationCounters,
      workers: accountMetrics.workers,
      d1: accountMetrics.d1,
      kv: accountMetrics.kv,
      analyticsEngine: applicationHealth.analyticsEngine,
    };
  }

  const now = new Date();
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const nowIso = now.toISOString();
  const todayDate = startOfDay.slice(0, 10);
  const monthStartDate = startOfMonth.slice(0, 10);

  const accountMetrics = {
    configured: true,
    status: 'connected',
    message: 'Cloudflare Account GraphQL API connected.',
    workers: { status: 'unavailable', data: null, error: null },
    d1: { status: 'unavailable', data: null, error: null },
    kv: { status: 'unavailable', data: null, error: null },
  };

  // 1. Workers Analytics (GraphQL)
  try {
    const workersQuery = `
      query WorkersMetrics($accountTag: String!, $scriptName: String!, $startMonth: Time!, $startDay: Time!, $end: Time!) {
        viewer {
          accounts(filter: { accountTag: $accountTag }) {
            month: workersInvocationsAdaptive(
              limit: 100
              filter: { scriptName: $scriptName, datetime_geq: $startMonth, datetime_leq: $end }
            ) {
              sum { requests errors subrequests }
              quantiles { cpuTimeP50 cpuTimeP99 durationP50 }
            }
            day: workersInvocationsAdaptive(
              limit: 100
              filter: { scriptName: $scriptName, datetime_geq: $startDay, datetime_leq: $end }
            ) {
              sum { requests errors }
            }
          }
        }
      }
    `;
    const data = await queryCloudflareGraphQL(
      apiToken,
      workersQuery,
      { accountTag: accountId, scriptName, startMonth: startOfMonth, startDay: startOfDay, end: nowIso },
      fetchImpl
    );
    const acc = data?.viewer?.accounts?.[0];
    const monthRows = acc?.month || [];
    const dayRows = acc?.day || [];

    const monthlyRequests = monthRows.reduce((s, r) => s + Number(r?.sum?.requests || 0), 0);
    const monthlyErrors = monthRows.reduce((s, r) => s + Number(r?.sum?.errors || 0), 0);
    const dailyRequests = dayRows.reduce((s, r) => s + Number(r?.sum?.requests || 0), 0);
    const cpuP50 = monthRows[0]?.quantiles?.cpuTimeP50 ?? null;
    const durationP50 = monthRows[0]?.quantiles?.durationP50 ?? null;
    const successRate =
      monthlyRequests > 0 ? Number((((monthlyRequests - monthlyErrors) / monthlyRequests) * 100).toFixed(2)) : null;

    accountMetrics.workers = {
      status: 'available',
      data: {
        scriptName,
        dailyRequests,
        monthlyRequests,
        errors: monthlyErrors,
        successPercentage: successRate,
        cpuTimeP50Us: cpuP50,
        responseDurationP50Ms: durationP50,
      },
    };
  } catch (err) {
    accountMetrics.workers = { status: 'unavailable', data: null, error: err?.message || 'Workers metrics unavailable' };
  }

  // 2. D1 Database Metrics
  try {
    let databaseSizeBytes = null;
    if (d1DatabaseId) {
      const infoRes = await fetchImpl(`${CF_API_BASE}/accounts/${accountId}/d1/database/${d1DatabaseId}`, {
        headers: { Authorization: `Bearer ${apiToken}` },
      });
      if (infoRes.ok) {
        const infoJson = await infoRes.json();
        databaseSizeBytes = infoJson?.result?.file_size ?? null;
      }
    }

    const d1Query = `
      query D1Metrics($accountTag: String!, $start: Date!, $end: Date!) {
        viewer {
          accounts(filter: { accountTag: $accountTag }) {
            d1AnalyticsAdaptiveGroups(limit: 100, filter: { date_geq: $start, date_leq: $end }) {
              sum { readQueries writeQueries rowsRead rowsWritten }
              avg { queryBatchResponseBytes }
            }
          }
        }
      }
    `;
    const data = await queryCloudflareGraphQL(
      apiToken,
      d1Query,
      { accountTag: accountId, start: monthStartDate, end: todayDate },
      fetchImpl
    );
    const groups = data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups || [];
    const readQueries = groups.reduce((s, g) => s + Number(g?.sum?.readQueries || 0), 0);
    const writeQueries = groups.reduce((s, g) => s + Number(g?.sum?.writeQueries || 0), 0);
    const rowsRead = groups.reduce((s, g) => s + Number(g?.sum?.rowsRead || 0), 0);
    const rowsWritten = groups.reduce((s, g) => s + Number(g?.sum?.rowsWritten || 0), 0);

    accountMetrics.d1 = {
      status: 'available',
      data: {
        databaseId: d1DatabaseId || null,
        databaseSizeBytes,
        readQueries,
        writeQueries,
        totalQueries: readQueries + writeQueries,
        rowsRead,
        rowsWritten,
      },
    };
  } catch (err) {
    accountMetrics.d1 = { status: 'unavailable', data: null, error: err?.message || 'D1 metrics unavailable' };
  }

  // 3. KV Storage Metrics
  try {
    const kvQuery = `
      query KVMetrics($accountTag: String!, $start: Date!, $end: Date!) {
        viewer {
          accounts(filter: { accountTag: $accountTag }) {
            kvOperationsAdaptiveGroups(limit: 100, filter: { date_geq: $start, date_leq: $end }) {
              dimensions { actionType }
              sum { requests }
            }
            kvStorageAdaptiveGroups(limit: 5, filter: { date_geq: $start, date_leq: $end }) {
              max { byteCount keyCount }
            }
          }
        }
      }
    `;
    const data = await queryCloudflareGraphQL(
      apiToken,
      kvQuery,
      { accountTag: accountId, start: monthStartDate, end: todayDate },
      fetchImpl
    );
    const acc = data?.viewer?.accounts?.[0];
    const ops = acc?.kvOperationsAdaptiveGroups || [];
    const storage = acc?.kvStorageAdaptiveGroups?.[0]?.max || {};
    let reads = 0;
    let writes = 0;
    for (const op of ops) {
      const action = String(op?.dimensions?.actionType || '').toLowerCase();
      const count = Number(op?.sum?.requests || 0);
      if (action === 'read' || action === 'list') reads += count;
      if (action === 'write' || action === 'delete') writes += count;
    }

    accountMetrics.kv = {
      status: 'available',
      data: {
        namespaceId: kvNamespaceId || null,
        reads,
        writes,
        storageBytes: storage.byteCount ?? null,
        keyCount: storage.keyCount ?? null,
      },
    };
  } catch (err) {
    accountMetrics.kv = { status: 'unavailable', data: null, error: err?.message || 'KV metrics unavailable' };
  }

  return {
    applicationHealth,
    accountMetrics,
    configured: true,
    status: 'connected',
    lastUpdated: checkedAt,
    applicationCounters,
    workers: accountMetrics.workers,
    d1: accountMetrics.d1,
    kv: accountMetrics.kv,
    analyticsEngine: applicationHealth.analyticsEngine,
  };
}
