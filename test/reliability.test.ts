import test from 'node:test';
import assert from 'node:assert/strict';
import {Gateway} from '../src/gateway.ts';
import {Wakes, wakeLimits} from '../src/wake.ts';
import type {Config} from '../src/types.ts';
const config = (): Config => ({prefix:'chatgpt',connector:'Crossfeed',labels:{alpha:{row:'Latest',level:2}},wake_daily_cap:0,wake_hourly_cap:12});
const request = (content:string) => ({model:'chatgpt:alpha',messages:[{role:'user',content}]});
const poll = (g:Gateway) => g.exchange('connector',{worker_label:'alpha',maximum_wait_seconds:20});

test('consecutive jobs reuse one warm worker and completion stays in the long poll',async t=>{
  let wakes=0,wakePending=false;const g=new Gateway(config(),{waitForWake:true,pollMs:50,wake:()=>{if(!wakePending){wakes++;wakePending=true;}}});t.after(()=>g.close());
  const first=g.submit(request('first'),'first');const a=await poll(g);assert.ok(a.state==='request');wakePending=false;
  const following=g.exchange('connector',{worker_label:'alpha',request_id:a.request!.request_id,claim_token:a.request!.claim_token,response:'one'});
  assert.equal(g.workers.get('alpha')!.polling,true);
  assert.equal((await first).choices[0].message.content,'one');
  const second=g.submit(request('second'),'second');const b=await following;
  assert.ok(b.state==='request');assert.notEqual(b.request!.request_id,a.request!.request_id);
  await g.exchange('connector',{worker_label:'alpha',request_id:b.request!.request_id,claim_token:b.request!.claim_token,response:'two'});
  assert.equal((await second).choices[0].message.content,'two');assert.equal(g.workers.size,1);assert.equal(wakes,1);
});

test('recent contact without a poller requests a wake immediately',async t=>{
  const seen:string[]=[];const g=new Gateway(config(),{waitForWake:true,pollMs:1,wake:name=>seen.push(name)});t.after(()=>g.close());
  await poll(g);const pending=g.submit(request('after idle'),'immediate');assert.deepEqual(seen,['alpha']);
  const a=await poll(g);assert.ok(a.state==='request');await g.exchange('connector',{worker_label:'alpha',request_id:a.request!.request_id,claim_token:a.request!.claim_token,response:'ok'});await pending;
});

test('failed automatic wake retries after one minute without losing the queued job',async t=>{
  let now=100000;const cfg=config();const g=new Gateway(cfg,{waitForWake:true,now:()=>now,pollMs:1});t.after(()=>g.close());
  const wakes=new Wakes(cfg,()=>now,{failed:name=>g.wakeFailed(name),needed:()=>g.queued('alpha').length>0});
  g.wake=name=>{if(!wakes.has(name,undefined,undefined))wakes.enqueue(name,null,true);};
  const answer=g.submit(request('retry'),'retry');const a=wakes.next().ticket!;wakes.claim(a.nonce);wakes.result({nonce:a.nonce,ok:false});
  const job=[...g.jobs.values()][0];assert.equal(job.state,'queued');assert.strictEqual(g.submit(request('retry'),'retry'),answer);
  g.prune();now+=59999;assert.equal(wakes.next().ticket,null);now++;assert.ok(wakes.next().ticket);assert.equal(wakeLimits(cfg,now).hourly_attempts,2);
  const b=await poll(g);assert.ok(b.state==='request');await g.exchange('connector',{worker_label:'alpha',request_id:b.request!.request_id,claim_token:b.request!.claim_token,response:'retained'});assert.equal((await answer).choices[0].message.content,'retained');
});

test('three short failed-wake retries precede longer cooldown and respect hourly admission',()=>{
  let now=100000;const cfg=config();const wakes=new Wakes(cfg,()=>now);
  wakes.enqueue('alpha',null,true);let issued=wakes.next().ticket!;
  for(let failure=1;failure<=4;failure++){
    assert.ok(issued);wakes.claim(issued.nonce);wakes.result({nonce:issued.nonce,ok:false});
    wakes.enqueue('alpha',null,true);now+=59999;assert.equal(wakes.next().ticket,null);now++;
    if(failure<4){issued=wakes.next().ticket!;assert.ok(issued);}
    else {assert.equal(wakes.next().ticket,null);now+=540000;assert.ok(wakes.next().ticket);}
  }
  assert.equal(wakeLimits(cfg,now).hourly_attempts,5);
});

test('zero and omitted daily caps are off while the rolling hourly cap remains twelve',()=>{
  const now=new Date(2026,9,5,12).getTime();
  for(const daily of [undefined,0]){
    const cfg=config();cfg.wake_daily_cap=daily;cfg.wake_state={wakes:Array(60).fill(now-7200000),failed:{},cooldown_until:0,archives:[]};
    const limits=wakeLimits(cfg,now);assert.equal(limits.daily_cap,0);assert.equal(limits.daily_cap_status,'off');assert.equal(limits.blocked,null);
    cfg.wake_state.wakes.push(...Array(12).fill(now-1));assert.match(wakeLimits(cfg,now).blocked!,/Hourly fresh-chat cap \(12\)/);
  }
});

test('idle workers long-poll until the worker lease releases them',async t=>{
  let now=1000;const g=new Gateway(config(),{now:()=>now,pollMs:100,leaseMs:15});t.after(()=>g.close());
  const pending=poll(g),worker=g.workers.get('alpha')!;assert.equal(worker.polling,true);assert.equal(worker.idleUntil,1015);
  now=worker.idleUntil!;const reply=await pending;assert.equal(reply.state,'released');assert.equal(reply.continue,false);assert.equal(worker.stale,true);
});

test('a fresh conversation renews an expired idle lease without reviving old polls',async t=>{
  let now=1000;const g=new Gateway(config(),{now:()=>now,leaseMs:50,pollMs:1});t.after(()=>g.close());
  const args={worker_label:'alpha'};
  await g.exchange('connector',args,undefined,'chat-one');now=1051;
  assert.equal((await g.exchange('connector',args,undefined,'chat-one')).state,'released');
  now=2051;assert.equal((await g.exchange('connector',args,undefined,'chat-two')).state,'idle');
  assert.equal(g.workers.get('alpha')!.idleUntil,2101);now=2102;
  assert.equal((await g.exchange('connector',args,undefined,'chat-two')).state,'released');
});

test('invalid success URLs cannot reset consecutive wake failures',()=>{
  let now=100000;const cfg=config();cfg.labels.alpha.url='https://chatgpt.com/c/retained';
  const wakes=new Wakes(cfg,()=>now,{registeredContact:()=>true});
  for(let n=1;n<=4;n++){
    wakes.enqueue('alpha');const ticket=wakes.next().ticket!;wakes.claim(ticket.nonce);wakes.result({nonce:ticket.nonce,ok:false});now+=n<4?60000:600000;
  }
  wakes.enqueue('alpha');const ticket=wakes.next().ticket!;wakes.claim(ticket.nonce);
  assert.throws(()=>wakes.result({nonce:ticket.nonce,ok:true,url:cfg.labels.alpha.url}));
  assert.equal(cfg.wake_state!.failed_attempts!.alpha,4);
  wakes.result({nonce:ticket.nonce,ok:false});assert.equal(cfg.wake_state!.failed_attempts!.alpha,5);
  now+=60000;wakes.enqueue('alpha',null,true);assert.equal(wakes.next().ticket,null);
  now+=540000;const valid=wakes.next().ticket!;wakes.claim(valid.nonce);wakes.result({nonce:valid.nonce,ok:true,url:'https://chatgpt.com/c/fresh'});
  assert.equal(cfg.wake_state!.failed_attempts!.alpha,undefined);
});
