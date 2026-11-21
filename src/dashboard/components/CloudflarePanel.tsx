import React from 'react';
import { Activity, CheckCircle2, Cloud, Database, HardDrive, Info, RefreshCw, ShieldCheck } from 'lucide-react';
import type { CloudflareMetricsPayload } from '../api';

interface CloudflarePanelProps {
  connected: boolean;
  loading: boolean;
  metrics: CloudflareMetricsPayload | null;
  onRefresh: () => void;
}

function fmtBytes(bytes: number | null | undefined) {
  if (bytes === null || bytes === undefined) return 'Unavailable';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(2)} MB`;
}

function fmtNum(val: number | null | undefined, suffix = '') {
  if (val === null || val === undefined) return 'Unavailable';
  return `${val.toLocaleString()}${suffix}`;
}

export function CloudflarePanel({ connected, loading, metrics, onRefresh }: CloudflarePanelProps) {
  const appHealth = metrics?.applicationHealth;
  const accountConfigured = Boolean(metrics?.accountMetrics?.configured ?? metrics?.configured);
  const accountMessage =
    metrics?.accountMetrics?.message ||
    metrics?.message ||
    'Account-level metrics are not configured.';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800/80 bg-[#0D1322] p-5">
        <div>
          <h2 className="font-display text-sm font-semibold text-white">
            Cloudflare Infrastructure Monitor (Two-Layer Architecture)
          </h2>
          <p className="mt-0.5 text-xs text-slate-400">
            Layer 1 monitors live Worker, D1, KV, and Analytics Engine bindings directly. Layer 2 queries optional
            Cloudflare Account GraphQL/REST telemetry when secrets are provided.{' '}
            {metrics ? `Last updated: ${new Date(metrics.lastUpdated).toLocaleString()}` : 'Not connected'}
          </p>
        </div>
        <button
          onClick={onRefresh}
          disabled={!connected || loading}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3.5 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh Telemetry
        </button>
      </div>

      {/* LAYER 1: Live Application & Worker Health (Always active via Worker bindings) */}
      <div className="rounded-xl border border-slate-800/80 bg-[#0D1322] p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-emerald-400" />
            <h3 className="font-display text-sm font-semibold text-white">
              Layer 1 — Application & Binding Health (Live)
            </h3>
          </div>
          <span
            className={`font-mono text-[11px] uppercase ${
              appHealth?.status === 'healthy'
                ? 'text-emerald-400'
                : metrics
                  ? 'text-amber-400'
                  : 'text-slate-500'
            }`}
          >
            {appHealth ? `STATUS: ${appHealth.status}` : connected ? 'CHECKING...' : 'UNCONNECTED'}
          </span>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <BindingHealthCard
            title="Worker Runtime"
            healthy={Boolean(metrics)}
            primary={appHealth?.worker?.scriptName || 'botfactory'}
            detail={appHealth?.worker?.publicUrl || 'Connect Worker to inspect'}
          />
          <BindingHealthCard
            title="Cloudflare D1 Binding"
            healthy={Boolean(appHealth?.d1.healthy)}
            primary={
              appHealth?.d1.healthy
                ? `Healthy · ${appHealth.d1.latencyMs ?? 0} ms`
                : appHealth?.d1.bound
                  ? 'Degraded'
                  : 'Unconnected'
            }
            detail={
              appHealth?.d1.tableCount
                ? `${appHealth.d1.tableCount} tables verified`
                : appHealth?.d1.error || 'Real SELECT query check'
            }
          />
          <BindingHealthCard
            title="Cloudflare KV Binding"
            healthy={Boolean(appHealth?.kv.healthy)}
            primary={
              appHealth?.kv.healthy
                ? `Healthy · ${appHealth.kv.latencyMs ?? 0} ms`
                : appHealth?.kv.bound
                  ? 'Bound'
                  : 'Unconnected'
            }
            detail={appHealth?.kv.detail || appHealth?.kv.error || 'Config & rate-limit cache active'}
          />
          <BindingHealthCard
            title="Analytics Engine"
            healthy={Boolean(appHealth?.analyticsEngine.bound ?? metrics?.analyticsEngine.bound)}
            primary={
              metrics
                ? (appHealth?.analyticsEngine.bound ?? metrics.analyticsEngine.bound)
                  ? 'Dataset Bound'
                  : 'Not Bound'
                : 'Unconnected'
            }
            detail="Multi-tenant event ingestion"
          />
        </div>

        {/* Application-Level D1 Counters */}
        <div className="mt-5 border-t border-slate-800/80 pt-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Activity className="h-3.5 w-3.5 text-blue-400" />
              <span className="text-xs font-semibold text-slate-200">Application-Level D1 Telemetry</span>
            </div>
            <span className="font-mono text-[11px] text-slate-500">usage_statistics & webhook_logs</span>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <MetricCell label="Requests Today" value={fmtNum(metrics?.applicationCounters.requestsToday)} />
            <MetricCell label="Requests This Month" value={fmtNum(metrics?.applicationCounters.requestsThisMonth)} />
            <MetricCell label="Total Webhook Updates" value={fmtNum(metrics?.applicationCounters.totalWebhookUpdates)} />
            <MetricCell label="Recorded Errors" value={fmtNum(metrics?.applicationCounters.workerErrors)} />
            <MetricCell
              label="Avg Response Duration"
              value={
                metrics?.applicationCounters.avgResponseTimeMs !== null &&
                metrics?.applicationCounters.avgResponseTimeMs !== undefined
                  ? `${metrics.applicationCounters.avgResponseTimeMs} ms`
                  : 'N/A'
              }
            />
          </div>
        </div>
      </div>

      {/* LAYER 2: Cloudflare Account-Level Metrics (Optional GraphQL / REST API) */}
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-display text-sm font-semibold text-white">
            Layer 2 — Cloudflare Account-Level Metrics (Optional API)
          </h3>
          <span
            className={`font-mono text-[11px] uppercase ${
              accountConfigured ? 'text-emerald-400' : 'text-slate-400'
            }`}
          >
            {accountConfigured ? 'GraphQL / REST Connected' : 'Not Configured (Optional)'}
          </span>
        </div>

        {metrics && !accountConfigured && (
          <div className="flex items-start gap-3 rounded-xl border border-slate-700/80 bg-[#0D1322] p-4 text-xs text-slate-300">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-400" />
            <div>
              <div className="font-semibold text-white">{accountMessage}</div>
              <p className="mt-1 text-slate-400">
                Your application bindings in Layer 1 above are operational. To enable optional Cloudflare account-wide
                GraphQL & REST quotas (Workers CPU p50, D1 storage bytes, KV monthly operations), set{' '}
                <code className="font-mono text-slate-200">CLOUDFLARE_API_TOKEN</code> and{' '}
                <code className="font-mono text-slate-200">CLOUDFLARE_ACCOUNT_ID</code> via Wrangler secrets.
              </p>
            </div>
          </div>
        )}

        <div className="grid gap-6 lg:grid-cols-3">
          {/* Workers */}
          <div className="rounded-xl border border-slate-800/80 bg-[#0D1322] p-5">
            <div className="mb-4 flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <Cloud className="h-4 w-4 text-blue-400" />
                <h4 className="font-display text-sm font-semibold text-white">Workers Account Metrics</h4>
              </div>
              <span className="font-mono text-[11px] text-slate-400">
                {metrics?.workers.status === 'available' ? 'Live API' : 'Not configured'}
              </span>
            </div>

            {metrics?.workers.data ? (
              <div className="divide-y divide-slate-800/70 text-xs">
                <MetricRow label="Script" value={metrics.workers.data.scriptName} />
                <MetricRow label="Daily Requests" value={fmtNum(metrics.workers.data.dailyRequests)} />
                <MetricRow label="Monthly Requests" value={fmtNum(metrics.workers.data.monthlyRequests)} />
                <MetricRow label="Request Errors" value={fmtNum(metrics.workers.data.errors)} />
                <MetricRow label="Success Rate" value={fmtNum(metrics.workers.data.successPercentage, '%')} />
                <MetricRow
                  label="CPU Time (p50)"
                  value={
                    metrics.workers.data.cpuTimeP50Us !== null
                      ? `${(metrics.workers.data.cpuTimeP50Us / 1000).toFixed(2)} ms`
                      : 'Unavailable'
                  }
                />
                <MetricRow
                  label="Duration (p50)"
                  value={fmtNum(metrics.workers.data.responseDurationP50Ms, ' ms')}
                />
              </div>
            ) : (
              <p className="py-6 text-xs text-slate-500">
                {metrics?.workers.error || 'Account-level metrics are not configured.'}
              </p>
            )}
          </div>

          {/* D1 */}
          <div className="rounded-xl border border-slate-800/80 bg-[#0D1322] p-5">
            <div className="mb-4 flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <Database className="h-4 w-4 text-emerald-400" />
                <h4 className="font-display text-sm font-semibold text-white">D1 Account Quotas</h4>
              </div>
              <span className="font-mono text-[11px] text-slate-400">
                {metrics?.d1.status === 'available' ? 'Live API' : 'Not configured'}
              </span>
            </div>

            {metrics?.d1.data ? (
              <div className="divide-y divide-slate-800/70 text-xs">
                <MetricRow label="Database Size" value={fmtBytes(metrics.d1.data.databaseSizeBytes)} />
                <MetricRow label="Total Queries (MTD)" value={fmtNum(metrics.d1.data.totalQueries)} />
                <MetricRow label="Read Queries" value={fmtNum(metrics.d1.data.readQueries)} />
                <MetricRow label="Write Queries" value={fmtNum(metrics.d1.data.writeQueries)} />
                <MetricRow label="Rows Read" value={fmtNum(metrics.d1.data.rowsRead)} />
                <MetricRow label="Rows Written" value={fmtNum(metrics.d1.data.rowsWritten)} />
              </div>
            ) : (
              <p className="py-6 text-xs text-slate-500">
                {metrics?.d1.error || 'Account-level metrics are not configured.'}
              </p>
            )}
          </div>

          {/* KV */}
          <div className="rounded-xl border border-slate-800/80 bg-[#0D1322] p-5">
            <div className="mb-4 flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <HardDrive className="h-4 w-4 text-blue-400" />
                <h4 className="font-display text-sm font-semibold text-white">KV Account Operations</h4>
              </div>
              <span className="font-mono text-[11px] text-slate-400">
                {metrics?.kv.status === 'available' ? 'Live API' : 'Not configured'}
              </span>
            </div>

            {metrics?.kv.data ? (
              <div className="divide-y divide-slate-800/70 text-xs">
                <MetricRow label="KV Reads (MTD)" value={fmtNum(metrics.kv.data.reads)} />
                <MetricRow label="KV Writes (MTD)" value={fmtNum(metrics.kv.data.writes)} />
                <MetricRow label="KV Storage Used" value={fmtBytes(metrics.kv.data.storageBytes)} />
                <MetricRow label="Stored Keys" value={fmtNum(metrics.kv.data.keyCount)} />
              </div>
            ) : (
              <p className="py-6 text-xs text-slate-500">
                {metrics?.kv.error || 'Account-level metrics are not configured.'}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function BindingHealthCard({
  title,
  healthy,
  primary,
  detail,
}: {
  title: string;
  healthy: boolean;
  primary: string;
  detail: string;
}) {
  return (
    <div className="rounded-lg border border-slate-800 bg-[#070B14] p-4">
      <div className="flex items-center justify-between text-[11px] text-slate-400">
        <span>{title}</span>
        <CheckCircle2 className={`h-3.5 w-3.5 ${healthy ? 'text-emerald-400' : 'text-slate-600'}`} />
      </div>
      <div className={`mt-2 font-mono text-sm font-semibold tabular-nums ${healthy ? 'text-emerald-400' : 'text-slate-300'}`}>
        {primary}
      </div>
      <div className="mt-1 truncate text-[11px] text-slate-500">{detail}</div>
    </div>
  );
}

function MetricCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-[#070B14] p-3.5">
      <div className="text-[11px] text-slate-400">{label}</div>
      <div className="mt-1.5 font-mono text-base font-semibold text-white tabular-nums">{value}</div>
    </div>
  );
}

function MetricRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-2.5">
      <span className="text-slate-400">{label}</span>
      <span className="font-mono text-slate-100 tabular-nums">{value}</span>
    </div>
  );
}
