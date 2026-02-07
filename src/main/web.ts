import { mkdirSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { createScanner } from './scanner.js';
import { createDatabase } from './db.js';
import { createSettingsStore } from './settings.js';
import type { Device } from './types.js';

const env = process.env;
const host = env.ANETI_WEB_HOST ?? '0.0.0.0';
const port = Number(env.ANETI_WEB_PORT ?? 8787);
const scanIntervalMs = Number(env.ANETI_SCAN_INTERVAL_MS ?? 8000);
const scanMaxHosts = Number(env.ANETI_SCAN_MAX_HOSTS ?? 256);
const scanBatchSize = Number(env.ANETI_SCAN_BATCH_SIZE ?? 64);
const dataDir = env.ANETI_DATA_DIR ?? '/var/lib/aneti';

mkdirSync(dataDir, { recursive: true });

const db = createDatabase(join(dataDir, 'aneti.sqlite'));
const settings = createSettingsStore(join(dataDir, 'settings.json'));
const scanner = createScanner();
const baselineDeviceIds = new Set<string>();
const labelById = new Map<string, string>();
let scannerRunning = false;

const secureEqual = (left: string, right: string) => {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

const readTokenFromRequest = (request: IncomingMessage): string | null => {
  const bearer = request.headers.authorization;
  if (typeof bearer === 'string' && bearer.toLowerCase().startsWith('bearer ')) {
    return bearer.slice(7).trim();
  }
  const headerToken = request.headers['x-api-token'];
  if (typeof headerToken === 'string') {
    return headerToken.trim();
  }
  const url = new URL(request.url ?? '/', `http://${host}:${port}`);
  const token = url.searchParams.get('token');
  return token?.trim() || null;
};

const writeJson = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
};

const writeHtml = (response: ServerResponse, status: number, body: string) => {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(body);
};

const requireAuth = (request: IncomingMessage, response: ServerResponse) => {
  const expected = settings.ensureApiToken();
  const supplied = readTokenFromRequest(request);
  if (!supplied || !secureEqual(supplied, expected)) {
    writeJson(response, 401, { ok: false, error: 'unauthorized' });
    return false;
  }
  return true;
};

const buildStatsPayload = () => {
  const now = Date.now();
  const devices = scanner.list() as Device[];
  const trustedIds = new Set(settings.getSecurity().trustedDeviceIds ?? []);
  const alerts = db.listAlerts(100) as Array<{ type: string; createdAt: number }>;
  const online = devices.filter((item) => item.status === 'online').length;
  const anomalies = devices.filter(
    (item) => item.status === 'online' && !trustedIds.has(item.id) && !baselineDeviceIds.has(item.id)
  ).length;
  const trusted = devices.filter((item) => trustedIds.has(item.id)).length;
  const alerts24h = alerts.filter((item) => now - item.createdAt <= 24 * 60 * 60_000);

  return {
    generatedAt: now,
    scanner: {
      scanning: scannerRunning,
      totalDevices: devices.length,
      onlineDevices: online,
      offlineDevices: Math.max(0, devices.length - online),
      trustedDevices: trusted,
      anomalyDevices: anomalies,
    },
    alerts: {
      last24h: alerts24h.length,
      securityLast24h: alerts24h.filter((item) => item.type === 'security_anomaly').length,
      aiSummaryLast24h: alerts24h.filter((item) => item.type === 'ai_summary').length,
    },
    devices: devices.map((device) => ({
      id: device.id,
      ip: device.ip,
      hostname: device.hostname ?? null,
      vendor: device.vendor ?? null,
      label: device.label ?? null,
      status: device.status,
      firstSeen: device.firstSeen,
      lastSeen: device.lastSeen,
      trusted: trustedIds.has(device.id),
    })),
  };
};

const dashboardHtml = () => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AnetI Web</title>
  <style>
    :root { color-scheme: light; --bg:#f4f7fb; --card:#fff; --text:#182033; --muted:#5f6d85; --ok:#0f8a5f; --warn:#b4481c; --line:#dbe3ef; }
    body { margin:0; font-family: "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif; background:linear-gradient(160deg,#eef4ff 0%,#f8f9fc 100%); color:var(--text); }
    .wrap { max-width: 1080px; margin: 24px auto; padding: 0 16px 40px; }
    .card { background: var(--card); border:1px solid var(--line); border-radius: 14px; padding: 14px; box-shadow: 0 8px 24px rgba(20,32,56,.05); }
    .row { display:flex; gap:12px; flex-wrap:wrap; margin-bottom:12px; }
    .metric { flex:1; min-width:140px; }
    .metric h3 { margin:0; font-size:12px; color:var(--muted); font-weight:600; text-transform:uppercase; letter-spacing:.05em; }
    .metric p { margin:4px 0 0; font-size:24px; font-weight:700; }
    h1 { margin:0 0 12px; font-size:24px; }
    table { width:100%; border-collapse: collapse; font-size: 14px; }
    th,td { padding:8px; border-bottom:1px solid var(--line); text-align:left; }
    th { color:var(--muted); font-size:12px; text-transform:uppercase; }
    .online { color:var(--ok); font-weight:700; }
    .offline { color:var(--warn); font-weight:700; }
    .token { display:flex; gap:8px; margin-bottom:12px; }
    input { flex:1; min-width:220px; padding:8px 10px; border:1px solid var(--line); border-radius:10px; }
    button { border:0; background:#1d4ed8; color:white; border-radius:10px; padding:8px 12px; cursor:pointer; font-weight:600; }
    .err { color:#b42318; margin:8px 0 0; font-size:13px; }
    .meta { color:var(--muted); margin-bottom:8px; font-size:12px; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>AnetI Browser Dashboard</h1>
    <div class="card">
      <div class="token">
        <input id="token" placeholder="API token (from /var/lib/aneti/settings.json)" />
        <button id="save">Connect</button>
      </div>
      <div id="err" class="err"></div>
      <div id="meta" class="meta"></div>
      <div class="row">
        <div class="card metric"><h3>Total</h3><p id="m-total">-</p></div>
        <div class="card metric"><h3>Online</h3><p id="m-online">-</p></div>
        <div class="card metric"><h3>Trusted</h3><p id="m-trusted">-</p></div>
        <div class="card metric"><h3>Anomalies</h3><p id="m-anomaly">-</p></div>
      </div>
      <table>
        <thead><tr><th>Status</th><th>IP</th><th>Name</th><th>Vendor</th><th>Last Seen</th></tr></thead>
        <tbody id="rows"></tbody>
      </table>
    </div>
  </div>
  <script>
    const tokenInput = document.getElementById('token');
    const saveBtn = document.getElementById('save');
    const err = document.getElementById('err');
    const rows = document.getElementById('rows');
    const meta = document.getElementById('meta');
    const mTotal = document.getElementById('m-total');
    const mOnline = document.getElementById('m-online');
    const mTrusted = document.getElementById('m-trusted');
    const mAnomaly = document.getElementById('m-anomaly');
    const key = 'aneti:web:token';
    tokenInput.value = localStorage.getItem(key) || '';

    const fmtTime = (t) => new Date(t).toLocaleString();
    const setErr = (msg) => { err.textContent = msg || ''; };

    const render = (payload) => {
      mTotal.textContent = String(payload.scanner.totalDevices);
      mOnline.textContent = String(payload.scanner.onlineDevices);
      mTrusted.textContent = String(payload.scanner.trustedDevices);
      mAnomaly.textContent = String(payload.scanner.anomalyDevices);
      meta.textContent = 'Updated: ' + fmtTime(payload.generatedAt);
      rows.innerHTML = payload.devices.map((d) => {
        const name = d.label || d.hostname || '-';
        const vendor = d.vendor || '-';
        const cls = d.status === 'online' ? 'online' : 'offline';
        return '<tr><td class="' + cls + '">' + d.status.toUpperCase() + '</td><td>' + d.ip + '</td><td>' + name + '</td><td>' + vendor + '</td><td>' + fmtTime(d.lastSeen) + '</td></tr>';
      }).join('');
    };

    const fetchStats = async () => {
      const token = tokenInput.value.trim();
      if (!token) {
        setErr('Enter API token to load data.');
        return;
      }
      try {
        const res = await fetch('/api/stats', { headers: { 'Authorization': 'Bearer ' + token } });
        if (!res.ok) {
          setErr('Request failed: ' + res.status + ' (check token)');
          return;
        }
        setErr('');
        render(await res.json());
      } catch (e) {
        setErr(String(e));
      }
    };

    saveBtn.addEventListener('click', () => {
      localStorage.setItem(key, tokenInput.value.trim());
      fetchStats();
    });
    setInterval(fetchStats, 7000);
    fetchStats();
  </script>
</body>
</html>`;

const seedKnownDevices = () => {
  const existing = db.listDevices() as Device[];
  for (const device of existing) {
    baselineDeviceIds.add(device.id);
    if (device.label) {
      labelById.set(device.id, device.label);
    }
  }
};

scanner.onDevices((devices: Device[]) => {
  const trustedIds = new Set(settings.getSecurity().trustedDeviceIds ?? []);
  const labeled = (devices as Device[]).map((device) => ({
    ...device,
    label: labelById.get(device.id) ?? device.label,
    securityState: trustedIds.has(device.id) ? 'trusted' : null,
  }));
  db.syncDevices(labeled as Device[]);
});

seedKnownDevices();
scanner.start({
  intervalMs: scanIntervalMs,
  maxHosts: scanMaxHosts,
  batchSize: scanBatchSize,
});
scannerRunning = true;

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${host}:${port}`);

  if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/dashboard')) {
    writeHtml(response, 200, dashboardHtml());
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/health') {
    if (!requireAuth(request, response)) return;
    writeJson(response, 200, {
      ok: true,
      generatedAt: Date.now(),
      scannerRunning,
      deviceCount: scanner.list().length,
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/stats') {
    if (!requireAuth(request, response)) return;
    writeJson(response, 200, buildStatsPayload());
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/diagnostics') {
    if (!requireAuth(request, response)) return;
    writeJson(response, 200, scanner.diagnostics({ maxHosts: scanMaxHosts }));
    return;
  }

  writeJson(response, 404, { ok: false, error: 'not_found' });
});

server.listen(port, host, () => {
  const token = settings.ensureApiToken();
  console.log(`[aneti-web] listening on http://${host}:${port}`);
  console.log(`[aneti-web] dashboard: http://${host}:${port}/dashboard`);
  console.log(`[aneti-web] token: ${token}`);
});

const shutdown = () => {
  scannerRunning = false;
  scanner.stop();
  server.close(() => process.exit(0));
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
