import test from 'node:test';
import assert from 'node:assert/strict';
import {InvestigationAPI,LimitError,SubmissionUncertainError} from '../assets/api.js';
const PAGES='https://iamsorenl.github.io',API='https://1-2-3-4.sslip.io',no=()=>assert.fail('no fetch expected');
const reply=(status,body)=>async()=>({ok:status<400,status,json:async()=>body});
test('Pages origin gets a live client only with a configured HTTPS public API',()=>{
 assert.throws(()=>new InvestigationAPI({pageOrigin:PAGES,publicAPI:'',fetchImpl:no}),/saved-run replay only/);
 assert.throws(()=>new InvestigationAPI({pageOrigin:'https://gavinrs.github.io',publicAPI:API,fetchImpl:no}),/saved-run replay only/);
 assert.throws(()=>new InvestigationAPI({pageOrigin:PAGES,publicAPI:'http://1-2-3-4.sslip.io',fetchImpl:no}),/HTTPS/);
 const api=new InvestigationAPI({pageOrigin:PAGES,publicAPI:API,fetchImpl:no});
 assert.equal(api.baseURL,API);assert.equal(api.public,true);assert.equal(api.maxQuestion,500);
});
test('local origins keep the loopback API and the 4,000-character limit',()=>{
 const api=new InvestigationAPI({pageOrigin:'http://127.0.0.1:5173',publicAPI:API,fetchImpl:no});
 assert.equal(api.baseURL,'http://127.0.0.1:8080');assert.equal(api.public,false);assert.equal(api.maxQuestion,4000);
});
test('429 limit replies become LimitError, not an uncertain submission',async()=>{
 const api=new InvestigationAPI({pageOrigin:PAGES,publicAPI:API,fetchImpl:reply(429,{detail:{code:'daily_limit',message:'Lots of people tried this today'}})});
 await assert.rejects(api.start('slac-001',{mode:'collaborative',question:'q'}),e=>e instanceof LimitError&&!(e instanceof SubmissionUncertainError)&&e.code==='daily_limit'&&/Lots of people/.test(e.message));
 assert.equal(api.submitting,false);
});
test('public questions over 500 characters are refused before any request',()=>{
 const api=new InvestigationAPI({pageOrigin:PAGES,publicAPI:API,fetchImpl:no});
 assert.throws(()=>api.start('slac-001',{mode:'collaborative',question:'x'.repeat(501)}),/500/);
 assert.throws(()=>api.followup('series','x'.repeat(501)),/500/);
});
test('limits() reads the limits endpoint on the public API',async()=>{
 let seen;const api=new InvestigationAPI({pageOrigin:PAGES,publicAPI:API,fetchImpl:async(url)=>{seen=url;return {ok:true,status:200,json:async()=>({public:true,runs_left_today:12,visitor_runs_left:3,busy:false})};}});
 assert.equal((await api.limits()).runs_left_today,12);assert.equal(seen,API+'/api/v1/limits');
});
import {limitBanner} from '../assets/live.js';
test('limit banners show the server message and a link to the saved runs',()=>{
 const html=limitBanner({code:'visitor_limit',message:"You've used your 3 live runs for today"});
 assert.match(html,/You(&#39;|')ve used your 3 live runs/);assert.match(html,/href="\?mode=replay"/);
 assert.doesNotMatch(limitBanner({code:'busy',message:'<script>'}),/<script>/);
});
