import type { Config, WorkerSettings } from './types.ts';
import { homedir } from 'node:os';
import path from 'node:path';
import { check, chatUrl, label, line, object, publicOrigin, readPrivate, writePrivate } from './security.ts';

export const defaultDirectory = (env: Record<string, string | undefined> = process.env, home = homedir()) => env.CROSSFEED_HOME || path.join(env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(home, '.config'), 'crossfeed-chat');
export function loadConfig(directory: string, overrides: Partial<Config> = {}): Config {
  const config: Config = { prefix: 'chatgpt', connector: 'Crossfeed', labels: {}, ...readPrivate<Partial<Config>>(directory, 'config.json', {}), ...overrides };
  check(object(config.labels) && Object.keys(config.labels).length <= 128, 'Invalid saved labels');
  check(/^[a-zA-Z0-9_-]{1,32}$/.test(config.prefix), 'Invalid model prefix');
  // A selected pairing may be revoked or absent after restart. Retain its ID to fail closed.
  check(config.wake_receiver_id === undefined || typeof config.wake_receiver_id === 'string' && /^[A-Za-z0-9_-]{32}$/.test(config.wake_receiver_id), 'Invalid wake receiver ID');
  line(config.connector, 'connector', 80);
  check(!/[@\r\n]/.test(config.connector), 'Connector must be its literal name without @');
  if (config.public_url) config.public_url = publicOrigin(config.public_url);
  for (const [name, saved] of Object.entries(config.labels)) {
    label(name); check(!name.includes("~replica-") && !name.includes("~session-"), "Reserved replica identity in saved label"); workerSettings(saved);
    check(Buffer.byteLength(workerIdentities(config, name).at(-1)!) <= 128, "Replica identity exceeds label length");
    if (saved.url !== undefined) chatUrl(saved.url);
  }
  config.session_workers ??= {};
  check(object(config.session_workers) && Object.keys(config.session_workers).length <= 1024, 'Invalid session workers');
  for (const [identity, saved] of Object.entries(config.session_workers)) {
    const route = workerRoute(config, identity);
    check(route.scope && saved.label === route.name && saved.scope === route.scope, 'Invalid session worker binding');
    if (saved.url) chatUrl(saved.url);
  }
  config.conversation_bindings ??= {};
  check(object(config.conversation_bindings) && Object.keys(config.conversation_bindings).length <= 4096 &&
    Object.entries(config.conversation_bindings).every(([conversation,identity])=> /^[A-Za-z0-9_-]{22}$/.test(conversation) && typeof identity === 'string' && Buffer.byteLength(identity) <= 256), 'Invalid conversation bindings');
  config.quota_until ??= {};
  check(object(config.quota_until) && Object.keys(config.quota_until).length <= 256 && Object.values(config.quota_until).every(n => Number.isSafeInteger(n) && n >= 0), 'Invalid quota state');
  Object.keys(config.quota_until).forEach(label);
  config.quota_pause_until ??= 0;
  check(Number.isSafeInteger(config.quota_pause_until) && config.quota_pause_until >= 0, 'Invalid quota pause');
  config.job_deadline_ms ??= 1800000;
  check(Number.isSafeInteger(config.job_deadline_ms) && config.job_deadline_ms >= 1 && config.job_deadline_ms <= 86400000, 'Invalid job deadline');
  config.max_claimed_jobs ??= 4;
  check(Number.isSafeInteger(config.max_claimed_jobs) && config.max_claimed_jobs >= 1 && config.max_claimed_jobs <= 128, 'Invalid concurrent claim limit');
  config.worker_lease_ms ??= config.job_deadline_ms;
  check(Number.isSafeInteger(config.worker_lease_ms) && config.worker_lease_ms >= 1 && config.worker_lease_ms <= 86400000, 'Invalid worker lease');
  config.wake_daily_cap ??= 0;
  config.wake_hourly_cap ??= 12;
  config.attachment_delivery ??= 'mcp';
  // Discard legacy configuration: conversation disposal is always deletion.
  delete (config as Config & {chat_disposal?: unknown}).chat_disposal;
  check(['mcp', 'composer'].includes(config.attachment_delivery), 'Attachment delivery must be mcp or composer');
  check(Number.isSafeInteger(config.wake_daily_cap) && config.wake_daily_cap >= 0 && config.wake_daily_cap <= 1000, 'Invalid wake daily cap');
  check(Number.isSafeInteger(config.wake_hourly_cap) && config.wake_hourly_cap >= 0 && config.wake_hourly_cap <= 1000, 'Invalid wake hourly cap');
  if (config.wake_state !== undefined) {
    const s = config.wake_state, timestamp = (n: number) => Number.isSafeInteger(n) && n >= 0;
    check(object(s) && Array.isArray(s.wakes) && s.wakes.length <= 2000 && s.wakes.every(timestamp) && object(s.failed) && Object.keys(s.failed).length <= 128 && Object.values(s.failed).every(timestamp) && timestamp(s.cooldown_until) && Array.isArray(s.archives) && s.archives.length <= 256, 'Invalid wake state');
    if (s.worker_modes !== undefined) {
      check(object(s.worker_modes) && Object.keys(s.worker_modes).length <= 4096 && Object.values(s.worker_modes).every(mode => ['configured', 'native'].includes(mode)), 'Invalid retained worker wake modes');
      Object.keys(s.worker_modes).forEach(name => line(name, 'worker label', 128));
    }
    if (s.failed_attempts !== undefined) check(object(s.failed_attempts) && Object.keys(s.failed_attempts).length <= 128 && Object.values(s.failed_attempts).every(n => Number.isSafeInteger(n) && n >= 1 && n <= 1000), 'Invalid wake retry state');
    s.archives.forEach(chatUrl);
    if (s.started_chats !== undefined) {
      check(Array.isArray(s.started_chats) && s.started_chats.length <= 4096 && new Set(s.started_chats).size === s.started_chats.length, 'Invalid started chat ownership state');
      s.started_chats.forEach(chatUrl);
    }
    if (s.legacy_import !== undefined) check(object(s.legacy_import) && Object.keys(s.legacy_import).length === 2 &&
      typeof s.legacy_import.digest === 'string' && /^[A-Za-z0-9_-]{43}$/.test(s.legacy_import.digest) &&
      Number.isSafeInteger(s.legacy_import.next) && s.legacy_import.next >= 0 && s.legacy_import.next <= 8192, 'Invalid legacy import cursor');
    if (s.unproven_dropped !== undefined) check(timestamp(s.unproven_dropped), 'Invalid unproven disposal count');
    if (s.last_sweep !== undefined) validateSweepCounters(s.last_sweep, true);
    if (s.disposal_queued_at !== undefined) {
      check(object(s.disposal_queued_at) && Object.keys(s.disposal_queued_at).length <= 256 && Object.values(s.disposal_queued_at).every(timestamp), 'Invalid disposal queue times');
      Object.keys(s.disposal_queued_at).forEach(chatUrl);
    }
    if (s.chat_started_at !== undefined) {
      check(object(s.chat_started_at) && Object.keys(s.chat_started_at).length <= 4096 && Object.values(s.chat_started_at).every(timestamp), 'Invalid chat start times');
      Object.keys(s.chat_started_at).forEach(chatUrl);
    }
    check(!s.archives.some(url => retainedUrls(config).includes(url)), 'Deletion queue contains a retained chat');
  }
  return config;
}
export function quotaState(config: Pick<Config, 'quota_until' | 'quota_pause_until'>, name: string, now: number) {
  const quota_until = Object.fromEntries(Object.entries(config.quota_until ?? {}).filter(([, until]) => until > now));
  if (!Object.hasOwn(quota_until, name) && Object.keys(quota_until).length >= 256) return {quota_until, quota_pause_until: now + 3600000};
  return {quota_until: {...quota_until, [name]: now + 3600000}, quota_pause_until: config.quota_pause_until ?? 0};
}

export const saveConfig = (directory: string, config: Partial<Config>) => writePrivate(directory, 'config.json', config);

/** Omitted modes belong to saved pre-native workers. New labels store native explicitly. */
export function ordinaryWakeMode(saved: Pick<WorkerSettings, 'wake_mode'>, recorded?: 'configured' | 'native'): 'configured' | 'native' {
  return saved.wake_mode ?? recorded ?? 'configured';
}

export function workerSettings(value: unknown): WorkerSettings {
  const saved = value as WorkerSettings;
  check(object(saved) && Object.keys(saved).every(k => ['row', 'level', 'wake_mode', 'url', 'replicas', 'replica_urls'].includes(k)), 'Invalid worker settings; use model row and numeric level 0..4, see README upgrade instructions');
  line(saved.row, 'model row', 128);
  check(saved.wake_mode === undefined || ['configured', 'native'].includes(saved.wake_mode), 'Wake mode must be configured or native');
  check(Number.isInteger(saved.level) && saved.level >= 0 && saved.level <= 4, 'Worker level must be 0..4');
  check(saved.replicas === undefined || Number.isSafeInteger(saved.replicas) && saved.replicas >= 1 && saved.replicas <= 16, "Replicas must be an integer from 1 to 16");
  if (saved.replica_urls !== undefined) {
    check(object(saved.replica_urls) && Object.entries(saved.replica_urls).every(([key, url]) => /^[2-9]$|^1[0-6]$/.test(key) && typeof url === "string"), "Invalid replica chats");
    Object.values(saved.replica_urls).forEach(chatUrl);
  }
  return saved;
}

// Replica 1 retains the original identity and URL for existing worker chats.
export function workerIdentities(config: Pick<Config, 'labels'>, name: string, scope?: string): string[] {
  const base = scope ? `${name}~session-${scope}` : name;
  return Array.from({length: config.labels[name]?.replicas ?? 1}, (_, i) => i === 0 ? base : `${base}~replica-${i + 1}`);
}
export function workerRoute(config: Pick<Config, 'labels'>, identity: string) {
  const replica = /^(.*)~replica-([0-9]+)$/.exec(identity);
  const base = replica ? replica[1] : identity;
  const session = /^(.*)~session-([A-Za-z0-9_-]{22})$/.exec(base);
  const name = session ? session[1] : base, scope = session?.[2];
  const index = replica ? Number(replica[2]) : 1;
  if (identity.includes('~replica-') || identity.includes('~session-'))
    check(Object.hasOwn(config.labels, name) && Number.isInteger(index) && index >= 1 && index <= 16 && (!base.includes('~session-') || !!session), 'Unknown worker identity');
  return {name, index, scope};
}
export function retainedUrls(config: Pick<Config, 'labels' | 'session_workers'>) {
  return [...Object.values(config.labels).flatMap(s => [...(s.url ? [s.url] : []), ...Object.values(s.replica_urls ?? {})]),
    ...Object.values(config.session_workers ?? {}).flatMap(s => s.url ? [s.url] : [])];
}

const sweepCounterKeys = ['at', 'listed_visible', 'listed_archived', 'candidates', 'approved', 'wake_matches_visible', 'wake_matches_archived', 'deleted_visible', 'deleted_archived', 'errors', 'pass_complete', 'backlog', 'pass_started_at', 'pass_wake_matches_visible', 'pass_wake_matches_archived', 'pass_deleted_visible', 'pass_deleted_archived', 'last_pass_started_at', 'last_pass_completed_at', 'last_pass_wake_matches_visible', 'last_pass_wake_matches_archived', 'last_pass_deleted_visible', 'last_pass_deleted_archived', 'pass_errors', 'last_pass_errors', 'rate_limited_until'];
const inventoryCounterKeys = ['listed_visible','listed_archived','crossfeed_visible','crossfeed_archived','owner_visible','owner_archived',
  'unclassified_visible','unclassified_archived','owner_min_create_time','owner_max_create_time'];
sweepCounterKeys.push('inventory_version', 'inventory_errors', ...inventoryCounterKeys.flatMap(k => [k, 'pass_'+k, 'last_pass_'+k]));
export function validateSweepCounters(value: unknown, legacy = false) {
  check(object(value) && Object.keys(value).length > 0 && Object.keys(value).every(key => sweepCounterKeys.includes(key) || legacy && key === 'deleted') &&
    Object.entries(value).every(([key, v]) => key === 'pass_complete' ? typeof v === 'boolean' : Number.isSafeInteger(v) && Number(v) >= 0), 'Invalid sweep result');
}
