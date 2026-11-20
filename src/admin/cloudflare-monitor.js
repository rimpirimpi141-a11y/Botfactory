/**
 * Cloudflare Infrastructure Monitor.
 *
 * Uses official Cloudflare GraphQL Analytics API & REST API when least-privilege
 * secrets (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID) are configured.
 *
 * STRICT HONESTY RULE:
 * - Clearly separates Application-level D1 counters from Cloudflare Infrastructure metrics.
 * - If Cloudflare API credentials or datasets are unavailable, explicitly returns
 *   status: 'unavailable' and null metric values — NEVER invents fake live metrics.
 */

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

export async function getCloudflareInfrastructureMetrics(env, repos, fetchImpl = globalThis.fetch) {
  const checkedAt = new Date().toISOString();
  const appMetrics = await repos.stats.getPlatformOverview();

  const accountId = env?.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = env?.CLOUDFLARE_API_TOKEN;
  const scriptName = env?.CLOUDFLARE_WORKER_SCRIPT_NAME || 'bot-factory';
  const d1DatabaseId = env?.CLOUDFLARE_D1_DATABASE_ID || '';
  const kvNamespaceId = env?.CLOUDFLARE_KV_NAMESPACE_ID || '';

  if (!accountId || !apiToken) {
    return {
      configured: false,
      status: 'unavailable',
      message: 'Cloudflare API credentials (CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN) are not configured as Worker secrets.',
      lastUpdated: checkedAt,
      applicationCounters: {
        source: 'Cloudflare D1 (Application-Level)',
        requestsToday: appMetrics.requestsToday,
        requestsThisMonth: appMetrics.requestsThisMonth,
        workerErrors: appMetrics.workerErrors,
        avgResponseTimeMs: appMetrics.avgResponseTimeMs,
        totalWebhookUpdates: appMetrics.totalWebhookUpdates,
      },
      workers: { status: 'unavailable', data: null },
      d1: { status: 'unavailable', data: null },
      kv: { status: 'unavailable', data: null },
      analyticsEngine: {
        bound: Boolean(env?.ANALYTICS),
        status: env?.ANALYTICS ? 'bound_write_active' : 'unavailable',
      },
    };
  }

  const now = new Date();
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const nowIso = now.toISOString();
  const todayDate = startOfDay.slice(0, 10);
  const monthStartDate = startOfMonth.slice(0, 10);

  const result = {
    configured: true,
    status: 'connected',
    lastUpdated: checkedAt,
    applicationCounters: {
      source: 'Cloudflare D1 (Application-Level)',
      requestsToday: appMetrics.requestsToday,
      requestsThisMonth: appMetrics.requestsThisMonth,
      workerErrors: appMetrics.workerErrors,
      avgResponseTimeMs: appMetrics.avgResponseTimeMs,
      totalWebhookUpdates: appMetrics.totalWebhookUpdates,
    },
    workers: { status: 'unavailable', data: null, error: null },
    d1: { status: 'unavailable', data: null, error: null },
    kv: { status: 'unavailable', data: null, error: null },
    analyticsEngine: {
      bound: Boolean(env?.ANALYTICS),
      status: env?.ANALYTICS ? 'bound_write_active' : 'unavailable',
    },
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

    result.workers = {
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
    result.workers = { status: 'unavailable', data: null, error: err?.message || 'Workers metrics unavailable' };
  }

  // 2. D1 Database Metrics (GraphQL + REST database info)
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

    result.d1 = {
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
    result.d1 = { status: 'unavailable', data: null, error: err?.message || 'D1 metrics unavailable' };
  }

  // 3. KV Storage Metrics (GraphQL)
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

    result.kv = {
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
    result.kv = { status: 'unavailable', data: null, error: err?.message || 'KV metrics unavailable' };
  }

  return result;
}
