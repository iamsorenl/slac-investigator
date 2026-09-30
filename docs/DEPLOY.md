# Deployment: SLAC Investigator Live Demo

Host the FastAPI + Flower grid on a public Oracle Always Free Ubuntu 24.04 arm64 VM behind Caddy.

## 1. Oracle Account

Sign up at [cloud.oracle.com](https://cloud.oracle.com). The card is for identity verification only. Stay on "Always Free" and never click "Upgrade to Pay As You Go".

## 2. Create the VM

1. Navigate to **Compute → Instances → Create**
2. **Image:** Canonical Ubuntu 24.04 (aarch64)
3. **Shape:** `VM.Standard.A1.Flex`, **1 OCPU, 4 GB** (Oracle Always Free allows 2 OCPU / 12 GB total)
   - Keep it small on purpose: Oracle reclaims an Always Free VM when CPU, network AND memory all stay under 20% for 7 days.
   - The stack uses ~1.5 GB, so on 4 GB memory remains above 20% and the VM is not reclaimed.
4. **SSH:** Paste your SSH public key (`~/.ssh/id_ed25519.pub`)
5. **Network:** Assign a public IPv4 address

## 3. Open Ports in Oracle's Network

1. Navigate to **Networking → the VCN → default security list**
2. Add ingress rules for:
   - **TCP 80** from `0.0.0.0/0`
   - **TCP 443** from `0.0.0.0/0`

## 4. Host Name

Convert the public IP to an sslip.io hostname. For example:
- Public IP: `1.2.3.4`
- sslip.io hostname: `1-2-3-4.sslip.io`

## 5. First Setup

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

## Redeploy After a Push

After pushing changes to the main branch:

```bash
ssh ubuntu@1.2.3.4 sudo /opt/slac-investigator/deploy/server/setup.sh 1-2-3-4.sslip.io
```

The script is idempotent and safe to rerun.

## View Logs

Stream logs from both services:

```bash
ssh ubuntu@1.2.3.4 sudo journalctl -u slac-grid -u slac-api -f
```

## Change API Capabilities

Edit `/opt/slac-investigator/api.env` on the VM:
- `INVESTIGATOR_DAILY_RUNS` — max runs per day (global)
- `INVESTIGATOR_VISITOR_RUNS` — max runs per visitor (per hashed IP)
- `INVESTIGATOR_CORS_ORIGINS` — allowed frontend origins

Then restart the API:

```bash
ssh ubuntu@1.2.3.4 sudo systemctl restart slac-api
```

## If Oracle Reclaims the VM

Oracle reclaims an Always Free VM when CPU, network AND memory all stay below 20% for 7 days. If this happens:

1. Create a new VM (repeat steps 2–5 above)
2. Run the setup script on the new instance
3. Update `PUBLIC_API` in `frontend/assets/config.js` with the new host
4. Push the change to main
