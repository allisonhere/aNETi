import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export type ProviderId = 'openai' | 'gemini' | 'claude';

export type AlertSettings = {
  osNotifications: boolean;
  unknownOnly: boolean;
  startupWarmupMs: number;
  globalCooldownMs: number;
  perDeviceCooldownMs: number;
  mutedDeviceIds: string[];
};

export type SecuritySettings = {
  trustedDeviceIds: string[];
};

export type IntegrationSettings = {
  apiEnabled: boolean;
  apiPort: number;
  apiToken?: string;
};

type SettingsFile = {
  providers: Partial<Record<ProviderId, string>>;
  accentId?: string | null;
  alerts?: AlertSettings;
  security?: SecuritySettings;
  integration?: IntegrationSettings;
  updatedAt: number;
};

export type SettingsPublic = {
  providers: Record<ProviderId, { hasKey: boolean; last4: string | null }>;
  accentId?: string | null;
  alerts: AlertSettings;
  security: SecuritySettings;
  integration: {
    apiEnabled: boolean;
    apiPort: number;
    hasApiToken: boolean;
    tokenLast4: string | null;
  };
  updatedAt: number;
};

const defaultAlerts = (): AlertSettings => ({
  osNotifications: true,
  unknownOnly: true,
  startupWarmupMs: 45_000,
  globalCooldownMs: 20_000,
  perDeviceCooldownMs: 60_000,
  mutedDeviceIds: [],
});

const defaultSecurity = (): SecuritySettings => ({
  trustedDeviceIds: [],
});

const defaultIntegration = (): IntegrationSettings => ({
  apiEnabled: true,
  apiPort: 8787,
  apiToken: undefined,
});

const normalizeAlerts = (alerts?: Partial<AlertSettings> | null): AlertSettings => ({
  osNotifications: alerts?.osNotifications ?? true,
  unknownOnly: alerts?.unknownOnly ?? true,
  startupWarmupMs:
    typeof alerts?.startupWarmupMs === 'number'
      ? Math.min(Math.max(Math.round(alerts.startupWarmupMs), 0), 300_000)
      : 45_000,
  globalCooldownMs:
    typeof alerts?.globalCooldownMs === 'number'
      ? Math.min(Math.max(Math.round(alerts.globalCooldownMs), 5_000), 300_000)
      : 20_000,
  perDeviceCooldownMs:
    typeof alerts?.perDeviceCooldownMs === 'number'
      ? Math.min(Math.max(Math.round(alerts.perDeviceCooldownMs), 5_000), 600_000)
      : 60_000,
  mutedDeviceIds: Array.isArray(alerts?.mutedDeviceIds)
    ? alerts?.mutedDeviceIds
        .map((id) => String(id).trim())
        .filter(Boolean)
    : [],
});

const normalizeSecurity = (security?: Partial<SecuritySettings> | null): SecuritySettings => ({
  trustedDeviceIds: Array.isArray(security?.trustedDeviceIds)
    ? security?.trustedDeviceIds
        .map((id) => String(id).trim())
        .filter(Boolean)
    : [],
});

const normalizeIntegration = (integration?: Partial<IntegrationSettings> | null): IntegrationSettings => ({
  apiEnabled: integration?.apiEnabled ?? true,
  apiPort:
    typeof integration?.apiPort === 'number'
      ? Math.min(Math.max(Math.round(integration.apiPort), 1024), 65535)
      : 8787,
  apiToken:
    integration?.apiToken && String(integration.apiToken).trim().length > 0
      ? String(integration.apiToken).trim()
      : undefined,
});

const createApiToken = () => `aneti_${randomBytes(24).toString('hex')}`;

const defaultSettings = (): SettingsFile => ({
  providers: {},
  accentId: null,
  alerts: defaultAlerts(),
  security: defaultSecurity(),
  integration: defaultIntegration(),
  updatedAt: Date.now(),
});

const scrubSettings = (settings: SettingsFile): SettingsPublic => {
  const providers = {
    openai: settings.providers.openai,
    gemini: settings.providers.gemini,
    claude: settings.providers.claude,
  };

  const toMeta = (value?: string) => ({
    hasKey: Boolean(value && value.trim()),
    last4: value ? value.trim().slice(-4) : null,
  });

  const integration = normalizeIntegration(settings.integration);

  return {
    providers: {
      openai: toMeta(providers.openai),
      gemini: toMeta(providers.gemini),
      claude: toMeta(providers.claude),
    },
    accentId: settings.accentId ?? null,
    alerts: normalizeAlerts(settings.alerts),
    security: normalizeSecurity(settings.security),
    integration: {
      apiEnabled: integration.apiEnabled,
      apiPort: integration.apiPort,
      hasApiToken: Boolean(integration.apiToken),
      tokenLast4: integration.apiToken?.slice(-4) ?? null,
    },
    updatedAt: settings.updatedAt,
  };
};

export const createSettingsStore = (filePath: string) => {
  let cache: SettingsFile | null = null;

  const load = (): SettingsFile => {
    if (cache) return cache;
    if (!existsSync(filePath)) {
      cache = defaultSettings();
      return cache;
    }
    try {
      const raw = readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as SettingsFile;
      cache = {
        providers: parsed.providers ?? {},
        accentId: parsed.accentId ?? null,
        alerts: normalizeAlerts(parsed.alerts),
        security: normalizeSecurity(parsed.security),
        integration: normalizeIntegration(parsed.integration),
        updatedAt: parsed.updatedAt ?? Date.now(),
      };
      return cache;
    } catch {
      cache = defaultSettings();
      return cache;
    }
  };

  const persist = (settings: SettingsFile) => {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(filePath, JSON.stringify(settings, null, 2), 'utf8');
  };

  const getPublic = (): SettingsPublic => scrubSettings(load());

  const updateProvider = (provider: ProviderId, key: string | null) => {
    const settings = load();
    if (!key || key.trim().length === 0) {
      delete settings.providers[provider];
    } else {
      settings.providers[provider] = key.trim();
    }
    settings.updatedAt = Date.now();
    cache = settings;
    persist(settings);
    return scrubSettings(settings);
  };

  const updateAccent = (accentId: string | null) => {
    const settings = load();
    const normalized = accentId && accentId.trim().length > 0 ? accentId.trim() : null;
    settings.accentId = normalized;
    settings.updatedAt = Date.now();
    cache = settings;
    persist(settings);
    return scrubSettings(settings);
  };

  const updateAlerts = (
    patch: Partial<
      Pick<
        AlertSettings,
        'osNotifications' | 'unknownOnly' | 'startupWarmupMs' | 'globalCooldownMs' | 'perDeviceCooldownMs'
      >
    >
  ) => {
    const settings = load();
    const current = normalizeAlerts(settings.alerts);
    settings.alerts = normalizeAlerts({
      ...current,
      ...patch,
      mutedDeviceIds: current.mutedDeviceIds,
    });
    settings.updatedAt = Date.now();
    cache = settings;
    persist(settings);
    return scrubSettings(settings);
  };

  const setDeviceMuted = (deviceId: string, muted: boolean) => {
    const id = deviceId.trim();
    if (!id) return scrubSettings(load());

    const settings = load();
    const current = normalizeAlerts(settings.alerts);
    const mutedIds = new Set(current.mutedDeviceIds);
    if (muted) {
      mutedIds.add(id);
    } else {
      mutedIds.delete(id);
    }
    settings.alerts = {
      ...current,
      mutedDeviceIds: Array.from(mutedIds),
    };
    settings.updatedAt = Date.now();
    cache = settings;
    persist(settings);
    return scrubSettings(settings);
  };

  const getAlerts = () => normalizeAlerts(load().alerts);

  const setDeviceTrusted = (deviceId: string, trusted: boolean) => {
    const id = deviceId.trim();
    if (!id) return scrubSettings(load());

    const settings = load();
    const current = normalizeSecurity(settings.security);
    const trustedIds = new Set(current.trustedDeviceIds);
    if (trusted) {
      trustedIds.add(id);
    } else {
      trustedIds.delete(id);
    }
    settings.security = {
      trustedDeviceIds: Array.from(trustedIds),
    };
    settings.updatedAt = Date.now();
    cache = settings;
    persist(settings);
    return scrubSettings(settings);
  };

  const getSecurity = () => normalizeSecurity(load().security);

  const updateIntegration = (patch: Partial<Pick<IntegrationSettings, 'apiEnabled' | 'apiPort'>>) => {
    const settings = load();
    const current = normalizeIntegration(settings.integration);
    settings.integration = normalizeIntegration({
      ...current,
      ...patch,
      apiToken: current.apiToken,
    });
    settings.updatedAt = Date.now();
    cache = settings;
    persist(settings);
    return scrubSettings(settings);
  };

  const ensureApiToken = () => {
    const settings = load();
    const current = normalizeIntegration(settings.integration);
    if (current.apiToken) return current.apiToken;
    current.apiToken = createApiToken();
    settings.integration = current;
    settings.updatedAt = Date.now();
    cache = settings;
    persist(settings);
    return current.apiToken;
  };

  const rotateApiToken = () => {
    const settings = load();
    const current = normalizeIntegration(settings.integration);
    current.apiToken = createApiToken();
    settings.integration = current;
    settings.updatedAt = Date.now();
    cache = settings;
    persist(settings);
    return current.apiToken;
  };

  const getIntegration = () => normalizeIntegration(load().integration);

  const getSecret = (provider: ProviderId) => load().providers[provider];

  return {
    getPublic,
    updateProvider,
    updateAccent,
    updateAlerts,
    setDeviceMuted,
    getAlerts,
    setDeviceTrusted,
    getSecurity,
    updateIntegration,
    ensureApiToken,
    rotateApiToken,
    getIntegration,
    getSecret,
  };
};
