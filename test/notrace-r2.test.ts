import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tempPrefix} from './temp.ts';
import {Wakes} from '../src/wake.ts';
import {Gateway} from '../src/gateway.ts';
import {main} from '../src/cli.ts';
import {createApp} from '../src/server.ts';
import {writePrivate, lease} from '../src/security.ts';
import {loadConfig} from '../src/config.ts';
import {fakeHTTP} from './fake-http.ts';
import {sweepWakeChats} from '../extension/core.ts';

const url = (id: string) => 'https://chatgpt.com/c/'+id;
const floor = Date.parse('2026-09-15T00:00:00Z');
const key = 'k'.repeat(43);
const scope = 'a'.repeat(22), identity = 'sol~session-'+scope;
function temporary(t: any) {const d=fs.mkdtempSync(tempPrefix('notrace-r2-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;}
function worker(t: any, scoped = true) {
  let clock=floor+86400000;
  const config:any={prefix:'chatgpt',connector:'Crossfeed',labels:{sol:{row:'Latest',level:0}},session_workers:scoped?{[identity]:{label:'sol',scope}}:{}};
  const name=scoped?identity:'sol';let alive=true;
  const w=new Wakes(config,()=>clock,{alive:()=>alive,contact:()=>1,registeredContact:()=>true});
  w.enqueue(name);const ticket=w.next().ticket!;w.claim(ticket.nonce);w.chat({nonce:ticket.nonce,url:url('warm')});w.result({nonce:ticket.nonce,ok:true,url:url('warm')});
  return {w,config,name,advance:(ms:number)=>clock+=ms,expire:()=>alive=false};
}

test('round2: scoped chat survives its jobs and is directly queued on session release',t=>{
  const f=worker(t);
  for(let i=0;i<3;i++) {assert.equal(f.w.finishJob(f.name),false);assert.equal(f.config.session_workers[identity].url,url('warm'));assert.deepEqual(f.config.wake_state.archives,[]);}
  assert.deepEqual(f.w.releaseSession(scope),{released:1,queued:1});
  assert.deepEqual(f.config.session_workers,{});
  assert.equal(f.w.archiveNext().archive!.verify,undefined);
});

test('round2: scoped chat retires after its worker lease expires with a fake clock',t=>{
  const f=worker(t);f.w.finishJob(f.name);f.advance(120001);
  assert.deepEqual(f.w.reconcile(true),{retired:0,orphans:0});
  assert.equal(f.config.session_workers[identity].url,url('warm'));
  f.expire();assert.deepEqual(f.w.reconcile(true),{retired:1,orphans:0});
  assert.deepEqual(f.config.wake_state.archives,[url('warm')]);
});

test('round2: unscoped label completion queues its chat at the job boundary',async t=>{
  const f=worker(t,false);const g=new Gateway(f.config,{pollMs:1});t.after(()=>g.close());
  g.onFinished=job=>f.w.finishJob(job.worker!);
  const caller=g.submit({model:'chatgpt:sol',messages:[{role:'user',content:'answer'}]},'unscoped');
  const work=await g.exchange('connector',{worker_label:'sol'});assert.ok(work.state==='request');
  const ended=await g.exchange('connector',{worker_label:'sol',request_id:work.request!.request_id,claim_token:work.request!.claim_token,response:'done'});
  assert.equal((await caller).choices[0].message.content,'done');assert.equal(ended.state,'released');
  assert.deepEqual(f.config.wake_state.archives,[url('warm')]);assert.equal(f.config.labels.sol.url,undefined);
});

test('round2: legacy import validates exact URLs and IDs, skips retained and queued, and persists proof',async t=>{
  const directory=temporary(t),source=directory+'/legacy.json';
  const state:any={labels:{sol:{row:'Latest',level:0,url:url('retained')}},session_workers:{[identity]:{label:'sol',scope,url:url('session')}},wake_state:{wakes:[],failed:{},cooldown_until:0,archives:[url('queued')]}};
  writePrivate(directory,'config.json',state);
  const bad=['http://chatgpt.com/c/no','https://chatgpt.com.evil/c/no','https://chatgpt.com/c/no?x=1','https://chatgpt.com/c/no/','https://chatgpt.com/c/a_b','https://chatgpt.com/c/'+'a'.repeat(129),'https://chatgpt.com/c/%61','https://chatgpt.com:443/c/no',' https://chatgpt.com/c/no'];
  const legacy={chats:Object.fromEntries([url('retained'),url('session'),url('queued'),url('new'),...bad].map((u,i)=>['label'+i,{url:u}])),_archive_pending:['pending','new','bad_id','/path',null]};
  fs.writeFileSync(source,JSON.stringify(legacy));const original=fs.readFileSync(source,'utf8');const logs:string[]=[];
  await main(['import-legacy-chats','--from',source,'--state-dir',directory],{CROSSFEED_API_KEY:key},{fetch:async()=>{throw Error('offline');},log:m=>logs.push(m)});
  assert.deepEqual(JSON.parse(logs.join('')),{imported:2,skipped_retained:2,skipped_queued:2,invalid:12});
  assert.equal(fs.readFileSync(source,'utf8'),original);
  const config=loadConfig(directory);assert.deepEqual(config.wake_state!.started_chats,[url('new'),url('pending')]);
  for(const u of [url('new'),url('pending')]) {assert.ok(config.wake_state!.archives.includes(u));assert.equal(typeof config.wake_state!.chat_started_at![u],'number');}
  const w=new Wakes(config);const queued=w.archiveNext().archive!;w.archiveResult({nonce:queued.nonce,ok:false,unproven:true});
  assert.equal(w.archiveNext().archive!.verify,undefined,'imported ownership skips first-message verification');
});

test('round2: offline legacy import refuses a held server.lock and writes nothing',async t=>{
  const directory=temporary(t);writePrivate(directory,'config.json',{labels:{}});const unlock=lease(directory);t.after(unlock);
  const source=directory+'/legacy.json';fs.writeFileSync(source,JSON.stringify({_archive_pending:['old']}));const before=fs.readFileSync(directory+'/config.json','utf8');
  await assert.rejects(main(['import-legacy-chats','--from',source,'--state-dir',directory],{CROSSFEED_API_KEY:key},{fetch:async()=>{throw Error('offline');},log:()=>{}}),/locked/);
  assert.equal(fs.readFileSync(directory+'/config.json','utf8'),before);
});

async function appFixture(t:any, extra: Record<string, any> = {}) {
  const directory=temporary(t),fake=fakeHTTP();
  const app=await createApp({directory,apiKey:key,apiPort:0,mcpPort:0,serverFactory:fake.factory,gateway:{pollMs:1},config:{public_url:'https://crossfeed.example.test'},...extra});t.after(()=>app.close());
  const call=async(route:string,input?:any,secret=key,remote=false)=>{
    const response=await fake.fetcher((remote?app.mcpUrl.slice(0,-4):app.apiUrl)+route,{method:input===undefined?'GET':'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},...(input===undefined?{}:{body:JSON.stringify(input)})});
    return {status:response.status,data:await response.json()};
  };
  const extensionSecret='e'.repeat(43),origin='chrome-extension://'+'a'.repeat(32);const paired=app.pairing.create(origin,extensionSecret);app.pairing.approve(paired.id);
  const extensionFetch:any=(address:string,init:any)=>fake.fetcher(address,{...init,headers:{...init.headers,Origin:origin}});
  return {app,call,fake,directory,extensionSecret,extensionFetch};
}

test('round2: running legacy import uses authenticated admin endpoint and its owning process',async t=>{
  const f=await appFixture(t);const source=f.directory+'/legacy.json';fs.writeFileSync(source,JSON.stringify({chats:{old:{url:url('legacy')}}}));
  assert.equal((await f.call('/chats/import-legacy',{urls:[url('legacy')],invalid:0},'bad')).status,401);
  assert.equal((await f.call('/chats/import-legacy',{urls:[url('legacy')],invalid:0},key,true)).status,404);
  const logs:string[]=[];await main(['import-legacy-chats','--from',source,'--state-dir',f.directory,'--api-port',new URL(f.app.apiUrl).port],{CROSSFEED_API_KEY:key},{fetch:f.fake.fetcher,log:m=>logs.push(m)});
  assert.deepEqual(JSON.parse(logs.join('')),{imported:1,skipped_retained:0,skipped_queued:0,invalid:0});
  assert.deepEqual(f.app.config.wake_state!.archives,[url('legacy')]);assert.equal(f.app.wakes.archiveNext().archive!.verify,undefined);
  assert.equal((await f.call('/chats/import-legacy',{urls:[url('legacy')+'?bad'],invalid:0})).status,400);
});

test('round2: inventory reaches both true listing ends, classifies proof, and keeps titles only in memory',async t=>{
  const f=await appFixture(t);const old=floor-86400000;const now=floor+30*86400000;
  f.app.config.labels={sol:{row:'Latest',level:0,url:url('held')}};
  f.app.wakes.track(f.app.config.wake_state!,url('tracked-old'));
  const lists=[
    Array.from({length:105},(_,i)=>({id:'old-v'+i,create_time:(old-i*1000)/1000,title:'old owner '+i})).concat([{id:'held',create_time:(floor+5000)/1000,title:'Crossfeed held'},{id:'ordinary',create_time:(floor+6000)/1000,title:'Recent owner '+'x'.repeat(100)},{id:'unknown',create_time:(now-1000)/1000,title:'Too new'},{id:'tracked-old',create_time:(old-1000000)/1000,title:'tracked'}]),
    [{id:'old-a',create_time:(old-2000000)/1000,title:'Oldest owner'},...Array.from({length:104},(_,i)=>({id:'a'+i,create_time:(floor+10000+i*1000)/1000+0.000456,title:'Archived owner '+i+(i===103?' '+ '🛩'.repeat(100):'')}))]
  ];
  const state:any={},details:string[]=[],patches:string[]=[],pages:string[]=[];
  t.mock.method(globalThis,'fetch',async(address:any,init:any={})=>{
    const u=new URL(address);
    if(u.pathname.endsWith('/api/auth/session'))return {ok:true,json:async()=>({accessToken:'fake'})} as any;
    if(u.pathname.endsWith('/conversations')) {const side=u.searchParams.get('is_archived')==='true'?1:0,offset=Number(u.searchParams.get('offset'));pages.push(side+':'+offset);return {ok:true,json:async()=>({items:lists[side].slice(offset,offset+100)})} as any;}
    const id=u.pathname.split('/').at(-1)!;
    if(init.method==='PATCH'){patches.push(id);for(const list of lists){const i=list.findIndex(x=>x.id===id);if(i>=0)list.splice(i,1);}return {ok:true} as any;}
    details.push(id);return {ok:true,json:async()=>({mapping:{one:{message:{author:{role:'user'},content:{parts:[id==='a0'?'@Crossfeed wake up as sol':'Personal message never stored']}}}}})} as any;
  });
  const browser:any={storage:{local:{get:async()=>structuredClone(state),set:async(v:any)=>Object.assign(state,structuredClone(v))}}};
  const api={apiURL:f.app.apiUrl,key:f.extensionSecret};
  for(let i=0;i<30&&!state.crossfeedSweep?.pass_complete;i++){const n=details.length;await sweepWakeChats(api,browser,f.extensionFetch,()=>now);assert.ok(details.length-n<=30);}
  assert.equal(state.crossfeedSweep.pass_complete,true);assert.ok(pages.includes('0:100'));assert.ok(pages.some(p=>p.startsWith('1:')&&p!=='1:0'));
  assert.ok(details.includes('a103'),'archived walk continues after old entries');assert.ok(!details.some(id=>id.startsWith('old-')||id==='tracked-old'||id==='held'||id==='unknown'));
  assert.deepEqual(patches,['a0']);
  const inventory=await f.call('/chats/inventory');assert.equal(inventory.status,200);const c=inventory.data.counters;
  assert.equal(c.pass_owner_visible,106);assert.equal(c.pass_owner_archived,104);assert.equal(c.pass_crossfeed_visible,2);assert.equal(c.pass_crossfeed_archived,1);assert.equal(c.pass_unclassified_visible,1);assert.equal(c.pass_unclassified_archived,0);
  assert.equal(c.pass_owner_min_create_time,old-2000000);assert.equal(c.pass_owner_max_create_time,floor+113000);
  assert.equal(inventory.data.owner_samples.length,5);assert.equal(inventory.data.owner_samples[0].title,'Archived owner 103 '+'🛩'.repeat(61));
  for(const sample of inventory.data.owner_samples)assert.ok(Array.from(sample.title).length<=80);
  assert.equal((await f.call('/chats/inventory',undefined,'bad')).status,401);assert.equal((await f.call('/chats/inventory',undefined,key,true)).status,404);
  const status=await f.call('/status');assert.deepEqual(status.data.chat_disposal.last_sweep,c);
  for(const v of Object.values(c))assert.ok(['number','boolean'].includes(typeof v));
  const persisted=JSON.stringify(state)+fs.readFileSync(f.directory+'/config.json','utf8');
  assert.ok(!persisted.includes('Archived owner'));assert.ok(!persisted.includes('Recent owner'));assert.ok(!persisted.includes('Personal message never stored'));assert.ok(!JSON.stringify(status.data).includes('Archived owner'));
  const restarted=new Wakes(loadConfig(f.directory));assert.deepEqual((restarted as any).inventory().owner_samples,[]);
});

test('round2: releasing a warm session revokes its poller before another job can use it',async t=>{
  const f=await appFixture(t);await f.call('/workers/add',{label:'sol',row:'Latest',level:0});
  const session='release-warm';
  const response=f.fake.fetcher(f.app.apiUrl+'/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json','X-Crossfeed-Session':session},body:JSON.stringify({model:'chatgpt:sol',messages:[{role:'user',content:'scoped'}]})});
  while(![...f.app.gateway.jobs.values()].some(j=>j.scope))await new Promise(r=>setImmediate(r));
  const job=[...f.app.gateway.jobs.values()].find(j=>j.scope)!;
  const ticket=f.app.wakes.next().ticket!;f.app.wakes.claim(ticket.nonce);
  const args={worker_label:ticket.label,wake_nonce:ticket.nonce,maximum_wait_seconds:1};
  const work=await f.app.gateway.exchange('connector',args,undefined,'warm-conversation');assert.ok(work.state==='request');
  f.app.wakes.result({nonce:ticket.nonce,ok:true,url:url('released-session')});
  await f.app.gateway.exchange('connector',{...args,request_id:job.id,claim_token:job.claim,response:'done'},undefined,'warm-conversation');
  assert.equal((await response).status,200);
  assert.deepEqual((await f.call('/v1/sessions/release',{session})).data,{released:1,queued:1});
  assert.equal(f.app.gateway.workers.get(ticket.label)!.revoked,true);
  assert.equal((await f.app.gateway.exchange('connector',args,undefined,'warm-conversation')).state,'released');
});

for(const outcome of ['success','failure','cancel','timeout']) test('round2: scoped '+outcome+' job retains its confirmed chat',async t=>{
  let now=floor+30*86400000;
  const f=await appFixture(t,{now:()=>now,gateway:{pollMs:1,timeoutMs:1000,leaseMs:1000}});
  await f.call('/workers/add',{label:'sol',row:'Latest',level:0});
  const pending=f.app.gateway.submit({model:'chatgpt:sol',messages:[{role:'user',content:'work'}]},undefined,undefined,{caller:scope,scope});
  const ticket=f.app.wakes.next().ticket!;f.app.wakes.claim(ticket.nonce);
  const args={worker_label:ticket.label,wake_nonce:ticket.nonce,maximum_wait_seconds:1};
  const work=await f.app.gateway.exchange('connector',args,undefined,'scoped-outcome');assert.ok(work.state==='request');
  f.app.wakes.chat({nonce:ticket.nonce,url:url('scoped-'+outcome)});
  f.app.wakes.result({nonce:ticket.nonce,ok:true,url:url('scoped-'+outcome)});
  const assertion=outcome==='success'?pending:assert.rejects(pending);
  if(outcome==='success'||outcome==='failure')await f.app.gateway.exchange('connector',{...args,request_id:work.request.request_id,claim_token:work.request.claim_token,...(outcome==='success'?{response:'ok'}:{error:'failed'})},undefined,'scoped-outcome');
  else if(outcome==='cancel')f.app.gateway.cancel({id:work.request.request_id});
  else {now+=1001;f.app.gateway.prune();}
  await assertion;
  assert.equal(f.app.config.session_workers![identity].url,url('scoped-'+outcome));
  assert.deepEqual(f.app.config.wake_state!.archives,[]);
  if(outcome==='success') {
    now+=120001;assert.equal(f.app.gateway.workerAwake(f.app.gateway.workers.get(identity)),false);
    assert.equal(f.app.wakes.reconcile(true).retired,1,'actual worker lease/contact expiry retires the scoped chat');
    assert.equal(f.app.wakes.archiveNext().archive!.url,url('scoped-success'));
    assert.equal(f.app.gateway.workers.get(identity)!.revoked,true,'a retired scoped worker cannot revive its deleted chat');
    assert.equal((await f.app.gateway.exchange('connector',args,undefined,'scoped-outcome')).state,'released');
  }
});

test('round2: legacy import rejects final line terminators instead of normalizing ownership',async t=>{
  const directory=temporary(t),source=directory+'/legacy.json';
  fs.writeFileSync(source,JSON.stringify({chats:{lf:{url:url('lf')+'\n'},cr:{url:url('cr')+'\r'},crlf:{url:url('crlf')+'\r\n'}},_archive_pending:['pending\n','pending\r','pending\r\n']}));
  const logs:string[]=[];await main(['import-legacy-chats','--from',source,'--state-dir',directory],{CROSSFEED_API_KEY:key},{fetch:async()=>{throw Error('offline');},log:m=>logs.push(m)});
  assert.deepEqual(JSON.parse(logs.join('')),{imported:0,skipped_retained:0,skipped_queued:0,invalid:6});
  assert.equal(fs.existsSync(directory+'/config.json'),false,'invalid ownership never writes a config');
});

for(const outcome of ['failed','cancelled'])test('round2: a '+outcome+' scoped wake queues only its own new chat',t=>{
  const f=worker(t);f.w.enqueue(identity);const ticket=f.w.next().ticket!;f.w.claim(ticket.nonce);
  f.w.chat({nonce:ticket.nonce,url:url('abandoned-'+outcome)});
  if(outcome==='failed')f.w.result({nonce:ticket.nonce,ok:false});else f.w.finishJob(identity,undefined,true);
  assert.equal(f.config.session_workers[identity].url,url('warm'));
  assert.deepEqual(f.config.wake_state.archives,[url('abandoned-'+outcome)]);
  assert.equal(f.w.archiveNext().archive!.verify,undefined);
});

test('round2: legacy imports are idempotent and capacity refusal leaves the whole state unchanged',()=>{
  const config:any={labels:{}};let writes=0;const w=new Wakes(config,()=>12345,{save:()=>{writes++;}});
  assert.equal(w.importLegacy({urls:[url('once')]}).imported,1);
  assert.equal(w.importLegacy({urls:[url('once')]}).skipped_queued,1);assert.equal(writes,1);
  config.wake_state.archives=Array.from({length:255},(_,i)=>url('queued-'+i));
  const before=structuredClone(config);assert.throws(()=>w.importLegacy({urls:[url('fits'),url('overflow')]}),/queue is full/);
  assert.deepEqual(config,before);assert.equal(writes,1);
});
