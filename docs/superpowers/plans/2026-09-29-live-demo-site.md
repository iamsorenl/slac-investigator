# Live Demo Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Anyone can open the Fieldnote site on GitHub Pages, ask their own question about one of the 4 SLAC events, and watch a live Flower grid answer it, at $0 cost with daily caps.

**Architecture:** The existing FastAPI app gets an opt-in public mode (host/origin allowlist, grid-only, 500-char questions, daily caps counted in its SQLite job table, one run at a time). It runs on an Oracle Always Free VM behind Caddy (HTTPS via sslip.io), next to a self-hosted Flower SuperLink and 3 SuperNodes started by the existing `scripts/start_grid.sh`, using Groq's free gpt-oss-20b. The existing static frontend gets one configured public API URL and opens in live mode on the Pages origin, falling back to saved runs.

**Tech Stack:** Python 3 / FastAPI / SQLite / pytest; flwr 1.39; plain ES modules + `node --test`; systemd, Caddy, Ubuntu 24.04 arm64; GitHub Actions Pages.

**Spec:** `docs/superpowers/specs/2026-09-29-live-demo-site-design.md`

## Global Constraints

- Cost must be $0: Groq free tier with **no card on the account**; Oracle Always Free shape only; GitHub Pages on a public fork.
- Caps: `INVESTIGATOR_DAILY_RUNS=15`, `INVESTIGATOR_VISITOR_RUNS=3`; follow-ups count as runs; day resets at midnight `America/Los_Angeles`.
- Public mode is off unless `INVESTIGATOR_PUBLIC=1`. With it off, local behavior is unchanged and all existing tests pass.
- Public mode: `mode` must be `grid`; questions are at most 500 characters.
- Model on the server: `FLWR_MODEL_API_ENDPOINT=https://api.groq.com/openai/v1/responses`, `INVESTIGATOR_MODEL=openai/gpt-oss-20b`.
- Never print, log, or commit a key. `.env*` is gitignored; keep it that way. The browser never sends a provider, model, or key.
- Raw visitor IPs are never stored; only `sha256(salt + ip)[:16]`. Public mode refuses to start without `INVESTIGATOR_VISITOR_SALT`.
- Limit copy (exact):
  - `daily_limit`: "Lots of people tried this today, so live runs are paused until tomorrow (midnight Pacific). The saved runs show the same grid at work."
  - `visitor_limit`: "You've used your {n} live runs for today, thanks for trying it! Live runs reset at midnight Pacific; the saved runs are still here."
  - `busy`: "Someone else's run is in progress. Runs take a minute or two, so try again shortly."
- Live runs are labeled "Live run · Groq gpt-oss-20b on self-hosted Flower". The old slac-001 / slac-003 prototype replays ran on an OpenAI model through the Flower runtime; they must never be labeled as Flower-model runs.
- Outward-facing steps (fork creation, any push, Pages deploy, PR to GavinRS, anything on the VM) need Soren's explicit OK at that step.
- Do not touch `GavinRS/slac-investigator` except the one README PR in Task 9.

## Review Focus

1. **Two visitors press Start at the same moment.** Expect exactly one run to start and the other to get `busy`; the cap and busy checks happen inside the same `BEGIN IMMEDIATE` transaction as the insert. Test in Task 3.
2. **Every request reaches the API from Caddy on 127.0.0.1.** Without reading `X-Forwarded-For`, all visitors would share one 3-run bucket. Expect per-visitor counting from the forwarded IP when the peer is localhost. Test in Task 3.
3. **A visitor sends their own `X-Forwarded-For` straight to the API** (not via Caddy). Expect it to be ignored; the peer IP counts. Test in Task 3.
4. **A run hangs, or the API restarts mid-run.** Expect the demo not to be stuck on "busy" forever: restart marks jobs interrupted (existing `recover()`), and a queued/running job untouched for 15 minutes no longer counts as busy. Test in Task 3.
5. **The server is down or Groq refuses.** Expect the Pages site to show the saved runs with a plain notice, never a blank page or an error-only panel. Test in Task 5.

---

## File map

| File | Change | Responsibility |
|---|---|---|
| `slac_assistant/api.py` | modify | public-mode settings, visitor id, caps/busy check, `/api/v1/limits` |
| `tests/test_api_public.py` | create | all public-mode tests |
| `docs/API.md` | modify | drop stale grid note; document public mode and `/limits` |
| `frontend/assets/config.js` | create | the one public API URL + Pages origin |
| `frontend/assets/api.js` | modify | allow Pages→public API, `LimitError`, `limits()`, 500-char public limit |
| `frontend/assets/app.js` | modify | open live mode on Pages; fall back to replay |
| `frontend/assets/live.js` | modify | grid mode, public labels, runs-left, limit banners |
| `frontend/data/manifest.json` | modify | correct prototype-run labels |
| `frontend/index.html` | modify | footer credit line |
| `frontend/tests/public.test.js` | create | public client tests |
| `deploy/server/setup.sh` | create | idempotent VM setup + redeploy |
| `deploy/server/slac-grid.service`, `slac-api.service` | create | systemd units |
| `deploy/server/api.env.example` | create | API env for the VM |
| `docs/DEPLOY.md` | create | Oracle + deploy steps for Soren |
| `.github/workflows/frontend-pages.yml` | create (fork) | Pages deploy |
| `README.md` | modify | demo link + fork explanation |

Parallel tracks once Task 1 passes: **backend** (Task 2 → 3), **frontend** (Task 4 → 5; codes against the `/limits` and 429 contract defined in Task 3), **deploy** (Task 6). Tasks 7-9 are sequential and gated on Soren.

---

### Task 1: Prove a grid run through the API on Groq (local)

No product code unless something fails. This is the gate for everything else.

**Files:**
- Modify: `.env` (local, gitignored: switch the active provider block)
- Modify: `docs/API.md` (the "until the AgentApp's Grid orchestrator lands" sentence)

**Interfaces:**
- Consumes: Soren has added a line `GROQ_API_KEY=...` to `.env`.
- Produces: a measured run (wall time, model calls, whether Groq 429s appeared) recorded in the task report.

- [ ] **Step 1: Switch `.env` to the Groq block without printing the key**

```bash
.venv/bin/python - <<'EOF'
from pathlib import Path
p = Path('.env'); lines = p.read_text().splitlines()
groq = next(l.split('=', 1)[1].strip() for l in lines if l.startswith('GROQ_API_KEY='))
out = []
for l in lines:
    name = l.split('=', 1)[0].strip()
    if name in ('FLWR_MODEL_API_ENDPOINT', 'FLWR_MODEL_API_KEY', 'INVESTIGATOR_MODEL') and not l.startswith('#'):
        out.append('# nebius: ' + l)   # keep the old values, commented
    else:
        out.append(l)
out += ['FLWR_MODEL_API_ENDPOINT=https://api.groq.com/openai/v1/responses',
        f'FLWR_MODEL_API_KEY={groq}',
        'INVESTIGATOR_MODEL=openai/gpt-oss-20b']
p.write_text('\n'.join(out) + '\n'); p.chmod(0o600)
print('switched to groq; key length', len(groq))
EOF
```

Expected: `switched to groq; key length 56` (or similar). Never `cat` the file.

- [ ] **Step 2: Confirm the provider answers**

Run: `.venv/bin/python scripts/check_model.py`
Expected: success line naming `openai/gpt-oss-20b`. If it fails with 401, stop and tell Soren the key was rejected.

- [ ] **Step 3: Start the grid and API (two background shells)**

```bash
./scripts/start_grid.sh      # background: SuperLink + rf, ltu, dump
./scripts/start_api.sh       # background: API on 127.0.0.1:8080
```

- [ ] **Step 4: Run one grid investigation with a question**

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/investigations -H 'Content-Type: application/json' \
  -d '{"event_id":"slac-001","mode":"grid","question":"Was the beam disturbed, and do we know why?"}' | tee /tmp/slac-job.json
# poll until terminal:
JOB=$(python3 -c "import json;print(json.load(open('/tmp/slac-job.json'))['id'])")
while :; do S=$(curl -s http://127.0.0.1:8080/api/v1/investigations/$JOB | python3 -c "import json,sys;print(json.load(sys.stdin)['status'])"); echo $S; case $S in completed|failed|interrupted) break;; esac; sleep 5; done
curl -s http://127.0.0.1:8080/api/v1/investigations/$JOB/result | python3 -c "import json,sys;r=json.load(sys.stdin)['report'];print(r['final']['beam_disturbance']['status'],r['final']['unique_cause']['status'],r['metrics'])"
```

Expected: `completed`, then two statuses and a metrics dict. Record wall time and `model_calls`.

- [ ] **Step 5: If the run failed, stop and report**

If `failed` with `rate_limited`, or activity shows Groq 429s: do not patch anything. Report the error code, the failing step, and the activity tail to the controller. The fix (backoff in the model call path, or slower node pacing) gets its own task.

- [ ] **Step 6: Fix the stale doc note and commit**

In `docs/API.md`, replace the sentence starting "The API accepts `grid` now; until the AgentApp's Grid orchestrator lands" with:
"`grid` runs the three-node Grid orchestrator; verified end to end on Groq `openai/gpt-oss-20b` on 2026-09-29."

```bash
git add docs/API.md && git commit -m "API doc: grid mode verified end to end on Groq"
```

---

### Task 2: API public mode: settings, hosts, grid-only, question length

**Files:**
- Modify: `slac_assistant/api.py` (`create_app`, `start`, `followup`; new `Settings`)
- Create: `tests/test_api_public.py`

**Interfaces:**
- Produces:
  - `Settings` dataclass: `public: bool, allowed_hosts: list[str], daily_runs: int, visitor_runs: int, salt: str`
  - `load_settings(environ=os.environ) -> Settings`; raises `RuntimeError('INVESTIGATOR_VISITOR_SALT is required in public mode')` when public and salt is empty.
  - Public-mode 400s: `detail='Only grid investigations run on the public demo.'` and `detail='Questions are limited to 500 characters on the public demo.'`

- [ ] **Step 1: Write the failing tests**

Create `tests/test_api_public.py`:

```python
"""Public-mode tests: protocol fixture runner, no model calls."""
from fastapi.testclient import TestClient
import pytest

from slac_assistant.api import create_app, load_settings
from test_api import Runner, terminal   # tests/ has no __init__; pytest puts tests/ on sys.path

PUBLIC_ENV = {'INVESTIGATOR_PUBLIC': '1', 'INVESTIGATOR_ALLOWED_HOSTS': 'demo.sslip.io',
              'INVESTIGATOR_CORS_ORIGINS': 'https://iamsorenl.github.io',
              'INVESTIGATOR_VISITOR_SALT': 'test-salt',
              'INVESTIGATOR_DAILY_RUNS': '15', 'INVESTIGATOR_VISITOR_RUNS': '3'}


def public_app(tmp_path, monkeypatch, runner=None, **overrides):
    for key, value in {**PUBLIC_ENV, **overrides}.items():
        monkeypatch.setenv(key, value)
    return create_app(tmp_path/'api.db', runner or Runner())


def client_for(app, ip='127.0.0.1', forwarded=None, host='demo.sslip.io'):
    # One client per app per test: entering a TestClient runs the API lifespan
    # (recover() + executor shutdown on exit), so never open two on one app.
    client = TestClient(app, base_url=f'https://{host}', client=(ip, 5000))
    if forwarded:
        client.headers['X-Forwarded-For'] = forwarded
    return client


GRID = {'event_id': 'slac-001', 'mode': 'grid', 'question': 'Was the beam disturbed?'}


def test_public_mode_is_off_by_default(monkeypatch):
    for key in PUBLIC_ENV:
        monkeypatch.delenv(key, raising=False)
    settings = load_settings()
    assert settings.public is False and settings.daily_runs == 15 and settings.visitor_runs == 3


def test_public_mode_requires_salt(tmp_path, monkeypatch):
    with pytest.raises(RuntimeError, match='INVESTIGATOR_VISITOR_SALT'):
        public_app(tmp_path, monkeypatch, INVESTIGATOR_VISITOR_SALT='')


def test_public_rejects_unknown_host(tmp_path, monkeypatch):
    with client_for(public_app(tmp_path, monkeypatch), host='evil.example') as client:
        assert client.get('/api/v1/events').status_code == 400


def test_public_accepts_only_grid(tmp_path, monkeypatch):
    with client_for(public_app(tmp_path, monkeypatch), forwarded='198.51.100.7') as client:
        response = client.post('/api/v1/investigations', json={**GRID, 'mode': 'collaborative'})
        assert response.status_code == 400
        assert response.json()['detail'] == 'Only grid investigations run on the public demo.'


def test_public_question_limit_is_500(tmp_path, monkeypatch):
    with client_for(public_app(tmp_path, monkeypatch), forwarded='198.51.100.7') as client:
        response = client.post('/api/v1/investigations', json={**GRID, 'question': 'x'*501})
        assert response.status_code == 400
        assert response.json()['detail'] == 'Questions are limited to 500 characters on the public demo.'
        assert client.post('/api/v1/investigations', json={**GRID, 'question': 'x'*500}).status_code == 202
```

- [ ] **Step 2: Run to confirm failure**

Run: `.venv/bin/python -m pytest tests/test_api_public.py -q`
Expected: FAIL/ERROR with `ImportError: cannot import name 'load_settings'`.

- [ ] **Step 3: Implement**

In `slac_assistant/api.py`, add imports `from dataclasses import dataclass` and `from fastapi import Request`, then after `failure()` add:

```python
@dataclass
class Settings:
    public: bool
    allowed_hosts: list
    daily_runs: int
    visitor_runs: int
    salt: str


def load_settings(environ=os.environ):
    settings = Settings(
        public=environ.get('INVESTIGATOR_PUBLIC') == '1',
        allowed_hosts=[h.strip() for h in environ.get('INVESTIGATOR_ALLOWED_HOSTS', '').split(',') if h.strip()],
        daily_runs=int(environ.get('INVESTIGATOR_DAILY_RUNS', '15')),
        visitor_runs=int(environ.get('INVESTIGATOR_VISITOR_RUNS', '3')),
        salt=environ.get('INVESTIGATOR_VISITOR_SALT', ''))
    if settings.public and not settings.salt:
        raise RuntimeError('INVESTIGATOR_VISITOR_SALT is required in public mode')
    return settings


PUBLIC_QUESTION_LIMIT = 500
```

In `create_app`, first line: `settings = load_settings()`. Replace the TrustedHost line with:

```python
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=['127.0.0.1', 'localhost', 'testserver', *settings.allowed_hosts])
```

Add a helper inside `create_app` and call it from `start` (with `request.mode`, `request.question.strip()`) and `followup` (with `'grid'`, `request.question`):

```python
    def check_public(mode, question):
        if not settings.public:
            return
        if mode != 'grid':
            raise HTTPException(400, detail='Only grid investigations run on the public demo.')
        if len(question) > PUBLIC_QUESTION_LIMIT:
            raise HTTPException(400, detail='Questions are limited to 500 characters on the public demo.')
```

- [ ] **Step 4: Run all API tests**

Run: `.venv/bin/python -m pytest tests/test_api.py tests/test_api_public.py -q`
Expected: all pass (existing tests unchanged).

- [ ] **Step 5: Commit**

```bash
git add slac_assistant/api.py tests/test_api_public.py
git commit -m "API public mode: env settings, host allowlist, grid only, 500-char questions"
```

---

### Task 3: API caps, busy check, visitor id, `/api/v1/limits`

**Files:**
- Modify: `slac_assistant/api.py` (`Store.__init__`, `Store.enqueue`, new `Store.usage`, `start`, `followup`, new route)
- Modify: `tests/test_api_public.py`
- Modify: `docs/API.md` (new "Public mode" section)

**Interfaces:**
- Consumes: `Settings`, `load_settings`, `check_public` from Task 2.
- Produces:
  - `day_start(at=None) -> str`: UTC ISO string of the latest midnight `America/Los_Angeles` at or before `at`.
  - `visitor_id(request: Request, salt: str) -> str`: 16 hex chars.
  - `Store.usage(db, visitor, since) -> (total:int, mine:int, busy:bool)`.
  - `Store.enqueue(..., visitor=None, caps=None)`, where `caps` is a `Settings`; raises `HTTPException(429, detail={'code': ..., 'message': ...})`.
  - `GET /api/v1/limits` → `{"public": bool, "runs_left_today": int, "visitor_runs_left": int, "busy": bool}`.
  - 429 body: `{"detail": {"code": "daily_limit" | "visitor_limit" | "busy", "message": "<copy from Global Constraints>"}}`.

- [ ] **Step 1: Write the failing tests** (append to `tests/test_api_public.py`)

```python
from datetime import datetime, timedelta, timezone
import sqlite3
import threading

from fastapi import HTTPException
from slac_assistant.api import StartRequest, day_start


def start(client, ip='198.51.100.7', **extra):
    return client.post('/api/v1/investigations', json={**GRID, **extra}, headers={'X-Forwarded-For': ip})


def limits(client, ip='198.51.100.7'):
    return client.get('/api/v1/limits', headers={'X-Forwarded-For': ip}).json()


def test_day_start_is_pacific_midnight():
    before = datetime(2026, 9, 30, 6, 59, tzinfo=timezone.utc)   # 23:59 PDT Sep 29
    after = datetime(2026, 9, 30, 7, 0, tzinfo=timezone.utc)     # 00:00 PDT Sep 30
    assert day_start(before) == '2026-09-29T07:00:00+00:00'
    assert day_start(after) == '2026-09-30T07:00:00+00:00'


def test_visitor_cap_counts_followups_and_is_per_visitor(tmp_path, monkeypatch):
    with client_for(public_app(tmp_path, monkeypatch)) as c:
        job = start(c, '198.51.100.7').json(); terminal(c, job)
        for _ in range(2):
            follow = c.post(job['links']['followup'], json={'question': 'And the dump?'},
                            headers={'X-Forwarded-For': '198.51.100.7'})
            assert follow.status_code == 202; terminal(c, follow.json())
        blocked = start(c, '198.51.100.7')
        assert blocked.status_code == 429
        assert blocked.json()['detail']['code'] == 'visitor_limit'
        assert "You've used your 3 live runs for today" in blocked.json()['detail']['message']
        assert start(c, '198.51.100.8').status_code == 202


def test_daily_cap_across_visitors(tmp_path, monkeypatch):
    with client_for(public_app(tmp_path, monkeypatch, INVESTIGATOR_DAILY_RUNS='2')) as c:
        for ip in ('198.51.100.1', '198.51.100.2'):
            terminal(c, start(c, ip).json())
        response = start(c, '198.51.100.3')
        assert response.status_code == 429 and response.json()['detail']['code'] == 'daily_limit'
        assert limits(c, '198.51.100.3')['runs_left_today'] == 0


def test_busy_while_a_run_is_active(tmp_path, monkeypatch):
    gate = threading.Event()
    with client_for(public_app(tmp_path, monkeypatch, runner=Runner(gate=gate))) as c:
        first = start(c, '198.51.100.1').json()
        second = start(c, '198.51.100.2')
        assert second.status_code == 429 and second.json()['detail']['code'] == 'busy'
        assert limits(c, '198.51.100.2')['busy'] is True
        gate.set(); terminal(c, first)
        assert limits(c, '198.51.100.2')['busy'] is False


def test_simultaneous_enqueues_only_one_passes(tmp_path, monkeypatch):
    # Store level: no executor, so the first job stays queued and must block the rest.
    app = public_app(tmp_path, monkeypatch)
    settings, results = load_settings(), []
    def go(i):
        try:
            app.state.store.enqueue(request=StartRequest(**GRID), question='q', model='m', visitor=f'v{i}', caps=settings)
            results.append('ok')
        except HTTPException as exc:
            results.append(exc.detail['code'])
    threads = [threading.Thread(target=go, args=(i,)) for i in range(5)]
    [t.start() for t in threads]; [t.join() for t in threads]
    assert sorted(results) == ['busy', 'busy', 'busy', 'busy', 'ok']


def test_forwarded_header_ignored_when_not_from_proxy(tmp_path, monkeypatch):
    app = public_app(tmp_path, monkeypatch, INVESTIGATOR_VISITOR_RUNS='1')
    with client_for(app, ip='203.0.113.5') as c:
        terminal(c, start(c, '198.51.100.1').json())
        assert start(c, '198.51.100.99').json()['detail']['code'] == 'visitor_limit'


def test_raw_ip_is_never_stored(tmp_path, monkeypatch):
    with client_for(public_app(tmp_path, monkeypatch)) as c:
        terminal(c, start(c, '198.51.100.77').json())
    assert b'198.51.100.77' not in (tmp_path/'api.db').read_bytes()


def test_stale_active_job_does_not_block(tmp_path, monkeypatch):
    with client_for(public_app(tmp_path, monkeypatch)) as c:
        job = start(c).json(); terminal(c, job)
        old = (datetime.now(timezone.utc) - timedelta(minutes=20)).isoformat()
        with sqlite3.connect(tmp_path/'api.db') as db:
            db.execute("UPDATE jobs SET status='running', updated_at=? WHERE id=?", (old, job['id']))
        assert limits(c)['busy'] is False


def test_limits_shape_for_local_mode(tmp_path, monkeypatch):
    for key in PUBLIC_ENV:
        monkeypatch.delenv(key, raising=False)
    with TestClient(create_app(tmp_path/'api.db', Runner())) as c:
        assert c.get('/api/v1/limits').json() == {'public': False, 'runs_left_today': 15, 'visitor_runs_left': 3, 'busy': False}
```

- [ ] **Step 2: Run to confirm failure**

Run: `.venv/bin/python -m pytest tests/test_api_public.py -q`
Expected: new tests fail (`ImportError: day_start`).

- [ ] **Step 3: Implement**

Imports: `import hashlib`, `from datetime import timedelta`, `from zoneinfo import ZoneInfo`.

Module level:

```python
PACIFIC = ZoneInfo('America/Los_Angeles')
STALE_AFTER = timedelta(minutes=15)
PROXY_PEERS = {'127.0.0.1', '::1'}


def day_start(at=None):
    local = (at or datetime.now(timezone.utc)).astimezone(PACIFIC)
    return local.replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc).isoformat()


def visitor_id(request, salt):
    ip = request.client.host if request.client else 'unknown'
    forwarded = request.headers.get('x-forwarded-for')
    if ip in PROXY_PEERS and forwarded:
        ip = forwarded.split(',')[-1].strip()   # Caddy appends the real client last
    return hashlib.sha256((salt + ip).encode()).hexdigest()[:16]


def limit_messages(settings):
    return {
        'daily_limit': 'Lots of people tried this today, so live runs are paused until tomorrow (midnight Pacific). The saved runs show the same grid at work.',
        'visitor_limit': f"You've used your {settings.visitor_runs} live runs for today, thanks for trying it! Live runs reset at midnight Pacific; the saved runs are still here.",
        'busy': "Someone else's run is in progress. Runs take a minute or two, so try again shortly.",
    }
```

In `Store.__init__`, after `executescript`, add the column for existing databases:

```python
            try:
                db.execute('ALTER TABLE jobs ADD COLUMN visitor TEXT')
            except sqlite3.OperationalError:
                pass   # column already exists
```

Add to `Store`:

```python
    def usage(self, db, visitor, since):
        total = db.execute('SELECT COUNT(*) FROM jobs WHERE created_at>=?', (since,)).fetchone()[0]
        mine = db.execute('SELECT COUNT(*) FROM jobs WHERE created_at>=? AND visitor=?', (since, visitor)).fetchone()[0]
        fresh = (datetime.now(timezone.utc) - STALE_AFTER).isoformat()
        busy = db.execute("SELECT COUNT(*) FROM jobs WHERE status IN ('queued','running') AND updated_at>=?", (fresh,)).fetchone()[0] > 0
        return total, mine, busy
```

Change `enqueue` signature to `enqueue(self, request=None, series_id=None, question='', model=None, visitor=None, caps=None)`. Directly after `db.execute('BEGIN IMMEDIATE')`:

```python
            if caps is not None:
                total, mine, busy = self.usage(db, visitor, day_start())
                code = 'busy' if busy else 'daily_limit' if total >= caps.daily_runs else 'visitor_limit' if mine >= caps.visitor_runs else None
                if code:
                    raise HTTPException(429, detail={'code': code, 'message': limit_messages(caps)[code]})
```

Change the jobs INSERT to include `visitor`:

```python
            db.execute('INSERT INTO jobs (id,series_id,status,question,created_at,updated_at,visitor) VALUES (?,?,?,?,?,?,?)',
                       (job_id, series_id, 'queued', question, now(), now(), visitor))
```

In `create_app`, routes become (rename the body param so `Request` can be injected):

```python
    def caps_for(http_request):
        if not settings.public:
            return None, None
        return visitor_id(http_request, settings.salt), settings

    @app.post('/api/v1/investigations', status_code=202, response_model=StatusResponse)
    def start(body: StartRequest, http_request: Request):
        if body.event_id not in event_ids():
            raise HTTPException(404, detail='Event not found')
        question = body.question.strip()
        check_public(body.mode, question)
        visitor, caps = caps_for(http_request)
        return submit(store.enqueue(request=body, question=question, model=configured_model, visitor=visitor, caps=caps))

    @app.post('/api/v1/series/{series_id}/follow-ups', status_code=202, response_model=StatusResponse)
    def followup(series_id: str, body: FollowupRequest, http_request: Request):
        check_public('grid', body.question)
        visitor, caps = caps_for(http_request)
        return submit(store.enqueue(series_id=series_id, question=body.question, visitor=visitor, caps=caps))

    @app.get('/api/v1/limits')
    def limits(http_request: Request):
        visitor = visitor_id(http_request, settings.salt)
        with store.db() as db:
            total, mine, busy = store.usage(db, visitor, day_start())
        return {'public': settings.public, 'runs_left_today': max(0, settings.daily_runs - total),
                'visitor_runs_left': max(0, settings.visitor_runs - mine), 'busy': busy}
```

- [ ] **Step 4: Run the full Python suite**

Run: `.venv/bin/python -m pytest -q`
Expected: all pass (86 existing + the new public tests).

- [ ] **Step 5: Document in `docs/API.md`**

Add a `## Public mode` section after "Deployment, credentials and ownership": the env vars (`INVESTIGATOR_PUBLIC`, `INVESTIGATOR_ALLOWED_HOSTS`, `INVESTIGATOR_CORS_ORIGINS`, `INVESTIGATOR_VISITOR_SALT`, `INVESTIGATOR_DAILY_RUNS`, `INVESTIGATOR_VISITOR_RUNS`), grid-only, 500 characters, the three 429 codes with their exact messages, the day reset (midnight Pacific), the 15-minute stale rule, hashed visitor ids, and the `/api/v1/limits` shape. Add `/api/v1/limits` to the endpoint table. Edit the paragraph saying "This service is not a hosted backend" to: "Hosted only in public mode behind Caddy; see docs/DEPLOY.md."

- [ ] **Step 6: Commit**

```bash
git add slac_assistant/api.py tests/test_api_public.py docs/API.md
git commit -m "API public mode: daily and per-visitor caps, one run at a time, /limits"
```

---

### Task 4: Frontend public live client

**Files:**
- Create: `frontend/assets/config.js`
- Modify: `frontend/assets/api.js` (constructor, `request`, `start`, `followup`; new `LimitError`, `limits()`)
- Create: `frontend/tests/public.test.js`
- Modify: `frontend/tests/api.test.js` only if an existing assertion message changes (it must not; keep the phrase "saved-run replay only").

**Interfaces:**
- Consumes: the Task 3 contract (`/api/v1/limits` shape and 429 body).
- Produces:
  - `config.js`: `export const PUBLIC_API=''; export const PAGES_ORIGIN='https://iamsorenl.github.io';`
  - `new InvestigationAPI({pageOrigin, baseURL, fetchImpl, publicAPI=PUBLIC_API, pagesOrigin=PAGES_ORIGIN})` with `.public: boolean`, `.maxQuestion: 500|4000`, `.baseURL`.
  - `export class LimitError extends Error` with `.code`.
  - `api.limits() → Promise<{public, runs_left_today, visitor_runs_left, busy}>`.
  - `export function publicLiveAvailable(origin=location.origin)` → `Boolean(PUBLIC_API) && origin===PAGES_ORIGIN`.

- [ ] **Step 1: Write the failing tests**

`frontend/tests/public.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {InvestigationAPI,LimitError,SubmissionUncertainError} from '../assets/api.js';
const PAGES='https://iamsorenl.github.io',API='https://1-2-3-4.sslip.io',no=()=>assert.fail('no fetch expected');
const reply=(status,body)=>async()=>({ok:status<400,status,json:async()=>body});
test('Pages origin gets a live client only with a configured HTTPS public API',()=>{
 assert.throws(()=>new InvestigationAPI({pageOrigin:PAGES,publicAPI:'',fetchImpl:no}),/saved-run replay only/);
 assert.throws(()=>new InvestigationAPI({pageOrigin:'https://gavinrs.github.io',publicAPI:API,fetchImpl:no}),/saved-run replay only/);
 assert.throws(()=>new InvestigationAPI({pageOrigin:PAGES,publicAPI:'http://1-2-3-4.sslip.io',fetchImpl:no}),/HTTPS/);
 const api=new InvestigationAPI({pageOrigin:PAGES,publicAPI:API,fetchImpl:no});
 assert.equal(api.baseURL,API);assert.equal(api.public,true);assert.equal(api.maxQuestion,500);
});
test('local origins keep the loopback API and the 4,000-character limit',()=>{
 const api=new InvestigationAPI({pageOrigin:'http://127.0.0.1:5173',publicAPI:API,fetchImpl:no});
 assert.equal(api.baseURL,'http://127.0.0.1:8080');assert.equal(api.public,false);assert.equal(api.maxQuestion,4000);
});
test('429 limit replies become LimitError, not an uncertain submission',async()=>{
 const api=new InvestigationAPI({pageOrigin:PAGES,publicAPI:API,fetchImpl:reply(429,{detail:{code:'daily_limit',message:'Lots of people tried this today'}})});
 await assert.rejects(api.start('slac-001',{mode:'grid',question:'q'}),e=>e instanceof LimitError&&!(e instanceof SubmissionUncertainError)&&e.code==='daily_limit'&&/Lots of people/.test(e.message));
 assert.equal(api.submitting,false);
});
test('public questions over 500 characters are refused before any request',()=>{
 const api=new InvestigationAPI({pageOrigin:PAGES,publicAPI:API,fetchImpl:no});
 assert.throws(()=>api.start('slac-001',{mode:'grid',question:'x'.repeat(501)}),/500/);
 assert.throws(()=>api.followup('series','x'.repeat(501)),/500/);
});
test('limits() reads the limits endpoint on the public API',async()=>{
 let seen;const api=new InvestigationAPI({pageOrigin:PAGES,publicAPI:API,fetchImpl:async(url)=>{seen=url;return {ok:true,status:200,json:async()=>({public:true,runs_left_today:12,visitor_runs_left:3,busy:false})};}});
 assert.equal((await api.limits()).runs_left_today,12);assert.equal(seen,API+'/api/v1/limits');
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `node --test frontend/tests/public.test.js`
Expected: FAIL (`LimitError` not exported).

- [ ] **Step 3: Implement**

`frontend/assets/config.js`:

```js
// Public live API for GitHub Pages. Empty = Pages shows saved runs only. Set in Task 8.
export const PUBLIC_API='';
export const PAGES_ORIGIN='https://iamsorenl.github.io';
```

`frontend/assets/api.js`: add `import {PUBLIC_API,PAGES_ORIGIN} from './config.js';` at the top and `export class LimitError extends Error{constructor(code,message){super(message);this.code=code;}}`. Replace the constructor:

```js
  constructor({pageOrigin=location.origin,baseURL,fetchImpl=(...args)=>fetch(...args),publicAPI=PUBLIC_API,pagesOrigin=PAGES_ORIGIN}={}){
    this.public=Boolean(publicAPI)&&pageOrigin===pagesOrigin;
    if(!LOCAL_ORIGINS.has(pageOrigin)&&!this.public)throw new Error('Live execution is not available from this origin; saved-run replay only.');
    const url=new URL(baseURL??(this.public?publicAPI:'http://127.0.0.1:8080'));
    if(this.public){if(url.protocol!=='https:'||url.origin!==new URL(publicAPI).origin||url.username||url.password)throw new Error('The public API must be the configured HTTPS address.');}
    else if(url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname)||url.username||url.password)throw new Error('Only the documented loopback development API is supported.');
    this.baseURL=url.origin;this.fetch=fetchImpl;this.submitting=false;this.maxQuestion=this.public?500:4000;
  }
```

Note: in the public case the message for a non-HTTPS URL must match `/HTTPS/`; when `publicAPI` itself is `http:`, `this.public` is true and the check above throws that message.

In `request`, before the generic `if(!response.ok)` line:

```js
    if(response.status===429&&payload.detail?.code)throw new LimitError(payload.detail.code,payload.detail.message);
```

Replace `start`, `followup` length checks to use `this.maxQuestion`, and add `limits`:

```js
  start(eventId,{mode='collaborative',question=''}={}){const q=question.trim();if(q.length>this.maxQuestion)throw new Error(`Enter a question of at most ${this.maxQuestion.toLocaleString('en-US')} characters.`);return this.submit('/api/v1/investigations',q?{event_id:eventId,mode,question:q}:{event_id:eventId,mode});}
  followup(seriesId,question){
    const q=question.trim();if(!q||q.length>this.maxQuestion)throw new Error(`Enter a question of 1–${this.maxQuestion.toLocaleString('en-US')} characters.`);
    return this.submit(`/api/v1/series/${encodeURIComponent(seriesId)}/follow-ups`,{question:q});
  }
  limits(){return this.request('/api/v1/limits');}
```

Add at the bottom:

```js
export function publicLiveAvailable(origin=location.origin){return Boolean(PUBLIC_API)&&origin===PAGES_ORIGIN;}
```

- [ ] **Step 4: Run all frontend tests**

Run: `node --test frontend/tests/*.test.js`
Expected: all pass (13 existing + 5 new). If the existing "Pages and foreign origins" test fails on message text, the new message must still contain "saved-run replay only"; fix the message, not the test.

- [ ] **Step 5: Commit**

```bash
git add frontend/assets/config.js frontend/assets/api.js frontend/tests/public.test.js
git commit -m "Frontend: public HTTPS API client for Pages, LimitError, limits()"
```

---

### Task 5: Live page on Pages, limit banners, labels, credit

**Files:**
- Modify: `frontend/assets/app.js:99-107` (mode switch at the bottom)
- Modify: `frontend/assets/live.js` (`live` state, `render`, `submit`, `initLive`)
- Modify: `frontend/data/manifest.json` (prototype labels)
- Modify: `frontend/index.html:23` (footer)
- Modify: `frontend/build.mjs` (no change needed if `assets/` is copied whole; verify `config.js` lands in `dist/assets/`)
- Test: `frontend/tests/public.test.js` (append)

**Interfaces:**
- Consumes: `publicLiveAvailable`, `LimitError`, `api.limits()`, `api.public`, `api.maxQuestion` from Task 4.
- Produces: `initLive({onUnavailable})` in `live.js`; when the public API cannot be reached, it calls `onUnavailable(message)` instead of throwing.

- [ ] **Step 1: Write the failing test** (append to `frontend/tests/public.test.js`)

Pure helper, so it is testable without a DOM:

```js
import {limitBanner} from '../assets/live.js';
test('limit banners show the server message and a link to the saved runs',()=>{
 const html=limitBanner({code:'visitor_limit',message:"You've used your 3 live runs for today"});
 assert.match(html,/You've used your 3 live runs/);assert.match(html,/href="\?mode=replay"/);
 assert.doesNotMatch(limitBanner({code:'busy',message:'<script>'}),/<script>/);
});
```

`live.js` imports DOM helpers at module load. If importing it under node fails on `document`, move `limitBanner` into `replay.js` (which the tests already import) and import it from there in `live.js`; adjust the test import to match.

- [ ] **Step 2: Run to confirm failure**

Run: `node --test frontend/tests/public.test.js`
Expected: FAIL (`limitBanner` not exported).

- [ ] **Step 3: Implement**

`limitBanner` (exported; uses the existing `escapeHTML`):

```js
export function limitBanner(error){return `<div class="live-error limit-banner" role="status"><p>${h(error.message)}</p><a class="button secondary" href="?mode=replay">See the saved runs ↗</a></div>`;}
```

`live.js` changes:
1. State: add `limits:null, limitError:null` to `live`.
2. `submit()`: send `mode:'grid'` (both the first call and the 422 fallback keep `mode:'grid'`). In the `catch`: `if(e instanceof LimitError){live.limitError=e;}else{live.error=e.message;...existing...}`. In `finally`: `try{live.limits=await live.api.limits();}catch{}` before `render()`.
3. `render()`: when `live.api.public`, use these labels instead of the local ones: eyebrow `LIVE RUN / ${id}`, subtitle "Ask your own question. A live Flower grid on Groq gpt-oss-20b answers it; nothing here is pre-recorded.", meta "Execution" → "Live run · Groq gpt-oss-20b on self-hosted Flower", event button subtitle "Live event". Under the page heading add `${live.limits?`<p class="small muted">${live.limits.runs_left_today} live runs left today · you have ${live.limits.visitor_runs_left}</p>`:''}` and `${live.limitError?limitBanner(live.limitError):''}`. Textarea `maxlength` uses `${live.api.maxQuestion}`. Disable Start when `live.limits&&(live.limits.runs_left_today===0||live.limits.visitor_runs_left===0)`. Clear `live.limitError` at the start of each `submit`.
4. `initLive({onUnavailable}={})`: build `live.api=new InvestigationAPI()`; if `live.api.public`, first `try{live.limits=await live.api.limits();}catch(e){onUnavailable?.('Live runs are unavailable right now, so here are the saved runs.');return;}`. Set the mode pill to `Live · Groq on Flower` when public, keep "Local live execution" otherwise. The replay-notice link becomes `href="?mode=replay"`.

`app.js` bottom block becomes:

```js
const params=new URLSearchParams(location.search);
const wantLive=params.get('mode')!=='replay'&&((params.get('mode')==='live'&&LOCAL_ORIGINS.has(location.origin))||publicLiveAvailable());
if(wantLive){
  import('./live.js').then(m=>m.initLive({onUnavailable:message=>{error(message);init();}})).catch(e=>{
    if(publicLiveAvailable()){error('Live runs are unavailable right now, so here are the saved runs.');init();return;}
    error(e.message);$('#content').setAttribute('aria-busy','false');$('#content').innerHTML='<section class="panel"><div class="assessment-body"><h2>Backend connection unavailable</h2><p>No investigation was submitted. The backend owner manages API availability; this page has not switched to replay.</p><a href="./">Open saved replay explicitly ↗</a></div></section>';$('#event-list').textContent='API connection unavailable.';});
}else{
  if(params.get('mode')==='live')error('Live execution is unavailable on this origin. This is saved-run replay; no backend was contacted.');
  init();
}
```

with `publicLiveAvailable` added to the existing `import {LOCAL_ORIGINS} from './api.js';`. On Pages, add a "Try it live ↗" link (`href="./"`) to the replay notice when `publicLiveAvailable()`.

`manifest.json`: for `slac-001` and `slac-003` add `"note": "Prototype run: Flower runtime, OpenAI model (not a Flower-hosted model)"`. Change the top-level `description` to "Saved runs. Opening or replaying one does not execute a model." Before editing, confirm the model in `frontend/data/slac-001.json` and `slac-003.json` (`runs[].events` where `kind=='started'`, field `model`) is an OpenAI model; if it is not, stop and report.

`index.html` footer:

```html
<footer>Built at the Flower Collaborative Agent Hackathon (Stanford, 2026) by the slac-investigator team · <a href="https://github.com/GavinRS/slac-investigator">original repo</a> · SLAC public archive · Operator review required</footer>
```

- [ ] **Step 4: Run tests and a browser check**

```bash
node --test frontend/tests/*.test.js
node frontend/build.mjs && ls frontend/dist/assets/config.js
python3 -m http.server 5173 --bind 127.0.0.1 --directory frontend
```

Expected: all tests pass; `config.js` is in `dist`. With the Task 1 grid + API running, open `http://127.0.0.1:5173/?mode=live`, start a run, and confirm the activity panel shows `delegation` → `node_report` → `finding` for rf, ltu and dump, with the runs-left line. Then open `http://127.0.0.1:5173/` and confirm the replay still works and the prototype runs show the OpenAI note.

- [ ] **Step 5: Commit**

```bash
git add frontend/assets frontend/data/manifest.json frontend/index.html frontend/tests/public.test.js
git commit -m "Frontend: live grid questions on Pages with caps, fallback to saved runs, honest labels"
```

---

### Task 6: Server setup (VM scripts and units)

**Files:**
- Create: `deploy/server/setup.sh`
- Create: `deploy/server/slac-grid.service`
- Create: `deploy/server/slac-api.service`
- Create: `deploy/server/api.env.example`
- Create: `docs/DEPLOY.md`

**Interfaces:**
- Consumes: `scripts/start_grid.sh`, `scripts/start_api.sh` (unchanged), the Task 2/3 env vars.
- Produces: `sudo /opt/slac-investigator/deploy/server/setup.sh <ip-with-dashes>.sslip.io` sets up or redeploys; services `slac-grid`, `slac-api`, `caddy`.

- [ ] **Step 1: Write `deploy/server/slac-grid.service`**

```ini
[Unit]
Description=SLAC grid: Flower SuperLink + rf, ltu, dump SuperNodes
After=network-online.target
Wants=network-online.target

[Service]
User=slac
WorkingDirectory=/opt/slac-investigator
ExecStart=/opt/slac-investigator/scripts/start_grid.sh
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Write `deploy/server/slac-api.service`**

```ini
[Unit]
Description=SLAC investigation API (public mode)
After=slac-grid.service
Requires=slac-grid.service

[Service]
User=slac
WorkingDirectory=/opt/slac-investigator
EnvironmentFile=/opt/slac-investigator/api.env
ExecStart=/opt/slac-investigator/scripts/start_api.sh
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 3: Write `deploy/server/api.env.example`**

```sh
# Copy to /opt/slac-investigator/api.env (mode 600). The model key does NOT go here; it goes in .env.
INVESTIGATOR_PUBLIC=1
INVESTIGATOR_ALLOWED_HOSTS=REPLACE-with-host.sslip.io
INVESTIGATOR_CORS_ORIGINS=https://iamsorenl.github.io
INVESTIGATOR_DAILY_RUNS=15
INVESTIGATOR_VISITOR_RUNS=3
INVESTIGATOR_MODEL=openai/gpt-oss-20b
# setup.sh fills this with a random value on first run:
INVESTIGATOR_VISITOR_SALT=
```

- [ ] **Step 4: Write `deploy/server/setup.sh`**

```bash
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
```

- [ ] **Step 5: Syntax-check**

Run: `bash -n deploy/server/setup.sh && echo ok` and, if installed, `shellcheck deploy/server/setup.sh`.
Expected: `ok`; no shellcheck errors (warnings about `sudo -u ... bash -c` quoting are acceptable if explained).

- [ ] **Step 6: Write `docs/DEPLOY.md`**

Contents, in order:
1. **Oracle account:** sign up at cloud.oracle.com. The card is for identity verification; stay on "Always Free" and never click "Upgrade to Pay As You Go".
2. **Create the VM:** Compute → Instances → Create. Image: Canonical Ubuntu 24.04 (aarch64). Shape: `VM.Standard.A1.Flex`, 2 OCPU, 12 GB (inside the Always Free 4 OCPU / 24 GB). Paste your SSH public key (`~/.ssh/id_ed25519.pub`). Assign a public IPv4.
3. **Open ports in Oracle's network:** Networking → the VCN → default security list → add ingress rules for TCP 80 and 443 from `0.0.0.0/0`.
4. **Host name:** public IP `1.2.3.4` → `1-2-3-4.sslip.io`.
5. **First setup:** `ssh ubuntu@1.2.3.4`, `sudo git clone https://github.com/iamsorenl/slac-investigator /opt/slac-investigator`, create `/opt/slac-investigator/.env` with the three Groq lines (endpoint, key, model) yourself, then `sudo /opt/slac-investigator/deploy/server/setup.sh 1-2-3-4.sslip.io`.
6. **Redeploy after a push:** `ssh ubuntu@1.2.3.4 sudo /opt/slac-investigator/deploy/server/setup.sh 1-2-3-4.sslip.io`.
7. **Logs:** `journalctl -u slac-grid -u slac-api -f`.
8. **Change caps:** edit `api.env`, then `sudo systemctl restart slac-api`.
9. **If Oracle reclaims the VM:** create a new one and repeat steps 2-5; then update `PUBLIC_API` in `frontend/assets/config.js` and push.

- [ ] **Step 7: Commit**

```bash
git add deploy/server docs/DEPLOY.md
git commit -m "Server: rerunnable Oracle VM setup, systemd units, Caddy, deploy guide"
```

---

### Task 7: Fork and Pages workflow (Soren approves each outward step)

**Files:**
- Create: `.github/workflows/frontend-pages.yml`

- [ ] **Step 1: Ask Soren to approve creating the fork**, then:

```bash
gh repo fork GavinRS/slac-investigator --remote --remote-name fork --clone=false
```

- [ ] **Step 2: Install the workflow** (the reviewed template with a push trigger added)

```bash
mkdir -p .github/workflows
sed -e 's/^# Install at.*$/# Deploys the static frontend from this fork to GitHub Pages./' \
    -e 's/^# Intentionally manual.*$/# Runs on frontend changes to main, or by hand./' \
    -e 's/^  workflow_dispatch:$/  workflow_dispatch:\n  push:\n    branches: [main]\n    paths: ["frontend\/**"]/' \
    frontend/deploy/github-pages.yml > .github/workflows/frontend-pages.yml
cat .github/workflows/frontend-pages.yml | head -12
```

Expected: `on:` contains `workflow_dispatch:` and a `push:` block limited to `frontend/**`.

- [ ] **Step 3: Commit, then ask Soren to approve pushing `soren/live-site` to the fork's `main`**

```bash
git add .github/workflows/frontend-pages.yml
git commit -m "Pages workflow for the fork"
git push fork soren/live-site:main
```

- [ ] **Step 4: Soren sets fork Settings → Pages → Source: "GitHub Actions"**, then:

```bash
gh workflow run frontend-pages.yml -R iamsorenl/slac-investigator
gh run watch -R iamsorenl/slac-investigator
curl -sI https://iamsorenl.github.io/slac-investigator/ | head -1
```

Expected: run succeeds; `HTTP/2 200`. The site shows saved runs (PUBLIC_API still empty).

---

### Task 8: Provision, deploy, and prove it live (Soren steps marked)

- [ ] **Step 1 (Soren):** follow `docs/DEPLOY.md` steps 1-4 and send the public IP.
- [ ] **Step 2 (Soren, or controller with approval):** SSH in, clone, create `.env` with the Groq block, run `setup.sh <ip>.sslip.io`. Expected last line: `Live at https://<ip>.sslip.io` after a JSON `/limits` body.
- [ ] **Step 3: Point the site at the server**

In `frontend/assets/config.js` set `export const PUBLIC_API='https://<ip-with-dashes>.sslip.io';`. Run `node --test frontend/tests/*.test.js`, commit ("Point Pages at the live server"), and push to `fork main` with Soren's OK. Wait for the Pages run to finish.

- [ ] **Step 4: End-to-end checks**

1. Laptop browser: open `https://iamsorenl.github.io/slac-investigator/`. It opens in live mode showing "15 live runs left today". Ask a question on slac-003; the run completes with rf suspicious and ltu/dump normal (per `docs/DEMO.md`). Runs-left drops to 14.
2. Phone on cellular: open the same URL; confirm it shows the visitor's own count (3) and today's total (14).
3. Cap banner: on the VM set `INVESTIGATOR_DAILY_RUNS=1` in `api.env`, `sudo systemctl restart slac-api`, press Start: the `daily_limit` banner and "See the saved runs" link appear. Restore `15` and restart.
4. Down path: `sudo systemctl stop slac-api`, reload the site: it shows the saved runs with "Live runs are unavailable right now". Start it again.

- [ ] **Step 5: Record the result** in the task report: URL, run wall time, model calls. No commit needed beyond Step 3.

---

### Task 9: Link it from the original repo

**Files:**
- Modify: `README.md` (fork `main`, and a PR to `GavinRS/slac-investigator`)

- [ ] **Step 1: README text (same block in both repos), under the title**

```markdown
**Try it live:** [iamsorenl.github.io/slac-investigator](https://iamsorenl.github.io/slac-investigator/): pick a SLAC event, ask your own question, and watch the grid answer.

The live demo runs from [Soren's fork](https://github.com/iamsorenl/slac-investigator) so it can be hosted for free after the hackathon: a self-hosted Flower SuperLink with the rf, ltu and dump SuperNodes on a small cloud VM, using Groq's free `gpt-oss-20b`. Live runs are capped at 15 a day. This repo is the main project; the fork only adds the hosting.
```

In the fork README only, add one line under it: "This is a fork of [GavinRS/slac-investigator](https://github.com/GavinRS/slac-investigator), the team's main repo."

- [ ] **Step 2: With Soren's OK, commit to the fork and open the PR to GavinRS**

```bash
git switch -c soren/live-demo-link origin/main
# apply the README block (without the fork-only line)
git commit -am "README: link the live demo"
git push origin soren/live-demo-link
gh pr create -R GavinRS/slac-investigator --title "README: link the live demo" --body "Adds a Try it live link to the hosted demo and explains that it runs from a fork for free hosting.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

- [ ] **Step 3: Give Soren the message for Gavin**: "Could you set the repo's About → Website to https://iamsorenl.github.io/slac-investigator/ ? And merge the README PR when you get a sec."
