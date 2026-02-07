import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type ProviderId = 'openai' | 'gemini' | 'claude';

type SettingsFile = {
  providers: Partial<Record<ProviderId, string>>;
  updatedAt: number;
};

export type SettingsPublic = {
  providers: Record<ProviderId, { hasKey: boolean; last4: string | null }>;
  updatedAt: number;
};

const defaultSettings = (): SettingsFile => ({
  providers: {},
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

  const getSecret = (provider: ProviderId) => load().providers[provider];

  return {
    getPublic,
    updateProvider,
    getSecret,
  };
};
