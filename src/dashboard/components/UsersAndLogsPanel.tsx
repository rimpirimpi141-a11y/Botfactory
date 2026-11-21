import React, { useState } from 'react';
import {
  CheckCircle2,
  Eye,
  Plus,
  RefreshCw,
  Save,
  Search,
  Shield,
  ShieldAlert,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import type {
  BotRecord,
  DeploymentLogRecord,
  PlatformAdminRecord,
  PlatformReferralRecord,
  SystemLogRecord,
  UserEntitlement,
  UserRecord,
  WorkerConnection,
} from '../api';
import { createWorkerApi } from '../api';

interface UsersAndLogsPanelProps {
  connection: WorkerConnection;
  connected: boolean;
  users: UserRecord[];
  logs: SystemLogRecord[];
  platformAdmins: PlatformAdminRecord[];
  deployments: DeploymentLogRecord[];
  settings: Record<string, string>;
  loading: boolean;
  onRefresh: () => void;
}

export function UsersAndLogsPanel({
  connection,
  connected,
  users,
  logs,
  platformAdmins,
  deployments,
  settings,
  loading,
  onRefresh,
}: UsersAndLogsPanelProps) {
  const [subTab, setSubTab] = useState<'users' | 'admins' | 'support_fj' | 'security' | 'logs'>('users');
  const [query, setQuery] = useState('');
  const [logLevel, setLogLevel] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [draftSettings, setDraftSettings] = useState<Record<string, string>>(settings);
  const [savingSettings, setSavingSettings] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Platform Admin RBAC add form
  const [newAdminId, setNewAdminId] = useState('');
  const [newAdminUsername, setNewAdminUsername] = useState('');

  // Force Join channel verifier
  const [verifyChannelInput, setVerifyChannelInput] = useState('');
  const [verifyResult, setVerifyResult] = useState<string | null>(null);

  // User profile inspection modal
  const [inspectedUser, setInspectedUser] = useState<{
    user: UserRecord;
    entitlement: UserEntitlement;
    bots: BotRecord[];
    referrals: PlatformReferralRecord[];
    recentActivity: SystemLogRecord[];
  } | null>(null);
  const [inspectLoading, setInspectLoading] = useState(false);

  async function handleInspectUser(telegramId: string) {
    setInspectLoading(true);
    setNotice(null);
    try {
      const detail = await api.getUserDetail(telegramId);
      setInspectedUser({
        user: detail.user,
        entitlement: detail.entitlement,
        bots: detail.bots || [],
        referrals: detail.referrals || [],
        recentActivity: detail.recentActivity || [],
      });
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Failed to inspect user profile');
    } finally {
      setInspectLoading(false);
    }
  }

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
      setNotice(`Updated user ${telegramId} plan override to ${plan.toUpperCase()}.`);
      onRefresh();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setBusyId(null);
    }
  }

  async function handleBonusSlotsChange(user: UserRecord, delta: number) {
    setBusyId(user.telegram_id);
    setNotice(null);
    try {
      const nextBonus = Math.max(-50, Math.min(500, Number(user.bonus_bot_slots || 0) + delta));
      await api.updateUser(user.telegram_id, { bonusBotSlots: nextBonus });
      setNotice(`Adjusted bonus bot slots for ${user.telegram_id} to ${nextBonus >= 0 ? `+${nextBonus}` : nextBonus}.`);
      onRefresh();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Slot update failed');
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

  async function handleAddAdmin(e: React.FormEvent) {
    e.preventDefault();
    if (!newAdminId.trim()) return;
    setBusyId('add_admin');
    setNotice(null);
    try {
      await api.addPlatformAdmin({
        telegramId: newAdminId.trim(),
        username: newAdminUsername.trim().replace(/^@/, '') || undefined,
      });
      setNewAdminId('');
      setNewAdminUsername('');
      setNotice('Platform Admin added with RBAC audit log.');
      onRefresh();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Failed to add admin');
    } finally {
      setBusyId(null);
    }
  }

  async function handleRemoveAdmin(telegramId: string) {
    setBusyId(telegramId);
    setNotice(null);
    try {
      await api.removePlatformAdmin(telegramId);
      setNotice(`Removed platform admin ${telegramId}.`);
      onRefresh();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Failed to remove admin');
    } finally {
      setBusyId(null);
    }
  }

  async function handleVerifyForceJoinChannel() {
    if (!verifyChannelInput.trim()) return;
    setVerifyResult(null);
    try {
      const res = await api.verifyForceJoin(verifyChannelInput.trim());
      if (res.pendingPrivateLink) {
        setVerifyResult(
          res.message ||
            'Private invite link saved as pending. Add Master Bot to your private channel/group and promote it to Administrator to link its numeric chat ID.'
        );
      } else if (res.botIsAdmin) {
        setVerifyResult(`Verified: Master Bot is ${res.status} in ${res.channel}. Ready for Force Join.`);
      } else {
        setVerifyResult(`Not admin: Master Bot status in ${res.channel} is "${res.status}". Promote bot as Admin first.`);
      }
    } catch (err) {
      setVerifyResult(err instanceof Error ? err.message : 'Verification failed');
    }
  }

  async function handleSaveSettings(e: React.FormEvent) {
    e.preventDefault();
    setSavingSettings(true);
    setNotice(null);
    try {
      await api.saveSettings(draftSettings);
      setNotice('Global platform settings saved to Cloudflare D1.');
      onRefresh();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSavingSettings(false);
    }
  }

  return (
    <div className="animate-fade-slide-up space-y-5">
      {/* Sub-navigation */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1 rounded-lg border border-slate-800 bg-[#0D1322] p-1">
          {(
            [
              ['users', 'Users & Bot Slots'],
              ['admins', 'Platform Admins (RBAC)'],
              ['support_fj', 'Force Join & Support'],
              ['security', 'Global Settings & Emergency'],
              ['logs', 'Logs & Deployments'],
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

      {/* TAB 1: USERS & BOT SLOTS */}
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
                    <th className="px-5 py-3 font-medium">Plan Override</th>
                    <th className="px-5 py-3 text-right font-medium">Refs / Bot Slots</th>
                    <th className="px-5 py-3 text-right font-medium">Bonus Slot Adjust</th>
                    <th className="px-5 py-3 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {filteredUsers.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-5 py-10 text-center text-slate-500">
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
                        <td className="px-5 py-3 text-right font-mono tabular-nums">
                          <div className="text-slate-100">
                            {u.bot_count} / {u.entitlement?.maxBotsLabel || '2'}
                          </div>
                          <div className="text-[10px] text-slate-500">
                            {u.verified_referrals ?? 0} verified refs
                          </div>
                        </td>
                        <td className="px-5 py-3 text-right">
                          <div className="inline-flex items-center gap-1.5 font-mono text-[11px]">
                            <button
                              onClick={() => handleBonusSlotsChange(u, -1)}
                              disabled={busyId === u.telegram_id}
                              className="rounded border border-slate-700 px-2 py-0.5 text-slate-300 hover:bg-slate-800"
                              title="Decrease bonus slot override (never deletes existing bots)"
                            >
                              -1
                            </button>
                            <span className="min-w-[2.2rem] text-center text-slate-200 tabular-nums">
                              {Number(u.bonus_bot_slots || 0) >= 0
                                ? `+${Number(u.bonus_bot_slots || 0)}`
                                : Number(u.bonus_bot_slots || 0)}
                            </span>
                            <button
                              onClick={() => handleBonusSlotsChange(u, 1)}
                              disabled={busyId === u.telegram_id}
                              className="rounded border border-emerald-500/40 px-2 py-0.5 text-emerald-300 hover:bg-emerald-500/10"
                              title="Grant +1 bonus bot slot"
                            >
                              +1
                            </button>
                          </div>
                        </td>
                        <td className="px-5 py-3 text-right">
                          <div className="inline-flex items-center justify-end gap-1.5">
                            <button
                              onClick={() => handleInspectUser(u.telegram_id)}
                              disabled={inspectLoading}
                              className="inline-flex items-center gap-1 rounded-md border border-slate-700 px-2.5 py-1 text-[11px] font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-40"
                              title="Inspect user's bots, referral history, and activity"
                            >
                              <Eye className="h-3 w-3" />
                              Inspect
                            </button>
                            <button
                              onClick={() => handleSuspendToggle(u)}
                              disabled={busyId === u.telegram_id || u.role === 'super_admin'}
                              className={`rounded-md border px-2.5 py-1 text-[11px] font-medium disabled:opacity-30 ${
                                u.status === 'suspended'
                                  ? 'border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10'
                                  : 'border-red-500/40 text-red-300 hover:bg-red-500/10'
                              }`}
                            >
                              {u.status === 'suspended' ? 'Restore' : 'Suspend'}
                            </button>
                          </div>
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

      {/* TAB 2: PLATFORM ADMINS RBAC */}
      {subTab === 'admins' && (
        <div className="space-y-5">
          <form
            onSubmit={handleAddAdmin}
            className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-800/80 bg-[#0D1322] p-5"
          >
            <div className="min-w-[180px] flex-1">
              <label className="mb-1 block text-xs text-slate-400">Admin Telegram User ID</label>
              <input
                type="text"
                required
                value={newAdminId}
                onChange={(e) => setNewAdminId(e.target.value)}
                placeholder="e.g. 543219876"
                className="w-full rounded-lg border border-slate-700 bg-[#070B14] px-3 py-2 font-mono text-xs text-white"
              />
            </div>
            <div className="min-w-[180px] flex-1">
              <label className="mb-1 block text-xs text-slate-400">Telegram Username (Optional)</label>
              <input
                type="text"
                value={newAdminUsername}
                onChange={(e) => setNewAdminUsername(e.target.value)}
                placeholder="@ModeratorHandle"
                className="w-full rounded-lg border border-slate-700 bg-[#070B14] px-3 py-2 text-xs text-white"
              />
            </div>
            <button
              type="submit"
              disabled={!connected || busyId === 'add_admin'}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-40 whitespace-nowrap"
            >
              <Plus className="h-3.5 w-3.5" />
              Add Platform Admin
            </button>
          </form>

          <div className="rounded-xl border border-slate-800/80 bg-[#0D1322]">
            <div className="flex items-center justify-between border-b border-slate-800/80 px-5 py-4">
              <div className="flex items-center gap-2">
                <Shield className="h-4 w-4 text-blue-400" />
                <div>
                  <h3 className="font-display text-sm font-semibold text-white">Delegated Platform Administrators</h3>
                  <p className="text-xs text-slate-400">
                    Super Admin (ADMIN_TELEGRAM_ID) is immutable and cannot be modified or removed by ordinary admins.
                  </p>
                </div>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-800/80 text-slate-400">
                  <tr>
                    <th className="px-5 py-3 font-medium">Telegram ID</th>
                    <th className="px-5 py-3 font-medium">Username</th>
                    <th className="px-5 py-3 font-medium">Role</th>
                    <th className="px-5 py-3 font-medium">Status</th>
                    <th className="px-5 py-3 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {platformAdmins.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-5 py-10 text-center text-slate-500">
                        {connected
                          ? 'Only the primary Super Admin (ADMIN_TELEGRAM_ID) currently has access.'
                          : 'Connect your Worker to manage Platform Admins.'}
                      </td>
                    </tr>
                  ) : (
                    platformAdmins.map((a) => (
                      <tr key={a.id} className="hover:bg-slate-800/30">
                        <td className="px-5 py-3 font-mono text-white">{a.telegram_id}</td>
                        <td className="px-5 py-3 text-slate-300">{a.username ? `@${a.username}` : '—'}</td>
                        <td className="px-5 py-3 font-mono text-[11px] text-blue-400">{a.role.toUpperCase()}</td>
                        <td className="px-5 py-3 font-mono text-[11px] text-emerald-400">{a.status.toUpperCase()}</td>
                        <td className="px-5 py-3 text-right">
                          <button
                            onClick={() => handleRemoveAdmin(a.telegram_id)}
                            disabled={busyId === a.telegram_id || a.role === 'super_admin'}
                            className="inline-flex items-center gap-1 rounded border border-red-500/30 px-2.5 py-1 text-[11px] text-red-400 hover:bg-red-500/10 disabled:opacity-30"
                          >
                            <Trash2 className="h-3 w-3" />
                            Remove
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

      {/* TAB 3: PLATFORM FORCE JOIN & SUPPORT MANAGEMENT */}
      {subTab === 'support_fj' && (
        <form onSubmit={handleSaveSettings} className="space-y-6">
          <div className="space-y-4 rounded-xl border border-slate-800/80 bg-[#0D1322] p-6">
            <div className="flex items-center gap-2 border-b border-slate-800 pb-3">
              <Users className="h-4 w-4 text-emerald-400" />
              <h3 className="font-display text-sm font-semibold text-white">Platform Force Join Enforcement</h3>
            </div>

            <label className="flex items-center justify-between rounded-lg border border-slate-800 bg-[#070B14] p-3.5 text-xs">
              <div>
                <div className="font-semibold text-white">Require Channel Membership on Master Bot</div>
                <div className="text-[11px] text-slate-400">
                  Verifies live Telegram getChatMember status before allowing new bot creation
                </div>
              </div>
              <input
                type="checkbox"
                checked={draftSettings.platform_force_join_enabled === 'true'}
                onChange={(e) =>
                  setDraftSettings((p) => ({
                    ...p,
                    platform_force_join_enabled: e.target.checked ? 'true' : 'false',
                  }))
                }
              />
            </label>

            <div>
              <label className="mb-1 block text-xs text-slate-400">
                Required Channels JSON Array (e.g. [&quot;@BotFactoryOfficial&quot;])
              </label>
              <input
                type="text"
                value={draftSettings.platform_force_join_channels || '[]'}
                onChange={(e) => setDraftSettings((p) => ({ ...p, platform_force_join_channels: e.target.value }))}
                className="w-full rounded-lg border border-slate-700 bg-[#070B14] px-3 py-2 font-mono text-xs text-white"
              />
            </div>

            <div className="flex flex-wrap items-end gap-2 rounded-lg border border-slate-800 bg-[#070B14] p-3.5">
              <div className="min-w-[220px] flex-1">
                <label className="mb-1 block text-[11px] text-slate-400">
                  Verify Master Bot Admin Permissions in Channel
                </label>
                <input
                  type="text"
                  value={verifyChannelInput}
                  onChange={(e) => setVerifyChannelInput(e.target.value)}
                  placeholder="@YourChannelUsername or -1001234567890"
                  className="w-full rounded-lg border border-slate-700 bg-[#0D1322] px-3 py-1.5 font-mono text-xs text-white"
                />
              </div>
              <button
                type="button"
                onClick={handleVerifyForceJoinChannel}
                disabled={!connected || !verifyChannelInput.trim()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-600/15 px-3.5 py-2 text-xs font-medium text-emerald-300 hover:bg-emerald-600/25 disabled:opacity-40"
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                Check Bot Admin Status
              </button>
              {verifyResult && <div className="w-full text-xs text-slate-300">{verifyResult}</div>}
            </div>
          </div>

          <div className="space-y-4 rounded-xl border border-slate-800/80 bg-[#0D1322] p-6">
            <h3 className="border-b border-slate-800 pb-3 font-display text-sm font-semibold text-white">
              Official Platform Support Contact (Shown in Master Bot 🆘 Help &amp; Support)
            </h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs text-slate-400">Official Support Handle</label>
                <input
                  type="text"
                  value={draftSettings.platform_support_username || ''}
                  onChange={(e) => setDraftSettings((p) => ({ ...p, platform_support_username: e.target.value }))}
                  placeholder="@BotFactorySupport"
                  className="w-full rounded-lg border border-slate-700 bg-[#070B14] px-3 py-2 text-xs text-white"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-400">Support Link URL (Optional)</label>
                <input
                  type="text"
                  value={draftSettings.platform_support_url || ''}
                  onChange={(e) => setDraftSettings((p) => ({ ...p, platform_support_url: e.target.value }))}
                  placeholder="https://t.me/BotFactorySupport"
                  className="w-full rounded-lg border border-slate-700 bg-[#070B14] px-3 py-2 text-xs text-white"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="mb-1 block text-xs text-slate-400">Support Desk Message</label>
                <textarea
                  rows={2}
                  value={draftSettings.platform_support_message || ''}
                  onChange={(e) => setDraftSettings((p) => ({ ...p, platform_support_message: e.target.value }))}
                  placeholder="Need help launching or verifying your Telegram bot? Contact our support desk."
                  className="w-full rounded-lg border border-slate-700 bg-[#070B14] px-3 py-2 text-xs text-white"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-400">Support Instructions (Optional)</label>
                <input
                  type="text"
                  value={draftSettings.platform_support_instructions || ''}
                  onChange={(e) => setDraftSettings((p) => ({ ...p, platform_support_instructions: e.target.value }))}
                  placeholder="Include your Bot ID and screenshot when messaging support."
                  className="w-full rounded-lg border border-slate-700 bg-[#070B14] px-3 py-2 text-xs text-white"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-400">Support Availability Hours (Optional)</label>
                <input
                  type="text"
                  value={draftSettings.platform_support_availability || ''}
                  onChange={(e) => setDraftSettings((p) => ({ ...p, platform_support_availability: e.target.value }))}
                  placeholder="Mon–Sat, 09:00–21:00 UTC"
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
                {savingSettings ? 'Saving...' : 'Save Force Join & Support'}
              </button>
            </div>
          </div>
        </form>
      )}

      {/* TAB 4: GLOBAL SETTINGS & EMERGENCY */}
      {subTab === 'security' && (
        <form onSubmit={handleSaveSettings} className="space-y-5 rounded-xl border border-slate-800/80 bg-[#0D1322] p-6">
          <div className="flex items-center gap-2 border-b border-slate-800 pb-3">
            <ShieldAlert className="h-4 w-4 text-red-400" />
            <h3 className="font-display text-sm font-semibold text-white">
              Global Settings &amp; Emergency Kill-Switches
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

      {/* TAB 5: SYSTEM LOGS & DEPLOYMENT AUDIT */}
      {subTab === 'logs' && (
        <div className="space-y-6">
          {/* Deployment Audit Table */}
          <div className="rounded-xl border border-slate-800/80 bg-[#0D1322]">
            <div className="border-b border-slate-800/80 px-5 py-3.5">
              <h3 className="font-display text-sm font-semibold text-white">Recent Bot Deployment Logs</h3>
              <p className="text-xs text-slate-400">Tracked automatically in D1 deployment_logs per tenant bot</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-800/80 text-slate-400">
                  <tr>
                    <th className="px-5 py-2.5 font-medium">Timestamp</th>
                    <th className="px-5 py-2.5 font-medium">Template / Stage</th>
                    <th className="px-5 py-2.5 font-medium">Status</th>
                    <th className="px-5 py-2.5 font-medium">Detail</th>
                    <th className="px-5 py-2.5 font-medium">Owner</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 font-mono text-[11px]">
                  {deployments.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-5 py-8 text-center font-sans text-xs text-slate-500">
                        {connected ? 'No deployment logs recorded yet.' : 'Connect your Worker to view deployment logs.'}
                      </td>
                    </tr>
                  ) : (
                    deployments.slice(0, 20).map((d) => (
                      <tr key={d.id} className="hover:bg-slate-800/30">
                        <td className="px-5 py-2.5 text-slate-400 whitespace-nowrap tabular-nums">
                          {d.created_at.slice(0, 19).replace('T', ' ')}
                        </td>
                        <td className="px-5 py-2.5 text-slate-200">
                          {d.template_slug || 'custom'} · <span className="text-slate-400">{d.stage}</span>
                        </td>
                        <td className="px-5 py-2.5">
                          <span className={d.status === 'failed' ? 'text-red-400' : 'text-emerald-400'}>
                            {d.status.toUpperCase()}
                          </span>
                        </td>
                        <td className="px-5 py-2.5 font-sans text-xs text-slate-300">{d.detail || '—'}</td>
                        <td className="px-5 py-2.5 text-slate-400">{d.owner_telegram_id}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* System Audit Logs */}
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
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
        </div>
      )}
      {/* User Profile Inspection Modal */}
      {inspectedUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <div className="animate-modal-pop max-h-[88vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-slate-800 bg-[#0D1322] shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
              <div>
                <h3 className="font-display text-base font-semibold text-white">
                  {inspectedUser.user.first_name || 'User'}{' '}
                  {inspectedUser.user.username ? `(@${inspectedUser.user.username})` : ''}
                </h3>
                <p className="font-mono text-[11px] text-slate-400">
                  Telegram ID: {inspectedUser.user.telegram_id} · Plan: {inspectedUser.entitlement.planLabel} · Slots:{' '}
                  {inspectedUser.entitlement.activeBotCount}/{inspectedUser.entitlement.maxBotsLabel}
                </p>
              </div>
              <button
                onClick={() => setInspectedUser(null)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
                aria-label="Close user inspector"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-5 p-6 text-xs">
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-lg border border-slate-800 bg-[#070B14] p-3">
                  <div className="text-[11px] text-slate-400">Verified / Pending Refs</div>
                  <div className="mt-1 font-mono text-base font-semibold text-white tabular-nums">
                    {inspectedUser.entitlement.verifiedReferrals} / {inspectedUser.entitlement.pendingReferrals}
                  </div>
                </div>
                <div className="rounded-lg border border-slate-800 bg-[#070B14] p-3">
                  <div className="text-[11px] text-slate-400">Bonus Slot Override</div>
                  <div className="mt-1 font-mono text-base font-semibold text-emerald-400 tabular-nums">
                    {inspectedUser.entitlement.bonusBotSlots >= 0
                      ? `+${inspectedUser.entitlement.bonusBotSlots}`
                      : inspectedUser.entitlement.bonusBotSlots}
                  </div>
                </div>
                <div className="rounded-lg border border-slate-800 bg-[#070B14] p-3">
                  <div className="text-[11px] text-slate-400">Referral Code</div>
                  <div className="mt-1 font-mono text-sm font-semibold text-blue-300">
                    {inspectedUser.user.referral_code || '—'}
                  </div>
                </div>
              </div>

              <div>
                <h4 className="mb-2 font-display text-xs font-semibold text-white">
                  Created Bots ({inspectedUser.bots.length})
                </h4>
                {inspectedUser.bots.length === 0 ? (
                  <div className="rounded-lg border border-slate-800 bg-[#070B14] p-3 text-slate-500">
                    No bots deployed by this user yet.
                  </div>
                ) : (
                  <div className="divide-y divide-slate-800/70 rounded-lg border border-slate-800 bg-[#070B14]">
                    {inspectedUser.bots.map((b) => (
                      <div key={b.id} className="flex items-center justify-between px-3.5 py-2.5">
                        <div>
                          <div className="font-medium text-white">
                            {b.display_name} <span className="font-mono text-blue-400">@{b.telegram_username}</span>
                          </div>
                          <div className="font-mono text-[10px] text-slate-500">
                            {b.id} · {b.template_slug || b.mode}
                          </div>
                        </div>
                        <span
                          className={`font-mono text-[11px] ${
                            b.status === 'active' ? 'text-emerald-400' : 'text-amber-400'
                          }`}
                        >
                          {b.status.toUpperCase()}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <h4 className="mb-2 font-display text-xs font-semibold text-white">
                  Referral History ({inspectedUser.referrals.length})
                </h4>
                {inspectedUser.referrals.length === 0 ? (
                  <div className="rounded-lg border border-slate-800 bg-[#070B14] p-3 text-slate-500">
                    No referral attributions recorded for this user.
                  </div>
                ) : (
                  <div className="divide-y divide-slate-800/70 rounded-lg border border-slate-800 bg-[#070B14]">
                    {inspectedUser.referrals.slice(0, 12).map((r) => (
                      <div key={r.id} className="flex items-center justify-between px-3.5 py-2 font-mono text-[11px]">
                        <span className="text-slate-200">
                          {r.referred_username ? `@${r.referred_username}` : r.referred_telegram_id}
                        </span>
                        <span
                          className={
                            r.status === 'verified'
                              ? 'text-emerald-400'
                              : r.status === 'pending'
                                ? 'text-amber-400'
                                : 'text-red-400'
                          }
                        >
                          {r.status.toUpperCase()}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {inspectedUser.recentActivity.length > 0 && (
                <div>
                  <h4 className="mb-2 font-display text-xs font-semibold text-white">Recent Activity Logs</h4>
                  <div className="divide-y divide-slate-800/70 rounded-lg border border-slate-800 bg-[#070B14]">
                    {inspectedUser.recentActivity.slice(0, 8).map((log) => (
                      <div key={log.id} className="px-3.5 py-2">
                        <div className="text-slate-200">{log.message}</div>
                        <div className="font-mono text-[10px] text-slate-500">
                          {log.created_at.slice(0, 19).replace('T', ' ')} · {log.source}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
