#!/usr/bin/env bash
# stift Proxmox VE helper — creates an LXC container running the stift server.
#
# Run on the Proxmox host as root:
#   bash -c "$(curl -fsSL https://stift.sh/proxmox.sh)"
#
# Flags (all optional):
#   --ctid N         container id        (default: next free id)
#   --hostname NAME  container hostname  (default: stift)
#   --storage S      rootfs storage      (default: local-lvm)
#   --disk GB        rootfs size         (default: 8)
#   --cores N        cpu cores           (default: 1)
#   --memory MB      memory              (default: 512)
#   --bridge BR      network bridge      (default: vmbr0)
#   --ip CIDR        static ip, e.g. 192.168.1.50/24  (default: dhcp)
#   --gw IP          gateway, required with --ip
#   --binary PATH    install a local stift binary instead of downloading
#   --token TOK      admin token to pin  (default: generated)
#   --yes            skip the confirmation prompt
#
# Environment: STIFT_BASE_URL (default https://stift.sh/dl), STIFT_VERSION
# (default latest) control where the binary is downloaded from.

set -euo pipefail

CTID="" HOST="stift" STORAGE="local-lvm" DISK=8 CORES=1 MEMORY=512
BRIDGE="vmbr0" IP="dhcp" GW="" BINARY="" TOKEN="" YES=0
TEMPLATE_STORAGE="local"
BASE_URL="${STIFT_BASE_URL:-https://stift.sh/dl}"
VERSION="${STIFT_VERSION:-latest}"

c_blue=$'\033[1;34m' c_green=$'\033[1;32m' c_red=$'\033[1;31m' c_off=$'\033[0m'
msg()  { echo "${c_blue}==>${c_off} $*"; }
ok()   { echo "${c_green} ✓ ${c_off} $*"; }
fail() { echo "${c_red}error:${c_off} $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --ctid)     CTID=$2; shift 2 ;;
    --hostname) HOST=$2; shift 2 ;;
    --storage)  STORAGE=$2; shift 2 ;;
    --disk)     DISK=$2; shift 2 ;;
    --cores)    CORES=$2; shift 2 ;;
    --memory)   MEMORY=$2; shift 2 ;;
    --bridge)   BRIDGE=$2; shift 2 ;;
    --ip)       IP=$2; shift 2 ;;
    --gw)       GW=$2; shift 2 ;;
    --binary)   BINARY=$2; shift 2 ;;
    --token)    TOKEN=$2; shift 2 ;;
    --yes)      YES=1; shift ;;
    -h|--help)  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) fail "unknown flag: $1 (try --help)" ;;
  esac
done

command -v pct >/dev/null 2>&1 || fail "pct not found — run this on a Proxmox VE host"
[ "$(id -u)" = 0 ] || fail "must run as root on the Proxmox host"
[ "$IP" = dhcp ] || [ -n "$GW" ] || fail "--ip needs --gw as well"

case "$(uname -m)" in
  x86_64)  ARCH=amd64 ;;
  aarch64) ARCH=arm64 ;;
  *) fail "unsupported architecture: $(uname -m)" ;;
esac

[ -n "$CTID" ] || CTID=$(pvesh get /cluster/nextid)
[ -n "$TOKEN" ] || TOKEN="stf_$(openssl rand -hex 24)"

NET="name=eth0,bridge=$BRIDGE,ip=$IP"
[ "$IP" = dhcp ] || NET="$NET,gw=$GW"

echo
echo "  stift LXC to create:"
echo "    ctid      $CTID"
echo "    hostname  $HOST"
echo "    rootfs    $STORAGE:$DISK (GB)"
echo "    cpu/mem   $CORES core(s), ${MEMORY}MB"
echo "    network   $NET"
if [ -n "$BINARY" ]; then
  echo "    binary    $BINARY (local file)"
else
  echo "    binary    $BASE_URL/$VERSION/stift-linux-$ARCH"
fi
echo
if [ "$YES" != 1 ]; then
  printf "  proceed? [y/N] "
  read -r answer
  case "$answer" in y|Y|yes|YES) ;; *) echo "aborted"; exit 1 ;; esac
fi

# --- debian template ----------------------------------------------------------
msg "locating Debian template"
TEMPLATE=$(pveam available --section system | awk '{print $2}' \
  | grep -E '^debian-1[23]-standard' | sort -V | tail -n1)
[ -n "$TEMPLATE" ] || fail "no debian-12/13-standard template offered by pveam"
if ! pveam list "$TEMPLATE_STORAGE" | awk '{print $1}' | grep -qx "$TEMPLATE_STORAGE:vztmpl/$TEMPLATE"; then
  msg "downloading template $TEMPLATE"
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE"
fi
ok "template: $TEMPLATE"

# --- container ----------------------------------------------------------------
msg "creating container $CTID"
pct create "$CTID" "$TEMPLATE_STORAGE:vztmpl/$TEMPLATE" \
  --hostname "$HOST" --unprivileged 1 \
  --cores "$CORES" --memory "$MEMORY" --rootfs "$STORAGE:$DISK" \
  --net0 "$NET" --onboot 1 --start 1 >/dev/null
ok "container created and started"

msg "waiting for network"
CT_IP=""
for _ in $(seq 1 30); do
  CT_IP=$(pct exec "$CTID" -- ip -4 -o addr show dev eth0 2>/dev/null \
    | awk '{print $4}' | cut -d/ -f1 | head -n1) || true
  [ -n "$CT_IP" ] && break
  sleep 1
done
[ -n "$CT_IP" ] || fail "container got no IPv4 address on eth0 after 30s"
ok "container ip: $CT_IP"

# --- stift binary -------------------------------------------------------------
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
if [ -n "$BINARY" ]; then
  [ -f "$BINARY" ] || fail "no such file: $BINARY"
  cp "$BINARY" "$tmp/stift"
else
  url="$BASE_URL/$VERSION/stift-linux-$ARCH"
  msg "downloading $url"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$tmp/stift" || fail "download failed: $url"
    curl -fsSL "$url.sha256" -o "$tmp/stift.sha256" 2>/dev/null || true
  else
    wget -qO "$tmp/stift" "$url" || fail "download failed: $url"
    wget -qO "$tmp/stift.sha256" "$url.sha256" 2>/dev/null || true
  fi
  if [ -s "$tmp/stift.sha256" ]; then
    want=$(awk '{print $1}' "$tmp/stift.sha256")
    got=$(sha256sum "$tmp/stift" | awk '{print $1}')
    [ "$want" = "$got" ] || fail "checksum mismatch (expected $want, got $got)"
    ok "checksum verified"
  fi
fi

# --- install inside the container ----------------------------------------------
msg "installing stift"
pct push "$CTID" "$tmp/stift" /usr/local/bin/stift --perms 0755

cat > "$tmp/env" <<EOF
STIFT_ADMIN_TOKEN=$TOKEN
EOF
pct exec "$CTID" -- mkdir -p /etc/stift
pct push "$CTID" "$tmp/env" /etc/stift/env --perms 0600

cat > "$tmp/stift.service" <<'EOF'
[Unit]
Description=stift — self-hosted session store for AI coding agents
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/stift serve --data /var/lib/stift
EnvironmentFile=-/etc/stift/env
DynamicUser=yes
StateDirectory=stift
Restart=on-failure
RestartSec=2
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes

[Install]
WantedBy=multi-user.target
EOF
pct push "$CTID" "$tmp/stift.service" /etc/systemd/system/stift.service --perms 0644
pct exec "$CTID" -- systemctl enable --now stift >/dev/null 2>&1
ok "stift service enabled"

# --- health check ---------------------------------------------------------------
healthy=0
for _ in $(seq 1 10); do
  if pct exec "$CTID" -- /usr/local/bin/stift version >/dev/null 2>&1 \
     && pct exec "$CTID" -- bash -c \
       'command -v curl >/dev/null && curl -fsm2 http://127.0.0.1:8580/healthz || wget -qT2 -O- http://127.0.0.1:8580/healthz' \
       2>/dev/null | grep -q ok; then
    healthy=1; break
  fi
  sleep 1
done
if [ "$healthy" = 1 ]; then
  ok "server is healthy"
else
  echo "warning: could not confirm health yet — check: pct exec $CTID -- journalctl -u stift" >&2
fi

cat <<EOF

${c_green}stift is up.${c_off}

  server   http://$CT_IP:8580
  web ui   http://$CT_IP:8580/        (paste the token)
  token    $TOKEN

Connect from your dev machines:

  stift login http://$CT_IP:8580 --token $TOKEN
  stift push

The token is also stored in the container at /etc/stift/env.
Data lives in /var/lib/stift inside container $CTID — Proxmox backups cover it.
For access from outside your LAN, put a TLS reverse proxy or VPN in front.
EOF
