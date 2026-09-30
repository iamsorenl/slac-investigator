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
