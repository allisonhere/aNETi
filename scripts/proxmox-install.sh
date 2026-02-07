#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
AnetI Proxmox helper installer (Debian/Ubuntu guest)

Usage:
  proxmox-install.sh [--repo owner/name] [--branch name] [--dir path] [--skip-build] [--web-service]

Examples:
  proxmox-install.sh
  proxmox-install.sh --repo allisonhere/aNETi --branch main --dir /opt/aneti
EOF
}

REPO="allisonhere/aNETi"
BRANCH="main"
INSTALL_DIR="/opt/aneti"
SKIP_BUILD=0
WEB_SERVICE=0
WEB_HOST="0.0.0.0"
WEB_PORT="8787"
WEB_DATA_DIR="/var/lib/aneti"

while [ $# -gt 0 ]; do
  case "$1" in
    --repo)
      REPO="${2:-}"
      shift 2
      ;;
    --branch)
      BRANCH="${2:-}"
      shift 2
      ;;
    --dir)
      INSTALL_DIR="${2:-}"
      shift 2
      ;;
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    --web-service)
      WEB_SERVICE=1
      shift
      ;;
    --web-host)
      WEB_HOST="${2:-}"
      shift 2
      ;;
    --web-port)
      WEB_PORT="${2:-}"
      shift 2
      ;;
    --web-data-dir)
      WEB_DATA_DIR="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root (or with sudo)." >&2
  exit 1
fi

if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
else
  echo "Cannot detect OS. /etc/os-release not found." >&2
  exit 1
fi

case "${ID:-}" in
  debian|ubuntu)
    ;;
  *)
    echo "Unsupported OS: ${ID:-unknown}. This script supports Debian/Ubuntu guests." >&2
    exit 1
    ;;
esac

APT_PKGS=(
  ca-certificates
  curl
  git
  build-essential
  python3
  make
  g++
  pkg-config
  iputils-ping
  iproute2
  net-tools
  libnss3
  libatk-bridge2.0-0
  libgtk-3-0
  libxss1
  libasound2
  libgbm1
  libdrm2
  libxshmfence1
  libx11-xcb1
  libxcb-dri3-0
  libxrandr2
  libxcomposite1
  libxdamage1
  libxfixes3
  libatspi2.0-0
  libxkbcommon0
)

echo "[aneti] Installing system dependencies..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y "${APT_PKGS[@]}"

if ! command -v node >/dev/null 2>&1 || ! node -v | grep -Eq '^v(20|21|22)\.'; then
  echo "[aneti] Installing Node.js 20.x..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

if [ -d "$INSTALL_DIR/.git" ]; then
  echo "[aneti] Updating existing checkout in $INSTALL_DIR..."
  git -C "$INSTALL_DIR" fetch origin
  git -C "$INSTALL_DIR" checkout "$BRANCH"
  git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH"
else
  echo "[aneti] Cloning repository to $INSTALL_DIR..."
  rm -rf "$INSTALL_DIR"
  git clone --branch "$BRANCH" "https://github.com/$REPO.git" "$INSTALL_DIR"
fi

echo "[aneti] Installing npm dependencies..."
npm --prefix "$INSTALL_DIR" ci

if [ "$SKIP_BUILD" -eq 0 ]; then
  echo "[aneti] Building app..."
  npm --prefix "$INSTALL_DIR" run build
fi

if [ "$WEB_SERVICE" -eq 1 ]; then
  echo "[aneti] Building web service runtime..."
  npm --prefix "$INSTALL_DIR" run build:web

  echo "[aneti] Installing systemd service: aneti-web.service"
  cat >/etc/systemd/system/aneti-web.service <<EOF
[Unit]
Description=AnetI Headless Web Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
Environment=ANETI_WEB_HOST=${WEB_HOST}
Environment=ANETI_WEB_PORT=${WEB_PORT}
Environment=ANETI_DATA_DIR=${WEB_DATA_DIR}
ExecStart=/usr/bin/env npm run start:web
Restart=always
RestartSec=2
User=root
Group=root

[Install]
WantedBy=multi-user.target
EOF

  mkdir -p "$WEB_DATA_DIR"

  if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload
    systemctl enable --now aneti-web.service
  else
    echo "[aneti] Warning: systemctl not found. Service file created but not started."
  fi
fi

TOKEN=""
SETTINGS_PATH="${WEB_DATA_DIR}/settings.json"
if [ -f "$SETTINGS_PATH" ]; then
  TOKEN="$(node -e "const fs=require('fs');const p=process.argv[1];const j=JSON.parse(fs.readFileSync(p,'utf8'));process.stdout.write(String(j?.integration?.apiToken||''));" "$SETTINGS_PATH" 2>/dev/null || true)"
fi

cat <<EOF

[aneti] Done.
- Source: $INSTALL_DIR
- Start dev UI: cd $INSTALL_DIR && npm run dev
- Build output: $INSTALL_DIR/out and $INSTALL_DIR/dist
EOF

if [ "$WEB_SERVICE" -eq 1 ]; then
  echo "- Web app: http://<ct-ip>:${WEB_PORT}/app"
  if [ -n "$TOKEN" ]; then
    echo "- API token: ${TOKEN}"
  else
    echo "- API token file: ${SETTINGS_PATH}"
  fi
  echo "- Service status: systemctl status aneti-web.service"
else
  echo "If this is a headless Proxmox guest, run the app with a desktop session or X/Wayland forwarding."
fi
