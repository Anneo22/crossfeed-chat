import * as childProcess from 'node:child_process';
import {randomBytes} from 'node:crypto';
import fs from 'node:fs';
import fileOps from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Adapted from PiLink MIT KWin focus guard. */
export function kwinWakeFocusScript(marker: string): string {
  if (!/^[a-f0-9]{32}$/.test(marker)) throw Error('Invalid focus marker');
  return `"use strict";
const title = ${JSON.stringify('Crossfeed Wake ')} + ${JSON.stringify(marker)};
const previous = workspace.activeWindow;
const desktop = workspace.currentDesktop;
const activity = workspace.currentActivity;
const list = () => workspace.windowList ? workspace.windowList() : workspace.stackingOrder;
const existing = new Set(list() || []);
const deadline = Date.now() + 4000;
let done = !previous || !existing.has(previous), added = null, early = null;
function present(w) { const all = list(); return !!all && all.includes(w); }
function safe() { return !done && Date.now() < deadline && workspace.currentDesktop === desktop && workspace.currentActivity === activity && present(previous); }
function candidate(w) {
  if (!w || w.normalWindow !== true || typeof w.resourceClass !== 'string' || existing.has(w) || w === previous) return false;
  return ['brave-browser','brave','brave-browser-beta','brave-browser-nightly','google-chrome','google-chrome-stable','chromium','chromium-browser'].includes(w.resourceClass.toLowerCase());
}
function owned(w) {
  return candidate(w) && typeof w.caption === 'string' &&
    (w.caption === title || [' - ',' \\u2013 ',' \\u2014 '].some(separator => w.caption.startsWith(title + separator)));
}
// KWin activation signals vary across releases; marked caption remains mandatory.
const activation = [workspace.windowActivated, workspace.activeWindowChanged,
  workspace.clientActivated, workspace.activeClientChanged].find(s =>
  s && typeof s.connect === 'function' && typeof s.disconnect === 'function');
function finish() {
  if (done) return;
  done = true;
  try { workspace.windowAdded.disconnect(onAdded); } catch (_) {}
  try { if (activation) activation.disconnect(onActivated); } catch (_) {}
  try { if (workspace.windowRemoved) workspace.windowRemoved.disconnect(onRemoved); } catch (_) {}
  try { if (workspace.currentDesktopChanged) workspace.currentDesktopChanged.disconnect(onContextChange); } catch (_) {}
  try { if (workspace.currentActivityChanged) workspace.currentActivityChanged.disconnect(onContextChange); } catch (_) {}
  try { added.captionChanged.disconnect(onCaption); } catch (_) {}
}
function restore(w) {
  if (!safe() || !owned(w) || workspace.activeWindow !== w || !present(w)) { finish(); return; }
  finish();
  if (workspace.currentDesktop === desktop && workspace.currentActivity === activity &&
      present(previous) && workspace.activeWindow === w) workspace.activeWindow = previous;
}
function onContextChange() { finish(); }
function onRemoved(w) { if (w === previous) finish(); }
function onCaption() {
  if (!safe()) { finish(); return; }
  if (owned(added) && workspace.activeWindow === added) restore(added);
}
function onAdded(w) {
  if (!safe()) { finish(); return; }
  if (!candidate(w)) return;
  if (added && added !== w || early && early !== w) { finish(); return; }
  added = w;
  if (w.captionChanged) w.captionChanged.connect(onCaption);
  if (workspace.activeWindow === w && owned(w)) restore(w);
}
function onActivated(w) {
  if (!w) w = workspace.activeWindow;
  if (!safe()) { finish(); return; }
  if (w === previous) return;
  if (added && w === added) { if (owned(w)) restore(w); return; }
  if (!added && !early && candidate(w)) { early = w; return; }
  finish();
}
if (!done && activation && workspace.windowAdded && typeof workspace.windowAdded.connect === 'function') {
  workspace.windowAdded.connect(onAdded);
  activation.connect(onActivated);
  if (workspace.windowRemoved) workspace.windowRemoved.connect(onRemoved);
  if (workspace.currentDesktopChanged) workspace.currentDesktopChanged.connect(onContextChange);
  if (workspace.currentActivityChanged) workspace.currentActivityChanged.connect(onContextChange);
}
`;
}

export interface FocusGuard { close(): Promise<void> }
export interface FocusDeps {
  /** Exact one-use window title marker provided by the authenticated claim. */
  marker?: string;
  env?: Record<string, string | undefined>;
  platform?: string;
  access?: (file: string, mode: number) => Promise<void>;
  run?: (binary: string, args: string[], signal: AbortSignal) => Promise<string>;
  mkdtemp?: typeof fileOps.mkdtemp;
  writeFile?: typeof fileOps.writeFile;
  rm?: typeof fileOps.rm;
  /** Fixed, sanitized preparation reason; no environment or process output. */
  onOutcome?: (reason: FocusOutcome) => void;
}
export type FocusOutcome = 'unsupported_desktop' | 'unsupported_bus' | 'timeout' | 'prepare_failed' | 'prepared' | 'cancelled';
const QDBUS = '/usr/bin/qdbus6';
const CALL_MS = 500;
const PREP_MS = 1250; // Within the host's 1300 ms preparation bound.
const MAX_OUTPUT = 8192;
const DBUS = ['org.freedesktop.DBus', '/org/freedesktop/DBus'] as const;
const KWIN = ['org.kde.KWin', '/Scripting'] as const;
const OWNER_METHOD = 'org.freedesktop.DBus.GetNameOwner';
const INTROSPECT_METHOD = 'org.freedesktop.DBus.Introspectable.Introspect';
// Match only the fixed freedesktop introspection DTD. XML whitespace may
// separate its tokens/quoted identifiers; the identifiers are exact literals.
// No DTD is parsed or resolved, and no external URL is ever fetched.
const DBUS_DOCTYPE = /^<!DOCTYPE[ \t\r\n]+node[ \t\r\n]+PUBLIC[ \t\r\n]+(["'])-\/\/freedesktop\/\/DTD D-BUS Object Introspection 1\.0\/\/EN\1[ \t\r\n]+(["'])http:\/\/www\.freedesktop\.org\/standards\/dbus\/1\.0\/introspect\.dtd\2[ \t\r\n]*>/;

function validOwner(raw: string): string | undefined {
  if (typeof raw !== 'string' || raw.length > MAX_OUTPUT) return undefined;
  const owner = raw.trim();
  return /^:[0-9]{1,8}\.[0-9]{1,8}$/.test(owner) ? owner : undefined;
}

// Verify a complete, bounded XML element tree rather than trusting token text
// that could appear inside mismatched or unclosed tags.
function balancedIntrospection(xml: string): boolean {
  const body = xml.replace(/^<\?xml\s+version=["']1\.0["'](?:\s+encoding=["']UTF-8["'])?\s*\?>\s*/, '');
  const stack: string[] = [];
  let cursor = 0;
  for (const match of body.matchAll(/<([^<>]+)>/g)) {
    if (body.slice(cursor, match.index).trim()) return false;
    cursor = (match.index ?? 0) + match[0].length;
    const token = match[1].trim();
    const closing = token.startsWith('/');
    const empty = !closing && token.endsWith('/');
    const fragment = closing ? token.slice(1) : token;
    const name = /^([A-Za-z_][\w:.-]*)(?=\s|\/?$)/.exec(fragment)?.[1];
    if (!name) return false;
    let tail = fragment.slice(name.length);
    if (closing) {
      if (tail.trim() || stack.pop() !== name) return false;
    } else {
      if (empty) tail = tail.slice(0, -1);
      if (!/^(?:\s+[A-Za-z_][\w:.-]*\s*=\s*(?:"[^"<>]*"|'[^'<>]*'))*\s*$/.test(tail)) return false;
      if (!empty) stack.push(name);
      if (stack.length > 32) return false;
    }
  }
  return !stack.length && !body.slice(cursor).trim();
}

function hasScriptingMethods(raw: string): boolean {
  if (typeof raw !== 'string' || raw.length > MAX_OUTPUT) return false;
  let xml = raw.trim();
  // Strip only this exact DTD shape, optionally after a safe XML declaration.
  // Everything else beginning with <! remains rejected below.
  const prolog = /^(?:<\?xml\s+version=["']1\.0["'](?:\s+encoding=["']UTF-8["'])?\s*\?>\s*)/.exec(xml);
  const offset = prolog?.[0].length ?? 0;
  const dtd = DBUS_DOCTYPE.exec(xml.slice(offset));
  if (dtd) xml = xml.slice(0, offset) + xml.slice(offset + dtd[0].length).trimStart();
  // Reject every other declaration, DTD, comment, control or malformed tree.
  // Methods must be structurally contained in the exact scripting interface.
  if (/<!|[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(xml) ||
      !/^(?:<\?xml\s+version=["']1\.0["'](?:\s+encoding=["']UTF-8["'])?\s*\?>\s*)?<node(?:\s[^>]*)?>[\s\S]*<\/node>$/.test(xml) ||
      !balancedIntrospection(xml)) return false;
  const matches = [...xml.matchAll(/<interface\b[^>]*\bname=["']org\.kde\.kwin\.Scripting["'][^>]*>([\s\S]*?)<\/interface>/g)];
  if (matches.length !== 1) return false;
  const methods = [...matches[0][1].matchAll(/<method\b[^>]*\bname=["']([^"']+)["'][^>]*\/?>/g)].map(m => m[1]);
  return methods.includes('loadScript') && methods.includes('unloadScript');
}

function runQdbus(binary: string, args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const execFile = (childProcess as unknown as {execFile: (
      binary: string, args: string[], options: {signal: AbortSignal; timeout: number; encoding: 'utf8'; maxBuffer: number},
      callback: (error: Error | null, stdout: string) => void
    ) => void}).execFile;
    execFile(binary, args, {signal, timeout: CALL_MS, encoding: 'utf8', maxBuffer: MAX_OUTPUT},
      (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

// Only fixed DBus destinations, paths, and methods are queried, with no
// shell or arguments derived from session metadata. All failure is advisory.
export async function prepareWakeFocusGuard(signal: AbortSignal, deps: FocusDeps = {}): Promise<FocusGuard | undefined> {
  const report = (reason: FocusOutcome) => { try { deps.onOutcome?.(reason); } catch { /* advisory only */ } };
  // Reject missing or malformed proof before touching any native service.
  const marker = deps.marker;
  if (!marker || !/^[a-f0-9]{32}$/.test(marker)) {
    report('prepare_failed'); return undefined;
  }
  const env = deps.env ?? process.env;
  const session = env.XDG_SESSION_TYPE?.trim().toLowerCase();
  const desktop = env.XDG_CURRENT_DESKTOP?.split(':').filter(Boolean);
  if (signal.aborted) { report('cancelled'); return undefined; }
  if ((deps.platform ?? process.platform) !== 'linux' ||
      (session && session !== 'wayland') ||
      (desktop?.length && !desktop.includes('KDE'))) { report('unsupported_desktop'); return undefined; }
  if (!env.DBUS_SESSION_BUS_ADDRESS?.trim()) { report('unsupported_bus'); return undefined; }
  const start = performance.now();
  let outcome: FocusOutcome = 'prepare_failed';
  let probing = true;
  const run = deps.run ?? runQdbus;
  let directory: string | undefined, plugin: string | undefined;
  let unloaded: string | undefined, removed: string | undefined, armed = false;

  // A mocked run or filesystem operation may ignore abort. Use a real race
  // for each <=500ms call plus a cumulative <=1250ms monotonic-time budget.
  async function bounded<T>(operation: (limited: AbortSignal) => Promise<T>): Promise<T> {
    const remaining = PREP_MS - (performance.now() - start);
    if (signal.aborted || remaining <= 0) throw Error('focus_timeout');
    const controller = new AbortController();
    const limited = AbortSignal.any([signal, controller.signal]);
    let timer: ReturnType<typeof setTimeout> | number | undefined;
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => operation(limited)),
        new Promise<never>((_, reject) => {
          onAbort = () => reject(Error('focus_timeout'));
          limited.addEventListener('abort', onAbort, {once:true});
          if (limited.aborted) onAbort();
          timer = setTimeout(() => controller.abort(), Math.min(CALL_MS, remaining));
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (onAbort) limited.removeEventListener('abort', onAbort);
    }
  }

  const command = (args: string[], onLate?: () => void) => bounded(async limited => {
    let output: string;
    try { output = await run(QDBUS, args, limited); }
    finally {
      // Mocked/transient transports can settle after timeout despite abort.
      // A late load/run must attempt another unload, even after rejection.
      if (limited.aborted) onLate?.();
    }
    if (limited.aborted) throw Error('focus_timeout');
    if (typeof output !== 'string' || output.length > MAX_OUTPUT) throw Error('focus_output');
    return output;
  });
  const owner = () => command([...DBUS, OWNER_METHOD, 'org.kde.KWin']).then(validOwner);
  const unload = (name: string) => Promise.resolve().then(() => run(QDBUS, [...KWIN,
    'org.kde.kwin.Scripting.unloadScript', name], AbortSignal.timeout(CALL_MS))).catch(() => {});
  const discardDirectory = (location: string) => Promise.resolve().then(() =>
    (deps.rm ?? fileOps.rm)(location, {recursive:true,force:true})).catch(() => {});
  const close = async () => {
    const tasks: Promise<unknown>[] = [];
    if (plugin && plugin !== unloaded) { unloaded = plugin; tasks.push(unload(plugin)); }
    if (directory && directory !== removed) {
      removed = directory;
      tasks.push(discardDirectory(directory));
    }
    // Cleanup is best-effort and may not hold a wake open indefinitely.
    let limit: ReturnType<typeof setTimeout> | number | undefined;
    try {
      await Promise.race([Promise.allSettled(tasks), new Promise<void>(resolve => {
        limit = setTimeout(resolve, CALL_MS + 100);
      })]);
    } finally { clearTimeout(limit); }
  };
  const onAbort = () => { void close(); };
  signal.addEventListener('abort', onAbort, {once:true});
  try {
    await bounded(async () => (deps.access ?? (async (file, mode) => fs.accessSync(file, mode)))(QDBUS, fs.constants.X_OK));
    const firstOwner = await owner();
    if (!firstOwner) { outcome = 'unsupported_bus'; return undefined; }
    const xml = await command([...KWIN, INTROSPECT_METHOD]);
    if (!hasScriptingMethods(xml) || await owner() !== firstOwner) {
      outcome = 'unsupported_bus'; return undefined;
    }
    probing = false;

    // mkdtemp creates mode 0700; the script is created mode 0600.
    directory = await bounded(async limited => {
      const location = await (deps.mkdtemp ?? fileOps.mkdtemp)(path.join(os.tmpdir(), 'crossfeed-wake-focus-'));
      // A mock filesystem may ignore cancellation and create a directory after
      // the preparation budget expired. Its late result owns its own cleanup.
      if (limited.aborted) { void discardDirectory(location); throw Error('focus_timeout'); }
      return location;
    });
    const script = path.join(directory, 'restore.js');
    plugin = 'crossfeed_focus_' + randomBytes(12).toString('hex');
    await bounded(async limited => {
      try { await (deps.writeFile ?? fileOps.writeFile)(script, kwinWakeFocusScript(marker), {mode:0o600}); }
      finally {
        // A late file write (even one rejecting) may leave partial content.
        if (limited.aborted) void discardDirectory(directory!);
      }
      if (limited.aborted) throw Error('focus_timeout');
    });
    if (await owner() !== firstOwner) { outcome = 'unsupported_bus'; return undefined; }
    const id = (await command([...KWIN, 'org.kde.kwin.Scripting.loadScript', script, plugin],
      () => { void unload(plugin!); })).trim();
    if (!/^(?:0|[1-9][0-9]{0,6})$/.test(id)) return undefined;
    if (await owner() !== firstOwner) { outcome = 'unsupported_bus'; return undefined; }
    await command(['org.kde.KWin', '/Scripting/Script' + id, 'org.kde.kwin.Script.run'],
      () => { void unload(plugin!); });
    if (await owner() !== firstOwner || signal.aborted) {
      outcome = signal.aborted ? 'cancelled' : 'unsupported_bus'; return undefined;
    }
    // Script.run is NOT a measurement of activation callbacks or first frame.
    armed = true;
    outcome = 'prepared';
    const timer = setTimeout(() => { void close(); }, 4800); timer.unref();
    return {close: async () => { clearTimeout(timer); await close(); }};
  } catch (error) {
    const timedOut = error instanceof Error && (error.message === 'focus_timeout' || error.name === 'TimeoutError' ||
      error.name === 'AbortError' || (error as NodeJS.ErrnoException).code === 'ETIMEDOUT');
    outcome = signal.aborted ? 'cancelled' : timedOut ? 'timeout' : probing ? 'unsupported_bus' : 'prepare_failed';
    return undefined;
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (!armed) void close();
    report(outcome);
  }
}
