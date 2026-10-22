import { tempPrefix } from './temp.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Pairing } from '../src/pairing.ts';
import { ensurePairing, defaultAPI } from '../extension/pairing.ts';
import { main } from '../src/cli.ts';
import type { Fetcher } from '../extension/types.d.ts';

const origin = 'chrome-extension://' + 'a'.repeat(32);
const secret = 's'.repeat(43);
function host(t: import('node:test').TestContext) {
  const directory = fs.mkdtempSync(tempPrefix('crossfeed-pairing-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let now = 1000;
  return { directory, pairing: new Pairing(directory, () => now), advance: (n: any) => { now += n; } };
}
test('extension pairing exposes a random matching code and persists only approved hashes in private state', t => {
  const { pairing, directory } = host(t);
  const pending = pairing.create(origin, secret);
  assert.match(pending.code, /^[A-F0-9]{4}-[A-F0-9]{4}$/);
  assert.equal(pending.expires_at, 301000);
  assert.equal(pairing.authenticate(secret, origin), false);
  assert.deepEqual(pairing.create(origin, secret), pending);
  assert(!JSON.stringify(pairing.list()).includes(secret));
  assert(!JSON.stringify(pairing.list()).includes('secret_hash'));
  assert(!fs.existsSync(directory + '/extension-pairings.json'));
  const approved = pairing.approve(pending.code);
  assert.equal(approved.state, 'approved');
  assert.equal(pairing.enabled, true);
  const stored = fs.readFileSync(directory + '/extension-pairings.json', 'utf8');
  assert(!stored.includes(secret)); assert(stored.includes('secret_hash'));
  assert.equal(fs.statSync(directory + '/extension-pairings.json').mode & 0o777, 0o600);
  const restarted = new Pairing(directory);
  assert.equal(restarted.authenticate(secret, origin), true);
  assert.equal(restarted.authenticate(secret, 'chrome-extension://' + 'b'.repeat(32)), false);
  assert.equal(restarted.authenticate('t'.repeat(43), origin), false);
  assert.equal(restarted.status(pending.id, origin, secret).state, 'approved');
  restarted.revoke(pending.id);
  assert.equal(new Pairing(directory).authenticate(secret, origin), false);
});
test('pending pairing expires at five minutes and status is bound to secret and origin', t => {
  const { pairing, advance, directory } = host(t);
  const record = pairing.create(origin, secret);
  assert.throws(() => pairing.status(record.id, origin, 'x'.repeat(43)), e => e.status === 404);
  assert.throws(() => pairing.status(record.id, 'chrome-extension://' + 'b'.repeat(32), secret), e => e.status === 404);
  assert.equal(new Pairing(directory).list().pending.length, 0);
  advance(300000);
  assert.equal(pairing.status(record.id, origin, secret).state, 'expired');
  assert.throws(() => pairing.approve(record.id), e => e.status === 404);
});
test('pairing validates extension origin, throttles requests, and bounds both rate and pending capacity', t => {
  const { pairing, advance } = host(t);
  for (const bad of [undefined, 'null', 'https://chatgpt.com', origin + '/', 'chrome-extension://' + 'z'.repeat(32)]) assert.throws(() => pairing.create(bad as string, secret), e => e.status === 403);
  assert.throws(() => pairing.create(origin, 'short'));
  for (let i = 0; i < 12; i++) pairing.create(origin, secret);
  assert.throws(() => pairing.create(origin, secret), e => e.status === 429);
  advance(60000);
  assert.equal(pairing.create(origin, secret).state, 'pending');
  for (let i = 1; i < 60; i++) {
    const id = i.toString(16).replace(/[0-9a-f]/g, c => String.fromCharCode(97 + parseInt(c, 16))).padStart(32, 'a');
    pairing.create('chrome-extension://' + id, 'v'.repeat(42) + i.toString(36));
  }
  assert.throws(() => pairing.create('chrome-extension://' + 'p'.repeat(32), secret), e => e.status === 429);
  advance(60000);
  for (let i = 0; i < 4; i++) pairing.create('chrome-extension://' + 'p'.repeat(32), 'z'.repeat(40) + i.toString().padStart(3, '0'));
  assert.equal(pairing.pending.size, 64);
  assert.throws(() => pairing.create('chrome-extension://' + 'p'.repeat(32), 'q'.repeat(43)), e => e.status === 429);
});
test('invalid or unsafe pairing persistence is rejected', t => {
  const { directory } = host(t);
  fs.writeFileSync(directory + '/extension-pairings.json', JSON.stringify({ approved: [], secret }), { mode: 0o600 });
  assert.throws(() => new Pairing(directory));
  fs.writeFileSync(directory + '/extension-pairings.json', JSON.stringify({ approved: [] }));
  fs.chmodSync(directory + '/extension-pairings.json', 0o644);
  assert.throws(() => new Pairing(directory));
});
test('failed private writes preserve pending approval and existing approved access', t => {
  const { pairing } = host(t);
  const record = pairing.create(origin, secret);
  const persist = pairing.persist.bind(pairing);
  pairing.persist = () => { throw Error('write refused'); };
  assert.throws(() => pairing.approve(record.id));
  assert.equal(pairing.authenticate(secret, origin), false);
  assert.equal(pairing.list().pending.length, 1);
  pairing.persist = persist;
  pairing.approve(record.id);
  pairing.persist = () => { throw Error('write refused'); };
  assert.throws(() => pairing.revoke(record.id));
  assert.equal(pairing.authenticate(secret, origin), true);
});
function browserFixture() {
  const state: Record<string, any> = {}, writes: any[] = [];
  return { state, writes, browser: { storage: { local: {
    get: async (names: any) => Object.fromEntries(names.filter((name: any) => Object.hasOwn(state, name)).map((name: any) => [name, state[name]])),
    set: async (value: any) => { writes.push(value); Object.assign(state, value); },
    setAccessLevel: async (value: any) => assert.deepEqual(value, { accessLevel: 'TRUSTED_CONTEXTS' }),
  } } } };
}
test('extension starts with no configuration, generates a secret once and polls until approved', async () => {
  const { browser, state } = browserFixture();
  const calls: any[] = [];
  let approved = false;
  const fetcher = async (url: any, init: any) => {
    calls.push(url);
    const body = JSON.parse(init.body);
    assert.match(body.secret, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(init.headers.Authorization, undefined);
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'a'.repeat(32), code: 'ABCD-0123', state: approved ? 'approved' : 'pending', expires_at: Date.now() + 300000 }) };
  };
  assert.equal(await ensurePairing(browser, fetcher), null);
  const original = state.key;
  assert.equal(state.apiURL, defaultAPI); assert.equal(state.pairingVersion, 1);
  assert.equal(state.pairing.code, 'ABCD-0123');
  approved = true;
  const result = await ensurePairing(browser, fetcher);
  assert.deepEqual(result, { apiURL: defaultAPI, key: original });
  assert.deepEqual(calls, [defaultAPI + '/extension/pair', defaultAPI + '/extension/pair/status']);
  assert.deepEqual(await ensurePairing(browser, fetcher), result);
  assert.equal(calls.length, 2);
});
test('concurrent extension startup generates one credential; expired and lost pairings restart safely', async () => {
  const { browser, state } = browserFixture();
  let calls = 0;
  const fetcher = async (..._args: any[]) => {
    calls++;
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'a'.repeat(32), code: 'ABCD-0123', state: 'pending', expires_at: Date.now() + 300000 }) };
  };
  await Promise.all([ensurePairing(browser, fetcher), ensurePairing(browser, fetcher)]);
  assert.equal(calls, 1);
  const key = state.key;
  let statusRequests = 0;
  await ensurePairing(browser, async (url, init) => {
    if (url.endsWith('/status')) { statusRequests++; return { status: 404, ok: false } as Awaited<ReturnType<Fetcher>>; }
    return fetcher(url, init);
  });
  assert.equal(statusRequests, 1); assert.equal(state.key, key); assert.equal(calls, 2);
  state.pairing.apiURL = 'http://127.0.0.1:4321';
  await ensurePairing(browser, fetcher);
  assert.equal(calls, 3);
});
test('extension rotates the retired key configuration and never returns a pending credential', async () => {
  const { browser, state } = browserFixture();
  state.key = secret;
  const result = await ensurePairing(browser, async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ id: 'a'.repeat(32), code: 'ABCD-0123', state: 'pending', expires_at: Date.now() + 300000 }) }));
  assert.equal(result, null); assert.notEqual(state.key, secret);
});
test('CLI extension list, approve by code, and revoke use only owner-authenticated routes', async () => {
  const calls: any[] = [], logs: any[] = [];
  const io: Parameters<typeof main>[2] = { log: (value: any) => logs.push(value), fetch: async (url: any, init: any) => { calls.push({ url, init }); return { ok: true, json: async () => ({ ok: true }) } as Awaited<ReturnType<NonNullable<Parameters<typeof main>[2]>['fetch']>>; } };
  for (const args of [['extension', 'list'], ['extension', 'approve', 'ABCD-0123'], ['extension', 'revoke', 'a'.repeat(32)]]) await main(args, { CROSSFEED_API_KEY: secret }, io);
  assert.deepEqual(calls.map(({url}) => new URL(url).pathname), ['/extensions', '/extensions/approve', '/extensions/revoke']);
  assert.equal(calls[0].init.method, 'GET'); assert.equal(JSON.parse(calls[1].init.body).id, 'ABCD-0123');
  assert(calls.every(({init}) => init.headers.Authorization === 'Bearer ' + secret));
  assert(logs.every(log => !log.includes(secret)));
  await assert.rejects(main(['extension', 'approve'], { CROSSFEED_API_KEY: secret }, io));
});
