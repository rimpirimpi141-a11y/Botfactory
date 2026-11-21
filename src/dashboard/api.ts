/**
 * Typed Cloudflare Worker REST API Client for BOT FACTORY Control Plane.
 * Never embeds secrets in frontend code — credentials are supplied at runtime by the platform owner.
 */

export interface WorkerConnection {
  workerUrl: string;
  adminApiKey: string;
}

export interface HealthResponse {
  service: string;
  tagline: string;
  status: 'operational' | 'setup_required';
  timestamp: string;
  workerPublicUrl?: string;
  expectedMasterWebhookUrl?: string;
  masterBotDeepLink: string | null;
  bindings: {
    d1: {
      healthy: boolean;
      upgrade0003Applied?: boolean;
      tableCount?: number;
      missingTables?: string[];
      missingUpgradeTables?: string[];
      seededTemplates?: number;
      latencyMs?: number;
      error?: string;
    };
    kv: boolean;
    analyticsEngine: boolean;
    masterBotConfigured: boolean;
    masterWebhookSecretConfigured?: boolean;
    encryptionKeyConfigured: boolean;
    ownerIdConfigured: boolean;
    adminApiKeyConfigured: boolean;
    cloudflareMetricsConfigured: boolean;
  };
}

export interface MasterWebhookTelegramInfo {
  url: string;
  has_custom_certificate: boolean;
  pending_update_count: number;
  ip_address: string | null;
  last_error_date: number | null;
  last_error_message: string | null;
  last_synchronization_error_date: number | null;
  max_connections: number;
  allowed_updates: string[];
}

export interface MasterWebhookTelegramResponse {
  ok?: boolean;
  setWebhookOk?: boolean;
  setWebhookDescription?: string;
  webhookInfo?: MasterWebhookTelegramInfo;
}

export interface MasterWebhookStatusResponse {
  ok: boolean;
  configuration: {
    masterBotTokenConfigured: boolean;
    masterWebhookSecretConfigured: boolean;
    readyForRegistration: boolean;
    masterBotUsername: string | null;
    workerPublicUrl: string;
    expectedWebhookUrl: string;
    allowedUpdates: string[];
  };
  webhook: {
    status: 'verified' | 'mismatch' | 'not_registered' | 'failed' | string;
    verified: boolean;
    lastRegisteredAt: string | null;
    lastVerifiedAt: string | null;
    lastError: string | null;
    telegramResponse: MasterWebhookTelegramResponse | null;
  };
}

export interface MasterWebhookActionResponse {
  ok: boolean;
  verified: boolean;
  status: 'verified' | 'mismatch' | 'not_registered' | 'failed' | 'configuration_missing' | string;
  workerPublicUrl: string;
  expectedWebhookUrl: string;
  lastRegisteredAt: string | null;
  lastVerifiedAt: string | null;
  error?: string | null;
  bot?: {
    id: number;
    username: string;
    first_name: string;
  };
  verification?: {
    verified: boolean;
    status: string;
    webhookUrl?: string;
    actualUrl?: string;
    expectedUrl: string;
    allowedUpdates: string[];
    pendingUpdateCount: number;
    lastErrorMessage: string | null;
    lastErrorDate: number | null;
    maxConnections: number;
    verifiedAt?: string;
    checkedAt?: string;
    telegramResponse?: MasterWebhookTelegramResponse;
  };
}

export interface PlatformOverview {
  totalUsers: number;
  activeUsers?: number;
  premiumUsers: number;
  freeUsers?: number;
  starterUsers?: number;
  proUsers?: number;
  enterpriseUsers?: number;
  totalReferrals?: number;
  verifiedReferrals?: number;
  pendingReferrals?: number;
  totalBots: number;
  activeBots: number;
  disabledBots: number;
  failedDeployments: number;
  botsCreatedToday?: number;
  botsCreatedThisMonth?: number;
  totalWebhookUpdates: number;
  requestsToday: number;
  requestsThisMonth: number;
  workerErrors: number;
  avgResponseTimeMs: number | null;
  totalTransactions: number;
  dailySeries: Array<{ stat_date: string; requests: number; errors: number }>;
  lastUpdated: string;
}

export interface BotRecord {
  id: string;
  owner_telegram_id: string;
  telegram_bot_id: string;
  telegram_username: string;
  display_name: string;
  description: string;
  webhook_url: string | null;
  webhook_status: 'pending' | 'registered' | 'verified' | 'failed' | 'disabled';
  webhook_last_verified_at: string | null;
  webhook_last_error: string | null;
  template_id: string;
  template_slug?: string;
  template_name?: string;
  mode: 'template' | 'custom';
  status: 'deploying' | 'active' | 'disabled' | 'failed' | 'deleted';
  plan: string;
  total_updates: number;
  total_users: number;
  created_at: string;
  updated_at: string;
}

export interface TemplateStudioRecord {
  id: string;
  slug: string;
  name: string;
  category: string;
  description: string;
  required_plan: string;
  is_active: number;
  is_coming_soon: number;
  availability_status: 'active' | 'disabled' | 'maintenance' | 'coming_soon' | string;
}

export interface BuilderButton {
  id: string;
  label: string;
  emoji: string;
  buttonType?: 'callback' | 'url' | 'reply';
  actionType: 'submenu' | 'message' | 'url' | 'feature' | 'back' | 'support';
  actionPayload: string;
  row: number;
  col: number;
  position: number;
  visibility: 'all' | 'users' | 'admins' | 'hidden';
  style: 'primary' | 'success' | 'danger' | 'default';
}

export interface BuilderMenu {
  id?: string;
  menuKey: string;
  parentMenuKey: string | null;
  title: string;
  messageText: string;
  imageUrl: string | null;
  scope: 'user' | 'admin';
  keyboardType: 'inline' | 'reply';
  columns: number;
  isRoot: boolean;
  buttons: BuilderButton[];
}

export interface BotBrandingConfig {
  brandTitle: string;
  welcomeMessage: string;
  welcomeImageUrl: string | null;
  logoUrl: string | null;
  footerText: string;
  supportUsername: string;
  themeId: string;
}

export interface BroadcastRecord {
  id: string;
  scope: 'global' | 'single_bot' | 'bot_group' | 'selected_users';
  target_bot_ids: string[];
  target_user_ids: string[];
  message_text: string;
  image_url: string | null;
  inline_buttons: Array<{ text: string; url: string; style: 'primary' | 'success' | 'danger' | 'default' }>;
  include_promo_footer: boolean;
  status: 'draft' | 'queued' | 'running' | 'paused' | 'completed' | 'cancelled' | 'failed';
  total_recipients: number;
  delivered_count: number;
  failed_count: number;
  blocked_count: number;
  created_at: string;
  completed_at: string | null;
}

export interface CloudflareMetricsPayload {
  configured: boolean;
  status: 'connected' | 'unavailable';
  message?: string;
  lastUpdated: string;
  applicationHealth?: {
    status: 'healthy' | 'degraded';
    checkedAt?: string;
    worker?: {
      healthy: boolean;
      scriptName: string;
      publicUrl: string;
    };
    d1: {
      bound: boolean;
      healthy: boolean;
      latencyMs: number | null;
      tableCount: number | null;
      seededTemplates?: number;
      upgrade0003Applied?: boolean;
      error?: string | null;
    };
    kv: {
      bound: boolean;
      healthy: boolean;
      latencyMs: number | null;
      detail?: string | null;
      error?: string | null;
    };
    analyticsEngine: {
      bound: boolean;
      status: string;
    };
  };
  accountMetrics?: {
    configured: boolean;
    status: 'connected' | 'not_configured';
    message: string;
  };
  applicationCounters: {
    source: string;
    requestsToday: number;
    requestsThisMonth: number;
    workerErrors: number;
    avgResponseTimeMs: number | null;
    totalWebhookUpdates: number;
  };
  workers: {
    status: 'available' | 'unavailable';
    error?: string | null;
    data: null | {
      scriptName: string;
      dailyRequests: number;
      monthlyRequests: number;
      errors: number;
      successPercentage: number | null;
      cpuTimeP50Us: number | null;
      responseDurationP50Ms: number | null;
    };
  };
  d1: {
    status: 'available' | 'unavailable';
    error?: string | null;
    data: null | {
      databaseId: string | null;
      databaseSizeBytes: number | null;
      readQueries: number;
      writeQueries: number;
      totalQueries: number;
      rowsRead: number;
      rowsWritten: number;
    };
  };
  kv: {
    status: 'available' | 'unavailable';
    error?: string | null;
    data: null | {
      namespaceId: string | null;
      reads: number;
      writes: number;
      storageBytes: number | null;
      keyCount: number | null;
    };
  };
  analyticsEngine: {
    bound: boolean;
    status: string;
  };
}

export interface UserEntitlement {
  plan: string;
  planLabel: string;
  verifiedReferrals: number;
  pendingReferrals: number;
  bonusBotSlots: number;
  maxBots: number | null;
  maxBotsLabel: string;
  activeBotCount: number;
  remainingSlots: number | null;
  isUnlimited: boolean;
  canCreateBot: boolean;
}

export interface UserRecord {
  id: string;
  telegram_id: string;
  username: string | null;
  first_name: string | null;
  role: string;
  plan: string;
  status: string;
  referral_code?: string | null;
  verified_referrals?: number;
  bonus_bot_slots?: number;
  bot_count: number;
  entitlement?: UserEntitlement;
  last_active_at: string | null;
  created_at: string;
}

export interface PlatformReferralRecord {
  id: string;
  referrer_telegram_id: string;
  referred_telegram_id: string;
  referral_code: string;
  status: 'verified' | 'pending' | 'flagged' | 'rejected';
  rejection_reason?: string | null;
  referrer_username?: string | null;
  referred_username?: string | null;
  created_at: string;
  verified_at?: string | null;
}

export interface PlatformAdminRecord {
  id: string;
  telegram_id: string;
  username: string | null;
  role: 'super_admin' | 'admin';
  permissions: Record<string, boolean> | string[];
  status: string;
  added_by: string | null;
  created_at: string;
}

export interface DeploymentLogRecord {
  id: string;
  bot_id: string | null;
  owner_telegram_id: string;
  template_slug: string | null;
  stage: string;
  status: string;
  detail: string | null;
  created_at: string;
}

export interface SystemLogRecord {
  id: string;
  level: 'info' | 'warn' | 'error' | 'security' | 'audit';
  source: string;
  message: string;
  metadata: Record<string, unknown>;
  actor_telegram_id: string | null;
  created_at: string;
}

const STORAGE_URL_KEY = 'bf_worker_url';
const SESSION_API_KEY = 'bf_admin_api_key';

export function loadSavedConnection(): WorkerConnection {
  const defaultUrl = (import.meta.env.VITE_WORKER_URL || '').trim();
  const savedUrl = typeof window !== 'undefined' ? window.localStorage.getItem(STORAGE_URL_KEY) : null;
  const savedKey = typeof window !== 'undefined' ? window.sessionStorage.getItem(SESSION_API_KEY) : null;
  const candidateUrl = (savedUrl ?? defaultUrl).replace(/\/+$/, '');
  const cleanUrl = candidateUrl.includes('YOUR-SUBDOMAIN') ? '' : candidateUrl;
  return {
    workerUrl: cleanUrl,
    adminApiKey: savedKey || '',
  };
}

export function saveConnection(conn: WorkerConnection) {
  const cleanUrl = conn.workerUrl.trim().replace(/\/+$/, '');
  window.localStorage.setItem(STORAGE_URL_KEY, cleanUrl);
  if (conn.adminApiKey.trim()) {
    window.sessionStorage.setItem(SESSION_API_KEY, conn.adminApiKey.trim());
  } else {
    window.sessionStorage.removeItem(SESSION_API_KEY);
  }
}

export function createWorkerApi(conn: WorkerConnection) {
  const baseUrl = conn.workerUrl.trim().replace(/\/+$/, '');

  async function request<T>(path: string, options: RequestInit = {}, requireAuth = true): Promise<T> {
    if (!baseUrl) {
      throw new Error('Cloudflare Worker URL is not configured. Click "Connect Worker" to link your deployment.');
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> | undefined),
    };

    if (requireAuth) {
      if (!conn.adminApiKey.trim()) {
        throw new Error('Admin API Key is required for control plane operations. Configure it in "Connect Worker".');
      }
      headers.Authorization = `Bearer ${conn.adminApiKey.trim()}`;
    }

    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, { ...options, headers });
    } catch {
      throw new Error(`Unable to reach Cloudflare Worker at ${baseUrl}. Verify URL, HTTPS, and CORS settings.`);
    }

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(body?.error || `Worker request failed with HTTP ${res.status}`);
    }
    return body as T;
  }

  return {
    isConfigured: Boolean(baseUrl),
    hasAuth: Boolean(baseUrl && conn.adminApiKey.trim()),
    health: () => request<HealthResponse>('/api/health', { method: 'GET' }, false),
    getMasterWebhookStatus: (live = false) =>
      request<MasterWebhookStatusResponse>(`/api/master/webhook-status${live ? '?live=true' : ''}`, { method: 'GET' }),
    registerMasterWebhook: () =>
      request<MasterWebhookActionResponse>('/api/master/register-webhook', { method: 'POST' }),
    verifyMasterWebhook: () =>
      request<MasterWebhookActionResponse>('/api/master/verify-webhook', { method: 'POST' }),
    getOverview: () =>
      request<{
        ok: boolean;
        analytics: {
          overview: PlatformOverview;
          uniqueActiveUsers30d: number;
          topBots: BotRecord[];
          featureBreakdown: Array<{ feature: string; count: number }>;
          lastUpdated: string;
        };
        settings: Record<string, string>;
        masterBotDeepLink: string | null;
      }>('/api/dashboard/overview'),
    getAllTemplates: () =>
      request<{ ok: boolean; templates: TemplateStudioRecord[] }>('/api/templates/all'),
    updateTemplate: (id: string, payload: { availabilityStatus?: string; isActive?: boolean; description?: string }) =>
      request<{ ok: boolean; template: TemplateStudioRecord }>(`/api/templates/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    listBots: (params?: { q?: string; status?: string }) => {
      const qs = new URLSearchParams();
      if (params?.q) qs.set('q', params.q);
      if (params?.status) qs.set('status', params.status);
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      return request<{ ok: boolean; bots: BotRecord[] }>(`/api/bots${suffix}`);
    },
    validateToken: (token: string) =>
      request<{
        ok: boolean;
        bot: { telegramBotId: string; telegramUsername: string; telegramFirstName: string };
      }>('/api/bots/validate-token', {
        method: 'POST',
        body: JSON.stringify({ token }),
      }),
    deployBot: (payload: {
      token: string;
      templateId: string;
      mode: 'template' | 'custom';
      displayName: string;
      description: string;
      branding: BotBrandingConfig;
      customMenus?: BuilderMenu[];
      templateConfig?: Record<string, unknown>;
    }) =>
      request<{
        ok: boolean;
        bot: BotRecord;
        verification: { verified: boolean; webhookUrl: string };
        stages: Array<{ stage: string; detail: string; at: string }>;
      }>('/api/bots/deploy', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    disableBot: (botId: string) => request<{ ok: boolean; bot: BotRecord }>(`/api/bots/${botId}/disable`, { method: 'POST' }),
    enableBot: (botId: string) =>
      request<{ ok: boolean; bot: BotRecord; verification: { webhookUrl: string } }>(`/api/bots/${botId}/enable`, {
        method: 'POST',
      }),
    deleteBot: (botId: string) => request<{ ok: boolean; deleted: boolean }>(`/api/bots/${botId}`, { method: 'DELETE' }),
    getBuilder: (botId: string) =>
      request<{ ok: boolean; botId: string; config: BotBrandingConfig; menus: BuilderMenu[] }>(`/api/builder/${botId}`),
    saveBuilder: (botId: string, payload: { config: BotBrandingConfig; menus: BuilderMenu[] }) =>
      request<{ ok: boolean; config: BotBrandingConfig; menus: BuilderMenu[] }>(`/api/builder/${botId}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      }),
    listBroadcasts: () =>
      request<{ ok: boolean; broadcasts: BroadcastRecord[]; masterBotDeepLink: string | null }>('/api/broadcasts'),
    createBroadcast: (payload: {
      scope: string;
      targetBotIds?: string[];
      targetUserIds?: string[];
      messageText: string;
      imageUrl?: string | null;
      inlineButtons?: Array<{ text: string; url: string; style: string }>;
      includePromoFooter: boolean;
    }) =>
      request<{ ok: boolean; broadcast: BroadcastRecord }>('/api/broadcasts', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    launchBroadcast: (id: string) =>
      request<{ ok: boolean; broadcast: BroadcastRecord; batch: Record<string, unknown> }>(
        `/api/broadcasts/${id}/launch`,
        { method: 'POST' }
      ),
    stepBroadcast: (id: string) =>
      request<{ ok: boolean; broadcast: BroadcastRecord; batch: Record<string, unknown> }>(
        `/api/broadcasts/${id}/step`,
        { method: 'POST' }
      ),
    updateBroadcastStatus: (id: string, status: 'paused' | 'running' | 'cancelled') =>
      request<{ ok: boolean; broadcast: BroadcastRecord }>(`/api/broadcasts/${id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      }),
    getCloudflareMetrics: () =>
      request<{ ok: boolean; metrics: CloudflareMetricsPayload }>('/api/cloudflare/metrics'),
    listUsers: (q = '') =>
      request<{ ok: boolean; users: UserRecord[] }>(`/api/users${q ? `?q=${encodeURIComponent(q)}` : ''}`),
    getUserDetail: (telegramId: string) =>
      request<{
        ok: boolean;
        user: UserRecord;
        entitlement: UserEntitlement;
        bots: BotRecord[];
        referrals: PlatformReferralRecord[];
        recentActivity: SystemLogRecord[];
      }>(`/api/users/${encodeURIComponent(telegramId)}`),
    updateUser: (telegramId: string, payload: { plan?: string; suspend?: boolean; bonusBotSlots?: number }) =>
      request<{ ok: boolean; user: UserRecord }>(`/api/users/${telegramId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    listReferrals: (status = '') =>
      request<{ ok: boolean; referrals: PlatformReferralRecord[] }>(
        `/api/referrals${status ? `?status=${encodeURIComponent(status)}` : ''}`
      ),
    updateReferral: (id: string, payload: { status: 'verified' | 'pending' | 'flagged' | 'rejected'; reason?: string }) =>
      request<{ ok: boolean; referral: PlatformReferralRecord }>(`/api/referrals/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    listPlatformAdmins: () =>
      request<{ ok: boolean; admins: PlatformAdminRecord[] }>('/api/platform-admins'),
    addPlatformAdmin: (payload: { telegramId: string; username?: string }) =>
      request<{ ok: boolean; admin: PlatformAdminRecord }>('/api/platform-admins', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    removePlatformAdmin: (telegramId: string) =>
      request<{ ok: boolean; removed: boolean }>(`/api/platform-admins/${telegramId}`, {
        method: 'DELETE',
      }),
    listDeployments: () =>
      request<{ ok: boolean; deployments: DeploymentLogRecord[] }>('/api/deployments'),
    verifyForceJoin: (channel: string) =>
      request<{ ok: boolean; channel: string; botIsAdmin: boolean; status: string; error?: string }>(
        '/api/force-join/verify',
        { method: 'POST', body: JSON.stringify({ channel }) }
      ),
    listLogs: (level = '') =>
      request<{ ok: boolean; logs: SystemLogRecord[] }>(`/api/logs${level ? `?level=${encodeURIComponent(level)}` : ''}`),
    getSettings: () => request<{ ok: boolean; settings: Record<string, string> }>('/api/settings'),
    saveSettings: (settings: Record<string, string>) =>
      request<{ ok: boolean; settings: Record<string, string> }>('/api/settings', {
        method: 'PUT',
        body: JSON.stringify(settings),
      }),
  };
}
