# Hugging Face Spaces Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the live backend (Flower SuperLink, rf/ltu/dump SuperNodes, and the public API) on a free Hugging Face Docker Space, so the "Ask your own" card on https://iamsorenl.github.io/slac-investigator/ runs real investigations.

**Architecture:** This replaces plan `2026-09-29-live-demo-site.md` Task 8 (Oracle VM, which never got capacity). One container runs `scripts/start_grid.sh` in the background and uvicorn on port 7860 in the foreground. There's no Caddy: Hugging Face's proxy terminates HTTPS at `https://<user>-slac-investigator.hf.space`. The Space repo holds only `README.md` and a `Dockerfile`; the Dockerfile clones the fork, so the code has one home. The Groq key and the visitor salt are Space secrets. The entrypoint writes them to a mode-600 `.env` inside the container, because `scripts/start_flower.py` already reads the key from `.env`.

**Tech Stack:** Docker (python:3.12-slim + uv), Hugging Face Spaces (Docker SDK, free `cpu-basic`: 2 vCPU, 16 GB), `huggingface_hub` (via `uv run --with`), FastAPI/uvicorn, Flower 1.39.0, Groq `openai/gpt-oss-20b`.

**Spec:** `docs/superpowers/specs/2026-09-29-live-demo-site-design.md` (public mode, caps, frontend). The host change from Oracle to Hugging Face was agreed in chat on 2026-09-30.

## Global Constraints

- Cost stays $0: Space hardware is `cpu-basic` (free). Never pick paid hardware or persistent storage. No card on Groq.
- Public mode runs `collaborative` only. Never switch public mode to `grid`.
- Caps: `INVESTIGATOR_DAILY_RUNS=15`, `INVESTIGATOR_VISITOR_RUNS=3`.
- Secrets (`FLWR_MODEL_API_KEY`, `INVESTIGATOR_VISITOR_SALT`) are only ever Space secrets or the gitignored local `.env`. Never on a command line, in logs, in a commit, or in output.
- The Space is public (browsers must reach it). Anything outward-facing (creating the Space, setting secrets, pushing to fork `main`, PRs) needs Soren's OK at that step.
- Don't touch `GavinRS/slac-investigator` except via a README PR, and don't re-open PR #25.
- Known ceilings, accepted: the Space sleeps after 48 h with no traffic (the first visitor waits about 1–2 minutes and sees the saved runs meanwhile). Container storage isn't kept, so the daily counter resets when the Space restarts. If the grid process dies, the API stays up but runs fail until the Space restarts.

## Review Focus

1. **Hugging Face's proxy peer is not in the private ranges we trust.** Then every visitor shares one 3-run bucket. Expect Task 4's two-network check to catch it; the fix is in Task 4 Step 4.
2. **A visitor sends their own `X-Forwarded-For`.** Expect it to be ignored; the proxy-appended address counts. Test in Task 1.
3. **The Space is asleep or rebuilding when someone clicks "Ask your own".** Expect the saved runs to stay, with a plain "waking up, try again in a minute" note, never a blank page. Test in Task 4 Step 3.
4. **The Groq key is missing or wrong in the Space.** Expect the container to fail at start with a clear log line, and the site to fall back to saved runs. Test in Task 2 (missing key → entrypoint exits non-zero).
5. **The request `Host` differs from what we allow.** Hugging Face forwards `<user>-slac-investigator.hf.space`, and `INVESTIGATOR_ALLOWED_HOSTS` must match exactly, or every call returns 400. Checked in Task 3 Step 5.

---

## File map

| File | Change | Responsibility |
|---|---|---|
| `slac_assistant/api.py` | modify | `visitor_id`: trust `X-Forwarded-For` from any private-network peer, not only localhost |
| `tests/test_api_public.py` | modify | proxy-peer tests |
| `deploy/hf/Dockerfile` | create | build image: clone fork, `uv sync` |
| `deploy/hf/README.md` | create | Space card (YAML: `sdk: docker`, `app_port: 7860`) |
| `deploy/hf/entrypoint.sh` | create | write `.env` from secrets, start grid, exec uvicorn |
| `deploy/hf/configure_space.py` | create | create Space, set variables and secrets from local `.env` without printing them, upload card + Dockerfile |
| `frontend/assets/config.js` | modify | `PUBLIC_API` = Space URL |
| `frontend/assets/live.js` | modify | plain "waking up" message when the server doesn't answer |
| `docs/DEPLOY.md` | modify | Hugging Face section replaces the Oracle steps as the default |

---

### Task 1: Count visitors correctly behind any private proxy

**Files:**
- Modify: `slac_assistant/api.py:91-104` (`PROXY_PEERS`, `visitor_id`)
- Test: `tests/test_api_public.py`

**Interfaces:**
- Produces: `visitor_id(request, salt) -> str` (same signature). The peer is trusted when its IP is in `TRUSTED_PROXY_NETS` (loopback, 10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7). The visitor is then the rightmost `X-Forwarded-For` entry that is not itself in those networks.

- [ ] **Step 1: Write the failing tests** (append to `tests/test_api_public.py`)

```python
def test_private_proxy_peer_uses_forwarded_client(tmp_path, monkeypatch):
    # Hugging Face's proxy reaches the container from a private address, not localhost.
    with client_for(public_app(tmp_path, monkeypatch, INVESTIGATOR_VISITOR_RUNS='1'), ip='10.20.30.40') as c:
        first = start(c, '198.51.100.1'); assert first.status_code == 202; terminal(c, first.json())
        assert start(c, '198.51.100.1').json()['detail']['code'] == 'visitor_limit'
        assert start(c, '198.51.100.2').status_code == 202


def test_spoofed_forwarded_and_private_hops_are_skipped(tmp_path, monkeypatch):
    # Visitor-supplied entries sit left of the real client; internal hops sit right of it.
    with client_for(public_app(tmp_path, monkeypatch, INVESTIGATOR_VISITOR_RUNS='1'), ip='100.64.0.9') as c:
        first = start(c, '9.9.9.9, 198.51.100.1, 10.0.0.2'); assert first.status_code == 202; terminal(c, first.json())
        assert start(c, '1.1.1.1, 198.51.100.1').json()['detail']['code'] == 'visitor_limit'


def test_forwarded_with_only_private_hops_falls_back_to_peer(tmp_path, monkeypatch):
    with client_for(public_app(tmp_path, monkeypatch, INVESTIGATOR_VISITOR_RUNS='1'), ip='10.0.0.1') as c:
        first = start(c, '10.0.0.7'); assert first.status_code == 202; terminal(c, first.json())
        assert start(c, '10.0.0.8').json()['detail']['code'] == 'visitor_limit'
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `.venv/bin/pytest tests/test_api_public.py -k "private_proxy or spoofed or only_private" -v`
Expected: the first two FAIL (the 10.x / 100.64.x peer is not trusted today). The third may pass already.

- [ ] **Step 3: Implement** (replace `PROXY_PEERS` and `visitor_id` in `slac_assistant/api.py`; add `import ipaddress` to the imports)

```python
# Proxies we trust to append the real client to X-Forwarded-For: Caddy on localhost, or a
# platform proxy (Hugging Face) reaching the container from a private network.
TRUSTED_PROXY_NETS = [ipaddress.ip_network(n) for n in (
    '127.0.0.0/8', '::1/128', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', 'fc00::/7')]


def _trusted(ip):
    try:
        return any(ipaddress.ip_address(ip) in net for net in TRUSTED_PROXY_NETS)
    except ValueError:
        return False


def visitor_id(request, salt):
    ip = request.client.host if request.client else 'unknown'
    forwarded = request.headers.get('x-forwarded-for')
    if _trusted(ip) and forwarded:
        # Rightmost address that isn't an internal hop = what the outermost proxy saw.
        hops = [h.strip() for h in forwarded.split(',') if h.strip()]
        ip = next((h for h in reversed(hops) if not _trusted(h)), ip)
    return hashlib.sha256((salt + ip).encode()).hexdigest()[:16]
```

- [ ] **Step 4: Run the whole API suite**

Run: `.venv/bin/pytest tests/test_api_public.py tests/test_api.py -q`
Expected: all pass. That includes the existing `test_forwarded_header_ignored_when_not_from_proxy` (public peer 203.0.113.5 is still untrusted) and `test_visitor_ip_is_rightmost_forwarded_address`.

- [ ] **Step 5: Commit**

```bash
git add slac_assistant/api.py tests/test_api_public.py
git commit -m "API: trust X-Forwarded-For from private-network proxies (Hugging Face)"
```

---

### Task 2: The container

**Files:**
- Create: `deploy/hf/Dockerfile`, `deploy/hf/README.md`, `deploy/hf/entrypoint.sh`

**Interfaces:**
- Consumes: `scripts/start_grid.sh` (reads `.env`, starts SuperLink + 3 SuperNodes), `slac_assistant.api:create_app`.
- Produces: an image that listens on 7860 and needs these env vars at run time. Secrets: `FLWR_MODEL_API_KEY`, `INVESTIGATOR_VISITOR_SALT`. Variables: `FLWR_MODEL_API_ENDPOINT`, `INVESTIGATOR_MODEL`, `INVESTIGATOR_PUBLIC`, `INVESTIGATOR_ALLOWED_HOSTS`, `INVESTIGATOR_CORS_ORIGINS`, `INVESTIGATOR_DAILY_RUNS`, `INVESTIGATOR_VISITOR_RUNS`. Build args: `REPO` (default the fork), `REF` (default `main`).

- [ ] **Step 1: `deploy/hf/entrypoint.sh`**

```sh
#!/bin/sh
# Hugging Face Space entrypoint: grid in the background, public API in the foreground on 7860.
set -eu
cd /app
: "${FLWR_MODEL_API_KEY:?Space secret FLWR_MODEL_API_KEY is missing}"
: "${INVESTIGATOR_VISITOR_SALT:?Space secret INVESTIGATOR_VISITOR_SALT is missing}"
# start_flower.py reads the model key from a private .env (owner-only, mode 600).
umask 077
printf 'FLWR_MODEL_API_ENDPOINT=%s\nFLWR_MODEL_API_KEY=%s\nINVESTIGATOR_MODEL=%s\n' \
  "${FLWR_MODEL_API_ENDPOINT:-https://api.groq.com/openai/v1/responses}" "$FLWR_MODEL_API_KEY" \
  "${INVESTIGATOR_MODEL:-openai/gpt-oss-20b}" > .env
unset FLWR_MODEL_API_KEY   # the API process never needs it
scripts/start_grid.sh &
exec .venv/bin/uvicorn slac_assistant.api:create_app --factory --host 0.0.0.0 --port 7860 \
  --workers 1 --no-proxy-headers --no-access-log
```

- [ ] **Step 2: `deploy/hf/Dockerfile`**

```dockerfile
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.8 /uv /usr/local/bin/uv
# Hugging Face runs Spaces as uid 1000.
RUN useradd -m -u 1000 user
ARG REPO=https://github.com/iamsorenl/slac-investigator.git
ARG REF=main
RUN git clone --depth 1 --branch "$REF" "$REPO" /app && chown -R user /app
USER user
WORKDIR /app
ENV UV_PYTHON_DOWNLOADS=never
RUN uv sync --frozen
EXPOSE 7860
CMD ["sh", "deploy/hf/entrypoint.sh"]
```

- [ ] **Step 3: `deploy/hf/README.md`** (the Space card; the YAML header is required)

```markdown
---
title: SLAC Investigator
emoji: 🔬
colorFrom: blue
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
short_description: Live backend for the Cut Us Some SLAC beam investigator
---

API and Flower grid behind https://iamsorenl.github.io/slac-investigator/. Visit that page to use it.
Code: https://github.com/iamsorenl/slac-investigator (main project: https://github.com/GavinRS/slac-investigator).
```

- [ ] **Step 4: Commit and push to the fork** (the Dockerfile clones fork `main`, so the entrypoint must be there before a build). Needs Soren's OK.

```bash
chmod +x deploy/hf/entrypoint.sh
git add deploy/hf
git commit -m "Hugging Face Space container: grid + public API on 7860"
git push fork HEAD:main
```

Pages won't redeploy: no `frontend/**` change.

- [ ] **Step 5: Missing-key check (Review Focus 4).** Start Docker Desktop (`open -a Docker`, wait until `docker info` works), then:

```bash
docker build -t slac-hf deploy/hf
docker run --rm -e INVESTIGATOR_VISITOR_SALT=x slac-hf; echo "exit=$?"
```

Expected: the log says `Space secret FLWR_MODEL_API_KEY is missing` and exit is non-zero.

- [ ] **Step 6: Full local run with the real key** (read from `.env` by Docker, never typed or printed)

```bash
grep -E '^(FLWR_MODEL_API_ENDPOINT|FLWR_MODEL_API_KEY|INVESTIGATOR_MODEL)=' .env > /tmp/slac-hf.env && chmod 600 /tmp/slac-hf.env
docker run -d --name slac-hf -p 7860:7860 --env-file /tmp/slac-hf.env \
  -e INVESTIGATOR_VISITOR_SALT=local-test -e INVESTIGATOR_PUBLIC=1 -e INVESTIGATOR_ALLOWED_HOSTS=localhost \
  -e INVESTIGATOR_CORS_ORIGINS=https://iamsorenl.github.io -e INVESTIGATOR_DAILY_RUNS=15 -e INVESTIGATOR_VISITOR_RUNS=3 slac-hf
sleep 20; curl -s http://localhost:7860/api/v1/limits
```

Expected: `{"public":true,"runs_left_today":15,"visitor_runs_left":3,"busy":false}`.

Then start one run and poll it until it finishes:

```bash
curl -s -X POST -H 'Content-Type: application/json' http://localhost:7860/api/v1/investigations \
  -d '{"event_id":"slac-003","mode":"collaborative","question":"Was the beam disturbed?"}'
# poll: curl -s http://localhost:7860/api/v1/investigations/<id>   until status is completed or failed
```

Expected: `completed` within about 3 minutes. The result has `beam_disturbance` and `unique_cause`. Then run `docker rm -f slac-hf; rm /tmp/slac-hf.env`.

If it fails, `docker logs slac-hf` shows why. Fix before going on; nothing is public yet.

---

### Task 3: Create the Space

**Files:**
- Create: `deploy/hf/configure_space.py`

**Interfaces:**
- Consumes: local `.env` (`FLWR_MODEL_API_ENDPOINT`, `FLWR_MODEL_API_KEY`, `INVESTIGATOR_MODEL`), `deploy/hf/README.md`, `deploy/hf/Dockerfile`.
- Produces: public Space `<user>/slac-investigator` on `cpu-basic`, and its URL `https://<user>-slac-investigator.hf.space`, printed at the end.

- [ ] **Step 1 (Soren):** make a free account at huggingface.co if needed. Create a **write** token (Settings → Access Tokens), then run `! hf auth login` in this session. Check with `hf auth whoami`.

- [ ] **Step 2: `deploy/hf/configure_space.py`**

```python
"""Create or update the Hugging Face Space. Reads secrets from .env; never prints them.
Run: uv run --with huggingface_hub python deploy/hf/configure_space.py"""
import secrets
from pathlib import Path
from huggingface_hub import HfApi

ROOT = Path(__file__).resolve().parents[2]
NAME = 'slac-investigator'


def env_values():
    keep = {'FLWR_MODEL_API_ENDPOINT', 'FLWR_MODEL_API_KEY', 'INVESTIGATOR_MODEL'}
    pairs = (line.partition('=') for line in (ROOT / '.env').read_text().splitlines())
    return {k.strip(): v.strip().strip('\'"') for k, sep, v in pairs if sep and k.strip() in keep}


def main():
    api = HfApi()
    user = api.whoami()['name']
    repo = f'{user}/{NAME}'
    host = f"{user.lower().replace('_', '-').replace('.', '-')}-{NAME}.hf.space"
    api.create_repo(repo, repo_type='space', space_sdk='docker', space_hardware='cpu-basic', exist_ok=True)
    env = env_values()
    if not env.get('FLWR_MODEL_API_KEY'):
        raise SystemExit('FLWR_MODEL_API_KEY missing from .env')
    api.add_space_secret(repo, 'FLWR_MODEL_API_KEY', env['FLWR_MODEL_API_KEY'])
    known = {s for s in api.get_space_variables(repo)}  # variables only; secrets are write-only
    if 'SALT_SET' not in known:  # keep the salt stable across reruns so visitor counts survive redeploys
        api.add_space_secret(repo, 'INVESTIGATOR_VISITOR_SALT', secrets.token_hex(16))
        api.add_space_variable(repo, 'SALT_SET', '1')
    for key, value in {
        'FLWR_MODEL_API_ENDPOINT': env.get('FLWR_MODEL_API_ENDPOINT', 'https://api.groq.com/openai/v1/responses'),
        'INVESTIGATOR_MODEL': env.get('INVESTIGATOR_MODEL', 'openai/gpt-oss-20b'),
        'INVESTIGATOR_PUBLIC': '1', 'INVESTIGATOR_ALLOWED_HOSTS': host,
        'INVESTIGATOR_CORS_ORIGINS': 'https://iamsorenl.github.io',
        'INVESTIGATOR_DAILY_RUNS': '15', 'INVESTIGATOR_VISITOR_RUNS': '3',
    }.items():
        api.add_space_variable(repo, key, value)
    for name in ('README.md', 'Dockerfile'):
        api.upload_file(path_or_fileobj=str(ROOT / 'deploy/hf' / name), path_in_repo=name, repo_id=repo, repo_type='space')
    print(f'Space: https://huggingface.co/spaces/{repo}\nAPI:   https://{host}')


if __name__ == '__main__':
    main()
```

- [ ] **Step 3: Run it** (with Soren's OK: this creates a public Space and stores the Groq key as a secret)

Run: `uv run --with huggingface_hub python deploy/hf/configure_space.py`
Expected: two lines, `Space: …` and `API: https://<user>-slac-investigator.hf.space`. Nothing else is printed.

- [ ] **Step 4: Wait for the build.** Poll until the Space is running (about 3–6 minutes):

```bash
uv run --with huggingface_hub python -c "from huggingface_hub import HfApi;print(HfApi().get_space_runtime('<user>/slac-investigator').stage)"
```

Expected: `BUILDING`, then `RUNNING`. If `RUNTIME_ERROR` or `BUILD_ERROR`, read the logs on the Space page (Logs tab) and fix. Confirm the hardware is `cpu-basic` (free).

- [ ] **Step 5: Smoke check the public URL** (Review Focus 5)

```bash
curl -s https://<user>-slac-investigator.hf.space/api/v1/limits
curl -s -o /dev/null -w '%{http_code}\n' https://<user>-slac-investigator.hf.space/docs
```

Expected: the limits JSON with `"public":true`, and `404` for `/docs`. A `400 Invalid host header` means `INVESTIGATOR_ALLOWED_HOSTS` doesn't match. Fix the variable on the Space and restart it.

- [ ] **Step 6: Commit**

```bash
git add deploy/hf/configure_space.py
git commit -m "Script to create and configure the Hugging Face Space"
```

---

### Task 4: Point the site at the Space and check it end to end

**Files:**
- Modify: `frontend/assets/config.js`, `frontend/assets/live.js:91`

- [ ] **Step 1: Set the URL and the waking message**

In `frontend/assets/config.js`:

```js
export const PUBLIC_API='https://<user>-slac-investigator.hf.space';
```

In `frontend/assets/live.js`, replace the message in the `live.api.limits()` catch:

```js
onUnavailable?.("The live server is waking up or offline. Try again in a minute; the saved runs are here meanwhile.");
```

Run: `node --test frontend/tests/*.test.js` → all pass. `public.test.js` passes its own `publicAPI`, so it doesn't depend on config.js.

- [ ] **Step 2: Commit and push to fork `main`** (with Soren's OK), then wait for the Pages run.

```bash
git add frontend/assets/config.js frontend/assets/live.js
git commit -m "Point Pages at the Hugging Face Space"
git push fork HEAD:main
gh run watch -R iamsorenl/slac-investigator $(gh run list -R iamsorenl/slac-investigator -L1 --json databaseId -q '.[0].databaseId') --exit-status
```

- [ ] **Step 3: End-to-end checks**

1. **Laptop:** open https://iamsorenl.github.io/slac-investigator/. The "Ask your own" card is active. Click it: step 1 shows "15 live runs left today · 3 for you". Pick "A glitch the beam ignored" (slac-003), press Start. The three agents fill in, then the answer (per `docs/DEMO.md`, beam: not disturbed). Runs left drops to 14 and 2.
2. **Phone on cellular (not Wi-Fi):** open the same URL and click "Ask your own". It should show **3 for you** and 14 today. This is Review Focus 1: if it shows 2 for you, go to Step 4.
3. **Phone, 375 px:** the question box, Start button and story fit with no sideways scroll.
4. **Cap banner:** on the Space, set the variable `INVESTIGATOR_DAILY_RUNS=1` (it restarts). Press Start: the daily-limit banner and "See the saved runs" link appear. Set it back to `15`.
5. **Asleep or down (Review Focus 3):** on the Space page, Settings → Pause. Reload the site and click "Ask your own": the saved run stays and the "waking up or offline" note shows. Restart the Space.

- [ ] **Step 4 (only if check 2 failed):** Hugging Face's proxy peer isn't in `TRUSTED_PROXY_NETS`. Add a temporary log line in `visitor_id` printing `request.client.host` (not the forwarded header), redeploy (Settings → Factory rebuild), read one request in the Logs tab, and add that network to `TRUSTED_PROXY_NETS` with a test like Task 1's. Remove the log line, then commit, push and rebuild.

- [ ] **Step 5: Record** in the ledger `.superpowers/sdd/2026-09-29-live-demo-site/progress.md`: Space URL, one run's wall time, and the check results.

---

### Task 5: Docs and README wording

**Files:**
- Modify: `docs/DEPLOY.md`, `README.md` (fork), plus a PR to `GavinRS/slac-investigator` `README.md`

- [ ] **Step 1: `docs/DEPLOY.md`.** Add a "Hugging Face Space (default)" section at the top with: prerequisites (free HF account and write token, `hf auth login`), `uv run --with huggingface_hub python deploy/hf/configure_space.py`, how to redeploy after pushing code (Space → Settings → Factory rebuild), the 48 h sleep, the counter reset, and pausing to take it offline. Move the Oracle steps under "Alternative: a VM (Oracle, needs capacity)". Keep `deploy/server/` as it is.

- [ ] **Step 2: README "Try it live" wording** (fork now; PR to Gavin with Soren's OK). Replace the block from PR #38 with:

```markdown
**Try it live:** [iamsorenl.github.io/slac-investigator](https://iamsorenl.github.io/slac-investigator/): replay two real investigations, or pick "Ask your own" to question the agents live.

The demo is hosted from [Soren's fork](https://github.com/iamsorenl/slac-investigator) so it can stay up for free after the hackathon: the Flower grid runs on a free Hugging Face Space using Groq's free `gpt-oss-20b`, capped at 15 live runs a day. If nobody has used it for a couple of days, the first live run takes a minute to wake up. This repo is the main project; the fork only adds the hosting.
```

If #38 is still open, push this to its branch `soren/live-demo-link` instead of opening a new PR.

- [ ] **Step 3: Commit and push**

```bash
git add docs/DEPLOY.md README.md
git commit -m "Docs: Hugging Face Space is the default host; live wording"
git push fork HEAD:main
```
