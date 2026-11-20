import React, { useState } from 'react';
import { CheckCircle2, Copy, ExternalLink, RefreshCw, ShieldCheck, Terminal, X, AlertCircle } from 'lucide-react';
import type { HealthResponse, WorkerConnection } from '../api';
import { createWorkerApi, saveConnection } from '../api';
import { copyTextSafely } from '../clipboard';

interface SetupModalProps {
  open: boolean;
  connection: WorkerConnection;
  health: HealthResponse | null;
  onClose: () => void;
  onConnected: (conn: WorkerConnection, health: HealthResponse) => void;
}

export function SetupModal({ open, connection, health, onClose, onConnected }: SetupModalProps) {
  const [workerUrl, setWorkerUrl] = useState(connection.workerUrl);
  const [adminApiKey, setAdminApiKey] = useState(connection.adminApiKey);
  const [testing, setTesting] = useState(false);
  const [registeringMaster, setRegisteringMaster] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [masterMsg, setMasterMsg] = useState<string | null>(null);
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);

  if (!open) return null;

  async function handleTestAndSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMasterMsg(null);
    setTesting(true);
    try {
      const nextConn = { workerUrl: workerUrl.trim().replace(/\/+$/, ''), adminApiKey: adminApiKey.trim() };
      const api = createWorkerApi(nextConn);
      const res = await api.health();
      saveConnection(nextConn);
      onConnected(nextConn, res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect to Worker');
    } finally {
      setTesting(false);
    }
  }

  async function handleRegisterMasterWebhook() {
    setError(null);
    setMasterMsg(null);
    setRegisteringMaster(true);
    try {
      const api = createWorkerApi({ workerUrl, adminApiKey });
      const res = await api.registerMasterWebhook();
      setMasterMsg(
        `Verified Master Bot @${res.bot?.username || 'master'} -> ${res.verification?.webhookUrl || res.expectedWebhookUrl}`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Master webhook registration failed');
    } finally {
      setRegisteringMaster(false);
    }
  }

  async function copySnippet(id: string, text: string) {
    const copied = await copyTextSafely(text);
    if (copied) {
      setCopiedCmd(id);
      setTimeout(() => setCopiedCmd(null), 1800);
    } else {
      setError('Unable to access clipboard automatically in this frame. Select and copy the commands manually.');
    }
  }

  const cliCommands = `# 1. Provision Cloudflare D1 & KV (copy real IDs into wrangler.jsonc)
npx wrangler d1 create bot_factory_db
npx wrangler kv namespace create BOT_FACTORY_KV

# 2. Apply SQL Migrations to remote Cloudflare D1
npm run db:migrate:remote

# 3. Set required Worker Secrets (never stored in Git)
npx wrangler secret put MASTER_BOT_TOKEN
npx wrangler secret put MASTER_WEBHOOK_SECRET
npx wrangler secret put TOKEN_ENCRYPTION_KEY
npx wrangler secret put ADMIN_API_KEY

# 4. Deploy central multi-tenant Worker
npm run worker:deploy`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
      <div className="w-full max-w-2xl rounded-xl border border-slate-800 bg-[#0D1322] shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
          <div>
            <h2 className="font-display text-lg font-semibold text-white">Connect Cloudflare Worker</h2>
            <p className="text-xs text-slate-400">
              Link this Control Plane directly to your deployed multi-tenant BOT FACTORY Worker.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
            aria-label="Close modal"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleTestAndSave} className="space-y-5 p-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className="mb-1.5 block text-xs font-medium text-slate-300">
                Deployed Worker URL (HTTPS)
              </label>
              <input
                type="url"
                required
                value={workerUrl}
                onChange={(e) => setWorkerUrl(e.target.value)}
                placeholder="https://botfactory.rimpirimpi141.workers.dev"
                className="w-full rounded-lg border border-slate-700 bg-[#070B14] px-3.5 py-2.5 font-mono text-xs text-slate-100 placeholder-slate-500 focus:border-blue-500 focus:outline-none"
              />
            </div>

            <div className="sm:col-span-2">
              <label className="mb-1.5 block text-xs font-medium text-slate-300">
                Owner Admin API Key (stored in browser sessionStorage only)
              </label>
              <input
                type="password"
                value={adminApiKey}
                onChange={(e) => setAdminApiKey(e.target.value)}
                placeholder="Matches wrangler secret ADMIN_API_KEY"
                className="w-full rounded-lg border border-slate-700 bg-[#070B14] px-3.5 py-2.5 font-mono text-xs text-slate-100 placeholder-slate-500 focus:border-blue-500 focus:outline-none"
              />
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2.5 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
              <span>{error}</span>
            </div>
          )}

          {masterMsg && (
            <div className="flex items-start gap-2.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-300">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
              <span className="font-mono">{masterMsg}</span>
            </div>
          )}

          {health && (
            <div className="rounded-lg border border-slate-800 bg-[#070B14] p-4">
              <div className="mb-2 flex items-center justify-between text-xs">
                <span className="font-medium text-slate-200">Verified Worker Bindings</span>
                <span className="font-mono text-slate-400">
                  D1 Latency: {health.bindings.d1.latencyMs ?? '—'} ms
                </span>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-3">
                <BindingRow label="D1 Schema" ok={health.bindings.d1.healthy} />
                <BindingRow label="KV Cache" ok={health.bindings.kv} />
                <BindingRow label="Analytics Engine" ok={health.bindings.analyticsEngine} />
                <BindingRow label="Master Bot Token" ok={health.bindings.masterBotConfigured} />
                <BindingRow label="AES-GCM Key" ok={health.bindings.encryptionKeyConfigured} />
                <BindingRow label="Cloudflare API" ok={health.bindings.cloudflareMetricsConfigured} />
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <button
              type="button"
              onClick={handleRegisterMasterWebhook}
              disabled={registeringMaster || !workerUrl || !adminApiKey}
              className="inline-flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-xs font-medium text-emerald-300 transition-colors hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40 whitespace-nowrap shrink-0"
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              {registeringMaster ? 'Registering Master Webhook...' : 'Register & Verify Master Bot Webhook'}
            </button>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-slate-700 px-4 py-2 text-xs font-medium text-slate-300 transition-colors hover:bg-slate-800 whitespace-nowrap shrink-0"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={testing}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-500 disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${testing ? 'animate-spin' : ''}`} />
                {testing ? 'Verifying...' : 'Verify & Connect'}
              </button>
            </div>
          </div>

          <div className="border-t border-slate-800 pt-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-300">
                <Terminal className="h-3.5 w-3.5 text-blue-400" />
                Cloudflare Provisioning Commands
              </span>
              <button
                type="button"
                onClick={() => copySnippet('cli', cliCommands)}
                className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300"
              >
                <Copy className="h-3 w-3" />
                {copiedCmd === 'cli' ? 'Copied' : 'Copy commands'}
              </button>
            </div>
            <pre className="max-h-40 overflow-auto rounded-lg border border-slate-800 bg-[#070B14] p-3 font-mono text-[11px] leading-relaxed text-slate-300">
              {cliCommands}
            </pre>
            {health?.masterBotDeepLink && (
              <a
                href={health.masterBotDeepLink}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-flex items-center gap-1.5 text-xs text-emerald-400 hover:text-emerald-300"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Open Master Bot: {health.masterBotDeepLink}
              </a>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

function BindingRow({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div className="flex items-center justify-between py-0.5 text-slate-300">
      <span>{label}</span>
      <span className={`font-mono text-[11px] ${ok ? 'text-emerald-400' : 'text-amber-400'}`}>
        {ok ? 'Ready' : 'Missing'}
      </span>
    </div>
  );
}
