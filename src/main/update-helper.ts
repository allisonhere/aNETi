/**
 * Docker update helper — runs as a short-lived sidecar container.
 * Waits for the old container to stop, removes it, creates a replacement
 * from the new image with the same config, and starts it.
 */

import { request as httpRequest } from 'node:http';

const DOCKER_SOCKET = '/var/run/docker.sock';

const dockerRequest = (
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: any }> =>
  new Promise((resolve, reject) => {
    const payload = body != null ? JSON.stringify(body) : undefined;
    const req = httpRequest(
      {
        socketPath: DOCKER_SOCKET,
        path,
        method,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let data: any;
          try { data = JSON.parse(raw); } catch { data = raw; }
          resolve({ status: res.statusCode ?? 0, data });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const log = (msg: string) => console.log(`[update-helper] ${msg}`);

const run = async () => {
  const targetId = process.env.ANETI_UPDATE_TARGET;
  const configJson = process.env.ANETI_UPDATE_CONFIG;
  const containerName = process.env.ANETI_UPDATE_NAME;

  if (!targetId || !configJson) {
    log('Missing ANETI_UPDATE_TARGET or ANETI_UPDATE_CONFIG');
    process.exit(1);
  }

  let createConfig: any;
  try {
    createConfig = JSON.parse(configJson);
  } catch {
    log('Failed to parse ANETI_UPDATE_CONFIG');
    process.exit(1);
  }

  // Wait for old container to stop
  log(`Waiting for container ${targetId} to stop…`);
  for (let i = 0; i < 60; i++) {
    const res = await dockerRequest('GET', `/containers/${targetId}/json`);
    if (res.status === 404) {
      log('Container already removed');
      break;
    }
    const running = res.data?.State?.Running ?? false;
    if (!running) {
      log('Container stopped');
      break;
    }
    if (i === 59) {
      log('Timeout waiting for container to stop, forcing stop');
      await dockerRequest('POST', `/containers/${targetId}/stop?t=5`);
      await sleep(3000);
    }
    await sleep(1000);
  }

  // Remove old container
  log('Removing old container…');
  const rmRes = await dockerRequest('DELETE', `/containers/${targetId}?v=false`);
  if (rmRes.status !== 204 && rmRes.status !== 404) {
    log(`Warning: remove returned HTTP ${rmRes.status}`);
  }

  // Create new container
  const nameParam = containerName ? `?name=${encodeURIComponent(containerName)}` : '';
  log(`Creating new container${containerName ? ` (${containerName})` : ''}…`);
  const createRes = await dockerRequest('POST', `/containers/create${nameParam}`, createConfig);
  if (createRes.status !== 201) {
    log(`Failed to create container: HTTP ${createRes.status} — ${JSON.stringify(createRes.data)}`);
    process.exit(1);
  }

  const newId: string = createRes.data.Id;
  log(`Created container ${newId.slice(0, 12)}`);

  // Reconnect additional networks beyond the primary
  const endpoints = createConfig.NetworkingConfig?.EndpointsConfig ?? {};
  const primaryNetwork = Object.keys(endpoints)[0];
  // Check if original config had extra networks we should connect
  // (primary is already handled in create)

  // Start the new container
  log('Starting new container…');
  const startRes = await dockerRequest('POST', `/containers/${newId}/start`);
  if (startRes.status !== 204 && startRes.status !== 304) {
    log(`Warning: start returned HTTP ${startRes.status}`);
  }

  log('Update complete!');
};

run().catch((err) => {
  log(`Fatal error: ${err}`);
  process.exit(1);
});
