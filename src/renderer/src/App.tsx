import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Bell,
  ChevronDown,
  ChevronUp,
  KeyRound,
  Palette,
  Radar,
  Router,
  Settings,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { ToastContainer, useToast } from './components/Toast';
import { cn } from '@/lib/utils';

export type Device = {
  id: string;
  ip: string;
  mac?: string;
  hostname?: string;
  vendor?: string;
  mdnsName?: string;
  label?: string;
  securityState?: 'trusted' | 'anomaly' | null;
  firstSeen: number;
  lastSeen: number;
  status: 'online' | 'offline';
  latencyMs?: number;
};

type Diagnostics = {
  interfaces: Array<{ name: string; ip: string; netmask: string; family: string }>;
  ipv4Interfaces: Array<{ name: string; ip: string; netmask: string; family: string }>;
  subnets: string[];
  hostCount: number;
  tools: { ping: boolean; ip: boolean; arp: boolean; procArp: boolean };
};

type ProviderId = 'openai' | 'gemini' | 'claude';

type SettingsPublic = {
  providers: Record<ProviderId, { hasKey: boolean; last4: string | null }>;
  accentId?: string | null;
  alerts: {
    osNotifications: boolean;
    unknownOnly: boolean;
    startupWarmupMs: number;
    globalCooldownMs: number;
    perDeviceCooldownMs: number;
    mutedDeviceIds: string[];
  };
  security: {
    trustedDeviceIds: string[];
  };
  updatedAt: number;
};

type AiSummary = {
  provider?: ProviderId;
  model?: string;
  text: string;
  deviceId?: string;
  createdAt: number;
};

type AlertRecord = {
  id: number;
  type: string;
  message: string;
  deviceId?: string | null;
  createdAt: number;
};

type SightingRecord = {
  id: number;
  deviceId: string;
  seenAt: number;
  ip: string;
  latencyMs?: number | null;
  status?: 'online' | 'offline' | null;
};

const formatTimestamp = (value: number) =>
  new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const formatDateTime = (value: number) =>
  new Date(value).toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

const scanMaxHosts = 1024;
const scanIntervalMs = 8000;

function StatCard({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'warn' | 'info' }) {
  return (
    <div
      className={cn(
        'rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur',
        tone === 'good' && 'shadow-[0_0_24px_rgba(56,189,248,0.2)]',
        tone === 'warn' && 'shadow-[0_0_24px_rgba(248,113,113,0.18)]'
      )}
    >
      <div className="text-xs uppercase tracking-[0.2em] text-white/50">{label}</div>
      <div className="mt-2 text-2xl font-semibold text-white">{value}</div>
    </div>
  );
}

export default function App() {
  type AccentPreset = {
    id: string;
    label: string;
    helper: string;
    colors: Record<200 | 300 | 400, string>;
  };

  const providerDefs: Array<{ id: ProviderId; label: string; helper: string }> = [
    {
      id: 'openai',
      label: 'OpenAI',
      helper: 'Used for narrative summaries, chat, and anomaly explanations.',
    },
    {
      id: 'gemini',
      label: 'Gemini',
      helper: 'Optional backup model for summaries and device classification.',
    },
    {
      id: 'claude',
      label: 'Claude',
      helper: 'Great at summarization, long-form analysis, and incident reports.',
    },
  ];

  const accentPresets: AccentPreset[] = [
    {
      id: 'emerald',
      label: 'Emerald',
      helper: 'Fresh, calm green for focus.',
      colors: { 200: '167, 243, 208', 300: '110, 231, 183', 400: '52, 211, 153' },
    },
    {
      id: 'sky',
      label: 'Sky',
      helper: 'Bright blue highlight for clarity.',
      colors: { 200: '186, 230, 253', 300: '125, 211, 252', 400: '56, 189, 248' },
    },
    {
      id: 'amber',
      label: 'Amber',
      helper: 'Warm amber for visibility.',
      colors: { 200: '253, 230, 138', 300: '252, 211, 77', 400: '251, 191, 36' },
    },
    {
      id: 'rose',
      label: 'Rose',
      helper: 'Soft rose for standout highlights.',
      colors: { 200: '254, 205, 211', 300: '253, 164, 175', 400: '251, 113, 133' },
    },
    {
      id: 'purple',
      label: 'Purple',
      helper: 'Violet glow with a bold accent.',
      colors: { 200: '221, 214, 254', 300: '196, 181, 253', 400: '167, 139, 250' },
    },
  ];

  const [devices, setDevices] = useState<Device[]>([]);
  const [renderDevices, setRenderDevices] = useState<Device[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanStatus, setScanStatus] = useState<'idle' | 'scanning' | 'ready'>('idle');
  const [bridgeStatus, setBridgeStatus] = useState<'pending' | 'ready' | 'missing'>('pending');
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [view, setView] = useState<'dashboard' | 'settings'>('dashboard');
  const [settings, setSettings] = useState<SettingsPublic | null>(null);
  const [aiSummary, setAiSummary] = useState<AiSummary | null>(null);
  const [expandedDeviceId, setExpandedDeviceId] = useState<string | null>(null);
  const [labelDrafts, setLabelDrafts] = useState<Record<string, string>>({});
  const [savingLabelId, setSavingLabelId] = useState<string | null>(null);
  const [scanProgressive, setScanProgressive] = useState(true);
  const [scanBatchSize, setScanBatchSize] = useState(64);
  const [accentId, setAccentId] = useState<string>('emerald');
  const [savingAccent, setSavingAccent] = useState(false);
  const [sightingsById, setSightingsById] = useState<Record<string, SightingRecord[]>>({});
  const [loadingSightingsId, setLoadingSightingsId] = useState<string | null>(null);
  const [historyExpandedById, setHistoryExpandedById] = useState<Record<string, boolean>>({});
  const [keyDrafts, setKeyDrafts] = useState<Record<ProviderId, string>>({
    openai: '',
    gemini: '',
    claude: '',
  });
  const [keyVisible, setKeyVisible] = useState<Record<ProviderId, boolean>>({
    openai: false,
    gemini: false,
    claude: false,
  });
  const [savingProvider, setSavingProvider] = useState<ProviderId | null>(null);
  const [savingAlertPrefs, setSavingAlertPrefs] = useState(false);
  const [savingMutedDeviceId, setSavingMutedDeviceId] = useState<string | null>(null);
  const [savingTrustedDeviceId, setSavingTrustedDeviceId] = useState<string | null>(null);
  const [sendingTestNotification, setSendingTestNotification] = useState(false);
  const [alertTimingDraft, setAlertTimingDraft] = useState({
    startupWarmupSec: 45,
    globalCooldownSec: 20,
    perDeviceCooldownSec: 60,
  });
  const { toasts, showToast, dismissToast } = useToast();
  const knownIds = useRef(new Set<string>());
  const hydratedFromDb = useRef(false);
  const hasScanResult = useRef(false);
  const initialScanHandled = useRef(false);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let unsubscribeSummary: (() => void) | undefined;
    let pollTimer: number | undefined;
    let bridgeTimer: number | undefined;
    let cancelled = false;

    const boot = async () => {
      if (!window.aneti || cancelled) return;
      setBridgeStatus('ready');

      if (!hydratedFromDb.current) {
        const stored = await window.aneti.listStoredDevices();
        if (Array.isArray(stored) && stored.length > 0) {
          setDevices(stored as Device[]);
          knownIds.current = new Set((stored as Device[]).map((device) => device.id));
          hydratedFromDb.current = true;
          hasScanResult.current = true;
          setScanStatus('ready');
        }
      }

      const diag = await window.aneti.diagnostics({ maxHosts: scanMaxHosts });
      setDiagnostics(diag as Diagnostics);

      const settingsData = await window.aneti.settingsGet();
      if (settingsData) {
        const data = settingsData as SettingsPublic;
        setSettings(data);
        if (data.accentId) {
          setAccentId(data.accentId);
        }
      }

      const alerts = await window.aneti.listAlerts(20);
      if (Array.isArray(alerts)) {
        const summaryAlert = (alerts as AlertRecord[]).find((alert) => alert.type === 'ai_summary');
        if (summaryAlert) {
          setAiSummary({
            text: summaryAlert.message,
            deviceId: summaryAlert.deviceId ?? undefined,
            createdAt: summaryAlert.createdAt,
          });
        }
      }

      await window.aneti.startScan({
        intervalMs: scanIntervalMs,
        maxHosts: scanMaxHosts,
        progressive: scanProgressive,
        batchSize: scanBatchSize,
      });
      if (!hasScanResult.current) {
        setScanStatus('scanning');
      }
      setScanning(true);

      unsubscribe = window.aneti.onDevices((next) => {
        const list = next as Device[];
        setDevices(list);
        if (!hasScanResult.current) {
          hasScanResult.current = true;
          setScanStatus('ready');
        }

        const known = knownIds.current;
        if (!initialScanHandled.current) {
          const baselineCount = known.size;
          const newCount = list.filter((device) => !known.has(device.id)).length;
          for (const device of list) {
            known.add(device.id);
          }
          initialScanHandled.current = true;
          if (list.length > 0) {
            const message =
              baselineCount > 0
                ? `Initial scan complete: ${list.length} devices (${newCount} new).`
                : `Initial scan complete: ${list.length} devices.`;
            showToast('info', message);
          }
          return;
        }

        const newDevices = list.filter((device) => !known.has(device.id));
        if (newDevices.length === 0) return;

        if (newDevices.length > 1) {
          showToast('info', `Scan update: ${list.length} devices (${newDevices.length} new).`);
        } else {
          const device = newDevices[0];
          const name = device.label || device.hostname || device.ip;
          showToast('info', `New device: ${name}`);
        }

        for (const device of newDevices) {
          known.add(device.id);
        }
      });

      unsubscribeSummary = window.aneti.onSummary((summary) => {
        const data = summary as AiSummary;
        if (data?.text) {
          setAiSummary(data);
        }
      });

      pollTimer = window.setInterval(async () => {
        const list = await window.aneti?.listDevices();
        if (Array.isArray(list) && list.length > 0) {
          setDevices(list as Device[]);
        }
      }, 12000);
    };

    const waitForBridge = () => {
      const deadline = Date.now() + 3000;
      bridgeTimer = window.setInterval(() => {
        if (window.aneti) {
          if (bridgeTimer) window.clearInterval(bridgeTimer);
          void boot();
          return;
        }
        if (Date.now() >= deadline) {
          if (bridgeTimer) window.clearInterval(bridgeTimer);
          setBridgeStatus('missing');
        }
      }, 120);
    };

    waitForBridge();

    return () => {
      cancelled = true;
      unsubscribe?.();
      unsubscribeSummary?.();
      if (pollTimer) window.clearInterval(pollTimer);
      if (bridgeTimer) window.clearInterval(bridgeTimer);
      window.aneti?.stopScan();
    };
  }, [showToast]);

  useEffect(() => {
    if (!expandedDeviceId) return;
    const device = devices.find((item) => item.id === expandedDeviceId);
    if (!device) return;
    setLabelDrafts((prev) => {
      if (prev[device.id] !== undefined) return prev;
      return { ...prev, [device.id]: device.label ?? '' };
    });
  }, [expandedDeviceId, devices]);

  useEffect(() => {
    if (!expandedDeviceId) return;
    if (!window.aneti?.listSightings) return;
    if (sightingsById[expandedDeviceId]) return;
    let cancelled = false;
    setLoadingSightingsId(expandedDeviceId);
    window.aneti
      .listSightings(expandedDeviceId, 20)
      .then((rows) => {
        if (cancelled) return;
        if (Array.isArray(rows)) {
          setSightingsById((prev) => ({
            ...prev,
            [expandedDeviceId]: rows as SightingRecord[],
          }));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingSightingsId(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [expandedDeviceId, sightingsById]);

  const onlineCount = useMemo(
    () => devices.filter((device) => device.status === 'online').length,
    [devices]
  );

  useEffect(() => {
    setRenderDevices((prev) => {
      if (!expandedDeviceId) return devices;
      const prevOrder = prev.map((item) => item.id);
      const nextById = new Map(devices.map((item) => [item.id, item]));
      const ordered: Device[] = [];

      for (const id of prevOrder) {
        const item = nextById.get(id);
        if (item) {
          ordered.push(item);
          nextById.delete(id);
        }
      }

      for (const item of nextById.values()) {
        ordered.push(item);
      }

      return ordered;
    });
  }, [devices, expandedDeviceId]);

  const offlineCount = devices.length - onlineCount;
  const anomalyCount = useMemo(
    () => devices.filter((device) => device.securityState === 'anomaly').length,
    [devices]
  );
  const lastSeen = devices[0]?.lastSeen;
  const hasAiKey = settings
    ? Object.values(settings.providers).some((provider) => provider.hasKey)
    : false;

  const handleToggleScan = async () => {
    if (!window.aneti) return;
    if (scanning) {
      await window.aneti.stopScan();
      setScanning(false);
      showToast('info', 'Scanning paused.');
    } else {
      await window.aneti.startScan({
        intervalMs: scanIntervalMs,
        maxHosts: scanMaxHosts,
        progressive: scanProgressive,
        batchSize: scanBatchSize,
      });
      setScanning(true);
      showToast('success', 'Scanning resumed.');
    }
  };

  const toggleDevicePanel = (deviceId: string) => {
    setExpandedDeviceId((current) => (current === deviceId ? null : deviceId));
  };

  const handleSaveKey = async (provider: ProviderId) => {
    if (!window.aneti) return;
    setSavingProvider(provider);
    const value = keyDrafts[provider]?.trim() ?? '';
    const updated = await window.aneti.settingsUpdate(provider, value.length > 0 ? value : null);
    if (updated) {
      setSettings(updated as SettingsPublic);
      setKeyDrafts((prev) => ({ ...prev, [provider]: '' }));
      showToast('success', `${provider.toUpperCase()} key saved.`);
    }
    setSavingProvider(null);
  };

  const handleClearKey = async (provider: ProviderId) => {
    if (!window.aneti) return;
    setSavingProvider(provider);
    const updated = await window.aneti.settingsUpdate(provider, null);
    if (updated) {
      setSettings(updated as SettingsPublic);
      showToast('info', `${provider.toUpperCase()} key cleared.`);
    }
    setSavingProvider(null);
  };

  const isElectron = typeof navigator !== 'undefined' && navigator.userAgent.toLowerCase().includes('electron');
  const preloadMeta = typeof window !== 'undefined' ? window.anetiMeta : undefined;

  const applyAccent = (id: string | null) => {
    if (typeof document === 'undefined') return;
    const preset = accentPresets.find((item) => item.id === id) ?? accentPresets[0];
    document.documentElement.style.setProperty('--accent-200-rgb', preset.colors[200]);
    document.documentElement.style.setProperty('--accent-300-rgb', preset.colors[300]);
    document.documentElement.style.setProperty('--accent-400-rgb', preset.colors[400]);
  };

  useEffect(() => {
    applyAccent(accentId);
  }, [accentId]);

  const extractSuggestedName = (text?: string | null) => {
    if (!text) return null;
    const match = text.match(/["“”']([^"“”']{2,64})["“”']/);
    if (!match) return null;
    const candidate = match[1].trim();
    if (!candidate) return null;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(candidate)) return null;
    return candidate;
  };

  const suggestedName = useMemo(() => extractSuggestedName(aiSummary?.text ?? null), [aiSummary?.text]);
  const suggestedDevice = useMemo(
    () => (aiSummary?.deviceId ? devices.find((device) => device.id === aiSummary.deviceId) : undefined),
    [aiSummary?.deviceId, devices]
  );

  const copyText = async (value: string, label?: string) => {
    if (!value || value.trim().length === 0) {
      showToast('info', 'No value to copy.');
      return;
    }
    const message = label ? `Copied ${label}.` : 'Copied to clipboard.';
    try {
      if (window.aneti?.copyText) {
        window.aneti.copyText(value);
        showToast('success', message);
        return;
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        showToast('success', message);
        return;
      }
    } catch {
      // fall through to legacy copy
    }
    try {
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.style.position = 'fixed';
      textarea.style.top = '-9999px';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(textarea);
      if (ok) {
        showToast('success', message);
        return;
      }
    } catch {
      // ignore
    }
    showToast('error', 'Failed to copy.');
  };

  const deviceSummary = (device: Device) =>
    [
      `Device: ${device.label || device.hostname || 'Unknown device'}`,
      `Label: ${device.label || '—'}`,
      `IP: ${device.ip}`,
      `MAC: ${device.mac || 'Unknown'}`,
      `Vendor: ${device.vendor || 'Unknown'}`,
      `mDNS: ${device.mdnsName || '—'}`,
      `First seen: ${formatDateTime(device.firstSeen)}`,
      `Last seen: ${formatDateTime(device.lastSeen)}`,
      `Status: ${device.status}`,
      `Latency: ${device.latencyMs ? `${device.latencyMs} ms` : '—'}`,
    ].join('\n');

  const updateDeviceLabel = async (deviceId: string, label: string | null) => {
    if (!window.aneti?.updateDeviceLabel) {
      showToast('error', 'Device rename unavailable.');
      return;
    }
    setSavingLabelId(deviceId);
    const normalized = label && label.trim().length > 0 ? label.trim() : null;
    const result = await window.aneti.updateDeviceLabel(deviceId, normalized);
    if (result) {
      setDevices((prev) =>
        prev.map((device) =>
          device.id === deviceId ? { ...device, label: normalized ?? undefined } : device
        )
      );
      setLabelDrafts((prev) => {
        const next = { ...prev };
        if (normalized) {
          next[deviceId] = normalized;
        } else {
          delete next[deviceId];
        }
        return next;
      });
      showToast('success', normalized ? 'Device label saved.' : 'Device label cleared.');
    }
    setSavingLabelId(null);
  };

  const toggleHistory = (deviceId: string) => {
    setHistoryExpandedById((prev) => ({ ...prev, [deviceId]: !prev[deviceId] }));
  };

  const handleAccentChange = async (id: string) => {
    setAccentId(id);
    if (!window.aneti?.settingsUpdateAccent) {
      showToast('error', 'Accent settings unavailable.');
      return;
    }
    setSavingAccent(true);
    const updated = await window.aneti.settingsUpdateAccent(id);
    if (updated) {
      setSettings(updated as SettingsPublic);
      showToast('success', 'Accent updated.');
    }
    setSavingAccent(false);
  };

  const handleUpdateAlerts = async (patch: {
    osNotifications?: boolean;
    unknownOnly?: boolean;
    startupWarmupMs?: number;
    globalCooldownMs?: number;
    perDeviceCooldownMs?: number;
  }) => {
    if (!window.aneti?.settingsUpdateAlerts) {
      showToast('error', 'Alert settings unavailable.');
      return;
    }
    setSavingAlertPrefs(true);
    const updated = await window.aneti.settingsUpdateAlerts(patch);
    if (updated) {
      setSettings(updated as SettingsPublic);
      showToast('success', 'Alert settings updated.');
    }
    setSavingAlertPrefs(false);
  };

  const handleSetDeviceMuted = async (deviceId: string, muted: boolean) => {
    if (!window.aneti?.settingsSetDeviceMuted) {
      showToast('error', 'Mute settings unavailable.');
      return;
    }
    setSavingMutedDeviceId(deviceId);
    const updated = await window.aneti.settingsSetDeviceMuted(deviceId, muted);
    if (updated) {
      setSettings(updated as SettingsPublic);
      showToast('success', muted ? 'Device muted from alerts.' : 'Device unmuted for alerts.');
    }
    setSavingMutedDeviceId(null);
  };

  const handleSetDeviceTrusted = async (deviceId: string, trusted: boolean) => {
    if (!window.aneti?.settingsSetDeviceTrusted) {
      showToast('error', 'Trust settings unavailable.');
      return;
    }
    setSavingTrustedDeviceId(deviceId);
    const updated = await window.aneti.settingsSetDeviceTrusted(deviceId, trusted);
    if (updated) {
      setSettings(updated as SettingsPublic);
      showToast('success', trusted ? 'Device marked trusted.' : 'Device marked untrusted.');
    }
    setSavingTrustedDeviceId(null);
  };

  const handleTestNotification = async () => {
    if (!window.aneti?.settingsTestNotification) {
      showToast('error', 'Test notification unavailable.');
      return;
    }
    setSendingTestNotification(true);
    const result = await window.aneti.settingsTestNotification();
    const typed = result as { ok?: boolean; reason?: string } | null;
    if (typed?.ok) {
      showToast('success', 'Test notification sent.');
    } else {
      showToast(
        'error',
        typed?.reason === 'unsupported'
          ? 'Notifications are not supported on this system.'
          : 'Failed to send test notification.'
      );
    }
    setSendingTestNotification(false);
  };

  const handleSaveAlertTiming = async () => {
    const startupWarmupMs = Math.max(0, Math.min(300, Math.round(alertTimingDraft.startupWarmupSec))) * 1000;
    const globalCooldownMs = Math.max(5, Math.min(300, Math.round(alertTimingDraft.globalCooldownSec))) * 1000;
    const perDeviceCooldownMs = Math.max(5, Math.min(600, Math.round(alertTimingDraft.perDeviceCooldownSec))) * 1000;
    await handleUpdateAlerts({ startupWarmupMs, globalCooldownMs, perDeviceCooldownMs });
  };

  useEffect(() => {
    if (!settings?.alerts) return;
    setAlertTimingDraft({
      startupWarmupSec: Math.round((settings.alerts.startupWarmupMs ?? 45_000) / 1000),
      globalCooldownSec: Math.round((settings.alerts.globalCooldownMs ?? 20_000) / 1000),
      perDeviceCooldownSec: Math.round((settings.alerts.perDeviceCooldownMs ?? 60_000) / 1000),
    });
  }, [settings?.alerts]);

  return (
    <div className="min-h-screen bg-[#070b1a] text-white">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,#1d4ed8_0%,rgba(7,11,26,0.2)_45%)] opacity-70" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_30%,rgba(59,130,246,0.2),transparent_55%)]" />

      <div className="relative z-10 px-8 py-8">
        <header className="flex items-center justify-between gap-6">
          <div>
            <div className="flex items-center gap-3">
              <div className="rounded-2xl bg-white/10 p-3 shadow-[0_0_20px_rgba(37,99,235,0.4)]">
                <Radar className="h-6 w-6 text-sky-300" />
              </div>
              <div>
                <div className="text-xs uppercase tracking-[0.4em] text-sky-300/70">AnetI</div>
                <h1 className="text-2xl font-semibold">Network Intelligence Console</h1>
              </div>
            </div>
            <p className="mt-3 text-sm text-white/60 max-w-xl">
              Continuous LAN discovery with real-time device intelligence, alerting, and
              SNMP-based enrichment.
            </p>
          </div>

          <div className="flex items-center gap-3">
            {view === 'dashboard' && (
              <button
                type="button"
                onClick={handleToggleScan}
                className={cn(
                  'rounded-full px-4 py-2 text-sm font-medium transition',
                  scanning
                    ? 'bg-emerald-400/20 text-emerald-200 hover:bg-emerald-400/30'
                    : 'bg-white/10 text-white/80 hover:bg-white/20'
                )}
              >
                {scanning ? 'Pause Scan' : 'Resume Scan'}
              </button>
            )}
            <button
              type="button"
              onClick={() => setView((current) => (current === 'dashboard' ? 'settings' : 'dashboard'))}
              className="rounded-full bg-white/10 px-4 py-2 text-sm text-white/70 hover:bg-white/20"
            >
              {view === 'dashboard' ? 'Settings' : 'Back to Dashboard'}
            </button>
          </div>
        </header>

        {bridgeStatus !== 'ready' && (
          <div className="mt-6 rounded-2xl border border-red-400/40 bg-red-500/10 p-4 text-sm text-red-100">
            {bridgeStatus === 'pending'
              ? 'IPC bridge pending. Waiting for the Electron preload layer to attach.'
              : 'IPC bridge not ready. The renderer cannot reach the Electron preload layer.'}
            {!isElectron && (
              <div className="mt-2 text-xs text-red-100/70">
                This page is running in a normal browser. Launch the Electron window from the dev server instead.
              </div>
            )}
            {isElectron && (
              <div className="mt-2 text-xs text-red-100/70">
                Preload meta: {preloadMeta?.preload ? `loaded v${preloadMeta.version}` : 'missing'}
              </div>
            )}
          </div>
        )}

        {bridgeStatus === 'ready' && scanStatus !== 'scanning' && devices.length === 0 && diagnostics && (
          <div className="mt-6 rounded-2xl border border-amber-300/30 bg-amber-500/10 p-4 text-sm text-amber-100">
            <div className="text-xs uppercase tracking-[0.2em] text-amber-200/70">Discovery diagnostics</div>
            <div className="mt-2">
              IPv4 interfaces: {diagnostics.ipv4Interfaces.length} · Subnets: {diagnostics.subnets.length} · Hosts scanned: {diagnostics.hostCount}
            </div>
            {diagnostics.ipv4Interfaces.length > 0 && (
              <div className="mt-2 text-xs text-amber-200/70">
                IPv4: {diagnostics.ipv4Interfaces.map((iface) => iface.ip).join(', ')}
              </div>
            )}
            {diagnostics.subnets.length > 0 && (
              <div className="mt-2 text-xs text-amber-200/70">
                Subnets: {diagnostics.subnets.join(', ')}
              </div>
            )}
            {diagnostics.ipv4Interfaces.length === 0 && (
              <div className="mt-2 text-xs text-amber-200/70">
                No IPv4 interfaces detected. IPv6 interfaces: {diagnostics.interfaces.filter((iface) => iface.family === 'IPv6').length}. Scanning is IPv4-only right now.
              </div>
            )}
            <div className="mt-2 text-xs text-amber-200/70">
              Tools: ping {diagnostics.tools.ping ? 'ok' : 'missing'} · ip {diagnostics.tools.ip ? 'ok' : 'missing'} · arp {diagnostics.tools.arp ? 'ok' : 'missing'} · /proc/net/arp {diagnostics.tools.procArp ? 'ok' : 'missing'}
            </div>
          </div>
        )}

        {view === 'dashboard' && (
          <>
            <section className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-3">
              <StatCard label="Devices" value={`${devices.length}`} tone="info" />
              <StatCard label="Online" value={`${onlineCount}`} tone="good" />
              <StatCard
                label={anomalyCount > 0 ? 'Anomalies' : 'Offline'}
                value={anomalyCount > 0 ? `${anomalyCount}` : `${offlineCount}`}
                tone={anomalyCount > 0 ? 'warn' : 'warn'}
              />
            </section>

            <section className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-[1.2fr_1fr]">
              <div className="rounded-3xl border border-white/10 bg-white/5 p-6 backdrop-blur">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs uppercase tracking-[0.3em] text-white/50">Live Devices</div>
                    <h2 className="mt-2 text-lg font-semibold">Active network inventory</h2>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-white/60">
                    <Activity className="h-4 w-4 text-sky-300" />
                    {scanStatus === 'scanning'
                      ? 'Scanning…'
                      : lastSeen
                        ? `Updated ${formatTimestamp(lastSeen)}`
                        : 'Awaiting scan'}
                  </div>
                </div>

                <div className="mt-6 space-y-3">
                  {scanStatus === 'scanning' &&
                    Array.from({ length: 4 }).map((_, index) => (
                      <div
                        key={`skeleton-${index}`}
                        className="skeleton-card flex items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-4 py-3"
                      >
                        <div className="flex items-center gap-3">
                          <div className="skeleton-accent" />
                          <div className="space-y-2">
                            <div className="skeleton-line skeleton-line--lg" />
                            <div className="skeleton-line skeleton-line--sm" />
                          </div>
                        </div>
                        <div className="space-y-2 text-right">
                          <div className="skeleton-line skeleton-line--xs" />
                          <div className="skeleton-line skeleton-line--xs" />
                        </div>
                      </div>
                    ))}

                  {scanStatus !== 'scanning' &&
                    renderDevices.map((device) => {
                      const isExpanded = expandedDeviceId === device.id;
                      return (
                        <div key={device.id} className="device-stack">
                          <div
                            role="button"
                            tabIndex={0}
                            onClick={() => toggleDevicePanel(device.id)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                toggleDevicePanel(device.id);
                              }
                            }}
                            className={cn(
                              'device-card device-card--interactive flex items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-4 py-3',
                              device.status === 'online' ? 'device-card--online' : 'device-card--offline'
                            )}
                          >
                            <div className="flex items-center gap-3">
                              <div className={cn('device-accent', device.status === 'online' ? 'device-accent--online' : 'device-accent--offline')} />
                              <div>
                                <div className="text-sm font-medium text-white">
                                  {device.label || device.hostname || 'Unknown device'}
                                </div>
                                <div className="text-xs text-white/50">
                                  <span className="device-tag">{device.ip}</span>
                                  <span className="device-tag">{device.vendor || 'Unknown vendor'}</span>
                                  {device.label && device.hostname && (
                                    <span className="device-tag">{device.hostname}</span>
                                  )}
                                  {!device.label && device.mdnsName && device.mdnsName !== device.hostname && (
                                    <span className="device-tag">{device.mdnsName}</span>
                                  )}
                                </div>
                              </div>
                            </div>
                            <div className="device-meta text-right text-xs text-white/60">
                              <div className="device-tag device-tag--latency">
                                {device.latencyMs ? `${device.latencyMs} ms` : '—'}
                              </div>
                              <div className={cn('device-tag', device.status === 'online' ? 'device-tag--ok' : 'device-tag--warn')}>
                                {device.status}
                              </div>
                              {device.securityState === 'anomaly' && (
                                <div className="device-tag device-tag--security-anomaly">anomaly</div>
                              )}
                              <div className="device-toggle">
                                {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                              </div>
                            </div>
                          </div>

                          {isExpanded && (
                            <div className="device-panel">
                              <div className="detail-row">
                                <div className="detail-label">Label</div>
                                <button
                                  type="button"
                                  onClick={() => copyText(device.label || '')}
                                  className="detail-value detail-value--copy"
                                  title="Click to copy"
                                >
                                  {device.label || 'Not set'}
                                </button>
                              </div>
                              <div className="detail-row">
                                <div className="detail-label">IP Address</div>
                                <button
                                  type="button"
                                  onClick={() => copyText(device.ip)}
                                  className="detail-value detail-value--copy"
                                  title="Click to copy"
                                >
                                  {device.ip}
                                </button>
                              </div>
                              <div className="detail-row">
                                <div className="detail-label">MAC Address</div>
                                <button
                                  type="button"
                                  onClick={() => copyText(device.mac || '')}
                                  className="detail-value detail-value--copy"
                                  title="Click to copy"
                                >
                                  {device.mac || 'Unknown'}
                                </button>
                              </div>
                              <div className="detail-row">
                                <div className="detail-label">Hostname</div>
                                <button
                                  type="button"
                                  onClick={() => copyText(device.hostname || '')}
                                  className="detail-value detail-value--copy"
                                  title="Click to copy"
                                >
                                  {device.hostname || 'Unknown'}
                                </button>
                              </div>
                              <div className="detail-row">
                                <div className="detail-label">mDNS Name</div>
                                <button
                                  type="button"
                                  onClick={() => copyText(device.mdnsName || '')}
                                  className="detail-value detail-value--copy"
                                  title="Click to copy"
                                >
                                  {device.mdnsName || 'Unknown'}
                                </button>
                              </div>
                              <div className="detail-row">
                                <div className="detail-label">Vendor</div>
                                <button
                                  type="button"
                                  onClick={() => copyText(device.vendor || '')}
                                  className="detail-value detail-value--copy"
                                  title="Click to copy"
                                >
                                  {device.vendor || 'Unknown'}
                                </button>
                              </div>
                              <div className="detail-row">
                                <div className="detail-label">First Seen</div>
                                <button
                                  type="button"
                                  onClick={() => copyText(formatDateTime(device.firstSeen))}
                                  className="detail-value detail-value--copy"
                                  title="Click to copy"
                                >
                                  {formatDateTime(device.firstSeen)}
                                </button>
                              </div>
                              <div className="detail-row">
                                <div className="detail-label">Last Seen</div>
                                <button
                                  type="button"
                                  onClick={() => copyText(formatDateTime(device.lastSeen))}
                                  className="detail-value detail-value--copy"
                                  title="Click to copy"
                                >
                                  {formatDateTime(device.lastSeen)}
                                </button>
                              </div>
                              <div className="detail-history">
                                <div className="detail-history-header">
                                  <div className="detail-label">Recent sightings</div>
                                  <button
                                    type="button"
                                    className="detail-action detail-action--ghost"
                                    onClick={() => toggleHistory(device.id)}
                                  >
                                    {historyExpandedById[device.id] ? 'Hide' : 'Show'}
                                  </button>
                                </div>
                                {historyExpandedById[device.id] && (
                                  <>
                                    {loadingSightingsId === device.id && (
                                      <div className="detail-history-empty">Loading…</div>
                                    )}
                                    {loadingSightingsId !== device.id &&
                                      (sightingsById[device.id]?.length ? (
                                        <>
                                          <div className="detail-history-spark">
                                            {sightingsById[device.id]
                                              ?.slice(0, 16)
                                              .map((sighting) => {
                                                const status =
                                                  sighting.status ??
                                                  (sighting.latencyMs ? 'online' : 'offline');
                                                return (
                                                  <span
                                                    key={sighting.id}
                                                    className={cn(
                                                      'detail-history-dot',
                                                      status === 'online'
                                                        ? 'detail-history-dot--online'
                                                        : 'detail-history-dot--offline'
                                                    )}
                                                    title={`${formatTimestamp(sighting.seenAt)} · ${status}`}
                                                  />
                                                );
                                              })}
                                          </div>
                                          <div className="detail-history-list">
                                            {sightingsById[device.id]?.map((sighting) => {
                                              const status =
                                                sighting.status ??
                                                (sighting.latencyMs ? 'online' : 'offline');
                                              return (
                                                <div key={sighting.id} className="detail-history-row">
                                                  <div>{formatTimestamp(sighting.seenAt)}</div>
                                                  <div className="detail-history-ip">{sighting.ip}</div>
                                                  <div className="detail-history-latency">
                                                    {sighting.latencyMs ? `${sighting.latencyMs} ms` : '—'}
                                                  </div>
                                                  <div
                                                    className={cn(
                                                      'detail-history-status',
                                                      status === 'online'
                                                        ? 'detail-history-status--online'
                                                        : 'detail-history-status--offline'
                                                    )}
                                                  >
                                                    {status}
                                                  </div>
                                                </div>
                                              );
                                            })}
                                          </div>
                                        </>
                                      ) : (
                                        <div className="detail-history-empty">No sightings yet.</div>
                                      ))}
                                  </>
                                )}
                              </div>
                              <div className="detail-edit">
                                <div className="detail-label">Rename device</div>
                                <div className="detail-edit-row">
                                  <input
                                    className="detail-input"
                                    placeholder="Set a friendly label"
                                    value={labelDrafts[device.id] ?? ''}
                                    onChange={(event) =>
                                      setLabelDrafts((prev) => ({
                                        ...prev,
                                        [device.id]: event.target.value,
                                      }))
                                    }
                                  />
                                  <button
                                    type="button"
                                    className="detail-action"
                                    onClick={() => updateDeviceLabel(device.id, labelDrafts[device.id] ?? '')}
                                    disabled={savingLabelId === device.id}
                                  >
                                    {savingLabelId === device.id ? 'Saving…' : 'Save'}
                                  </button>
                                  <button
                                    type="button"
                                    className="detail-action detail-action--ghost"
                                    onClick={() => updateDeviceLabel(device.id, null)}
                                    disabled={savingLabelId === device.id || !device.label}
                                  >
                                    Clear
                                  </button>
                                </div>
                              </div>
                              <div className="detail-actions">
                                <button
                                  type="button"
                                  className="detail-copy-button"
                                  disabled={savingTrustedDeviceId === device.id}
                                  onClick={() =>
                                    handleSetDeviceTrusted(
                                      device.id,
                                      !(settings?.security?.trustedDeviceIds ?? []).includes(device.id)
                                    )
                                  }
                                >
                                  {(settings?.security?.trustedDeviceIds ?? []).includes(device.id)
                                    ? 'Mark untrusted'
                                    : 'Mark trusted'}
                                </button>
                                <button
                                  type="button"
                                  className="detail-copy-button"
                                  disabled={savingMutedDeviceId === device.id}
                                  onClick={() =>
                                    handleSetDeviceMuted(
                                      device.id,
                                      !(settings?.alerts?.mutedDeviceIds ?? []).includes(device.id)
                                    )
                                  }
                                >
                                  {(settings?.alerts?.mutedDeviceIds ?? []).includes(device.id)
                                    ? 'Unmute device alerts'
                                    : 'Mute device alerts'}
                                </button>
                                <button
                                  type="button"
                                  className="detail-copy-button"
                                  onClick={() => copyText(deviceSummary(device))}
                                >
                                  Copy device summary
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                </div>
              </div>

              <div className="space-y-6">
                <div className="rounded-3xl border border-white/10 bg-gradient-to-br from-sky-500/10 via-blue-500/5 to-transparent p-6">
                  <div className="flex items-center gap-3">
                    <Router className="h-5 w-5 text-sky-300" />
                    <div>
                      <div className="text-xs uppercase tracking-[0.3em] text-white/50">Discovery</div>
                      <div className="text-base font-semibold">Auto-detecting subnets</div>
                    </div>
                  </div>
                  <p className="mt-3 text-sm text-white/60">
                    ARP + ICMP sweep, mDNS hostname resolution, and SNMP enrichment ready.
                  </p>
                </div>

                <div className="rounded-3xl border border-white/10 bg-white/5 p-6">
                  <div className="flex items-center gap-3">
                    <Sparkles className="h-5 w-5 text-emerald-200" />
                    <div>
                      <div className="text-xs uppercase tracking-[0.3em] text-white/50">AI Brief</div>
                      <div className="text-base font-semibold">Human-readable incident summary</div>
                    </div>
                  </div>
                  <p className="mt-3 text-sm text-white/60">
                    {aiSummary?.text
                      ? aiSummary.text
                      : hasAiKey
                        ? 'Awaiting the next event to summarize.'
                        : 'Add an API key in Settings to enable AI summaries.'}
                  </p>
                  {suggestedName && aiSummary?.deviceId && (
                    <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-white/60">
                      <span>Suggested label:</span>
                      <span className="device-tag">{suggestedName}</span>
                      {suggestedDevice?.label && (
                        <span className="text-white/40">Current: {suggestedDevice.label}</span>
                      )}
                      <button
                        type="button"
                        className="detail-action detail-action--ghost"
                        onClick={() => updateDeviceLabel(aiSummary.deviceId as string, suggestedName)}
                      >
                        Apply suggested name
                      </button>
                    </div>
                  )}
                  {aiSummary?.createdAt && (
                    <div className="mt-3 text-xs text-white/50">
                      Updated {formatTimestamp(aiSummary.createdAt)}
                    </div>
                  )}
                </div>

                <div className="rounded-3xl border border-white/10 bg-white/5 p-6">
                  <div className="flex items-center gap-3">
                    <Bell className="h-5 w-5 text-amber-300" />
                    <div>
                      <div className="text-xs uppercase tracking-[0.3em] text-white/50">Alerts</div>
                      <div className="text-base font-semibold">New device notifications</div>
                    </div>
                  </div>
                  <p className="mt-3 text-sm text-white/60">
                    {settings?.alerts?.osNotifications
                      ? `OS notifications are enabled (${settings?.alerts?.unknownOnly ? 'unknown devices only' : 'all discovery events'}).`
                      : 'OS notifications are disabled.'}
                  </p>
                  <div className="mt-3 text-xs text-white/50">
                    Muted devices: {(settings?.alerts?.mutedDeviceIds ?? []).length}
                  </div>
                </div>

                <div className="rounded-3xl border border-white/10 bg-white/5 p-6">
                  <div className="flex items-center gap-3">
                    <ShieldCheck className="h-5 w-5 text-emerald-300" />
                    <div>
                      <div className="text-xs uppercase tracking-[0.3em] text-white/50">Security</div>
                      <div className="text-base font-semibold">Baseline + anomaly detection</div>
                    </div>
                  </div>
                  <p className="mt-3 text-sm text-white/60">
                    {anomalyCount > 0
                      ? `${anomalyCount} untrusted device${anomalyCount === 1 ? '' : 's'} detected.`
                      : 'No untrusted device anomalies right now.'}
                  </p>
                  <p className="mt-2 text-xs text-white/50">
                    Trusted devices: {(settings?.security?.trustedDeviceIds ?? []).length}
                  </p>
                </div>
              </div>
            </section>
          </>
        )}

        {view === 'settings' && (
          <section className="mt-8 grid grid-cols-1 gap-6">
            <div className="rounded-3xl border border-white/10 bg-white/5 p-6 backdrop-blur">
              <div className="flex items-center gap-3">
                <div className="rounded-2xl bg-white/10 p-3">
                  <Settings className="h-5 w-5 text-sky-300" />
                </div>
                <div>
                  <div className="text-xs uppercase tracking-[0.3em] text-white/50">AI Settings</div>
                  <h2 className="mt-2 text-lg font-semibold">Connect your model providers</h2>
                </div>
              </div>
              <p className="mt-3 text-sm text-white/60 max-w-xl">
                Keys are stored locally in your user profile. They’re used for optional summaries,
                anomaly explanations, and chat-style queries.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
              {providerDefs.map((provider) => {
                const meta = settings?.providers?.[provider.id];
                const masked = meta?.hasKey ? `•••• ${meta?.last4 ?? ''}` : 'Not set';
                return (
                  <div key={provider.id} className="rounded-3xl border border-white/10 bg-white/5 p-6">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <KeyRound className="h-5 w-5 text-emerald-200" />
                        <div className="text-base font-semibold">{provider.label}</div>
                      </div>
                      <span className={cn('status-pill', meta?.hasKey ? 'status-pill--ok' : 'status-pill--empty')}>
                        {masked}
                      </span>
                    </div>
                    <p className="mt-3 text-sm text-white/60">{provider.helper}</p>

                    <div className="mt-4 space-y-3">
                      <input
                        type={keyVisible[provider.id] ? 'text' : 'password'}
                        value={keyDrafts[provider.id]}
                        onChange={(event) =>
                          setKeyDrafts((prev) => ({ ...prev, [provider.id]: event.target.value }))
                        }
                        placeholder={`Paste ${provider.label} API key`}
                        className="input-field"
                      />
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            setKeyVisible((prev) => ({ ...prev, [provider.id]: !prev[provider.id] }))
                          }
                          className="ghost-button"
                        >
                          {keyVisible[provider.id] ? 'Hide' : 'Show'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleSaveKey(provider.id)}
                          className="primary-button"
                          disabled={savingProvider === provider.id || keyDrafts[provider.id].trim().length === 0}
                        >
                          {savingProvider === provider.id ? 'Saving…' : 'Save'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleClearKey(provider.id)}
                          className="ghost-button"
                          disabled={savingProvider === provider.id || !meta?.hasKey}
                        >
                          Clear
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="rounded-3xl border border-white/10 bg-white/5 p-6 backdrop-blur">
              <div className="flex items-center gap-3">
                <div className="rounded-2xl bg-white/10 p-3">
                  <Radar className="h-5 w-5 text-sky-300" />
                </div>
                <div>
                  <div className="text-xs uppercase tracking-[0.3em] text-white/50">Scan Settings</div>
                  <h2 className="mt-2 text-lg font-semibold">Discovery behavior</h2>
                </div>
              </div>
              <p className="mt-3 text-sm text-white/60 max-w-xl">
                Progressive updates stream devices as they’re found. Batch size controls how often
                partial results are emitted.
              </p>

              <div className="scan-settings">
                <div className="scan-setting-row">
                  <div>
                    <div className="scan-setting-label">Progressive updates</div>
                    <div className="scan-setting-help">Show devices during the scan instead of waiting for the full sweep.</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setScanProgressive((prev) => !prev)}
                    aria-pressed={scanProgressive}
                    className={cn('toggle-button', scanProgressive && 'toggle-button--on')}
                  >
                    <span className="toggle-knob" aria-hidden="true" />
                    <span className="toggle-label">{scanProgressive ? 'Enabled' : 'Disabled'}</span>
                  </button>
                </div>

                <div className="scan-setting-row">
                  <div>
                    <div className="scan-setting-label">Batch size</div>
                    <div className="scan-setting-help">Lower values update more often. Higher values scan faster.</div>
                  </div>
                  <input
                    type="number"
                    min={16}
                    max={256}
                    step={8}
                    value={scanBatchSize}
                    onChange={(event) => {
                      const parsed = Number(event.target.value);
                      if (!Number.isFinite(parsed)) return;
                      const clamped = Math.min(256, Math.max(16, Math.round(parsed)));
                      setScanBatchSize(clamped);
                    }}
                    className="detail-input scan-batch-input"
                  />
                </div>
                <div className="scan-setting-note">Changes apply on the next scan start/resume.</div>
              </div>
            </div>

            <div className="rounded-3xl border border-white/10 bg-white/5 p-6 backdrop-blur">
              <div className="flex items-center gap-3">
                <div className="rounded-2xl bg-white/10 p-3">
                  <Bell className="h-5 w-5 text-amber-300" />
                </div>
                <div>
                  <div className="text-xs uppercase tracking-[0.3em] text-white/50">Alert Settings</div>
                  <h2 className="mt-2 text-lg font-semibold">OS notifications</h2>
                </div>
              </div>
              <p className="mt-3 text-sm text-white/60 max-w-xl">
                Choose when desktop notifications fire for device discoveries.
              </p>

              <div className="scan-settings">
                <div className="scan-setting-row">
                  <div>
                    <div className="scan-setting-label">Enable OS notifications</div>
                    <div className="scan-setting-help">Show native desktop alerts when discovery events match your rules.</div>
                  </div>
                  <button
                    type="button"
                    disabled={savingAlertPrefs}
                    aria-pressed={settings?.alerts?.osNotifications ?? true}
                    onClick={() =>
                      handleUpdateAlerts({
                        osNotifications: !(settings?.alerts?.osNotifications ?? true),
                      })
                    }
                    className={cn(
                      'toggle-button',
                      (settings?.alerts?.osNotifications ?? true) && 'toggle-button--on'
                    )}
                  >
                    <span className="toggle-knob" aria-hidden="true" />
                    <span className="toggle-label">
                      {(settings?.alerts?.osNotifications ?? true) ? 'Enabled' : 'Disabled'}
                    </span>
                  </button>
                </div>

                <div className="scan-setting-row">
                  <div>
                    <div className="scan-setting-label">Only unknown devices</div>
                    <div className="scan-setting-help">When enabled, alerts trigger only on first-time devices.</div>
                  </div>
                  <button
                    type="button"
                    disabled={savingAlertPrefs || !(settings?.alerts?.osNotifications ?? true)}
                    aria-pressed={settings?.alerts?.unknownOnly ?? true}
                    onClick={() =>
                      handleUpdateAlerts({
                        unknownOnly: !(settings?.alerts?.unknownOnly ?? true),
                      })
                    }
                    className={cn(
                      'toggle-button',
                      (settings?.alerts?.unknownOnly ?? true) && 'toggle-button--on'
                    )}
                  >
                    <span className="toggle-knob" aria-hidden="true" />
                    <span className="toggle-label">
                      {(settings?.alerts?.unknownOnly ?? true) ? 'Enabled' : 'Disabled'}
                    </span>
                  </button>
                </div>
                <div className="scan-setting-note">
                  Muted devices: {(settings?.alerts?.mutedDeviceIds ?? []).length}
                </div>
                <div className="scan-setting-row">
                  <div>
                    <div className="scan-setting-label">Startup warmup</div>
                    <div className="scan-setting-help">Suppress notifications during initial scan (seconds).</div>
                  </div>
                  <input
                    type="number"
                    min={0}
                    max={300}
                    step={5}
                    className="detail-input scan-batch-input"
                    value={alertTimingDraft.startupWarmupSec}
                    onChange={(event) =>
                      setAlertTimingDraft((prev) => ({
                        ...prev,
                        startupWarmupSec: Number(event.target.value) || 0,
                      }))
                    }
                  />
                </div>
                <div className="scan-setting-row">
                  <div>
                    <div className="scan-setting-label">Global cooldown</div>
                    <div className="scan-setting-help">Minimum seconds between notifications.</div>
                  </div>
                  <input
                    type="number"
                    min={5}
                    max={300}
                    step={5}
                    className="detail-input scan-batch-input"
                    value={alertTimingDraft.globalCooldownSec}
                    onChange={(event) =>
                      setAlertTimingDraft((prev) => ({
                        ...prev,
                        globalCooldownSec: Number(event.target.value) || 5,
                      }))
                    }
                  />
                </div>
                <div className="scan-setting-row">
                  <div>
                    <div className="scan-setting-label">Per-device cooldown</div>
                    <div className="scan-setting-help">Minimum seconds between alerts for the same device.</div>
                  </div>
                  <input
                    type="number"
                    min={5}
                    max={600}
                    step={5}
                    className="detail-input scan-batch-input"
                    value={alertTimingDraft.perDeviceCooldownSec}
                    onChange={(event) =>
                      setAlertTimingDraft((prev) => ({
                        ...prev,
                        perDeviceCooldownSec: Number(event.target.value) || 5,
                      }))
                    }
                  />
                </div>
                <div className="detail-inline-actions">
                  <button
                    type="button"
                    className="detail-action"
                    disabled={sendingTestNotification || !(settings?.alerts?.osNotifications ?? true)}
                    onClick={handleTestNotification}
                  >
                    {sendingTestNotification ? 'Sending…' : 'Test notification'}
                  </button>
                  <button
                    type="button"
                    className="detail-action detail-action--ghost"
                    disabled={savingAlertPrefs}
                    onClick={handleSaveAlertTiming}
                  >
                    Save timing
                  </button>
                </div>
              </div>
            </div>

            <div className="rounded-3xl border border-white/10 bg-white/5 p-6 backdrop-blur">
              <div className="flex items-center gap-3">
                <div className="rounded-2xl bg-white/10 p-3">
                  <Palette className="h-5 w-5 text-sky-300" />
                </div>
                <div>
                  <div className="text-xs uppercase tracking-[0.3em] text-white/50">Appearance</div>
                  <h2 className="mt-2 text-lg font-semibold">Accent color</h2>
                </div>
              </div>
              <p className="mt-3 text-sm text-white/60 max-w-xl">
                Choose a highlight color for status indicators, device accents, and badges.
              </p>

              <div className="accent-grid">
                {accentPresets.map((preset) => {
                  const isActive = accentId === preset.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      className={cn('accent-card', isActive && 'accent-card--active')}
                      onClick={() => handleAccentChange(preset.id)}
                      disabled={savingAccent}
                    >
                      <div
                        className="accent-swatch"
                        style={{ backgroundColor: `rgb(${preset.colors[400]})` }}
                      />
                      <div className="accent-info">
                        <div className="accent-label">{preset.label}</div>
                        <div className="accent-helper">{preset.helper}</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="rounded-3xl border border-white/10 bg-gradient-to-br from-emerald-500/10 via-blue-500/5 to-transparent p-6">
              <div className="flex items-center gap-3">
                <Sparkles className="h-5 w-5 text-emerald-200" />
                <div>
                  <div className="text-xs uppercase tracking-[0.3em] text-white/50">Next Up</div>
                  <div className="text-base font-semibold">AI summaries + anomaly narratives</div>
                </div>
              </div>
              <p className="mt-3 text-sm text-white/60">
                Once a key is stored, we’ll generate plain-English incident briefs and
                device risk summaries directly inside the timeline.
              </p>
            </div>
          </section>
        )}
      </div>

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
