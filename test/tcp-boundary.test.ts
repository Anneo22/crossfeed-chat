import { tempPrefix } from './temp.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
type ClaimedExchange = Extract<Awaited<ReturnType<import('../src/gateway.ts').Gateway['exchange']>>, {request: unknown}>;
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createApp } from '../src/server.ts';
import { nonce } from '../src/security.ts';
const tcp = process.env.CROSSFEED_TEST_TCP === '1';
async function fixture(t: import('node:test').TestContext, extra: Record<string, any> = {}) {
  const directory = fs.mkdtempSync(tempPrefix('crossfeed-tcp-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const apiKey = nonce() + nonce();
  const app = await createApp({directory, apiKey, apiPort: 0, mcpPort: 0, config: {public_url: 'https://test.example', labels: {sol: {row: 'Latest', level: 0}}}, gateway: {wake() {}, timeoutMs: 2000}, ...extra});
  t.after(() => app.close()); return {app, apiKey, directory};
}
test('TCP abrupt disconnect cancels unkeyed jobs and retains keyed work for replay', {skip: !tcp}, async t => {
  const f = await fixture(t); f.app.gateway.wake = () => {};
  for (const key of [undefined, 'retained']) {
    const req = http.request(f.app.apiUrl + '/v1/chat/completions', {method: 'POST', headers: {Authorization: 'Bearer ' + f.apiKey, 'Content-Type': 'application/json', ...(key ? {'Idempotency-Key': key} : {})}});
    req.on('error', () => {}); req.end(JSON.stringify({model: 'chatgpt:sol', messages: [{role: 'user', content: 'test'}]}));
    while (![...f.app.gateway.jobs.values()].some(j => !j.finished)) await new Promise(r => setTimeout(r, 1));
    const job = [...f.app.gateway.jobs.values()].find(j => !j.finished); req.destroy();
    await new Promise(r => setTimeout(r, 25));
    if (key) {
      assert.equal(job!.finished, undefined);
      const replay = f.app.gateway.submit(job!.request, key); assert.equal(replay, job!.promise);
      const work = await f.app.gateway.exchange('client', {worker_label: 'sol'}); assert.ok(work.state === 'request');
      await f.app.gateway.exchange('client', {worker_label: 'sol', request_id: work.request.request_id, claim_token: work.request.claim_token, response: 'answer'}, AbortSignal.abort());
      assert.equal((await replay).choices[0].message.content, 'answer');
    } else { await assert.rejects(job!.promise, e => e.code === 'caller_cancelled'); }
  }
});
test('TCP second-listener bind failure closes the first listener and releases state ownership', {skip: !tcp}, async t => {
  const blocker = http.createServer(); blocker.listen(0, '127.0.0.1'); await once(blocker, 'listening');
  t.after(() => new Promise(resolve => blocker.close(resolve)));
  const directory = fs.mkdtempSync(tempPrefix('crossfeed-bind-')); t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const servers: any[] = [];
  await assert.rejects(createApp({directory, apiKey: nonce() + nonce(), apiPort: 0, mcpPort: blocker.address().port, config: {public_url: 'https://test.example'}, serverFactory: (options: any, handler: any) => { const server = http.createServer(options, handler); servers.push(server); return server; }}), e => e.code === 'EADDRINUSE');
  assert.equal(fs.existsSync(directory + '/server.lock'), false); assert(servers.every(s => !s.listening));
});
test('TCP header and body deadlines close slow requests using the production server limits', {skip: !tcp}, async t => {
  const f = await fixture(t, {serverFactory: (options: any, handler: any) => {
    assert.equal(options.headersTimeout, 10000); assert.equal(options.requestTimeout, 30000);
    return http.createServer({...options, headersTimeout: 100, requestTimeout: 200, connectionsCheckingInterval: 20}, handler);
  }});
  for (const body of [false, true]) {
    const socket = net.connect(Number(new URL(f.app.apiUrl).port), '127.0.0.1'); await once(socket, 'connect');
    let response = ''; socket.on('data', (chunk: any) => { response += chunk; });
    socket.write(body ? `POST /wake HTTP/1.1\r\nHost: ${new URL(f.app.apiUrl).host}\r\nAuthorization: Bearer ${f.apiKey}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{` : 'POST /wake HTTP/1.1\r\n');
    const timeout = setTimeout(() => socket.destroy(Error('timeout did not close request')), 2000);
    try { await once(socket, 'close'); } finally { clearTimeout(timeout); }
    assert.match(response, /408 Request Timeout/);
  }
});
test('CLI serve exits on SIGINT and SIGTERM and releases its state lock and listeners', {skip: !tcp}, async t => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const reserve = http.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
    const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
    const directory = fs.mkdtempSync(tempPrefix('crossfeed-cli-')); t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
    const child = spawn(process.execPath, ['src/cli.ts', 'serve', '--public-url', 'https://test.example', '--api-port', String(port), '--mcp-port', '0', '--state-dir', directory], {env: {...process.env, CROSSFEED_API_KEY: nonce() + nonce()}});
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let output = ''; child.stdout.on('data', (chunk: any) => { output += chunk; });
    const deadline = Date.now() + 5000;
    while (!output.includes('Local API:') && Date.now() < deadline && child.exitCode === null) await new Promise(r => setTimeout(r, 5));
    assert.match(output, /Local API:/); const exit = once(child, 'exit'); child.kill(signal);
    assert.equal((await exit)[0], 0); assert.equal(fs.existsSync(directory + '/server.lock'), false);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/status`));
  }
});
