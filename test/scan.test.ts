import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tempPrefix } from './temp.ts';
import { Files } from '../src/files.ts';
import { Gateway } from '../src/gateway.ts';
import { exposure } from '../src/scan.ts';
type ClaimedExchange = Extract<Awaited<ReturnType<Gateway['exchange']>>, {request: unknown}>;

// 6 Nov 2026, chatgpt:media-unattended: asked for a beaver illustration, the worker returned
// "a_clean_interface_like_screenshot_or_mockup_of_api.png", a drawing of its own gateway_exchange
// calls with the wake nonce in clear. These fixtures stand in for it with fake tokens.
const gatewayUI = fs.readFileSync(new URL('./fixtures/gateway-ui.png', import.meta.url));
const clean = fs.readFileSync(new URL('./fixtures/clean-ink.png', import.meta.url));
const nonce = 'NONCEaaaaBBBBccccDDDDeeeeFFFF0001';

function setup(t: import('node:test').TestContext, data: Buffer, options: Record<string, any> = {}) {
  const directory = fs.mkdtempSync(tempPrefix('crossfeed-scan-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const files = new Files(directory, {download: async () => ({status: 200, data}), ...options});
  const g = new Gateway({prefix: 'chatgpt', labels: {media: {row: 'GPT-6', level: 1}}}, {files, pollMs: 2, timeoutMs: 120000});
  t.after(() => g.close());
  return {directory, files, g};
}
async function returnFile(g: Gateway, name = 'image.png', wake_nonce?: string) {
  await g.exchange('client', {worker_label: 'media', ...(wake_nonce ? {wake_nonce} : {})});
  const pending = g.submit({model: 'chatgpt:media', messages: [{role: 'user', content: 'Draw five beavers.'}]}, 'image-' + name);
  const work = (await g.exchange('client', {worker_label: 'media', ...(wake_nonce ? {wake_nonce} : {})}) as ClaimedExchange).request;
  const answer = (file: string) => g.exchange('client', {worker_label: 'media', request_id: work.request_id, claim_token: work.claim_token, response: 'Here is the image.', files: [{download_url: 'https://example.com/signed', file_id: 'file-1', file_name: file}]});
  return {pending, work, answer};
}

test('OCR text of a gateway_exchange capture is recognized despite recognition noise', () => {
  // Lines Vision read from the 6 Nov image (token replaced).
  const noisy = 'gateway_excnange\nworker label": \'media-unattended"\nwake_nonce™: "<R>"\nẠạmaximum_wait seconds: 20';
  assert.equal(exposure(noisy, [], true), 'gateway_protocol');
  assert.equal(exposure('gotcnay exchange', [], true), null);
  assert.equal(exposure(`token ${nonce.slice(0, 10)} ${nonce.slice(10)}`, [nonce], true), 'live_token');
  assert.equal(exposure('Five beaver clerks at five small desks, joined by red strings', [nonce], true), null);
  assert.equal(exposure(`binary ${nonce} tail`, [nonce], false), 'live_token');
  assert.equal(exposure('"worker_label": "media"', [], false), 'gateway_protocol');
});

test('a returned image showing the gateway protocol never reaches the caller (macOS Vision)', {skip: process.platform !== 'darwin', timeout: 240000}, async t => {
  const f = setup(t, gatewayUI);
  // The first Vision run on a host loads its model, which can take tens of seconds under load.
  await f.files.scan.warm();
  const {pending, answer} = await returnFile(f.g);
  await assert.rejects(answer('a_clean_interface_like_screenshot_or_mockup_of_api.png'), (e: any) => {
    assert.equal(e.code, 'unsafe_file', e.message); assert.equal(e.status, 422); assert.match(e.message, /never draw, capture or quote/); return true;
  });
  assert.equal(f.files.rows.filter(r => r.kind === 'output').length, 0);
  assert.deepEqual(fs.readdirSync(f.directory + '/files'), []);
  // The claim stays open, so the worker can return the image it was asked for.
  f.files.download = async () => ({status: 200, data: clean});
  await answer('beavers.png');
  const result = await pending;
  assert.equal(result.files!.length, 1);
  assert.deepEqual(f.files.output(result.files![0].id).data, clean);
});

test('a returned image showing a live wake nonce or claim token is refused', async t => {
  let text = '';
  const f = setup(t, clean, {readImageText: async () => text});
  const {pending, work, answer} = await returnFile(f.g, 'token.png', nonce);
  for (const shown of [nonce, work.claim_token]) {
    text = `A picture with ${shown} written on it`;
    await assert.rejects(answer('token.png'), (e: any) => e.code === 'unsafe_file');
  }
  assert.equal(f.files.rows.length, 0);
  text = 'five beavers';
  await answer('beavers.png');
  assert.equal((await pending).files!.length, 1);
});

test('a returned image that cannot be checked is discarded, not returned', async t => {
  const f = setup(t, clean, {readImageText: async () => { throw Error('Vision unavailable'); }});
  const {answer} = await returnFile(f.g, 'unchecked.png');
  await assert.rejects(answer('unchecked.png'), (e: any) => e.status === 503 && e.code === 'file_unverified');
  assert.equal(f.files.rows.length, 0);
});

test('a returned text file quoting gateway arguments is refused', async t => {
  const f = setup(t, Buffer.from('{"worker_label":"media","wake_nonce":"x"}'));
  const {answer} = await returnFile(f.g, 'notes.json');
  await assert.rejects(answer('notes.json'), (e: any) => e.code === 'unsafe_file');
});
