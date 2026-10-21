import test from 'node:test';
import assert from 'node:assert/strict';
import {Gateway} from '../src/gateway.ts';
import {Wakes, wakeLimits, wakeDeferred, wakeRetryDelay} from '../src/wake.ts';
import type {Config} from '../src/types.ts';

const base = (cap = 12): Config => ({
  prefix: 'chatgpt', connector: 'Crossfeed', wake_daily_cap: 0, wake_hourly_cap: cap,
  max_claimed_jobs: 4,
  labels: Object.fromEntries(['alpha', 'beta', 'gamma', 'delta', 'epsilon']
    .map(label => [label, {row: 'Latest', level: 2}])),
});
const request = (label: string) => ({
  model: 'chatgpt:' + label, messages: [{role: 'user' as const, content: 'synthetic nonsecret probe'}],
});

test('12 versus explicitly configured 64 rolling-hour admission keeps the existing wake ledger', () => {
  const now = Date.parse('2026-10-13T07:42:52.000Z');
  const oldest = Date.parse('2026-10-13T06:45:35.827Z');
  const cfg = base(12);
  cfg.wake_state = {wakes: [oldest, ...Array.from({length: 11}, (_, i) => oldest + (i + 1) * 100000)],
    failed: {}, archives: [], cooldown_until: 0};
  const before = structuredClone(cfg.wake_state);
  const cap12 = wakeLimits(cfg, now);
  assert.equal(cap12.hourly_attempts, 12);
  assert.equal(cap12.hourly_reset_at, oldest + 3600000);
  assert.match(cap12.blocked!, /Hourly fresh-chat cap \(12\)/);
  cfg.wake_hourly_cap = 64;
  const cap64 = wakeLimits(cfg, now);
  assert.equal(cap64.blocked, null);
  assert.equal(cap64.hourly_attempts, 12);
  assert.equal(cap64.hourly_cap, 64);
  assert.deepEqual(cfg.wake_state, before, 'changing cap must not erase prior attempts');
  cfg.wake_hourly_cap = 12;
  assert.equal(wakeLimits(cfg, oldest + 3600000 - 1).blocked !== null, true);
  assert.equal(wakeLimits(cfg, oldest + 3600000).blocked, null, 'oldest attempt rolls off at exact boundary');
  assert.equal(cfg.wake_state.wakes.length, 12, 'report calculation never rewrites persistent ledger');
});

test('30-second alarm phase adds up to 30 seconds after rolling reset, not a guaranteed exact reopen', () => {
  const reset = Date.parse('2026-10-13T07:45:35.827Z');
  const anchor = Date.parse('2026-10-13T07:45:05.822Z');
  const firstTick = anchor + Math.ceil((reset - anchor) / 30000) * 30000;
  assert.equal(new Date(firstTick).toISOString(), '2026-10-13T07:46:05.822Z');
  assert(firstTick >= reset && firstTick - reset < 30000);
  // This tick arithmetic is a scheduling model, not measured Chrome alarm delivery.
});

test('one global issued/claimed ticket causes up-to-240-second head-of-line blocking', () => {
  let now = 1000000;
  const cfg = base(64);
  const wakes = new Wakes(cfg, () => now);
  wakes.enqueue('alpha', null, true);
  wakes.enqueue('beta', null, true);
  const first = wakes.next().ticket!;
  assert.equal(first.label, 'alpha');
  assert.equal(first.expires_at, now + 240000);
  assert.equal(wakeLimits(cfg, now).hourly_attempts, 1);
  wakes.claim(first.nonce);
  assert.equal(wakes.next().ticket, null);
  now += 239999;
  assert.equal(wakes.next().ticket, null);
  now++;
  const second = wakes.next().ticket!;
  assert.equal(second.label, 'beta');
  assert.equal(second.expires_at, now + 240000);
  assert.equal(wakes.status()[0].state, 'expired');
  assert.equal(wakeLimits(cfg, now).hourly_attempts, 2, 'expired issued wake still consumes hourly budget');
});

test('per-label failure backoff skips a stalled candidate without blocking another label', () => {
  let now = 1000000;
  const cfg = base(64);
  const wakes = new Wakes(cfg, () => now);
  wakes.enqueue('alpha', null, true);
  const first = wakes.next().ticket!;
  wakes.claim(first.nonce);
  wakes.result({nonce: first.nonce, ok: false, error: 'page_not_ready'});
  assert.equal(wakeRetryDelay(cfg, 'alpha'), 60000);
  wakes.enqueue('alpha', null, true);
  wakes.enqueue('beta', null, true);
  assert.equal(wakeDeferred(cfg, 'alpha', now), true);
  assert.equal(wakeDeferred(cfg, 'beta', now), false);
  assert.equal(wakes.next().ticket?.label, 'beta');
  assert.equal(cfg.wake_state!.failed_attempts!.alpha, 1);
  assert.equal(cfg.wake_state!.wakes.length, 2);
  // Backoff and failure count attach to the routing label, not a caller scope.
});

test('four globally claimed jobs remain the capacity ceiling even when hourly wake cap is 64', async t => {
  const cfg = base(64);
  const gateway = new Gateway(cfg, {waitForWake: true, pollMs: 2, leaseMs: 10000});
  t.after(() => gateway.close());
  const names = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
  const answers = names.map(name => gateway.submit(request(name), 'probe-' + name));
  for (const answer of answers) answer.catch(() => {});
  const claimed = [];
  for (const name of names.slice(0, 4)) {
    const reply = await gateway.exchange('connector', {worker_label: name, maximum_wait_seconds: 1});
    if (reply.state !== 'request') throw new Error('expected claimed work');
    claimed.push({name, requestId: reply.request.request_id, claimToken: reply.request.claim_token});
  }
  assert.deepEqual(gateway.capacity(), {claimed: 4, limit: 4});
  const blocked = await gateway.exchange('connector', {worker_label: 'epsilon', maximum_wait_seconds: 1});
  assert.notEqual(blocked.state, 'request');
  assert.equal(gateway.capacity().claimed, 4);
  const first = claimed[0];
  await gateway.exchange('connector', {worker_label: 'alpha', request_id: first.requestId,
    claim_token: first.claimToken, response: 'done', maximum_wait_seconds: 1});
  assert.equal(gateway.capacity().claimed, 3);
  const fifth = await gateway.exchange('connector', {worker_label: 'epsilon', maximum_wait_seconds: 1});
  if (fifth.state !== 'request') throw new Error('expected fifth claim after capacity frees');
  assert.equal(gateway.capacity().claimed, 4);
  for (const {name, requestId, claimToken} of claimed.slice(1)) {
    await gateway.exchange('connector', {worker_label: name, request_id: requestId,
      claim_token: claimToken, response: 'done', maximum_wait_seconds: 1});
  }
  await gateway.exchange('connector', {worker_label: 'epsilon', request_id: fifth.request.request_id,
    claim_token: fifth.request.claim_token, response: 'done', maximum_wait_seconds: 1});
  await Promise.all(answers);
  assert.equal(gateway.capacity().claimed, 0);
  assert.equal(cfg.wake_hourly_cap, 64);
});
