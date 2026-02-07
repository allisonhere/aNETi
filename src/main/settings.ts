import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type ProviderId = 'openai' | 'gemini' | 'claude';

export type AlertSettings = {
  osNotifications: boolean;
  unknownOnly: boolean;
  mutedDeviceIds: string[];
};

type SettingsFile = {
  providers: Partial<Record<ProviderId, string>>;
  accentId?: string | null;
  alerts?: AlertSettings;
  updatedAt: number;
};

export type SettingsPublic = {
  providers: Record<ProviderId, { hasKey: boolean; last4: string | null }>;
  accentId?: string | null;
  alerts: AlertSettings;
  updatedAt: number;
};

const defaultAlerts = (): AlertSettings => ({
  osNotifications: true,
  unknownOnly: true,
  mutedDeviceIds: [],
});

const normalizeAlerts = (alerts?: Partial<AlertSettings> | null): AlertSettings => ({
  osNotifications: alerts?.osNotifications ?? true,
  unknownOnly: alerts?.unknownOnly ?? true,
  mutedDeviceIds: Array.isArray(alerts?.mutedDeviceIds)
    ? alerts?.mutedDeviceIds
        .map((id) => String(id).trim())
        .filter(Boolean)
    : [],
});

const defaultSettings = (): SettingsFile => ({
  providers: {},
  accentId: null,
  alerts: defaultAlerts(),
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

  return {
    providers: {
      openai: toMeta(providers.openai),
      gemini: toMeta(providers.gemini),
      claude: toMeta(providers.claude),
    },
    accentId: settings.accentId ?? null,
    alerts: normalizeAlerts(settings.alerts),
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

  const updateAlerts = (patch: Partial<Pick<AlertSettings, 'osNotifications' | 'unknownOnly'>>) => {
    const settings = load();
    const current = normalizeAlerts(settings.alerts);
    settings.alerts = {
      ...current,
      ...patch,
      mutedDeviceIds: current.mutedDeviceIds,
    };
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

  const getSecret = (provider: ProviderId) => load().providers[provider];

  return {
    getPublic,
    updateProvider,
    updateAccent,
    updateAlerts,
    setDeviceMuted,
    getAlerts,
    getSecret,
  };
};
