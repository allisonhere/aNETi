#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
AnetI Proxmox helper installer (Debian/Ubuntu guest)

Usage:
  proxmox-install.sh [--repo owner/name] [--branch name] [--dir path] [--skip-build]

Examples:
  proxmox-install.sh
  proxmox-install.sh --repo allisonhere/aNETi --branch main --dir /opt/aneti
EOF
}

REPO="allisonhere/aNETi"
BRANCH="main"
INSTALL_DIR="/opt/aneti"
SKIP_BUILD=0

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

cat <<EOF

[aneti] Done.
- Source: $INSTALL_DIR
- Start dev UI: cd $INSTALL_DIR && npm run dev
- Build output: $INSTALL_DIR/out and $INSTALL_DIR/dist

If this is a headless Proxmox guest, run the app with a desktop session or X/Wayland forwarding.
EOF
