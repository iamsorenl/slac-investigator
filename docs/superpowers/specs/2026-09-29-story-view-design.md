# Story view: make the page about the investigation

Date: 2026-09-29. Branch: `soren/live-site`. Deploys to the fork's Pages site.

## Why

The page opens with timestamps, model IDs, execution source and raw charts, and the actual answer is buried. A visitor with no accelerator background can't tell what happened or why it matters. The saved runs already contain a clear story: a question, three instrument agents checking their own data, a two-part answer, and what's still unknown. The page should lead with that.

## Audience

Non-experts first (recruiters, hiring managers, hackathon judges). Jargon is either explained in a few words or moved to the details section.

## Decisions

- Rework the existing page (option 1). No rewrite and no second view.
- Build the story once as a shared renderer in `frontend/assets/replay.js`, used by both the replay page (`app.js`) and the live page (`live.js`).
- Public cases are the grid runs only. The two old OpenAI single-agent runs come out of `manifest.json`; their data files stay in the repo.
- Keep the raw-signal charts visible, below the answer.
- Responsive from 360px phones to wide desktops, with no horizontal page scroll.

## Page layout (top to bottom)

1. **Top bar:** brand, plus the saved/live indicator (and "Try it live" once the backend exists).
2. **Intro:** "Did a power glitch knock SLAC's electron beam off course?", plus two sentences on how it works: three agents each check one instrument's data, a lead agent gives a two-part answer, and the raw data stays on the instruments.
3. **Case picker:** two cards with plain titles taken from new `title` and `summary` fields in `manifest.json`:
   - `slac-001-grid`: "A glitch the beam felt"
   - `slac-003-grid`: "A glitch the beam ignored"
   The Endeavor run appears inside case 1 as a small link: "Same case, run on Flower's Endeavor model". The manifest gets a `variant_of` field for this.
   On the live page, the same cards act as the event picker.
4. **The question:** a plain one-sentence explainer of what a klystron is, then the question being asked. Live page: the question textarea, Start button, runs-left count and limit banners sit here.
5. **The agents check:** one row per instrument, in order: Klystron, Beam mid-line (LTU), Beam at the end (dump). Each row shows a plain status and the agent's one-line observation. Then one line: "Only X% of the raw data left the instruments (A KB of B KB)". Replay reveals rows step by step using the existing timer and scrubber, with a "Replay" button.
6. **The answer:** two rows, "Was the beam disturbed?" and "Did the klystron cause it?", each with a plain verdict. A "Why?" disclosure holds the model's rationale plus the supporting and conflicting evidence, word for word. If the final answer came from the deterministic fallback, a small note says so.
7. **Still unknown:** the requested next check and data limitations. Includes the existing caveat that a requested check was not performed.
8. **Live only, after an answer:** "Ask a follow-up" form (the existing follow-up behavior, moved here).
9. **The raw signals:** the existing three charts (RF amplitude, beam position, beam charge), a one-line plain caption each, and the focus toggle. Visible, not collapsed.
10. **More details** (one collapsed `<details>`): full agent activity trace, evidence ledger with the Inspect dialog, model, calls, tokens and latency, run ID, data provenance and license, and Export saved run.
11. **Footer:** unchanged.

Removed: the left sidebar (replaced by case cards), the meta strip, the "Follow the evidence" heading, the sidebar notes, the replay notice banner (its message becomes the saved/live pill), and the empty follow-up card on saved runs.

## Plain-English labels

A fixed lookup in `replay.js`. The model's own words are never rewritten; they appear under "Why?". Unknown values fall back to the current `pretty()` output.

| Field | Value | Label |
|---|---|---|
| beam_disturbance | corroborated | Yes, the beam was disturbed |
| | not_corroborated | No, the beam looked normal |
| | insufficient_evidence | Can't tell from this data |
| | not_assessed | Not checked |
| unique_cause | established | Yes, the klystron caused it |
| | not_established | Not proven |
| | insufficient_evidence | Can't tell from this data |
| | not_assessed | Not checked |
| node assessment | normal | Looks normal |
| | insufficient_evidence | Not enough data to say |
| | other | raw value, prettified |
| instrument | rf / ltu / dump | Klystron / Beam mid-line (LTU) / Beam at the end (dump) |

## Responsive rules

- A single centered column (max about 820px) for sections 2 through 8. Charts and More details may use up to about 1100px.
- Case cards sit side by side at 640px and wider, and stack below that.
- Agent rows and answer rows put the label and status side by side on wide screens, and stack label → status → text on narrow ones.
- The evidence table scrolls inside its own box on phones. The page itself never scrolls sideways.
- Tap targets are at least 40px tall. Text doesn't shrink below 12px.

## Code shape

- `replay.js`: add `LABELS` and `storyHTML(events, {report, question, eventId, step})` covering sections 4 through 7. `conversationHTML` is removed once nothing uses it, and its tests move to the story tests. `nodeReportCard` stays for the activity trace.
- `app.js`: `render()` produces the new layout; `nav()` becomes the case cards. The playback timer, scrubber, evidence dialog, focus toggle and export stay.
- `live.js`: same layout, with the live controls in section 4 and the follow-up form in section 8. The API, limits and polling logic are untouched.
- `index.html`: drop the sidebar, notice banner and connection panel. While there is no backend, the intro ends with a small muted line: "Live runs, where you ask your own question, are coming soon."
- `styles.css`: new story styles and breakpoints. Delete the rules for removed elements.
- `manifest.json`: remove the two prototype entries; add `title`, `summary` and `variant_of`.

## Testing

- Node tests (`frontend/tests/`): every label maps correctly, and unknown values fall back; agent rows follow the step count; the verdict is hidden until the report arrives; the deterministic-fallback note shows; observation text is HTML-escaped. Existing api, public and replay tests keep passing.
- Visual check with the Playwright MCP at 375×812, 768×1024 and 1440×900 on both cases: no horizontal scroll (`scrollWidth <= innerWidth`), all sections visible, and screenshots reviewed.
- Local live mode (`?mode=live` against the local API) renders the same layout. The full public-live E2E stays in plan Task 8.

## Out of scope

- Any backend change.
- Rewording model output.
- Dark mode.
