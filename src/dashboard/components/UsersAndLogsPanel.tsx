import React, { useState } from 'react';
import { RefreshCw, Search, ShieldAlert, Save } from 'lucide-react';
import type { SystemLogRecord, UserRecord, WorkerConnection } from '../api';
import { createWorkerApi } from '../api';

interface UsersAndLogsPanelProps {
  connection: WorkerConnection;
  connected: boolean;
  users: UserRecord[];
  logs: SystemLogRecord[];
  settings: Record<string, string>;
  loading: boolean;
  onRefresh: () => void;
}

export function UsersAndLogsPanel({
  connection,
  connected,
  users,
  logs,
  settings,
  loading,
  onRefresh,
}: UsersAndLogsPanelProps) {
  const [subTab, setSubTab] = useState<'users' | 'security' | 'logs'>('users');
  const [query, setQuery] = useState('');
  const [logLevel, setLogLevel] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [draftSettings, setDraftSettings] = useState<Record<string, string>>(settings);
  const [savingSettings, setSavingSettings] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  React.useEffect(() => {
    setDraftSettings(settings);
  }, [settings]);

  const api = createWorkerApi(connection);

  const filteredUsers = users.filter((u) => {
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    return (
      u.telegram_id.includes(q) ||
      (u.username || '').toLowerCase().includes(q) ||
      (u.first_name || '').toLowerCase().includes(q)
    );
  });

  const filteredLogs = logs.filter((l) => (!logLevel ? true : l.level === logLevel));

  async function handlePlanChange(telegramId: string, plan: string) {
    setBusyId(telegramId);
    setNotice(null);
    try {
      await api.updateUser(telegramId, { plan });
      setNotice(`Updated user ${telegramId} plan to ${plan}.`);
      onRefresh();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setBusyId(null);
    }
  }

  async function handleSuspendToggle(user: UserRecord) {
    setBusyId(user.telegram_id);
    setNotice(null);
    try {
      const suspend = user.status !== 'suspended';
      await api.updateUser(user.telegram_id, { suspend });
      setNotice(`${suspend ? 'Suspended' : 'Restored'} account ${user.telegram_id}.`);
      onRefresh();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setBusyId(null);
    }
  }

  async function handleSaveSettings(e: React.FormEvent) {
    e.preventDefault();
    setSavingSettings(true);
    setNotice(null);
    try {
      await api.saveSettings(draftSettings);
      setNotice('Global platform settings saved to D1.');
      onRefresh();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSavingSettings(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* Sub-navigation */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-[#0D1322] p-1">
          {(
            [
              ['users', 'User Management'],
              ['security', 'Global Settings & Emergency'],
              ['logs', 'System & Audit Logs'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setSubTab(id)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                subTab === id ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <button
          onClick={onRefresh}
          disabled={!connected || loading}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-40"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {notice && (
        <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 px-4 py-2.5 text-xs text-blue-200">
          {notice}
        </div>
      )}

      {subTab === 'users' && (
        <div className="space-y-4">
          <div className="relative max-w-sm">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by Telegram ID, @username, name..."
              className="w-full rounded-lg border border-slate-800 bg-[#0D1322] py-2 pr-3 pl-9 text-xs text-slate-100 placeholder-slate-500"
            />
          </div>

          <div className="rounded-xl border border-slate-800/80 bg-[#0D1322]">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-800/80 text-slate-400">
                  <tr>
                    <th className="px-5 py-3 font-medium">Telegram User</th>
                    <th className="px-5 py-3 font-medium">Role / Status</th>
                    <th className="px-5 py-3 font-medium">Subscription Plan</th>
                    <th className="px-5 py-3 text-right font-medium">Created Bots</th>
                    <th className="px-5 py-3 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {filteredUsers.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-5 py-10 text-center text-slate-500">
                        {connected ? 'No users found.' : 'Connect your Worker to load users from D1.'}
                      </td>
                    </tr>
                  ) : (
                    filteredUsers.map((u) => (
                      <tr key={u.id} className="hover:bg-slate-800/30">
                        <td className="px-5 py-3">
                          <div className="font-medium text-white">
                            {u.first_name || 'Unknown'} {u.username ? `(@${u.username})` : ''}
                          </div>
                          <div className="font-mono text-[11px] text-slate-500">{u.telegram_id}</div>
                        </td>
                        <td className="px-5 py-3 font-mono text-[11px]">
                          <span className={u.status === 'active' ? 'text-emerald-400' : 'text-red-400'}>
                            {u.role.toUpperCase()} · {u.status.toUpperCase()}
                          </span>
                        </td>
                        <td className="px-5 py-3">
                          <select
                            value={u.plan}
                            disabled={busyId === u.telegram_id}
                            onChange={(e) => handlePlanChange(u.telegram_id, e.target.value)}
                            className="rounded border border-slate-700 bg-[#070B14] px-2 py-1 text-xs text-slate-200"
                          >
                            <option value="free">Free</option>
                            <option value="starter">Starter</option>
                            <option value="pro">Pro</option>
                            <option value="enterprise">Enterprise</option>
                          </select>
                        </td>
                        <td className="px-5 py-3 text-right font-mono tabular-nums">{u.bot_count}</td>
                        <td className="px-5 py-3 text-right">
                          <button
                            onClick={() => handleSuspendToggle(u)}
                            disabled={busyId === u.telegram_id || u.role === 'super_admin'}
                            className={`rounded-md border px-2.5 py-1 text-[11px] font-medium disabled:opacity-30 ${
                              u.status === 'suspended'
                                ? 'border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10'
                                : 'border-red-500/40 text-red-300 hover:bg-red-500/10'
                            }`}
                          >
                            {u.status === 'suspended' ? 'Restore Account' : 'Suspend Account'}
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {subTab === 'security' && (
        <form onSubmit={handleSaveSettings} className="space-y-5 rounded-xl border border-slate-800/80 bg-[#0D1322] p-6">
          <div className="flex items-center gap-2 border-b border-slate-800 pb-3">
            <ShieldAlert className="h-4 w-4 text-red-400" />
            <h3 className="font-display text-sm font-semibold text-white">
              Global Settings & Emergency Kill-Switches
            </h3>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex items-center justify-between rounded-lg border border-slate-800 bg-[#070B14] p-3.5 text-xs">
              <div>
                <div className="font-semibold text-white">Maintenance Mode</div>
                <div className="text-[11px] text-slate-400">Pause new tenant deployments for non-owner users</div>
              </div>
              <input
                type="checkbox"
                checked={draftSettings.maintenance_mode === 'true'}
                onChange={(e) =>
                  setDraftSettings((p) => ({ ...p, maintenance_mode: e.target.checked ? 'true' : 'false' }))
                }
              />
            </label>

            <label className="flex items-center justify-between rounded-lg border border-red-500/30 bg-[#070B14] p-3.5 text-xs">
              <div>
                <div className="font-semibold text-red-300">Emergency Broadcast Kill-Switch</div>
                <div className="text-[11px] text-slate-400">Immediately halts all running global broadcast batches</div>
              </div>
              <input
                type="checkbox"
                checked={draftSettings.emergency_pause_broadcasts === 'true'}
                onChange={(e) =>
                  setDraftSettings((p) => ({
                    ...p,
                    emergency_pause_broadcasts: e.target.checked ? 'true' : 'false',
                  }))
                }
              />
            </label>

            <label className="flex items-center justify-between rounded-lg border border-slate-800 bg-[#070B14] p-3.5 text-xs">
              <div>
                <div className="font-semibold text-white">Promotional Footer Globally Enabled</div>
                <div className="text-[11px] text-slate-400">Append BOT FACTORY deep-link CTA to broadcasts</div>
              </div>
              <input
                type="checkbox"
                checked={draftSettings.promo_footer_enabled !== 'false'}
                onChange={(e) =>
                  setDraftSettings((p) => ({ ...p, promo_footer_enabled: e.target.checked ? 'true' : 'false' }))
                }
              />
            </label>

            <div>
              <label className="mb-1 block text-xs text-slate-400">Broadcast Batch Size (per tick)</label>
              <input
                type="number"
                min={1}
                max={50}
                value={draftSettings.broadcast_batch_size || '25'}
                onChange={(e) => setDraftSettings((p) => ({ ...p, broadcast_batch_size: e.target.value }))}
                className="w-full rounded-lg border border-slate-700 bg-[#070B14] px-3 py-2 font-mono text-xs text-white"
              />
            </div>

            <div className="sm:col-span-2">
              <label className="mb-1 block text-xs text-slate-400">Promotional Footer Copy</label>
              <input
                type="text"
                value={draftSettings.promo_footer_text || '🤖 Create your own Telegram bot easily with BOT FACTORY.'}
                onChange={(e) => setDraftSettings((p) => ({ ...p, promo_footer_text: e.target.value }))}
                className="w-full rounded-lg border border-slate-700 bg-[#070B14] px-3 py-2 text-xs text-white"
              />
            </div>
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={!connected || savingSettings}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-500 disabled:opacity-40"
            >
              <Save className="h-3.5 w-3.5" />
              {savingSettings ? 'Saving...' : 'Save Platform Settings'}
            </button>
          </div>
        </form>
      )}

      {subTab === 'logs' && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            {['', 'audit', 'security', 'error', 'warn', 'info'].map((lvl) => (
              <button
                key={lvl || 'all'}
                onClick={() => setLogLevel(lvl)}
                className={`rounded-md border px-2.5 py-1 text-xs capitalize ${
                  logLevel === lvl
                    ? 'border-blue-500 bg-blue-600/20 text-white'
                    : 'border-slate-800 bg-[#0D1322] text-slate-400 hover:text-white'
                }`}
              >
                {lvl || 'All Levels'}
              </button>
            ))}
          </div>

          <div className="rounded-xl border border-slate-800/80 bg-[#0D1322]">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-800/80 text-slate-400">
                  <tr>
                    <th className="px-5 py-3 font-medium">Timestamp</th>
                    <th className="px-5 py-3 font-medium">Level / Source</th>
                    <th className="px-5 py-3 font-medium">Message (Secrets Redacted)</th>
                    <th className="px-5 py-3 font-medium">Actor</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 font-mono text-[11px]">
                  {filteredLogs.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-5 py-10 text-center font-sans text-xs text-slate-500">
                        {connected ? 'No matching system logs.' : 'Connect your Worker to inspect secret-redacted D1 logs.'}
                      </td>
                    </tr>
                  ) : (
                    filteredLogs.map((l) => (
                      <tr key={l.id} className="hover:bg-slate-800/30">
                        <td className="px-5 py-2.5 text-slate-400 whitespace-nowrap tabular-nums">
                          {l.created_at.slice(0, 19).replace('T', ' ')}
                        </td>
                        <td className="px-5 py-2.5 whitespace-nowrap">
                          <span
                            className={
                              l.level === 'error' || l.level === 'security'
                                ? 'text-red-400'
                                : l.level === 'warn'
                                  ? 'text-amber-400'
                                  : l.level === 'audit'
                                    ? 'text-emerald-400'
                                    : 'text-blue-400'
                            }
                          >
                            {l.level.toUpperCase()}
                          </span>{' '}
                          <span className="text-slate-500">/ {l.source}</span>
                        </td>
                        <td className="px-5 py-2.5 font-sans text-xs text-slate-200">{l.message}</td>
                        <td className="px-5 py-2.5 text-slate-400">{l.actor_telegram_id || 'system'}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
