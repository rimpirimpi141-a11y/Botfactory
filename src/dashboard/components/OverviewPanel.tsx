import React from 'react';
import {
  Activity,
  Bot,
  Database,
  ExternalLink,
  Plus,
  RefreshCw,
  Shield,
  Users,
  AlertTriangle,
} from 'lucide-react';
import type {
  BotRecord,
  HealthResponse,
  MasterWebhookStatusResponse,
  PlatformOverview,
  WorkerConnection,
} from '../api';
import { MasterWebhookCard } from './MasterWebhookCard';

interface OverviewPanelProps {
  connection: WorkerConnection;
  connected: boolean;
  loading: boolean;
  error: string | null;
  health: HealthResponse | null;
  overview: PlatformOverview | null;
  masterWebhookStatus: MasterWebhookStatusResponse | null;
  topBots: BotRecord[];
  masterBotDeepLink: string | null;
  onRefresh: () => void;
  onMasterWebhookStatusChange: (next: MasterWebhookStatusResponse) => void;
  onOpenConnect: () => void;
  onOpenDeploy: () => void;
}

export function OverviewPanel({
  connection,
  connected,
  loading,
  error,
  health,
  overview,
  masterWebhookStatus,
  topBots,
  masterBotDeepLink,
  onRefresh,
  onMasterWebhookStatusChange,
  onOpenConnect,
  onOpenDeploy,
}: OverviewPanelProps) {
  const fmt = (val: number | null | undefined) =>
    val === null || val === undefined ? 'Data unavailable' : val.toLocaleString();

  const kpis = [
    {
      label: 'Active Verified Bots',
      value: overview ? `${overview.activeBots} / ${overview.totalBots}` : 'Data unavailable',
      sub: overview
        ? `${overview.botsCreatedToday ?? 0} today · ${overview.disabledBots} disabled · ${overview.failedDeployments} failed`
        : 'Connect Worker for D1 count',
      icon: Bot,
    },
    {
      label: 'Creators & Verified Referrals',
      value: overview
        ? `${fmt(overview.totalUsers)} · ${fmt(overview.verifiedReferrals ?? 0)} refs`
        : 'Data unavailable',
      sub: overview
        ? `Free ${overview.freeUsers ?? 0} · Starter ${overview.starterUsers ?? 0} · Pro ${overview.proUsers ?? 0} · Ent ${overview.enterpriseUsers ?? 0}`
        : 'From D1 users & platform_referrals',
      icon: Users,
    },
    {
      label: 'Requests Today / Month',
      value: overview ? `${overview.requestsToday.toLocaleString()} / ${overview.requestsThisMonth.toLocaleString()}` : 'Data unavailable',
      sub: overview ? `${overview.totalWebhookUpdates.toLocaleString()} total updates` : 'Application-level counters',
      icon: Activity,
    },
    {
      label: 'Avg Response / Errors',
      value: overview
        ? `${overview.avgResponseTimeMs !== null ? `${overview.avgResponseTimeMs} ms` : 'N/A'} · ${overview.workerErrors} err`
        : 'Data unavailable',
      sub: overview ? `${overview.totalTransactions.toLocaleString()} ledger transactions` : 'Measured per webhook call',
      icon: Database,
    },
  ];

  const maxDaily = Math.max(1, ...(overview?.dailySeries || []).map((d) => Number(d.requests || 0)));

  return (
    <div className="animate-fade-slide-up space-y-6">
      {!connected && (
        <div className="flex flex-col justify-between gap-4 rounded-xl border border-amber-500/30 bg-[#0D1322] p-5 sm:flex-row sm:items-center">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
            <div>
              <h2 className="font-display text-sm font-semibold text-white">
                Cloudflare Worker Not Connected
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-slate-400">
                BOT FACTORY never displays simulated or hardcoded operational metrics. Connect your deployed Cloudflare
                Worker URL and Admin API Key to inspect live D1 data, verify webhooks, deploy bots, and dispatch global
                broadcasts.
              </p>
            </div>
          </div>
          <button
            onClick={onOpenConnect}
            className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-500 whitespace-nowrap shrink-0"
          >
            Connect Worker
          </button>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-xs text-red-300">
          {error}
        </div>
      )}

      {/* KPI Strip */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {kpis.map((item) => {
          const Icon = item.icon;
          return (
            <div
              key={item.label}
              className="rounded-xl border border-slate-800/80 bg-[#0D1322] p-5 transition-colors hover:border-slate-700"
            >
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>{item.label}</span>
                <Icon className="h-4 w-4 text-slate-500" />
              </div>
              <div className="mt-3 font-mono text-2xl font-semibold tracking-tight text-white tabular-nums">
                {loading ? <div className="bf-skeleton h-7 w-28 rounded-md" /> : item.value}
              </div>
              <div className="mt-1.5 text-xs text-slate-500">
                {loading ? <div className="bf-skeleton h-3.5 w-36 rounded" /> : item.sub}
              </div>
            </div>
          );
        })}
      </div>

      {/* Master Bot Manual Webhook Registration Section */}
      <MasterWebhookCard
        connection={connection}
        connected={connected}
        health={health}
        statusData={masterWebhookStatus}
        onStatusUpdated={onMasterWebhookStatusChange}
        onOpenConnect={onOpenConnect}
      />

      {/* Main Split: Daily Webhook Traffic + Infrastructure Readiness */}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="rounded-xl border border-slate-800/80 bg-[#0D1322] p-5 lg:col-span-2">
          <div className="flex items-center justify-between border-b border-slate-800/80 pb-4">
            <div>
              <h3 className="font-display text-sm font-semibold text-white">Daily Webhook Traffic (14 Days)</h3>
              <p className="text-xs text-slate-400">
                Source: Cloudflare D1 usage_statistics ·{' '}
                {overview ? `Last updated ${new Date(overview.lastUpdated).toLocaleTimeString()}` : 'Data unavailable'}
              </p>
            </div>
            <button
              onClick={onRefresh}
              disabled={!connected || loading}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap shrink-0"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>

          {!overview || overview.dailySeries.length === 0 ? (
            <div className="flex h-52 flex-col items-center justify-center text-center">
              <p className="text-sm font-medium text-slate-300">No webhook traffic recorded yet</p>
              <p className="mt-1 max-w-sm text-xs text-slate-500">
                Once your Worker processes verified Telegram updates for deployed tenant bots, daily throughput appears
                here automatically.
              </p>
            </div>
          ) : (
            <div className="mt-5 flex h-52 items-end gap-2">
              {overview.dailySeries.map((day) => {
                const pct = Math.max(4, Math.round((Number(day.requests) / maxDaily) * 100));
                return (
                  <div key={day.stat_date} className="group flex flex-1 flex-col items-center gap-2">
                    <span className="font-mono text-[10px] text-slate-400 tabular-nums">{day.requests}</span>
                    <div className="flex h-36 w-full items-end">
                      <div
                        style={{ height: `${pct}%` }}
                        className="animate-bar-grow w-full rounded-t bg-blue-600/80 transition-colors group-hover:bg-emerald-500"
                        title={`${day.stat_date}: ${day.requests} requests, ${day.errors} errors`}
                      />
                    </div>
                    <span className="font-mono text-[10px] text-slate-500">{day.stat_date.slice(5)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Binding & Security Posture */}
        <div className="rounded-xl border border-slate-800/80 bg-[#0D1322] p-5">
          <div className="flex items-center justify-between border-b border-slate-800/80 pb-4">
            <h3 className="font-display text-sm font-semibold text-white">Runtime Architecture</h3>
            <Shield className="h-4 w-4 text-emerald-400" />
          </div>

          <div className="mt-4 divide-y divide-slate-800/70 text-xs">
            <StatusLine
              label="Cloudflare D1 Schema"
              value={
                health
                  ? health.bindings.d1.healthy
                    ? `Verified (${health.bindings.d1.tableCount} tables)`
                    : 'Migration Pending'
                  : 'Unconnected'
              }
              good={Boolean(health?.bindings.d1.healthy)}
            />
            <StatusLine
              label="KV Config Cache"
              value={health ? (health.bindings.kv ? 'Bound' : 'Not Bound') : 'Unconnected'}
              good={Boolean(health?.bindings.kv)}
            />
            <StatusLine
              label="Analytics Engine"
              value={health ? (health.bindings.analyticsEngine ? 'Bound' : 'Not Bound') : 'Unconnected'}
              good={Boolean(health?.bindings.analyticsEngine)}
            />
            <StatusLine
              label="Token Encryption"
              value={health ? (health.bindings.encryptionKeyConfigured ? 'AES-256-GCM Active' : 'Secret Missing') : 'Unconnected'}
              good={Boolean(health?.bindings.encryptionKeyConfigured)}
            />
            <StatusLine
              label="Master Bot Token"
              value={health ? (health.bindings.masterBotConfigured ? 'Configured' : 'Secret Missing') : 'Unconnected'}
              good={Boolean(health?.bindings.masterBotConfigured)}
            />
            <StatusLine
              label="Multi-Tenant Model"
              value="1 Shared Worker · /webhook/:botId"
              good={true}
            />
          </div>

          <div className="mt-5 flex flex-col gap-2">
            <button
              onClick={onOpenDeploy}
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-emerald-500"
            >
              <Plus className="h-3.5 w-3.5" />
              Deploy New Tenant Bot
            </button>
            {masterBotDeepLink && (
              <a
                href={masterBotDeepLink}
                target="_blank"
                rel="noreferrer"
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-slate-700 px-4 py-2 text-xs font-medium text-slate-200 transition-colors hover:bg-slate-800"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Open Master Bot on Telegram
              </a>
            )}
          </div>
        </div>
      </div>

      {/* Active Tenant Fleet Preview */}
      <div className="rounded-xl border border-slate-800/80 bg-[#0D1322]">
        <div className="flex items-center justify-between border-b border-slate-800/80 px-5 py-4">
          <div>
            <h3 className="font-display text-sm font-semibold text-white">Top Active Tenant Bots</h3>
            <p className="text-xs text-slate-400">Sorted by real processed webhook updates in D1</p>
          </div>
        </div>
        {topBots.length === 0 ? (
          <div className="px-5 py-10 text-center text-xs text-slate-500">
            {connected
              ? 'No tenant bots deployed yet. Deploy your first bot via the Master Bot or "Deploy New Tenant Bot".'
              : 'Connect your Cloudflare Worker to inspect deployed tenant bots.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-800/80 text-slate-400">
                <tr>
                  <th className="px-5 py-3 font-medium">Bot</th>
                  <th className="px-5 py-3 font-medium">Template</th>
                  <th className="px-5 py-3 font-medium">Status / Webhook</th>
                  <th className="px-5 py-3 text-right font-medium">Users</th>
                  <th className="px-5 py-3 text-right font-medium">Updates</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {topBots.map((b) => (
                  <tr key={b.id} className="hover:bg-slate-800/30">
                    <td className="px-5 py-3">
                      <div className="font-medium text-white">{b.display_name}</div>
                      <div className="font-mono text-[11px] text-slate-400">
                        @{b.telegram_username} · {b.id}
                      </div>
                    </td>
                    <td className="px-5 py-3 text-slate-300">{b.template_name || b.template_id}</td>
                    <td className="px-5 py-3">
                      <span
                        className={`font-mono text-[11px] ${
                          b.status === 'active' && b.webhook_status === 'verified'
                            ? 'text-emerald-400'
                            : b.status === 'failed'
                              ? 'text-red-400'
                              : 'text-amber-400'
                        }`}
                      >
                        {b.status.toUpperCase()} · {b.webhook_status.toUpperCase()}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-right font-mono text-slate-200 tabular-nums">
                      {b.total_users.toLocaleString()}
                    </td>
                    <td className="px-5 py-3 text-right font-mono text-slate-200 tabular-nums">
                      {b.total_updates.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusLine({ label, value, good }: { label: string; value: string; good: boolean }) {
  return (
    <div className="flex items-center justify-between py-2.5">
      <span className="text-slate-400">{label}</span>
      <span className={`font-mono text-[11px] ${good ? 'text-emerald-400' : 'text-slate-400'}`}>{value}</span>
    </div>
  );
}
