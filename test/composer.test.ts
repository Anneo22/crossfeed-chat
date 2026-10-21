import test from 'node:test';
import type { WakeConfig } from '../src/types.ts';
import assert from 'node:assert/strict';
import type { PollBrowser, PageTicket } from '../extension/types.d.ts';
// The fixtures intentionally install partial browser and DOM objects.
const globals: any = globalThis;
import { makePoller, validTicket } from '../extension/core.js';
import { pageWake } from '../extension/page.js';
import { Wakes } from '../src/wake.ts';

const attachment = (name = 'diagram.png') => ({id: 'file1', name, path: `/private/state/files/file1/${name}`, mime: 'image/png', bytes: 100});
const ticket = () => ({nonce: 'n'.repeat(32), type: 'composer' as const, job_id: 'job1', label: 'sol', row: 'Latest', level: 2,
  connector: 'Crossfeed', attachments: [attachment()], expires_at: Date.now() + 240000});
const message = (t: any) => `process exactly job ${t.job_id} as ${t.label}. Call gateway_exchange with worker_label=${JSON.stringify(t.label)}, request_id=${JSON.stringify(t.job_id)} and maximum_wait_seconds=1 to fetch this job only. Use these uploaded attachments with its request, submit its answer with request_id and claim_token, then stop when released.`;

function pollFixture(options: Record<string, any> = {}) {
  const events: any[] = [], value = {...ticket(), ...options.ticket};
  let time = Date.now(), issued = false, sent = false, level = 2, uploadReads = 0, pickerOpen = false, maximum = options.pickerMax ?? 4, pickerInputs = 0, transientReads = 0;
  const apiURL = 'http://127.0.0.1:4319', key = 'e'.repeat(43);
  const browser = {
    storage: {local: {get: async () => ({apiURL, key, pairingVersion: 1, pairing: {id: 'p'.repeat(32), state: 'approved', apiURL, checked_at: Date.now()}})}},
    tabs: {create: async (args: any) => {events.push({create: args}); return {id: 42};}, group: async (args: any) => {events.push({group: args}); return 5;}, get: async () => ({status: 'complete', url: sent ? 'https://chatgpt.com/c/one-shot' : 'https://chatgpt.com/'}), remove: async (id: any) => events.push({remove: id})},
    tabGroups: {update: async (id: any, args: any) => events.push({groupUpdate: {id, ...args}})},
    debugger: {attach: async () => {}, detach: async () => events.push({detach: true}), sendCommand: async (_: any, method: string, params: any) => {
      events.push({method, params});
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased' && params.x === 6) pickerOpen = !pickerOpen;
      if (method === 'DOM.getDocument') return {root: {nodeId: 1}};
      if (method === 'DOM.querySelector') return {nodeId: options.missingInput ? 0 : 2};
      if (method === 'DOM.setFileInputFiles' && options.uploadCommandFailure) throw Error('private disk detail');
      if (method === 'Input.dispatchKeyEvent' && params.type === 'keyDown') {
        if (params.key === 'ArrowLeft') { level = Math.max(0, level - 1); pickerInputs++; }
        if (params.key === 'ArrowRight') { level = Math.min(maximum, level + 1); pickerInputs++; }
        if (options.mutateRange && pickerInputs === 1) maximum = options.mutatedMax ?? 3;
        if ((options.transientRange || options.transientRow) && pickerInputs === 1) transientReads = 1;
        if (params.key === 'Escape') pickerOpen = false;
        if (params.key === 'Enter') {sent = true; if (options.uncertainEnter) throw Error('lost reply');}
      }
      return {};
    }},
    scripting: {executeScript: async ({func, args}: any) => {
      assert.equal(func, pageWake); assert(!JSON.stringify(args).includes('/private/state')); assert(!JSON.stringify(args).includes(key));
      const action = args[1]; events.push({action});
      if (action === options.refused) throw Error(options.reason ?? 'composer_not_empty');
      const names = ['Instant', 'Medium', 'High', 'Extra High', 'Pro'];
      const transient = action === 'picker' && transientReads > 0;
      const shownMaximum = transient && options.transientRange ? options.mutatedMax ?? 3 : maximum;
      const shownRow = transient && options.transientRow ? 'Other' : 'Latest';
      if (transient) transientReads--;
      const states: Record<string, any> = {ready: {ready: true, empty: true, chat: true}, modelFocus: {focused: true, modelPoint: {x: 6, y: 6}}, sliderFocus: {focused: true}, editorFocus: {focused: true},
        picker: {open: pickerOpen, row: shownRow, minimum: '0', maximum: String(shownMaximum), position: level, status: `${names[level]}, ${level + 1} of ${shownMaximum + 1}.`},
        mention: {mentionPoint: {x: 1, y: 1}}, resolved: {resolved: true, focused: true}, uploadInput: {ready: true, uploadSelector: 'form input[type="file"][aria-label="Attach files"]'}, uploads: {ready: ++uploadReads > (options.uploadWaits ?? 1)}, send: {ready: true}, registration: {url: sent ? 'https://chatgpt.com/c/one-shot' : 'https://chatgpt.com/'}};
      return [{documentId: options.changedDocument && action === 'uploads' ? 'other' : 'document1', result: states[action]}];
    }},
  };
  const fetcher = async (url: any, init: any) => {
    const path = new URL(url).pathname, body = init.body && JSON.parse(init.body); events.push({path, body});
    const result = path === '/extension/next' ? {ticket: issued ? null : value} : path === '/extension/check' ? {registered: !options.noExactContact} : {ok: true};
    if (path === '/extension/next') issued = true;
    return {ok: true, text: async () => JSON.stringify(result)};
  };
  return {events, value, run: () => makePoller(browser as unknown as PollBrowser, fetcher, () => time, async ms => {time += ms;})()};
}
const enters = (f: any) => f.events.filter((e: any) => e.params?.key === 'Enter' && e.params.type === 'keyDown');

test('composer tickets accept only bounded canonical disk files with matching unique names', () => {
  assert(validTicket(ticket()));
  for (const file of [{path: '/private/../secret/diagram.png'}, {path: '/private/secret.png'}, {path: '//private/diagram.png'}, {path: 'relative/diagram.png'}, {path: '/private/\u200b/diagram.png'}, {name: '..'}, {bytes: 20 * 1024 * 1024 + 1}]) assert.equal(validTicket({...ticket(), attachments: [{...attachment(), ...file}]}), false);
  for (const change of [{job_id: ''}, {attachments: []}, {attachments: [attachment(), attachment()]}, {type: 'wake'}]) assert.equal(validTicket({...ticket(), ...change}), false);
  assert.equal(validTicket({...ticket(), type: undefined}), false);
});

test('composer uploads only ticket paths, waits completed chips then sends exact job once', async () => {
  const f = pollFixture({uploadWaits: 5, ticket: {title: 'image · Report'}}); await f.run();
  assert.deepEqual(f.events.find(e => e.create).create, {url: 'https://chatgpt.com/', active: false});
  assert.deepEqual(f.events.find(e => e.group).group, {tabIds: [42]});
  assert.deepEqual(f.events.find(e => e.groupUpdate).groupUpdate,
    {id: 5, title: 'Crossfeed · image · Report', color: 'blue', collapsed: true});
  assert.deepEqual(f.events.find(e => e.method === 'DOM.setFileInputFiles').params, {nodeId: 2, files: [attachment().path]});
  const upload = f.events.findIndex(e => e.method === 'DOM.setFileInputFiles'), send = f.events.findIndex(e => e.params?.key === 'Enter');
  assert(upload >= 0 && upload < send); assert(f.events.slice(upload, send).some(e => e.action === 'uploads'));
  assert.equal(enters(f).length, 1);
  assert.deepEqual(f.events.filter(e => e.method === 'Input.insertText').map(e => e.params.text), ['@Crossfeed', ' ' + message(f.value)]);
  assert.deepEqual(f.events.find(e => e.path === '/extension/result').body, {nonce: f.value.nonce, ok: true, url: 'https://chatgpt.com/c/one-shot'});
  assert.deepEqual(f.events.slice(-2), [{detach: true}, {remove: 42}]);
});

test('composer accepts a three-position picker and observes High exactly', async () => {
  const f = pollFixture({pickerMax: 2}); await f.run();
  assert.equal(enters(f).length, 1);
  assert.deepEqual(f.events.find(e => e.path === '/extension/observe').body.picker_receipt, {row: 'Latest', level: 2});
  assert.deepEqual(f.events.filter(e => e.params?.type === 'keyDown' && ['ArrowLeft', 'ArrowRight'].includes(e.params.key)).map(e => e.params.key),
    ['ArrowLeft', 'ArrowLeft', 'ArrowRight', 'ArrowRight']);
});

test('composer refuses unavailable three-position levels before slider input, observation or send', async () => {
  for (const level of [3, 4]) {
    const f = pollFixture({pickerMax: 2, ticket: {level}}); await f.run();
    assert.equal(f.events.some(e => e.action === 'sliderFocus'), false);
    assert.equal(f.events.some(e => e.params?.key === 'ArrowLeft' || e.params?.key === 'ArrowRight'), false);
    assert.equal(f.events.some(e => e.path === '/extension/observe'), false);
    assert.equal(enters(f).length, 0);
    assert.equal(f.events.find(e => e.path === '/extension/result').body.error, 'level_unconfirmed');
  }
});

test('composer preserves five-position authority and refuses a range mutation before observation', async () => {
  const five = pollFixture({ticket: {level: 4}}); await five.run();
  assert.equal(enters(five).length, 1);
  assert.deepEqual(five.events.find(e => e.path === '/extension/observe').body.picker_receipt, {row: 'Latest', level: 4});

  const changed = pollFixture({mutateRange: true, mutatedMax: 3}); await changed.run();
  assert.equal(changed.events.some(e => e.path === '/extension/observe'), false);
  assert.equal(enters(changed).length, 0);
  assert.equal(changed.events.find(e => e.path === '/extension/result').body.error, 'level_unconfirmed');
});

test('composer refuses even transient row or range authority changes before observation', async () => {
  for (const options of [{transientRange: true, mutatedMax: 3}, {transientRow: true}]) {
    const f = pollFixture(options); await f.run();
    assert.equal(f.events.some(e => e.path === '/extension/observe'), false);
    assert.equal(enters(f).length, 0);
    assert.equal(f.events.find(e => e.path === '/extension/result').body.error, 'level_unconfirmed');
  }
});

test('upload ambiguity, occupied composer, errors, document changes and timeout refuse Enter', async () => {
  for (const options of [{missingInput: true}, {uploadCommandFailure: true}, {refused: 'editorFocus'}, {refused: 'uploads', reason: 'upload_failed'}, {refused: 'uploads', reason: 'composer_not_empty'}, {changedDocument: true}, {uploadWaits: 10000}]) {
    const f = pollFixture(options); await f.run(); assert.equal(enters(f).length, 0);
    assert.equal(f.events.find(e => e.path === '/extension/result').body.ok, false);
    assert.deepEqual(f.events.at(-1), {remove: 42});
  }
});

test('composer registration requires exact contact and uncertain send reports only orphan URL once', async () => {
  for (const options of [{noExactContact: true}, {uncertainEnter: true}]) {
    const f = pollFixture(options); await f.run(); await f.run();
    assert.equal(enters(f).length, 1); const result = f.events.find(e => e.path === '/extension/result').body;
    assert.equal(result.ok, false); assert.equal(result.url, 'https://chatgpt.com/c/one-shot');
    assert(!JSON.stringify(result).includes('private'));
  }
});

function wakeFixture() {
  let now = 1000, claimed = false, finished = false, contacts = 0;
  const failures: any[] = [], config: WakeConfig = {connector: 'Crossfeed', labels: {sol: {row: 'Latest', level: 2, url: 'https://chatgpt.com/c/normal'}}};
  const wakes = new Wakes(config, () => now, {contact: () => contacts, active: () => true, jobContact: (id: any) => id === 'job1' && claimed, jobFinished: () => finished, failed: (...args: any[]) => failures.push(args)});
  const begin = () => {wakes.enqueueComposer({id: 'job1', label: 'sol', attachments: [attachment()]}); const {ticket} = wakes.next(); wakes.claim(ticket!.nonce); return ticket;};
  return {wakes, config, failures, begin, claim: () => {claimed = true;}, finish: () => {finished = true;}, contact: () => {contacts++;}, advance: (ms: number) => {now += ms;}};
}

test('composer wake observes its exact job only, preserving saved worker URL and durable cleanup', () => {
  const f = wakeFixture(), t = f.begin(); assert.equal(t!.type, 'composer'); assert.equal(t!.job_id, 'job1');
  assert.equal(f.wakes.has('sol'), false); assert.equal(f.wakes.has('sol', 'job1'), true);
  f.contact(); assert.equal(f.wakes.check(t!.nonce).registered, false);
  f.wakes.observe({nonce: t!.nonce, picker_receipt: {row: 'Latest', level: 2}});
  assert.equal(f.wakes.observation('sol'), null); assert.equal(f.wakes.observation('sol', 'job1')!.row, 'Latest');
  f.claim(); assert.equal(f.wakes.check(t!.nonce).registered, true);
  f.wakes.result({nonce: t!.nonce, ok: true, url: 'https://chatgpt.com/c/one-shot'});
  assert.equal(f.config.labels.sol.url, 'https://chatgpt.com/c/normal'); assert.deepEqual(f.config.wake_state!.archives, ['https://chatgpt.com/c/one-shot']);
  assert.equal(f.wakes.archiveNext().archive, null); f.advance(600001); f.wakes.prune(); assert.equal(f.wakes.archiveNext().archive, null);
  f.finish(); assert.equal(f.wakes.archiveNext().archive!.url, 'https://chatgpt.com/c/one-shot');
  const restarted = new Wakes(f.config); assert.equal(restarted.archiveNext().archive!.url, 'https://chatgpt.com/c/one-shot');
});

test('uncertain composer orphans wait for the active job to finish before archive', () => {
  for (const expired of [false, true]) {
    const f = wakeFixture(), t = f.begin(); f.claim();
    if (expired) {f.advance(240001); f.wakes.prune();}
    f.wakes.result({nonce: t!.nonce, ok: false, url: 'https://chatgpt.com/c/orphan'});
    assert.equal(f.wakes.archiveNext().archive, null);
    f.advance(600001); f.wakes.prune(); assert.equal(f.wakes.archiveNext().archive, null);
    f.finish(); assert.equal(f.wakes.archiveNext().archive!.url, 'https://chatgpt.com/c/orphan');
    assert.equal(f.config.labels.sol.url, 'https://chatgpt.com/c/normal');
  }
});

test('composer shares durable volume guards, isolates failure callback and never archives normal chat', () => {
  const f = wakeFixture(), t = f.begin(); assert.equal(f.config.wake_state!.wakes.length, 1);
  f.wakes.result({nonce: t!.nonce, ok: false, url: 'https://chatgpt.com/c/normal'});
  assert.deepEqual(f.failures, [['sol', 'job1']]); assert.deepEqual(f.config.wake_state!.archives, []);
  const g = wakeFixture(); g.config.wake_hourly_cap = 0; g.wakes.enqueueComposer({id: 'job1', label: 'sol', attachments: [attachment()]});
  assert.equal(g.wakes.next().ticket, null); assert.deepEqual(g.failures, []);
  assert.equal(g.wakes.status()[0].state, 'queued');
  g.advance(900001); g.wakes.prune(); assert.equal(g.wakes.status()[0].state, 'queued');
  g.config.wake_hourly_cap = 1; assert.equal(g.wakes.next().ticket!.job_id, 'job1');
});

test('finished jobs are discarded before upload and multiple composer jobs can share a label', () => {
  const f = wakeFixture(); f.finish(); f.wakes.enqueueComposer({id: 'job1', label: 'sol', attachments: [attachment()]}); assert.equal(f.wakes.next().ticket, null);
  const g = wakeFixture(); g.wakes.enqueueComposer({id: 'job1', label: 'sol', attachments: [attachment()]});
  assert.throws(() => g.wakes.enqueueComposer({id: 'job1', label: 'sol', attachments: [attachment()]}), e => e.status === 409);
  g.wakes.enqueueComposer({id: 'job2', label: 'sol', attachments: [attachment()]}); g.wakes.enqueue('sol');
  assert.equal(g.wakes.tickets.size, 3);
});

function pageFixture(options: Record<string, any> = {}) {
  const element = (content = '', attrs: Record<string, any> = {}): any => ({textContent: content, isConnected: true, getClientRects: () => [1],
    getBoundingClientRect: () => ({x: 0, y: 0, width: 2, height: 2}), closest: () => null,
    getAttribute: (key: any) => attrs[key] ?? null, querySelectorAll: () => [], contains: () => false, focus() { globals.document.activeElement = this; }});
  const parent = element(), chat = element('Chat', {'aria-selected': 'true'}), work = element('Work', {'aria-selected': 'false'});
  chat.parentElement = work.parentElement = parent;
  const editor = element(), model = element(), form = element(), mention = element('Crossfeed'); editor.isContentEditable = true;
  const input = {...element(), files: options.files ?? [], disabled: false, tagName: 'INPUT'}, send = {...element(), disabled: false}; input.closest = () => form;
  editor.closest = (selector: string) => selector === 'form' ? form : null;
  editor.querySelectorAll = (selector: string) => selector.includes('contenteditable="false"') ? [mention] : [];
  const attachments = (options.names ?? ['diagram.png']).map((name: any) => {
    const span = element(name), remove = {...element(), disabled: options.disabledRemove ?? false}, progress = element();
    const chip = element(name, {'title': name, 'aria-busy': String(options.busy ?? false)});
    chip.querySelectorAll = (selector: string) => selector.includes('progressbar') ? options.progress ? [progress] : [] : selector.includes('remove-attachment') ? options.uncertainReady ? [] : [remove] : selector.includes('[role="alert"]') ? options.failed ? [element('failed')] : [] : selector.includes('span, ') ? [span] : [];
    chip.contains = (el: any) => el === span || el === remove || el === progress;
    return chip;
  });
  form.querySelectorAll = (selector: string) => selector.includes('send-button') ? [send] : selector.includes('attachment') ? options.empty ? [] : attachments : selector === 'img' && options.extraImage ? [element()] : [];
  const doc: any = {activeElement: null, querySelectorAll: (selector: string) => selector === 'form #prompt-textarea[contenteditable="true"], form [contenteditable="true"][role="textbox"]' ? [editor] : selector.includes('model-switcher') ? [model] : selector === 'button, [role="tab"]' ? [chat, work] : selector === 'input[type="file"]' || selector === 'form input[type="file"][aria-label="Attach files"]' ? options.multipleInputs ? [input, {...input}] : options.noInput ? [] : [input] : selector.includes('stop-button') && options.stop ? [element()] : []};
  return {doc, editor, input, attachments};
}
async function inPage(fixture: any, run: any) {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document'), oldLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  globals.document = fixture.doc; globals.location = {href: 'https://chatgpt.com/', origin: 'https://chatgpt.com'};
  try { return await run(); }
  finally {
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else delete globals.document;
    if (oldLocation) Object.defineProperty(globalThis, 'location', oldLocation); else delete globals.location;
  }
}

test('page upload guard requires unique composer-owned empty input and preserves wake attachment refusal', async () => {
  const t = ticket(); const f = pageFixture({empty: true});
  await inPage(f, () => assert.deepEqual(pageWake(t, 'uploadInput'), {ready: true, uploadSelector: 'form input[type="file"][aria-label="Attach files"]'}));
  for (const options of [{multipleInputs: true}, {noInput: true}, {empty: true, files: [{name: 'stray.txt', size: 5}]}, {stop: true}]) {
    const f = pageFixture(options); await inPage(f, () => assert.throws(() => pageWake(t, 'uploadInput'), /upload_unconfirmed|composer_not_empty/));
  }
  const withFiles = pageFixture(); withFiles.editor.textContent = 'Crossfeed wake up as sol';
  await inPage(withFiles, () => assert.throws(() => pageWake({...t, type: undefined} as unknown as PageTicket, 'send'), /composer_not_empty/));
});

test('page upload completion requires every own chip with no busy, progress, error or ambiguous status', async () => {
  const t = ticket(), f = pageFixture({files: [{name: 'diagram.png', size: 100}]});
  await inPage(f, () => assert.deepEqual(pageWake(t, 'uploads'), {ready: true}));
  for (const options of [{busy: true}, {progress: true}, {uncertainReady: true}, {disabledRemove: true}, {empty: true}]) {
    const f = pageFixture(options); await inPage(f, () => assert.deepEqual(pageWake(t, 'uploads'), {ready: false}));
  }
  for (const options of [{names: ['stray.txt']}, {names: ['diagram.png', 'diagram.png']}, {failed: true}, {extraImage: true}, {files: [{name: 'diagram.png', size: 99}]}, {files: [{name: 'stray.txt', size: 100}]}]) {
    const f = pageFixture(options); await inPage(f, () => assert.throws(() => pageWake(t, 'uploads'), /composer_not_empty|upload_failed/));
  }
  const partial = pageFixture(); await inPage(partial, () => assert.deepEqual(pageWake({...t, attachments: [attachment(), attachment('report.pdf')]}, 'uploads'), {ready: false}));
});

test('composer Send validates exact job instruction and rechecks completed attachment chips', async () => {
  const t = ticket(), f = pageFixture(); f.editor.textContent = 'Crossfeed ' + message(t);
  await inPage(f, () => assert.deepEqual(pageWake(t, 'send'), {ready: true}));
  await inPage(f, () => assert.throws(() => pageWake({...t, job_id: 'another'}, 'send'), /mention_unconfirmed/));
  for (const options of [{progress: true}, {empty: true}, {names: ['stray.txt']}, {stop: true}]) {
    const f = pageFixture(options); f.editor.textContent = 'Crossfeed ' + message(t);
    await inPage(f, () => assert.throws(() => pageWake(t, 'send'), /upload_unconfirmed|composer_not_empty|send_unconfirmed/));
  }
});


test('composer selects Attach files while unrelated photo and video inputs remain present', async () => {
  const f = pageFixture({empty: true}), query = f.doc.querySelectorAll;
  f.doc.querySelectorAll = (selector: string) => selector === 'input[type="file"]' ? [f.input, {...f.input}, {...f.input}] : query(selector);
  await inPage(f, () => assert.deepEqual(pageWake(ticket(), 'uploadInput'), {ready: true, uploadSelector: 'form input[type="file"][aria-label="Attach files"]'}));
});

test('delete disposal marks the archive lease and archive stays the default', () => {
  for (const disposal of [undefined, 'archive', 'delete'] as const) {
    const config: WakeConfig = {connector: 'Crossfeed', labels: {sol: {row: 'Latest', level: 2}}, ...(disposal ? {chat_disposal: disposal} : {}),
      wake_state: {wakes: [], failed: {}, cooldown_until: 0, archives: ['https://chatgpt.com/c/old'], ...(disposal === 'delete' ? {started_chats: ['https://chatgpt.com/c/old']} : {})}};
    const lease = new Wakes(config).archiveNext().archive!;
    assert.equal(lease.url, 'https://chatgpt.com/c/old');
    assert.equal(lease.remove === true, disposal === 'delete');
  }
});

test('releasing a session queues only its own recorded chats and forgets its workers', () => {
  const config: WakeConfig = {connector: 'Crossfeed', labels: {sol: {row: 'Latest', level: 2, url: 'https://chatgpt.com/c/normal'}},
    session_workers: {
      'sol~session-mine': {label: 'sol', scope: 'mine', url: 'https://chatgpt.com/c/mine'},
      'sol~session-other': {label: 'sol', scope: 'other', url: 'https://chatgpt.com/c/other'}},
    wake_state: {wakes: [], failed: {}, cooldown_until: 0, archives: []}};
  const wakes = new Wakes(config);
  assert.deepEqual(wakes.releaseSession('nobody'), {released: 0});
  assert.deepEqual(wakes.releaseSession('mine'), {released: 1, queued: 1});
  assert.deepEqual(config.wake_state!.archives, ['https://chatgpt.com/c/mine']);
  assert.deepEqual(Object.keys(config.session_workers!), ['sol~session-other']);
  assert.deepEqual(wakes.releaseSession('mine'), {released: 0});
  assert.equal(config.labels.sol.url, 'https://chatgpt.com/c/normal');
});
