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


GRID = {'event_id': 'slac-001', 'mode': 'collaborative', 'question': 'Was the beam disturbed?'}


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


def test_public_accepts_only_collaborative(tmp_path, monkeypatch):
    with client_for(public_app(tmp_path, monkeypatch), forwarded='198.51.100.7') as client:
        response = client.post('/api/v1/investigations', json={**GRID, 'mode': 'grid'})
        assert response.status_code == 400
        assert response.json()['detail'] == 'Only collaborative (model-backed grid) investigations run on the public demo.'


def test_public_question_limit_is_500(tmp_path, monkeypatch):
    with client_for(public_app(tmp_path, monkeypatch), forwarded='198.51.100.7') as client:
        response = client.post('/api/v1/investigations', json={**GRID, 'question': 'x'*501})
        assert response.status_code == 400
        assert response.json()['detail'] == 'Questions are limited to 500 characters on the public demo.'
        assert client.post('/api/v1/investigations', json={**GRID, 'question': 'x'*500}).status_code == 202


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


def test_visitor_ip_is_rightmost_forwarded_address(tmp_path, monkeypatch):
    with client_for(public_app(tmp_path, monkeypatch, INVESTIGATOR_VISITOR_RUNS='1')) as c:
        first = start(c, '9.9.9.9, 198.51.100.1'); assert first.status_code == 202; terminal(c, first.json())
        again = start(c, '198.51.100.1')
        assert again.status_code == 429 and again.json()['detail']['code'] == 'visitor_limit'
        assert start(c, '198.51.100.2').status_code == 202


def test_public_mode_hides_api_docs(tmp_path, monkeypatch):
    with client_for(public_app(tmp_path, monkeypatch)) as c:
        assert c.get('/docs').status_code == 404 and c.get('/openapi.json').status_code == 404


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
        assert start(c, '198.51.100.1, 198.51.100.2, 10.0.0.2').status_code == 202


def test_forwarded_with_only_private_hops_falls_back_to_peer(tmp_path, monkeypatch):
    with client_for(public_app(tmp_path, monkeypatch, INVESTIGATOR_VISITOR_RUNS='1'), ip='10.0.0.1') as c:
        first = start(c, '10.0.0.7'); assert first.status_code == 202; terminal(c, first.json())
        assert start(c, '10.0.0.8').json()['detail']['code'] == 'visitor_limit'
