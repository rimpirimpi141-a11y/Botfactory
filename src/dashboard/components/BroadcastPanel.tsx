import React, { useState } from 'react';
import { FastForward, Pause, Play, Plus, RefreshCw, Send, Trash2, XCircle } from 'lucide-react';
import type { BotRecord, BroadcastRecord, WorkerConnection } from '../api';
import { createWorkerApi } from '../api';

interface BroadcastPanelProps {
  connection: WorkerConnection;
  connected: boolean;
  bots: BotRecord[];
  broadcasts: BroadcastRecord[];
  masterBotDeepLink: string | null;
  loading: boolean;
  onRefresh: () => void;
}

export function BroadcastPanel({
  connection,
  connected,
  bots,
  broadcasts,
  masterBotDeepLink,
  loading,
  onRefresh,
}: BroadcastPanelProps) {
  const [scope, setScope] = useState<'global' | 'single_bot' | 'bot_group' | 'selected_users'>('global');
  const [selectedBotIds, setSelectedBotIds] = useState<string[]>([]);
  const [targetUserIdsText, setTargetUserIdsText] = useState('');
  const [messageText, setMessageText] = useState(
    '🚀 Want to create your own Telegram bot?\n\nNow you can build your own bot easily using BOT FACTORY!\n🤖 Choose a template.\n🎨 Customize your theme.\n⚙️ Configure features.\n☁️ Deploy automatically.\n\nNo coding required for ready-made templates!'
  );
  const [imageUrl, setImageUrl] = useState('');
  const [includePromoFooter, setIncludePromoFooter] = useState(true);
  const [inlineButtons, setInlineButtons] = useState<Array<{ text: string; url: string; style: 'primary' | 'success' | 'danger' }>>([]);
  const [confirmingDraft, setConfirmingDraft] = useState<BroadcastRecord | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const api = createWorkerApi(connection);

  async function handleCreateDraft(e: React.FormEvent) {
    e.preventDefault();
    setNotice(null);
    setSubmitting(true);
    try {
      const targetUserIds = targetUserIdsText
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await api.createBroadcast({
        scope,
        targetBotIds: selectedBotIds,
        targetUserIds,
        messageText,
        imageUrl: imageUrl.trim() || null,
        inlineButtons: inlineButtons.filter((b) => b.text.trim() && b.url.trim()),
        includePromoFooter,
      });
      setConfirmingDraft(res.broadcast);
      onRefresh();
    } catch (err) {
      setNotice({ type: 'err', text: err instanceof Error ? err.message : 'Failed to create broadcast draft' });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleLaunch(id: string) {
    setBusyId(id);
    setNotice(null);
    try {
      const res = await api.launchBroadcast(id);
      setConfirmingDraft(null);
      setNotice({
        type: 'ok',
        text: `Broadcast ${id} launched for ${res.broadcast.total_recipients} eligible recipient(s). Batch 1 processed; Cron automatically resumes remaining batches.`,
      });
      onRefresh();
    } catch (err) {
      setNotice({ type: 'err', text: err instanceof Error ? err.message : 'Broadcast launch failed' });
    } finally {
      setBusyId(null);
    }
  }

  async function handleStep(id: string) {
    setBusyId(id);
    setNotice(null);
    try {
      await api.stepBroadcast(id);
      setNotice({ type: 'ok', text: `Processed next rate-limited batch for ${id}.` });
      onRefresh();
    } catch (err) {
      setNotice({ type: 'err', text: err instanceof Error ? err.message : 'Batch step failed' });
    } finally {
      setBusyId(null);
    }
  }

  async function handleStatus(id: string, status: 'paused' | 'running' | 'cancelled') {
    setBusyId(id);
    setNotice(null);
    try {
      await api.updateBroadcastStatus(id, status);
      onRefresh();
    } catch (err) {
      setNotice({ type: 'err', text: err instanceof Error ? err.message : 'Status update failed' });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      {notice && (
        <div
          className={`rounded-lg border px-4 py-2.5 text-xs ${
            notice.type === 'ok'
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
              : 'border-red-500/30 bg-red-500/10 text-red-300'
          }`}
        >
          {notice.text}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-12">
        {/* Composer */}
        <form onSubmit={handleCreateDraft} className="space-y-4 rounded-xl border border-slate-800/80 bg-[#0D1322] p-5 lg:col-span-7">
          <div className="border-b border-slate-800 pb-3">
            <h2 className="font-display text-sm font-semibold text-white">Global & Targeted Broadcast Composer</h2>
            <p className="text-xs text-slate-400">
              Dispatches only to verified, non-blocked users who started the target bot(s). Deduplicated & rate-limited.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-300">Audience Scope</label>
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value as typeof scope)}
                className="w-full rounded-lg border border-slate-700 bg-[#070B14] px-3 py-2 text-xs text-slate-100"
              >
                <option value="global">Global (All Active Tenant Bots)</option>
                <option value="single_bot">Specific Single Bot</option>
                <option value="bot_group">Selected Bot Group</option>
                <option value="selected_users">Selected User Telegram IDs</option>
              </select>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-300">Optional Header Image URL</label>
              <input
                type="url"
                value={imageUrl}
                onChange={(e) => setImageUrl(e.target.value)}
                placeholder="https://..."
                className="w-full rounded-lg border border-slate-700 bg-[#070B14] px-3 py-2 text-xs text-slate-100 placeholder-slate-500"
              />
            </div>
          </div>

          {(scope === 'single_bot' || scope === 'bot_group') && (
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-300">Select Target Bot(s)</label>
              <div className="flex max-h-28 flex-wrap gap-2 overflow-y-auto rounded-lg border border-slate-800 bg-[#070B14] p-2.5">
                {bots.length === 0 ? (
                  <span className="text-xs text-slate-500">No active bots loaded.</span>
                ) : (
                  bots.map((b) => {
                    const checked = selectedBotIds.includes(b.id);
                    return (
                      <button
                        type="button"
                        key={b.id}
                        onClick={() =>
                          setSelectedBotIds((prev) =>
                            scope === 'single_bot'
                              ? [b.id]
                              : checked
                                ? prev.filter((id) => id !== b.id)
                                : [...prev, b.id]
                          )
                        }
                        className={`rounded-md border px-2.5 py-1 text-xs ${
                          checked
                            ? 'border-blue-500 bg-blue-600/20 text-white'
                            : 'border-slate-700 text-slate-400 hover:text-white'
                        }`}
                      >
                        @{b.telegram_username}
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {scope === 'selected_users' && (
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-300">Target Telegram User IDs (comma or space separated)</label>
              <input
                type="text"
                value={targetUserIdsText}
                onChange={(e) => setTargetUserIdsText(e.target.value)}
                placeholder="123456789, 987654321"
                className="w-full rounded-lg border border-slate-700 bg-[#070B14] px-3 py-2 font-mono text-xs text-slate-100"
              />
            </div>
          )}

          <div>
            <label className="mb-1 block text-xs font-medium text-slate-300">Broadcast Message (Telegram HTML supported)</label>
            <textarea
              rows={6}
              required
              value={messageText}
              onChange={(e) => setMessageText(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-[#070B14] px-3 py-2.5 text-xs leading-relaxed text-slate-100 focus:border-blue-500 focus:outline-none"
            />
          </div>

          {/* Inline CTA Buttons */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <label className="text-xs font-medium text-slate-300">Custom Inline URL Buttons</label>
              <button
                type="button"
                onClick={() => setInlineButtons((p) => [...p, { text: 'Learn More', url: 'https://', style: 'primary' }])}
                className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300"
              >
                <Plus className="h-3.5 w-3.5" />
                Add CTA Button
              </button>
            </div>
            <div className="space-y-2">
              {inlineButtons.map((btn, idx) => (
                <div key={idx} className="flex gap-2">
                  <input
                    type="text"
                    value={btn.text}
                    onChange={(e) =>
                      setInlineButtons((p) => p.map((b, i) => (i === idx ? { ...b, text: e.target.value } : b)))
                    }
                    placeholder="Button text"
                    className="w-1/3 rounded-lg border border-slate-700 bg-[#070B14] px-2.5 py-1.5 text-xs text-slate-100"
                  />
                  <input
                    type="url"
                    value={btn.url}
                    onChange={(e) =>
                      setInlineButtons((p) => p.map((b, i) => (i === idx ? { ...b, url: e.target.value } : b)))
                    }
                    placeholder="https://..."
                    className="flex-1 rounded-lg border border-slate-700 bg-[#070B14] px-2.5 py-1.5 text-xs text-slate-100"
                  />
                  <select
                    value={btn.style}
                    onChange={(e) =>
                      setInlineButtons((p) =>
                        p.map((b, i) => (i === idx ? { ...b, style: e.target.value as 'primary' | 'success' | 'danger' } : b))
                      )
                    }
                    className="rounded-lg border border-slate-700 bg-[#070B14] px-2 py-1.5 text-xs text-slate-200"
                  >
                    <option value="success">Green</option>
                    <option value="primary">Blue</option>
                    <option value="danger">Red</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => setInlineButtons((p) => p.filter((_, i) => i !== idx))}
                    className="rounded-lg border border-red-500/30 p-1.5 text-red-400 hover:bg-red-500/10"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <label className="flex items-start gap-2.5 rounded-lg border border-slate-800 bg-[#070B14] p-3 text-xs text-slate-300">
            <input
              type="checkbox"
              checked={includePromoFooter}
              onChange={(e) => setIncludePromoFooter(e.target.checked)}
              className="mt-0.5 rounded border-slate-600"
            />
            <span>
              <strong>Append BOT FACTORY Promotional Footer & Deep Link</strong>
              <span className="mt-0.5 block font-mono text-[11px] text-slate-500">
                {masterBotDeepLink || 'Configure MASTER_BOT_USERNAME in wrangler.jsonc to activate deep link'}
              </span>
            </span>
          </label>

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={!connected || submitting}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-500 disabled:opacity-40"
            >
              <Send className="h-3.5 w-3.5" />
              {submitting ? 'Creating Draft...' : 'Save Draft & Confirm Launch'}
            </button>
          </div>
        </form>

        {/* Live Preview & Confirmation */}
        <div className="space-y-4 lg:col-span-5">
          <div className="rounded-xl border border-slate-800/80 bg-[#0D1322] p-5">
            <h3 className="font-display text-sm font-semibold text-white">Broadcast Preview</h3>
            <p className="mt-0.5 text-xs text-slate-400">Exact message & colourful CTA layout delivered via Telegram</p>

            <div className="mt-4 rounded-xl border border-slate-800 bg-[#070B14] p-4">
              {imageUrl && (
                <div className="mb-3 rounded border border-slate-800 bg-slate-900/60 px-3 py-2 font-mono text-[11px] text-slate-400 truncate">
                  Image: {imageUrl}
                </div>
              )}
              <div className="whitespace-pre-wrap text-xs leading-relaxed text-slate-200">{messageText}</div>

              {includePromoFooter && (
                <div className="mt-3 border-t border-slate-800 pt-2.5 text-xs italic text-slate-400">
                  🤖 Create your own Telegram bot easily with BOT FACTORY.
                </div>
              )}

              <div className="mt-3 space-y-1.5">
                {inlineButtons.map((b, i) => (
                  <div
                    key={i}
                    className={`rounded-lg px-3 py-2 text-center text-xs font-medium text-white ${
                      b.style === 'success' ? 'bg-emerald-600' : b.style === 'danger' ? 'bg-red-600' : 'bg-blue-600'
                    }`}
                  >
                    {b.text}
                  </div>
                ))}
                {includePromoFooter && (
                  <div className="rounded-lg bg-emerald-600 px-3 py-2 text-center text-xs font-semibold text-white">
                    🚀 Create Your Bot
                  </div>
                )}
              </div>
            </div>

            {confirmingDraft && (
              <div className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4">
                <div className="text-xs font-semibold text-amber-200">
                  Confirm Execution · Draft <span className="font-mono">{confirmingDraft.id}</span>
                </div>
                <p className="mt-1 text-xs text-amber-200/80">
                  Scope: <strong>{confirmingDraft.scope}</strong>. Eligible users who initiated target bots will be
                  queued in deduplicated, rate-limited batches.
                </p>
                <div className="mt-3 flex gap-2">
                  <button
                    onClick={() => handleLaunch(confirmingDraft.id)}
                    disabled={busyId === confirmingDraft.id}
                    className="rounded-lg bg-emerald-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500"
                  >
                    {busyId === confirmingDraft.id ? 'Dispatching...' : 'Confirm & Launch'}
                  </button>
                  <button
                    onClick={() => setConfirmingDraft(null)}
                    className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Broadcast History & Resumable Batch Queue */}
      <div className="rounded-xl border border-slate-800/80 bg-[#0D1322]">
        <div className="flex items-center justify-between border-b border-slate-800/80 px-5 py-4">
          <div>
            <h3 className="font-display text-sm font-semibold text-white">Broadcast History & Active Batches</h3>
            <p className="text-xs text-slate-400">Cloudflare Cron advances running batches automatically every 2 minutes</p>
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

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-800/80 text-slate-400">
              <tr>
                <th className="px-5 py-3 font-medium">Campaign ID / Scope</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 text-right font-medium">Eligible</th>
                <th className="px-5 py-3 text-right font-medium">Delivered</th>
                <th className="px-5 py-3 text-right font-medium">Blocked (403)</th>
                <th className="px-5 py-3 text-right font-medium">Failed</th>
                <th className="px-5 py-3 text-right font-medium">Controls</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {broadcasts.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-5 py-10 text-center text-slate-500">
                    {connected ? 'No broadcast campaigns recorded yet.' : 'Connect your Worker to view broadcast history.'}
                  </td>
                </tr>
              ) : (
                broadcasts.map((b) => (
                  <tr key={b.id} className="hover:bg-slate-800/30">
                    <td className="px-5 py-3">
                      <div className="font-mono text-slate-200">{b.id}</div>
                      <div className="text-[11px] text-slate-500">
                        {b.scope} · {new Date(b.created_at).toLocaleString()}
                      </div>
                    </td>
                    <td className="px-5 py-3 font-mono text-[11px] uppercase text-blue-400">{b.status}</td>
                    <td className="px-5 py-3 text-right font-mono tabular-nums">{b.total_recipients}</td>
                    <td className="px-5 py-3 text-right font-mono text-emerald-400 tabular-nums">{b.delivered_count}</td>
                    <td className="px-5 py-3 text-right font-mono text-amber-400 tabular-nums">{b.blocked_count}</td>
                    <td className="px-5 py-3 text-right font-mono text-red-400 tabular-nums">{b.failed_count}</td>
                    <td className="px-5 py-3">
                      <div className="flex items-center justify-end gap-1.5">
                        {b.status === 'draft' && (
                          <button
                            onClick={() => handleLaunch(b.id)}
                            disabled={busyId === b.id}
                            className="inline-flex items-center gap-1 rounded bg-emerald-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-emerald-500"
                          >
                            <Play className="h-3 w-3" /> Launch
                          </button>
                        )}
                        {b.status === 'running' && (
                          <>
                            <button
                              onClick={() => handleStep(b.id)}
                              disabled={busyId === b.id}
                              className="inline-flex items-center gap-1 rounded border border-blue-500/40 px-2 py-1 text-[11px] text-blue-300 hover:bg-blue-500/10"
                              title="Process next batch now"
                            >
                              <FastForward className="h-3 w-3" /> Step
                            </button>
                            <button
                              onClick={() => handleStatus(b.id, 'paused')}
                              disabled={busyId === b.id}
                              className="inline-flex items-center gap-1 rounded border border-amber-500/40 px-2 py-1 text-[11px] text-amber-300 hover:bg-amber-500/10"
                            >
                              <Pause className="h-3 w-3" /> Pause
                            </button>
                          </>
                        )}
                        {b.status === 'paused' && (
                          <button
                            onClick={() => handleStatus(b.id, 'running')}
                            disabled={busyId === b.id}
                            className="inline-flex items-center gap-1 rounded border border-emerald-500/40 px-2 py-1 text-[11px] text-emerald-300 hover:bg-emerald-500/10"
                          >
                            <Play className="h-3 w-3" /> Resume
                          </button>
                        )}
                        {['running', 'paused', 'draft'].includes(b.status) && (
                          <button
                            onClick={() => handleStatus(b.id, 'cancelled')}
                            disabled={busyId === b.id}
                            className="rounded border border-red-500/30 p-1 text-red-400 hover:bg-red-500/10"
                            title="Cancel campaign"
                          >
                            <XCircle className="h-3.5 w-3.5" />
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
    </div>
  );
}
