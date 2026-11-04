import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tempPrefix} from './temp.ts';
import {fakeHTTP} from './fake-http.ts';
import {Wakes} from '../src/wake.ts';
import {Gateway} from '../src/gateway.ts';
import {loadConfig} from '../src/config.ts';
import {createApp} from '../src/server.ts';
import {readPrivate, writePrivate} from '../src/security.ts';
import {makePoller, sweepWakeChats} from '../extension/core.ts';

const url = (id: string) => 'https://chatgpt.com/c/'+id;
const floor = Date.parse('2026-09-15T00:00:00Z');
function temporary(t: any) {const d=fs.mkdtempSync(tempPrefix('notrace-r3-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;}

async function paired(t: any) {
  const fake=fakeHTTP(), key='k'.repeat(43), secret='e'.repeat(43), origin='chrome-extension://'+'a'.repeat(32);
  const app=await createApp({directory:temporary(t),apiKey:key,apiPort:0,mcpPort:0,serverFactory:fake.factory,config:{public_url:'https://crossfeed.example.test'}});
  t.after(()=>app.close());
  const pairing=app.pairing.create(origin,secret);app.pairing.approve(pairing.id);
  const fetcher:any=(address:string,init:any={})=>fake.fetcher(address,{...init,headers:{...init.headers,Origin:origin}});
  const poll=async(body?:any)=>{
    const response=await fetcher(app.apiUrl+'/extension/archive/next',{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    assert.equal(response.status,200);return (await response.json()).archive;
  };
  return {app,poll,fetcher,secret,pairing};
}

test('round3: old pollers cannot lease unproven chats but can still delete proven chats',async t=>{
  const f=await paired(t),state=f.app.config.wake_state!;
  state.archives=[url('personal'),url('proven')];state.started_chats=[url('proven')];
  // 57fafc1 used an empty POST and ignored unknown lease fields before deleting.
  const lease=await f.poll({});assert.equal(lease.url,url('proven'));
  assert.equal(lease.remove,true);assert.equal(lease.verify,undefined);
  f.app.wakes.archiveResult({nonce:lease.nonce,ok:true});
  assert.equal(await f.poll({}),null);assert.equal(await f.poll(),null);
  const verified=await f.poll({verify:1});assert.equal(verified.url,url('personal'));assert.equal(verified.verify,true);
  f.app.wakes.archiveResult({nonce:verified.nonce,ok:false,unproven:true});
  assert.deepEqual(f.app.config.wake_state!.archives,[]);
});

test('round3: new extension declares verification before receiving an unproven lease',async t=>{
  const f=await paired(t);f.app.config.wake_state!.archives=[url('personal')];
  const requests:any[]=[],patches:any[]=[];
  t.mock.method(globalThis,'fetch',async(address:any,init:any={})=>{
    if(String(address).endsWith('/api/auth/session'))return {ok:true,json:async()=>({accessToken:'fake'})} as any;
    if(init.method==='PATCH'){patches.push(JSON.parse(init.body));return {ok:true} as any;}
    return {ok:true,json:async()=>({mapping:{one:{message:{author:{role:'user'},content:{parts:['My personal chat']}}}}})} as any;
  });
  const config={apiURL:f.app.apiUrl,key:f.secret,pairingVersion:1,pairing:{id:f.pairing.id,state:'approved',apiURL:f.app.apiUrl,checked_at:Date.now()}};
  const browser:any={storage:{local:{get:async()=>config,set:async()=>{}}}};
  const fetcher:any=async(address:string,init:any)=>{requests.push({path:new URL(address).pathname,body:JSON.parse(init.body)});return f.fetcher(address,init);};
  await makePoller(browser,fetcher)();
  assert.deepEqual(requests.find(r=>r.path==='/extension/archive/next')?.body,{verify:1});
  assert.deepEqual(f.app.config.wake_state!.archives,[]);assert.deepEqual(patches,[]);
  assert.equal(f.app.config.wake_state!.unproven_dropped,1);
});

for(const replica of [false,true])test('round3: full deletion queue retains a finished '+(replica?'replica':'primary')+' URL for reconciliation',()=>{
  let now=1000;
  const saved:any={row:'Latest',level:0,...(replica?{replica_urls:{'2':url('finished')}}:{url:url('finished')})};
  const config:any={labels:{sol:saved},wake_state:{wakes:[],failed:{},cooldown_until:0,archives:Array.from({length:256},(_,i)=>url('queued-'+i))}};
  const w=new Wakes(config,()=>now,{alive:()=>false});w.finishJob(replica?'sol~replica-2':'sol');
  assert.equal(replica?config.labels.sol.replica_urls?.['2']:config.labels.sol.url,url('finished'));
  assert.equal(config.wake_state.archives.length,256);
  config.wake_state.archives.shift();w.reconcile(true);now+=120001;
  assert.equal(w.reconcile(true).retired,1);
  assert.ok(config.wake_state.archives.includes(url('finished')));
  assert.equal(replica?config.labels.sol.replica_urls?.['2']:config.labels.sol.url,undefined);
});

test('round3: 257 legacy URLs import durable batches and defer only the remainder',t=>{
  const directory=temporary(t),config:any={labels:{}};
  let w=new Wakes(config,()=>1000,{save:c=>writePrivate(directory,'config.json',c)});
  const urls=Array.from({length:257},(_,i)=>url('legacy-'+i));
  const first=w.importLegacy({urls});
  assert.equal(first.imported,256);assert.equal((first as any).deferred,1);
  const persisted=readPrivate<any>(directory,'config.json',null);
  assert.deepEqual(persisted.wake_state.archives,urls.slice(0,256));
  assert.deepEqual(persisted.wake_state.started_chats,urls.slice(0,256));
  for(let i=0;i<256;i++){const lease=w.archiveNext().archive!;assert.equal(lease.verify,undefined);w.archiveResult({nonce:lease.nonce,ok:true});}
  w=new Wakes(loadConfig(directory),()=>1000,{save:c=>writePrivate(directory,'config.json',c)});
  const second=w.importLegacy({urls});assert.equal(second.imported,1);assert.equal((second as any).deferred,0);
  assert.equal(second.skipped_imported,256);
  assert.deepEqual(w.config.wake_state!.archives,[urls[256]]);assert.equal(w.archiveNext().archive!.verify,undefined);
});

test('round3: pruning cannot resurrect expired payloads when an earlier job finishes in the same pass',async t=>{
  const directory=temporary(t);let now=1000;
  const g=new Gateway({prefix:'chatgpt',labels:{sol:{row:'Latest',level:0}}},{now:()=>now,timeoutMs:2000000,save:s=>writePrivate(directory,'jobs.json',s)});t.after(()=>g.close());
  const submit=(text:string)=>g.submit({model:'chatgpt:sol',messages:[{role:'user',content:text}]},text.replaceAll(' ','-'));
  const active=submit('active');const activeJob=[...g.jobs.values()][0];
  const expired=submit('expired private prompt');const expiredJob=[...g.jobs.values()][1];
  g.finish(expiredJob,null,{role:'assistant',content:'expired private answer'});await expired;
  now=expiredJob.expires+1;activeJob.claimBy=now;
  g.prune();await assert.rejects(active);
  assert.equal(g.jobs.has(expiredJob.id),false);
  const persisted=readPrivate<any>(directory,'jobs.json',null);
  assert.deepEqual(persisted.jobs.map((j:any)=>j.id),[activeJob.id]);
  assert.ok(!JSON.stringify(persisted).includes('expired private'));
});

for(const archived of [false,true])test('round3: resumed '+(archived?'archived':'visible')+' sweep overlaps rows shifted by queue deletion',async t=>{
  const state:any={},details:string[]=[],patches:string[]=[],offsets:number[]=[];
  const rows=Array.from({length:110},(_,i)=>({id:'row-'+i,create_time:(floor+i*1000)/1000,title:'Owner '+i}));
  const fetcher:any=async(address:string,init:any)=>{
    const body=JSON.parse(init.body);return {ok:true,text:async()=>JSON.stringify(address.endsWith('/inventory/check')?{crossfeed:[]}:address.endsWith('/sweep')?{dispose:body.candidates.map((c:any)=>c.id)}:{ok:true})};
  };
  t.mock.method(globalThis,'fetch',async(address:any,init:any={})=>{
    const u=new URL(address);
    if(u.pathname.endsWith('/api/auth/session'))return {ok:true,json:async()=>({accessToken:'fake'})} as any;
    if(u.pathname.endsWith('/conversations')) {
      const sameSide=(u.searchParams.get('is_archived')==='true')===archived,offset=Number(u.searchParams.get('offset'));
      if(sameSide)offsets.push(offset);
      return {ok:true,json:async()=>({items:sameSide?rows.slice(offset,offset+100):[]})} as any;
    }
    const id=u.pathname.split('/').at(-1)!;
    if(init.method==='PATCH'){patches.push(id);rows.splice(rows.findIndex(r=>r.id===id),1);return {ok:true} as any;}
    details.push(id);return {ok:true,json:async()=>({mapping:{one:{message:{author:{role:'user'},content:{parts:[id==='row-100'?'@Crossfeed wake up as sol':'Personal chat']}}}}})} as any;
  });
  const browser:any={storage:{local:{get:async()=>structuredClone(state),set:async(v:any)=>Object.assign(state,structuredClone(v))}}};
  const run=()=>sweepWakeChats({apiURL:'http://127.0.0.1:4319',key:'fake'},browser,fetcher,()=>floor+30*86400000);
  await run();assert.equal(details.length,30);assert.equal(state.crossfeedSweep.pass_complete,false);
  rows.splice(0,1); // Queue deletes a previously inspected row outside the sweep.
  for(let i=0;i<15&&!state.crossfeedSweep.pass_complete;i++)await run();
  assert.equal(state.crossfeedSweep.pass_complete,true);
  assert.ok(details.includes('row-100'),'wake shifted from index 100 to 99 must be inspected before completion');
  assert.deepEqual(patches,['row-100']);
  assert.equal(new Set(details).size,110);assert.equal(details.length,110,'overlap must not refetch inspected owners');
  assert.equal(state.crossfeedSweep[archived?'pass_owner_archived':'pass_owner_visible'],109,'overlap must not double-count owners');
  assert.ok(offsets.filter(o=>o===0).length>=2);
});

test('round3: a cancelled scoped wake stays tracked when the queue is full',()=>{
  let now=1000;
  const scope='a'.repeat(22),identity='sol~session-'+scope;
  const config:any={connector:'Crossfeed',labels:{sol:{row:'Latest',level:0}},session_workers:{[identity]:{label:'sol',scope}}};
  const w=new Wakes(config,()=>now,{alive:()=>false});
  w.enqueue(identity);const ticket=w.next().ticket!;w.claim(ticket.nonce);w.chat({nonce:ticket.nonce,url:url('cancelled')});
  config.wake_state.archives=Array.from({length:256},(_,i)=>url('queued-'+i));
  w.finishJob(identity,undefined,true);
  assert.equal(w.tickets.get(ticket.nonce)!.state,'expired');
  assert.ok(config.wake_state.started_chats.includes(url('cancelled')));
  assert.equal(config.wake_state.archives.length,256);
  config.wake_state.archives.shift();now+=600001;w.prune();
  assert.equal(w.reconcile(true).orphans,1);assert.ok(config.wake_state.archives.includes(url('cancelled')));
});

test('round3: failed pruning writes preserve expired jobs for a successful retry',async t=>{
  let now=1000,fail=false;let saved:any;
  const g=new Gateway({prefix:'chatgpt',labels:{sol:{row:'Latest',level:0}}},{now:()=>now,save:s=>{if(fail)throw Error('injected prune write failure');saved=structuredClone(s);}});t.after(()=>g.close());
  const pending=g.submit({model:'chatgpt:sol',messages:[{role:'user',content:'private'}]},'retry');
  const job=[...g.jobs.values()][0];g.cancel({id:job.id});await assert.rejects(pending);
  now=job.expires+1;fail=true;
  assert.throws(()=>g.prune(),/injected prune write failure/);
  assert.equal(g.jobs.has(job.id),true);assert.equal(saved.jobs[0].id,job.id);
  fail=false;g.prune();assert.equal(g.jobs.size,0);assert.equal(g.idempotency.size,0);assert.deepEqual(saved.jobs,[]);
});

test('round3: entirely full legacy import defers without writing or losing existing proof',()=>{
  const queued=Array.from({length:256},(_,i)=>url('queued-'+i));
  const config:any={labels:{},wake_state:{wakes:[],failed:{},cooldown_until:0,archives:queued,started_chats:[queued[0]]}};
  let writes=0;const w=new Wakes(config,()=>1000,{save:()=>{writes++;}}),before=structuredClone(config);
  assert.deepEqual(w.importLegacy({urls:[url('later'),queued[0]]}),{imported:0,skipped_retained:0,skipped_queued:1,skipped_imported:0,deferred:1,invalid:0});
  assert.equal(writes,0);assert.deepEqual(config,before);
  config.wake_state.archives.pop();
  assert.equal(w.importLegacy({urls:[url('later'),queued[0]]}).imported,1);
  assert.ok(config.wake_state.started_chats.includes(url('later')));assert.equal(writes,1);
});
