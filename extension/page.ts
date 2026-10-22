import type { PageAction, PageProbe, PageTicket, Point, PrefillLocationDiagnostic, PrefillProbeResult, PrefillWakeResult } from './types.d.ts';
export { prefillModel } from './prefill-model.ts';

// Serialized into the isolated world. No extension key reaches the page.
// The ordinary wake path is adapted from PiLink's MIT-licensed one-shot
// browser wake. See NOTICE for upstream attribution and license terms.
/**
 * Non-sending native-prefill attestation. The host may authorize an already
 * consumed bare root only for the exact newly-created owned wake tab.
 */
export async function prefillProbe(ticket: PageTicket, allowConsumedRoot = false, timeoutMs = 15000, pollMs = 100): Promise<PrefillProbeResult> {
  const tail = ` wake up. First gateway_exchange: worker_label=${JSON.stringify(ticket.label)} exactly as issued, wake_nonce=${JSON.stringify(ticket.nonce)}, maximum_wait_seconds=20. Then use the server-returned worker_label and repeat wake_nonce=${JSON.stringify(ticket.nonce)} on all subsequent gateway_exchange calls. Poll until state=released and continue=false; do not send a final chat reply between jobs. Return local caller tools as structured tool_calls through gateway_exchange; do not execute them natively.`;
  const prompt = `@${ticket.connector}${tail}`;
  const composerSelector = 'form #prompt-textarea[contenteditable="true"], form [contenteditable="true"][role="textbox"]';
  const mentionSelector = '[contenteditable="false"][app-mention-name][app-mention-path^="app://"], [contenteditable="false"][data-prompt-link-href^="app:"][data-prompt-link-label]';
  const started = Date.now(), deadline = Math.min(ticket.expires_at, started + Math.max(1, Math.min(timeoutMs, 15000)));
  const ownedDocument = document;
  let phase = -1;
  const visible = <E extends Element>(el: E | null | undefined): el is E => !!el && el.isConnected !== false && !el.closest('[hidden], [inert]') &&
    el.getClientRects().length > 0 && (typeof getComputedStyle !== 'function' || !['hidden', 'collapse'].includes(getComputedStyle(el).visibility));
  const all = (root: ParentNode, selector: string): HTMLElement[] => [...root.querySelectorAll(selector)].filter(visible) as HTMLElement[];
  const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
  const nativePhase = (value: unknown): -1 | 0 | 1 | 2 => {
    if (typeof value !== 'string') return -1;
    const home = 'https://chatgpt.com/';
    if (!value.startsWith(home) || value.includes('#')) return -1;
    let url;
    try { url = new URL(value); } catch { return -1; }
    if (url.href !== value || url.protocol !== 'https:' || url.hostname !== 'chatgpt.com' || url.port ||
        url.username || url.password || url.pathname !== '/') return -1;
    if (value === home) return 2;
    if (!url.search || url.search === '?' || url.search.includes('&')) return -1;
    const entries = [...url.searchParams.entries()];
    if (entries.length !== 1) return -1;
    const [key, decoded] = entries[0];
    if (!['q', 'prompt'].includes(key) || !url.search.startsWith(`?${key}=`) || decoded !== prompt) return -1;
    return key === 'q' ? 0 : 1;
  };
  const urlPhase = (): -1 | 0 | 1 | 2 => {
    const next = nativePhase(location.href);
    if (next < 0 || phase >= 0 && next < phase || phase < 0 && next === 2 && !allowConsumedRoot) return -1;
    phase = next;
    return next;
  };
  const queryNames = new Set(['q', 'prompt', 'model', 'temporary-chat', 'hints', 'ref', 'utm_source', 'utm_campaign', 'other']);
  const locationDiagnostic = (): PrefillLocationDiagnostic => {
    const value = typeof location?.href === 'string' ? location.href : undefined;
    let uriClass: PrefillLocationDiagnostic['uri_class'] = 'missing';
    let parsedPhase: -1 | 0 | 1 | 2 = -1;
    let queryCount = 0;
    let names: string[] = [];
    let qMatches = false, promptMatches = false;
    if (value == null) return {uri_class: uriClass, parsed_phase: parsedPhase, query_count: queryCount, query_names: names, q_matches: qMatches, prompt_matches: promptMatches};
    if (value === '' || value === 'about:blank') {
      uriClass = 'blank';
      return {uri_class: uriClass, parsed_phase: parsedPhase, query_count: queryCount, query_names: names, q_matches: qMatches, prompt_matches: promptMatches};
    }
    let url;
    try { url = new URL(value); } catch {
      uriClass = 'other';
      return {uri_class: uriClass, parsed_phase: parsedPhase, query_count: queryCount, query_names: names, q_matches: qMatches, prompt_matches: promptMatches};
    }
    const entries = [...url.searchParams.entries()];
    queryCount = Math.min(8, entries.length);
    names = entries.slice(0, 8).map(([name]) => queryNames.has(name) ? name : 'other');
    qMatches = entries.some(([name, decoded]) => name === 'q' && decoded === prompt);
    promptMatches = entries.some(([name, decoded]) => name === 'prompt' && decoded === prompt);
    parsedPhase = nativePhase(value);
    if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com') uriClass = 'foreign';
    else if (url.username || url.password || url.port) uriClass = 'other';
    else if (url.pathname === '/') {
      if (!url.search) uriClass = 'root';
      else if (parsedPhase === 0) uriClass = 'native_q';
      else if (parsedPhase === 1) uriClass = 'native_prompt';
      else uriClass = 'root_other_query';
    } else if (url.pathname === '/login' || url.pathname.startsWith('/auth/')) uriClass = 'login';
    else if (url.pathname.startsWith('/c/')) uriClass = 'conversation';
    else uriClass = 'other';
    return {uri_class: uriClass, parsed_phase: parsedPhase, query_count: queryCount, query_names: names, q_matches: qMatches, prompt_matches: promptMatches};
  };
  const fail = (error: string, withLocation = false): PrefillProbeResult => ({ready: false, error, ...(withLocation ? {diagnostic: locationDiagnostic()} : {})});
  const editorState = (editor: HTMLElement): -1 | 0 | 1 => {
    if (!visible(editor) || editor.closest('form') == null) return -1;
    const raw = editor.textContent ?? '', links = all(editor, 'a'), fixed = all(editor, '[contenteditable="false"]');
    if (raw === '' && links.length === 0 && fixed.length === 0) return 0;
    if (raw === prompt && links.length === 0 && fixed.length === 0) return 1;
    const chips = all(editor, mentionSelector);
    if (chips.length !== 1 || links.length !== 0 || fixed.length !== 1 || fixed[0] !== chips[0]) return -1;
    const chip = chips[0], chipText = chip.textContent ?? '';
    const legacyName = chip.getAttribute('app-mention-name'), legacyPath = chip.getAttribute('app-mention-path');
    const modernHref = chip.getAttribute('data-prompt-link-href'), modernLabel = chip.getAttribute('data-prompt-link-label');
    const legacy = legacyName !== null || legacyPath !== null, modern = modernHref !== null || modernLabel !== null;
    if (legacy === modern) return -1;
    if (legacy && (legacyName !== ticket.connector || !/^app:\/\/[A-Za-z0-9_-]{1,128}$/.test(legacyPath ?? ''))) return -1;
    if (modern && (![ticket.connector, `@${ticket.connector}`].includes(modernLabel ?? '') || !/^app:[A-Za-z0-9_./-]{1,256}$/.test(modernHref ?? ''))) return -1;
    if (![ticket.connector, `@${ticket.connector}`].includes(chipText)) return -1;
    return raw.startsWith(chipText) && raw.slice(chipText.length) === tail ? 1 : -1;
  };
  while (Date.now() < deadline) {
    if (document !== ownedDocument || ticket.expires_at <= Date.now()) return fail('page_changed');
    if (urlPhase() < 0) return fail('page_changed', true);
    const limited = all(document, '[role="alert"], [role="dialog"], [role="status"]').some(el =>
      !el.closest('nav, aside, [role="navigation"], [data-testid^="conversation-turn"], [data-message-author-role]') &&
      /too many requests|you['’]ve reached|rate limit/i.test((el.textContent ?? '').replace(/\s+/g, ' ').trim()));
    if (limited) return fail('rate_limited');
    const editors = all(document, composerSelector);
    if (editors.length > 1) return fail('composer_not_empty');
    if (editors.length === 0) { await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now()))); continue; }
    const state = editorState(editors[0]);
    if (state === 0) { await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now()))); continue; }
    if (state < 0) return fail('composer_not_empty');
    const form = editors[0].closest('form');
    if (!form) return fail('page_not_ready');
    const attachments = all(form, '[data-testid*="attachment"], img');
    const files = [...document.querySelectorAll('input[type="file"]')] as HTMLInputElement[];
    if (attachments.length || files.some(input => input.files?.length) || all(document, 'button[data-testid="stop-button"], button[aria-label="Stop generating"]').length) return fail('composer_not_empty');
    const current = urlPhase();
    if (document !== ownedDocument) return fail('page_changed');
    if (current < 0) return fail('page_changed', true);
    return {ready: true, phase: current as 0 | 1 | 2};
  }
  return fail(ticket.expires_at <= Date.now() ? 'expired' : 'page_not_ready');
}

export async function prefillWake(ticket: PageTicket, timeoutMs = 15000, pollMs = 100, initialPhase = -1): Promise<PrefillWakeResult> {
  const tail = ` wake up. First gateway_exchange: worker_label=${JSON.stringify(ticket.label)} exactly as issued, wake_nonce=${JSON.stringify(ticket.nonce)}, maximum_wait_seconds=20. Then use the server-returned worker_label and repeat wake_nonce=${JSON.stringify(ticket.nonce)} on all subsequent gateway_exchange calls. Poll until state=released and continue=false; do not send a final chat reply between jobs. Return local caller tools as structured tool_calls through gateway_exchange; do not execute them natively.`;
  const prompt = `@${ticket.connector}${tail}`;
  const composerSelector = 'form #prompt-textarea[contenteditable="true"], form [contenteditable="true"][role="textbox"]';
  const sendSelector = 'button[data-testid="send-button"], button#composer-submit-button, button[data-testid="composer-submit-button"], button[aria-label="Send prompt"], button[aria-label="Send message"], button[aria-label="Send"][type="submit"]';
  const mentionSelector = '[contenteditable="false"][app-mention-name][app-mention-path^="app://"], [contenteditable="false"][data-prompt-link-href^="app:"][data-prompt-link-label]';
  const started = Date.now(), deadline = Math.min(ticket.expires_at, started + Math.max(1, Math.min(timeoutMs, 15000)));
  const ownedDocument = document;
  let phase = Number.isInteger(initialPhase) && initialPhase >= 0 && initialPhase <= 2 ? initialPhase : -1, sealed = false;
  let pinned: HTMLElement | null = null;

  const visible = <E extends Element>(el: E | null | undefined): el is E => !!el && el.isConnected !== false && !el.closest('[hidden], [inert]') &&
    el.getClientRects().length > 0 && (typeof getComputedStyle !== 'function' || !['hidden', 'collapse'].includes(getComputedStyle(el).visibility));
  const all = (root: ParentNode, selector: string): HTMLElement[] => [...root.querySelectorAll(selector)].filter(visible) as HTMLElement[];
  const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
  const fail = (error: string): PrefillWakeResult => ({sent: false, error});

  const nativePhase = (value: unknown): -1 | 0 | 1 | 2 => {
    if (typeof value !== 'string') return -1;
    const home = 'https://chatgpt.com/';
    if (!value.startsWith(home) || value.includes('#')) return -1;
    let url;
    try { url = new URL(value); } catch { return -1; }
    if (url.href !== value || url.protocol !== 'https:' || url.hostname !== 'chatgpt.com' || url.port ||
        url.username || url.password || url.pathname !== '/') return -1;
    if (value === home) return 2;
    if (!url.search || url.search === '?' || url.search.includes('&')) return -1;
    const entries = [...url.searchParams.entries()];
    if (entries.length !== 1) return -1;
    const [key, decoded] = entries[0];
    if (!['q', 'prompt'].includes(key) || !url.search.startsWith(`?${key}=`) || decoded !== prompt) return -1;
    return key === 'q' ? 0 : 1;
  };
  const urlPhase = (): -1 | 0 | 1 | 2 => {
    const next = nativePhase(location.href);
    if (next < 0 || phase >= 0 && next < phase) return -1;
    // With no host-acquired phase, a restored root draft is never authority.
    if (phase < 0 && next === 2) return -1;
    phase = next;
    return next;
  };

  const exactEditor = (editor: HTMLElement): boolean => {
    if (!visible(editor) || editor.closest('form') == null) return false;
    const raw = editor.textContent ?? '';
    const links = all(editor, 'a');
    const fixed = all(editor, '[contenteditable="false"]');
    const chips = all(editor, mentionSelector);
    if (raw === prompt && links.length === 0 && fixed.length === 0) return true;
    if (chips.length !== 1 || links.length !== 0 || fixed.length !== 1 || fixed[0] !== chips[0]) return false;
    const chip = chips[0], chipText = chip.textContent ?? '';
    const legacyName = chip.getAttribute('app-mention-name'), legacyPath = chip.getAttribute('app-mention-path');
    const modernHref = chip.getAttribute('data-prompt-link-href'), modernLabel = chip.getAttribute('data-prompt-link-label');
    const legacy = legacyName !== null || legacyPath !== null, modern = modernHref !== null || modernLabel !== null;
    if (legacy === modern) return false;
    if (legacy && (legacyName !== ticket.connector || !/^app:\/\/[A-Za-z0-9_-]{1,128}$/.test(legacyPath ?? ''))) return false;
    if (modern && (![ticket.connector, `@${ticket.connector}`].includes(modernLabel ?? '') || !/^app:[A-Za-z0-9_./-]{1,256}$/.test(modernHref ?? ''))) return false;
    if (![ticket.connector, `@${ticket.connector}`].includes(chipText)) return false;
    return raw.startsWith(chipText) && raw.slice(chipText.length) === tail;
  };

  try {
    while (Date.now() < deadline) {
      if (document !== ownedDocument || ticket.expires_at <= Date.now() || urlPhase() < 0) return fail('page_changed');
      const limited = all(document, '[role="alert"], [role="dialog"], [role="status"]').some(el =>
        !el.closest('nav, aside, [role="navigation"], [data-testid^="conversation-turn"], [data-message-author-role]') &&
        /too many requests|you['’]ve reached|rate limit/i.test((el.textContent ?? '').replace(/\s+/g, ' ').trim()));
      if (limited) return fail('rate_limited');

      const editors = all(document, composerSelector);
      if (editors.length > 1) return fail('composer_not_empty');
      if (editors.length === 0) { await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now()))); continue; }
      const editor = editors[0];
      const raw = editor.textContent ?? '', fixed = all(editor, '[contenteditable="false"]'), links = all(editor, 'a');
      if (raw === '' && fixed.length === 0 && links.length === 0) { await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now()))); continue; }
      if (!exactEditor(editor)) return fail('composer_not_empty');

      if (editor !== pinned) {
        if (pinned !== null && pinned.isConnected !== false) return fail('page_changed');
        if (typeof editor.focus !== 'function') return fail('page_not_ready');
        editor.focus();
        pinned = editor;
      }
      const connected = () => editor.isConnected !== false;
      if (document !== ownedDocument || !connected() || urlPhase() < 0) {
        if (!connected()) { await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now()))); continue; }
        return fail('page_changed');
      }
      if (!connected() || !exactEditor(editor) || document.activeElement !== editor) return fail('composer_not_empty');

      const form = editor.closest('form');
      if (!form) return fail('page_not_ready');
      const attachments = all(form, '[data-testid*="attachment"], img');
      const files = [...document.querySelectorAll('input[type="file"]')] as HTMLInputElement[];
      if (attachments.length || files.some(input => input.files?.length) || all(document, 'button[data-testid="stop-button"], button[aria-label="Stop generating"]').length) return fail('composer_not_empty');

      const sends = all(form, sendSelector) as HTMLButtonElement[];
      if (sends.length > 1) return fail('send_unconfirmed');
      if (sends.length === 0 || sends[0].disabled || sends[0].getAttribute('aria-disabled') === 'true') {
        await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now()))); continue;
      }
      const button = sends[0], buttonConnected = () => button.isConnected !== false;
      if (document !== ownedDocument || urlPhase() < 0 || !connected() || !exactEditor(editor) ||
          document.activeElement !== editor || !buttonConnected() || button.closest('form') !== form ||
          typeof button.click !== 'function') return fail('send_unconfirmed');

      const root = document.documentElement;
      if (!root || root.getAttribute('data-crossfeed-wake-sealed') != null) return fail('send_unconfirmed');
      root.setAttribute('data-crossfeed-wake-sealed', ticket.nonce);
      sealed = true;
      // Revalidate after the page seal. The host seals its attempt before this
      // function is injected, so a lost execution reply cannot authorize retry.
      if (document !== ownedDocument || urlPhase() < 0 || !connected() || !exactEditor(editor) ||
          document.activeElement !== editor || !buttonConnected() || button.closest('form') !== form) throw Error('send_unconfirmed');
      button.click();
      return {sent: true, url: location.href};
    }
    return fail(ticket.expires_at <= Date.now() ? 'expired' : 'page_not_ready');
  } catch {
    if (sealed) throw Error('send_unconfirmed');
    return fail('browser_error');
  }
}

/**
 * Click only a previously observed connector-owned approval control.
 */
export function pagePermission(ticket: PageTicket, choice: string, expectedURL: string): boolean {
  const text = (el: Element | null | undefined): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const visible = <E extends Element>(el: E | null | undefined): el is E => !!el && el.isConnected !== false && !el.closest('[hidden], [inert]') && el.getClientRects().length > 0 && (typeof getComputedStyle !== 'function' || !['hidden', 'collapse'].includes(getComputedStyle(el).visibility));
  const all = (root: ParentNode, selector: string): HTMLElement[] => [...root.querySelectorAll(selector)].filter(visible) as HTMLElement[];
  if (ticket.expires_at <= Date.now() || location.href !== expectedURL ||
      !/^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9-]{1,128}$/.test(expectedURL)) return false;
  const cards = all(document, '[data-codex-approval-surface="true"]').filter(el =>
    !el.closest('nav, aside, [contenteditable], [data-message-author-role], .markdown'));
  if (cards.length !== 1) return false;
  const card = cards[0], alerts = all(card, '[role="alert"]');
  if (alerts.length !== 1 || text(all(alerts[0], 'span')[0]) !== ticket.connector) return false;
  const materialization = all(alerts[0], 'div').some(el => text(el) === 'Allow file materialization?');
  const direct = (all(card, 'button') as HTMLButtonElement[]).filter(el =>
    text(el) === 'Always allow' && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
  let button: HTMLElement | null = null;
  if (choice === 'Always allow') {
    if (direct.length !== 1) return false;
    button = direct[0];
  } else {
    if (!materialization || direct.length) return false;
    const options = all(card, 'button[aria-label="Approval options"][aria-haspopup="menu"]') as HTMLButtonElement[];
    if (options.length !== 1 || options[0].disabled || options[0].getAttribute('aria-disabled') === 'true') return false;
    if (choice === 'options') {
      if (options[0].getAttribute('aria-expanded') === 'true') return false;
      button = options[0];
    } else {
      if (choice !== `Allow ${ticket.connector} for this conversation` || options[0].getAttribute('aria-expanded') !== 'true') return false;
      const menuId = options[0].getAttribute('aria-controls'), menu = menuId ? document.getElementById(menuId) : null;
      if (!visible(menu) || menu.getAttribute('role') !== 'menu' || menu.getAttribute('aria-labelledby') !== options[0].id) return false;
      const matches = all(menu, '[role="menuitem"]').filter(el => text(el) === choice && el.getAttribute('aria-disabled') !== 'true');
      if (matches.length !== 1) return false;
      button = matches[0];
    }
  }
  if (!button || !visible(button) || typeof button.click !== 'function') return false;
  button.click();
  return true;
}

export function pageWake(ticket: PageTicket, action: PageAction): PageProbe {
  const text = (el: Element | null | undefined): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const visible = <E extends Element>(el: E | null | undefined): el is E => !!el && el.isConnected !== false && !el.closest('[hidden], [inert]') && el.getClientRects().length > 0 && (typeof getComputedStyle !== 'function' || !['hidden', 'collapse'].includes(getComputedStyle(el).visibility));
  const all = (root: ParentNode, selector: string): HTMLElement[] => [...root.querySelectorAll(selector)].filter(visible) as HTMLElement[];
  const one = (root: ParentNode, selector: string): HTMLElement | null => { const found = all(root, selector); return found.length === 1 ? found[0] : null; };
  const point = (el: Element | null | undefined): Point | null => { if (!visible(el)) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
  const focus = (el: HTMLElement | null | undefined): boolean => { if (!el) return false; el.focus(); return document.activeElement === el; };
  const selected = (el: Element | null | undefined): boolean => el?.getAttribute('aria-pressed') === 'true' || el?.getAttribute('aria-selected') === 'true' || el?.getAttribute('data-state') === 'active';
  const home = 'https://chatgpt.com/';
  if (action !== 'discardOwnDraft' && action !== 'discardBareMention' && ticket.expires_at <= Date.now()) throw Error('expired');
  if (location.href !== home && !(action === 'registration' && /^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9-]{1,128}$/.test(location.href))) throw Error('page_changed');
  // ChatGPT's current ProseMirror textbox has no ID. Require one visible,
  // form-owned editor so another editable field cannot receive trusted input.
  const editor = one(document, 'form #prompt-textarea[contenteditable="true"], form [contenteditable="true"][role="textbox"]');
  if (action === 'discardOwnDraft' || action === 'discardBareMention') {
    // A bare mention carries no words of the owner's, so it can only be wake residue.
    const mine = action === 'discardBareMention'
      ? (text: string) => text.trim().toLowerCase() === `@${ticket.connector}`.toLowerCase()
      : (text: string) => text.startsWith(`@${ticket.connector}`);
    if (!editor?.isContentEditable || !mine(editor.textContent ?? '') || !focus(editor)) return {};
    const selection = document.getSelection();
    if (!selection) return {};
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges(); selection.addRange(range);
    // Native editing updates ProseMirror and its persisted draft together.
    document.execCommand('delete');
    return {empty: editor.textContent === ''};
  }
  const limited = all(document, '[role="alert"], [role="dialog"], [role="status"]').some(el =>
    !el.closest('nav, aside, [role="navigation"], [data-testid^="conversation-turn"], [data-message-author-role]') &&
    /too many requests|you['’]ve reached|rate limit/i.test(text(el)));
  if (limited) return { rateLimited: true };
  const model = one(document, 'button[aria-label="Select ChatGPT model"], [data-testid="model-switcher-dropdown-button"]');
  const buttons = all(document, 'button, [role="tab"]');
  const chat = buttons.find(b => text(b) === 'Chat'), work = buttons.find(b => text(b) === 'Work');
  const modes: boolean[] = [];
  if (chat && work && chat.parentElement === work.parentElement) {
    if (selected(chat) !== selected(work)) modes.push(selected(chat));
    for (const el of all(chat.parentElement as HTMLElement, '[style]')) {
      const m = (el.getAttribute('style') ?? '').match(/(?:translateX\(\s*(0|100)%\s*\)|translate(?:\s*:\s*|\(\s*)(0|100)%)/i);
      if (m) modes.push((m[1] ?? m[2]) === '0');
    }
  }
  const chatMode = modes.length && modes.every(Boolean) && !selected(work);
  const ready = !!editor?.isContentEditable && !!model;
  if (action === 'ready') return { ready, chat: !!chatMode, chatPoint: point(chat), empty: editor?.textContent === '', url: location.href };
  if (action === 'registration') {
    // Approval cards belong to ChatGPT, never rendered message content. A menu
    // may live in a portal, so bind it through this card's Approval options ID.
    const cards = all(document, '[data-codex-approval-surface="true"]').filter(el =>
      !el.closest('nav, aside, [contenteditable], [data-message-author-role], .markdown'));
    if (!cards.length) return {url: location.href};
    if (cards.length !== 1) throw Error('permission_unconfirmed');
    const card = cards[0], alert = one(card, '[role="alert"]');
    if (!alert || text(all(alert, 'span')[0]) !== ticket.connector) throw Error('permission_unconfirmed');
    const materialization = all(alert, 'div').some(el => text(el) === 'Allow file materialization?');
    const direct = all(card, 'button').filter(el => text(el) === 'Always allow');
    if (direct.length === 1 && !(direct[0] as HTMLButtonElement).disabled && direct[0].getAttribute('aria-disabled') !== 'true') return {url: location.href, permissionPending: true, allowPoint: point(direct[0]), allowOption: 'Always allow'};
    if (!materialization || direct.length) throw Error('permission_unconfirmed');
    const options = one(card, 'button[aria-label="Approval options"][aria-haspopup="menu"]');
    if (!options || options.getAttribute('aria-disabled') === 'true' || (options as HTMLButtonElement).disabled) throw Error('permission_unconfirmed');
    const menuId = options.getAttribute('aria-controls');
    if (options.getAttribute('aria-expanded') !== 'true') return {url: location.href, permissionPending: true, optionsPoint: point(options)};
    const menu = menuId ? document.getElementById(menuId) : null;
    if (!visible(menu) || menu.getAttribute('role') !== 'menu' || menu.getAttribute('aria-labelledby') !== options.id) throw Error('permission_unconfirmed');
    const option = `Allow ${ticket.connector} for this conversation`;
    const matches = all(menu, '[role="menuitem"]').filter(el => text(el) === option && el.getAttribute('aria-disabled') !== 'true');
    if (matches.length !== 1) throw Error('permission_unconfirmed');
    return {url: location.href, permissionPending: true, allowPoint: point(matches[0]), allowOption: option};
  }
  if (!ready) throw Error('page_not_ready');
  if (!chatMode) throw Error('mode_unconfirmed');
  if (action === 'modelFocus') return { focused: focus(model), modelPoint: point(model) };
  if (action === 'picker') {
    const menu = one(document, '[role="menu"]');
    if (!menu) return { open: false };
    // The inactive list still records the selected model while the slider is
    // shown. Read that state, but point() refuses input into its inert track.
    const rows = [...menu.querySelectorAll('[role="menuitemradio"]')] as HTMLElement[];
    const matches = rows.filter(el => text(el) === ticket.row || all(el, 'span').some(s => text(s) === ticket.row));
    const row = matches.length === 1 ? matches[0] : null;
    const slider = one(menu, '[role="slider"]');
    return { open: true, row: row?.getAttribute('aria-checked') === 'true' ? ticket.row : null,
      rowPoint: point(row), viewPoint: point(one(document, '[data-model-picker-view-toggle="true"]')),
      minimum: slider?.getAttribute('aria-valuemin'), maximum: slider?.getAttribute('aria-valuemax'),
      position: slider && /^[0-4]$/.test(slider.getAttribute('aria-valuenow') ?? '') ? Number(slider.getAttribute('aria-valuenow')) : null,
      status: all(menu, '[role="status"]').map(text).find(s => / of /i.test(s)) ?? null };
  }
  if (action === 'sliderFocus') return { focused: focus(one(document, '[role="menu"] [data-reasoning-slider="true"]')) };
  const form = editor.closest('form');
  const attachmentNodes = form ? all(form, '[data-testid*="attachment"]') : [];
  const attachmentRoots = attachmentNodes.filter(el => !attachmentNodes.some(parent => parent !== el && parent.contains?.(el)));
  const fileInputs = [...document.querySelectorAll('input[type="file"]')] as HTMLInputElement[];
  const ownedFiles = () => {
    if (!form || ticket.type !== 'composer' || !Array.isArray(ticket.attachments)) throw Error('composer_not_empty');
    const attachments = ticket.attachments;
    const expected = attachments.map(file => file.name);
    for (const input of fileInputs) {
      if (input.closest('form') !== form && input.files?.length) throw Error('composer_not_empty');
      if ([...(input.files ?? [])].some(file => !expected.includes(file.name) || !attachments.some(item => item.name === file.name && item.bytes === file.size))) throw Error('composer_not_empty');
    }
    const names = attachmentRoots.map(chip => {
      const matches = expected.filter(name => text(chip) === name || chip.getAttribute('title') === name ||
        all(chip, 'span, [title], [aria-label]').some(el => text(el) === name || el.getAttribute('title') === name || el.getAttribute('aria-label') === name));
      if (matches.length !== 1) throw Error('composer_not_empty');
      return matches[0];
    });
    if (new Set(names).size !== names.length) throw Error('composer_not_empty');
    if (attachmentRoots.some(chip => all(chip, '[role="alert"], [data-testid*="error"]').length || /upload failed|could not upload|unsupported file/i.test(text(chip)))) throw Error('upload_failed');
    const images = all(form, 'img');
    if (images.some(img => !attachmentRoots.some(chip => chip.contains?.(img)))) throw Error('composer_not_empty');
    const completed = names.length === expected.length && attachmentRoots.every(chip =>
      chip.getAttribute('aria-busy') !== 'true' && !all(chip, '[role="progressbar"], [aria-busy="true"], [data-testid*="loading"], [data-testid*="spinner"]').length &&
      !/uploading|processing/i.test(text(chip)) &&
      all(chip, 'button[data-testid="remove-attachment"], button[aria-label="Remove file"], button[aria-label="Remove attachment"]').some(button => !(button as HTMLButtonElement).disabled));
    return {ready: completed};
  };
  if (action === 'uploadInput') {
    const uploadSelector = 'form input[type="file"][aria-label="Attach files"]';
    const uploads = [...document.querySelectorAll(uploadSelector)] as HTMLInputElement[];
    if (ticket.type !== 'composer' || !form || uploads.length !== 1 || uploads[0].closest('form') !== form || uploads[0].disabled) throw Error('upload_unconfirmed');
    if (attachmentRoots.length || all(form, 'img').length || fileInputs.some(el => el.files?.length) || all(document, 'button[data-testid="stop-button"]').length) throw Error('composer_not_empty');
    return {ready: true, uploadSelector};
  }
  if (action === 'uploads') return ownedFiles();
  if (action === 'editorFocus') {
    if (editor.textContent !== '' || all(document, 'button[data-testid="stop-button"]').length) throw Error('composer_not_empty');
    if (!form || attachmentRoots.length || all(form, 'img').length || fileInputs.some(el => el.files?.length)) throw Error('composer_not_empty');
    return { focused: focus(editor) };
  }
  const chips = all(editor, '[contenteditable="false"][data-type="mention"][data-mention-type="connector"], [contenteditable="false"][data-type="mention"][data-app-id], [contenteditable="false"][data-type="app-mention"], [contenteditable="false"][data-testid="connector-mention"], [contenteditable="false"][app-mention-name][app-mention-path^="app://"]');
  const chip = chips.length === 1 ? chips[0] : null;
  const appName = chip?.getAttribute('app-mention-name');
  const resolved = !!chip && [ticket.connector, `@${ticket.connector}`].includes(text(chip)) &&
    (appName == null || appName === ticket.connector && /^app:\/\/[A-Za-z0-9_-]{1,128}$/.test(chip.getAttribute('app-mention-path') ?? ''));
  if (action === 'mention') {
    // Only a composer-owned popup or an exact connector button, as in PiLink's live sequence.
    const owned = (editor.getAttribute('aria-controls') ?? '').split(/\s+/).map(id => document.getElementById(id)).filter(visible);
    const options = owned.flatMap(root => all(root, '[role="option"], [role="menuitem"], button'));
    const connectorButtons = buttons.filter(b => !b.closest('nav, aside, [role="navigation"], [contenteditable]') && all(b, 'span').some(s => text(s) === ticket.connector));
    const matches = [...new Set([...options, ...connectorButtons])].filter(b => text(b) === ticket.connector || all(b, 'span').some(s => text(s) === ticket.connector));
    return { mentionPoint: matches.length === 1 ? point(matches[0]) : null };
  }
  if (action === 'resolved') {
    const tail = resolved && editor.textContent!.slice(chips[0].textContent!.length);
    return { resolved: !!resolved && /^\s*$/.test(tail as string), focused: !!resolved && focus(editor) };
  }
  if (action === 'send') {
    const tail = resolved && editor.textContent!.slice(chips[0].textContent!.length);
    const message = ticket.type === 'composer' ? `process exactly job ${ticket.job_id} as ${ticket.label}. Call gateway_exchange with worker_label=${JSON.stringify(ticket.label)}, request_id=${JSON.stringify(ticket.job_id)} and maximum_wait_seconds=1 to fetch this job only. Use these uploaded attachments with its request, submit its answer with request_id and claim_token, then stop when released.` : `wake up as ${ticket.label}`;
    if (!resolved || !editor.textContent!.startsWith(chips[0].textContent!) || (tail as string).trim() !== message) throw Error('mention_unconfirmed');
    const send = form && one(form, 'button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send message"], button[aria-label="Send"]');
    if (ticket.type === 'composer') { if (!ownedFiles().ready) throw Error('upload_unconfirmed'); }
    else if (form && (attachmentRoots.length || all(form, 'img').length || fileInputs.some(el => el.files?.length))) throw Error('composer_not_empty');
    if (!send || (send as HTMLButtonElement).disabled || all(document, 'button[data-testid="stop-button"]').length || !focus(editor)) throw Error('send_unconfirmed');
    return { ready: true };
  }
  throw Error('page_not_ready');
}
