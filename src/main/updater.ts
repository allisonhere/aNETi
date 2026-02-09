import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, execSync } from 'node:child_process';

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
    if (status.state === 'completed') {
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

export const performUpdate = (installDir: string, dataDir: string): { ok: boolean; error?: string } => {
  const mode = detectDeploymentMode();
  if (mode === 'docker') {
    return { ok: false, error: 'Self-update is not available in Docker mode' };
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

CURRENT_STEP="git pull"
write_status "in_progress" "git pull --ff-only" 1 "null"
cd "$INSTALL_DIR"
git pull --ff-only

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
