/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import {
  Award,
  Bot,
  Cloud,
  LayoutDashboard,
  Layers,
  Menu,
  Megaphone,
  Plug,
  Plus,
  Shield,
  Sliders,
  X,
} from 'lucide-react';
import {
  createWorkerApi,
  loadSavedConnection,
  type BotRecord,
  type BroadcastRecord,
  type CloudflareMetricsPayload,
  type DeploymentLogRecord,
  type HealthResponse,
  type MasterWebhookStatusResponse,
  type PlatformAdminRecord,
  type PlatformOverview,
  type PlatformReferralRecord,
  type SystemLogRecord,
  type TemplateStudioRecord,
  type UserRecord,
  type WorkerConnection,
} from './dashboard/api';
import { SetupModal } from './dashboard/components/SetupModal';
import { OverviewPanel } from './dashboard/components/OverviewPanel';
import { BotsPanel } from './dashboard/components/BotsPanel';
import { TemplatesPanel } from './dashboard/components/TemplatesPanel';
import { BuilderPanel } from './dashboard/components/BuilderPanel';
import { PlansPanel } from './dashboard/components/PlansPanel';
import { BroadcastPanel } from './dashboard/components/BroadcastPanel';
import { CloudflarePanel } from './dashboard/components/CloudflarePanel';
import { UsersAndLogsPanel } from './dashboard/components/UsersAndLogsPanel';

type SectionId = 'overview' | 'bots' | 'templates' | 'builder' | 'plans' | 'broadcast' | 'cloudflare' | 'admin';

const NAV_ITEMS: Array<{ id: SectionId; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'overview', label: 'Control Center', icon: LayoutDashboard },
  { id: 'bots', label: 'Bot Fleet', icon: Bot },
  { id: 'templates', label: 'Template Studio', icon: Layers },
  { id: 'builder', label: 'No-Code Builder', icon: Sliders },
  { id: 'plans', label: 'Plans & Referrals', icon: Award },
  { id: 'broadcast', label: 'Global Broadcast', icon: Megaphone },
  { id: 'cloudflare', label: 'Cloudflare Monitor', icon: Cloud },
  { id: 'admin', label: 'Owner & Security', icon: Shield },
];

export default function App() {
  const [section, setSection] = useState<SectionId>('overview');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [connection, setConnection] = useState<WorkerConnection>(() => loadSavedConnection());
  const [setupOpen, setSetupOpen] = useState(false);
  const [deployOpen, setDeployOpen] = useState(false);
  const [deployTemplateSlug, setDeployTemplateSlug] = useState<string | null>(null);
  const [builderBotId, setBuilderBotId] = useState<string | null>(null);

  // Real Worker API State (zero mock operational data)
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [overview, setOverview] = useState<PlatformOverview | null>(null);
  const [masterWebhookStatus, setMasterWebhookStatus] = useState<MasterWebhookStatusResponse | null>(null);
  const [topBots, setTopBots] = useState<BotRecord[]>([]);
  const [bots, setBots] = useState<BotRecord[]>([]);
  const [liveTemplates, setLiveTemplates] = useState<TemplateStudioRecord[]>([]);
  const [referrals, setReferrals] = useState<PlatformReferralRecord[]>([]);
  const [platformAdmins, setPlatformAdmins] = useState<PlatformAdminRecord[]>([]);
  const [deployments, setDeployments] = useState<DeploymentLogRecord[]>([]);
  const [broadcasts, setBroadcasts] = useState<BroadcastRecord[]>([]);
  const [cfMetrics, setCfMetrics] = useState<CloudflareMetricsPayload | null>(null);
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [logs, setLogs] = useState<SystemLogRecord[]>([]);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [masterDeepLink, setMasterDeepLink] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);

  const connected = Boolean(connection.workerUrl && health);

  const syncWithWorker = useCallback(
    async (conn: WorkerConnection = connection) => {
      const api = createWorkerApi(conn);
      if (!api.isConfigured) {
        setHealth(null);
        setOverview(null);
        setMasterWebhookStatus(null);
        return;
      }

      setLoading(true);
      setApiError(null);
      try {
        const h = await api.health();
        setHealth(h);
        setMasterDeepLink(h.masterBotDeepLink);

        if (api.hasAuth) {
          const [
            ovRes,
            botsRes,
            tplRes,
            refRes,
            admRes,
            depRes,
            brcRes,
            cfRes,
            usrRes,
            logRes,
            masterWhRes,
          ] = await Promise.allSettled([
            api.getOverview(),
            api.listBots(),
            api.getAllTemplates(),
            api.listReferrals(),
            api.listPlatformAdmins(),
            api.listDeployments(),
            api.listBroadcasts(),
            api.getCloudflareMetrics(),
            api.listUsers(),
            api.listLogs(),
            api.getMasterWebhookStatus(false),
          ]);

          if (ovRes.status === 'fulfilled') {
            setOverview(ovRes.value.analytics.overview);
            setTopBots(ovRes.value.analytics.topBots || []);
            setSettings(ovRes.value.settings || {});
            setMasterDeepLink(ovRes.value.masterBotDeepLink || h.masterBotDeepLink);
          } else {
            setApiError(ovRes.reason instanceof Error ? ovRes.reason.message : 'Unable to load overview');
          }

          if (botsRes.status === 'fulfilled') setBots(botsRes.value.bots || []);
          if (tplRes.status === 'fulfilled') setLiveTemplates(tplRes.value.templates || []);
          if (refRes.status === 'fulfilled') setReferrals(refRes.value.referrals || []);
          if (admRes.status === 'fulfilled') setPlatformAdmins(admRes.value.admins || []);
          if (depRes.status === 'fulfilled') setDeployments(depRes.value.deployments || []);
          if (brcRes.status === 'fulfilled') setBroadcasts(brcRes.value.broadcasts || []);
          if (cfRes.status === 'fulfilled') setCfMetrics(cfRes.value.metrics);
          if (usrRes.status === 'fulfilled') setUsers(usrRes.value.users || []);
          if (logRes.status === 'fulfilled') setLogs(logRes.value.logs || []);
          if (masterWhRes.status === 'fulfilled') setMasterWebhookStatus(masterWhRes.value);
        }
      } catch (err) {
        setHealth(null);
        setMasterWebhookStatus(null);
        setApiError(err instanceof Error ? err.message : 'Failed to connect to Cloudflare Worker');
      } finally {
        setLoading(false);
      }
    },
    [connection]
  );

  useEffect(() => {
    if (connection.workerUrl) {
      syncWithWorker(connection);
    }
  }, []);

  const currentNav = NAV_ITEMS.find((n) => n.id === section) || NAV_ITEMS[0];

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex min-h-screen bg-[#070B14] text-slate-100">
        {/* Desktop Sidebar (252px) */}
        <aside className="hidden w-[252px] shrink-0 flex-col border-r border-slate-800/80 bg-[#0A101D] lg:flex">
          <div className="flex h-16 flex-col justify-center border-b border-slate-800/80 px-6">
            <div className="font-display text-base font-bold tracking-tight text-white whitespace-nowrap">
              BOT FACTORY
            </div>
            <div className="font-mono text-[10px] tracking-wider text-slate-400">Build. Customize. Deploy.</div>
          </div>

          <nav className="flex-1 space-y-1 px-3 py-4">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const active = section === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setSection(item.id)}
                  className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-xs font-medium transition-colors whitespace-nowrap ${
                    active
                      ? 'bg-blue-600/15 text-white'
                      : 'text-slate-400 hover:bg-slate-800/50 hover:text-slate-100'
                  }`}
                >
                  <Icon className={`h-4 w-4 shrink-0 ${active ? 'text-blue-400' : 'text-slate-500'}`} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>

          <div className="border-t border-slate-800/80 p-4">
            <div className="text-[11px] font-medium text-slate-400">Cloudflare Worker</div>
            <div className="mt-1 truncate font-mono text-[11px] text-slate-300">
              {connection.workerUrl || 'Not configured'}
            </div>
            <div className="mt-1.5 font-mono text-[11px]">
              <span className={connected ? 'text-emerald-400' : 'text-amber-400'}>
                {connected ? 'Connected · D1 Ready' : 'Unconnected'}
              </span>
            </div>
            <button
              onClick={() => setSetupOpen(true)}
              className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:bg-slate-800 whitespace-nowrap"
            >
              <Plug className="h-3.5 w-3.5" />
              {connected ? 'Worker Settings' : 'Connect Worker'}
            </button>
          </div>
        </aside>

        {/* Mobile Drawer */}
        {mobileNavOpen && (
          <div className="fixed inset-0 z-40 flex lg:hidden">
            <div className="fixed inset-0 bg-black/70" onClick={() => setMobileNavOpen(false)} />
            <aside className="relative z-10 flex w-64 flex-col border-r border-slate-800 bg-[#0A101D]">
              <div className="flex h-16 items-center justify-between border-b border-slate-800 px-5">
                <span className="font-display text-base font-bold text-white">BOT FACTORY</span>
                <button onClick={() => setMobileNavOpen(false)} className="p-1.5 text-slate-400 hover:text-white">
                  <X className="h-4 w-4" />
                </button>
              </div>
              <nav className="flex-1 space-y-1 p-3">
                {NAV_ITEMS.map((item) => {
                  const Icon = item.icon;
                  const active = section === item.id;
                  return (
                    <button
                      key={item.id}
                      onClick={() => {
                        setSection(item.id);
                        setMobileNavOpen(false);
                      }}
                      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-xs font-medium ${
                        active ? 'bg-blue-600/15 text-white' : 'text-slate-400 hover:bg-slate-800/50 hover:text-white'
                      }`}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </nav>
            </aside>
          </div>
        )}

        {/* Main Content Area */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Top Bar Contract: Breadcrumbs left, max 2 single-line actions right */}
          <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-4 border-b border-slate-800/80 bg-[#070B14]/95 px-6 backdrop-blur">
            <div className="flex min-w-0 items-center gap-3">
              <button
                onClick={() => setMobileNavOpen(true)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white lg:hidden"
                aria-label="Open menu"
              >
                <Menu className="h-5 w-5" />
              </button>
              <div className="flex items-center gap-2 truncate text-xs text-slate-400">
                <span className="hidden sm:inline">BOT FACTORY</span>
                <span className="hidden sm:inline" aria-hidden="true">/</span>
                <h1 className="truncate font-display text-sm font-semibold text-white">{currentNav.label}</h1>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2.5">
              <button
                onClick={() => setSetupOpen(true)}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-700 px-3.5 py-2 text-xs font-medium text-slate-200 transition-colors hover:bg-slate-800 whitespace-nowrap"
              >
                <Plug className="h-3.5 w-3.5" />
                {connected ? 'Worker Connected' : 'Connect Worker'}
              </button>
              <button
                onClick={() => {
                  setDeployTemplateSlug(null);
                  setSection('bots');
                  setDeployOpen(true);
                }}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-500 whitespace-nowrap"
              >
                <Plus className="h-3.5 w-3.5" />
                Deploy Bot
              </button>
            </div>
          </header>

          <main className="mx-auto w-full max-w-[1360px] flex-1 p-6">
            <AnimatePresence mode="wait">
              <motion.div
                key={section}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.16, ease: 'easeOut' }}
              >
                {section === 'overview' && (
                  <OverviewPanel
                    connection={connection}
                    connected={connected}
                    loading={loading}
                    error={apiError}
                    health={health}
                    overview={overview}
                    masterWebhookStatus={masterWebhookStatus}
                    topBots={topBots}
                    masterBotDeepLink={masterDeepLink}
                    onRefresh={() => syncWithWorker()}
                    onMasterWebhookStatusChange={setMasterWebhookStatus}
                    onOpenConnect={() => setSetupOpen(true)}
                    onOpenDeploy={() => {
                      setSection('bots');
                      setDeployOpen(true);
                    }}
                  />
                )}

                {section === 'bots' && (
                  <BotsPanel
                    connection={connection}
                    connected={connected}
                    bots={bots}
                    loading={loading}
                    initialTemplateSlug={deployTemplateSlug}
                    openDeployModal={deployOpen}
                    onCloseDeployModal={() => setDeployOpen(false)}
                    onOpenDeployModal={() => setDeployOpen(true)}
                    onRefresh={() => syncWithWorker()}
                    onEditInBuilder={(botId) => {
                      setBuilderBotId(botId);
                      setSection('builder');
                    }}
                  />
                )}

                {section === 'templates' && (
                  <TemplatesPanel
                    connection={connection}
                    connected={connected}
                    liveTemplates={liveTemplates}
                    onRefresh={() => syncWithWorker()}
                    onSelectTemplateToDeploy={(slug) => {
                      setDeployTemplateSlug(slug);
                      setSection('bots');
                      setDeployOpen(true);
                    }}
                  />
                )}

                {section === 'builder' && (
                  <BuilderPanel
                    connection={connection}
                    connected={connected}
                    bots={bots}
                    selectedBotId={builderBotId}
                    onSelectBotId={setBuilderBotId}
                  />
                )}

                {section === 'plans' && (
                  <PlansPanel
                    connection={connection}
                    connected={connected}
                    loading={loading}
                    overview={overview}
                    referrals={referrals}
                    onRefresh={() => syncWithWorker()}
                  />
                )}

                {section === 'broadcast' && (
                  <BroadcastPanel
                    connection={connection}
                    connected={connected}
                    bots={bots}
                    broadcasts={broadcasts}
                    masterBotDeepLink={masterDeepLink}
                    loading={loading}
                    onRefresh={() => syncWithWorker()}
                  />
                )}

                {section === 'cloudflare' && (
                  <CloudflarePanel
                    connected={connected}
                    loading={loading}
                    metrics={cfMetrics}
                    onRefresh={() => syncWithWorker()}
                  />
                )}

                {section === 'admin' && (
                  <UsersAndLogsPanel
                    connection={connection}
                    connected={connected}
                    users={users}
                    logs={logs}
                    platformAdmins={platformAdmins}
                    deployments={deployments}
                    settings={settings}
                    loading={loading}
                    onRefresh={() => syncWithWorker()}
                  />
                )}
              </motion.div>
            </AnimatePresence>
          </main>
        </div>

        <SetupModal
          open={setupOpen}
          connection={connection}
          health={health}
          onClose={() => setSetupOpen(false)}
          onConnected={(nextConn, nextHealth) => {
            setConnection(nextConn);
            setHealth(nextHealth);
            setSetupOpen(false);
            syncWithWorker(nextConn);
          }}
        />
      </div>
    </MotionConfig>
  );
}
