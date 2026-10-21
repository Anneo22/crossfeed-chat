import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

async function run(t: import('node:test').TestContext, handler: any, deadlineMs: number) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfeed-live-test-'));
  t.after(() => fs.rmSync(directory, {recursive:true, force:true}));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jgekAAAAASUVORK5CYII=', 'base64');
  const wav = Buffer.alloc(44); wav.write('RIFF'); wav.write('WAVE', 8);
  for (const [name, bytes] of [['image.png', png], ['audio.wav', wav], ['note.txt', 'test marker']] as [string, string | Buffer][]) fs.writeFileSync(path.join(directory, name), bytes);
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const child = spawn(process.execPath, ['scripts/live-attachments.ts', '--api-port', String(server.address().port), '--label', 'test', '--image', path.join(directory, 'image.png'), '--audio', path.join(directory, 'audio.wav'), '--file', path.join(directory, 'note.txt'), '--job-deadline-ms', String(deadlineMs)], {env:{...process.env, CROSSFEED_API_KEY:'test-key'}});
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk: any) => { stdout += chunk; });
  child.stderr.on('data', (chunk: any) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  return {code, stdout, stderr};
}

test('live caller waits for delayed headers and retrieves the returned file', async t => {
  // Opt in to crossing fetch's actual 300-second headers limit.
  const delay = process.env.CROSSFEED_TEST_SLOW_HEADERS === '1' ? 301000 : 100;
  let payload: any, key: any;
  const result = await run(t, (req: any, res: any) => {
    if (req.url === '/v1/files/result/content') { res.end('returned observations'); return; }
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer test-key');
    key = req.headers['idempotency-key'];
    let body = '';
    req.on('data', (chunk: any) => { body += chunk; });
    req.on('end', () => {
      payload = JSON.parse(body);
      const timer = setTimeout(() => res.end(JSON.stringify({choices:[{message:{content:'worker observations'}}], files:[{id:'result', name:'crossfeed-result.txt', mime:'text/plain', bytes:21}]})), delay);
      res.on('close', () => clearTimeout(timer));
    });
  }, delay + 5000);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(payload.model, 'chatgpt:test');
  assert.deepEqual(payload.messages[0].content.map((part: any) => part.type), ['text', 'image_url', 'input_audio', 'file']);
  assert.match(key, /^live-/);
  assert.match(result.stdout, /Returned file: crossfeed-result.txt, text\/plain, 21 bytes\nreturned observations/);
});

for (const headers of [false, true]) {
  test(`job deadline aborts a stalled ${headers ? 'body' : 'headers'} response`, async t => {
    let disconnected: any;
    const closed = new Promise(resolve => { disconnected = resolve; });
    const result = await run(t, (req: any, res: any) => {
      req.resume();
      if (headers) { res.writeHead(200, {'Content-Type':'application/json'}); res.write('{'); }
      res.on('close', disconnected);
    }, 200);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Acceptance request failed/);
    await closed;
  });
}
