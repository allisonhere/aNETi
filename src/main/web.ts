import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join, normalize, extname } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { createScanner, sendWakeOnLan } from './scanner.js';
import { createDatabase } from './db.js';
import { createSettingsStore } from './settings.js';
import { createAiClient } from './ai.js';
import type { Device } from './types.js';

const env = process.env;
const host = env.ANETI_WEB_HOST ?? '0.0.0.0';
const port = Number(env.ANETI_WEB_PORT ?? 8787);
const scanIntervalMs = Number(env.ANETI_SCAN_INTERVAL_MS ?? 8000);
const scanMaxHosts = Number(env.ANETI_SCAN_MAX_HOSTS ?? 1024);
const scanBatchSize = Number(env.ANETI_SCAN_BATCH_SIZE ?? 64);
const dataDir = env.ANETI_DATA_DIR ?? '/var/lib/aneti';
const rendererDir = env.ANETI_RENDERER_DIR ?? join(process.cwd(), 'dist/renderer');
const disableAuth = env.ANETI_WEB_DISABLE_AUTH === '1';

mkdirSync(dataDir, { recursive: true });

const db = await createDatabase(join(dataDir, 'aneti.sqlite'));
const settings = createSettingsStore(join(dataDir, 'settings.json'));
const scanner = createScanner();
const ai = createAiClient((provider) => settings.getSecret(provider));
const labelById = new Map<string, string>();
const baselineDeviceIds = new Set<string>();
const lastSummaryAtById = new Map<string, number>();
const aiQueue: Device[] = [];
let aiWorking = false;
let latestSummary: { text: string; provider: string; model: string; deviceId: string; createdAt: number } | null = null;
const aiSummaryCooldownMs = 60_000;
let scannerRunning = false;

const mimeByExt: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

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
  if (typeof headerToken === 'string') return headerToken.trim();
  return null;
};

const writeJson = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
};

const writeText = (response: ServerResponse, status: number, body: string, contentType: string) => {
  response.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
  });
  response.end(body);
};

const parseJsonBody = async (request: IncomingMessage): Promise<any> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
};

const requireAuth = (request: IncomingMessage, response: ServerResponse) => {
  if (disableAuth) return true;
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
  const trusted = devices.filter((item) => trustedIds.has(item.id)).length;
  const anomalies = devices.filter((item) => item.status === 'online' && !trustedIds.has(item.id)).length;
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
    devices,
  };
};

const processAiQueue = async () => {
  if (aiWorking) return;
  aiWorking = true;
  try {
    while (aiQueue.length > 0) {
      const device = aiQueue.shift();
      if (!device) continue;
      const snapshot = scanner.list();
      const onlineDevices = snapshot.filter((item) => item.status === 'online').length;
      const totalDevices = snapshot.length;
      const detectedAt = device.lastSeen ?? Date.now();

      const summary = await ai.summarizeNewDevice({
        device,
        totalDevices,
        onlineDevices,
        detectedAt,
      });

      if (!summary) continue;
      const createdAt = Date.now();
      db.addAlert({
        type: 'ai_summary',
        message: summary.text,
        deviceId: device.id,
        createdAt,
      });
      latestSummary = { ...summary, deviceId: device.id, createdAt };
    }
  } finally {
    aiWorking = false;
  }
};

const bridgeScript = () => `(() => {
  const authDisabled = ${disableAuth ? 'true' : 'false'};
  const key = 'aneti:web:token';
  const meta = { preload: true, version: 'web-bridge-1' };
  window.anetiMeta = meta;

  const loadToken = () => localStorage.getItem(key) || '';
  const saveToken = (v) => localStorage.setItem(key, v || '');
  const ensureToken = () => {
    if (authDisabled) return '';
    const fromUrl = new URLSearchParams(location.search).get('token');
    if (fromUrl && fromUrl.trim()) {
      saveToken(fromUrl.trim());
      return fromUrl.trim();
    }
    let token = loadToken().trim();
    if (!token) {
      token = (prompt('Enter AnetI API token') || '').trim();
      if (token) saveToken(token);
    }
    return token;
  };

  const req = async (method, path, body) => {
    let token = ensureToken();
    const run = async () => fetch(path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(!authDisabled && token ? { Authorization: 'Bearer ' + token } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let res = await run();
    if (res.status === 401) {
      token = (prompt('API token invalid. Enter token again') || '').trim();
      saveToken(token);
      res = await run();
    }
    if (!res.ok) throw new Error(method + ' ' + path + ' failed: ' + res.status);
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return res.json();
    return null;
  };

  const onDevices = (callback) => {
    let active = true;
    const tick = async () => {
      if (!active) return;
      try {
        const devices = await req('GET', '/api/scanner/list');
        callback(devices);
      } catch {}
    };
    tick();
    const timer = setInterval(tick, 4000);
    return () => { active = false; clearInterval(timer); };
  };

  window.aneti = {
    startScan: (options) => req('POST', '/api/scanner/start', options || {}),
    stopScan: () => req('POST', '/api/scanner/stop', {}),
    listDevices: () => req('GET', '/api/scanner/list'),
    listStoredDevices: () => req('GET', '/api/db/devices'),
    listAlerts: (limit) => req('GET', '/api/db/alerts?limit=' + (limit || 50)),
    listSightings: (deviceId, limit) => req('GET', '/api/db/sightings?deviceId=' + encodeURIComponent(deviceId) + '&limit=' + (limit || 30)),
    updateDeviceLabel: (id, label) => req('POST', '/api/db/label', { id, label }),
    diagnostics: (options) => req('GET', '/api/scanner/diagnostics?maxHosts=' + (options?.maxHosts || '')),
    onDevices,
    onSummary: (callback) => {
      let active = true;
      let lastCreatedAt = 0;
      const poll = async () => {
        if (!active) return;
        try {
          const data = await req('GET', '/api/ai/summary');
          if (data && data.createdAt && data.createdAt > lastCreatedAt) {
            lastCreatedAt = data.createdAt;
            callback(data);
          }
        } catch {}
      };
      poll();
      const t = setInterval(poll, 8000);
      return () => { active = false; clearInterval(t); };
    },
    settingsGet: () => req('GET', '/api/settings'),
    settingsUpdate: (provider, key) => req('POST', '/api/settings/provider', { provider, key }),
    settingsUpdateAccent: (accentId) => req('POST', '/api/settings/accent', { accentId }),
    settingsUpdateAlerts: (patch) => req('POST', '/api/settings/alerts', patch || {}),
    settingsSetDeviceMuted: (deviceId, muted) => req('POST', '/api/settings/mute-device', { deviceId, muted }),
    settingsSetDeviceTrusted: (deviceId, trusted) => req('POST', '/api/settings/trust-device', { deviceId, trusted }),
    settingsUpdateIntegration: (patch) => req('POST', '/api/settings/integration', patch || {}),
    settingsApiToken: () => req('GET', '/api/settings/api-token'),
    settingsRotateApiToken: () => req('POST', '/api/settings/api-token/rotate', {}),
    settingsTestNotification: async () => ({ ok: false, reason: 'unsupported_in_web_mode' }),
    wakeDevice: (mac) => req('POST', '/api/device/wake', { mac }),
    copyText: (value) => navigator.clipboard?.writeText(String(value || '')).catch(() => {}),
  };
})();`;

const serveRendererIndex = (response: ServerResponse) => {
  const indexPath = join(rendererDir, 'index.html');
  if (!existsSync(indexPath)) {
    writeText(
      response,
      503,
      'Renderer build not found. Run: npm run build',
      'text/plain; charset=utf-8'
    );
    return;
  }

  let html = readFileSync(indexPath, 'utf8');
  if (!html.includes('/bridge.js')) {
    html = html.replace('</head>', '  <script src="/bridge.js"></script>\n</head>');
  }
  writeText(response, 200, html, 'text/html; charset=utf-8');
};

const serveStatic = (urlPath: string, response: ServerResponse): boolean => {
  const normalizedPath = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(rendererDir, normalizedPath);
  if (!filePath.startsWith(rendererDir) || !existsSync(filePath)) return false;
  const stats = statSync(filePath);
  if (!stats.isFile()) return false;
  const ext = extname(filePath).toLowerCase();
  const contentType = mimeByExt[ext] ?? 'application/octet-stream';
  response.writeHead(200, {
    'content-type': contentType,
    'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=300',
  });
  response.end(readFileSync(filePath));
  return true;
};

const seedKnownDevices = () => {
  const existing = db.listDevices() as Device[];
  for (const device of existing) {
    baselineDeviceIds.add(device.id);
    if (device.label) labelById.set(device.id, device.label);
  }
};

scanner.onDevices((devices: Device[]) => {
  const trustedIds = new Set(settings.getSecurity().trustedDeviceIds ?? []);
  const labeled = devices.map((device) => ({
    ...device,
    label: labelById.get(device.id) ?? device.label,
    securityState: trustedIds.has(device.id) ? 'trusted' : null,
  }));
  db.syncDevices(labeled as Device[]);

  const now = Date.now();
  for (const device of labeled as Device[]) {
    if (device.status !== 'online') continue;
    if (baselineDeviceIds.has(device.id)) continue;
    const lastSummaryAt = lastSummaryAtById.get(device.id) ?? 0;
    if (now - lastSummaryAt < aiSummaryCooldownMs) continue;
    lastSummaryAtById.set(device.id, now);
    baselineDeviceIds.add(device.id);
    aiQueue.push(device);
  }
  void processAiQueue();
});

seedKnownDevices();
scanner.start({
  intervalMs: scanIntervalMs,
  maxHosts: scanMaxHosts,
  batchSize: scanBatchSize,
});
scannerRunning = true;

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${host}:${port}`);

  if (request.method === 'GET' && url.pathname === '/bridge.js') {
    writeText(response, 200, bridgeScript(), 'text/javascript; charset=utf-8');
    return;
  }

  if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/app' || url.pathname === '/dashboard')) {
    serveRendererIndex(response);
    return;
  }

  if (request.method === 'GET' && url.pathname.startsWith('/assets/')) {
    if (serveStatic(url.pathname, response)) return;
  }

  if (url.pathname.startsWith('/api/')) {
    if (!requireAuth(request, response)) return;

    if (request.method === 'GET' && url.pathname === '/api/health') {
      writeJson(response, 200, {
        ok: true,
        generatedAt: Date.now(),
        scannerRunning,
        deviceCount: scanner.list().length,
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/stats') {
      writeJson(response, 200, buildStatsPayload());
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/scanner/list') {
      writeJson(response, 200, scanner.list());
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/scanner/start') {
      const body = await parseJsonBody(request);
      scanner.start(body ?? {});
      scannerRunning = true;
      writeJson(response, 200, { ok: true });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/scanner/stop') {
      scanner.stop();
      scannerRunning = false;
      writeJson(response, 200, { ok: true });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/scanner/diagnostics') {
      const maxHosts = Number(url.searchParams.get('maxHosts') ?? scanMaxHosts);
      writeJson(response, 200, scanner.diagnostics({ maxHosts }));
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/ai/summary') {
      if (latestSummary) {
        writeJson(response, 200, latestSummary);
      } else {
        const alerts = db.listAlerts(50) as Array<{ type: string; message: string; deviceId?: string | null; createdAt: number }>;
        const last = alerts.find((a) => a.type === 'ai_summary');
        if (last) {
          writeJson(response, 200, {
            text: last.message,
            provider: 'unknown',
            model: 'unknown',
            deviceId: last.deviceId ?? '',
            createdAt: last.createdAt,
          });
        } else {
          writeJson(response, 200, null);
        }
      }
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/db/devices') {
      writeJson(response, 200, db.listDevices());
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/db/alerts') {
      const limit = Number(url.searchParams.get('limit') ?? 50);
      writeJson(response, 200, db.listAlerts(limit));
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/db/sightings') {
      const deviceId = url.searchParams.get('deviceId') ?? '';
      const limit = Number(url.searchParams.get('limit') ?? 30);
      writeJson(response, 200, db.listSightingsByDevice(deviceId, limit));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/db/label') {
      const body = await parseJsonBody(request);
      const id = String(body?.id ?? '');
      const label = body?.label == null ? null : String(body.label);
      const result = db.updateDeviceLabel(id, label);
      if (label && label.trim().length > 0) {
        labelById.set(id, label.trim());
      } else {
        labelById.delete(id);
      }
      writeJson(response, 200, result);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/device/wake') {
      const body = await parseJsonBody(request);
      const mac = String(body?.mac ?? '');
      const result = await sendWakeOnLan(mac);
      writeJson(response, 200, result);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/settings') {
      writeJson(response, 200, settings.getPublic());
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/settings/provider') {
      const body = await parseJsonBody(request);
      writeJson(response, 200, settings.updateProvider(body.provider, body.key ?? null));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/settings/accent') {
      const body = await parseJsonBody(request);
      writeJson(response, 200, settings.updateAccent(body.accentId ?? null));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/settings/alerts') {
      const body = await parseJsonBody(request);
      writeJson(response, 200, settings.updateAlerts(body ?? {}));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/settings/mute-device') {
      const body = await parseJsonBody(request);
      writeJson(response, 200, settings.setDeviceMuted(String(body.deviceId ?? ''), Boolean(body.muted)));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/settings/trust-device') {
      const body = await parseJsonBody(request);
      writeJson(response, 200, settings.setDeviceTrusted(String(body.deviceId ?? ''), Boolean(body.trusted)));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/settings/integration') {
      const body = await parseJsonBody(request);
      writeJson(response, 200, settings.updateIntegration(body ?? {}));
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/settings/api-token') {
      writeJson(response, 200, { token: settings.ensureApiToken() });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/settings/api-token/rotate') {
      writeJson(response, 200, { token: settings.rotateApiToken() });
      return;
    }
  }

  if (serveStatic(url.pathname, response)) return;
  writeJson(response, 404, { ok: false, error: 'not_found' });
});

server.listen(port, host, () => {
  const token = settings.ensureApiToken();
  console.log(`[aneti-web] listening on http://${host}:${port}`);
  console.log(`[aneti-web] app: http://${host}:${port}/app`);
  if (disableAuth) {
    console.log('[aneti-web] auth: disabled (ANETI_WEB_DISABLE_AUTH=1)');
  } else {
    console.log(`[aneti-web] token: ${token}`);
  }
});

const shutdown = () => {
  scannerRunning = false;
  scanner.stop();
  server.close(() => process.exit(0));
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
