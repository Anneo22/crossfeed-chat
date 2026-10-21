import type { WakeConfig, ComposerJob, PickerReceipt, WakeState, WakeTicket } from './types.ts';
import { quotaState, workerIdentities, workerRoute, retainedUrls, ordinaryWakeMode } from './config.ts';
import { check, chatUrl, nonce, object, shortTitle } from './security.ts';

// Calendar days use the service host's local timezone; the hour remains rolling across midnight.
export function wakeLimits(config: WakeConfig, now = Date.now()) {
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  const tomorrow = new Date(midnight); tomorrow.setDate(tomorrow.getDate() + 1);
  const wakes = config.wake_state?.wakes ?? [];
  const hourly = wakes.filter(t => t > now - 3600000);
  const daily = wakes.filter(t => t >= midnight.getTime());
  const daily_cap = config.wake_daily_cap ?? 0, hourly_cap = config.wake_hourly_cap ?? 12;
  const daily_reset_at = tomorrow.getTime();
  const hourly_reset_at = hourly.length >= hourly_cap && hourly_cap > 0
    ? [...hourly].sort((a,b) => a-b)[hourly.length - hourly_cap] + 3600000 : now;
  const blocked = daily_cap > 0 && daily.length >= daily_cap
    ? `Daily fresh-chat cap (${daily_cap}) reached. Retry after local midnight (${new Date(daily_reset_at).toISOString()}).`
    : hourly.length >= hourly_cap
      ? hourly_cap === 0 ? 'Fresh-chat wakes are paused. Restart serve with a positive --wake-hourly-cap.'
        : `Hourly fresh-chat cap (${hourly_cap}) reached. Retry after ${new Date(hourly_reset_at).toISOString()}.`
      : null;
  return {daily_cap, daily_cap_status: daily_cap === 0 ? 'off' : 'on', hourly_cap, attempts: daily.length, hourly_attempts: hourly.length, daily_reset_at, hourly_reset_at, blocked, cooldown_until: config.wake_state?.cooldown_until ?? 0};
}

const pending = (t: WakeTicket) => ['queued', 'issued', 'claimed'].includes(t.state);
export function wakeRetryDelay(config: WakeConfig, name: string) {
  return (config.wake_state?.failed_attempts?.[name] ?? 1) <= 3 ? 60000 : 600000;
}
export function wakeDeferred(config: WakeConfig, name: string, now = Date.now()) {
  const state = config.wake_state;
  return (config.quota_pause_until ?? 0) > now || (config.quota_until?.[name] ?? 0) > now || !!wakeLimits(config, now).blocked || (state?.cooldown_until ?? 0) > now
    || Object.hasOwn(state?.failed ?? {}, name) && state!.failed[name] + wakeRetryDelay(config, name) > now;
}
interface WakeOptions {
  alive?: (identity: string) => boolean; issued?: (ticket: WakeTicket) => void; registeredContact?: (ticket: WakeTicket) => boolean; save?: (config: WakeConfig) => void; contact?: (name: string) => number; active?: (name: string) => boolean; failed?: (name: string, jobId?: string, identity?: string) => void; jobContact?: (id: string | undefined) => boolean; jobFinished?: (id: string | undefined) => boolean; needed?: (name: string, identity: string) => boolean; waiting?: (name: string, identity: string) => boolean; mediaPending?: (ticket: WakeTicket) => boolean }
interface WakeInput { nonce: string; picker_receipt?: PickerReceipt; ok?: boolean; url?: string; error?: string; stage?: string; permissions?: {connector: string; option: string}[] }
// Store only fixed diagnostic identifiers, never page text or browser errors.
const failureCodes = new Set(['invalid_ticket', 'page_not_ready', 'page_changed', 'mode_unconfirmed', 'level_unconfirmed', 'level_unavailable', 'permission_unconfirmed', 'upload_unconfirmed', 'upload_failed', 'composer_not_empty', 'mention_unconfirmed', 'send_unconfirmed', 'claim_refused', 'expired', 'browser_error', 'rate_limited']);
const failureStages = new Set(['loading', 'create', 'attach', 'activate', 'load', 'upload', 'enter', 'observe', 'result', 'claim', 'input', 'ready', 'registration', 'modelFocus', 'picker', 'sliderFocus', 'editorFocus', 'mention', 'resolved', 'send', 'uploadInput', 'uploads']);
export class Wakes {
  declare config: WakeConfig; declare now: () => number; declare save: (config: WakeConfig) => void; declare contact: (name: string) => number; declare active: (name: string) => boolean;
  declare failed: (name: string, jobId?: string, identity?: string) => void; declare jobContact: (id: string | undefined) => boolean; declare jobFinished: (id: string | undefined) => boolean;
  declare mediaPending: (ticket: WakeTicket) => boolean;
  declare needed: (name: string, identity: string) => boolean;
  declare waiting: (name: string, identity: string) => boolean;
  declare issued: (ticket: WakeTicket) => void; declare registeredContact?: (ticket: WakeTicket) => boolean;
  declare alive: (identity: string) => boolean; declare lastReconcile: number; declare lastSweep: {at: number; deleted: number} | null;
  declare tickets: Map<string, WakeTicket>; declare archiveLease: {nonce: string; url: string; expires_at: number; remove?: boolean} | null;
  sweepLeases = new Map<string, number>();

  constructor(config: WakeConfig, now = Date.now, { alive = () => true, save = () => {}, contact = () => 0, active = () => false, failed = () => {}, jobContact = () => false, jobFinished = () => true, needed = () => true, waiting = () => false, mediaPending = () => false, issued = () => {}, registeredContact }: WakeOptions = {}) {
    this.issued = issued; this.registeredContact = registeredContact; this.alive = alive; this.lastReconcile = 0; this.lastSweep = null;
    this.config = config; this.now = now; this.save = save; this.contact = contact; this.active = active; this.failed = failed; this.jobContact = jobContact; this.jobFinished = jobFinished;
    this.mediaPending = mediaPending; this.needed = needed; this.waiting = waiting; this.tickets = new Map(); this.archiveLease = null;
    config.wake_state ??= { wakes: [], failed: {}, cooldown_until: 0, archives: [] };
  }
  persist(state: WakeState, labels = this.config.labels, quota_until = this.config.quota_until, quota_pause_until = this.config.quota_pause_until) {
    this.save({ ...this.config, labels, wake_state: state, quota_until, quota_pause_until });
    this.config.labels = labels; this.config.wake_state! = state; this.config.quota_until = quota_until; this.config.quota_pause_until = quota_pause_until;
  }
  notifyFailure(ticket: WakeTicket) {
    if (ticket.type === 'composer') this.failed(ticket.routing_label ?? ticket.label, ticket.job_id);
    else this.failed(ticket.routing_label ?? ticket.label, undefined, ticket.label);
  }
  failure(ticket: WakeTicket, state = 'failed', rateLimited = false) {
    const limits = structuredClone(this.config.wake_state!);
    Object.defineProperty(limits.failed, (ticket.routing_label ?? ticket.label), { value: this.now(), enumerable: true, configurable: true, writable: true });
    limits.failed_attempts = Object.fromEntries(Object.entries(limits.failed_attempts ?? {}).filter(([name]) => Object.hasOwn(this.config.labels,name)));
    const name = ticket.routing_label ?? ticket.label;
    Object.defineProperty(limits.failed_attempts, name, {value: Math.min(1000, (Object.hasOwn(limits.failed_attempts,name) ? limits.failed_attempts[name] : 0) + 1), enumerable:true, configurable:true, writable:true});
    // A chat recorded the moment it existed is queued on every failure, whether or not the extension reports it again.
    if (ticket.chat_url && !retainedUrls(this.config).includes(ticket.chat_url) && !limits.archives.includes(ticket.chat_url) && limits.archives.length < 256) limits.archives.push(ticket.chat_url);
    const quota = rateLimited ? quotaState(this.config, (ticket.routing_label ?? ticket.label), this.now()) : this.config;
    this.persist(limits, this.config.labels, quota.quota_until, quota.quota_pause_until);
    ticket.state = state; ticket.retain_until = this.now() + 600000;
    ticket.error = rateLimited ? 'ChatGPT rate limit: this label is paused for 60 minutes' : `Fresh-chat wake failed; retry after ${wakeRetryDelay(this.config, ticket.routing_label ?? ticket.label) / 60000} minute(s)`;
    this.notifyFailure(ticket);
  }
  prune() {
    for (const [key, t] of this.tickets) {
      // Manual queued wakes adopt callers too, even before recent contact becomes stale.
      if (t.state === 'queued' && t.type !== 'composer' && this.waiting(t.routing_label ?? t.label,t.label)) t.automatic = true;
      if (t.state === 'queued' && t.automatic && !this.needed(t.routing_label ?? t.label,t.label)) {t.state='cancelled';t.retain_until=this.now()+600000;}
      // Job-backed tickets wait for demand cancellation or the job deadline before issue.
      if (pending(t) && !(t.state === 'queued' && (t.automatic || t.type === 'composer')) && t.expires_at <= this.now()) this.failure(t, 'expired');
      if (t.retain_until && t.retain_until <= this.now() && !(t.type === 'composer' && t.url && !this.jobFinished(t.job_id))) this.tickets.delete(key);
    }
  }
  has(name: string, jobId?: string, scope?: string | null) { this.prune(); return [...this.tickets.values()].some(t => (t.routing_label ?? t.label) === name && (jobId ? t.job_id === jobId : t.type !== 'composer' && (scope === null || workerRoute(this.config,t.label).scope === scope)) && pending(t)); }
  enqueueComposer(job: ComposerJob) {
    check(object(job) && typeof job.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(job.id) && Array.isArray(job.attachments) && job.attachments.length > 0 && job.attachments.length <= 10, 'Invalid composer job');
    return this.enqueue(workerIdentities(this.config,job.label,job.scope)[0], job, false, job.title);
  }
  enqueue(identity: string, job: ComposerJob | null = null, automatic = false, title?: string) {
    this.prune();
    const {name,scope} = workerRoute(this.config, identity);
    check(workerIdentities(this.config,name,scope).includes(identity), 'Unknown worker identity');
    check(Object.hasOwn(this.config.labels, name), 'Save a worker with worker add <label> --row ROW --level 0..4 first', 404);
    check((this.config.quota_pause_until ?? 0) <= this.now() && (!Object.hasOwn(this.config.quota_until ?? {}, name) || this.config.quota_until![name] <= this.now()), 'Worker label is paused by a ChatGPT quota limit', 429, 'quota_blocked');
    check(![...this.tickets.values()].some(t => pending(t) && (job ? t.job_id === job.id : t.label === identity && t.type !== 'composer')), 'Wake already pending', 409);
    check(this.tickets.size < 128, 'Wake queue is full', 429);
    check(this.config.wake_state!.archives.length < 256, 'Archive queue is full; allow archive retries first', 429);
    const ticket: WakeTicket = { nonce: nonce(), label: identity, ...(identity !== name ? {routing_label: name} : {}), ...(automatic ? {automatic: true} : {}), row: this.config.labels[name].row, level: this.config.labels[name].level,
      // Preserve saved picker behavior; new native labels carry an explicit mode.
      wake_mode: job ? (this.config.labels[name].wake_mode ?? 'configured') : ordinaryWakeMode(this.config.labels[name], this.config.wake_state!.worker_modes?.[name]),
      connector: this.config.connector!, expires_at: this.now() + 900000, state: 'queued', ...(shortTitle(title ?? job?.title) ? {title: shortTitle(title ?? job?.title)} : {}),
      ...(job ? {type: 'composer', job_id: job.id, attachments: structuredClone(job.attachments)} : {}) };
    this.tickets.set(ticket.nonce, ticket);
    return { label: name, queued: true };
  }
  next() {
    this.prune();
    if ([...this.tickets.values()].some(t => ['issued', 'claimed'].includes(t.state))) return { ticket: null };
    for (const ticket of this.tickets.values()) {
      if (ticket.state !== 'queued') continue;
      if (ticket.automatic && !this.needed(ticket.routing_label ?? ticket.label, ticket.label)) { ticket.state = 'cancelled'; ticket.retain_until = this.now() + 600000; continue; }
      const name = ticket.routing_label ?? ticket.label;
      if (ticket.type === 'composer' && this.jobFinished(ticket.job_id)) { ticket.state = 'cancelled'; ticket.retain_until = this.now() + 600000; continue; }
      const limits = structuredClone(this.config.wake_state!), now = this.now();
      const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
      limits.wakes = limits.wakes.filter(t => t >= Math.min(midnight.getTime(), now - 3600000));
      const cap = wakeLimits(this.config, now);
      limits.failed = Object.fromEntries(Object.entries(limits.failed).filter(([failedName, t]) => t + wakeRetryDelay(this.config, failedName) > now));
      if ((ticket.automatic || ticket.type === 'composer') && wakeDeferred(this.config, name, now)) continue;
      if ((this.config.quota_pause_until ?? 0) > now || (Object.hasOwn(this.config.quota_until ?? {}, name) && this.config.quota_until![name] > now) || limits.cooldown_until > now || Object.hasOwn(limits.failed, name) || cap.blocked || limits.archives.length >= 256) {
        ticket.state = 'failed'; ticket.error = cap.blocked ?? 'Wake paused by a quota or cooldown. Check doctor, then retry after the pause expires.'; ticket.retain_until = now + 600000;
        this.notifyFailure(ticket); continue;
      }
      limits.wakes.push(now); this.persist(limits);
      ticket.state = 'issued'; ticket.issued_at = now; ticket.expires_at = now + 240000; ticket.contact = this.contact(ticket.label); this.issued(ticket);
      const { state, contact, claimed, ...fields } = ticket;
      return { ticket: fields };
    }
    return { ticket: null };
  }
  claim(key: string) {
    this.prune(); const ticket = this.tickets.get(key);
    check(ticket?.state === 'issued', 'Wake nonce is invalid, consumed, or expired', 409);
    const name = ticket.routing_label ?? workerRoute(this.config, ticket.label).name;
    if (ticket.type !== 'composer' && !Object.hasOwn(this.config.wake_state!.worker_modes ?? {}, name)) {
      const modes = this.config.wake_state!.worker_modes ?? {};
      check(Object.keys(modes).length < 4096, 'Retained worker mode limit reached; use an existing label', 429);
      this.persist({...this.config.wake_state!, worker_modes: {...modes, [name]: ticket.wake_mode ?? ordinaryWakeMode(this.config.labels[name])}});
    }
    ticket.state = 'claimed'; ticket.claimed = true; return { ok: true };
  }
  observe(value: unknown) {
    const input = value as WakeInput;
    this.prune(); const ticket = this.tickets.get(input.nonce), receipt = input.picker_receipt;
    check(ticket?.state === 'claimed' && object(receipt) && Object.keys(input).every(key => ['nonce', 'picker_receipt'].includes(key)) && Object.keys(receipt).every(key => ['row', 'level'].includes(key)) && receipt.row === ticket.row && receipt.level === ticket.level, 'Observation must match the claimed wake picker', 409);
    ticket.picker_receipt = {row: receipt.row, level: receipt.level, source: 'extension', observed_at: this.now()};
    return {ok: true};
  }
  observation(name: string, jobId?: string) { return [...this.tickets.values()].find(ticket => ticket.label === name && (jobId ? ticket.job_id === jobId : ticket.type !== 'composer') && ticket.state === 'claimed' && ticket.expires_at > this.now())?.picker_receipt ?? null; }
  registered(ticket: WakeTicket) { if (this.registeredContact) return this.registeredContact(ticket); return ticket.type === 'composer' ? this.jobContact(ticket.job_id) : this.contact(ticket.label) > ticket.contact! && this.active(ticket.label); }
  check(key: string) {
    this.prune(); const ticket = this.tickets.get(key);
    check(ticket?.state === 'claimed', 'Wake nonce is invalid, consumed, or expired', 409);
    return { registered: this.registered(ticket), ...(this.mediaPending(ticket) ? {media_pending: true} : {}) };
  }
  result(value: unknown) {
    const input = value as WakeInput;
    this.prune(); const ticket = this.tickets.get(input.nonce);
    const lateCleanup = ticket?.state === 'expired' && ticket.claimed && !ticket.cleanupReceived && input.ok === false;
    check(ticket && (['issued', 'claimed'].includes(ticket.state) || lateCleanup) && typeof input.ok === 'boolean', 'Invalid wake result', 409);
    if (input.permissions !== undefined) {
      check(ticket.claimed && Array.isArray(input.permissions) && input.permissions.length > 0 && input.permissions.length <= 10 && input.permissions.every(p => object(p) && Object.keys(p).every(k => ['connector', 'option'].includes(k)) && p.connector === ticket.connector && ['Always allow', `Allow ${ticket.connector} for this conversation`].includes(p.option)), 'Invalid connector permission receipt', 400);
      ticket.permissions = structuredClone(input.permissions);
    }
    if (!input.ok) {
      // If Enter succeeded before a later step failed, retain the orphan for cleanup.
      if (input.url !== undefined) {
        const url = chatUrl(input.url!);
        const retained = retainedUrls(this.config).includes(url);
        const state = structuredClone(this.config.wake_state!);
        // The extension read this URL from the tab it opened, so the chat is ours: delete it, never merely archive it.
        // Full archive queue: it stays tracked and reconcile() queues it as soon as there is room.
        this.track(state, url);
        if (!retained && !state.archives.includes(url) && state.archives.length < 256) state.archives.push(url);
        this.persist(state);
        if (ticket.type === 'composer' && !retained && state.archives.includes(url)) ticket.url = url;
      }
      if (lateCleanup) {
        if (input.error === 'rate_limited') { const quota = quotaState(this.config, (ticket.routing_label ?? ticket.label), this.now()); this.persist(structuredClone(this.config.wake_state!), this.config.labels, quota.quota_until, quota.quota_pause_until); }
        ticket.cleanupReceived = true;
      } else this.failure(ticket, 'failed', input.error === 'rate_limited');
      ticket.failure_code = failureCodes.has(input.error ?? '') ? input.error : 'browser_error';
      if (failureStages.has(input.stage ?? '')) ticket.failure_stage = input.stage;
      return { ok: true };
    }
    check(ticket.state === 'claimed' && this.registered(ticket), 'Wake must be claimed and polling before confirmation', 409);
    const cleared = structuredClone(this.config.wake_state!);
    delete cleared.failed[ticket.routing_label ?? ticket.label];
    if (cleared.failed_attempts) delete cleared.failed_attempts[ticket.routing_label ?? ticket.label];
    const {name, index, scope} = workerRoute(this.config, ticket.label);
    const saved = this.config.labels[name];
    const url = chatUrl(input.url!), previous = scope ? this.config.session_workers?.[ticket.label]?.url : index === 1 ? saved?.url : saved?.replica_urls?.[String(index)];
    check(url !== previous && !retainedUrls(this.config).includes(url) && !this.config.wake_state!.archives.includes(url), 'New conversation must be fresh', 409);
    const state = cleared, labels = { ...this.config.labels };
    this.track(state, url);
    if (ticket.type === 'composer') {
      check(state.archives.length < 256, 'Archive queue is full', 429);
      state.archives.push(url); this.persist(state);
      ticket.url = url; ticket.state = 'confirmed'; ticket.error = null; ticket.retain_until = this.now() + 600000;
      return {ok: true};
    }
    if (previous && !state.archives.includes(previous)) state.archives.push(previous);
    if (scope) {
      const session_workers = {...this.config.session_workers,[ticket.label]:{label:name,scope,url}};
      check(Object.keys(session_workers).length <= 1024, 'Session worker storage is full',429);
      const previousWorkers = this.config.session_workers;
      this.config.session_workers = session_workers;
      try { this.persist(state,labels); } catch (error) { this.config.session_workers = previousWorkers; throw error; }
      ticket.state = 'confirmed'; ticket.error = null; ticket.retain_until = this.now() + 600000;
      return {ok:true};
    }
    Object.defineProperty(labels, name, { value: { ...saved, ...(index === 1 ? {url} : {replica_urls: {...saved.replica_urls, [index]: url}}) }, enumerable: true, configurable: true, writable: true });
    this.persist(state, labels);
    ticket.state = 'confirmed'; ticket.error = null; ticket.retain_until = this.now() + 600000;
    return { ok: true };
  }
  /** Remember that the extension started this chat (so it may be deleted) and when we first saw it. */
  track(state: WakeState, url: string) {
    state.started_chats ??= []; state.chat_started_at ??= {};
    if (!state.started_chats.includes(url)) {
      check(state.started_chats.length < 4096, 'Started chat ownership storage is full', 429);
      state.started_chats.push(url);
    }
    state.chat_started_at[url] ??= this.now();
  }
  /** The extension reports a chat the moment it exists, long before any outcome is known. */
  chat(value: unknown) {
    const input = value as {nonce: string; url: string};
    check(object(input) && Object.keys(input).every(key => ['nonce', 'url'].includes(key)) && typeof input.nonce === 'string' && typeof input.url === 'string', 'Invalid chat record');
    this.prune(); const ticket = this.tickets.get(input.nonce);
    check(ticket?.claimed === true, 'Chat record needs a claimed wake', 409);
    const url = chatUrl(input.url);
    if (retainedUrls(this.config).includes(url)) return {ok: true};
    const state = structuredClone(this.config.wake_state!);
    this.track(state, url); this.persist(state);
    ticket.chat_url = url;
    return {ok: true};
  }
  /** Chats that must be disposed of although nobody asked: finished retained chats and tracked chats no ticket owns. */
  reconcile(force = false) {
    const now = this.now();
    if (!force && now - this.lastReconcile < 30000) return {retired: 0, orphans: 0};
    this.lastReconcile = now;
    const GRACE = 120000;
    const state = structuredClone(this.config.wake_state!);
    state.started_chats ??= []; state.chat_started_at ??= {};
    let dirty = false;
    const seen = (url: string) => { if (state.chat_started_at![url] === undefined) { state.chat_started_at![url] = now; dirty = true; } return state.chat_started_at![url]; };
    const owned = new Set<string>();
    for (const t of this.tickets.values()) {
      if (t.chat_url && (pending(t) || t.type === 'composer' && !this.jobFinished(t.job_id))) owned.add(t.chat_url);
      if (t.url && t.type === 'composer' && !this.jobFinished(t.job_id)) owned.add(t.url);
    }
    const pendingIdentity = (identity: string) => [...this.tickets.values()].some(t => t.label === identity && pending(t));
    const finished = (identity: string, url: string) => !this.alive(identity) && !pendingIdentity(identity) && now - seen(url) >= GRACE;
    const labels = {...this.config.labels};
    const sessions = {...(this.config.session_workers ?? {})};
    const retire: string[] = [];
    for (const [name, saved] of Object.entries(this.config.labels)) {
      const identities = workerIdentities(this.config, name);
      let next = saved;
      if (saved.url && finished(identities[0], saved.url) && state.archives.length + retire.length < 256) { retire.push(saved.url); const {url, ...rest} = next; next = rest; }
      for (const [index, url] of Object.entries(saved.replica_urls ?? {})) {
        const identity = identities[Number(index) - 1] ?? `${name}~replica-${index}`;
        if (finished(identity, url) && state.archives.length + retire.length < 256) {
          retire.push(url);
          const {[index]: _gone, ...left} = next.replica_urls!;
          const {replica_urls, ...rest} = next;
          next = Object.keys(left).length ? {...rest, replica_urls: left} : rest;
        }
      }
      if (next !== saved) Object.defineProperty(labels, name, {value: next, enumerable: true, configurable: true, writable: true});
    }
    for (const [identity, worker] of Object.entries(this.config.session_workers ?? {})) {
      if (worker.url && finished(identity, worker.url) && state.archives.length + retire.length < 256) {
        retire.push(worker.url); const {url, ...rest} = worker; sessions[identity] = rest;
      }
    }
    for (const url of retire) if (!state.archives.includes(url)) state.archives.push(url);
    // A tracked chat that nothing holds (no label, no session, no live ticket, not queued) is an orphan.
    const held = new Set([...Object.values(labels).flatMap(s => [...(s.url ? [s.url] : []), ...Object.values(s.replica_urls ?? {})]), ...Object.values(sessions).flatMap(s => s.url ? [s.url] : [])]);
    let orphans = 0;
    for (const url of state.started_chats) {
      if (held.has(url) || owned.has(url) || state.archives.includes(url) || now - seen(url) < GRACE || state.archives.length >= 256) continue;
      state.archives.push(url); orphans++;
    }
    if (!retire.length && !orphans && !dirty) return {retired: 0, orphans: 0};
    const previous = this.config.session_workers;
    this.config.session_workers = sessions;
    try { this.persist(state, labels); } catch (error) { this.config.session_workers = previous; throw error; }
    return {retired: retire.length, orphans};
  }
  sweeping() {
    for (const [receiver, until] of this.sweepLeases) if (until <= this.now()) this.sweepLeases.delete(receiver);
    return this.sweepLeases.size > 0;
  }
  /** Which of the extension's candidate conversations may it inspect for the wake signature and delete? */
  sweepCheck(value: unknown, receiver?: string) {
    const input = value as {candidates: {id: string; created_at: number}[]};
    check(object(input) && Object.keys(input).length === 1 && Array.isArray(input.candidates) && input.candidates.length <= 100 &&
      input.candidates.every(c => object(c) && Object.keys(c).length === 2 && typeof c.id === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(c.id) && Number.isSafeInteger(c.created_at)), 'Invalid sweep candidates');
    this.prune();
    const now = this.now(), minAge = Math.max(this.config.worker_lease_ms ?? 1800000, this.config.job_deadline_ms ?? 0, 900000) + 600000;
    const held = new Set(retainedUrls(this.config));
    for (const url of this.config.wake_state!.archives) held.add(url);
    for (const t of this.tickets.values()) {
      if (t.chat_url && (pending(t) || t.type === 'composer' && !this.jobFinished(t.job_id))) held.add(t.chat_url);
      if (t.url && t.type === 'composer' && !this.jobFinished(t.job_id)) held.add(t.url);
    }
    const dispose = input.candidates.filter(c => now - c.created_at >= minAge && !held.has(`https://chatgpt.com/c/${c.id}`)).slice(0, 10).map(c => c.id);
    // The extension's whole sweep has a 20-second deadline. Fence receiver
    // changes for at most a minute, including failed/empty deletion results.
    this.sweeping();
    if (receiver && dispose.length) this.sweepLeases.set(receiver, now + 60000);
    return {dispose, min_age_ms: minAge};
  }
  sweepDone(value: unknown, receiver?: string) {
    const input = value as {deleted: string[]};
    check(object(input) && Object.keys(input).length === 1 && Array.isArray(input.deleted) && input.deleted.length <= 100 && input.deleted.every(id => typeof id === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(id)), 'Invalid sweep result');
    if (receiver) this.sweepLeases.delete(receiver);
    if (!input.deleted.length) return {ok: true};
    this.lastSweep = {at: this.now(), deleted: (this.lastSweep?.deleted ?? 0) + input.deleted.length};
    // Gone from ChatGPT: stop tracking any of them.
    const gone = new Set(input.deleted.map(id => `https://chatgpt.com/c/${id}`));
    const state = structuredClone(this.config.wake_state!);
    if (state.started_chats?.some(url => gone.has(url)) || state.archives.some(url => gone.has(url))) {
      state.started_chats = (state.started_chats ?? []).filter(url => !gone.has(url));
      state.archives = state.archives.filter(url => !gone.has(url));
      for (const url of gone) if (state.chat_started_at) delete state.chat_started_at[url];
      this.persist(state);
    }
    return {ok: true};
  }
  /** Queue a finished session's own chats for disposal and forget its workers. */
  releaseSession(scope: string) {
    const workers = Object.entries(this.config.session_workers ?? {}).filter(([, worker]) => worker.scope === scope);
    if (workers.length === 0) return { released: 0 };
    const state = structuredClone(this.config.wake_state!);
    const urls = workers.flatMap(([, worker]) => worker.url ? [worker.url] : []);
    check(state.archives.length + urls.length <= 256, 'Archive queue is full; allow archive retries first', 429);
    for (const url of urls) if (!state.archives.includes(url)) state.archives.push(url);
    const previous = this.config.session_workers;
    this.config.session_workers = Object.fromEntries(Object.entries(previous ?? {}).filter(([, worker]) => worker.scope !== scope));
    try { this.persist(state); } catch (error) { this.config.session_workers = previous; throw error; }
    return { released: workers.length, queued: urls.length };
  }
  archiveNext() {
    if (this.archiveLease && this.archiveLease.expires_at > this.now()) return { archive: null };
    const url = this.config.wake_state!.archives.find(url => ![...this.tickets.values()].some(t => t.type === 'composer' && t.url === url && !this.jobFinished(t.job_id)));
    if (!url) return { archive: null };
    check(!retainedUrls(this.config).includes(url), 'Cannot archive a retained worker chat', 409);
    // Legacy and manually supplied queue entries lack proof of lane ownership,
    // so even delete mode archives them instead of hiding them from the account.
    this.archiveLease = { nonce: nonce(), url, expires_at: this.now() + 120000,
      ...(this.config.chat_disposal === 'delete' && this.config.wake_state!.started_chats?.includes(url) ? { remove: true } : {}) };
    return { archive: this.archiveLease };
  }
  archiveResult(value: unknown) {
    const input = value as WakeInput;
    const lease = this.archiveLease;
    check(lease && lease.nonce === input.nonce && lease.expires_at > this.now() && typeof input.ok === 'boolean', 'Invalid archive result', 409);
    if (input.ok) {
      const state = structuredClone(this.config.wake_state!); state.archives = state.archives.filter(url => url !== lease.url);
      state.started_chats = (state.started_chats ?? []).filter(url => url !== lease.url);
      if (state.chat_started_at) delete state.chat_started_at[lease.url];
      this.persist(state); this.archiveLease = null;
    } else {
      const state = structuredClone(this.config.wake_state!); state.archives = [...state.archives.filter(url => url !== lease.url), lease.url];
      this.persist(state); lease.expires_at = this.now() + 30000;
    }
    return { ok: true };
  }
  status() { this.prune(); return [...this.tickets.values()].map(t => ({ label: t.label, state: t.state, error: t.error ?? null, ...(t.permissions ? {permissions: t.permissions} : {}), ...(t.failure_code ? {failure_code: t.failure_code} : {}), ...(t.failure_stage ? {failure_stage: t.failure_stage} : {}) })); }
}
