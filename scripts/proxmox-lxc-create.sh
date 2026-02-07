#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Create a Proxmox LXC and install AnetI inside it.

Run on Proxmox host as root.

Usage:
  proxmox-lxc-create.sh [options]

Options:
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
  --repo OWNER/REPO         GitHub repo (default: allisonhere/aNETi)
  --branch NAME             Git branch (default: main)
  --dir PATH                Install dir in CT (default: /opt/aneti)
  --web-port N              Browser/API service port inside CT (default: 8787)
  --no-web-service          Skip headless web service install
  --start                   Start CT after create (default: true)
  --no-start                Do not start CT or install AnetI
  --help                    Show help

Example:
  scripts/proxmox-lxc-create.sh --vmid 120 --bridge vmbr0
EOF
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

storage_exists() {
  local name="$1"
  pvesm status 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx "$name"
}

pick_storage_by_content() {
  local content="$1"
  local selected
  selected="$(pvesm status -content "$content" 2>/dev/null | awk 'NR>1 {print $1; exit}')"
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

random_password() {
  # head closes the pipe early, which can trip pipefail; tolerate that here.
  tr -dc 'A-Za-z0-9_@%+=' </dev/urandom | head -c 24 || true
}

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root on Proxmox host." >&2
  exit 1
fi

require_cmd pct
require_cmd pveam
require_cmd pvesm

VMID=""
HOSTNAME="aneti"
STORAGE="auto"
TEMPLATE_STORAGE="auto"
BRIDGE="vmbr0"
DISK_GB="12"
MEMORY_MB="2048"
CORES="2"
PASSWORD=""
PASSWORD_FILE=""
TEMPLATE=""
REPO="allisonhere/aNETi"
BRANCH="main"
INSTALL_DIR="/opt/aneti"
WEB_SERVICE=1
WEB_PORT="8787"
DO_START=1

while [ $# -gt 0 ]; do
  case "$1" in
    --vmid) VMID="${2:-}"; shift 2 ;;
    --hostname) HOSTNAME="${2:-}"; shift 2 ;;
    --storage) STORAGE="${2:-}"; shift 2 ;;
    --template-storage) TEMPLATE_STORAGE="${2:-}"; shift 2 ;;
    --bridge) BRIDGE="${2:-}"; shift 2 ;;
    --disk-gb) DISK_GB="${2:-}"; shift 2 ;;
    --memory-mb) MEMORY_MB="${2:-}"; shift 2 ;;
    --cores) CORES="${2:-}"; shift 2 ;;
    --password) PASSWORD="${2:-}"; shift 2 ;;
    --password-file) PASSWORD_FILE="${2:-}"; shift 2 ;;
    --template) TEMPLATE="${2:-}"; shift 2 ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    --branch) BRANCH="${2:-}"; shift 2 ;;
    --dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    --web-port) WEB_PORT="${2:-}"; shift 2 ;;
    --no-web-service) WEB_SERVICE=0; shift ;;
    --start) DO_START=1; shift ;;
    --no-start) DO_START=0; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 1 ;;
  esac
done

if [ -z "$VMID" ]; then
  VMID="$(pvesh get /cluster/nextid)"
fi

if [ "$TEMPLATE_STORAGE" = "auto" ]; then
  TEMPLATE_STORAGE="$(pick_storage_by_content vztmpl)"
elif ! storage_exists "$TEMPLATE_STORAGE"; then
  echo "Template storage '${TEMPLATE_STORAGE}' does not exist on this node." >&2
  echo "Available storages:" >&2
  pvesm status >&2 || true
  exit 1
fi

if [ "$STORAGE" = "auto" ]; then
  STORAGE="$(pick_storage_by_content rootdir)"
elif ! storage_exists "$STORAGE"; then
  echo "CT storage '${STORAGE}' does not exist on this node." >&2
  echo "Available storages:" >&2
  pvesm status >&2 || true
  exit 1
fi

if [ -z "$TEMPLATE" ]; then
  TEMPLATE="$(pick_debian12_template)"
fi

if [ -z "$PASSWORD" ]; then
  PASSWORD="$(random_password)"
fi

if [ -z "$PASSWORD_FILE" ]; then
  PASSWORD_FILE="/root/aneti-lxc-${VMID}.txt"
fi

TEMPLATE_VOL="${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}"

echo "[aneti] Ensuring template exists: ${TEMPLATE_VOL}"
if ! pvesm list "$TEMPLATE_STORAGE" 2>/dev/null | awk '{print $1}' | grep -qx "${TEMPLATE}"; then
  echo "[aneti] Downloading template ${TEMPLATE} to ${TEMPLATE_STORAGE}..."
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE"
fi

echo "[aneti] Creating CT ${VMID} (${HOSTNAME})..."
pct create "$VMID" "$TEMPLATE_VOL" \
  --hostname "$HOSTNAME" \
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

cat >"$PASSWORD_FILE" <<EOF
AnetI Proxmox LXC Login
CT_ID=${VMID}
HOSTNAME=${HOSTNAME}
USERNAME=root
PASSWORD=${PASSWORD}
EOF
chmod 600 "$PASSWORD_FILE"

if [ "$DO_START" -eq 0 ]; then
  echo "[aneti] Skipping start/install (--no-start)."
  exit 0
fi

echo "[aneti] Starting CT ${VMID}..."
pct start "$VMID"
sleep 8

echo "[aneti] Installing AnetI inside CT ${VMID}..."
INSTALL_ARGS="--repo ${REPO} --branch ${BRANCH} --dir ${INSTALL_DIR}"
if [ "$WEB_SERVICE" -eq 1 ]; then
  INSTALL_ARGS="${INSTALL_ARGS} --web-service --web-port ${WEB_PORT} --web-host 0.0.0.0"
fi
pct exec "$VMID" -- bash -lc "apt-get update -y && apt-get install -y curl ca-certificates && curl -fsSL https://raw.githubusercontent.com/${REPO}/${BRANCH}/scripts/proxmox-install.sh | bash -s -- ${INSTALL_ARGS}"

cat <<EOF

[aneti] Complete.
- CT ID: ${VMID}
- Hostname: ${HOSTNAME}
- Login: root / ${PASSWORD}
- Login file: ${PASSWORD_FILE}
- Enter CT: pct enter ${VMID}
- App path: ${INSTALL_DIR}
- Dev run: pct exec ${VMID} -- bash -lc 'cd ${INSTALL_DIR} && npm run dev'
EOF

if [ "$WEB_SERVICE" -eq 1 ]; then
  echo "- Browser app: http://<ct-ip>:${WEB_PORT}/app"
  echo "- Service logs: pct exec ${VMID} -- journalctl -u aneti-web -f"
fi
