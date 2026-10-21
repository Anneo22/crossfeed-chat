import test from 'node:test';
import assert from 'node:assert/strict';
const {default: crossfeedSession, beforeProviderHeaders} = await import(new URL('../integrations/pi-session.js', import.meta.url).href);
const event = (headers: Record<string, string> = {}) => ({type:'before_provider_headers', headers});

const model = {id:'chatgpt:sol', baseUrl:'http://127.0.0.1:4319/v1'};

function context(getSessionId: () => unknown, override: Record<string, string> = {}) {
  return {model:{...model,...override}, sessionManager:{getSessionId}};
}

test('Pi extension registers before_provider_headers and reads the current session on every request', () => {
  let handler: any, calls = 0, session = 'session-A';
  crossfeedSession({on(name: string, fn: any) { assert.equal(name, 'before_provider_headers'); handler = fn; }});
  const ctx = context(() => { calls++; return session; });
  for (const phase of ['turn','tool','resume']) {
    const input = event({phase});
    handler(input, ctx);
    assert.equal(input.headers['X-Crossfeed-Session'], 'session-A');
  }
  session = 'session-B';
  const fresh = event();
  handler(fresh, ctx);
  assert.equal(fresh.headers['X-Crossfeed-Session'], 'session-B');
  assert.equal(calls, 4);
});

test('distinct Pi sessions and /new-style session changes inject distinct caller IDs', () => {
  for (const id of ['old-session','new-session','third_session~1']) {
    const input = event();
    beforeProviderHeaders(input, context(() => id));
    assert.equal(input.headers['X-Crossfeed-Session'], id);
  }
});

test('foreign models and non-exact loopback v1 URLs never receive the session header', () => {
  const variants = [
    {id:'other:sol', baseUrl:model.baseUrl},
    {id:'chatgpt:sol', baseUrl:'http://localhost:4319/v1'},
    {id:'chatgpt:sol', baseUrl:'http://127.0.0.2:4319/v1'},
    {id:'chatgpt:sol', baseUrl:'https://127.0.0.1:4319/v1'},
    {id:'chatgpt:sol', baseUrl:'http://user@127.0.0.1:4319/v1'},
    {id:'chatgpt:sol', baseUrl:'http://127.0.0.1:4319/v1/'},
    {id:'chatgpt:sol', baseUrl:'http://127.0.0.1:4319/v1?q=x'},
    {id:'chatgpt:sol', baseUrl:'http://127.0.0.1:4319/v1#x'},
    {id:'chatgpt:sol', baseUrl:'http://127.0.0.1:0/v1'},
    {id:'chatgpt:sol', baseUrl:'http://127.0.0.1:65536/v1'},
  ];
  for (const candidate of variants) {
    let called = false;
    const input = event();
    beforeProviderHeaders(input, context(() => { called = true; return 'secret-session'; }, candidate));
    assert.equal(input.headers['X-Crossfeed-Session'], undefined, candidate.baseUrl);
    assert.equal(called, false, candidate.baseUrl);
  }
});

test('eligible Crossfeed requests fail closed on missing or unsafe session IDs', () => {
  for (const id of [undefined, '', 'has space', 'x'.repeat(129), 'line\nbreak']) {
    const input = event();
    assert.throws(() => beforeProviderHeaders(input, context(() => id)), /URL-safe Pi session ID/);
    assert.equal(input.headers['X-Crossfeed-Session'], '', 'caught handler failures leave an explicit invalid header');
  }
  const thrown = event();
  assert.throws(() => beforeProviderHeaders(thrown, context(() => { throw Error('PRIVATE_SESSION_SENTINEL'); })), (error: any) =>
    error.message === 'Crossfeed requires a URL-safe Pi session ID' && !error.message.includes('PRIVATE'));
  assert.equal(thrown.headers['X-Crossfeed-Session'], '');
  const input = {...event(), type:'other'};
  beforeProviderHeaders(input, context(() => { throw Error('must not read session'); }));
  assert.deepEqual(input.headers, {});
});
