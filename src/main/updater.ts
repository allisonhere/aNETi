import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { hostname } from 'node:os';

export type DeploymentMode = 'docker' | 'bare-metal';

export type UpdateCheckResult = {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  latestCommitSha: string;
};

export type UpdateStatus = {
  state: 'idle' | 'in_progress' | 'completed' | 'failed';
  step: string;
  stepIndex: number;
  totalSteps: number;
  startedAt: number;
  error: string | null;
};

const GITHUB_API = 'https://api.github.com';
const REPO = 'allisonhere/aNETi';

export const detectDeploymentMode = (): DeploymentMode =>
  existsSync('/.dockerenv') ? 'docker' : 'bare-metal';

export const getCurrentVersion = (): string => {
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
};

const compareSemver = (current: string, latest: string): boolean => {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map(Number);
  const [cMaj, cMin, cPat] = parse(current);
  const [lMaj, lMin, lPat] = parse(latest);
  if (lMaj !== cMaj) return lMaj > cMaj;
  if (lMin !== cMin) return lMin > cMin;
  return lPat > cPat;
};

const getLocalCommitSha = (): string => {
  try {
    return execSync('git rev-parse HEAD', { cwd: process.cwd(), encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};

export const checkForUpdate = async (): Promise<UpdateCheckResult> => {
  const currentVersion = getCurrentVersion();
  const localSha = getLocalCommitSha();

  const [pkgRes, commitRes] = await Promise.all([
    fetch(`${GITHUB_API}/repos/${REPO}/contents/package.json?ref=main`, {
      headers: { Accept: 'application/vnd.github.v3.raw', 'User-Agent': 'aneti-updater' },
    }),
    fetch(`${GITHUB_API}/repos/${REPO}/commits/main`, {
      headers: { Accept: 'application/vnd.github.v3+json', 'User-Agent': 'aneti-updater' },
    }),
  ]);

  if (!pkgRes.ok) throw new Error(`GitHub API error: ${pkgRes.status}`);
  if (!commitRes.ok) throw new Error(`GitHub API error: ${commitRes.status}`);

  const remotePkg = JSON.parse(await pkgRes.text());
  const latestVersion: string = remotePkg.version ?? '0.0.0';

  const commitData = (await commitRes.json()) as { sha: string };
  const latestCommitSha = commitData.sha ?? '';

  const newerVersion = compareSemver(currentVersion, latestVersion);
  const differentCommit = localSha !== '' && latestCommitSha !== '' && localSha !== latestCommitSha;

  return {
    currentVersion,
    latestVersion,
    updateAvailable: newerVersion || differentCommit,
    latestCommitSha,
  };
};

export const getUpdateStatus = (dataDir: string): UpdateStatus => {
  const statusPath = join(dataDir, '.update-status');
  try {
    const raw = readFileSync(statusPath, 'utf8');
    return JSON.parse(raw) as UpdateStatus;
  } catch {
    return { state: 'idle', step: '', stepIndex: 0, totalSteps: 0, startedAt: 0, error: null };
  }
};

export const clearStaleStatus = (dataDir: string) => {
  const statusPath = join(dataDir, '.update-status');
  try {
    if (!existsSync(statusPath)) return;
    const raw = readFileSync(statusPath, 'utf8');
    const status = JSON.parse(raw) as UpdateStatus;
    if (status.state === 'in_progress') {
      // Process just started and status says in_progress — the update completed
      // (Docker: old container exited, helper replaced it, we're the new container)
      writeFileSync(statusPath, JSON.stringify({
        state: 'completed', step: 'done', stepIndex: status.totalSteps, totalSteps: status.totalSteps, startedAt: status.startedAt, error: null,
      }));
    } else if (status.state === 'completed') {
      const stat = statSync(statusPath);
      if (Date.now() - stat.mtimeMs > 60_000) {
        writeFileSync(statusPath, JSON.stringify({
          state: 'idle', step: '', stepIndex: 0, totalSteps: 0, startedAt: 0, error: null,
        }));
      }
    }
  } catch {
    // ignore
  }
};

const DOCKER_SOCKET = '/var/run/docker.sock';
const DOCKER_IMAGE = 'ghcr.io/allisonhere/aneti';

export const isDockerSocketAvailable = (): boolean =>
  existsSync(DOCKER_SOCKET);

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
        res.on('data', (c) => chunks.push(c));
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

const pullImage = (image: string, tag: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath: DOCKER_SOCKET,
        path: `/images/create?fromImage=${encodeURIComponent(image)}&tag=${encodeURIComponent(tag)}`,
        method: 'POST',
      },
      (res) => {
        // Docker streams JSON progress lines; consume until EOF
        res.on('data', () => {});
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) resolve();
          else reject(new Error(`Image pull failed: HTTP ${res.statusCode}`));
        });
      },
    );
    req.on('error', reject);
    req.end();
  });

const performDockerUpdate = async (dataDir: string): Promise<{ ok: boolean; error?: string }> => {
  const statusPath = join(dataDir, '.update-status');

  const writeStatus = (state: string, step: string, stepIndex: number) => {
    writeFileSync(statusPath, JSON.stringify({
      state, step, stepIndex, totalSteps: 3, startedAt: Date.now(), error: null,
    }));
  };

  try {
    writeStatus('in_progress', 'Pulling latest image', 1);
    await pullImage(DOCKER_IMAGE, 'latest');

    writeStatus('in_progress', 'Inspecting container', 2);
    const selfId = hostname();
    const inspect = await dockerRequest('GET', `/containers/${selfId}/json`);
    if (inspect.status !== 200) {
      throw new Error(`Cannot inspect self (${selfId}): HTTP ${inspect.status}`);
    }

    const containerInfo = inspect.data;
    const containerName = (containerInfo.Name ?? '').replace(/^\//, '');
    const config = containerInfo.Config ?? {};
    const hostConfig = containerInfo.HostConfig ?? {};
    const networkSettings = containerInfo.NetworkSettings ?? {};

    // Build the create config for the replacement container
    const createConfig: Record<string, any> = {
      Image: `${DOCKER_IMAGE}:latest`,
      Env: config.Env ?? [],
      ExposedPorts: config.ExposedPorts ?? {},
      Labels: config.Labels ?? {},
      Volumes: config.Volumes ?? {},
      HostConfig: {
        ...hostConfig,
        // Ensure docker socket is mounted in new container too
        Binds: hostConfig.Binds ?? [],
      },
      NetworkingConfig: {},
    };

    // Preserve the primary network
    const networks = networkSettings.Networks ?? {};
    const networkNames = Object.keys(networks);
    if (networkNames.length > 0) {
      const primary = networkNames[0]!;
      createConfig.NetworkingConfig = {
        EndpointsConfig: {
          [primary]: {
            IPAMConfig: networks[primary].IPAMConfig ?? undefined,
          },
        },
      };
    }

    writeStatus('in_progress', 'Spawning update helper', 3);

    // Spawn helper container from the new image
    const helperConfig = {
      Image: `${DOCKER_IMAGE}:latest`,
      Cmd: ['node', 'out/web/update-helper.js'],
      Env: [
        `ANETI_UPDATE_TARGET=${selfId}`,
        `ANETI_UPDATE_CONFIG=${JSON.stringify(createConfig)}`,
        `ANETI_UPDATE_NAME=${containerName}`,
      ],
      HostConfig: {
        Binds: [`${DOCKER_SOCKET}:${DOCKER_SOCKET}`],
        AutoRemove: true,
        NetworkMode: 'none',
      },
    };

    const helperRes = await dockerRequest('POST', '/containers/create?name=aneti-updater', helperConfig);
    if (helperRes.status !== 201) {
      // If name conflict, try removing stale helper first
      if (helperRes.status === 409) {
        await dockerRequest('DELETE', '/containers/aneti-updater?force=true');
        const retry = await dockerRequest('POST', '/containers/create?name=aneti-updater', helperConfig);
        if (retry.status !== 201) throw new Error(`Helper create retry failed: HTTP ${retry.status}`);
        await dockerRequest('POST', `/containers/${retry.data.Id}/start`);
      } else {
        throw new Error(`Helper create failed: HTTP ${helperRes.status} — ${JSON.stringify(helperRes.data)}`);
      }
    } else {
      await dockerRequest('POST', `/containers/${helperRes.data.Id}/start`);
    }

    writeStatus('in_progress', 'Restarting', 3);

    // Give helper time to start, then exit so the old container stops
    setTimeout(() => process.exit(0), 2000);

    return { ok: true };
  } catch (err) {
    writeFileSync(statusPath, JSON.stringify({
      state: 'failed', step: 'Docker update failed', stepIndex: 0, totalSteps: 3,
      startedAt: Date.now(), error: String((err as Error).message ?? err),
    }));
    return { ok: false, error: String((err as Error).message ?? err) };
  }
};

export const performUpdate = (installDir: string, dataDir: string): { ok: boolean; error?: string } | Promise<{ ok: boolean; error?: string }> => {
  const mode = detectDeploymentMode();
  if (mode === 'docker') {
    if (!isDockerSocketAvailable()) {
      return { ok: false, error: 'Docker socket not mounted. Add /var/run/docker.sock volume for one-click updates.' };
    }
    return performDockerUpdate(dataDir);
  }

  const status = getUpdateStatus(dataDir);
  if (status.state === 'in_progress') {
    return { ok: false, error: 'Update already in progress' };
  }

  const statusPath = join(dataDir, '.update-status');
  const scriptPath = join(dataDir, '.update.sh');

  const script = `#!/usr/bin/env bash
set -e

STATUS_FILE="${statusPath}"
INSTALL_DIR="${installDir}"
TOTAL_STEPS=5

write_status() {
  local state="$1" step="$2" index="$3" error="$4"
  cat > "$STATUS_FILE" <<EOFSTATUS
{"state":"$state","step":"$step","stepIndex":$index,"totalSteps":$TOTAL_STEPS,"startedAt":${Date.now()},"error":$error}
EOFSTATUS
}

trap 'write_status "failed" "unexpected error" 0 "\\"Update script failed at step: $CURRENT_STEP\\""; exit 1' ERR

CURRENT_STEP="git fetch"
write_status "in_progress" "git fetch + reset" 1 "null"
cd "$INSTALL_DIR"
git fetch origin
git reset --hard origin/main

CURRENT_STEP="npm ci"
write_status "in_progress" "npm ci" 2 "null"
npm ci

CURRENT_STEP="build"
write_status "in_progress" "npm run build:web" 3 "null"
npm run build:web

CURRENT_STEP="prune"
write_status "in_progress" "npm prune --omit=dev" 4 "null"
npm prune --omit=dev

CURRENT_STEP="restart"
write_status "completed" "done" 5 "null"
sleep 1
systemctl restart aneti-web || true
`;

  writeFileSync(scriptPath, script, { mode: 0o755 });
  writeFileSync(statusPath, JSON.stringify({
    state: 'in_progress', step: 'starting', stepIndex: 0, totalSteps: 5, startedAt: Date.now(), error: null,
  }));

  const child = spawn('bash', [scriptPath], {
    detached: true,
    stdio: 'ignore',
    cwd: installDir,
  });
  child.unref();

  return { ok: true };
};
