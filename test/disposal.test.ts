// Every way a wake chat can outlive its job, and the guard that disposes of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { WakeConfig } from '../src/types.ts';
import { Wakes } from '../src/wake.ts';

const chat = (id: string) => `https://chatgpt.com/c/${id}`;
const GRACE = 120001;

function fixture(extra: Record<string, any> = {}, alive = false) {
  let now = 1_000_000, contacts = 0, active = false, live = alive;
  const writes: any[] = [], liveSet = new Set<string>();
  const config: WakeConfig = { wake_hourly_cap: 1000, connector: 'Crossfeed', chat_disposal: 'delete', labels: { sol: { row: 'Latest', level: 3 } }, ...extra };
  const wakes = new Wakes(config, () => now, {
    save: (state: any) => writes.push(structuredClone(state)), contact: () => contacts, active: () => active,
    alive: identity => live || liveSet.has(identity),
  });
  const begin = (label = 'sol') => { wakes.enqueue(label); const { ticket } = wakes.next(); wakes.claim(ticket!.nonce); return ticket!; };
  const confirm = (ticket: any, id = 'new-chat') => { contacts++; active = true; return wakes.result({ nonce: ticket.nonce, ok: true, url: chat(id) }); };
  return { config, wakes, writes, begin, confirm, liveSet, setLive: (v: boolean) => { live = v; }, advance: (ms: number) => { now += ms; }, now: () => now };
}
const queued = (f: ReturnType<typeof fixture>) => f.config.wake_state!.archives;

test('P1: a finished wake with no later wake and no release call is disposed once its worker is gone', () => {
  const f = fixture({}, true);
  f.confirm(f.begin(), 'manual-test');
  assert.equal(f.config.labels.sol.url, chat('manual-test'));
  // Still polling (worker alive): it is the label's working chat, leave it.
  f.advance(GRACE * 10); f.wakes.reconcile(true);
  assert.deepEqual(queued(f), []); assert.equal(f.config.labels.sol.url, chat('manual-test'));
  // The worker stops (lease expired, chat closed, service restarted): dispose, deleting because the extension started it.
  f.setLive(false); f.wakes.reconcile(true);
  assert.deepEqual(queued(f), [chat('manual-test')]);
  assert.equal(f.config.labels.sol.url, undefined);
  assert.equal(f.writes.at(-1).labels.sol.url, undefined); assert.deepEqual(f.writes.at(-1).wake_state.archives, [chat('manual-test')]);
  const lease = f.wakes.archiveNext().archive!;
  assert.equal(lease.url, chat('manual-test')); assert.equal(lease.remove, true);
  f.wakes.archiveResult({ nonce: lease.nonce, ok: true });
  assert.deepEqual(f.config.wake_state!.started_chats, []); assert.deepEqual(f.config.wake_state!.chat_started_at, {});
});

test('P1: a fresh chat is never retired inside the grace window, and a pending wake keeps its identity', () => {
  const f = fixture();
  f.confirm(f.begin(), 'young');
  f.advance(60000); f.wakes.reconcile(true);
  assert.deepEqual(queued(f), []);
  f.advance(GRACE); f.wakes.enqueue('sol'); f.wakes.reconcile(true);
  assert.deepEqual(queued(f), [], 'a queued wake for the same identity protects it');
});

test('P1: replica and session chats retire on their own identities and keep the session reservation', () => {
  const f = fixture({ labels: { sol: { row: 'Latest', level: 3, replicas: 2, url: chat('one'), replica_urls: { '2': chat('two') } } },
    session_workers: { ['sol~session-' + 'A'.repeat(22)]: { label: 'sol', scope: 'A'.repeat(22), url: chat('sess') } },
    wake_state: { wakes: [], failed: {}, cooldown_until: 0, archives: [], started_chats: [chat('one'), chat('two'), chat('sess')] } });
  f.liveSet.add('sol');
  f.wakes.reconcile(true); f.advance(GRACE); f.wakes.reconcile(true);
  assert.deepEqual([...queued(f)].sort(), [chat('sess'), chat('two')].sort());
  assert.equal(f.config.labels.sol.url, chat('one')); assert.equal(f.config.labels.sol.replica_urls, undefined);
  const session = f.config.session_workers!['sol~session-' + 'A'.repeat(22)];
  assert.equal(session.url, undefined); assert.equal(session.scope, 'A'.repeat(22));
  const removed = [f.wakes.archiveNext().archive!];
  assert.equal(removed[0].remove, true);
});

test('P1: archive mode disposes the same chats by archiving them', () => {
  const f = fixture({ chat_disposal: 'archive' });
  f.confirm(f.begin(), 'arch'); f.advance(GRACE); f.wakes.reconcile(true);
  const lease = f.wakes.archiveNext().archive!;
  assert.equal(lease.url, chat('arch')); assert.equal(lease.remove, undefined);
});

test('P2/P3: the chat reported at creation is queued when the wake fails, expires, or is lost', () => {
  // Failure without any url in the result (native mode never sends one).
  const failed = fixture(); const t1 = failed.begin();
  failed.wakes.chat({ nonce: t1.nonce, url: chat('native-orphan') });
  failed.wakes.result({ nonce: t1.nonce, ok: false, error: 'send_unconfirmed' });
  assert.deepEqual(queued(failed), [chat('native-orphan')]);
  assert.equal(failed.wakes.archiveNext().archive!.remove, true);
  // The ticket expires while claimed and the extension never reports again (reload, crash).
  const expired = fixture(); const t2 = expired.begin();
  expired.wakes.chat({ nonce: t2.nonce, url: chat('crashed') });
  assert.deepEqual(queued(expired), []);
  expired.advance(240001); expired.wakes.prune();
  assert.deepEqual(queued(expired), [chat('crashed')]);
});

test('P3/P4: a recorded chat survives a service restart and is disposed once no ticket owns it', () => {
  const f = fixture(); const t = f.begin();
  f.wakes.chat({ nonce: t.nonce, url: chat('mid-wake') });
  // Service restarts: tickets live in memory only. Same persisted config, new Wakes.
  const restarted = new Wakes(f.config, () => f.now(), { save: () => {}, alive: () => false });
  restarted.reconcile(true);
  assert.deepEqual(queued(f), [], 'inside the grace window a restarted service waits');
  f.advance(GRACE); restarted.reconcile(true);
  assert.deepEqual(queued(f), [chat('mid-wake')]);
  assert.equal(restarted.archiveNext().archive!.remove, true);
});

test('a recorded chat that a live ticket owns is never queued by reconcile', () => {
  const f = fixture(); const t = f.begin();
  f.wakes.chat({ nonce: t.nonce, url: chat('in-flight') });
  f.advance(GRACE); f.wakes.reconcile(true);
  assert.deepEqual(queued(f), []);
});

test('chat records need a claimed wake, a chat URL and nothing else; retained chats are not re-tracked', () => {
  const f = fixture(); f.wakes.enqueue('sol'); const issued = f.wakes.next().ticket!;
  assert.throws(() => f.wakes.chat({ nonce: issued.nonce, url: chat('early') }), (e: any) => e.status === 409);
  f.wakes.claim(issued.nonce);
  assert.throws(() => f.wakes.chat({ nonce: issued.nonce, url: 'https://evil.example/c/x' }));
  assert.throws(() => f.wakes.chat({ nonce: issued.nonce, url: chat('x'), extra: 1 }));
  assert.throws(() => f.wakes.chat({ nonce: 'z'.repeat(32), url: chat('x') }), (e: any) => e.status === 409);
  assert.deepEqual(f.config.wake_state!.started_chats ?? [], []);
  f.wakes.chat({ nonce: issued.nonce, url: chat('x') }); f.wakes.chat({ nonce: issued.nonce, url: chat('x') });
  assert.deepEqual(f.config.wake_state!.started_chats, [chat('x')]);
});

test('P5: a failed wake that reports its URL is deleted in delete mode, not just archived', () => {
  const f = fixture(); const t = f.begin();
  f.wakes.result({ nonce: t.nonce, ok: false, error: 'permission_unconfirmed', url: chat('failed-with-url') });
  assert.deepEqual(queued(f), [chat('failed-with-url')]);
  assert.deepEqual(f.config.wake_state!.started_chats, [chat('failed-with-url')]);
  assert.equal(f.wakes.archiveNext().archive!.remove, true);
});

test('P5b: a full archive queue keeps the failed chat tracked and queues it as soon as there is room', () => {
  const f = fixture(); const t = f.begin();
  f.config.wake_state!.archives = Array.from({ length: 256 }, (_, i) => chat(`full-${i}`));
  f.wakes.result({ nonce: t.nonce, ok: false, error: 'send_unconfirmed', url: chat('dropped-before') });
  assert.equal(queued(f).length, 256); assert.ok(!queued(f).includes(chat('dropped-before')));
  assert.ok(f.config.wake_state!.started_chats!.includes(chat('dropped-before')));
  f.advance(GRACE); f.wakes.reconcile(true);
  assert.equal(queued(f).length, 256, 'still full');
  f.config.wake_state!.archives.shift();
  f.wakes.reconcile(true);
  assert.ok(queued(f).includes(chat('dropped-before')));
});

test('P6: removing a label that holds a retained chat does not lose the chat', () => {
  const f = fixture();
  f.confirm(f.begin(), 'label-chat');
  assert.equal(f.config.labels.sol.url, chat('label-chat'));
  // POST /workers/remove replaces config.labels without the label.
  f.config.labels = {};
  f.advance(GRACE); f.wakes.reconcile(true);
  assert.deepEqual(queued(f), [chat('label-chat')]);
  assert.equal(f.wakes.archiveNext().archive!.remove, true);
});

test('P8: a ticket that expires while claimed and never reported a chat leaves nothing to track', () => {
  const f = fixture(); f.begin(); f.advance(240001); f.wakes.prune();
  assert.deepEqual(queued(f), []); assert.deepEqual(f.config.wake_state!.started_chats ?? [], []);
});

test('reconcile is throttled and never touches an alive worker, a legacy untracked chat is only archived', () => {
  const f = fixture({ labels: { sol: { row: 'Latest', level: 3, url: chat('legacy') } } });
  f.wakes.reconcile(); f.advance(GRACE);
  assert.equal(f.wakes.reconcile().retired, 1);
  assert.equal(f.wakes.reconcile().retired, 0, 'throttled inside 30 s');
  const lease = f.wakes.archiveNext().archive!;
  assert.equal(lease.url, chat('legacy')); assert.equal(lease.remove, undefined, 'no ownership proof: archive, never delete');
});

test('reconcile survives a failed save without corrupting the live configuration', () => {
  const f = fixture(); f.confirm(f.begin(), 'save-fails'); f.advance(GRACE);
  const save = f.wakes.save;
  f.wakes.save = () => { throw Error('disk full'); };
  assert.throws(() => f.wakes.reconcile(true), /disk full/);
  assert.equal(f.config.labels.sol.url, chat('save-fails')); assert.deepEqual(queued(f), []);
  f.wakes.save = save; f.advance(31000); f.wakes.reconcile(true);
  assert.deepEqual(queued(f), [chat('save-fails')]);
});

test('sweepCheck approves only old chats that no label, session, queue entry or ticket holds', () => {
  const f = fixture({ labels: { sol: { row: 'Latest', level: 3, url: chat('retained') } } });
  f.wakes.config.wake_state!.archives = [chat('queued')];
  const t = f.begin(); f.wakes.chat({ nonce: t.nonce, url: chat('ticket') });
  const old = f.now() - 3_600_000, young = f.now() - 60_000;
  const candidates = [['retained', old], ['queued', old], ['ticket', old], ['orphan', old], ['young', young], ['also-orphan', old]]
    .map(([id, created_at]) => ({ id, created_at })) as any;
  const reply = f.wakes.sweepCheck({ candidates });
  assert.deepEqual(reply.dispose, ['orphan', 'also-orphan']);
  assert.ok(reply.min_age_ms >= 900000);
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `o${i}`, created_at: old }));
  assert.equal(f.wakes.sweepCheck({ candidates: many }).dispose.length, 10);
  for (const bad of [{}, { candidates: 'x' }, { candidates: [{ id: '../x', created_at: 1 }] }, { candidates: [{ id: 'a', created_at: 1, extra: 1 }] }, { candidates: [], extra: 1 }])
    assert.throws(() => f.wakes.sweepCheck(bad), (e: any) => e.status === 400);
});

test('sweepDone records deletions and stops tracking those chats', () => {
  const f = fixture(); const t = f.begin();
  f.wakes.result({ nonce: t.nonce, ok: false, error: 'send_unconfirmed', url: chat('swept') });
  assert.deepEqual(queued(f), [chat('swept')]);
  f.wakes.sweepDone({ deleted: ['swept'] });
  assert.deepEqual(queued(f), []); assert.deepEqual(f.config.wake_state!.started_chats, []);
  assert.equal(f.wakes.lastSweep!.deleted, 1);
  assert.throws(() => f.wakes.sweepDone({ deleted: ['bad id'] }));
});
