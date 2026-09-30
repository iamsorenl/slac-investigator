import {InvestigationAPI,SubmissionUncertainError,LimitError,observeJob,normalizePlot} from './api.js';
import {escapeHTML as h,pretty,nodeReportCard,dataSharedHeadline,conversationHTML} from './replay.js';
import {plot} from './charts.js';
const $=s=>document.querySelector(s);
const live={api:null,events:[],selected:null,data:null,history:[],activity:[],status:null,busy:false,error:'',limits:null,limitError:null,uncertain:false,focus:false,question:'Was the beam disturbed during this event, and do we know why?',questionSent:true};
export function limitBanner(error){return `<div class="live-error limit-banner" role="status"><p>${h(error.message)}</p><a class="button secondary" href="?mode=replay">See the saved runs ↗</a></div>`;}
const refButtons=refs=>`<div class="evidence-links">${[...new Set(refs||[])].map(ref=>`<button class="ref-button" data-live-evidence="${h(ref)}">${h(ref)}</button>`).join('')}</div>`;
function storeJob(){
  sessionStorage.setItem('slac-live-job',JSON.stringify({eventId:live.selected,jobId:live.status?.id,historyIds:live.history.map(r=>r.status.id),uncertain:live.uncertain}));
}
function dimensions(f){return `<div class="dimension-grid">${[['beam_disturbance','Beam disturbance corroborated?'],['unique_cause','Unique cause established?']].map(([key,title])=>`<div><strong>${title}</strong><span>${h(pretty(f[key].status))}</span><p>${h(f[key].rationale)}</p>${refButtons(f[key].tool_result_refs)}</div>`).join('')}</div>`;}
function reportCard(item,index){
  const r=item.report,f=r.final;
  return `<section class="panel"><div class="assessment-header"><span class="eyebrow">COMPLETED LIVE RUN · SCHEMA V2</span><h2>${index===0?'Initial assessment':'Follow-up assessment'}</h2>${r.data_shared?dataSharedHeadline(r.data_shared):''}</div><div class="assessment-body">${dimensions(f)}<p>${h(f.observation)}</p><details><summary>Limitations and evidence</summary><ul>${f.data_limitations.map(x=>`<li>${h(x)}</li>`).join('')}</ul>${refButtons(f.tool_result_refs)}<p><strong>Requested next check</strong><br>${h(f.requested_next_check||'None')}</p><p class="muted small">A requested check has not necessarily been performed.</p></details></div><div class="run-details"><span>Flower run <span class="code">${h(r.flower_run_id)}</span></span><span>${r.metrics.model_calls} model / ${r.metrics.tool_calls} tool calls</span><span>Cost: ${r.metrics.cost_usd===null?'unavailable':h(r.metrics.cost_usd)}</span></div></section>`;
}
function activity(){return live.activity.filter(item=>['started','delegation','tool_request','tool_result','finding','finding_rejected','failed','node_report','data_shared'].includes(item.event.kind)).map(item=>{
  const e=item.event,f=e.finding;
  const text=e.kind==='delegation'?e.question:e.kind==='tool_request'?`Requests ${pretty(e.analysis)}`:e.kind==='tool_result'?`Evidence returned · ${pretty(e.evidence.analysis)}`:e.kind==='finding'?f.observation:e.kind==='finding_rejected'?'Finding rejected by validation':e.kind==='failed'?e.error.message:e.kind==='node_report'?e.observation:e.kind==='data_shared'?`${Number(e.percent_shared).toFixed(1)}% of raw data shared`:'Flower investigation started';
  const role=f?.agent||e.agent||(e.kind==='node_report'?pretty(e.instrument):'Flower');
  return `<div class="activity-row"><span class="activity-icon">${item.seq}</span><span class="activity-role">${h(role)}</span><div class="activity-content"><p class="activity-label">${h(pretty(e.kind))}</p><p>${h(text)}</p>${f?dimensions(f):e.evidence?refButtons([e.evidence.ref]):e.kind==='node_report'?nodeReportCard(e):e.kind==='data_shared'?dataSharedHeadline(e):''}</div></div>`;
}).join('')||'<p class="empty">No activity yet. Starting an investigation submits a real job to the local backend.</p>';}
function render(){
  $('#event-list').innerHTML=live.events.map(id=>`<button class="event-button ${id===live.selected?'active':''}" data-live-event="${h(id)}" ${live.busy?'disabled':''}><span class="event-name">${h(id)} ↗</span><span class="event-count">${live.api.public?'Live event':'Local backend event'}</span></button>`).join('');
  if(!live.data)return;
  const d=live.data,pub=live.api.public,outOfRuns=live.limits&&(live.limits.runs_left_today===0||live.limits.visitor_runs_left===0),canFollow=live.history.length>0&&live.status?.status==='completed'&&!live.busy&&!live.uncertain;
  $('#content').innerHTML=`<div class="page-heading"><div><span class="eyebrow">${pub?'LIVE RUN':'LOCAL LIVE EXECUTION'} / ${h(live.selected)}</span><h1>Investigate with Flower.</h1><p class="muted">${pub?'Ask your own question. A live Flower grid on Groq gpt-oss-20b answers it; nothing here is pre-recorded.':'Real model execution through the local backend. No replay fallback.'}</p>${live.limits?`<p class="small muted">${live.limits.runs_left_today} live runs left today · you have ${live.limits.visitor_runs_left}</p>`:''}${live.limitError?limitBanner(live.limitError):''}</div><button class="button primary" id="live-start" ${live.busy||live.uncertain||outOfRuns?'disabled':''}>${live.busy?'Investigation in progress…':'Start live investigation'}</button></div><div class="meta-strip"><div class="meta-item"><span>Station</span><strong>${h(d.station)}</strong></div><div class="meta-item"><span>Source</span><strong>SLAC public archive</strong></div><div class="meta-item"><span>Backend status</span><strong>${h(live.status?.status||'Ready · not started')}</strong></div><div class="meta-item"><span>Execution</span><strong>${pub?'Live run · Groq gpt-oss-20b on self-hosted Flower':'Local API → Flower'}</strong></div></div>${live.error?`<div class="live-error" role="alert">${h(live.error)} ${live.status?.id?'<button class="text-button" id="live-resume">Refresh existing run status</button>':''}</div>`:''}<div class="workspace-grid"><div><section class="panel"><div class="panel-head"><h2>Equipment & beam</h2><button class="text-button" id="live-focus">${live.focus?'Show context':'Focus candidate'}</button></div><p class="panel-note">Original measurements from the backend. Candidate interval shaded; no time shifts.</p><div class="plots">${plot(d,live.focus,[d.plots.rf],'rf')}${plot(d,live.focus,d.plots.beam.filter(t=>t.kind==='position'),'position')}${plot(d,live.focus,d.plots.beam.filter(t=>t.kind==='charge'),'charge')}</div><div class="plot-footnote">Low-charge positions are masked by the backend. Sparse RF nulls mean no update.</div></section><details class="provenance"><summary>Data provenance & limitations</summary><p><a href="${h(d.provenance.source_url)}" rel="noopener noreferrer" target="_blank">SLAC public archive ↗</a></p><p>${h(d.provenance.timing)}</p><p>${h(d.provenance.license)}</p></details></div><div class="right-stack">${live.history.length?live.history.map(reportCard).join(''):'<section class="panel"><div class="assessment-header"><span class="eyebrow">NO ACCEPTED ASSESSMENT YET</span><h2>Waiting for an investigation</h2></div><div class="assessment-body"><p>The final assessment appears only after the backend confirms completion. An activity report alone is provisional.</p></div></section>'}${live.busy?`<section class="panel"><div class="assessment-body"><strong>${h(live.status?.status||'Submitting')}…</strong><p class="small muted">${live.history.length?'The initial assessment stays visible while the follow-up runs.':'Evidence and findings appear below as the backend reports them.'}</p></div></section>`:''}<section class="panel followup-card"><div class="panel-head"><h2>Human follow-up</h2></div><form class="live-form" id="live-followup"><label for="live-question">Question for the investigators</label><textarea id="live-question" maxlength="4000" required ${canFollow?'':'disabled'} placeholder="Could low charge explain the position readings?"></textarea><button class="button secondary" ${canFollow?'':'disabled'}>Submit live follow-up</button><p class="small muted">Continues the latest completed API series. Historical replay series cannot be used here.</p></form></section></div></div><section class="panel convo-panel" aria-labelledby="live-convo-title"><div class="panel-head"><h2 id="live-convo-title">Conversation</h2></div><form class="live-form" id="live-ask"><label for="live-initial-question">Your question (starts a Grid investigation)</label><textarea id="live-initial-question" maxlength="${live.api.maxQuestion}" ${live.busy||live.uncertain?'disabled':''}>${h(live.question)}</textarea></form>${live.questionSent?'':'<p class="panel-note">This backend did not accept a question on start, so the agents ran without it.</p>'}<div aria-live="polite">${conversationHTML(live.activity.map(i=>i.event),{question:live.question,eventId:live.selected,report:live.history.at(-1)?.report})}</div></section><section class="panel activity-panel"><div class="panel-head"><h2>Live agent activity</h2><span class="live-status">${h(live.status?.status||'Not started')}</span></div><div class="activity-list" tabindex="0" aria-label="Live agent activity">${activity()}</div></section>`;
  $('#content').setAttribute('aria-busy','false');
}
async function selectEvent(id){
  if(live.busy)return;
  live.selected=id;live.data=null;live.history=[];live.activity=[];live.status=null;live.error='';
  $('#content').setAttribute('aria-busy','true');$('#content').innerHTML='<p class="loading">Reading event metadata and plot traces from the local API…</p>';
  const [meta,plots]=await Promise.all([live.api.metadata(id),live.api.plot(id)]);
  live.data=normalizePlot(meta,plots);render();
}
async function observe(job){
  live.status=job;storeJob();
  const result=await observeJob(live.api,job,update=>{
    live.status=update.status;live.activity=update.events;
    if(update.report&&!live.history.some(r=>r.status.id===update.status.id))live.history.push(update);
    storeJob();render();
  });
  return result;
}
async function submit(question){
  if(live.busy||live.uncertain)return;
  live.busy=true;live.error='';live.limitError=null;live.activity=[];render();
  try{
    let job;
    if(question===undefined){
      live.question=live.question.trim();if(!live.question)throw new Error('Enter a question to start the investigation.');live.questionSent=true;
      // Older backends reject unknown start fields with 422 (nothing queued), so retry once without the question and say so.
      try{job=await live.api.start(live.selected,{mode:'collaborative',question:live.question});}
      catch(e){if(!/^API 422/.test(e.message))throw e;live.questionSent=false;job=await live.api.start(live.selected,{mode:'collaborative'});}
    }else job=await live.api.followup(live.status.series_id,question);
    if(question===undefined)live.history=[];
    await observe(job);
  }catch(e){if(e instanceof LimitError)live.limitError=e;else{live.error=e.message;if(e instanceof SubmissionUncertainError){live.uncertain=true;storeJob();}}}
  finally{live.busy=false;try{live.limits=await live.api.limits();}catch{}render();}
}
async function resume(id,historyIds=[]){
  if(live.busy)return;live.busy=true;live.error='';
  try{
    for(const priorId of historyIds.filter(x=>x!==id)){
      if(live.history.some(r=>r.status.id===priorId))continue;
      const status=await live.api.status(priorId);
      if(status.status==='completed')await observeJob(live.api,status,update=>{if(update.report)live.history.push(update);});
    }
    await observe(await live.api.status(id));
  }catch(e){live.error=e.message;}
  finally{live.busy=false;render();}
}
function evidence(ref){
  const candidates=[...live.history.flatMap(r=>r.report.evidence),...live.activity.filter(e=>e.event.kind==='tool_result').map(e=>e.event.evidence)];
  const result=candidates.find(e=>e.ref===ref);if(!result)return;
  $('#evidence-dialog-title').textContent=`${result.ref} · ${pretty(result.analysis)}`;
  $('#evidence-content').innerHTML='<p class="source-note">Read-only backend tool evidence. Exact timestamps remain strings.</p><pre></pre>';
  $('#evidence-content pre').textContent=JSON.stringify(result,null,2);$('#evidence-dialog').showModal();
}
export async function initLive({onUnavailable}={}){
  live.api=new InvestigationAPI();
  if(live.api.public){try{live.limits=await live.api.limits();}catch(e){onUnavailable?.('Live runs are unavailable right now, so here are the saved runs.');return;}}
  $('.mode-pill').classList.add('live');$('.mode-pill').innerHTML=live.api.public?'<i></i> Live · Groq on Flower':'<i></i> Local live execution';
  $('.sidebar>.small').textContent='Events from the local backend.';
  $('.replay-notice').innerHTML='<span class="notice-icon">↗</span><div><strong>Local live execution</strong><span>A new investigation makes real backend model calls. No provider credentials enter the browser.</span></div><a class="text-button" href="?mode=replay">Open saved replay ↗</a>';
  $('#connection-panel').hidden=true;
  document.addEventListener('click',async e=>{
    const b=e.target.closest('button');if(!b)return;
    try{
      if(b.dataset.liveEvent)await selectEvent(b.dataset.liveEvent);
      else if(b.dataset.liveEvidence)evidence(b.dataset.liveEvidence);
      else if(b.id==='live-start')await submit();
      else if(b.id==='live-resume')await resume(live.status.id);
      else if(b.id==='live-focus'){live.focus=!live.focus;render();}
    }catch(error){live.error=error.message;render();}
  });
  document.addEventListener('input',e=>{if(e.target.id==='live-initial-question')live.question=e.target.value;});
  document.addEventListener('submit',e=>{if(e.target.id==='live-followup'){e.preventDefault();const q=$('#live-question').value.trim();if(q)submit(q);}});
  const catalog=await live.api.events();live.events=catalog.event_ids;
  let saved;try{saved=JSON.parse(sessionStorage.getItem('slac-live-job')||'null');}catch{}
  const requested=decodeURIComponent(location.hash.slice(1));
  const eventId=live.events.includes(requested)?requested:live.events.includes(saved?.eventId)?saved.eventId:live.events[0];
  await selectEvent(eventId);
  if(saved?.eventId===eventId){live.uncertain=!!saved.uncertain;
    if(live.uncertain){live.error='An earlier submission had an uncertain response. No work was resubmitted. Ask the backend owner to locate the job.';render();}
    else if(saved.jobId)await resume(saved.jobId,saved.historyIds||[]);
  }
}
