import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { createApp } from '../src/server.ts';
import { loadConfig } from '../src/config.ts';
import { nonce } from '../src/security.ts';
import { fakeHTTP } from './fake-http.ts';
import { tempPrefix } from './temp.ts';

const origin = 'chrome-extension://' + 'a'.repeat(32);
const issuer = 'https://receiver.example.test';

async function fixture(t: import('node:test').TestContext, extra: Record<string, any> = {}) {
  const directory = await fs.mkdtemp(tempPrefix('crossfeed-receiver-'));
  const apiKey = nonce() + nonce();
  const secrets = [nonce() + nonce(), nonce() + nonce(), nonce() + nonce()];
  const fake = fakeHTTP();
  const tcp = process.env.CROSSFEED_TEST_TCP === '1';
  const fetcher = tcp ? fetch : fake.fetcher;
  let now = Date.now();
  let app = await createApp({directory, apiKey, apiPort: 0, mcpPort: 0,
    config: {public_url: issuer}, now: () => now,
    gateway: {timeoutMs: 300, pollMs: 50}, ...(tcp ? {} : {serverFactory: fake.factory}), ...extra});
  t.after(async () => { await app.close(); await fs.rm(directory, {recursive: true, force: true}); });

  const call = async (route: string, input?: unknown, opts: {
    key?: string; origin?: string; method?: string; raw?: string; public?: boolean;
    headers?: Record<string, string>;
  } = {}) => {
    const url = (opts.public ? app.mcpUrl.slice(0, -4) : app.apiUrl) + route;
    const response = await fetcher(url, {method: opts.method ?? (input === undefined ? 'GET' : 'POST'),
      headers: {'Authorization': 'Bearer ' + (opts.key ?? apiKey), 'Content-Type': 'application/json',
        ...(opts.origin ? {'Origin': opts.origin} : {}), ...opts.headers},
      ...(input === undefined ? {} : {body: opts.raw ?? JSON.stringify(input)})});
    const text = await response.text();
    return {status: response.status, data: text && response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text};
  };
  const ext = (secret: string, route: string, input?: unknown, opts: {method?: string; origin?: string} = {}) =>
    call(route, input, {key: secret, origin: opts.origin ?? origin, method: opts.method});
  const pair = async (secret: string, approve = true) => {
    const result = await call('/extension/pair', {secret}, {key: '', origin});
    assert.equal(result.status, 200);
    const record = result.data;
    if (approve) assert.equal((await call('/extensions/approve', {id: record.id})).status, 200);
    return record as {id: string; code: string; state: string};
  };
  const select = (id: string | null) => call('/extensions/receiver', {id});
  const restart = async () => {
    await app.close();
    app = await createApp({directory, apiKey, apiPort: 0, mcpPort: 0,
      config: {public_url: issuer}, now: () => now,
      gateway: {timeoutMs: 300, pollMs: 50}, ...(tcp ? {} : {serverFactory: fake.factory}), ...extra});
  };
  return {get app() {return app;}, directory, apiKey, secrets, call, ext, pair, select, restart, advance: (ms: number) => {now += ms;}};
}

test('default unset preserves all approved pairings, including distinct secrets from one origin', async t => {
  const f = await fixture(t);
  const a = await f.pair(f.secrets[0]), b = await f.pair(f.secrets[1]);
  assert.notEqual(a.id, b.id);
  assert.equal(f.app.pairing.identify(f.secrets[0], origin), a.id);
  assert.equal(f.app.pairing.identify(f.secrets[1], origin), b.id);
  assert.equal(f.app.pairing.identify(f.secrets[1], 'chrome-extension://' + 'b'.repeat(32)), undefined);
  assert.equal(f.app.pairing.authenticate(f.secrets[0], origin), true);
  assert.equal((await f.call('/extensions/receiver')).data.id, null);
  assert.deepEqual((await f.ext(f.secrets[0], '/extension/next')).data, {ticket: null});
  assert.deepEqual((await f.ext(f.secrets[1], '/extension/next', {})).data, {ticket: null});
  assert.equal((await f.call('/workers/add', {label: 'legacy', row: 'Latest', level: 0})).status, 200);
  assert.equal((await f.call('/wake', {label: 'legacy'})).status, 202);
  const first = (await f.ext(f.secrets[0], '/extension/next')).data.ticket;
  assert.ok(first?.nonce);
  assert.equal((await f.ext(f.secrets[0], '/extension/claim', {nonce: first.nonce})).status, 200);
  assert.equal((await f.ext(f.secrets[0], '/extension/result', {nonce: first.nonce, ok: false})).status, 200);
  f.advance(60001);
  assert.equal((await f.call('/wake', {label: 'legacy'})).status, 202);
  const second = (await f.ext(f.secrets[1], '/extension/next')).data.ticket;
  assert.ok(second?.nonce);
  assert.equal((await f.ext(f.secrets[1], '/extension/claim', {nonce: second.nonce})).status, 200);
  assert.equal((await f.ext(f.secrets[1], '/extension/result', {nonce: second.nonce, ok: false})).status, 200);
  const status = (await f.call('/status')).data;
  assert.equal(status.wake_receiver.id, null);
  assert.equal(status.extension_poll.recent, true);
});

test('pending preselection prevents approve-to-select race and isolates all wake and archive operations', async t => {
  const f = await fixture(t);
  const a = await f.pair(f.secrets[0]);
  const b = await f.pair(f.secrets[1], false);
  const selected = await f.select(b.id);
  assert.equal(selected.status, 200);
  assert.deepEqual([selected.data.id, selected.data.approved, selected.data.pending], [b.id, false, true]);
  assert.equal((await f.ext(f.secrets[1], '/extension/next')).status, 401);
  assert.equal((await f.ext(f.secrets[0], '/extension/next')).status, 200);
  assert.equal((await f.call('/status')).data.extension_poll.last_seen_at, null);
  assert.equal((await f.call('/extensions/approve', {id: b.code})).status, 200);
  assert.equal((await f.call('/workers/add', {label: 'sol', row: 'Latest', level: 0})).status, 200);
  assert.equal((await f.call('/wake', {label: 'sol'})).status, 202);
  assert.deepEqual((await f.ext(f.secrets[0], '/extension/next')).data, {ticket: null});
  const queued = [...f.app.wakes.tickets.values()][0];
  assert.equal(queued.state, 'queued');
  const next = (await f.ext(f.secrets[1], '/extension/next')).data.ticket;
  assert.equal(next.nonce, queued.nonce);
  assert.equal(queued.state, 'issued');
  assert.equal((await f.call('/status')).data.extension_poll.recent, true);
  assert.equal((await f.ext(f.secrets[0], '/extension/next')).data.ticket, null);

  for (const [route, input] of [
    ['/extension/claim', {nonce: next.nonce}],
    ['/extension/claim', {nonce: nonce()}],
    ['/extension/check', {nonce: next.nonce}],
    ['/extension/observe', {nonce: next.nonce, picker_receipt: {row: 'Latest', level: 0}}],
    ['/extension/result', {nonce: next.nonce, ok: false}],
    ['/extension/archive/result', {nonce: next.nonce, ok: false}]
  ] as const) {
    const response = await f.ext(f.secrets[0], route, input);
    assert.equal(response.status, 403, route);
    assert.equal(response.data.error.code, 'receiver_mismatch', route);
    assert.equal(queued.state, 'issued', route);
  }
  assert.equal((await f.ext(f.secrets[1], '/extension/claim', {nonce: next.nonce})).status, 200);
  assert.equal((await f.ext(f.secrets[0], '/extension/check', {nonce: next.nonce})).status, 403);
  assert.equal((await f.ext(f.secrets[1], '/extension/check', {nonce: next.nonce})).status, 200);
  assert.equal((await f.ext(f.secrets[1], '/extension/result', {nonce: next.nonce, ok: false})).status, 200);

  f.app.config.wake_state!.archives.push('https://chatgpt.com/c/review-archive');
  assert.deepEqual((await f.ext(f.secrets[0], '/extension/archive/next')).data, {archive: null});
  assert.deepEqual((await f.ext(f.secrets[0], '/extension/archive/next', {})).data, {archive: null});
  assert.equal(f.app.wakes.archiveLease, null);
  assert.equal(f.app.config.wake_state!.archives.length, 1);
  const archive = (await f.ext(f.secrets[1], '/extension/archive/next')).data.archive;
  assert.equal(archive.url, 'https://chatgpt.com/c/review-archive');
  assert.equal((await f.ext(f.secrets[0], '/extension/archive/result', {nonce: archive.nonce, ok: true})).status, 403);
  assert.equal(f.app.config.wake_state!.archives.length, 1);
  assert.equal((await f.ext(f.secrets[1], '/extension/archive/result', {nonce: archive.nonce, ok: true})).status, 200);
  assert.equal(f.app.config.wake_state!.archives.length, 0);
  assert.equal(a.id === b.id, false);
});

test('disposal routes isolate selected pairing even with a known claimed nonce and valid cleanup IDs', async t => {
  const f = await fixture(t, {config: {public_url: issuer, chat_disposal: 'delete'}});
  const selected = await f.pair(f.secrets[0]), other = await f.pair(f.secrets[1]);
  assert.notEqual(selected.id, other.id);
  assert.equal((await f.select(selected.id)).status, 200);
  assert.equal((await f.call('/workers/add', {label: 'disposal', row: 'Latest', level: 0})).status, 200);
  assert.equal((await f.call('/wake', {label: 'disposal'})).status, 202);
  const ticket = (await f.ext(f.secrets[0], '/extension/next')).data.ticket;
  assert.ok(ticket?.nonce);
  assert.equal((await f.ext(f.secrets[0], '/extension/claim', {nonce: ticket.nonce})).status, 200);
  const chat = (id: string) => `https://chatgpt.com/c/${id}`;
  assert.equal((await f.ext(f.secrets[0], '/extension/chat', {nonce: ticket.nonce, url: chat('early')})).status, 200);
  assert.equal((await f.ext(f.secrets[0], '/extension/result', {nonce: ticket.nonce, ok: false})).status, 200);
  assert.equal(f.app.wakes.tickets.get(ticket.nonce)?.state, 'failed');
  assert.equal(f.app.wakes.tickets.get(ticket.nonce)?.claimed, true);
  // Late claimed-nonce registration is cleanup evidence after failure, not another send.
  assert.equal((await f.ext(f.secrets[0], '/extension/chat', {nonce: ticket.nonce, url: chat('late')})).status, 200);
  assert.deepEqual(f.app.config.wake_state!.started_chats, [chat('early'), chat('late')]);
  assert.deepEqual(f.app.config.wake_state!.archives, [chat('early')]);

  f.advance(1000);
  const candidates = {candidates: [{id: 'orphan', created_at: Date.now() - 7_200_000}]};
  const attacks = [
    ['/extension/chat', {nonce: ticket.nonce, url: chat('injected')}],
    ['/extension/sweep', candidates],
    ['/extension/sweep/done', {deleted: ['early']}],
  ] as const;
  const before = structuredClone(f.app.config.wake_state);
  const beforeTicket = structuredClone(f.app.wakes.tickets.get(ticket.nonce));
  const beforeSweep = structuredClone(f.app.wakes.lastSweep);
  const beforeDisk = await fs.readFile(f.directory + '/config.json', 'utf8');
  const beforeContact = (await f.call('/status')).data.extension_poll;
  for (const [route, input] of attacks) {
    const response = await f.ext(f.secrets[1], route, input);
    assert.equal(response.status, 403, route);
    assert.equal(response.data.error.code, 'receiver_mismatch', route);
    assert.deepEqual(f.app.config.wake_state, before, route + ' state');
    assert.deepEqual(f.app.wakes.tickets.get(ticket.nonce), beforeTicket, route + ' ticket');
    assert.deepEqual(f.app.wakes.lastSweep, beforeSweep, route + ' sweep');
    assert.equal(await fs.readFile(f.directory + '/config.json', 'utf8'), beforeDisk, route + ' durable state');
    assert.deepEqual((await f.call('/status')).data.extension_poll, beforeContact, route + ' selected contact');
  }
  // The selected receiver can still run the same cleanup paths.
  const eligible = await f.ext(f.secrets[0], '/extension/sweep', candidates);
  assert.equal(eligible.status, 200);
  assert.deepEqual(eligible.data.dispose, ['orphan']);
  assert.equal((await f.ext(f.secrets[0], '/extension/sweep/done', {deleted: ['early']})).status, 200);
  assert.deepEqual(f.app.config.wake_state!.started_chats, [chat('late')]);
  assert.deepEqual(f.app.config.wake_state!.archives, []);
  assert.equal(f.app.wakes.lastSweep?.deleted, 1);

  // With no receiver selected, both independently approved pairings retain legacy access.
  assert.equal((await f.select(null)).status, 200);
  assert.equal((await f.ext(f.secrets[1], '/extension/chat', {nonce: ticket.nonce, url: chat('legacy')})).status, 200);
  assert.equal((await f.ext(f.secrets[1], '/extension/sweep', candidates)).status, 200);
  assert.equal((await f.ext(f.secrets[1], '/extension/sweep/done', {deleted: ['late', 'legacy']})).status, 200);
  assert.deepEqual(f.app.config.wake_state!.started_chats, []);
  assert.equal(f.app.wakes.lastSweep?.deleted, 3);
});

test('receiver selection validates exact body, auth, pending expiry, and private-only access', async t => {
  const f = await fixture(t);
  const a = await f.pair(f.secrets[0]);
  for (const input of [{}, {id: undefined}, {id: 1}, {id: false}, {id: ''}, {id: 'x'.repeat(32), extra: true}, {id: [a.id]}, {id: {}}, {id: null, extra: 1}]) {
    assert.equal((await f.call('/extensions/receiver', input)).status, 400);
  }
  assert.equal((await f.call('/extensions/receiver', {id: 'x'.repeat(32)})).status, 404);
  assert.equal((await f.call('/extensions/receiver', {id: a.id}, {key: 'wrong'})).status, 401);
  assert.equal((await f.call('/extensions/receiver', undefined, {key: 'wrong'})).status, 401);
  assert.equal((await f.call('/extensions/receiver', {id: a.id}, {origin})).status, 403);
  assert.equal((await f.call('/extensions/receiver', {id: a.id}, {origin: 'https://chatgpt.com'})).status, 403);
  assert.notEqual((await f.call('/extensions/receiver', {id: a.id}, {public: true})).status, 200);
  assert.equal((await f.call('/extensions/receiver')).data.id, null);
  const pending = await f.pair(f.secrets[1], false);
  f.advance(300001);
  assert.equal((await f.select(pending.id)).status, 404);
  assert.equal((await f.select(a.id)).status, 200);
  assert.equal((await f.select(a.id)).status, 200);
});

test('sweep approval holds its receiver until done or bounded expiry', async t => {
  const f = await fixture(t);
  const a = await f.pair(f.secrets[0]), b = await f.pair(f.secrets[1]);
  assert.equal((await f.select(a.id)).status, 200);
  const candidates = [{id: 'sweep-owned', created_at: 0}];
  assert.deepEqual((await f.ext(f.secrets[0], '/extension/sweep', {candidates})).data.dispose, ['sweep-owned']);
  assert.equal((await f.select(b.id)).status, 409);
  assert.equal((await f.select(null)).status, 409);
  assert.equal((await f.ext(f.secrets[1], '/extension/sweep/done', {deleted: []})).status, 403);
  assert.equal((await f.select(b.id)).status, 409);
  assert.equal((await f.ext(f.secrets[0], '/extension/sweep/done', {deleted: []})).status, 200);
  assert.equal((await f.select(b.id)).status, 200);
  assert.equal((await f.ext(f.secrets[1], '/extension/sweep', {candidates})).status, 200);
  assert.equal((await f.select(a.id)).status, 409);
  f.advance(59999);
  assert.equal((await f.select(a.id)).status, 409);
  f.advance(1);
  assert.equal((await f.select(a.id)).status, 200);
});

test('unselected mode binds each sweep lease to the pairing that opened it', async t => {
  const f = await fixture(t);
  const a = await f.pair(f.secrets[0]); await f.pair(f.secrets[1]);
  const candidates = [{id: 'sweep-owned', created_at: 0}];
  await f.ext(f.secrets[0], '/extension/sweep', {candidates});
  await f.ext(f.secrets[1], '/extension/sweep/done', {deleted: []});
  assert.equal((await f.select(a.id)).status, 409);
  await f.ext(f.secrets[0], '/extension/sweep/done', {deleted: []});
  assert.equal((await f.select(a.id)).status, 200);
});

test('changes require complete idle: gateway jobs, queued/issued/claimed wakes and archive lease', async t => {
  const f = await fixture(t);
  const a = await f.pair(f.secrets[0]), b = await f.pair(f.secrets[1]);
  assert.equal((await f.select(a.id)).status, 200);
  // Simulate an unfinished gateway job; exercise the real operator HTTP handler.
  f.app.gateway.jobs.set('test-busy', {finished: false} as any);
  assert.equal((await f.select(b.id)).status, 409);
  f.app.gateway.jobs.delete('test-busy');
  assert.equal((await f.call('/workers/add', {label: 'sol', row: 'Latest', level: 0})).status, 200);
  assert.equal((await f.call('/wake', {label: 'sol'})).status, 202);
  assert.equal((await f.select(b.id)).status, 409);
  assert.equal((await f.select(a.id)).status, 200, 'no-op may be permitted while busy');
  const ticket = (await f.ext(f.secrets[0], '/extension/next')).data.ticket;
  assert.equal((await f.select(b.id)).status, 409);
  assert.equal((await f.ext(f.secrets[0], '/extension/claim', {nonce: ticket.nonce})).status, 200);
  assert.equal((await f.select(b.id)).status, 409);
  assert.equal((await f.ext(f.secrets[0], '/extension/result', {nonce: ticket.nonce, ok: false})).status, 200);
  f.app.config.wake_state!.archives.push('https://chatgpt.com/c/lease-test');
  const lease = (await f.ext(f.secrets[0], '/extension/archive/next')).data.archive;
  assert.equal((await f.select(b.id)).status, 409);
  assert.equal((await f.ext(f.secrets[0], '/extension/archive/result', {nonce: lease.nonce, ok: true})).status, 200);
  assert.equal((await f.select(b.id)).status, 200);
  assert.equal(f.app.config.wake_receiver_id, b.id);
});

test('selected-only contact health, switch reset, revoke fail-closed, restart persistence and explicit clear', async t => {
  const f = await fixture(t);
  const a = await f.pair(f.secrets[0]), b = await f.pair(f.secrets[1]);
  assert.equal((await f.select(a.id)).status, 200);
  assert.equal((await f.ext(f.secrets[1], '/extension/next')).status, 200);
  assert.equal((await f.call('/status')).data.extension_poll.recent, false);
  assert.equal((await f.ext(f.secrets[0], '/extension/next')).status, 200);
  const live = (await f.call('/status')).data;
  assert.equal(live.extension_poll.recent, true);
  assert.equal(live.wake_receiver.approved, true);
  assert.equal((await f.select(b.id)).status, 200);
  assert.equal((await f.call('/status')).data.extension_poll.last_contact_at, null);
  assert.equal((await f.ext(f.secrets[0], '/extension/next')).status, 200);
  assert.equal((await f.call('/status')).data.extension_poll.recent, false);
  assert.equal((await f.ext(f.secrets[1], '/extension/next')).status, 200);
  assert.equal((await f.call('/status')).data.extension_poll.recent, true);

  await f.restart();
  assert.equal(f.app.config.wake_receiver_id, b.id);
  assert.equal((await f.call('/extensions/receiver')).data.id, b.id);
  assert.equal((await f.ext(f.secrets[0], '/extension/next')).status, 200);
  assert.equal((await f.call('/status')).data.extension_poll.last_seen_at, null);
  assert.equal((await f.call('/extensions/revoke', {id: b.id})).status, 200);
  assert.equal((await f.ext(f.secrets[1], '/extension/next')).status, 401);
  assert.deepEqual((await f.ext(f.secrets[0], '/extension/next')).data, {ticket: null});
  const missing = (await f.call('/status')).data;
  assert.equal(missing.wake_receiver.id, b.id);
  assert.equal(missing.wake_receiver.approved, false);
  assert.equal(missing.wake_receiver.recent, false);
  assert.equal(missing.extension_poll.last_contact_at, null);
  assert.equal((await f.select(b.id)).status, 404, 'cannot re-select missing revoked ID');
  await f.restart();
  assert.equal((await f.call('/extensions/receiver')).data.id, b.id);
  assert.equal((await f.call('/status')).data.wake_receiver.approved, false);
  assert.equal((await f.ext(f.secrets[0], '/extension/next')).status, 200);
  assert.equal((await f.call('/status')).data.extension_poll.recent, false);
  assert.equal((await f.select(null)).status, 200);
  assert.equal(f.app.config.wake_receiver_id, undefined);
  assert.equal((await f.ext(f.secrets[0], '/extension/next')).status, 200);
  assert.equal((await f.call('/status')).data.extension_poll.recent, true);
  assert.equal(loadConfig(f.directory).wake_receiver_id, undefined);
});

test('config enforces pairing-ID shape but preserves a valid selected ID with no approved record', async t => {
  const f = await fixture(t);
  const id = nonce();
  assert.equal(loadConfig(f.directory, {wake_receiver_id: id}).wake_receiver_id, id);
  assert.throws(() => loadConfig(f.directory, {wake_receiver_id: 'bad'}), /Invalid wake receiver ID/);
  assert.throws(() => loadConfig(f.directory, {wake_receiver_id: null as any}), /Invalid wake receiver ID/);
});

test('asynchronous focus preparation reauthenticates after selected pairing is revoked', async t => {
  let entered!: () => void;
  let release!: () => void;
  const focusEntered = new Promise<void>(resolve => {entered = resolve;});
  const focusReleased = new Promise<void>(resolve => {release = resolve;});
  const f = await fixture(t, {focusGuard: async () => {
    entered();
    await focusReleased;
    return undefined;
  }});
  const a = await f.pair(f.secrets[0]), b = await f.pair(f.secrets[1]);
  assert.equal((await f.select(a.id)).status, 200);
  assert.equal((await f.call('/workers/add', {label: 'focus', row: 'Latest', level: 0})).status, 200);
  assert.equal((await f.call('/wake', {label: 'focus'})).status, 202);
  const ticket = (await f.ext(f.secrets[0], '/extension/next')).data.ticket;
  const claiming = f.ext(f.secrets[0], '/extension/claim',
    {nonce: ticket.nonce, focus_guard: true, focus_guard_version: 4});
  await focusEntered;
  assert.equal((await f.select(b.id)).status, 409, 'claimed wake blocks selection during focus prepare');
  assert.equal((await f.call('/extensions/revoke', {id: a.id})).status, 200);
  release();
  const response = await claiming;
  assert.equal(response.status, 403);
  assert.equal(response.data.error.code, 'receiver_mismatch');
  assert.equal((await f.call('/status')).data.extension_poll.recent, false);
  assert.deepEqual((await f.ext(f.secrets[1], '/extension/next')).data, {ticket: null});
});
