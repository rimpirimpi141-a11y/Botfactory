import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Copy,
  Download,
  Plus,
  Save,
  Shield,
  Trash2,
} from 'lucide-react';
import type { BotBrandingConfig, BotRecord, BuilderButton, BuilderMenu, WorkerConnection } from '../api';
import { createWorkerApi } from '../api';
import { copyTextSafely } from '../clipboard';
import { DEFAULT_BUILDER_MENUS, THEME_OPTIONS } from '../catalog';

interface BuilderPanelProps {
  connection: WorkerConnection;
  connected: boolean;
  bots: BotRecord[];
  selectedBotId: string | null;
  onSelectBotId: (botId: string | null) => void;
}

const TELEGRAM_STYLE_CLASSES: Record<BuilderButton['style'], string> = {
  success: 'bg-emerald-600 text-white border-emerald-500',
  primary: 'bg-blue-600 text-white border-blue-500',
  danger: 'bg-red-600 text-white border-red-500',
  default: 'bg-slate-800 text-slate-200 border-slate-700',
};

type ExtendedActionKind =
  | 'submenu'
  | 'message'
  | 'info'
  | 'collect_input'
  | 'catalogue'
  | 'create_order'
  | 'submit_request'
  | 'support'
  | 'url'
  | 'feature'
  | 'back';

function getUiActionKind(btn: BuilderButton): ExtendedActionKind {
  if (btn.actionType === 'feature') {
    const p = btn.actionPayload || '';
    if (p.startsWith('info:')) return 'info';
    if (p.startsWith('form:')) return 'collect_input';
    if (p.startsWith('catalogue:')) return 'catalogue';
    if (p.startsWith('create_order:')) return 'create_order';
    if (p.startsWith('submit_request:')) return 'submit_request';
  }
  return btn.actionType;
}

function stripPrefix(payload: string, prefix: string) {
  return payload.startsWith(prefix) ? payload.slice(prefix.length) : payload;
}

function computeDynamicAdminModules(menus: BuilderMenu[]) {
  const allButtons = menus.flatMap((m) => m.buttons);
  let hasProducts = false;
  let hasOrders = false;
  let hasForms = false;
  let hasSupport = false;

  for (const b of allButtons) {
    const p = b.actionPayload || '';
    if (b.actionType === 'support' || p === 'support_contact') hasSupport = true;
    if (b.actionType === 'feature') {
      if (p.startsWith('catalogue:')) hasProducts = true;
      if (p.startsWith('create_order:')) {
        hasProducts = true;
        hasOrders = true;
      }
      if (p.startsWith('form:') || p.startsWith('submit_request:')) hasForms = true;
    }
  }

  const modules: Array<{ label: string; style: 'success' | 'primary' | 'danger'; reason: string }> = [
    { label: '📊 Bot Analytics', style: 'primary', reason: 'Core module' },
    { label: '👥 Manage Users', style: 'primary', reason: 'Core module' },
    { label: '📢 Force Join', style: 'primary', reason: 'Core module' },
    { label: '📣 Broadcast Users', style: 'success', reason: 'Core module' },
  ];

  if (hasProducts) {
    modules.push({ label: '🛍 Manage Products', style: 'success', reason: 'Detected Catalogue / Order button' });
  }
  if (hasOrders) {
    modules.push({ label: '📦 Manage Orders', style: 'primary', reason: 'Detected Create Order action' });
    modules.push({ label: '💳 Payment Verification', style: 'danger', reason: 'Detected Paid Order flow' });
  }
  if (hasForms) {
    modules.push({ label: '📥 Form Submissions', style: 'primary', reason: 'Detected Input / Request form' });
  }
  if (hasSupport) {
    modules.push({ label: '🆘 Support Settings', style: 'primary', reason: 'Detected Support button' });
  }
  modules.push({ label: '⚙️ Bot Settings', style: 'primary', reason: 'Core module' });

  return modules;
}

export function BuilderPanel({ connection, connected, bots, selectedBotId, onSelectBotId }: BuilderPanelProps) {
  const [menus, setMenus] = useState<BuilderMenu[]>(DEFAULT_BUILDER_MENUS);
  const [activeMenuKey, setActiveMenuKey] = useState<string>('main');
  const [branding, setBranding] = useState<BotBrandingConfig>({
    brandTitle: 'My Custom Bot',
    welcomeMessage: 'Welcome! Select an option below.',
    welcomeImageUrl: null,
    logoUrl: null,
    footerText: 'Built with BOT FACTORY',
    supportUsername: '',
    themeId: 'obsidian_neon',
  });
  const [previewAsAdmin, setPreviewAsAdmin] = useState(true);
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const api = createWorkerApi(connection);

  useEffect(() => {
    if (!connected || !selectedBotId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.getBuilder(selectedBotId);
        if (cancelled) return;
        if (res.config) setBranding(res.config);
        if (res.menus && res.menus.length > 0) {
          setMenus(res.menus);
          setActiveMenuKey(res.menus[0].menuKey);
        }
      } catch (err) {
        if (!cancelled) {
          setStatusMsg({ type: 'err', text: err instanceof Error ? err.message : 'Failed to load bot builder config' });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connected, selectedBotId]);

  const activeMenu = menus.find((m) => m.menuKey === activeMenuKey) || menus[0];
  const dynamicAdminModules = useMemo(() => computeDynamicAdminModules(menus), [menus]);

  function updateActiveMenu(patch: Partial<BuilderMenu>) {
    setMenus((prev) => prev.map((m) => (m.menuKey === activeMenu.menuKey ? { ...m, ...patch } : m)));
  }

  function addSubmenu() {
    const idx = menus.length + 1;
    const key = `sub_menu_${idx}`;
    const next: BuilderMenu = {
      menuKey: key,
      parentMenuKey: activeMenu.menuKey,
      title: `Submenu ${idx}`,
      messageText: 'Configure this submenu message and buttons.',
      imageUrl: null,
      scope: 'user',
      keyboardType: 'inline',
      columns: 2,
      isRoot: false,
      buttons: [
        {
          id: `btn_back_${idx}`,
          label: 'Back',
          emoji: '⬅️',
          actionType: 'back',
          actionPayload: activeMenu.menuKey,
          row: 0,
          col: 0,
          position: 0,
          visibility: 'all',
          style: 'danger',
        },
      ],
    };
    setMenus((prev) => [...prev, next]);
    setActiveMenuKey(key);
  }

  function deleteActiveMenu() {
    if (activeMenu.isRoot || menus.length <= 1) return;
    const nextList = menus.filter((m) => m.menuKey !== activeMenu.menuKey);
    setMenus(nextList);
    setActiveMenuKey(nextList[0].menuKey);
  }

  function addButton() {
    const pos = activeMenu.buttons.length;
    const cols = Math.max(1, activeMenu.columns || 2);
    const nextBtn: BuilderButton = {
      id: `btn_${Math.random().toString(36).slice(2, 10)}`,
      label: 'New Action',
      emoji: '⚡',
      actionType: 'message',
      actionPayload: 'Configure your response text here.',
      row: Math.floor(pos / cols),
      col: pos % cols,
      position: pos,
      visibility: activeMenu.scope === 'admin' ? 'admins' : 'all',
      style: 'primary',
    };
    updateActiveMenu({ buttons: [...activeMenu.buttons, nextBtn] });
  }

  function updateButton(btnId: string, patch: Partial<BuilderButton>) {
    updateActiveMenu({
      buttons: activeMenu.buttons.map((b) => (b.id === btnId ? { ...b, ...patch } : b)),
    });
  }

  function handleActionKindChange(btn: BuilderButton, kind: ExtendedActionKind) {
    switch (kind) {
      case 'info':
        updateButton(btn.id, { actionType: 'feature', actionPayload: 'info:Important information for your users.' });
        break;
      case 'collect_input':
        updateButton(btn.id, { actionType: 'feature', actionPayload: 'form:Please reply with your details:' });
        break;
      case 'submit_request':
        updateButton(btn.id, { actionType: 'feature', actionPayload: 'submit_request:Describe your request:' });
        break;
      case 'catalogue':
        updateButton(btn.id, { actionType: 'feature', actionPayload: 'catalogue:all' });
        break;
      case 'create_order':
        updateButton(btn.id, { actionType: 'feature', actionPayload: 'create_order:all' });
        break;
      case 'submenu':
      case 'back':
        updateButton(btn.id, { actionType: kind, actionPayload: menus[0]?.menuKey || 'main' });
        break;
      case 'feature':
        updateButton(btn.id, { actionType: 'feature', actionPayload: 'user_profile' });
        break;
      case 'url':
        updateButton(btn.id, { actionType: 'url', actionPayload: 'https://example.com' });
        break;
      case 'support':
        updateButton(btn.id, { actionType: 'support', actionPayload: 'Contact our support desk for assistance.' });
        break;
      default:
        updateButton(btn.id, { actionType: 'message', actionPayload: 'Configure your response text here.' });
    }
  }

  function moveButton(index: number, dir: -1 | 1) {
    const target = index + dir;
    if (target < 0 || target >= activeMenu.buttons.length) return;
    const copy = [...activeMenu.buttons];
    const [moved] = copy.splice(index, 1);
    copy.splice(target, 0, moved);
    const cols = Math.max(1, activeMenu.columns || 2);
    const reindexed = copy.map((b, i) => ({
      ...b,
      position: i,
      row: Math.floor(i / cols),
      col: i % cols,
    }));
    updateActiveMenu({ buttons: reindexed });
  }

  function removeButton(btnId: string) {
    const remaining = activeMenu.buttons.filter((b) => b.id !== btnId);
    const cols = Math.max(1, activeMenu.columns || 2);
    updateActiveMenu({
      buttons: remaining.map((b, i) => ({ ...b, position: i, row: Math.floor(i / cols), col: i % cols })),
    });
  }

  async function handleSaveToD1() {
    if (!selectedBotId) {
      setStatusMsg({ type: 'err', text: 'Select a deployed bot from the dropdown to save directly to Cloudflare D1.' });
      return;
    }
    setSaving(true);
    setStatusMsg(null);
    try {
      await api.saveBuilder(selectedBotId, { config: branding, menus });
      setStatusMsg({ type: 'ok', text: `Saved ${menus.length} menu(s) & dynamic admin rules to D1 and invalidated KV cache.` });
    } catch (err) {
      setStatusMsg({ type: 'err', text: err instanceof Error ? err.message : 'Failed to save configuration' });
    } finally {
      setSaving(false);
    }
  }

  function exportSchemaJson() {
    const payload = JSON.stringify({ branding, menus, dynamicAdminModules }, null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bot-factory-blueprint-${selectedBotId || 'draft'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function copySchemaJson() {
    const copied = await copyTextSafely(JSON.stringify({ branding, menus, dynamicAdminModules }, null, 2));
    if (copied) {
      setStatusMsg({ type: 'ok', text: 'Copied validated builder JSON schema to clipboard.' });
    } else {
      setStatusMsg({ type: 'err', text: 'Clipboard access blocked by browser frame. Use Export Blueprint instead.' });
    }
  }

  const previewButtons = activeMenu.buttons.filter((b) => {
    if (b.visibility === 'hidden') return false;
    if (b.visibility === 'admins' && !previewAsAdmin) return false;
    return true;
  });
  const cols = Math.max(1, Math.min(4, activeMenu.columns || 2));
  const previewRows: BuilderButton[][] = [];
  for (let i = 0; i < previewButtons.length; i += cols) {
    previewRows.push(previewButtons.slice(i, i + cols));
  }

  const guidedSteps = [
    { num: 1, title: 'Bot Basics', done: Boolean(selectedBotId || branding.brandTitle.trim()) },
    { num: 2, title: 'Welcome & Theme', done: Boolean(branding.welcomeMessage.trim() && branding.themeId) },
    { num: 3, title: 'Menus & Buttons', done: menus.length > 0 && activeMenu.buttons.length > 0 },
    {
      num: 4,
      title: 'Actions & Forms',
      done: menus.some((m) => m.buttons.some((b) => b.actionType !== 'message' || Boolean(b.actionPayload))),
    },
    { num: 5, title: 'Dynamic Admin & Save', done: dynamicAdminModules.length >= 5 },
  ];

  return (
    <div className="animate-fade-slide-up space-y-5">
      {/* 5-Step Guided No-Code Builder Progress */}
      <div className="grid gap-2 rounded-xl border border-slate-800/80 bg-[#0D1322] p-3.5 sm:grid-cols-5">
        {guidedSteps.map((st) => (
          <div
            key={st.num}
            className="flex items-center gap-2.5 rounded-lg border border-slate-800/80 bg-[#070B14] px-3 py-2 text-xs"
          >
            <span
              className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md font-mono text-[11px] font-semibold ${
                st.done ? 'bg-emerald-600/20 text-emerald-400' : 'bg-slate-800 text-slate-400'
              }`}
            >
              {st.num}
            </span>
            <span className="truncate font-medium text-slate-200">{st.title}</span>
          </div>
        ))}
      </div>

      {/* Top Action Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800/80 bg-[#0D1322] p-4">
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-xs font-medium text-slate-400">Target Bot:</label>
          <select
            value={selectedBotId || ''}
            onChange={(e) => onSelectBotId(e.target.value || null)}
            className="rounded-lg border border-slate-700 bg-[#070B14] px-3 py-1.5 text-xs text-slate-100 focus:border-blue-500 focus:outline-none"
          >
            <option value="">Local Draft Blueprint (Exportable JSON)</option>
            {bots.map((b) => (
              <option key={b.id} value={b.id}>
                @{b.telegram_username} ({b.display_name})
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={copySchemaJson}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800 whitespace-nowrap"
          >
            <Copy className="h-3.5 w-3.5" />
            Copy JSON
          </button>
          <button
            onClick={exportSchemaJson}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800 whitespace-nowrap"
          >
            <Download className="h-3.5 w-3.5" />
            Export Blueprint
          </button>
          <button
            onClick={handleSaveToD1}
            disabled={!connected || !selectedBotId || saving}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-40 whitespace-nowrap"
          >
            <Save className="h-3.5 w-3.5" />
            {saving ? 'Saving to D1...' : 'Save Live to Cloudflare D1'}
          </button>
        </div>
      </div>

      {statusMsg && (
        <div
          className={`flex items-center gap-2 rounded-lg border px-4 py-2.5 text-xs ${
            statusMsg.type === 'ok'
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
              : 'border-red-500/30 bg-red-500/10 text-red-300'
          }`}
        >
          {statusMsg.type === 'ok' ? (
            <CheckCircle2 className="h-4 w-4 shrink-0" />
          ) : (
            <AlertCircle className="h-4 w-4 shrink-0" />
          )}
          <span>{statusMsg.text}</span>
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-12">
        {/* Left: Menu Tree & Branding */}
        <div className="space-y-5 xl:col-span-3">
          <div className="rounded-xl border border-slate-800/80 bg-[#0D1322] p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-display text-xs font-semibold text-white">Menu Tree ({menus.length})</h3>
              <button
                onClick={addSubmenu}
                className="inline-flex items-center gap-1 text-xs font-medium text-blue-400 hover:text-blue-300"
              >
                <Plus className="h-3.5 w-3.5" />
                Add Submenu
              </button>
            </div>
            <div className="space-y-1.5">
              {menus.map((m) => (
                <button
                  key={m.menuKey}
                  onClick={() => setActiveMenuKey(m.menuKey)}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs transition-colors ${
                    m.menuKey === activeMenu.menuKey
                      ? 'bg-blue-600/20 text-white'
                      : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
                  }`}
                >
                  <div className="truncate">
                    <div className="font-medium">{m.title}</div>
                    <div className="font-mono text-[10px] text-slate-500">
                      {m.menuKey} · {m.scope}
                    </div>
                  </div>
                  <span className="font-mono text-[11px] text-slate-500">{m.buttons.length}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-3 rounded-xl border border-slate-800/80 bg-[#0D1322] p-4">
            <h3 className="font-display text-xs font-semibold text-white">Theme & Branding</h3>
            <div>
              <label className="mb-1 block text-[11px] text-slate-400">Brand Title</label>
              <input
                type="text"
                value={branding.brandTitle}
                onChange={(e) => setBranding((p) => ({ ...p, brandTitle: e.target.value }))}
                className="w-full rounded-lg border border-slate-700 bg-[#070B14] px-2.5 py-1.5 text-xs text-slate-100"
              />
            </div>
            <div>
              <label className="mb-1 block text-[11px] text-slate-400">Theme Preset</label>
              <select
                value={branding.themeId}
                onChange={(e) => setBranding((p) => ({ ...p, themeId: e.target.value }))}
                className="w-full rounded-lg border border-slate-700 bg-[#070B14] px-2.5 py-1.5 text-xs text-slate-100"
              >
                {THEME_OPTIONS.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[11px] text-slate-400">Support Handle</label>
              <input
                type="text"
                value={branding.supportUsername}
                onChange={(e) => setBranding((p) => ({ ...p, supportUsername: e.target.value }))}
                placeholder="@SupportHandle"
                className="w-full rounded-lg border border-slate-700 bg-[#070B14] px-2.5 py-1.5 text-xs text-slate-100"
              />
            </div>
            <div>
              <label className="mb-1 block text-[11px] text-slate-400">Footer Text</label>
              <input
                type="text"
                value={branding.footerText}
                onChange={(e) => setBranding((p) => ({ ...p, footerText: e.target.value }))}
                className="w-full rounded-lg border border-slate-700 bg-[#070B14] px-2.5 py-1.5 text-xs text-slate-100"
              />
            </div>
          </div>
        </div>

        {/* Center: Menu & Button Configurator */}
        <div className="space-y-5 xl:col-span-5">
          <div className="space-y-4 rounded-xl border border-slate-800/80 bg-[#0D1322] p-5">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div>
                <h3 className="font-display text-sm font-semibold text-white">Menu Settings · {activeMenu.menuKey}</h3>
                <p className="text-[11px] text-slate-400">
                  Declarative actions automatically synthesize matching Tenant Admin Panel modules
                </p>
              </div>
              {!activeMenu.isRoot && (
                <button
                  onClick={deleteActiveMenu}
                  className="rounded-md border border-red-500/30 px-2.5 py-1 text-[11px] text-red-400 hover:bg-red-500/10"
                >
                  Delete Menu
                </button>
              )}
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-[11px] text-slate-400">Menu Title</label>
                <input
                  type="text"
                  value={activeMenu.title}
                  onChange={(e) => updateActiveMenu({ title: e.target.value })}
                  className="w-full rounded-lg border border-slate-700 bg-[#070B14] px-3 py-1.5 text-xs text-slate-100"
                />
              </div>
              <div>
                <label className="mb-1 block text-[11px] text-slate-400">Scope & Columns</label>
                <div className="flex gap-2">
                  <select
                    value={activeMenu.scope}
                    onChange={(e) => updateActiveMenu({ scope: e.target.value as 'user' | 'admin' })}
                    className="flex-1 rounded-lg border border-slate-700 bg-[#070B14] px-2 py-1.5 text-xs text-slate-100"
                  >
                    <option value="user">User Menu</option>
                    <option value="admin">Admin Menu</option>
                  </select>
                  <select
                    value={activeMenu.columns}
                    onChange={(e) => updateActiveMenu({ columns: Number(e.target.value) })}
                    className="w-24 rounded-lg border border-slate-700 bg-[#070B14] px-2 py-1.5 text-xs text-slate-100"
                  >
                    <option value={1}>1 col</option>
                    <option value={2}>2 cols</option>
                    <option value={3}>3 cols</option>
                  </select>
                </div>
              </div>
              <div className="sm:col-span-2">
                <label className="mb-1 block text-[11px] text-slate-400">Menu Message Text</label>
                <textarea
                  rows={2}
                  value={activeMenu.messageText}
                  onChange={(e) => updateActiveMenu({ messageText: e.target.value })}
                  className="w-full rounded-lg border border-slate-700 bg-[#070B14] px-3 py-1.5 text-xs text-slate-100"
                />
              </div>
            </div>

            {/* Buttons List */}
            <div className="border-t border-slate-800 pt-4">
              <div className="mb-3 flex items-center justify-between">
                <h4 className="text-xs font-semibold text-white">Buttons ({activeMenu.buttons.length})</h4>
                <button
                  onClick={addButton}
                  className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-500"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add Button
                </button>
              </div>

              <div className="space-y-3">
                {activeMenu.buttons.map((btn, idx) => {
                  const actionKind = getUiActionKind(btn);
                  return (
                    <div key={btn.id} className="space-y-2.5 rounded-lg border border-slate-800 bg-[#070B14] p-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex flex-1 items-center gap-2">
                          <input
                            type="text"
                            value={btn.emoji}
                            onChange={(e) => updateButton(btn.id, { emoji: e.target.value })}
                            placeholder="⚡"
                            className="w-11 rounded border border-slate-700 bg-[#0D1322] px-2 py-1 text-center text-xs text-white"
                          />
                          <input
                            type="text"
                            value={btn.label}
                            onChange={(e) => updateButton(btn.id, { label: e.target.value })}
                            placeholder="Button label"
                            className="flex-1 rounded border border-slate-700 bg-[#0D1322] px-2.5 py-1 text-xs text-white"
                          />
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => moveButton(idx, -1)}
                            disabled={idx === 0}
                            className="rounded p-1 text-slate-400 hover:bg-slate-800 disabled:opacity-30"
                            aria-label="Move up"
                          >
                            <ArrowUp className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => moveButton(idx, 1)}
                            disabled={idx === activeMenu.buttons.length - 1}
                            className="rounded p-1 text-slate-400 hover:bg-slate-800 disabled:opacity-30"
                            aria-label="Move down"
                          >
                            <ArrowDown className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => removeButton(btn.id)}
                            className="rounded p-1 text-red-400 hover:bg-red-500/10"
                            aria-label="Remove button"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>

                      <div className="grid grid-cols-3 gap-2">
                        <select
                          value={btn.style}
                          onChange={(e) => updateButton(btn.id, { style: e.target.value as BuilderButton['style'] })}
                          className="rounded border border-slate-700 bg-[#0D1322] px-2 py-1 text-[11px] text-slate-200"
                        >
                          <option value="success">Green (success)</option>
                          <option value="primary">Blue (primary)</option>
                          <option value="danger">Red (danger)</option>
                        </select>

                        <select
                          value={actionKind}
                          onChange={(e) => handleActionKindChange(btn, e.target.value as ExtendedActionKind)}
                          className="rounded border border-slate-700 bg-[#0D1322] px-2 py-1 text-[11px] text-slate-200"
                        >
                          <option value="submenu">Open Submenu</option>
                          <option value="message">Show Message</option>
                          <option value="info">Info Card</option>
                          <option value="collect_input">Collect Input Form</option>
                          <option value="submit_request">Submit Request</option>
                          <option value="catalogue">Product Catalogue</option>
                          <option value="create_order">Create Order (UPI)</option>
                          <option value="support">Contact Support</option>
                          <option value="url">Open URL</option>
                          <option value="feature">Core Feature</option>
                          <option value="back">Navigate Back</option>
                        </select>

                        <select
                          value={btn.visibility}
                          onChange={(e) => updateButton(btn.id, { visibility: e.target.value as BuilderButton['visibility'] })}
                          className="rounded border border-slate-700 bg-[#0D1322] px-2 py-1 text-[11px] text-slate-200"
                        >
                          <option value="all">Visible: All</option>
                          <option value="users">Users Only</option>
                          <option value="admins">Admins Only</option>
                          <option value="hidden">Hidden</option>
                        </select>
                      </div>

                      <div>
                        {actionKind === 'submenu' || actionKind === 'back' ? (
                          <select
                            value={btn.actionPayload}
                            onChange={(e) => updateButton(btn.id, { actionPayload: e.target.value })}
                            className="w-full rounded border border-slate-700 bg-[#0D1322] px-2.5 py-1 text-[11px] text-slate-200"
                          >
                            {menus.map((m) => (
                              <option key={m.menuKey} value={m.menuKey}>
                                Target Menu: {m.title} ({m.menuKey})
                              </option>
                            ))}
                          </select>
                        ) : actionKind === 'feature' ? (
                          <select
                            value={btn.actionPayload}
                            onChange={(e) => updateButton(btn.id, { actionPayload: e.target.value })}
                            className="w-full rounded border border-slate-700 bg-[#0D1322] px-2.5 py-1 text-[11px] text-slate-200"
                          >
                            <option value="user_profile">Feature: User Profile</option>
                            <option value="bot_stats">Feature: Bot Statistics (Admin)</option>
                            <option value="referral_link">Feature: Referral Link</option>
                            <option value="support_contact">Feature: Support Contact</option>
                            <option value="help_overview">Feature: Help Overview</option>
                          </select>
                        ) : actionKind === 'collect_input' ? (
                          <input
                            type="text"
                            value={stripPrefix(btn.actionPayload, 'form:')}
                            onChange={(e) => updateButton(btn.id, { actionType: 'feature', actionPayload: `form:${e.target.value}` })}
                            placeholder="Prompt shown to user before saving to form_submissions..."
                            className="w-full rounded border border-slate-700 bg-[#0D1322] px-2.5 py-1 text-[11px] text-slate-200"
                          />
                        ) : actionKind === 'submit_request' ? (
                          <input
                            type="text"
                            value={stripPrefix(btn.actionPayload, 'submit_request:')}
                            onChange={(e) =>
                              updateButton(btn.id, { actionType: 'feature', actionPayload: `submit_request:${e.target.value}` })
                            }
                            placeholder="Request prompt shown to user..."
                            className="w-full rounded border border-slate-700 bg-[#0D1322] px-2.5 py-1 text-[11px] text-slate-200"
                          />
                        ) : actionKind === 'info' ? (
                          <input
                            type="text"
                            value={stripPrefix(btn.actionPayload, 'info:')}
                            onChange={(e) => updateButton(btn.id, { actionType: 'feature', actionPayload: `info:${e.target.value}` })}
                            placeholder="Info card text..."
                            className="w-full rounded border border-slate-700 bg-[#0D1322] px-2.5 py-1 text-[11px] text-slate-200"
                          />
                        ) : actionKind === 'catalogue' || actionKind === 'create_order' ? (
                          <input
                            type="text"
                            value={stripPrefix(btn.actionPayload, `${actionKind}:`)}
                            onChange={(e) =>
                              updateButton(btn.id, {
                                actionType: 'feature',
                                actionPayload: `${actionKind}:${e.target.value || 'all'}`,
                              })
                            }
                            placeholder="Category filter (e.g. all, templates, ebooks)"
                            className="w-full rounded border border-slate-700 bg-[#0D1322] px-2.5 py-1 text-[11px] text-slate-200"
                          />
                        ) : (
                          <input
                            type="text"
                            value={btn.actionPayload}
                            onChange={(e) => updateButton(btn.id, { actionPayload: e.target.value })}
                            placeholder={actionKind === 'url' ? 'https://example.com' : 'Message content...'}
                            className="w-full rounded border border-slate-700 bg-[#0D1322] px-2.5 py-1 text-[11px] text-slate-200"
                          />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* Right: Exact Telegram Keyboard Preview + Dynamic Admin Panel Preview */}
        <div className="space-y-5 xl:col-span-4">
          <div className="rounded-xl border border-slate-800/80 bg-[#0D1322] p-5">
            <div className="mb-4 flex items-center justify-between border-b border-slate-800 pb-3">
              <div>
                <h3 className="font-display text-sm font-semibold text-white">Keyboard Layout Preview</h3>
                <p className="text-[11px] text-slate-400">
                  Compiled Telegram <code className="text-slate-300">reply_markup</code>
                </p>
              </div>
              <button
                onClick={() => setPreviewAsAdmin((v) => !v)}
                className="rounded-md border border-slate-700 px-2.5 py-1 text-[11px] text-slate-300 hover:bg-slate-800"
              >
                View: {previewAsAdmin ? 'Admin' : 'User'}
              </button>
            </div>

            <div className="rounded-xl border border-slate-800 bg-[#070B14] p-4">
              <div className="text-xs font-semibold text-white">⚡ {branding.brandTitle || 'My Custom Bot'}</div>
              <div className="mt-0.5 text-xs font-medium text-slate-300">{activeMenu.title}</div>
              <div className="my-2 font-mono text-[10px] text-slate-600">━━━━━━━━━━━━━━━━━━━━</div>
              <p className="whitespace-pre-wrap text-xs leading-relaxed text-slate-300">{activeMenu.messageText}</p>
              {(branding.footerText || branding.supportUsername) && (
                <div className="mt-3 border-t border-slate-800/80 pt-2 text-[11px] text-slate-500">
                  {branding.footerText} {branding.supportUsername && `· Support: ${branding.supportUsername}`}
                </div>
              )}

              <div className="mt-4 space-y-2">
                {previewRows.map((row, rIdx) => (
                  <div
                    key={rIdx}
                    style={{ gridTemplateColumns: `repeat(${row.length}, minmax(0, 1fr))` }}
                    className="grid gap-2"
                  >
                    {row.map((btn) => (
                      <button
                        key={btn.id}
                        type="button"
                        onClick={() => {
                          if (
                            (btn.actionType === 'submenu' || btn.actionType === 'back') &&
                            menus.some((m) => m.menuKey === btn.actionPayload)
                          ) {
                            setActiveMenuKey(btn.actionPayload);
                          }
                        }}
                        className={`truncate rounded-lg border px-3 py-2 text-center text-xs font-medium transition-opacity hover:opacity-90 ${TELEGRAM_STYLE_CLASSES[btn.style]}`}
                        title={`Telegram style: "${btn.style}" | Action: ${getUiActionKind(btn)}`}
                      >
                        {btn.emoji ? `${btn.emoji} ` : ''}
                        {btn.label}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Live Dynamic Admin Panel Preview */}
          <div className="rounded-xl border border-slate-800/80 bg-[#0D1322] p-5">
            <div className="mb-3 flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <Shield className="h-4 w-4 text-emerald-400" />
                <div>
                  <h3 className="font-display text-sm font-semibold text-white">Auto-Generated Admin Panel</h3>
                  <p className="text-[11px] text-slate-400">
                    Native ReplyKeyboard modules synthesized from your buttons
                  </p>
                </div>
              </div>
              <span className="font-mono text-[11px] text-emerald-400 tabular-nums">
                {dynamicAdminModules.length} modules
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2">
              {dynamicAdminModules.map((mod) => (
                <div
                  key={mod.label}
                  title={mod.reason}
                  className={`rounded-lg border px-2.5 py-2 text-xs font-medium ${TELEGRAM_STYLE_CLASSES[mod.style]}`}
                >
                  <div className="truncate">{mod.label}</div>
                  <div className="mt-0.5 truncate text-[10px] opacity-80">{mod.reason}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
