import { tempPrefix } from './temp.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { bearer, body, chatUrl, equal, hash, label, lease, line, nonce, privateDirectory, publicOrigin, readPrivate, shortTitle, text, writePrivate } from '../src/security.ts';

const fault = (status: number) => (error: any) => error.status === status;
function fixture(t: import('node:test').TestContext) {
  const root = fs.mkdtempSync(tempPrefix('crossfeed-security-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const incoming = (chunks: any, headers: Record<string, any> = {}) => Object.assign(Readable.from(chunks.map((value: any) => Buffer.isBuffer(value) ? value : Buffer.from(value))), { headers: { 'content-type': 'application/json', ...headers } }) as unknown as IncomingMessage;

test('a stale lock is never deleted or replaced automatically', t => {
  const directory = fixture(t);
  const original = { pid: 999999999, owner: nonce() };
  writePrivate(directory, 'server.lock', original);
  assert.throws(() => lease(directory), e => e.status === 409 && e.code === 'already_running');
  assert.deepEqual(readPrivate(directory, 'server.lock'), original);
});

test('releasing a lease never deletes a replacement belonging to a different owner', t => {
  const directory = fixture(t);
  const release = lease(directory);
  const replacement = { pid: process.pid, owner: nonce() };
  writePrivate(directory, 'server.lock', replacement);
  release();
  assert.deepEqual(readPrivate(directory, 'server.lock'), replacement);
});

test('nonces are random URL-safe values and equality accepts only matching strings', () => {
  const values = new Set(Array.from({ length: 64 }, nonce));
  assert.equal(values.size, 64);
  for (const value of values) assert.match(value, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(hash('input').length, 43);
  assert.equal(equal('same', 'same'), true);
  for (const [a, b] of [['same', 'different'], ['a', 'aa'], [undefined, undefined], [null, ''], [42, 42]]) assert.equal(equal(a, b), false);
});

test('text and line limits count bytes and reject invisible control characters', () => {
  assert.equal(text('', 'optional', 4, true), '');
  assert.equal(text('éé', 'bounded', 4), 'éé');
  assert.throws(() => text('ééé', 'bounded', 4), fault(400));
  for (const value of ['', null, 3, {}, 'x'.repeat(129)]) assert.throws(() => label(value), fault(400));
  for (const value of [' leading', 'trailing ', 'new\nline', 'tab\there', 'hidden\u200btext', 'null\0byte']) assert.throws(() => line(value, 'line'), fault(400));
  assert.equal(label('worker-alpha'), 'worker-alpha');
});

test('job titles normalize controls and whitespace, then cap the display label', () => {
  assert.equal(shortTitle('  review\n\t· Task Manager\u202e  '), 'review · Task Manager');
  assert.equal(shortTitle('x'.repeat(100)), 'x'.repeat(80));
  assert.equal(shortTitle(' \u0000\u202e '), undefined);
  assert.equal(shortTitle(undefined), undefined);
  assert.throws(() => shortTitle(42), fault(400));
  assert.throws(() => shortTitle('x'.repeat(4097)), fault(400));
});

test('public origins and saved chats reject credentials, query, fragments and wrong hosts', () => {
  assert.equal(publicOrigin('https://crossfeed.example/'), 'https://crossfeed.example');
  for (const value of ['http://crossfeed.example', 'https://user:pass@crossfeed.example', 'https://crossfeed.example/path', 'https://crossfeed.example/?x=1', 'https://crossfeed.example/#x', 'not-a-url']) assert.throws(() => publicOrigin(value), fault(400));
  assert.equal(chatUrl('https://chatgpt.com/c/chat-123'), 'https://chatgpt.com/c/chat-123');
  for (const value of ['http://chatgpt.com/c/abc', 'https://chatgpt.com.evil.test/c/abc', 'https://user:pass@chatgpt.com/c/abc', 'https://chatgpt.com/c/abc?x=1', 'https://chatgpt.com/c/abc#x', 'https://chatgpt.com/c/abc/extra', 'https://chatgpt.com/', 'https://chatgpt.com/c/']) assert.throws(() => chatUrl(value), fault(400));
});

test('private state creates 0700 directories and 0600 files and survives replacement', t => {
  const root = fixture(t); const directory = path.join(root, 'state');
  const fallback = { empty: true };
  assert.strictEqual(readPrivate(directory, 'state.json', fallback), fallback);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  writePrivate(directory, 'state.json', { value: 'first' });
  assert.equal(fs.statSync(path.join(directory, 'state.json')).mode & 0o777, 0o600);
  assert.deepEqual(readPrivate(directory, 'state.json', fallback), { value: 'first' });
  writePrivate(directory, 'state.json', { value: 'second' });
  assert.deepEqual(readPrivate(directory, 'state.json', fallback), { value: 'second' });
  assert.deepEqual(fs.readdirSync(directory), ['state.json']);
});

test('state directories with group/world permissions are rejected without repair', t => {
  const root = fixture(t); const directory = path.join(root, 'public');
  fs.mkdirSync(directory, { mode: 0o700 }); fs.chmodSync(directory, 0o755);
  assert.throws(() => privateDirectory(directory), fault(500));
  assert.throws(() => readPrivate(directory, 'state.json', {}), fault(500));
  assert.throws(() => writePrivate(directory, 'state.json', {}), fault(500));
  assert.equal(fs.statSync(directory).mode & 0o777, 0o755);
  assert.equal(fs.existsSync(path.join(directory, 'state.json')), false);
});

test('unsafe existing state files cannot be silently overwritten', t => {
  const directory = fixture(t); const filename = path.join(directory, 'state.json');
  fs.writeFileSync(filename, '{"original":true}', { mode: 0o600 }); fs.chmodSync(filename, 0o644);
  assert.throws(() => writePrivate(directory, 'state.json', { changed: true }), fault(500));
  assert.equal(fs.readFileSync(filename, 'utf8'), '{"original":true}');
  fs.mkdirSync(path.join(directory, 'folder'), { mode: 0o700 });
  assert.throws(() => writePrivate(directory, 'folder', {}), fault(500));
  assert.equal(fs.statSync(path.join(directory, 'folder')).isDirectory(), true);
});

test('state reads reject public files, non-files, oversized files and malformed JSON', t => {
  const directory = fixture(t); const filename = path.join(directory, 'state.json');
  fs.writeFileSync(filename, '{}', { mode: 0o600 }); fs.chmodSync(filename, 0o644);
  assert.throws(() => readPrivate(directory, 'state.json', {}), fault(500));
  fs.chmodSync(filename, 0o600); fs.truncateSync(filename, 2 * 1024 * 1024 + 1);
  assert.throws(() => readPrivate(directory, 'state.json', {}), fault(500));
  fs.writeFileSync(filename, '{broken');
  assert.throws(() => readPrivate(directory, 'state.json', {}), SyntaxError);
  fs.mkdirSync(path.join(directory, 'folder'), { mode: 0o700 });
  assert.throws(() => readPrivate(directory, 'folder', {}), fault(500));
});

test('symlink state directories fail closed for reads and writes', t => {
  const root = fixture(t); const real = path.join(root, 'real'); const link = path.join(root, 'link');
  fs.mkdirSync(real, { mode: 0o700 }); fs.symlinkSync(real, link);
  assert.throws(() => readPrivate(link, 'state.json', {}));
  assert.throws(() => writePrivate(link, 'state.json', { changed: true }));
  assert.deepEqual(fs.readdirSync(real), []);
});

test('symlink state files fail closed and their targets remain untouched', t => {
  const root = fixture(t); const directory = path.join(root, 'state');
  fs.mkdirSync(directory, { mode: 0o700 });
  const target = path.join(root, 'original.json'); const link = path.join(directory, 'state.json');
  fs.writeFileSync(target, '{"original":true}', { mode: 0o600 }); fs.symlinkSync(target, link);
  assert.throws(() => readPrivate(directory, 'state.json', {}));
  assert.throws(() => writePrivate(directory, 'state.json', { changed: true }));
  assert.equal(fs.readFileSync(target, 'utf8'), '{"original":true}');
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
});

test('JSON bodies require objects, correct content type and unencoded bounded data', async () => {
  assert.deepEqual(await body(incoming(['{"message":', '"ok"}'])), { message: 'ok' });
  const atLimit = JSON.stringify({ x: 'x'.repeat(1024 * 1024 - 8) });
  assert.equal(Buffer.byteLength(atLimit), 1024 * 1024);
  assert.equal(((await body(incoming([atLimit]))) as {x:string}).x.length, 1024 * 1024 - 8);
  for (const raw of ['[]', 'null', '"string"', '{invalid', '']) await assert.rejects(body(incoming([raw])), fault(400));
  await assert.rejects(body(incoming(['{}'], { 'content-type': 'text/plain' })), fault(415));
  await assert.rejects(body(incoming(['{}'], { 'content-encoding': 'gzip' })), fault(415));
  await assert.rejects(body(incoming([Buffer.alloc(1024 * 1024), Buffer.from('x')])), fault(413));
});

test('OAuth form bodies reject duplicate fields and bearer parsing is strict', async () => {
  const headers = { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' };
  assert.deepEqual(await body(incoming(['grant_type=authorization_code&code=a%2Bb'], headers), true), { grant_type: 'authorization_code', code: 'a+b' });
  await assert.rejects(body(incoming(['code=one&code=two'], headers), true), fault(400));
  assert.equal(bearer({ headers: { authorization: 'Bearer abc_def-123' } }), 'abc_def-123');
  for (const authorization of ['bearer abc', 'Bearer', 'Bearer a b', 'Bearer abc\n', 'Basic abc']) assert.equal(bearer({ headers: { authorization } }), undefined);
  assert.equal(bearer({ headers: {} }), undefined);
});

test('worker configuration validates row and numeric level, keeping old URLs only for archive', async t => {
  const {loadConfig} = await import('../src/config.ts');
  const directory = fixture(t);
  const labels = {sol: {row: 'Latest', level: 4, url: 'https://chatgpt.com/c/old'}};
  writePrivate(directory, 'config.json', {labels});
  assert.deepEqual(loadConfig(directory).labels, labels);
  for (const saved of [{row: '', level: 4}, {row: 'Latest', level: '3'}, {row: 'Latest', level: 5}, {row: 'Latest', level: 0, mode: 'Work'}, {url: 'https://chatgpt.com/c/old', level: 'Standard', mode: 'Chat'}]) {
    writePrivate(directory, 'config.json', {labels: {sol: saved}}); assert.throws(() => loadConfig(directory));
  }
});

test('configuration rejects invalid deadlines, volume state and retained-chat archive targets', async t => {
  const {loadConfig} = await import('../src/config.ts'); const directory = fixture(t);
  const state = {wakes: [], failed: {}, cooldown_until: 0, archives: []};
  for (const update of [{wake_hourly_cap: -1}, {wake_hourly_cap: 1.5}, {wake_hourly_cap: 1001}, {job_deadline_ms: 0}, {job_deadline_ms: 86400001}, {wake_daily_cap: -1}, {wake_daily_cap: 1.5}, {wake_state: {...state, wakes: ['invalid']}}, {wake_state: {...state, archives: ['https://evil.example/c/x']}}, {labels: {sol: {row: 'Latest', level: 0, url: 'https://chatgpt.com/c/current'}}, wake_state: {...state, archives: ['https://chatgpt.com/c/current']}}]) {
    writePrivate(directory, 'config.json', update); assert.throws(() => loadConfig(directory));
  }
});

test('worker lease defaults to the job deadline while explicit saved leases and overrides survive', async t => {
  const {loadConfig} = await import('../src/config.ts'); const directory = fixture(t);
  assert.equal(loadConfig(directory).worker_lease_ms, 1800000);
  assert.equal(loadConfig(directory, {job_deadline_ms: 2400000}).worker_lease_ms, 2400000);
  writePrivate(directory, 'config.json', {worker_lease_ms: 600000});
  assert.equal(loadConfig(directory).worker_lease_ms, 600000);
  assert.equal(loadConfig(directory, {worker_lease_ms: 1800000}).worker_lease_ms, 1800000);
});
