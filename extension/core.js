import { pageWake, prefillProbe, prefillModel, prefillWake, pagePermission } from './page.js';
import { ensurePairing } from './pairing.js';

/** @typedef {import('./types.js').Ticket} Ticket */
/** @typedef {import('./types.js').PageTicket} PageTicket */
/** @typedef {import('./types.js').PageProbe} PageProbe */
/** @typedef {import('./types.js').PageAction} PageAction */
/** @typedef {import('./types.js').PrefillProbeResult} PrefillProbeResult */
/** @typedef {import('./types.js').PrefillWakeResult} PrefillWakeResult */

/** @param {unknown} value @returns {string | null} */
export function savedChatURL(value) {
  if (typeof value !== 'string' || !/^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9-]{1,128}$/.test(value)) return null;
  try { return new URL(value).href === value ? value : null; } catch { return null; }
}

// ChatGPT briefly uses a local conversation ID before the saved chat exists.
// This is a wait-only route after Enter, never an input target or saved URL.
/** @param {unknown} value @returns {boolean} */
function pendingChatURL(value) {
  return typeof value === 'string' && /^https:\/\/chatgpt\.com\/c\/local-chatgpt%3[Aa][0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value);
}

/** @param {unknown} value @param {string} prompt @returns {-1 | 0 | 1 | 2} */
function ordinaryWakePhase(value, prompt) {
  if (typeof value !== 'string') return -1;
  const home = 'https://chatgpt.com/';
  // Keep authority/path serialization exact while allowing equivalent
  // canonical query encoding (for example '+' versus '%20').
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
}

const wakeDiagnosticCheckpoints = new Set(['tab_wait', 'probe_result', 'probe_binding', 'before_send']);
const wakeDiagnosticStatuses = new Set(['complete', 'loading', 'missing', 'other']);
const wakeDiagnosticURIClasses = new Set(['missing', 'blank', 'native_q', 'native_prompt', 'root', 'root_other_query', 'login', 'conversation', 'foreign', 'other']);
const wakeDiagnosticQueryNames = new Set(['q', 'prompt', 'model', 'temporary-chat', 'hints', 'ref', 'utm_source', 'utm_campaign', 'other']);

/** @param {unknown} value @param {string} prompt */
function wakeURLDiagnostic(value, prompt) {
  let uriClass = 'missing', parsedPhase = -1, queryCount = 0;
  /** @type {string[]} */
  let queryNames = [];
  let qMatches = false, promptMatches = false;
  if (value == null) return {uri_class: uriClass, parsed_phase: parsedPhase, query_count: queryCount, query_names: queryNames, q_matches: qMatches, prompt_matches: promptMatches};
  if (value === '' || value === 'about:blank') {
    uriClass = 'blank';
    return {uri_class: uriClass, parsed_phase: parsedPhase, query_count: queryCount, query_names: queryNames, q_matches: qMatches, prompt_matches: promptMatches};
  }
  if (typeof value !== 'string') {
    uriClass = 'other';
    return {uri_class: uriClass, parsed_phase: parsedPhase, query_count: queryCount, query_names: queryNames, q_matches: qMatches, prompt_matches: promptMatches};
  }
  let url;
  try { url = new URL(value); } catch {
    uriClass = 'other';
    return {uri_class: uriClass, parsed_phase: parsedPhase, query_count: queryCount, query_names: queryNames, q_matches: qMatches, prompt_matches: promptMatches};
  }
  const entries = [...url.searchParams.entries()];
  queryCount = Math.min(8, entries.length);
  queryNames = entries.slice(0, 8).map(([name]) => wakeDiagnosticQueryNames.has(name) ? name : 'other');
  qMatches = entries.some(([name, decoded]) => name === 'q' && decoded === prompt);
  promptMatches = entries.some(([name, decoded]) => name === 'prompt' && decoded === prompt);
  parsedPhase = ordinaryWakePhase(value, prompt);
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
  return {uri_class: uriClass, parsed_phase: parsedPhase, query_count: queryCount, query_names: queryNames, q_matches: qMatches, prompt_matches: promptMatches};
}

/** @param {import('./types.js').Tab | undefined} tab @param {string} prompt */
function wakeTabDiagnostic(tab, prompt) {
  const status = tab?.status == null ? 'missing' : wakeDiagnosticStatuses.has(tab.status) ? tab.status : 'other';
  return {
    status,
    current: wakeURLDiagnostic(tab?.url, prompt),
    pending: wakeURLDiagnostic(tab?.pendingUrl, prompt),
    hasPending: typeof tab?.pendingUrl === 'string' && tab.pendingUrl.length > 0,
  };
}

/** @param {unknown} value */
function safeWakeURLDiagnostic(value) {
  const input = value && typeof value === 'object' ? /** @type {Record<string, unknown>} */ (value) : {};
  const uriClass = typeof input.uri_class === 'string' && wakeDiagnosticURIClasses.has(input.uri_class) ? input.uri_class : 'other';
  const phase = Number(input.parsed_phase);
  const parsedPhase = Number.isInteger(phase) && phase >= -1 && phase <= 2 ? phase : -1;
  const count = Number(input.query_count);
  const queryCount = Number.isInteger(count) ? Math.max(0, Math.min(8, count)) : 0;
  const queryNames = Array.isArray(input.query_names) ? input.query_names.slice(0, 8).map(name =>
    typeof name === 'string' && wakeDiagnosticQueryNames.has(name) ? name : 'other') : [];
  return {
    uri_class: uriClass, parsed_phase: parsedPhase, query_count: queryCount, query_names: queryNames,
    q_matches: input.q_matches === true, prompt_matches: input.prompt_matches === true,
  };
}

/** @param {unknown} candidate @param {string} failureCode @param {number} timestamp */
function safeWakeDiagnostic(candidate, failureCode, timestamp) {
  const input = candidate && typeof candidate === 'object' ? /** @type {Record<string, unknown>} */ (candidate) : {};
  if (typeof input.checkpoint !== 'string' || !wakeDiagnosticCheckpoints.has(input.checkpoint)) return null;
  const status = typeof input.status === 'string' && wakeDiagnosticStatuses.has(input.status) ? input.status : 'other';
  const probeInput = input.probe && typeof input.probe === 'object' ? /** @type {Record<string, unknown>} */ (input.probe) : {};
  const probePhaseRaw = Number(probeInput.phase);
  const probePhase = Number.isInteger(probePhaseRaw) && probePhaseRaw >= -1 && probePhaseRaw <= 2 ? probePhaseRaw : -1;
  const output = {
    revision: 'revision1',
    timestamp: Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : Date.now(),
    checkpoint: input.checkpoint,
    failure_code: reasons.has(failureCode) ? failureCode : 'browser_error',
    status,
    current: safeWakeURLDiagnostic(input.current),
    pending: safeWakeURLDiagnostic(input.pending),
    hasPending: input.hasPending === true,
    probe: {
      executed: probeInput.executed === true,
      ready: probeInput.ready === true,
      phase: probePhase,
      documentIdPresent: probeInput.documentIdPresent === true,
    },
  };
  if (input.probe_location && typeof input.probe_location === 'object') {
    Object.assign(output, {probe_location: safeWakeURLDiagnostic(input.probe_location)});
  }
  return output;
}

/** @param {import('./types.js').PollBrowser} browser @param {unknown} candidate @param {string} failureCode @param {number} timestamp */
async function persistWakeDiagnostic(browser, candidate, failureCode, timestamp) {
  const diagnostic = safeWakeDiagnostic(candidate, failureCode, timestamp);
  const set = browser.storage?.local?.set;
  if (!diagnostic || typeof set !== 'function') return;
  try {
    await set.call(browser.storage.local, {crossfeedWakeDiagnostic: 'CFWAKE_DIAG_V1' + JSON.stringify(diagnostic)});
  } catch { /* Best-effort diagnostics never affect wake failure handling. */ }
}

/** @param {unknown} value @returns {string | null} */
export function apiURL(value) {
  if (typeof value !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(value)) return null;
  try { return new URL(value).origin === value ? value : null; } catch { return null; }
}

/** @param {unknown} input @param {number} [now] @returns {input is Ticket} */
export function validTicket(input, now = Date.now()) {
  // Interpret untrusted JSON only inside the validator; every ticket field is checked below.
  const ticket = /** @type {Ticket | null | undefined} */ (input);
  /** @param {unknown} value @param {number} limit @returns {value is string} */
  const line = (value, limit) => typeof value === 'string' && value.length > 0 &&
    new TextEncoder().encode(value).length <= limit && value.trim() === value && !/\p{C}/u.test(value);
  const composer = ticket?.type === 'composer';
  const attachments = ticket?.attachments;
  const validFiles = Array.isArray(attachments) && attachments.length > 0 && attachments.length <= 10 &&
    attachments.every(file => file && line(file.name, 255) && !/[\\/]/.test(file.name) && !['.', '..'].includes(file.name) &&
      typeof file.path === 'string' && file.path.startsWith('/') && !/[\\]/.test(file.path) && !/\p{C}/u.test(file.path) &&
      !file.path.split('/').some(part => part === '.' || part === '..') && !file.path.includes('//') &&
      file.path.split('/').at(-1) === file.name && file.path.length <= 4096 &&
      line(file.mime, 128) && Number.isSafeInteger(file.bytes) && file.bytes > 0 && file.bytes <= 20 * 1024 * 1024) &&
    new Set(attachments.map(file => file.path)).size === attachments.length &&
    new Set(attachments.map(file => file.name)).size === attachments.length &&
    attachments.reduce((sum, file) => sum + file.bytes, 0) <= 50 * 1024 * 1024;
  const validTitle = ticket?.title === undefined || typeof ticket.title === 'string' &&
    Array.from(ticket.title).length <= 80 && new TextEncoder().encode(ticket.title).length <= 320 &&
    ticket.title === ticket.title.trim() && !/\p{C}/u.test(ticket.title);
  return !!ticket && (ticket.wake_mode === undefined || ['configured', 'native'].includes(ticket.wake_mode)) && (ticket.type === undefined || composer) &&
    (composer ? /^[A-Za-z0-9_-]{1,64}$/.test(ticket.job_id ?? '') && validFiles : ticket.attachments === undefined && ticket.job_id === undefined) && /^[A-Za-z0-9_-]{32}$/.test(ticket.nonce ?? '') &&
    line(ticket.row, 128) && Number.isInteger(ticket.level) && ticket.level >= 0 && ticket.level <= 4 &&
    line(ticket.label, 128) && line(ticket.connector, 80) && !ticket.connector.includes('@') && validTitle &&
    Number.isSafeInteger(ticket.expires_at) && ticket.expires_at > now;
}

/**
 * The signed-in ChatGPT bearer token, read from the trusted extension service worker.
 * @param {AbortSignal} signal
 * @returns {Promise<string | null>}
 */
async function chatgptToken(signal) {
  const session = await fetch('https://chatgpt.com/api/auth/session', {credentials: 'include', redirect: 'error', cache: 'no-store', signal});
  if (!session.ok) return null;
  const token = (/** @type {{accessToken?: unknown}} */ (await session.json())).accessToken;
  return typeof token === 'string' && token ? token : null;
}

/**
 * @param {string} token @param {string} id @param {boolean} remove @param {AbortSignal} signal
 * @returns {Promise<boolean>}
 */
async function disposeConversation(token, id, remove, signal) {
  const response = await fetch('https://chatgpt.com/backend-api/conversation/' + id, {
    credentials: 'include', redirect: 'error', cache: 'no-store', signal, method: 'PATCH',
    headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json'},
    body: JSON.stringify(remove ? {is_visible: false} : {is_archived: true}),
  });
  // A conversation that is already gone (owner or lead deleted it) is disposed: never retry it forever.
  return response.ok || response.status === 404;
}

/**
 * Run ChatGPT's archive request from the trusted extension service worker.
 * @param {string} url @param {number} [timeoutMs] @param {boolean} [remove]
 */
export async function archiveConversation(url, timeoutMs = 15000, remove = false) {
  if (!savedChatURL(url)) return false;
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    const token = await chatgptToken(signal);
    if (!token) return false;
    return await disposeConversation(token, /** @type {string} */ (new URL(url).pathname.split('/').at(-1)), remove, signal);
  } catch { return false; }
}

// The first user message of every wake chat starts with the connector chip, then one of three
// fixed phrases (configured wake, native wake, composer job). Nothing else is ever swept.
const chip = String.raw`(?:\[\$?[^\]\n]{1,80}\]\(app:\/\/[^)\s]{1,200}\)|[@$][A-Za-z0-9_.-]{1,80})`;
const wakeSignature = new RegExp(String.raw`^\s*${chip}\s+(?:wake up as [^\s]{1,160}\s*$|wake up\. First gateway_exchange: worker_label=|process exactly job [A-Za-z0-9_-]{1,64} as [^\n]{1,200}?\. Call gateway_exchange with worker_label=)`);
/** @param {unknown} text @returns {boolean} */
export function isWakeSignature(text) { return typeof text === 'string' && text.length <= 4000 && wakeSignature.test(text); }

/**
 * The first user message of a ChatGPT conversation payload, or '' when the shape is not understood.
 * @param {any} conversation @returns {string}
 */
export function firstUserText(conversation) {
  const mapping = conversation?.mapping;
  if (!mapping || typeof mapping !== 'object') return '';
  /** @type {any[]} */
  let chain = [];
  const seen = new Set();
  for (let id = conversation.current_node; typeof id === 'string' && mapping[id] && !seen.has(id) && chain.length < 5000; id = mapping[id].parent) { seen.add(id); chain.push(mapping[id]); }
  chain.reverse();
  if (!chain.length) chain = Object.values(mapping).sort((a, b) => (a?.message?.create_time ?? 0) - (b?.message?.create_time ?? 0));
  for (const node of chain) {
    const message = node?.message;
    if (message?.author?.role !== 'user') continue;
    const parts = message.content?.parts;
    return Array.isArray(parts) ? parts.filter(part => typeof part === 'string').join('') : '';
  }
  return '';
}

/** @param {unknown} value @returns {number | null} */
function createdAt(value) {
  const ms = typeof value === 'string' ? Date.parse(value) : typeof value === 'number' ? value * 1000 : NaN;
  return Number.isFinite(ms) ? ms : null;
}

const sweepEveryMs = 600000, sweepMinAgeMs = 600000, sweepChecked = 500, sweepPerRun = 10;
/**
 * Delete wake chats nobody recorded or released (extension reloaded mid-wake, service state lost). A conversation is
 * touched only if the service says no ticket, label, session or queue entry holds it AND its first message is a wake
 * message. Every other conversation of the owner is only listed, never changed.
 * @param {import('./types.js').APIConfig} config
 * @param {import('./types.js').PollBrowser} browser
 * @param {import('./types.js').Fetcher} fetcher
 * @param {() => number} now
 */
export async function sweepWakeChats(config, browser, fetcher = fetch, now = Date.now) {
  const store = /** @type {any} */ (browser.storage?.local);
  if (typeof store?.get !== 'function' || typeof store?.set !== 'function') return;
  const previous = ((await store.get(['crossfeedSweep'])) ?? {}).crossfeedSweep ?? {};
  if (typeof previous.at === 'number' && now() - previous.at < sweepEveryMs) return;
  /** @type {Set<string>} */
  const checked = new Set(Array.isArray(previous.checked) ? previous.checked.filter((/** @type {unknown} */ id) => typeof id === 'string') : []);
  const report = {at: now(), listed: 0, candidates: 0, approved: 0, deleted: 0, error: ''};
  // Record the attempt first: a failing sweep must not run on every 30-second poll.
  await store.set({crossfeedSweep: {...report, checked: [...checked]}});
  /** @type {string[]} */
  const deleted = [];
  let sweepApproved = false;
  try {
    const signal = AbortSignal.timeout(20000);
    const token = await chatgptToken(signal);
    if (!token) throw Error('no_session');
    const headers = {Authorization: 'Bearer ' + token};
    const listing = await fetch('https://chatgpt.com/backend-api/conversations?offset=0&limit=100&order=created&is_archived=false', {credentials: 'include', redirect: 'error', cache: 'no-store', signal, headers});
    if (!listing.ok) throw Error('list_' + listing.status);
    const items = (await listing.json())?.items;
    if (!Array.isArray(items)) throw Error('list_shape');
    report.listed = items.length;
    const candidates = items.flatMap((/** @type {any} */ item) => {
      const created = createdAt(item?.create_time);
      return typeof item?.id === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(item.id) && created !== null && now() - created >= sweepMinAgeMs && !checked.has(item.id) ? [{id: item.id, created_at: created}] : [];
    });
    report.candidates = candidates.length;
    if (candidates.length) {
      const { dispose } = /** @type {{dispose?: string[]}} */ (await request(config, '/extension/sweep', {candidates}, fetcher));
      sweepApproved = true;
      const approved = Array.isArray(dispose) ? dispose.filter(id => candidates.some(c => c.id === id)).slice(0, sweepPerRun) : [];
      report.approved = approved.length;
      for (const id of approved) {
        const response = await fetch('https://chatgpt.com/backend-api/conversation/' + id, {credentials: 'include', redirect: 'error', cache: 'no-store', signal, headers});
        if (!response.ok) continue;
        if (!isWakeSignature(firstUserText(await response.json()))) { checked.add(id); continue; }
        if (await disposeConversation(token, id, true, signal)) deleted.push(id);
      }
    }
  } catch (error) { report.error = String(/** @type {Error} */ (error)?.message ?? error).slice(0, 40); }
  report.deleted = deleted.length;
  try { if (sweepApproved) await request(config, '/extension/sweep/done', {deleted}, fetcher); } catch { /* the bounded receiver lease expires if reporting fails */ }
  await store.set({crossfeedSweep: {...report, checked: [...checked].slice(-sweepChecked)}});
}

// Cosmetic and best-effort: a missing tabGroups permission (granted only by a full Chrome reload
// of the extension) or a failed group call must never fail the job itself.
/** @param {import('./types.js').PollBrowser} browser @param {import('./types.js').Tab} tab @param {Ticket} ticket */
async function groupWorkerTab(browser, tab, ticket) {
  try {
    if (!browser.tabGroups?.update || !browser.tabs?.group) return;
    const group = await browser.tabs.group({tabIds: [tab.id]});
    await browser.tabGroups.update(group, {title: `Crossfeed · ${ticket.title ?? ticket.label}`, color: 'blue', collapsed: true});
  } catch { /* the job continues ungrouped */ }
}

// Tabs (and, for native wakes, the window) this extension opened for a wake.
// A record is a claim on that tab, not on the window: closing it must never
// close tabs the owner later added to the same window.
const ownedWakeTabsKey = 'crossfeedWakeTabs';
/** @typedef {{tab: number, window?: number, at: number}} OwnedWakeTab */

/** @param {unknown} value @returns {OwnedWakeTab | null} */
function ownedWakeTab(value) {
  if (!value || typeof value !== 'object') return null;
  const record = /** @type {Record<string, unknown>} */ (value);
  if (!Number.isSafeInteger(record.tab) || /** @type {number} */ (record.tab) <= 0) return null;
  const tab = /** @type {number} */ (record.tab);
  const window = Number.isSafeInteger(record.window) && /** @type {number} */ (record.window) > 0 ? /** @type {number} */ (record.window) : undefined;
  const at = typeof record.at === 'number' && Number.isFinite(record.at) ? record.at : 0;
  return {tab, ...(window === undefined ? {} : {window}), at};
}

/** @param {unknown} value */
function chatGPTURL(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'chatgpt.com' && !url.port && !url.username && !url.password;
  } catch { return false; }
}

/** @param {import('./types.js').PollBrowser} browser @returns {Promise<OwnedWakeTab[]>} */
async function ownedWakeTabs(browser) {
  const store = browser.storage?.local;
  if (typeof store?.get !== 'function') return [];
  try {
    const value = (await store.get([ownedWakeTabsKey]))?.[ownedWakeTabsKey];
    if (!Array.isArray(value)) return [];
    /** @type {OwnedWakeTab[]} */
    const records = [];
    for (const candidate of value) {
      const record = ownedWakeTab(candidate);
      if (record) records.push(record);
    }
    return records;
  } catch { return []; }
}

/** @param {import('./types.js').PollBrowser} browser @param {OwnedWakeTab[]} records */
async function storeOwnedWakeTabs(browser, records) {
  const store = browser.storage?.local;
  if (typeof store?.set !== 'function') return;
  try { await store.set({[ownedWakeTabsKey]: records}); } catch { /* cleanup is best-effort, like diagnostics */ }
}

/** @param {import('./types.js').PollBrowser} browser @param {number} tab @param {number | undefined} window @param {number} at */
async function rememberOwnedWakeTab(browser, tab, window, at) {
  if (!Number.isSafeInteger(tab) || tab <= 0) return;
  const records = await ownedWakeTabs(browser);
  records.push({tab, ...(Number.isSafeInteger(window) && /** @type {number} */ (window) > 0 ? {window: /** @type {number} */ (window)} : {}), at});
  await storeOwnedWakeTabs(browser, records);
}

/** @param {import('./types.js').PollBrowser} browser @param {number | undefined} tab @param {number | undefined} window */
async function forgetOwnedWakeTab(browser, tab, window) {
  const records = await ownedWakeTabs(browser);
  if (!records.length) return;
  const kept = records.filter(record => record.tab !== tab && (window === undefined || record.window !== window));
  if (kept.length !== records.length) await storeOwnedWakeTabs(browser, kept);
}

/**
 * Close wake tabs whose waking poll died before its own finally block. A tab is
 * closed only if it still exists, is not the wake currently running, is still on
 * chatgpt.com, and (for a recorded native window) still belongs to that window.
 * Records for gone, moved or owner-repurposed tabs are dropped without closing.
 * @param {import('./types.js').PollBrowser} browser
 * @param {number} [runningTab]
 */
export async function closeOrphanedWakeTabs(browser, runningTab) {
  const store = browser.storage?.local;
  if (typeof store?.get !== 'function' || typeof store?.set !== 'function') return;
  const records = await ownedWakeTabs(browser);
  if (!records.length) return;
  /** @type {OwnedWakeTab[]} */
  const kept = [];
  for (const record of records) {
    if (record.tab === runningTab) { kept.push(record); continue; }
    /** @type {import('./types.js').Tab | undefined} */
    let tab;
    try { tab = await browser.tabs.get(record.tab); } catch { continue; }
    if (!tab || tab.id !== record.tab) continue;
    if (!chatGPTURL(tab.url) || record.window !== undefined && tab.windowId !== record.window) continue;
    try { await browser.tabs.remove(record.tab); } catch { kept.push(record); }
  }
  await storeOwnedWakeTabs(browser, kept);
}

/**
 * Chrome reuses tab ids after a restart, so startup must forget old records
 * without touching any tab. A record left by an extension reload (same browser
 * session) is still valid and is cleaned by the next poll instead.
 * @param {import('./types.js').PollBrowser} browser
 */
export async function clearOwnedWakeTabs(browser) {
  await storeOwnedWakeTabs(browser, []);
}

const reasons = new Set(['invalid_ticket', 'page_not_ready', 'page_changed', 'mode_unconfirmed',
  'level_unconfirmed', 'permission_unconfirmed', 'upload_unconfirmed', 'upload_failed', 'composer_not_empty', 'mention_unconfirmed', 'send_unconfirmed', 'claim_refused', 'expired', 'browser_error', 'rate_limited']);

/**
 * @param {import('./types.js').APIConfig} config
 * @param {string} path
 * @param {unknown} body
 * @param {import('./types.js').Fetcher} [fetcher]
 * @returns {Promise<import('./types.js').APIReply>}
 */
export async function request(config, path, body, fetcher = fetch) {
  if (!apiURL(config.apiURL) || typeof config.key !== 'string' || !config.key || /[\r\n]/.test(config.key) ||
    !['/extension/next', '/extension/claim', '/extension/observe', '/extension/result', '/extension/check', '/extension/archive/next', '/extension/archive/result', '/extension/chat', '/extension/sweep', '/extension/sweep/done'].includes(path)) throw Error('invalid_config');
  // Host-permitted extension GETs can omit Origin, which the paired API requires.
  // Use an empty POST for queue reads so Chrome supplies the extension Origin.
  const input = body ?? {};
  const controller = new AbortController();
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetcher(config.apiURL + path, {
          method: 'POST', redirect: 'error', cache: 'no-store',
          credentials: 'omit', signal: controller.signal,
          headers: { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
        if (!response.ok) throw Error('request_refused');
        const raw = await response.text();
        if (raw.length > 16_384) throw Error('response_too_large');
        return /** @type {import('./types.js').APIReply} */ (JSON.parse(raw));
      })(),
      new Promise(/** @param {(value: import('./types.js').APIReply) => void} _ */ (_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error('request_timeout')); }, 4000); }),
    ]);
  } finally { clearTimeout(timer); controller.abort(); }
}


const levels = ['Instant', 'Medium', 'High', 'Extra High', 'Pro'];
/**
 * @param {import('./types.js').PollBrowser} browser
 * @param {import('./types.js').Fetcher} [fetcher]
 * @param {() => number} [now]
 * @param {(ms: number) => Promise<unknown>} [pause]
 * @returns {() => Promise<void>}
 */
export function makePoller(browser, fetcher = fetch, now = Date.now, pause = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  let running = false, generation = 0, watchdogAt = 0;
  // A call into a busy or replaced ChatGPT page can stay pending forever; bound each one so a
  // wake fails cleanly (and its finally closes the tab) instead of freezing the extension.
  /** @type {(options: any, ms?: number) => Promise<any>} */
  const pageScript = (options, ms = 20000) => {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    return Promise.race([
      browser.scripting.executeScript(options),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('page_not_ready')), ms); }),
    ]).finally(() => clearTimeout(timer));
  };
  return async function poll() {
    if (running) {
      if (now() < watchdogAt) return;
      // The previous wake outlived its deadline: close what it opened and take over.
      try { await closeOrphanedWakeTabs(browser); } catch { /* best effort */ }
      running = false;
    }
    running = true;
    const mine = ++generation;
    watchdogAt = now() + 300000;
    // No wake is running in this poll yet: anything still recorded belongs to a
    // wake whose context died. Clean it before deciding what to do next.
    try { await closeOrphanedWakeTabs(browser); } catch { /* never block a wake on cleanup */ }
    /** @type {unknown} */
    let ticket;
    /** @type {import('./types.js').APIConfig | null | undefined} */
    let config;
    /** @type {import('./types.js').Tab | undefined} */
    let tab;
    /** @type {string | undefined} */
    let documentId;
    /** @type {string | undefined} */
    let newURL;
    /** @type {string | undefined} */
    let wakePrompt;
    let attached = false, sent = false, ordinary = false, native = false;
    /** @type {number | undefined} */
    let ownedWindowId;
    /** @type {unknown} */
    let wakeDiagnostic;
    /** @type {import('./types.js').PageTicket | undefined} */
    let draftTicket;
    /** @type {{connector: string, option: string}[]} */
    const permissions = [];
    let stage = 'loading';
    const home = 'https://chatgpt.com/';
    try {
      config = await ensurePairing(browser, fetcher);
      if (!config || !apiURL(config.apiURL) || !config.key) return;
      const pairedConfig = config;
      ({ ticket } = await request(config, '/extension/next', undefined, fetcher));
      if (ticket == null) {
        const { archive } = await request(config, '/extension/archive/next', undefined, fetcher);
        if (!archive) { await sweepWakeChats(config, browser, fetcher, now); return; }
        if (!validTicket({ ...archive, label: 'archive', connector: 'archive', row: 'archive', level: 0 }, now()) || !savedChatURL(archive.url)) throw Error('invalid_ticket');
        const ok = await archiveConversation(archive.url, 15000, archive.remove === true);
        await request(config, '/extension/archive/result', {nonce: archive.nonce, ok}, fetcher);
        return;
      }
      if (!validTicket(ticket, now())) throw Error('invalid_ticket');
      // Stable aliases carry the successful validation into asynchronous page probes.
      const activeTicket = ticket;
      watchdogAt = Math.max(watchdogAt, /** @type {any} */ (activeTicket).expires_at + 60000);
      /** @type {string | undefined} */
      let reportedChat;
      // Tell the service about the chat the moment its URL exists, so a crash, an extension reload or a
      // service restart before the final result can never leave an unrecorded conversation behind.
      /** @param {string} url */
      const reportChat = async url => {
        if (reportedChat === url) return;
        try { await request(/** @type {import('./types.js').APIConfig} */ (config), '/extension/chat', {nonce: activeTicket.nonce, url}, fetcher); reportedChat = url; }
        catch { /* the final result and the periodic sweep still cover this chat */ }
      };
      stage = 'claim';
      ordinary = activeTicket.type !== 'composer';
      native = ordinary && activeTicket.wake_mode === 'native';
      // The host may ignore/decline the optional cosmetic advisory. Only the
      // authenticated nonce claim itself is mandatory for wake authorization.
      const claim = await request(config, '/extension/claim', {nonce: activeTicket.nonce,
          ...(native ? {focus_guard: true, focus_guard_version: 4} : {})}, fetcher);
      if (claim?.ok !== true) throw Error('claim_refused');
      if (!validTicket(activeTicket, now())) throw Error('expired');
      if (ordinary) {
        try { await browser.storage?.local?.set?.({crossfeedWakeDiagnostic: ''}); } catch { /* Timestamped failure markers are still safe if clearing is unavailable. */ }
      }
      const prompt = `@${activeTicket.connector} wake up. First gateway_exchange: worker_label=${JSON.stringify(activeTicket.label)} exactly as issued, wake_nonce=${JSON.stringify(activeTicket.nonce)}, maximum_wait_seconds=20. Then use the server-returned worker_label and repeat wake_nonce=${JSON.stringify(activeTicket.nonce)} on all subsequent gateway_exchange calls. Poll until state=released and continue=false; do not send a final chat reply between jobs. Return local caller tools as structured tool_calls through gateway_exchange; do not execute them natively.`;
      wakePrompt = prompt;
      const wakeURL = `${home}?q=${encodeURIComponent(prompt)}`;
      const promptURL = `${home}?prompt=${encodeURIComponent(prompt)}`;
      const focus = claim.focus_guard;
      const marker = native && focus && typeof focus === 'object' && focus.status === 'armed' &&
        typeof focus.marker === 'string' && /^[a-f0-9]{32}$/.test(focus.marker) ? focus.marker : undefined;
      const bootstrapURL = marker && browser.runtime?.getURL ?
        browser.runtime.getURL('wake-window.html') + '?marker=' + marker : undefined;
      // Ordinary native wakes have an independent minimized normal window.
      // Chrome/KWin can still affect focus: desktop restoration is advisory.
      if (native) {
        // A minimized normal window avoids Chrome raising the owner's app on macOS;
        // never group its active tab, which would restore/foreground that window.
        const window = await browser.windows.create({url: bootstrapURL ?? wakeURL, type: 'normal', state: 'minimized'});
        const own = window?.tabs;
        const windowId = window?.id;
        if (window?.type === 'normal' && typeof windowId === 'number' && Number.isSafeInteger(windowId) && windowId > 0) ownedWindowId = windowId;
        if (Array.isArray(own) && own[0]) tab = own[0];
        if (tab && Number.isSafeInteger(tab.id) && tab.id > 0) {
          await rememberOwnedWakeTab(browser, tab.id, ownedWindowId, now());
        }
        if (typeof windowId !== 'number' || !Number.isSafeInteger(windowId) || windowId <= 0 ||
            window.type !== 'normal' || !Array.isArray(own) || own.length !== 1 ||
            !Number.isSafeInteger(own[0]?.id) || own[0].id <= 0 ||
            own[0].windowId !== windowId || own[0].active !== true) {
          if (typeof ownedWindowId === 'number' && Number.isSafeInteger(ownedWindowId) && ownedWindowId > 0) {
            try { await browser.windows.remove(ownedWindowId); await forgetOwnedWakeTab(browser, tab?.id, ownedWindowId); } catch { /* Still report the failed ownership proof. */ }
            ownedWindowId = undefined;
          } else if (tab && Number.isSafeInteger(tab.id) && tab.id > 0) {
            try { await browser.tabs.remove(tab.id); await forgetOwnedWakeTab(browser, tab.id, undefined); } catch { /* Still report the failed ownership proof. */ }
            tab = undefined;
          }
          throw Error('browser_error');
        }
        // No grouping here: the job already has its own unfocused window, and grouping its active tab
        // can raise Chrome over the owner's app (seen 19 Oct). Background tabs below are still grouped.
      } else {
        tab = await browser.tabs.create({url: home, active: false});
        await rememberOwnedWakeTab(browser, tab.id, undefined, now());
        await groupWorkerTab(browser, tab, activeTicket);
        if (ordinary) {
          const current = await browser.tabs.get(tab.id);
          if (current.id !== tab.id || !Number.isSafeInteger(current.windowId) || /** @type {number} */ (current.windowId) <= 0) throw Error('page_changed');
          ownedWindowId = current.windowId;
        }
      }
      if (!tab || !Number.isSafeInteger(tab.id) || tab.id <= 0) throw Error('browser_error');
      const activeTab = tab;
      // Disk paths remain in the trusted extension, the page gets only upload metadata.
      const pageTicket = /** @type {import('./types.js').PageTicket} */ ({...activeTicket, ...(activeTicket.attachments ? {attachments: activeTicket.attachments.map(({name, mime, bytes}) => ({name, mime, bytes}))} : {})});

      /** @param {number} [expectedMaximum] */
      const performPrefilledWake = async expectedMaximum => {
        const config = pairedConfig;
        const getOwnedTab = async () => {
          const current = await browser.tabs.get(activeTab.id);
          if (current?.id !== activeTab.id || current.windowId !== ownedWindowId) {
            throw Error('page_changed');
          }
          return current;
        };
        if (bootstrapURL) {
          // The private page identifies only this owned window to the desktop.
          // Cosmetic hydration timeout still proceeds with the authorized wake.
          const until = Math.min(activeTicket.expires_at, now() + 1500);
          while (now() < until) {
            const current = await getOwnedTab();
            if (current.pendingUrl && current.pendingUrl !== bootstrapURL ||
                current.url && current.url !== 'about:blank' && current.url !== bootstrapURL) throw Error('page_changed');
            if (current.status === 'complete' && current.url === bootstrapURL &&
                current.title === 'Crossfeed Wake ' + marker) break;
            await pause(100);
          }
          const current = await getOwnedTab();
          if (current.pendingUrl && current.pendingUrl !== bootstrapURL ||
              current.url && current.url !== 'about:blank' && current.url !== bootstrapURL) throw Error('page_changed');
          if (!validTicket(activeTicket, now())) throw Error('expired');
          await browser.tabs.update(activeTab.id, {url: wakeURL});
        }
        // Explicit native URL navigation plus the unpredictable scoped alias
        // is host authority. Wait for only its monotonic native root sequence.
        stage = 'loading';
        const navigationDeadline = Math.min(activeTicket.expires_at, now() + 15000);
        /** @type {-1 | 0 | 1 | 2} */
        let nativePhase = -1;
        let ready = false;
        let wakeSnapshot = wakeTabDiagnostic(activeTab, prompt);
        wakeDiagnostic = {checkpoint: 'tab_wait', ...wakeSnapshot, probe: {executed: false, ready: false, phase: -1, documentIdPresent: false}};
        while (now() < navigationDeadline) {
          const current = await getOwnedTab();
          wakeSnapshot = wakeTabDiagnostic(current, prompt);
          wakeDiagnostic = {checkpoint: 'tab_wait', ...wakeSnapshot, probe: {executed: false, ready: false, phase: -1, documentIdPresent: false}};
          const currentPhase = ordinaryWakePhase(current.url, prompt);
          // Before authority is acquired, Chrome may expose only its new-tab
          // shell. These states are wait-only: no page code runs until a
          // complete, no-pending canonical native root is committed.
          if (nativePhase < 0 && current.status === 'loading') {
            const shell = current.url == null || current.url === '' || current.url === 'about:blank' ||
              // Chrome can retain our exact private bootstrap as the committed
              // document while the owned native URL is pending. Wait only;
              // never execute page code there or accept another extension URL.
              !!bootstrapURL && current.url === bootstrapURL;
            if (!shell && currentPhase < 0) throw Error('page_changed');
            if (current.pendingUrl && ordinaryWakePhase(current.pendingUrl, prompt) < 0) throw Error('page_changed');
            await pause(100);
            continue;
          }
          if (current.pendingUrl || current.status !== 'complete' || currentPhase < 0) throw Error('page_changed');
          nativePhase = currentPhase;
          ready = true;
          break;
        }
        if (!validTicket(activeTicket, now())) throw Error('expired');
        if (!ready || nativePhase < 0) throw Error('page_not_ready');

        const remaining = Math.max(1, Math.min(15000, activeTicket.expires_at - now()));
        /** @type {[PageTicket, boolean, number, number]} */
        const probeArgs = [pageTicket, true, remaining, 100];
        wakeDiagnostic = {checkpoint: 'probe_result', ...wakeSnapshot, probe: {executed: true, ready: false, phase: -1, documentIdPresent: false}};
        /** @type {import('./types.js').Injection<PrefillProbeResult>[]} */
        const probeRuns = await pageScript({target: {tabId: activeTab.id}, func: prefillProbe, args: probeArgs});
        const probe = probeRuns[0];
        const rawProbePhase = probe?.result?.phase;
        const probePhase = Number.isInteger(rawProbePhase) ? /** @type {number} */ (rawProbePhase) : -1;
        const probeState = {
          executed: true,
          ready: probe?.result?.ready === true,
          phase: probePhase,
          documentIdPresent: typeof probe?.documentId === 'string',
        };
        wakeDiagnostic = {
          checkpoint: 'probe_result', ...wakeSnapshot, probe: probeState,
          ...(probe?.result?.diagnostic && typeof probe.result.diagnostic === 'object' ? {probe_location: probe.result.diagnostic} : {}),
        };
        if (!probe?.result) throw Error('browser_error');
        if (!probe.result.ready || !Number.isInteger(probe.result.phase)) {
          throw Error(reasons.has(probe.result.error ?? '') ? probe.result.error : 'page_not_ready');
        }
        wakeDiagnostic = {
          checkpoint: 'probe_binding', ...wakeSnapshot, probe: probeState,
          ...(probe.result.diagnostic && typeof probe.result.diagnostic === 'object' ? {probe_location: probe.result.diagnostic} : {}),
        };
        if (typeof probe.documentId !== 'string' || /** @type {number} */ (probe.result.phase) < nativePhase) throw Error('page_changed');
        documentId = probe.documentId;
        nativePhase = /** @type {0 | 1 | 2} */ (probe.result.phase);
        if (expectedMaximum !== undefined) {
          // A configured wake must retain the actual saved picker selection
          // across native navigation; never silently fall back to defaults.
          stage = 'picker';
          /** @type {[PageTicket, number, number]} */
          const modelArgs = [pageTicket, expectedMaximum, Math.max(1, Math.min(1500, activeTicket.expires_at - now()))];
          const modelRuns = await pageScript({
            target: {tabId: activeTab.id, documentIds: [documentId]}, func: prefillModel, args: modelArgs,
          });
          const model = modelRuns[0];
          if (model?.documentId !== documentId) throw Error('page_changed');
          if (model?.result?.verified !== true || model.result.row !== activeTicket.row ||
              model.result.level !== activeTicket.level || model.result.maximum !== expectedMaximum)
            throw Error(model?.result?.error === 'rate_limited' ? 'rate_limited' : 'level_unconfirmed');
        }

        // Revalidate URL/ticket immediately before the only send-capable call.
        const beforeSend = await getOwnedTab();
        const beforePhase = ordinaryWakePhase(beforeSend.url, prompt);
        wakeDiagnostic = {checkpoint: 'before_send', ...wakeTabDiagnostic(beforeSend, prompt), probe: probeState};
        // The read-only probe already attested a ready exact prefill in this
        // pinned document. Chrome can still report loading for unrelated page
        // resources. Like PiLink, use DOM authority, not that network-load flag.
        // Pending navigation, unknown status, phase regression and document
        // replacement still cannot transfer the sender's authority.
        if (beforeSend.pendingUrl || !['complete', 'loading'].includes(beforeSend.status ?? '') || beforePhase < nativePhase || !validTicket(activeTicket, now())) {
          throw Error(validTicket(activeTicket, now()) ? 'page_changed' : 'expired');
        }
        nativePhase = beforePhase;
        stage = 'send';
        // Host-side seal before execution. A lost result can never authorize a retry.
        sent = true;
        /** @type {[PageTicket, number, number, number]} */
        const sendArgs = [pageTicket, Math.max(1, Math.min(15000, activeTicket.expires_at - now())), 100, nativePhase];
        /** @type {import('./types.js').Injection<PrefillWakeResult>[]} */
        const wakeRuns = await pageScript({
          target: {tabId: activeTab.id, documentIds: [documentId]}, func: prefillWake, args: sendArgs,
        });
        const wake = wakeRuns[0];
        if (!wake?.result) throw Error('browser_error');
        if (wake.documentId !== documentId) throw Error('page_changed');
        if (!wake.result.sent) {
          sent = false;
          throw Error(reasons.has(wake.result.error ?? '') ? wake.result.error : 'send_unconfirmed');
        }

        /** @type {string | undefined} */
        let registrationDocumentId;
        let approving = false;
        while (now() < activeTicket.expires_at) {
          stage = 'registration';
          let current = await getOwnedTab();
          if (newURL && (current.url !== newURL || current.pendingUrl || !['complete', 'loading'].includes(current.status ?? ''))) throw Error('page_changed');
          // A ChatGPT page that is polling tools keeps reporting 'loading'; DOM authority, not the load flag, decides (as before send).
          while (now() < activeTicket.expires_at && (current.pendingUrl || !['complete', 'loading'].includes(current.status ?? '') ||
              ordinaryWakePhase(current.url, prompt) >= 0 || pendingChatURL(current.url))) {
            if (current.pendingUrl && !savedChatURL(current.pendingUrl) && !pendingChatURL(current.pendingUrl) ||
                current.url && ordinaryWakePhase(current.url, prompt) < 0 && !savedChatURL(current.url) && !pendingChatURL(current.url)) throw Error('page_changed');
            await pause(200);
            current = await getOwnedTab();
          }
          if (!validTicket(activeTicket, now())) throw Error('expired');
          if (current.pendingUrl || !savedChatURL(current.url)) throw Error('page_changed');
          newURL = /** @type {string} */ (current.url);
          await reportChat(newURL);

          /** @type {[PageTicket, 'registration']} */
          const registrationArgs = [pageTicket, 'registration'];
          const registrationTarget = registrationDocumentId ?
            {tabId: activeTab.id, documentIds: [registrationDocumentId]} : {tabId: activeTab.id};
          /** @type {import('./types.js').Injection<PageProbe>[]} */
          const registrationRuns = await pageScript({
            target: registrationTarget, func: pageWake, args: registrationArgs,
          });
          const value = registrationRuns[0];
          if (!value?.result || typeof value.documentId !== 'string' || value.result.url !== newURL ||
              registrationDocumentId && value.documentId !== registrationDocumentId) throw Error('page_changed');
          if (!registrationDocumentId) registrationDocumentId = value.documentId;
          const boundDocumentId = registrationDocumentId;
          if (value.result.rateLimited) throw Error('rate_limited');
          const state = value.result;
          if (state.optionsPoint && !approving) {
            stage = 'permission';
            approving = true;
            /** @type {[PageTicket, string, string]} */
            const permissionArgs = [pageTicket, 'options', newURL];
            /** @type {import('./types.js').Injection<boolean>[]} */
            const permissionRuns = await pageScript({
              target: {tabId: activeTab.id, documentIds: [boundDocumentId]}, func: pagePermission, args: permissionArgs,
            });
            const clicked = permissionRuns[0];
            if (clicked?.documentId !== boundDocumentId || clicked.result !== true) throw Error('permission_unconfirmed');
            approving = false;
            continue;
          }
          if (state.allowPoint && !approving) {
            const option = state.allowOption ?? '';
            if (!['Always allow', `Allow ${activeTicket.connector} for this conversation`].includes(option)) throw Error('permission_unconfirmed');
            stage = 'permission';
            approving = true;
            /** @type {[PageTicket, string, string]} */
            const permissionArgs = [pageTicket, option, newURL];
            /** @type {import('./types.js').Injection<boolean>[]} */
            const permissionRuns = await pageScript({
              target: {tabId: activeTab.id, documentIds: [boundDocumentId]}, func: pagePermission, args: permissionArgs,
            });
            const clicked = permissionRuns[0];
            if (clicked?.documentId !== boundDocumentId || clicked.result !== true) throw Error('permission_unconfirmed');
            permissions.push({connector: activeTicket.connector, option});
            continue;
          }
          if (!state.permissionPending) approving = false;
          const registered = await request(config, '/extension/check', {nonce: activeTicket.nonce}, fetcher);
          const filesAllowed = permissions.some(p => p.option === `Allow ${activeTicket.connector} for this conversation`);
          if (registered?.registered && (!registered.media_pending || filesAllowed) && !state.permissionPending) break;
          await pause(1000);
        }
        if (!newURL || now() >= activeTicket.expires_at) throw Error('expired');
        const receipt = await request(config, '/extension/result', {nonce: activeTicket.nonce, ok: true, url: newURL, ...(permissions.length ? {permissions} : {})}, fetcher);
        if (receipt?.ok !== true) throw Error('browser_error');
      };
      if (native) {
        await performPrefilledWake();
        return;
      }

      await browser.debugger.attach({tabId: activeTab.id}, '1.3'); attached = true;
      // Trusted input into our background composer tab needs an active renderer.
      await browser.debugger.sendCommand({tabId: activeTab.id}, 'Emulation.setFocusEmulationEnabled', {enabled: true});
      /** @param {PageAction} action @returns {Promise<PageProbe>} */
      const read = async action => {
        stage = action;
        if (!validTicket(activeTicket, now())) throw Error('expired');
        const registration = sent && action === 'registration';
        let current = await browser.tabs.get(activeTab.id);
        // Enter may navigate before its key-up. Wait only for our own fresh
        // conversation; pre-send reads stay bound to the original document.
        while (registration && (current.pendingUrl || !['complete', 'loading'].includes(current.status ?? '') || pendingChatURL(current.url))) {
          if (current.pendingUrl && !savedChatURL(current.pendingUrl) && !pendingChatURL(current.pendingUrl) || current.url !== home && !savedChatURL(current.url) && !pendingChatURL(current.url)) throw Error('page_changed');
          if (!validTicket(activeTicket, now())) throw Error('expired');
          await pause(200); current = await browser.tabs.get(activeTab.id);
        }
        if (current.pendingUrl || current.url !== home && !(action === 'registration' && savedChatURL(current.url))) throw Error('page_changed');
        const [value] = await pageScript({target: {tabId: activeTab.id, ...(documentId && !registration ? {documentIds: [documentId]} : {})}, func: pageWake, args: [pageTicket, action]});
        if (!value?.result || typeof value.documentId !== 'string') throw Error('page_changed');
        if (documentId && value.documentId !== documentId && !(registration && savedChatURL(value.result.url))) throw Error('page_changed');
        documentId = value.documentId;
        if (value.result.rateLimited) throw Error('rate_limited');
        return value.result;
      };
      /** @param {PageAction} action @param {(result: PageProbe) => unknown} predicate */
      const wait = async (action, predicate) => {
        while (now() < activeTicket.expires_at) {
          const result = await read(action);
          if (predicate(result)) return result;
          await pause(200);
        }
        throw Error('expired');
      };
      /** @param {string} method @param {Record<string, unknown>} params */
      const dispatch = async (method, params) => {
        await read(sent ? 'registration' : 'ready');
        stage = 'input';
        // A lost debugger reply can still have inserted text. The page cleanup
        // checks our prefix before deleting anything.
        if (method === 'Input.insertText') draftTicket = pageTicket;
        await browser.debugger.sendCommand({tabId: activeTab.id}, method, params);
      };
      /** @param {'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Escape' | 'Enter' | 'End'} name */
      const key = async name => {
        const codes = {ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Escape: 27, Enter: 13, End: 35};
        await dispatch('Input.dispatchKeyEvent', {type: 'keyDown', key: name, code: name, windowsVirtualKeyCode: codes[name]});
        await dispatch('Input.dispatchKeyEvent', {type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: codes[name]});
      };
      /** @param {import('./types.js').Point | null | undefined} p */
      const click = async p => {
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) throw Error('page_not_ready');
        await dispatch('Input.dispatchMouseEvent', {type: 'mouseMoved', x: p.x, y: p.y});
        await dispatch('Input.dispatchMouseEvent', {type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1});
        await dispatch('Input.dispatchMouseEvent', {type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1});
      };
      // Wait for the new document before binding subsequent reads and input.
      while (now() < activeTicket.expires_at) {
        const current = await browser.tabs.get(activeTab.id);
        if (current.status === 'complete' && current.url === home && !current.pendingUrl) break;
        if (current.url && !['about:blank', home].includes(current.url) || current.pendingUrl && current.pendingUrl !== home) throw Error('page_changed');
        await pause(200);
      }
      let state = await wait('ready', r => r.ready);
      // Bare-root drafts can be restored/shared by ChatGPT. Ordinary wakes
      // configure only the picker here; never focus, clear or type into a draft.
      // Composer may clear exactly its orphaned bare mention, not user text.
      if (!ordinary && !state.empty) {
        await read('discardBareMention');
        stage = 'ready';
        state = await wait('ready', r => r.ready);
        if (!state.empty) throw Error('composer_not_empty');
      }
      if (!state.chat) { await click(state.chatPoint); await wait('ready', r => r.chat); }
      const openPicker = async () => {
        const current = await read('picker');
        if (current.open) return current;
        const model = await read('modelFocus');
        if (!model.focused) throw Error('page_not_ready');
        await click(model.modelPoint); return wait('picker', r => r.open);
      };
      state = await openPicker();
      if (state.row !== activeTicket.row) {
        if (!state.rowPoint) { await click(state.viewPoint); state = await wait('picker', r => r.rowPoint); }
        await click(state.rowPoint);
        state = await openPicker();
        state = await wait('picker', r => r.row === activeTicket.row);
      }
      /** @param {PageProbe} candidate @param {number | undefined} expectedPosition @param {number | undefined} expectedMaximum */
      const canonicalPicker = (candidate, expectedPosition, expectedMaximum) => {
        if (candidate.open !== true || candidate.row !== activeTicket.row || candidate.minimum !== '0' ||
            typeof candidate.maximum !== 'string' || !/^[0-4]$/.test(candidate.maximum) ||
            !Number.isInteger(candidate.position)) return null;
        const maximum = Number(candidate.maximum), position = /** @type {number} */ (candidate.position);
        if (position < 0 || position > maximum || expectedMaximum !== undefined && maximum !== expectedMaximum ||
            expectedPosition !== undefined && position !== expectedPosition || !levels[position] ||
            candidate.status !== `${levels[position]}, ${position + 1} of ${maximum + 1}.`) return null;
        return {maximum, position, state: candidate};
      };
      /** @param {number | undefined} expectedPosition @param {number | undefined} expectedMaximum */
      const settlePicker = async (expectedPosition, expectedMaximum) => {
        const deadline = Math.min(activeTicket.expires_at, now() + 1000);
        while (now() < deadline) {
          const candidate = await read('picker');
          const canonical = canonicalPicker(candidate, expectedPosition, expectedMaximum);
          if (canonical) return canonical;
          await pause(100);
        }
        throw Error('level_unconfirmed');
      };
      const initial = await settlePicker(undefined, undefined);
      if (activeTicket.level > initial.maximum) throw Error('level_unconfirmed');
      /** Once row/range authority exists, never settle through a mutation. @param {number} expectedPosition */
      const settledAuthority = async expectedPosition => {
        const deadline = Math.min(activeTicket.expires_at, now() + 1000);
        while (now() < deadline) {
          const candidate = await read('picker');
          if (candidate.row !== activeTicket.row || candidate.minimum !== '0' ||
              candidate.maximum !== String(initial.maximum)) throw Error('level_unconfirmed');
          const canonical = canonicalPicker(candidate, expectedPosition, initial.maximum);
          if (canonical) return canonical;
          await pause(100);
        }
        throw Error('level_unconfirmed');
      };
      await settledAuthority(initial.position);
      if (!(await read('sliderFocus')).focused) throw Error('level_unconfirmed');
      let cursor = initial.position;
      /** @type {PageProbe} */
      let observed = initial.state;
      for (let i = 0; i < initial.position; i++) {
        await settledAuthority(cursor);
        await key('ArrowLeft');
        cursor--;
        observed = (await settledAuthority(cursor)).state;
      }
      for (let i = 0; i < activeTicket.level; i++) {
        await settledAuthority(cursor);
        await key('ArrowRight');
        cursor++;
        observed = (await settledAuthority(cursor)).state;
      }
      if ((await request(config, '/extension/observe', {nonce: activeTicket.nonce, picker_receipt: {row: observed.row, level: observed.position}}, fetcher))?.ok !== true) throw Error('claim_refused');
      await key('Escape');
      if (ordinary) {
        await browser.debugger.detach({tabId: activeTab.id}); attached = false;
        // Exact owned-tab native prefill replaces the input path, not the
        // user's draft. A fresh document must re-prove model, text and nonce.
        await browser.tabs.update(activeTab.id, {url: wakeURL});
        await performPrefilledWake(initial.maximum);
        return;
      }
      if (!(await read('editorFocus')).focused) throw Error('page_not_ready');
      await dispatch('Input.insertText', {text: `@${activeTicket.connector}`});
      state = await wait('mention', r => r.mentionPoint);
      await click(state.mentionPoint);
      await wait('resolved', r => r.resolved && r.focused);
      if (activeTicket.type === 'composer') {
        const upload = await read('uploadInput');
        if (!upload.ready || upload.uploadSelector !== 'form input[type="file"][aria-label="Attach files"]') throw Error('upload_unconfirmed');
        const target = {tabId: activeTab.id};
        const {root} = /** @type {import('./types.js').DebugReply} */ (await browser.debugger.sendCommand(target, 'DOM.getDocument', {}));
        if (!Number.isInteger(root?.nodeId)) throw Error('upload_unconfirmed');
        const {nodeId} = /** @type {import('./types.js').DebugReply} */ (await browser.debugger.sendCommand(target, 'DOM.querySelector', {nodeId: /** @type {{nodeId: number}} */ (root).nodeId, selector: upload.uploadSelector}));
        if (!Number.isInteger(nodeId) || /** @type {number} */ (nodeId) <= 0 || !(await read('uploadInput')).ready) throw Error('upload_unconfirmed');
        await browser.debugger.sendCommand(target, 'DOM.setFileInputFiles', {nodeId, files: activeTicket.attachments.map(file => file.path)});
        await wait('uploads', r => r.ready);
        // Upload controls may take focus; bind the connector editor again before typing.
        await wait('resolved', r => r.resolved && r.focused);
      }
      await key('End');
      const message = activeTicket.type === 'composer' ? ` process exactly job ${activeTicket.job_id} as ${activeTicket.label}. Call gateway_exchange with worker_label=${JSON.stringify(activeTicket.label)}, request_id=${JSON.stringify(activeTicket.job_id)} and maximum_wait_seconds=1 to fetch this job only. Use these uploaded attachments with its request, submit its answer with request_id and claim_token, then stop when released.` : ` wake up as ${activeTicket.label}`;
      await dispatch('Input.insertText', {text: message});
      if (!(await read('send')).ready) throw Error('send_unconfirmed');
      // Mark before Enter: a lost debugger reply must never send again.
      sent = true; await key('Enter');
      let approving = false;
      while (now() < activeTicket.expires_at) {
        state = await read('registration');
        if (savedChatURL(state.url)) { newURL = state.url; await reportChat(/** @type {string} */ (state.url)); }
        if (state.optionsPoint && !approving) { await click(state.optionsPoint); continue; }
        if (state.allowPoint && !approving) {
          if (!['Always allow', `Allow ${activeTicket.connector} for this conversation`].includes(state.allowOption ?? '')) throw Error('permission_unconfirmed');
          approving = true;
          await click(state.allowPoint);
          permissions.push({connector: activeTicket.connector, option: /** @type {string} */ (state.allowOption)});
          continue;
        }
        if (!state.permissionPending) approving = false;
        const registered = await request(config, '/extension/check', {nonce: activeTicket.nonce}, fetcher);
        const filesAllowed = permissions.some(p => p.option === `Allow ${activeTicket.connector} for this conversation`);
        if (registered?.registered && newURL && (!registered.media_pending || filesAllowed) && !state.permissionPending) break;
        await pause(1000);
      }
      if (!newURL || now() >= activeTicket.expires_at) throw Error('expired');
      await request(config, '/extension/result', {nonce: activeTicket.nonce, ok: true, url: newURL, ...(permissions.length ? {permissions} : {})}, fetcher);
    } catch (error) {
      if (config && /^[A-Za-z0-9_-]{32}$/.test(/** @type {Ticket | null | undefined} */ (ticket)?.nonce ?? '')) {
        // A configured send may have succeeded before its reply was lost.
        // Navigation alone is insufficient: require our exact nonce-bearing
        // first message and the same owned tab/window before and after lookup.
        if (ordinary && !native && sent && !newURL && tab && wakePrompt) {
          try {
            const current = await browser.tabs.get(tab.id);
            const url = savedChatURL(current.url);
            if (url && current.id === tab.id && current.windowId === ownedWindowId && current.status === 'complete' && !current.pendingUrl) {
              const signal = AbortSignal.timeout(2000), token = await chatgptToken(signal);
              if (token) {
                const response = await fetch('https://chatgpt.com/backend-api/conversation/' + url.split('/').at(-1), {credentials: 'include', redirect: 'error', cache: 'no-store', signal, headers: {Authorization: 'Bearer ' + token}});
                const first = response.ok ? firstUserText(await response.json()) : '';
                // ChatGPT may serialize the resolved connector as an app link.
                const tail = wakePrompt.slice(wakePrompt.indexOf(' wake up.'));
                const ownsMessage = first === wakePrompt || first.endsWith(tail) &&
                  new RegExp('^' + chip + '$').test(first.slice(0, -tail.length));
                if (ownsMessage) {
                  const after = await browser.tabs.get(tab.id);
                  if (after.id === current.id && after.windowId === ownedWindowId && after.url === url && after.status === 'complete' && !after.pendingUrl) newURL = url;
                }
              }
            }
          } catch { /* Recovery never grants another send. */ }
        }
        if (!ordinary && sent && !newURL && tab) {
          try { const current = await browser.tabs.get(tab.id); if (savedChatURL(current.url)) newURL = current.url; } catch {}
        }
        const reason = reasons.has(/** @type {Error | undefined} */ (error)?.message ?? '') ? /** @type {Error} */ (error).message : 'browser_error';
        try { await request(config, '/extension/result', {nonce: /** @type {Ticket} */ (ticket).nonce, ok: false, error: reason, stage, ...(permissions.length ? {permissions} : {}), ...(!native && newURL ? {url: newURL} : {})}, fetcher); } catch { /* Never retry an uncertain wake. */ }
        if (ordinary && !sent && stage === 'loading' && wakeDiagnostic) {
          await persistWakeDiagnostic(browser, wakeDiagnostic, reason, now());
        }
      }
    } finally {
      if (!sent && draftTicket && tab && documentId) {
        /** @type {ReturnType<typeof setTimeout> | undefined} */
        let timer;
        try {
          // Do not use read(): cleanup must also work after ticket expiry.
          await Promise.race([
            browser.scripting.executeScript({target: {tabId: tab.id, documentIds: [documentId]}, func: pageWake, args: [draftTicket, 'discardOwnDraft']}),
            new Promise(resolve => { timer = setTimeout(resolve, 3000); }),
          ]);
        } catch { /* Preserve the original failure, even if cleanup fails. */ }
        finally { clearTimeout(timer); }
      }
      if (attached) { try { await browser.debugger.detach({tabId: /** @type {import('./types.js').Tab} */ (tab).id}); } catch {} }
      if (tab && Number.isSafeInteger(tab.id) && tab.id > 0) {
        try { await browser.tabs.remove(tab.id); await forgetOwnedWakeTab(browser, tab.id, ownedWindowId); } catch { /* The next idle poll closes the recorded orphan. */ }
      } else if (native && typeof ownedWindowId === 'number' && Number.isSafeInteger(ownedWindowId) && ownedWindowId > 0) {
        try { await browser.windows.remove(ownedWindowId); await forgetOwnedWakeTab(browser, undefined, ownedWindowId); } catch { /* The next idle poll closes the recorded orphan tab. */ }
      }
      if (generation === mine) running = false;
    }
  };
}
