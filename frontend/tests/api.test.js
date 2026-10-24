// Transport fixtures test the API contract, not model accuracy. Never served by the site.
import test from 'node:test';
import assert from 'node:assert/strict';
import {InvestigationAPI,SubmissionUncertainError,MaintenanceError,observeJob,normalizePlot,validateResult} from '../assets/api.js';
const result=()=>({result_schema_version:2,findings:[],evidence:[{ref:'T-fixture'}],final:{beam_disturbance:{status:'not_corroborated',rationale:'Protocol fixture',tool_result_refs:['T-fixture']},unique_cause:{status:'not_established',rationale:'Protocol fixture',tool_result_refs:['T-fixture']}}});
const links={status:'/api/v1/investigations/job',activity:'/api/v1/investigations/job/activity',result:'/api/v1/investigations/job/result'};
const job=status=>({id:'job',series_id:'api-series',status,links});
test('Pages and foreign origins cannot construct a live client',()=>{
 assert.throws(()=>new InvestigationAPI({pageOrigin:'https://gavinrs.github.io',fetchImpl:()=>assert.fail()}),/saved-run replay only/);
 assert.throws(()=>new InvestigationAPI({pageOrigin:'http://127.0.0.1:5173',baseURL:'https://example.com',fetchImpl:()=>assert.fail()}),/loopback/);
});
test('a lost POST is never retried and no credential/provider/model enters the body',async()=>{
 let calls=[];const api=new InvestigationAPI({pageOrigin:'http://127.0.0.1:5173',fetchImpl:async(url,options)=>{calls.push({url,options});throw new Error('connection lost');}});
 await assert.rejects(api.start('slac-001'),SubmissionUncertainError);
 assert.equal(calls.length,1);
 assert.deepEqual(JSON.parse(calls[0].options.body),{event_id:'slac-001',mode:'collaborative'});
 assert.equal(calls[0].options.credentials,'omit');
 await assert.rejects(api.request('https://another.example/api/v1/result'),/unexpected API link/);
});
test('pending submit is blocked and follow-up uses API UUID plus question only',async()=>{
 let finish;let captured;
 const api=new InvestigationAPI({pageOrigin:'http://127.0.0.1:5173',fetchImpl:(url,options)=>{captured={url,options};return new Promise(r=>finish=r);}});
 const pending=api.followup('api-series',' Check low charge? ');
 await assert.rejects(api.start('slac-003'),/pending/);
 assert.match(captured.url,/series\/api-series\/follow-ups$/);
 assert.deepEqual(JSON.parse(captured.options.body),{question:'Check low charge?'});
 finish({ok:true,json:async()=>job('queued')});await pending;
});
test('drains pages, deduplicates sequence numbers, accepts result only after completed',async()=>{
 let order=[],updates=[],pages=0;
 const api={request:async path=>{
  order.push(path);
  if(path.includes('/activity')){pages++;return pages===1?{events:[{seq:1,event:{kind:'report',report:result()}}],next_cursor:1,has_more:true}:{events:[{seq:1,event:{kind:'report'}},{seq:2,event:{kind:'future_kind'}}],next_cursor:2,has_more:false};}
  if(path===links.status)return job('completed');
  if(path===links.result)return {report:result()};
  assert.fail(path);
 }};
 const final=await observeJob(api,job('running'),u=>updates.push(u),{sleep:async()=>{}});
 assert.equal(final.events.length,2);
 assert.equal(updates[0].report,null);
 assert.equal(order.at(-1),links.result);
 assert.equal(final.report.final.unique_cause.status,'not_established');
});
test('failed/interrupted status never accepts provisional report or fetches a result',async()=>{
 for(const status of ['failed','interrupted']){
  const api={request:async path=>{assert.match(path,/activity/);return {events:[{seq:1,event:{kind:'report',report:result()}}],next_cursor:1,has_more:false};}};
  await assert.rejects(observeJob(api,job(status),()=>{}),new RegExp(status));
 }
});
test('legacy mixed-scope assessment is never converted to v2 dimensions',()=>{
 assert.throws(()=>validateResult({final:{assessment:'corroborated'}}),/not schema v2/);
 const bad=result();bad.final.unique_cause.tool_result_refs=['invented'];assert.throws(()=>validateResult(bad),/evidence reference/);
});
test('plot contract preserves nanoseconds, holds only observed RF and keeps BPM gaps',()=>{
 const view=normalizePlot({station:'KLYS:EXAMPLE'},{event_id:'example',reference_time_ns:'1604277203201922048',candidate_interval_ns:['1604277203101922048','1604277203201922048'],traces:[{channel:'RF:AMPL',family:'health',relative_s:[-.1,0,.1],values:[null,3,null]},{channel:'BPM:X',family:'bpm',relative_s:[-.1,0,.1],values:[1,null,2]}]});
 assert.deepEqual(view.candidate_interval_s,[-.1,0]);
 assert.deepEqual(view.plots.rf.points,[[0,3]]);
 assert.equal(view.plots.beam[0].points[1][1],null);
 assert.equal(view.time_origin_ns,'1604277203201922048');
});
test('default browser fetch is invoked without an API-instance receiver',async()=>{
 const original=globalThis.fetch;
 globalThis.fetch=function(){
  assert.ok(this===undefined||this===globalThis,'native Window.fetch must not receive the client object as this');
  return Promise.resolve({ok:true,json:async()=>({event_ids:['slac-001']})});
 };
 try{const api=new InvestigationAPI({pageOrigin:'http://127.0.0.1:5173'});assert.deepEqual(await api.events(),{event_ids:['slac-001']});}
 finally{globalThis.fetch=original;}
});
test('public server down or behind a dead gateway reads as maintenance',async()=>{
 const pub=fetchImpl=>new InvestigationAPI({pageOrigin:'https://pages.test',publicAPI:'https://api.test',pagesOrigin:'https://pages.test',fetchImpl});
 await assert.rejects(pub(async()=>{throw new Error('offline');}).limits(),MaintenanceError);
 await assert.rejects(pub(async()=>({status:502,ok:false,json:async()=>{throw new Error('html');}})).events(),/maintenance/);
 await assert.rejects(pub(async()=>({status:404,ok:false,json:async()=>({detail:'nope'})})).events(),/API 404/);
});
