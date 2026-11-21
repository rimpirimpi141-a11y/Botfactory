import React, { useState } from 'react';
import { Award, CheckCircle2, RefreshCw, ShieldCheck, Users } from 'lucide-react';
import { PLAN_TIERS } from '../catalog';
import type { PlatformOverview, PlatformReferralRecord, WorkerConnection } from '../api';
import { createWorkerApi } from '../api';

interface PlansPanelProps {
  connection: WorkerConnection;
  connected: boolean;
  loading: boolean;
  overview: PlatformOverview | null;
  referrals: PlatformReferralRecord[];
  onRefresh: () => void;
}

export function PlansPanel({
  connection,
  connected,
  loading,
  overview,
  referrals,
  onRefresh,
}: PlansPanelProps) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const api = createWorkerApi(connection);

  async function handleReferralStatus(refId: string, status: 'verified' | 'flagged' | 'rejected') {
    setBusyId(refId);
    setNotice(null);
    try {
      await api.updateReferral(refId, { status });
      setNotice(`Referral ${refId} marked ${status} and creator slots recalculated.`);
      onRefresh();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Failed to update referral');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-800/80 bg-[#0D1322] p-5">
        <div>
          <h2 className="font-display text-sm font-semibold text-white">
            Plans & Referral-Based Bot Slot Progression
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-slate-400">
            Every creator starts on <strong className="text-slate-200">FREE (2 bots)</strong> with all 11 functional
            Template Studio bots unlocked. Each verified unique Master Bot referral permanently adds{' '}
            <strong className="text-emerald-400">+1 bot creation slot</strong> and automatically unlocks higher tiers at
            8, 48, and 50 verified referrals.
          </p>
        </div>
        <button
          onClick={onRefresh}
          disabled={!connected || loading}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3.5 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh Stats
        </button>
      </div>

      {/* Live Plan & Referral Breakdown */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard
          label="FREE / STARTER Creators"
          value={
            overview
              ? `${(overview.freeUsers ?? 0).toLocaleString()} / ${(overview.starterUsers ?? 0).toLocaleString()}`
              : 'Data unavailable'
          }
          sub="0–7 refs (FREE) · 8–47 refs (STARTER)"
        />
        <SummaryCard
          label="PRO / ENTERPRISE Creators"
          value={
            overview
              ? `${(overview.proUsers ?? 0).toLocaleString()} / ${(overview.enterpriseUsers ?? 0).toLocaleString()}`
              : 'Data unavailable'
          }
          sub="48–49 refs (PRO) · 50+ refs (ENTERPRISE)"
        />
        <SummaryCard
          label="Verified Platform Referrals"
          value={overview ? (overview.verifiedReferrals ?? 0).toLocaleString() : 'Data unavailable'}
          sub={overview ? `${overview.pendingReferrals ?? 0} pending review` : 'Connect Worker for D1 count'}
        />
        <SummaryCard
          label="Template Access Policy"
          value="11 / 11 Unlocked"
          sub="Zero template category locks on any plan"
        />
      </div>

      {/* 4 Plan Tier Cards */}
      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
        {PLAN_TIERS.map((tier) => (
          <div
            key={tier.id}
            className={`flex flex-col justify-between rounded-xl border p-5 ${
              tier.id === 'enterprise'
                ? 'border-emerald-500/40 bg-[#0D1724]'
                : tier.id === 'pro'
                  ? 'border-blue-500/40 bg-[#0D1322]'
                  : 'border-slate-800/80 bg-[#0D1322]'
            }`}
          >
            <div>
              <div className="flex items-center justify-between">
                <span className="font-display text-sm font-bold tracking-wide text-white">{tier.name}</span>
                <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                  {tier.referralsRequired} refs
                </span>
              </div>
              <div className="mt-3 font-mono text-xl font-semibold text-white tabular-nums">
                {tier.maxBotsLabel}
              </div>
              <div className="mt-1 text-[11px] text-slate-400">{tier.slotFormula}</div>

              <ul className="mt-4 space-y-2 border-t border-slate-800/80 pt-4 text-xs text-slate-300">
                {tier.highlights.map((h) => (
                  <li key={h} className="flex items-start gap-2 leading-relaxed">
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
                    <span>{h}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="mt-5 border-t border-slate-800/70 pt-3 font-mono text-[11px] text-slate-500">
              {tier.id === 'enterprise'
                ? 'Priority rule: overrides 8 & 48 milestones'
                : 'Backend enforced in tenant-manager.js'}
            </div>
          </div>
        ))}
      </div>

      {/* Anti-Abuse & Referral Audit Table */}
      <div className="rounded-xl border border-slate-800/80 bg-[#0D1322]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 px-5 py-4">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-blue-400" />
            <div>
              <h3 className="font-display text-sm font-semibold text-white">Platform Referral Attribution Ledger</h3>
              <p className="text-xs text-slate-400">
                Anti-abuse enforced: new unique Telegram users only · no self-referrals · no bot accounts · permanent
                attribution
              </p>
            </div>
          </div>
          <div className="inline-flex items-center gap-1.5 font-mono text-[11px] text-emerald-400">
            <ShieldCheck className="h-3.5 w-3.5" />
            Server-side D1 verified
          </div>
        </div>

        {notice && (
          <div className="border-b border-slate-800 bg-blue-500/10 px-5 py-2.5 text-xs text-blue-200">{notice}</div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-800/80 text-slate-400">
              <tr>
                <th className="px-5 py-3 font-medium">Referrer</th>
                <th className="px-5 py-3 font-medium">Referred Creator</th>
                <th className="px-5 py-3 font-medium">Code</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium">Attributed At</th>
                <th className="px-5 py-3 text-right font-medium">Owner Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {referrals.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-5 py-10 text-center text-slate-500">
                    {connected
                      ? 'No platform referrals recorded yet. Creators share their deep link from Master Bot -> Plans & Features.'
                      : 'Connect your Cloudflare Worker to inspect and moderate real platform referrals from D1.'}
                  </td>
                </tr>
              ) : (
                referrals.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-800/30">
                    <td className="px-5 py-3">
                      <div className="font-medium text-white">
                        {r.referrer_username ? `@${r.referrer_username}` : r.referrer_telegram_id}
                      </div>
                      <div className="font-mono text-[11px] text-slate-500">{r.referrer_telegram_id}</div>
                    </td>
                    <td className="px-5 py-3">
                      <div className="font-medium text-slate-200">
                        {r.referred_username ? `@${r.referred_username}` : r.referred_telegram_id}
                      </div>
                      <div className="font-mono text-[11px] text-slate-500">{r.referred_telegram_id}</div>
                    </td>
                    <td className="px-5 py-3 font-mono text-[11px] text-slate-300">{r.referral_code}</td>
                    <td className="px-5 py-3 font-mono text-[11px]">
                      <span
                        className={
                          r.status === 'verified'
                            ? 'text-emerald-400'
                            : r.status === 'flagged' || r.status === 'rejected'
                              ? 'text-red-400'
                              : 'text-amber-400'
                        }
                      >
                        {r.status.toUpperCase()}
                      </span>
                    </td>
                    <td className="px-5 py-3 font-mono text-[11px] text-slate-400 tabular-nums">
                      {r.created_at.slice(0, 19).replace('T', ' ')}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <div className="inline-flex items-center gap-1.5">
                        {r.status !== 'verified' && (
                          <button
                            onClick={() => handleReferralStatus(r.id, 'verified')}
                            disabled={busyId === r.id}
                            className="rounded border border-emerald-500/40 px-2 py-1 text-[11px] text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-40"
                          >
                            Verify
                          </button>
                        )}
                        {r.status !== 'flagged' && (
                          <button
                            onClick={() => handleReferralStatus(r.id, 'flagged')}
                            disabled={busyId === r.id}
                            className="rounded border border-amber-500/40 px-2 py-1 text-[11px] text-amber-300 hover:bg-amber-500/10 disabled:opacity-40"
                          >
                            Flag
                          </button>
                        )}
                        {r.status !== 'rejected' && (
                          <button
                            onClick={() => handleReferralStatus(r.id, 'rejected')}
                            disabled={busyId === r.id}
                            className="rounded border border-red-500/40 px-2 py-1 text-[11px] text-red-300 hover:bg-red-500/10 disabled:opacity-40"
                          >
                            Reject
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Policy Footnote */}
      <div className="flex items-start gap-2.5 rounded-xl border border-slate-800/80 bg-[#0D1322] p-4 text-xs text-slate-400">
        <Award className="mt-0.5 h-4 w-4 shrink-0 text-blue-400" />
        <p>
          Reducing or overriding a user&apos;s slot count in Owner Control Center never deletes existing live tenant
          bots — it strictly prevents creating additional bots until slots become available again.
        </p>
      </div>
    </div>
  );
}

function SummaryCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-xl border border-slate-800/80 bg-[#0D1322] p-5">
      <div className="text-xs text-slate-400">{label}</div>
      <div className="mt-2 font-mono text-xl font-semibold text-white tabular-nums">{value}</div>
      <div className="mt-1 text-[11px] text-slate-500">{sub}</div>
    </div>
  );
}
