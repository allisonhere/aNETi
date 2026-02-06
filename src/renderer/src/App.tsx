import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Bell, Radar, Router, ShieldCheck } from 'lucide-react';
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
  const [devices, setDevices] = useState<Device[]>([]);
  const [scanning, setScanning] = useState(false);
  const { toasts, showToast, dismissToast } = useToast();
  const knownIds = useRef(new Set<string>());

  useEffect(() => {
    if (!window.aneti) return;
    window.aneti.startScan({ intervalMs: 8000 });
    setScanning(true);
    const unsubscribe = window.aneti.onDevices((next) => {
      const list = next as Device[];
      setDevices(list);

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

    return () => {
      unsubscribe?.();
      window.aneti.stopScan();
    };
  }, [showToast]);

  const onlineCount = useMemo(
    () => devices.filter((device) => device.status === 'online').length,
    [devices]
  );

  const offlineCount = devices.length - onlineCount;
  const lastSeen = devices[0]?.lastSeen;

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
            <button
              type="button"
              className="rounded-full bg-white/10 px-4 py-2 text-sm text-white/70 hover:bg-white/20"
            >
              Configure Alerts
            </button>
          </div>
        </header>

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
                {lastSeen ? `Updated ${formatTimestamp(lastSeen)}` : 'Awaiting scan'}
              </div>
            </div>

            <div className="mt-6 space-y-3">
              {devices.map((device) => (
                <div
                  key={device.id}
                  className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-4 py-3"
                >
                  <div className="flex items-center gap-3">
                    <div
                      className={cn(
                        'h-2.5 w-2.5 rounded-full',
                        device.status === 'online' ? 'bg-emerald-400' : 'bg-red-400'
                      )}
                    />
                    <div>
                      <div className="text-sm font-medium text-white">
                        {device.hostname || 'Unknown device'}
                      </div>
                      <div className="text-xs text-white/50">
                        {device.ip} · {device.vendor || 'Unknown vendor'}
                      </div>
                    </div>
                  </div>
                  <div className="text-right text-xs text-white/60">
                    <div>{device.latencyMs ? `${device.latencyMs} ms` : '—'}</div>
                    <div>{device.status}</div>
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
      </div>

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
