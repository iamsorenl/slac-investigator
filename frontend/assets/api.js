// Browser client for docs/API.md v1. No provider configuration or credentials.
import {PUBLIC_API,PAGES_ORIGIN} from './config.js';
export const LOCAL_ORIGINS=new Set(['http://localhost:3000','http://127.0.0.1:3000','http://localhost:5173','http://127.0.0.1:5173']);
export class SubmissionUncertainError extends Error {}
export class LimitError extends Error{constructor(code,message){super(message);this.code=code;}}
export class InvestigationAPI {
  constructor({pageOrigin=location.origin,baseURL,fetchImpl=(...args)=>fetch(...args),publicAPI=PUBLIC_API,pagesOrigin=PAGES_ORIGIN}={}){
    this.public=Boolean(publicAPI)&&pageOrigin===pagesOrigin;
    if(!LOCAL_ORIGINS.has(pageOrigin)&&!this.public)throw new Error('Live execution is not available from this origin; saved-run replay only.');
    const url=new URL(baseURL??(this.public?publicAPI:'http://127.0.0.1:8080'));
    if(this.public){if(url.protocol!=='https:'||url.origin!==new URL(publicAPI).origin||url.username||url.password)throw new Error('The public API must be the configured HTTPS address.');}
    else if(url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname)||url.username||url.password)throw new Error('Only the documented loopback development API is supported.');
    this.baseURL=url.origin;this.fetch=fetchImpl;this.submitting=false;this.maxQuestion=this.public?500:4000;
  }
  async request(path,{method='GET',body}={}){
    const url=new URL(path,this.baseURL);
    if(url.origin!==this.baseURL||!url.pathname.startsWith('/api/v1/'))throw new Error('Backend returned an unexpected API link.');
    let response;
    try{response=await this.fetch(url.href,{method,credentials:'omit',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});}
    catch(error){if(method==='POST')throw new SubmissionUncertainError('Submission response was lost. Work may already be running. It was not resubmitted; ask the backend owner to inspect the queue.');throw new Error(`${this.public?'Could not reach the live server.':'Local API connection failed.'} Saved replay has not been substituted.`);}
    let payload;
    try{payload=await response.json();}catch(error){
      if(method==='POST'&&response.ok)throw new SubmissionUncertainError('The backend accepted the request but its response could not be read. Do not resubmit; ask the backend owner to locate the run.');
      throw new Error(`API response could not be read (${response.status}).`);
    }
    if(response.status===429&&payload.detail?.code)throw new LimitError(payload.detail.code,payload.detail.message);
    if(!response.ok){const detail=payload.detail;throw new Error(`API ${response.status}: ${typeof detail==='string'?detail:detail?.error?.message||detail?.status||'Request rejected. Check the API contract.'}`);}
    return payload;
  }
  events(){return this.request('/api/v1/events');}
  metadata(id){return this.request(`/api/v1/events/${encodeURIComponent(id)}`);}
  plot(id){return this.request(`/api/v1/events/${encodeURIComponent(id)}/plot`);}
  async submit(path,body){
    if(this.submitting)throw new Error('A submission is already pending.');
    this.submitting=true;try{return await this.request(path,{method:'POST',body});}finally{this.submitting=false;}
  }
  // question is sent only when given (grid demo); the collaborative default body is unchanged.
  start(eventId,{mode='collaborative',question=''}={}){const q=question.trim();if(q.length>this.maxQuestion)throw new Error(`Enter a question of at most ${this.maxQuestion.toLocaleString('en-US')} characters.`);return this.submit('/api/v1/investigations',q?{event_id:eventId,mode,question:q}:{event_id:eventId,mode});}
  followup(seriesId,question){
    const q=question.trim();if(!q||q.length>this.maxQuestion)throw new Error(`Enter a question of 1–${this.maxQuestion.toLocaleString('en-US')} characters.`);
    return this.submit(`/api/v1/series/${encodeURIComponent(seriesId)}/follow-ups`,{question:q});
  }
  status(id){return this.request(`/api/v1/investigations/${encodeURIComponent(id)}`);}
  limits(){return this.request('/api/v1/limits');}
}
export function validateResult(report){
  if(report.result_schema_version!==2)throw new Error('Live result is not schema v2; legacy fields cannot be converted automatically.');
  const refs=new Set(report.evidence.map(e=>e.ref));
  for(const finding of [...report.findings,report.final]){
    for(const dimension of ['beam_disturbance','unique_cause']){
      const value=finding[dimension];
      const allowed=dimension==='beam_disturbance'?['corroborated','not_corroborated','insufficient_evidence','not_assessed']:['established','not_established','insufficient_evidence','not_assessed'];
      if(!value||!allowed.includes(value.status)||!Array.isArray(value.tool_result_refs)||!value.tool_result_refs.every(ref=>refs.has(ref)))throw new Error('Result has an invalid assessment dimension or evidence reference.');
      if(value.status!=='not_assessed'&&!value.tool_result_refs.length)throw new Error('An assessed dimension has no evidence reference.');
    }
  }
  return report;
}
export async function observeJob(api,initial,onUpdate,{sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
  let status=initial,cursor=0;const events=[],seen=new Set();
  const drain=async()=>{
    let page;
    do{
      page=await api.request(`${status.links.activity}?after=${cursor}&limit=100`);
      for(const item of page.events){const key=`${status.id}:${item.seq}`;if(!seen.has(key)){seen.add(key);events.push(item);}}
      if(page.has_more&&page.next_cursor<=cursor)throw new Error('Activity cursor did not advance; polling stopped.');
      cursor=page.next_cursor;
    }while(page.has_more);
  };
  while(true){
    await drain();onUpdate({status,events:[...events],report:null});
    if(['completed','failed','interrupted'].includes(status.status)){
      if(status.status!=='completed')throw new Error(`${status.status}: ${status.error?.message||'No accepted result is available.'}`);
      const result=await api.request(status.links.result);
      validateResult(result.report);
      onUpdate({status,events:[...events],report:result.report});return {status,events,report:result.report};
    }
    await sleep(1000);status=await api.request(status.links.status);
  }
}
export function normalizePlot(meta,plot){
  const origin=BigInt(plot.reference_time_ns);
  const traces=plot.traces.map(t=>({channel:t.channel,kind:t.family==='health'?'rf':t.channel.endsWith(':TMIT')?'charge':'position',points:t.relative_s.map((x,i)=>[x,t.values[i]])}));
  const rf=traces.find(t=>t.kind==='rf');if(!rf)throw new Error('The API did not return an RF plot trace.');
  // RF nulls mean no update: omit them for a step plot without leading backfill.
  rf.points=rf.points.filter(p=>p[1]!==null);
  return {id:plot.event_id,station:meta.station,provenance:meta,time_origin_ns:plot.reference_time_ns,candidate_interval_s:plot.candidate_interval_ns.map(t=>Number(BigInt(t)-origin)/1e9),plots:{rf,beam:traces.filter(t=>t.kind!=='rf')}};
}
export function publicLiveAvailable(origin=location.origin){return Boolean(PUBLIC_API)&&origin===PAGES_ORIGIN;}
