// Synthetic fixture only — hand-written, not a recorded Flower run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {storyHTML, finalSource, LABELS, label} from '../assets/replay.js';
import {InvestigationAPI} from '../assets/api.js';

const events = [
  {kind:'started', event_id:'synthetic-1', mode:'grid', model:'m'},
  {kind:'delegation', agent:'orchestrator', node_id:'42', instrument:'rf', question:'Run the rf checks <b>locally</b>.'},
  {kind:'tool_request', agent:'rf', analysis:'equipment'},
  {kind:'node_report', instrument:'rf', role_source:'local_data', assessment:'odd_new_status', observation:'RF dipped.', payload_bytes:2048, raw_bytes_held:204800},
];
const report = {data_shared:{percent_shared:0.905}, final:{data_limitations:[],
  beam_disturbance:{status:'corroborated', rationale:'Beam moved.', tool_result_refs:[]},
  unique_cause:{status:'not_established', rationale:'RF data sparse.', tool_result_refs:[]}, requested_next_check:'Look again.'}};

test('story reads agents -> answer -> still unknown, in plain words', () => {
  const html = storyHTML(events, {report});
  const order = ['The agents check', 'Klystron', 'The answer', 'Still unknown'].map(s => html.indexOf(s));
  assert.ok(order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])), html);
  assert.match(html, /Yes, the beam was disturbed/);
  assert.match(html, /Not proven/);
  assert.match(html, /Beam moved\./, 'model rationale kept under Why?');
  assert.match(html, /Only 0\.9%/);
  assert.match(html, /odd new status/, 'unknown node status falls back to the raw value');
  assert.match(html, /Look again\./);
  assert.doesNotMatch(html, /<b>/, 'agent text is escaped');
  assert.doesNotMatch(html, /equipment/, 'tool chatter stays in the activity feed');
});

test('every backend status has a plain label', () => {
  for (const s of ['corroborated','not_corroborated','insufficient_evidence','not_assessed']) assert.ok(LABELS.beam_disturbance[s], s);
  for (const s of ['established','not_established','insufficient_evidence','not_assessed']) assert.ok(LABELS.unique_cause[s], s);
  for (const s of ['suspicious','normal','insufficient_evidence']) assert.ok(LABELS.node[s], s);
});

test('no answer before the report; delegated nodes show as checking', () => {
  const html = storyHTML(events.slice(0, 2));
  assert.doesNotMatch(html, /answer-list|Still unknown/);
  assert.match(html, /Checking…/);
  assert.match(html, /weighing the reports/);
  assert.match(storyHTML([]), /Not started yet/);
});

test('deterministic fallback answer is flagged in the story', () => {
  const f = {...report.final, data_limitations:['Deterministic combine of node summaries; the model final was not accepted.']};
  assert.match(storyHTML(events, {report:{...report, final:f}}), /answer was not accepted/);
});

test('deterministic fallback is labelled', () => {
  assert.equal(finalSource({data_limitations:['Deterministic combine of node summaries; the model final was not accepted.']}), 'deterministic combine');
  assert.equal(finalSource(report.final), 'model');
});

test('exported grid replay keeps the events the story needs', () => {
  const data = JSON.parse(fs.readFileSync(new URL('../data/slac-001-grid.json', import.meta.url)));
  const run = data.runs[0], kinds = new Set(run.events.map(e => e.kind));
  for (const k of ['delegation', 'node_report', 'data_shared']) assert.ok(kinds.has(k), k);
  assert.equal(finalSource(run.report.final), 'model');
  assert.equal(run.report.mode, 'grid');
  assert.ok(run.report.final.beam_disturbance && run.report.data_shared);
});

test('grid start sends the question; default body is unchanged', async () => {
  const calls = [];
  const api = new InvestigationAPI({pageOrigin:'http://127.0.0.1:5173', fetchImpl:async (url, options) => {calls.push(options); return {ok:true, json:async () => ({id:'x'})};}});
  await api.start('slac-001', {mode:'grid', question:'  Why?  '});
  await api.start('slac-001');
  assert.deepEqual(JSON.parse(calls[0].body), {event_id:'slac-001', mode:'grid', question:'Why?'});
  assert.deepEqual(JSON.parse(calls[1].body), {event_id:'slac-001', mode:'collaborative'});
});
