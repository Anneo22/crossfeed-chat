import { tempPrefix } from './temp.ts';
import test from 'node:test';
import type { WakeConfig } from '../src/types.ts';
import assert from 'node:assert/strict';
import { Wakes, wakeLimits } from '../src/wake.ts';

function fixture(extra: Record<string, any> = {}) {
  let now = 1000, contacts = 0, active = false;
  const failures: any[] = [], writes: any[] = [];
  const config: WakeConfig = { wake_hourly_cap: 1000, connector: 'Crossfeed', labels: { sol: { row: 'Latest', level: 3 }, other: { row: 'Older', level: 1 } }, ...extra };
  const wakes = new Wakes(config, () => now, { save: (state: any) => writes.push(structuredClone(state)), contact: () => contacts, active: () => active, failed: (name: any) => failures.push(name) });
  const poll = () => { contacts++; active = true; };
  const begin = (label = 'sol') => { wakes.enqueue(label); const { ticket } = wakes.next(); wakes.claim(ticket!.nonce); return ticket; };
  const confirm = (ticket: any, id = 'new-chat') => { poll(); return wakes.result({ nonce: ticket.nonce, ok: true, url: `https://chatgpt.com/c/${id}` }); };
  return { config, wakes, writes, failures, begin, confirm, poll, advance: (ms: number) => { now += ms; }, now: () => now };
}

test('one issued wake at a time; queued tickets get a fresh four-minute window', () => {
  const f = fixture(); const first = f.begin(); f.wakes.enqueue('other');
  assert.equal(f.wakes.next().ticket, null);
  f.confirm(first); f.advance(30000);
  const second = f.wakes.next().ticket;
  assert.equal(second!.label, 'other'); assert.equal(second!.expires_at, f.now() + 240000);
});

test('ordinary claim durably locks its mode before allowing a send and fails closed on storage failure', () => {
  const f = fixture(); f.wakes.enqueue('sol'); const issued = f.wakes.next().ticket!;
  const ticket = f.wakes.tickets.get(issued.nonce)!;
  const save = f.wakes.save;
  f.wakes.save = () => { throw Error('storage unavailable'); };
  assert.throws(() => f.wakes.claim(ticket.nonce), /storage unavailable/);
  assert.equal(ticket.state, 'issued'); assert.equal(f.config.wake_state!.worker_modes, undefined);
  f.wakes.save = save; f.wakes.claim(ticket.nonce);
  assert.equal(ticket.state, 'claimed'); assert.equal(f.config.wake_state!.worker_modes!.sol, 'configured');
  assert.equal(f.writes.at(-1).wake_state.worker_modes.sol, 'configured');
});

test('saved row and level without a mode retain the picker; explicit native skips it', () => {
  const native = fixture();
  assert.equal(native.begin()!.wake_mode, 'configured');
  const explicitNative = fixture({labels:{sol:{row:'Latest',level:2,wake_mode:'native'}}});
  assert.equal(explicitNative.begin()!.wake_mode, 'native');
  const configured = fixture({labels:{sol:{row:'Latest',level:2,wake_mode:'configured'}}});
  assert.equal(configured.begin()!.wake_mode, 'configured');
  const composer = fixture(); composer.wakes.jobFinished = () => false;
  composer.wakes.enqueueComposer({id:'composer_1',label:'sol',attachments:[{name:'x.txt',path:'/tmp/x.txt',mime:'text/plain',bytes:1}],expires_at:composer.now()+60000} as any);
  assert.equal(composer.wakes.next().ticket!.wake_mode, 'configured');
});

test('legacy omitted mode does not erase retained historical locks or existing conversation bindings', () => {
  const old = {wakes:[],failed:{},cooldown_until:0,archives:[],worker_modes:{sol:'configured' as const}};
  const f=fixture({wake_state:old,labels:{sol:{row:'Latest',level:2,url:'https://chatgpt.com/c/prior'}}});
  const t=f.begin()!;
  assert.equal(t.wake_mode,'configured');
  assert.equal(f.config.wake_state!.worker_modes!.sol,'configured');
  assert.equal(f.config.labels.sol.url,'https://chatgpt.com/c/prior');
  assert.equal(f.wakes.observation('sol'),null,'a configured wake must await the actual picker receipt');
  f.wakes.observe({nonce:t.nonce,picker_receipt:{row:'Latest',level:2}});
  assert.equal(f.wakes.observation('sol')?.level,2);
});

test('nonce claims and results are single-use and require new worker contact', () => {
  const f = fixture(); f.poll(); const t = f.begin();
  assert.throws(() => f.wakes.claim(t!.nonce), e => e.status === 409);
  assert.equal(f.wakes.check(t!.nonce).registered, false);
  assert.throws(() => f.wakes.result({nonce: t!.nonce, ok: true, url: 'https://chatgpt.com/c/new'}), e => e.status === 409);
  f.confirm(t);
  assert.throws(() => f.wakes.result({nonce: t!.nonce, ok: true, url: 'https://chatgpt.com/c/new'}), e => e.status === 409);
  assert.equal(f.wakes.status()[0].state, 'confirmed');
});

test('replaced chat is persisted in archive queue together with the new URL', () => {
  const f = fixture({ labels: { sol: { row: 'Latest', level: 3, url: 'https://chatgpt.com/c/old' } } });
  f.confirm(f.begin());
  assert.equal(f.config.labels.sol.url, 'https://chatgpt.com/c/new-chat');
  assert.deepEqual(f.config.wake_state!.archives, ['https://chatgpt.com/c/old']);
  assert.equal(f.writes.at(-1).labels.sol.url, f.config.labels.sol.url);
  assert.deepEqual(f.writes.at(-1).wake_state!.archives, f.config.wake_state!.archives);
});

test('delete mode hides only chats confirmed as started by this lane', () => {
  const f = fixture({chat_disposal: 'delete'});
  f.confirm(f.begin(), 'lane-first');
  assert.deepEqual(f.config.wake_state!.started_chats, ['https://chatgpt.com/c/lane-first']);
  f.confirm(f.begin(), 'lane-second');
  const laneCreated = f.wakes.archiveNext().archive!;
  assert.equal(laneCreated.url, 'https://chatgpt.com/c/lane-first');
  assert.equal(laneCreated.remove, true);
  f.wakes.archiveResult({nonce: laneCreated.nonce, ok: true});

  f.config.wake_state!.archives.push('https://chatgpt.com/c/not-started-here');
  const foreign = f.wakes.archiveNext().archive!;
  assert.equal(foreign.url, 'https://chatgpt.com/c/not-started-here');
  assert.equal(foreign.remove, undefined);
});

test('wake tickets carry a sanitized optional caller title', () => {
  const f = fixture();
  f.wakes.enqueue('sol', null, false, '  review\nTask Manager\u202e  ');
  assert.equal(f.wakes.next().ticket!.title, 'review Task Manager');
  const fallback = fixture(); fallback.wakes.enqueue('other');
  assert.equal(fallback.wakes.next().ticket!.title, undefined);
});

test('saved, retained and pending-archive URLs cannot be presented as fresh chats', () => {
  const f = fixture({labels: {sol: {row: 'Latest', level: 3, url: 'https://chatgpt.com/c/old'}, other: {row: 'Latest', level: 2, url: 'https://chatgpt.com/c/other'}}});
  const t = f.begin(); f.poll();
  for (const id of ['old', 'other']) assert.throws(() => f.confirm(t, id), e => e.status === 409);
  assert.throws(() => f.wakes.result({nonce: t!.nonce, ok: true, url: 'https://evil.example/c/new'}));
});

test('failed archives retry after backoff and survive restarting Wakes', () => {
  const f = fixture({labels: {sol: {row: 'Latest', level: 0, url: 'https://chatgpt.com/c/old'}}}); f.confirm(f.begin());
  const first = f.wakes.archiveNext().archive;
  f.wakes.archiveResult({nonce: first!.nonce, ok: false});
  assert.equal(f.wakes.archiveNext().archive, null);
  f.advance(30001); const retry = f.wakes.archiveNext().archive;
  assert.notEqual(retry!.nonce, first!.nonce); assert.equal(retry!.url, first!.url);
  const restarted = new Wakes(f.config, f.now);
  const archive = restarted.archiveNext().archive;
  restarted.archiveResult({nonce: archive!.nonce, ok: true});
  assert.deepEqual(f.config.wake_state!.archives, []);
  assert.throws(() => restarted.archiveResult({nonce: archive!.nonce, ok: true}), e => e.status === 409);
});

test('expired archive leases retry and cannot acknowledge success late', () => {
  const f = fixture({labels: {sol: {row: 'Latest', level: 0, url: 'https://chatgpt.com/c/old'}}}); f.confirm(f.begin());
  const t = f.wakes.archiveNext().archive; f.advance(120001);
  assert.throws(() => f.wakes.archiveResult({nonce: t!.nonce, ok: true}), e => e.status === 409);
  assert.equal(f.wakes.archiveNext().archive!.url, t!.url);
});

test('failure cooldown is per label and retries after one minute, never storing supplied errors', () => {
  const f = fixture(); const t = f.begin(); f.wakes.result({nonce: t!.nonce, ok: false, error: 'secret-page-text'});
  f.wakes.enqueue('sol'); assert.equal(f.wakes.next().ticket, null);
  assert(!JSON.stringify(f.config).includes('secret-page-text'));
  const other = f.begin('other'); f.confirm(other);
  f.advance(600001); assert.ok(f.begin());
});

test('visible rate limit pauses only its label for sixty minutes and survives restart', () => {
  const f = fixture(); f.wakes.result({nonce: f.begin()!.nonce, ok: false, error: 'rate_limited'});
  const restarted = new Wakes(f.config, f.now);
  assert.throws(() => restarted.enqueue('sol'), e => e.code === 'quota_blocked');
  restarted.enqueue('other'); assert.equal(restarted.next().ticket!.label, 'other');
  f.advance(3600001); restarted.enqueue('sol'); assert.equal(restarted.next().ticket!.label, 'sol');
});

test('wake status retains only bounded failure identifiers, including late expiry cleanup', () => {
  for (const late of [false, true]) {
    const f = fixture(), t = f.begin();
    if (late) { f.advance(240000); f.wakes.prune(); }
    f.wakes.result({nonce: t!.nonce, ok: false, error: 'expired', stage: 'picker'});
    assert.deepEqual(f.wakes.status()[0], {label: 'sol', state: late ? 'expired' : 'failed',
      error: 'Fresh-chat wake failed; retry after 1 minute(s)', failure_code: 'expired', failure_stage: 'picker'});
  }
  const f = fixture(), t = f.begin();
  f.wakes.result({nonce: t!.nonce, ok: false, error: 'secret-page-text', stage: 'private-browser-detail'});
  assert(!JSON.stringify(f.wakes.status()).includes('secret-page-text'));
  assert(!JSON.stringify(f.wakes.status()).includes('private-browser-detail'));
});

test('daily cap is durable and charged at issue rather than enqueue', () => {
  const f = fixture({wake_daily_cap: 1}); const first = f.begin(); f.confirm(first);
  const restarted = new Wakes(f.config, f.now); restarted.enqueue('other');
  assert.equal(restarted.next().ticket, null); assert.equal(f.config.wake_state!.wakes.length, 1);
  f.advance(86400001); restarted.enqueue('other'); assert.ok(restarted.next().ticket);
});

test('expired wakes fail waiting jobs and respect cooldown; queue also expires', () => {
  const f = fixture(); const t = f.begin(); f.advance(240001);
  assert.throws(() => f.wakes.claim(t!.nonce), e => e.status === 409);
  assert.equal(f.wakes.status()[0].state, 'expired'); assert.deepEqual(f.failures, ['sol']);
  f.wakes.enqueue('other'); f.advance(900001); f.wakes.prune();
  assert.equal(f.wakes.status().at(-1)!.state, 'expired');
});

test('uncertain fresh-chat send queues orphan cleanup without archiving a retained chat', () => {
  const f = fixture(); const t = f.begin();
  f.wakes.result({nonce: t!.nonce, ok: false, url: 'https://chatgpt.com/c/orphan'});
  assert.deepEqual(f.config.wake_state!.archives, ['https://chatgpt.com/c/orphan']);
});

test('failed persistence does not replace labels or lose the archive queue', () => {
  const f = fixture({labels: {sol: {row: 'Latest', level: 0, url: 'https://chatgpt.com/c/old'}}});
  const t = f.begin(); f.poll(); f.wakes.save = () => { throw Error('disk failure'); };
  assert.throws(() => f.confirm(t));
  assert.equal(f.config.labels.sol.url, 'https://chatgpt.com/c/old'); assert.deepEqual(f.config.wake_state!.archives, []);
  assert.equal(f.wakes.tickets.get(t!.nonce)!.state, 'claimed');
});

test('archive capacity is checked again at delivery so queued wakes cannot overflow durable state', () => {
  const f = fixture();
  f.wakes.enqueue('sol'); f.wakes.enqueue('other');
  f.config.wake_state!.archives = Array.from({length: 256}, (_, i) => `https://chatgpt.com/c/old-${i}`);
  assert.equal(f.wakes.next().ticket, null); assert.deepEqual(f.failures, ['sol', 'other']);
});

test('expired claimed nonce accepts orphan cleanup once without reviving a wake or failing new jobs', () => {
  const f = fixture(); const ticket = f.begin(); f.advance(240000); f.wakes.prune();
  assert.deepEqual(f.failures, ['sol']);
  assert.deepEqual(f.wakes.result({nonce: ticket!.nonce, ok: false, url: 'https://chatgpt.com/c/orphan'}), {ok: true});
  assert.deepEqual(f.config.wake_state!.archives, ['https://chatgpt.com/c/orphan']);
  assert.equal(f.wakes.status()[0].state, 'expired'); assert.deepEqual(f.failures, ['sol']);
  assert.throws(() => f.wakes.result({nonce: ticket!.nonce, ok: false, url: 'https://chatgpt.com/c/orphan'}), e => e.status === 409);
  assert.throws(() => f.wakes.result({nonce: ticket!.nonce, ok: true, url: 'https://chatgpt.com/c/orphan'}), e => e.status === 409);
});

test('expired unclaimed nonce cannot report a newly sent orphan chat', () => {
  const f = fixture(); f.wakes.enqueue('sol'); const ticket = f.wakes.next().ticket;
  f.advance(240000);
  assert.throws(() => f.wakes.result({nonce: ticket!.nonce, ok: false, url: 'https://chatgpt.com/c/orphan'}), e => e.status === 409);
  assert.deepEqual(f.config.wake_state!.archives, []);
});

test('archive failures rotate the queue so an unavailable chat cannot starve other archives', () => {
  const f = fixture(); f.config.wake_state!.archives = ['https://chatgpt.com/c/first', 'https://chatgpt.com/c/second'];
  const first = f.wakes.archiveNext().archive;
  f.wakes.archiveResult({nonce: first!.nonce, ok: false}); f.advance(30001);
  const next = f.wakes.archiveNext().archive; assert.equal(next!.url, 'https://chatgpt.com/c/second');
  f.wakes.archiveResult({nonce: next!.nonce, ok: true}); assert.deepEqual(f.config.wake_state!.archives, [first!.url]);
});

test('quota label churn never saves more records than startup accepts; overflow conservatively pauses work', async t => {
  const {loadConfig, quotaState} = await import('../src/config.ts'); const fs = await import('node:fs');
  const directory = fs.mkdtempSync(tempPrefix('crossfeed-quota-bound-')); t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const f = fixture({prefix: 'chatgpt', wake_daily_cap: 1000});
  for (let index = 0; index < 257; index++) {
    if (index === 128 || index === 256) f.advance(600001);
    const label = 'worker-' + index; f.config.labels = {[label]: {row: 'Latest', level: 0}};
    const ticket = f.begin(label); f.wakes.result({nonce: ticket!.nonce, ok: false, error: 'rate_limited'});
  }
  assert.equal(Object.keys(f.config.quota_until!).length, 256); assert.equal(f.config.quota_pause_until, f.now() + 3600000);
  const loaded = loadConfig(directory, f.writes.at(-1)); assert.equal(loaded.quota_pause_until, f.config.quota_pause_until);
  const restarted = new Wakes(loaded, f.now); assert.throws(() => restarted.enqueue('worker-256'), e => e.code === 'quota_blocked');
  f.advance(3600001); const compacted = quotaState(loaded, 'new-label', f.now()); assert.equal(Object.keys(compacted.quota_until).length, 1);
  restarted.enqueue('worker-256'); assert.ok(restarted.next().ticket);
});

test('replica replacement archives only its own chat, with shared failure cooldown and cap', () => {
  const f = fixture({labels: {sol: {row: 'Latest', level: 3, replicas: 2, url: 'https://chatgpt.com/c/first', replica_urls: {'2': 'https://chatgpt.com/c/second'}}}, wake_daily_cap: 1});
  const ticket = f.begin('sol~replica-2'); f.confirm(ticket, 'replacement');
  assert.equal(f.config.labels.sol.url, 'https://chatgpt.com/c/first');
  assert.equal(f.config.labels.sol.replica_urls!['2'], 'https://chatgpt.com/c/replacement');
  assert.equal(f.config.labels.sol.replicas, 2);
  assert.deepEqual(f.config.wake_state!.archives, ['https://chatgpt.com/c/second']);
  f.wakes.enqueue('sol'); assert.equal(f.wakes.next().ticket, null);
});

test('automatic wake is cancelled without spending cap once waiting demand disappears', () => {
  const config = {labels: {sol: {row: 'Latest', level: 3, replicas: 2}}};
  const wakes = new Wakes(config, Date.now, {needed: () => false});
  wakes.enqueue('sol~replica-2', null, true);
  assert.equal(wakes.next().ticket, null);
  assert.equal(wakes.status()[0].state, 'cancelled');
  assert.equal(wakes.config.wake_state!.wakes.length, 0);
});


test('wake reports pending media after contact and retains only exact connector permission receipts', () => {
  const f = fixture(), ticket = f.begin(); f.poll();
  f.wakes.mediaPending = () => true;
  assert.deepEqual(f.wakes.check(ticket!.nonce), {registered: true, media_pending: true});
  f.wakes.mediaPending = () => false;
  const permissions = [{connector: 'Crossfeed', option: 'Allow Crossfeed for this conversation'}];
  for (const rejected of [[{connector: 'Other', option: 'Always allow'}], [{connector: 'Crossfeed', option: 'Allow once'}], [], [{...permissions[0], extra: 'page text'}]]) {
    assert.throws(() => f.wakes.result({nonce: ticket!.nonce, ok: true, url: 'https://chatgpt.com/c/new', permissions: rejected}), e => e.status === 400);
  }
  f.wakes.result({nonce: ticket!.nonce, ok: true, url: 'https://chatgpt.com/c/new', permissions});
  assert.deepEqual(f.wakes.status()[0].permissions, permissions);
  permissions[0].connector = 'mutated';
  assert.equal(f.wakes.status()[0].permissions![0].connector, 'Crossfeed');
});

for (const zone of ['Europe/Rome', 'America/New_York']) {
  test(`daily resets at local midnight while hourly spans midnight (${zone})`, () => {
    const original = process.env.TZ; process.env.TZ = zone;
    try {
      const midnight = new Date(2026, 9, 5).getTime();
      const config = {labels: {}, wake_daily_cap: 1, wake_hourly_cap: 1,
        wake_state: {wakes: [midnight - 1000], failed: {}, archives: [], cooldown_until: 0}};
      assert.match(wakeLimits(config, midnight - 1).blocked!, /Daily/);
      assert.equal(wakeLimits(config, midnight).attempts, 0);
      assert.match(wakeLimits(config, midnight).blocked!, /Hourly/);
      assert.equal(wakeLimits(config, midnight + 3599000).blocked, null);
      config.wake_state.wakes.push(midnight);
      assert.equal(wakeLimits(config, midnight).attempts, 1);
    } finally { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; }
  });
}

test('hourly cap survives restart and releases exactly at the rolling boundary', () => {
  const f = fixture({wake_daily_cap: 48, wake_hourly_cap: 1});
  f.confirm(f.begin()); const restarted = new Wakes(f.config, f.now);
  restarted.enqueue('other'); assert.equal(restarted.next().ticket, null);
  assert.match(restarted.status().at(-1)!.error!, /Hourly.*Retry after/);
  f.advance(3599999); restarted.enqueue('other'); assert.equal(restarted.next().ticket, null);
  f.advance(1); restarted.enqueue('other'); assert.ok(restarted.next().ticket);
});

test('calendar day includes the whole 25-hour DST day and resets on a 23-hour day', () => {
  const original = process.env.TZ; process.env.TZ = 'Europe/Rome';
  try {
    const start = new Date(2026, 9, 25).getTime(), end = new Date(2026, 9, 26).getTime();
    const config = {labels: {}, wake_daily_cap: 1, wake_hourly_cap: 12,
      wake_state: {wakes: [start], failed: {}, archives: [], cooldown_until: 0}};
    assert.equal(end - start, 25 * 3600000);
    assert.match(wakeLimits(config, end - 1).blocked!, /Daily/);
    assert.equal(wakeLimits(config, end).blocked, null);
    assert.equal(wakeLimits(config, new Date(2026, 2, 29).getTime()).daily_reset_at - new Date(2026, 2, 29).getTime(), 23 * 3600000);
  } finally { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; }
});

test('wake diagnostics allow fixed stages and mask unknown page errors', () => {
  const f=fixture();const t=f.begin()!;
  f.wakes.result({nonce:t.nonce,ok:false,error:'PRIVATE_SENTINEL',stage:'send'});
  assert.deepEqual(f.wakes.status()[0],{label:'sol',state:'failed',error:'Fresh-chat wake failed; retry after 1 minute(s)',failure_code:'browser_error',failure_stage:'send'});
  assert(!JSON.stringify(f.writes).includes('PRIVATE_SENTINEL'));
});
