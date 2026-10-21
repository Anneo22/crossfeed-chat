import test from 'node:test';
import assert from 'node:assert/strict';
import type { PollBrowser, Fetcher } from '../extension/types.d.ts';
// The fixtures intentionally install partial browser and DOM objects.
const globals: any = globalThis;
import { readFile } from 'node:fs/promises';
import { apiURL, savedChatURL, validTicket, request, makePoller, archiveConversation, isWakeSignature, firstUserText, sweepWakeChats, closeOrphanedWakeTabs, clearOwnedWakeTabs } from '../extension/core.js';
import { pageWake, prefillProbe, prefillModel, prefillWake, pagePermission } from '../extension/page.js';

const ticket = () => ({nonce: 'a'.repeat(32), label: 'research', connector: 'Crossfeed Chat', wake_mode: 'native' as const,
  row: 'GPT-6', level: 3, expires_at: Date.now() + 60_000});
const ordinaryPrompt = (value: ReturnType<typeof ticket>) => `@${value.connector} wake up. First gateway_exchange: worker_label=${JSON.stringify(value.label)} exactly as issued, wake_nonce=${JSON.stringify(value.nonce)}, maximum_wait_seconds=20. Then use the server-returned worker_label and repeat wake_nonce=${JSON.stringify(value.nonce)} on all subsequent gateway_exchange calls. Poll until state=released and continue=false; do not send a final chat reply between jobs. Return local caller tools as structured tool_calls through gateway_exchange; do not execute them natively.`;

test('saved URLs allow only an exact HTTPS saved conversation path', () => {
  assert.equal(savedChatURL('https://chatgpt.com/c/example'), 'https://chatgpt.com/c/example');
  for (const value of ['https://chatgpt.com/', 'https://chatgpt.com/c/x/', 'https://chatgpt.com/c/x?q=hi',
    'https://chatgpt.com/c/local-chatgpt%3A8913b581-eb16-4dd3-ac9e-a1cf513ed722',
    'https://chatgpt.com/c/x#hi', 'https://chatgpt.com/c/x/y', 'https://chatgpt.com/c/%78',
    'https://chatgpt.com/c/../x', 'https://chatgpt.com:443/c/x', 'https://user@chatgpt.com/c/x',
    'https://chatgpt.com.evil/c/x', 'http://chatgpt.com/c/x', ' https://chatgpt.com/c/x',
    'https://chatgpt.com/c/x?prompt=wake']) assert.equal(savedChatURL(value), null, value);
});

test('options allow only a canonical loopback API origin with a real port', () => {
  assert.equal(apiURL('http://127.0.0.1:4319'), 'http://127.0.0.1:4319');
  for (const value of ['http://localhost:4319', 'http://127.0.0.1:0', 'http://127.0.0.1:65536',
    'http://127.0.0.1:04319', 'http://127.0.0.1:4319/', 'http://127.0.0.1:4319/x',
    'http://127.0.0.1:4319?x', 'http://127.0.0.1:4319#x', 'https://127.0.0.1:4319',
    'http://127.0.0.1:4319@evil', 'http://127.0.0.2:4319']) assert.equal(apiURL(value), null, value);
});

test('tickets bind an unexpired nonce, model row, level and exact wake semantics', () => {
  const value = ticket();
  assert.equal(validTicket(value), true);
  assert.equal(validTicket({...value, connector: 'Crossfeed (local)', label: 'Research worker'}), true);
  assert.equal(validTicket({...value, title: 'review · Task Manager'}), true);
  for (const update of [{expires_at: Date.now()}, {nonce: 'bad'}, {row: ''}, {label: 'a\nsend'},
    {connector: '@Other'}, {connector: 'Crossfeed\nChat'}, {title: 'bad\ntitle'}, {title: 'x'.repeat(81)},
    {level: ''}, {level: -1}, {level: 5}, {level: 1.5}]) {
    assert.equal(validTicket({...value, ...update}), false);
  }
});

test('manifest has only loopback and ChatGPT hosts, no messaging or content-script bridge', async () => {
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.permissions, ['storage', 'alarms', 'scripting', 'tabs', 'tabGroups', 'debugger']);
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*', 'https://chatgpt.com/*']);
  for (const key of ['externally_connectable', 'content_scripts', 'web_accessible_resources']) assert.equal(manifest[key], undefined);
});


test('private legacy bootstrap stays packaged and validates one exact 128-bit title marker', async () => {
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.web_accessible_resources, undefined);
  const html = await readFile(new URL('../extension/wake-window.html', import.meta.url), 'utf8');
  assert.match(html, /<script src="wake-window\.js" defer><\/script>/);
  assert.match(html, /<meta name="referrer" content="no-referrer">/);
  const source = await readFile(new URL('../extension/wake-window.js', import.meta.url), 'utf8');
  const hydrate = new Function('URL','location','document',source);
  const root = 'chrome-extension://' + 'a'.repeat(32) + '/wake-window.html';
  const marker = 'f'.repeat(32);
  const variants = [
    [root + '?marker=' + marker, 'Crossfeed Wake ' + marker],
    [root + '?marker=' + marker + '&marker=' + marker, 'Crossfeed Wake'],
    [root + '?marker=' + marker + '&other=1', 'Crossfeed Wake'],
    [root + '?marker=' + marker + '#spoof', 'Crossfeed Wake'],
    [root + '?marker=' + marker.toUpperCase(), 'Crossfeed Wake'],
    [root + '?marker=' + 'a'.repeat(31), 'Crossfeed Wake'],
    [root + '?marker=', 'Crossfeed Wake'],
  ];
  for (const [href, expected] of variants) {
    const page = {title:'Crossfeed Wake'};
    hydrate(URL,{href},page);
    assert.equal(page.title,expected,href);
  }
});

function workerFixture(options: Record<string, any> = {}) {
  const events: any[] = [];
  let clock = Date.now(), row = options.row ?? 'Older', position = 2, chat = options.chat ?? false, sent = false, returned = false, pendingMention = false, pickerOpen = false, registrationReads = 0, registrationScripts = 0, tabReads = 0, checks = 0;
  const value: any = {...ticket(), ...(Object.hasOwn(options, 'wakeMode') ? {wake_mode: options.wakeMode} : {}), ...(options.composer ? {type: 'composer', job_id: 'job_1', attachments: [{name: 'x.txt', path: '/tmp/x.txt', mime: 'text/plain', bytes: 1}]} : {}), ...(options.ticket ?? {}), expires_at: clock + 240000}, point = (n: any) => ({x: n, y: n});
  const fetcher = async (url: any, init: any) => {
    const path = new URL(url).pathname, body = init.body && JSON.parse(init.body);
    events.push({path, body});
    assert.equal(init.headers.Authorization, 'Bearer ' + 'e'.repeat(43));
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
    let result: Record<string, any> = {ok: true};
    if (path === '/extension/next') { result = {ticket: returned || options.archive ? null : value}; returned = true; }
    if (path === '/extension/claim') { result = {ok: !options.claimDenied,
      ...(Object.hasOwn(options,'focusGuardReply') ? {focus_guard: options.focusGuardReply} : {})};
      if (options.expired) clock += 240001; }
    if (path === '/extension/check') {
      checks++;
      if (options.media && checks === 1) options.allow = true;
      result = {registered: !options.noContact, ...(options.media && checks < 4 ? {media_pending: true} : {})};
    }
    if (path === '/extension/archive/next') result = {archive: options.archive ? {nonce: 'b'.repeat(32), url: 'https://chatgpt.com/c/old', expires_at: clock + 120000} : null};
    if (path === '/extension/result' && options.resultAckFalse) result = {ok: false};
    if (path === '/extension/observe' && options.observeAckFalse) result = {ok: false};
    return {ok: true, text: async () => JSON.stringify(result)};
  };
  const browser = {
    runtime: {getURL: (name:string) => 'chrome-extension://'+'a'.repeat(32)+'/'+name},
    storage: {local: {
      get: async () => ({apiURL: 'http://127.0.0.1:4319', key: 'e'.repeat(43), pairingVersion: 1, pairing: {id: 'p'.repeat(32), state: 'approved', apiURL: 'http://127.0.0.1:4319', checked_at: Date.now()}}),
      ...(options.noDiagnosticStorage ? {} : {set: async (values: any) => {
        if (options.rejectDiagnosticStorage) throw Error('storage rejected');
        if (Object.hasOwn(values, 'crossfeedWakeDiagnostic')) events.push({wakeStorage: values.crossfeedWakeDiagnostic});
      }}),
    }},
    windows: {
      create: async (opts: any) => {
        events.push({windowCreate: opts, create: {url: opts.url, active: true}});
        if (options.windowCreateThrows) throw Error('window creation failed');
        if (options.badWindowOwnership) return {id: 8, type: 'normal', focused: false,
          tabs: [{id: 7, windowId: 99, active: true}]};
        return {id: 8, type: 'normal', focused: Boolean(options.compositorFocused),
          tabs: [{id: 7, windowId: 8, active: true}]};
      },
      remove: async (id: any) => events.push({windowRemove: id}),
    },
    tabs: {
      create: async (opts: any) => {events.push({create: opts}); return {id: 7};},
      group: async (opts: any) => {events.push({group: opts}); return 17;},
      get: async () => {
        const createdURL = events.find(e => e.update)?.update.url ?? events.find(e => e.create)?.create?.url;
        if (options.bootstrapTransition && events.some(e => e.update) && !options.bootstrapTransitionSeen && !sent) {
          options.bootstrapTransitionSeen = true;
          const bootstrap = events.find(e => e.windowCreate)?.windowCreate.url;
          return {id:7,windowId:options.tabWindowId ?? 8,status:'loading',
            url:options.bootstrapTransitionForeign ? bootstrap + '&extra=1' : bootstrap,
            pendingUrl:options.bootstrapPendingForeign ? 'https://evil.example/' : createdURL};
        }
        if (createdURL?.startsWith('chrome-extension://') && !sent) return {id:7,windowId:options.tabWindowId ?? 8,status:'complete',url:options.bootstrapForeign ? 'https://evil.example/' : createdURL,title:options.bootstrapNeverReady ? 'Loading' : 'Crossfeed Wake '+new URL(createdURL).searchParams.get('marker')};
        const createdWake = typeof createdURL === 'string' ? new URL(createdURL) : null;
        const phrase = createdWake?.searchParams.get('q') ?? ordinaryPrompt(value);
        const wake = createdWake?.searchParams.has('q') ? createdURL : 'https://chatgpt.com/?q=' + encodeURIComponent(phrase);
        const promptWake = 'https://chatgpt.com/?prompt=' + encodeURIComponent(phrase);
        const plusWake = (key: string) => 'https://chatgpt.com/?' + new URLSearchParams([[key, phrase]]).toString();
        if (!sent) {
          const n = tabReads++;
          if (options.beforeSendLoading && events.some(e => e.probe)) return {id:7,windowId:options.tabWindowId ?? 8,status:'loading',url:options.preSendNavigation==='q'?createdURL:'https://chatgpt.com/',
            ...(options.beforeSendPending ? {pendingUrl:'https://evil.example/'} : {})};
          if (options.preSendURL) return {id: 7, windowId: options.tabWindowId ?? 8, status: 'complete', url: options.preSendURL};
          if (options.preSendNavigation === 'loading' && n === 0) return {id: 7, windowId: options.tabWindowId ?? 8, status: 'loading', url: 'about:blank', pendingUrl: wake};
          if (options.preSendNavigation === 'loading-undefined' && n === 0) return {id: 7, windowId: options.tabWindowId ?? 8, status: 'loading', url: undefined, pendingUrl: wake};
          if (options.preSendNavigation === 'loading-empty-pending' && n === 0) return {id: 7, windowId: options.tabWindowId ?? 8, status: 'loading', url: '', pendingUrl: wake};
          if (options.preSendNavigation === 'loading-empty-none' && n === 0) return {id: 7, windowId: options.tabWindowId ?? 8, status: 'loading', url: ''};
          if (options.preSendNavigation === 'loading-about-none' && n === 0) return {id: 7, windowId: options.tabWindowId ?? 8, status: 'loading', url: 'about:blank'};
          if (options.preSendNavigation === 'loading-root-pending' && n === 0) return {id: 7, windowId: options.tabWindowId ?? 8, status: 'loading', url: 'https://chatgpt.com/', pendingUrl: wake};
          if (['loading', 'loading-undefined', 'loading-empty-pending', 'loading-empty-none', 'loading-about-none'].includes(options.preSendNavigation)) return {id: 7, windowId: options.tabWindowId ?? 8, status: 'complete', url: wake};
          if (options.preSendNavigation === 'loading-root-pending') return {id: 7, windowId: options.tabWindowId ?? 8, status: 'complete', url: 'https://chatgpt.com/'};
          if (options.preSendNavigation === 'plus-q') return {id: 7, windowId: options.tabWindowId ?? 8, status: 'complete', url: plusWake('q')};
          if (options.preSendNavigation === 'plus-prompt') return {id: 7, windowId: options.tabWindowId ?? 8, status: 'complete', url: plusWake('prompt')};
          if (options.preSendNavigation === 'backward-bound') return {id: 7, windowId: options.tabWindowId ?? 8, status: 'complete', url: n === 0 ? promptWake : wake};
          if (options.preSendNavigation === 'foreign') return {id: 7, windowId: options.tabWindowId ?? 8, status: 'loading', url: 'about:blank', pendingUrl: 'https://evil.example/'};
          if (options.preSendNavigation === 'q') return {id: 7, windowId: options.tabWindowId ?? 8, status: 'complete', url: wake};
          if (options.preSendNavigation === 'extra') return {id: 7, windowId: options.tabWindowId ?? 8, status: 'complete', url: wake + '&x=1'};
          return {id: 7, windowId: options.tabWindowId ?? 8, status: 'complete', url: 'https://chatgpt.com/'};
        }
        if (options.canonicalChanged && events.some(e => e.path === '/extension/check')) return {id: 7, windowId: options.tabWindowId ?? 8, status: 'complete', url: 'https://chatgpt.com/c/unrelated'};
        if (options.registrationNavigation) {
          const n = registrationReads++, temporary = 'https://chatgpt.com/c/local-chatgpt%3A8913b581-eb16-4dd3-ac9e-a1cf513ed722' + (options.registrationNavigation === 'provisional-query' ? '?prompt=other' : '');
          if (n < 2) return {id: 7, windowId: options.tabWindowId ?? 8, status: 'loading', url: 'https://chatgpt.com/', pendingUrl: options.registrationNavigation === 'foreign' ? 'https://evil.example/' : options.registrationNavigation.startsWith?.('provisional') ? temporary : 'https://chatgpt.com/c/new'};
          if (options.registrationNavigation === 'provisional' && n < 5 || options.registrationNavigation === 'provisional-stalled') return {id: 7, windowId: options.tabWindowId ?? 8, status: 'complete', url: temporary};
        }
        return {id: 7, windowId: options.tabWindowId ?? 8, status: 'complete', url: 'https://chatgpt.com/c/new'};
      },
      update: async (id:any, opts:any) => {events.push({update:{id,...opts}});return {id,windowId:8,url:opts.url};},
      remove: async (id: any) => events.push({remove: id}),
    },
    tabGroups: {update: async (id: any, opts: any) => events.push({groupUpdate: {id, ...opts}})},
    debugger: {
      attach: async () => {events.push({attach: true}); if (options.attachError) throw Error('private UI detail');},
      detach: async () => events.push({detach: true}),
      sendCommand: async (_: any, method: string, params: any) => {
        events.push({method, params});
        if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') {
          if (params.x === 1) chat = true;
          if (params.x === 2) row = value.row;
          if (params.x === 4) pendingMention = true;
          if (params.x === 5) { if (options.linger) options.approvedLinger = 3; else options.allow = false; }
          if (params.x === 7) options.menuOpen = true;
          if (params.x === 6) pickerOpen = !pickerOpen;
        }
        if (method === 'Input.dispatchKeyEvent' && params.type === 'keyDown') {
          if (params.key === 'ArrowLeft') position = Math.max(0, position - 1);
          if (params.key === 'ArrowRight') position = Math.min(4, position + 1);
          if (params.key === 'Escape') pickerOpen = false;
          if (params.key === 'Enter') { sent = true; if (options.uncertainEnter) throw Error('lost private reply'); }
        }
      },
    },
    scripting: {executeScript: async (opts: any) => {
      assert(!JSON.stringify(opts.args).includes('e'.repeat(43)));
      if (opts.func === prefillProbe) {
        events.push({probe: {target: opts.target, args: opts.args}});
        const diagnostic = options.probeDiagnostic;
        if (options.probeRefused || options.rateLimited) return [{documentId: 'prefill-document', result: {ready: false, error: options.rateLimited ? 'rate_limited' : options.probeRefused, ...(diagnostic ? {diagnostic} : {})}}];
        const phase = options.probePhase ?? (['q', 'loading', 'loading-undefined', 'loading-empty-pending', 'loading-empty-none', 'loading-about-none', 'plus-q'].includes(options.preSendNavigation) ? 0 :
          ['plus-prompt', 'backward-bound'].includes(options.preSendNavigation) ? 1 : 2);
        return [{documentId: options.probeDocumentMissing ? undefined : 'prefill-document', result: {ready: true, phase, ...(diagnostic ? {diagnostic} : {})}}];
      }
      if (opts.func === prefillModel) {
        events.push({modelProof: {target: opts.target, args: opts.args}});
        return [{documentId: options.postPrefillDocumentChanged ? 'changed-document' : 'prefill-document',
          result: options.postPrefillModelMismatch ? {verified: false, error: 'level_unconfirmed'} :
            {verified: true, row: value.row, level: value.level, maximum: opts.args[1]}}];
      }
      if (opts.func === prefillWake) {
        events.push({prefill: {target: opts.target, args: opts.args}});
        if (options.prefillRefused) return [{documentId: 'prefill-document', result: {sent: false, error: options.prefillRefused}}];
        sent = true;
        if (options.lostExecutionReply || options.uncertainEnter) throw Error('lost execution reply');
        const createdURL = events.find(e => e.update)?.update.url ?? events.find(e => e.create)?.create?.url;
        return [{documentId: options.preSendDocumentChanged ? 'replacement-document' : 'prefill-document', result: {sent: true, url: typeof createdURL === 'string' ? createdURL : undefined}}];
      }
      if (opts.func === pagePermission) {
        const choice = opts.args[1]; events.push({permission: choice, target: opts.target});
        if (options.ambiguousPermission) return [{documentId: 'registration-document', result: false}];
        if (choice === 'options') options.menuOpen = true;
        else if (options.linger) options.approvedLinger = 3;
        else options.allow = false;
        return [{documentId: 'registration-document', result: true}];
      }
      assert.equal(opts.func, pageWake);
      const action = opts.args[1]; events.push({action, target: opts.target});
      let result = {};
      if (action === 'ready') result = {ready: true, chat, empty: !options.occupied, chatPoint: point(1)};
      if (['modelFocus', 'sliderFocus', 'editorFocus'].includes(action)) result = {focused: true, ...(action === 'modelFocus' ? {modelPoint: point(6)} : {})};
      if (action === 'picker') {
        const names = ['Instant', 'Medium', 'High', 'Extra High', 'Pro'];
        result = {open: pickerOpen, row, rowPoint: options.hidden && !events.some(e => e.params?.x === 3 && e.params.type === 'mouseReleased') ? null : point(2), viewPoint: point(3), minimum: '0', maximum: options.badSlider ? '5' : '4', position, status: `${names[position]}, ${position + 1} of 5.`};
      }
      if (action === 'mention') result = {mentionPoint: options.unresolved ? null : point(4)};
      if (action === 'resolved') result = {resolved: pendingMention, focused: pendingMention};
      if (action === 'send') result = {ready: true};
      if (action === 'registration' && options.approvedLinger > 0 && --options.approvedLinger === 0) options.allow = false;
      if (action === 'registration' && sent && options.ambiguousPermission) throw Error('permission_unconfirmed');
      if (action === 'registration') result = {url: sent ? 'https://chatgpt.com/c/new' : 'https://chatgpt.com/', allowPoint: options.allow && (!options.dropdown || options.menuOpen) ? point(5) : null, ...(options.allow ? {allowOption: options.dropdown ? `Allow ${value.connector} for this conversation` : 'Always allow', permissionPending: true, ...(options.dropdown && !options.menuOpen ? {optionsPoint: point(7)} : {})} : {})};
      const registrationDocument = action === 'registration' && sent ? (++registrationScripts > 1 && options.registrationDocumentChanged ? 'different-document' : 'registration-document') : 'new-document';
      return [{documentId: registrationDocument, result}];
    }},
  };
  return {events, browser, fetcher, now: () => clock, pause: async (ms: number) => { clock += ms; }};
}
const run = (f: any) => makePoller(f.browser as unknown as PollBrowser, f.fetcher, f.now, f.pause)();
const enterCount = (f: any) => f.events.filter((e: any) => e.params?.key === 'Enter' && e.params.type === 'keyDown').length;
const prefillCount = (f: any) => f.events.filter((e: any) => e.prefill).length;
const probeCount = (f: any) => f.events.filter((e: any) => e.probe).length;

test('background tabs use a collapsed blue Crossfeed group; native wake windows are never grouped (grouping raised Chrome)', async () => {
  const native = workerFixture({ticket: {title: 'review · Task Manager'}}); await run(native);
  assert.equal(native.events.some((e: any) => e.group || e.groupUpdate), false);

  const titled = workerFixture({wakeMode: 'configured', ticket: {title: 'review · Task Manager'}}); await run(titled);
  assert.deepEqual(titled.events.find((e: any) => e.group).group, {tabIds: [7]});
  assert.deepEqual(titled.events.find((e: any) => e.groupUpdate).groupUpdate,
    {id: 17, title: 'Crossfeed · review · Task Manager', color: 'blue', collapsed: true});
  assert.equal(titled.events.some((e: any) => e.remove === 7), true);

  const fallback = workerFixture({wakeMode: 'configured'}); await run(fallback);
  assert.deepEqual(fallback.events.find((e: any) => e.groupUpdate).groupUpdate,
    {id: 17, title: 'Crossfeed · research', color: 'blue', collapsed: true});
  assert.equal(fallback.events.some((e: any) => e.remove === 7), true);
});

for (const wakeMode of [undefined, 'configured']) {
  test(`configured picker wake stays authoritative with mode ${wakeMode ?? 'absent'}`, async () => {
    const f = workerFixture({wakeMode, allow: true}); await run(f);
    assert.equal(prefillCount(f), 1);
    assert.deepEqual(f.events.find((e: any) => e.create).create, {url: 'https://chatgpt.com/', active: false});
    const observation = f.events.find((e: any) => e.path === '/extension/observe');
    assert.deepEqual(observation?.body?.picker_receipt, {row: 'GPT-6', level: 3});
    assert.equal(enterCount(f), 0);
    const proof = f.events.find((e: any) => e.modelProof);
    assert.deepEqual(proof?.modelProof.target.documentIds, ['prefill-document']);
    assert(f.events.indexOf(observation) < f.events.findIndex((e: any) => e.detach));
    assert(f.events.findIndex((e: any) => e.detach) < f.events.findIndex((e: any) => e.update));
    assert(f.events.indexOf(proof) < f.events.findIndex((e: any) => e.prefill));
    assert(!f.events.some((e: any) => e.method === 'Input.insertText'));
    assert.equal(f.events.find((e: any) => e.path === '/extension/result')?.body?.ok, true);
  });
}

test('configured ordinary wake tolerates a restored root draft without typing or clearing it', async () => {
  const f = workerFixture({wakeMode: 'configured', occupied: true}); await run(f);
  assert.equal(f.events.find(e => e.path === '/extension/result')?.body?.ok, true);
  assert.equal(prefillCount(f), 1);
  assert.equal(enterCount(f), 0);
  assert(!f.events.some(e => e.method === 'Input.insertText' || e.action === 'editorFocus' || e.action === 'discardOwnDraft'));
  const navigation = f.events.find(e => e.update)?.update;
  assert.equal(new URL(navigation.url).searchParams.get('q'), ordinaryPrompt({...ticket(), wake_mode: 'configured' as any}));
});

test('configured prefill refuses changed model or document before its single send', async () => {
  for (const options of [{postPrefillModelMismatch: true}, {postPrefillDocumentChanged: true}]) {
    const f = workerFixture({wakeMode: 'configured', occupied: true, ...options}); await run(f);
    assert.equal(prefillCount(f), 0);
    assert.equal(enterCount(f), 0);
    assert(!f.events.some(e => e.method === 'Input.insertText'));
    assert.equal(f.events.find(e => e.path === '/extension/result')?.body?.ok, false);
  }
});

test('configured prefill seals uncertain execution, closes its owned tab and never resends', async () => {
  const f = workerFixture({wakeMode: 'configured', occupied: true, lostExecutionReply: true}); await run(f);
  assert.equal(prefillCount(f), 1);
  assert.equal(enterCount(f), 0);
  assert.equal(f.events.filter(e => e.remove === 7).length, 1);
  assert(!f.events.some(e => e.action === 'discardOwnDraft'));
  assert.equal(f.events.find(e => e.path === '/extension/result')?.body?.ok, false);
});

test('unknown wake modes are refused before tab creation', async () => {
  for (const wakeMode of ['automatic', '', null, 1]) {
    assert.equal(validTicket({...ticket(), wake_mode: wakeMode}), false);
    const f = workerFixture({wakeMode}); await run(f);
    assert.equal(f.events.some((e: any) => e.create), false);
  }
});

test('configured wake refuses to send without the host acknowledging the picker observation', async () => {
  const f = workerFixture({wakeMode: 'configured', observeAckFalse: true}); await run(f);
  assert.equal(prefillCount(f), 0);
  assert.equal(enterCount(f), 0);
  assert.equal(f.events.some((e: any) => e.path === '/extension/observe'), true);
  assert.equal(f.events.find((e: any) => e.path === '/extension/result')?.body?.error, 'claim_refused');
});
const wakeMarker = 'CFWAKE_DIAG_V1';
const wakeMarkerValues = (f: any) => f.events.map((e: any) => e.wakeStorage).filter((value: any) => typeof value === 'string' && value.startsWith(wakeMarker));
const wakeDiagnostic = (f: any) => {
  const values = wakeMarkerValues(f); assert.equal(values.length, 1);
  return {raw: values[0], value: JSON.parse(values[0].slice(wakeMarker.length))};
};

test('ordinary wake uses exact native prefill, one page send attempt and no debugger or picker input', async () => {
  const f = workerFixture({allow: true}); await run(f);
  const command = ordinaryPrompt(ticket());
  const expected = 'https://chatgpt.com/?q=' + encodeURIComponent(command);
  const created = f.events.find(e => e.create).create;
  assert.deepEqual(created, {url: expected, active: true});
  assert.equal(new URL(created.url).searchParams.get('q'), command);
  assert.equal(command.includes('\n'), false);
  assert(command.includes('worker_label="research" exactly as issued, wake_nonce="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", maximum_wait_seconds=20'));
  assert(command.includes('server-returned worker_label'));
  assert(command.includes('repeat wake_nonce="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" on all subsequent gateway_exchange calls'));
  assert(command.includes('Poll until state=released and continue=false'));
  assert(command.includes('do not send a final chat reply between jobs'));
  assert(command.includes('structured tool_calls through gateway_exchange'));
  assert(command.includes('do not execute them natively'));
  assert(f.events.findIndex(e => e.path === '/extension/claim') < f.events.findIndex(e => e.create));
  assert.equal(f.events.filter(e => e.create).length, 1);
  assert.equal(probeCount(f), 1); assert.equal(prefillCount(f), 1);
  assert.equal(f.events.find(e => e.prefill).prefill.args[0].label, 'research');
  assert.deepEqual(f.events.find(e => e.prefill).prefill.target.documentIds, ['prefill-document']);
  assert.equal(f.events.some(e => e.attach || e.detach || e.method), false);
  assert.equal(enterCount(f), 0);
  assert.equal(f.events.some(e => e.path === '/extension/observe'), false);
  assert.deepEqual(f.events.filter(e => e.permission).map(e => e.permission), ['Always allow']);
  assert.deepEqual(f.events.find(e => e.path === '/extension/result').body,
    {nonce: 'a'.repeat(32), ok: true, url: 'https://chatgpt.com/c/new', permissions: [{connector: 'Crossfeed Chat', option: 'Always allow'}]});
  assert.deepEqual(f.events.at(-1), {remove: 7});
  assert(f.events.findIndex(e => e.path === '/extension/claim') < f.events.findIndex(e => e.create));
  const registrations = f.events.filter(e => e.action === 'registration');
  assert.equal(registrations[0].target.documentIds, undefined);
  assert(registrations.slice(1).every(e => e.target.documentIds?.[0] === 'registration-document'));
  assert(f.events.filter(e => e.permission).every(e => e.target.documentIds?.[0] === 'registration-document'));
});

test('ordinary wake waits through only its own initial loading shell before acquiring authority', async () => {
  for (const preSendNavigation of ['loading', 'loading-undefined', 'loading-empty-pending', 'loading-empty-none', 'loading-about-none', 'loading-root-pending']) {
    const f = workerFixture({preSendNavigation}); await run(f);
    assert.equal(probeCount(f), 1, preSendNavigation); assert.equal(prefillCount(f), 1, preSendNavigation);
    assert.deepEqual(f.events.at(-1), {remove: 7}, preSendNavigation);
  }
  for (const preSendNavigation of ['foreign', 'extra']) {
    const f = workerFixture({preSendNavigation}); await run(f);
    assert.equal(probeCount(f), 0); assert.equal(prefillCount(f), 0);
    assert.equal(f.events.find(e => e.path === '/extension/result').body.error, 'page_changed');
    assert.deepEqual(f.events.at(-1), {remove: 7});
  }
});

test('ordinary native URL parsing accepts equivalent query encoding but rejects hostile structure', async () => {
  for (const preSendNavigation of ['plus-q', 'plus-prompt']) {
    const f = workerFixture({preSendNavigation}); await run(f);
    assert.equal(probeCount(f), 1, preSendNavigation); assert.equal(prefillCount(f), 1, preSendNavigation);
    assert.deepEqual(f.events.at(-1), {remove: 7}, preSendNavigation);
  }
  const phrase = ordinaryPrompt(ticket()), encoded = encodeURIComponent(phrase);
  for (const preSendURL of [
    `https://chatgpt.com/?q=${encoded}&x=1`,
    `https://chatgpt.com/?q=${encoded}&q=${encoded}`,
    `https://chatgpt.com/?q=${encoded}#`,
    `https://user@chatgpt.com/?q=${encoded}`,
    `https://chatgpt.com:443/?q=${encoded}`,
    `https://evil.example/?q=${encoded}`,
    'https://chatgpt.com/?',
  ]) {
    const f = workerFixture({preSendURL}); await run(f);
    assert.equal(probeCount(f), 0, preSendURL); assert.equal(prefillCount(f), 0, preSendURL);
    assert.equal(f.events.find(e => e.path === '/extension/result').body.error, 'page_changed', preSendURL);
  }
});

test('ordinary backward native phase after the readonly probe is refused before send', async () => {
  const f = workerFixture({preSendNavigation: 'backward-bound'}); await run(f);
  assert.equal(probeCount(f), 1); assert.equal(prefillCount(f), 0);
  const result = f.events.find(e => e.path === '/extension/result').body;
  assert.equal(result.ok, false); assert.equal(result.error, 'page_changed'); assert.equal(result.stage, 'loading');
  assert.equal(wakeDiagnostic(f).value.checkpoint, 'before_send');
  assert.deepEqual(f.events.at(-1), {remove: 7});
});

test('ordinary tab-wait diagnostics store only safe classes and never raw URL values or wake identifiers', async () => {
  const secret = 'never-store-this-value';
  const rawURL = `https://user:pass@chatgpt.com/?q=${encodeURIComponent(secret)}&nonce=${secret}&token=${secret}`;
  const f = workerFixture({preSendURL: rawURL}); await run(f);
  const {raw, value} = wakeDiagnostic(f);
  assert.equal(value.revision, 'revision1'); assert.equal(Number.isSafeInteger(value.timestamp), true);
  assert.equal(value.checkpoint, 'tab_wait'); assert.equal(value.failure_code, 'page_changed'); assert.equal(value.status, 'complete');
  assert.equal(value.current.uri_class, 'other'); assert.equal(value.current.parsed_phase, -1);
  assert.deepEqual(value.current.query_names, ['q', 'other', 'other']); assert.equal(value.current.query_count, 3);
  assert.equal(value.current.q_matches, false); assert.equal(value.hasPending, false);
  for (const forbidden of [secret, rawURL, 'user:pass', ordinaryPrompt(ticket()), 'Crossfeed Chat', 'research', 'a'.repeat(32), 'e'.repeat(43), 'prefill-document']) {
    assert.equal(raw.includes(forbidden), false, forbidden);
  }
  assert.equal(f.events.find(e => e.path === '/extension/result').body.error, 'page_changed');
  assert.deepEqual(f.events.at(-1), {remove: 7});
});

test('probe diagnostics are independently allowlisted and distinguish result from binding refusal', async () => {
  const hidden = 'raw-probe-secret';
  const probeDiagnostic = {uri_class: 'conversation', parsed_phase: 2, query_count: 99,
    query_names: ['q', 'credential', 'utm_campaign'], q_matches: true, prompt_matches: false,
    rawurl: `https://evil.example/?token=${hidden}`, documentId: 'should-not-copy'};
  const refused = workerFixture({preSendNavigation: 'q', probeRefused: 'page_changed', probeDiagnostic}); await run(refused);
  const first = wakeDiagnostic(refused);
  assert.equal(first.value.checkpoint, 'probe_result');
  assert.deepEqual(first.value.probe, {executed: true, ready: false, phase: -1, documentIdPresent: true});
  assert.deepEqual(first.value.probe_location, {uri_class: 'conversation', parsed_phase: 2, query_count: 8,
    query_names: ['q', 'other', 'utm_campaign'], q_matches: true, prompt_matches: false});
  assert.equal(first.raw.includes(hidden), false); assert.equal(first.raw.includes('should-not-copy'), false); assert.equal(first.raw.includes('rawurl'), false);

  const binding = workerFixture({preSendNavigation: 'plus-prompt', probePhase: 0}); await run(binding);
  const second = wakeDiagnostic(binding).value;
  assert.equal(second.checkpoint, 'probe_binding'); assert.equal(second.failure_code, 'page_changed');
  assert.deepEqual(second.probe, {executed: true, ready: true, phase: 0, documentIdPresent: true});
  assert.equal(second.current.uri_class, 'native_prompt'); assert.equal(prefillCount(binding), 0);
});

test('diagnostic storage is best-effort and never changes failure reporting or owned cleanup', async () => {
  for (const options of [{preSendNavigation: 'foreign', noDiagnosticStorage: true}, {preSendNavigation: 'foreign', rejectDiagnosticStorage: true}]) {
    const f = workerFixture(options); await run(f);
    assert.equal(wakeMarkerValues(f).length, 0);
    const result = f.events.find(e => e.path === '/extension/result').body;
    assert.equal(result.ok, false); assert.equal(result.error, 'page_changed'); assert.equal(result.stage, 'loading');
    assert.deepEqual(f.events.at(-1), {remove: 7});
  }
});

test('diagnostics are absent for success, composer failures, and failures after the send seal', async () => {
  const success = workerFixture(); await run(success); assert.equal(wakeMarkerValues(success).length, 0);
  const composer = workerFixture({composer: true, attachError: true}); await run(composer); assert.equal(wakeMarkerValues(composer).length, 0);
  const afterSeal = workerFixture({prefillRefused: 'page_changed'}); await run(afterSeal); assert.equal(wakeMarkerValues(afterSeal).length, 0);
});

test('pre-send document replacement cannot transfer one-shot send authority and closes its owned window', async () => {
  const f = workerFixture({preSendDocumentChanged: true}); await run(f);
  assert.equal(probeCount(f), 1); assert.equal(prefillCount(f), 1);
  assert.equal(f.events.find(e => e.path === '/extension/result').body.error, 'page_changed');
  assert.equal(f.events.some(e => e.remove === 7), true);
});

test('attested ready prefill can send while unrelated resources leave Chrome tab loading', async () => {
  for (const preSendNavigation of ['q',undefined]) {
    const f=workerFixture({beforeSendLoading:true,preSendNavigation});await run(f);
    assert.equal(probeCount(f),1);assert.equal(prefillCount(f),1);
    assert.equal(f.events.find(e=>e.path==='/extension/result').body.ok,true);
  }
  const pending=workerFixture({beforeSendLoading:true,beforeSendPending:true});await run(pending);
  assert.equal(prefillCount(pending),0);
  assert.equal(pending.events.find(e=>e.path==='/extension/result').body.error,'page_changed');
});

test('an ok-false post-send result acknowledgment closes the owned tab and never resends', async () => {
  const f = workerFixture({resultAckFalse: true}), poll = makePoller(f.browser as unknown as PollBrowser, f.fetcher, f.now, f.pause);
  await poll(); await poll();
  assert.equal(prefillCount(f), 1);
  assert.equal(f.events.filter(e => e.path === '/extension/result')[0].body.ok, true);
  assert.equal(f.events.some(e => e.remove === 7), true);
});

test('ordinary wake ignores saved picker row and level while preserving the exact scoped alias', async () => {
  for (let level = 0; level < 5; level++) {
    const f = workerFixture({row: 'Anything'});
    const fetcher = async (...args: any[]) => {
      const response = await f.fetcher(...args as [any, any]); const data = JSON.parse(await response.text());
      if (data.ticket) { data.ticket.level = level; data.ticket.label = 'scope_' + level + '_ABCDEFGHIJKLMNOPQRSTUV'; }
      return {...response, text: async () => JSON.stringify(data)};
    };
    await makePoller(f.browser as unknown as PollBrowser, fetcher, f.now, f.pause)();
    assert.equal(prefillCount(f), 1);
    const scoped = f.events.find(e => e.prefill).prefill.args[0].label;
    assert.equal(scoped, 'scope_' + level + '_ABCDEFGHIJKLMNOPQRSTUV');
    assert.equal(f.events.some(e => e.action === 'picker' || e.path === '/extension/observe' || e.method), false);
  }
});

test('ordinary post-send waits through the owned provisional route and binds a fresh registration document', async () => {
  const f = workerFixture({registrationNavigation: 'provisional'}), start = f.now(); await run(f);
  assert.equal(prefillCount(f), 1);
  assert.deepEqual(f.events.find(e => e.path === '/extension/result').body, {nonce: 'a'.repeat(32), ok: true, url: 'https://chatgpt.com/c/new'});
  assert(f.now() - start >= 1000);
  const registrations = f.events.filter(e => e.action === 'registration');
  assert.equal(registrations.length, 1); assert.equal(registrations[0].target.documentIds, undefined);
  assert.notEqual(f.events.find(e => e.prefill).prefill.target.documentIds?.[0], 'registration-document');
});

test('ordinary post-send refuses foreign or noncanonical pending navigation without a second send', async () => {
  for (const registrationNavigation of ['foreign', 'provisional-query']) {
    const f = workerFixture({registrationNavigation}); await run(f);
    assert.equal(prefillCount(f), 1);
    const result = f.events.find(e => e.path === '/extension/result').body;
    assert.equal(result.ok, false); assert.equal(result.error, 'page_changed');
    assert.equal(f.events.some(e => e.remove === 7), true);
  }
});

test('a provisional conversation that never saves expires without resend and closes its owned tab', async () => {
  const f = workerFixture({registrationNavigation: 'provisional-stalled'}); await run(f);
  assert.equal(prefillCount(f), 1);
  const result = f.events.find(e => e.path === '/extension/result').body;
  assert.equal(result.ok, false); assert.equal(result.error, 'expired'); assert.equal(result.stage, 'registration');
  assert.equal(result.url, undefined);
  assert.equal(f.events.some(e => e.remove === 7), true);
});

test('concurrent alarms open one fresh tab and authorize one ordinary page send attempt', async () => {
  const f = workerFixture(), poll = makePoller(f.browser as unknown as PollBrowser, f.fetcher, f.now, f.pause);
  await Promise.all([poll(), poll(), poll()]);
  assert.equal(f.events.filter(e => e.create).length, 1); assert.equal(prefillCount(f), 1);
});

test('claim denial and expiry do not invoke the ordinary page sender', async () => {
  for (const opts of [{claimDenied: true}, {expired: true}]) {
    const f = workerFixture(opts); await run(f); assert.equal(prefillCount(f), 0);
    assert.equal(f.events.find(e => e.path === '/extension/result').body.ok, false);
  }
});

test('safe ordinary prefill refusal reports failure and closes only the owned unsent tab', async () => {
  for (const error of ['composer_not_empty', 'send_unconfirmed', 'page_changed']) {
    const f = workerFixture({prefillRefused: error}); await run(f);
    assert.equal(prefillCount(f), 1);
    const result = f.events.find(e => e.path === '/extension/result').body;
    assert.equal(result.ok, false); assert.equal(result.error, error);
    assert.deepEqual(f.events.at(-1), {remove: 7});
  }
});

test('rate-limit evidence is reported by the non-sending probe and the owned unsent tab is closed', async () => {
  const f = workerFixture({rateLimited: true}); await run(f);
  assert.equal(f.events.find(e => e.path === '/extension/result').body.error, 'rate_limited');
  assert.equal(probeCount(f), 1); assert.equal(prefillCount(f), 0); assert.deepEqual(f.events.at(-1), {remove: 7});
});

test('lost ordinary execution reply is never repeated and closes the owned window', async () => {
  const f = workerFixture({lostExecutionReply: true}); const poll = makePoller(f.browser as unknown as PollBrowser, f.fetcher, f.now, f.pause);
  await poll(); await poll(); assert.equal(prefillCount(f), 1);
  const result = f.events.find(e => e.path === '/extension/result').body;
  assert.equal(result.ok, false); assert.equal(result.error, 'browser_error'); assert.equal(result.url, undefined);
  assert.equal(f.events.some(e => e.remove === 7), true);
});

test('uncertain configured send recovers only its nonce-owned canonical chat and never resends', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  for (const variant of ['owned', 'owned-chip', 'other-nonce', 'other-label', 'foreign-text', 'moved-window', 'pending', 'navigated-during-read']) {
    const f = workerFixture({wakeMode: 'configured', lostExecutionReply: true});
    const get = f.browser.tabs.get;
    let navigated = false;
    f.browser.tabs.get = async () => {
      const tab = await get();
      if (f.events.some(e => e.prefill)) {
        if (variant === 'moved-window') tab.windowId = 99;
        if (variant === 'pending') Object.assign(tab, {pendingUrl: 'https://chatgpt.com/c/unrelated'});
        if (navigated) tab.url = 'https://chatgpt.com/c/unrelated';
      }
      return tab;
    };
    globalThis.fetch = async input => {
      const url = String(input);
      if (url === 'https://chatgpt.com/api/auth/session') return new Response(JSON.stringify({accessToken: 'synthetic-token'}));
      assert.equal(url, 'https://chatgpt.com/backend-api/conversation/new');
      if (variant === 'navigated-during-read') navigated = true;
      let content = ordinaryPrompt({...ticket(), ...(variant === 'other-nonce' ? {nonce: 'z'.repeat(32)} : {}), ...(variant === 'other-label' ? {label:'another-worker'} : {})});
      if (variant === 'owned-chip') content = content.replace('@Crossfeed Chat', '[$crossfeed](app://asdk_app_fixture)');
      if (variant === 'foreign-text') content = content.replace('@Crossfeed Chat', 'Personal draft');
      return new Response(JSON.stringify({current_node: 'u', mapping: {u: {message: {author: {role: 'user'}, content: {parts: [content]}}}}}));
    };
    const poll = makePoller(f.browser as unknown as PollBrowser, f.fetcher, f.now, f.pause);
    await poll(); await poll();
    const result = f.events.find(e => e.path === '/extension/result').body;
    assert.equal(result.ok, false, variant);
    assert.equal(result.error, 'browser_error', variant);
    assert.equal(result.url, variant.startsWith('owned') ? 'https://chatgpt.com/c/new' : undefined, variant);
    assert.equal(prefillCount(f), 1, variant);
  }
});

test('sent ordinary wake without exact gateway contact expires and closes its tab', async () => {
  const f = workerFixture({noContact: true}); await run(f);
  assert.equal(prefillCount(f), 1); assert.equal(f.events.find(e => e.path === '/extension/result').body.ok, false);
  assert.equal(f.events.some(e => e.remove === 7), true);
});

test('a later post-send registration document replacement fails without another send', async () => {
  const f = workerFixture({noContact: true, registrationDocumentChanged: true}); await run(f);
  assert.equal(prefillCount(f), 1);
  assert.equal(f.events.find(e => e.path === '/extension/result').body.error, 'page_changed');
  assert.equal(f.events.some(e => e.remove === 7), true);
});

test('ordinary canonical URL changes are refused and cannot authorize an unrelated archive', async () => {
  const f = workerFixture({noContact: true, canonicalChanged: true}); await run(f);
  const result = f.events.find(e => e.path === '/extension/result').body;
  assert.equal(prefillCount(f), 1);
  assert.equal(result.ok, false); assert.equal(result.error, 'page_changed'); assert.equal(result.url, undefined);
  assert.equal(f.events.some(e => e.remove === 7), true);
});

test('archive poll uses the service-worker session and acknowledges without opening a tab', async () => {
  for (const archiveFailure of [false, true]) {
    const f = workerFixture({archive: true}), calls: any[] = [];
    await inPage({}, async () => {
      globals.fetch = async (url: string, init: any) => {
        calls.push({url, init});
        if (url.endsWith('/api/auth/session')) return {ok: true, json: async () => ({accessToken: 'worker-only-token'})};
        return {ok: !archiveFailure};
      };
      await run(f);
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'https://chatgpt.com/api/auth/session');
    assert.equal(calls[1].url, 'https://chatgpt.com/backend-api/conversation/old');
    assert.equal(f.events.find(e => e.path === '/extension/archive/result').body.ok, !archiveFailure);
    assert.equal(f.events.some(e => e.create || e.group || e.archive), false);
    assert.equal(enterCount(f), 0);
  }
});

test('network helper refuses unknown endpoints before fetch', async () => {
  let called = false;
  await assert.rejects(request({apiURL: 'http://127.0.0.1:4319', key: 'key'}, '/v1/chat/completions', {}, (async () => { called = true; }) as unknown as Fetcher), /invalid_config/);
  assert.equal(called, false);
});

const composerSelector = 'form #prompt-textarea[contenteditable="true"], form [contenteditable="true"][role="textbox"]';
function domFixture({limited = false, sidebar = false, mode = 'Chat', occupied = false, modern = false} = {}) {
  const element = (content = '', attrs: Record<string, any> = {}): any => ({textContent: content, isConnected: true, getClientRects: () => [1],
    getBoundingClientRect: () => ({x: 1, y: 1, width: 4, height: 4}), closest: () => null,
    getAttribute: (k: any) => attrs[k] ?? null, querySelectorAll: () => [], focus() { globals.document.activeElement = this; }});
  const parent = element(), chat = element('Chat', {'aria-selected': String(mode === 'Chat')}), work = element('Work', {'aria-selected': String(mode === 'Work')});
  chat.parentElement = work.parentElement = parent;
  const editor = element(occupied ? 'my draft' : ''); editor.isContentEditable = true;
  const model = element(), alert = element('You have reached your rate limit');
  alert.closest = () => sidebar ? {} : null;
  const doc: any = {activeElement: null, querySelectorAll: (selector: string) => selector === composerSelector || selector === '#prompt-textarea' && !modern ? [editor] : selector.includes('model-switcher') ? [model] : selector === 'button, [role="tab"]' ? [chat, work] : selector.includes('[role="alert"]') && limited ? [alert] : []};
  return {doc, editor};
}
async function inPage(doc: any, callback: any) {
  const keys = ['document', 'location', 'fetch'], originals = keys.map(k => Object.getOwnPropertyDescriptor(globalThis, k));
  globals.document = doc; globals.location = {href: 'https://chatgpt.com/', origin: 'https://chatgpt.com'};
  try { return await callback(); } finally { keys.forEach((k, i) => { if (originals[i]) Object.defineProperty(globalThis, k, originals[i]); else delete globals[k]; }); }
}

function draftWorkerFixture(options: Record<string, any> = {}) {
  // Only composer delivery still types. Ordinary configured wakes use prefill.
  const f = workerFixture({wakeMode: 'configured', composer: true, ...options}), dom = domFixture({occupied: options.occupied});
  let selected: any;
  dom.doc.createRange = () => ({node: undefined, selectNodeContents(node: any) { this.node = node; }});
  dom.doc.getSelection = () => ({removeAllRanges() { selected = undefined; }, addRange(range: any) { selected = range.node; }});
  dom.doc.execCommand = (command: string) => {
    assert.equal(command, 'delete'); assert.equal(selected, dom.editor);
    assert.equal(dom.doc.activeElement, dom.editor);
    f.events.push({deleteDraft: true}); dom.editor.textContent = ''; return true;
  };
  const execute = f.browser.scripting.executeScript, dispatch = f.browser.debugger.sendCommand;
  f.browser.debugger.sendCommand = async (...args) => {
    await dispatch(...args);
    if (args[1] === 'Input.insertText') dom.editor.textContent += args[2].text;
    if (args[1] === 'DOM.getDocument') return {root: {nodeId: 1}} as any;
    if (args[1] === 'DOM.querySelector') return {nodeId: 2} as any;
  };
  f.browser.scripting.executeScript = async opts => {
    const result = await execute(opts), action = opts.args[1];
    if (action === 'uploadInput') result[0].result = {ready: true, uploadSelector: 'form input[type="file"][aria-label="Attach files"]'};
    if (action === 'uploads') result[0].result = {ready: true};
    if (action === 'ready' || action === 'discardOwnDraft' || action === 'discardBareMention') {
      // Exercise real page cleanup with an expired ticket, rather than letting
      // the fake worker clock hide the page's separate expiry check.
      const value = action !== 'ready' ? {...opts.args[0], expires_at: Date.now() - 1} : opts.args[0];
      result[0].result = await inPage(dom.doc, () => pageWake(value, action));
    }
    return result;
  };
  return {...f, ...dom};
}

test('failed wake discards its typed mention before closing and preserves the expired failure', async () => {
  const f = draftWorkerFixture({unresolved: true}); await run(f);
  assert.deepEqual(f.events.filter(e => e.method === 'Input.insertText').map(e => e.params.text), ['@Crossfeed Chat']);
  assert.deepEqual(f.events.find(e => e.path === '/extension/result').body,
    {nonce: 'a'.repeat(32), ok: false, error: 'expired', stage: 'mention'});
  assert.equal(f.editor.textContent, '');
  const cleanup = f.events.findIndex(e => e.action === 'discardOwnDraft');
  assert(cleanup >= 0); assert(cleanup < f.events.findIndex(e => e.detach));
  assert.deepEqual(f.events[cleanup].target, {tabId: 7, documentIds: ['new-document']});
  assert.equal(f.events.filter(e => e.deleteDraft).length, 1);
  assert.deepEqual(f.events.slice(-2), [{detach: true}, {remove: 7}]);
});

test('a pre-existing foreign draft refuses wake without cleanup or input', async () => {
  const f = draftWorkerFixture({occupied: true}); await run(f);
  assert.equal(f.editor.textContent, 'my draft');
  assert.deepEqual(f.events.find(e => e.path === '/extension/result').body,
    {nonce: 'a'.repeat(32), ok: false, error: 'composer_not_empty', stage: 'ready'});
  assert(!f.events.some(e => e.action === 'discardOwnDraft' || e.deleteDraft || e.method === 'Input.insertText'));
});

test('text inserted before a lost debugger reply is discarded without changing browser_error', async () => {
  const f = draftWorkerFixture(), dispatch = f.browser.debugger.sendCommand;
  f.browser.debugger.sendCommand = async (...args) => {
    await dispatch(...args);
    if (args[1] === 'Input.insertText') throw Error('lost insert reply');
  };
  await run(f);
  assert.equal(f.editor.textContent, '');
  assert.deepEqual(f.events.find(e => e.path === '/extension/result').body,
    {nonce: 'a'.repeat(32), ok: false, error: 'browser_error', stage: 'input'});
  assert.equal(f.events.filter(e => e.deleteDraft).length, 1);
});

test('a bare leftover mention is cleared before the wake and words of the owner are not', async () => {
  const f = draftWorkerFixture(); f.editor.textContent = '@Crossfeed Chat'; await run(f);
  assert.equal(f.events.filter(e => e.deleteDraft).length >= 1, true);
  assert.notEqual(f.events.find(e => e.path === '/extension/result').body.error, 'composer_not_empty');
});

test('a pre-existing connector prefix is also preserved when this run inserted nothing', async () => {
  const f = draftWorkerFixture(); f.editor.textContent = '@Crossfeed Chat my draft'; await run(f);
  assert.equal(f.editor.textContent, '@Crossfeed Chat my draft');
  assert.equal(f.events.find(e => e.path === '/extension/result').body.error, 'composer_not_empty');
  assert(!f.events.some(e => e.action === 'discardOwnDraft' || e.deleteDraft));
});

test('sent wakes never discard a draft even after an uncertain Enter or later failure', async () => {
  for (const options of [{}, {uncertainEnter: true}, {noContact: true}]) {
    const f = draftWorkerFixture(options); await run(f);
    assert.equal(enterCount(f), 1);
    assert.equal(f.editor.textContent, '@Crossfeed Chat process exactly job job_1 as research. Call gateway_exchange with worker_label="research", request_id="job_1" and maximum_wait_seconds=1 to fetch this job only. Use these uploaded attachments with its request, submit its answer with request_id and claim_token, then stop when released.');
    assert(!f.events.some(e => e.action === 'discardOwnDraft' || e.deleteDraft));
    assert.equal(f.events.find(e => e.path === '/extension/result').body.ok, !Object.keys(options).length);
  }
});

test('cleanup preserves replacement foreign text and cannot replace the original failure', async () => {
  for (const fails of [false, true]) {
    const f = draftWorkerFixture({unresolved: true}), execute = f.browser.scripting.executeScript;
    f.browser.scripting.executeScript = async opts => {
      if (opts.args[1] === 'discardOwnDraft') {
        f.editor.textContent = 'my draft';
        if (fails) throw Error('cleanup failed');
      }
      return execute(opts);
    };
    await run(f);
    assert.equal(f.editor.textContent, 'my draft'); assert(!f.events.some(e => e.deleteDraft));
    assert.equal(f.events.find(e => e.path === '/extension/result').body.error, 'expired');
    assert.deepEqual(f.events.slice(-2), [{detach: true}, {remove: 7}]);
  }
});

test('stalled cleanup is bounded and still detaches and removes the tab', {timeout: 5000}, async () => {
  const f = draftWorkerFixture({unresolved: true}), execute = f.browser.scripting.executeScript;
  f.browser.scripting.executeScript = async opts => {
    if (opts.args[1] === 'discardOwnDraft') return new Promise(() => {});
    return execute(opts);
  };
  await run(f);
  assert.equal(f.events.find(e => e.path === '/extension/result').body.error, 'expired');
  assert.deepEqual(f.events.slice(-2), [{detach: true}, {remove: 7}]);
});

test('page discard requires the raw connector prefix even after expiry or a rate limit', async () => {
  const f = draftWorkerFixture(), expired = {...ticket(), expires_at: Date.now() - 1};
  for (const value of ['my draft', 'prefix @Crossfeed Chat', 'Crossfeed Chat wake up as research']) {
    f.editor.textContent = value;
    await inPage(f.doc, () => assert.deepEqual(pageWake(expired, 'discardOwnDraft'), {}));
    assert.equal(f.editor.textContent, value);
  }
  for (const value of ['@Crossfeed Chat', '@Crossfeed Chat wake up as research']) {
    f.editor.textContent = value;
    await inPage(f.doc, () => assert.deepEqual(pageWake(expired, 'discardOwnDraft'), {empty: true}));
    assert.equal(f.editor.textContent, '');
  }
  const query = f.doc.querySelectorAll;
  f.doc.querySelectorAll = (selector: string) => selector.includes('[role="alert"]') ? [{textContent: 'rate limit', closest: () => null, getClientRects: () => [1]}] : query(selector);
  f.editor.textContent = '@Crossfeed Chat';
  await inPage(f.doc, () => assert.deepEqual(pageWake(expired, 'discardOwnDraft'), {empty: true}));
  f.editor.textContent = '@Crossfeed Chat';
  await inPage(f.doc, () => {
    globals.location.href = 'https://chatgpt.com/c/existing';
    assert.throws(() => pageWake(expired, 'discardOwnDraft'), /page_changed/);
  });
  assert.equal(f.editor.textContent, '@Crossfeed Chat');
});

test('page probe reads mode and occupied composer without changing either', async () => {
  for (const mode of ['Chat', 'Work']) {
    const f = domFixture({mode, occupied: true});
    const state = await inPage(f.doc, () => pageWake(ticket(), 'ready'));
    assert.equal(state.chat, mode === 'Chat'); assert.equal(state.empty, false); assert.equal(f.editor.textContent, 'my draft');
  }
});

test('current ChatGPT composer without the legacy ID is ready and can receive focus', async () => {
  const f = domFixture({modern: true});
  f.editor.closest = (selector: string) => selector === 'form' ? {querySelectorAll: () => []} : null;
  await inPage(f.doc, () => {
    assert.equal(pageWake(ticket(), 'ready').ready, true);
    assert.deepEqual(pageWake(ticket(), 'editorFocus'), {focused: true});
  });
});

test('ambiguous composer fields refuse readiness and input', async () => {
  const f = domFixture({modern: true}), query = f.doc.querySelectorAll;
  f.doc.querySelectorAll = (selector: string) => selector === composerSelector ? [f.editor, {...f.editor}] : query(selector);
  await inPage(f.doc, () => {
    assert.equal(pageWake(ticket(), 'ready').ready, false);
    assert.throws(() => pageWake(ticket(), 'editorFocus'), /page_not_ready/);
  });
});

test('only visible rate alerts outside navigation trigger the page rate guard', async () => {
  for (const sidebar of [false, true]) {
    const f = domFixture({limited: true, sidebar});
    const state = await inPage(f.doc, () => pageWake(ticket(), 'ready'));
    assert.equal(!!state.rateLimited, !sidebar);
  }
});

test('page actions refuse changed location and wrong mode', async () => {
  const f = domFixture({mode: 'Work'});
  await inPage(f.doc, () => {
    assert.throws(() => pageWake(ticket(), 'modelFocus'), /mode_unconfirmed/);
    globals.location.href = 'https://chatgpt.com/c/existing';
    assert.throws(() => pageWake(ticket(), 'ready'), /page_changed/);
  });
});

test('service-worker archive and delete requests use the signed-in session and reject non-worker URLs', async () => {
  for (const remove of [false, true]) {
    await inPage({}, async () => {
      const calls: any[] = [];
      globals.fetch = async (url: string, init: any) => {
        calls.push({url, init});
        return url.endsWith('/api/auth/session') ? {ok: true, json: async () => ({accessToken: 'worker-only-token'})} : {ok: true};
      };
      assert.equal(await archiveConversation('https://chatgpt.com/c/old', 15000, remove), true);
      assert.equal(calls[0].url, 'https://chatgpt.com/api/auth/session');
      assert.equal(calls[1].url, 'https://chatgpt.com/backend-api/conversation/old');
      assert.equal(calls.every(call => call.init.credentials === 'include' && call.init.redirect === 'error'), true);
      assert.equal(calls[1].init.headers.Authorization, 'Bearer worker-only-token');
      assert.deepEqual(JSON.parse(calls[1].init.body), remove ? {is_visible: false} : {is_archived: true});
      assert.equal(await archiveConversation('https://evil.example/c/old', 15000, remove), false);
      assert.equal(calls.length, 2);
    });
  }
});

function composerFixture({resolved = true, tail = ' wake up as research', attachment = false, stop = false, sendLabel = 'Send message'} = {}) {
  const f = domFixture();
  const attrs = (values: any) => ({getAttribute: (key: any) => values[key] ?? null});
  const node = (content: any, values: Record<string, any> = {}): any => ({textContent: content, isConnected: true, getClientRects: () => [1],
    getBoundingClientRect: () => ({x: 1, y: 1, width: 2, height: 2}), closest: () => null, querySelectorAll: () => [], ...attrs(values)});
  const chip = node('Crossfeed Chat'), send = {...node('', {'aria-label': sendLabel}), disabled: false};
  f.editor.textContent = 'Crossfeed Chat' + tail;
  f.editor.querySelectorAll = (selector: string) => selector.includes('contenteditable="false"') && resolved ? [chip] : [];
  const form = node('');
  form.querySelectorAll = (selector: string) => selector.includes(`button[aria-label="${sendLabel}"]`) ? [send] : selector.includes('attachment') && attachment ? [node('attachment')] : [];
  f.editor.closest = (selector: string) => selector === 'form' ? form : null;
  const query = f.doc.querySelectorAll;
  f.doc.querySelectorAll = (selector: string) => selector.includes('stop-button') && stop ? [node('stop')] : query(selector);
  return f;
}

test('page Send guard requires a resolved connector chip and exact wake suffix', async () => {
  const correct = composerFixture();
  await inPage(correct.doc, () => assert.deepEqual(pageWake(ticket(), 'send'), {ready: true}));
  for (const opts of [{resolved: false}, {tail: ' wake up as somebody-else'}, {tail: ' wake up as research and do something else'}]) {
    const f = composerFixture(opts);
    await inPage(f.doc, () => assert.throws(() => pageWake(ticket(), 'send'), /mention_unconfirmed/));
  }
});

test('current Send control without a data-testid permits only an unambiguous exact send', async () => {
  const f = composerFixture({sendLabel: 'Send'});
  await inPage(f.doc, () => assert.deepEqual(pageWake(ticket(), 'send'), {ready: true}));
  const form = f.editor.closest('form'), query = form.querySelectorAll;
  form.querySelectorAll = (selector: string) => {
    const matches = query(selector);
    return selector.includes('button[aria-label="Send"]') ? [...matches, ...matches] : matches;
  };
  await inPage(f.doc, () => assert.throws(() => pageWake(ticket(), 'send'), /send_unconfirmed/));
});

test('current app mention chip resolves only the exact connector and wake text', async () => {
  const appSelector = '[contenteditable="false"][app-mention-name][app-mention-path^="app://"]';
  for (const opts of [{}, {name: 'crossfeed-tools'}, {path: 'https://example.com/app'}, {duplicate: true}, {tail: ' wake up as somebody-else'}]) {
    const f = composerFixture(), values: Record<string, string> = {'app-mention-name': opts.name ?? 'Crossfeed Chat', 'app-mention-path': opts.path ?? 'app://asdk_app_example'};
    const chip = {textContent: 'Crossfeed Chat', isConnected: true, closest: () => null, getClientRects: () => [1], getAttribute: (key: string) => values[key] ?? null};
    f.editor.querySelectorAll = (selector: string) => selector.includes(appSelector) && values['app-mention-path'].startsWith('app://') ? opts.duplicate ? [chip, {...chip}] : [chip] : [];
    await inPage(f.doc, () => {
      f.editor.textContent = 'Crossfeed Chat ';
      assert.equal(pageWake(ticket(), 'resolved').resolved, !opts.name && !opts.path && !opts.duplicate);
      f.editor.textContent = 'Crossfeed Chat' + (opts.tail ?? ' wake up as research');
      if (Object.keys(opts).length) assert.throws(() => pageWake(ticket(), 'send'), /mention_unconfirmed/);
      else assert.deepEqual(pageWake(ticket(), 'send'), {ready: true});
    });
  }
});

test('configured poller uses current composer readiness but never inserts a draft', async () => {
  const f = workerFixture({wakeMode: 'configured', row: 'GPT-6', chat: true});
  const dom = composerFixture({sendLabel: 'Send'});
  dom.editor.textContent = '';
  const query = dom.doc.querySelectorAll;
  // Only the current form-owned textbox exists, not #prompt-textarea.
  dom.doc.querySelectorAll = (selector: string) => selector === '#prompt-textarea' ? [] : query(selector);
  const chip = {textContent: 'Crossfeed Chat', isConnected: true, getClientRects: () => [1], closest: () => null,
    getAttribute: (key: string) => ({'app-mention-name': 'Crossfeed Chat', 'app-mention-path': 'app://asdk_app_example'})[key] ?? null};
  let resolved = false;
  dom.editor.querySelectorAll = (selector: string) => resolved && selector.includes('[app-mention-name]') ? [chip] : [];
  const command = f.browser.debugger.sendCommand;
  f.browser.debugger.sendCommand = async (...args) => {
    await command(...args);
    const [, method, params] = args;
    if (method === 'Input.insertText') dom.editor.textContent += params.text;
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased' && params.x === 4) {
      resolved = true; dom.editor.textContent = 'Crossfeed Chat ';
    }
  };
  const execute = f.browser.scripting.executeScript;
  f.browser.scripting.executeScript = async opts => {
    const action = opts.args[1];
    if (!['ready', 'editorFocus', 'resolved', 'send'].includes(action)) return execute(opts);
    return inPage(dom.doc, () => [{documentId: 'new-document', result: pageWake(opts.args[0], action)}]);
  };
  await run(f);
  assert.equal(enterCount(f), 0);
  assert.equal(prefillCount(f), 1);
  assert.equal(dom.editor.textContent, '');
  assert.deepEqual(f.events.find(e => e.path === '/extension/result').body, {nonce: 'a'.repeat(32), ok: true, url: 'https://chatgpt.com/c/new'});
  // The configured path records the chat the moment its URL exists, before the final result.
  const chatAt = f.events.findIndex(e => e.path === '/extension/chat');
  assert(chatAt >= 0 && chatAt < f.events.findIndex(e => e.path === '/extension/result'));
  assert.deepEqual(f.events[chatAt].body, {nonce: 'a'.repeat(32), url: 'https://chatgpt.com/c/new'});
});


test('page Send guard refuses attachments, generation and changed Send controls', async () => {
  for (const opts of [{attachment: true}, {stop: true}, {sendLabel: 'Stop generating'}]) {
    const f = composerFixture(opts);
    await inPage(f.doc, () => assert.throws(() => pageWake(ticket(), 'send'), /composer_not_empty|send_unconfirmed/));
  }
});

test('page picker reads exact selected row, bounds and level status, rejecting missing position', async () => {
  const f = domFixture();
  const attrs = (value: any, values: Record<string, any> = {}): any => ({textContent: value, isConnected: true, closest: () => null, getClientRects: () => [1], getBoundingClientRect: () => ({x: 0, y: 0, width: 2, height: 2}), getAttribute: (key: any) => values[key] ?? null, querySelectorAll: () => []});
  const row = attrs('GPT-6', {'aria-checked': 'true'}), sliderValues: Record<string, string> = {'aria-valuemin': '0', 'aria-valuemax': '4', 'aria-valuenow': '3'}, slider = attrs('', sliderValues), status = attrs('Extra High, 4 of 5.');
  const menu = attrs(''); menu.querySelectorAll = (selector: string) => selector.includes('menuitemradio') ? [row] : selector.includes('slider') ? [slider] : selector.includes('status') ? [status] : [];
  const query = f.doc.querySelectorAll; f.doc.querySelectorAll = (selector: string) => selector === '[role="menu"]' ? [menu] : query(selector);
  await inPage(f.doc, () => {
    const result = pageWake(ticket(), 'picker');
    assert.deepEqual([result.row, result.minimum, result.maximum, result.position, result.status], ['GPT-6', '0', '4', 3, 'Extra High, 4 of 5.']);
    delete sliderValues['aria-valuenow']; assert.equal(pageWake(ticket(), 'picker').position, null);
  });
});

test('connector menu requires a single exact matching option', async () => {
  const f = domFixture(), text = 'Crossfeed Chat';
  const option = {textContent: text, isConnected: true, closest: () => null, getClientRects: () => [1], querySelectorAll: () => [], getBoundingClientRect: () => ({x: 0, y: 0, width: 4, height: 4})};
  let options = [option]; const popup = {...option, querySelectorAll: () => options};
  f.editor.getAttribute = (key: string) => key === 'aria-controls' ? 'mentions' : null;
  f.doc.getElementById = (id: any) => id === 'mentions' ? popup : null;
  await inPage(f.doc, () => {
    assert.deepEqual(pageWake(ticket(), 'mention').mentionPoint, {x: 2, y: 2});
    options = [option, {...option}]; assert.equal(pageWake(ticket(), 'mention').mentionPoint, null);
  });
});

test('picker reads selection but refuses input into inert model tracks with rectangles', async () => {
  const f = domFixture();
  let inert = true;
  const row = {textContent: 'GPT-6', isConnected: true, getClientRects: () => [1],
    getBoundingClientRect: () => ({x: 10, y: 20, width: 4, height: 4}),
    closest: (selector: string) => inert && selector.includes('[inert]') ? {} : null,
    getAttribute: (key: string) => key === 'aria-checked' ? 'true' : null, querySelectorAll: () => []};
  const toggle = {...row, closest: () => null};
  const menu = {...toggle, querySelectorAll: (selector: string) => selector.includes('menuitemradio') ? [row] : []};
  const query = f.doc.querySelectorAll;
  f.doc.querySelectorAll = (selector: string) => selector === '[role="menu"]' ? [menu] : selector.includes('data-model-picker-view-toggle') ? [toggle] : query(selector);
  await inPage(f.doc, () => {
    const hidden = pageWake(ticket(), 'picker');
    assert.equal(hidden.row, 'GPT-6'); assert.equal(hidden.rowPoint, null);
    assert.deepEqual(hidden.viewPoint, {x: 12, y: 22});
    inert = false;
    const shown = pageWake(ticket(), 'picker');
    assert.equal(shown.row, 'GPT-6'); assert.deepEqual(shown.rowPoint, {x: 12, y: 22});
  });
});

test('CSS-hidden rate alerts are not counted as visible rate-limit evidence', async () => {
  const f = domFixture({limited: true});
  const original = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle');
  try {
    globals.getComputedStyle = () => ({visibility: 'hidden'});
    await inPage(f.doc, () => assert.equal(pageWake(ticket(), 'ready').rateLimited, undefined));
  } finally { if (original) Object.defineProperty(globalThis, 'getComputedStyle', original); else delete globals.getComputedStyle; }
});

test('visible Chat controls remain readable while a modal model menu aria-hides background content', async () => {
  const f = domFixture();
  const original = f.doc.querySelectorAll;
  f.doc.querySelectorAll = (selector: string) => original(selector).map((el: any) => ({...el, closest: (query: any) => query.includes('aria-hidden') ? {} : el.closest(query)}));
  await inPage(f.doc, () => {
    const state = pageWake(ticket(), 'ready'); assert.equal(state.ready, true); assert.equal(state.chat, true);
  });
});

test('archive fetch timeout returns failure rather than hanging the service worker', async () => {
  await inPage({}, async () => {
    const calls: any[] = [];
    globals.fetch = async (url: string, init: any) => {
      calls.push(url);
      if (url.endsWith('/api/auth/session')) return {ok: true, json: async () => ({accessToken: 'worker-only-token'})};
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Error('timeout')), {once: true}));
    };
    // Node unrefs AbortSignal.timeout timers; this handle keeps the fake page alive.
    const keepAlive = setTimeout(() => {}, 1000);
    try { assert.equal(await archiveConversation('https://chatgpt.com/c/old', 5), false); }
    finally { clearTimeout(keepAlive); }
    assert.equal(calls.length, 2);
  });
});

test('failed archive retries without opening one tab per chat', async () => {
  const f = workerFixture({archive: true});
  await inPage({}, async () => {
    globals.fetch = async (url: string) => url.endsWith('/api/auth/session') ?
      {ok: true, json: async () => ({accessToken: 'worker-only-token'})} : {ok: false};
    const poll = makePoller(f.browser as unknown as PollBrowser, f.fetcher, f.now, f.pause);
    await poll(); await poll();
  });
  assert.equal(f.events.filter(e => e.path === '/extension/next').length, 2);
  assert.equal(f.events.some(e => e.create || e.group || e.remove || e.archive), false);
  assert(f.events.filter(e => e.path === '/extension/archive/result').every(e => e.body.ok === false));
});

test('request bounds stalled headers and bodies even when fetch ignores abort', async () => {
  const config = {apiURL: 'http://127.0.0.1:4319', key: 'dedicated'};
  const results = await Promise.allSettled([
    request(config, '/extension/next', undefined, () => new Promise(() => {})),
    request(config, '/extension/next', undefined, async () => ({ok: true, text: () => new Promise(() => {})})),
  ]);
  for (const result of results) { assert.equal(result.status, 'rejected'); assert.equal((result as PromiseRejectedResult).reason.message, 'request_timeout'); }
});
test('request refuses redirects/non-success, oversized or malformed responses and aborts after settlement', async () => {
  const config = {apiURL: 'http://127.0.0.1:4319', key: 'dedicated'};
  for (const [raw, ok, expected] of [['{}', false, 'request_refused'], ['x'.repeat(16385), true, 'response_too_large'], ['{bad', true, undefined]] as [string, boolean, string | undefined][]) {
    let signal: AbortSignal | undefined;
    await assert.rejects(request(config, '/extension/next', undefined, async (_, init) => { signal = init.signal ?? undefined; assert.equal(init.redirect, 'error'); return {ok, text: async () => raw}; }), e => !expected || e.message === expected);
    assert.equal(signal!.aborted, true);
  }
});
test('lost claim or post-send acknowledgments never authorize a second ordinary send', async () => {
  for (const path of ['/extension/claim', '/extension/check', '/extension/result']) {
    const f = workerFixture(); let lost = false;
    const fetcher = async (url: any, init: any) => {
      const response = await f.fetcher(url, init);
      if (!lost && new URL(url).pathname === path) { lost = true; throw Error('lost acknowledgment'); }
      return response;
    };
    await makePoller(f.browser as unknown as PollBrowser, fetcher, f.now, f.pause)();
    assert.equal(prefillCount(f), path === '/extension/claim' ? 0 : 1);
    if (path !== '/extension/claim') assert.equal(f.events.some(e => e.remove === 7), true);
    await makePoller(f.browser as unknown as PollBrowser, fetcher, f.now, f.pause)();
    assert.equal(prefillCount(f), path === '/extension/claim' ? 0 : 1);
    assert.equal(f.events.some(e => e.path === '/extension/observe'), false);
  }
});

test('ordinary wake never fabricates a picker observation', async () => {
  const f = workerFixture(); await run(f);
  assert.equal(prefillCount(f), 1);
  assert.equal(f.events.some(e => e.path === '/extension/observe'), false);
  assert.equal(f.events.some(e => e.action === 'picker'), false);
});

test('media wake opens only the exact approval menu and receipts conversation allowance', async () => {
  const f = workerFixture({media: true, dropdown: true}); await run(f);
  assert.equal(prefillCount(f), 1);
  assert.equal(f.events.filter(e => e.path === '/extension/check').length, 2);
  assert.deepEqual(f.events.filter(e => e.permission).map(e => e.permission),
    ['options', 'Allow Crossfeed Chat for this conversation']);
  assert.deepEqual(f.events.find(e => e.path === '/extension/result').body.permissions,
    [{connector: 'Crossfeed Chat', option: 'Allow Crossfeed Chat for this conversation'}]);
});

test('ambiguous permission refuses approval and records a fixed failure identifier', async () => {
  const f = workerFixture({ambiguousPermission: true}); await run(f);
  assert.equal(prefillCount(f), 1);
  assert.equal(f.events.some(e => e.permission), false);
  assert.equal(f.events.find(e => e.path === '/extension/result').body.error, 'permission_unconfirmed');
});

test('media without an approval prompt stays until its initial media job finishes', async () => {
  const f = workerFixture({media: true});
  const execute = f.browser.scripting.executeScript;
  f.browser.scripting.executeScript = async opts => {
    const r = await execute(opts);
    if (opts.func === pageWake && opts.args[1] === 'registration') r[0].result = {url: 'https://chatgpt.com/c/new'};
    return r;
  };
  await run(f);
  assert.equal(f.events.filter(e => e.path === '/extension/check').length, 4);
  assert.equal(f.events.find(e => e.path === '/extension/result').body.ok, true);
});

test('approval card may linger after native trusted click without repeating a settled approval', async () => {
  const f = workerFixture({allow: true, linger: true}); await run(f);
  assert.deepEqual(f.events.filter(e => e.permission).map(e => e.permission), ['Always allow']);
  assert.equal(f.events.find(e => e.path === '/extension/result').body.ok, true);
});
test('v4 native ordinary wake tolerates missing, legacy-object and malformed advisory replies', async () => {
  for (const focusGuardReply of [undefined, false, 'invalid', {}, true,
    {status:'unsupported'}, {status:'armed',marker:'c'.repeat(32)}]) {
    const f = workerFixture({focusGuardReply, compositorFocused:true});
    await run(f);
    const claim = f.events.find((e: any) => e.path === '/extension/claim');
    assert.deepEqual(claim.body, {nonce:'a'.repeat(32),focus_guard:true,focus_guard_version:4});
    const creation = f.events.find((e: any) => e.windowCreate);
    assert.deepEqual(creation.windowCreate, {
      url:focusGuardReply && typeof focusGuardReply==='object' && focusGuardReply.status==='armed' ? 'chrome-extension://'+'a'.repeat(32)+'/wake-window.html?marker='+focusGuardReply.marker : 'https://chatgpt.com/?q='+encodeURIComponent(ordinaryPrompt(ticket())),
      type:'normal',state:'minimized',
    });
    assert.equal(f.events.some((e: any) => e.create && !e.windowCreate), false);
    assert.equal(prefillCount(f),1);
    assert.equal(f.events.find((e: any) => e.path === '/extension/result').body.ok,true);
  }
});
test('ordinary refuses forged ownership but not merely a focused window', async () => {
  const forged = workerFixture({badWindowOwnership:true}); await run(forged);
  assert.equal(prefillCount(forged),0); assert.equal(probeCount(forged),0);
  assert.equal(forged.events.some((e: any) => e.windowRemove === 8),true);
  assert.equal(forged.events.find((e: any) => e.path === '/extension/result').body.ok,false);

  const moved = workerFixture({tabWindowId:99}); await run(moved);
  assert.equal(prefillCount(moved),0); assert.equal(probeCount(moved),0);
  assert.equal(moved.events.some((e: any) => e.remove === 7),true);
  assert.equal(moved.events.find((e: any) => e.path === '/extension/result').body.ok,false);

  const f = workerFixture({windowCreateThrows:true}); await run(f);
  assert.equal(prefillCount(f),0);
  assert.equal(f.events.some((e: any) => e.remove),false);
});

test('owned marker bootstrap navigates only its exact tab, and never sends there', async () => {
  for (const bootstrapNeverReady of [false,true]) {
    const f=workerFixture({focusGuardReply:{status:'armed',marker:'c'.repeat(32)},bootstrapNeverReady});
    await run(f);
    const update=f.events.find(e=>e.update)?.update;
    assert.deepEqual(update,{id:7,url:'https://chatgpt.com/?q='+encodeURIComponent(ordinaryPrompt(ticket()))});
    assert.equal(prefillCount(f),1);
    assert.equal(f.events.find(e=>e.path==='/extension/result').body.ok,true);
  }
  const transition=workerFixture({focusGuardReply:{status:'armed',marker:'c'.repeat(32)},bootstrapTransition:true});
  await run(transition);
  assert.equal(transition.events.find(e=>e.path==='/extension/result').body.ok,true);
  assert.equal(prefillCount(transition),1);
  for (const extra of [{bootstrapTransitionForeign:true},{bootstrapPendingForeign:true}]) {
    const invalid=workerFixture({focusGuardReply:{status:'armed',marker:'c'.repeat(32)},bootstrapTransition:true,...extra});
    await run(invalid);assert.equal(prefillCount(invalid),0);
    assert.equal(invalid.events.find(e=>e.path==='/extension/result').body.error,'page_changed');
  }
  const f=workerFixture({focusGuardReply:{status:'armed',marker:'c'.repeat(32)},bootstrapForeign:true});
  await run(f);
  assert.equal(f.events.some(e=>e.update),false);
  assert.equal(prefillCount(f),0);
});


// ---- Guaranteed disposal: early chat record, 404 as success, and the wake-signature sweep ----

test('P2/P3: a native wake reports its chat the moment the URL exists, even though its failure report carries no URL', async () => {
  const f = workerFixture({noContact: true}); await run(f);
  const events = f.events.map((e: any) => e.path);
  const chatAt = events.indexOf('/extension/chat'), resultAt = events.indexOf('/extension/result');
  assert(chatAt >= 0 && chatAt < resultAt, 'chat recorded before the outcome');
  assert.deepEqual(f.events[chatAt].body, {nonce: 'a'.repeat(32), url: 'https://chatgpt.com/c/new'});
  assert.equal(f.events[resultAt].body.ok, false); assert.equal(f.events[resultAt].body.url, undefined);
  assert.equal(events.filter(p => p === '/extension/chat').length, 1, 'reported once, not on every poll');
});

test('a service that refuses the early chat record never fails the wake itself', async () => {
  const f = workerFixture({}); const fetcher = f.fetcher;
  f.fetcher = async (url: any, init: any) => { if (new URL(url).pathname === '/extension/chat') throw Error('service restarting'); return fetcher(url, init); };
  await makePoller(f.browser as unknown as PollBrowser, f.fetcher, f.now, f.pause)();
  assert.equal(f.events.find((e: any) => e.path === '/extension/result').body.ok, true);
});

test('P7: archiving a conversation that is already gone counts as done; other failures still retry', async () => {
  const calls: any[] = [];
  const replies: Record<string, number> = {gone: 404, boom: 500, fine: 200};
  await inPage({}, async () => {
    globals.fetch = async (url: string, init: any) => {
      calls.push({url, init});
      if (url.endsWith('/api/auth/session')) return {ok: true, json: async () => ({accessToken: 't'})};
      const status = replies[url.split('/').at(-1)!];
      return {ok: status === 200, status};
    };
    assert.equal(await archiveConversation('https://chatgpt.com/c/gone', 15000, true), true);
    assert.equal(await archiveConversation('https://chatgpt.com/c/boom', 15000, true), false);
    assert.equal(await archiveConversation('https://chatgpt.com/c/fine', 15000, false), true);
  });
  const patches = calls.filter(c => c.init?.method === 'PATCH');
  assert.deepEqual(patches.map(c => JSON.parse(c.init.body)), [{is_visible: false}, {is_visible: false}, {is_archived: true}]);
});

test('wake signature matches exactly the three first messages Crossfeed sends and nothing a person writes', () => {
  const chip = '[$crossfeed](app://asdk_app_6a1b)';
  const nonce = 'EL-' + 'x'.repeat(29);
  for (const text of [
    `${chip} wake up as wake-${nonce}`, `${chip} wake up as sol`, `${chip} wake up as sol~session-${'A'.repeat(22)}~replica-2 `,
    `@Crossfeed wake up. First gateway_exchange: worker_label="research" exactly as issued, wake_nonce="${'a'.repeat(32)}", maximum_wait_seconds=20.`,
    `${chip} wake up. First gateway_exchange: worker_label="wake-${nonce}" exactly as issued`,
    `${chip} process exactly job job_1 as research. Call gateway_exchange with worker_label="research", request_id="job_1" and maximum_wait_seconds=1`,
  ]) assert.equal(isWakeSignature(text), true, text);
  for (const text of [
    '', 'wake up as sol', 'hello', 'Please wake up as soon as possible', `${chip} wake up as sol and then delete my files`,
    `${chip} summarize this`, `I typed ${chip} wake up as sol`, `${chip} process exactly job x as y without the rest`,
    `${chip} wake up. Something else entirely`, 12, null, undefined, `${chip} wake up as ` + 'x'.repeat(5000),
  ]) assert.equal(isWakeSignature(text as any), false, String(text));
});

test('first user message is read from the conversation tree, and an unreadable shape reads as nothing', () => {
  const node = (role: string, parts: any[], parent: string | null, extra: any = {}) => ({parent, message: {author: {role}, content: {parts}, ...extra}});
  const conversation = {current_node: 'c', mapping: {
    a: {parent: null, message: null}, s: node('system', ['sys'], 'a'), b: node('user', ['[$crossfeed](app://x) ', 'wake up as sol'], 's'), c: node('assistant', ['hi'], 'b'),
  }};
  assert.equal(firstUserText(conversation), '[$crossfeed](app://x) wake up as sol');
  assert.equal(firstUserText({mapping: conversation.mapping}), '[$crossfeed](app://x) wake up as sol');
  for (const bad of [null, {}, {mapping: 3}, {mapping: {a: node('user', [{type: 'image'}], null)}}, {current_node: 'z', mapping: {}}]) assert.equal(firstUserText(bad), '');
});

function sweepFixture(options: {service?: (candidates: any[]) => string[]; chats: Record<string, {created: number | string; first: string; fetchStatus?: number}>; store?: any; failList?: number}) {
  const calls: string[] = [], patches: any[] = [], serviceCalls: any[] = [];
  let clock = Date.parse('2026-10-20T12:00:00Z');
  const store: Record<string, any> = options.store ?? {};
  const browser: any = {storage: {local: {get: async (keys: string[]) => Object.fromEntries(keys.filter(k => k in store).map(k => [k, structuredClone(store[k])])), set: async (values: any) => Object.assign(store, structuredClone(values))}}};
  const fetcher: any = async (url: any, init: any) => {
    const path = new URL(url).pathname, body = JSON.parse(init.body);
    serviceCalls.push({path, body});
    let result: any = {ok: true};
    if (path === '/extension/sweep') result = {dispose: (options.service ?? (c => c.map((x: any) => x.id)))(body.candidates), min_age_ms: 2400000};
    return {ok: true, text: async () => JSON.stringify(result)};
  };
  const config: any = {apiURL: 'http://127.0.0.1:4319', key: 'e'.repeat(43)};
  const chatgpt = async (url: string, init: any = {}) => {
    calls.push(`${init.method ?? 'GET'} ${new URL(url).pathname}${new URL(url).search ? '?' : ''}`);
    if (url.endsWith('/api/auth/session')) return {ok: true, json: async () => ({accessToken: 'tok'})};
    if (url.includes('/backend-api/conversations?')) {
      if (options.failList) return {ok: false, status: options.failList};
      return {ok: true, json: async () => ({items: Object.entries(options.chats).map(([id, c]) => ({id, title: 'x', create_time: c.created}))})};
    }
    const id = url.split('/').at(-1)!;
    if (init.method === 'PATCH') { patches.push({id, body: JSON.parse(init.body)}); return {ok: true, status: 200}; }
    const c = options.chats[id];
    if (c.fetchStatus) return {ok: false, status: c.fetchStatus};
    return {ok: true, status: 200, json: async () => ({current_node: 'b', mapping: {a: {parent: null, message: null}, b: {parent: 'a', message: {author: {role: 'user'}, content: {parts: [c.first]}}}}})};
  };
  const run = () => inPage({}, async () => { globals.fetch = chatgpt; await sweepWakeChats(config, browser, fetcher, () => clock); });
  return {run, calls, patches, serviceCalls, store, advance: (ms: number) => { clock += ms; }, iso: (agoMs: number) => new Date(clock - agoMs).toISOString()};
}
const wakeFirst = '[$crossfeed](app://asdk_app_6a1b) wake up as wake-' + 'E'.repeat(32);

test('sweep deletes only approved, old conversations whose first message is a wake message', async () => {
  const probe = sweepFixture({chats: {}});
  const old = probe.iso(3_600_000);
  const fixture = sweepFixture({chats: {
    orphanwake: {created: old, first: wakeFirst}, ownerchat: {created: old, first: 'Plan my week'}, young: {created: probe.iso(60_000), first: wakeFirst},
    denied: {created: old, first: wakeFirst}, lookalike: {created: old, first: 'wake up as sol, please'}, unreadable: {created: old, first: wakeFirst, fetchStatus: 500},
  }, service: candidates => candidates.map((c: any) => c.id).filter((id: string) => id !== 'denied')});
  await fixture.run();
  assert.deepEqual(fixture.patches, [{id: 'orphanwake', body: {is_visible: false}}]);
  const asked = fixture.serviceCalls.find(c => c.path === '/extension/sweep').body.candidates.map((c: any) => c.id);
  assert.deepEqual(asked.sort(), ['denied', 'lookalike', 'orphanwake', 'ownerchat', 'unreadable'], 'a young chat is not even offered');
  assert.equal(fixture.calls.some(c => c.includes('/conversation/denied')), false, 'a chat the service did not approve is never opened');
  assert.deepEqual(fixture.serviceCalls.find(c => c.path === '/extension/sweep/done').body, {deleted: ['orphanwake']});
  const saved = fixture.store.crossfeedSweep;
  assert.deepEqual(saved.checked.sort(), ['lookalike', 'ownerchat'], 'non-wake chats are never read twice; unreadable ones are retried');
  assert.equal(saved.deleted, 1); assert.equal(saved.error, '');
});

test('approved sweep reports done even when no chat can be deleted', async () => {
  for (const entry of [{first:'Personal conversation'}, {first:wakeFirst,fetchStatus:500}]) {
    const fixture = sweepFixture({chats:{candidate:{created:1,...entry}}});
    await fixture.run();
    assert.deepEqual(fixture.patches, []);
    assert.deepEqual(fixture.serviceCalls.find(c => c.path === '/extension/sweep/done')?.body, {deleted:[]});
  }
});

test('sweep runs at most every ten minutes, remembers what it already read, and survives a listing failure', async () => {
  const f = sweepFixture({chats: {}, failList: 429});
  await f.run();
  assert.equal(f.store.crossfeedSweep.error, 'list_429');
  const calls = f.calls.length; await f.run();
  assert.equal(f.calls.length, calls, 'throttled even after a failure');
  f.advance(600001);
  const g = sweepFixture({chats: {}, store: {crossfeedSweep: {at: 1, checked: ['seen']}}});
  await g.run(); assert(g.calls.some(c => c.startsWith('GET /backend-api/conversations')));
  assert.equal(g.serviceCalls.length, 0, 'no candidates, nothing to ask');
  assert.deepEqual(g.store.crossfeedSweep.checked, ['seen']);
  // No storage API, no sweep, no crash.
  await inPage({}, async () => { globals.fetch = async () => { throw Error('must not be called'); }; await sweepWakeChats({apiURL: 'http://127.0.0.1:4319', key: 'k'} as any, {} as any, (async () => ({})) as any, Date.now); });
});

test('idle poll triggers the sweep only when there is neither a wake nor an archive to run', async () => {
  const f = workerFixture({});
  const fetcher = f.fetcher;
  f.fetcher = async (url: any, init: any) => { const path = new URL(url).pathname; if (path === '/extension/next') { f.events.push({path, body: null}); return {ok: true, text: async () => JSON.stringify({ticket: null})}; } return fetcher(url, init); };
  const stored: Record<string, any> = {};
  const local: any = f.browser.storage.local, get = local.get;
  local.get = async (keys: any) => keys.includes?.('crossfeedSweep') ? Object.fromEntries(Object.entries(stored)) : get(keys);
  local.set = async (values: any) => { Object.assign(stored, values); };
  await inPage({}, async () => {
    globals.fetch = async (url: string) => url.endsWith('/api/auth/session') ? {ok: true, json: async () => ({accessToken: 't'})} : {ok: true, json: async () => ({items: []})};
    await makePoller(f.browser as unknown as PollBrowser, f.fetcher, f.now, f.pause)();
  });
  assert.equal(typeof stored.crossfeedSweep?.at, 'number');
  assert.equal(f.events.some((e: any) => e.create), false);
});

// ---- Owned wake tabs: records survive a dead poll, but never outlive the owner's intent ----

function ownedTabFixture(records: any[], tabs: Record<number, any>,
  options: {removeThrows?: number[]} = {}) {
  const events: any[] = [];
  const store: Record<string, any> = {
    crossfeedWakeTabs: structuredClone(records),
    crossfeedSweep: {at: Date.now(), checked: []},
    apiURL: 'http://127.0.0.1:4319', key: 'e'.repeat(43), pairingVersion: 1,
    pairing: {id: 'p'.repeat(32), state: 'approved', apiURL: 'http://127.0.0.1:4319', checked_at: Date.now()},
  };
  const browser: any = {
    storage: {local: {
      get: async (keys: string[]) => Object.fromEntries(keys.filter(key => key in store).map(key => [key, structuredClone(store[key])])),
      set: async (values: any) => { events.push({set: structuredClone(values)}); Object.assign(store, structuredClone(values)); },
    }},
    tabs: {
      get: async (id: number) => {
        events.push({get: id});
        if (!tabs[id]) throw Error('No tab with id: ' + id);
        return structuredClone(tabs[id]);
      },
      remove: async (id: number) => {
        events.push({remove: id});
        if (options.removeThrows?.includes(id)) throw Error('remove failed');
        delete tabs[id];
      },
    },
    windows: {remove: async (id: number) => events.push({windowRemove: id})},
  };
  return {events, store, tabs, browser};
}

test('an orphaned recorded wake tab on chatgpt.com is closed on the next idle poll', async () => {
  const f = ownedTabFixture([{tab: 7, at: Date.now()}], {
    7: {id: 7, windowId: 1, url: 'https://chatgpt.com/c/orphan', status: 'complete'},
  });
  const fetcher: any = async (url: any) => {
    const path = new URL(url).pathname;
    const value = path === '/extension/next' || path === '/extension/archive/next' ? {} : {ok: true};
    return {ok: true, text: async () => JSON.stringify(path === '/extension/next' ? {ticket: null} : path === '/extension/archive/next' ? {archive: null} : value)};
  };
  await makePoller(f.browser as unknown as PollBrowser, fetcher, () => Date.now(), async () => {})();
  assert.deepEqual(f.events.filter(e => e.remove), [{remove: 7}]);
  assert.deepEqual(f.store.crossfeedWakeTabs, []);
});

test('a recorded wake tab that navigated off chatgpt.com is never closed', async () => {
  const f = ownedTabFixture([{tab: 7, at: Date.now()}], {
    7: {id: 7, windowId: 1, url: 'https://example.com/owner-page', status: 'complete'},
  });
  await closeOrphanedWakeTabs(f.browser);
  assert.equal(f.events.some(e => e.remove), false);
  assert.deepEqual(f.store.crossfeedWakeTabs, [], 'an owner-repurposed tab is no longer our record');
});

test('a running wake keeps its own recorded tab', async () => {
  const f = ownedTabFixture([{tab: 7, at: Date.now()}], {
    7: {id: 7, windowId: 1, url: 'https://chatgpt.com/c/new', status: 'complete'},
  });
  await closeOrphanedWakeTabs(f.browser, 7);
  assert.equal(f.events.some(e => e.remove || e.windowRemove), false);
  assert.deepEqual(f.store.crossfeedWakeTabs, [{tab: 7, at: f.store.crossfeedWakeTabs[0].at}]);
});

test('startup clears owned tab records without closing anything', async () => {
  const f = ownedTabFixture([{tab: 7, window: 8, at: Date.now()}], {
    7: {id: 7, windowId: 8, url: 'https://chatgpt.com/c/orphan', status: 'complete'},
  });
  await clearOwnedWakeTabs(f.browser);
  assert.equal(f.events.some(e => e.remove || e.windowRemove), false);
  assert.deepEqual(f.store.crossfeedWakeTabs, []);
});

test('an owned wake window keeps an extra tab the owner added', async () => {
  const f = ownedTabFixture([{tab: 7, window: 8, at: Date.now()}], {
    7: {id: 7, windowId: 8, url: 'https://chatgpt.com/c/orphan', status: 'complete'},
    9: {id: 9, windowId: 8, url: 'https://chatgpt.com/c/owner', status: 'complete'},
  });
  await closeOrphanedWakeTabs(f.browser);
  assert.deepEqual(f.events.filter(e => e.remove), [{remove: 7}]);
  assert.equal(f.events.some(e => e.windowRemove), false, 'never close the whole window');
  assert.deepEqual(f.tabs[9], {id: 9, windowId: 8, url: 'https://chatgpt.com/c/owner', status: 'complete'});
  assert.deepEqual(f.store.crossfeedWakeTabs, []);
});

test('each wake records its tab (and native window) at creation and releases it in finally', async () => {
  for (const [wakeMode, window] of [['configured', undefined], [undefined, 8]] as const) {
    const f = workerFixture(wakeMode === undefined ? {} : {wakeMode});
    const local: any = f.browser.storage.local;
    const get = local.get, set = local.set;
    let records: any[] | undefined;
    local.get = async (keys: any) => ({
      ...(await get(keys)), ...(records ? {crossfeedWakeTabs: structuredClone(records)} : {}),
    });
    local.set = async (values: any) => {
      if (Object.hasOwn(values, 'crossfeedWakeTabs')) {
        records = structuredClone(values.crossfeedWakeTabs);
        f.events.push({recorded: structuredClone(records)});
      }
      return set(values);
    };
    await run(f);
    const written = f.events.filter((e: any) => e.recorded).map((e: any) => e.recorded);
    assert.equal(written.length >= 2, true);
    assert.equal(written[0].length, 1);
    assert.equal(written[0][0].tab, 7);
    assert.equal(written[0][0].window, window);
    assert.equal(Number.isSafeInteger(written[0][0].at), true);
    assert.deepEqual(written.at(-1), [], 'finally releases the record');
    assert.equal(f.events.some((e: any) => e.remove === 7), true);
  }
});
