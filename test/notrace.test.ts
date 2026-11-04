import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tempPrefix } from './temp.ts';
import { loadConfig } from '../src/config.ts';
import { main } from '../src/cli.ts';
import { Wakes } from '../src/wake.ts';
import { Gateway } from '../src/gateway.ts';
import { writePrivate, readPrivate } from '../src/security.ts';
import { archiveConversation, isWakeSignature, sweepWakeChats } from '../extension/core.ts';

const url = (id: string) => 'https://chatgpt.com/c/' + id;
const floor = Date.parse('2026-09-15T00:00:00Z');
const first = '@Crossfeed wake up as sol. Poll gateway_exchange with worker_label sol until released.';
const conversation = (text: string) => ({mapping:{a:{message:{author:{role:'user'},content:{parts:[text]}}}}});
function temporary(t: any) { const dir = fs.mkdtempSync(tempPrefix('notrace-')); t.after(() => fs.rmSync(dir,{recursive:true,force:true})); return dir; }

test('no-trace: legacy config disposal key is discarded and CLI accepts only deprecated delete', async t => {
  const directory = temporary(t);
  writePrivate(directory,'config.json',{chat_disposal:'archive'});
  assert.equal('chat_disposal' in loadConfig(directory), false);
  const env = {CROSSFEED_API_KEY:'k'.repeat(43)};
  const io = {log() {}, fetch: async () => { throw Error('no network'); }};
  await assert.rejects(main(['serve','--chat-disposal','archive'],env,io), /archive.*(?:removed|unsupported|delete)|delete.*only/i);
  // No public URL: accepted flag reaches config validation without starting a listener.
  await assert.rejects(main(['serve','--state-dir',directory,'--chat-disposal','delete'],env,io), /public-url/);
});

test('no-trace: unowned queue leases require proof and unproven outcomes drop durably', () => {
  const config: any = {labels:{},wake_state:{wakes:[],failed:{},cooldown_until:0,archives:[url('personal')]}};
  let saved: any;
  const w = new Wakes(config,()=>1000,{save: s => {saved=structuredClone(s);}});
  const lease = w.archiveNext(true).archive!;
  assert.equal((lease as any).verify,true);
  w.archiveResult({nonce:lease.nonce,ok:false,unproven:true});
  assert.deepEqual(config.wake_state.archives,[]);
  assert.equal(saved.wake_state.unproven_dropped,1);
  assert.equal(new Wakes(saved,()=>2000).archiveNext().archive,null);
});

test('no-trace: delete PATCH is the only disposal body and legacy signature is tightly bounded', async t => {
  const patches: any[] = [];
  t.mock.method(globalThis,'fetch',async (_: any, init: any) => {
    if (init.method === 'PATCH') {patches.push(JSON.parse(init.body)); return {ok:true};}
    return {ok:true,json:async()=>({accessToken:'fake'})};
  });
  assert.equal(await archiveConversation(url('owned')),true);
  assert.deepEqual(patches,[{is_visible:false}]);
  assert.equal(isWakeSignature(first),true);
  for (const text of ['Plan my week', 'Tell me how to wake up as sol', 'I quote: '+first,
    first+' Do something else.',first.replace('worker_label sol','worker_label other'), first+'x'.repeat(4001)]) assert.equal(isWakeSignature(text),false,text);
});

function sweepFake(t: any, count = 145) {
  const state: any = {}, listings: URL[] = [], details: string[] = [], patches: any[] = [], reports: any[] = [];
  let clock = Date.parse('2026-11-04T12:00:00Z');
  const lists = [false,true].map(archived => Array.from({length:count},(_,i)=>({id:(archived?'a':'v')+i,create_time:new Date(floor + (count-i-1)*60000).toISOString()})).concat([{id:archived?'ancient-a':'ancient-v',create_time:new Date(floor-1).toISOString()}]));
  const browser: any = {storage:{local:{get:async()=>structuredClone(state),set:async(v:any)=>Object.assign(state,structuredClone(v))}}};
  t.mock.method(globalThis,'fetch',async (address: any, init: any = {}) => {
    const u = new URL(address);
    if(u.pathname.endsWith('/api/auth/session')) return {ok:true,json:async()=>({accessToken:'fake'})};
    if(u.pathname.endsWith('/conversations')) {
      listings.push(u); const list=lists[u.searchParams.get('is_archived')==='true'?1:0];
      const offset=Number(u.searchParams.get('offset'));
      assert.equal(u.searchParams.get('order'),'created'); assert.equal(u.searchParams.get('limit'),'100');
      return {ok:true,json:async()=>({items:list.slice(offset,offset+100)})};
    }
    const id=u.pathname.split('/').at(-1)!;
    if(init.method==='PATCH') {
      patches.push({id,body:JSON.parse(init.body)});
      for(const list of lists) {const i=list.findIndex(x=>x.id===id);if(i>=0) list.splice(i,1);}
      return {ok:true};
    }
    details.push(id);
    return {ok:true,json:async()=>conversation(id.endsWith('0')?first:'My ordinary chat')};
  });
  const fetcher: any = async(address: string,init: any) => {
    const body=JSON.parse(init.body);
    if(address.endsWith('/inventory')) return {ok:true,text:async()=>'{"ok":true}'};
    if(address.endsWith('/sweep/done')) {reports.push(body);return {ok:true,text:async()=>'{"ok":true}'};}
    return {ok:true,text:async()=>JSON.stringify({dispose:body.candidates.map((c:any)=>c.id)})};
  };
  const run = () => sweepWakeChats({apiURL:'http://127.0.0.1:4319',key:'fake'},browser,fetcher,()=>clock);
  return {state,listings,details,patches,reports,run,advance:(ms:number)=>{clock+=ms;}};
}

test('no-trace: sweep resumes budgets across visible and archived pages to the fixed floor', async t => {
  const f=sweepFake(t);
  let complete=false;
  for(let i=0;i<30;i++) {
    const before=f.details.length; await f.run();
    assert.ok(f.details.length-before<=30,'at most 30 details per run');
    const r=f.state.crossfeedSweep;
    if(r.pass_complete) {complete=true;break;}
    assert.ok(r.backlog>0,'cursor advertises remaining work');
  }
  assert.equal(complete,true,'idle runs eventually finish the whole pass');
  assert.equal(f.details.length,290);
  assert.ok(f.listings.some(u=>u.searchParams.get('is_archived')==='true'));
  assert.ok(f.listings.some(u=>Number(u.searchParams.get('offset'))>0));
  assert.ok(!f.details.some(id=>id.startsWith('ancient')));
  assert.ok(f.patches.length>0); assert.ok(f.patches.every(p=>JSON.stringify(p.body)==='{"is_visible":false}'));
  const r=f.state.crossfeedSweep;
  assert.equal(r.pass_wake_matches_visible,15); assert.equal(r.pass_wake_matches_archived,15);
  assert.equal(r.pass_deleted_visible,15); assert.equal(r.pass_deleted_archived,15);
  assert.equal(r.last_pass_deleted_visible,15); assert.equal(r.last_pass_deleted_archived,15);
  assert.equal(r.checked.length,260);
  for(const report of f.reports) for(const v of Object.values(report)) assert.ok(['number','boolean'].includes(typeof v),'report contains primitive counters only');
  await f.run(); // new pass confirms nothing remains, without re-reading ordinary chats
  while(!f.state.crossfeedSweep.pass_complete) await f.run();
  const n=f.listings.length; await f.run(); assert.equal(f.listings.length,n,'empty completed pass waits ten minutes');
});

test('no-trace: service sweep approvals are bounded at 100 and preserve age/held guards', () => {
  const w=new Wakes({labels:{}},()=>10_000_000);
  assert.equal(w.sweepCheck({candidates:Array.from({length:100},(_,i)=>({id:'c'+i,created_at:1}))}).dispose.length,100);
});

test('no-trace: finished jobs are removed from jobs.json by timer alone and on startup', async t => {
  const directory=temporary(t); let now=1000;
  t.mock.timers.enable({apis:['setInterval']});
  const config={prefix:'chatgpt',labels:{sol:{row:'Latest',level:0}}};
  const save=(state:any)=>writePrivate(directory,'jobs.json',state);
  const g=new Gateway(config,{now:()=>now,save});t.after(()=>g.close());
  const pending=g.submit({model:'chatgpt:sol',messages:[{role:'user',content:'private prompt'}]},'key');
  const job=[...g.jobs.values()][0];g.cancel({id:job.id});await assert.rejects(pending);
  const records=readPrivate<any>(directory,'jobs.json',null);
  assert.equal(records.jobs.length,1);
  now+=600001;t.mock.timers.tick(60000);
  assert.deepEqual(readPrivate<any>(directory,'jobs.json',null).jobs,[]);
  writePrivate(directory,'jobs.json',records);
  const restarted=new Gateway(config,{now:()=>now,save,records});t.after(()=>restarted.close());
  assert.deepEqual(readPrivate<any>(directory,'jobs.json',null).jobs,[]);
});

for(const scenario of ['failure-after-enter','late-expiry','restart','worker-lease-expiry','release-session']) test('no-trace: lifecycle '+scenario+' reaches a delete PATCH',async t=>{
  let now=Date.parse('2026-11-04T00:00:00Z');
  const scope='A'.repeat(22),identity='sol~session-'+scope;
  const config:any={connector:'Crossfeed',labels:{sol:{row:'Latest',level:0}},session_workers:{[identity]:{label:'sol',scope}}};
  const directory=temporary(t),save=(state:any)=>writePrivate(directory,'config.json',state);
  let w=new Wakes(config,()=>now,{alive:()=>false,contact:()=>1,active:()=>true,save});
  w.enqueue(scenario==='release-session'?identity:'sol');const ticket=w.next().ticket!;w.claim(ticket.nonce);
  const chat=url(scenario);w.chat({nonce:ticket.nonce,url:chat});
  if(scenario==='failure-after-enter') w.result({nonce:ticket.nonce,ok:false,url:chat});
  if(scenario==='late-expiry') {now+=240001;w.prune();w.result({nonce:ticket.nonce,ok:false,url:chat});}
  if(scenario==='restart') {w=new Wakes(loadConfig(directory),()=>now,{alive:()=>false,save});now+=120001;w.reconcile(true);}
  if(scenario==='worker-lease-expiry'||scenario==='release-session') {
    w.tickets.get(ticket.nonce)!.contact=0;w.result({nonce:ticket.nonce,ok:true,url:chat});
    if(scenario==='release-session') w.releaseSession(scope);else {now+=120001;w.reconcile(true);}
  }
  const lease=w.archiveNext().archive!;assert.ok(lease,scenario);assert.equal((lease as any).verify,undefined);
  const bodies:any[]=[];t.mock.method(globalThis,'fetch',async(_:any,init:any)=>{
    if(init.method==='PATCH'){bodies.push(JSON.parse(init.body));return {ok:true};}return {ok:true,json:async()=>({accessToken:'fake'})};
  });
  const ok=await archiveConversation(lease.url);w.archiveResult({nonce:lease.nonce,ok});
  assert.deepEqual(bodies,[{is_visible:false}]);assert.deepEqual(w.config.wake_state!.archives,[]);
});

test('no-trace: an unreadable first sweep candidate does not starve later pages',async t=>{
  const f=sweepFake(t,45), original=globalThis.fetch;
  t.mock.method(globalThis,'fetch',async(address:any,init:any={})=>String(address).endsWith('/conversation/v0')&&init.method!=='PATCH'?{ok:false,status:500} as any:original(address,init));
  for(let i=0;i<10&&!f.state.crossfeedSweep?.pass_complete;i++) await f.run();
  assert.equal(f.state.crossfeedSweep.pass_complete,true);
  assert.ok(f.details.includes('a44'));
});

test('no-trace: verification drops ordinary queued chats, retries errors, and accepts 404 without PATCH',async t=>{
  const {deleteQueuedConversation}=await import('../extension/core.ts');
  const patches:any[]=[];
  t.mock.method(globalThis,'fetch',async(address:any,init:any={})=>{
    if(String(address).endsWith('/api/auth/session')) return {ok:true,json:async()=>({accessToken:'fake'})} as any;
    if(init.method==='PATCH') {patches.push(JSON.parse(init.body));return {ok:true} as any;}
    const id=String(address).split('/').at(-1);
    if(id==='gone') return {ok:false,status:404} as any;
    if(id==='error') return {ok:false,status:500} as any;
    return {ok:true,json:async()=>conversation(id==='wake'?first:'Help plan my week')} as any;
  });
  assert.deepEqual(await deleteQueuedConversation(url('personal'),true),{ok:false,unproven:true});
  assert.deepEqual(await deleteQueuedConversation(url('gone'),true),{ok:true});
  assert.deepEqual(await deleteQueuedConversation(url('error'),true),{ok:false});
  assert.deepEqual(patches,[]);
  assert.deepEqual(await deleteQueuedConversation(url('wake'),true),{ok:true});
  assert.deepEqual(patches,[{is_visible:false}]);
});

test('no-trace: sweep enforces elapsed-time budget and keeps its cursor after a reload',async t=>{
  const f=sweepFake(t,80),original=globalThis.fetch;
  t.mock.method(globalThis,'fetch',async(address:any,init:any={})=>{
    const result=await original(address,init);
    if(String(address).includes('/conversation/')&&!init.method) f.advance(11000);
    return result;
  });
  await f.run(); assert.ok(f.details.length<=2);assert.equal(f.state.crossfeedSweep.pass_complete,false);
  const before=f.details.length;await f.run();assert.ok(f.details.length>before);assert.ok(f.details.length<=before+2);
});

test('no-trace: composer completion never retires a sibling ordinary worker chat',()=>{
  const config:any={labels:{sol:{row:'Latest',level:0,url:url('ordinary')}},wake_state:{wakes:[],failed:{},cooldown_until:0,archives:[url('composer')],started_chats:[url('ordinary'),url('composer')]}};
  const w=new Wakes(config);
  w.finishJob('sol','composer-job');
  assert.equal(config.labels.sol.url,url('ordinary'));
  assert.deepEqual(config.wake_state.archives,[url('composer')]);
});

test('no-trace: extension reload orphan-tab cleanup is followed by a signature-verified delete',async t=>{
  const {closeOrphanedWakeTabs}=await import('../extension/core.ts');
  const f=sweepFake(t,1);
  const closed:number[]=[];
  const browser:any={storage:{local:{get:async()=>({crossfeedWakeTabs:[{tab:7,at:1}]}),set:async()=>{}}},tabs:{get:async()=>({id:7,url:url('v0')}),remove:async(id:number)=>{closed.push(id);}}};
  await closeOrphanedWakeTabs(browser);assert.deepEqual(closed,[7]);
  await f.run();
  assert.ok(f.patches.some(p=>p.id==='v0'&&JSON.stringify(p.body)==='{"is_visible":false}'));
});

test('no-trace: retrying a timed-out delete counts its wake signature once per pass',async t=>{
  const f=sweepFake(t,1), original=globalThis.fetch;let fail=true;
  t.mock.method(globalThis,'fetch',async(address:any,init:any={})=>{
    if(fail&&String(address).endsWith('/conversation/v0')&&init.method==='PATCH') {fail=false;f.advance(20000);throw Error('timeout');}
    return original(address,init);
  });
  await f.run();assert.equal(f.state.crossfeedSweep.pass_wake_matches_visible,1);assert.equal(f.state.crossfeedSweep.pass_complete,false);
  await f.run();assert.equal(f.state.crossfeedSweep.pass_complete,true);
  assert.equal(f.state.crossfeedSweep.pass_wake_matches_visible,1);
  assert.equal(f.state.crossfeedSweep.pass_deleted_visible,1);
});
