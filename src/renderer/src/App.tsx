import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Bell, KeyRound, Radar, Router, Settings, ShieldCheck, Sparkles } from 'lucide-react';
import { ToastContainer, useToast } from './components/Toast';
import { cn } from '@/lib/utils';

export type Device = {
  id: string;
  ip: string;
  mac?: string;
  hostname?: string;
  vendor?: string;
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

const formatTimestamp = (value: number) =>
  new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

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

  const [devices, setDevices] = useState<Device[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanStatus, setScanStatus] = useState<'idle' | 'scanning' | 'ready'>('idle');
  const [bridgeStatus, setBridgeStatus] = useState<'pending' | 'ready' | 'missing'>('pending');
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [view, setView] = useState<'dashboard' | 'settings'>('dashboard');
  const [settings, setSettings] = useState<SettingsPublic | null>(null);
  const [aiSummary, setAiSummary] = useState<AiSummary | null>(null);
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
  const { toasts, showToast, dismissToast } = useToast();
  const knownIds = useRef(new Set<string>());
  const hydratedFromDb = useRef(false);
  const hasScanResult = useRef(false);

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
          hydratedFromDb.current = true;
          hasScanResult.current = true;
          setScanStatus('ready');
        }
      }

      const diag = await window.aneti.diagnostics({ maxHosts: 128 });
      setDiagnostics(diag as Diagnostics);

      const settingsData = await window.aneti.settingsGet();
      if (settingsData) {
        setSettings(settingsData as SettingsPublic);
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

      await window.aneti.startScan({ intervalMs: 8000, maxHosts: 128 });
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
        for (const device of list) {
          if (!known.has(device.id)) {
            if (known.size > 0) {
              showToast('info', `New device: ${device.hostname || device.ip}`);
            }
            known.add(device.id);
          }
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

  const onlineCount = useMemo(
    () => devices.filter((device) => device.status === 'online').length,
    [devices]
  );

  const offlineCount = devices.length - onlineCount;
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
      await window.aneti.startScan({ intervalMs: 8000 });
      setScanning(true);
      showToast('success', 'Scanning resumed.');
    }
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
              <StatCard label="Offline" value={`${offlineCount}`} tone="warn" />
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
                    devices.map((device) => (
                      <div
                        key={device.id}
                        className={cn(
                          'device-card flex items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-4 py-3',
                          device.status === 'online' ? 'device-card--online' : 'device-card--offline'
                        )}
                      >
                        <div className="flex items-center gap-3">
                          <div className={cn('device-accent', device.status === 'online' ? 'device-accent--online' : 'device-accent--offline')} />
                          <div>
                            <div className="text-sm font-medium text-white">
                              {device.hostname || 'Unknown device'}
                            </div>
                            <div className="text-xs text-white/50">
                              <span className="device-tag">{device.ip}</span>
                              <span className="device-tag">{device.vendor || 'Unknown vendor'}</span>
                            </div>
                          </div>
                        </div>
                        <div className="text-right text-xs text-white/60">
                          <div className="device-tag device-tag--latency">
                            {device.latencyMs ? `${device.latencyMs} ms` : '—'}
                          </div>
                          <div className={cn('device-tag', device.status === 'online' ? 'device-tag--ok' : 'device-tag--warn')}>
                            {device.status}
                          </div>
                        </div>
                      </div>
                    ))}
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
                    Configure OS, email, and Notifiarr alerts with per-device rules.
                  </p>
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
                    Track expected devices and flag unknown entrants instantly.
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
