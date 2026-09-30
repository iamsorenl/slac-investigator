// Frontend view helpers only. This schema is for exported replay files, not an API contract.
export function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
export function validateReplay(data) {
  if (!data || !Array.isArray(data.runs) || !data.runs.length || !data.plots) throw new Error('The saved event is incomplete.');
  for (const run of data.runs) {
    if (run.execution_source !== 'saved_run' || run.recorded_state !== 'completed') throw new Error('This is not a completed saved run.');
    if (run.report.event_id !== data.id) throw new Error('The saved run belongs to a different event.');
    const refs = new Set(run.report.evidence.map(e => e.ref));
    for (const finding of run.report.findings) {
      if (!finding.tool_result_refs.every(ref => refs.has(ref))) throw new Error('A finding refers to missing evidence.');
    }
  }
  return data;
}
export function plotPath(points, x, y, step = false) {
  let path = '', open = false;
  for (const [t,v] of points) {
    if (v === null || !Number.isFinite(v)) { open = false; continue; }
    const xy = `${x(t).toFixed(2)},${y(v).toFixed(2)}`;
    path += open ? (step ? `H${x(t).toFixed(2)}V${y(v).toFixed(2)}` : `L${xy}`) : `M${xy}`;
    open = true;
  }
  return path;
}
export const pretty = value => String(value).replaceAll('_',' ');
const ROLE_SOURCE_LABEL = {local_data: 'Local data', assigned: 'Assigned by orchestrator'};
// Grid node report: one card per instrument. role_source is shown as text + class, never colour alone.
export function nodeReportCard(e) {
  const cls = e.role_source === 'local_data' ? 'role-local' : 'role-assigned';
  const label = ROLE_SOURCE_LABEL[e.role_source] || pretty(e.role_source);
  return `<div class="node-card ${cls}"><h3>${escapeHTML(pretty(e.instrument))}</h3>` +
    `<p><span class="role-badge ${cls}">${escapeHTML(label)}</span> <span class="status-tag">${escapeHTML(pretty(e.assessment))}</span></p>` +
    `<p>${escapeHTML(e.observation)}</p>` +
    `<p class="node-bytes small muted"><span>Payload sent: ${Number(e.payload_bytes)} bytes</span> <span>Raw held: ${Number(e.raw_bytes_held)} bytes</span></p></div>`;
}
export function dataSharedHeadline(e) {
  const pct = Number(e.percent_shared);
  return `<div class="data-shared-headline"><strong>${pct.toFixed(1)}%</strong> <span>of raw data shared</span></div>`;
}
const kb = n => `${(Number(n) / 1024).toFixed(1)} KB`;
// 'deterministic combine' when the backend fell back from the model final (grid_workflow data_limitations).
export function finalSource(final) {
  return (final?.data_limitations || []).some(l => /model final was not accepted|No model was called/.test(l)) ? 'deterministic combine' : 'model';
}
// Plain-English labels for a non-expert reader. The model's own words are shown unchanged under "Why?".
// tone drives colour, but the label text always carries the meaning.
export const LABELS = {
  beam_disturbance: {corroborated:['Yes, the beam was disturbed','alert'], not_corroborated:['No, the beam looked normal','ok'], insufficient_evidence:["Can't tell from this data",'unsure'], not_assessed:['Not checked','unsure']},
  unique_cause: {established:['Yes, the klystron caused it','alert'], not_established:['Not proven','unsure'], insufficient_evidence:["Can't tell from this data",'unsure'], not_assessed:['Not checked','unsure']},
  node: {suspicious:['Something looks off','alert'], normal:['Looks normal','ok'], insufficient_evidence:['Not enough data to say','unsure']},
};
export function label(kind, value) {
  const [text, tone] = LABELS[kind]?.[value] || [pretty(value), 'unsure'];
  return `<span class="verdict tone-${tone}">${escapeHTML(text)}</span>`;
}
export const INSTRUMENTS = {rf:['Klystron','the power source'], ltu:['Beam, mid-line','LTU position and charge monitors'], dump:['Beam, end of line','monitors at the beam dump']};
export const CASES = {
  'slac-001': {title:'A glitch the beam felt', summary:'Klystron power jumped and the beam dipped at the same moment.'},
  'slac-003': {title:'A glitch the beam ignored', summary:'Klystron power wobbled, but the beam looked fine.'},
};
const QUESTIONS = [['beam_disturbance', 'Was the beam disturbed?'], ['unique_cause', 'Did the klystron cause it?']];
const unquote = s => String(s ?? '').trim().replace(/^["']+|["']+$/g, '');
const items = values => `<ul>${values.map(v => `<li>${escapeHTML(v)}</li>`).join('')}</ul>`;
// The investigation as a story: the agents check, the answer, what's still unknown.
// `events` may be a prefix (replay step or live progress); the answer only shows from an accepted report.
export function storyHTML(events, {report = null} = {}) {
  const asked = events.filter(e => e.kind === 'delegation' && e.instrument).map(e => e.instrument);
  const reports = new Map(events.filter(e => e.kind === 'node_report').map(e => [e.instrument, e]));
  const order = [...new Set([...asked, ...reports.keys()])];
  const shared = events.find(e => e.kind === 'data_shared') || report?.data_shared;
  const rows = order.map(id => {
    const [name, what] = INSTRUMENTS[id] || [pretty(id), ''], r = reports.get(id);
    return `<li class="agent-row"><div class="agent-name"><strong>${escapeHTML(name)}</strong><span>${escapeHTML(what)}</span></div>` +
      `<div class="agent-result">${r ? `${label('node', r.assessment)}<p>${escapeHTML(unquote(r.observation))}</p>` : '<span class="verdict tone-pending">Checking…</span>'}</div></li>`;
  }).join('');
  const agents = `<section class="story-card" aria-labelledby="s-agents"><h2 id="s-agents"><span class="step">2</span> The agents check</h2>` +
    `<p class="muted">Each agent sits next to one instrument and only sees that instrument's data.</p>` +
    (rows ? `<ol class="agent-list">${rows}</ol>` : '<p class="empty">Not started yet.</p>') +
    (shared ? `<p class="shared-line"><strong>Only ${Number(shared.percent_shared).toFixed(1)}%</strong> of the raw data left the instruments${shared.payload_bytes ? ` (${kb(shared.payload_bytes)} of ${kb(shared.raw_bytes_held)})` : ''}. The agents sent summaries, not recordings.</p>` : '') + `</section>`;
  const f = report?.final;
  const answer = `<section class="story-card answer-card" aria-labelledby="s-answer"><h2 id="s-answer"><span class="step">3</span> The answer</h2>` + (f?.beam_disturbance ?
    `<dl class="answer-list">${QUESTIONS.map(([k, q]) => `<div><dt>${q}</dt><dd>${label(k, f[k].status)}</dd></div>`).join('')}</dl>` +
    (finalSource(f) === 'model' ? '' : '<p class="small muted">The model\'s answer was not accepted, so this answer was combined directly from the agents\' reports.</p>') +
    `<details class="why"><summary>Why?</summary>${QUESTIONS.map(([k, q]) => `<h3>${q}</h3><p>${escapeHTML(f[k].rationale)}</p>`).join('')}` +
    `<h3>Evidence for</h3>${items(f.supporting_evidence || [])}<h3>Evidence against or caveats</h3>${(f.conflicting_evidence || []).length ? items(f.conflicting_evidence) : '<p>None listed.</p>'}</details>`
    : `<p class="empty">${order.length ? 'The lead agent is weighing the reports…' : 'Appears once the agents report back.'}</p>`) + `</section>`;
  const unknown = f ? `<section class="story-card" aria-labelledby="s-unknown"><h2 id="s-unknown"><span class="step">4</span> Still unknown</h2>` +
    `<p><strong>What they'd check next:</strong> ${escapeHTML(f.requested_next_check || 'Nothing further requested.')}</p><p class="small muted">This is a suggestion; the check was not run.</p>` +
    ((f.data_limitations || []).length ? `<details><summary>Limits of this data (${f.data_limitations.length})</summary>${items(f.data_limitations)}</details>` : '') + `</section>` : '';
  return agents + answer + unknown;
}
