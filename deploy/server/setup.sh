#!/bin/bash
# Set up or redeploy the live demo on Ubuntu 24.04 (Oracle Always Free, arm64). Safe to rerun.
# Usage: sudo ./setup.sh 1-2-3-4.sslip.io
set -euo pipefail
HOST=${1:?usage: sudo setup.sh <ip-with-dashes>.sslip.io}
APP=/opt/slac-investigator
REPO=https://github.com/iamsorenl/slac-investigator.git

apt-get update -q && apt-get install -yq git curl caddy iptables-persistent
id slac >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash slac
[ -d "$APP/.git" ] || git clone "$REPO" "$APP"
chown -R slac:slac "$APP"
sudo -u slac git -C "$APP" pull --ff-only
sudo -u slac bash -c 'command -v ~/.local/bin/uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | sh'
sudo -u slac bash -c "cd $APP && ~/.local/bin/uv sync --frozen"

# API env: create once from the example, fill host and a random salt; never overwrite.
if [ ! -f "$APP/api.env" ]; then
  sed -e "s/REPLACE-with-host.sslip.io/$HOST/" -e "s/^INVESTIGATOR_VISITOR_SALT=$/INVESTIGATOR_VISITOR_SALT=$(openssl rand -hex 16)/" \
    "$APP/deploy/server/api.env.example" > "$APP/api.env"
fi
chown slac:slac "$APP/api.env"; chmod 600 "$APP/api.env"
[ -f "$APP/.env" ] || { echo "Missing $APP/.env with the Groq provider block (see docs/DEPLOY.md)."; exit 1; }
chown slac:slac "$APP/.env"; chmod 600 "$APP/.env"

cp "$APP"/deploy/server/slac-*.service /etc/systemd/system/
printf '%s {\n\treverse_proxy 127.0.0.1:8080\n}\n' "$HOST" > /etc/caddy/Caddyfile

# Oracle's Ubuntu images block everything but SSH in iptables; open 80/443 once.
for port in 80 443; do
  iptables -C INPUT -p tcp --dport $port -j ACCEPT 2>/dev/null || iptables -I INPUT 5 -p tcp --dport $port -j ACCEPT
done
netfilter-persistent save

systemctl daemon-reload
systemctl enable --now slac-grid slac-api caddy
systemctl restart slac-grid slac-api caddy
sleep 10
curl -fsS "https://$HOST/api/v1/limits" && echo && echo "Live at https://$HOST"
