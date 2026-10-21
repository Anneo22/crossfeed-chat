import test from 'node:test';
import assert from 'node:assert/strict';
import { Gateway, validateRequest } from '../src/gateway.ts';

const config: any = { prefix: 'chatgpt', labels: { alpha: {}, beta: {} } };
const request = (name = 'alpha', extra: Record<string, any> = {}) => ({ model: `chatgpt:${name}`, messages: [{ role: 'user', content: 'Answer this' }], ...extra });
const fault = (status: number, code?: string) => (error: any) => error.status === status && (!code || error.code === code);
const tool = (name: any) => ({ type: 'function', function: { name, parameters: { type: 'object' } } });
const call = (name: any, id = 'call_1') => ({ id, type: 'function', function: { name, arguments: '{"value":1}' } });
function gateway(t: import('node:test').TestContext, options: Record<string, any> = {}) {
  const g = new Gateway(config, { pollMs: 2, timeoutMs: 1000, ...options });
  t.after(() => g.close());
  return g;
}
async function awake(g: any, name = 'alpha', client = 'client_a') {
  return g.exchange(client, { worker_label: name, maximum_wait_seconds: 1 });
}
async function complete(g: any, claimed: any, extra: Record<string, any> = { response: 'Answer' }, name = 'alpha', client = 'client_a') {
  return g.exchange(client, { worker_label: name, request_id: claimed.request.request_id, claim_token: claimed.request.claim_token, maximum_wait_seconds: 1, ...extra });
}

test('completion removes internal citation markers while retaining prose, links and tool arguments', async t => {
  const g = gateway(t);
  await awake(g);
  const result = g.submit(request('alpha', { tools: [tool('lookup')] }), 'citation-retry');
  const claimed = await awake(g);
  const raw = 'Source\uE200cite\uE202turn298035view0\uE201, another\uE200citeturn12search0\uE201. [Link](https://example.com) and plain citeturn12search0. \uE200other\uE201';
  const args = { response: raw, tool_calls: [{ ...call('lookup'), function: { name: 'lookup', arguments: JSON.stringify({ value: raw }) } }] };
  await complete(g, claimed, args);
  const answer = await result;
  assert.equal(answer.choices[0].message.content, 'Source, another. [Link](https://example.com) and plain citeturn12search0. \uE200other\uE201');
  assert.equal(JSON.parse(answer.choices[0].message.tool_calls![0].function.arguments).value, raw);
  await complete(g, claimed, args);
  assert.deepEqual(await g.submit(request('alpha', { tools: [tool('lookup')] }), 'citation-retry'), answer);
});

test('malformed citation starts preserve text and do not stall completion', async t => {
  const g = gateway(t, { timeoutMs: 10000 });
  await awake(g);
  const malformed = '\uE200cite'.repeat(60000);
  for (const suffix of ['', ' ordinary text \uE200cite\uE202source\uE201']) {
    const result = g.submit(request());
    const claimed = await awake(g);
    const started = performance.now();
    await complete(g, claimed, { response: malformed + suffix });
    assert.ok(performance.now() - started < 2000, 'citation parsing blocked completion for two seconds');
    assert.equal((await result).choices[0].message.content, malformed + (suffix ? ' ordinary text ' : ''));
  }
});

test('saved labels are known but asleep until a worker polls', async t => {
  const g = gateway(t);
  assert.equal(g.status().find(w => w.label === 'alpha')!.saved, true);
  assert.equal(g.status().find(w => w.label === 'alpha')!.awake, false);
  assert.throws(() => g.submit(request('unknown')), fault(503, 'worker_asleep'));
  assert.equal((await awake(g)).state, 'idle');
  assert.equal(g.status().find(w => w.label === 'alpha')!.awake, true);
});

test('requests route only to their exact worker label', async t => {
  const g = gateway(t);
  await awake(g); await awake(g, 'beta', 'client_b');
  const a = g.submit(request('alpha'));
  const b = g.submit(request('beta'));
  const claimedB = await awake(g, 'beta', 'client_b');
  const claimedA = await awake(g);
  assert.equal(claimedA.request.model, 'chatgpt:alpha');
  assert.equal(claimedB.request.model, 'chatgpt:beta');
  assert.notEqual(claimedA.request.request_id, claimedB.request.request_id);
  await complete(g, claimedB, { response: 'Beta' }, 'beta', 'client_b');
  await complete(g, claimedA, { response: 'Alpha' });
  assert.equal((await a).choices[0].message.content, 'Alpha');
  assert.equal((await b).choices[0].message.content, 'Beta');
});

test('a long poll wakes when a matching request arrives', async t => {
  const g = gateway(t, { pollMs: 1000 });
  const poll = awake(g);
  assert.equal(g.status().find(w => w.label === 'alpha')!.polling, true);
  const result = g.submit(request());
  const claimed = await poll;
  assert.equal(claimed.state, 'request');
  await complete(g, claimed);
  assert.equal((await result).choices[0].finish_reason, 'stop');
});

test('idempotency replays the same job and rejects a changed payload', async t => {
  const g = gateway(t); await awake(g);
  const first = g.submit(request(), 'same-key');
  assert.strictEqual(g.submit(request(), 'same-key'), first);
  assert.throws(() => g.submit(request('alpha', { messages: [{ role: 'user', content: 'Changed' }] }), 'same-key'), fault(409, 'idempotency_conflict'));
  const claimed = await awake(g);
  await complete(g, claimed);
  assert.strictEqual(g.submit(request(), 'same-key'), first);
  assert.equal((await first).choices[0].message.content, 'Answer');
  assert.equal(g.status().find(w => w.label === 'alpha')!.queued, 0);
});

test('idempotency preserves a job across caller disconnection', async t => {
  const g = gateway(t); await awake(g);
  const controller = new AbortController();
  const result = g.submit(request(), 'retry-after-disconnect', controller.signal);
  controller.abort();
  const claimed = await awake(g);
  assert.equal(claimed.state, 'request');
  await complete(g, claimed);
  assert.equal((await result).choices[0].message.content, 'Answer');
});

test('a connector cannot take another connector label or submit its completion', async t => {
  const g = gateway(t); await awake(g);
  const result = g.submit(request());
  const claimed = await awake(g);
  await assert.rejects(awake(g, 'alpha', 'intruder'), fault(409));
  await assert.rejects(complete(g, claimed, { response: 'Stolen' }, 'alpha', 'intruder'), fault(409));
  await complete(g, claimed);
  assert.equal((await result).choices[0].message.content, 'Answer');
});

test('claims are stable when repolled and a false claim cannot complete a job', async t => {
  const g = gateway(t); await awake(g);
  const result = g.submit(request());
  const claimed = await awake(g);
  assert.deepEqual((await awake(g)).request, claimed.request);
  const rejected = await complete(g, { request: { ...claimed.request, claim_token: 'false-token' } });
  assert.equal(rejected.code, 'stale_claim');
  assert.equal(rejected.continue, true);
  await complete(g, claimed);
  await result;
});

test('identical completion retries succeed but conflicting retries fail', async t => {
  const g = gateway(t); await awake(g);
  const result = g.submit(request());
  const claimed = await awake(g);
  await complete(g, claimed);
  assert.equal((await complete(g, claimed)).state, 'idle');
  await assert.rejects(complete(g, claimed, { response: 'A different answer' }), fault(409));
  assert.equal((await result).choices[0].message.content, 'Answer');
});

test('a completion retry cannot steal the next queued job', async t => {
  const g = gateway(t); await awake(g);
  const first = g.submit(request()); const second = g.submit(request());
  const claimed = await awake(g);
  const next = await complete(g, claimed);
  const retry = await complete(g, claimed);
  assert.notEqual(next.request.request_id, claimed.request.request_id);
  assert.deepEqual(retry.request, next.request);
  await complete(g, next);
  await Promise.all([first, second]);
});

test('disconnect cancellation invalidates a claimed request and releases the worker', async t => {
  const g = gateway(t); await awake(g);
  const controller = new AbortController();
  const result = g.submit(request(), undefined, controller.signal);
  const rejected = assert.rejects(result, fault(499, 'caller_cancelled'));
  const claimed = await awake(g);
  controller.abort();
  await rejected;
  assert.equal((await complete(g, claimed)).code, 'request_cancelled');
  const next = g.submit(request());
  const nextClaim = await awake(g);
  assert.notEqual(nextClaim.request.request_id, claimed.request.request_id);
  await complete(g, nextClaim); await next;
});

test('an already aborted caller never leaves work in the queue', async t => {
  const g = gateway(t); await awake(g);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(g.submit(request(), undefined, controller.signal), fault(499, 'caller_cancelled'));
  assert.equal((await awake(g)).state, 'idle');
});

test('claimed expiry fires without prune, settles uncertainty, and retains the failed retry key', async t => {
  const g = gateway(t, { timeoutMs: 30, leaseMs: 200 });
  const result = g.submit(request(), 'late-answer');
  const rejected = assert.rejects(result, fault(503, 'uncertain_delivery'));
  const claimed = await awake(g);
  await rejected; // Real lease timer, without status/prune/exchange calls.
  assert.equal(g.jobs.get(claimed.request.request_id)!.state, 'failed');
  assert.equal(g.capacity().claimed, 0);
  assert.strictEqual(g.submit(request(), 'late-answer'), result);
  assert.equal((await complete(g, claimed, {response: 'completed late'})).code, 'request_cancelled');
  const next=g.submit(request('alpha',{messages:[{role:'user',content:'fresh turn'}]}),'fresh-key');
  const nextClaim=await awake(g);
  assert.equal(nextClaim.state,'request','ordinary worker can continue with a new, distinct claim');
  assert.notEqual(nextClaim.request.request_id,claimed.request.request_id);
  await complete(g,nextClaim);
  await next;
});

test('new polls supersede old waits without clearing the newest poll', async t => {
  const g = gateway(t, { pollMs: 1000 });
  const controller = new AbortController();
  const first = g.exchange('client_a', { worker_label: 'alpha', maximum_wait_seconds: 1 }, controller.signal);
  const second = awake(g);
  const third = awake(g);
  assert.equal((await first).state, 'idle');
  assert.equal((await second).state, 'idle');
  controller.abort();
  assert.equal(g.status().find(w => w.label === 'alpha')!.polling, true);
  const result = g.submit(request());
  const work = await third;
  assert.equal(work.state, 'request');
  await complete(g, work); await result;
  assert.equal(g.status().find(w => w.label === 'alpha')!.polling, false);
});

test('answers land promptly while completion exchanges keep polling and retries supersede polls', async t => {
  const g = gateway(t, { pollMs: 1000, leaseMs: 10000 });
  const result = g.submit(request());
  const work = await awake(g);
  const promptly = async (promise: any) => {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('completion waited for a poll')), 250);
      })]);
    } finally { clearTimeout(timer); }
  };
  const completionPoll = complete(g, work, {response: '391'});
  assert.equal((await promptly(result)).choices[0].message.content, '391');
  assert.equal(g.workers.get('alpha')!.polling, true);
  const retryPoll = complete(g, work, {response: '391'});
  assert.equal((await promptly(completionPoll)).state, 'idle');
  assert.equal((await retryPoll).state, 'idle');
});

test('a newly arrived exchange owns a job even when the old poll was already notified', async t => {
  const g = gateway(t, {pollMs: 1000});
  const older = awake(g);
  const result = g.submit(request());
  // Notify resolves the wait, but the old exchange has not resumed yet.
  const newer = awake(g);
  assert.equal((await older).state, 'idle');
  const work = await newer;
  assert.equal(work.state, 'request');
  await complete(g, work); await result;
});

test('shutdown releases long polls and rejects all queued or claimed callers', async t => {
  const g = gateway(t, { pollMs: 1000 });
  const poll = awake(g);
  const result = g.submit(request());
  const rejected = assert.rejects(result, fault(503, 'host_stopped'));
  g.close();
  assert.equal((await poll).state, 'released'); await rejected;
  assert.equal((await awake(g)).continue, false);
  assert.throws(() => g.submit(request()), fault(503));
});

test('tool results remain structured, with JSON arguments and tool_calls finish reason', async t => {
  const g = gateway(t); await awake(g);
  const result = g.submit(request('alpha', { tools: [tool('lookup')], tool_choice: 'required' }));
  const claimed = await awake(g);
  await complete(g, claimed, { tool_calls: [call('lookup')] });
  const answer = await result;
  assert.equal(answer.choices[0].finish_reason, 'tool_calls');
  assert.equal(answer.choices[0].message.content, null);
  assert.deepEqual(JSON.parse(answer.choices[0].message.tool_calls![0].function.arguments), { value: 1 });
});

test('completion enforces tool_choice, advertised tools and parallel_tool_calls', async t => {
  const g = gateway(t); await awake(g);
  const cases = [
    [{ tools: [tool('lookup')], tool_choice: 'none' }, { tool_calls: [call('lookup')] }, { response: 'Text' }],
    [{ tools: [tool('lookup')], tool_choice: 'required' }, { response: 'Text' }, { tool_calls: [call('lookup')] }],
    [{ tools: [tool('lookup'), tool('other')], tool_choice: { type: 'function', function: { name: 'lookup' } } }, { tool_calls: [call('other')] }, { tool_calls: [call('lookup')] }],
    [{ tools: [tool('lookup')] }, { tool_calls: [call('unadvertised')] }, { tool_calls: [call('lookup')] }],
    [{ tools: [tool('lookup')], parallel_tool_calls: false }, { tool_calls: [call('lookup'), call('lookup', 'call_2')] }, { tool_calls: [call('lookup')] }],
    [{ tools: [tool('lookup')] }, { tool_calls: [call('lookup'), call('lookup')] }, { tool_calls: [call('lookup')] }],
    [{ tools: [tool('lookup')] }, { tool_calls: [{ ...call('lookup'), function: { name: 'lookup', arguments: '[]' } }] }, { tool_calls: [call('lookup')] }],
  ];
  for (const [options, invalid, valid] of cases) {
    const result = g.submit(request('alpha', options)); const claimed = await awake(g);
    await assert.rejects(complete(g, claimed, invalid), fault(400));
    assert.equal(g.status().find(w => w.label === 'alpha')!.busy, true);
    await complete(g, claimed, valid); await result;
  }
});

test('worker errors reject callers without returning worker error text', async t => {
  const g = gateway(t); await awake(g);
  const result = g.submit(request()); const rejected = assert.rejects(result, error => error.code === 'worker_error' && !error.message.includes('private-detail'));
  const claimed = await awake(g);
  await assert.rejects(complete(g, claimed, { error: 'private-detail', response: 'answer' }), fault(400));
  await complete(g, claimed, { error: 'private-detail' }); await rejected;
});

test('input validation preserves text tool history and rejects unsupported content', () => {
  const input = request('alpha', { messages: [
    { role: 'user', content: [{ type: 'text', text: 'One' }, { type: 'text', text: 'Two' }] },
    { role: 'assistant', content: null, tool_calls: [call('lookup')] },
    { role: 'tool', content: 'Result', tool_call_id: 'call_1' },
  ] });
  assert.equal(validateRequest(input, 'chatgpt').messages[0].content, 'One\nTwo');
  for (const invalid of [
    request('alpha', { unknown: true }), request('alpha', { model: 'wrong:alpha' }),
    request('alpha', { messages: [] }), request('alpha', { messages: [{ role: 'user', content: null }] }),
    request('alpha', { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: {} }] }] }),
    request('alpha', { messages: [{ role: 'tool', content: 'Result' }] }),
    request('alpha', { tools: [tool('lookup'), tool('lookup')] }), request('alpha', { tool_choice: 'required' }),
    request('alpha', { tools: [tool('lookup')], tool_choice: { type: 'function', function: { name: 'missing' } } }),
    request('alpha', { parallel_tool_calls: 'false' }), request('alpha', { max_tokens: 1.5 }), request('alpha', { temperature: 3 }),
    request('alpha', { messages: [{ role: 'user', content: 'x'.repeat(256 * 1024 + 1) }] }),
  ]) assert.throws(() => validateRequest(invalid, 'chatgpt'), fault(400));
  const large = request('alpha', { messages: Array.from({ length: 5 }, () => ({ role: 'user', content: 'x'.repeat(250 * 1024) })) });
  assert.throws(() => validateRequest(large, 'chatgpt'), fault(413));
});

test('queue and poll arguments have bounded capacity', async t => {
  const g = gateway(t); await awake(g);
  for (const args of [{ maximum_wait_seconds: 0 }, { maximum_wait_seconds: 21 }, { maximum_wait_seconds: 1.5 }, { extra: true }, { worker_label: 'alpha\n' }])
    await assert.rejects(g.exchange('client_a', { worker_label: 'alpha', ...args }), fault(400));
  for (const key of ['', 'x'.repeat(129), 'contains space']) assert.throws(() => g.submit(request(), key), fault(400));
  const jobs = Array.from({ length: 128 }, () => g.submit(request()).catch((error: any) => error.code));
  assert.throws(() => g.submit(request()), fault(429));
  g.close();
  assert.ok((await Promise.all(jobs)).every(code => code === 'host_stopped'));
});

test('finished idempotency records expire and worker freshness is bounded', async t => {
  let now = 1_000_000;
  const g = gateway(t, { now: () => now }); await awake(g);
  const first = g.submit(request(), 'expires'); const claimed = await awake(g);
  await complete(g, claimed); await first;
  now += 600001;
  assert.equal(g.status().find(w => w.label === 'alpha')!.awake, false);
  await awake(g);
  const second = g.submit(request(), 'expires');
  assert.notStrictEqual(second, first);
  const secondClaim = await awake(g); await complete(g, secondClaim); await second;
});

test('a claim from a different label is stale and leaves both jobs owned correctly', async t => {
  const g = gateway(t); await awake(g); await awake(g, 'beta');
  const alpha = g.submit(request()); const beta = g.submit(request('beta'));
  const alphaClaim = await awake(g); const betaClaim = await awake(g, 'beta');
  assert.equal((await complete(g, alphaClaim, { response: 'Wrong route' }, 'beta')).code, 'stale_claim');
  assert.deepEqual((await awake(g, 'beta')).request, betaClaim.request);
  await complete(g, alphaClaim); await complete(g, betaClaim, { response: 'Beta' }, 'beta');
  await Promise.all([alpha, beta]);
});

test('the idempotency ledger bounds retained jobs while allowing existing retries', async t => {
  const g = gateway(t); await awake(g);
  let first;
  for (let batch = 0; batch < 2; batch++) {
    const results = Array.from({ length: 128 }, (_, index) => g.submit(request(), `key-${batch * 128 + index}`));
    first ??= results[0];
    let claimed = await awake(g);
    for (let index = 0; index < results.length; index++) {
      assert.equal(claimed.state, 'request');
      claimed = await complete(g, claimed);
      await results[index];
    }
    assert.equal(claimed.state, 'idle');
  }
  assert.strictEqual(g.submit(request(), 'key-0'), first);
  assert.throws(() => g.submit(request(), 'key-overflow'), fault(429));
});

test('worker labels cannot grow without bound', async t => {
  const g = gateway(t);
  const controller = new AbortController(); controller.abort();
  for (let index = 0; index < 128; index++)
    assert.equal((await g.exchange('client_a', { worker_label: `worker-${index}` }, controller.signal)).state, 'idle');
  await assert.rejects(g.exchange('client_a', { worker_label: 'overflow' }, controller.signal), fault(429));
});

test('oversized completion output is rejected without losing the active claim', async t => {
  const g = gateway(t); await awake(g);
  const result = g.submit(request()); const claimed = await awake(g);
  await assert.rejects(complete(g, claimed, { response: 'x'.repeat(768 * 1024 + 1) }), fault(400));
  assert.deepEqual((await awake(g)).request, claimed.request);
  await complete(g, claimed, { response: 'x'.repeat(768 * 1024) });
  assert.equal((await result).choices[0].message.content!.length, 768 * 1024);
});

test('saved asleep label requests wake once and holds an idempotent job until polling', async t => {
  const wakes: any[] = [], g = gateway(t, {wake: (label: any) => wakes.push(label)});
  const first = g.submit(request(), 'held');
  assert.strictEqual(g.submit(request(), 'held'), first);
  assert.deepEqual(wakes, ['alpha']);
  const claimed = await awake(g); assert.equal(claimed.state, 'request');
  await complete(g, claimed); assert.equal((await first).choices[0].message.content, 'Answer');
});

test('wake failure rejects held jobs with a safe stable error', async t => {
  const g = gateway(t); const result = g.submit(request());
  g.wakeFailed('alpha'); await assert.rejects(result, fault(503, 'wake_failed'));
  assert.equal((await awake(g)).state, 'idle');
});

test('disabled or refused wake rejects the caller rather than leaving a hanging request', async t => {
  const g = gateway(t, {wake: () => { throw Error('private details'); }});
  await assert.rejects(g.submit(request()), error => error.code === 'wake_failed' && !error.message.includes('private'));
});

test('a recently polling saved worker accepts a job between polls with automatic wakes disabled', async t => {
  const g = gateway(t, {wake: () => { throw Error('Automatic wakes disabled'); }});
  await awake(g);
  assert.equal(g.status().find(w => w.label === 'alpha')!.awake, true);
  const result = g.submit(request());
  result.catch(() => {});
  const claim = await awake(g);
  assert.equal(claim.state, 'request', 'the readiness-to-submit gap must not discard the job');
  await complete(g, claim);
  assert.equal((await result).choices[0].message.content, 'Answer');
});

test('stale contact without a poll or claim requests a fresh wake for saved workers', async t => {
  let now = 1000;
  const wakes: any[] = [], g = gateway(t, {now: () => now, wake: (name: any) => wakes.push(name)}); await awake(g);
  now += 45000;
  assert.equal(g.status().find(w => w.label === 'alpha')!.awake, false);
  const result = g.submit(request()); assert.deepEqual(wakes, ['alpha']);
  const claim = await awake(g); await complete(g, claim); await result;
});

test('a job queued with recent contact but no polling worker requests an immediate wake', async t => {
  let now = 0;
  const wakes: string[] = [], g = gateway(t, {now: () => now, timeoutMs: 1800000, wake: (name: string) => wakes.push(name)});
  await awake(g);
  const pending = g.submit(request());
  assert.equal(g.status().find(w => w.label === 'alpha')!.awake, true);
  assert.ok(wakes.includes('alpha'));
  now = 45001; g.prune();
  assert.ok(wakes.includes('alpha'));
  const claim = await awake(g); await complete(g, claim); await pending;
});

test('a cooldown beginning after submission defers the real claim timer but keeps the deadline', async t => {
  const cfg = structuredClone(config);
  const g = new Gateway(cfg, {unclaimedMs: 20, timeoutMs: 150}); t.after(() => g.close());
  const pending = g.submit(request());
  cfg.wake_state = {wakes: [], failed: {}, archives: [], cooldown_until: Date.now() + 1000};
  await new Promise(resolve => setTimeout(resolve, 50));
  const job = [...g.jobs.values()][0];
  assert.equal(job.state, 'queued'); assert.equal(job.claimBy, job.deadline);
  await assert.rejects(pending, fault(504, 'worker_timeout'));
});

test('a capped submission commits its deferred claim deadline in one queued transition', async t => {
  const cfg = {...structuredClone(config), wake_hourly_cap: 0};
  let writes = 0;
  const g = new Gateway(cfg, {timeoutMs: 1000, unclaimedMs: 15, save: state => {
    if (++writes > 1) throw Error('State unavailable');
    assert.equal(state.jobs[0].claimBy, state.jobs[0].deadline);
  }});
  t.after(() => g.close());
  let pending: Promise<any>;
  assert.doesNotThrow(() => { pending = g.submit(request()); });
  const job = [...g.jobs.values()][0];
  assert.equal(writes, 1); assert.equal(job.state, 'queued'); assert.ok(job.timer);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(job.state, 'queued');
  assert.strictEqual(job.promise, pending!);
});

test('status has never, recent, stale contacts and exact polling/processing_claim booleans', async t => {
  let now = 1000; const g = gateway(t, {now: () => now});
  const row = () => g.status().find(w => w.label === 'alpha')!;
  assert.deepEqual([row().contact, row().polling, row().processing_claim], ['never', false, false]);
  await awake(g); assert.equal(row().contact, 'recent');
  now += 45000; assert.equal(row().contact, 'stale');
  const result = g.submit(request()); const claim = await awake(g);
  assert.deepEqual([row().contact, row().polling, row().processing_claim], ['recent', false, true]);
  await complete(g, claim); await result; assert.equal(row().processing_claim, false);
});

test('production defaults allow thirty-minute jobs and fifteen-minute unclaimed TTL', () => {
  const g = new Gateway(config);
  assert.equal(g.timeoutMs, 1800000); assert.equal(g.unclaimedMs, 900000); g.close();
});

test('unclaimed TTL rejects jobs early while claimed jobs keep their full deadline', async t => {
  const g = gateway(t, {unclaimedMs: 15, timeoutMs: 1000});
  await assert.rejects(g.submit(request()), fault(504, 'worker_unclaimed'));
  const result = g.submit(request()); const claim = await awake(g);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(g.jobs.get(claim.request.request_id)!.finished, undefined);
  await complete(g, claim); assert.equal((await result).choices[0].finish_reason, 'stop');
});

test('configured deadline and unclaimed TTL are enforced by the injected clock too', async t => {
  let now = 0; const g = gateway(t, {now: () => now, timeoutMs: 1000, unclaimedMs: 500});
  const pending = g.submit(request()); now = 501; g.prune(); await assert.rejects(pending, fault(504));
  const result = g.submit(request()); const claim = await awake(g);
  now += 501; g.prune(); assert.equal(g.jobs.get(claim.request.request_id)!.state, 'claimed');
  now += 500; g.prune(); assert.equal(g.jobs.get(claim.request.request_id)!.state, 'failed');
  await assert.rejects(result, fault(503, 'uncertain_delivery'));
  assert.equal((await complete(g, claim)).code, 'request_cancelled');
});

test('already-disconnected keyed request still requests wake and completes on its idempotent retry', async t => {
  const wakes: any[] = [], g = gateway(t, {wake: (name: any) => wakes.push(name)}), controller = new AbortController(); controller.abort();
  const first = g.submit(request(), 'disconnected-key', controller.signal);
  assert.deepEqual(wakes, ['alpha']); assert.strictEqual(g.submit(request(), 'disconnected-key'), first);
  const claim = await awake(g); await complete(g, claim); assert.equal((await first).choices[0].message.content, 'Answer');
});

test('seeded completion/cancellation/expiry order preserves terminal results and label ownership', async t => {
  for (let seed = 1; seed <= 12; seed++) {
    let clock = 1000, random = seed;
    const next = () => { random = (random * 1664525 + 1013904223) >>> 0; return random; };
    const g = gateway(t, {now: () => clock});
    for (let step = 0; step < 8; step++) {
      const name = next() % 2 ? 'alpha' : 'beta', client = 'client-' + name, key = `${seed}-${step}`;
      const result = g.submit(request(name), key); const outcome = result.then((value: any) => value, (error: any) => error);
      assert.equal(g.submit(request(name), key), result, `seed ${seed}`);
      const claimed = await awake(g, name, client);
      assert.equal((await complete(g, claimed, {response: 'wrong'}, name === 'alpha' ? 'beta' : 'alpha', 'client-' + (name === 'alpha' ? 'beta' : 'alpha'))).code, 'stale_claim');
      if (next() % 3 === 0) { clock += 101; g.prune(); assert.equal(g.jobs.get(claimed.request.request_id)!.state, 'claimed'); }
      {
        await complete(g, claimed, {response: key}, name, client);
        await complete(g, claimed, {response: key}, name, client);
        assert.equal((await outcome).choices[0].message.content, key);
      }
      assert.equal(await g.submit(request(name), key).catch((e: any) => e), await outcome);
      assert.equal([...g.workers.values()].filter(w => w.active).length, 0);
    }
    g.close();
  }
});

test('replicas claim separate jobs for one public model and cannot complete each other claims', async t => {
  const cfg = {prefix: 'chatgpt', labels: {sol: {row: 'Latest', level: 3, replicas: 2}}};
  const g = new Gateway(cfg, {pollMs: 1}); t.after(() => g.close());
  const first = g.submit(request('sol')), second = g.submit(request('sol'));
  const a = await g.exchange('client', {worker_label: 'sol'});
  const b = await g.exchange('client', {worker_label: 'sol~replica-2'});
  assert.ok(a.state === 'request' && b.state === 'request');
  assert.notEqual(a.request.request_id, b.request.request_id);
  assert.equal(g.capacity().claimed, 2);
  const cross = await g.exchange('client', {worker_label: 'sol', request_id: b.request.request_id, claim_token: b.request.claim_token, response: 'wrong'});
  assert.equal(cross.state, 'recovery');
  assert.equal(g.capacity().claimed, 2);
  for (const [identity, work] of [['sol', a], ['sol~replica-2', b]] as const) {
    await g.exchange('client', {worker_label: identity, request_id: work.request.request_id, claim_token: work.request.claim_token, response: identity});
  }
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map(r => r.metadata.worker_identity), ['sol', 'sol~replica-2']);
  assert(results.every(r => r.model === 'chatgpt:sol' && r.metadata.worker_label === 'sol'));
  assert.deepEqual(g.status().map(w => w.model), ['chatgpt:sol']);
  await assert.rejects(g.exchange('client', {worker_label: 'sol~replica-3'}));
});

test('rate limit from a replica pauses the whole label and releases its sibling', async t => {
  const cfg = {prefix: 'chatgpt', labels: {sol: {row: 'Latest', level: 4, replicas: 2}}};
  const g = new Gateway(cfg, {pollMs: 1}); t.after(() => g.close());
  const result = g.submit(request('sol'));
  const work = await g.exchange('client', {worker_label: 'sol~replica-2'});
  assert.ok(work.state === 'request');
  await g.exchange('client', {worker_label: 'sol~replica-2', request_id: work.request.request_id, claim_token: work.request.claim_token, error: 'rate_limited'});
  await assert.rejects(result, e => (e as any).code === 'rate_limited');
  assert.equal((await g.exchange('client', {worker_label: 'sol'})).state, 'released');
  assert.throws(() => g.submit(request('sol')), e => (e as any).code === 'quota_blocked');
});

test('legacy retained composer completion retries still release after restart without worker field', async t => {
  const cfg = {prefix: 'chatgpt', labels: {sol: {row: 'Latest', level: 3}}};
  const g = new Gateway(cfg, {pollMs: 1}); t.after(() => g.close());
  const result = g.submit(request('sol'), 'legacy-composer');
  const job = [...g.jobs.values()][0]; job.delivery = 'composer';
  const work = await g.exchange('client', {worker_label: 'sol', request_id: job.id});
  assert.ok(work.state === 'request');
  const args = {worker_label: 'sol', request_id: job.id, claim_token: work.request.claim_token, response: 'done'};
  assert.equal((await g.exchange('client', args)).state, 'released'); await result;
  const record = g.record(job); delete record.worker;
  const restarted = new Gateway(cfg, {records: {version: 1, jobs: [record]}}); t.after(() => restarted.close());
  assert.equal((await restarted.exchange('client', args)).state, 'released');
});

test('atomic completion wait carries eight delayed local-tool continuations in one scoped lane without wakes or idle gaps', {timeout:5000}, async t => {
  const session = 'e'.repeat(22), identity = `alpha~session-${session}`, wake_nonce = 'n'.repeat(32);
  const wakes: any[] = [];
  const g = gateway(t, {pollMs:1000, wake:(name: string, scope: string) => wakes.push([name, scope])});
  const exchange = (args: Record<string, any> = {}, signal?: AbortSignal) =>
    g.exchange('client_a', {worker_label:identity, wake_nonce, maximum_wait_seconds:1, ...args}, signal, 'continuation-chat');
  let workerWait = exchange();
  while (!g.workers.get(identity)?.polling) await new Promise(resolve => setTimeout(resolve, 1));
  let controller = new AbortController();
  for (let i = 0; i < 8; i++) {
    const prior = `prior_${i}`, next = `next_${i}`;
    const messages = i === 0 ? [{role:'user',content:'start tools'}] : [
      {role:'user',content:'start tools'},
      {role:'assistant',content:null,tool_calls:[call('lookup', prior)]},
      {role:'tool',content:`local result ${i}`,tool_call_id:prior},
    ];
    const local = g.submit(request('alpha', {messages, tools:[tool('lookup')], tool_choice:'required'}), undefined, undefined, {caller:session,scope:session});
    const work = await workerWait;
    assert.equal(work.state, 'request'); assert.equal(work.worker_label, identity);
    if (work.state !== 'request') assert.fail('Expected scoped tool work');
    assert.deepEqual(work.request.messages, messages);
    controller = new AbortController();
    workerWait = exchange({request_id:work.request.request_id, claim_token:work.request.claim_token, tool_calls:[call('lookup', next)]}, controller.signal);
    const answer = await local;
    assert.equal(answer.choices[0].finish_reason, 'tool_calls');
    assert.equal(answer.choices[0].message.tool_calls?.[0].id, next);
    assert.equal(answer.metadata?.worker_identity, identity);
    assert.equal(g.workers.get(identity)?.polling, true);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.deepEqual(wakes, []);
  controller.abort();
  assert.equal((await workerWait).state, 'idle');
});

test('an atomic completion wait cannot claim a sibling scoped session', {timeout:5000}, async t => {
  const A = 'j'.repeat(22), B = 'k'.repeat(22), g = gateway(t, {pollMs:1000});
  const identity = (scope: string) => `alpha~session-${scope}`;
  const exchange = (scope: string, args: Record<string, any> = {}, signal?: AbortSignal) =>
    g.exchange('client_a', {worker_label:identity(scope), wake_nonce:(scope === A ? 'a' : 'b').repeat(32), maximum_wait_seconds:1, ...args}, signal, `sibling-chat-${scope}`);
  const bRegisterController = new AbortController();
  const bRegister = exchange(B, {}, bRegisterController.signal);
  while (!g.workers.get(identity(B))?.polling) await new Promise(resolve => setTimeout(resolve, 1));
  bRegisterController.abort(); await bRegister;
  const aPoll = exchange(A);
  while (!g.workers.get(identity(A))?.polling) await new Promise(resolve => setTimeout(resolve, 1));
  const aCaller = g.submit(request(), undefined, undefined, {caller:A,scope:A}), aWork = await aPoll;
  if (aWork.state !== 'request') assert.fail('Expected A work');
  const aController = new AbortController();
  const aWait = exchange(A, {request_id:aWork.request.request_id, claim_token:aWork.request.claim_token, response:'A'}, aController.signal);
  assert.equal((await aCaller).choices[0].message.content, 'A');
  assert.equal(g.workers.get(identity(A))?.polling, true);
  const bCaller = g.submit(request(), undefined, undefined, {caller:B,scope:B});
  await new Promise(resolve => setTimeout(resolve, 5));
  // Queue notification may end another lane's wait, but cannot hand it B's work.
  assert.equal((await aWait).state, 'idle');
  assert.equal(g.workers.get(identity(A))?.active, null);
  assert.equal(g.queued('alpha', B).length, 1);
  const bWork = await exchange(B);
  assert.equal(bWork.worker_label, identity(B));
  if (bWork.state !== 'request') assert.fail('Expected B work');
  const bController = new AbortController();
  const bWait = exchange(B, {request_id:bWork.request.request_id, claim_token:bWork.request.claim_token, response:'B'}, bController.signal);
  assert.equal((await bCaller).choices[0].message.content, 'B');
  bController.abort(); await bWait; aController.abort(); await aWait;
});

test('two caller sessions isolate queues and replicas, while a worker conversation cannot cross sessions', async t => {
  const cfg = {prefix:'chatgpt',labels:{alpha:{row:'Latest',level:3,replicas:2}}};
  const g = new Gateway(cfg,{pollMs:1,timeoutMs:5000}); t.after(()=>g.close());
  const a = 'a'.repeat(22), b = 'b'.repeat(22);
  const first = g.submit(request(), 'same-key',undefined,{caller:a,scope:a});
  const second = g.submit(request(), 'same-key',undefined,{caller:b,scope:b});
  const third = g.submit(request('alpha',{messages:[{role:'user',content:'Other parallel job'}]}),'third',undefined,{caller:a,scope:a});
  const identities = [`alpha~session-${a}`,`alpha~session-${b}`,`alpha~session-${a}~replica-2`];
  const works: any[] = [];
  for (const [i,identity] of identities.entries()) works.push(await g.exchange('connector',{worker_label:identity,wake_nonce:'n'.repeat(32)},undefined,`chat-${i}`));
  assert.equal(new Set(works.map(w=>w.request!.request_id)).size,3);
  await assert.rejects(g.exchange('connector',{worker_label:`alpha~session-${b}~replica-2`,wake_nonce:'n'.repeat(32)},undefined,'chat-0'),fault(409));
  for (const [i,w] of works.entries()) await g.exchange('connector',{worker_label:identities[i],wake_nonce:'n'.repeat(32),request_id:w.request!.request_id,claim_token:w.request!.claim_token,response:`answer-${i}`},undefined,`chat-${i}`);
  assert.deepEqual((await Promise.all([first,second,third])).map(r=>r.metadata.worker_identity),identities);
  const follow = g.submit(request('alpha',{messages:[{role:'user',content:'Follow-up'}]}),'follow',undefined,{caller:a,scope:a});
  const w = await g.exchange('connector',{worker_label:identities[0],wake_nonce:'n'.repeat(32)},undefined,'chat-0');
  assert.ok(w.state==='request');
  await g.exchange('connector',{worker_label:identities[0],wake_nonce:'n'.repeat(32),request_id:w.request!.request_id,claim_token:w.request!.claim_token,response:'continued'},undefined,'chat-0');
  assert.equal((await follow).metadata.worker_identity,identities[0]);
});

test('short same-caller content retries attach with different keys; callers and later deliberate requests stay separate', async t => {
  let clock = 100000;
  const g = gateway(t,{now:()=>clock,timeoutMs:1000000});
  const caller = 'a'.repeat(22), other = 'b'.repeat(22);
  const first = g.submit(request(),'original',undefined,{caller});
  assert.equal(g.submit(request(),'retry',undefined,{caller}),first);
  assert.equal(g.submit(request(),'retry',undefined,{caller}),first);
  const foreign = g.submit(request(),'original',undefined,{caller:other});
  assert.notEqual(foreign,first);
  clock += 60001;
  const later = g.submit(request(),'later',undefined,{caller});
  assert.notEqual(later,first); assert.equal(g.jobs.size,3);
});

test('retry aliases and caller session queues survive restart and a disconnected transport', async t => {
  let records: any = {version:1,jobs:[]}; const caller = 'a'.repeat(22);
  const cfg = {prefix:'chatgpt',labels:{alpha:{row:'Latest',level:3}}};
  const g = new Gateway(cfg,{pollMs:1,waitForWake:true,save:state=>{records=structuredClone(state);}});
  const abort = new AbortController();
  const first = g.submit(request(),'original',abort.signal,{caller,scope:caller});
  g.submit(request(),'retry',undefined,{caller,scope:caller}); abort.abort();
  assert.equal([...g.jobs.values()][0].state,'queued');
  g.close(); await assert.rejects(first,fault(503,'host_stopped'));
  const restored = new Gateway(cfg,{pollMs:1,waitForWake:true,records}); t.after(()=>restored.close());
  assert.equal(restored.submit(request(),'retry',undefined,{caller,scope:caller}),[...restored.jobs.values()][0].promise);
  assert.equal(restored.jobs.size,1);
});

test('production queue wait survives several days of wake caps and starts its completion limit at claim', async t => {
  let clock=Date.now();
  const cfg={prefix:'chatgpt',labels:{alpha:{row:'Latest',level:3}},wake_daily_cap:0};
  const g = new Gateway(cfg,{now:()=>clock,waitForWake:true,timeoutMs:1000,pollMs:1}); t.after(()=>g.close());
  const result=g.submit(request(),'waiting'); const job=[...g.jobs.values()][0];
  clock+=3*86400000; g.prune(); assert.equal(job.state,'queued');
  const work=await g.exchange('connector',{worker_label:'alpha'});
  assert.ok(work.state==='request');
  assert.equal(job.deadline,clock+1000);
  await g.exchange('connector',{worker_label:'alpha',request_id:work.request!.request_id,claim_token:work.request!.claim_token,response:'completed'});
  assert.equal((await result).choices[0].message.content,'completed');
});

test('a receipt write failure after durable completion still settles the answer and releases the worker',async t=>{
  let records:any;
  const g=gateway(t,{waitForWake:true,save:(state:any)=>{records=structuredClone(state);},audit:(job:any)=>{if(job.finished)throw Error('disk unavailable');}});
  const result=g.submit(request(),'receipt-failure');const work=await awake(g);
  await complete(g,work,{response:'saved answer'});
  assert.equal((await result).choices[0].message.content,'saved answer');
  assert.equal(records.jobs[0].state,'completed');assert.equal(g.workers.get('alpha')!.active,null);
  assert.equal(g.auditUnavailable,true);assert.equal(g.closed,true);
  assert.throws(()=>g.submit(request(),'new'),fault(503));
});

test('scoped routing rejects overlong labels before persisting or scheduling work',async t=>{
  const name='x'.repeat(99),caller='a'.repeat(22);const cfg={prefix:'chatgpt',labels:{[name]:{row:'Latest',level:3}}};
  const g=new Gateway(cfg);t.after(()=>g.close());
  assert.throws(()=>g.submit(request(name),'long',undefined,{caller,scope:caller}),fault(400));assert.equal(g.jobs.size,0);
});

test('anonymous keys cannot collide with scoped keys and changing caller scope never borrows a job',t=>{
  const g=gateway(t),caller='a'.repeat(22);
  const scoped=g.submit(request(),'same',undefined,{caller,scope:caller});
  const anonymous=g.submit(request(),`${caller}:same`);
  const correlated=g.submit(request(),'same',undefined,{caller});
  assert.notEqual(scoped,anonymous);assert.notEqual(scoped,correlated);assert.equal(g.jobs.size,3);
});

test('scoped workers fail closed when the ChatGPT conversation metadata is absent',async t=>{
  const g=gateway(t),caller='a'.repeat(22);
  await assert.rejects(g.exchange('connector',{worker_label:`alpha~session-${caller}`,wake_nonce:'n'.repeat(32)}),fault(409,'worker_session_required'));
  assert.equal(g.workers.size,0);
});

test('stale idle session workers free in-memory slots while saved conversation URLs remain intact',async t=>{
  let now=100000;const cfg:any={prefix:'chatgpt',labels:{alpha:{row:'Latest',level:3}},session_workers:{}};
  const g=new Gateway(cfg,{now:()=>now,pollMs:1});t.after(()=>g.close());
  for(let i=0;i<128;i++){
    const scope=i.toString().padStart(22,'0'),identity=`alpha~session-${scope}`;
    g.workers.set(identity,{label:'alpha',client:'connector',seen:0,polling:false,active:null});
    cfg.session_workers[identity]={label:'alpha',scope,url:`https://chatgpt.com/c/old-${i}`};
  }
  const saved=structuredClone(cfg.session_workers),caller='z'.repeat(22),identity=`alpha~session-${caller}`;
  assert.equal(g.workerRoom(identity),true);assert.equal(g.workers.size,127);assert.deepEqual(cfg.session_workers,saved);
  const result=g.submit(request(),'new',undefined,{caller,scope:caller});
  const work=await g.exchange('connector',{worker_label:identity,wake_nonce:'n'.repeat(32)},undefined,'new-chat');assert.ok(work.state==='request');
  await g.exchange('connector',{worker_label:identity,wake_nonce:'n'.repeat(32),request_id:work.request!.request_id,claim_token:work.request!.claim_token,response:'new'},undefined,'new-chat');
  await result;assert.deepEqual(cfg.session_workers,saved);
});

test('conversation bindings survive restart and eviction and prevent crossing scoped or legacy routes',async t=>{
  const a='a'.repeat(22),b='b'.repeat(22),conversation='c'.repeat(22);
  const cfg:any={prefix:'chatgpt',labels:{alpha:{row:'Latest',level:3}}};
  const first=new Gateway(cfg,{pollMs:1});
  const job=first.submit(request(),'a',undefined,{caller:a,scope:a});
  const work=await first.exchange('connector',{worker_label:`alpha~session-${a}`,wake_nonce:'n'.repeat(32)},undefined,conversation);assert.ok(work.state==='request');
  await first.exchange('connector',{worker_label:`alpha~session-${a}`,wake_nonce:'n'.repeat(32),request_id:work.request!.request_id,claim_token:work.request!.claim_token,response:'A'},undefined,conversation);await job;
  first.workers.clear();
  await assert.rejects(first.exchange('connector',{worker_label:`alpha~session-${b}`,wake_nonce:'n'.repeat(32)},undefined,conversation),fault(409));first.close();
  const restored=new Gateway(cfg,{pollMs:1});t.after(()=>restored.close());
  await assert.rejects(restored.exchange('connector',{worker_label:`alpha~session-${b}`,wake_nonce:'n'.repeat(32)},undefined,conversation),fault(409));
  await assert.rejects(restored.exchange('connector',{worker_label:'alpha'},undefined,conversation),fault(409));
  await restored.exchange('connector',{worker_label:'alpha'},undefined,'d'.repeat(22));
  restored.workers.clear();await assert.rejects(restored.exchange('connector',{worker_label:`alpha~session-${b}`,wake_nonce:'n'.repeat(32)},undefined,'d'.repeat(22)),fault(409));
});

test('Pi standard store false is accepted and normalized while provider-side storage stays refused',()=>{
  assert.deepEqual(validateRequest({...request(),store:false},'chatgpt'),request());
  assert.throws(()=>validateRequest({...request(),store:true},'chatgpt'),fault(400));
});

test('singleton omitted worker label resolves canonically and explicit replies share the same worker',async t=>{
  const g=new Gateway({prefix:'chatgpt',labels:{sol:{row:'Latest',level:2}}},{pollMs:2,timeoutMs:1000});t.after(()=>g.close());
  assert.equal((await g.exchange('c',{maximum_wait_seconds:1})).worker_label,'sol');
  const promise=g.submit(request('sol'));
  const work=await g.exchange('c',{maximum_wait_seconds:1});assert.equal(work.state,'request');assert.equal(work.worker_label,'sol');
  if(work.state !== 'request') throw Error('Expected work');
  const answer=await g.exchange('c',{worker_label:'sol',request_id:work.request!.request_id,claim_token:work.request!.claim_token,response:'answer',maximum_wait_seconds:1});
  assert.equal(answer.worker_label,'sol');assert.equal((await promise).choices[0].message.content,'answer');assert.equal(g.workers.size,1);
  g.close();assert.equal((await g.exchange('c',{})).worker_label,'sol');
});

test('omitted labels fail closed with multiple labels, replicas, remembered scopes or no identities',async t=>{
  for(const config of [{labels:{}},{labels:{a:{},b:{}}},{labels:{a:{replicas:2}}},{labels:{a:{}},session_workers:{'a~session-abc123':{label:'a',scope:'abc123'}}}]) {
    const g=new Gateway({prefix:'chatgpt',...config} as any,{pollMs:2});t.after(()=>g.close());
    await assert.rejects(g.exchange('c',{}),/exactly one effective worker identity/);
  }
});

test('owner cancels queued work without new wakes and keyed retries replay cancellation', async t => {
  let wakes = 0; const audits: any[] = [], abort = new AbortController();
  const g = gateway(t, {waitForWake:true,wake:()=>{wakes++;},audit:(job:any)=>audits.push(structuredClone(job))});
  const pending = g.submit(request(), 'cancel-queued', abort.signal), job = [...g.jobs.values()][0];
  abort.abort(); assert.equal(job.state,'queued'); assert.equal(job.finished,undefined);
  const before = wakes;
  assert.deepEqual(g.cancel({id:job.id}),{id:job.id,label:'alpha',state:'failed',error:'caller_cancelled',was:'queued'});
  await assert.rejects(pending,fault(499,'caller_cancelled'));
  assert.equal(job.error!.message,'Cancelled by the owner'); assert.equal(job.finished,true);
  assert.equal(audits.at(-1).error.code,'caller_cancelled');
  g.prune(); g.resume(); g.status(); assert.equal(wakes,before); assert.equal(g.queued('alpha').length,0);
  assert.strictEqual(g.submit(request(),'cancel-queued'),pending);
  await assert.rejects(g.submit(request(),'cancel-queued'),fault(499,'caller_cancelled'));
});

test('key cancellation uses caller and scope identity, including retry aliases', async t => {
  const g = gateway(t,{waitForWake:true}), caller = 'a'.repeat(22), foreign = 'b'.repeat(22);
  const pending = g.submit(request(),'cancel-key',undefined,{caller,scope:caller});
  assert.strictEqual(g.submit(request(),'cancel-alias',undefined,{caller,scope:caller}),pending);
  assert.throws(()=>g.cancel({key:'cancel-key',caller:foreign,scope:foreign}),fault(404,'job_not_found'));
  assert.throws(()=>g.cancel({key:'cancel-key',caller,scope:foreign}),fault(404,'job_not_found'));
  const job = [...g.jobs.values()][0]; assert.equal(job.state,'queued');
  assert.equal(g.cancel({key:'cancel-alias',caller,scope:caller}).id,job.id);
  await assert.rejects(pending,fault(499,'caller_cancelled'));
  await assert.rejects(g.submit(request(),'cancel-key',undefined,{caller,scope:caller}),fault(499,'caller_cancelled'));
});

test('cancelling a claimed job frees capacity and a late completion cannot resurrect it', async t => {
  const g = gateway(t,{waitForWake:true});
  const pending = g.submit(request(),'cancel-claimed'), claimed = await awake(g), job = [...g.jobs.values()][0];
  assert.equal(g.capacity().claimed,1);
  assert.equal(g.cancel({id:job.id}).was,'claimed');
  await assert.rejects(pending,fault(499,'caller_cancelled'));
  const record = structuredClone(g.record(job));
  assert.equal(g.workers.get('alpha')!.active,null); assert.equal(g.capacity().claimed,0);
  const late = await complete(g,claimed);
  assert.equal(late.state,'recovery'); assert.equal(late.code,'request_cancelled'); assert.equal(late.next_action,'poll');
  assert.deepEqual(g.record(job),record);
  const next = g.submit(request('alpha',{messages:[{role:'user',content:'Next job'}]}),'after-cancel');
  const work = await awake(g); assert.notEqual(work.request.request_id,job.id);
  await complete(g,work); assert.equal((await next).choices[0].message.content,'Answer');
});

test('finished and unknown job cancellation refuse without changing records', async t => {
  const g = gateway(t,{waitForWake:true});
  assert.throws(()=>g.cancel({id:'x'.repeat(32)}),fault(404,'job_not_found'));
  assert.throws(()=>g.cancel({key:'unknown',caller:'a'.repeat(22),scope:'a'.repeat(22)}),fault(404,'job_not_found'));
  const pending = g.submit(request(),'finished-cancel'), claimed = await awake(g);
  await complete(g,claimed); await pending;
  const completed = [...g.jobs.values()][0], before = structuredClone(g.record(completed));
  assert.throws(()=>g.cancel({id:completed.id}),fault(409,'job_finished')); assert.deepEqual(g.record(completed),before);
  const failed = g.submit(request(),'already-cancelled'), job = [...g.jobs.values()].at(-1)!;
  g.cancel({id:job.id}); await assert.rejects(failed,fault(499,'caller_cancelled'));
  const failedBefore = structuredClone(g.record(job));
  assert.throws(()=>g.cancel({id:job.id}),fault(409,'job_finished')); assert.deepEqual(g.record(job),failedBefore);
});

test('a cancellation persistence failure preserves the queued job for a safe retry', async t => {
  let fail = false;
  const g = gateway(t,{waitForWake:true,save:()=>{if(fail)throw Error('injected write failure');}});
  const pending = g.submit(request(),'cancel-write'), job = [...g.jobs.values()][0], before = structuredClone(g.record(job));
  fail = true; assert.throws(()=>g.cancel({id:job.id}),/injected write failure/);
  assert.deepEqual(g.record(job),before); assert.strictEqual(g.submit(request(),'cancel-write'),pending);
  fail = false; g.cancel({id:job.id}); await assert.rejects(pending,fault(499,'caller_cancelled'));
});

test('six scoped pre-wake Pi calls fail after an extension poll outage without claiming capacity', async t => {
  let now = 10000;
  const g = gateway(t, {now: () => now, waitForWake: true, extensionLastActivity: () => undefined, extensionGraceMs: 1000});
  const requests = Array.from({length: 6}, (_, i) => {
    const caller = String(i).repeat(22);
    return g.submit(request(), undefined, undefined, {caller, scope: caller});
  });
  assert.equal(g.capacity().claimed, 0);
  assert.equal(g.status().find(w => w.label === 'alpha')!.queued, 6);
  now += 999; g.prune();
  assert.equal(g.queued('alpha', '0'.repeat(22)).length, 1);
  now++; g.prune();
  for (const result of requests) await assert.rejects(result, fault(503, 'extension_unavailable'));
  assert.equal(g.status().find(w => w.label === 'alpha')!.queued, 0);
  assert.equal(g.capacity().claimed, 0);
  const caller = '0'.repeat(22);
  const fresh = g.submit(request(), undefined, undefined, {caller, scope: caller});
  assert.equal(g.jobs.size, 7, 'a retry after the terminal failure creates a new job');
  g.close(); await assert.rejects(fresh, fault(503, 'host_stopped'));
});

test('unkeyed scoped content dedupe reference-counts separate transports and cancels only its last queued waiter', async t => {
  const g = gateway(t, {waitForWake: true});
  const caller = 'a'.repeat(22), a = new AbortController(), b = new AbortController();
  const first = g.submit(request(), undefined, a.signal, {caller, scope: caller});
  const second = g.submit(request(), undefined, b.signal, {caller, scope: caller});
  assert.notStrictEqual(first, second, 'each transport must settle independently');
  assert.equal(g.jobs.size, 1);
  a.abort(); await assert.rejects(first, fault(499, 'caller_cancelled'));
  assert.equal(g.queued('alpha', caller).length, 1, 'one surviving transport retains the job');
  b.abort(); await assert.rejects(second, fault(499, 'caller_cancelled'));
  assert.equal(g.queued('alpha', caller).length, 0);
  const c = new AbortController();
  const again = g.submit(request(), undefined, c.signal, {caller, scope: caller});
  assert.notStrictEqual(again, first);
  c.abort(); await assert.rejects(again, fault(499, 'caller_cancelled'));
});

test('scoped waiter can disconnect while another stays to receive a worker answer; claimed work survives final disconnect', async t => {
  const g = gateway(t, {waitForWake: true});
  const caller = 'b'.repeat(22), a = new AbortController(), b = new AbortController();
  const first = g.submit(request(), undefined, a.signal, {caller, scope: caller});
  const second = g.submit(request(), undefined, b.signal, {caller, scope: caller});
  a.abort(); await assert.rejects(first, fault(499, 'caller_cancelled'));
  const identity = 'alpha~session-' + caller;
  const work = await g.exchange('connector', {worker_label: identity, wake_nonce: 'n'.repeat(32)}, undefined, 'chat-1');
  if (work.state !== 'request') assert.fail('Expected scoped job claim');
  const committed = g.jobs.get(work.request.request_id)!.promise;
  b.abort(); await assert.rejects(second, fault(499, 'caller_cancelled'));
  assert.equal(g.jobs.get(work.request.request_id)!.state, 'claimed');
  await g.exchange('connector', {worker_label: identity, wake_nonce: 'n'.repeat(32), request_id: work.request.request_id, claim_token: work.request.claim_token, response: 'complete'}, undefined, 'chat-1');
  assert.equal((await committed).choices[0].message.content, 'complete');
});

test('explicit retry key added to an unkeyed scoped job makes it durable across all disconnects and restart', async t => {
  let state: any = {version: 1, jobs: []};
  const caller = 'c'.repeat(22), a = new AbortController(), b = new AbortController();
  const config = {prefix:'chatgpt', labels:{alpha:{row:'Latest', level:0}}};
  const g = new Gateway(config, {waitForWake:true, save: rows => {state = structuredClone(rows);}});
  const first = g.submit(request(), undefined, a.signal, {caller, scope: caller});
  const keyed = g.submit(request(), 'explicit-retry', b.signal, {caller, scope: caller});
  assert.notStrictEqual(first, keyed);
  a.abort(); await assert.rejects(first, fault(499, 'caller_cancelled'));
  b.abort();
  assert.equal(g.queued('alpha', caller).length, 1);
  g.close(); await assert.rejects(keyed, fault(503, 'host_stopped'));
  const restored = new Gateway(config, {waitForWake:true, records:state}); t.after(() => restored.close());
  const persisted = [...restored.jobs.values()][0];
  assert.equal(persisted.state, 'queued');
  assert.strictEqual(restored.submit(request(), 'explicit-retry', undefined, {caller, scope: caller}), persisted.promise);
});

test('restart discards unkeyed orphaned scoped queue, but extension cold start and authenticated activity allow a grace window', async t => {
  let state: any = {version: 1, jobs: []}, now = 5000, lastPoll: number | undefined;
  const caller = 'd'.repeat(22);
  const cfg = {prefix: 'chatgpt', labels: {alpha: {row:'Latest', level:0}}};
  const g = new Gateway(cfg, {waitForWake:true, now: () => now, extensionLastActivity: () => lastPoll, extensionGraceMs: 1000, save: rows => {state = structuredClone(rows);}});
  const first = g.submit(request(), undefined, undefined, {caller, scope: caller});
  now += 900; g.prune(); assert.equal(g.queued('alpha', caller).length, 1, 'cold start has a grace window');
  lastPoll = now;
  now += 900; g.prune(); assert.equal(g.queued('alpha', caller).length, 1, 'poll refreshes liveness');
  g.close(); await assert.rejects(first, fault(503, 'host_stopped'));
  const restarted = new Gateway(cfg, {waitForWake:true, now: () => now, extensionLastActivity: () => lastPoll, extensionGraceMs: 1000, records:state});
  t.after(() => restarted.close());
  assert.equal([...restarted.jobs.values()][0].error?.code, 'caller_cancelled');
  assert.equal(restarted.queued('alpha', caller).length, 0);
});

test('extension liveness timeout does not bypass quotas, durable jobs or other queue semantics', async t => {
  let now = 10000, lastPoll: number | undefined = now;
  const cfg = {prefix:'chatgpt',labels:{alpha:{row:'Latest',level:0}},quota_until:{alpha:0}};
  const g = new Gateway(cfg, {waitForWake:true, now:()=>now, extensionLastActivity:()=>lastPoll, extensionGraceMs:1000});
  t.after(()=>g.close());
  const caller = 'e'.repeat(22);
  const key = g.submit(request(), 'durable', undefined, {caller, scope: caller});
  const limited = g.submit(request('alpha',{messages:[{role:'user',content:'Unkeyed'}]}), undefined, undefined, {caller, scope: caller});
  now += 900; lastPoll = now;
  now += 900; g.prune();
  assert.equal(g.queued('alpha', caller).length, 2, 'live extension does not kill queued work');
  cfg.quota_until.alpha = now + 5000;
  assert.throws(()=>g.submit(request('alpha',{messages:[{role:'user',content:'Blocked'}]}),undefined,undefined,{caller,scope:caller}),fault(429,'quota_blocked'));
  lastPoll = now; now += 900; g.prune();
  assert.equal(g.queued('alpha', caller).length, 2, 'quota pause with ongoing extension contact retains pre-wake work');
  now += 1001; g.prune();
  await assert.rejects(limited, fault(503,'extension_unavailable'));
  assert.equal(g.queued('alpha', caller).length, 1, 'keyed work remains queued under pause');
  g.close(); await assert.rejects(key, fault(503,'host_stopped'));
});

test('pre-claim extension outage fails a scoped HTTP waiter on its timer without status polling', async t => {
  const g = gateway(t, {waitForWake:true, extensionLastActivity: () => undefined, extensionGraceMs:1000});
  const caller = 'f'.repeat(22);
  await assert.rejects(g.submit(request(), undefined, undefined, {caller, scope:caller}), fault(503,'extension_unavailable'));
  assert.equal(g.queued('alpha',caller).length,0);
});

test('restart discards an unidentified unkeyed queue but retains keyed work', async t => {
  let state: any = {version: 1, jobs: []};
  const cfg = {prefix:'chatgpt',labels:{alpha:{row:'Latest',level:0}}};
  const missingInput = request('alpha',{messages:[{role:'user',content:'orphan'}]});
  const keyedInput = request('alpha',{messages:[{role:'user',content:'durable'}]});
  const original = new Gateway(cfg,{waitForWake:true,save:rows=>{state=structuredClone(rows);}});
  const missing = original.submit(missingInput);
  const keyed = original.submit(keyedInput,'preserved-key');
  const snapshot = structuredClone(state); // Simulate restart from a queued on-disk snapshot.
  original.close();
  await assert.rejects(missing,fault(503,'host_stopped'));
  await assert.rejects(keyed,fault(503,'host_stopped'));
  const restored = new Gateway(cfg,{waitForWake:true,records:snapshot});
  t.after(()=>restored.close());
  const orphan = [...restored.jobs.values()].find(j=>j.request.messages[0].content==='orphan');
  assert.equal(orphan?.error?.code,'caller_cancelled');
  assert.equal(restored.queued('alpha').length,1,'keyed request remains durable');
  assert.strictEqual(restored.submit(keyedInput,'preserved-key'),restored.queued('alpha')[0].promise);
});

test('legacy non-scoped caller correlation remains durable across restart without an explicit key', async t => {
  let stored: any = {version: 1, jobs: []};
  const cfg = {prefix:'chatgpt', labels:{alpha:{row:'Latest',level:0}}};
  const caller = 'j'.repeat(22);
  const original = new Gateway(cfg, {waitForWake:true, save: rows => { stored = structuredClone(rows); }});
  const pending = original.submit(request(), undefined, undefined, {caller});
  original.close();
  await assert.rejects(pending, fault(503,'host_stopped'));
  const restored = new Gateway(cfg, {waitForWake:true, records:stored});
  t.after(() => restored.close());
  const job = restored.queued('alpha')[0];
  assert.ok(job);
  assert.equal(job.caller, caller);
  assert.equal(job.error, undefined);
  const replay = restored.submit(request(), undefined, undefined, {caller});
  assert.strictEqual(replay, job.promise);
  const work = await restored.exchange('connector',{worker_label:'alpha'});
  if (work.state !== 'request') assert.fail('Legacy restored caller job not claimed');
  await restored.exchange('connector',{worker_label:'alpha',request_id:work.request.request_id,claim_token:work.request.claim_token,response:'restored',maximum_wait_seconds:1});
  assert.equal((await replay).choices[0].message.content,'restored');
});

test('warm scoped worker keeps new requests through long generation and active poll without extension contact', async t => {
  let now = 10000;
  const g = gateway(t,{now:()=>now,waitForWake:true,timeoutMs:300000,extensionLastActivity:()=>undefined,extensionGraceMs:1000,leaseMs:600000});
  const caller = 'w'.repeat(22), identity = 'alpha~session-'+caller, wake_nonce = 'n'.repeat(32);
  const first = g.submit(request(),undefined,undefined,{caller,scope:caller});
  const claim = await g.exchange('connector',{worker_label:identity,wake_nonce,maximum_wait_seconds:1},undefined,'warm-worker');
  if (claim.state !== 'request') assert.fail('Warm worker did not claim');
  now += 91000; // Generation extends beyond the browser's ordinary grace.
  const second = g.submit(request('alpha',{messages:[{role:'user',content:'second'}]}),undefined,undefined,{caller,scope:caller});
  g.prune();
  assert.equal(g.queued('alpha',caller).length,1,'active generation needs no second browser wake');
  const next = await g.exchange('connector',{worker_label:identity,wake_nonce,request_id:claim.request.request_id,claim_token:claim.request.claim_token,response:'first',maximum_wait_seconds:1},undefined,'warm-worker');
  if (next.state !== 'request') assert.fail('Warm worker did not take next queued request');
  assert.equal((await first).choices[0].message.content,'first');
  const poll = g.exchange('connector',{worker_label:identity,wake_nonce,request_id:next.request.request_id,claim_token:next.request.claim_token,response:'second',maximum_wait_seconds:1},undefined,'warm-worker');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(g.workers.get(identity)?.polling,true);
  now += 91000; // An existing scoped poll remains usable without an extension heartbeat.
  const third = g.submit(request('alpha',{messages:[{role:'user',content:'third'}]}),undefined,undefined,{caller,scope:caller});
  g.prune();
  assert.equal(g.queued('alpha',caller).length,1);
  const final = await poll;
  if (final.state !== 'request') assert.fail('Warm poll did not receive the third request');
  assert.equal((await second).choices[0].message.content,'second');
  await g.exchange('connector',{worker_label:identity,wake_nonce,request_id:final.request.request_id,claim_token:final.request.claim_token,response:'third',maximum_wait_seconds:1},undefined,'warm-worker');
  assert.equal((await third).choices[0].message.content,'third');
});

test('suppressed scoped liveness checks never rearm millisecond timers and close clears pending waiters', async t => {
  let now = 10000;
  const g = new Gateway({prefix:'chatgpt',labels:{alpha:{row:'Latest',level:0}}},{now:()=>now,waitForWake:true,extensionLastActivity:()=>undefined,extensionGraceMs:1000});
  const caller = 't'.repeat(22);
  const pending = g.submit(request(),undefined,undefined,{caller,scope:caller});
  const job = g.queued('alpha',caller)[0];
  assert.ok(job);
  now += 91000;
  const workerId='alpha~session-'+caller;
  g.workers.set(workerId,{label:'alpha',client:'connector',seen:now-91000,polling:true,active:null});
  g.armExtensionWait(job);
  const timer = job.timer as NodeJS.Timeout;
  assert.ok((timer as any)._idleTimeout >= 1000,'a warm worker must not trigger a busy timer loop');
  assert.equal(g.extensionStalled(job),false);
  g.close();
  await assert.rejects(pending,fault(503,'host_stopped'));
  assert.equal((timer as any)._destroyed,true,'shutdown cancels the liveness timer');
});

test('claimed timer frees all four full slots and wakes a pending sibling without status or prune', async t => {
  const cfg = {prefix:'chatgpt',labels:Object.fromEntries('abcde'.split('').map(name=>[name,{row:'Latest',level:2}]))};
  const g = new Gateway(cfg,{waitForWake:true,timeoutMs:150,leaseMs:1000,pollMs:1000});
  t.after(()=>g.close());
  const active = [];
  for (const name of 'abcd') {
    const result = g.submit(request(name), name+'-key');
    const rejected = assert.rejects(result,fault(503,'uncertain_delivery'));
    const work = await g.exchange('client',{worker_label:name,maximum_wait_seconds:1});
    assert.equal(work.state,'request');
    active.push(rejected);
  }
  assert.equal(g.capacity().claimed,4);
  const pending = g.submit(request('e'),'pending-key');
  const sibling = g.exchange('client',{worker_label:'e',maximum_wait_seconds:1});
  const claim = await sibling;
  assert.equal(claim.state,'request','real timer must notify waiting sibling');
  assert.ok(g.capacity().claimed>=1 && g.capacity().claimed<=4);
  await Promise.all(active);
  assert.equal(g.capacity().claimed,1);
  assert.equal(g.capacity().limit,4);
  if(claim.state!=='request') throw Error('Missing sibling claim');
  await g.exchange('client',{worker_label:'e',request_id:claim.request.request_id,claim_token:claim.request.claim_token,response:'sibling',maximum_wait_seconds:1});
  assert.equal((await pending).choices[0].message.content,'sibling');
});

test('injected clock expires worker contact lease separately from the absolute deadline', async t => {
  let now=1000;
  const g=gateway(t,{now:()=>now,waitForWake:true,timeoutMs:400,leaseMs:60});
  const result=g.submit(request(),'lease-only');
  const work=await awake(g);
  assert.equal(work.state,'request');
  now+=59;g.prune();
  assert.equal(g.capacity().claimed,1);
  now++;g.prune();
  assert.equal(g.capacity().claimed,0);
  await assert.rejects(result,fault(503,'uncertain_delivery'));
  assert.equal((await complete(g,work)).code,'request_cancelled');
});

test('repeated active polls cannot carry a claim beyond its hard deadline', async t => {
  let now=0;
  const g=gateway(t,{now:()=>now,waitForWake:true,timeoutMs:80,leaseMs:30});
  const result=g.submit(request(),'hard-deadline');
  const work=await awake(g);
  assert.equal(work.state,'request');
  for(const tick of [15,28,55,79]) {
    now=tick;
    const repeat=await awake(g);
    assert.equal(repeat.request?.request_id,work.request.request_id);
    assert.ok(g.jobs.get(work.request.request_id)!.leaseUntil!<=80);
  }
  now=80;
  assert.equal((await complete(g,work,{response:'too late'})).code,'request_cancelled');
  await assert.rejects(result,fault(503,'uncertain_delivery'));
  assert.equal(g.capacity().claimed,0);
  assert.strictEqual(g.submit(request(),'hard-deadline'),result);
  assert.notEqual((await awake(g)).state,'request','expired claim cannot reappear on an empty old-worker poll');
});

test('early real timer firing under an injected clock reschedules to check again', async t => {
  let now=0;
  const g=gateway(t,{now:()=>now,waitForWake:true,timeoutMs:100,leaseMs:35});
  const result=g.submit(request(),'early-timer');
  const claim=await awake(g);
  assert.equal(claim.state,'request');
  await new Promise(resolve=>setTimeout(resolve,45));
  assert.equal(g.capacity().claimed,1,'wall timer is early while injected clock has not advanced');
  now=35;
  await assert.rejects(result,fault(503,'uncertain_delivery'));
  assert.equal(g.capacity().claimed,0);
});

test('four concurrent scoped claims across two sessions respect capacity and fresh nonce recovery', async t => {
  let now=1000;
  const cfg={prefix:'chatgpt',labels:{alpha:{replicas:2,row:'Latest',level:2}}};
  const g=new Gateway(cfg,{now:()=>now,waitForWake:true,timeoutMs:500,leaseMs:100,pollMs:2,authorizeWorker:()=>{}});
  t.after(()=>g.close());
  const entries:any[]=[];
  for (const scope of ['a'.repeat(22),'b'.repeat(22)]) for(let i=1;i<=2;i++) {
    const textValue=scope[0]+i;
    const result=g.submit(request('alpha',{messages:[{role:'user',content:textValue}]}),textValue,undefined,{caller:scope,scope});
    const rejected=assert.rejects(result,fault(503,'uncertain_delivery'));
    const identity='alpha~session-'+scope+(i===2?'~replica-2':'');
    const work=await g.exchange('connector',{worker_label:identity,wake_nonce:'n'.repeat(32),maximum_wait_seconds:1},undefined,'chat-'+textValue);
    assert.equal(work.state,'request');
    entries.push({identity,work,rejected});
  }
  assert.equal(g.capacity().claimed,4);
  const scope='a'.repeat(22);
  const fifth=g.submit(request('alpha',{messages:[{role:'user',content:'fifth'}]}),'fifth',undefined,{caller:scope,scope});
  assert.equal(g.capacity().claimed,4);
  now=1100;g.prune();
  await Promise.all(entries.map(x=>x.rejected));
  assert.equal(g.capacity().claimed,0);
  const expired=await g.exchange('connector',{worker_label:entries[0].identity,wake_nonce:'n'.repeat(32),maximum_wait_seconds:1},undefined,'chat-a1');
  assert.equal(expired.state,'released','old scoped conversation cannot claim fifth');
  const fresh=await g.exchange('connector',{worker_label:entries[0].identity,wake_nonce:'m'.repeat(32),maximum_wait_seconds:1},undefined,'chat-fresh');
  assert.equal(fresh.state,'request');
  if(fresh.state!=='request') throw Error('Missing fresh scoped claim');
  assert.notEqual(fresh.request.request_id,entries[0].work.request.request_id);
  await g.exchange('connector',{worker_label:entries[0].identity,wake_nonce:'m'.repeat(32),request_id:fresh.request.request_id,claim_token:fresh.request.claim_token,response:'fresh',maximum_wait_seconds:1},undefined,'chat-fresh');
  assert.equal((await fifth).choices[0].message.content,'fresh');
});

test('file output completing after claim deadline cannot commit or leak output ownership', async t => {
  let now=0, finishDownload:(value:any)=>void=()=>{};
  const removed:string[]=[];
  const files={
    outputs:()=>new Promise(resolve=>{finishDownload=resolve;}),
    removeOwner:(_id:string,kind?:string)=>removed.push(kind??'all')
  };
  const g=gateway(t,{now:()=>now,waitForWake:true,timeoutMs:100,leaseMs:1000,files});
  const result=g.submit(request(),'file-race');
  const claim=await awake(g);
  assert.equal(claim.state,'request');
  const completion=g.exchange('client_a',{worker_label:'alpha',request_id:claim.request.request_id,claim_token:claim.request.claim_token,response:'download',files:[{url:'https://example.invalid/test',name:'file.txt'}],maximum_wait_seconds:1});
  await new Promise(resolve=>setImmediate(resolve));
  now=100;
  finishDownload([{id:'file-id',name:'file.txt',mime:'text/plain',bytes:5}]);
  await assert.rejects(completion,fault(409,'stale_claim'));
  await assert.rejects(result,fault(503,'uncertain_delivery'));
  assert.equal(g.jobs.get(claim.request.request_id)!.state,'failed');
  assert.ok(removed.includes('output'));
});

test('prune, timer, and late duplicate race produce only one terminal record', async t => {
  let now=0;
  const terminal:any[]=[];
  const g=gateway(t,{now:()=>now,waitForWake:true,timeoutMs:50,leaseMs:50,audit:(j:any)=>{if(j.finished)terminal.push(j);}});
  const result=g.submit(request(),'terminal-race');
  const work=await awake(g);
  assert.equal(work.state,'request');
  now=50;g.prune();g.prune();
  await assert.rejects(result,fault(503,'uncertain_delivery'));
  assert.equal((await complete(g,work)).code,'request_cancelled');
  assert.equal((await complete(g,work)).code,'request_cancelled');
  assert.equal(terminal.length,1);
  assert.equal(terminal[0].error.code,'uncertain_delivery');
  assert.strictEqual(g.submit(request(),'terminal-race'),result);
});

test('ordinary queued work gets a full per-claim deadline when finally claimed', async t => {
  let now=0;
  const g=gateway(t,{now:()=>now,timeoutMs:1000,unclaimedMs:900,leaseMs:2000});
  const result=g.submit(request(),'queue-delay');
  now=600;
  const work=await awake(g);
  assert.equal(work.state,'request');
  assert.equal(g.jobs.get(work.request.request_id)!.deadline,1600);
  now=1599;g.prune();assert.equal(g.capacity().claimed,1);
  now=1600;g.prune();assert.equal(g.capacity().claimed,0);
  await assert.rejects(result,fault(503,'uncertain_delivery'));
});

test('long multi-turn session grants a fresh deadline for each separately claimed job', async t => {
  let now=1000;
  const g=gateway(t,{now:()=>now,waitForWake:true,timeoutMs:100,leaseMs:200});
  for(let round=0;round<3;round++){
    const result=g.submit(request('alpha',{messages:[{role:'user',content:'turn-'+round}]}),'turn-'+round);
    const claimed=await awake(g);
    assert.equal(claimed.state,'request');
    const job=g.jobs.get(claimed.request.request_id)!;
    assert.equal(job.deadline,now+100);
    now+=90;
    await complete(g,claimed,{response:'answer-'+round});
    assert.equal((await result).choices[0].message.content,'answer-'+round);
  }
  assert.equal(g.capacity().claimed,0);
});
