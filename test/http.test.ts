import { tempPrefix } from './temp.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.ts';
import { main } from '../src/cli.ts';
import { hash, nonce } from '../src/security.ts';
import { fakeHTTP } from './fake-http.ts';
import type { TestResponse } from './fake-http.ts';
import { makePoller, validTicket, request as extensionRequest } from '../extension/core.js';
import { pageWake, prefillProbe, prefillWake } from '../extension/page.js';
import manifest from '../package.json' with { type: 'json' };

const issuer = 'https://crossfeed.example.test';
// Node fetch replaces Host with the URL authority; hostile Host probes need raw HTTP.
function fetchWithHost(address: string | URL, init: RequestInit) {
  return new Promise<Pick<TestResponse, 'status' | 'headers' | 'text'>>((resolve, reject) => {
    const request = http.request(address, { method: init.method, headers: Object.fromEntries(new Headers(init.headers)) }, (response: any) => {
      const chunks: any[] = [];
      response.on('data', (chunk: any) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: new Headers(response.headers), text: async () => Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end(init.body);
  });
}
async function fixture(t: import('node:test').TestContext, extra: Record<string, any> = {}) {
  const directory = await fs.mkdtemp(tempPrefix('crossfeed-http-'));
  const apiKey = nonce() + nonce(), extensionSecret = nonce() + nonce().slice(0,11);
  const fake = fakeHTTP(); const tcp = process.env.CROSSFEED_TEST_TCP === '1';
  const fetcher: (address: string | URL, init?: RequestInit) => Promise<any> = tcp ? (address: any, init: RequestInit = {}) => new Headers(init.headers).has('host') ? fetchWithHost(address, init) : fetch(address, init) : fake.fetcher;
  const app = await createApp({ directory, apiKey, apiPort: 0, mcpPort: 0, config: { public_url: issuer }, gateway: { timeoutMs: 300, pollMs: 50 }, ...(tcp ? {} : { serverFactory: fake.factory }), ...extra });
  t.after(async () => { await app.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const publicUrl = app.mcpUrl.slice(0, -4);
  const call = async (route: any, input: any = undefined, { key = apiKey, headers = {}, public: remote = false, method, raw }: { key?: string; headers?: Record<string,string>; public?: boolean; method?: string; raw?: string } = {}) => {
    const response = await fetcher((remote ? publicUrl : app.apiUrl) + route, { method: method ?? (input === undefined ? 'GET' : 'POST'), redirect: 'manual', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(key === extensionSecret && route.startsWith('/extension/') ? {Origin:'chrome-extension://'+'a'.repeat(32)} : {}), ...headers }, ...(input === undefined ? {} : { body: raw ?? JSON.stringify(input) }) });
    const text = await response.text();
    return { status: response.status, headers: response.headers, data: text && response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
  };
  const paired = app.pairing.create('chrome-extension://'+'a'.repeat(32),extensionSecret);
  app.pairing.approve(paired.id);
  const form = async (data: any) => {
    const response = await fetcher(publicUrl + '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data).toString() });
    return { status: response.status, data: await response.json() };
  };
  const connect = async (suffix = 'fake_client', endpoint = '/mcp') => {
    assert.equal((await call('/link', {})).status, 200);
    const redirect = 'https://chatgpt.com/connector/oauth/' + suffix;
    const registration = await call('/oauth/register', { client_name: 'ChatGPT', redirect_uris: [redirect], token_endpoint_auth_method: 'none' }, { public: true });
    assert.equal(registration.status, 201);
    const client = registration.data.client_id;
    const verifier = nonce() + nonce();
    const params = new URLSearchParams({ client_id: client, redirect_uri: redirect, response_type: 'code', code_challenge_method: 'S256', code_challenge: hash(verifier), state: 'fake_state', scope: 'mcp:tools offline_access', resource: issuer + endpoint });
    const authorization = await call('/oauth/authorize?' + params, undefined, { public: true });
    assert.equal(authorization.status, 303);
    const cookie = authorization.headers.get('set-cookie').split(';')[0];
    assert.match(authorization.headers.get('set-cookie'), /Secure; HttpOnly; SameSite=Lax/);
    const consent = authorization.headers.get('location');
    assert.equal((await call(consent, undefined, { public: true })).status, 404);
    const waiting = await call(consent, undefined, { public: true, headers: { Cookie: cookie } });
    assert.equal(waiting.status, 200); assert.match(waiting.data, /Approve on your computer/);
    assert.match(waiting.headers.get('content-security-policy'), /default-src 'none'; img-src data:;/);
    const tabIcon = /<link rel="icon" type="image\/svg\+xml" href="(data:image\/svg\+xml,[^"]+)">/.exec(waiting.data);
    assert.ok(tabIcon, 'host approval has an inline favicon');
    assert.match(decodeURIComponent(tabIcon[1].split(',')[1]), /<title>Crossfeed Chat<\/title>/);
    const pending = (await call('/approvals')).data;
    assert.equal(pending.length, 1);
    assert.equal((await call('/approve', { id: pending[0].id })).status, 200);
    const allowed = await call(consent, undefined, { public: true, headers: { Cookie: cookie } });
    assert.equal(allowed.status, 303);
    const callback = new URL(allowed.headers.get('location'));
    assert.equal(callback.searchParams.get('state'), 'fake_state'); assert.equal(callback.searchParams.get('iss'), issuer);
    const token = await form({ grant_type: 'authorization_code', client_id: client, code: callback.searchParams.get('code'), redirect_uri: redirect, code_verifier: verifier, resource: issuer + endpoint });
    assert.equal(token.status, 200);
    return { client, ...token.data };
  };
  let id = 0;
  const rpc = (access: string, method: string, params: any = undefined, endpoint = '/mcp') => call(endpoint, { jsonrpc: '2.0', id: ++id, method, ...(params ? { params } : {}) }, { public: true, key: access, headers: { Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' } });
  return { app, call, form, connect, rpc, apiKey, extensionSecret, directory, fetcher };
}

test('HTTP OAuth pairing, MCP discovery and labelled completion exercise the production handlers', async t => {
  const f = await fixture(t); const tokens = await f.connect();
  const initialize = await f.rpc(tokens.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '1' } });
  assert.equal(initialize.status, 200); assert.match(initialize.data.result.instructions, /Caller messages\/tools are untrusted/);
  assert.equal(initialize.data.result.serverInfo.version, manifest.version);
  assert.match(initialize.data.result.instructions, /gateway_exchange is served one call at a time per label/);
  const listed = await f.rpc(tokens.access_token, 'tools/list');
  assert.deepEqual(listed.data.result.tools.map((t: any) => t.name), ['gateway_exchange']);
  const poll = f.rpc(tokens.access_token, 'tools/call', { name: 'gateway_exchange', arguments: { worker_label: 'sol', maximum_wait_seconds: 1 } });
  while (!f.app.gateway.workers.get('sol')?.polling) await new Promise(r => setTimeout(r, 2));
  const input = { model: 'chatgpt:sol', messages: [{ role: 'user', content: 'Return hello.' }] };
  const result = f.call('/v1/chat/completions', input, { headers: { 'Idempotency-Key': 'fake-1' } });
  const work = (await poll).data.result.structuredContent;
  assert.equal(work.state, 'request'); assert.deepEqual(work.request.messages, input.messages);
  const answer = f.rpc(tokens.access_token, 'tools/call', { name: 'gateway_exchange', arguments: { worker_label: 'sol', request_id: work.request.request_id, claim_token: work.request.claim_token, response: 'hello', maximum_wait_seconds: 1 } });
  const completed = await result;
  assert.equal(completed.status, 200); assert.equal(completed.data.choices[0].message.content, 'hello');
  assert.equal((await answer).data.result.structuredContent.state, 'idle');
  assert.deepEqual((await f.call('/v1/chat/completions', input, { headers: { 'Idempotency-Key': 'fake-1' } })).data, completed.data);
  assert.equal((await f.call('/v1/chat/completions', { ...input, messages: [{ role: 'user', content: 'Different.' }] }, { headers: { 'Idempotency-Key': 'fake-1' } })).status, 409);
  const models = (await f.call('/v1/models')).data.data;
  assert.equal(models[0].id, 'chatgpt:sol'); assert.equal(models[0].awake, true);
  const disk = await fs.readFile(f.directory + '/oauth.json', 'utf8');
  assert(!disk.includes(tokens.access_token)); assert(!disk.includes(tokens.refresh_token));
});

test('MCP three parallel polls then completion release older polls and deliver the answer promptly', {timeout: 5000}, async t => {
  const f = await fixture(t, {gateway: {timeoutMs: 3000, pollMs: 2000}});
  const tokens = await f.connect();
  const exchange = (args: any) => f.rpc(tokens.access_token, 'tools/call', {name: 'gateway_exchange', arguments: {worker_label: 'sol', ...args}});
  const first = exchange({});
  while (!f.app.gateway.workers.get('sol')?.polling) await new Promise(r => setTimeout(r, 1));
  const promptly = async (promise: any) => {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => {timer = setTimeout(() => reject(Error('MCP call waited for the old poll')), 500);})]); }
    finally { clearTimeout(timer); }
  };
  // TCP arrival order can differ from invocation order. Admit the second poll
  // before starting the third; the original total latency bound covers both.
  const {responses, third} = await promptly((async () => {
    const token = f.app.gateway.workers.get('sol')!.exchange;
    const second = exchange({});
    const deadline = Date.now() + 500;
    while (f.app.gateway.workers.get('sol')!.exchange === token && Date.now() < deadline) await new Promise(r => setTimeout(r, 1));
    assert.notStrictEqual(f.app.gateway.workers.get('sol')!.exchange, token, 'Second poll was not admitted promptly');
    const third = exchange({});
    return {responses: await Promise.all([first, second]), third};
  })());
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.equal(response.data.result.structuredContent.state, 'idle');
  }
  assert.equal(f.app.gateway.workers.get('sol')!.polling, true);
  const caller = f.call('/v1/chat/completions', {model: 'chatgpt:sol', messages: [{role: 'user', content: 'Return 391'}]});
  const work = (await promptly(third)).data.result.structuredContent.request;
  const completion = {request_id: work.request_id, claim_token: work.claim_token, response: '391'};
  const waitingAnswer = exchange(completion);
  assert.equal((await promptly(caller)).data.choices[0].message.content,'391');
  const answer = await waitingAnswer;
  assert.equal(answer.status, 200); assert.equal(answer.data.result.structuredContent.state, 'idle');
  const result = await promptly(caller);
  assert.equal(result.status, 200); assert.equal(result.data.choices[0].message.content, '391');
  assert.equal(f.app.gateway.jobs.get(work.request_id)!.state, 'completed');

  // A completion retry can reuse the RPC ID of an abandoned poll for this label.
  const headers = {Accept: 'application/json, text/event-stream'};
  const call = (args: any) => f.call('/mcp', {jsonrpc: '2.0', id: 'abandoned', method: 'tools/call', params: {name: 'gateway_exchange', arguments: {worker_label: 'sol', ...args}}}, {public: true, key: tokens.access_token, headers});
  const abandoned = call({});
  while (!f.app.gateway.workers.get('sol')!.polling) await new Promise(r => setTimeout(r, 1));
  const retryPoll = call(completion);
  assert.equal((await promptly(abandoned)).data.result.structuredContent.state, 'idle');
  assert.equal(f.app.gateway.workers.get('sol')!.polling,true);
  const retry = await retryPoll;
  assert.equal(retry.status, 200); assert.equal(retry.data.result.structuredContent.state, 'idle');
  assert.equal(f.app.gateway.workers.get('sol')!.polling, false);
});

test('MCP completion retries bypass a same-label poll RPC ID conflict', {timeout: 5000}, async t => {
  const f = await fixture(t, {gateway: {timeoutMs: 3000, pollMs: 50}});
  const tokens = await f.connect();
  const headers = {Accept: 'application/json, text/event-stream'};
  const exchange = (id: any, args: any) => f.call('/mcp', {jsonrpc: '2.0', id, method: 'tools/call', params: {name: 'gateway_exchange', arguments: {worker_label: 'sol', ...args}}}, {public: true, key: tokens.access_token, headers});
  const initial = exchange('initial', {});
  while (!f.app.gateway.workers.get('sol')?.polling) await new Promise(r => setTimeout(r, 1));
  const caller = f.call('/v1/chat/completions', {model: 'chatgpt:sol', messages: [{role: 'user', content: 'Return 391'}]});
  const work = (await initial).data.result.structuredContent.request;
  const completion = {request_id: work.request_id, claim_token: work.claim_token, response: '391'};
  await exchange('first-answer', completion); await caller;
  f.app.gateway.pollMs = 2000;
  const abandoned = exchange('reused-id', {});
  while (!f.app.gateway.workers.get('sol')!.polling) await new Promise(r => setTimeout(r, 1));
  const retry = await exchange('reused-id', completion);
  assert.equal(retry.status, 200);
  assert.equal(retry.data.result.structuredContent.state, 'idle');
  assert.equal((await abandoned).data.result.structuredContent.state, 'idle');
});

test('MCP disconnected poll releases its waiter and a replacement can receive work', {timeout: 5000}, async t => {
  const f = await fixture(t, {gateway: {timeoutMs: 3000, pollMs: 2000}});
  const tokens = await f.connect(), controller = new AbortController();
  const pending = f.fetcher(f.app.mcpUrl, {
    method: 'POST', signal: controller.signal,
    headers: {Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream'},
    body: JSON.stringify({jsonrpc: '2.0', id: 'disconnect', method: 'tools/call', params: {name: 'gateway_exchange', arguments: {worker_label: 'sol'}}})
  });
  const rejected = assert.rejects(pending);
  while (!f.app.gateway.workers.get('sol')?.polling) await new Promise(r => setTimeout(r, 1));
  controller.abort(); await rejected;
  while (f.app.gateway.workers.get('sol')!.polling) await new Promise(r => setTimeout(r, 1));
  const poll = f.rpc(tokens.access_token, 'tools/call', {name: 'gateway_exchange', arguments: {worker_label: 'sol'}});
  while (!f.app.gateway.workers.get('sol')!.polling) await new Promise(r => setTimeout(r, 1));
  const caller = f.call('/v1/chat/completions', {model: 'chatgpt:sol', messages: [{role: 'user', content: 'Return 391'}]});
  const work = (await poll).data.result.structuredContent.request;
  const answer = await f.rpc(tokens.access_token, 'tools/call', {name: 'gateway_exchange', arguments: {worker_label: 'sol', request_id: work.request_id, claim_token: work.claim_token, response: '391'}});
  assert.equal(answer.data.result.structuredContent.state, 'idle');
  assert.equal((await caller).data.choices[0].message.content, '391');
});

test('model listing exposes exact saved settings including level zero and omits them for unsaved workers', async t => {
  const f = await fixture(t, { config: { public_url: issuer, labels: {
    sol: { row: 'Latest', level: 0, url: 'https://chatgpt.com/c/retained' },
    pro: { row: 'Previous', level: 4 },
  } } });
  const tokens = await f.connect();
  assert.equal((await f.rpc(tokens.access_token, 'tools/call', { name: 'gateway_exchange', arguments: { worker_label: 'known', maximum_wait_seconds: 1 } })).data.result.structuredContent.state, 'idle');
  const listed = await f.call('/v1/models');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.data, { object: 'list', data: [
    { id: 'chatgpt:sol', object: 'model', created: 0, owned_by: 'crossfeed-chat', awake: false, saved: true, replicas: 1, row: 'Latest', level: 0, wake_mode: 'configured' },
    { id: 'chatgpt:pro', object: 'model', created: 0, owned_by: 'crossfeed-chat', awake: false, saved: true, replicas: 1, row: 'Previous', level: 4, wake_mode: 'configured' },
    { id: 'chatgpt:known', object: 'model', created: 0, owned_by: 'crossfeed-chat', awake: true, saved: false, replicas: 1 },
  ] });
  assert.equal((await f.call('/workers/add', { label: 'known', row: 'Latest', level: 2 })).status, 200);
  const saved = (await f.call('/v1/models')).data.data.find((w: any) => w.id === 'chatgpt:known');
  assert.equal(saved.saved, true); assert.equal(saved.row, 'Latest'); assert.equal(saved.level, 2);
  assert.equal((await f.call('/workers/add', { label: 'known', row: 'Previous', level: 0 })).status, 200);
  const updated = (await f.call('/v1/models')).data.data.find((w: any) => w.id === 'chatgpt:known');
  assert.equal(updated.row, 'Previous'); assert.equal(updated.level, 0);
  assert.equal((await f.call('/workers/remove', { label: 'known' })).status, 200);
  const unsaved = (await f.call('/v1/models')).data.data.find((w: any) => w.id === 'chatgpt:known');
  assert.equal(unsaved.saved, false); assert.equal(Object.hasOwn(unsaved, 'row'), false); assert.equal(Object.hasOwn(unsaved, 'level'), false);
});

test('HTTP listeners reject cross-boundary authority, bad origins, hosts and unbounded inputs', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/status', undefined, { key: f.extensionSecret })).status, 401);
  assert.equal((await f.call('/extension/next')).status, 401);
  assert.equal((await f.call('/approve', { id: 'anything' }, { public: true })).status, 404);
  assert.equal((await f.call('/v1/models', undefined, { public: true })).status, 404);
  assert.equal((await f.call('/mcp', undefined, { public: true })).status, 401);
  assert.match((await f.call('/mcp', undefined, { public: true })).headers.get('www-authenticate'), /resource_metadata=/);
  assert.equal((await f.call('/status', undefined, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await f.call('/status', undefined, { headers: { Host: 'evil.example' } })).status, 403);
  assert.equal((await f.call('/status', undefined, { headers: { Host: '127.0.0.1:1' } })).status, 403);
  assert.equal((await f.call('/status', undefined, { headers: { Host: new URL(issuer).host } })).status, 403);
  assert.equal((await f.call('/.well-known/oauth-authorization-server', undefined, { public: true, headers: { Host: 'evil.example' } })).status, 403);
  assert.equal((await f.call('/.well-known/oauth-authorization-server', undefined, { public: true, headers: { Host: new URL(issuer).host } })).status, 200);
  assert.equal((await f.call('/oauth/register', {}, { public: true, headers: { Origin: 'null' } })).status, 403);
  assert.equal((await f.call('/oauth/register', {}, { public: true })).status, 403);
  assert.equal((await f.call('/wake', { label: 'test', url: 'https://evil.example/c/x', level: 'Standard' })).status, 400);
  assert.equal((await f.call('/wake', {}, { raw: '{broken' })).status, 400);
  assert.equal((await f.call('/wake', {}, { raw: JSON.stringify({ label: 'x', body: 'x'.repeat(1024 * 1024) }) })).status, 413);
  assert.equal((await f.call('/v1/chat/completions', { model: 'chatgpt:asleep', messages: [{ role: 'user', content: 'x' }] })).status, 503);
});

test('expiring one nonce preserves sibling wake and real authorization without quota reset', async t => {
  let now = Date.now();
  const f = await fixture(t, {
    now: () => now,
    config: {public_url: issuer, labels: {sol: {row: 'Latest', level: 2}}}
  });
  const wakes = f.app.wakes, g = f.app.gateway;
  const a = 'sol~session-' + 'a'.repeat(22);
  const b = 'sol~session-' + 'b'.repeat(22);
  wakes.enqueue(a);
  const first = wakes.next().ticket!;
  wakes.claim(first.nonce);
  wakes.enqueue(b);
  const sibling = [...wakes.tickets.values()].find(t => t.label === b)!;
  assert.equal(sibling.state, 'queued');
  const prior = f.app.config.wake_state!.wakes.slice();
  g.expireWake(a, first.nonce);
  assert.equal(wakes.tickets.get(first.nonce)!.state, 'expired');
  assert.equal(sibling.state, 'queued');
  assert.deepEqual(f.app.config.wake_state!.wakes, prior);
  assert.throws(() => g.authorizeWorker(a, first.nonce), (e: any) => e.status === 409);
  const issued = wakes.next().ticket!;
  assert.equal(issued.nonce, sibling.nonce);
  wakes.claim(sibling.nonce);
  assert.doesNotThrow(() => g.authorizeWorker(b, sibling.nonce));
  assert.equal(f.app.config.wake_state!.wakes.length, prior.length + 1);
});

test('scoped lease expiry fences the matching claimed wake after worker-room eviction', async t => {
  let now = Date.now();
  const f = await fixture(t, {
    now: () => now,
    config: {public_url: issuer, labels: {sol: {row: 'Latest', level: 2}}},
    gateway: {timeoutMs: 300000, leaseMs: 60, pollMs: 1}
  });
  const scope = 'a'.repeat(22), identity = 'sol~session-' + scope;
  const g = f.app.gateway, wakes = f.app.wakes;
  const request = (body: string) => ({model: 'chatgpt:sol', messages: [{role: 'user', content: body}]});
  const first = g.submit(request('claimed'), 'claim-expired', undefined, {caller: scope, scope});
  const rejected = assert.rejects(first, (e: any) => e.code === 'uncertain_delivery');
  const old = wakes.next().ticket!;
  assert.equal(old.label, identity);
  wakes.claim(old.nonce);
  const claimed = await g.exchange('connector', {worker_label: identity, wake_nonce: old.nonce, maximum_wait_seconds: 1}, AbortSignal.abort(), 'old-chat');
  assert.equal(claimed.state, 'request');
  assert.equal(g.capacity().claimed, 1);
  const priorQuota = f.app.config.wake_state!.wakes.slice();
  now += 60;
  g.prune();
  await rejected;
  assert.equal(g.capacity().claimed, 0);
  assert.equal(wakes.tickets.get(old.nonce)!.state, 'expired');
  assert.deepEqual(f.app.config.wake_state!.wakes, priorQuota, 'expiry does not erase issuance history');
  assert.equal(wakes.tickets.get(old.nonce)!.retain_until, now + 600000);

  // Exercise the actual workerRoom eviction path, not a manually deleted worker.
  for (let i = 0; i < 127; i++) {
    const other = 'sol~session-' + String(i).padStart(22, '0');
    g.workers.set(other, {client: 'connector', label: 'sol', seen: now - 100000, polling: false, active: null, stale: true});
  }
  assert.equal(g.workers.size, 128);
  assert.equal(g.workerRoom('sol~session-' + 'z'.repeat(22)), true);
  assert.equal(g.workers.has(identity), false, 'the revoked expired worker was evicted');

  const second = g.submit(request('fresh'), 'claim-fresh', undefined, {caller: scope, scope});
  const fresh = wakes.next().ticket!;
  assert.ok(fresh && fresh.nonce !== old.nonce, 'old ticket must not block the next authorized wake');
  assert.equal(fresh.label, identity);
  wakes.claim(fresh.nonce);
  await assert.rejects(
    g.exchange('connector', {worker_label: identity, wake_nonce: old.nonce, maximum_wait_seconds: 1}, AbortSignal.abort(), 'old-chat'),
    (e: any) => e.status === 409 && /claimed wake nonce/.test(e.message),
    'the stale chat and nonce cannot reauthorize after eviction'
  );
  const work = await g.exchange('connector', {worker_label: identity, wake_nonce: fresh.nonce, maximum_wait_seconds: 1}, AbortSignal.abort(), 'fresh-chat');
  assert.equal(work.state, 'request');
  if (work.state !== 'request') throw Error('Fresh worker failed to claim');
  assert.equal(work.request.request_id, [...g.jobs.values()].find(j => j.key === 'claim-fresh')!.id);
  await g.exchange('connector', {worker_label: identity, wake_nonce: fresh.nonce, request_id: work.request!.request_id, claim_token: work.request!.claim_token, response: 'fresh answer', maximum_wait_seconds: 1}, AbortSignal.abort(), 'fresh-chat');
  assert.equal((await second).choices[0].message.content, 'fresh answer');
  assert.equal(g.capacity().claimed, 0);
});

test('fresh-chat wakes require extension authority and an unexpired single-use nonce', async t => {
  let now = Date.now(); const f = await fixture(t, { now: () => now });
  assert.equal((await f.call('/workers/add', { label: 'sol', row: 'Latest', level: 2 })).status, 200);
  assert.equal((await f.call('/wake', { label: 'sol' })).status, 202);
  assert.equal((await f.call('/wake', { label: 'sol' })).status, 409);
  const extension = (route: string, input: any = undefined) => f.call(route, input, { key: f.extensionSecret, headers: { Origin: 'chrome-extension://' + 'a'.repeat(32) } });
  const next = await extension('/extension/next');
  assert.equal(next.status, 200); assert.equal(next.data.ticket.label, 'sol');
  assert.equal(next.headers.get('access-control-allow-origin'), 'chrome-extension://' + 'a'.repeat(32));
  const ticket = next.data.ticket;
  assert.equal((await extension('/extension/next')).data.ticket, null);
  assert.equal((await extension('/extension/result', { nonce: ticket.nonce, ok: true })).status, 409);
  assert.equal((await extension('/extension/claim', { nonce: ticket.nonce })).status, 200);
  assert.equal((await extension('/extension/claim', { nonce: ticket.nonce })).status, 409);
  assert.equal((await extension('/extension/result', { nonce: ticket.nonce, ok: false, error: f.apiKey })).status, 200);
  assert(!JSON.stringify((await f.call('/status')).data).includes(f.apiKey));
  now += 600001;
  await f.call('/wake', { label: 'sol' });
  const expired = (await extension('/extension/next')).data.ticket;
  now += 240001;
  assert.equal((await extension('/extension/claim', { nonce: expired.nonce })).status, 409);
  assert.equal((await fs.stat(f.directory + '/config.json')).mode & 0o777, 0o600);
});

test('OpenAI buffered SSE carries the assistant result and explicit completion marker', async t => {
  const f = await fixture(t); const tokens = await f.connect();
  const poll = f.rpc(tokens.access_token, 'tools/call', { name: 'gateway_exchange', arguments: { worker_label: 'stream', maximum_wait_seconds: 1 } });
  while (!f.app.gateway.workers.get('stream')?.polling) await new Promise(r => setTimeout(r, 2));
  const result = f.call('/v1/chat/completions', { model: 'chatgpt:stream', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'Say hi' }] });
  const work = (await poll).data.result.structuredContent.request;
  const answer = f.rpc(tokens.access_token, 'tools/call', { name: 'gateway_exchange', arguments: { worker_label: 'stream', request_id: work.request_id, claim_token: work.claim_token, response: 'hi', maximum_wait_seconds: 1 } });
  const stream = await result;
  assert.equal(stream.status, 200); assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  const chunks = stream.data.split('\n\n').filter(Boolean).map((x: any) => x.slice(6));
  assert.equal(chunks.at(-1), '[DONE]'); assert.equal(JSON.parse(chunks[0]).choices[0].delta.content, 'hi');
  assert.equal(JSON.parse(chunks[1]).choices[0].finish_reason, 'stop'); assert.equal(JSON.parse(chunks[2]).usage, null);
  await answer;
});

test('CLI status and approvals operate on the fake server without printing secrets', async t => {
  const f = await fixture(t);
  const run = async (args: any) => {
    let stdout = '';
    await main([...args, '--api-port', new URL(f.app.apiUrl).port], { CROSSFEED_API_KEY: f.apiKey }, { fetch: f.fetcher, log: value => { stdout += value + '\n'; } });
    return { code: 0, stdout };
  };
  const linked = await run(['link']); assert.equal(linked.code, 0); assert.match(linked.stdout, /five minutes/);
  const status = await run(['status']); assert.equal(status.code, 0); assert.deepEqual(JSON.parse(status.stdout).workers, []);
  const approvals = await run(['approve', '--pending']); assert.equal(approvals.code, 0); assert.deepEqual(JSON.parse(approvals.stdout), []);
  for (const output of [linked, status, approvals]) assert(!JSON.stringify(output).includes(f.apiKey));
});

test('MCP cancellation releases only the authenticated client pending poll', async t => {
  const f = await fixture(t); const tokens = await f.connect();
  const headers = { Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' };
  const poll = f.call('/mcp', { jsonrpc: '2.0', id: 'pending-poll', method: 'tools/call', params: { name: 'gateway_exchange', arguments: { worker_label: 'cancel', maximum_wait_seconds: 20 } } }, { public: true, key: tokens.access_token, headers });
  while (!f.app.gateway.workers.get('cancel')?.polling) await new Promise(r => setTimeout(r, 2));
  const cancelled = await f.call('/mcp', { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'pending-poll' } }, { public: true, key: tokens.access_token, headers });
  assert.equal(cancelled.status, 202);
  assert.equal((await poll).data.result.structuredContent.state, 'idle');
  assert.equal(f.app.gateway.workers.get('cancel')!.polling, false);
});

test('one server owns each state directory and clean shutdown releases that ownership', async t => {
  const f = await fixture(t);
  const fake = fakeHTTP();
  const options = { directory: f.directory, apiKey: f.apiKey, apiPort: 0, mcpPort: 0, serverFactory: fake.factory };
  await assert.rejects(createApp(options), e => e.code === 'already_running');
  await f.app.close();
  const next = await createApp(options);
  await next.close();
});

test('CLI saves, lists and removes worker rows and numeric levels with exact status shape', async t => {
  const f = await fixture(t); let stdout = '';
  const run = (args: any) => main([...args, '--api-port', new URL(f.app.apiUrl).port], {CROSSFEED_API_KEY: f.apiKey}, {fetch: f.fetcher, log: value => { stdout = value; }});
  await run(['worker', 'add', 'sol', '--row', 'Latest', '--level', '4']);
  await run(['worker', 'list']); assert.deepEqual(JSON.parse(stdout), {sol: {row: 'Latest', level: 4, wake_mode: 'native'}});
  const status = (await f.call('/v1/gateway/status')).data.workers[0];
  assert.deepEqual({label: status.label, contact: status.contact, polling: status.polling, processing_claim: status.processing_claim}, {label: 'sol', contact: 'never', polling: false, processing_claim: false});
  for (const level of ['-1', '5', 'false', '', '1.5']) await assert.rejects(run(['worker', 'add', 'bad', '--row', 'Latest', '--level', level]));
  await run(['worker', 'set', 'sol', '--replicas', '2']);
  await run(['worker', 'list']); assert.equal(JSON.parse(stdout).sol.replicas, 2);
  for (const replicas of ['0', '17', '1.5', 'false']) await assert.rejects(run(['worker', 'set', 'sol', '--replicas', replicas]));
  await run(['worker', 'remove', 'sol']); assert.deepEqual((await f.call('/workers')).data, {});
  assert.equal((await f.call('/workers/add', {label: 'bad', row: 'Latest', level: '3'})).status, 400);
});

test('HTTP asleep-label completion wakes, claims, retains new chat and retries prior archive', async t => {
  const f = await fixture(t); const tokens = await f.connect();
  await f.call('/workers/add', {label: 'sol', row: 'Latest', level: 3});
  f.app.config.labels.sol.url = 'https://chatgpt.com/c/old';
  const result = f.call('/v1/chat/completions', {model: 'chatgpt:sol', title: '  review\n· Task Manager\u202e  ', messages: [{role: 'user', content: 'Answer'}]}, {headers: {'Idempotency-Key': 'asleep'}});
  while (!f.app.wakes.has('sol')) await new Promise(r => setTimeout(r, 1));
  const extension = (route: string, input: any = undefined) => f.call(route, input, {key: f.extensionSecret});
  const ticket = (await extension('/extension/next')).data.ticket;
  assert.deepEqual({row: ticket.row, level: ticket.level}, {row: 'Latest', level: 3}); assert.equal(ticket.url, undefined);
  assert.equal(ticket.title, 'review · Task Manager');
  await extension('/extension/claim', {nonce: ticket.nonce});
  assert.equal((await extension('/extension/check', {nonce: ticket.nonce})).data.registered, false);
  const work = (await f.rpc(tokens.access_token, 'tools/call', {name: 'gateway_exchange', arguments: {worker_label: 'sol',wake_nonce:ticket.nonce}})).data.result.structuredContent.request;
  assert.equal(work.title, undefined);
  assert.equal((await extension('/extension/check', {nonce: ticket.nonce})).data.registered, true);
  assert.equal((await extension('/extension/result', {nonce: ticket.nonce, ok: true, url: 'https://chatgpt.com/c/new'})).status, 200);
  const archive = (await extension('/extension/archive/next')).data.archive;
  assert.equal(archive.url, 'https://chatgpt.com/c/old');
  await extension('/extension/archive/result', {nonce: archive.nonce, ok: false});
  assert.deepEqual(f.app.config.wake_state!.archives, [archive.url]);
  const answer = f.rpc(tokens.access_token, 'tools/call', {name: 'gateway_exchange', arguments: {worker_label: 'sol', request_id: work.request_id, claim_token: work.claim_token, response: 'Finished'}});
  assert.equal((await result).data.choices[0].message.content, 'Finished'); await answer;
  const disk = JSON.parse(await fs.readFile(f.directory + '/config.json', 'utf8'));
  assert.equal(disk.labels.sol.url, 'https://chatgpt.com/c/new'); assert.deepEqual(disk.wake_state!.archives, [archive.url]);
});

test('extension wake failure retains held HTTP jobs and all new routes preserve authority', async t => {
  const f = await fixture(t); await f.call('/workers/add', {label: 'sol', row: 'Latest', level: 1});
  const result = f.call('/v1/chat/completions', {model: 'chatgpt:sol', messages: [{role: 'user', content: 'Answer'}]});
  while (!f.app.wakes.has('sol')) await new Promise(r => setTimeout(r, 1));
  const ticket = (await f.call('/extension/next', undefined, {key: f.extensionSecret})).data.ticket;
  await f.call('/extension/result', {nonce: ticket.nonce, ok: false}, {key: f.extensionSecret});
  const job = [...f.app.gateway.jobs.values()][0]; assert.equal(job.state, 'queued');
  const work = await f.app.gateway.exchange('connector',{worker_label:'sol'}); assert.ok(work.state==='request');
  await f.app.gateway.exchange('connector',{worker_label:'sol',request_id:work.request!.request_id,claim_token:work.request!.claim_token,response:'retained answer'});
  assert.equal((await result).data.choices[0].message.content, 'retained answer');
  for (const route of ['/workers', '/workers/add', '/workers/remove']) assert.equal((await f.call(route, route === '/workers' ? undefined : {}, {key: f.extensionSecret})).status, 401);
  for (const route of ['/extension/check', '/extension/archive/result']) assert.equal((await f.call(route, {})).status, 401);
  assert.equal((await f.call('/extension/archive/next')).status, 401);
  assert.equal((await f.call('/workers', undefined, {public: true})).status, 404);
});

for (const pause of ['hourly', 'daily', 'cooldown', 'failure-cooldown'] as const) {
  test(`automatic wake delayed by ${pause} keeps its job until the deadline and wakes after release`, async t => {
    let now = new Date(2026, 9, 4, 12).getTime();
    const f = await fixture(t, {now: () => now, gateway: {timeoutMs: 86400000, unclaimedMs: 900000, pollMs: 1}});
    await f.call('/workers/add', {label: 'sol', row: 'Latest', level: 3});
    const state = f.app.config.wake_state!;
    if (pause === 'hourly') { f.app.config.wake_hourly_cap = 1; state.wakes = [now]; }
    if (pause === 'daily') { f.app.config.wake_daily_cap = 1; state.wakes = [now]; }
    if (pause === 'cooldown') state.cooldown_until = now + 1800000;
    if (pause === 'failure-cooldown') state.failed.sol = now;
    const pending = f.app.gateway.submit({model: 'chatgpt:sol', messages: [{role: 'user', content: 'Answer'}]}, 'paused-job');
    const job = [...f.app.gateway.jobs.values()][0];
    assert.equal(f.app.wakes.next().ticket, null);
    assert.equal(job.state, 'queued');
    now += 900001; f.app.gateway.prune(); f.app.wakes.prune();
    assert.equal(job.state, 'queued');
    if (pause === 'daily') now = new Date(2026, 9, 5).getTime();
    if (pause === 'hourly') now += 2700000;
    if (pause === 'cooldown') now += 900000;
    f.app.gateway.prune();
    const ticket = f.app.wakes.next().ticket!;
    assert.ok(ticket); assert.equal(ticket.label, 'sol');
    f.app.wakes.claim(ticket.nonce);
    const work = await f.app.gateway.exchange('paused-client', {worker_label: 'sol'});
    assert.ok(work.state === 'request');
    await f.app.gateway.exchange('paused-client', {worker_label: 'sol', request_id: work.request!.request_id, claim_token: work.request!.claim_token, response: 'Answer'});
    assert.equal((await pending).choices[0].message.content, 'Answer');
  });
}

test('prune retries the stale replica through normal wake dedupe while its sibling is busy', async t => {
  let now = Date.now();
  const f = await fixture(t, {now: () => now, gateway: {timeoutMs: 1800000, pollMs: 1}});
  await f.call('/workers/add', {label: 'sol', row: 'Latest', level: 3, replicas: 2});
  const input = {model: 'chatgpt:sol', messages: [{role: 'user', content: 'Answer'}]};
  await f.app.gateway.exchange('replica-client', {worker_label: 'sol'});
  const first = f.app.gateway.submit(input);
  const work = await f.app.gateway.exchange('replica-client', {worker_label: 'sol'});
  assert.ok(work.state === 'request');
  await f.app.gateway.exchange('replica-client', {worker_label: 'sol~replica-2'});
  const controller = new AbortController();
  const second = f.app.gateway.submit(input, undefined, controller.signal);
  assert.equal([...f.app.wakes.tickets.values()].filter(t=>t.state==='queued').length,1);
  now += 45001; f.app.gateway.prune(); f.app.gateway.prune();
  assert.equal([...f.app.wakes.tickets.values()].filter(t=>t.state==='queued').length,1);
  assert.equal([...f.app.wakes.tickets.values()].find(t=>t.state==='queued')!.label, 'sol~replica-2');
  controller.abort(); await assert.rejects(second, e => e.code === 'caller_cancelled');
  assert.equal(f.app.wakes.next().ticket, null);
  assert.ok([...f.app.wakes.tickets.values()].every(t=>t.state==='cancelled'));
  await f.app.gateway.exchange('replica-client', {worker_label: 'sol', request_id: work.request!.request_id, claim_token: work.request!.claim_token, response: 'Answer'});
  await first;
});

test('the service immediately wakes queued work when recent contact has no poller', async t => {
  let now = Date.now();
  const f = await fixture(t, {now: () => now, gateway: {timeoutMs: 1800000, pollMs: 1}});
  await f.call('/workers/add', {label: 'sol', row: 'Latest', level: 3});
  await f.app.gateway.exchange('tick-client', {worker_label: 'sol'});
  const pending = f.app.gateway.submit({model: 'chatgpt:sol', messages: [{role: 'user', content: 'Answer'}]});
  assert.equal(f.app.wakes.tickets.size, 1);
  now += 45001;
  await new Promise(resolve => setTimeout(resolve, 1100));
  const ticket = f.app.wakes.next().ticket!;
  assert.ok(ticket); assert.equal(ticket.label, 'sol');
  const work = await f.app.gateway.exchange('tick-client', {worker_label: 'sol'});
  assert.ok(work.state === 'request');
  await f.app.gateway.exchange('tick-client', {worker_label: 'sol', request_id: work.request!.request_id, claim_token: work.request!.claim_token, response: 'Answer'});
  await pending;
});

test('a capped production job waits beyond its old deadline and completes when wakes resume', async t => {
  let now = Date.now();
  const f = await fixture(t, {now: () => now, gateway: {timeoutMs: 1800000, unclaimedMs: 900000, pollMs: 1}});
  await f.call('/workers/add', {label: 'sol', row: 'Latest', level: 3});
  f.app.config.wake_hourly_cap = 0;
  const pending = f.app.gateway.submit({model: 'chatgpt:sol', messages: [{role: 'user', content: 'Answer'}]});
  assert.equal(f.app.wakes.next().ticket, null);
  now += 1800000; f.app.gateway.prune();
  assert.equal([...f.app.gateway.jobs.values()][0].state,'queued');
  assert.equal(f.app.wakes.next().ticket,null);
  f.app.config.wake_hourly_cap=12;
  const ticket=f.app.wakes.next().ticket!;assert.ok(ticket);f.app.wakes.claim(ticket.nonce);
  const work=await f.app.gateway.exchange('client',{worker_label:'sol'});assert.ok(work.state==='request');
  await f.app.gateway.exchange('client',{worker_label:'sol',request_id:work.request!.request_id,claim_token:work.request!.claim_token,response:'completed'});
  assert.equal((await pending).choices[0].message.content,'completed');
});

for (const recent of [false, true]) test(`a caller adopts an existing manual wake under the cap (recent contact: ${recent})`, async t => {
  let now = Date.now();
  const f = await fixture(t, {now: () => now, gateway: {timeoutMs: 1800000, unclaimedMs: 900000, pollMs: 1}});
  await f.call('/workers/add', {label: 'sol', row: 'Latest', level: 3});
  f.app.config.wake_hourly_cap = 0;
  f.app.wakes.enqueue('sol');
  if (recent) await f.app.gateway.exchange('manual-client', {worker_label: 'sol', maximum_wait_seconds: 1});
  const pending = f.app.gateway.submit({model: 'chatgpt:sol', messages: [{role: 'user', content: 'Answer'}]});
  assert.equal(f.app.wakes.next().ticket, null);
  now += 900001; f.app.gateway.prune(); f.app.wakes.prune();
  assert.equal([...f.app.gateway.jobs.values()][0].state, 'queued');
  assert.ok([...f.app.wakes.tickets.values()].some(t => t.state === 'queued'));
  f.app.config.wake_hourly_cap = 12;
  const ticket = f.app.wakes.next().ticket!;
  assert.ok(ticket);
  const work = await f.app.gateway.exchange('manual-client', {worker_label: 'sol'});
  assert.ok(work.state === 'request');
  await f.app.gateway.exchange('manual-client', {worker_label: 'sol', request_id: work.request.request_id, claim_token: work.request.claim_token, response: 'Answer'});
  await pending;
});

test('server config persists deadline, both wake caps, archive queue and model settings across restart', async t => {
  const f = await fixture(t, {gateway: undefined, config: {public_url: issuer, job_deadline_ms: 2400000, wake_daily_cap: 2, wake_hourly_cap: 1}});
  assert.equal(f.app.gateway.timeoutMs, 2400000);
  await f.call('/workers/add', {label: 'sol', row: 'Latest', level: 4});
  await f.call('/wake', {label: 'sol'});
  const ticket = (await f.call('/extension/next', undefined, {key: f.extensionSecret})).data.ticket;
  await f.call('/extension/claim', {nonce: ticket.nonce}, {key: f.extensionSecret});
  await f.call('/extension/result', {nonce: ticket.nonce, ok: false, url: 'https://chatgpt.com/c/orphan'}, {key: f.extensionSecret});
  await f.app.close(); const fake = fakeHTTP();
  const restarted = await createApp({directory: f.directory, apiKey: f.apiKey, apiPort: 0, mcpPort: 0, serverFactory: fake.factory});
  assert.equal(restarted.gateway.timeoutMs, 2400000); assert.equal(restarted.config.wake_daily_cap, 2); assert.equal(restarted.config.wake_hourly_cap, 1); assert.deepEqual(restarted.config.labels.sol, {row: 'Latest', level: 4, wake_mode: 'native'});
  assert.deepEqual(restarted.config.wake_state!.archives, ['https://chatgpt.com/c/orphan']);
  assert.equal(restarted.config.wake_state!.wakes.length, 1);
  const limits = restarted.status().wake_limits;
  assert.equal(limits.daily_cap, 2); assert.equal(limits.hourly_cap, 1);
  assert.equal(limits.attempts, 1); assert.equal(limits.hourly_attempts, 1);
  assert.match(limits.blocked!, /Hourly/);
  assert.equal(restarted.wakes.archiveNext().archive!.url, 'https://chatgpt.com/c/orphan');
  restarted.wakes.enqueue('sol'); assert.equal(restarted.wakes.next().ticket, null);
  await restarted.close();
});

test('expired claimed extension wake can persist orphan cleanup through the real HTTP handler', async t => {
  let now = Date.now(); const f = await fixture(t, {now: () => now});
  await f.call('/workers/add', {label: 'sol', row: 'Latest', level: 3}); await f.call('/wake', {label: 'sol'});
  const extension = (route: string, input: any = undefined) => f.call(route, input, {key: f.extensionSecret});
  const ticket = (await extension('/extension/next')).data.ticket;
  await extension('/extension/claim', {nonce: ticket.nonce}); now += 240000;
  const result = await extension('/extension/result', {nonce: ticket.nonce, ok: false, url: 'https://chatgpt.com/c/orphan'});
  assert.equal(result.status, 200); assert.equal(f.app.wakes.status()[0].state, 'expired');
  const disk = JSON.parse(await fs.readFile(f.directory + '/config.json', 'utf8'));
  assert.deepEqual(disk.wake_state!.archives, ['https://chatgpt.com/c/orphan']);
  assert.equal((await extension('/extension/result', {nonce: ticket.nonce, ok: false, url: 'https://chatgpt.com/c/orphan'})).status, 409);
});

test('two approved clients can share an RPC ID; cancellation and duplicate refusal stay client-scoped', async t => {
  const f = await fixture(t, {gateway: {timeoutMs: 300, pollMs: 2000}});
  const a = await f.connect('client_alpha'), b = await f.connect('client_bravo');
  const headers = {Accept: 'application/json, text/event-stream'};
  const call = (tokens: any, body: any) => f.call('/mcp', body, {public: true, key: tokens.access_token, headers});
  const args = (name: any) => ({jsonrpc: '2.0', id: 'same-id', method: 'tools/call', params: {name: 'gateway_exchange', arguments: {worker_label: name}}});
  const first = call(a, args('alpha')), second = call(b, args('bravo'));
  while (!f.app.gateway.workers.get('bravo')?.polling) await new Promise(r => setTimeout(r, 1));
  assert.equal((await call(a, args('alpha'))).status, 409);
  const cancel = {jsonrpc: '2.0', method: 'notifications/cancelled', params: {requestId: 'same-id'}};
  assert.equal((await call(a, cancel)).status, 202); await first;
  assert.equal(f.app.gateway.workers.get('alpha')!.polling, false); assert.equal(f.app.gateway.workers.get('bravo')!.polling, true);
  await call(b, cancel); await second;
  const retry = call(a, args('alpha'));
  while (!f.app.gateway.workers.get('alpha')!.polling) await new Promise(r => setTimeout(r, 1));
  await call(a, cancel); assert.equal((await retry).status, 200);
});
test('one connector can poll two labels with the same RPC ID without cross-label cancellation', {timeout: 5000}, async t => {
  const f = await fixture(t, {gateway: {timeoutMs: 3000, pollMs: 2000}});
  const tokens = await f.connect();
  const headers = {Accept: 'application/json, text/event-stream'};
  const call = (body: any) => f.call('/mcp', body, {public: true, key: tokens.access_token, headers});
  const poll = (name: any) => call({jsonrpc: '2.0', id: 7, method: 'tools/call', params: {name: 'gateway_exchange', arguments: {worker_label: name}}});
  const first = poll('alpha');
  while (!f.app.gateway.workers.get('alpha')?.polling) await new Promise(r => setTimeout(r, 1));
  let finished = false;
  const second = poll('bravo').then(value => { finished = true; return value; });
  // Wait for either registration or the erroneous early refusal.
  const until = Date.now() + 1000;
  while (!f.app.gateway.workers.get('bravo')?.polling && !finished && Date.now() < until) await new Promise(r => setTimeout(r, 1));
  assert.equal(f.app.gateway.workers.get('bravo')?.polling, true);
  assert.equal((await call({jsonrpc: '2.0', method: 'notifications/cancelled', params: {requestId: 7}})).status, 202);
  assert.equal(f.app.gateway.workers.get('alpha')!.polling, true, 'ambiguous cancellation must not stop another chat');
  assert.equal(f.app.gateway.workers.get('bravo')!.polling, true);
  const submit = (name: any) => f.call('/v1/chat/completions', {model: 'chatgpt:' + name, messages: [{role: 'user', content: 'answer'}]});
  const a = submit('alpha'), b = submit('bravo');
  const requests = await Promise.all([first, second]);
  for (const [index, name] of ['alpha', 'bravo'].entries()) {
    assert.equal(requests[index].status, 200);
    const work = requests[index].data.result.structuredContent.request;
    const answer = await call({jsonrpc: '2.0', id: 7, method: 'tools/call', params: {name: 'gateway_exchange', arguments: {worker_label: name, request_id: work.request_id, claim_token: work.claim_token, response: name}}});
    assert.equal(answer.status, 200);
  }
  assert.equal((await a).data.choices[0].message.content, 'alpha');
  assert.equal((await b).data.choices[0].message.content, 'bravo');
});

test('special-property worker labels roundtrip independently and pending work prevents settings edits', async t => {
  const f = await fixture(t); const tokens = await f.connect();
  for (const name of ['__proto__', 'constructor', 'other']) assert.equal((await f.call('/workers/add', {label: name, row: 'Latest', level: 0})).status, 200);
  const labels = (await f.call('/workers')).data;
  assert((await f.call('/status')).data.workers.every((worker: any) => worker.quota_until === 0));
  assert.equal(Object.keys(labels).length, 3); assert.equal(labels.__proto__.level, 0); assert.equal(labels.constructor.row, 'Latest');
  await f.call('/wake', {label: '__proto__'});
  assert.equal((await f.call('/workers/remove', {label: '__proto__'})).status, 409);
  const ticket = (await f.call('/extension/next', undefined, {key: f.extensionSecret})).data.ticket;
  const unrelated = f.rpc(tokens.access_token, 'tools/call', {name: 'gateway_exchange', arguments: {worker_label: 'other'}});
  while (!f.app.gateway.workers.get('other')?.polling) await new Promise(r => setTimeout(r, 1));
  await f.call('/extension/claim', {nonce: ticket.nonce}, {key: f.extensionSecret});
  assert.equal((await f.call('/extension/check', {nonce: ticket.nonce}, {key: f.extensionSecret})).data.registered, false);
  await f.call('/extension/result', {nonce: ticket.nonce, ok: false}, {key: f.extensionSecret});
  assert.equal((await f.call('/workers/remove', {label: 'constructor'})).status, 200);
  assert.equal((await f.call('/workers')).data.other.level, 0);
  const disk = JSON.parse(await fs.readFile(f.directory + '/config.json', 'utf8'));
  assert(Object.hasOwn(disk.labels, '__proto__')); assert(!Object.hasOwn(disk.labels, 'constructor')); await unrelated;
});
test('buffered SSE preserves required and named tool choices, indexes, finish reason, usage and a single DONE', async t => {
  const f = await fixture(t); const tokens = await f.connect();
  for (const choice of ['required', {type: 'function', function: {name: 'lookup'}}]) {
    const poll = f.rpc(tokens.access_token, 'tools/call', {name: 'gateway_exchange', arguments: {worker_label: 'tools'}});
    while (!f.app.gateway.workers.get('tools')?.polling) await new Promise(r => setTimeout(r, 1));
    const result = f.call('/v1/chat/completions', {model: 'chatgpt:tools', messages: [{role: 'user', content: 'Look it up'}], tools: [{type: 'function', function: {name: 'lookup'}}], tool_choice: choice, parallel_tool_calls: false, stream: true, stream_options: {include_usage: true}});
    const job = (await poll).data.result.structuredContent.request;
    const answer = f.rpc(tokens.access_token, 'tools/call', {name: 'gateway_exchange', arguments: {worker_label: 'tools', request_id: job.request_id, claim_token: job.claim_token, tool_calls: [{id: 'call-1', type: 'function', function: {name: 'lookup', arguments: '{"query":"test"}'}}]}});
    const chunks = (await result).data.split('\n\n').filter(Boolean).map((x: any) => x.slice(6));
    assert.equal(chunks.filter((x: any) => x === '[DONE]').length, 1);
    assert.equal(JSON.parse(chunks[0]).choices[0].delta.tool_calls[0].index, 0);
    assert.equal(JSON.parse(chunks[0]).choices[0].delta.tool_calls[0].function.name, 'lookup');
    assert.equal(JSON.parse(chunks[1]).choices[0].finish_reason, 'tool_calls'); assert.equal(JSON.parse(chunks[2]).usage, null); await answer;
  }
});

test('quota circuit persists worker reports and extension rate limits per label across a server restart', async t => {
  let now = Date.now(); const f = await fixture(t, {now: () => now}); const tokens = await f.connect();
  for (const name of ['sol', 'other']) await f.call('/workers/add', {label: name, row: 'Latest', level: 0});
  const pending = f.app.gateway.submit({model: 'chatgpt:sol', messages: [{role: 'user', content: 'answer'}]}, 'quota-http');
  const job = (await f.rpc(tokens.access_token, 'tools/call', {name: 'gateway_exchange', arguments: {worker_label: 'sol'}})).data.result.structuredContent.request;
  const answer = await f.rpc(tokens.access_token, 'tools/call', {name: 'gateway_exchange', arguments: {worker_label: 'sol', request_id: job.request_id, claim_token: job.claim_token, error: 'rate_limited'}});
  assert.equal(answer.data.result.structuredContent.state, 'released'); await assert.rejects(pending, e => e.code === 'rate_limited');
  assert.equal((await f.call('/wake', {label: 'sol'})).status, 429);
  await f.call('/wake', {label: 'other'}); const ticket = (await f.call('/extension/next', undefined, {key: f.extensionSecret})).data.ticket;
  assert.equal(ticket.label, 'other'); await f.call('/extension/result', {nonce: ticket.nonce, ok: false, error: 'rate_limited'}, {key: f.extensionSecret});
  const disk = JSON.parse(await fs.readFile(f.directory + '/config.json', 'utf8'));
  assert.equal(disk.quota_until.sol, now + 3600000); assert.equal(disk.quota_until.other, now + 3600000);
  await f.app.close(); const fake = fakeHTTP();
  const next = await createApp({directory: f.directory, apiKey: f.apiKey, apiPort: 0, mcpPort: 0, serverFactory: fake.factory, now: () => now});
  t.after(() => next.close()); assert(next.status().workers.every(w => w.quota_blocked));
  assert.throws(() => next.gateway.submit({model: 'chatgpt:sol', messages: [{role: 'user', content: 'new'}]}), e => e.code === 'quota_blocked');
  now += 3600001; assert(next.status().workers.every(w => !w.quota_blocked));
});

test('doctor prints actionable operational problems without caller payloads or credentials', async t => {
  const f = await fixture(t); const tokens = await f.connect();
  let output = ''; const run = () => main(['doctor', '--api-port', new URL(f.app.apiUrl).port], {CROSSFEED_API_KEY: f.apiKey}, {fetch: f.fetcher, log: value => {output = value;}});
  await run(); assert.match(output, /No workers are configured.*Next: run worker add/);
  await f.call('/workers/add', {label: 'sol', row: 'Latest', level: 0}); await run(); assert.match(output, /sol: no active worker contact.*run wake sol/);
  const result = f.app.gateway.submit({model: 'chatgpt:sol', messages: [{role: 'user', content: f.apiKey}]}, 'doctor');
  await f.rpc(tokens.access_token, 'tools/call', {name: 'gateway_exchange', arguments: {worker_label: 'sol'}});
  f.app.gateway.deliveryLost([...f.app.gateway.jobs.values()][0], 'test interruption'); await assert.rejects(result);
  await run(); assert.match(output, /unknown outcome.*Next: inspect/); assert(!output.includes(f.apiKey)); assert(!output.includes(tokens.access_token));
  f.app.config.quota_until!.sol = Date.now() + 3600000; await run(); assert.match(output, /ChatGPT quota is paused.*Next: wait/);
});

test('client CLI revocation invalidates grants, ends pending polls and releases labels without affecting other clients', async t => {
  const f = await fixture(t, {gateway: {pollMs: 2000, timeoutMs: 300}}), a = await f.connect('revoke_alpha'), b = await f.connect('revoke_bravo');
  const polling = f.rpc(a.access_token, 'tools/call', {name: 'gateway_exchange', arguments: {worker_label: 'alpha'}});
  while (!f.app.gateway.workers.get('alpha')?.polling) await new Promise(r => setTimeout(r, 1));
  let output = ''; const run = (args: any) => main([...args, '--api-port', new URL(f.app.apiUrl).port], {CROSSFEED_API_KEY: f.apiKey}, {fetch: f.fetcher, log: value => {output = value;}});
  await run(['client', 'list']); assert.equal(JSON.parse(output).length, 2); assert(!output.includes(a.access_token));
  assert.equal((await f.call('/clients', undefined, {key: f.extensionSecret})).status, 401); assert.equal((await f.call('/clients', undefined, {public: true})).status, 404);
  await run(['client', 'revoke', a.client]); assert.equal(JSON.parse(output).revoked, a.client);
  assert.equal((await polling).data.result.structuredContent.state, 'released'); assert.equal((await f.rpc(a.access_token, 'ping')).status, 401);
  assert.equal((await f.rpc(b.access_token, 'ping')).status, 200);
  const replacement = f.rpc(b.access_token, 'tools/call', {name: 'gateway_exchange', arguments: {worker_label: 'alpha'}});
  while (!f.app.gateway.workers.get('alpha')?.polling) await new Promise(r => setTimeout(r, 1));
  f.app.gateway.workers.get('alpha')!.notify!(); assert.equal((await replacement).data.result.structuredContent.state, 'idle');
});

test('a verified extension observation reaches even an answer completed before wake confirmation', async t => {
  const f = await fixture(t), tokens = await f.connect(); await f.call('/workers/add', {label: 'sol', row: 'Latest', level: 0});
  const pending = f.call('/v1/chat/completions', {model: 'chatgpt:sol', messages: [{role: 'user', content: 'answer'}], stream: true});
  while (!f.app.wakes.has('sol')) await new Promise(r => setTimeout(r, 1));
  const extension = (route: string, input: any = undefined) => f.call(route, input, {key: f.extensionSecret});
  const ticket = (await extension('/extension/next')).data.ticket;
  assert.equal((await extension('/extension/observe', {nonce: ticket.nonce, picker_receipt: {row: 'Latest', level: 0}})).status, 409);
  await extension('/extension/claim', {nonce: ticket.nonce});
  assert.equal((await extension('/extension/observe', {nonce: ticket.nonce, picker_receipt: {row: 'Wrong', level: 0}})).status, 409);
  assert.equal((await extension('/extension/observe', {nonce: ticket.nonce, picker_receipt: {row: 'Latest', level: 0}})).status, 200);
  const job = (await f.rpc(tokens.access_token, 'tools/call', {name: 'gateway_exchange', arguments: {worker_label: 'sol'}})).data.result.structuredContent.request;
  const answer = f.rpc(tokens.access_token, 'tools/call', {name: 'gateway_exchange', arguments: {worker_label: 'sol', request_id: job.request_id, claim_token: job.claim_token, response: 'answer'}});
  const frames = (await pending).data.split('\n\n').filter(Boolean).slice(0, -1).map((frame: any) => JSON.parse(frame.slice(6)));
  for (const frame of frames) { assert.equal(frame.metadata.worker_label, 'sol'); assert.equal(frame.metadata.picker_receipt.row, 'Latest'); assert.equal(frame.metadata.picker_receipt.level, 0); assert.equal(frame.metadata.picker_receipt.source, 'extension'); }
  await answer;
  assert.equal((await f.call('/extension/observe', {nonce: ticket.nonce, picker_receipt: {row: 'Latest', level: 0}})).status, 401);
});

test('revoking a client while its MCP body arrives prevents dispatch by that already-authenticated request', async t => {
  const {EventEmitter} = await import('node:events'); const {PassThrough} = await import('node:stream');
  const servers: any[] = [], transport = fakeHTTP(); const f = await fixture(t, {serverFactory: (options: any, handler: any) => {const server = transport.factory(options, handler); servers.push(server); return server;}});
  // Use the authenticated OAuth object directly; this request deliberately arrives in chunks.
  f.app.oauth.open(); const redirect = 'https://chatgpt.com/connector/oauth/slow_client', verifier = nonce() + nonce();
  const client = f.app.oauth.register({redirect_uris: [redirect]});
  const approval = f.app.oauth.authorize({client_id: client.client_id, redirect_uri: redirect, response_type: 'code', code_challenge_method: 'S256', code_challenge: hash(verifier), state: 'slow-body', resource: issuer + '/mcp'});
  f.app.oauth.approve(approval.id); const code = new URL(f.app.oauth.consent(approval.id, approval.browser).redirect!).searchParams.get('code');
  const token = f.app.oauth.token({grant_type: 'authorization_code', client_id: client.client_id, code, redirect_uri: redirect, code_verifier: verifier, resource: issuer + '/mcp'}).access_token;
  f.app.config.labels.sol = {row: 'Latest', level: 0}; f.app.gateway.wake = () => {};
  const pending = f.app.gateway.submit({model: 'chatgpt:sol', messages: [{role: 'user', content: 'private payload'}]}, 'slow-revoke');
  const req = new PassThrough(); req.headers = {host: new URL(f.app.mcpUrl).host, authorization: 'Bearer ' + token, accept: 'application/json, text/event-stream', 'content-type': 'application/json'};
  req.socket = {localPort: Number(new URL(f.app.mcpUrl).port)}; req.url = '/mcp'; req.method = 'POST';
  const res: any = new EventEmitter(); let response: any; res.setHeader = () => {}; res.writeHead = (status: number) => {res.status = status;}; res.end = (raw: any) => {res.writableEnded = true; response = JSON.parse(raw); res.emit('close');};
  const handling = servers[1].handler(req, res); req.write('{');
  await new Promise(resolve => setImmediate(resolve)); f.app.oauth.revoke(client.client_id); f.app.gateway.revokeClient(client.client_id);
  req.end('"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"gateway_exchange","arguments":{"worker_label":"sol"}}}');
  await handling; assert.equal(res.status, 401); assert.equal(f.app.gateway.workers.has('sol'), false); assert.equal(f.app.gateway.capacity().claimed, 0); assert.equal(response!.error.code, -32602);
  f.app.gateway.close(); await assert.rejects(pending);
});

test('doctor distinguishes rejected credentials from an unreachable listener', async t => {
  const f = await fixture(t); const wrong = nonce() + nonce();
  await assert.rejects(main(['doctor', '--api-port', new URL(f.app.apiUrl).port], {CROSSFEED_API_KEY: wrong}, {fetch: f.fetcher, log: () => assert.fail('no status on rejected authentication')}), e => e.status === 401 && /authentication was refused/.test(e.message) && !e.message.includes(wrong));
});

test('extension pairing HTTP requires extension Origin and owner approval, persists, revokes and cannot escalate',async t=>{
  const f=await fixture(t); const origin='chrome-extension://'+'b'.repeat(32),secret=nonce()+nonce();
  const options={headers:{Origin:origin},key:''};
  assert.equal((await f.call('/extension/pair',{secret},{key:''})).status,403);
  assert.equal((await f.call('/extension/pair',{secret},{...options,headers:{Origin:'https://chatgpt.com'}})).status,403);
  assert.equal((await f.call('/extension/pair',{secret:f.apiKey},options)).status,400);
  const record=(await f.call('/extension/pair',{secret},options)).data;
  const ext=(route: string,input: any = undefined,headers={Origin:origin})=>f.call(route,input,{key:secret,headers});
  assert.equal((await ext('/extension/next')).status,401);
  assert.equal((await ext('/extensions/approve',{id:record.id})).status,403);
  assert.equal((await f.call('/extensions/approve',{id:record.code})).status,200);
  assert.equal((await ext('/extension/next')).status,200);
  assert.equal((await ext('/extension/next',undefined,{Origin:'chrome-extension://'+'c'.repeat(32)})).status,401);
  for(const route of ['/approve','/clients','/v1/models','/status','/v1/chat/completions']) assert.equal((await f.call(route,undefined,{key:secret})).status,401);
  const persisted=await fs.readFile(f.directory+'/extension-pairings.json','utf8');assert(!persisted.includes(secret));
  assert.equal((await f.call('/extensions/revoke',{id:record.id})).status,200);
  assert.equal((await ext('/extension/next')).status,401);
  assert.equal((await f.call('/extensions',{id:record.id},{public:true})).status,404);
});

test('HTTP multimodal job emits native MCP blocks, downloads generated files and protects binary retrieval',async t=>{
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jgekAAAAASUVORK5CYII=','base64');
  const f=await fixture(t,{audio:{enabled:false},files:{download:async()=>({status:200,data:png})},gateway:{timeoutMs:3000,pollMs:10}});const tokens=await f.connect();
  await f.call('/workers/add',{label:'sol',row:'Latest',level:2});
  await f.rpc(tokens.access_token,'tools/call',{name:'gateway_exchange',arguments:{worker_label:'sol'}});
  const data=Buffer.alloc(1100*1024,65);
  const wav=Buffer.alloc(44);wav.write('RIFF');wav.write('WAVE',8);
  const pdf=Buffer.from('%PDF-1.7\n'),docx=Buffer.from([80,75,3,4,0,1]);
  const input={model:'chatgpt:sol',messages:[{role:'user',content:[{type:'text',text:'Read these'},{type:'image_url',image_url:{url:'data:image/png;base64,'+png.toString('base64')}},{type:'input_audio',input_audio:{format:'wav',data:wav.toString('base64')}},...[['note.txt',data],['report.pdf',pdf],['report.docx',docx]].map(([filename,bytes])=>({type:'file',file:{filename,file_data:bytes.toString('base64')}}))]}]};
  const pending=f.call('/v1/chat/completions',input,{headers:{'Idempotency-Key':'multi-http'}});
  while(!f.app.gateway.jobs.size) await new Promise(r=>setTimeout(r,1));
  const delivered=(await f.rpc(tokens.access_token,'tools/call',{name:'gateway_exchange',arguments:{worker_label:'sol'}})).data.result;
  assert.deepEqual(delivered.content.map((p: any)=>p.type),['text','image','resource','audio','resource','resource','resource','resource']);
  assert.equal(delivered.content[1].data,png.toString('base64'));assert.equal(delivered.content[3].data,wav.toString('base64'));
  for(const [index,name,bytes,mime] of [[2,'attachment.png',png,'image/png'],[4,'attachment.wav',wav,'audio/wav'],[5,'note.txt',data,'text/plain'],[6,'report.pdf',pdf,'application/pdf'],[7,'report.docx',docx,'application/vnd.openxmlformats-officedocument.wordprocessingml.document']] as [number,string,Buffer,string][]) {
    const resource=delivered.content[index].resource;
    assert.equal(resource.mimeType,mime);assert.equal(new URL(resource.uri).pathname,`/${name}`);
    assert.deepEqual(Buffer.from(resource.blob,'base64'),bytes);
  }
  const work=delivered.structuredContent.request;
  const tool=(await f.rpc(tokens.access_token,'tools/list')).data.result.tools[0];
  assert.deepEqual(tool._meta['openai/fileParams'],['files']);assert.deepEqual(tool.inputSchema.properties.files.items.required,['download_url','file_id']);
  await f.rpc(tokens.access_token,'tools/call',{name:'gateway_exchange',arguments:{worker_label:'sol',request_id:work.request_id,claim_token:work.claim_token,response:'Generated',files:[{download_url:'https://example.com/signed',file_id:'f',file_name:'result.png',mime_type:'text/plain'}]}});
  const completed=await pending;assert.equal(completed.status,200);assert.equal(completed.data.files[0].mime,'image/png');assert.equal(f.app.files.rows.filter((r: any)=>r.kind==='input').length,0);
  const route='/v1/files/'+completed.data.files[0].id+'/content';
  const streamPending=f.call('/v1/chat/completions',{...input,stream:true},{headers:{'Idempotency-Key':'multi-stream'}});
  while(!f.app.gateway.idempotency.has('multi-stream')) await new Promise(r=>setTimeout(r,1));
  const streamWork=(await f.rpc(tokens.access_token,'tools/call',{name:'gateway_exchange',arguments:{worker_label:'sol'}})).data.result.structuredContent.request;
  await f.rpc(tokens.access_token,'tools/call',{name:'gateway_exchange',arguments:{worker_label:'sol',request_id:streamWork.request_id,claim_token:streamWork.claim_token,response:'Streamed',files:[{download_url:'https://example.com/stream',file_id:'g',file_name:'stream.png'}]}});
  const stream=await streamPending;assert.equal(stream.status,200);
  const frame=JSON.parse(stream.data.split('\n')[0].slice(6));assert.equal(frame.files[0].name,'stream.png');
  const binary=await f.fetcher(f.app.apiUrl+route,{headers:{Authorization:'Bearer '+f.apiKey}});assert.equal(binary.status,200);assert.deepEqual(Buffer.from(await binary.arrayBuffer()),png);assert.match(binary.headers.get('content-disposition'),/attachment/);
  assert.equal((await f.call(route,undefined,{key:f.extensionSecret})).status,401);assert.equal((await f.call(route,undefined,{public:true,key:tokens.access_token})).status,404);
  assert.equal((await f.call('/v1/files/'+nonce()+'/content')).status,404);
});

test('HTTP composer isolates exact job, confirms exact contact, defers archive and preserves normal chat',async t=>{
  const f=await fixture(t,{config:{public_url:issuer,attachment_delivery:'composer',labels:{sol:{row:'Latest',level:2,url:'https://chatgpt.com/c/normal'}}},gateway:{timeoutMs:3000,pollMs:10}});const tokens=await f.connect();
  await f.rpc(tokens.access_token,'tools/call',{name:'gateway_exchange',arguments:{worker_label:'sol'}});
  const ext=(route: string,input: any = undefined)=>f.call(route,input,{key:f.extensionSecret});
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jgekAAAAASUVORK5CYII=';
  const pending=f.call('/v1/chat/completions',{model:'chatgpt:sol',title:'image review',messages:[{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,'+png}}]}]});
  while(![...f.app.wakes.tickets.values()].some(t=>t.type==='composer')) await new Promise(r=>setTimeout(r,1));
  const ticket=(await ext('/extension/next')).data.ticket;assert.equal(ticket.type,'composer');assert.equal(ticket.title,'image review');assert.equal(ticket.attachments.length,1);assert.equal(ticket.attachments[0].path.split('/').at(-1),ticket.attachments[0].name);
  await ext('/extension/claim',{nonce:ticket.nonce});assert.equal((await ext('/extension/check',{nonce:ticket.nonce})).data.registered,false);
  const normal=(await f.rpc(tokens.access_token,'tools/call',{name:'gateway_exchange',arguments:{worker_label:'sol'}})).data.result.structuredContent;assert.equal(normal.state,'idle');
  const work=(await f.rpc(tokens.access_token,'tools/call',{name:'gateway_exchange',arguments:{worker_label:'sol',request_id:ticket.job_id}})).data.result.structuredContent.request;
  assert.equal(work.request_id,ticket.job_id);assert.equal(work.title,undefined);assert.equal((await ext('/extension/check',{nonce:ticket.nonce})).data.registered,true);
  assert.equal((await ext('/extension/result',{nonce:ticket.nonce,ok:true,url:'https://chatgpt.com/c/one-shot'})).status,200);
  assert.equal((await ext('/extension/archive/next')).data.archive,null);
  const finished=(await f.rpc(tokens.access_token,'tools/call',{name:'gateway_exchange',arguments:{worker_label:'sol',request_id:work.request_id,claim_token:work.claim_token,response:'Image answer'}})).data.result.structuredContent;assert.equal(finished.state,'released');
  assert.equal((await pending).status,200);assert.equal(f.app.config.labels.sol.url,'https://chatgpt.com/c/normal');assert.equal((await ext('/extension/archive/next')).data.archive.url,'https://chatgpt.com/c/one-shot');
});

test('revoking an extension while its POST body arrives prevents the already-authenticated mutation',async t=>{
  const {EventEmitter}=await import('node:events');const {PassThrough}=await import('node:stream');
  const servers: any[] = [],transport=fakeHTTP();const f=await fixture(t,{serverFactory:(options: any,handler: any)=>{const server=transport.factory(options,handler);servers.push(server);return server;}});
  f.app.config.labels.sol={row:'Latest',level:0};f.app.wakes.enqueue('sol');const ticket=f.app.wakes.next().ticket;
  const req=new PassThrough();req.headers={host:new URL(f.app.apiUrl).host,authorization:'Bearer '+f.extensionSecret,origin:'chrome-extension://'+'a'.repeat(32),'content-type':'application/json'};req.socket={localPort:Number(new URL(f.app.apiUrl).port)};req.url='/extension/claim';req.method='POST';
  const res: any =new EventEmitter();res.setHeader=()=>{};res.writeHead=(status: number)=>{res.status=status;};res.end=()=>{res.writableEnded=true;res.emit('close');};
  const handling=servers[0].handler(req,res);req.write('{');await new Promise(r=>setImmediate(r));
  f.app.pairing.revoke(f.app.pairing.list().approved[0].id);req.end('"nonce":"'+ticket!.nonce+'"}');await handling;
  assert.equal(res.status,401);assert.equal(f.app.wakes.tickets.get(ticket!.nonce)!.state,'issued');
});


test('OAuth MCP workbench discovery, edit and refusal use production handlers', async t => {
  const root = await fs.mkdtemp(tempPrefix('crossfeed-mcp-workbench-'));
  t.after(() => fs.rm(root, {recursive:true,force:true}));
  const {spawnSync} = await import('node:child_process');
  assert.equal(spawnSync('/usr/bin/git',['init','-q',root]).status,0);
  await fs.writeFile(root+'/hello.txt','before\n');
  const f = await fixture(t, {workbench:{roots:[root]}});
  const tokens = await f.connect('workbench_client', '/tools/mcp');
  const listed = await f.rpc(tokens.access_token,'tools/list', undefined, '/tools/mcp');
  assert.equal(listed.data.result.tools.length,7);
  const initialized=await f.rpc(tokens.access_token,'initialize',{protocolVersion:'2025-06-18'}, '/tools/mcp');
  assert.match(initialized.data.result.instructions,/Direct owner tools/);
  const run = (name: any,args: any) => f.rpc(tokens.access_token,'tools/call',{name:'workbench_'+name,arguments:args}, '/tools/mcp');
  const roots=await run('roots',{});
  assert.equal(roots.data.result.structuredContent.roots[0].root,'root1');
  const read=await run('read',{root:'root1',path:'hello.txt'});
  assert.equal(read.data.result.structuredContent.text,'before\n');
  const edit=await run('apply_patch',{root:'root1',path:'hello.txt',before:'before',after:'after'});
  assert.equal(edit.data.result.structuredContent.edited,true);
  assert.equal(await fs.readFile(root+'/hello.txt','utf8'),'after\n');
  const refused=await run('read',{root:'root1',path:'.git/config'});
  assert.equal(refused.data.result.isError,true);
  assert.match(refused.data.result.content[0].text,/refused/);
  await f.call('/clients/revoke',{id:tokens.client});
  assert.equal((await run('roots',{})).status,401);
});

test('MCP notification cancellation and client revocation stop active workbench commands', {skip:process.platform!=='darwin'}, async t => {
  const root=await fs.mkdtemp(tempPrefix('crossfeed-command-cancel-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const {spawnSync}=await import('node:child_process');spawnSync('/usr/bin/git',['init','-q',root]);
  const f=await fixture(t,{workbench:{roots:[root],commands:{[root]:{wait:['/bin/sleep','60']}}}});
  const tokens=await f.connect('cancel_workbench', '/tools/mcp');
  const start=async()=>{
    const requestId=98765;
    const pending=f.call('/tools/mcp',{jsonrpc:'2.0',id:requestId,method:'tools/call',params:{name:'workbench_run',arguments:{root:'root1',command:'wait'}}},{public:true,key:tokens.access_token,headers:{Accept:'application/json, text/event-stream'}});
    const deadline=Date.now()+3000;
    while(!f.app.workbench!.busy&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));
    assert(f.app.workbench!.busy);return {requestId,pending};
  };
  const cancelled=await start();
  await f.call('/tools/mcp',{jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:cancelled.requestId}},{public:true,key:tokens.access_token,headers:{Accept:'application/json, text/event-stream'}});
  assert.equal((await cancelled.pending).data.result.structuredContent.stopped,'cancelled');
  const revoked=await start();await f.call('/clients/revoke',{id:tokens.client});
  assert.equal((await revoked.pending).data.result.structuredContent.stopped,'cancelled');
});

test('OAuth MCP bridge is startup-only, audits denials, and refuses browser control access', {skip: process.platform !== 'darwin'}, async t => {
  const base = await fs.mkdtemp(tempPrefix('crossfeed-http-bridge-'));
  t.after(() => fs.rm(base, {recursive:true,force:true}));
  const filename = base + '/bridge.json';
  await fs.writeFile(filename, JSON.stringify({servers:{gaddi:{command:process.execPath,args:[fileURLToPath(new URL('./bridge-peer.ts',import.meta.url))],tools:{browser_open:'allow',browser_click:'allow'}}}}), {mode:0o600});
  const f = await fixture(t, {bridge:filename});
  const tokens = await f.connect('bridge_client', '/tools/mcp');
  const listed = await f.rpc(tokens.access_token, 'tools/list', undefined, '/tools/mcp');
  assert(listed.data.result.tools.some((tool: any)=>tool.name==='bridge_gaddi_browser_open'));
  assert(!listed.data.result.tools.some((tool: any)=>tool.name==='bridge_gaddi_browser_eval'));
  assert.equal((f.app.config as typeof f.app.config & {bridge?: unknown}).bridge, undefined);
  const call = (name: any,args: any) => f.rpc(tokens.access_token,'tools/call',{name:'bridge_gaddi_browser_'+name,arguments:args}, '/tools/mcp');
  assert.equal((await call('status',{})).data.result.isError, undefined);
  assert.equal((await call('eval',{expression:'1'})).data.result.isError,true);
  assert.equal((await call('open',{url:'http://127.0.0.1:4319/status'})).data.result.isError,true);
  // Node fetch overwrites Sec-Fetch-Mode with cors; raw HTTP preserves the browser probe.
  assert.equal((await f.call('/status',undefined,{headers:{host:new URL(f.app.apiUrl).host,'Sec-Fetch-Mode':'navigate'}})).status,403);
  assert.equal((await f.call('/link',{}, {headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
  assert.equal((await f.call('/status')).status,200);
  assert.equal((await f.call('/status',undefined,{public:true,key:tokens.access_token})).status,404);
  const audit = await fs.readFile(f.app.bridge!.auditFile,'utf8');
  assert(audit.includes('"state":"refused"')); assert(!audit.includes('expression')); assert(!audit.includes(tokens.access_token));
  await f.call('/clients/revoke',{id:tokens.client});
  assert.equal((await call('status',{})).status,401);
});


test('gateway and direct tools have separate discovery, calls and OAuth audiences', {skip: process.platform !== 'darwin'}, async t => {
  const base = await fs.mkdtemp(tempPrefix('crossfeed-isolation-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = base + '/folder'; await fs.mkdir(root);
  const settings = base + '/settings.json';
  await fs.writeFile(settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{type: 'command', command: 'exit 0'}] }] } }));
  const bridge = base + '/bridge.json';
  await fs.writeFile(bridge, JSON.stringify({ servers: { qmd: { command: process.execPath, args: [fileURLToPath(new URL('./bridge-peer.ts', import.meta.url))], tools: {} } } }), { mode: 0o600 });
  const f = await fixture(t, { workbench: { roots: [root], shell: 'full', guardSettings: settings }, bridge });
  const worker = await f.connect('worker_isolation');
  const owner = await f.connect('owner_isolation', '/tools/mcp');
  assert.deepEqual((await f.rpc(worker.access_token, 'tools/list')).data.result.tools.map((t: any) => t.name), ['gateway_exchange']);
  assert.equal((await f.rpc(worker.access_token, 'tools/call', {name: 'workbench_roots', arguments: {}})).status, 400);
  assert.equal((await f.rpc(worker.access_token, 'tools/call', {name: 'bridge_qmd_query', arguments: {}})).status, 400);
  assert.equal((await f.rpc(worker.access_token, 'tools/list', undefined, '/tools/mcp')).status, 401);
  assert.equal((await f.rpc(owner.access_token, 'tools/list')).status, 401);
  const tools = (await f.rpc(owner.access_token, 'tools/list', undefined, '/tools/mcp')).data.result.tools.map((t: any) => t.name);
  assert(tools.includes('workbench_start')); assert(tools.includes('workbench_job')); assert(tools.includes('bridge_qmd_query'));
  assert(!tools.includes('gateway_exchange'));
  assert.equal((await f.rpc(owner.access_token, 'tools/call', {name: 'gateway_exchange', arguments: {worker_label:'sol'}}, '/tools/mcp')).status, 400);
  for (const [token, client, endpoint] of [[worker, worker.client, '/tools/mcp'], [owner, owner.client, '/mcp']]) {
    assert.equal((await f.form({grant_type:'refresh_token', client_id:client, refresh_token:token.refresh_token, resource:issuer + endpoint})).status,400);
  }
  const refresh = await f.form({grant_type:'refresh_token',client_id:owner.client,refresh_token:owner.refresh_token,resource:issuer + '/tools/mcp'});
  assert.equal(refresh.status,200);
  assert.equal((await f.rpc(refresh.data.access_token,'tools/list',undefined,'/tools/mcp')).status,200);
  assert.equal((await f.rpc(refresh.data.access_token,'tools/list')).status,401);
  const metadata = await f.call('/.well-known/oauth-protected-resource/tools/mcp',undefined,{public:true});
  assert.equal(metadata.data.resource, issuer + '/tools/mcp');
});


test('CLI revocation accepts an OAuth client ID beginning with a hyphen', async () => {
  let route, payload: any;
  await main(['client','revoke','-synthetic-client','--api-port','4319'],{CROSSFEED_API_KEY:'x'.repeat(32)}, {log:()=>{}, fetch:async (url,init) => {
    route=url;payload=JSON.parse(init.body as string);return {ok:true,json:async()=>({revoked:payload.id})} as Awaited<ReturnType<NonNullable<Parameters<typeof main>[2]>['fetch']>>;
  }});
  assert.equal(route,'http://127.0.0.1:4319/clients/revoke'); assert.equal(payload.id,'-synthetic-client');
});

// Chrome's host-permitted GET can omit Origin; POST carries the extension origin.
test('extension queue transport claims wakes and retries archives with Chrome-shaped Origin headers', async t => {
  const f = await fixture(t);
  const origin = 'chrome-extension://' + 'a'.repeat(32);
  const config = { apiURL: f.app.apiUrl, key: f.extensionSecret };
  const chromeFetch = (url: any, init: any) => f.fetcher(url, { ...init, headers: { ...init.headers, ...(init.method === 'POST' ? { Origin: origin } : {}) } });
  await f.call('/workers/add', {label: 'sol', row: 'Latest', level: 3});
  await f.call('/wake', {label: 'sol'});
  const missingOrigin = await f.fetcher(config.apiURL + '/extension/next', {headers: {Authorization: 'Bearer ' + config.key}});
  assert.equal(missingOrigin.status, 401);
  assert.equal(f.app.wakes.status()[0].state, 'queued');
  const {ticket} = await extensionRequest(config, '/extension/next', undefined, chromeFetch);
  assert.ok(validTicket(ticket));
  assert.equal(ticket!.label, 'sol');
  await extensionRequest(config, '/extension/claim', {nonce: ticket!.nonce}, chromeFetch);
  assert.equal(f.app.wakes.status()[0].state, 'claimed');
  f.app.config.wake_state!.archives.push('https://chatgpt.com/c/orphan');
  const {archive} = await extensionRequest(config, '/extension/archive/next', undefined, chromeFetch);
  assert.equal(archive!.url, 'https://chatgpt.com/c/orphan');
  for (const route of ['/extension/next', '/extension/archive/next']) {
    assert.equal((await f.call(route, {}, {key: f.extensionSecret, headers: {Origin: 'https://chatgpt.com'}})).status, 403);
    assert.equal((await f.call(route, {}, {key: f.apiKey, headers: {Origin: origin}})).status, 401);
  }
});

test('HTTP replicas serve two concurrent callers with distinct wakes and durable chats', async t => {
  const f = await fixture(t, {gateway: {timeoutMs: 5000, pollMs: 5}}), tokens = await f.connect();
  assert.equal((await f.call('/workers/add', {label: 'sol', row: 'Latest', level: 3})).status, 200);
  assert.equal((await f.call('/workers/set', {label: 'sol', replicas: 2})).status, 200);
  const models = (await f.call('/v1/models')).data.data;
  assert.equal(models.length, 1); assert.equal(models[0].id, 'chatgpt:sol'); assert.equal(models[0].replicas, 2);
  for (const replicas of [0, 1.5, 17, '2', null, true]) assert.equal((await f.call('/workers/set', {label: 'sol', replicas})).status, 400);
  const extension = (route: string, input?: any) => f.call(route, input, {key: f.extensionSecret});
  const exchange = async (identity: string, extra: any = {}) => (await f.rpc(tokens.access_token, 'tools/call', {name: 'gateway_exchange', arguments: {worker_label: identity, ...extra}})).data.result.structuredContent;
  const input = {model: 'chatgpt:sol', messages: [{role: 'user', content: 'Answer'}]};
  const one = f.call('/v1/chat/completions', input, {headers: {'Idempotency-Key': 'replicas-one'}});
  while (!f.app.wakes.has('sol')) await new Promise(r => setTimeout(r, 1));
  const a = (await extension('/extension/next')).data.ticket;
  assert.equal(a.label, 'sol');
  assert.equal((await extension('/extension/next')).data.ticket, null);
  await extension('/extension/claim', {nonce: a.nonce});
  const workA = (await exchange(a.label,{wake_nonce:a.nonce})).request;
  await extension('/extension/result', {nonce: a.nonce, ok: true, url: 'https://chatgpt.com/c/replica-one'});
  // One busy worker without waiting work never wakes its second replica.
  f.app.gateway.wake('sol'); assert.equal((await extension('/extension/next')).data.ticket, null);
  const two = f.call('/v1/chat/completions', input, {headers: {'Idempotency-Key': 'replicas-two'}});
  while (!f.app.wakes.has('sol')) await new Promise(r => setTimeout(r, 1));
  const b = (await extension('/extension/next')).data.ticket;
  assert.equal(b.label, 'sol~replica-2');
  await extension('/extension/claim', {nonce: b.nonce});
  assert.equal((await extension('/extension/check', {nonce: b.nonce})).data.registered, false);
  const workB = (await exchange(b.label,{wake_nonce:b.nonce})).request;
  assert.equal((await extension('/extension/check', {nonce: b.nonce})).data.registered, true);
  assert.equal(f.app.gateway.capacity().claimed, 2);
  await extension('/extension/result', {nonce: b.nonce, ok: true, url: 'https://chatgpt.com/c/replica-two'});
  assert.deepEqual(f.app.config.wake_state!.archives, []);
  await Promise.all([[a, workA], [b, workB]].map(([ticket, work]) => exchange(ticket.label, {request_id: work.request_id, claim_token: work.claim_token, response: ticket.label})));
  const replies = await Promise.all([one, two]);
  assert(replies.every(r => r.status === 200));
  assert.deepEqual(replies.map(r => r.data.metadata.worker_identity), ['sol', 'sol~replica-2']);
  const disk = JSON.parse(await fs.readFile(f.directory + '/config.json', 'utf8'));
  assert.equal(disk.labels.sol.replicas, 2);
  assert.equal(disk.labels.sol.url, 'https://chatgpt.com/c/replica-one');
  assert.equal(disk.labels.sol.replica_urls['2'], 'https://chatgpt.com/c/replica-two');
  assert.equal((await f.call('/workers/set', {label: 'sol', replicas: 1})).status, 200);
  assert.equal(f.app.config.labels.sol.replica_urls!['2'], 'https://chatgpt.com/c/replica-two');
});

test('HTTP extra replica wake guards preserve queued work for a healthy sibling', async t => {
  const f = await fixture(t, {gateway: {timeoutMs: 5000, pollMs: 1}}), tokens = await f.connect();
  await f.call('/workers/add', {label: 'sol', row: 'Latest', level: 3, replicas: 2});
  const input = {model: 'chatgpt:sol', messages: [{role: 'user', content: 'Answer'}]};
  const exchange = async (identity: string, extra: any = {}) => (await f.rpc(tokens.access_token, 'tools/call', {name: 'gateway_exchange', arguments: {worker_label: identity, ...extra}})).data.result.structuredContent;
  const one = f.call('/v1/chat/completions', input);
  while (!f.app.wakes.has('sol')) await new Promise(r => setTimeout(r, 1));
  // The original worker returns before its automatic wake has issued.
  const a = (await exchange('sol')).request;
  const two = f.call('/v1/chat/completions', input);
  while (f.app.gateway.jobs.size < 2) await new Promise(r => setTimeout(r, 1));
  const ticket = f.app.wakes.next().ticket!; // busy target cancelled; waiting demand wakes the idle replica immediately
  assert.equal(ticket.label, 'sol~replica-2'); f.app.wakes.claim(ticket.nonce);
  f.app.wakes.result({nonce: ticket.nonce, ok: false, error: 'browser_error'});
  assert.equal(f.app.gateway.capacity().claimed, 1);
  assert.equal([...f.app.gateway.jobs.values()].filter(j => j.state === 'queued' && !j.finished).length, 1);
  const before = f.app.wakes.tickets.size;
  for (let i = 0; i < 10; i++) f.app.gateway.wake('sol');
  assert.equal(f.app.wakes.tickets.size, before); // cooldown must not churn failed tickets
  f.app.config.wake_daily_cap = 0;
  const b = (await exchange('sol', {request_id: a.request_id, claim_token: a.claim_token, response: 'first'})).request;
  assert.equal((await one).status, 200);
  await exchange('sol', {request_id: b.request_id, claim_token: b.claim_token, response: 'second'});
  assert.equal((await two).data.choices[0].message.content, 'second');
});

test('HTTP lowering replica count releases removed idle polls before they can claim', async t => {
  const f = await fixture(t, {gateway: {timeoutMs: 5000, pollMs: 5000}}), tokens = await f.connect();
  await f.call('/workers/add', {label: 'sol', row: 'Latest', level: 3, replicas: 2});
  const rpc = (identity: string, extra: any = {}) => f.rpc(tokens.access_token, 'tools/call', {name: 'gateway_exchange', arguments: {worker_label: identity, ...extra}});
  const polling = rpc('sol~replica-2');
  while (!f.app.gateway.workers.get('sol~replica-2')?.polling) await new Promise(r => setTimeout(r, 1));
  assert.equal((await f.call('/workers/set', {label: 'sol', replicas: 1})).status, 200);
  assert.equal((await polling).data.result.structuredContent.state, 'released');
  const result = f.call('/v1/chat/completions', {model: 'chatgpt:sol', messages: [{role: 'user', content: 'Answer'}]});
  while (!f.app.wakes.has('sol')) await new Promise(r => setTimeout(r, 1));
  const work = (await rpc('sol')).data.result.structuredContent.request;
  await rpc('sol', {request_id: work.request_id, claim_token: work.claim_token, response: 'first'});
  assert.equal((await result).data.metadata.worker_label, 'sol');
});

test('HTTP healthy manually registered replicas keep serving without a paired extension', async t => {
  const f = await fixture(t, {gateway: {timeoutMs: 5000, pollMs: 1}}), tokens = await f.connect();
  await f.call('/workers/add', {label: 'sol', row: 'Latest', level: 3, replicas: 2});
  for (const pairing of f.app.pairing.list().approved) f.app.pairing.revoke(pairing.id);
  const exchange = async (identity: string, extra: any = {}) => (await f.rpc(tokens.access_token, 'tools/call', {name: 'gateway_exchange', arguments: {worker_label: identity, ...extra}})).data.result.structuredContent;
  await exchange('sol');
  const input = {model: 'chatgpt:sol', messages: [{role: 'user', content: 'Answer'}]};
  const first = f.call('/v1/chat/completions', input);
  while (f.app.gateway.jobs.size < 1) await new Promise(r => setTimeout(r, 1));
  const a = (await exchange('sol')).request;
  const second = f.call('/v1/chat/completions', input);
  while (f.app.gateway.jobs.size < 2) await new Promise(r => setTimeout(r, 1));
  await new Promise(r => setTimeout(r, 1100)); // exercise the production maintenance callback
  assert.equal(f.app.gateway.closed, false);
  const b = (await exchange('sol', {request_id: a.request_id, claim_token: a.claim_token, response: 'first'})).request;
  await exchange('sol', {request_id: b.request_id, claim_token: b.claim_token, response: 'second'});
  assert((await Promise.all([first, second])).every(r => r.status === 200));
});

test('default audio transcripts reach the authenticated worker and leave input bytes unchanged', async t => {
  let calls = 0;
  const f = await fixture(t, {audio: {recognize: async (file: string, locale: string) => {
    calls++; assert.equal(locale, 'en-US'); assert.match(file, /attachment\.wav$/);
    assert.deepEqual(await fs.readFile(file), wav); return 'Unseen spoken words';
  }}, gateway: {timeoutMs: 3000, pollMs: 10}});
  const tokens = await f.connect();
  await f.call('/workers/add', {label: 'sol', row: 'Latest', level: 2});
  await f.rpc(tokens.access_token, 'tools/call', {name: 'gateway_exchange', arguments: {worker_label: 'sol'}});
  const wav = Buffer.alloc(44); wav.write('RIFF'); wav.write('WAVE', 8);
  const input = {model: 'chatgpt:sol', messages: [{role: 'user', content: [{type: 'input_audio', input_audio: {format: 'wav', data: wav.toString('base64')}}]}]};
  const pending = f.call('/v1/chat/completions', input, {headers: {'Idempotency-Key': 'spoken'}});
  while (!f.app.gateway.jobs.size) await new Promise(r => setTimeout(r, 1));
  const delivered = (await f.rpc(tokens.access_token, 'tools/call', {name: 'gateway_exchange', arguments: {worker_label: 'sol'}})).data.result;
  assert.equal(calls, 1); assert.match(delivered.structuredContent.request.messages[0].content[1].text, /Audio transcript.*\nUnseen spoken words$/);
  assert.deepEqual(JSON.parse(delivered.content[0].text), delivered.structuredContent);
  assert.equal(delivered.content[1].data, wav.toString('base64'));
  assert.equal(delivered.structuredContent.request.messages[0].content[0].mime, 'audio/wav');
  const storedContent = [...f.app.gateway.jobs.values()][0].request.messages[0].content;
  assert.ok(Array.isArray(storedContent));
  assert.equal(storedContent.length, 1, 'transcript must not mutate persisted request or retry digest');
  const work = delivered.structuredContent.request;
  await f.rpc(tokens.access_token, 'tools/call', {name: 'gateway_exchange', arguments: {worker_label: 'sol', request_id: work.request_id, claim_token: work.claim_token, response: 'Unseen spoken words'}});
  assert.equal((await pending).status, 200);
  assert.equal((await f.call('/v1/chat/completions', input, {headers: {'Idempotency-Key': 'spoken'}})).status, 200);
  assert.equal(calls, 1); assert.equal(f.app.files.rows.length, 0);
});

test('wake checks distinguish a claimed MCP media job from ordinary contact and completed work', async t => {
  const f = await fixture(t, {config: {public_url: issuer, labels: {sol: {row: 'Latest', level: 1}}}, gateway: {timeoutMs: 2000, pollMs: 10}});
  f.app.wakes.enqueue('sol'); const ticket = f.app.wakes.next().ticket!; f.app.wakes.claim(ticket.nonce);
  const pending = f.app.gateway.submit({model: 'chatgpt:sol', messages: [{role: 'user', content: [{type: 'file', file: {filename: 'fixture.txt', file_data: Buffer.from('fixture').toString('base64')}}]}]});
  const value = await f.app.gateway.exchange('connector', {worker_label: 'sol',wake_nonce:ticket.nonce}, AbortSignal.abort());
  assert.equal(value.state, 'request');
  assert.deepEqual(f.app.wakes.check(ticket.nonce), {registered: true, media_pending: true});
  if (value.state !== 'request') throw Error('No media claim');
  await f.app.gateway.exchange('connector', {worker_label: 'sol', request_id: value.request.request_id, claim_token: value.request.claim_token, response: 'observed'}, AbortSignal.abort());
  await pending;
  assert.equal(f.app.wakes.check(ticket.nonce).media_pending, undefined);
});

 test('public root health responds without exposing control state', async t => {
  const f = await fixture(t);
  const result = await f.call('/', undefined, {public: true});
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, {service: 'crossfeed-chat', status: 'ok'});
  assert.equal((await f.call('/status', undefined, {public: true})).status, 404);
});

test('HTTP two Pi session headers open independent workers, bind wake nonces and emit content-free receipts', async t => {
  let now=Date.now();
  const f=await fixture(t,{now:()=>now,gateway:{pollMs:1,timeoutMs:5000}}); const token=await f.connect();
  await f.call('/workers/add',{label:'sol',row:'Latest',level:3,replicas:2});
  const input={model:'chatgpt:sol',messages:[{role:'user',content:'PRIVATE-PROMPT-DO-NOT-RECORD'}]};
  const headers=(session:string,key:string)=>({'User-Agent':'pi/0.test','x-session-affinity':session,'Idempotency-Key':key});
  const first=f.call('/v1/chat/completions',input,{headers:headers('PI-SESSION-ONE','one')});
  while(f.app.gateway.jobs.size<1) await new Promise(r=>setTimeout(r,1));
  const retry=f.call('/v1/chat/completions',input,{headers:headers('PI-SESSION-ONE','retry')});
  const second=f.call('/v1/chat/completions',input,{headers:headers('PI-SESSION-TWO','one')});
  while(f.app.gateway.jobs.size<2) await new Promise(r=>setTimeout(r,1));
  const ext=(route:string,input:any)=>f.call(route,input,{key:f.extensionSecret});
  const works:any[]=[]; const tickets:any[]=[];
  for(const conversation of ['CHATGPT-ONE','CHATGPT-TWO']) {
    const ticket=(await ext('/extension/next',{})).data.ticket; tickets.push(ticket);
    assert.equal(ticket.label,`wake-${ticket.nonce}`); await ext('/extension/claim',{nonce:ticket.nonce});
    const missing=await f.rpc(token.access_token,'tools/call',{name:'gateway_exchange',arguments:{worker_label:f.app.wakes.tickets.get(ticket.nonce)!.label},_meta:{'openai/session':conversation}});
    assert.equal(missing.data.result.isError,true);
    const result=await f.rpc(token.access_token,'tools/call',{name:'gateway_exchange',arguments:{worker_label:ticket.label,wake_nonce:ticket.nonce},_meta:{'openai/session':conversation}});
    assert.equal(result.data.result.structuredContent.state,'request'); works.push(result.data.result.structuredContent.request);
    assert.equal((await ext('/extension/check',{nonce:ticket.nonce})).data.registered,true);
    assert.equal((await ext('/extension/result',{nonce:ticket.nonce,ok:true,url:`https://chatgpt.com/c/${conversation}`})).status,200);
    now+=100;
  }
  assert.notEqual(tickets[0].label,tickets[1].label); assert.equal(f.app.gateway.jobs.size,2);
  const cross=await f.rpc(token.access_token,'tools/call',{name:'gateway_exchange',arguments:{worker_label:tickets[1].label,wake_nonce:tickets[1].nonce},_meta:{'openai/session':'CHATGPT-ONE'}});
  assert.equal(cross.data.result.isError,true);
  for(const [i,work] of works.entries()) await f.rpc(token.access_token,'tools/call',{name:'gateway_exchange',arguments:{worker_label:tickets[i].label,wake_nonce:tickets[i].nonce,request_id:work.request_id,claim_token:work.claim_token,response:`PRIVATE-ANSWER-${i}`},_meta:{'openai/session':['CHATGPT-ONE','CHATGPT-TWO'][i]}});
  const replies=await Promise.all([first,retry,second]); assert(replies.every(r=>r.status===200)); assert.equal(replies[0].data.id,replies[1].data.id); assert.notEqual(replies[0].data.id,replies[2].data.id);
  const raw=await fs.readFile(f.directory+'/receipts.json','utf8'); const rows=JSON.parse(raw).receipts;
  assert.equal(rows.length,2); assert(rows.every((r:any)=>r.enqueue_at && r.claim_at && r.wake_at && r.finish_at && r.wake_needed && r.outcome==='completed'));
  assert.notEqual(rows[0].caller,rows[1].caller); assert(rows.every((r:any)=>r.replica.includes('~session-')));
  for(const privateText of ['PRIVATE-PROMPT','PRIVATE-ANSWER','PI-SESSION','CHATGPT-ONE','CHATGPT-TWO','retry','messages','digest','claim_token']) assert(!raw.includes(privateText),privateText);
  assert.equal((await fs.stat(f.directory+'/receipts.json')).mode & 0o077,0);
  const disk=JSON.parse(await fs.readFile(f.directory+'/config.json','utf8')); assert.equal(Object.keys(disk.session_workers).length,2); assert.equal(disk.labels.sol.url,undefined);
});

test('joining scoped HTTP work inherits the issued wake timestamp in its receipt', async t => {
  let now = 50_000;
  const f = await fixture(t, {now: () => now, gateway: {timeoutMs: 300, pollMs: 20, extensionGraceMs: 1000}});
  await f.call('/workers/add', {label: 'sol', row: 'Latest', level: 0});
  const headers = {'X-Crossfeed-Session': 'j'.repeat(22)};
  const send = (content: string) => f.call('/v1/chat/completions',
    {model: 'chatgpt:sol', messages: [{role: 'user', content}]}, {headers});
  const first = send('before issued wake');
  while (f.app.gateway.jobs.size !== 1) await new Promise(r => setTimeout(r, 1));
  const ticket = (await f.call('/extension/next', undefined, {key: f.extensionSecret})).data.ticket;
  assert.ok(ticket?.issued_at !== undefined);
  const original = [...f.app.gateway.jobs.values()][0];
  assert.equal(original.wake_at, ticket.issued_at);

  now += 1234;
  const second = send('joined after wake issued');
  while (Number(f.app.gateway.jobs.size) !== 2) await new Promise(r => setTimeout(r, 1));
  const joined = [...f.app.gateway.jobs.values()].find(job => job.id !== original.id)!;
  assert.equal(joined.wake_at, ticket.issued_at, 'joiner reuses the original issued time, not its enqueue time');
  assert.equal(joined.wake_needed, true);
  const rows = JSON.parse(await fs.readFile(f.directory + '/receipts.json', 'utf8')).receipts;
  const receipt = rows.find((row: any) => row.request === joined.id);
  assert.ok(receipt, 'the joining job has a persisted receipt');
  assert.equal(receipt.wake_at, ticket.issued_at);
  assert.equal(receipt.wake_needed, true);
  assert.equal(receipt.outcome, 'queued');

  now = ticket.issued_at + 241_001;
  f.app.gateway.prune();
  const results = await Promise.all([first, second]);
  assert(results.every(result => result.status === 503 && result.data.error.code === 'extension_unavailable'));
});

test('MCP atomic completion wait carries eight delayed local-tool continuations over production HTTP', {timeout:10000}, async t => {
  const f = await fixture(t, {gateway:{timeoutMs:5000, pollMs:1000}}), tokens = await f.connect('tool_continuations');
  await f.call('/workers/add', {label:'sol', row:'Latest', level:2});
  const toolSpec = {type:'function', function:{name:'lookup', parameters:{type:'object'}}};
  const toolCall = (id: string) => ({id, type:'function', function:{name:'lookup', arguments:'{"value":1}'}});
  const messagesFor = (i: number) => i === 0 ? [{role:'user',content:'start tools'}] : [
    {role:'user',content:'start tools'},
    {role:'assistant',content:null,tool_calls:[toolCall(`prior_${i}`)]},
    {role:'tool',content:`local result ${i}`,tool_call_id:`prior_${i}`},
  ];
  const submit = (i: number) => f.call('/v1/chat/completions', {model:'chatgpt:sol', messages:messagesFor(i), tools:[toolSpec], tool_choice:'required'}, {headers:{'X-Crossfeed-Session':'pi-continuation-session'}});
  let caller = submit(0);
  while (!f.app.wakes.has('sol', undefined, null)) await new Promise(r => setTimeout(r, 1));
  const ext = (route: string, input?: any) => f.call(route, input ?? {}, {key:f.extensionSecret});
  const ticket = (await ext('/extension/next')).data.ticket;
  assert.equal((await ext('/extension/claim', {nonce:ticket.nonce})).status, 200);
  const identity = f.app.wakes.tickets.get(ticket.nonce)!.label;
  const exchange = (args: Record<string, any> = {}) => f.rpc(tokens.access_token, 'tools/call', {
    name:'gateway_exchange', arguments:{worker_label:identity, wake_nonce:ticket.nonce, maximum_wait_seconds:1, ...args},
    _meta:{'openai/session':'continuation-conversation'},
  });
  let workerWait = exchange();
  for (let i = 0; i < 8; i++) {
    const reply = await workerWait;
    assert.equal(reply.status, 200);
    assert.equal(reply.data.result.isError, undefined);
    const work = reply.data.result.structuredContent;
    assert.equal(work.state, 'request'); assert.equal(work.worker_label, identity);
    assert.deepEqual(work.request.messages, messagesFor(i));
    if (i === 0) {
      assert.equal((await ext('/extension/check', {nonce:ticket.nonce})).data.registered, true);
      assert.equal((await ext('/extension/result', {nonce:ticket.nonce,ok:true,url:'https://chatgpt.com/c/tool-continuations'})).status, 200);
    }
    workerWait = exchange({request_id:work.request.request_id, claim_token:work.request.claim_token, tool_calls:[toolCall(`next_${i}`)]});
    const completed = await caller;
    assert.equal(completed.status, 200);
    assert.equal(completed.data.metadata.worker_identity, identity);
    assert.equal(completed.data.choices[0].finish_reason, 'tool_calls');
    assert.equal(completed.data.choices[0].message.tool_calls[0].id, `next_${i}`);
    while (!f.app.gateway.workers.get(identity)?.polling) await new Promise(r => setTimeout(r, 1));
    await new Promise(r => setTimeout(r, 5));
    assert.equal(f.app.wakes.tickets.size, 1, 'warm tool continuations need no new wake');
    if (i < 7) caller = submit(i + 1);
  }
  assert.equal((await workerWait).data.result.structuredContent.state, 'idle');
});

test('HTTP Pi without session correlation fails explicitly instead of borrowing a shared worker',async t=>{
  const f=await fixture(t);
  const result=await f.call('/v1/chat/completions',{model:'chatgpt:sol',messages:[{role:'user',content:'hello'}]},{headers:{'User-Agent':'pi/0.test'}});
  assert.equal(result.status,400);assert.equal(result.data.error.code,'caller_session_required');assert.equal(f.app.gateway.jobs.size,0);
});

test('removing a scoped label retires workers and leaves a reloadable config',async t=>{
  const f=await fixture(t);await f.call('/workers/add',{label:'sol',row:'Latest',level:3});
  const scope='a'.repeat(22),identity=`sol~session-${scope}`;
  f.app.config.session_workers={[identity]:{label:'sol',scope,url:'https://chatgpt.com/c/scoped'}};
  f.app.gateway.workers.set(identity,{client:'connector',label:'sol',seen:Date.now(),polling:false,active:null});
  assert.equal((await f.call('/workers/remove',{label:'sol'})).status,200);
  assert.equal(f.app.gateway.workers.size,0);assert.deepEqual(f.app.config.session_workers,{});
  const {loadConfig}=await import('../src/config.ts');assert.doesNotThrow(()=>loadConfig(f.directory));
});

test('queued attachment bytes survive the wake budget wait and remain available on claim',async t=>{
  let now=Date.now();const f=await fixture(t,{now:()=>now,gateway:{timeoutMs:1000,pollMs:1}});
  await f.call('/workers/add',{label:'sol',row:'Latest',level:3});f.app.config.wake_daily_cap=0;
  const pending=f.app.gateway.submit({model:'chatgpt:sol',messages:[{role:'user',content:[{type:'file',file:{filename:'waiting.txt',file_data:Buffer.from('private queued bytes').toString('base64')}}]}]},'queued-file');
  const job=[...f.app.gateway.jobs.values()][0];const before=f.app.files.descriptors(job);
  now+=3*86400000;f.app.gateway.prune();f.app.files.prune();assert.deepEqual(f.app.files.descriptors(job),before);
  f.app.config.wake_daily_cap=48;const work=await f.app.gateway.exchange('connector',{worker_label:'sol'});assert.ok(work.state==='request');
  assert.equal(f.app.files.blocks(job).length,1);
  await f.app.gateway.exchange('connector',{worker_label:'sol',request_id:work.request!.request_id,claim_token:work.request!.claim_token,response:'received'});
  assert.equal((await pending).choices[0].message.content,'received');assert.equal(f.app.files.descriptors(job).length,0);
});

test('unrelated contact for the same label cannot confirm an extension wake without its nonce',async t=>{
  const f=await fixture(t,{gateway:{timeoutMs:5000,pollMs:1}});await f.call('/workers/add',{label:'sol',row:'Latest',level:3});
  f.app.wakes.enqueue('sol');const ticket=f.app.wakes.next().ticket!;f.app.wakes.claim(ticket.nonce);
  await f.app.gateway.exchange('connector',{worker_label:'sol'});
  assert.equal(f.app.wakes.check(ticket.nonce).registered,false);
  assert.throws(()=>f.app.wakes.result({nonce:ticket.nonce,ok:true,url:'https://chatgpt.com/c/unrelated'}));
  const polling=f.app.gateway.exchange('connector',{worker_label:'sol',wake_nonce:ticket.nonce});
  assert.equal(f.app.wakes.check(ticket.nonce).registered,true);
  await polling;
});

test('scoped composer wakes reject foreign and legacy exact fetches and require the exact wake authorization',async t=>{
  const f=await fixture(t,{config:{public_url:issuer,attachment_delivery:'composer'},gateway:{timeoutMs:5000,pollMs:1}}),tokens=await f.connect();
  await f.call('/workers/add',{label:'sol',row:'Latest',level:3});
  const pending=f.call('/v1/chat/completions',{model:'chatgpt:sol',messages:[{role:'user',content:[{type:'file',file:{filename:'private.txt',file_data:Buffer.from('session A attachment').toString('base64')}}]}]},{headers:{'x-session-affinity':'session-A'}});
  while(!f.app.gateway.jobs.size)await new Promise(r=>setTimeout(r,1));
  const ticket=f.app.wakes.next().ticket!;assert(ticket.label.includes('~session-'));f.app.wakes.claim(ticket.nonce);
  const fetchExact=(label:string,nonce?:string,conversation?:string)=>f.rpc(tokens.access_token,'tools/call',{name:'gateway_exchange',arguments:{worker_label:label,request_id:ticket.job_id,...(nonce?{wake_nonce:nonce}:{})},...(conversation?{_meta:{'openai/session':conversation}}:{})});
  const scopeB='b'.repeat(22);
  for(const [label,nonce,conversation] of [['sol',ticket.nonce,'legacy'],[`sol~session-${scopeB}`,ticket.nonce,'foreign'],[ticket.label,undefined,'own'],[ticket.label,ticket.nonce,undefined],[ticket.label,'n'.repeat(32),'own']] as const){
    const refused=await fetchExact(label,nonce,conversation);assert.equal(refused.data.result.isError,true);assert.equal([...f.app.gateway.jobs.values()][0].state,'queued');
  }
  const accepted=await fetchExact(ticket.label,ticket.nonce,'own');const work=accepted.data.result.structuredContent.request;assert.equal(work.request_id,ticket.job_id);
  assert.equal(f.app.wakes.check(ticket.nonce).registered,true);assert.equal(f.app.wakes.result({nonce:ticket.nonce,ok:true,url:'https://chatgpt.com/c/scoped-composer'}).ok,true);
  await f.rpc(tokens.access_token,'tools/call',{name:'gateway_exchange',arguments:{worker_label:ticket.label,wake_nonce:ticket.nonce,request_id:work.request_id,claim_token:work.claim_token,response:'A answer'},_meta:{'openai/session':'own'}});
  assert.equal((await pending).status,200);
  const disk=JSON.parse(await fs.readFile(f.directory+'/config.json','utf8'));assert.equal(Object.keys(disk.conversation_bindings).length,1);
});

test('MCP singleton omission completes a canonical round trip and exposes optional schema', {timeout:10000}, async t=>{
  const f=await fixture(t,{gateway:{timeoutMs:3000,pollMs:2000}}),tokens=await f.connect('singleton');
  const listed=await f.rpc(tokens.access_token,'tools/list');
  assert.equal(listed.data.result.tools[0].inputSchema.required?.includes('worker_label')??false,false);
  const empty=await f.rpc(tokens.access_token,'tools/call',{name:'gateway_exchange',arguments:{}});
  assert.equal(empty.data.result.isError,true);assert.match(empty.data.result.content[0].text,/exactly one effective worker identity/);
  await f.call('/workers/add',{label:'solo',row:'Latest',level:2});
  const poll=f.rpc(tokens.access_token,'tools/call',{name:'gateway_exchange',arguments:{maximum_wait_seconds:2}});
  while(!f.app.gateway.workers.get('solo')?.polling) await new Promise(r=>setTimeout(r,2));
  const pending=f.call('/v1/chat/completions',{model:'chatgpt:solo',messages:[{role:'user',content:'answer me'}]});
  const work=(await poll).data.result.structuredContent;assert.equal(work.worker_label,'solo');assert.equal(work.state,'request');
  const answer=f.rpc(tokens.access_token,'tools/call',{name:'gateway_exchange',arguments:{worker_label:work.worker_label,request_id:work.request.request_id,claim_token:work.request.claim_token,response:'answer',maximum_wait_seconds:1}});
  assert.equal((await pending).data.choices[0].message.content,'answer');assert.equal((await answer).data.result.structuredContent.worker_label,'solo');
  await f.call('/workers/add',{label:'another',row:'Latest',level:2});
  assert.equal((await f.rpc(tokens.access_token,'tools/call',{name:'gateway_exchange',arguments:{}})).data.result.isError,true);
});

test('MCP dedup canonicalizes omitted and explicit singleton labels before replacing a pending poll', {timeout:10000},async t=>{
  const f=await fixture(t,{gateway:{timeoutMs:3000,pollMs:2000}}),tokens=await f.connect('singleton_dedup');
  await f.call('/workers/add',{label:'solo',row:'Latest',level:0});
  const sameId=(args: any)=>f.call('/mcp',{jsonrpc:'2.0',id:'singleton-mixed',method:'tools/call',params:{name:'gateway_exchange',arguments:args}},{public:true,key:tokens.access_token,headers:{Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-06-18'}});
  const omitted=sameId({maximum_wait_seconds:2});
  while(!f.app.gateway.workers.get('solo')?.polling) await new Promise(r=>setTimeout(r,2));
  const explicit=await sameId({worker_label:'solo',request_id:'missing',claim_token:'missing',response:'unused',maximum_wait_seconds:1});
  assert.equal(explicit.data.result.structuredContent.state,'recovery');assert.equal(explicit.data.result.structuredContent.worker_label,'solo');
  const cancelled=await Promise.race([omitted,new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('canonical pending poll was not replaced')),750))]);
  assert.equal(cancelled.data.result.structuredContent.worker_label,'solo');
});

test('claimed singleton rejects guessed model labels and confirms only its authenticated nonce contact', {timeout:10000},async t=>{
  // Keep a real poll alive across both HTTP assertions; a 20ms poll raced
  // its own expiry under suite load and tested an unintended idle boundary.
  const f=await fixture(t,{gateway:{timeoutMs:3000,pollMs:1000}}),tokens=await f.connect('singleton_wake');
  await f.call('/workers/add',{label:'solo',row:'Latest',level:2});await f.call('/wake',{label:'solo'});
  const ext=(path: string,body?: any)=>f.call(path,body??{},{key:f.extensionSecret});
  const ticket=(await ext('/extension/next')).data.ticket;
  assert.equal(ticket.wake_text,undefined);await ext('/extension/claim',{nonce:ticket.nonce});
  const wrong=await f.rpc(tokens.access_token,'tools/call',{name:'gateway_exchange',arguments:{worker_label:'chatgpt',maximum_wait_seconds:1}});
  assert.equal(wrong.data.result.isError,true);assert.match(wrong.data.result.content[0].text,/Use worker_label "solo"/);assert.equal(f.app.gateway.workers.has('chatgpt'),false);
  assert.equal((await ext('/extension/result',{nonce:ticket.nonce,ok:true,url:'https://chatgpt.com/c/singleton-proof'})).status,409);
  const contact=f.rpc(tokens.access_token,'tools/call',{name:'gateway_exchange',arguments:{worker_label:'solo',wake_nonce:ticket.nonce,maximum_wait_seconds:1}});
  while(!f.app.gateway.workers.get('solo')?.polling) await new Promise(r=>setTimeout(r,1));
  assert.equal((await ext('/extension/check',{nonce:ticket.nonce})).data.registered,true);
  assert.equal((await ext('/extension/result',{nonce:ticket.nonce,ok:true,url:'https://chatgpt.com/c/singleton-proof'})).status,200);
  assert.equal((await contact).data.result.structuredContent.worker_label,'solo');
});

test('composer quota retry guards preserve the host and unrelated work',async t=>{
  const f=await fixture(t,{config:{public_url:issuer,attachment_delivery:'composer'}});
  await f.call('/workers/add',{label:'sol',row:'Latest',level:2});
  await f.call('/workers/add',{label:'other',row:'Latest',level:2});
  const held=f.app.gateway.submit({model:'chatgpt:sol',messages:[{role:'user',content:[{type:'file',file:{filename:'held.txt',file_data:Buffer.from('held input').toString('base64')}}]}]},'held-composer');held.catch(()=>{});
  const ticket=f.app.wakes.next().ticket!;assert.ok(ticket);f.app.wakes.claim(ticket.nonce);f.app.wakes.result({nonce:ticket.nonce,ok:false,error:'rate_limited'});
  await new Promise(resolve=>setTimeout(resolve,1100));
  assert.equal(f.app.gateway.closed,false);assert.equal([...f.app.gateway.jobs.values()][0].state,'queued');
  const other=f.app.gateway.submit({model:'chatgpt:other',messages:[{role:'user',content:'unrelated'}]},'other-job');
  const work=await f.app.gateway.exchange('connector',{worker_label:'other'});assert.ok(work.state==='request');
  await f.app.gateway.exchange('connector',{worker_label:'other',request_id:work.request.request_id,claim_token:work.request.claim_token,response:'available'});
  assert.equal((await other).choices[0].message.content,'available');
});

test('native ordinary extension sends a scoped wake label through all production endpoints', {timeout:10000}, async t => {
  const f=await fixture(t,{gateway:{pollMs:20,timeoutMs:5000}}), tokens=await f.connect('baseline_protocol');
  await f.call('/workers/add',{label:'sol',row:'Latest',level:2,wake_mode:'native'});
  const pending=f.call('/v1/chat/completions',{model:'chatgpt:sol',messages:[{role:'user',content:'protocol proof'}]},{headers:{'X-Crossfeed-Session':'caller-proof'}});
  while(f.app.gateway.jobs.size<1) await new Promise(r=>setTimeout(r,1));
  let sent=false, wireLabel='', wireNonce='', work:any, createdURL='';
  const paths:string[]=[], closed:number[]=[], groups:any[]=[];
  const rpc=(args:any,session='worker-proof')=>f.rpc(tokens.access_token,'tools/call',{name:'gateway_exchange',arguments:args,_meta:{'openai/session':session}});
  const browser:any={
    storage:{local:{get:async()=>({apiURL:f.app.apiUrl,key:f.extensionSecret,pairingVersion:1,pairing:{id:'p'.repeat(32),state:'approved',apiURL:f.app.apiUrl,checked_at:Date.now()}})}},
    windows:{create:async(opts:any)=>{
      assert.equal(opts.type,'normal');assert.equal(opts.state,'minimized');assert.equal(opts.focused,undefined);
      createdURL=opts.url;
      return {id:8,type:'normal',focused:false,tabs:[{id:7,windowId:8,active:true}]};
    }},
    tabs:{
      create:async()=>{assert.fail('native wake requires its own normal window');},
      group:async(opts:any)=>{groups.push({tabIds:opts.tabIds});return 9;},
      get:async()=>({id:7,windowId:8,status:'complete',url:sent?'https://chatgpt.com/c/protocol-proof':'https://chatgpt.com/'}),
      remove:async(id:number)=>{closed.push(id);}
    },
    tabGroups:{update:async(id:number,opts:any)=>{groups.push({id,...opts});}},
    debugger:{
      attach:async()=>{assert.fail('ordinary wake must not attach debugger');},
      detach:async()=>{assert.fail('ordinary wake must not detach debugger');},
      sendCommand:async()=>{assert.fail('ordinary wake must not dispatch CDP input');}
    },
    scripting:{executeScript:async(opts:any)=>{
      const ticket=opts.args[0];
      if(opts.func===prefillProbe){
        const command=new URL(createdURL).searchParams.get('q')!;
        const first=/First gateway_exchange: worker_label=("[^"]+") exactly as issued, wake_nonce=("[^"]+"), maximum_wait_seconds=20\./.exec(command)!;
        assert.ok(first);wireLabel=JSON.parse(first[1]);wireNonce=JSON.parse(first[2]);
        assert.equal(wireLabel,ticket.label);assert.equal(wireNonce,ticket.nonce);
        assert.match(wireLabel,/^wake-[A-Za-z0-9_-]{32}$/);assert.equal(wireLabel,`wake-${wireNonce}`);
        const expected=`@${ticket.connector} wake up. First gateway_exchange: worker_label=${JSON.stringify(ticket.label)} exactly as issued, wake_nonce=${JSON.stringify(ticket.nonce)}, maximum_wait_seconds=20. Then use the server-returned worker_label and repeat wake_nonce=${JSON.stringify(ticket.nonce)} on all subsequent gateway_exchange calls. Poll until state=released and continue=false; do not send a final chat reply between jobs. Return local caller tools as structured tool_calls through gateway_exchange; do not execute them natively.`;
        assert.equal(createdURL,'https://chatgpt.com/?q='+encodeURIComponent(expected));
        // The observed legacy/default idle response must not drain this scoped job or confirm its wake.
        const base=await rpc({worker_label:'sol',maximum_wait_seconds:1},'legacy-worker-proof');
        assert.equal(base.data.result.structuredContent.state,'idle');
        assert.equal([...f.app.gateway.jobs.values()][0].state,'queued');
        assert.equal(f.app.wakes.registered([...f.app.wakes.tickets.values()].find(w=>w.nonce===wireNonce)!),false);
        return [{documentId:'prefill-document',result:{ready:true,phase:2}}];
      }
      if(opts.func===prefillWake){
        assert.deepEqual(opts.target.documentIds,['prefill-document']);
        assert.equal(opts.args[3],2);
        sent=true;
        const result=await rpc({worker_label:wireLabel,wake_nonce:wireNonce,maximum_wait_seconds:20});
        assert.equal(result.data.result.isError,undefined);work=result.data.result.structuredContent;
        return [{documentId:'prefill-document',result:{sent:true,url:'https://chatgpt.com/'}}];
      }
      assert.equal(opts.func,pageWake);assert.equal(opts.args[1],'registration');
      return [{documentId:'registration-document',result:{url:'https://chatgpt.com/c/protocol-proof'}}];
    }}
  };
  const fetcher:any=async(url:string,init:any)=>{
    const path=new URL(url).pathname;paths.push(path);
    const result=await f.call(path,JSON.parse(init.body),{key:f.extensionSecret});
    if(path==='/extension/next')assert(validTicket(result.data.ticket));
    return {ok:result.status===200,text:async()=>JSON.stringify(result.data)};
  };
  await makePoller(browser,fetcher)();
  assert.match(wireLabel,/^wake-[A-Za-z0-9_-]{32}$/);
  assert.equal(work.state,'request');assert.equal(work.worker_label,wireLabel);
  assert.deepEqual(closed,[7]);
  assert.deepEqual(groups,[], 'a native wake window must not group its active tab');
  for(const path of ['/extension/next','/extension/claim','/extension/check','/extension/result'])assert(paths.includes(path),path);
  assert.equal(paths.includes('/extension/observe'),false);assert.equal(f.app.wakes.observation('sol'),null);
  assert.equal(f.app.wakes.status()[0].state,'confirmed');
  assert.equal((await rpc({worker_label:work.worker_label,wake_nonce:wireNonce},'foreign-worker')).data.result.isError,true);
  await rpc({worker_label:work.worker_label,wake_nonce:wireNonce,request_id:work.request.request_id,claim_token:work.request.claim_token,response:'READY',maximum_wait_seconds:1});
  assert.equal((await pending).data.choices[0].message.content,'READY');
  // MCP deliberately preserves the supplied alias, while direct exchange returns its canonical identity.
  assert.equal((await rpc({worker_label:work.worker_label,wake_nonce:wireNonce,maximum_wait_seconds:1})).data.result.structuredContent.worker_label,work.worker_label);
  // An explicit nonce mismatch is never normalized into authority, even with a valid alias.
  assert.equal((await rpc({worker_label:wireLabel,wake_nonce:'x'.repeat(32),maximum_wait_seconds:1})).data.result.isError,true);
  // Existing older-extension alias-only compatibility remains safe after ticket retention.
  f.app.wakes.tickets.clear();assert.equal((await rpc({worker_label:wireLabel,maximum_wait_seconds:1})).data.result.structuredContent.worker_label,wireLabel);
  f.app.wakes.enqueue('sol');const manual=f.app.wakes.next().ticket!;f.app.wakes.claim(manual.nonce);
  assert.equal((await rpc({worker_label:wireLabel,maximum_wait_seconds:1})).data.result.structuredContent.worker_label,wireLabel);
  assert.equal((await rpc({worker_label:'guessed-model',maximum_wait_seconds:1})).data.result.isError,true);
  f.app.gateway.pollMs=1000;
  const headers={Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-06-18'};
  const sameId=(session:string,args:any)=>f.call('/mcp',{jsonrpc:'2.0',id:'shared-id',method:'tools/call',params:{name:'gateway_exchange',arguments:args,_meta:{'openai/session':session}}},{public:true,key:tokens.access_token,headers});
  let settled=false;
  const polling=sameId('worker-proof',{worker_label:wireLabel,maximum_wait_seconds:2}).then(r=>{settled=true;return r;});
  const worker=[...f.app.gateway.workers.values()].find(w=>w.wake_nonce===wireLabel.slice(5))!;
  while(!worker.polling)await new Promise(r=>setTimeout(r,1));
  const foreign=await sameId('foreign-worker',{worker_label:wireLabel,request_id:'missing',claim_token:'missing',response:'foreign'});
  assert.equal(foreign.data.result.isError,true);assert.equal(settled,false);assert.equal(worker.polling,true);
  const cancel=(session?:string)=>f.call('/mcp',{jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:'shared-id',...(session?{_meta:{'openai/session':session}}:{})}},{public:true,key:tokens.access_token,headers});
  await cancel();await cancel('foreign-worker');assert.equal(settled,false);assert.equal(worker.polling,true);
  await cancel('worker-proof');await polling;assert.equal(settled,true);
  const ownPoll=sameId('worker-proof',{worker_label:wireLabel,maximum_wait_seconds:2});
  while(!worker.polling)await new Promise(r=>setTimeout(r,1));
  const completion=await sameId('worker-proof',{worker_label:wireLabel,request_id:'missing',claim_token:'missing',response:'own'});
  assert.equal(completion.data.result.structuredContent.state,'recovery');await ownPoll;

});


test('worker wake mode is explicit, retained and reported without mislabelling defaults', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/workers/add', {label: 'new-default', row: 'Latest', level: 3})).status, 200);
  assert.equal(f.app.config.labels['new-default'].wake_mode, 'native');
  f.app.wakes.enqueue('new-default');
  const fresh = f.app.wakes.next().ticket!;
  assert.equal(fresh.wake_mode, 'native');
  f.app.wakes.claim(fresh.nonce); f.app.wakes.result({nonce:fresh.nonce,ok:false});
  assert.equal((await f.call('/workers/add', {label: 'configured', row: 'Latest', level: 3, wake_mode: 'configured'})).status, 200);
  assert.equal((await f.call('/workers/add', {label: 'native', row: 'Latest', level: 2, wake_mode: 'native'})).status, 200);
  assert.equal((await f.call('/workers/add', {label: 'bad', row: 'Latest', level: 2, wake_mode: 'automatic'})).status, 400);
  const catalog = (await f.call('/v1/models')).data.data;
  assert.equal(catalog.find((w: any) => w.id === 'chatgpt:configured').wake_mode, 'configured');
  assert.equal(catalog.find((w: any) => w.id === 'chatgpt:native').wake_mode, 'native');
  assert.equal((await f.call('/workers/set', {label: 'native', replicas: 10})).status, 200);
  assert.equal(f.app.config.labels.native.wake_mode, 'native');
  assert.equal(f.app.config.labels.native.replicas, 10);
  f.app.wakes.enqueue('native');
  assert.equal(f.app.wakes.next().ticket!.wake_mode, 'native');
  assert.equal((await f.call('/workers/set', {label: 'native', wake_mode: 'configured'})).status, 409);
  assert.equal(f.app.config.labels.native.wake_mode, 'native');
  const saved = JSON.parse(await fs.readFile(f.directory + '/config.json', 'utf8'));
  assert.equal(saved.labels.native.wake_mode, 'native');
});

test('existing configured worker preserves its picker in tickets and catalog and can restore explicit configured mode',async t=>{
  const f=await fixture(t,{config:{public_url:issuer,labels:{legacy:{row:'Latest',level:2}},wake_state:{wakes:[],failed:{},cooldown_until:0,archives:[],worker_modes:{legacy:'configured'}}}});
  const catalog=(await f.call('/v1/models')).data.data;
  assert.equal(catalog.find((w:any)=>w.id==='chatgpt:legacy').wake_mode,'configured');
  assert.equal(f.app.config.labels.legacy.wake_mode,undefined);
  assert.equal(f.app.config.wake_state!.worker_modes!.legacy,'configured');
  assert.equal((await f.call('/workers/set',{label:'legacy',replicas:2})).status,200);
  assert.equal((await f.call('/workers/set',{label:'legacy',wake_mode:'configured'})).status,200);
  assert.equal((await f.call('/wake',{label:'legacy'})).status,202);
  const ext=(path:string,body?:any)=>f.call(path,body??{},{key:f.extensionSecret});
  const ticket=(await ext('/extension/next')).data.ticket;
  assert.equal(ticket.wake_mode,'configured');
  assert.equal((await ext('/extension/claim',{nonce:ticket.nonce})).status,200);
  assert.equal(f.app.config.wake_state!.worker_modes!.legacy,'configured');
  assert.equal(f.app.wakes.observation('legacy'),null);
});

test('worker CLI forwards the requested wake mode and rejects invalid modes before HTTP', async t => {
  const f = await fixture(t);
  await main(['worker', 'add', 'native', '--row', 'Latest', '--level', '2', '--wake-mode', 'native'], {CROSSFEED_API_KEY: f.apiKey, CROSSFEED_API_PORT: String(new URL(f.app.apiUrl).port)}, {fetch: f.fetcher, log: () => {}});
  assert.equal(f.app.config.labels.native.wake_mode, 'native');
  await assert.rejects(() => main(['worker', 'set', 'native', '--wake-mode', 'automatic'], {CROSSFEED_API_KEY: f.apiKey}, {fetch: async () => { assert.fail('invalid mode reached HTTP'); }, log: () => {}}), /Wake mode must be configured or native/);
});

test('changing wake mode cannot relabel an existing warm or saved conversation', async t => {
  const f = await fixture(t);
  await f.call('/workers/add', {label: 'native', row: 'Latest', level: 2, wake_mode: 'native'});
  await f.app.gateway.exchange('native-worker', {worker_label: 'native'});
  assert.equal(f.app.gateway.status().find(w => w.label === 'native')?.awake, true);
  assert.equal((await f.call('/workers/set', {label: 'native', wake_mode: 'configured'})).status, 409);
  assert.equal(f.app.config.labels.native.wake_mode, 'native');
  assert.equal((await f.call('/workers/set', {label: 'native', replicas: 2})).status, 200);
  assert.equal(f.app.gateway.status().find(w => w.label === 'native')?.awake, true);
  const cold = await fixture(t, {config: {public_url: issuer, labels: {
    saved: {row: 'Latest', level: 2, wake_mode: 'native', url: 'https://chatgpt.com/c/saved'},
    replica: {row: 'Latest', level: 2, wake_mode: 'native', replicas: 2, replica_urls: {'2': 'https://chatgpt.com/c/replica'}},
  }}});
  assert.equal(cold.app.gateway.workers.size, 0);
  for (const label of ['saved', 'replica']) {
    assert.equal((await cold.call('/workers/set', {label, wake_mode: 'configured'})).status, 409);
    assert.equal(cold.app.config.labels[label].wake_mode, 'native');
  }
  assert.equal((await cold.call('/workers/add', {label: 'saved', row: 'Latest', level: 2, wake_mode: 'configured'})).status, 409);
  for (const label of ['saved', 'replica']) {
    assert.equal((await cold.call('/workers/remove', {label})).status, 200);
    assert.equal((await cold.call('/workers/add', {label, row: 'Latest', level: 2, wake_mode: 'configured'})).status, 409);
    assert.equal((await cold.call('/workers/add', {label, row: 'Latest', level: 2, wake_mode: 'native'})).status, 200);
  }
  const uncertain = await fixture(t);
  await uncertain.call('/workers/add', {label: 'native', row: 'Latest', level: 2, wake_mode: 'native'});
  uncertain.app.wakes.enqueue('native');
  const attempted = uncertain.app.wakes.next().ticket!; uncertain.app.wakes.claim(attempted.nonce);
  uncertain.app.wakes.result({nonce: attempted.nonce, ok: false, error: 'browser_error', stage: 'send'});
  const restarted = await fixture(t, {config: structuredClone(uncertain.app.config)});
  assert.equal(restarted.app.gateway.workers.size, 0);
  assert.equal(restarted.app.config.labels.native.url, undefined);
  assert.equal((await restarted.call('/workers/set', {label: 'native', wake_mode: 'configured'})).status, 409);
  const cleared = structuredClone(uncertain.app.config);
  cleared.wake_state!.failed = {}; cleared.wake_state!.failed_attempts = {};
  const recovered = await fixture(t, {config: cleared});
  assert.equal((await recovered.call('/workers/set', {label: 'native', wake_mode: 'configured'})).status, 409);
  assert.equal((await recovered.call('/workers/add', {label: 'native', row: 'Latest', level: 2, wake_mode: 'native'})).status, 200);
  assert.equal(recovered.app.config.wake_state!.worker_modes!.native, 'native');
  assert.equal((await recovered.call('/workers/add', {label: 'native', row: 'Latest', level: 2, wake_mode:'configured'})).status, 409);
  assert.equal((await recovered.call('/workers/set', {label: 'native', wake_mode_locked: false})).status, 400);
  assert.equal((await recovered.call('/workers/remove', {label: 'native'})).status, 200);
  assert.equal((await recovered.call('/workers/add', {label: 'native', row: 'Latest', level: 2, wake_mode:'configured'})).status, 409);
  assert.equal((await recovered.call('/workers/add', {label: 'native', row: 'Latest', level: 2, wake_mode: 'native'})).status, 200);
  assert.equal(recovered.app.config.wake_state!.worker_modes!.native, 'native');
  await cold.call('/workers/add', {label: 'unused', row: 'Latest', level: 2});
  assert.equal((await cold.call('/workers/set', {label: 'unused', wake_mode: 'native'})).status, 200);
});

test('both local cancel routes enforce API authentication and exact body shapes', async t => {
  const f = await fixture(t), id = 'x'.repeat(32);
  for (const route of ['/jobs/cancel','/v1/jobs/cancel']) {
    for (const key of ['',f.extensionSecret,'wrong']) {
      const refused = await f.call(route,{id},{key}); assert.equal(refused.status,401); assert.equal(refused.data.error.code,'unauthorized');
    }
    for (const input of [null,[],{}, {id:1},{id:'short'},{id:'!'.repeat(32)},{id,extra:true},{id,idempotency_key:'key',session:'owner'},
      {idempotency_key:'key'},{session:'owner'},{idempotency_key:1,session:'owner'},{idempotency_key:'bad key',session:'owner'},
      {idempotency_key:'key',session:''},{idempotency_key:'key',session:' owner'},{idempotency_key:'key',session:'o\nn'},
      {idempotency_key:'key',session:'x'.repeat(257)},{idempotency_key:'key',session:1},{idempotency_key:'key',session:'owner',extra:true}]) {
      const refused = await f.call(route,input); assert.equal(refused.status,400); assert.equal(refused.data.error.code,'invalid_request');
    }
    const unknown = await f.call(route,{id}); assert.equal(unknown.status,404); assert.equal(unknown.data.error.code,'job_not_found');
    const remote = await f.call(route,{id},{public:true}); assert.equal(remote.status,404);
  }
});

test('HTTP cancellation by ID settles its caller and prevents any further automatic wake', async t => {
  const f = await fixture(t); await f.call('/workers/add',{label:'sol',row:'Latest',level:0});
  const pending = f.call('/v1/chat/completions',{model:'chatgpt:sol',messages:[{role:'user',content:'Private cancel request'}]}, {headers:{'Idempotency-Key':'http-cancel-id'}});
  while(!f.app.gateway.jobs.size)await new Promise(r=>setImmediate(r));
  const job = [...f.app.gateway.jobs.values()][0], ticket = [...f.app.wakes.tickets.values()][0];
  assert.equal(ticket.state,'queued'); assert.equal(f.app.wakes.waiting('sol','sol'),true);
  const cancelled = await f.call('/jobs/cancel',{id:job.id});
  assert.equal(cancelled.status,200); assert.deepEqual(cancelled.data,{id:job.id,label:'sol',state:'failed',error:'caller_cancelled',was:'queued'});
  assert(!JSON.stringify(cancelled.data).includes('Private cancel request')); assert(!JSON.stringify(cancelled.data).includes('http-cancel-id'));
  const original = await pending; assert.equal(original.status,499); assert.equal(original.data.error.code,'caller_cancelled');
  f.app.gateway.prune(); f.app.gateway.resume(); f.app.wakes.prune();
  assert.equal(f.app.wakes.waiting('sol','sol'),false); assert.equal(f.app.wakes.needed('sol','sol'),false);
  assert.equal(f.app.wakes.next().ticket,null); assert.equal(ticket.state,'cancelled'); assert.equal(f.app.wakes.tickets.size,1);
  const before = f.app.gateway.record(job);
  const finished = await f.call('/v1/jobs/cancel',{id:job.id}); assert.equal(finished.status,409); assert.equal(finished.data.error.code,'job_finished');
  assert.deepEqual(f.app.gateway.record(job),before);
});

test('HTTP key and session cancellation resolves the exact submit identity and replays its failure', async t => {
  const f = await fixture(t); await f.call('/workers/add',{label:'sol',row:'Latest',level:0});
  const input = {model:'chatgpt:sol',messages:[{role:'user',content:'Private scoped request'}]}, key = 'http-cancel-key', session = 'orchestrator:http-cancel-key';
  const headers = {'Idempotency-Key':key,'X-Crossfeed-Session':session};
  const pending = f.call('/v1/chat/completions',input,{headers});
  while(!f.app.gateway.jobs.size)await new Promise(r=>setImmediate(r));
  const job = [...f.app.gateway.jobs.values()][0];
  assert.equal(job.scope,job.caller);
  const foreign = await f.call('/v1/jobs/cancel',{idempotency_key:key,session:'orchestrator:other'});
  assert.equal(foreign.status,404); assert.equal(foreign.data.error.code,'job_not_found'); assert.equal(job.state,'queued');
  const cancelled = await f.call('/v1/jobs/cancel',{idempotency_key:key,session});
  assert.equal(cancelled.status,200); assert.deepEqual(cancelled.data,{id:job.id,label:'sol',state:'failed',error:'caller_cancelled',was:'queued'});
  assert(!JSON.stringify(cancelled.data).includes(key)); assert(!JSON.stringify(cancelled.data).includes('Private scoped request'));
  assert.equal((await pending).status,499);
  const retry = await f.call('/v1/chat/completions',input,{headers}); assert.equal(retry.status,499); assert.equal(retry.data.error.code,'caller_cancelled');
  assert.equal(f.app.gateway.jobs.size,1);
});

test('cancelled composer jobs release queued tickets, input files and confirmed archive holds', async t => {
  const f = await fixture(t,{config:{public_url:issuer,attachment_delivery:'composer',labels:{sol:{row:'Latest',level:0}}},gateway:{timeoutMs:3000,pollMs:1}});
  const input = {model:'chatgpt:sol',messages:[{role:'user',content:[{type:'file',file:{filename:'cancel.txt',file_data:Buffer.from('Private attachment').toString('base64')}}]}]};
  const queued = f.app.gateway.submit(input,'cancel-composer-queued'), job = [...f.app.gateway.jobs.values()][0];
  const ticket = [...f.app.wakes.tickets.values()][0]; assert.equal(f.app.files.descriptors(job).length,1);
  assert.equal((await f.call('/jobs/cancel',{id:job.id})).data.was,'queued');
  await assert.rejects(queued,(e:any)=>e.code==='caller_cancelled');
  assert.equal(f.app.wakes.jobFinished(job.id),true); assert.equal(f.app.files.descriptors(job).length,0);
  assert.equal(f.app.wakes.next().ticket,null); assert.equal(ticket.state,'cancelled');
  const claimed = f.app.gateway.submit(input,'cancel-composer-claimed'), active = [...f.app.gateway.jobs.values()].at(-1)!;
  const issued = f.app.wakes.next().ticket!; f.app.wakes.claim(issued.nonce);
  const work: any = await f.app.gateway.exchange('client',{worker_label:'sol',request_id:active.id});
  assert.equal(f.app.wakes.result({nonce:issued.nonce,ok:true,url:'https://chatgpt.com/c/cancel-composer'}).ok,true);
  assert.equal(f.app.wakes.archiveNext().archive,null);
  assert.equal((await f.call('/v1/jobs/cancel',{id:active.id})).data.was,'claimed');
  await assert.rejects(claimed,(e:any)=>e.code==='caller_cancelled');
  assert.equal(f.app.files.descriptors(active).length,0); assert.equal(f.app.gateway.workers.has(`\0composer:${active.id}`),false);
  assert.equal(f.app.wakes.archiveNext().archive!.url,'https://chatgpt.com/c/cancel-composer');
  const late: any = await f.app.gateway.exchange('client',{worker_label:'sol',request_id:active.id,claim_token:work.request.claim_token,response:'Too late'});
  assert.equal(late.state,'recovery'); assert.equal(late.code,'request_cancelled'); assert.equal(active.state,'failed');
});

test('CLI cancel posts the validated ID and prints only the control response', async t => {
  const f = await fixture(t); await f.call('/workers/add',{label:'sol',row:'Latest',level:0});
  const pending = f.app.gateway.submit({model:'chatgpt:sol',messages:[{role:'user',content:'CLI cancellation'}]},'cli-cancel');
  const job = [...f.app.gateway.jobs.values()][0]; let output = '';
  await main(['cancel',job.id,'--api-port',new URL(f.app.apiUrl).port],{CROSSFEED_API_KEY:f.apiKey},{fetch:f.fetcher,log:value=>{output=value;}});
  assert.deepEqual(JSON.parse(output),{id:job.id,label:'sol',state:'failed',error:'caller_cancelled',was:'queued'});
  assert(!output.includes(f.apiKey)); await assert.rejects(pending,(e:any)=>e.code==='caller_cancelled');
});

test('CLI cancellation validates arguments before fetch and accepts a hyphen-leading job ID', async () => {
  const env = {CROSSFEED_API_KEY:'x'.repeat(32)}, id = '-'.repeat(1)+'a'.repeat(31); let calls = 0, output = '';
  const io = {log:(value:string)=>{output=value;},fetch:async (url:string,init:RequestInit)=>{
    calls++; assert.equal(url,'http://127.0.0.1:5432/jobs/cancel'); assert.equal(init.method,'POST');
    assert.deepEqual(JSON.parse(init.body as string),{id});
    return {ok:true,status:200,json:async()=>({id,label:'sol',state:'failed',error:'caller_cancelled',was:'queued'})};
  }};
  for(const args of [['cancel'],['cancel','short'],['cancel','a'.repeat(31)],['cancel','a'.repeat(33)],['cancel','/'.repeat(32)],['cancel',id,'extra'],['cancel',id,'--row','Latest']]) {
    await assert.rejects(main(args,env,io)); assert.equal(calls,0);
  }
  await main(['cancel',id,'--api-port','5432'],env,io); assert.equal(calls,1); assert.equal(JSON.parse(output).id,id);
});
test('v2 native claim arms focus only after authenticated nonce claim; malformed versions cannot claim', async t => {
  let prepare = 0, closed = 0;
  const f = await fixture(t, {focusGuard: async () => {
    prepare++;
    return Object.freeze({close: async () => {closed++;}});
  }});
  await f.call('/workers/add', {label:'native',row:'Latest',level:2,wake_mode:'native'});
  await f.call('/wake', {label:'native'});
  const ext = (route: string, body: any = {}) => f.call(route, body, {key:f.extensionSecret});
  const ticket = (await ext('/extension/next')).data.ticket;
  assert.equal(prepare, 0);
  assert.equal((await f.call('/extension/claim', {nonce:ticket.nonce,focus_guard:true},
    {key:f.apiKey,headers:{Origin:'chrome-extension://'+'a'.repeat(32)}})).status, 401);
  assert.equal(prepare, 0);
  for (const value of [1, 5, '2', null, false, true, {}, []])
    assert.equal((await ext('/extension/claim',{nonce:ticket.nonce,focus_guard:true,focus_guard_version:value})).status,400);
  for (const bad of [{focus_guard_version:2}, {focus_guard:false,focus_guard_version:2},
    {focus_guard:true,focus_guard_version:2,unexpected:'value'}])
    assert.equal((await ext('/extension/claim',{nonce:ticket.nonce,...bad})).status,400);
  assert.equal(prepare, 0);
  const claimed = await ext('/extension/claim', {nonce:ticket.nonce,focus_guard:true,focus_guard_version:2});
  assert.equal(claimed.status, 200);
  assert.deepEqual(claimed.data, {ok:true,focus_guard:true});
  assert.equal(prepare, 1);
  assert.equal((await ext('/extension/claim',{nonce:ticket.nonce,focus_guard:true})).status,409);
  assert.equal(prepare,1);
  t.after(() => assert.equal(closed,1));
});
test('legacy extension gets fresh exact-title markers from the new server without changing wake authorization', async t => {
  let prepared = 0, closed = 0;
  const f = await fixture(t, {focusGuard: async () => {
    prepared++; return {close: async () => {closed++;}};
  }});
  await f.call('/workers/add',{label:'sol',row:'Latest',level:2});
  const markers: string[] = [];
  const bootstrap = await fs.readFile(new URL('../extension/wake-window.js', import.meta.url), 'utf8');
  for (let i = 0; i < 2; i++) {
    f.app.wakes.enqueue('sol');
    const ticket = (await f.call('/extension/next',{}, {key:f.extensionSecret})).data.ticket;
    assert.ok(ticket && ticket.type !== 'composer');
    const reply = await f.call('/extension/claim',{nonce:ticket.nonce,focus_guard:true},{key:f.extensionSecret});
    assert.equal(reply.status,200);
    assert.equal(reply.data.ok,true);
    const focus = reply.data.focus_guard;
    assert.equal(focus.status,'armed');
    assert.match(focus.marker,/^[a-f0-9]{32}$/);
    markers.push(focus.marker);
    // Exercise the already-loaded legacy exact-title bootstrap with the actual
    // server's unversioned wire reply, rather than assuming a Reload occurred.
    const page = {title:'Crossfeed Wake'};
    new Function('URL','location','document',bootstrap)(URL,
      {href:`chrome-extension://${'a'.repeat(32)}/wake-window.html?marker=${focus.marker}`},page);
    assert.equal(page.title,`Crossfeed Wake ${focus.marker}`);
    assert.equal((await f.call('/extension/claim',{nonce:ticket.nonce,focus_guard:true},{key:f.extensionSecret})).status,409);
    f.app.wakes.tickets.clear();
  }
  assert.notEqual(markers[0],markers[1]);
  assert.equal(prepared,2);
  t.after(() => assert.equal(closed,2));
});

test('composer ticket cannot arm a host focus guard even with a versioned request', async t => {
  let prepared = 0;
  const f = await fixture(t,{focusGuard:async()=>{prepared++;return {close:async()=>{}};}});
  await f.call('/workers/add',{label:'sol',row:'Latest',level:2});
  f.app.wakes.jobFinished = () => false;
  f.app.wakes.enqueueComposer({id:'owned_composer',label:'sol',
    attachments:[{id:'f'.repeat(32),name:'file.txt',mime:'text/plain',bytes:1,path:'/tmp/fake-file'}]});
  const ticket = (await f.call('/extension/next',{}, {key:f.extensionSecret})).data.ticket;
  assert.equal(ticket.type,'composer');
  assert.deepEqual((await f.call('/extension/claim',
    {nonce:ticket.nonce,focus_guard:true,focus_guard_version:2},{key:f.extensionSecret})).data,{ok:true});
  assert.equal(prepared,0);
});

test('claims without focus request never arm optional KWin guard', async t => {
  let prepare = 0;
  const f = await fixture(t, {focusGuard: async () => {prepare++; return undefined;}});
  await f.call('/workers/add',{label:'sol',row:'Latest',level:2});
  await f.call('/wake',{label:'sol'});
  const ext = (route: string, body: any = {}) => f.call(route,body,{key:f.extensionSecret});
  const ticket = (await ext('/extension/next')).data.ticket;
  assert.deepEqual((await ext('/extension/claim',{nonce:ticket.nonce})).data,{ok:true});
  assert.equal(prepare,0);
});
for (const behavior of ['unsupported','throws','malformed','throwing-getter','timeout']) {
  for (const version of ['legacy','v2'] as const) {
  test(`${version} optional KWin advisory ${behavior} does not deny an authenticated native wake`, {timeout:5000}, async t => {
    const f = await fixture(t, {focusGuard: async () => {
      if (behavior === 'throws') throw Error('optional helper failure');
      if (behavior === 'malformed') return {close:'not a function'} as any;
      if (behavior === 'throwing-getter') return Object.defineProperty({}, 'close', {
        get() {throw Error('malformed focus guard');},
      }) as any;
      if (behavior === 'timeout') return new Promise(() => {});
      return undefined;
    }});
    await f.call('/workers/add',{label:'native',row:'Latest',level:0,wake_mode:'native'});
    await f.call('/wake',{label:'native'});
    const ext = (route: string, body: any = {}) => f.call(route,body,{key:f.extensionSecret});
    const ticket = (await ext('/extension/next')).data.ticket;
    const claimed = await ext('/extension/claim',{nonce:ticket.nonce,focus_guard:true,
      ...(version === 'v2' ? {focus_guard_version:2} : {})});
    assert.equal(claimed.status,200);
    assert.deepEqual(claimed.data,{ok:true,focus_guard:version === 'v2' ? false : {status:'unsupported'}});
    assert.equal(f.app.wakes.tickets.get(ticket.nonce)?.state,'claimed');
  });
  }
}
test('revocation during asynchronous focus preparation remains an authorization failure', async t => {
  let enter!: () => void, finish!: (guard: any) => void, closed = 0;
  const entered = new Promise<void>(resolve => {enter=resolve;});
  const f = await fixture(t, {focusGuard: async () => {
    enter();
    return new Promise(resolve => {finish=resolve;});
  }});
  await f.call('/workers/add',{label:'native',row:'Latest',level:0,wake_mode:'native'});
  await f.call('/wake',{label:'native'});
  const ticket = (await f.call('/extension/next',{}, {key:f.extensionSecret})).data.ticket;
  const claim = f.call('/extension/claim',{nonce:ticket.nonce,focus_guard:true},{key:f.extensionSecret});
  await entered;
  const paired = f.app.pairing.list().approved[0];
  f.app.pairing.revoke(paired.id);
  finish({close: async () => {closed++;}});
  assert.equal((await claim).status,409);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed,1);
});
test('revoked claim does not await a stuck cosmetic guard close', {timeout:5000}, async t => {
  let enter!: () => void, finish!: (guard:any) => void, closed = 0;
  const entered = new Promise<void>(resolve => {enter=resolve;});
  const f = await fixture(t, {focusGuard: async () => {
    enter();
    return new Promise(resolve => {finish=resolve;});
  }});
  await f.call('/workers/add',{label:'native',row:'Latest',level:0,wake_mode:'native'});
  await f.call('/wake',{label:'native'});
  const ticket = (await f.call('/extension/next',{}, {key:f.extensionSecret})).data.ticket;
  const claim = f.call('/extension/claim',{nonce:ticket.nonce,focus_guard:true},{key:f.extensionSecret});
  await entered;
  f.app.pairing.revoke(f.app.pairing.list().approved[0].id);
  finish({close: () => {closed++; return new Promise<void>(() => {});}});
  const result = await Promise.race([claim, new Promise(resolve => setTimeout(() => resolve({status:0}), 400))]) as {status:number};
  assert.equal(result.status, 409, 'cleanup must not block revocation response');
  assert.equal(closed, 1);
});
test('late guard resolved after timeout is disposed without arming a stale claim', async t => {
  let finish!: (guard:any) => void, closed = 0;
  const f = await fixture(t, {focusGuard: async () =>
    new Promise(resolve => {finish=resolve;})});
  await f.call('/workers/add',{label:'native',row:'Latest',level:0,wake_mode:'native'});
  await f.call('/wake',{label:'native'});
  const ticket = (await f.call('/extension/next',{}, {key:f.extensionSecret})).data.ticket;
  const claim = await f.call('/extension/claim',{nonce:ticket.nonce,focus_guard:true,focus_guard_version:2},{key:f.extensionSecret});
  assert.deepEqual(claim.data,{ok:true,focus_guard:false});
  finish({close:async () => {closed++;}});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed,1);
});

test('v4 and legacy replies return exactly the ownership marker installed in the desktop guard', async t => {
  const markers:string[]=[];
  const f=await fixture(t,{focusGuard:async (_signal:AbortSignal,marker:string)=>{
    markers.push(marker);return {close:async()=>{}};
  }});
  await f.call('/workers/add',{label:'native',row:'Latest',level:0,wake_mode:'native'});
  for(const version of [4,undefined]) {
    f.app.wakes.enqueue('native');
    const ticket=(await f.call('/extension/next',{}, {key:f.extensionSecret})).data.ticket;
    const reply=await f.call('/extension/claim',{nonce:ticket.nonce,focus_guard:true,
      ...(version ? {focus_guard_version:version} : {})},{key:f.extensionSecret});
    assert.equal(reply.status,200);
    assert.deepEqual(reply.data.focus_guard,{status:'armed',marker:markers.at(-1)});
    assert.match(markers.at(-1)!,/^[a-f0-9]{32}$/);
    f.app.wakes.tickets.clear();
  }
  assert.notEqual(markers[0],markers[1]);
});

test('already-loaded v3 claim degrades advisory to direct prefill without arming a broken bootstrap',async t=>{
  let prepared=0;
  const f=await fixture(t,{focusGuard:async()=>{prepared++;return {close:async()=>{}};}});
  await f.call('/workers/add',{label:'legacy',row:'Latest',level:2});
  f.app.wakes.enqueue('legacy');
  const ticket=(await f.call('/extension/next',{}, {key:f.extensionSecret})).data.ticket;
  assert.equal(ticket.wake_mode,'native');
  const reply=await f.call('/extension/claim',{nonce:ticket.nonce,focus_guard:true,focus_guard_version:3},{key:f.extensionSecret});
  assert.equal(reply.status,200);
  assert.deepEqual(reply.data,{ok:true,focus_guard:{status:'unsupported'}});
  assert.equal(prepared,0);
  assert.equal(f.app.wakes.tickets.get(ticket.nonce)!.state,'claimed');
});

test('successful paired extension activity keeps cold scoped queues alive, with authenticated contact only', async t => {
  let clock = 10000;
  const f = await fixture(t, {now: () => clock, gateway: {timeoutMs:300, pollMs:20, extensionGraceMs:1000}});
  await f.call('/workers/add',{label:'sol',row:'Latest',level:0});
  const status = async () => (await f.call('/status')).data.extension_poll;
  assert.deepEqual(await status(), {last_seen_at:null, last_contact_at:null, recent:false, grace_ms:1000});
  const caller = 'client-pi-1';
  const pending = f.call('/v1/chat/completions', {model:'chatgpt:sol', messages:[{role:'user',content:'first turn'}]}, {headers:{'X-Crossfeed-Session':caller}});
  while (f.app.gateway.jobs.size !== 1) await new Promise(r=>setTimeout(r,1));
  clock += 900; f.app.gateway.prune();
  assert.equal(f.app.gateway.status().find((w:any)=>w.label==='sol')!.queued, 1, 'cold startup cannot immediately fail');
  assert.equal((await f.call('/extension/next')).status, 401, 'owner key cannot impersonate paired extension');
  assert.equal((await f.call('/extension/next', undefined, {key:f.extensionSecret, headers:{Origin:'chrome-extension://'+'b'.repeat(32)}})).status, 401);
  assert.equal((await status()).last_seen_at,null, 'unauthorized calls are not liveness evidence');
  const issued = await f.call('/extension/next', undefined, {key:f.extensionSecret});
  assert.equal(issued.status, 200);
  assert.ok(issued.data.ticket?.nonce);
  assert.deepEqual(await status(), {last_seen_at:clock, last_contact_at:clock, recent:true, grace_ms:1000});
  clock += 250;
  assert.equal((await f.call('/extension/claim', {nonce:issued.data.ticket.nonce}, {key:f.extensionSecret})).status,200);
  assert.equal((await status()).last_contact_at,clock,'a paired claim refreshes contact');
  assert.equal((await status()).last_seen_at,clock-250,'claims do not impersonate /next');
  clock += 250;
  assert.equal((await f.call('/extension/result', {nonce:issued.data.ticket.nonce,ok:false,error:'browser_error'}, {key:f.extensionSecret})).status,200);
  assert.equal((await status()).last_contact_at,clock,'a valid failure report is still browser activity');
  assert.equal((await f.call('/extension/next', {}, {key:f.extensionSecret})).status, 200, 'paired POST polling also counts after a failed ticket');
  clock += 900; f.app.gateway.prune();
  assert.equal(f.app.gateway.status().find((w:any)=>w.label==='sol')!.queued, 1, 'authenticated poll resets extension grace');
  clock += 101; f.app.gateway.prune();
  assert.equal(f.app.gateway.status().find((w:any)=>w.label==='sol')!.queued, 0);
  const result = await pending;
  assert.equal(result.status,503);
  assert.equal(result.data.error.code,'extension_unavailable');
  assert.equal((await status()).recent,false);
});

test('six concurrent scoped HTTP callers share one slow serialized wake past 90 seconds and fail after fixed expiry', async t => {
  let clock = 20000;
  const f = await fixture(t,{now:()=>clock,gateway:{timeoutMs:300,pollMs:20,extensionGraceMs:1000}});
  await f.call('/workers/add',{label:'sol',row:'Latest',level:0});
  const scopes = Array.from({length:6},(_,i)=>String(i).repeat(22));
  const pending = scopes.map(scope=>f.call('/v1/chat/completions',{model:'chatgpt:sol',messages:[{role:'user',content:'slow native wake'}]},{headers:{'X-Crossfeed-Session':scope}}));
  while (f.app.gateway.jobs.size !== 6) await new Promise(resolve=>setTimeout(resolve,1));
  const ext = (path:string, body?:any) => f.call(path,body,{key:f.extensionSecret});
  // Wake dispatch is globally serial: five scopes wait without a ticket while
  // one scope's real browser navigation runs for up to 240 seconds.
  const next=await ext('/extension/next');
  assert.equal(next.status,200);
  assert.ok(next.data.ticket?.nonce);
  const ticket=next.data.ticket;
  const issuedIdentity=f.app.wakes.tickets.get(ticket.nonce)!.label;
  assert.match(issuedIdentity,/~session-/,'the issued ticket belongs to a scoped identity');
  assert.equal((await ext('/extension/claim',{nonce:ticket.nonce})).status,200);
  assert.equal(f.app.config.wake_state!.wakes.length,1,'the global wake cap is preserved');
  clock += 91000; // Navigation is still ongoing after the ordinary 90-second grace.
  f.app.gateway.prune();
  assert.equal(f.app.gateway.status().find((w:any)=>w.label==='sol')!.queued,6,
    'one globally serialized real wake protects all six pending callers, not just its own scope');
  const checked = await ext('/extension/check',{nonce:ticket.nonce});
  assert.equal(checked.status,200,'the legitimate long-running wake can check in');
  assert.equal((await f.call('/status')).data.extension_poll.last_seen_at,20000,'a check is not a new /next poll');
  assert.equal((await f.call('/status')).data.extension_poll.last_contact_at,clock,'a valid check IS global browser liveness');
  const unrelatedScope='z'.repeat(22);
  const unrelated=f.call('/v1/chat/completions',{model:'chatgpt:sol',messages:[{role:'user',content:'no issued wake'}]},{headers:{'X-Crossfeed-Session':unrelatedScope}});
  while (Number(f.app.gateway.jobs.size) !== 7) await new Promise(resolve=>setTimeout(resolve,1));
  clock += 1001; f.app.gateway.prune();
  assert.equal(f.app.gateway.status().find((w:any)=>w.label==='sol')!.queued,7,
    'new sibling scopes also share browser availability but cannot claim the issued wake');
  clock = ticket.issued_at + 239000;
  assert.equal((await ext('/extension/check',{nonce:ticket.nonce})).status,200);
  f.app.gateway.prune();
  assert.equal(f.app.gateway.status().find((w:any)=>w.label==='sol')!.queued,7);
  clock = ticket.issued_at + 239999;
  assert.equal((await ext('/extension/check',{nonce:'z'.repeat(32)})).status,409);
  assert.equal((await f.call('/extension/check',{nonce:ticket.nonce})).status,401);
  assert.equal((await f.call('/extension/check',{nonce:ticket.nonce},{key:f.extensionSecret,headers:{Origin:'chrome-extension://'+'b'.repeat(32)}})).status,401);
  assert.equal((await f.call('/status')).data.extension_poll.last_contact_at,ticket.issued_at+239000,
    'invalid nonces and unpaired credentials/origins cannot refresh global contact');
  f.app.gateway.prune();
  assert.equal(f.app.gateway.status().find((w:any)=>w.label==='sol')!.queued,7);
  clock = ticket.issued_at + 240000;
  f.app.gateway.prune();
  assert.equal(f.app.gateway.status().find((w:any)=>w.label==='sol')!.queued,7,'fixed ticket expiry has one grace');
  clock += 1001; f.app.gateway.prune();
  const settled = await Promise.all([...pending,unrelated]);
  assert.ok(settled.every(r=>r.status===503 && r.data.error.code==='extension_unavailable'),
    'all affected cold scopes eventually fail once fixed expiry + grace and real contact expire');
  assert.equal(f.app.gateway.status().find((w:any)=>w.label==='sol')!.queued,0);
  assert.equal(f.app.gateway.capacity().claimed,0);
});

test('session release queues only the caller own chats and refuses while its job is active', async t => {
  const f = await fixture(t); await f.call('/workers/add',{label:'sol',row:'Latest',level:0});
  const session = 'orchestrator:release-key', headers = {'Idempotency-Key':'release-key','X-Crossfeed-Session':session};
  const pending = f.call('/v1/chat/completions',{model:'chatgpt:sol',messages:[{role:'user',content:'Scoped request'}]},{headers});
  while(!f.app.gateway.jobs.size)await new Promise(r=>setImmediate(r));
  const job = [...f.app.gateway.jobs.values()][0], scope = job.scope!, identity = `sol~session-${scope}`;
  f.app.config.session_workers = {[identity]:{label:'sol',scope,url:'https://chatgpt.com/c/mine'},
    [`sol~session-${'b'.repeat(22)}`]:{label:'sol',scope:'b'.repeat(22),url:'https://chatgpt.com/c/theirs'}};
  for (const bad of [{}, {session:1}, {session, extra:1}]) assert.equal((await f.call('/v1/sessions/release',bad)).status,400);
  const busy = await f.call('/v1/sessions/release',{session}); assert.equal(busy.status,409);
  assert.equal(Object.keys(f.app.config.session_workers).length,2);
  await f.call('/v1/jobs/cancel',{idempotency_key:'release-key',session}); assert.equal((await pending).status,499);
  const foreign = await f.call('/v1/sessions/release',{session:'orchestrator:someone-else'});
  assert.equal(foreign.status,200); assert.deepEqual(foreign.data,{released:0});
  const released = await f.call('/v1/sessions/release',{session});
  assert.equal(released.status,200); assert.deepEqual(released.data,{released:1,queued:1});
  assert.deepEqual(f.app.config.wake_state!.archives,['https://chatgpt.com/c/mine']);
  assert.deepEqual(Object.keys(f.app.config.session_workers),[`sol~session-${'b'.repeat(22)}`]);
});

test('disposal wiring: the service retires a finished wake chat on its own timer and deletes it through the archive lease', {timeout: 15000}, async t => {
  let clock = Date.now();
  const f = await fixture(t, {now: () => clock, config: {public_url: issuer, chat_disposal: 'delete'}, gateway: {timeoutMs: 3000, pollMs: 1500}});
  const tokens = await f.connect();
  await f.call('/workers/add', {label: 'sol', row: 'Latest', level: 3});
  const ext = (route: string, input: any = undefined) => f.call(route, input, {key: f.extensionSecret});
  const exchange = (extra: Record<string, any> = {}) => f.rpc(tokens.access_token, 'tools/call', {name: 'gateway_exchange', arguments: {worker_label: 'sol', maximum_wait_seconds: 1, ...extra}});
  // A manual test wake: no job, no caller session, nobody will ever call /v1/sessions/release.
  assert.equal((await f.call('/wake', {label: 'sol'})).status, 202);
  const ticket = (await ext('/extension/next')).data.ticket;
  assert.equal((await ext('/extension/chat', {nonce: ticket.nonce, url: 'https://chatgpt.com/c/early'})).status, 409, 'unclaimed wake may not record a chat');
  await ext('/extension/claim', {nonce: ticket.nonce});
  assert.equal((await f.call('/extension/chat', {nonce: ticket.nonce, url: 'https://chatgpt.com/c/manual-test'})).status, 401, 'the owner key is not the extension');
  assert.equal((await ext('/extension/chat', {nonce: ticket.nonce, url: 'https://chatgpt.com/c/manual-test'})).status, 200);
  assert.deepEqual(f.app.config.wake_state!.started_chats, ['https://chatgpt.com/c/manual-test']);
  const polling = exchange({wake_nonce: ticket.nonce});
  while (!f.app.gateway.workers.get('sol')?.polling) await new Promise(r => setTimeout(r, 2));
  assert.equal((await ext('/extension/result', {nonce: ticket.nonce, ok: true, url: 'https://chatgpt.com/c/manual-test'})).status, 200);
  await polling;
  assert.equal(f.app.config.labels.sol.url, 'https://chatgpt.com/c/manual-test');
  assert.equal((await ext('/extension/archive/next')).data.archive, null, 'a working chat is not disposed');
  // Still in contact two minutes later: the worker is alive, leave it.
  clock += 130000; await exchange({wake_nonce: ticket.nonce});
  f.app.wakes.reconcile(true);
  assert.equal(f.app.config.labels.sol.url, 'https://chatgpt.com/c/manual-test');
  // It goes quiet. No call from anyone: the service's own timer disposes of it.
  clock += 60000;
  const until = Date.now() + 5000;
  while (f.app.config.labels.sol.url && Date.now() < until) await new Promise(r => setTimeout(r, 50));
  assert.equal(f.app.config.labels.sol.url, undefined);
  const lease = (await ext('/extension/archive/next')).data.archive;
  assert.deepEqual({url: lease.url, remove: lease.remove}, {url: 'https://chatgpt.com/c/manual-test', remove: true});
  const status = (await f.call('/status')).data.chat_disposal;
  assert.deepEqual({mode: status.mode, queued: status.queued, tracked: status.tracked}, {mode: 'delete', queued: 1, tracked: 1});
  assert.equal((await ext('/extension/archive/result', {nonce: lease.nonce, ok: true})).status, 200);
  const disk = JSON.parse(await fs.readFile(f.directory + '/config.json', 'utf8'));
  assert.equal(disk.labels.sol.url, undefined); assert.deepEqual(disk.wake_state.archives, []); assert.deepEqual(disk.wake_state.started_chats, []);
});

test('sweep routes: only the paired extension may ask, and the reply never includes chats a ticket or label holds', async t => {
  const f = await fixture(t, {config: {public_url: issuer, chat_disposal: 'delete', labels: {sol: {row: 'Latest', level: 3, url: 'https://chatgpt.com/c/mine'}}}});
  const old = Date.now() - 7_200_000;
  const body = {candidates: [{id: 'mine', created_at: old}, {id: 'stray', created_at: old}, {id: 'fresh', created_at: Date.now()}]};
  assert.equal((await f.call('/extension/sweep', body)).status, 401);
  const reply = await f.call('/extension/sweep', body, {key: f.extensionSecret});
  assert.equal(reply.status, 200); assert.deepEqual(reply.data.dispose, ['stray']);
  assert.equal((await f.call('/extension/sweep', {candidates: [{id: 'x/../y', created_at: old}]}, {key: f.extensionSecret})).status, 400);
  assert.equal((await f.call('/extension/sweep/done', {deleted: ['stray']}, {key: f.extensionSecret})).status, 200);
  assert.equal((await f.call('/status')).data.chat_disposal.last_sweep.deleted, 1);
});

test('authenticated extension next with ticket null cannot indefinitely preserve a cold scoped caller', async t => {
  let clock=10000;
  const f=await fixture(t,{now:()=>clock,config:{public_url:issuer,wake_hourly_cap:0},
    gateway:{timeoutMs:300,pollMs:20,startupMs:3000,extensionGraceMs:1000}});
  assert.equal((await f.call('/workers/add',{label:'sol',row:'Latest',level:0})).status,200);
  const scope='h'.repeat(22);
  const pending=f.call('/v1/chat/completions',{model:'chatgpt:sol',messages:[{role:'user',content:'blocked cold start'}]},
    {headers:{'X-Crossfeed-Session':scope}});
  while (f.app.gateway.jobs.size!==1) await new Promise(resolve=>setTimeout(resolve,1));
  for(const tick of [10000,11000,12999]) {
    clock=tick;
    const heartbeat=await f.call('/extension/next',{}, {key:f.extensionSecret});
    assert.equal(heartbeat.status,200);
    assert.equal(heartbeat.data.ticket,null,'a paused wake must not issue a ticket');
    f.app.gateway.prune();
    assert.equal(f.app.gateway.capacity().claimed,0);
    const startup=(await f.call('/status')).data.startup;
    assert.equal(startup.cold_scoped_queued,1);
    assert.equal(startup.budget_ms,3000);
    assert.equal(startup.scoped_queued,1);
    assert.equal(startup.blocker,'wake_paused');
  }
  clock=13000;
  const heartbeat=await f.call('/extension/next',{}, {key:f.extensionSecret});
  assert.equal(heartbeat.status,200);
  assert.equal(heartbeat.data.ticket,null);
  f.app.gateway.prune();
  const outcome=await pending;
  assert.equal(outcome.status,503);
  assert.equal(outcome.data.error.code,'wake_stalled');
  assert.equal((await f.call('/status')).data.startup.cold_scoped_queued,0);
  assert.equal(f.app.gateway.capacity().claimed,0);
});

test('startup status priority reports capacity, caps, cooldown, archive and stale contact without scoped IDs',async t=>{
  let clock=10000;
  const f=await fixture(t,{now:()=>clock,config:{public_url:issuer,wake_hourly_cap:0,max_claimed_jobs:1},
    gateway:{timeoutMs:300,pollMs:20,startupMs:20000,extensionGraceMs:1000}});
  assert.equal((await f.call('/workers/add',{label:'sol',row:'Latest',level:0})).status,200);
  const g=f.app.gateway;
  const occupier=g.submit({model:'chatgpt:sol',messages:[{role:'user',content:'occupy'}]});
  const claim=await g.exchange('connector',{worker_label:'sol',maximum_wait_seconds:1},undefined,'occupier-chat');
  assert.equal(claim.state,'request');
  if(claim.state!=='request') throw new Error('No capacity claim');
  const caller='j'.repeat(22);
  const pending=f.call('/v1/chat/completions',{model:'chatgpt:sol',messages:[{role:'user',content:'scope diagnostic'}]},
    {headers:{'X-Crossfeed-Session':caller}});
  while(g.jobs.size!==2) await new Promise(resolve=>setTimeout(resolve,1));
  const status=async()=> (await f.call('/status')).data;
  const blocker=async()=> (await status()).startup.blocker;
  assert.equal(await blocker(),'capacity_full');
  await g.exchange('connector',{worker_label:'sol',request_id:claim.request.request_id,
    claim_token:claim.request.claim_token,response:'done',maximum_wait_seconds:1},AbortSignal.abort(),'occupier-chat');
  await occupier;
  assert.equal(await blocker(),'wake_paused');
  f.app.config.wake_hourly_cap=1;
  f.app.config.wake_state!.wakes=[clock];
  assert.equal(await blocker(),'wake_budget');
  f.app.config.wake_state!.wakes=[];
  f.app.config.quota_pause_until=clock+10000;
  assert.equal(await blocker(),'quota_cooldown');
  f.app.config.quota_pause_until=0;
  f.app.config.wake_state!.archives=Array(256).fill('https://chatgpt.com/c/stored');
  assert.equal(await blocker(),'archive_full');
  f.app.config.wake_state!.archives=[];
  assert.equal(await blocker(),'no_extension_contact');
  assert.equal((await status()).extension_poll.recent,false);
  const heartbeat=await f.call('/extension/next',{}, {key:f.extensionSecret});
  assert.equal(heartbeat.status,200);
  const recent=await status();
  assert.equal(recent.extension_poll.recent,true);
  assert.ok(['wake_budget','serialized_wake','awaiting_worker'].includes(recent.startup.blocker),
    'the contact is recent, but a wake issued on a one-attempt hourly cap can already consume that cap');
  assert.equal(recent.startup.scoped_queued,1);
  assert.equal(recent.startup.cold_scoped_queued,1);
  assert.equal(recent.startup.budget_ms,20000);
  assert.doesNotMatch(JSON.stringify(recent.startup),new RegExp(caller));
  clock+=1001;
  assert.equal((await status()).extension_poll.recent,false);
  assert.equal(await blocker(),'wake_budget','a cap blocker takes precedence even when contact is stale');
  f.app.config.wake_state!.wakes=[];
  assert.equal(await blocker(),'no_extension_contact','stale authenticated contact must not count as recent');
  g.close();
  assert.equal((await pending).status,503);
});

test('focus status is API-authenticated, bounded, sanitized and only counts requested focus', async t => {
  let scenario = 'prepared';
  const observedMarkers: string[] = [];
  const privateValue = 'DO_NOT_EMIT_PRIVATE_FOCUS_VALUE';
  const f = await fixture(t, {
    now: () => 123456,
    focusGuard: async (_signal: AbortSignal, marker: string, report?: (reason: string) => void) => {
      observedMarkers.push(marker);
      if (scenario === 'prepared') {report?.('prepared'); return {close:async () => {}};}
      if (scenario === 'unsupported_bus' || scenario === 'unsupported_desktop') {
        report?.(scenario); return undefined;
      }
      if (scenario === 'invalid') {report?.(privateValue); return undefined;}
      if (scenario === 'throws') throw Error(privateValue);
      return undefined;
    },
  });
  const status = async () => (await f.call('/status')).data.focus_guard;
  const empty = {unsupported_desktop:0, unsupported_bus:0, timeout:0, prepare_failed:0, prepared:0, cancelled:0};
  assert.deepEqual(await status(), {attempts:0, counts:empty, last:null});
  assert.equal((await f.call('/status',undefined,{key:f.extensionSecret})).status,401);
  assert.equal((await f.call('/v1/gateway/status',undefined,{key:'wrong'})).status,401);
  assert.equal((await f.call('/status',undefined,{public:true})).status,404);
  await f.call('/workers/add',{label:'sol',row:'Latest',level:2});
  f.app.wakes.enqueue('sol');
  const idleTicket = (await f.call('/extension/next',{}, {key:f.extensionSecret})).data.ticket;
  assert.equal((await f.call('/extension/claim',{nonce:idleTicket.nonce},{key:f.extensionSecret})).status,200);
  assert.deepEqual(await status(), {attempts:0, counts:empty, last:null});
  f.app.wakes.tickets.clear();

  for (const step of ['prepared','unsupported_bus','unsupported_desktop','throws','invalid','undefined']) {
    scenario = step;
    f.app.wakes.enqueue('sol');
    const ticket = (await f.call('/extension/next', {}, {key:f.extensionSecret})).data.ticket;
    assert(ticket);
    const claimed = await f.call('/extension/claim',
      {nonce:ticket.nonce,focus_guard:true,focus_guard_version:2},{key:f.extensionSecret});
    assert.equal(claimed.status,200);
    assert.deepEqual(claimed.data,{ok:true,focus_guard:step==='prepared'});
    f.app.wakes.tickets.clear();
  }
  assert.equal(observedMarkers.length,6);
  assert(observedMarkers.every(value => /^[a-f0-9]{32}$/.test(value)));
  assert.equal(new Set(observedMarkers).size,6);
  const focus = await status();
  assert.deepEqual(focus,{attempts:6,counts:{
    unsupported_desktop:1,unsupported_bus:1,timeout:0,prepare_failed:3,prepared:1,cancelled:0,
  },last:{reason:'prepare_failed',at_ms:123456}});
  assert.deepEqual((await f.call('/v1/gateway/status')).data.focus_guard,focus);
  assert(!JSON.stringify(focus).includes(privateValue));
  assert(!JSON.stringify(focus).includes(f.extensionSecret));
  assert(!JSON.stringify(focus).includes(f.apiKey));
});

test('stuck cosmetic focus is counted as timeout while a claimed ordinary wake survives', {timeout:5000}, async t => {
  const f = await fixture(t, {focusGuard:async () => new Promise(() => {})});
  await f.call('/workers/add',{label:'native',row:'Latest',level:0,wake_mode:'native'});
  f.app.wakes.enqueue('native');
  const ticket = (await f.call('/extension/next',{}, {key:f.extensionSecret})).data.ticket;
  const claimed = await f.call('/extension/claim',
    {nonce:ticket.nonce,focus_guard:true,focus_guard_version:2},{key:f.extensionSecret});
  assert.deepEqual(claimed.data,{ok:true,focus_guard:false});
  assert.equal(f.app.wakes.tickets.get(ticket.nonce)?.state,'claimed');
  const focus=(await f.call('/status')).data.focus_guard;
  assert.deepEqual(focus.counts,{unsupported_desktop:0,unsupported_bus:0,timeout:1,prepare_failed:0,prepared:0,cancelled:0});
  assert.equal(focus.attempts,1);
  assert.equal(focus.last.reason,'timeout');
  assert.equal(typeof focus.last.at_ms,'number');
});
