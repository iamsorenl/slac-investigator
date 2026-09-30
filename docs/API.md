# Frontend API contract (v1)

Authoritative implementation: `slac_assistant/api.py`. Start with `./scripts/start_api.sh` after starting Flower with `./scripts/start.sh`. Default API base is **http://127.0.0.1:8080**. Interactive OpenAPI documentation: `/docs`; machine-readable schema: `/openapi.json`. The existing Streamlit UI remains usable independently.

## Deployment, credentials and ownership

This is a **local, single-user development API**, bound to loopback, with **one Uvicorn worker**. There is no frontend login or public authentication endpoint. Default CORS origins are `http://localhost:3000`, `http://127.0.0.1:3000`, `http://localhost:5173`, and `http://127.0.0.1:5173`. `INVESTIGATOR_CORS_ORIGINS` can set an explicit comma-separated list. Cookies are not used; allowed methods are GET/POST and the allowed request header is Content-Type. Only localhost/127.0.0.1 hosts are accepted. CORS is not authentication.

**GitHub Pages stays in saved-run replay mode.** This service is not a hosted backend and does not promise that an HTTPS Pages origin can reach localhost. Public live execution requires an authenticated HTTPS backend deployment, explicit origin configuration, and an authorization policy; that deployment is not implemented by this local API. Do not expose this server publicly or add a provider credential to browser code.

The browser never supplies provider keys, provider names, model IDs, Flower addresses, or Flower internal credentials. Unknown request fields are rejected without echoing their values. SuperLink alone loads the model provider from the private `.env` through `scripts/start.sh`. The API reads the model from `INVESTIGATOR_MODEL` (environment, then `.env`, then the app default), uses Flower's Control API (`FLOWER_CONTROL_URL`, default `http://127.0.0.1:8000`), and never makes direct provider requests. The API never reads the provider key.

## Endpoints

| Method | Path | Success | Purpose |
|---|---|---|---|
| GET | `/api/v1/events` | 200 | `{ "event_ids": ["slac-001", ...] }` |
| GET | `/api/v1/events/{event_id}` | 200 | Source metadata, channel catalog, candidate interval and limitations; no evaluation labels |
| GET | `/api/v1/events/{event_id}/plot` | 200 | Original sampled plot traces described below |
| POST | `/api/v1/investigations` | 202 | Queue a new investigation and series |
| GET | `/api/v1/investigations/{id}` | 200 | Status and links |
| GET | `/api/v1/investigations/{id}/activity?after=0&limit=100` | 200 | Ordered activity page |
| GET | `/api/v1/investigations/{id}/result` | 200 | Completed result; 409 until completed, including failures |
| POST | `/api/v1/series/{series_id}/follow-ups` | 202 | New investigation run in the same series |

POST requests must use `Content-Type: application/json`. There is no SSE or WebSocket contract; poll status/activity approximately once per second. A POST creates work once per request; **there is no idempotency-key support or automatic retry**. Disable duplicate submissions. If a POST's network response is lost, do not silently resend it: work may already be running.

### Start investigation

```json
{"event_id":"slac-001","mode":"collaborative"}
```

`mode` is `collaborative` (default), `baseline`, `smoke`, or `grid`. Smoke performs deterministic software checks and no inference. Both `collaborative` and `grid` run on the three-node Grid (rf, ltu, dump; each node replies with a summary only, see `node_report`/`data_shared` below). `collaborative` calls the model on each node and for the orchestrator's final finding; `grid` is the same topology with deterministic node checks and no model calls. Verified end to end on Groq `openai/gpt-oss-20b` on 2026-09-29 (about 15 s per collaborative run). The event must exist in `/events`. An optional `question` (up to 4,000 characters) is passed to the agents. No series ID is accepted here; use the follow-up route to continue.

The 202 response and subsequent status responses use the same shape (the job may already be running when 202 arrives):

```json
{
  "id": "api-investigation-uuid",
  "series_id": "api-series-uuid",
  "event_id": "slac-001",
  "mode": "collaborative",
  "model": "dedicated/flowerai/MiniMax-M3-OOLI9o",
  "status": "queued",
  "created_at": "2026-09-29T22:00:00+00:00",
  "updated_at": "2026-09-29T22:00:00+00:00",
  "flower_run_id": null,
  "flower_series_id": null,
  "error": null,
  "links": {
    "status": "/api/v1/investigations/api-investigation-uuid",
    "activity": "/api/v1/investigations/api-investigation-uuid/activity",
    "result": "/api/v1/investigations/api-investigation-uuid/result",
    "followup": "/api/v1/series/api-series-uuid/follow-ups"
  }
}
```

The response includes a `Location` header equal to the status URL. Follow returned links. API UUIDs are distinct from Flower IDs; never interchange them. Flower IDs become decimal **strings** once Flower accepts the run.

States: `queued` → `running` → `completed` or `failed`; `interrupted` marks unfinished records after an API restart. All three of `completed`, `failed`, and `interrupted` are terminal. Only `completed` has an accepted result. Receiving a `report` activity event is not completion: Flower must still confirm finished/completed.

### Retrieve activity

```json
{
  "investigation_id": "api-investigation-uuid",
  "status": "running",
  "events": [
    {"seq":1,"created_at":"2026-09-29T22:00:01+00:00","event":{"kind":"started","event_id":"slac-001","mode":"collaborative","model":"dedicated/flowerai/MiniMax-M3-OOLI9o"}},
    {"seq":2,"created_at":"2026-09-29T22:00:02+00:00","event":{"kind":"tool_request","agent":"equipment","analysis":"equipment"}}
  ],
  "next_cursor": 2,
  "has_more": false
}
```

`after` is an exclusive integer sequence cursor, initially 0. `limit` is 1–200 (default 100). Fetch additional pages immediately while `has_more`; otherwise resume polling with `next_cursor`. An empty page leaves the cursor unchanged. On terminal status, drain remaining pages; activity is durable and can be replayed after reload. Deduplicate by `(investigation_id, seq)`.

Activity `event.kind` values:

- `started`: `event_id`, `mode`, `model`, optional `budget`.
- `delegation`: `agent`, `to`, `question`, `analysis`. In `mode: "grid"`: `node_id`, `instrument`.
- `tool_request`: `agent`, `analysis`.
- `tool_result`: `agent`, `evidence` (ref, analysis, event_id, source, hdf5_group, interval_ns, result, limitations).
- `finding`: `finding` with schema-v2 fields described below.
- `finding_rejected`: `agent`, `error`, `draft`; validation feedback, not an accepted finding.
- `report`: `report`, provisional until completed status; runtime IDs/metrics may only be final in `/result`.
- `failed`: sanitized `error` with `code` and `message`.
- `node_report` (`mode: "grid"` only): a Grid instrument node's reply. Never contains raw samples, only summary numbers.
- `data_shared` (`mode: "grid"` only): how much raw data stayed on the node vs. was shared, for the "% raw data shared" headline.

Ignore unfamiliar event kinds gracefully. These are application activity and concise findings, not private model reasoning.

#### `node_report` example

```json
{
  "kind": "node_report",
  "instrument": "rf",
  "role_source": "local_data",
  "event_id": "slac-001",
  "assessment": "suspicious",
  "observation": "RF amplitude on this klystron deviates from its neighbors near the candidate window.",
  "summary": {"baseline": 1.02, "peak_deviation": 2.5, "onset_ns": "1604277203201922048", "valid_count": 480, "masked_count": 12},
  "tool_refs": ["T-rf-1"],
  "raw_bytes_held": 123456,
  "payload_bytes": 512,
  "limitations": []
}
```

`instrument` is `rf`, `ltu`, or `dump`. `role_source` is `local_data` (the node found its own instrument slice) or `assigned` (the orchestrator assigned it). `assessment` is the node's own per-instrument signal (`suspicious`, `normal`, or `insufficient_evidence`) — not the final verdict; only the report's `final` (below) is the verdict. `summary` holds numbers only, never arrays longer than 10 elements.

#### `data_shared` example

```json
{"kind": "data_shared", "raw_bytes_held": 370368, "payload_bytes": 1536, "percent_shared": 0.41}
```

`raw_bytes_held` is the total raw sample bytes held across nodes; `payload_bytes` is what actually crossed the wire in node replies; `percent_shared` is `payload_bytes / raw_bytes_held * 100`.

### Retrieve results: two independent questions

`GET .../result` returns `{ "investigation_id": "...", "series_id": "...", "report": {...} }`.

The report contains `result_schema_version: 2`, `benchmark_eligible: false`, `event_id`, `mode`, `model`, `provider`, `model_execution_path`, `final`, `findings`, `evidence`, `metrics`, `flower_run_id`, `flower_series_id`, `runtime`, and `wall_latency_s`. Metrics include actual model/tool calls, token usage (nullable), latency, and cost (nullable); null cost does not mean free.

For `mode: "grid"`, the report additionally carries `grid`: `{"nodes_seen": 3, "assignment": {"rf": "node-1", "ltu": "node-2", "dump": "node-3"}, "fallback": null}` (`fallback` is a short note when fewer than 3 nodes were available; with 0 nodes all three instruments run in-process) and `data_shared` (`raw_bytes_held`, `payload_bytes`, `percent_shared`, as in the activity event above). Frontends render `data_shared.percent_shared` as the headline "% raw data shared" figure.

Every finding, including `final`, has independent dimensions:

```json
{
  "beam_disturbance": {
    "status": "not_corroborated",
    "rationale": "No sustained disturbance was corroborated in the available charge-valid BPM readings.",
    "tool_result_refs": ["T-example-beam"]
  },
  "unique_cause": {
    "status": "not_established",
    "rationale": "The replay evidence does not establish a unique causal RF station.",
    "tool_result_refs": ["T-example-rf","T-example-beam"]
  }
}
```

This example illustrates the shape, not a newly verified live finding. The remaining finding fields are `finding_id`, `agent`, `observation`, `source_channels`, `time_interval_ns`, `tool_result_refs`, `supporting_evidence`, `conflicting_evidence`, `data_limitations`, and nullable `requested_next_check`.

Display headings **“Beam disturbance corroborated?”** and **“Unique cause established?”** independently:

- Beam status: `corroborated`, `not_corroborated`, `insufficient_evidence`, or `not_assessed`. An RF-only excursion cannot make beam corroboration positive. A negative heuristic is not proof of normality.
- Unique cause status: `established`, `not_established`, `insufficient_evidence`, or `not_assessed`. `not_established` does not assert that causation is absent. Coincidence or a positive beam heuristic is insufficient to establish a unique cause.
- Each dimension has its own rationale and evidence refs; assessed dimensions require refs validated against the finding's available evidence. Structural citation validation does not establish semantic accuracy.
- There is **no combined `assessment` field in v2**. The external evaluator emits no prediction/agreement scores; the source anomaly labels do not provide separately adjudicated truth for these questions.

The historical runs in the frontend's saved-run replay (`frontend/data/`) use the old mixed-scope enum. Show their original narratives and review caveats as **saved-run replay**; do not automatically convert their enums to either dimension or score them. If a frontend requires a dimension for a legacy run, show `not_assessed` with “Legacy mixed-scope output; requires review.” These archival IDs are not API series UUIDs and cannot be submitted to this API's follow-up route.

### Follow-up in the same series

```http
POST /api/v1/series/{series_id}/follow-ups
Content-Type: application/json
```

```json
{"question":"Could low charge explain the position readings?"}
```

Question: nonempty after trimming, maximum 4,000 characters. Response: 202 status object with a **new investigation ID** and the **same API series ID**. The event, mode, configured model, and Flower series ID are inherited from the initial run. The backend passes the exact integer Flower series ID to `run_flower`, allowing AgentApp Context to load the prior final assessment. It never silently creates a replacement series when continuation fails.

Only one pending/running job per series is allowed; follow-up requires the latest run to be completed and cannot follow smoke, failed, or interrupted runs. Conflicts return 409. Globally one background worker processes jobs in queue order. Keep the initial result visible and render the follow-up separately while it runs; do not overwrite historical conclusions.

### Event metadata and plot data

Metadata is the event's local provenance record, with exact nanosecond fields serialized as strings. No source labels are exposed.

Plot response: `event_id`, `reference_time_ns`, `candidate_interval_ns`, `traces`, `downsampled: false`, `notes`. Each trace has `channel`, `family` (`health` or `bpm`), `time_ns` (string array), `relative_s` (number array), and `values` (number/null array). Arrays in a trace have equal lengths. The health trace is the candidate AMPL channel; BPM traces contain the available charge and position channels.

RF nulls mean no new update, never zero: hold only a previously observed value. Position samples whose local TMIT is below 1e8 are masked as null. Plot `relative_s` relative to the recorded candidate end; do not infer or apply timing shifts. Exact `_ns` fields throughout API payloads—including lists such as `interval_ns`—are decimal strings to avoid JavaScript's 53-bit integer precision loss. Use `BigInt` for exact differences; use the supplied relative seconds for plotting.

## Errors and persistence

Request errors: 404 for unknown event/run/series, 422 for invalid bodies/query parameters, 409 for unavailable results or invalid follow-up state. Ordinary errors use `{ "detail": ... }`; validation errors list field location/type and a generic message without rejected input values. A 409 result response has `{ "detail": { "status": "running|queued|failed|interrupted", "error": null_or_error_object } }`.

Asynchronous failure is returned via status `failed`, its `error`, and a final activity event. Error codes are `missing_environment`, `credential_rejected`, `billing_quota`, `model_unavailable`, `rate_limited`, or `workflow_failed`; unrecognized failures remain unclassified. Provider exception bodies and credentials are not returned. `server_restarted` accompanies `interrupted` records. No automatic retry or replay fallback occurs.

API records/activity/results live in Git-ignored `artifacts/api/state.sqlite3` (user-only permissions). Reloading the browser loses no recorded activity. Restarting the API marks its queued/running records interrupted; it does not cancel or resubmit Flower work, which may still finish independently. Completed API records remain available. Follow-up continuity across a **Flower** restart additionally depends on Flower's own persistent series store; the API does not reconstruct missing Context. If that series is unavailable, continuation fails explicitly.

## Verification scope

Contract tests cover asynchronous start/poll/results, pagination, same-series continuation, concurrent follow-up rejection, input validation, error classification/redaction, interrupted-run recovery, smoke follow-up rejection, and nanosecond strings. These tests use protocol fixtures and do not establish model accuracy. A separate local smoke check exercises real Flower through the HTTP API without new model inference.

On 2026-09-29 a real HTTP smoke run completed with 0 investigation-model calls, beam `not_corroborated`, and unique cause `not_established` (its record is not kept in the repository). Flower's separate automatic series-title request logged its existing nonblocking HTTP 404. No new paid investigation was used to validate model adherence to the v2 schema; that remains a live-validation limitation.
