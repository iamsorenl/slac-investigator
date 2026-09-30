# Cut Us Some SLAC — GitHub Pages frontend

Static operator interface for SLAC RF investigations. Frontend ownership only; backend/authentication and Flower services belong to the other window.

## Preview, verify, package

```sh
python3 -m http.server 5173 --bind 127.0.0.1 --directory frontend
node --test frontend/tests/*.test.js
node frontend/build.mjs
```

Open `http://127.0.0.1:5173/`. No npm install, build service, CDN, provider credential or model call is needed for replay. Output is `frontend/dist/`; the build uses an explicit static-asset allowlist and excludes source scripts, tests, backend files, env files, raw datasets and logs. All asset/data URLs are relative, so a Pages repository subpath works without router rewrites.

## What is displayed

- Real SLAC RF amplitude, charge-qualified beam positions and beam charge. Candidate interval shading, original recorded timing and explicit data provenance. RF nulls never become zeros; low-charge position gaps are not bridged.
- An event selector for slac-001/slac-003, original initial and human-follow-up assessments, individual evidence references opening exact tool results, and a complete evidence ledger.
- Historical agent activity in saved order, with play/pause and a progress slider. Replay does not issue new model calls. Playback speed does not represent original wall-clock timing.
- Persistent **Saved-run replay** labeling; original mixed-scope model enums are preserved and never converted to the schema-v2 dimensions. Both v2 questions show “Not assessed in legacy schema.” Caveats flag the onset precision issue and slac-003 enum/narrative mismatch.
- Download of the displayed saved run, including its provenance, original findings, evidence, and review.

`export_replay.py` reads the existing, reviewed traces and event arrays and creates frontend-only data files. It does not run tools or agents and does not read credentials or evaluation labels. Model narrative strings and evidence values are retained; large integer timestamps/IDs are serialized as strings for browser safety. Relative plotting coordinates use differences calculated before float conversion. It leaves all original traces untouched.

Included saved runs are 4210859065409350628 (slac-001 initial), 16085169257987671247 (same-series follow-up), and 1795740798858395915 (slac-003). These are historical live runs, not current API UUIDs and not new schema-v2 outputs. The backend owner's separately preserved archives remain untouched.

## Backend contract and local live mode

The sole authoritative contract is [../docs/API.md](../docs/API.md), supplied by the backend owner. `assets/api.js` implements that contract; `assets/live.js` provides a separate local development surface at `http://127.0.0.1:5173/?mode=live`.

The live client is allowed only on the four documented localhost/127.0.0.1 origins with ports 3000/5173. On GitHub Pages and every other origin it cannot instantiate a live client, even with `?mode=live`. Pages therefore remains saved replay. Public live operation requires the backend owner's authenticated HTTPS service and explicit origin policy; this frontend does not invent one.

In local live mode:

- Event metadata/plots are GET-only until the operator explicitly starts an investigation.
- Start body is exactly `{event_id, mode: "collaborative"}`. No browser-supplied provider, model, key, or Flower address.
- Follow-up body is exactly `{question}` and uses the returned **API series UUID**, never an archival/Flower series ID. The initial result stays visible separately while follow-up runs.
- Returned links are restricted to the API origin and `/api/v1/`. Status/activity is polled about once per second; activity pages are drained immediately and sequence numbers deduplicated.
- A report event is provisional. Only terminal `completed` plus `/result` yields an accepted assessment. Failed/interrupted states show errors, never replay or fabricated findings.
- Schema v2 displays **Beam disturbance corroborated?** and **Unique cause established?** independently, each with its own rationale and refs. No combined classification or label scoring.
- Buttons prevent duplicate submissions. A lost POST response is never automatically retried. An uncertain submission locks further submissions and directs the operator to the backend owner. Session storage contains job identifiers only, allowing status recovery after reload; it never contains provider credentials.

Verification: 13 frontend tests passed. They cover replay provenance/citations, precision, masking, output escaping, origin gating, no-retry POST behavior, pagination/deduplication, terminal-state/result handling and legacy/v2 separation. API fixtures are test data, not live model evidence. Browser checks verified saved event selection, saved follow-up, evidence dialog, mismatch warning and playback. The initial browser GET to the local API failed; the backend owner independently confirmed host HTTP 200 and the expected CORS header. A native browser fetch receiver-binding issue was corrected and regression-tested. The browser surface became unavailable before the correction could be retested against the real API, so successful browser-to-API connectivity remains unverified. No live POST or model run was executed by this frontend window.

## GitHub Pages publication

A reviewed manual deployment template is in `deploy/github-pages.yml`. It follows [GitHub's custom-workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages) and uploads **only** `frontend/dist`, never the repository root.

Before first publication, confirm the intended site visibility and review the replay data. Repository privacy does not by itself make the Pages site private. The site includes public-source SLAC measurements and saved model findings; the dataset's reuse-license uncertainty is displayed in provenance. No GitHub Pages deployment has been performed by this window.

After approval, install the template as `.github/workflows/frontend-pages.yml`, commit only reconciled frontend files, configure Pages to use GitHub Actions, and dispatch the workflow. A push alone does not publish it. Current official action versions were checked against GitHub documentation on 2026-09-29. GitHub plan support for Pages on this private repository must be checked at deployment time; do not make the repository public as a workaround.

## Lovable coordination

No Lovable project was provided or used. The current frontend is dependency-free and can be handed to Lovable as a design reference if desired. Keep integration code, the authoritative API contract, execution-source labels, uncertainty warnings and preserved traces intact. Lovable must not invent endpoints, add provider keys, merge the v2 questions, rewrite archived conclusions, or fake a live execution animation. UI edits belong inside this directory; backend/auth changes go to the backend owner.
