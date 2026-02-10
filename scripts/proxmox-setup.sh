#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
AnetI Proxmox setup script.

Auto-detects context:
  - On Proxmox host (pct available): creates an LXC, then installs inside it
  - Inside a VM/LXC guest:           installs directly

Usage:
  proxmox-setup.sh [options]

LXC creation options (host only):
  --vmid ID                 LXC VMID (default: next available)
  --hostname NAME           Container hostname (default: aneti)
  --storage NAME            Rootfs storage (default: auto-detect)
  --template-storage NAME   Template storage (default: auto-detect)
  --bridge NAME             Network bridge (default: vmbr0)
  --disk-gb N               Root disk size GB (default: 12)
  --memory-mb N             Memory MB (default: 2048)
  --cores N                 CPU cores (default: 2)
  --password PASS           Root password (default: auto-generated)
  --password-file PATH      Write CT login details to this file
  --template NAME           Template filename (default: latest debian-12-standard)
  --no-start                Create CT but do not start or install

Install options:
  --repo OWNER/REPO         GitHub repo (default: allisonhere/aNETi)
  --branch NAME             Git branch (default: main)
  --dir PATH                Install dir (default: /opt/aneti)
  --web-service             Enable headless web service (default on LXC, off on guest)
  --no-web-service          Skip headless web service
  --web-port N              Web service port (default: 8787)
  --web-require-auth        Enable API token auth (disabled by default)
  --web-disable-auth        Disable API token auth (default)
  --skip-build              Skip build step
  --install-only            Force guest-mode install even on a Proxmox host

Examples:
  # On Proxmox host -- creates LXC + installs
  proxmox-setup.sh --vmid 120 --bridge vmbr0

  # Inside existing VM/LXC -- installs directly
  proxmox-setup.sh --web-service

  # Pipe from GitHub
  curl -fsSL https://raw.githubusercontent.com/allisonhere/aNETi/main/scripts/proxmox-setup.sh | sudo bash -s -- --web-service
EOF
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

random_password() {
  tr -dc 'A-Za-z0-9_@%+=' </dev/urandom | head -c 24 || true
}

storage_exists() {
  pvesm status 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx "$1"
}

pick_storage_by_content() {
  local content="$1" selected
  selected="$(pvesm status -content "$content" 2>/dev/null | awk 'NR>1 && $2=="active" {print $1; exit}')"
  if [ -z "$selected" ]; then
    selected="$(pvesm status -content "$content" 2>/dev/null | awk 'NR>1 {print $1; exit}')"
  fi
  if [ -z "$selected" ]; then
    echo "Could not find any storage with content '${content}'." >&2
    exit 1
  fi
  printf '%s\n' "$selected"
}

pick_debian12_template() {
  local selected
  selected=$(pveam available | awk '/debian-12-standard/ { tpl=$2 } END { print tpl }')
  if [ -z "$selected" ]; then
    echo "Could not find a debian-12-standard template via pveam." >&2
    exit 1
  fi
  printf '%s\n' "$selected"
}

get_ct_ip() {
  local vmid="$1" ip=""
  for _ in $(seq 1 12); do
    ip="$(pct exec "$vmid" -- bash -lc "hostname -I 2>/dev/null | awk '{print \$1}'" 2>/dev/null || true)"
    ip="${ip%% *}"
    if [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      printf '%s\n' "$ip"
      return 0
    fi
    sleep 2
  done
  return 1
}

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------

REPO="allisonhere/aNETi"
BRANCH="main"
INSTALL_DIR="/opt/aneti"
SKIP_BUILD=0
WEB_SERVICE="" # empty = auto (1 on host/lxc-create, 0 on guest)
WEB_HOST="0.0.0.0"
WEB_PORT="8787"
WEB_DATA_DIR="/var/lib/aneti"
WEB_DISABLE_AUTH=1
INSTALL_ONLY=0

# LXC creation options
VMID=""
CT_HOSTNAME="aneti"
STORAGE="auto"
TEMPLATE_STORAGE="auto"
BRIDGE="vmbr0"
DISK_GB="12"
MEMORY_MB="2048"
CORES="2"
PASSWORD=""
PASSWORD_FILE=""
TEMPLATE=""
DO_START=1

while [ $# -gt 0 ]; do
  case "$1" in
  # LXC creation
  --vmid)
    VMID="${2:-}"
    shift 2
    ;;
  --hostname)
    CT_HOSTNAME="${2:-}"
    shift 2
    ;;
  --storage)
    STORAGE="${2:-}"
    shift 2
    ;;
  --template-storage)
    TEMPLATE_STORAGE="${2:-}"
    shift 2
    ;;
  --bridge)
    BRIDGE="${2:-}"
    shift 2
    ;;
  --disk-gb)
    DISK_GB="${2:-}"
    shift 2
    ;;
  --memory-mb)
    MEMORY_MB="${2:-}"
    shift 2
    ;;
  --cores)
    CORES="${2:-}"
    shift 2
    ;;
  --password)
    PASSWORD="${2:-}"
    shift 2
    ;;
  --password-file)
    PASSWORD_FILE="${2:-}"
    shift 2
    ;;
  --template)
    TEMPLATE="${2:-}"
    shift 2
    ;;
  --start)
    DO_START=1
    shift
    ;;
  --no-start)
    DO_START=0
    shift
    ;;
  # Install
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
  --no-web-service)
    WEB_SERVICE=0
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
  --web-disable-auth)
    WEB_DISABLE_AUTH=1
    shift
    ;;
  --web-require-auth)
    WEB_DISABLE_AUTH=0
    shift
    ;;
  --install-only)
    INSTALL_ONLY=1
    shift
    ;;
  --help | -h)
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

# ---------------------------------------------------------------------------
# Detect mode
# ---------------------------------------------------------------------------

HOST_MODE=0
if [ "$INSTALL_ONLY" -eq 0 ] && command -v pct >/dev/null 2>&1; then
  HOST_MODE=1
fi

# Default WEB_SERVICE: on for host-mode (LXC is headless), off for guest
if [ -z "$WEB_SERVICE" ]; then
  if [ "$HOST_MODE" -eq 1 ]; then
    WEB_SERVICE=1
  else
    WEB_SERVICE=0
  fi
fi

# ===========================================================================
# HOST MODE -- create LXC, push this script inside, run it
# ===========================================================================

if [ "$HOST_MODE" -eq 1 ]; then
  for cmd in pct pveam pvesm; do
    command -v "$cmd" >/dev/null 2>&1 || {
      echo "Missing required command: $cmd" >&2
      exit 1
    }
  done

  if [ -z "$VMID" ]; then
    VMID="$(pvesh get /cluster/nextid)"
  fi

  if [ "$TEMPLATE_STORAGE" = "auto" ]; then
    TEMPLATE_STORAGE="$(pick_storage_by_content vztmpl)"
  elif ! storage_exists "$TEMPLATE_STORAGE"; then
    echo "Template storage '${TEMPLATE_STORAGE}' does not exist." >&2
    pvesm status >&2 || true
    exit 1
  fi

  if [ "$STORAGE" = "auto" ]; then
    STORAGE="$(pick_storage_by_content rootdir)"
  elif ! storage_exists "$STORAGE"; then
    echo "CT storage '${STORAGE}' does not exist." >&2
    pvesm status >&2 || true
    exit 1
  fi

  if [ -z "$TEMPLATE" ]; then
    TEMPLATE="$(pick_debian12_template)"
  fi

  [ -z "$PASSWORD" ] && PASSWORD="$(random_password)"
  [ -z "$PASSWORD_FILE" ] && PASSWORD_FILE="/root/aneti-lxc-${VMID}.txt"

  TEMPLATE_VOL="${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}"

  echo "[aneti] Ensuring template exists: ${TEMPLATE_VOL}"
  if ! pvesm list "$TEMPLATE_STORAGE" 2>/dev/null | awk '{print $1}' | grep -qx "${TEMPLATE_VOL}"; then
    echo "[aneti] Downloading template ${TEMPLATE} to ${TEMPLATE_STORAGE}..."
    pveam download "$TEMPLATE_STORAGE" "$TEMPLATE"
  fi

  echo "[aneti] Creating CT ${VMID} (${CT_HOSTNAME})..."
  pct create "$VMID" "$TEMPLATE_VOL" \
    --hostname "$CT_HOSTNAME" \
    --cores "$CORES" \
    --memory "$MEMORY_MB" \
    --swap 512 \
    --rootfs "${STORAGE}:${DISK_GB}" \
    --net0 "name=eth0,bridge=${BRIDGE},ip=dhcp" \
    --ostype debian \
    --onboot 1 \
    --unprivileged 0 \
    --features nesting=1,keyctl=1 \
    --password "$PASSWORD"

  echo "[aneti] CT ${VMID} created."

  cat >"$PASSWORD_FILE" <<CREDEOF
AnetI Proxmox LXC Login
CT_ID=${VMID}
HOSTNAME=${CT_HOSTNAME}
USERNAME=root
PASSWORD=${PASSWORD}
CREDEOF
  chmod 600 "$PASSWORD_FILE"

  if [ "$DO_START" -eq 0 ]; then
    echo "[aneti] Skipping start/install (--no-start)."
    exit 0
  fi

  echo "[aneti] Starting CT ${VMID}..."
  pct start "$VMID"

  echo -n "[aneti] Waiting for network"
  for _ in $(seq 1 30); do
    if pct exec "$VMID" -- ping -c1 -W1 8.8.8.8 >/dev/null 2>&1; then
      echo " ok"
      break
    fi
    echo -n "."
    sleep 2
  done
  echo ""

  # Build install args for guest-mode re-invocation
  INSTALL_ARGS="--install-only --repo ${REPO} --branch ${BRANCH} --dir ${INSTALL_DIR}"
  if [ "$WEB_SERVICE" -eq 1 ]; then
    INSTALL_ARGS="${INSTALL_ARGS} --web-service --web-port ${WEB_PORT} --web-host ${WEB_HOST}"
    if [ "$WEB_DISABLE_AUTH" -eq 1 ]; then
      INSTALL_ARGS="${INSTALL_ARGS} --web-disable-auth"
    fi
  else
    INSTALL_ARGS="${INSTALL_ARGS} --no-web-service"
  fi

  # Push this script into the CT and run it in install-only mode
  SELF=""
  if [ -n "${BASH_SOURCE[0]:-}" ]; then
    SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
  fi
  if [ -n "$SELF" ] && [ -f "$SELF" ]; then
    echo "[aneti] Pushing setup script into CT..."
    pct push "$VMID" "$SELF" /tmp/proxmox-setup.sh --perms 755
    pct exec "$VMID" -- bash -lc "bash /tmp/proxmox-setup.sh ${INSTALL_ARGS}"
  else
    echo "[aneti] Fetching setup script from GitHub..."
    pct exec "$VMID" -- bash -lc "apt-get update -y && apt-get install -y curl ca-certificates && curl -fsSL https://raw.githubusercontent.com/${REPO}/${BRANCH}/scripts/proxmox-setup.sh | bash -s -- ${INSTALL_ARGS}"
  fi

  CT_IP="unknown"
  if ip="$(get_ct_ip "$VMID")"; then
    CT_IP="$ip"
  fi

  cat <<SUMEOF

[aneti] Complete.
- CT ID: ${VMID}
- Hostname: ${CT_HOSTNAME}
- CT IP: ${CT_IP}
- Login: root / ${PASSWORD}
- Login file: ${PASSWORD_FILE}
- Enter CT: pct enter ${VMID}
- App path: ${INSTALL_DIR}
SUMEOF

  if [ "$WEB_SERVICE" -eq 1 ]; then
    if [ "$CT_IP" = "unknown" ]; then
      echo "- Browser app: http://<ct-ip>:${WEB_PORT}/app"
    else
      echo "- Browser app: http://${CT_IP}:${WEB_PORT}/app"
    fi
    if [ "$WEB_DISABLE_AUTH" -eq 1 ]; then
      echo "- Auth: disabled"
    fi
    echo "- Service logs: pct exec ${VMID} -- journalctl -u aneti-web -f"
  fi

  exit 0
fi

# ===========================================================================
# GUEST MODE -- install directly in current system
# ===========================================================================

if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
else
  echo "Cannot detect OS. /etc/os-release not found." >&2
  exit 1
fi

case "${ID:-}" in
debian | ubuntu) ;;
*)
  echo "Unsupported OS: ${ID:-unknown}. This script supports Debian/Ubuntu." >&2
  exit 1
  ;;
esac

APT_PKGS=(
  ca-certificates
  curl
  git
  iputils-ping
  iproute2
  net-tools
)

if [ "$WEB_SERVICE" -eq 0 ]; then
  APT_PKGS+=(
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
fi

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
  git -C "$INSTALL_DIR" reset --hard "origin/$BRANCH"
else
  echo "[aneti] Cloning repository to $INSTALL_DIR..."
  rm -rf "$INSTALL_DIR"
  git clone --branch "$BRANCH" "https://github.com/$REPO.git" "$INSTALL_DIR"
fi

echo "[aneti] Installing npm dependencies..."
npm --prefix "$INSTALL_DIR" ci

if [ "$SKIP_BUILD" -eq 0 ]; then
  if [ "$WEB_SERVICE" -eq 1 ]; then
    echo "[aneti] Building web service..."
    npm --prefix "$INSTALL_DIR" run build:web
  else
    echo "[aneti] Building app..."
    npm --prefix "$INSTALL_DIR" run build
  fi
fi

if [ "$WEB_SERVICE" -eq 1 ]; then
  echo "[aneti] Pruning dev dependencies..."
  npm --prefix "$INSTALL_DIR" prune --omit=dev

  echo "[aneti] Installing systemd service: aneti-web.service"
  cat >/etc/systemd/system/aneti-web.service <<SVCEOF
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
Environment=ANETI_WEB_DISABLE_AUTH=${WEB_DISABLE_AUTH}
ExecStart=/usr/bin/node ${INSTALL_DIR}/out/web/web.js
Restart=always
RestartSec=2
User=root
Group=root

[Install]
WantedBy=multi-user.target
SVCEOF

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

cat <<DONEEOF

[aneti] Done.
- Source: $INSTALL_DIR
- Build output: $INSTALL_DIR/out and $INSTALL_DIR/dist
DONEEOF

if [ "$WEB_SERVICE" -eq 1 ]; then
  echo "- Web app: http://<host>:${WEB_PORT}/app"
  if [ "$WEB_DISABLE_AUTH" -eq 1 ]; then
    echo "- Auth mode: disabled (trusted network only)"
  elif [ -n "$TOKEN" ]; then
    echo "- API token: ${TOKEN}"
  else
    echo "- API token file: ${SETTINGS_PATH}"
  fi
  echo "- Service status: systemctl status aneti-web.service"
else
  echo "- Start dev UI: cd $INSTALL_DIR && npm run dev"
fi
