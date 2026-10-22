import test from 'node:test';
import assert from 'node:assert/strict';
// The fixtures intentionally install partial browser and DOM objects.
const globals: any = globalThis;
const settle = () => new Promise(resolve => setImmediate(resolve));
test('background restricts storage before automatic polling and gates lifecycle events', async t => {
  const old = {chrome:globals.chrome,fetch:globals.fetch}; t.after(() => Object.assign(globalThis, old));
  const events: any[] = [], listeners: Record<string, any> = {}; let unlock: any, restrictions = 0;
  const apiURL = 'http://127.0.0.1:4319';
  const state = { apiURL, key: 'e'.repeat(43), pairingVersion: 1, pairing: { apiURL, id: 'a'.repeat(32), code: 'ABCD-0123', state: 'approved', checked_at: Date.now() } };
  globals.fetch = async (url: string) => ({ok:true,text:async () => JSON.stringify(url.endsWith('/extension/next') ? {ticket:null} : {archive:null})});
  globals.chrome = {
    storage: { local: { setAccessLevel: async (value: any) => { events.push(value); if (++restrictions === 1) await new Promise(resolve => { unlock = resolve; }); }, get: async () => { events.push('poll'); return state; } } },
    alarms: { create: async (...args: any[]) => events.push(args), onAlarm: { addListener: (f: any) => { listeners.alarm = f; } } },
    runtime: { id: 'a'.repeat(32), getURL: (path: string) => 'chrome-extension://' + 'a'.repeat(32) + '/' + path, onMessage: { addListener: (f: any) => { listeners.message = f; } }, onInstalled: { addListener: (f: any) => { listeners.install = f; } }, onStartup: { addListener: (f: any) => { listeners.start = f; } } },
  };
  await import('../extension/background.ts' + '?success');
  listeners.install(); listeners.start(); listeners.alarm({ name: 'other' });
  assert.equal(events.length, 1); unlock(); await settle();
  assert.deepEqual(events[0], { accessLevel: 'TRUSTED_CONTEXTS' });
  assert.deepEqual(events[1], ['crossfeed-fresh-chat-wake', { periodInMinutes: .5 }]);
  assert.equal(events.filter(e => e === 'poll').length, 1);
  listeners.alarm({ name: 'other' }); await settle(); assert.equal(events.filter(e => e === 'poll').length, 1);
  listeners.alarm({ name: 'crossfeed-fresh-chat-wake' }); await settle();
  assert.equal(events.filter(e => e === 'poll').length, 2);
  assert.equal(listeners.message({type:'pairing'}, {id:'other',url:'https://chatgpt.com'}, () => assert.fail('external response')), undefined);
  const response = await new Promise(resolve => {
    assert.equal(listeners.message({type:'pairing'}, {id:globals.chrome.runtime.id,url:globals.chrome.runtime.getURL('options.html')}, resolve), true);
  });
  assert.deepEqual(response, {state:'approved',code:'ABCD-0123'});
  assert(!JSON.stringify(response).includes(state.key));
});
test('background setup rejection prevents polling', async t => {
  const old = globals.chrome; t.after(() => { globals.chrome = old; });
  let poll = 0, listener: any;
  globals.chrome = { storage: { local: { setAccessLevel: async () => { throw Error('refused'); }, get: async () => { poll++; } } }, alarms: { create: async () => assert.fail('no alarm after failure'), onAlarm: { addListener() {} } }, runtime: { onMessage:{addListener(){}}, onInstalled: { addListener: (f: any) => { listener = f; } }, onStartup: { addListener() {} } } };
  await import('../extension/background.ts' + '?failure'); listener(); await settle(); assert.equal(poll, 0);
});
test('options exposes only API URL, pairing code and status and requests pairing through the background', async t => {
  const previous = { chrome: globals.chrome, document: globals.document, setInterval: globals.setInterval };
  t.after(() => Object.assign(globalThis, previous));
  const api = { value: '' }, status: any = {}, code: any = {}; let submit: any, fail = false; const messages: any[] = [];
  globals.setInterval = () => 1;
  globals.document = { querySelector: (selector: string) => ({ '#api': api, '#code': code, '#status': status, '#settings': { addEventListener: (_: any, f: any) => { submit = f; } } })[selector] };
  globals.chrome = {
    storage: { local: { setAccessLevel: async () => {}, get: async (names: any) => { assert.deepEqual(names, ['apiURL']); return { apiURL: 'http://127.0.0.1:4319' }; } } },
    runtime: { sendMessage: async (value: any) => { if(fail) throw Error('private detail'); messages.push(value); return {state:'pending',code:'ABCD-0123'}; } },
  };
  await import('../extension/options.ts'); assert.equal(api.value, 'http://127.0.0.1:4319'); assert.equal(code.textContent, 'ABCD-0123');
  assert.match(status.textContent, /Waiting for approval/);
  const event = { preventDefault() {} }; api.value = 'https://evil.example'; await submit(event); assert.equal(messages.length, 1);
  api.value = 'http://127.0.0.1:4321'; await submit(event); assert.deepEqual(messages[1], {type:'pairing',apiURL:api.value});
  fail = true; await submit(event); assert.equal(status.textContent, 'Settings could not be saved.');
});
