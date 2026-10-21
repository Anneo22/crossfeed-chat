import test from 'node:test';
import assert from 'node:assert/strict';
import {pageWake} from '../extension/page.js';
const globals: any = globalThis;
const ticket = {nonce: 'a'.repeat(32), label: 'sol', connector: 'crossfeed', row: 'Latest', level: 1, expires_at: Date.now() + 60000};

// Match the captured ChatGPT approval-card and linked Radix menu structure.
function fixture(options: Record<string, any> = {}) {
  const el = (textContent = '', attrs: Record<string, any> = {}): any => ({textContent, id: attrs.id, disabled: options.disabled,
    isConnected: true, getClientRects: () => options.hidden ? [] : [1], closest: () => null,
    getBoundingClientRect: () => ({x: 0, y: 0, width: 2, height: 2}), getAttribute: (key: string) => attrs[key] ?? null, querySelectorAll: () => []});
  const identity = el(options.connector ?? 'crossfeed'), title = el(options.title ?? 'Allow file materialization?');
  const alert = el(); alert.querySelectorAll = (s: string) => s === 'span' ? [identity] : s === 'div' ? [title] : [];
  const button = el('', {id: 'options', 'aria-controls': 'approval-menu', 'aria-expanded': options.open ? 'true' : 'false', 'aria-haspopup': 'menu'});
  const allow = el(options.option ?? 'Allow crossfeed for this conversation');
  const menu = el('', {role: 'menu', 'aria-labelledby': options.foreignMenu ? 'another-trigger' : 'options'});
  menu.querySelectorAll = () => options.duplicateOption ? [allow, allow] : [allow];
  const direct = el('Always allow');
  const card = el(); card.closest = () => options.messageContent ? {} : null;
  card.querySelectorAll = (s: string) => s === '[role="alert"]' ? [alert] : s === 'button' ? options.direct ? [direct] : [button] : s.includes('Approval options') ? [button] : [];
  const document = {querySelectorAll: (s: string) => s === '[data-codex-approval-surface="true"]' ? options.noCard ? [] : options.duplicate ? [card, card] : [card] : s === 'button, [role="tab"]' ? [direct] : [], getElementById: () => menu};
  return {document};
}
function probe(options: Record<string, any> = {}, url = 'https://chatgpt.com/c/fresh') {
  const old = {document: globals.document, location: globals.location};
  globals.document = fixture(options).document; globals.location = {href: url};
  try { return pageWake(ticket, 'registration'); } finally { Object.assign(globals, old); }
}

test('materialization approval opens only our exact connector card and its own menu', () => {
  assert.deepEqual(probe(), {url: 'https://chatgpt.com/c/fresh', permissionPending: true, optionsPoint: {x: 1, y: 1}});
  assert.deepEqual(probe({open: true}), {url: 'https://chatgpt.com/c/fresh', permissionPending: true, allowPoint: {x: 1, y: 1}, allowOption: 'Allow crossfeed for this conversation'});
  assert.equal(probe({direct: true}).allowOption, 'Always allow');
});

test('other connectors, prefix collisions, foreign menus and duplicate approval controls fail closed', () => {
  for (const options of [{connector: 'crossfeed-tools'}, {connector: 'Crossfeed'}, {connector: 'crossfeed evil'}, {duplicate: true}, {disabled: true}, {title: 'Unrelated approval'}, {open: true, foreignMenu: true}, {open: true, duplicateOption: true}, {open: true, option: 'Always allow other-app'}]) {
    assert.throws(() => probe(options), /permission_unconfirmed/);
  }
  for (const url of ['https://other.example/c/fresh', 'https://chatgpt.com.evil/c/fresh', 'https://chatgpt.com/c/fresh?x=1']) assert.throws(() => probe({}, url), /page_changed/);
});

test('message content, hidden cards and unrelated global Always allow buttons never yield approval input', () => {
  for (const options of [{messageContent: true}, {hidden: true}, {noCard: true}]) assert.deepEqual(probe(options), {url: 'https://chatgpt.com/c/fresh'});
});
