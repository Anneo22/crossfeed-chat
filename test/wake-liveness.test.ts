import test from 'node:test';
import assert from 'node:assert/strict';
import { Gateway } from '../src/gateway.ts';

const config = () => ({prefix:'chatgpt',labels:{alpha:{row:'Latest',level:0}}});
const request = (message='cold request') => ({model:'chatgpt:alpha',messages:[{role:'user',content:message}]});
const scope = (letter:string) => letter.repeat(22);
const faulty = (code:string) => (error:any) => error.status === 503 && error.code === code;
const jobFor = (g:Gateway, caller:string) => g.queued('alpha',caller)[0];

test('authenticated heartbeat without a ticket cannot renew a cold queued scoped request forever', async t => {
  let now=10000;
  const g=new Gateway(config(),{now:()=>now,waitForWake:true,startupMs:5000,extensionGraceMs:1000,
    extensionLastActivity:()=>now,pollMs:2});
  t.after(()=>g.close());
  const caller=scope('a'), result=g.submit(request(),undefined,undefined,{caller,scope:caller});
  const job=jobFor(g,caller);
  assert.equal(job?.wake_needed,true);
  for(const tick of [10500,12500,14999]) {
    now=tick; g.prune();
    assert.equal(job.finished,undefined,'authenticated polls must not expire work early');
    assert.equal(g.extensionStalled(job),false);
  }
  now=15000;g.prune();
  await assert.rejects(result,faulty('wake_stalled'));
  assert.equal(job.state,'failed');
  assert.equal(g.capacity().claimed,0);
  const poll=await g.exchange('connector',{worker_label:'alpha~session-'+caller,wake_nonce:'n'.repeat(32),
    maximum_wait_seconds:1},AbortSignal.abort(),'late-chat');
  assert.notEqual(poll.state,'request','terminal queued work cannot be claimed after the budget');
});

test('a continuously replaced global wake ticket cannot extend another scope\'s startup budget', async t => {
  let now=1000;
  const g=new Gateway(config(),{now:()=>now,waitForWake:true,startupMs:2000,extensionGraceMs:1000,
    extensionLastActivity:()=>now,extensionTicketUntil:()=>now+240000});
  t.after(()=>g.close());
  const caller=scope('b'), result=g.submit(request(),undefined,undefined,{caller,scope:caller});
  now=2999;g.prune();
  assert.equal(jobFor(g,caller)?.state,'queued');
  now=3000;g.prune();
  await assert.rejects(result,faulty('wake_stalled'));
  assert.equal(g.capacity().claimed,0);
});

test('ten different scoped 240-second serial wakes successfully claim across >15 minutes under the 45-minute admission bound', async t => {
  const base=100000;
  let now=base;
  const g=new Gateway({...config(),max_claimed_jobs:1},{now:()=>now,waitForWake:true,
    extensionGraceMs:1000,extensionLastActivity:()=>now,extensionTicketUntil:()=>now+240000,
    authorizeWorker:()=>{}});
  t.after(()=>g.close());
  assert.equal(g.startupMs,2700000);
  const callers='abcdefghij'.split('').map(scope);
  const promises=callers.map((caller,i)=>{
    now=base+i*1000; // Ten independent admission/enqueue timestamps.
    return g.submit(request('serial-'+i),undefined,undefined,{caller,scope:caller});
  });
  for(let i=0;i<callers.length;i++) {
    // Global navigation consumes 240s, followed by 30s poll quantization.
    // Each wake is actually claimed and completed before the next begins.
    now=base+240000+i*270000;
    g.prune();
    assert.equal(g.capacity().claimed,0);
    assert.equal(jobFor(g,callers[i])?.state,'queued');
    const identity='alpha~session-'+callers[i];
    const nonce=String(i).repeat(32);
    const claimed=await g.exchange('connector',{worker_label:identity,wake_nonce:nonce,maximum_wait_seconds:1},undefined,'serial-chat-'+i);
    assert.equal(claimed.state,'request','scope '+i+' must genuinely receive its request');
    if (claimed.state !== 'request') throw new Error('Scoped wake did not claim');
    assert.equal(g.capacity().claimed,1);
    assert.equal(g.jobs.get(claimed.request.request_id)?.scope,callers[i]);
    assert.equal(g.coldStartDue(g.jobs.get(claimed.request.request_id)!),undefined,'the claimed generation is exempt');
    await g.exchange('connector',{worker_label:identity,wake_nonce:nonce,
      request_id:claimed.request.request_id,claim_token:claimed.request.claim_token,
      response:'done-'+i,maximum_wait_seconds:1},AbortSignal.abort(),'serial-chat-'+i);
    assert.equal(g.capacity().claimed,0);
  }
  assert.ok(now-base>900000,'ten actual successive claims cross the legacy 15-minute cutoff');
  assert.ok(now-base<2700000,'the last enqueue still fits the finite 45-minute bound');
  const outcomes=await Promise.all(promises);
  assert.deepEqual(outcomes.map(x=>x.choices[0].message.content),callers.map((_,i)=>'done-'+i));
});

test('once claimed, scoped reasoning is governed by the claim lease/deadline rather than startup budget', async t => {
  let now=1000;
  const g=new Gateway(config(),{now:()=>now,waitForWake:true,startupMs:40,
    timeoutMs:5000,leaseMs:5000,authorizeWorker:()=>{}});
  t.after(()=>g.close());
  const caller=scope('c'), pending=g.submit(request(),undefined,undefined,{caller,scope:caller});
  const identity='alpha~session-'+caller;
  const claim=await g.exchange('connector',{worker_label:identity,wake_nonce:'n'.repeat(32),maximum_wait_seconds:1},
    undefined,'reasoning-chat');
  assert.equal(claim.state,'request');
  if (claim.state !== 'request') throw new Error('Claim not received');
  now=1500;g.prune();
  assert.equal(g.capacity().claimed,1,'cold startup budget does not expire an active claim');
  assert.equal(g.jobs.get(claim.request.request_id)?.state,'claimed');
  await g.exchange('connector',{worker_label:identity,wake_nonce:'n'.repeat(32),
    request_id:claim.request.request_id,claim_token:claim.request.claim_token,response:'reasoned',maximum_wait_seconds:1},
    AbortSignal.abort(),'reasoning-chat');
  assert.equal((await pending).choices[0].message.content,'reasoned');
});

test('warm-at-enqueue requests also become bounded if their matching worker disappears before claim', async t => {
  let now=1000;
  const g=new Gateway(config(),{now:()=>now,waitForWake:true,startupMs:100,
    extensionGraceMs:1000,extensionLastActivity:()=>now});
  t.after(()=>g.close());
  const caller=scope('g'), identity='alpha~session-'+caller;
  g.workers.set(identity,{client:'connector',label:'alpha',seen:now,polling:true,active:null});
  const pending=g.submit(request(),undefined,undefined,{caller,scope:caller});
  assert.equal(jobFor(g,caller)?.wake_needed,false);
  now=1100;
  assert.equal(g.coldStartDue(jobFor(g,caller)),1100,'warm contact never extends admission');
  const worker=g.workers.get(identity)!;
  worker.polling=false; worker.seen=now-45001;
  g.prune();
  await assert.rejects(pending,faulty('wake_stalled'));
  assert.equal(g.capacity().claimed,0);
});

test('keyed scoped queue survives cold budget and stop/restart without becoming unclaimed', async t => {
  let now=1000, stored:any={version:1,jobs:[]};
  const caller=scope('d'), key='durable-startup-key';
  const options={now:()=>now,waitForWake:true,startupMs:100,extensionLastActivity:()=>now,
    extensionGraceMs:1000,save:(next:any)=>{stored=structuredClone(next)},authorizeWorker:()=>{}};
  const first=new Gateway(config(),options);
  const pending=first.submit(request(),key,undefined,{caller,scope:caller});
  now=100000;first.prune();
  assert.equal(jobFor(first,caller)?.state,'queued');
  first.close();
  await assert.rejects(pending,faulty('host_stopped'));
  const second=new Gateway(config(),{...options,records:stored});
  t.after(()=>second.close());
  assert.equal(jobFor(second,caller)?.state,'queued');
  const replay=second.submit(request(),key,undefined,{caller,scope:caller});
  const claimed=await second.exchange('connector',{worker_label:'alpha~session-'+caller,
    wake_nonce:'n'.repeat(32),maximum_wait_seconds:1},undefined,'restored-chat');
  assert.equal(claimed.state,'request');
  if (claimed.state !== 'request') throw new Error('Claim not received');
  await second.exchange('connector',{worker_label:'alpha~session-'+caller,wake_nonce:'n'.repeat(32),
    request_id:claimed.request.request_id,claim_token:claimed.request.claim_token,
    response:'from restart',maximum_wait_seconds:1},AbortSignal.abort(),'restored-chat');
  assert.equal((await replay).choices[0].message.content,'from restart');
});

test('last scoped waiter cancellation clears the startup timer and prevents later delivery', async t => {
  let now=1000;
  const g=new Gateway(config(),{now:()=>now,waitForWake:true,startupMs:1200,
    extensionLastActivity:()=>now,extensionGraceMs:1000});
  t.after(()=>g.close());
  const caller=scope('e'), controller=new AbortController();
  const pending=g.submit(request(),undefined,controller.signal,{caller,scope:caller});
  const job=jobFor(g,caller), timer=job.timer as NodeJS.Timeout;
  controller.abort();
  await assert.rejects(pending,(e:any)=>e.code==='caller_cancelled');
  assert.equal(job.state,'failed');
  assert.equal((timer as any)._destroyed,true);
  now=5000;g.prune();
  assert.equal(g.capacity().claimed,0);
  assert.equal(job.state,'failed');
});

test('real startup timer expires heartbeat-positive unclaimed work without a prune call', async t => {
  const g=new Gateway(config(),{waitForWake:true,startupMs:1050,extensionGraceMs:1000,
    extensionLastActivity:()=>Date.now()});
  t.after(()=>g.close());
  const caller=scope('f'), started=Date.now();
  const pending=g.submit(request(),undefined,undefined,{caller,scope:caller});
  await assert.rejects(pending,faulty('wake_stalled'));
  assert.ok(Date.now()-started<2600,'startup timer must settle without an external status/prune');
  assert.equal(g.capacity().claimed,0);
});

test('continuously polling matching worker cannot waive queued admission when another scope occupies all claim slots', async t => {
  let now=10000;
  const g=new Gateway({...config(),max_claimed_jobs:1},{now:()=>now,waitForWake:true,startupMs:3000,
    extensionGraceMs:1000,extensionLastActivity:()=>now,authorizeWorker:()=>{}});
  t.after(()=>g.close());
  const busyScope=scope('q'), busy=g.submit(request('busy claim'),undefined,undefined,{caller:busyScope,scope:busyScope});
  const occupied=await g.exchange('connector',{worker_label:'alpha~session-'+busyScope,
    wake_nonce:'q'.repeat(32),maximum_wait_seconds:1},undefined,'occupied-chat');
  assert.equal(occupied.state,'request');
  if (occupied.state !== 'request') throw new Error('Capacity claim not received');
  assert.equal(g.capacity().claimed,1);
  const caller=scope('r'), identity='alpha~session-'+caller;
  g.workers.set(identity,{client:'connector',label:'alpha',seen:now,polling:true,active:null});
  const waiting=g.submit(request('queued behind busy'),undefined,undefined,{caller,scope:caller});
  const job=jobFor(g,caller), enqueue=job.enqueued_at!;
  assert.equal(job.wake_needed,false,'this worker was warm at admission');
  assert.equal(g.extensionStallDue(job),undefined,'warm contact waives only browser liveness');
  assert.equal(g.coldStartDue(job),enqueue+3000);
  for (const elapsed of [500,1500,2999]) {
    now=enqueue+elapsed;
    g.workers.get(identity)!.seen=now;
    g.prune();
    assert.equal(g.capacity().claimed,1);
    assert.equal(job.state,'queued');
  }
  now=enqueue+3000;
  g.workers.get(identity)!.seen=now;
  g.prune();
  await assert.rejects(waiting,faulty('wake_stalled'));
  assert.equal(g.capacity().claimed,1,'other claimed generation remains in progress');
  assert.equal(job.state,'failed');
  await g.exchange('connector',{worker_label:'alpha~session-'+busyScope,wake_nonce:'q'.repeat(32),
    request_id:occupied.request.request_id,claim_token:occupied.request.claim_token,
    response:'still valid',maximum_wait_seconds:1},AbortSignal.abort(),'occupied-chat');
  assert.equal((await busy).choices[0].message.content,'still valid');
});

test('real timer expires a warm polling scope starved behind a claimed global slot without prune', async t => {
  const g=new Gateway({...config(),max_claimed_jobs:1},{waitForWake:true,startupMs:1050,
    extensionGraceMs:1000,extensionLastActivity:()=>Date.now(),authorizeWorker:()=>{}});
  t.after(()=>g.close());
  const busyScope=scope('s'), busy=g.submit(request('occupy capacity'),undefined,undefined,{caller:busyScope,scope:busyScope});
  const occupied=await g.exchange('connector',{worker_label:'alpha~session-'+busyScope,
    wake_nonce:'s'.repeat(32),maximum_wait_seconds:1},undefined,'busy-timer-chat');
  assert.equal(occupied.state,'request');
  if (occupied.state !== 'request') throw new Error('Capacity claim not received');
  const caller=scope('t'), identity='alpha~session-'+caller;
  g.workers.set(identity,{client:'connector',label:'alpha',seen:Date.now(),polling:true,active:null});
  const started=Date.now(), pending=g.submit(request('starved warm'),undefined,undefined,{caller,scope:caller});
  assert.equal(g.extensionStallDue(jobFor(g,caller)),undefined);
  await assert.rejects(pending,faulty('wake_stalled'));
  assert.ok(Date.now()-started<2600,'real admission timer must settle despite continuous polling state');
  assert.equal(g.capacity().claimed,1);
  await g.exchange('connector',{worker_label:'alpha~session-'+busyScope,wake_nonce:'s'.repeat(32),
    request_id:occupied.request.request_id,claim_token:occupied.request.claim_token,
    response:'done',maximum_wait_seconds:1},AbortSignal.abort(),'busy-timer-chat');
  assert.equal((await busy).choices[0].message.content,'done');
});

test('scoped startup budget rejects unsafe or unsupported timer values independently of unclaimedMs', () => {
  for(const startupMs of [0,-1,1.1,NaN,Infinity,2147483648,Number.MAX_SAFE_INTEGER])
    assert.throws(()=>new Gateway(config(),{startupMs}),/Invalid scoped startup budget/);
  const g=new Gateway(config(),{startupMs:2700000,unclaimedMs:900000});
  assert.equal(g.startupMs,2700000);
  assert.equal(g.unclaimedMs,900000);
  g.close();
});
