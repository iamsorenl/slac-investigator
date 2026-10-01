#!/bin/bash
# Set up or redeploy the live demo inside an LXD container (ubuntu:24.04), exposed by Tailscale Funnel. Safe to rerun.
# Run as root inside the container: bash setup.sh <name>.<tailnet>.ts.net [home-ipv6-prefix]   (see docs/DEPLOY.md)
set -euo pipefail
HOST=${1:?usage: setup.sh <name>.<tailnet>.ts.net [home-ipv6-prefix]}
HOME_V6=${2:-}   # e.g. 2001:db8:1234:5678::/64, the LAN's global IPv6 range; blocked like the private ranges
APP=/opt/slac-investigator

export DEBIAN_FRONTEND=noninteractive
apt-get update -q && apt-get install -yq git curl
id slac >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash slac
[ -d "$APP/.git" ] || git clone https://github.com/iamsorenl/slac-investigator.git "$APP"
chown -R slac:slac "$APP"
sudo -u slac git -C "$APP" pull --ff-only
sudo -u slac bash -c 'command -v ~/.local/bin/uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | sh'
sudo -u slac bash -c "cd $APP && ~/.local/bin/uv sync --frozen"

# API env: create once from the example with a random salt; the host line is kept in sync.
[ -f "$APP/api.env" ] || sed "s/^INVESTIGATOR_VISITOR_SALT=$/INVESTIGATOR_VISITOR_SALT=$(openssl rand -hex 16)/" \
  "$APP/deploy/server/api.env.example" > "$APP/api.env"
sed -i "s/^INVESTIGATOR_ALLOWED_HOSTS=.*/INVESTIGATOR_ALLOWED_HOSTS=$HOST/" "$APP/api.env"
chown slac:slac "$APP/api.env"; chmod 600 "$APP/api.env"
[ -f "$APP/.env" ] || { echo "Missing $APP/.env with the Groq provider block (see docs/DEPLOY.md)."; exit 1; }
chown slac:slac "$APP/.env"; chmod 600 "$APP/.env"

cp "$APP"/deploy/server/slac-*.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable slac-grid slac-api
systemctl restart slac-grid slac-api

# Tailscale in userspace mode: no TUN device, so the LXD host needs no extra config.
command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh
sed -i 's/^FLAGS=.*/FLAGS="--tun=userspace-networking"/' /etc/default/tailscaled
systemctl restart tailscaled

# Egress guard: the container may reach the internet but not the home network.
# Only its own gateway (DNS, DHCP) is allowed among private addresses.
GW4=$(ip -4 route show default | awk '{print $3; exit}')
GW6=$(resolvectl dns eth0 2>/dev/null | sed 's/.*: //' | tr ' ' '\n' | grep ':' | grep -v '^fe80' | head -1 || true)
V6DNS=""; [ -n "$GW6" ] && V6DNS="ip6 daddr $GW6 udp dport 53 accept
    ip6 daddr $GW6 tcp dport 53 accept"
V6BLOCK="fc00::/7"; [ -n "$HOME_V6" ] && V6BLOCK="$V6BLOCK, $HOME_V6"
cat > /etc/nftables.conf <<NFT
#!/usr/sbin/nft -f
# Written by deploy/lxd/setup.sh. slac-demo egress guard.
table inet slac_egress
delete table inet slac_egress
table inet slac_egress {
  chain output {
    type filter hook output priority 0; policy accept;
    oif "lo" accept
    ip daddr $GW4 udp dport { 53, 67 } accept
    ip daddr $GW4 tcp dport 53 accept
    $V6DNS
    ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 100.64.0.0/10, 224.0.0.0/4 } counter reject
    ip6 daddr { $V6BLOCK } counter reject
  }
}
NFT
nft -f /etc/nftables.conf
systemctl enable nftables >/dev/null 2>&1
# Nobody logs in over SSH; access is lxc exec.
systemctl disable --now ssh.socket ssh.service >/dev/null 2>&1 || true

# Watchdog: Restart=always covers crashes; this covers an API that is up but not answering.
cat > /usr/local/bin/slac-watchdog <<'WD'
#!/bin/sh
ok() { curl -fs -m 10 http://127.0.0.1:8080/api/v1/limits >/dev/null; }
ok && exit 0
sleep 20; ok && exit 0
echo "API not answering twice in a row; restarting slac-grid and slac-api"
systemctl restart slac-grid slac-api
WD
chmod 755 /usr/local/bin/slac-watchdog
printf '[Unit]\nDescription=Restart the SLAC demo if its API stops answering\n\n[Service]\nType=oneshot\nExecStart=/usr/local/bin/slac-watchdog\n' > /etc/systemd/system/slac-watchdog.service
printf '[Unit]\nDescription=Check the SLAC demo API every 2 minutes\n\n[Timer]\nOnBootSec=3min\nOnUnitActiveSec=2min\n\n[Install]\nWantedBy=timers.target\n' > /etc/systemd/system/slac-watchdog.timer
systemctl daemon-reload
systemctl enable --now slac-watchdog.timer >/dev/null 2>&1

for attempt in {1..30}; do
  curl -fs http://127.0.0.1:8080/api/v1/limits && { echo; echo "API ready. Next: tailscale up / tailscale funnel --bg 8080 (first time only)."; exit 0; }
  sleep 5
done
echo "API did not respond after 150 s. Check: journalctl -u slac-grid -u slac-api -f"; exit 1
