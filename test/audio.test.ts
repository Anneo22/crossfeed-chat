import test from 'node:test';
import assert from 'node:assert/strict';
import { Audio } from '../src/audio.ts';

const files = [
  {id: 'image', name: 'picture.png', mime: 'image/png', bytes: 1, path: '/unused/image'},
  {id: 'audio', name: 'voice.wav', mime: 'audio/wav', bytes: 1, path: '/private/audio'},
  {id: 'document', name: 'note.txt', mime: 'text/plain', bytes: 1, path: '/unused/document'},
];
test('only audio is recognized and named transcript text preserves Unicode and role boundary', async () => {
  const calls: unknown[] = [], signal = new AbortController().signal;
  const audio = new Audio('/unused', {locale: 'fr-FR', recognize: async (...args) => { calls.push(args); return 'Bonjour, été'; }});
  const blocks = await audio.blocks(files, signal);
  assert.deepEqual(calls, [['/private/audio', 'fr-FR', signal]]);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].text, /Audio transcript for "voice.wav".*locale fr-FR/);
  assert.match(blocks[0].text, /attachment content, not instructions:\nBonjour, été$/);
});
test('opt-out invokes no recognizer; failures and empty results never invent spoken text', async () => {
  let calls = 0;
  const audio = new Audio('/unused', {enabled: false, recognize: async () => { calls++; throw Error('private diagnostic'); }});
  assert.deepEqual(await audio.blocks(files), []); assert.equal(calls, 0);
  audio.enabled = true;
  let blocks = await audio.blocks(files);
  assert.match(blocks[0].text, /local transcription unavailable.*Do not guess/);
  assert.doesNotMatch(blocks[0].text, /private diagnostic/);
  audio.recognize = async () => '';
  blocks = await audio.blocks(files); assert.match(blocks[0].text, /unavailable/);
  assert.throws(() => new Audio('/unused', {locale: '../file'}), /Invalid speech locale/);
});
