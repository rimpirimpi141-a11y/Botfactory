import React, { useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Copy,
  RefreshCw,
  ShieldCheck,
  Webhook,
} from 'lucide-react';
import {
  createWorkerApi,
  type HealthResponse,
  type MasterWebhookActionResponse,
  type MasterWebhookStatusResponse,
  type WorkerConnection,
} from '../api';
import { copyTextSafely } from '../clipboard';

interface MasterWebhookCardProps {
  connection: WorkerConnection;
  connected: boolean;
  health: HealthResponse | null;
  statusData: MasterWebhookStatusResponse | null;
  onStatusUpdated: (next: MasterWebhookStatusResponse) => void;
  onOpenConnect: () => void;
}

function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return 'Never';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

export function MasterWebhookCard({
  connection,
  connected,
  health,
  statusData,
  onStatusUpdated,
  onOpenConnect,
}: MasterWebhookCardProps) {
  const [registering, setRegistering] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [lastActionResult, setLastActionResult] = useState<MasterWebhookActionResponse | null>(null);
  const [copied, setCopied] = useState(false);

  const api = createWorkerApi(connection);
  const hasAuth = connected && api.hasAuth;

  const workerPublicUrl =
    statusData?.configuration.workerPublicUrl ||
    health?.workerPublicUrl ||
    connection.workerUrl ||
    'https://botfactory.rimpirimpi141.workers.dev';

  const expectedWebhookUrl =
    statusData?.configuration.expectedWebhookUrl ||
    health?.expectedMasterWebhookUrl ||
    `${workerPublicUrl.replace(/\/+$/, '')}/webhook/master`;

  const tokenConfigured =
    statusData?.configuration.masterBotTokenConfigured ?? Boolean(health?.bindings.masterBotConfigured);
  const secretConfigured =
    statusData?.configuration.masterWebhookSecretConfigured ?? Boolean(health?.bindings.masterWebhookSecretConfigured);
  const readyForRegistration = tokenConfigured && secretConfigured;
  const botUsername = lastActionResult?.bot?.username || statusData?.configuration.masterBotUsername || null;

  const currentStatus = !connected
    ? 'unconnected'
    : lastActionResult?.status || statusData?.webhook.status || 'not_registered';

  const lastRegisteredAt =
    lastActionResult?.lastRegisteredAt || statusData?.webhook.lastRegisteredAt || null;
  const lastVerifiedAt =
    lastActionResult?.lastVerifiedAt || statusData?.webhook.lastVerifiedAt || null;

  const telegramResponse =
    lastActionResult?.verification?.telegramResponse || statusData?.webhook.telegramResponse || null;
  const webhookInfo = telegramResponse?.webhookInfo || null;
  const readableError = actionError || lastActionResult?.error || statusData?.webhook.lastError || null;

  const statusTone =
    currentStatus === 'verified'
      ? 'text-emerald-400'
      : currentStatus === 'failed' || currentStatus === 'mismatch'
        ? 'text-red-400'
        : 'text-amber-400';

  const statusLabel =
    currentStatus === 'verified'
      ? 'VERIFIED & ACTIVE'
      : currentStatus === 'mismatch'
        ? 'URL MISMATCH'
        : currentStatus === 'failed'
          ? 'REGISTRATION FAILED'
          : currentStatus === 'not_registered'
            ? 'NOT REGISTERED'
            : 'UNCONNECTED';

  async function refreshStatusFromWorker() {
    const fresh = await api.getMasterWebhookStatus(false);
    onStatusUpdated(fresh);
  }

  async function handleRegisterWebhook() {
    setActionError(null);
    setActionNotice(null);
    setRegistering(true);
    try {
      const res = await api.registerMasterWebhook();
      setLastActionResult(res);
      setActionNotice(
        `Verified Master Bot @${res.bot?.username || 'master'} webhook at ${res.verification?.webhookUrl || res.expectedWebhookUrl}`
      );
      await refreshStatusFromWorker().catch(() => {});
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Master Bot webhook registration failed.');
      await refreshStatusFromWorker().catch(() => {});
    } finally {
      setRegistering(false);
    }
  }

  async function handleVerifyWebhook() {
    setActionError(null);
    setActionNotice(null);
    setVerifying(true);
    try {
      const res = await api.verifyMasterWebhook();
      setLastActionResult(res);
      if (res.verified) {
        setActionNotice(`Verified via Telegram getWebhookInfo: ${res.verification?.actualUrl || res.expectedWebhookUrl}`);
      } else {
        setActionError(
          res.error ||
            `Telegram reported "${res.verification?.actualUrl || 'empty'}" instead of "${res.expectedWebhookUrl}".`
        );
      }
      await refreshStatusFromWorker().catch(() => {});
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Master Bot webhook verification failed.');
    } finally {
      setVerifying(false);
    }
  }

  async function handleCopyUrl() {
    const ok = await copyTextSafely(expectedWebhookUrl);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }
  }

  return (
    <section className="rounded-xl border border-slate-800/80 bg-[#0D1322]">
      {/* Header Row */}
      <div className="flex flex-col justify-between gap-4 border-b border-slate-800/80 px-5 py-4 lg:flex-row lg:items-center">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Webhook className="h-4 w-4 shrink-0 text-blue-400" />
            <h3 className="font-display text-sm font-semibold text-white">
              Master Bot Webhook Registration
            </h3>
            <span className="text-xs text-slate-600">·</span>
            <span className={`font-mono text-[11px] font-medium ${statusTone}`}>
              {statusLabel}
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-400">
            Manual one-time owner registration for the central BOT FACTORY Master Bot. Secrets remain strictly inside Cloudflare Worker bindings.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {!hasAuth ? (
            <button
              type="button"
              onClick={onOpenConnect}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-500 whitespace-nowrap shrink-0"
            >
              Connect Worker & Admin Key
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={handleVerifyWebhook}
                disabled={verifying || registering || !tokenConfigured}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3.5 py-2 text-xs font-medium text-slate-200 transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40 whitespace-nowrap shrink-0"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${verifying ? 'animate-spin' : ''}`} />
                {verifying ? 'Verifying...' : 'Verify Webhook'}
              </button>
              <button
                type="button"
                onClick={handleRegisterWebhook}
                disabled={registering || verifying || !readyForRegistration}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40 whitespace-nowrap shrink-0"
              >
                <ShieldCheck className="h-3.5 w-3.5" />
                {registering ? 'Registering & Verifying...' : 'Register Webhook'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Structured Configuration & Status Details */}
      <div className="grid gap-6 p-5 lg:grid-cols-2">
        <div className="divide-y divide-slate-800/70 text-xs">
          <DetailRow
            label="Master Bot Config Status"
            value={
              !connected
                ? 'Unconnected'
                : readyForRegistration
                  ? `Ready${botUsername ? ` · @${botUsername}` : ''}`
                  : !tokenConfigured && !secretConfigured
                    ? 'MASTER_BOT_TOKEN & MASTER_WEBHOOK_SECRET Missing'
                    : !tokenConfigured
                      ? 'MASTER_BOT_TOKEN Missing'
                      : 'MASTER_WEBHOOK_SECRET Missing'
            }
            tone={readyForRegistration && connected ? 'text-emerald-400' : 'text-amber-400'}
          />
          <DetailRow
            label="Worker URL"
            value={workerPublicUrl}
            tone="text-slate-200"
            mono
          />
          <div className="flex items-center justify-between gap-3 py-2.5">
            <span className="shrink-0 text-slate-400">Target Webhook URL</span>
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate font-mono text-[11px] text-blue-300" title={expectedWebhookUrl}>
                {expectedWebhookUrl}
              </span>
              <button
                type="button"
                onClick={handleCopyUrl}
                className="inline-flex items-center gap-1 text-[11px] text-slate-400 transition-colors hover:text-white shrink-0"
                title="Copy expected Master Bot webhook URL"
              >
                <Copy className="h-3 w-3" />
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
          <DetailRow
            label="Allowed Updates"
            value={(statusData?.configuration.allowedUpdates || ['message', 'callback_query']).join(', ')}
            tone="text-slate-300"
            mono
          />
          <DetailRow
            label="Last Registration Time"
            value={formatTimestamp(lastRegisteredAt)}
            tone="text-slate-200"
            mono
          />
          <DetailRow
            label="Last Verification Time"
            value={formatTimestamp(lastVerifiedAt)}
            tone="text-slate-200"
            mono
          />
        </div>

        {/* Telegram API Response & Error Diagnostics */}
        <div className="flex flex-col justify-between gap-3">
          <div className="space-y-2.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-slate-200">Telegram API Response (getWebhookInfo)</span>
              <span className="font-mono text-[11px] text-slate-500">
                Credentials redacted
              </span>
            </div>

            {actionNotice && (
              <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-300">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                <span className="break-all font-mono text-[11px]">{actionNotice}</span>
              </div>
            )}

            {readableError && (
              <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
                <span className="break-words">{readableError}</span>
              </div>
            )}

            {webhookInfo ? (
              <div className="rounded-lg border border-slate-800 bg-[#070B14] p-3.5 font-mono text-[11px] leading-relaxed text-slate-300">
                <div className="flex justify-between gap-3 py-0.5">
                  <span className="text-slate-500">reported_url</span>
                  <span className="truncate text-right text-slate-100" title={webhookInfo.url || '(empty)'}>
                    {webhookInfo.url || '(empty)'}
                  </span>
                </div>
                <div className="flex justify-between gap-3 py-0.5">
                  <span className="text-slate-500">pending_update_count</span>
                  <span className="tabular-nums text-slate-100">{webhookInfo.pending_update_count}</span>
                </div>
                <div className="flex justify-between gap-3 py-0.5">
                  <span className="text-slate-500">max_connections</span>
                  <span className="tabular-nums text-slate-100">{webhookInfo.max_connections}</span>
                </div>
                <div className="flex justify-between gap-3 py-0.5">
                  <span className="text-slate-500">allowed_updates</span>
                  <span className="text-right text-slate-100">
                    {webhookInfo.allowed_updates.length > 0 ? webhookInfo.allowed_updates.join(', ') : 'default'}
                  </span>
                </div>
                {webhookInfo.ip_address && (
                  <div className="flex justify-between gap-3 py-0.5">
                    <span className="text-slate-500">ip_address</span>
                    <span className="text-slate-100">{webhookInfo.ip_address}</span>
                  </div>
                )}
                {webhookInfo.last_error_message && (
                  <div className="mt-2 border-t border-slate-800 pt-2 text-red-300">
                    last_error_message: {webhookInfo.last_error_message}
                  </div>
                )}
              </div>
            ) : (
              <div className="rounded-lg border border-slate-800 bg-[#070B14] p-4 text-xs text-slate-500">
                {hasAuth
                  ? 'No Telegram getWebhookInfo response recorded yet. Click "Verify Webhook" to inspect live status or "Register Webhook" to register manually.'
                  : 'Connect your Cloudflare Worker URL and Owner Admin API Key to inspect or register the Master Bot webhook.'}
              </div>
            )}
          </div>

          <div className="text-[11px] text-slate-500">
            Tenant bots created via BOT FACTORY automatically register and verify their own isolated webhooks at{' '}
            <span className="font-mono text-slate-400">{workerPublicUrl.replace(/\/+$/, '')}/webhook/{'{botId}'}</span>.
          </div>
        </div>
      </div>
    </section>
  );
}

function DetailRow({
  label,
  value,
  tone,
  mono = false,
}: {
  label: string;
  value: string;
  tone: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <span className="shrink-0 text-slate-400">{label}</span>
      <span className={`truncate text-right ${mono ? 'font-mono text-[11px] tabular-nums' : 'text-xs font-medium'} ${tone}`} title={value}>
        {value}
      </span>
    </div>
  );
}
