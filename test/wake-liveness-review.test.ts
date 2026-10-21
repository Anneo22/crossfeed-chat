import test from 'node:test';
import assert from 'node:assert/strict';
import { Gateway } from '../src/gateway.ts';

const config = () => ({prefix: 'chatgpt', labels: {alpha: {row: 'Latest', level: 0}}});
const request = (content: string) => ({model: 'chatgpt:alpha', messages: [{role: 'user', content}]});
const identityFor = (caller: string) => 'alpha~session-' + caller;

test('review: preclaim startup failure is durably terminal across restart and cannot be claimed later', async t => {
  let now = 1000;
  let saved: any = {version: 1, jobs: []};
  const caller = 'x'.repeat(22);
  const options = {
    now: () => now, waitForWake: true, startupMs: 200, extensionGraceMs: 1000,
    extensionLastActivity: () => now,
    save: (next: any) => { saved = structuredClone(next); },
    authorizeWorker: () => {},
  };
  const first = new Gateway(config(), options);
  t.after(() => first.close());
  const pending = first.submit(request('one unkeyed request'), undefined, undefined, {caller, scope: caller});
  const original = first.queued('alpha', caller)[0];
  assert.ok(original);
  now += 200;
  first.prune();
  await assert.rejects(pending, (error: any) => error.code === 'wake_stalled' && error.status === 503);
  assert.equal(saved.jobs.find((job: any) => job.id === original.id)?.error?.code, 'wake_stalled');
  assert.equal(saved.jobs.find((job: any) => job.id === original.id)?.finished, true);
  first.close();
  const restarted = new Gateway(config(), {...options, records: saved});
  t.after(() => restarted.close());
  assert.equal(restarted.jobs.get(original.id)?.state, 'failed');
  const late = await restarted.exchange('connector', {
    worker_label: identityFor(caller), wake_nonce: 'a'.repeat(32), maximum_wait_seconds: 1,
  }, AbortSignal.abort(), 'late-review-chat');
  assert.notEqual(late.state, 'request', 'an expired, persisted queue entry cannot reenter a claim');
  assert.equal(restarted.capacity().claimed, 0);
});

test('review: hard claim expiry fences nonce after worker eviction and never replays a keyed result', async t => {
  let now = 1000;
  const caller = 'y'.repeat(22), identity = identityFor(caller);
  const staleNonce = 's'.repeat(32), freshNonce = 'f'.repeat(32);
  const allowed = new Set([staleNonce, freshNonce]);
  const fences: string[] = [];
  const gateway = new Gateway(config(), {
    now: () => now, waitForWake: true, timeoutMs: 300, leaseMs: 50,
    authorizeWorker: (_identity, nonce) => { assert.ok(allowed.has(nonce!), 'fenced nonce must not authorize'); },
    expireWake: (_identity, nonce) => { allowed.delete(nonce!); fences.push(nonce!); },
  });
  t.after(() => gateway.close());
  const original = gateway.submit(request('first'), 'original-key', undefined, {caller, scope: caller});
  const rejected = assert.rejects(original, (error: any) => error.code === 'uncertain_delivery' && error.status === 503);
  const claimed = await gateway.exchange('connector', {
    worker_label: identity, wake_nonce: staleNonce, maximum_wait_seconds: 1,
  }, undefined, 'stale-review-chat');
  assert.equal(claimed.state, 'request');
  assert.equal(gateway.capacity().claimed, 1);
  now += 50;
  gateway.prune();
  await rejected;
  assert.deepEqual(fences, [staleNonce]);
  assert.equal(gateway.capacity().claimed, 0);
  assert.strictEqual(gateway.submit(request('first'), 'original-key', undefined, {caller, scope: caller}), original);
  gateway.workers.delete(identity); // Simulate ordinary expired-worker in-memory eviction.
  const followup = gateway.submit(request('second'), 'followup-key', undefined, {caller, scope: caller});
  await assert.rejects(gateway.exchange('connector', {
    worker_label: identity, wake_nonce: staleNonce, maximum_wait_seconds: 1,
  }, undefined, 'stale-review-chat'), /fenced nonce/);
  assert.equal(gateway.capacity().claimed, 0);
  const fresh = await gateway.exchange('connector', {
    worker_label: identity, wake_nonce: freshNonce, maximum_wait_seconds: 1,
  }, undefined, 'fresh-review-chat');
  assert.equal(fresh.state, 'request');
  if (fresh.state !== 'request') throw Error('Fresh nonce failed to claim');
  await gateway.exchange('connector', {
    worker_label: identity, wake_nonce: freshNonce, request_id: fresh.request.request_id,
    claim_token: fresh.request.claim_token, response: 'new answer', maximum_wait_seconds: 1,
  }, AbortSignal.abort(), 'fresh-review-chat');
  assert.equal((await followup).choices[0].message.content, 'new answer');
});
