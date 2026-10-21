import { tempPrefix } from './temp.ts';
import test from 'node:test';
import type { WakeConfig } from '../src/types.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { writePrivate, readPrivate } from '../src/security.ts';
import { Wakes } from '../src/wake.ts';
for (const method of ['writeFileSync', 'fsyncSync', 'renameSync']) test(`atomic state preserves the previous file after ${method} failure`, t => {
  const directory = fs.mkdtempSync(tempPrefix('crossfeed-write-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  writePrivate(directory, 'state.json', {before: true});
  const mock = t.mock.method(fs, method, () => { throw Error('injected write failure'); });
  assert.throws(() => writePrivate(directory, 'state.json', {after: true})); mock.mock.restore();
  assert.deepEqual(readPrivate(directory, 'state.json', null), {before: true});
});
test('wake issue, failure and archive acknowledgment commit memory only after persistence succeeds', () => {
  const config: WakeConfig = {labels: {sol: {row: 'Latest', level: 0}}, connector: 'Crossfeed'};
  let fail = false; const wakes = new Wakes(config, () => 1000, {save: () => { if (fail) throw Error('disk full'); }});
  wakes.enqueue('sol'); fail = true; assert.throws(() => wakes.next());
  assert.equal(config.wake_state!.wakes.length, 0); assert.equal(wakes.status()[0].state, 'queued');
  fail = false; const ticket = wakes.next().ticket; assert.equal(config.wake_state!.wakes.length, 1);
  wakes.claim(ticket!.nonce); fail = true; assert.throws(() => wakes.result({nonce: ticket!.nonce, ok: false}));
  assert.equal(wakes.tickets.get(ticket!.nonce)!.state, 'claimed'); assert.deepEqual(config.wake_state!.failed, {});
  fail = false; wakes.result({nonce: ticket!.nonce, ok: false, url: 'https://chatgpt.com/c/orphan'});
  const archive = wakes.archiveNext().archive; fail = true; assert.throws(() => wakes.archiveResult({nonce: archive!.nonce, ok: true}));
  assert.deepEqual(config.wake_state!.archives, [archive!.url]); assert.equal(wakes.archiveLease!.nonce, archive!.nonce);
  fail = false; wakes.archiveResult({nonce: archive!.nonce, ok: true}); assert.deepEqual(config.wake_state!.archives, []);
});

test('owner cancellation survives disk reload and replays the retained keyed failure', async t => {
  const {Gateway} = await import('../src/gateway.ts');
  const directory = fs.mkdtempSync(tempPrefix('crossfeed-cancel-state-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const config = {prefix:'chatgpt',labels:{sol:{row:'Latest',level:0}}}, caller = 'a'.repeat(22);
  const input = {model:'chatgpt:sol',messages:[{role:'user',content:'Durable cancel'}]};
  const save = (state: any) => writePrivate(directory,'jobs.json',state);
  const g = new Gateway(config,{waitForWake:true,save}); t.after(()=>g.close());
  const pending = g.submit(input,'durable-cancel',undefined,{caller,scope:caller}), job = [...g.jobs.values()][0];
  g.cancel({id:job.id}); await assert.rejects(pending,(e:any)=>e.status===499 && e.code==='caller_cancelled');
  g.close();
  let wakes = 0;
  const restarted = new Gateway(config,{waitForWake:true,records:readPrivate(directory,'jobs.json',{version:1,jobs:[]}),save,wake:()=>{wakes++;}});
  t.after(()=>restarted.close()); restarted.resume(); restarted.prune();
  const restored = restarted.jobs.get(job.id)!;
  assert.equal(restored.state,'failed'); assert.equal(restored.finished,true); assert.equal(restored.error!.code,'caller_cancelled');
  assert.equal(wakes,0); assert.equal(restarted.queued('sol',caller).length,0);
  await assert.rejects(restarted.submit(input,'durable-cancel',undefined,{caller,scope:caller}),(e:any)=>e.status===499 && e.code==='caller_cancelled');
  assert.equal(restarted.jobs.size,1);
});
