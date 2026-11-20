import React, { useState } from 'react';
import {
  CheckCircle2,
  ExternalLink,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  X,
  AlertCircle,
} from 'lucide-react';
import type { BotBrandingConfig, BotRecord, BuilderMenu, WorkerConnection } from '../api';
import { createWorkerApi } from '../api';
import { DEFAULT_BUILDER_MENUS, TEMPLATE_CATALOG, THEME_OPTIONS } from '../catalog';

interface BotsPanelProps {
  connection: WorkerConnection;
  connected: boolean;
  bots: BotRecord[];
  loading: boolean;
  initialTemplateSlug?: string | null;
  openDeployModal: boolean;
  onCloseDeployModal: () => void;
  onOpenDeployModal: () => void;
  onRefresh: () => void;
  onEditInBuilder: (botId: string) => void;
}

export function BotsPanel({
  connection,
  connected,
  bots,
  loading,
  initialTemplateSlug,
  openDeployModal,
  onCloseDeployModal,
  onOpenDeployModal,
  onRefresh,
  onEditInBuilder,
}: BotsPanelProps) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'disabled' | 'failed'>('all');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Deploy Drawer state
  const [mode, setMode] = useState<'template' | 'custom'>('template');
  const [templateSlug, setTemplateSlug] = useState<string>(initialTemplateSlug || 'refer-earn');
  const [rawToken, setRawToken] = useState('');
  const [validatedBot, setValidatedBot] = useState<{ telegramBotId: string; telegramUsername: string; telegramFirstName: string } | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [branding, setBranding] = useState<BotBrandingConfig>({
    brandTitle: '',
    welcomeMessage: '',
    welcomeImageUrl: null,
    logoUrl: null,
    footerText: '',
    supportUsername: '',
    themeId: 'obsidian_neon',
  });
  const [validating, setValidating] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [deployResult, setDeployResult] = useState<{ bot: BotRecord; webhookUrl: string; stages: Array<{ stage: string; detail: string }> } | null>(null);

  React.useEffect(() => {
    if (initialTemplateSlug) {
      if (initialTemplateSlug === 'custom-builder') {
        setMode('custom');
        setTemplateSlug('custom-builder');
      } else {
        setMode('template');
        setTemplateSlug(initialTemplateSlug);
      }
    }
  }, [initialTemplateSlug]);

  const api = createWorkerApi(connection);

  const filtered = bots.filter((b) => {
    if (statusFilter !== 'all' && b.status !== statusFilter) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      return (
        b.id.toLowerCase().includes(q) ||
        b.telegram_username.toLowerCase().includes(q) ||
        b.display_name.toLowerCase().includes(q) ||
        b.owner_telegram_id.includes(q)
      );
    }
    return true;
  });

  async function handleToggle(bot: BotRecord) {
    setBusyId(bot.id);
    setActionMsg(null);
    try {
      if (bot.status === 'active') {
        await api.disableBot(bot.id);
        setActionMsg({ type: 'ok', text: `Disabled @${bot.telegram_username} and removed webhook.` });
      } else {
        const res = await api.enableBot(bot.id);
        setActionMsg({ type: 'ok', text: `Re-enabled @${bot.telegram_username}. Verified webhook: ${res.verification.webhookUrl}` });
      }
      onRefresh();
    } catch (err) {
      setActionMsg({ type: 'err', text: err instanceof Error ? err.message : 'Action failed' });
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(botId: string) {
    setBusyId(botId);
    setActionMsg(null);
    try {
      await api.deleteBot(botId);
      setConfirmDeleteId(null);
      setActionMsg({ type: 'ok', text: `Bot ${botId} deleted and webhook removed.` });
      onRefresh();
    } catch (err) {
      setActionMsg({ type: 'err', text: err instanceof Error ? err.message : 'Delete failed' });
    } finally {
      setBusyId(null);
    }
  }

  async function handleValidateToken() {
    setDeployError(null);
    setValidatedBot(null);
    setValidating(true);
    try {
      const res = await api.validateToken(rawToken);
      setValidatedBot(res.bot);
      if (!displayName) setDisplayName(res.bot.telegramFirstName);
      if (!branding.brandTitle) setBranding((prev) => ({ ...prev, brandTitle: res.bot.telegramFirstName }));
    } catch (err) {
      setDeployError(err instanceof Error ? err.message : 'Token validation failed');
    } finally {
      setValidating(false);
    }
  }

  async function handleDeploy(e: React.FormEvent) {
    e.preventDefault();
    setDeployError(null);
    setDeployResult(null);
    setDeploying(true);
    try {
      const selectedTpl = mode === 'custom' ? 'custom-builder' : templateSlug;
      const customMenus: BuilderMenu[] | undefined = mode === 'custom' ? DEFAULT_BUILDER_MENUS : undefined;
      const res = await api.deployBot({
        token: rawToken,
        templateId: selectedTpl,
        mode,
        displayName: displayName.trim() || validatedBot?.telegramFirstName || 'My Bot',
        description: description.trim(),
        branding: {
          ...branding,
          brandTitle: branding.brandTitle.trim() || displayName.trim() || 'My Bot',
          welcomeMessage: branding.welcomeMessage.trim() || description.trim() || 'Welcome!',
        },
        customMenus,
      });
      setRawToken(''); // Immediately clear sensitive token from component memory
      setDeployResult({ bot: res.bot, webhookUrl: res.verification.webhookUrl, stages: res.stages });
      onRefresh();
    } catch (err) {
      setDeployError(err instanceof Error ? err.message : 'Deployment failed');
    } finally {
      setDeploying(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by bot ID, @username, owner..."
              className="w-64 rounded-lg border border-slate-800 bg-[#0D1322] py-2 pr-3 pl-9 text-xs text-slate-100 placeholder-slate-500 focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-[#0D1322] p-1">
            {(['all', 'active', 'disabled', 'failed'] as const).map((st) => (
              <button
                key={st}
                onClick={() => setStatusFilter(st)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors whitespace-nowrap shrink-0 ${
                  statusFilter === st ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                {st}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={onRefresh}
            disabled={!connected || loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap shrink-0"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            onClick={onOpenDeployModal}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500 whitespace-nowrap shrink-0"
          >
            <Plus className="h-3.5 w-3.5" />
            Deploy New Bot
          </button>
        </div>
      </div>

      {actionMsg && (
        <div
          className={`rounded-lg border px-4 py-2.5 text-xs ${
            actionMsg.type === 'ok'
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
              : 'border-red-500/30 bg-red-500/10 text-red-300'
          }`}
        >
          {actionMsg.text}
        </div>
      )}

      {/* Bot Table */}
      <div className="rounded-xl border border-slate-800/80 bg-[#0D1322]">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-800/80 text-slate-400">
              <tr>
                <th className="px-5 py-3 font-medium">Bot / Identifier</th>
                <th className="px-5 py-3 font-medium">Template & Mode</th>
                <th className="px-5 py-3 font-medium">Owner ID</th>
                <th className="px-5 py-3 font-medium">Webhook Verification</th>
                <th className="px-5 py-3 text-right font-medium">Users / Updates</th>
                <th className="px-5 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-5 py-12 text-center text-slate-500">
                    {connected
                      ? 'No tenant bots match the current filter.'
                      : 'Connect your Cloudflare Worker to load deployed bots from Cloudflare D1.'}
                  </td>
                </tr>
              ) : (
                filtered.map((bot) => {
                  const isLive = bot.status === 'active' && bot.webhook_status === 'verified';
                  const isBusy = busyId === bot.id;
                  return (
                    <tr key={bot.id} className="hover:bg-slate-800/30">
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-white">{bot.display_name}</span>
                          <a
                            href={`https://t.me/${bot.telegram_username}`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-0.5 font-mono text-[11px] text-blue-400 hover:underline"
                          >
                            @{bot.telegram_username}
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        </div>
                        <div className="mt-0.5 font-mono text-[11px] text-slate-500">{bot.id}</div>
                      </td>
                      <td className="px-5 py-3.5 text-slate-300">
                        <div>{bot.template_name || bot.template_id}</div>
                        <div className="text-[11px] text-slate-500">{bot.mode} · {bot.plan}</div>
                      </td>
                      <td className="px-5 py-3.5 font-mono text-slate-300 tabular-nums">{bot.owner_telegram_id}</td>
                      <td className="px-5 py-3.5">
                        <div className={`font-mono text-[11px] font-medium ${isLive ? 'text-emerald-400' : bot.status === 'failed' ? 'text-red-400' : 'text-amber-400'}`}>
                          {bot.status.toUpperCase()} · {bot.webhook_status.toUpperCase()}
                        </div>
                        {bot.webhook_last_error && (
                          <div className="mt-0.5 max-w-xs truncate text-[11px] text-red-400" title={bot.webhook_last_error}>
                            {bot.webhook_last_error}
                          </div>
                        )}
                      </td>
                      <td className="px-5 py-3.5 text-right font-mono text-slate-200 tabular-nums">
                        {bot.total_users.toLocaleString()} / {bot.total_updates.toLocaleString()}
                      </td>
                      <td className="px-5 py-3.5">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            onClick={() => onEditInBuilder(bot.id)}
                            className="rounded-md border border-slate-700 px-2.5 py-1 text-[11px] font-medium text-slate-200 hover:bg-slate-800 whitespace-nowrap"
                          >
                            Builder
                          </button>
                          <button
                            onClick={() => handleToggle(bot)}
                            disabled={isBusy}
                            className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium whitespace-nowrap ${
                              bot.status === 'active'
                                ? 'border border-amber-500/40 text-amber-300 hover:bg-amber-500/10'
                                : 'border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10'
                            }`}
                            title={bot.status === 'active' ? 'Disable Bot & Remove Webhook' : 'Enable & Verify Webhook'}
                          >
                            {bot.status === 'active' ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
                            {bot.status === 'active' ? 'Disable' : 'Verify & Enable'}
                          </button>
                          {confirmDeleteId === bot.id ? (
                            <button
                              onClick={() => handleDelete(bot.id)}
                              disabled={isBusy}
                              className="rounded-md bg-red-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-red-500 whitespace-nowrap"
                            >
                              Confirm Delete
                            </button>
                          ) : (
                            <button
                              onClick={() => setConfirmDeleteId(bot.id)}
                              className="rounded-md border border-red-500/30 p-1.5 text-red-400 hover:bg-red-500/10"
                              aria-label="Delete bot"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Real Multi-Tenant Bot Deployment Modal */}
      {openDeployModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-slate-800 bg-[#0D1322] shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
              <div>
                <h2 className="font-display text-lg font-semibold text-white">Deploy Multi-Tenant Telegram Bot</h2>
                <p className="text-xs text-slate-400">
                  Validates via Telegram getMe, encrypts token with AES-256-GCM, persists to D1, registers & verifies webhook.
                </p>
              </div>
              <button
                onClick={() => {
                  setDeployResult(null);
                  setDeployError(null);
                  onCloseDeployModal();
                }}
                className="rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleDeploy} className="space-y-5 p-6">
              {!connected && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
                  Connect your Cloudflare Worker first before deploying. Tokens are sent directly to your Worker and
                  validated against Telegram Bot API.
                </div>
              )}

              {/* Step 1: Mode */}
              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-300">1. Architecture Mode</label>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setMode('template')}
                    className={`rounded-lg border px-4 py-2.5 text-left text-xs transition-colors ${
                      mode === 'template'
                        ? 'border-blue-500 bg-blue-600/15 text-white'
                        : 'border-slate-800 bg-[#070B14] text-slate-400 hover:border-slate-700'
                    }`}
                  >
                    <div className="font-semibold">Prebuilt Template</div>
                    <div className="mt-0.5 text-[11px] text-slate-400">7 modular production templates</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setMode('custom')}
                    className={`rounded-lg border px-4 py-2.5 text-left text-xs transition-colors ${
                      mode === 'custom'
                        ? 'border-emerald-500 bg-emerald-600/15 text-white'
                        : 'border-slate-800 bg-[#070B14] text-slate-400 hover:border-slate-700'
                    }`}
                  >
                    <div className="font-semibold">Custom No-Code Builder</div>
                    <div className="mt-0.5 text-[11px] text-slate-400">Visual submenus & colourful buttons</div>
                  </button>
                </div>
              </div>

              {mode === 'template' && (
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-300">2. Select Prebuilt Template</label>
                  <select
                    value={templateSlug}
                    onChange={(e) => setTemplateSlug(e.target.value)}
                    className="w-full rounded-lg border border-slate-700 bg-[#070B14] px-3 py-2.5 text-xs text-slate-100 focus:border-blue-500 focus:outline-none"
                  >
                    {TEMPLATE_CATALOG.map((t) => (
                      <option key={t.id} value={t.slug}>
                        {t.name} ({t.category})
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Step 3: BotFather Token + Real getMe verification */}
              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-300">
                  3. Telegram BotFather Token (Sensitive — encrypted with AES-256-GCM, never echoed back)
                </label>
                <div className="flex gap-2">
                  <input
                    type="password"
                    required
                    value={rawToken}
                    onChange={(e) => {
                      setRawToken(e.target.value);
                      setValidatedBot(null);
                    }}
                    placeholder="123456789:AAH_generated_by_BotFather..."
                    className="flex-1 rounded-lg border border-slate-700 bg-[#070B14] px-3.5 py-2.5 font-mono text-xs text-slate-100 placeholder-slate-500 focus:border-blue-500 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={handleValidateToken}
                    disabled={!connected || !rawToken.trim() || validating}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-blue-500/40 bg-blue-600/15 px-3.5 py-2 text-xs font-medium text-blue-300 hover:bg-blue-600/25 disabled:opacity-40 whitespace-nowrap shrink-0"
                  >
                    <ShieldCheck className="h-3.5 w-3.5" />
                    {validating ? 'Checking getMe...' : 'Validate Token'}
                  </button>
                </div>
                {validatedBot && (
                  <div className="mt-2 flex items-center gap-2 text-xs text-emerald-400">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    <span>
                      Verified via Telegram getMe: <strong>@{validatedBot.telegramUsername}</strong> (ID:{' '}
                      <span className="font-mono">{validatedBot.telegramBotId}</span>)
                    </span>
                  </div>
                )}
              </div>

              {/* Step 4: Display Name, Description & Branding */}
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-300">Display Name</label>
                  <input
                    type="text"
                    required
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="Apex Rewards Bot"
                    className="w-full rounded-lg border border-slate-700 bg-[#070B14] px-3 py-2 text-xs text-slate-100 focus:border-blue-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-300">Theme Preset</label>
                  <select
                    value={branding.themeId}
                    onChange={(e) => setBranding((p) => ({ ...p, themeId: e.target.value }))}
                    className="w-full rounded-lg border border-slate-700 bg-[#070B14] px-3 py-2 text-xs text-slate-100 focus:border-blue-500 focus:outline-none"
                  >
                    {THEME_OPTIONS.map((th) => (
                      <option key={th.id} value={th.id}>
                        {th.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-300">Support Username</label>
                  <input
                    type="text"
                    value={branding.supportUsername}
                    onChange={(e) => setBranding((p) => ({ ...p, supportUsername: e.target.value }))}
                    placeholder="@YourSupportDesk"
                    className="w-full rounded-lg border border-slate-700 bg-[#070B14] px-3 py-2 text-xs text-slate-100 focus:border-blue-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-300">Footer Text</label>
                  <input
                    type="text"
                    value={branding.footerText}
                    onChange={(e) => setBranding((p) => ({ ...p, footerText: e.target.value }))}
                    placeholder="Official Verified Bot"
                    className="w-full rounded-lg border border-slate-700 bg-[#070B14] px-3 py-2 text-xs text-slate-100 focus:border-blue-500 focus:outline-none"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="mb-1.5 block text-xs font-medium text-slate-300">Welcome Description</label>
                  <textarea
                    rows={2}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Welcome! Choose an option from the colourful menu below."
                    className="w-full rounded-lg border border-slate-700 bg-[#070B14] px-3 py-2 text-xs text-slate-100 focus:border-blue-500 focus:outline-none"
                  />
                </div>
              </div>

              {deployError && (
                <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
                  <span>{deployError}</span>
                </div>
              )}

              {deployResult && (
                <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-4 text-xs text-emerald-200">
                  <div className="font-display text-sm font-semibold text-emerald-300">
                    BOT IS LIVE — @{deployResult.bot.telegram_username}
                  </div>
                  <div className="mt-1 font-mono text-[11px] text-emerald-200/90">
                    Verified Webhook: {deployResult.webhookUrl}
                  </div>
                  <div className="mt-2 space-y-1 border-t border-emerald-500/20 pt-2 font-mono text-[11px] text-emerald-200/80">
                    {deployResult.stages.map((s, i) => (
                      <div key={i}>✓ {s.detail}</div>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex items-center justify-end gap-2 border-t border-slate-800 pt-4">
                <button
                  type="button"
                  onClick={onCloseDeployModal}
                  className="rounded-lg border border-slate-700 px-4 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800"
                >
                  Close
                </button>
                <button
                  type="submit"
                  disabled={!connected || deploying || !rawToken.trim()}
                  className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-5 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
                >
                  {deploying ? 'Encrypting & Verifying Webhook...' : 'Deploy & Verify Live Webhook'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
