import React from 'react';
import { Cloud, Database, HardDrive, RefreshCw, Activity, AlertCircle } from 'lucide-react';
import type { CloudflareMetricsPayload } from '../api';

interface CloudflarePanelProps {
  connected: boolean;
  loading: boolean;
  metrics: CloudflareMetricsPayload | null;
  onRefresh: () => void;
}

function fmtBytes(bytes: number | null | undefined) {
  if (bytes === null || bytes === undefined) return 'Data unavailable';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(2)} MB`;
}

function fmtNum(val: number | null | undefined, suffix = '') {
  if (val === null || val === undefined) return 'Data unavailable';
  return `${val.toLocaleString()}${suffix}`;
}

export function CloudflarePanel({ connected, loading, metrics, onRefresh }: CloudflarePanelProps) {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800/80 bg-[#0D1322] p-5">
        <div>
          <h2 className="font-display text-sm font-semibold text-white">Cloudflare Infrastructure Monitor</h2>
          <p className="mt-0.5 text-xs text-slate-400">
            Distinguishes Application-Level D1 counters from Cloudflare GraphQL & REST infrastructure telemetry.{' '}
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

      {metrics && !metrics.configured && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-xs text-amber-200">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
          <div>
            <div className="font-semibold">Cloudflare GraphQL API Secrets Not Configured</div>
            <p className="mt-1 text-amber-200/80">
              {metrics.message} Configure a least-privilege API token (Account Analytics:Read, Workers Scripts:Read,
              D1:Read, Workers KV Storage:Read) via{' '}
              <code className="font-mono">wrangler secret put CLOUDFLARE_API_TOKEN</code> and{' '}
              <code className="font-mono">CLOUDFLARE_ACCOUNT_ID</code>. Application-level D1 metrics remain active below.
            </p>
          </div>
        </div>
      )}

      {/* Application-Level Counters (Always sourced from D1 when connected) */}
      <div className="rounded-xl border border-slate-800/80 bg-[#0D1322] p-5">
        <div className="mb-4 flex items-center justify-between border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-emerald-400" />
            <h3 className="font-display text-sm font-semibold text-white">Application-Level Counters (Cloudflare D1)</h3>
          </div>
          <span className="font-mono text-[11px] text-slate-500">Source of truth: usage_statistics & webhook_logs</span>
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
                : 'Data unavailable'
            }
          />
        </div>
      </div>

      {/* Cloudflare Infrastructure Cards */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Workers */}
        <div className="rounded-xl border border-slate-800/80 bg-[#0D1322] p-5">
          <div className="mb-4 flex items-center justify-between border-b border-slate-800 pb-3">
            <div className="flex items-center gap-2">
              <Cloud className="h-4 w-4 text-blue-400" />
              <h3 className="font-display text-sm font-semibold text-white">Cloudflare Workers</h3>
            </div>
            <span className="font-mono text-[11px] text-slate-400">
              {metrics?.workers.status === 'available' ? 'Live API' : 'Data unavailable'}
            </span>
          </div>

          {metrics?.workers.data ? (
            <div className="divide-y divide-slate-800/70 text-xs">
              <MetricRow label="Script" value={metrics.workers.data.scriptName} />
              <MetricRow label="Daily Requests" value={fmtNum(metrics.workers.data.dailyRequests)} />
              <MetricRow label="Monthly Requests" value={fmtNum(metrics.workers.data.monthlyRequests)} />
              <MetricRow label="Request Errors" value={fmtNum(metrics.workers.data.errors)} />
              <MetricRow
                label="Success Rate"
                value={fmtNum(metrics.workers.data.successPercentage, '%')}
              />
              <MetricRow
                label="CPU Time (p50)"
                value={
                  metrics.workers.data.cpuTimeP50Us !== null
                    ? `${(metrics.workers.data.cpuTimeP50Us / 1000).toFixed(2)} ms`
                    : 'Data unavailable'
                }
              />
              <MetricRow
                label="Duration (p50)"
                value={fmtNum(metrics.workers.data.responseDurationP50Ms, ' ms')}
              />
            </div>
          ) : (
            <p className="py-6 text-xs text-slate-500">
              {metrics?.workers.error || 'Data unavailable — connect Worker with CLOUDFLARE_API_TOKEN configured.'}
            </p>
          )}
        </div>

        {/* D1 */}
        <div className="rounded-xl border border-slate-800/80 bg-[#0D1322] p-5">
          <div className="mb-4 flex items-center justify-between border-b border-slate-800 pb-3">
            <div className="flex items-center gap-2">
              <Database className="h-4 w-4 text-emerald-400" />
              <h3 className="font-display text-sm font-semibold text-white">Cloudflare D1 Database</h3>
            </div>
            <span className="font-mono text-[11px] text-slate-400">
              {metrics?.d1.status === 'available' ? 'Live API' : 'Data unavailable'}
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
              {metrics?.d1.error || 'Data unavailable — configure CLOUDFLARE_D1_DATABASE_ID & API token.'}
            </p>
          )}
        </div>

        {/* KV & Analytics Engine */}
        <div className="rounded-xl border border-slate-800/80 bg-[#0D1322] p-5">
          <div className="mb-4 flex items-center justify-between border-b border-slate-800 pb-3">
            <div className="flex items-center gap-2">
              <HardDrive className="h-4 w-4 text-blue-400" />
              <h3 className="font-display text-sm font-semibold text-white">Cloudflare KV & Analytics</h3>
            </div>
            <span className="font-mono text-[11px] text-slate-400">
              {metrics?.kv.status === 'available' ? 'Live API' : 'Data unavailable'}
            </span>
          </div>

          {metrics?.kv.data ? (
            <div className="divide-y divide-slate-800/70 text-xs">
              <MetricRow label="KV Reads (MTD)" value={fmtNum(metrics.kv.data.reads)} />
              <MetricRow label="KV Writes (MTD)" value={fmtNum(metrics.kv.data.writes)} />
              <MetricRow label="KV Storage Used" value={fmtBytes(metrics.kv.data.storageBytes)} />
              <MetricRow label="Stored Keys" value={fmtNum(metrics.kv.data.keyCount)} />
              <MetricRow
                label="Analytics Engine"
                value={metrics.analyticsEngine.bound ? 'Dataset Bound (Active)' : 'Not Bound'}
              />
            </div>
          ) : (
            <div className="space-y-3 py-6 text-xs text-slate-500">
              <p>{metrics?.kv.error || 'KV metrics unavailable — configure Cloudflare API token.'}</p>
              <div className="border-t border-slate-800 pt-3">
                <MetricRow
                  label="Analytics Engine Binding"
                  value={metrics ? (metrics.analyticsEngine.bound ? 'Bound' : 'Not Bound') : 'Data unavailable'}
                />
              </div>
            </div>
          )}
        </div>
      </div>
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
