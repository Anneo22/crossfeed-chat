import test from 'node:test';
import assert from 'node:assert/strict';
import { prefillProbe, prefillWake, pagePermission } from '../extension/page.ts';

const globals: any = globalThis;
const nonce = 'a'.repeat(32), label = 'research', connector = 'Crossfeed Chat';
const tail = ` wake up. First gateway_exchange: worker_label=${JSON.stringify(label)} exactly as issued, wake_nonce=${JSON.stringify(nonce)}, maximum_wait_seconds=20. Then use the server-returned worker_label and repeat wake_nonce=${JSON.stringify(nonce)} on all subsequent gateway_exchange calls. Poll until state=released and continue=false; do not send a final chat reply between jobs. Return local caller tools as structured tool_calls through gateway_exchange; do not execute them natively.`;
const prompt = `@${connector}${tail}`;
const stalePrompt = `@${connector} wake up as ${label}`;
const qURL = 'https://chatgpt.com/?q=' + encodeURIComponent(prompt);
const promptURL = 'https://chatgpt.com/?prompt=' + encodeURIComponent(prompt);
const plusQURL = 'https://chatgpt.com/?' + new URLSearchParams([['q', prompt]]).toString();
const plusPromptURL = 'https://chatgpt.com/?' + new URLSearchParams([['prompt', prompt]]).toString();
const ticket = () => ({nonce, label, connector,
  row: 'Latest', level: 3, expires_at: Date.now() + 60_000});

function fixture(options: Record<string, any> = {}) {
  let clicks = 0;
  const attrs = new Map<string, string>();
  const element = (content = '', values: Record<string, string> = {}): any => ({
    textContent: content, isConnected: true, disabled: false,
    getClientRects: () => [1],
    closest: (_selector: string) => null,
    getAttribute: (key: string) => values[key] ?? null,
    querySelectorAll: (_selector: string) => [],
  });
  const form = element();
  const editor = element(options.text ?? prompt);
  const replacement = element(options.replacementText ?? prompt);
  const legacyValues = {
    'app-mention-name': options.chipName ?? 'Crossfeed Chat',
    'app-mention-path': options.chipPath ?? 'app://asdk_app_crossfeed',
  };
  const modernValues = {
    'data-prompt-link-href': options.modernHref ?? 'app:asdk_app_crossfeed',
    'data-prompt-link-label': options.modernLabel ?? 'Crossfeed Chat',
  };
  const chipValues = options.modernChip ? modernValues : options.mixedChip ? {...legacyValues, ...modernValues} : legacyValues;
  const chip = element(options.chipText ?? connector, chipValues);
  const chip2 = element(options.chipText ?? connector, chipValues);
  const chips = options.duplicateChips ? [chip, chip2] : [chip];
  const fixed = options.extraFixed ? [...chips, element('extra-fixed')] : chips;
  editor.closest = (selector: string) => selector === 'form' ? form : null;
  replacement.closest = editor.closest;
  if (options.chip) {
    editor.textContent = options.text ?? connector + tail;
    editor.querySelectorAll = (selector: string) =>
      selector === 'a' ? [] :
      selector === '[contenteditable="false"]' ? fixed :
      selector.includes('[app-mention-name]') || selector.includes('[data-prompt-link-href') ? chips : [];
  }
  if (options.link) {
    const link = element('other');
    editor.querySelectorAll = (selector: string) => selector === 'a' ? [link] : [];
  }
  const button = element();
  button.disabled = !!options.disabled;
  button.closest = (selector: string) => selector === 'form' && !options.unownedSend ? form : null;
  button.getAttribute = (key: string) => key === 'aria-disabled' && options.ariaDisabled ? 'true' : null;
  button.click = () => { clicks++; if (options.throwClick) throw Error('lost click reply'); };
  const attachment = element('attachment');
  const image = element();
  form.querySelectorAll = (selector: string) => {
    if (options.unknownSubmit) return selector.split(', ').includes('button[type="submit"]') ? [button] : [];
    if (options.onSendQuery && selector.includes('send-button')) options.onSendQuery();
    if (selector.includes('attachment') || selector.includes('img')) {
      return [...(options.attachment ? [attachment] : []), ...(options.image ? [image] : [])];
    }
    if (selector.includes('send-button') || selector.includes('composer-submit-button') || selector.includes('Send prompt')) {
      return options.duplicateSend ? [button, {...button}] : options.missingSend ? [] : [button];
    }
    return [];
  };
  const fileInput = {...element(), files: options.files ? [{name: 'x'}] : []};
  let currentEditors: any[] = options.duplicateEditors ? [editor, {...editor}] : [editor];
  const doc: any = {
    activeElement: null,
    documentElement: {
      getAttribute: (key: string) => attrs.get(key) ?? null,
      setAttribute: (key: string, value: string) => { attrs.set(key, value); },
    },
    querySelectorAll: (selector: string) => {
      if (selector === 'form #prompt-textarea[contenteditable="true"], form [contenteditable="true"][role="textbox"]') return currentEditors;
      if (selector === 'input[type="file"]') return [fileInput];
      if (selector.includes('stop-button')) return options.generating || options.ariaGenerating && selector.includes('Stop generating') ? [element('stop')] : [];
      if (selector.includes('[role="alert"]')) return [];
      return [];
    },
  };
  editor.focus = () => {
    doc.activeElement = editor;
    if (options.focusText !== undefined) editor.textContent = options.focusText;
    if (options.focusURL) globals.location.href = options.focusURL;
    if (options.replaceOnFocus) {
      editor.isConnected = false;
      currentEditors = [replacement];
      replacement.focus = () => { doc.activeElement = replacement; };
    }
    if (options.replaceDocumentOnFocus) globals.document = {...doc};
  };
  replacement.focus = () => { doc.activeElement = replacement; };
  return {doc, editor, replacement, form, button, attrs, get clicks() { return clicks; }};
}

async function inPage(f: any, url: string, callback: () => Promise<any>) {
  const names = ['document', 'location', 'getComputedStyle'];
  const old = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  globals.document = f.doc;
  globals.location = {href: url, origin: 'https://chatgpt.com'};
  globals.getComputedStyle = () => ({visibility: 'visible'});
  try { return await callback(); }
  finally {
    names.forEach((name, i) => {
      if (old[i]) Object.defineProperty(globalThis, name, old[i]!);
      else delete globals[name];
    });
  }
}

test('ordinary native command spells the scoped gateway protocol exactly and stays single-line', () => {
  assert.equal(prompt.includes('\n'), false);
  assert(prompt.includes(`worker_label=${JSON.stringify(label)} exactly as issued`));
  assert(prompt.includes(`wake_nonce=${JSON.stringify(nonce)}, maximum_wait_seconds=20`));
  assert(prompt.includes('server-returned worker_label'));
  assert(prompt.includes(`repeat wake_nonce=${JSON.stringify(nonce)} on all subsequent gateway_exchange calls`));
  assert(prompt.includes('Poll until state=released and continue=false'));
  assert(prompt.includes('do not send a final chat reply between jobs'));
  assert(prompt.includes('structured tool_calls through gateway_exchange'));
  assert(prompt.includes('do not execute them natively'));
  assert.equal(prompt.split(JSON.stringify(nonce)).length - 1, 2);
});

test('plain native prefill seals and clicks exactly once', async () => {
  const f = fixture();
  const result = await inPage(f, qURL, () => prefillWake(ticket(), 100, 1));
  assert.equal(result.sent, true);
  assert.equal(f.clicks, 1);
  assert.equal(f.attrs.get('data-crossfeed-wake-sealed'), 'a'.repeat(32));
  assert.equal(f.editor.textContent, prompt);
});

test('consumed bare root requires explicit owned-tab probe authority and never sends', async () => {
  const refused = fixture();
  const direct = await inPage(refused, 'https://chatgpt.com/', () => prefillProbe(ticket(), false, 20, 1));
  assert.equal(direct.ready, false); assert.equal(direct.error, 'page_changed'); assert.equal(refused.clicks, 0);
  const owned = fixture();
  const attested = await inPage(owned, 'https://chatgpt.com/', () => prefillProbe(ticket(), true, 20, 1));
  assert.deepEqual(attested, {ready: true, phase: 2}); assert.equal(owned.clicks, 0);
});

test('unique empty native composer may hydrate to the exact alias within the bounded wait', async () => {
  const f = fixture({text: ''});
  setTimeout(() => { f.editor.textContent = prompt; }, 2);
  const result = await inPage(f, qURL, () => prefillWake(ticket(), 100, 1));
  assert.equal(result.sent, true); assert.equal(f.clicks, 1);
});

test('probe and sender accept canonical equivalent plus encoding without normalizing the alias', async () => {
  const probe = fixture();
  assert.deepEqual(await inPage(probe, plusQURL, () => prefillProbe(ticket(), false, 20, 1)), {ready: true, phase: 0});
  assert.equal(probe.clicks, 0);
  for (const [url, phase] of [[plusQURL, 0], [plusPromptURL, 1]] as const) {
    const f = fixture();
    const result = await inPage(f, url, () => prefillWake(ticket(), 50, 1, phase));
    assert.equal(result.sent, true, url); assert.equal(f.clicks, 1, url);
  }
});

test('probe location diagnostic exposes only safe classes, counts, names and match booleans', async () => {
  const secret = 'credential-value-that-must-not-cross';
  const url = `https://chatgpt.com/?q=${encodeURIComponent(prompt)}&credential=${encodeURIComponent(secret)}&utm_campaign=${encodeURIComponent(secret)}`;
  const f = fixture();
  const result = await inPage(f, url, () => prefillProbe(ticket(), true, 10, 1));
  assert.equal(result.ready, false); assert.equal(result.error, 'page_changed'); assert.equal(f.clicks, 0);
  assert.deepEqual(result.diagnostic, {uri_class: 'root_other_query', parsed_phase: -1, query_count: 3,
    query_names: ['q', 'other', 'utm_campaign'], q_matches: true, prompt_matches: false});
  assert.equal(JSON.stringify(result.diagnostic).includes(secret), false);
});

test('probe and sender reject hostile or noncanonical native root URL structure', async () => {
  const encoded = encodeURIComponent(prompt);
  for (const url of [
    `https://chatgpt.com/?q=${encoded}&x=1`,
    `https://chatgpt.com/?q=${encoded}&q=${encoded}`,
    `https://chatgpt.com/?q=${encoded}#`,
    `https://user@chatgpt.com/?q=${encoded}`,
    `https://chatgpt.com:443/?q=${encoded}`,
    `https://evil.example/?q=${encoded}`,
    'https://chatgpt.com/?',
  ]) {
    const probe = fixture();
    const attested = await inPage(probe, url, () => prefillProbe(ticket(), true, 10, 1));
    assert.equal(attested.ready, false, url); assert.equal(probe.clicks, 0, url);
    const sender = fixture();
    const result = await inPage(sender, url, () => prefillWake(ticket(), 10, 1, 0));
    assert.equal(result.sent, false, url); assert.equal(sender.clicks, 0, url);
  }
});

test('one exact legacy or modern native app connector chip plus full protocol tail is accepted', async () => {
  for (const options of [{chip: true}, {chip: true, modernChip: true}]) {
    const f = fixture(options);
    const result = await inPage(f, qURL, () => prefillWake(ticket(), 100, 1));
    assert.equal(result.sent, true, JSON.stringify(options));
    assert.equal(f.clicks, 1);
  }
});

test('stale, altered, incomplete or structurally ambiguous ordinary commands never send', async () => {
  const cases = [
    {text: prompt + ' '},
    {text: prompt.replace('wake', 'wake\u200b')},
    {text: stalePrompt},
    {text: prompt.replace(JSON.stringify(label), JSON.stringify('somebody-else'))},
    {text: prompt.replace(JSON.stringify(nonce), JSON.stringify('b'.repeat(32)))},
    {text: prompt.replace(`, wake_nonce=${JSON.stringify(nonce)}`, '')},
    {text: prompt + ' appended'},
    {text: prompt.slice(0, -1)},
    {chip: true, text: connector + ' wake up as research'},
    {chip: true, chipName: 'Other'},
    {chip: true, modernChip: true, modernLabel: 'Other'},
    {chip: true, modernChip: true, modernHref: 'https://evil.example/app'},
    {chip: true, duplicateChips: true},
    {chip: true, extraFixed: true},
    {chip: true, mixedChip: true},
    {duplicateEditors: true},
  ];
  for (const options of cases) {
    const f = fixture(options);
    const result = await inPage(f, qURL, () => prefillWake(ticket(), 20, 1));
    assert.equal(result.sent, false, JSON.stringify(options));
    assert.equal(f.clicks, 0, JSON.stringify(options));
  }
});

test('unrelated links, attachments, files and generation refuse the ordinary wake', async () => {
  for (const options of [{link: true}, {attachment: true}, {image: true}, {files: true}, {generating: true}, {ariaGenerating: true}]) {
    const f = fixture(options);
    const result = await inPage(f, qURL, () => prefillWake(ticket(), 20, 1));
    assert.equal(result.sent, false, JSON.stringify(options));
    assert.equal(f.clicks, 0);
  }
});

test('focus mutation, document replacement and unsafe rerender never authorize a click', async () => {
  for (const options of [
    {focusText: prompt + ' changed'},
    {replaceDocumentOnFocus: true},
    {replaceOnFocus: true, replacementText: 'restored draft'},
  ]) {
    const f = fixture(options);
    const result = await inPage(f, qURL, () => prefillWake(ticket(), 20, 1));
    assert.equal(result.sent, false, JSON.stringify(options));
    assert.equal(f.clicks, 0);
  }
});

test('authorized root URL transition is monotonic q to prompt to root only', async () => {
  const forward = fixture({
    focusURL: promptURL,
    onSendQuery: () => { globals.location.href = 'https://chatgpt.com/'; },
  });
  assert.equal((await inPage(forward, qURL, () => prefillWake(ticket(), 100, 1))).sent, true);
  assert.equal(forward.clicks, 1);

  for (const url of [
    'https://chatgpt.com/',
    qURL + '&x=1',
    'https://chatgpt.com/?q=' + encodeURIComponent(prompt + ' changed'),
    'https://chatgpt.com/c/existing',
  ]) {
    const f = fixture();
    const result = await inPage(f, url, () => prefillWake(ticket(), 20, 1));
    assert.equal(result.sent, false, url);
    assert.equal(f.clicks, 0);
  }

  const backward = fixture({
    focusURL: promptURL,
    onSendQuery: () => { globals.location.href = qURL; },
  });
  assert.equal((await inPage(backward, qURL, () => prefillWake(ticket(), 20, 1))).sent, false);
  assert.equal(backward.clicks, 0);
});

test('duplicate, disabled, unowned or pre-sealed Send authority never clicks', async () => {
  for (const options of [{duplicateSend: true}, {disabled: true}, {ariaDisabled: true}, {unownedSend: true}, {unknownSubmit: true}]) {
    const f = fixture(options);
    const result = await inPage(f, qURL, () => prefillWake(ticket(), 5, 1));
    assert.equal(result.sent, false, JSON.stringify(options));
    assert.equal(f.clicks, 0);
  }
  const sealed = fixture();
  sealed.attrs.set('data-crossfeed-wake-sealed', 'other');
  const result = await inPage(sealed, qURL, () => prefillWake(ticket(), 20, 1));
  assert.equal(result.sent, false);
  assert.equal(sealed.clicks, 0);
});

test('a thrown one-shot click is uncertain after sealing and is never retried by the page helper', async () => {
  const f = fixture({throwClick: true});
  await assert.rejects(inPage(f, qURL, () => prefillWake(ticket(), 100, 1)), /send_unconfirmed/);
  assert.equal(f.clicks, 1);
  assert.equal(f.attrs.get('data-crossfeed-wake-sealed'), 'a'.repeat(32));
});

test('permission click is bound to the exact canonical conversation and connector card', async () => {
  const make = (textContent = ''): any => ({
    textContent, isConnected: true, disabled: false, id: '',
    getClientRects: () => [1], closest: () => null,
    getAttribute: (_key: string) => null, querySelectorAll: (_selector: string) => [],
  });
  let clicks = 0;
  const span = make('Crossfeed Chat');
  const alert = make();
  alert.querySelectorAll = (selector: string) => selector === 'span' ? [span] : [];
  const button = make('Always allow');
  button.click = () => { clicks++; };
  const card = make();
  card.querySelectorAll = (selector: string) =>
    selector === '[role="alert"]' ? [alert] :
    selector === 'button' ? [button] :
    selector.includes('Approval options') ? [] : [];
  const doc: any = {
    querySelectorAll: (selector: string) => selector === '[data-codex-approval-surface="true"]' ? [card] : [],
  };
  const f = {doc};
  const url = 'https://chatgpt.com/c/owned-conversation';
  const ok = await inPage(f, url, async () => pagePermission(ticket(), 'Always allow', url));
  assert.equal(ok, true);
  assert.equal(clicks, 1);
  for (const hidden of [card, alert, span, button]) {
    for (const visibility of ['hidden', 'collapse']) {
      const refused = await inPage(f, url, async () => {
        globals.getComputedStyle = (el: any) => ({visibility: el === hidden ? visibility : 'visible'});
        return pagePermission(ticket(), 'Always allow', url);
      });
      assert.equal(refused, false);
      assert.equal(clicks, 1);
    }
  }
  const moved = await inPage(f, 'https://chatgpt.com/c/other-conversation',
    async () => pagePermission(ticket(), 'Always allow', url));
  assert.equal(moved, false);
  assert.equal(clicks, 1);
});
