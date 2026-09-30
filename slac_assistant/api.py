"""Local frontend API. Provider configuration is owned by SuperLink, never clients."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sqlite3
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from typing import Literal

from .data import ROOT, event_ids, load_event
from .runtime import run_flower
from .workflow import configured_model as configured_model_setting


def now():
    return datetime.now(timezone.utc).isoformat()


def public(value, key=''):
    """Redact credentials and represent nanoseconds losslessly for JavaScript."""
    if isinstance(value, dict):
        return {k: public(v, k) for k, v in value.items()
                if k.lower() not in {'api_key', 'authorization', 'headers', 'token', 'secret',
                                     'flwr_model_api_key', 'flwr_runtime_api_key'}}
    if isinstance(value, list):
        return [public(v, key) for v in value]
    if isinstance(value, int) and not isinstance(value, bool) and key.endswith('_ns'):
        return str(value)
    if isinstance(value, str):
        for name, secret in os.environ.items():
            if any(word in name.upper() for word in ('KEY', 'TOKEN', 'SECRET')) and len(secret) >= 8:
                value = value.replace(secret, '[REDACTED]')
        return re.sub(r'\bsk-[\w.*-]+', '[REDACTED]', value)
    return value


def failure(exc):
    """Do not echo provider bodies, request headers, or SDK exception strings."""
    text = str(exc).lower()
    choices = [
        ('missing_environment', ('model api key is not set', 'missing environment', 'flwr_runtime_base_url', 'flwr_runtime_api_key'), 'Required server environment is missing.'),
        ('credential_rejected', ('invalid_api_key', 'incorrect api key', 'authentication failed', '401'), 'The provider rejected the server credential.'),
        ('billing_quota', ('insufficient_quota', 'billing', 'exceeded your current quota'), 'Provider billing or quota blocked the request.'),
        ('model_unavailable', ('model_not_found', 'model does not exist', 'do not have access to', 'model unavailable'), 'The configured model is unavailable to this server.'),
        ('rate_limited', ('rate_limit', '429'), 'The provider rate-limited the request.'),
    ]
    for code, needles, message in choices:
        if any(needle in text for needle in needles):
            return {'code': code, 'message': message}
    return {'code': 'workflow_failed', 'message': 'Flower did not complete the investigation. Inspect server logs.'}


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


class StartRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    event_id: str = Field(pattern=r'^slac-\d{3}$')
    mode: Literal['collaborative', 'baseline', 'smoke', 'grid'] = 'collaborative'
    question: str = Field(default='', max_length=4000)


class FollowupRequest(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)
    question: str = Field(min_length=1, max_length=4000)

class StatusResponse(BaseModel):
    id: str
    series_id: str
    event_id: str
    mode: str
    model: str
    status: Literal['queued','running','completed','failed','interrupted']
    created_at: str
    updated_at: str
    flower_run_id: str | None
    flower_series_id: str | None
    error: dict | None
    links: dict[str,str]

class ActivityResponse(BaseModel):
    investigation_id: str
    status: str
    events: list[dict]
    next_cursor: int
    has_more: bool

class ResultResponse(BaseModel):
    investigation_id: str
    series_id: str
    report: dict


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.db() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS series (
                    id TEXT PRIMARY KEY, event_id TEXT NOT NULL, mode TEXT NOT NULL,
                    model TEXT NOT NULL, flower_series_id TEXT, latest_job TEXT);
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY, series_id TEXT NOT NULL, status TEXT NOT NULL,
                    question TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    flower_run_id TEXT, flower_series_id TEXT, result TEXT, error TEXT);
                CREATE TABLE IF NOT EXISTS activity (
                    job_id TEXT NOT NULL, seq INTEGER NOT NULL, created_at TEXT NOT NULL,
                    payload TEXT NOT NULL, PRIMARY KEY(job_id, seq));
            ''')
        os.chmod(self.path, 0o600)

    @contextmanager
    def db(self):
        db = sqlite3.connect(self.path, timeout=30)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def recover(self):
        with self.db() as db:
            db.execute("UPDATE jobs SET status='interrupted', updated_at=?, error=? WHERE status IN ('queued','running')",
                       (now(), json.dumps({'code': 'server_restarted', 'message': 'API restarted; no automatic resubmission. Flower may still be running.'})))

    def get(self, job_id):
        with self.db() as db:
            row = db.execute('SELECT jobs.*, series.event_id, series.mode, series.model FROM jobs JOIN series ON series.id=jobs.series_id WHERE jobs.id=?', (job_id,)).fetchone()
        if row is None:
            raise HTTPException(404, detail='Investigation not found')
        return dict(row)

    def update(self, job_id, **fields):
        # All column names come from server code, never request input.
        fields['updated_at'] = now()
        with self.db() as db:
            db.execute('UPDATE jobs SET '+','.join(k+'=?' for k in fields)+' WHERE id=?', (*fields.values(), job_id))

    def append(self, job_id, event):
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            seq = db.execute('SELECT COALESCE(MAX(seq),0)+1 FROM activity WHERE job_id=?', (job_id,)).fetchone()[0]
            db.execute('INSERT INTO activity VALUES (?,?,?,?)', (job_id, seq, now(), json.dumps(public(event))))

    def enqueue(self, request=None, series_id=None, question='', model=None):
        job_id = str(uuid4())
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            if series_id is None:
                series_id = str(uuid4())
                db.execute('INSERT INTO series VALUES (?,?,?,?,NULL,NULL)',
                           (series_id, request.event_id, request.mode, model))
            else:
                series = db.execute('SELECT * FROM series WHERE id=?', (series_id,)).fetchone()
                if series is None:
                    raise HTTPException(404, detail='Series not found')
                latest = db.execute('SELECT status FROM jobs WHERE id=?', (series['latest_job'],)).fetchone()
                if series['mode'] == 'smoke':
                    raise HTTPException(409, detail='Smoke investigations do not support human follow-ups')
                if not latest or latest['status'] != 'completed' or not series['flower_series_id']:
                    raise HTTPException(409, detail='Follow-up requires the latest run to be completed; an active, failed, or interrupted series cannot advance')
            db.execute('INSERT INTO jobs (id,series_id,status,question,created_at,updated_at) VALUES (?,?,?,?,?,?)',
                       (job_id, series_id, 'queued', question, now(), now()))
            db.execute('UPDATE series SET latest_job=? WHERE id=?', (job_id, series_id))
        return job_id


def status(row):
    keys = ('id', 'series_id', 'event_id', 'mode', 'model', 'status', 'created_at', 'updated_at', 'flower_run_id', 'flower_series_id')
    result = {key: row[key] for key in keys}
    result['error'] = json.loads(row['error']) if row['error'] else None
    result['links'] = {name: f"/api/v1/investigations/{row['id']}"+suffix
                       for name, suffix in [('status', ''), ('activity', '/activity'), ('result', '/result')]}
    result['links']['followup'] = f"/api/v1/series/{row['series_id']}/follow-ups"
    return public(result)


def create_app(db_path=None, runner=run_flower):
    settings = load_settings()
    store = Store(db_path or ROOT/'artifacts/api/state.sqlite3')
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='flower-api')
    configured_model = configured_model_setting()
    address = os.environ.get('FLOWER_CONTROL_URL', 'http://127.0.0.1:8000')

    def work(job_id):
        row = store.get(job_id)
        store.update(job_id, status='running')
        with store.db() as db:
            series = dict(db.execute('SELECT * FROM series WHERE id=?', (row['series_id'],)).fetchone())
        expected_series = series['flower_series_id']

        def started(run_id, flower_series_id):
            store.update(job_id, flower_run_id=str(run_id), flower_series_id=str(flower_series_id))
            if expected_series and str(flower_series_id) != expected_series:
                raise RuntimeError('Flower changed the follow-up series')
            with store.db() as db:
                db.execute('UPDATE series SET flower_series_id=? WHERE id=?', (str(flower_series_id), row['series_id']))

        try:
            report, sid = runner(row['event_id'], mode=row['mode'], question=row['question'],
                                 model=row['model'], series_id=int(expected_series) if expected_series else None,
                                 address=address, on_event=lambda e: store.append(job_id, e), on_started=started)
            if expected_series and str(sid) != expected_series:
                raise RuntimeError('Flower changed the follow-up series')
            if report.get('result_schema_version') != 2:
                raise RuntimeError('Legacy mixed-scope result rejected; original traces remain archived')
            started(report['flower_run_id'], sid)
            # The protobuf status dump is an internal transport detail.
            report = {k:v for k,v in report.items() if k != 'runtime_status'}
            store.update(job_id, result=json.dumps(public(report)), status='completed')
        except Exception as exc:
            error = failure(exc)
            store.append(job_id, {'kind': 'failed', 'error': error})
            store.update(job_id, status='failed', error=json.dumps(error))

    @asynccontextmanager
    async def lifespan(app):
        store.recover()
        yield
        executor.shutdown(wait=True)

    app = FastAPI(title='SLAC Investigation API', version='1.0.0', lifespan=lifespan)
    app.state.store = store
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=['127.0.0.1', 'localhost', 'testserver', *settings.allowed_hosts])
    origins = os.environ.get('INVESTIGATOR_CORS_ORIGINS', 'http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173').split(',')
    app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=['GET', 'POST'], allow_headers=['Content-Type'])

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request, exc):
        # Pydantic's default body echoes rejected input, which could contain a key.
        return JSONResponse(status_code=422, content={'detail': [{'loc': e['loc'], 'type': e['type'], 'msg': 'Invalid request field'} for e in exc.errors()]})

    def check_public(mode, question):
        if not settings.public:
            return
        if mode != 'collaborative':
            raise HTTPException(400, detail='Only collaborative (model-backed grid) investigations run on the public demo.')
        if len(question) > PUBLIC_QUESTION_LIMIT:
            raise HTTPException(400, detail='Questions are limited to 500 characters on the public demo.')

    def submit(job_id):
        executor.submit(work, job_id)
        row = store.get(job_id)
        return JSONResponse(status_code=202, content=status(row), headers={'Location': f'/api/v1/investigations/{job_id}'})

    @app.get('/api/v1/events')
    def events():
        return {'event_ids': event_ids()}

    def event_data(event_id):
        if event_id not in event_ids():
            raise HTTPException(404, detail='Event not found')
        return load_event(event_id)

    @app.get('/api/v1/events/{event_id}')
    def metadata(event_id: str):
        meta, _ = event_data(event_id)
        return public(meta)

    @app.get('/api/v1/events/{event_id}/plot')
    def plot(event_id: str):
        import math
        meta, arrays = event_data(event_id)
        channel = meta['station']+':AMPL'
        index = meta['channels']['health'].index(channel)
        traces = []
        def add(name, family, values):
            timestamps = arrays[family+'_time_ns']
            traces.append({'channel': name, 'family': family,
                           'time_ns': [str(int(t)) for t in timestamps],
                           'relative_s': [(int(t)-meta['candidate_end_ns'])/1e9 for t in timestamps],
                           'values': [float(v) if math.isfinite(float(v)) else None for v in values]})
        add(channel, 'health', arrays['health'][:,index])
        for index, name in enumerate(meta['channels']['bpm']):
            values = arrays['bpm'][:,index].copy()
            if not name.endswith('TMIT'):
                charge_name = name.rsplit(':',1)[0]+':TMIT'
                charge = arrays['bpm'][:,meta['channels']['bpm'].index(charge_name)]
                values[charge < 1e8] = float('nan')
            add(name, 'bpm', values)
        return {'event_id': event_id, 'reference_time_ns': str(meta['candidate_end_ns']),
                'candidate_interval_ns': [str(meta['candidate_start_ns']),str(meta['candidate_end_ns'])],
                'traces': traces, 'downsampled': False,
                'notes': ['RF null means no new update, not zero; hold only a previously observed value.',
                          'Positions with local charge below 1e8 are masked as null.',
                          'relative_s is relative to recorded candidate end; no timestamps are shifted.']}

    @app.post('/api/v1/investigations', status_code=202, response_model=StatusResponse)
    def start(request: StartRequest):
        if request.event_id not in event_ids():
            raise HTTPException(404, detail='Event not found')
        check_public(request.mode, request.question.strip())
        return submit(store.enqueue(request=request, question=request.question.strip(), model=configured_model))

    @app.get('/api/v1/investigations/{investigation_id}', response_model=StatusResponse)
    def get_status(investigation_id: str):
        return status(store.get(investigation_id))

    @app.get('/api/v1/investigations/{investigation_id}/activity', response_model=ActivityResponse)
    def activity(investigation_id: str, after: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=200)):
        row = store.get(investigation_id)
        with store.db() as db:
            entries = db.execute('SELECT * FROM activity WHERE job_id=? AND seq>? ORDER BY seq LIMIT ?', (investigation_id, after, limit+1)).fetchall()
        page = entries[:limit]
        return {'investigation_id': investigation_id, 'status': row['status'],
                'events': [{'seq': e['seq'], 'created_at': e['created_at'], 'event': json.loads(e['payload'])} for e in page],
                'next_cursor': page[-1]['seq'] if page else after, 'has_more': len(entries)>limit}

    @app.get('/api/v1/investigations/{investigation_id}/result', response_model=ResultResponse)
    def result(investigation_id: str):
        row = store.get(investigation_id)
        if row['status'] != 'completed':
            raise HTTPException(409, detail={'status': row['status'], 'error': json.loads(row['error']) if row['error'] else None})
        return {'investigation_id': investigation_id, 'series_id': row['series_id'], 'report': json.loads(row['result'])}

    @app.post('/api/v1/series/{series_id}/follow-ups', status_code=202, response_model=StatusResponse)
    def followup(series_id: str, request: FollowupRequest):
        check_public('collaborative', request.question)
        return submit(store.enqueue(series_id=series_id, question=request.question))

    return app
