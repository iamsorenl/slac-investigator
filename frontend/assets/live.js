import {InvestigationAPI,SubmissionUncertainError,LimitError,observeJob,normalizePlot} from './api.js';
import {escapeHTML as h,pretty,nodeReportCard,dataSharedHeadline,storyHTML,CASES} from './replay.js';
import {signalsHTML} from './charts.js';
const $=s=>document.querySelector(s);
const live={active:false,api:null,events:[],selected:null,data:null,history:[],activity:[],status:null,busy:false,error:'',limits:null,limitError:null,uncertain:false,focus:false,question:'Was the beam disturbed during this event, and do we know why?',questionSent:true};
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
}).join('')||'<p class="empty">No activity yet. Starting an investigation submits a real job to '+(live.api.public?'the live server.':'the local backend.')+'</p>';}
function render(){
  if(!live.active)return;
  if(!live.data)return;
  const d=live.data,pub=live.api.public,outOfRuns=live.limits&&(live.limits.runs_left_today===0||live.limits.visitor_runs_left===0),canFollow=live.history.length>0&&live.status?.status==='completed'&&!live.busy&&!live.uncertain;
  $('#content').innerHTML=`<section class="story-card" aria-labelledby="s-question"><h2 id="s-question"><span class="step">1</span> The question</h2><div class="event-pick" role="group" aria-label="Event">${live.events.map(id=>`<button class="chip ${id===live.selected?'active':''}" data-live-event="${h(id)}" ${live.busy?'disabled':''} ${id===live.selected?'aria-pressed="true"':'aria-pressed="false"'}>${h(CASES[id]?.title||id)}</button>`).join('')}</div><p>The klystron at station <span class="code">${h(d.station)}</span> glitched. Ask the agents about it, or keep the default question.</p><div class="live-form"><label for="live-initial-question">Your question</label><textarea id="live-initial-question" maxlength="${live.api.maxQuestion}" ${live.busy||live.uncertain?'disabled':''}>${h(live.question)}</textarea><div class="ask-row"><button type="button" class="button primary" id="live-start" ${live.busy||live.uncertain||outOfRuns?'disabled':''}>${live.busy?'Investigating…':'Start investigation'}</button>${live.limits?`<span class="small muted">${live.limits.runs_left_today} live runs left today · ${live.limits.visitor_runs_left} for you</span>`:''}</div></div>${live.busy?`<p class="small muted" role="status">${h(live.status?.status||'Submitting')}…</p>`:''}${live.limitError?limitBanner(live.limitError):''}${live.error?`<div class="live-error" role="alert">${h(live.error)} ${live.status?.id?'<button class="text-button" id="live-resume">Refresh existing run status</button>':''}</div>`:''}${live.questionSent?'':'<p class="small muted">This backend did not accept a question on start, so the agents ran without it.</p>'}<p class="small muted run-on">${pub?'Runs live on Groq gpt-oss-20b, on a self-hosted Flower grid. Nothing here is pre-recorded.':'Runs through the local backend.'}</p></section>
<div id="story" aria-live="polite">${storyHTML(live.activity.map(i=>i.event),{report:live.history.at(-1)?.report})}</div>
${canFollow?`<section class="story-card"><h2>Ask a follow-up</h2><form class="live-form" id="live-followup"><label for="live-question">Question for the investigators</label><textarea id="live-question" maxlength="${live.api.maxQuestion}" required placeholder="Could low charge explain the position readings?"></textarea><button class="button secondary">Ask</button></form></section>`:''}
${signalsHTML(d,live.focus,'live-focus')}
<details class="more"><summary>More details</summary><div class="more-body"><section><h3>Every step the agents took</h3><div class="activity-list" tabindex="0" aria-label="Live agent activity">${activity()}</div></section>${live.history.length?`<section><h3>Full reports</h3>${live.history.map(reportCard).join('')}</section>`:''}<section><h3>Where the data comes from</h3><p><a href="${h(d.provenance.source_url)}" rel="noopener noreferrer" target="_blank">SLAC public klystron anomaly dataset ↗</a></p><p class="small">${h(d.provenance.timing)}</p><p class="small muted">${h(d.provenance.license)}</p></section></div></details>`;
  $('#content').setAttribute('aria-busy','false');
}
async function selectEvent(id){
  if(live.busy)return;
  live.selected=id;live.data=null;live.history=[];live.activity=[];live.status=null;live.error='';
  if(live.active){$('#content').setAttribute('aria-busy','true');$('#content').innerHTML='<p class="loading">Reading event metadata and plot traces from '+(live.api.public?'the live server':'the local API')+'…</p>';}
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
  finally{live.busy=false;if(live.api.public)try{live.limits=await live.api.limits();}catch{}render();}
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
let started=false;
export function leaveLive(){live.active=false;}
// Called each time the visitor opens the live card. First call loads the catalog and wires listeners once.
export async function enterLive({onUnavailable}={}){
  live.active=true;
  if(started){if(live.api.public)try{live.limits=await live.api.limits();}catch{}render();return;}
  live.api=new InvestigationAPI();
  if(live.api.public){try{live.limits=await live.api.limits();}catch(e){live.active=false;onUnavailable?.('The live server is waking up or offline. Try again in a minute; the saved runs are here meanwhile.');return;}}
  const catalog=await live.api.events();live.events=catalog.event_ids;started=true;
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
  let saved;try{saved=JSON.parse(sessionStorage.getItem('slac-live-job')||'null');}catch{}
  const requested=decodeURIComponent(location.hash.slice(1));
  const eventId=live.events.includes(requested)?requested:live.events.includes(saved?.eventId)?saved.eventId:live.events[0];
  await selectEvent(eventId);
  if(saved?.eventId===eventId){live.uncertain=!!saved.uncertain;
    if(live.uncertain){live.error='An earlier submission had an uncertain response. No work was resubmitted. Ask the backend owner to locate the job.';render();}
    else if(saved.jobId)await resume(saved.jobId,saved.historyIds||[]);
  }
}
