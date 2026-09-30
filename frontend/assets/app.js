import {escapeHTML as h, validateReplay, pretty, nodeReportCard, dataSharedHeadline, storyHTML, CASES} from './replay.js';
import {signalsHTML} from './charts.js';
import {LOCAL_ORIGINS,publicLiveAvailable} from './api.js';
const $ = selector => document.querySelector(selector);
const state = {manifest:null,event:null,runIndex:0,step:0,playing:false,timer:null,focus:false,loadVersion:0};
let cache = new Map();
const currentRun = () => state.event.runs[state.runIndex];
const refs = values => `<div class="evidence-links">${[...new Set(values)].map(ref=>`<button class="ref-button" data-evidence="${h(ref)}">${h(ref)}</button>`).join('')}</div>`;
const list = values => `<ul>${values.map(value=>`<li>${h(value)}</li>`).join('')}</ul>`;
const date = ns => new Date(Number(BigInt(ns)/1000000n)).toISOString().slice(0,19).replace('T',' · ')+' UTC';
function stopPlayback(){clearInterval(state.timer);state.timer=null;state.playing=false;}
function error(message){$('#error').hidden=false;$('#error').textContent=message;}
async function loadEvent(id){
  if(state.live){state.live=false;liveModule?.leaveLive();}
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
const liveAvailable=publicLiveAvailable()||LOCAL_ORIGINS.has(location.origin);
let liveModule=null;
const entryOf=id=>state.manifest.events.find(e=>e.id===id);
const modelName=entry=>(entry.note||'').replace(/^Grid run on /,'').replace(/ \(.*\)$/,'');
function nav(){
  const current=entryOf(state.entryId),activeId=state.live?null:current?.variant_of||current?.id;
  $('#event-list').innerHTML=state.manifest.events.filter(e=>!e.variant_of).map(e=>{const c=CASES[e.id.replace(/-(grid|endeavor)$/,'')]||{title:e.id,summary:e.note||''},on=e.id===activeId;
    return `<button class="case-card ${on?'active':''}" data-event="${h(e.id)}" ${on?'aria-current="true"':''}><strong>${h(c.title)}</strong><span>${h(c.summary)}</span></button>`;}).join('')+
    `<button class="case-card live-card ${state.live?'active':''}" data-live-card="1" ${liveAvailable?'':'disabled'} ${state.live?'aria-current="true"':''}><strong>Ask your own <span class="live-badge">LIVE</span></strong><span>${liveAvailable?'Pick an event, ask a question, and watch the agents work it out.':'Coming soon. Live runs aren\'t switched on yet.'}</span></button>`;
}
async function enterLiveMode(){
  stopPlayback();state.live=true;state.loadVersion++;$('#error').hidden=true;nav();history.replaceState(null,'','#live');
  const back=async message=>{state.live=false;liveModule?.leaveLive();await loadEvent(state.entryId||state.manifest.events[0].id);error(message);};
  try{liveModule??=await import('./live.js');await liveModule.enterLive({onUnavailable:back});}
  catch(e){await back(`Live runs are unavailable right now (${e.message}), so here are the saved runs.`);}
}
function details(e,run){
  const m=run.report.metrics;
  return `<details class="more"><summary>More details</summary><div class="more-body">
<section><h3>Every step the agents took</h3><p class="small muted">In the saved order. Follows the replay slider.</p><div class="activity-list" id="activity-list" tabindex="0" aria-label="Saved agent activity"></div></section>
<section><h3>Evidence (${run.report.evidence.length} tool results)</h3><div class="table-scroll"><table class="evidence-table"><thead><tr><th scope="col">Ref</th><th scope="col">Analysis</th><th scope="col">Result</th></tr></thead><tbody>${run.report.evidence.map(r=>`<tr><td class="code">${h(r.ref)}</td><td class="kind-label">${h(pretty(r.analysis))}</td><td><button class="text-button" data-evidence="${h(r.ref)}">Inspect ↗</button></td></tr>`).join('')}</tbody></table></div></section>
<section><h3>This run</h3><ul class="run-facts"><li>Model: <span class="code">${h(run.report.model)}</span></li><li>${m.model_calls} model calls · ${m.tool_calls} tool calls</li><li>${m.input_tokens??'?'} input / ${m.output_tokens??'?'} output tokens</li><li>${run.wall_latency_s.toFixed(1)} s end to end</li><li>Run <span class="code">${h(run.id)}</span></li><li>Event recorded ${date(e.time_origin_ns)}</li></ul><button class="button secondary" id="download">↓ Export saved run</button></section>
<section><h3>Where the data comes from</h3><p><a href="${h(e.provenance.source_url)}" target="_blank" rel="noopener noreferrer">SLAC public klystron anomaly dataset ↗</a></p><p class="small">${h(e.provenance.timing)}</p>${list(e.provenance.limitations)}<p class="small muted">${h(e.provenance.license)}</p></section>
</div></details>`;
}
function activityRow(e,index){
  let role=e.agent||'lead',label='',body='',extra='',icon='·';
  if(e.kind==='started'){role='Flower';label='Investigation started';body=`${e.mode} · ${e.model}`;icon='↗';}
  else if(e.kind==='delegation'){label=e.to?`${pretty(e.agent)} → ${e.to}`:`${pretty(e.instrument)} → node ${e.node_id}`;body=e.question;icon='↳';}
  else if(e.kind==='tool_request'){label=`Requested ${pretty(e.analysis)}`;body='Deterministic, read-only analysis';icon='⌁';}
  else if(e.kind==='tool_result'){label=`Evidence returned · ${pretty(e.evidence.analysis)}`;extra=refs([e.evidence.ref]);icon='✓';}
  else if(e.kind==='finding'){role=e.finding.agent;label=e.finding.assessment?`${e.finding.finding_id} · ${pretty(e.finding.assessment)}`:e.finding.finding_id;body=e.finding.observation;extra=refs(e.finding.tool_result_refs);icon='✧';}
  else if(e.kind==='finding_rejected'){label='Finding rejected by validation';body=e.error;icon='!';}
  else if(e.kind==='node_report'){role=pretty(e.instrument);label=`Node report · ${pretty(e.instrument)}`;extra=nodeReportCard(e);icon='⌂';}
  else if(e.kind==='data_shared'){role='Flower';label='Raw data shared';extra=dataSharedHeadline(e);icon='%';}
  return `<div class="activity-row" data-step="${index+1}"><span class="activity-icon ${e.kind==='finding'?'finding':''}" aria-hidden="true">${icon}</span><span class="activity-role">${h(role)}</span><div class="activity-content"><p class="activity-label">${h(label)}</p>${body?`<p>${h(body)}</p>`:''}${extra}</div></div>`;
}
function updateActivity(){
  const run=currentRun(),done=state.step>=run.events.length;
  $('#story').innerHTML=storyHTML(run.events.slice(0,state.step),{report:done?run.report:null});
  $('#activity-list').innerHTML=run.events.slice(0,state.step).map(activityRow).join('')||'<p class="empty">Press Replay to step through the saved run.</p>';
  $('#step-count').textContent=`Step ${state.step} of ${run.events.length}`;
  $('#scrubber').value=state.step;
  $('#playback-label').textContent=state.playing?'Pause':'Replay the investigation';
}
function render(){
  nav();const e=state.event,run=currentRun(),entry=entryOf(state.entryId),parent=entry.variant_of&&entryOf(entry.variant_of),variants=state.manifest.events.filter(v=>v.variant_of===entry.id);
  const day=new Date(Number(BigInt(e.time_origin_ns)/1000000n)).toLocaleDateString('en-US',{dateStyle:'medium',timeZone:'UTC'});
  $('#content').innerHTML=`<section class="story-card" aria-labelledby="s-question"><h2 id="s-question"><span class="step">1</span> The question</h2><p>On ${h(day)}, the klystron at station <span class="code">${h(e.station)}</span> glitched. The agents set out to answer two things:</p><ol class="questions"><li>Was the beam disturbed?</li><li>If so, did this klystron cause it?</li></ol>${run.question?`<p>Question asked: <q>${h(run.question)}</q></p>`:''}<p class="small muted run-on">Run on ${h(modelName(entry))}.${variants.map(v=>` <button class="text-button" data-event="${h(v.id)}">Same case on ${h(modelName(v))} ↗</button>`).join('')}${parent?` <button class="text-button" data-event="${h(parent.id)}">Back to the ${h(modelName(parent))} run</button>`:''}</p></section>
<div class="playback-bar"><button class="button secondary" id="playback"><span aria-hidden="true">↺</span> <span id="playback-label"></span></button><input type="range" id="scrubber" min="0" max="${run.events.length}" value="${state.step}" aria-label="Replay progress"><span class="playback-status" id="step-count"></span></div>
<div id="story" aria-live="polite"></div>${signalsHTML(e,state.focus,'focus-chart')}${details(e,run)}`;
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
  if(el.dataset.liveCard)enterLiveMode();
  else if(el.dataset.event)loadEvent(el.dataset.event);
  else if(el.dataset.evidence)showEvidence(el.dataset.evidence);
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
const params=new URLSearchParams(location.search);
async function init(){try{
  const response=await fetch('./data/manifest.json');if(!response.ok)throw new Error('The saved-run library could not be loaded.');
  state.manifest=await response.json();nav();let id=decodeURIComponent(location.hash.slice(1));
  if(liveAvailable&&(id==='live'||params.get('mode')==='live'))return enterLiveMode();
  if(!state.manifest.events.some(e=>e.id===id))id=state.manifest.events[0].id;await loadEvent(id);
}catch(e){error(e.message);$('#content').setAttribute('aria-busy','false');}}
if(params.get('mode')==='live'&&!liveAvailable)error('Live runs aren\'t switched on yet. Here are the saved runs.');
init();
