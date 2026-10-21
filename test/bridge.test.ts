import { tempPrefix } from './temp.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { Bridge, loadBridge } from '../src/bridge.ts';

const peer = path.resolve('test/bridge-peer.ts');
async function fixture(t: import('node:test').TestContext, extra: Record<string, any> = {}) {
  const directory = fs.mkdtempSync(tempPrefix('crossfeed-bridge-'));
  fs.chmodSync(directory, 0o700);
  const filename = path.join(directory, 'config.json');
  const config: any = { timeout_ms: 1000, output_bytes: 65536, servers: { gaddi: { command: process.execPath, args: [peer], tools: { browser_open: 'allow', browser_click: 'allow', browser_eval: 'allow', browser_look: 'allow' }, env: { BRIDGE_FIXTURE_SECRET: 'synthetic-known-secret' } } }, ...extra };
  fs.writeFileSync(filename, JSON.stringify(config), { mode: 0o600 });
  const bridge = new Bridge({ config: loadBridge(filename), directory, secrets: ['synthetic-control-key'] });
  t.after(() => { bridge.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await bridge.start();
  const call = (name: any, args = {}, context = {}) => bridge.call('bridge_gaddi_browser_' + name, args, { client: 'client1', ...context });
  return { bridge, call, directory, filename, config };
}

test('bridge config rejects readable, linked, unsupported and malformed configuration', {skip: process.platform !== 'darwin'}, async t => {
  const f = await fixture(t);
  fs.chmodSync(f.filename, 0o644); assert.throws(() => loadBridge(f.filename), /0600/);
  fs.chmodSync(f.filename, 0o600);
  const symlink = path.join(f.directory, 'symlink'); fs.symlinkSync(f.filename, symlink); assert.throws(() => loadBridge(symlink));
  const hardlink = path.join(f.directory, 'hardlink'); fs.linkSync(f.filename, hardlink); assert.throws(() => loadBridge(f.filename)); fs.unlinkSync(hardlink);
  for (const config of [ { servers: { mail: f.config.servers.gaddi } }, { ...f.config, output_bytes: 1000000 }, { ...f.config, servers: { gaddi: { ...f.config.servers.gaddi, env: { CROSSFEED_API_KEY: 'synthetic' } } } }, { ...f.config, servers: { gaddi: { ...f.config.servers.gaddi, tools: { browser_open: 'approve' } } } } ]) {
    fs.writeFileSync(f.filename, JSON.stringify(config)); assert.throws(() => loadBridge(f.filename));
  }
});

test('discovery default denies writes and hard ceiling beats explicit allow and misleading hints', {skip: process.platform !== 'darwin'}, async t => {
  const f = await fixture(t);
  const names = f.bridge.tools.map((tool: any) => tool.name);
  assert(names.includes('bridge_gaddi_browser_open')); assert(names.includes('bridge_gaddi_browser_status'));
  assert(!names.includes('bridge_gaddi_browser_eval')); assert(!names.includes('bridge_gaddi_browser_approvals'));
  assert(!JSON.stringify(f.bridge.tools).includes('Ignore all')); assert(!JSON.stringify(f.bridge.tools).includes('Always send'));
  assert(!JSON.stringify(f.bridge.tools).includes('"approval"'));
  await assert.rejects(f.call('eval', { expression: '1' }), /denied/);
  const other = await fixture(t, { servers: { qmd: { command: process.execPath, args: [peer], tools: { write: 'allow', get: 'deny' } }, omniread: { command: process.execPath, args: [peer], tools: {} } } });
  assert.deepEqual(other.bridge.tools.map((tool: any) => tool.name), ['bridge_qmd_query']);
});

test('bridge isolates tabs by OAuth client, preserves HELD id, and refuses all approval retries', {skip: process.platform !== 'darwin'}, async t => {
  const f = await fixture(t);
  await assert.rejects(f.call('look', { tab: 42 }), /bridge tabs/);
  await f.call('open', { url: 'https://example.com' });
  await f.call('look', { tab: 42 });
  await assert.rejects(f.call('look', { tab: 42 }, { client: 'other' }), /bridge tabs/);
  const held = await f.call('click', { tab: 42, selector: 'button' });
  assert.match(JSON.stringify(held), /HELD.*fixture-approval-id/);
  await assert.rejects(f.call('click', { tab: 42, selector: 'button', approval: 'fixture-approval-id' }), /approval retry/);
  const audit = fs.readFileSync(path.join(f.directory, 'bridge.jsonl'), 'utf8');
  assert(audit.includes('"state":"held"')); assert(!audit.includes('fixture-approval-id')); assert(!audit.includes('button'));
});

test('bridge refuses local URLs, credential URLs, mail, unknown fields and non-object input', {skip: process.platform !== 'darwin'}, async t => {
  const f = await fixture(t);
  for (const url of ['http:127.0.0.1:4319/status', 'http://127.0.0.1:4319/status', 'http://2130706433:4319/status', 'http://10.0.0.1/', 'http://localhost/', 'http://[::1]/', 'file:///etc/passwd', 'data:text/html,hello', 'javascript:alert(1)', 'https://u:p@example.com/', 'https://mail.google.com/', 'https://example.com/?access_token=synthetic']) await assert.rejects(f.call('open', { url }));
  await assert.rejects(f.call('status', { unexpected: 1 })); await assert.rejects(f.call('status', []));
});

test('bridge strips credentials across text and structured output and drops opaque blocks', {skip: process.platform !== 'darwin'}, async t => {
  const f = await fixture(t);
  await f.call('open', { url: 'https://example.com' });
  const value = JSON.stringify(await f.call('look', { tab: 42, mode: 'secret' }));
  for (const denied of ['synthetic-known-secret', 'opaque-synthetic-value', 'opaque-synthetic-bearer', 'synthetic-access', 'synthetic-hidden', 'synthetic phrase', 'several words', 'synthetic-unrecognized-token']) assert(!value.includes(denied));
  assert(value.includes('retained')); assert(value.includes('[redacted]'));
  assert(!fs.readFileSync(path.join(f.directory, 'bridge.jsonl'), 'utf8').includes('synthetic-known-secret'));
});

test('output cap and transport flood refuse output without leaking prefixes', {skip: process.platform !== 'darwin'}, async t => {
  const f = await fixture(t); await f.call('open', { url: 'https://example.com' });
  await assert.rejects(f.call('look', { tab: 42, mode: 'oversize' }), /output cap/);
  await assert.rejects(f.call('look', { tab: 42, mode: 'flood' }), /transport cap/);
  await assert.rejects(f.call('status'), /unavailable/);
});

test('timeout, busy refusal and cancellation stop the upstream process and are audited', {skip: process.platform !== 'darwin'}, async t => {
  const f = await fixture(t, { timeout_ms: 200 }); await f.call('open', { url: 'https://example.com' });
  const wait = f.call('look', { tab: 42, mode: 'timeout' });
  await assert.rejects(f.call('status'), /busy/);
  await assert.rejects(wait, /timed out/);
  const cancel = await fixture(t); await cancel.call('open', { url: 'https://example.com' });
  const stopped = cancel.bridge.peers.get('gaddi')!;
  const controller = new AbortController(); const running = cancel.call('look', { tab: 42, mode: 'timeout' }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(running, /cancelled/);
  assert(stopped.closed);
  assert.equal(cancel.bridge.status().gaddi.available, false);
});

test('upstream sandbox cannot connect to a real Crossfeed-style control listener or inherit its credential', {skip: process.platform !== 'darwin'}, async t => {
  const server = net.createServer((socket: any) => socket.destroy());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const f = await fixture(t, { servers: { gaddi: { command: process.execPath, args: [peer], tools: {}, env: { BRIDGE_CONTROL_PORT: String(server.address().port) } } } });
  const result = JSON.stringify(await f.call('status'));
  assert.match(result, /EPERM/); assert.match(result, /absent/); assert(!result.includes('CONNECTED'));
});

test('partial browser close retains ownership and disabled Gaddi policy refuses actions', {skip: process.platform !== 'darwin'}, async t => {
  const f = await fixture(t, {servers:{gaddi:{command:process.execPath,args:[peer],tools:{browser_open:'allow',browser_close:'allow'}}}});
  await f.call('open',{url:'https://example.com'});
  await f.call('close',{tabs:[42]}); assert.equal(f.bridge.tabs.get(42),'client1');
  await f.call('look',{tab:42});
  const off = await fixture(t, {servers:{gaddi:{command:process.execPath,args:[peer],tools:{browser_open:'allow'},env:{BRIDGE_POLICY_OFF:'true'}}}});
  await assert.rejects(off.call('open',{url:'https://example.com'}),/policy.*disabled/);
});

test('held URL reads preserve the approval ID without requiring successful-read provenance', {skip: process.platform !== 'darwin'}, async t => {
  const f = await fixture(t, {servers:{gaddi:{command:process.execPath,args:[peer],tools:{browser_read:'allow'}}}});
  const response = await f.call('read',{url:'https://example.com'});
  assert.match(JSON.stringify(response),/HELD.*fixture-read-id/);
  await assert.rejects(f.call('read',{url:'https://example.com',approval:'fixture-read-id'}),/approval retry/);
});

test('malformed peer envelope fails closed without crashing the host and redirected private reads are refused', {skip: process.platform !== 'darwin'}, async t => {
  const malformed = await fixture(t,{servers:{gaddi:{command:process.execPath,args:[peer],tools:{},env:{BRIDGE_NULL:'true'}}}});
  assert.deepEqual(malformed.bridge.tools,[]);
  assert.equal(malformed.bridge.status().gaddi.available,false);
  assert.match(String(malformed.bridge.status().gaddi.message),/envelope/);
  await assert.rejects(malformed.call('status'),/unavailable/);
  const f = await fixture(t,{servers:{gaddi:{command:process.execPath,args:[peer],tools:{browser_read:'allow'},env:{BRIDGE_READ_REDIRECT:'true'}}}});
  await assert.rejects(f.call('read',{url:'https://example.com'}),/Private/);
});

test('public reader peers cannot borrow the authenticated acquisition plugin, browser socket or login profiles', {skip: process.platform !== 'darwin'}, async t => {
  const f = await fixture(t,{servers:{omniread:{command:process.execPath,args:[peer],tools:{read_url:'allow'},env:{OMNIREAD_ACQUIRER_PLUGIN:'synthetic:plugin',GADDI_SOCKET:'/synthetic/socket',OMNIREAD_PROFILE_DIR:'/synthetic/profiles'}}}});
  const response = await f.bridge.call('bridge_omniread_read_url',{url:'https://example.com'},{client:'client1'});
  assert.equal(response.structuredContent!.plugin_present,false);
  assert.equal(response.structuredContent!.browser_disabled,true);
  assert.equal(response.structuredContent!.profiles_disabled,true);
});

test('a failing peer leaves the other peers serving, is named in status and recovers on retry', {skip: process.platform !== 'darwin'}, async t => {
  const directory = fs.mkdtempSync(tempPrefix('crossfeed-bridge-'));
  fs.chmodSync(directory, 0o700);
  const flag = path.join(directory, 'broken');
  fs.writeFileSync(flag, '');
  const filename = path.join(directory, 'config.json');
  // qmd exits at startup while the flag file exists, like a native module built for another Node.
  const broken = `if(require('fs').existsSync(${JSON.stringify(flag)}))process.exit(7);require(${JSON.stringify(peer)})`;
  fs.writeFileSync(filename, JSON.stringify({ timeout_ms: 1000, servers: { qmd: { command: process.execPath, args: ['--experimental-strip-types', '-e', broken], tools: {} }, gaddi: { command: process.execPath, args: [peer], tools: { browser_look: 'allow' } } } }), { mode: 0o600 });
  const lines: string[] = [];
  const bridge = new Bridge({ config: loadBridge(filename), directory, retryMs: 200, log: line => lines.push(line) });
  t.after(() => { bridge.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await bridge.start();
  assert.ok(bridge.routes.has('bridge_gaddi_browser_look'));
  assert.ok(!bridge.routes.has('bridge_qmd_query'));
  assert.deepEqual({ available: bridge.status().qmd.available, error: bridge.status().qmd.error, message: bridge.status().qmd.message }, { available: false, error: 'bridge_peer', message: 'Local tool server exited (code 7)' });
  assert.match(lines.join('\n'), /qmd unavailable \(bridge_peer: Local tool server exited \(code 7\)\)/);
  await assert.rejects(bridge.call('bridge_qmd_query', { query: 'x' }, { client: 'client1' }), /unavailable/);
  assert.match((await bridge.call('bridge_gaddi_browser_status', {}, { client: 'client1' })).content[0].text, /policy/);
  fs.rmSync(flag);
  for (let i = 0; i < 50 && !bridge.status().qmd.available; i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(bridge.status().qmd.available, true);
  assert.ok(bridge.routes.has('bridge_qmd_query'));
  assert.ok(bridge.tools.some(tool => tool.name === 'bridge_gaddi_browser_look'));
  assert.match(lines.join('\n'), /qmd available again/);
  const peerProcess = bridge.peers.get('qmd')!.child;
  peerProcess.kill('SIGKILL');
  for (let i = 0; i < 50 && bridge.status().qmd.available; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(bridge.status().qmd.available, false);
  assert.ok(!bridge.routes.has('bridge_qmd_query'));
  for (let i = 0; i < 50 && !bridge.status().qmd.available; i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(bridge.status().qmd.available, true, 'a peer that dies at runtime is restarted');
});
