import { tempPrefix } from './temp.ts';
import test from 'node:test';
import type { GatewayConfig } from '../src/types.ts';
import assert from 'node:assert/strict';
type ClaimedExchange = Extract<Awaited<ReturnType<import('../src/gateway.ts').Gateway['exchange']>>, {request: unknown}>;
import fs from 'node:fs';
import { Gateway, JOB_STORE_BYTES } from '../src/gateway.ts';
import { readPrivate, writePrivate } from '../src/security.ts';
const input = (label = 'sol') => ({model: 'chatgpt:' + label, messages: [{role: 'user', content: 'Answer'}]});
const poll = (g: any, label = 'sol') => g.exchange('connector', {worker_label: label}, AbortSignal.abort());
const complete = (g: any, job: any, response = 'answer') => g.exchange('connector', {worker_label: 'sol', request_id: job.request_id, claim_token: job.claim_token, response}, AbortSignal.abort());
function fixture(t: import('node:test').TestContext, extra: Record<string, any> = {}) {
  const directory = fs.mkdtempSync(tempPrefix('crossfeed-delivery-')); const instances: any[] = [];
  t.after(() => { for (const g of instances) g.stopWaiters(); fs.rmSync(directory, {recursive: true, force: true}); });
  let clock = Date.now(), fail = false;
  const config: GatewayConfig = {prefix: 'chatgpt', labels: {sol: {row: 'Latest', level: 0}, other: {row: 'Previous', level: 4}}};
  const load = () => {
    const g = new Gateway(config, {now: () => clock, records: readPrivate(directory, 'jobs.json', {version: 1, jobs: []}, JOB_STORE_BYTES), save: (state: any) => { if (fail) throw Error('injected write failure'); writePrivate(directory, 'jobs.json', state); }, ...extra});
    instances.push(g); return g;
  };
  return {load, directory, config, advance: (ms: number) => {clock += ms;}, fail: (value: any) => {fail = value;}};
}
test('queued keyed work survives an abrupt restart and only one job is replayed', async t => {
  const f = fixture(t), first = f.load(); first.submit(input(), 'retry'); first.stopWaiters();
  const next = f.load(); const a = next.submit(input(), 'retry'), b = next.submit(input(), 'retry');
  assert.equal(a, b); assert.equal(next.jobs.size, 1);
  assert.throws(() => next.submit({...input(), messages: [{role: 'user', content: 'changed'}]}, 'retry'), e => e.code === 'idempotency_conflict');
  const job = (await poll(next)).request; await complete(next, job);
  assert.equal((await a).choices[0].message.content, 'answer');
  assert.equal(fs.statSync(f.directory + '/jobs.json').mode & 0o777, 0o600);
});
test('completed text and structured tool results replay identically from disk after restart', async t => {
  const f = fixture(t), first = f.load(); const a = first.submit(input(), 'text');
  await complete(first, (await poll(first)).request); const text = await a;
  const toolInput = {...input(), tools: [{type: 'function', function: {name: 'lookup'}}], tool_choice: 'required'};
  const b = first.submit(toolInput, 'tool'), job = (await poll(first)).request;
  await first.exchange('connector', {worker_label: 'sol', request_id: job.request_id, claim_token: job.claim_token, tool_calls: [{id: 'call-1', type: 'function', function: {name: 'lookup', arguments: '{}'}}]}, AbortSignal.abort());
  const tools = await b; first.stopWaiters(); const next = f.load();
  assert.deepEqual(await next.submit(input(), 'text'), text); assert.deepEqual(await next.submit(toolInput, 'tool'), tools);
  assert.equal((await poll(next)).state, 'idle');
});
test('claimed jobs are never requeued on restart and late answers cannot revive them', async t => {
  const f = fixture(t), first = f.load(); first.submit(input(), 'claimed'); const job = (await poll(first)).request; first.stopWaiters();
  const next = f.load(); await assert.rejects(next.submit(input(), 'claimed'), e => e.status === 503);
  assert.equal((await complete(next, job)).code, 'request_cancelled'); assert.equal((await poll(next)).state, 'idle');
});
test('durable retry expiry and unclaimed deadlines survive restart, while unkeyed callers are cancelled', async t => {
  const f = fixture(t), first = f.load();
  const result = first.submit(input(), 'finished'); await complete(first, (await poll(first)).request); await result;
  first.submit(input(), 'queued'); first.submit(input('other')); first.stopWaiters();
  f.advance(900001); const next = f.load();
  assert(!next.idempotency.has('finished')); await assert.rejects(next.submit(input(), 'queued'), e => e.code === 'worker_timeout');
  assert.equal([...next.jobs.values()].filter(j => !j.finished).length, 0);
});
test('failed submit, claim and result writes leave the durable transition retryable without acknowledgment', async t => {
  const f = fixture(t), g = f.load(); f.fail(true);
  assert.throws(() => g.submit(input(), 'submit')); assert.equal(g.jobs.size, 0); assert.equal(g.idempotency.size, 0);
  f.fail(false); const result = g.submit(input(), 'submit'); f.fail(true);
  await assert.rejects(poll(g)); assert.equal([...g.jobs.values()][0].state, 'queued'); assert.equal(g.workers.get('sol')!.active, null);
  f.fail(false); const job = (await poll(g)).request; f.fail(true); await assert.rejects(complete(g, job));
  assert.equal(g.jobs.get(job.request_id)!.finished, undefined); assert.equal(g.jobs.get(job.request_id)!.completionDigest, undefined);
  f.fail(false); await complete(g, job); assert.equal((await result).choices[0].message.content, 'answer');
});
test('clean shutdown retains queued keyed jobs and releases their old callers', async t => {
  const f = fixture(t), g = f.load(); const pending = g.submit(input(), 'queued'); g.close();
  await assert.rejects(pending, e => e.code === 'host_stopped');
  const next = f.load(); const result = next.submit(input(), 'queued'); await complete(next, (await poll(next)).request); await result;
});

test('restart and shutdown explicitly record uncertain delivery and never re-run claimed work', async t => {
  for (const clean of [false, true]) {
    const f = fixture(t), first = f.load(); const result = first.submit(input(), 'uncertain');
    const job = (await poll(first)).request; if (clean) first.close(); else first.stopWaiters();
    await assert.rejects(result, e => e.code === (clean ? 'uncertain_delivery' : 'state_unavailable'));
    const next = f.load();
    for (let retry = 0; retry < 2; retry++) await assert.rejects(next.submit(input(), 'uncertain'), e => e.code === 'uncertain_delivery' && /Inspect the worker/.test(e.message));
    assert.equal((await complete(next, job)).code, 'request_cancelled'); assert.equal((await poll(next)).state, 'idle');
  }
});

test('worker quota report blocks only that label, fails queued work and keeps old results replayable', async t => {
  const f = fixture(t), g = f.load(); const first = g.submit(input(), 'quota'), waiting = g.submit(input(), 'waiting');
  const job = (await poll(g)).request;
  const released = await g.exchange('connector', {worker_label: 'sol', request_id: job.request_id, claim_token: job.claim_token, error: 'rate_limited'}, AbortSignal.abort());
  assert.equal(released.state, 'released'); await assert.rejects(first, e => e.code === 'rate_limited'); await assert.rejects(waiting, e => e.code === 'quota_blocked');
  assert.throws(() => g.submit(input(), 'new'), e => e.code === 'quota_blocked');
  await assert.rejects(g.submit(input(), 'quota'), e => e.code === 'rate_limited');
  assert.equal(g.status().find(w => w.label === 'sol')!.quota_blocked, true);
  const other = g.submit(input('other'), 'other'); const work = (await poll(g, 'other')).request;
  await g.exchange('connector', {worker_label: 'other', request_id: work.request_id, claim_token: work.claim_token, response: 'other'}, AbortSignal.abort()); await other;
  f.advance(3600001); const resumed = g.submit(input(), 'resumed'); await complete(g, (await poll(g)).request); await resumed;
});

test('no contact past the lease expires the claim and rejects its late answer', async t => {
  const f = fixture(t, {leaseMs: 50}), g = f.load(); const result = g.submit(input(), 'lease'); const job = (await poll(g)).request;
  f.advance(51); g.prune(); assert.equal(g.jobs.get(job.request_id)!.state,'failed');
  const status = g.status().find(w => w.label === 'sol'); assert.equal(status!.contact, 'stale'); assert.equal(status!.awake, false); assert.equal(status!.processing_claim, false);
  await assert.rejects(result, e => e.code === 'uncertain_delivery');
  assert.equal((await complete(g, job)).code,'request_cancelled'); assert.strictEqual(g.submit(input(),'lease'),result);
});
test('default lease allows a slow reasoning tool call beyond ten minutes within the job deadline', async t => {
  const f = fixture(t), g = f.load();
  const request = {...input(), tools: [{type: 'function', function: {name: 'bash'}}]};
  const result = g.submit(request, 'slow-tool'); result.catch(() => {});
  const job = (await poll(g)).request;
  f.advance(600001); g.prune();
  assert.equal(g.jobs.get(job.request_id)!.state, 'claimed');
  await g.exchange('connector', {worker_label: 'sol', request_id: job.request_id, claim_token: job.claim_token, tool_calls: [{id: 'test-call', type: 'function', function: {name: 'bash', arguments: '{"command":"npm test"}'}}]}, AbortSignal.abort());
  assert.equal((await result).choices[0].finish_reason, 'tool_calls');
});
test('a claimed answer cannot commit beyond the default hard deadline', async t => {
  const f = fixture(t), g = f.load(); const result = g.submit(input(), 'deadline');
  const job = (await poll(g)).request;
  f.advance(1800001); g.prune();
  assert.equal(g.jobs.get(job.request_id)!.state,'failed');
  await assert.rejects(result,e => e.code === 'uncertain_delivery');
  assert.equal((await complete(g,job)).code,'request_cancelled');
});
test('repeated polling renews the same claim lease and a different label cannot keep it alive', async t => {
  const f = fixture(t, {leaseMs: 50}), g = f.load(); const result = g.submit(input(), 'renew'); const first = (await poll(g)).request;
  f.advance(40); const renewed = (await poll(g)).request; assert.equal(renewed.claim_token, first.claim_token);
  f.advance(40); g.prune(); assert.equal(g.jobs.get(first.request_id)!.finished, undefined);
  await poll(g, 'other'); f.advance(11); g.prune(); assert.equal(g.workers.get('sol')!.stale,true);
  await assert.rejects(result,e => e.code === 'uncertain_delivery');
  assert.equal((await complete(g,first)).code,'request_cancelled');
});
test('a real lease timer expires claimed work without a prune call', async t => {
  const f = fixture(t, {leaseMs: 10}), g = f.load(); const result = g.submit(input(), 'timer'); const job=(await poll(g)).request;
  f.advance(11); // The real lease timer sees the advanced injected clock; no prune call.
  await assert.rejects(result,e => e.code === 'uncertain_delivery');
  assert.equal(g.workers.get('sol')!.stale, true); assert.equal(g.capacity().claimed,0);
  assert.equal((await complete(g,job)).code,'request_cancelled');
});

test('global capacity queues other labels and wakes their polls when a claimed slot is released', async t => {
  const f = fixture(t, {pollMs: 2000}), g = f.load(); f.config.max_claimed_jobs = 1;
  const first = g.submit(input(), 'first'), second = g.submit(input('other'), 'second');
  const one = (await poll(g)).request; assert.deepEqual(g.capacity(), {claimed: 1, limit: 1});
  assert.equal((await poll(g, 'other')).state, 'idle');
  assert.equal((await poll(g)).request.claim_token, one.claim_token); assert.equal(g.capacity().claimed, 1);
  const waiting = g.exchange('connector', {worker_label: 'other'}); assert.equal(g.workers.get('other')!.polling, true);
  await complete(g, one); await first; const two = (await waiting as ClaimedExchange).request;
  assert.equal(two.model, 'chatgpt:other'); assert.equal(g.capacity().claimed, 1);
  await g.exchange('connector', {worker_label: 'other', request_id: two.request_id, claim_token: two.claim_token, response: 'second'}, AbortSignal.abort()); await second;
  assert.equal(g.capacity().claimed, 0);
});
test('cancellation and expired stale claims both release capacity', async t => {
  const f = fixture(t, {leaseMs: 50}), g = f.load(); f.config.max_claimed_jobs = 1;
  const abort = new AbortController(), first = g.submit(input(), undefined, abort.signal);
  await poll(g); abort.abort(); await assert.rejects(first, e => e.code === 'caller_cancelled'); assert.equal(g.capacity().claimed, 0);
  const second = g.submit(input(), 'stale'); const job=(await poll(g)).request; f.advance(51); g.prune();
  assert.equal(g.capacity().claimed,0); await assert.rejects(second,e => e.code === 'uncertain_delivery');
  assert.equal((await complete(g,job)).code,'request_cancelled');
});

test('each result records observations from the answering worker, never inferring identity from saved settings', async t => {
  const f = fixture(t), g = f.load(); const unknown = g.submit(input(), 'unknown'); await complete(g, (await poll(g)).request);
  assert.deepEqual((await unknown).metadata, {worker_label: 'sol', picker_receipt: null});
  const result = g.submit(input(), 'observed');
  const job = (await g.exchange('connector', {worker_label: 'sol', picker_receipt: {row: 'Observed row', level: 4}}, AbortSignal.abort()) as ClaimedExchange).request;
  await complete(g, job); const answer = await result;
  assert.equal(answer.model, 'chatgpt:sol'); assert.equal(answer.metadata.picker_receipt!.row, 'Observed row'); assert.equal(answer.metadata.picker_receipt!.level, 4); assert.equal(answer.metadata.picker_receipt!.source, 'worker');
  g.stopWaiters(); const next = f.load(); assert.deepEqual((await next.submit(input(), 'observed')).metadata, answer.metadata);
  await assert.rejects(next.exchange('connector', {worker_label: 'sol', picker_receipt: {row: 'x', level: 5}}, AbortSignal.abort()));
});

test('real process death after queue, claim and result commits preserves replay without duplicate delivery', async t => {
  const {spawn} = await import('node:child_process'); const {once} = await import('node:events');
  for (const stage of ['queued', 'claimed', 'completed']) {
    const f = fixture(t);
    const script = `
      import {Gateway} from './src/gateway.ts';
      import {writePrivate} from './src/security.ts';
      const g = new Gateway({prefix:'chatgpt',labels:{sol:{row:'Latest',level:0}}}, {save: state => writePrivate(process.env.TEST_STATE_DIRECTORY,'jobs.json',state)});
      g.submit({model:'chatgpt:sol',messages:[{role:'user',content:'Answer'}]}, 'killed');
      if (process.env.TEST_CRASH_STAGE !== 'queued') {
        const job = (await g.exchange('connector',{worker_label:'sol'},AbortSignal.abort())).request;
        if (process.env.TEST_CRASH_STAGE === 'completed') await g.exchange('connector',{worker_label:'sol',request_id:job.request_id,claim_token:job.claim_token,response:'durable'},AbortSignal.abort());
      }
      console.log('committed');
      setInterval(()=>{},1000);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {env: {...process.env, TEST_STATE_DIRECTORY: f.directory, TEST_CRASH_STAGE: stage}});
    t.after(() => {if (child.exitCode === null) child.kill();});
    let stderr = ''; child.stderr.on('data', (chunk: any) => {stderr += chunk;});
    const output = await Promise.race([once(child.stdout, 'data').then(([chunk]) => chunk.toString()), once(child, 'exit').then(() => {throw Error(stderr || 'child stopped before commit');})]);
    assert.match(output, /committed/); const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    const restarted = f.load(); const result = restarted.submit(input(), 'killed');
    if (stage === 'claimed') {await assert.rejects(result, e => e.code === 'uncertain_delivery'); assert.equal((await poll(restarted)).state, 'idle');}
    else if (stage === 'completed') {assert.equal((await result).choices[0].message.content, 'durable'); assert.equal((await poll(restarted)).state, 'idle');}
    else {assert.equal(restarted.jobs.size, 1); await complete(restarted, (await poll(restarted)).request); await result;}
  }
});

test('another pending wake cannot replace the observation belonging to an already-claimed answer', async t => {
  const f = fixture(t), g = f.load(); const result = g.submit(input(), 'old-worker');
  const job = (await g.exchange('connector', {worker_label: 'sol', picker_receipt: {row: 'Previous', level: 4}}, AbortSignal.abort()) as ClaimedExchange).request;
  g.picker = () => ({row: 'Latest', level: 0, source: 'extension', observed_at: Date.now()});
  await complete(g, job); const receipt = (await result).metadata.picker_receipt;
  assert.equal(receipt!.row, 'Previous'); assert.equal(receipt!.level, 4); assert.equal(receipt!.source, 'worker');
});

test('disconnect-time persistence failure safely stops the gateway instead of crashing the process', () => {
  return import('node:child_process').then(({spawnSync}) => {
    const script = `
      import assert from 'node:assert/strict';
      import {Gateway} from './src/gateway.ts';
      let fail = false;
      const g = new Gateway({prefix:'chatgpt',labels:{sol:{row:'Latest',level:0}}}, {save:()=>{if(fail)throw Error('disk full');}});
      const abort = new AbortController();
      const result = g.submit({model:'chatgpt:sol',messages:[{role:'user',content:'Answer'}]},undefined,abort.signal);
      fail = true; abort.abort();
      await assert.rejects(result,e=>e.code==='state_unavailable');
      assert.equal(g.closed,true);
      setTimeout(()=>console.log('stopped safely'),20);
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {encoding: 'utf8'});
    assert.equal(child.status, 0, child.stderr); assert.match(child.stdout, /stopped safely/);
  });
});
