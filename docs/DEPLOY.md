# Deployment: SLAC Investigator Live Demo

The live backend (Flower SuperLink, the rf/ltu/dump SuperNodes, and the public API) runs in an LXD container on a home Linux box. Tailscale Funnel gives it a public HTTPS URL, so no ports are opened on the router and nothing costs money. The site on GitHub Pages calls it via `PUBLIC_API` in `frontend/assets/config.js`. When the box is off, the site says the live server is offline and shows the saved runs.

Current host: container `slac-demo` on a home Linux box, public at `https://slac-demo.tail88a93f.ts.net`.

## Home server (LXD + Tailscale Funnel)

### First setup

1. On the host, once (needs sudo): `sudo usermod -aG lxd $USER`, log in again, then `lxd init --auto --storage-backend=dir` if `lxc storage list` is empty.
2. Create the container. It starts with the host:
   ```bash
   lxc launch ubuntu:24.04 slac-demo -c boot.autostart=true
   ```
3. Install the app (run on your laptop from the repo). The first run clones and installs, then stops because `.env` is missing:
   ```bash
   ssh <host> 'lxc exec slac-demo -- bash -s slac-demo.<tailnet>.ts.net <home-ipv6-prefix>' < deploy/lxd/setup.sh
   ```
   The hostname is the container's Tailscale name. Before you know it, pass any placeholder; step 5 reruns this. The second argument is optional: your home network's global IPv6 range (on the host, `ip -6 addr` shows it, for example `2001:db8:1234:5678::/64`).
4. Copy the Groq block from your local `.env` without printing it, then rerun step 3 (services and Tailscale get installed):
   ```bash
   grep -E '^(FLWR_MODEL_API_ENDPOINT|FLWR_MODEL_API_KEY|INVESTIGATOR_MODEL)=' .env | \
     ssh <host> 'lxc exec slac-demo -- sh -c "umask 077; cat > /opt/slac-investigator/.env"'
   ```
5. Sign Tailscale in and turn on Funnel (inside the container: `lxc exec slac-demo -- bash`):
   ```bash
   tailscale up --hostname=slac-demo    # open the printed link and sign in
   tailscale funnel --bg 8080           # first time: open the printed link to allow Funnel on the tailnet
   ```
   Then rerun step 3 with the real `*.ts.net` name, and in the Tailscale console turn off key expiry for the machine (otherwise it drops off after 180 days).
6. Check from anywhere: `curl https://slac-demo.<tailnet>.ts.net/api/v1/limits`. A new Funnel host can fail TLS for a minute while the relays pick up its certificate.

The script also locks the container down. An nftables rule (`/etc/nftables.conf`, table `slac_egress`) lets it reach the internet but rejects the home network: 10/8, 172.16/12, 192.168/16, link-local, CGNAT, multicast, IPv6 ULA and the home IPv6 range, except its own gateway for DNS and DHCP. SSH inside the container is turned off; use `lxc exec`. If the ISP changes the home IPv6 prefix, rerun the script with the new one.

It comes back by itself after a reboot or crash. The container has `boot.autostart=true`; inside it `slac-grid`, `slac-api`, `tailscaled` and the firewall start at boot, the app services have `Restart=always`, and Tailscale keeps its login and Funnel setting. A `slac-watchdog.timer` checks the API every 2 minutes and restarts `slac-grid` and `slac-api` if it stops answering twice in a row. After a power cut the PC itself only turns back on if its BIOS is set to power on when AC returns.

Public mode runs `collaborative` only, capped at 15 runs a day and 3 per visitor. Funnel forwards each visitor's address in `X-Forwarded-For` from 127.0.0.1, which the API trusts, so visitors are counted separately.

### Redeploy after a push

```bash
ssh <host> 'lxc exec slac-demo -- bash -s slac-demo.<tailnet>.ts.net <home-ipv6-prefix>' < deploy/lxd/setup.sh
```

Always pass the IPv6 prefix again, or the rewritten firewall drops that rule.

### Logs

```bash
ssh <host> lxc exec slac-demo -- journalctl -u slac-grid -u slac-api -f
```

### Change the caps

Edit `/opt/slac-investigator/api.env` in the container (`INVESTIGATOR_DAILY_RUNS`, `INVESTIGATOR_VISITOR_RUNS`, `INVESTIGATOR_CORS_ORIGINS`), then `systemctl restart slac-api`. The run counter is in `artifacts/api/state.sqlite3`, so restarts don't reset it.

### Take it offline

Inside the container: `tailscale funnel --https=443 off` (public URL gone, services keep running) or `systemctl stop slac-api`. The site falls back to the saved runs either way.

## Alternative: a public VM (Oracle Always Free, needs capacity)

Host the FastAPI + Flower grid on a public Oracle Always Free Ubuntu 24.04 arm64 VM behind Caddy. In 2026-09 Oracle had no A1 capacity for weeks.

### 1. Oracle Account

Sign up at [cloud.oracle.com](https://cloud.oracle.com). The card is for identity verification only. Stay on "Always Free" and never click "Upgrade to Pay As You Go".

### 2. Create the VM

1. Navigate to **Compute → Instances → Create**
2. **Image:** Canonical Ubuntu 24.04 (aarch64)
3. **Shape:** `VM.Standard.A1.Flex`, **1 OCPU, 4 GB** (Oracle Always Free allows 2 OCPU / 12 GB total)
   - Keep it small on purpose: Oracle reclaims an Always Free VM when CPU, network AND memory all stay under 20% for 7 days.
   - The stack uses ~1.5 GB, so on 4 GB memory remains above 20% and the VM is not reclaimed.
4. **SSH:** Paste your SSH public key (`~/.ssh/id_ed25519.pub`)
5. **Network:** Assign a public IPv4 address

### 3. Open Ports in Oracle's Network

1. Navigate to **Networking → the VCN → default security list**
2. Add ingress rules for:
   - **TCP 80** from `0.0.0.0/0`
   - **TCP 443** from `0.0.0.0/0`

### 4. Host Name

Convert the public IP to an sslip.io hostname. For example:
- Public IP: `1.2.3.4`
- sslip.io hostname: `1-2-3-4.sslip.io`

### 5. First Setup

1. SSH into the VM:
   ```bash
   ssh ubuntu@1.2.3.4
   ```

2. Clone the repository:
   ```bash
   sudo git clone https://github.com/iamsorenl/slac-investigator /opt/slac-investigator
   ```

3. Create `/opt/slac-investigator/.env` with the Groq provider block (3 lines). Use `sudoedit` so the API key does not land in shell history:
   ```bash
   sudoedit /opt/slac-investigator/.env
   ```
   Add these 3 lines:
   ```sh
   FLWR_MODEL_API_ENDPOINT=https://api.groq.com/openai/v1/responses
   FLWR_MODEL_API_KEY=<your-groq-api-key>
   INVESTIGATOR_MODEL=openai/gpt-oss-20b
   ```

4. Run the setup script:
   ```bash
   sudo /opt/slac-investigator/deploy/server/setup.sh 1-2-3-4.sslip.io
   ```

The script will:
- Install dependencies (git, curl, caddy, iptables-persistent)
- Create a `slac` system user
- Pull the latest code
- Install `uv` and sync Python dependencies
- Generate `/opt/slac-investigator/api.env` with the host and a random visitor salt
- Copy systemd units and configure Caddy
- Open ports 80/443 in iptables
- Start services: `slac-grid`, `slac-api`, `caddy`
- Verify the API is responding via HTTPS

### Redeploy After a Push

After pushing changes to the main branch:

```bash
ssh ubuntu@1.2.3.4 sudo /opt/slac-investigator/deploy/server/setup.sh 1-2-3-4.sslip.io
```

The script is idempotent and safe to rerun.

### View Logs

Stream logs from both services:

```bash
ssh ubuntu@1.2.3.4 sudo journalctl -u slac-grid -u slac-api -f
```

### Change API Capabilities

Edit `/opt/slac-investigator/api.env` on the VM:
- `INVESTIGATOR_DAILY_RUNS` — max runs per day (global)
- `INVESTIGATOR_VISITOR_RUNS` — max runs per visitor (per hashed IP)
- `INVESTIGATOR_CORS_ORIGINS` — allowed frontend origins

Then restart the API:

```bash
ssh ubuntu@1.2.3.4 sudo systemctl restart slac-api
```

### If Oracle Reclaims the VM

Oracle reclaims an Always Free VM when CPU, network AND memory all stay below 20% for 7 days. If this happens:

1. Create a new VM (repeat steps 2–5 above)
2. Run the setup script on the new instance
3. Update `PUBLIC_API` in `frontend/assets/config.js` with the new host
4. Push the change to main
