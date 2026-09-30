import {escapeHTML as h, validateReplay, pretty, nodeReportCard, dataSharedHeadline, conversationHTML, finalSource} from './replay.js';
import {plot as drawPlot} from './charts.js';
import {LOCAL_ORIGINS,publicLiveAvailable} from './api.js';
const $ = selector => document.querySelector(selector);
const colors = ['#138993','#d49440','#686fb0','#c56e73'];
const state = {manifest:null,event:null,runIndex:0,step:0,playing:false,timer:null,focus:false,loadVersion:0};
let cache = new Map();
const currentRun = () => state.event.runs[state.runIndex];
const refs = values => `<div class="evidence-links">${[...new Set(values)].map(ref=>`<button class="ref-button" data-evidence="${h(ref)}">${h(ref)}</button>`).join('')}</div>`;
const list = values => `<ul>${values.map(value=>`<li>${h(value)}</li>`).join('')}</ul>`;
const date = ns => new Date(Number(BigInt(ns)/1000000n)).toISOString().slice(0,19).replace('T',' · ')+' UTC';
function stopPlayback(){clearInterval(state.timer);state.timer=null;state.playing=false;}
function error(message){$('#error').hidden=false;$('#error').textContent=message;}
async function loadEvent(id){
  stopPlayback();const ticket=++state.loadVersion;$('#content').setAttribute('aria-busy','true');$('#error').hidden=true;
  try{
    const entry=state.manifest.events.find(e=>e.id===id);
    if(!entry)throw new Error('Event is not in this saved library.');
    if(!cache.has(id)){
      const response=await fetch(entry.file);
      if(!response.ok)throw new Error(`Saved event could not be loaded (${response.status}).`);
      cache.set(id,validateReplay(await response.json()));
    }
    if(ticket!==state.loadVersion)return;
    state.event=cache.get(id);state.entryId=id;state.runIndex=0;state.focus=false;state.step=currentRun().events.length;
    render();history.replaceState(null,'',`#${encodeURIComponent(id)}`);
  }catch(e){if(ticket===state.loadVersion)error(e.message);}
  finally{if(ticket===state.loadVersion)$('#content').setAttribute('aria-busy','false');}
}
function nav(){
  $('#event-list').innerHTML=state.manifest.events.map(e=>`<button class="event-button ${state.entryId===e.id?'active':''}" data-event="${h(e.id)}" ${state.entryId===e.id?'aria-current="true"':''}><span class="event-name">${h(e.id)} <span aria-hidden="true">↗</span></span><span class="event-station">${h(e.station)}</span>${e.note?`<span class="event-count">${h(e.note)}</span>`:''}<span class="event-count">${e.run_count} saved ${e.run_count===1?'run':'runs'} · ${e.run_count>1?'Follow-up available':'Initial assessment'}</span></button>`).join('');
}
function plot(series,kind){return drawPlot(state.event,state.focus,series,kind);}
function assessment(run){
  const f=run.report.final,review=run.review,follow=run.phase==='followup';
  return `<section class="panel assessment-panel" aria-labelledby="assessment-title"><div class="assessment-header"><span class="eyebrow">SAVED MODEL ASSESSMENT</span><h2 id="assessment-title">${follow?'Follow-up assessment':'Initial assessment'}</h2><span class="status-tag">${f.beam_disturbance?`Final from ${h(finalSource(f))}`:`Model output: ${h(pretty(f.assessment))}`}</span> <span class="status-tag warning">Operator review</span>${run.report.data_shared?dataSharedHeadline(run.report.data_shared):''}</div><div class="phase-tabs" role="tablist" aria-label="Assessment phase">${state.event.runs.map((r,i)=>`<button role="tab" aria-selected="${i===state.runIndex}" data-phase="${i}">${r.phase==='initial'?'Initial investigation':'Human follow-up'}</button>`).join('')}</div><div class="assessment-body">${f.beam_disturbance?`<div class="dimension-grid">${[['beam_disturbance','Beam disturbance corroborated?'],['unique_cause','Unique cause established?']].map(([k,t])=>`<div><strong>${t}</strong><span>${h(pretty(f[k].status))}</span><p>${h(f[k].rationale)}</p></div>`).join('')}</div>`:`<div class="dimension-grid legacy"><div><strong>Beam disturbance corroborated?</strong><span>Not assessed in legacy schema</span></div><div><strong>Unique cause established?</strong><span>Not assessed in legacy schema</span></div></div><p class="small muted">Legacy mixed-scope output; requires review. The original mixed-scope label is not mapped to either question.</p>`}<p>${h(f.observation)}</p>${refs(f.tool_result_refs)}${review?`<div class="review-callout"><strong>${state.event.id==='slac-003'?'Headline / evidence mismatch':'Evidence review · precision caveat'}</strong>${h(review.overall)}${list(review.issues)}</div>`:''}<details><summary>Supporting & conflicting evidence</summary><h4>Supporting</h4>${list(f.supporting_evidence)}<h4>Conflicting / qualifying</h4>${f.conflicting_evidence.length?list(f.conflicting_evidence):'<p>No conflicting evidence listed in this finding.</p>'}</details><details><summary>Limitations & next check</summary>${list(f.data_limitations)}<strong>Requested next check</strong><p>${h(f.requested_next_check||'No further check requested.')}</p><p class="muted small">A requested check is not evidence that it was performed.</p></details></div><div class="run-details"><span>Run <span class="code">${h(run.id)}</span></span><span>${run.report.metrics.model_calls} model calls · ${run.report.metrics.tool_calls} tool calls</span><span>${run.wall_latency_s.toFixed(1)}s recorded · Cost unavailable</span></div></section>`;
}
function followupCard(){
  const follow=state.event.runs.find(r=>r.phase==='followup');
  return `<section class="panel followup-card"><div class="panel-head"><div><span class="eyebrow">HUMAN IN THE LOOP</span><h2>${follow?'A question changes the focus':'Ask the next question'}</h2></div></div>${follow?`<blockquote>${h(follow.question)}</blockquote><button class="button secondary" data-phase="1">${state.runIndex===1?'Viewing saved follow-up':'Review saved answer'} <span aria-hidden="true">↗</span></button><p class="small muted">The saved answer rechecks evidence in the same investigation series. It is not a new model response.</p>`:`<p class="small muted">No follow-up was saved for this event. New questions require a connected backend.</p><button class="button secondary" disabled>Submit a new question</button>`}</section>`;
}
function activityRow(e,index){
  let role=e.agent||'lead',label='',body='',extra='',icon='·';
  if(e.kind==='started'){role='Flower';label='Investigation started';body=`${e.mode} · ${e.model}`;icon='↗';}
  else if(e.kind==='delegation'){label=e.to?`${pretty(e.agent)} → ${e.to}`:`${pretty(e.instrument)} → node ${e.node_id}`;body=e.question;icon='↳';}
  else if(e.kind==='tool_request'){label=`Requested ${pretty(e.analysis)}`;body='Deterministic, read-only analysis';icon='⌁';}
  else if(e.kind==='tool_result'){label=`Evidence returned · ${pretty(e.evidence.analysis)}`;extra=refs([e.evidence.ref]);icon='✓';}
  else if(e.kind==='finding'){role=e.finding.agent;label=e.finding.assessment?`${e.finding.finding_id} · ${pretty(e.finding.assessment)}`:e.finding.finding_id;body=e.finding.observation;extra=refs(e.finding.tool_result_refs)+`<details><summary>Next check requested</summary><p>${h(e.finding.requested_next_check||'None')}</p></details>`;icon='✧';}
  else if(e.kind==='finding_rejected'){label='Finding rejected by validation';body=e.error;icon='!';}
  else if(e.kind==='node_report'){role=pretty(e.instrument);label=`Node report · ${pretty(e.instrument)}`;extra=nodeReportCard(e);icon='⌂';}
  else if(e.kind==='data_shared'){role='Flower';label='Raw data shared';extra=dataSharedHeadline(e);icon='%';}
  return `<div class="activity-row" data-step="${index+1}"><span class="activity-icon ${e.kind==='finding'?'finding':''}" aria-hidden="true">${icon}</span><span class="activity-role">${h(role)}</span><div class="activity-content"><p class="activity-label">${h(label)}</p>${body?`<p>${h(body)}</p>`:''}${extra}</div></div>`;
}
function updateActivity(){
  const run=currentRun();$('#activity-list').innerHTML=run.events.slice(0,state.step).map(activityRow).join('')||'<p class="empty">Press Replay to step through the saved agent activity.</p>';
  if($('#conversation'))$('#conversation').innerHTML=conversationHTML(run.events.slice(0,state.step),{question:run.question,eventId:state.event.id,report:state.step>=run.events.length?run.report:null});
  $('#step-count').textContent=`${state.step} / ${run.events.length} historical events`;
  $('#scrubber').value=state.step;
  $('#playback-label').textContent=state.playing?'Pause replay':'Replay activity';
  if(state.playing)$('#activity-list').scrollTop=$('#activity-list').scrollHeight;
}
function render(){
  nav();const e=state.event,run=currentRun();
  $('#content').innerHTML=`<div class="page-heading"><div><span class="eyebrow">EVENT ${h(e.id.toUpperCase())} / ARCHIVED RF CANDIDATE</span><h1>Follow the evidence.</h1><p class="muted">Investigate ${h(e.station)} against the measured beam response.</p></div><div class="heading-actions"><button class="button secondary" id="download">↓ Export saved run</button></div></div><div class="meta-strip"><div class="meta-item"><span>Recorded candidate end</span><strong>${date(e.time_origin_ns)}</strong></div><div class="meta-item"><span>Candidate station</span><strong class="code">${h(e.station)}</strong></div><div class="meta-item"><span>Investigation model</span><strong>${h(run.report.model)}</strong></div><div class="meta-item"><span>Execution source</span><strong>Saved Flower run · completed</strong></div></div><div class="workspace-grid"><div><section class="panel"><div class="panel-head"><div><span class="eyebrow">RECORDED SIGNALS</span><h2>Equipment & beam</h2></div><button class="text-button" id="focus-chart">${state.focus?'Show context':'Focus candidate'}</button></div><p class="panel-note">Shaded interval: published RF candidate. Time is relative to its recorded end.</p><div class="plots">${plot([e.plots.rf],'rf')}${plot(e.plots.beam.filter(s=>s.kind==='position'),'position')}${plot(e.plots.beam.filter(s=>s.kind==='charge'),'charge')}</div><div class="plot-footnote">Original timestamps retained. Low-charge positions are masked, not treated as orbit measurements. Sparse RF steps hold only a previously recorded value.</div></section><details class="provenance"><summary>Data provenance & recording limits</summary><p><a href="${h(e.provenance.source_url)}" target="_blank" rel="noopener noreferrer">SLAC public AMPL dataset ↗</a></p><p class="code">${h(e.provenance.hdf5_group)}</p><p>${h(e.provenance.timing)}</p>${list(e.provenance.limitations)}<p>${h(e.provenance.license)}</p><p class="small muted">No ground-truth labels are included in this replay payload.</p></details></div><div class="right-stack">${assessment(run)}${followupCard()}</div></div>${run.report.mode==='grid'?'<section class="panel convo-panel" aria-labelledby="convo-title"><div class="panel-head"><div><span class="eyebrow">GRID RUN · SAVED ORDER</span><h2 id="convo-title">Conversation</h2></div></div><p class="panel-note">The question, the orchestrator\'s requests to each instrument node, their summary replies and the final verdict. Follows the replay slider.</p><div id="conversation" aria-live="polite"></div></section>':''}<section class="panel activity-panel"><div class="panel-head"><div class="activity-header"><h2>Agent activity</h2><span class="count">${run.report.findings.length} findings</span></div><span class="eyebrow">HISTORICAL TRACE</span></div><p class="panel-note">Concise findings and tool requests, in their saved order. No private reasoning is shown.</p><div class="playback-bar"><button class="button secondary" id="playback"><span aria-hidden="true">↺</span><span id="playback-label">Replay activity</span></button><input type="range" id="scrubber" min="0" max="${run.events.length}" value="${state.step}" aria-label="Saved activity progress"><span class="playback-status" id="step-count"></span></div><div class="activity-list" id="activity-list" tabindex="0" aria-label="Saved agent activity"></div></section><section class="panel ledger"><div class="panel-head"><div><span class="eyebrow">TRACEABLE & READ-ONLY</span><h2>Evidence ledger</h2></div><span class="small muted">${run.report.evidence.length} unique results</span></div><table class="evidence-table"><thead><tr><th scope="col">EVIDENCE REF</th><th scope="col">ANALYSIS</th><th scope="col">SOURCE</th><th scope="col">RESULT</th></tr></thead><tbody>${run.report.evidence.map(r=>`<tr><td class="code">${h(r.ref)}</td><td class="kind-label">${h(pretty(r.analysis))}</td><td>SLAC AMPL archive</td><td><button class="text-button" data-evidence="${h(r.ref)}">Inspect ↗</button></td></tr>`).join('')}</tbody></table></section>`;
  updateActivity();
  document.querySelectorAll('[data-chart]').forEach(svg=>{
    svg.addEventListener('pointermove',event=>{const rect=svg.getBoundingClientRect(),pos=(event.clientX-rect.left)/rect.width*600;const min=Number(svg.dataset.min),max=Number(svg.dataset.max);if(pos<47||pos>587)return;const t=min+(pos-47)/540*(max-min);let cursor=svg.querySelector('.cursor');cursor.setAttribute('x1',pos);cursor.setAttribute('x2',pos);cursor.setAttribute('visibility','visible');svg.querySelector('.cursor-text').textContent=`${t.toFixed(3)} s`;});
    svg.addEventListener('pointerleave',()=>{svg.querySelector('.cursor').setAttribute('visibility','hidden');svg.querySelector('.cursor-text').textContent='';});
  });
}
function showEvidence(ref){
  const found=state.event.runs.flatMap(r=>r.report.evidence).find(e=>e.ref===ref);if(!found)return;
  $('#evidence-dialog-title').textContent=`${found.ref} · ${pretty(found.analysis)}`;
  $('#evidence-content').innerHTML=`<p class="source-note">${h(found.event_id)} · Original interval (Unix nanoseconds):<br><span class="code">${h((found.interval_ns||[]).join(' → ')||'not recorded')}</span></p><pre></pre>`;
  $('#evidence-content pre').textContent=JSON.stringify(found,null,2);$('#evidence-dialog').showModal();
}
document.addEventListener('click',event=>{
  const el=event.target.closest('button');if(!el)return;
  if(el.dataset.event)loadEvent(el.dataset.event);
  else if(el.dataset.phase!==undefined){stopPlayback();state.runIndex=Number(el.dataset.phase);state.step=currentRun().events.length;render();}
  else if(el.dataset.evidence)showEvidence(el.dataset.evidence);
  else if(el.id==='connection-button'){const panel=$('#connection-panel');panel.hidden=!panel.hidden;el.setAttribute('aria-expanded',!panel.hidden);}
  else if(el.id==='close-evidence')$('#evidence-dialog').close();
  else if(el.id==='focus-chart'){state.focus=!state.focus;render();}
  else if(el.id==='download'){
    const content=JSON.stringify({execution_source:'saved_run',event_id:state.event.id,run:currentRun()},null,2),url=URL.createObjectURL(new Blob([content],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=`${state.event.id}-${currentRun().phase}-saved-run.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }else if(el.id==='playback'){
    if(state.playing){stopPlayback();updateActivity();return;}
    if(state.step>=currentRun().events.length)state.step=0;
    state.playing=true;updateActivity();state.timer=setInterval(()=>{state.step++;if(state.step>=currentRun().events.length)stopPlayback();updateActivity();},650);
  }
});
document.addEventListener('input',event=>{if(event.target.id==='scrubber'){stopPlayback();state.step=Number(event.target.value);updateActivity();}});
$('#evidence-dialog').addEventListener('click',event=>{if(event.target===$('#evidence-dialog'))$('#evidence-dialog').close();});
async function init(){try{
  const response=await fetch('./data/manifest.json');if(!response.ok)throw new Error('The saved-run library could not be loaded.');
  state.manifest=await response.json();nav();let id=decodeURIComponent(location.hash.slice(1));if(!state.manifest.events.some(e=>e.id===id))id=state.manifest.events[0].id;await loadEvent(id);
}catch(e){error(e.message);$('#content').setAttribute('aria-busy','false');}}
if(LOCAL_ORIGINS.has(location.origin)){
  $('#connection-panel').innerHTML='<h3>Local development connection</h3><p>The backend contract is available. Live mode uses the local API on port 8080; provider credentials remain on the backend.</p><a class="button secondary" href="?mode=live">Open local live mode ↗</a><p class="small muted">Nothing runs until you explicitly start an investigation. GitHub Pages remains saved replay only.</p>';
}
if(publicLiveAvailable())$('#connection-panel').innerHTML='<p>Live runs are on. <a href="./">Open the live page</a> to ask your own question.</p>';
const params=new URLSearchParams(location.search);
const wantLive=params.get('mode')!=='replay'&&((params.get('mode')==='live'&&LOCAL_ORIGINS.has(location.origin))||publicLiveAvailable());
if(wantLive){
  import('./live.js').then(m=>m.initLive({onUnavailable:message=>{error(message);init();}})).catch(e=>{
    if(publicLiveAvailable()){error('Live runs are unavailable right now, so here are the saved runs.');init();return;}
    error(e.message);$('#content').setAttribute('aria-busy','false');$('#content').innerHTML='<section class="panel"><div class="assessment-body"><h2>Backend connection unavailable</h2><p>No investigation was submitted. The backend owner manages API availability; this page has not switched to replay.</p><a href="./">Open saved replay explicitly ↗</a></div></section>';$('#event-list').textContent='API connection unavailable.';});
}else{
  if(publicLiveAvailable())$('.replay-notice').insertAdjacentHTML('beforeend','<a class="text-button" href="./">Try it live ↗</a>');
  if(params.get('mode')==='live')error('Live execution is unavailable on this origin. This is saved-run replay; no backend was contacted.');
  init();
}
