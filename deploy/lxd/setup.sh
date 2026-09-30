#!/bin/bash
# Set up or redeploy the live demo inside an LXD container (ubuntu:24.04), exposed by Tailscale Funnel. Safe to rerun.
# Run as root inside the container: bash setup.sh <name>.<tailnet>.ts.net   (see docs/DEPLOY.md)
set -euo pipefail
HOST=${1:?usage: setup.sh <name>.<tailnet>.ts.net}
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

for attempt in {1..30}; do
  curl -fs http://127.0.0.1:8080/api/v1/limits && { echo; echo "API ready. Next: tailscale up / tailscale funnel --bg 8080 (first time only)."; exit 0; }
  sleep 5
done
echo "API did not respond after 150 s. Check: journalctl -u slac-grid -u slac-api -f"; exit 1
