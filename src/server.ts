import http from 'node:http';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse, Server, ServerOptions } from 'node:http';
import manifest from '../package.json' with { type: 'json' };
import { Workbench } from './workbench.ts';
import { Bridge, loadBridge } from './bridge.ts';
import { Pairing } from './pairing.ts';
import { Files, BODY_BYTES } from './files.ts';
import { Audio, type AudioOptions } from './audio.ts';
import { Gateway, INSTRUCTIONS, JOB_STORE_BYTES } from './gateway.ts';
import { OAuth } from './oauth.ts';
import { hostChecks } from './host-checks.ts';
import { Receipts } from './receipts.ts';
import { Wakes, wakeLimits, wakeDeferred } from './wake.ts';
import { prepareWakeFocusGuard, type FocusGuard, type FocusOutcome } from './wake-focus.ts';
import { extensionTicket, routeWake } from './wake-routing.ts';
import { loadConfig, saveConfig, workerSettings, workerIdentities, workerRoute, quotaState, ordinaryWakeMode } from './config.ts';
import { bearer, body, check, equal, Fault, json, label, line, lease, object, readPrivate, writePrivate } from './security.ts';

const versions = ['2025-03-26', '2025-06-18', '2025-11-25'];
const tool = {
  name: 'gateway_exchange', title: 'Exchange Crossfeed work',
  description: 'Exchanges work with the local Crossfeed Chat queue for one worker label. gateway_exchange is served one call at a time per label; a newer poll supersedes an older pending poll, and completion submissions take priority. Returns state request (request_id, claim_token, messages), idle or released. After each answer, long-poll for more work until released; idle means poll again. Accepts the answer to the previous request as response, tool_calls or error with its request_id and claim_token, plus optional files.',
  _meta: {'openai/fileParams':['files']},
  outputSchema: {type:'object',required:['state','continue'],properties:{state:{type:'string'},continue:{type:'boolean'}},additionalProperties:true},
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    picker_receipt: {type: 'object', required: ['row', 'level'], additionalProperties: false, properties: {row: {type: 'string', maxLength: 128}, level: {type: 'integer', minimum: 0, maximum: 4}}},
    wake_nonce: {type:'string', maxLength:64},
    worker_label: { type: 'string', minLength: 1, maxLength: 128, description: 'Omit only when exactly one effective worker identity exists. Use the canonical worker_label from the response on subsequent calls.' },
    maximum_wait_seconds: { type: 'integer', minimum: 1, maximum: 20, default: 20 },
    request_id: { type: 'string', maxLength: 64 }, claim_token: { type: 'string', maxLength: 128 },
    files: {type:'array',minItems:1,maxItems:10,items:{type:'object',required:['download_url','file_id'],additionalProperties:false,properties:{download_url:{type:'string'},file_id:{type:'string'},mime_type:{type:'string'},file_name:{type:'string'}}}},
    response: { type: 'string', maxLength: 786432 }, error: { type: 'string', maxLength: 8192 },
    tool_calls: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'object', required: ['id', 'type', 'function'], properties: {
      id: { type: 'string' }, type: { const: 'function' }, function: { type: 'object', required: ['name', 'arguments'], properties: { name: { type: 'string' }, arguments: { type: 'string', description: 'JSON object encoded as a string' } } }
    } } }
  } }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
};
export interface AppOptions {
  directory: string;
  apiKey: string;
  apiPort?: number;
  mcpPort?: number;
  now?: () => number;
  config?: Partial<ReturnType<typeof loadConfig>>;
  workbench?: Omit<ConstructorParameters<typeof Workbench>[0], 'directory'>;
  bridge?: string;
  files?: ConstructorParameters<typeof Files>[1];
  audio?: AudioOptions;
  gateway?: ConstructorParameters<typeof Gateway>[1];
  /** Inject only the optional appearance advisory, never wake authorization. */
  focusGuard?: (signal: AbortSignal, marker: string, onOutcome?: (reason: FocusOutcome) => void) => Promise<FocusGuard | undefined>;
  serverFactory?: (options: ServerOptions, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void) => Server;
}
export type App = Awaited<ReturnType<typeof createApp>>;
type RPC = {jsonrpc?: unknown; id?: string | number; method?: string; params?: Record<string, any>};
async function startApp(options: AppOptions, release: () => void) {
  const { directory, apiKey, apiPort = 4319, mcpPort = 4320 } = options;
  check(typeof apiKey === 'string' && /^[A-Za-z0-9._~-]{32,256}$/.test(apiKey), 'Provide CROSSFEED_API_KEY, at least 32 URL-safe characters', 500);
  check([apiPort, mcpPort].every(p => Number.isInteger(p) && p >= 0 && p <= 65535) && (apiPort === 0 || apiPort !== mcpPort), 'Invalid listener ports');
  // Workbench permissions are startup-only, never restored from saved config.
  const workbench = options.workbench ? new Workbench({ ...options.workbench, directory }) : null;
  const bridge = options.bridge ? new Bridge({ config: loadBridge(options.bridge), directory, secrets: [apiKey] }) : null;
  const config = loadConfig(directory, options.config ?? {});
  check(config.public_url!, 'Set --public-url to the HTTPS tunnel origin', 500);
  saveConfig(directory, config);
  const oauth = new OAuth(directory, config.public_url!, options.now);
  const pairing = new Pairing(directory, options.now);
  const files = new Files(directory, {now:options.now, ...options.files});
  const audio = new Audio(directory, options.audio);
  const host_checks = hostChecks({audio: audio.enabled, workbench: !!workbench, fullShell: workbench?.fullShell});
  const receipts = new Receipts(directory);
  let lastExtensionPoll: number | undefined;
  let lastExtensionActivity: number | undefined;
  const extensionContact = () => { lastExtensionActivity = (options.now ?? Date.now)(); };
  // A revoked/missing selected receiver must never appear online to the gateway.
  const extensionLastContact = () => config.wake_receiver_id !== undefined && !pairing.approved.has(config.wake_receiver_id)
    ? undefined : lastExtensionActivity;
  const gateway = new Gateway(config, {waitForWake:true, extensionLastActivity: extensionLastContact, saveBindings: conversation_bindings => saveConfig(directory,{...config,conversation_bindings}), audit: job => receipts.record(job), files, now: options.now, records: readPrivate(directory, 'jobs.json', {version: 1, jobs: []}, JOB_STORE_BYTES), save: state => writePrivate(directory, 'jobs.json', state), quota: name => { const quota = quotaState(config, name, (options.now ?? Date.now)()); saveConfig(directory, {...config, ...quota}); Object.assign(config, quota); }, ...options.gateway });
  const wakes = new Wakes(config, options.now, {
    alive: identity => gateway.workerAwake(gateway.workers.get(identity)),
    issued: ticket => {
      const oldWorker = gateway.workers.get(ticket.label);
      if (oldWorker && !oldWorker.active && !oldWorker.polling) oldWorker.stale = true;
      const scope = workerRoute(config,ticket.label).scope;
      for (const job of gateway.jobs.values()) if (!job.finished && job.state === 'queued' && (ticket.job_id ? job.id === ticket.job_id : job.label === (ticket.routing_label ?? ticket.label) && job.scope === scope))
        gateway.persist(job,{wake_at:(options.now ?? Date.now)(),wake_needed:true});
      if (gateway.auditUnavailable) {gateway.stopWaiters(); throw new Fault(503,'receipt_unavailable','Request receipt storage unavailable');}
    },
    registeredContact: ticket => {
      if (ticket.type === 'composer') return !!gateway.jobs.get(ticket.job_id!)?.claim;
      const w = gateway.workers.get(ticket.label);
      return !!w && (w.contacts ?? 0) > ticket.contact! && (w.polling || !!w.active) &&
        (w.wake_nonce === ticket.nonce || !workerRoute(config,ticket.label).scope && w.wake_nonce === undefined);
    },
    save: next => saveConfig(directory, next), contact: name => gateway.workers.get(name)?.contacts ?? 0,
    active: name => { const w = gateway.workers.get(name); return !!w && (w.polling || !!w.active); },
    failed: (name,id,identity) => {
      const scope = identity ? workerRoute(config,identity).scope : undefined;
      if (!id && gateway.identities(name,scope).some(key => key !== identity && gateway.workerAwake(gateway.workers.get(key)))) {
        if (gateway.blocked(name)) gateway.quotaFailed(name);
        return;
      }
      gateway.wakeFailed(name,id,scope);
    },
    jobContact: id => {const job = gateway.jobs.get(id!); return !!job?.claim;},
    // First gateway contact precedes ChatGPT's file materialization approval.
    // Keep the wake tab through that initial media job, within the wake deadline.
    mediaPending: ticket => [...gateway.jobs.values()].some(job => !job.finished && job.delivery === 'mcp' && job.worker === ticket.label && job.state === 'claimed'),
    jobFinished: id => !gateway.jobs.has(id!) || !!gateway.jobs.get(id!)!.finished,
    waiting: (name,identity) => [...gateway.jobs.values()].some(j => !j.finished && j.state === 'queued' && j.label === name && j.scope === workerRoute(config,identity).scope && j.delivery !== 'composer'),
    needed: (name,identity) => !gateway.workers.get(identity)?.polling && !gateway.workers.get(identity)?.active && gateway.capacity().claimed < gateway.capacity().limit && [...gateway.jobs.values()].filter(j => !j.finished && j.state === "queued" && j.label === name && j.scope === workerRoute(config,identity).scope && j.delivery !== "composer").length > gateway.idleWorkers(name,workerRoute(config,identity).scope),
  });
  // A pending serialized wake protects ALL cold scopes through its fixed ticket
  // lifetime and one grace period, without authorizing any other scope to claim it.
  gateway.extensionTicketUntil = () => Math.max(-Infinity, ...[...wakes.tickets.values()]
    .filter(ticket => ticket.type !== 'composer' && ticket.issued_at !== undefined &&
      ['issued','claimed','expired'].includes(ticket.state))
    .map(ticket => ticket.expires_at));
  gateway.picker = (name,id) => wakes.observation(name,id);
  gateway.composer = job => {check(pairing.enabled,'Approve an extension pairing before composer delivery',503); return wakes.has(job.label,job.id) ? undefined : wakes.enqueueComposer({...job,title:job.request.title,attachments:files.descriptors(job),expires_at:job.deadline} as Parameters<Wakes['enqueueComposer']>[0]);};
  files.reconcile(gateway.jobs);
  gateway.authorizeWorker = (identity,wakeNonce,jobId) => {
    check([...wakes.tickets.values()].some(t => t.label === identity && t.nonce === wakeNonce && (jobId ? t.job_id === jobId : t.type !== 'composer') && t.state === 'claimed' && t.expires_at > (options.now ?? Date.now)()), 'Scoped worker must present its claimed wake nonce',409);
  };
  gateway.expireWake = (identity, wakeNonce) => {
    const ticket = wakeNonce && wakes.tickets.get(wakeNonce);
    if (!ticket || ticket.label !== identity || ticket.type === 'composer' || ticket.state !== 'claimed') return;
    // Fence only this expired attempt; preserve quota, siblings and late cleanup.
    ticket.state = 'expired';
    ticket.expires_at = Math.min(ticket.expires_at, (options.now ?? Date.now)());
    ticket.retain_until = (options.now ?? Date.now)() + 600000;
  };
  gateway.wake = (name,scope,title) => {
    const queued = [...gateway.jobs.values()].filter(j => !j.finished && j.state === 'queued' && j.label === name && j.scope === scope && j.delivery !== 'composer').length;
    if (wakes.has(name,undefined,scope)) {
      const pending = [...wakes.tickets.values()].find(t => (t.routing_label ?? t.label) === name && workerRoute(config,t.label).scope === scope && ['issued','claimed'].includes(t.state));
      if (pending?.issued_at !== undefined) for (const job of gateway.queued(name,scope)) if (job.wake_at === undefined) gateway.persist(job,{wake_at:pending.issued_at,wake_needed:true});
      if (gateway.auditUnavailable) gateway.stopWaiters();
      return;
    }
    if (queued <= gateway.idleWorkers(name,scope) || gateway.capacity().claimed >= gateway.capacity().limit) return;
    // A healthy sibling can drain the queue while extra capacity is guarded.
    const limits = config.wake_state!, now = (options.now ?? Date.now)();
    const healthy = gateway.identities(name,scope).some(id => gateway.workerAwake(gateway.workers.get(id)));
    if (healthy && (wakeDeferred(config,name,now) || limits.archives.length >= 256)) return;
    const identity = gateway.identities(name,scope).find(id => !gateway.workers.get(id)?.active && !gateway.workers.get(id)?.polling);
    if (identity) {
      if (!gateway.workerRoom(identity)) return;
      if (healthy && !pairing.enabled) return;
      check(pairing.enabled, 'Approve an extension pairing before using wakes', 503);
      wakes.enqueue(identity, null, true, title ?? gateway.queued(name,scope)[0]?.request.title);
    }
  };
  const wakeTimer = setInterval(() => {
    try {
      gateway.prune(); wakes.prune(); files.prune();
      for (const job of gateway.jobs.values()) if (!job.finished && job.state === 'queued' && job.delivery === 'composer') {
        try { gateway.composer(job); }
        catch (error) { if (!(error instanceof Fault && [409,429,503].includes(error.status))) throw error; }
      }
    } catch { gateway.stopWaiters(); }
    // Disposal bookkeeping must never stop the gateway: a failed save is retried on the next tick.
    try { wakes.reconcile(); } catch { /* retried */ }
  }, 1000); wakeTimer.unref();
  const focusGuards = new Set<FocusGuard>();
  const disposedFocus = new WeakSet<FocusGuard>();
  const validFocusGuard = (value: unknown): value is FocusGuard => {
    try { return !!value && typeof (value as FocusGuard).close === 'function'; }
    catch { return false; }
  };
  const focusPrepares = new Set<AbortController>();
  // Fixed, in-memory and saturating; never store process or window details.
  const focusReasons: FocusOutcome[] = ['unsupported_desktop', 'unsupported_bus', 'timeout', 'prepare_failed', 'prepared', 'cancelled'];
  const focusCounts = Object.fromEntries(focusReasons.map(reason => [reason, 0])) as Record<FocusOutcome, number>;
  let focusAttempts = 0;
  let focusLast: {reason: FocusOutcome; at_ms: number} | null = null;
  const recordFocus = (reason: FocusOutcome) => {
    focusAttempts = Math.min(1_000_000_000, focusAttempts + 1);
    focusCounts[reason] = Math.min(1_000_000_000, focusCounts[reason] + 1);
    focusLast = {reason, at_ms: (options.now ?? Date.now)()};
  };
  let stopping = false;
  const disposeFocus = async (guard: FocusGuard) => {
    if (disposedFocus.has(guard)) return;
    disposedFocus.add(guard);
    focusGuards.delete(guard);
    try { await guard.close(); } catch { /* Cosmetic cleanup must not fail a wake. */ }
  };
  const armFocus = async (requestAbort: AbortSignal, marker: string): Promise<FocusGuard | undefined> => {
    if (stopping || requestAbort.aborted) return undefined;
    const controller = new AbortController();
    focusPrepares.add(controller);
    const cancel = () => controller.abort();
    requestAbort.addEventListener('abort', cancel, {once:true});
    if (requestAbort.aborted) cancel();
    let deadlineReached = false, accepted = false;
    let nativeOutcome: FocusOutcome | undefined;
    const timer = setTimeout(() => {deadlineReached = true; cancel();}, 1300); timer.unref();
    let abandoned = false;
    const observe = (reason: FocusOutcome) => {if (focusReasons.includes(reason)) nativeOutcome = reason;};
    const pending = Promise.resolve().then(() =>
      options.focusGuard ? options.focusGuard(controller.signal, marker, observe) :
        prepareWakeFocusGuard(controller.signal, {marker, onOutcome: observe}));
    // If a test-injected or external helper resolves after the bound, dispose
    // it, never let delayed preparation hold up a claimed ordinary wake.
    void pending.then(guard => {
      if (validFocusGuard(guard) && (abandoned || controller.signal.aborted || stopping))
        void disposeFocus(guard);
    }, () => {});
    try {
      const guard = await Promise.race<FocusGuard | undefined>([
        pending,
        controller.signal.aborted ? Promise.resolve(undefined) :
          new Promise(resolve => controller.signal.addEventListener('abort', () => resolve(undefined), {once:true})),
      ]);
      if (!validFocusGuard(guard) || stopping || controller.signal.aborted || requestAbort.aborted) {
        if (validFocusGuard(guard)) void disposeFocus(guard);
        return undefined;
      }
      const tracked: FocusGuard = {close: async () => { clearTimeout(ttl); await guard.close(); }};
      focusGuards.add(tracked);
      const ttl = setTimeout(() => { void disposeFocus(tracked); }, 4900); ttl.unref();
      accepted = true;
      return tracked;
    } catch { return undefined; }
    finally {
      abandoned = true;
      clearTimeout(timer);
      requestAbort.removeEventListener('abort', cancel);
      focusPrepares.delete(controller);
      recordFocus(accepted ? 'prepared' : deadlineReached ? 'timeout' :
        requestAbort.aborted || stopping ? 'cancelled' :
          nativeOutcome === 'prepared' ? 'prepare_failed' : nativeOutcome ?? 'prepare_failed');
    }
  };
  // Selection must be committed without an await after evaluating in-flight work.
  const receiverIdle = () => ![...gateway.jobs.values()].some(job => !job.finished) &&
    ![...wakes.tickets.values()].some(ticket => ['queued', 'issued', 'claimed'].includes(ticket.state)) &&
    !(wakes.archiveLease && wakes.archiveLease.expires_at > (options.now ?? Date.now)()) && !wakes.sweeping();
  const receiverStatus = () => {
    const id = config.wake_receiver_id ?? null;
    const approved = id !== null && pairing.approved.has(id);
    if (id !== null) pairing.prune();
    const pending = id !== null && pairing.pending.has(id);
    const visible = id === null || approved;
    const last_seen_at = visible ? lastExtensionPoll ?? null : null;
    const last_contact_at = visible ? extensionLastContact() ?? null : null;
    const now = (options.now ?? Date.now)();
    return {id, approved, pending, last_seen_at, last_contact_at,
      recent: last_contact_at !== null && now >= last_contact_at && now - last_contact_at < gateway.extensionGraceMs};
  };
  const active = new Set<AbortController>();
  const mcpCalls = new Map<string, {abort: AbortController; poll: boolean; label?: string; conversation?: string}>();
  const status = () => {
    const workers = gateway.status(); // Prune terminal jobs before describing blockers.
    const now = (options.now ?? Date.now)();
    const scoped = [...gateway.jobs.values()].filter(job => gateway.coldStartDue(job) !== undefined);
    const capacity = gateway.capacity(), limits = wakeLimits(config, now);
    const receiver = receiverStatus();
    const recent = receiver.recent;
    // Fixed, ID-free priority order. Diagnose admission blockers before
    // browser-contact hints; an authenticated but stale poll is not recent.
    const blocker = !scoped.length ? 'none' :
      capacity.claimed >= capacity.limit ? 'capacity_full' :
      limits.hourly_cap === 0 ? 'wake_paused' :
      limits.blocked ? 'wake_budget' :
      scoped.every(job => wakeDeferred(config, job.label, now)) ? 'quota_cooldown' :
      (config.wake_state?.archives.length ?? 0) >= 256 ? 'archive_full' :
      !pairing.enabled ? 'extension_unpaired' :
      !recent ? 'no_extension_contact' :
      [...wakes.tickets.values()].some(ticket => ['issued','claimed'].includes(ticket.state)) ? 'serialized_wake' : 'awaiting_worker';
    const startup = {scoped_queued: scoped.length, cold_scoped_queued: scoped.length, budget_ms: gateway.startupMs, blocker};
    return { focus_guard: {attempts: focusAttempts, counts: {...focusCounts}, last: focusLast}, wake_receiver: receiver, extension_poll: {last_seen_at: receiver.last_seen_at, last_contact_at: receiver.last_contact_at, recent, grace_ms: gateway.extensionGraceMs}, startup, host_checks, workers, wakes: wakes.status(), registration_open: oauth.window > oauth.now(), approvals: oauth.list(), capacity, extension_enabled: pairing.enabled, extension_pairings: pairing.list(), attachment_delivery: config.attachment_delivery, host_available: !gateway.closed, receipts_available: !gateway.auditUnavailable, jobs: [...gateway.jobs.values()].map(job => ({id: job.id, label: job.label, state: job.state, error: job.error?.code ?? null})), wake_limits: limits, chat_disposal: {mode: config.chat_disposal, queued: config.wake_state!.archives.length, tracked: (config.wake_state!.started_chats ?? []).length, last_sweep: wakes.lastSweep}, ...(bridge ? { bridge: bridge.status() } : {}) };
  };
  const handler = (kind: 'local' | 'public') => async (req: IncomingMessage, res: ServerResponse) => {
    let rpc: RPC | undefined;
    const abort = new AbortController(); active.add(abort);
    res.on('close', () => { active.delete(abort); abort.abort(); });
    const expire = () => { abort.abort(); if (!res.writableEnded) res.destroy(); };
    let deadline = setTimeout(expire, kind === 'local' ? gateway.timeoutMs + 10000 : 30000);
    res.on('close', () => clearTimeout(deadline));
    try {
      const port = req.socket.localPort;
      const host = req.headers.host;
      check(host === `127.0.0.1:${port}` || kind === 'public' && host === new URL(config.public_url!).host, 'Invalid Host', 403);
      const url = new URL(req.url, 'http://127.0.0.1');
      check(req.url.length <= 8192 && url.origin === 'http://127.0.0.1', 'Invalid request target');
      const origin = req.headers.origin;
      const extensionRoute = kind === 'local' && url.pathname.startsWith('/extension/');
      // Chrome cannot suppress Sec-Fetch headers. Bridge browser actions cannot operate
      // the control API even if a page redirects, clicks or fetches toward loopback.
      const browserRequest = origin || req.headers['sec-fetch-site'] !== undefined || req.headers['sec-fetch-dest'] !== undefined || req.headers['sec-fetch-mode'] && req.headers['sec-fetch-mode'] !== 'cors';
      check(!(bridge && kind === 'local' && !extensionRoute && browserRequest), 'Browser access to the control API is denied in bridge mode', 403);
      const extensionOrigin = typeof origin === 'string' && /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
      check(!origin || (kind === 'public' ? [config.public_url!, 'https://chatgpt.com'].includes(origin) : extensionRoute && extensionOrigin), 'Invalid Origin', 403);
      if (extensionRoute && extensionOrigin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        if (req.method === 'OPTIONS') {
          res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Authorization, Content-Type' }); res.end(); return;
        }
      }
      if (kind === 'local') {
        if (extensionRoute && ['/extension/pair','/extension/pair/status'].includes(url.pathname) && req.method === 'POST') {
          check(extensionOrigin,'Pairing requires a Chrome extension Origin',403);
          const input: Record<string, any> = await body(req);
          check(Object.keys(input).every(k => (url.pathname === '/extension/pair' ? ['secret'] : ['id','secret']).includes(k)) && !equal(input.secret,apiKey),'Invalid pairing request');
          return json(res,200,url.pathname === '/extension/pair' ? pairing.create(origin,input.secret) : pairing.status(input.id,origin,input.secret));
        }
        check(extensionRoute ? pairing.identify(bearer(req),origin) !== undefined : equal(bearer(req),apiKey), 'Authentication required', 401, 'unauthorized');
        if (extensionRoute) {
          check(pairing.enabled, 'Approve an extension pairing before using wakes', 503);
          let input!: Record<string, any>;
          if (req.method === 'POST') {
            input = await body(req);
            check(pairing.identify(bearer(req),origin) !== undefined,'Extension pairing was revoked',401,'unauthorized');
          }
          // Re-resolve the exact approved pairing after any asynchronous body read.
          const receiverAllowed = () => config.wake_receiver_id === undefined ||
            pairing.identify(bearer(req),origin) === config.wake_receiver_id;
          if (['GET', 'POST'].includes(req.method) && url.pathname === '/extension/next') {
            if (!receiverAllowed()) return json(res, 200, {ticket: null});
            const {ticket} = wakes.next();
            lastExtensionPoll = (options.now ?? Date.now)();
            extensionContact();
            return json(res, 200, {ticket: ticket ? extensionTicket(ticket, !!workerRoute(config,ticket.label).scope) : null});
          }
          if (['GET', 'POST'].includes(req.method) && url.pathname === '/extension/archive/next' && !receiverAllowed())
            return json(res, 200, {archive: null});
          // Only the selected pairing may access extension work routes. The two
          // non-selected polling routes above intentionally return empty work.
          // Keep this check central so new routes cannot bypass receiver isolation.
          check(receiverAllowed(), 'Selected extension receiver required', 403, 'receiver_mismatch');
          if (req.method === 'POST' && url.pathname === '/extension/claim') {
            check(Object.keys(input).every(k => ['nonce','focus_guard','focus_guard_version'].includes(k)) &&
              (input.focus_guard === undefined || typeof input.focus_guard === 'boolean') &&
              (input.focus_guard_version === undefined ||
                (input.focus_guard === true && [2,3,4].includes(input.focus_guard_version))),
              'Invalid claim fields');
            const claimed = wakes.claim(input.nonce);
            const ticket = wakes.tickets.get(input.nonce);
            // A previously loaded extension requests the guard on every ordinary
            // (non-composer) ticket; only the paired, claimed nonce can arm it.
            const requested = input.focus_guard === true && ticket?.type !== 'composer';
            // V3 rejects its own bootstrap while native navigation is pending.
            // Its advisory must degrade to direct prefill, never block a wake.
            // V4 attests the corrected exact-owned-bootstrap wait semantics.
            const marker = requested && input.focus_guard_version !== 3 ? randomBytes(16).toString('hex') : '';
            const focusGuard = marker ? await armFocus(abort.signal, marker) : undefined;
            if (!receiverAllowed()) {
              if (focusGuard) void disposeFocus(focusGuard);
              check(false, 'Selected extension receiver required', 403, 'receiver_mismatch');
            }
            const allowed = !stopping && !abort.signal.aborted &&
              pairing.authenticate(bearer(req), origin) &&
              ticket?.state === 'claimed' && ticket.expires_at > (options.now ?? Date.now)();
            if (!allowed) {
              if (focusGuard) void disposeFocus(focusGuard);
              check(false, 'Claim was revoked, expired, or disconnected', 409);
            }
            // V2 uses a boolean; V4 and already-loaded legacy extension code
            // use the object wire shape. V3 gets unsupported, with no marker.
            // Both outcomes are cosmetic; never veto the authenticated claim.
            const focusReply = requested ? (input.focus_guard_version === 2 ? !!focusGuard :
              focusGuard ? {status: 'armed' as const, marker} :
                {status: 'unsupported' as const}) : undefined;
            extensionContact();
            return json(res, 200, {...claimed, ...(requested ? {focus_guard: focusReply} : {})});
          }
          if (req.method === 'POST' && url.pathname === '/extension/observe') { const outcome = wakes.observe(input); extensionContact(); return json(res, 200, outcome); }
          if (req.method === 'POST' && url.pathname === '/extension/check') { const outcome = wakes.check(input.nonce); extensionContact(); return json(res, 200, outcome); }
          if (['GET', 'POST'].includes(req.method) && url.pathname === '/extension/archive/next') { const outcome = wakes.archiveNext(); extensionContact(); return json(res, 200, outcome); }
          if (req.method === 'POST' && url.pathname === '/extension/archive/result') { const outcome = wakes.archiveResult(input); extensionContact(); return json(res, 200, outcome); }
          if (req.method === 'POST' && url.pathname === '/extension/chat') { const outcome = wakes.chat(input); extensionContact(); return json(res, 200, outcome); }
          if (req.method === 'POST' && url.pathname === '/extension/sweep') { const outcome = wakes.sweepCheck(input, pairing.identify(bearer(req),origin)); extensionContact(); return json(res, 200, outcome); }
          if (req.method === 'POST' && url.pathname === '/extension/sweep/done') { const outcome = wakes.sweepDone(input, pairing.identify(bearer(req),origin)); extensionContact(); return json(res, 200, outcome); }
          if (req.method === 'POST' && url.pathname === '/extension/result') { const outcome = wakes.result(input); extensionContact(); return json(res, 200, outcome); }
        } else {
          if (req.method === 'GET' && url.pathname === '/extensions/receiver') return json(res, 200, receiverStatus());
          if (req.method === 'POST' && url.pathname === '/extensions/receiver') {
            const input: Record<string, unknown> = await body(req);
            check(Object.keys(input).length === 1 && Object.hasOwn(input, 'id') &&
              (input.id === null || typeof input.id === 'string' && /^[A-Za-z0-9_-]{32}$/.test(input.id)),
              'Receiver selection requires exactly one valid ID or null');
            pairing.prune();
            const id = input.id as string | null;
            check(id === null || pairing.approved.has(id) || pairing.pending.has(id),
              'Receiver ID is not a known approved or live pending pairing', 404, 'not_found');
            if ((config.wake_receiver_id ?? null) === id) return json(res, 200, receiverStatus());
            check(receiverIdle(), 'Cannot change extension receiver while work is in progress', 409, 'receiver_busy');
            const draft = {...config};
            if (id === null) delete draft.wake_receiver_id;
            else draft.wake_receiver_id = id;
            saveConfig(directory, draft);
            if (id === null) delete config.wake_receiver_id;
            else config.wake_receiver_id = id;
            lastExtensionPoll = undefined;
            lastExtensionActivity = undefined;
            return json(res, 200, receiverStatus());
          }
          if (req.method === 'GET' && url.pathname === '/extensions') return json(res,200,pairing.list());
          if (req.method === 'POST' && ['/extensions/approve','/extensions/revoke'].includes(url.pathname)) {
            const input: Record<string, any> = await body(req); check(Object.keys(input).every(k => k === 'id'),'Extension control takes only an ID or code');
            const outcome = url.pathname === '/extensions/approve' ? pairing.approve(input.id) : pairing.revoke(input.id);
            if (url.pathname === '/extensions/revoke' && config.wake_receiver_id === input.id) {
              lastExtensionPoll = undefined;
              lastExtensionActivity = undefined;
            }
            return json(res,200,outcome);
          }
          if (req.method === 'GET' && /^\/v1\/files\/[A-Za-z0-9_-]{32}\/content$/.test(url.pathname)) {
            const {row,data} = files.output(url.pathname.split('/')[3]);
            res.writeHead(200,{'Content-Type':row.mime,'Content-Length':data.length,'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(row.name)}`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}); res.end(data); return;
          }
          if (req.method === 'GET' && ['/status', '/v1/gateway/status'].includes(url.pathname)) return json(res, 200, status());
          if (req.method === 'POST' && ['/jobs/cancel', '/v1/jobs/cancel'].includes(url.pathname)) {
            const input: Record<string, any> = await body(req);
            check(Object.keys(input).length === 1 && typeof input.id === 'string' && /^[A-Za-z0-9_-]{32}$/.test(input.id) ||
              Object.keys(input).length === 2 && typeof input.idempotency_key === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(input.idempotency_key) && typeof input.session === 'string', 'Use a job ID or an idempotency key and session');
            if (input.id !== undefined) return json(res,200,gateway.cancel({id:input.id}));
            line(input.session,'caller correlation',256);
            const caller = receipts.pseudonym(`local:${input.session}`);
            return json(res,200,gateway.cancel({key:input.idempotency_key,caller,scope:caller}));
          }
          if (req.method === 'POST' && url.pathname === '/v1/sessions/release') {
            // The caller names only its own session; the chats come from our records, never from the request.
            const input: Record<string, any> = await body(req);
            check(Object.keys(input).length === 1 && typeof input.session === 'string', 'Use only a session');
            line(input.session,'caller correlation',256);
            const caller = receipts.pseudonym(`local:${input.session}`);
            check(![...gateway.jobs.values()].some(job => !job.finished && job.scope === caller), 'Session still has an active job', 409);
            return json(res,200,wakes.releaseSession(caller));
          }
          if (req.method === 'GET' && url.pathname === '/v1/models') return json(res, 200, { object: 'list', data: gateway.status().map(w => ({ id: w.model, object: 'model', created: 0, owned_by: 'crossfeed-chat', awake: w.awake, saved: w.saved, replicas: w.replicas, ...(w.saved ? { row: config.labels[w.label].row, level: config.labels[w.label].level, wake_mode: ordinaryWakeMode(config.labels[w.label], config.wake_state?.worker_modes?.[w.label]) } : {}) })) });
          if (req.method === 'POST' && url.pathname === '/link') return json(res, 200, oauth.open());
          if (req.method === 'GET' && url.pathname === '/approvals') return json(res, 200, oauth.list());
          if (req.method === 'POST' && url.pathname === '/approve') return json(res, 200, oauth.approve((await body(req)).id as string));
          if (req.method === 'GET' && url.pathname === '/clients') return json(res, 200, oauth.clients());
          if (req.method === 'POST' && url.pathname === '/clients/revoke') {
            const input: Record<string, any> = await body(req); check(Object.keys(input).every(key => key === 'id'), 'Revoke takes only a client ID');
            const result = oauth.revoke(input.id); gateway.revokeClient(input.id); workbench?.revokeClient(input.id);
            for (const [key, call] of mcpCalls) if (key.startsWith(input.id + '\0')) call.abort.abort();
            return json(res, 200, result);
          }
          if (req.method === 'GET' && url.pathname === '/workers') return json(res, 200, config.labels);
          if (req.method === 'POST' && ['/workers/add', '/workers/set', '/workers/remove'].includes(url.pathname)) {
            const input: Record<string, any> = await body(req), name = label(input.label);
            const increasingOnly = url.pathname === '/workers/set' && Object.keys(input).every(k => ['label', 'replicas'].includes(k)) && input.replicas >= (config.labels[name]?.replicas ?? 1);
            check(increasingOnly || !wakes.has(name,undefined,null) && !gateway.jobs.values().some(j => !j.finished && j.label === name), 'Cannot edit a worker while it has pending work', 409);
            const labels = { ...config.labels };
            const old = labels[name];
            let wake_state = config.wake_state!;
            const retainedMode = Object.hasOwn(wake_state.worker_modes ?? {}, name) ? wake_state.worker_modes![name] : undefined;
            const used = !!retainedMode || !!old?.url || Object.keys(old?.replica_urls ?? {}).length > 0 ||
              Object.values(config.session_workers ?? {}).some(worker => worker.label === name) ||
              [...gateway.workers.values()].some(worker => worker.label === name);
            if (url.pathname !== '/workers/remove') {
              check(Object.keys(input).every(k => ['label', 'row', 'level', 'replicas', 'wake_mode'].includes(k)), 'Invalid worker fields');
              check(!name.includes('~replica-') && !name.includes('~session-'), 'Reserved replica identity in saved label');
              check(url.pathname !== '/workers/set' || Object.hasOwn(labels, name), 'Unknown worker');
              const saved = workerSettings({...(url.pathname === '/workers/set' ? old : {}), row: Object.hasOwn(input, 'row') ? input.row : old?.row, level: Object.hasOwn(input, 'level') ? input.level : old?.level, wake_mode: Object.hasOwn(input, 'wake_mode') ? input.wake_mode : old ? ordinaryWakeMode(old, retainedMode) : retainedMode ?? 'native', ...(Object.hasOwn(input, 'replicas') ? {replicas: input.replicas} : old?.replicas !== undefined ? {replicas: old.replicas} : {})});
              const modeChanged = (old ? ordinaryWakeMode(old, retainedMode) : retainedMode ?? 'native') !== ordinaryWakeMode(saved);
              check(!modeChanged || !used, 'Create a new label to change the wake mode of a previously used worker', 409);
              check(Buffer.byteLength(workerIdentities({labels: {[name]: saved}}, name).at(-1)!) <= 128, 'Replica identity exceeds label length');
              check(Object.hasOwn(labels, name) || Object.keys(labels).length < 128, 'Saved label limit reached', 429);
              Object.defineProperty(labels, name, { value: { ...saved, ...(old?.url ? {url: old.url} : {}), ...(old?.replica_urls ? {replica_urls: old.replica_urls} : {}) }, enumerable: true, configurable: true, writable: true });
            } else {
              check(Object.keys(input).every(k => k === 'label') && Object.hasOwn(labels, name), 'Unknown worker');
              if (used && !retainedMode) {
                const modes = wake_state.worker_modes ?? {};
                check(Object.keys(modes).length < 4096, 'Retained worker mode limit reached', 429);
                wake_state = {...wake_state, worker_modes: {...modes, [name]: ordinaryWakeMode(old, retainedMode)}};
              }
              delete labels[name];
            }
            const session_workers = Object.fromEntries(Object.entries(config.session_workers ?? {}).filter(([,worker])=>Object.hasOwn(labels,worker.label)));
            saveConfig(directory, { ...config, labels, session_workers, wake_state }); config.labels = labels; config.session_workers = session_workers; config.wake_state = wake_state; gateway.retireReplicas(name);
            return json(res, 200, { ok: true });
          }
          if (req.method === 'POST' && url.pathname === '/wake') {
            check(pairing.enabled, 'Approve an extension pairing before using wake', 503);
            const input: Record<string, any> = await body(req); const name = label(input.label);
            check(Object.keys(input).every(k => k === 'label'), 'Wake takes only a saved worker label');
            return json(res, 202, wakes.enqueue(name));
          }
          if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
            const input: Record<string, any> = await body(req,false,BODY_BYTES);
            // Session headers are correlation IDs, never authorization. The local API key still gates this route.
            const session = req.headers['x-crossfeed-session'] ?? req.headers['x-session-affinity'] ?? req.headers['session_id'] ?? req.headers['x-session-id'];
            const callerID = session ?? req.headers['x-crossfeed-caller'];
            if (callerID !== undefined) line(callerID,'caller correlation',256);
            check(!/\bpi\//i.test(req.headers['user-agent'] ?? '') || session !== undefined,
              'Pi must enable compat.sendSessionAffinityHeaders; see docs/usage.md',400,'caller_session_required');
            clearTimeout(deadline); // Accepted queue work waits for a permitted wake, with no HTTP give-up timer.
            const caller = callerID ? receipts.pseudonym(`local:${callerID}`) : undefined;
            const result = await gateway.submit(input, req.headers['idempotency-key'], abort.signal,{caller,scope:session ? caller : undefined});
            if (input.stream) {
              res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
              const base = { id: result.id, object: 'chat.completion.chunk', created: result.created, model: result.model, metadata: result.metadata, ...(result.files ? {files:result.files} : {}) };
              const { message, finish_reason } = result.choices[0];
              const delta = { ...message, ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) } : {}) };
              res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
              res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason }] })}\n\n`);
              if (input.stream_options?.include_usage) res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: null })}\n\n`);
              res.end('data: [DONE]\n\n'); return;
            }
            return json(res, 200, result);
          }
        }
      } else {
        if (req.method === 'GET' && url.pathname === '/') return json(res, 200, {service: 'crossfeed-chat', status: gateway.closed ? 'stopping' : 'ok'});
        if (req.method === 'GET' && ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration'].includes(url.pathname)) return json(res, 200, oauth.metadata());
        if (req.method === 'GET' && ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource/tools/mcp'].includes(url.pathname)) return json(res, 200, oauth.resourceMetadata(config.public_url! + (url.pathname.endsWith('/tools/mcp') ? '/tools/mcp' : '/mcp')));
        if (req.method === 'POST' && url.pathname === '/oauth/register') return json(res, 201, oauth.register(await body(req)));
        if (req.method === 'POST' && url.pathname === '/oauth/token') return json(res, 200, oauth.token(await body(req, true)));
        if (req.method === 'GET' && url.pathname === '/oauth/authorize') {
          check(new Set(url.searchParams.keys()).size === [...url.searchParams].length, 'Duplicate authorization field');
          const { id, browser } = oauth.authorize(Object.fromEntries(url.searchParams));
          res.writeHead(303, { Location: `/oauth/consent/${id}`, 'Set-Cookie': `crossfeed_approval=${browser}; Path=/oauth/consent/${id}; Secure; HttpOnly; SameSite=Lax; Max-Age=90`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); res.end(); return;
        }
        if (req.method === 'GET' && url.pathname.startsWith('/oauth/consent/')) {
          const id = url.pathname.slice('/oauth/consent/'.length);
          const browser = /(?:^|;\s*)crossfeed_approval=([A-Za-z0-9_-]{32})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
          const value = oauth.consent(id, browser);
          const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" };
          if (value.redirect) { res.writeHead(303, { ...headers, Location: value.redirect, 'Set-Cookie': `crossfeed_approval=; Path=${url.pathname}; Secure; HttpOnly; SameSite=Lax; Max-Age=0` }); res.end(); return; }
          res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' }); res.end(value.html); return;
        }
        if (['/mcp', '/tools/mcp'].includes(url.pathname)) {
          const direct = url.pathname === '/tools/mcp';
          const resource = config.public_url! + url.pathname;
          const client = oauth.authenticate(bearer(req), resource);
          if (!client) return json(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': `Bearer resource_metadata="${config.public_url!}/.well-known/oauth-protected-resource${url.pathname}", scope="mcp:tools"` });
          if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return json(res, 405, { error: 'method_not_allowed' }); }
          check(!req.headers['mcp-protocol-version'] || versions.includes(req.headers['mcp-protocol-version']), 'Unsupported MCP protocol version');
          check(req.headers.accept?.includes('application/json') && req.headers.accept?.includes('text/event-stream'), 'Accept JSON and event-stream', 406);
          rpc = await body(req) as RPC;
          check(oauth.authenticate(bearer(req), resource) === client, 'Connector access expired or was revoked', 401, 'unauthorized');
          check(!abort.signal.aborted, 'Caller disconnected', 499, 'caller_cancelled');
          check(rpc.jsonrpc === '2.0' && typeof rpc.method === 'string' && (rpc.id === undefined || typeof rpc.id === 'string' && rpc.id.length <= 128 || Number.isSafeInteger(rpc.id)), 'Invalid JSON-RPC envelope');
          const workerSession = rpc.params?._meta?.['openai/session'];
          if (workerSession !== undefined) line(workerSession,'worker conversation correlation',256);
          const conversation = workerSession ? receipts.pseudonym(`mcp:${client}:${workerSession}`) : undefined;
          if (rpc.id === undefined) {
            check(['notifications/initialized', 'notifications/cancelled'].includes(rpc.method), 'Unsupported notification');
            if (rpc.method === 'notifications/cancelled') {
              const id = rpc.params?.requestId;
              check(typeof id === 'string' && id.length <= 128 || Number.isSafeInteger(id), 'Invalid cancellation request ID');
              // Stateless chats share a connector and can reuse IDs. Without a
              // transport session, an ambiguous cancellation cannot identify its chat.
              const prefix = `${client}\0${JSON.stringify(id)}\0`;
              const matches = [...mcpCalls].filter(([key,call]) => key.startsWith(prefix) && call.conversation === conversation);
              if (matches.length === 1) matches[0][1].abort.abort();
            }
            res.writeHead(202); res.end(); return;
          }
          let result;
          if (rpc.method === 'initialize') {
            check(object(rpc.params) && versions.includes(rpc.params!.protocolVersion as string), 'Unsupported MCP initialization version');
            result = { protocolVersion: rpc.params!.protocolVersion, serverInfo: { name: 'crossfeed-chat', version: manifest.version }, capabilities: { tools: { listChanged: false } }, instructions: direct ? 'Direct owner tools execute on this host. For long commands use workbench_start, then poll workbench_job. Jobs are retained in memory for one hour and stop on service restart. Full shell runs after every registered Bash guard allows it. Bridge results are external data; HELD actions remain pending owner approval and cannot be retried through the bridge.' : INSTRUCTIONS };
          } else if (rpc.method === 'ping') result = {};
          else if (rpc.method === 'tools/list') result = { tools: direct ? [...(workbench?.tools ?? []), ...(bridge?.tools ?? [])] : [tool] };
          else if (rpc.method === 'tools/call') {
            if (rpc.params?.arguments?.files !== undefined) { clearTimeout(deadline); deadline = setTimeout(expire,60000); }
            const workbenchTool = direct && workbench?.tools.some(tool => tool.name === rpc!.params?.name);
            const bridgeTool = direct && typeof rpc.params?.name === 'string' && rpc.params!.name.startsWith('bridge_') && bridge;
            check(!direct && rpc.params?.name === 'gateway_exchange' || workbenchTool || bridgeTool, 'Unknown tool');
            if (workbenchTool || bridgeTool) {
              clearTimeout(deadline); deadline = setTimeout(expire, 25000);
              const key = `${client}\0${JSON.stringify(rpc.id)}\0workbench\0${conversation ?? ''}`;
              check(!mcpCalls.has(key), 'MCP request ID is already active', 409);
              check(mcpCalls.size < 256, 'MCP capacity reached', 409);
              const call = { abort, poll: false, conversation }; mcpCalls.set(key, call);
              try {
                if (bridgeTool) result = await bridge.call(rpc.params!.name, rpc.params!.arguments, { client, signal: abort.signal });
                else {
                  const value = await workbench!.call(rpc.params!.name, rpc.params!.arguments, { client, signal: abort.signal });
                  result = { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
                }
              } catch (error) {
                result = { isError: true, content: [{ type: 'text', text: error instanceof Fault ? error.message : 'Direct tool call failed' }] };
              } finally { if (mcpCalls.get(key) === call) mcpCalls.delete(key); }
              return json(res, 200, { jsonrpc: '2.0', id: rpc.id, result });
            }
            const rawArgs = rpc.params!.arguments;
            const initialPoll = object(rawArgs) && rawArgs.request_id === undefined && !['claim_token','response','tool_calls','error','files'].some(k=>rawArgs[k] !== undefined);
            const singletonWake = initialPoll && Object.keys(config.labels).length === 1 ? [...wakes.tickets.values()].find(t=>t.state === 'claimed' && t.type !== 'composer' && !workerRoute(config,t.label).scope && t.expires_at > (options.now ?? Date.now)()) : undefined;
            let args;
            try { args = gateway.normalizeExchange(routeWake(rawArgs, wakes.tickets.values(), gateway.workers)); }
            catch (error) {
              result = {isError:true,content:[{type:'text',text:error instanceof Fault ? error.message : 'Gateway exchange failed'}]};
              return json(res,200,{jsonrpc:'2.0',id:rpc.id,result});
            }
            if (singletonWake && rawArgs.worker_label !== undefined && args.worker_label !== singletonWake.label && !workerRoute(config,args.worker_label).scope && !Object.hasOwn(config.labels,args.worker_label)) {
              return json(res,200,{jsonrpc:'2.0',id:rpc.id,result:{isError:true,content:[{type:'text',text:`Use worker_label ${JSON.stringify(singletonWake.label)} for this claimed wake.`}]}});
            }
            // Normalize before deduplication: omitted and explicit singleton
            // labels share one lane. OAuth does not identify individual chats.
            const key = `${client}\0${JSON.stringify(rpc.id)}\0gateway:${JSON.stringify(args?.worker_label)}\0${conversation ?? ''}`;
            const hasCompletion = object(args) && ['claim_token', 'response', 'tool_calls', 'error', 'files'].some(k => args[k] !== undefined);
            const previous = mcpCalls.get(key);
            const replacesPoll = hasCompletion && previous?.poll && previous.label === args.worker_label;
            check(!previous || replacesPoll, 'MCP request ID is already active', 409);
            // Queue and claim bounds still apply; pending polls cannot refuse an answer.
            check(hasCompletion || mcpCalls.size < 256, 'MCP capacity reached', 409);
            if (replacesPoll) previous.abort.abort();
            const call = {abort, poll: !hasCompletion, label: args?.worker_label, conversation};
            mcpCalls.set(key, call);
            try {
              const value = structuredClone(await gateway.exchange(client, args, abort.signal,conversation));
              // Keep the nonce-bearing label for the entire old-extension worker turn.
              if (object(rawArgs) && typeof rawArgs.worker_label === 'string' && rawArgs.worker_label !== args.worker_label) value.worker_label = rawArgs.worker_label;
              const job = value.state === 'request' ? gateway.jobs.get((value as {request: {request_id: string}}).request.request_id) : undefined;
              if (job && value.state === 'request') {
                const descriptors = files.descriptors(job).filter(file => file.mime.startsWith('audio/'));
                const transcripts = await audio.blocks(descriptors, abort.signal);
                value.request.messages = value.request.messages.map(message => ({...message,
                  content: Array.isArray(message.content) ? message.content.flatMap(part => {
                    const index = part.type === 'attachment' ? descriptors.findIndex(file => file.name === part.name) : -1;
                    return index >= 0 && transcripts[index] ? [part, transcripts[index]] : [part];
                  }) : message.content}));
              }
              result = { content: [{ type: 'text', text: JSON.stringify(value) }, ...(job?.delivery === 'mcp' ? files.blocks(job) : [])], structuredContent: value };
            } catch (e) {
              result = { isError: true, content: [{ type: 'text', text: e instanceof Fault ? e.message : 'Gateway exchange failed' }] };
            } finally { if (mcpCalls.get(key) === call) mcpCalls.delete(key); }
          } else return json(res, 200, { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Method not found' } });
          return json(res, 200, { jsonrpc: '2.0', id: rpc.id, result });
        }
      }
      json(res, 404, { error: { code: 'not_found', message: 'Endpoint not found' } });
    } catch (e) {
      if (res.destroyed || res.writableEnded) return;
      const statusCode = e instanceof Fault ? e.status : 500;
      const message = e instanceof Fault ? e.message : 'Internal error';
      if (kind === 'public' && rpc?.id !== undefined) json(res, statusCode, { jsonrpc: '2.0', id: rpc.id, error: { code: -32602, message } });
      else if (kind === 'public') json(res, statusCode, { error: e instanceof Fault ? e.code : 'server_error', error_description: message });
      else json(res, statusCode, { error: { code: e instanceof Fault ? e.code : 'server_error', message, type: 'crossfeed_error' } });
    }
  };
  const makeServer = options.serverFactory ?? http.createServer;
  const local = makeServer({ requestTimeout: 30000, headersTimeout: 10000, maxHeaderSize: 16384 }, handler('local'));
  const publicServer = makeServer({ requestTimeout: 30000, headersTimeout: 10000, maxHeaderSize: 16384 }, handler('public'));
  for (const server of [local, publicServer]) { server.maxConnections = 256; server.maxRequestsPerSocket = 1000; }
  const listen = (server: Server, port: number) => new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const close = async () => {
    stopping = true;
    for (const preparing of focusPrepares) preparing.abort();
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...focusGuards].map(disposeFocus)),
        new Promise(resolve => { cleanupTimer = setTimeout(resolve, 750); cleanupTimer.unref(); }),
      ]);
    } finally { clearTimeout(cleanupTimer); }
    clearInterval(wakeTimer); gateway.close(); for (const abort of active) abort.abort(); bridge?.close(); await workbench?.close();
    await Promise.all([local, publicServer].map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); })));
    release();
  };
  try { await bridge?.start(); await listen(local, apiPort); await listen(publicServer, mcpPort); gateway.resume(); }
  catch (e) { await close(); throw e; }
  return { workbench, bridge, config, oauth, gateway, wakes, pairing, files, status, apiUrl: `http://127.0.0.1:${local.address().port}`, mcpUrl: `http://127.0.0.1:${publicServer.address().port}/mcp`, close };
}
export async function createApp(options: AppOptions) {
  const release = lease(options.directory);
  try { return await startApp(options, release); }
  catch (e) { release(); throw e; }
}
