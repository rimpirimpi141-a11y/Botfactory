import React, { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowRight, Clock, Database, ShieldCheck, Wrench } from 'lucide-react';
import { TEMPLATE_CATALOG, type TemplateBlueprint } from '../catalog';
import { createWorkerApi, type TemplateStudioRecord, type WorkerConnection } from '../api';

interface TemplatesPanelProps {
  connection: WorkerConnection;
  connected: boolean;
  liveTemplates: TemplateStudioRecord[];
  onRefresh: () => void;
  onSelectTemplateToDeploy: (slug: string) => void;
}

const STYLE_MAP: Record<string, string> = {
  success: 'bg-emerald-600/90 text-white border-emerald-500/60',
  primary: 'bg-blue-600/90 text-white border-blue-500/60',
  danger: 'bg-red-600/90 text-white border-red-500/60',
  default: 'bg-slate-800 text-slate-200 border-slate-700',
};

export function TemplatesPanel({
  connection,
  connected,
  liveTemplates,
  onRefresh,
  onSelectTemplateToDeploy,
}: TemplatesPanelProps) {
  const [selected, setSelected] = useState<TemplateBlueprint>(TEMPLATE_CATALOG[0]);
  const [categoryFilter, setCategoryFilter] = useState<string>('All');
  const [updatingSlug, setUpdatingSlug] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const api = createWorkerApi(connection);

  const liveBySlug = useMemo(() => {
    const map = new Map<string, TemplateStudioRecord>();
    for (const t of liveTemplates) map.set(t.slug, t);
    return map;
  }, [liveTemplates]);

  const categories = useMemo(
    () => ['All', ...Array.from(new Set(TEMPLATE_CATALOG.map((t) => t.category)))],
    []
  );

  const filteredTemplates = useMemo(
    () =>
      categoryFilter === 'All'
        ? TEMPLATE_CATALOG
        : TEMPLATE_CATALOG.filter((t) => t.category === categoryFilter),
    [categoryFilter]
  );

  const selectedLive = liveBySlug.get(selected.slug);
  const effectiveStatus = selected.isComingSoon
    ? 'coming_soon'
    : selectedLive?.availability_status || selected.availabilityStatus;
  const deployDisabled = selected.isComingSoon || effectiveStatus !== 'active';

  async function handleStatusUpdate(tpl: TemplateBlueprint, nextStatus: 'active' | 'maintenance' | 'disabled') {
    const live = liveBySlug.get(tpl.slug);
    if (!live || tpl.isComingSoon) return;
    setUpdatingSlug(tpl.slug);
    setNotice(null);
    try {
      await api.updateTemplate(live.id, {
        availabilityStatus: nextStatus,
        isActive: nextStatus === 'active',
      });
      setNotice(`Updated ${tpl.name} availability to ${nextStatus.toUpperCase()}.`);
      onRefresh();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Failed to update template status');
    } finally {
      setUpdatingSlug(null);
    }
  }

  return (
    <div className="space-y-5">
      {/* Studio Summary & Category Filter */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800/80 bg-[#0D1322] p-4">
        <div>
          <h2 className="font-display text-sm font-semibold text-white">
            Template Studio — 11 Functional Templates + 2 Coming Soon
          </h2>
          <p className="mt-0.5 text-xs text-slate-400">
            All 11 production templates are available on every plan tier with dedicated native ReplyKeyboard Admin Panels.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setCategoryFilter(cat)}
              className={`rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors whitespace-nowrap ${
                categoryFilter === cat
                  ? 'border-blue-500 bg-blue-600/20 text-white'
                  : 'border-slate-800 bg-[#070B14] text-slate-400 hover:text-slate-200'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {notice && (
        <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 px-4 py-2.5 text-xs text-blue-200">
          {notice}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-12">
        {/* Template List */}
        <div className="space-y-2.5 lg:col-span-5">
          {filteredTemplates.map((tpl, idx) => {
            const active = selected.id === tpl.id;
            const live = liveBySlug.get(tpl.slug);
            const status = tpl.isComingSoon ? 'coming_soon' : live?.availability_status || tpl.availabilityStatus;

            return (
              <motion.button
                key={tpl.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.18, delay: Math.min(idx * 0.03, 0.28), ease: 'easeOut' }}
                onClick={() => setSelected(tpl)}
                className={`bf-card-interactive bf-press w-full rounded-xl border p-4 text-left ${
                  active
                    ? 'border-blue-500 bg-[#131B2E]'
                    : tpl.isComingSoon
                      ? 'border-slate-800/60 bg-[#0A0F1C] opacity-80 hover:border-slate-700'
                      : 'border-slate-800/80 bg-[#0D1322] hover:border-slate-700'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-display text-sm font-semibold text-white">{tpl.name}</span>
                  <span
                    className={`font-mono text-[10px] uppercase ${
                      status === 'coming_soon'
                        ? 'text-amber-400'
                        : status === 'active'
                          ? 'text-emerald-400'
                          : 'text-red-400'
                    }`}
                  >
                    {status === 'coming_soon' ? 'COMING SOON' : status}
                  </span>
                </div>
                <div className="mt-1 text-xs text-slate-400">
                  {tpl.category} · <span className="font-mono text-slate-500">{tpl.slug}</span>
                </div>
                <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-slate-400">{tpl.description}</p>
              </motion.button>
            );
          })}
        </div>

        {/* Selected Template Architecture Inspector */}
        <div className="lg:col-span-7">
          <AnimatePresence mode="wait">
            <motion.div
              key={selected.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.15, ease: 'easeOut' }}
              className="rounded-xl border border-slate-800/80 bg-[#0D1322] p-6"
            >
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-800 pb-5">
            <div>
              <div className="text-xs text-slate-400">
                {selected.category} · <span className="font-mono">{selected.id}</span> ·{' '}
                <span className="font-mono uppercase text-emerald-400">ALL PLANS UNLOCKED</span>
              </div>
              <h2 className="mt-1 font-display text-xl font-bold text-white">{selected.name}</h2>
              <p className="mt-2 max-w-xl text-xs leading-relaxed text-slate-300">{selected.description}</p>
            </div>

            {selected.isComingSoon ? (
              <div className="inline-flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-xs font-semibold text-amber-300 whitespace-nowrap shrink-0">
                <Clock className="h-3.5 w-3.5" />
                Coming Soon — Disabled
              </div>
            ) : (
              <button
                onClick={() => onSelectTemplateToDeploy(selected.slug)}
                disabled={deployDisabled}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-emerald-500 disabled:opacity-40 whitespace-nowrap shrink-0"
              >
                Deploy This Template
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {/* Owner Template Availability Controls (when connected & not Coming Soon) */}
          {connected && !selected.isComingSoon && selectedLive && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-800 bg-[#070B14] px-4 py-3">
              <div className="flex items-center gap-2 text-xs text-slate-300">
                <Wrench className="h-3.5 w-3.5 text-blue-400" />
                <span>
                  Owner Availability Control:{' '}
                  <strong className="font-mono uppercase text-white">{effectiveStatus}</strong>
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                {(['active', 'maintenance', 'disabled'] as const).map((st) => (
                  <button
                    key={st}
                    disabled={updatingSlug === selected.slug || effectiveStatus === st}
                    onClick={() => handleStatusUpdate(selected, st)}
                    className={`rounded border px-2.5 py-1 text-[11px] font-medium capitalize transition-colors disabled:opacity-40 ${
                      effectiveStatus === st
                        ? 'border-blue-500 bg-blue-600/20 text-white'
                        : 'border-slate-700 text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    {st}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Native Colourful Telegram User Keyboard */}
          <div className="mt-5">
            <div className="mb-2.5 flex items-center justify-between">
              <h3 className="text-xs font-semibold text-slate-200">
                Native Colourful User Keyboard (Zero Unstyled Buttons)
              </h3>
              <span className="font-mono text-[11px] text-slate-500">style: success / primary / danger</span>
            </div>
            <div className="rounded-lg border border-slate-800 bg-[#070B14] p-4">
              <div className="grid grid-cols-2 gap-2">
                {selected.userButtons.map((btn, idx) => (
                  <div
                    key={idx}
                    className={`flex items-center justify-between rounded-lg border px-3 py-2 text-xs font-medium ${STYLE_MAP[btn.style]}`}
                  >
                    <span className="truncate">{btn.text}</span>
                    <span className="ml-2 font-mono text-[10px] opacity-80">{btn.style}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Native ReplyKeyboard Tenant Admin Panel */}
          {selected.adminReplyButtons.length > 0 && (
            <div className="mt-5">
              <div className="mb-2.5 flex items-center justify-between">
                <h3 className="text-xs font-semibold text-slate-200">
                  Independent Tenant Admin Panel (Native ReplyKeyboard · /admin)
                </h3>
                <span className="font-mono text-[11px] text-slate-500">Strict bot_id isolation</span>
              </div>
              <div className="rounded-lg border border-slate-800 bg-[#070B14] p-4">
                <div className="grid grid-cols-2 gap-2">
                  {selected.adminReplyButtons.map((btn, idx) => (
                    <div
                      key={idx}
                      className={`flex items-center justify-between rounded-lg border px-3 py-2 text-xs font-medium ${STYLE_MAP[btn.style]}`}
                    >
                      <span className="truncate">{btn.text}</span>
                      <span className="ml-2 font-mono text-[10px] opacity-80">reply</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Admin Features & D1 Tables */}
          <div className="mt-6 grid gap-5 sm:grid-cols-2">
            <div>
              <h3 className="mb-2 text-xs font-semibold text-slate-200">Template & Admin Capabilities</h3>
              <ul className="space-y-1.5 text-xs text-slate-400">
                {selected.adminCapabilities.map((cap, i) => (
                  <li key={i} className="leading-relaxed">
                    · {cap}
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <h3 className="mb-2 inline-flex items-center gap-1.5 text-xs font-semibold text-slate-200">
                <Database className="h-3.5 w-3.5 text-blue-400" />
                Cloudflare D1 Schema Tables
              </h3>
              <div className="flex flex-wrap gap-x-2 gap-y-1 font-mono text-[11px] text-slate-400">
                {selected.d1TablesUsed.map((tbl, i) => (
                  <span key={tbl}>
                    {tbl}
                    {i < selected.d1TablesUsed.length - 1 ? ' ·' : ''}
                  </span>
                ))}
              </div>

              <div className="mt-4 rounded-lg border border-slate-800 bg-[#070B14] p-3">
                <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-400">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  Compliance & Verification Guardrail
                </div>
                <p className="mt-1 text-xs leading-relaxed text-slate-400">{selected.complianceNote}</p>
              </div>
            </div>
          </div>
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
