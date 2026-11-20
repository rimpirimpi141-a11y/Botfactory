import React, { useState } from 'react';
import { ArrowRight, Database, ShieldCheck } from 'lucide-react';
import { TEMPLATE_CATALOG, type TemplateBlueprint } from '../catalog';

interface TemplatesPanelProps {
  onSelectTemplateToDeploy: (slug: string) => void;
}

const STYLE_MAP: Record<string, string> = {
  success: 'bg-emerald-600/90 text-white border-emerald-500/60',
  primary: 'bg-blue-600/90 text-white border-blue-500/60',
  danger: 'bg-red-600/90 text-white border-red-500/60',
  default: 'bg-slate-800 text-slate-200 border-slate-700',
};

export function TemplatesPanel({ onSelectTemplateToDeploy }: TemplatesPanelProps) {
  const [selected, setSelected] = useState<TemplateBlueprint>(TEMPLATE_CATALOG[0]);

  return (
    <div className="grid gap-6 lg:grid-cols-12">
      {/* Template List */}
      <div className="space-y-2.5 lg:col-span-5">
        {TEMPLATE_CATALOG.map((tpl) => {
          const active = selected.id === tpl.id;
          return (
            <button
              key={tpl.id}
              onClick={() => setSelected(tpl)}
              className={`w-full rounded-xl border p-4 text-left transition-colors ${
                active
                  ? 'border-blue-500 bg-[#131B2E]'
                  : 'border-slate-800/80 bg-[#0D1322] hover:border-slate-700'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-display text-sm font-semibold text-white">{tpl.name}</span>
                <span className="font-mono text-[11px] text-slate-400 uppercase">{tpl.requiredPlan}</span>
              </div>
              <div className="mt-1 text-xs text-slate-400">
                {tpl.category} · <span className="font-mono text-slate-500">{tpl.slug}</span>
              </div>
              <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-slate-400">{tpl.description}</p>
            </button>
          );
        })}
      </div>

      {/* Selected Template Architecture Inspector */}
      <div className="rounded-xl border border-slate-800/80 bg-[#0D1322] p-6 lg:col-span-7">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-800 pb-5">
          <div>
            <div className="text-xs text-slate-400">
              {selected.category} · <span className="font-mono">{selected.id}</span>
            </div>
            <h2 className="mt-1 font-display text-xl font-bold text-white">{selected.name}</h2>
            <p className="mt-2 max-w-xl text-xs leading-relaxed text-slate-300">{selected.description}</p>
          </div>
          <button
            onClick={() => onSelectTemplateToDeploy(selected.slug)}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-emerald-500 whitespace-nowrap shrink-0"
          >
            Deploy This Template
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Native Colourful Telegram Keyboard Layout */}
        <div className="mt-5">
          <div className="mb-2.5 flex items-center justify-between">
            <h3 className="text-xs font-semibold text-slate-200">
              Native Colourful Telegram Button Styles (style: success / primary / danger)
            </h3>
            <span className="font-mono text-[11px] text-slate-500">KeyboardButton & InlineKeyboardButton</span>
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

        {/* Admin Features & D1 Tables */}
        <div className="mt-6 grid gap-5 sm:grid-cols-2">
          <div>
            <h3 className="mb-2 text-xs font-semibold text-slate-200">Admin Panel Capabilities</h3>
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
                Compliance & Safety Guardrail
              </div>
              <p className="mt-1 text-xs leading-relaxed text-slate-400">{selected.complianceNote}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
