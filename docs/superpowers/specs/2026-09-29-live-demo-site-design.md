# Live demo site: ask your own questions

Date: 2026-09-29. Status: approved by Soren 2026-09-29.

## Goal

A public web page where anyone can pick one of the four SLAC events, type their own question, and watch the grid answer it live: the orchestrator delegates to the rf, ltu and dump nodes, each node checks its own data, and the lead reconciles their reports. This is for people revisiting the project after the hackathon, and for live demos.

It must cost **$0** to run. If usage goes over the free limits, the page says so and offers the saved runs instead. It never falls back to paying.

## Decisions (agreed in chat)

| Topic | Decision |
|---|---|
| Frontend | The existing Fieldnote app (`frontend/`) on GitHub Pages, with live mode turned on for the Pages origin. No guided tour. |
| Repo | Fork `iamsorenl/slac-investigator`; Pages and deploys run from the fork. Gavin's repo is not changed. |
| Server | Oracle Cloud Always Free Arm VM. HF Spaces was ruled out: Docker Spaces now need a paid plan. |
| Flower | Self-hosted on the VM: SuperLink plus 3 SuperNodes via `scripts/start_grid.sh`. Not SuperGrid. |
| Model | Groq `openai/gpt-oss-20b`, free tier, **no card on the Groq account** (no card = cannot be billed). |
| Limits | 15 runs/day overall, 3 per visitor, follow-ups count as runs. Friendly "too many people today" message when hit. |
| Scope | Questions are about the 4 recorded events (slac-001 … slac-004); that is all the data the nodes hold. |

## Why these limits

Groq free tier for gpt-oss-20b: 30 requests/min, 1,000 requests/day, 8,000 tokens/min, 200,000 tokens/day. Saved traces show a grid run uses roughly 7-15K tokens, so the free tier supports about 13-25 runs/day, and the 8K tokens/min limit stretches a run to 1-2 minutes. 15/day keeps us under the daily token limit. Groq's own limit is the hard ceiling underneath ours.

## Architecture

```
Browser (iamsorenl.github.io/slac-investigator)
   │  HTTPS, JSON, polling ~1/s (existing contract, docs/API.md)
   ▼
Caddy on the VM  (443 only; free Let's Encrypt cert on <vm-ip>.sslip.io)
   ▼
FastAPI  slac_assistant/api.py   127.0.0.1:8080, 1 worker, SQLite job store
   ▼  Flower Control API 127.0.0.1
SuperLink ── SuperNode rf   (nodes/rf only)
          ── SuperNode ltu  (nodes/ltu only)
          ── SuperNode dump (nodes/dump only)
   ▼
Groq /openai/v1/responses   (key only in the VM's .env, mode 600)
```

Only ports 80/443 are open on the VM. The SuperLink, nodes and API listen on localhost only. Everything runs as systemd services so it restarts on reboot or crash.

`sslip.io` gives a real hostname for the VM's IP without buying a domain, which lets Caddy get a free HTTPS certificate. GitHub Pages is HTTPS, so the API must be too.

## Changes

### 1. API public mode (`slac_assistant/api.py`)

Off by default; local behavior stays exactly as today. Turned on with `INVESTIGATOR_PUBLIC=1` on the VM.

- **Hosts and origins from env:** `INVESTIGATOR_ALLOWED_HOSTS` (the sslip.io name) and the existing `INVESTIGATOR_CORS_ORIGINS` (`https://iamsorenl.github.io`).
- **Grid only:** in public mode, `mode` must be `collaborative` (the model-backed grid: models on each node and the orchestrator; `grid` is the deterministic no-model variant); anything else gets 400.
- **Question length:** 500 characters max in public mode (4,000 locally).
- **Daily caps:** before queueing a start or follow-up, count today's jobs (day resets at midnight Pacific) in the existing SQLite `jobs` table:
  - 15 or more overall → `429 {"code": "daily_limit", "message": "Lots of people tried this today, so live runs are paused until tomorrow. The saved runs below show the same grid at work."}`
  - 3 or more for this visitor → `429 {"code": "visitor_limit", ...}` with a matching message.
- **Visitor identity:** client IP from `X-Forwarded-For`, trusted only when the request comes from Caddy on localhost. Stored as a salted hash, never the raw IP. The salt lives in the VM's `.env`.
- **One run at a time:** if a run is already queued or running, reply `429 {"code": "busy", ...}` ("someone else's run is in progress, try again in a minute"). This also keeps us under Groq's per-minute limit.
- **New `GET /api/v1/limits`:** `{runs_left_today, visitor_runs_left, busy}`. The page shows "N live runs left today". Also serves as the health check.
- **Caps configurable** by env (`INVESTIGATOR_DAILY_RUNS=15`, `INVESTIGATOR_VISITOR_RUNS=3`) so they can change without a code edit.

### 2. Frontend live mode on Pages (`frontend/assets/api.js`, `live.js`, `app.js`)

- `api.js` accepts one extra allowed pair: the Pages origin talking to the configured public API (HTTPS, exact hostname). The existing localhost pairs stay. The public API URL is a single constant in one file.
- On Pages the page opens in live mode if `GET /limits` answers; otherwise it shows the saved runs with a note that live runs are unavailable right now.
- Live mode shows: event picker, question box (500 characters), "N live runs left today", and the 429 messages as friendly banners with a button to the saved runs.
- Live runs are labeled "Live run · Groq gpt-oss-20b on self-hosted Flower". Saved runs keep their labels; the old slac-001/slac-003 prototype replays are labeled as OpenAI runs, not Flower models.
- The existing rules stay: no provider/model/key from the browser, no automatic POST retry, duplicate-submit lock.

### 3. Server setup (`deploy/server/`)

- `setup.sh`: run once on a fresh Ubuntu Arm VM. Installs uv, Caddy, clones the fork, creates `.venv`, installs the three systemd units, opens the firewall for 80/443. Rerunnable, so if Oracle reclaims the VM, a new one is one command away.
- `slac-grid.service` (runs `scripts/start_grid.sh`), `slac-api.service` (runs `scripts/start_api.sh` with public-mode env), `Caddyfile` (reverse proxy to 127.0.0.1:8080).
- `server.env.example`: every variable the VM's `.env` needs, with no values. Includes `FLWR_MODEL_API_ENDPOINT=https://api.groq.com/openai/v1/responses`, `INVESTIGATOR_MODEL=openai/gpt-oss-20b`, `FLWR_MODEL_API_KEY=` (Groq key), the caps and the hash salt.
- `deploy.sh`: from the laptop, `ssh` in, `git pull`, restart the services.

### 4. Pages deploy

Install `frontend/deploy/github-pages.yml` as `.github/workflows/frontend-pages.yml` in the fork. It already uploads only `frontend/dist`. Deploys on push to main in the fork.

### 5. Linking (last step, only after a live run works from the Pages URL)

The original repo `GavinRS/slac-investigator` is the link Soren shares, so the first impression is a group project.

- **PR to the original README:** a "Try it live" link near the top, plus a short paragraph explaining that the demo runs from Soren's fork (`iamsorenl/slac-investigator`) on Groq's free tier and self-hosted Flower, and why it lives there.
- **Ask Gavin** to set the original repo's About → Website field to the demo URL (needs admin).
- **Site footer** names the team and links the original repo. The fork's README points back to the original as the main project.

## Things to verify first (before building on them)

1. **Grid through the API works locally:** `start_grid.sh` + `start_api.sh`, POST `mode: grid` with a question, and get a completed result. `docs/API.md` still says grid jobs fail until the orchestrator lands; that note predates the merged grid work.
2. **Groq through Flower works:** one local grid run on Groq gpt-oss-20b. Check for 429s from Groq's 8K tokens/min limit; if runs fail on them, add a retry with backoff in the model call path.
3. **The stack fits Oracle's free Arm VM:** flwr and all dependencies install on arm64.

## Error handling

- Groq refuses a request (limit or outage) → the run ends `failed` with a plain message. The page shows it and offers the saved runs. No fabricated findings (existing rule).
- API unreachable → page stays on saved runs, with "live runs are unavailable right now".
- Service crash or VM reboot → systemd restarts it.
- Oracle reclaims an idle Always Free VM (its policy for low-utilization instances) → the page falls back to saved runs automatically; rerun `setup.sh` on a new VM. Known limitation, accepted.

## Testing

- **pytest** (`tests/test_api.py`): public mode off by default; collaborative-only; 500-character limit; global cap; visitor cap; follow-ups counted; day rollover at Pacific midnight; busy rejection; `/limits` numbers; forwarded IP ignored when the request did not come from localhost; the raw IP never stored.
- **node tests** (`frontend/tests/`): Pages origin allowed only with the exact public API URL; 429 codes render the right banner; fallback to saved runs when `/limits` fails.
- **End to end:** local grid run on Groq (verification step 2); after deploy, one live run started from the Pages URL on a phone and a laptop; then hit the cap on purpose with the env set to 1 and confirm the banner.

## What Soren configures, and when

1. **Now:** create a Groq API key (free tier, no card). Add it to the slac-investigator `.env` as `GROQ_API_KEY=...` for the local test.
2. **After the local Groq test passes:** sign up for Oracle Cloud (a card is asked for identity only; Always Free does not bill unless you upgrade). Create the VM from the exact settings in the plan, and add an SSH key.
3. **Before the first Pages deploy:** approve creating the fork; then in the fork's Settings → Pages, set Source to "GitHub Actions".
4. **On the VM:** paste the Groq key into the VM's `.env` yourself (or approve me copying it over SSH without printing it).

## Out of scope

- The guided tour (dropped).
- Asking about events beyond the 4 recorded ones.
- Accounts or logins.
- Paid hosting or a paid model tier.
- Changes to Gavin's repo other than the README link PR.
