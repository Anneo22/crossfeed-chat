/** Private X11 supervisor. No work is performed when imported. Linux only. */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { hostname as hostName } from 'node:os';
import path from 'node:path';
import type { Layout, Plan } from './automation-browser.ts';

const { lstatSync, readFileSync, readlinkSync, writeFileSync, openSync, closeSync,
  writeSync, fstatSync, unlinkSync, rmdirSync, mkdtempSync, statSync, accessSync } = fs;
const { join, dirname, sep } = path;
const LEASE = '.automation-manager.json';
const SINGLETONS = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'] as const;
const OTHER_LOCKS = ['profile.lock', '.parentlock', 'lock'] as const;
const RUNTIME_SCHEMA = 'crossfeed-chat-private-xvfb';
const LEASE_SCHEMA = 'crossfeed-chat-automation-manager';

export type DisplayDeps = {
  /** Platform seam for synthetic supervisor tests. Defaults to the actual host. */
  platform?: string;
  spawnProcess?: typeof spawn;
  signals?: Pick<NodeProcess, 'on' | 'off'>;
  /** Test-only override: real implementation probes authenticated xdpyinfo. */
  probe?: (display: string, env: Record<string, string | undefined>) => Promise<boolean>;
  alive?: (pid: number) => boolean | null;
  hostname?: string;
  slotStart?: number;
  startupTimeoutMs?: number;
  /** Injectable process terminal status, including when spawnProcess is mocked. */
  reportExitStatus?: (status: number) => void;
};
function fail(reason: string): never { throw Error(reason); }
export function requireLinux(platform = process.platform): void {
  if (platform !== 'linux') fail('Private browser automation requires Linux');
}
function lst(p: string) {
  try { return lstatSync(p); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}
function noLinks(p: string, leafDir = true): void {
  let current = sep;
  const parts = p.slice(1).split(sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]!);
    const st = lst(current);
    if (st?.isSymbolicLink() || (st && (i < parts.length - 1 || leafDir) && !st.isDirectory()))
      fail('Unsafe linked/non-directory private path');
  }
}
function same(a: {ino:number;dev:number}, b: {ino:number;dev:number}): boolean {
  return a.ino === b.ino && a.dev === b.dev;
}
function ownedFile(p: string, executable = false, maxSize = 256 * 1024 * 1024): void {
  noLinks(dirname(p));
  const s = lst(p);
  if (!s || s.isSymbolicLink() || !s.isFile() || s.uid !== process.getuid?.() ||
      s.size < 1 || s.size > maxSize || (s.mode & 0o022) !== 0) fail('Missing or unsafe owned runtime file');
  if (executable) accessSync(p, fs.constants.X_OK);
}
function readBounded(p: string, max = 512): string {
  const s = lst(p);
  if (!s || !s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid?.() ||
      s.size > max || s.size < 2 || (s.mode & 0o077) !== 0) fail('Unsafe private record');
  return readFileSync(p, 'utf8');
}
/** Manifest is a host admission record, NOT independent proof of vendor signature. */
export function validateRuntime(layout: Layout): string {
  const runtime = join(layout.root, 'runtime');
  noLinks(runtime);
  const rs = lst(runtime);
  if (!rs?.isDirectory() || rs.uid !== process.getuid?.() || (rs.mode & 0o077) !== 0)
    fail('Missing or unsafe private Xvfb runtime directory');
  const binary = join(runtime, 'Xvfb');
  const provenance = join(runtime, 'provenance.json');
  ownedFile(binary, true);
  ownedFile(provenance, false, 512);
  const obj: unknown = JSON.parse(readBounded(provenance));
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) fail('Invalid Xvfb provenance');
  const rec = obj as Record<string, unknown>;
  if (Object.keys(rec).sort().join(',') !== 'schema,sha256,version' ||
      rec.schema !== RUNTIME_SCHEMA || rec.version !== 1 ||
      typeof rec.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(rec.sha256))
    fail('Invalid Xvfb provenance schema');
  const actual = createHash('sha256').update(readFileSync(binary)).digest('hex');
  if (actual !== rec.sha256) fail('Xvfb binary SHA-256 mismatch');
  return binary;
}
function live(pid: number, deps: DisplayDeps): boolean | null {
  if (deps.alive) return deps.alive(pid);
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH' ? false : null; }
}
function host(deps: DisplayDeps): string { return deps.hostname ?? hostName(); }
function pidFrom(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 2147483647)
    fail('Invalid owner PID');
  return value as number;
}
type LeaseRecord = { schema: string; version: number; hostname: string; pid: number; nonce: string };
function readLease(p: string): LeaseRecord {
  let rec: LeaseRecord;
  try { rec = JSON.parse(readBounded(p)) as LeaseRecord; } catch { return fail('Ambiguous manager lease'); }
  if (!rec || Object.keys(rec).sort().join(',') !== 'hostname,nonce,pid,schema,version' ||
      rec.schema !== LEASE_SCHEMA || rec.version !== 1 ||
      typeof rec.hostname !== 'string' || !rec.hostname ||
      typeof rec.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(rec.nonce))
    fail('Ambiguous manager lease');
  pidFrom(rec.pid);
  return rec;
}
/** Never auto-steal stale leases; an operator must explicitly invoke recover. */
export function acquireLease(layout: Layout): () => void {
  noLinks(layout.root);
  const p = join(layout.root, LEASE);
  const value = JSON.stringify({ schema: LEASE_SCHEMA, version: 1,
    hostname: hostName(), pid: process.pid, nonce: randomBytes(16).toString('hex') }) + '\n';
  let fd: number;
  try { fd = openSync(p, 'wx', 0o600); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') fail('Manager lease exists; use explicit recover only after owner exits');
    throw e;
  }
  let identity;
  try { writeSync(fd, value); identity = fstatSync(fd); }
  finally { closeSync(fd); }
  return () => {
    const st = lst(p);
    if (!st || !st.isFile() || !same(st, identity) || readFileSync(p, 'utf8') !== value)
      fail('Manager lease changed; refusing to unlink');
    unlinkSync(p);
  };
}
function requireDead(pid: number, deps: DisplayDeps): void {
  if (live(pid, deps) !== false) fail('Live or ambiguous owner PID; refusing recovery');
}
function removeDeadLease(layout: Layout, deps: DisplayDeps): void {
  const p = join(layout.root, LEASE);
  const st = lst(p);
  if (!st) return;
  const before = readLease(p);
  if (before.hostname !== host(deps)) fail('Cross-host manager lease; refusing recovery');
  requireDead(before.pid, deps);
  const after = lst(p);
  if (!after || !same(st, after) || !after.isFile() ||
      JSON.stringify(readLease(p)) !== JSON.stringify(before)) fail('Manager lease identity changed');
  unlinkSync(p);
}
/** Only Chromium's three singleton symlinks, after dead owner proof. Never follow socket/cookie targets. */
export function recoverSingletons(layout: Layout, deps: DisplayDeps = {}): number {
  for (const name of OTHER_LOCKS)
    if (lst(join(layout.profile, name))) fail('Unknown/other profile lock: ' + name);
  const lock = join(layout.profile, 'SingletonLock');
  const st = lst(lock);
  const links = SINGLETONS.map(name => ({ name, p: join(layout.profile, name),
    st: lst(join(layout.profile, name)) }));
  if (!st) {
    if (links.some(x => x.st)) fail('Orphan singleton links without owner');
    return 0;
  }
  if (!st.isSymbolicLink()) fail('Regular or unknown SingletonLock; refusing recovery');
  const target = readlinkSync(lock);
  const expected = host(deps) + '-';
  if (!target.startsWith(expected) || !/^[1-9][0-9]{0,9}$/.test(target.slice(expected.length)))
    fail('Cross-host or ambiguous SingletonLock');
  const pid = pidFrom(Number(target.slice(expected.length)));
  requireDead(pid, deps);
  if (links.some(x => x.st && !x.st.isSymbolicLink())) fail('Regular or unknown singleton entry');
  // Recheck complete identity and dead PID before any unlink.
  requireDead(pid, deps);
  for (const item of links) {
    const now = lst(item.p);
    if (!!now !== !!item.st || (now && (!now.isSymbolicLink() || !same(now, item.st!))))
      fail('Singleton identity changed during recovery');
  }
  if (readlinkSync(lock) !== target) fail('Singleton owner changed during recovery');
  for (const item of links) if (item.st) unlinkSync(item.p);
  return links.filter(x => x.st).length;
}
/** Caller must verify managed marker and extension BEFORE invoking recover. */
export function recoverStopped(layout: Layout, deps: DisplayDeps = {}): number {
  removeDeadLease(layout, deps);
  const release = acquireLease(layout);
  try { return recoverSingletons(layout, deps); }
  finally { release(); }
}
function wire(data: Buffer): Buffer {
  if (data.length > 65535) fail('Xauthority record field too long');
  return Buffer.concat([Buffer.from([data.length >>> 8, data.length & 255]), data]);
}
/** Xauthority X11 binary format, FamilyLocal with the exact host and display number. */
export function xauthorityRecord(displayNumber: number, hostname: string, cookie: Buffer): Buffer {
  if (!Number.isSafeInteger(displayNumber) || displayNumber < 0 || displayNumber > 65535 ||
      !hostname || cookie.length !== 16) fail('Invalid Xauthority parameters');
  return Buffer.concat([Buffer.from([1, 0]), wire(Buffer.from(hostname)),
    wire(Buffer.from(String(displayNumber))), wire(Buffer.from('MIT-MAGIC-COOKIE-1')),
    wire(cookie)]);
}
function displayFree(n: number): boolean {
  return !lst('/tmp/.X11-unix/X' + n) && !lst('/tmp/.X' + n + '-lock');
}
function sleep(ms: number): Promise<void> { return new Promise(ok => setTimeout(ok, ms)); }
function nativeProbe(display: string, env: Record<string, string | undefined>, timeoutMs = 900): Promise<boolean> {
  return new Promise(resolve => {
    let done = false;
    const child = spawn('/usr/bin/xdpyinfo', ['-display', display],
      { shell: false, detached: false, stdio: 'ignore', env });
    const finish = (ok: boolean) => { if (done) return; done = true; clearTimeout(timer); resolve(ok); };
    const timer = setTimeout(() => { if (child.pid) child.kill('SIGKILL'); finish(false); }, timeoutMs);
    child.once('exit', (code: number | null) => finish(code === 0));
    child.once('error', () => finish(false));
  });
}
export async function launchPrivateDisplay(plan: Plan, deps: DisplayDeps = {}): Promise<ChildProcess> {
  requireLinux(deps.platform);
  if (plan.command !== 'run') fail('Private display can only run managed browser');
  const xvfb = validateRuntime(plan.layout);
  const release = acquireLease(plan.layout); // before profile lock check or child spawn
  let session: string | undefined;
  let server: ChildProcess | undefined;
  let browser: ChildProcess | undefined;
  let serverDone = false, browserDone = false, supervised = false, stopping = false, finished = false;
  let fatal = false, requestedServerStop = false, operatorSignal: 'SIGINT' | 'SIGTERM' | null = null;
  let browserStatus = 1;
  const bus = deps.signals ?? process;
  const report = deps.reportExitStatus ?? ((status: number) => { process.exitCode = status; });
  let timer: NodeJS.Timeout | undefined;
  const cleanFiles = () => {
    if (!session) return;
    const auth = join(session, 'Xauthority');
    const s = lst(auth);
    if (s) {
      if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid?.()) fail('Private Xauthority replaced');
      unlinkSync(auth);
    }
    rmdirSync(session);
  };
  const kill = (child: ChildProcess | undefined, sig: string) => {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      try { child.kill(sig); } catch { fatal = true; }
    }
  };
  // Retain the lease/auth and keep bounded own-child escalation active until termination is proven.
  const armWatchdog = () => {
    if (timer || (serverDone && browserDone)) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!browserDone) kill(browser, 'SIGKILL');
      if (!serverDone) kill(server, 'SIGKILL');
      armWatchdog();
    }, 3000);
    timer.unref();
  };
  const stopServer = () => {
    if (!requestedServerStop) {
      requestedServerStop = true; // Must precede a synchronously observed fake exit.
      if (!serverDone) kill(server, 'SIGTERM');
    }
    armWatchdog();
  };
  const stopBrowser = () => {
    if (stopping) return; // ChildProcess error after a failed kill must not recurse.
    stopping = true;
    if (browser && !browserDone) kill(browser, 'SIGTERM');
    if (!browser || browserDone) stopServer();
    armWatchdog();
  };
  const signalInt = () => { operatorSignal ??= 'SIGINT'; stopBrowser(); };
  const signalTerm = () => { operatorSignal ??= 'SIGTERM'; stopBrowser(); };
  const done = () => {
    if (!supervised || !browserDone || !serverDone || finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    bus.off('SIGINT', signalInt);
    bus.off('SIGTERM', signalTerm);
    cleanFiles();
    release();
    // Exit 0 for an intentional operator stop, not for an unexpected display death.
    report(fatal ? 1 : operatorSignal ? 0 : browserStatus);
  };
  try {
    for (const name of [...SINGLETONS, ...OTHER_LOCKS])
      if (lst(join(plan.layout.profile, name))) fail('Browser profile lock exists: ' + name);
    const runtime = join(plan.layout.root, 'runtime');
    session = mkdtempSync(join(runtime, 'session-'));
    fs.chmodSync(session, 0o700);
    const seed = randomBytes(2);
    const start = deps.slotStart ?? (1600 + (seed[0]! * 256 + seed[1]!) % 6000);
    const n = [start, start + 1, start + 2].find(displayFree);
    if (n === undefined) fail('No free private X11 display slot');
    const display = ':' + n;
    const auth = join(session, 'Xauthority');
    writeFileSync(auth, xauthorityRecord(n, host(deps), randomBytes(16)), { flag: 'wx', mode: 0o600 });
    const env: Record<string, string | undefined> = { ...plan.childEnv, DISPLAY: display, XAUTHORITY: auth };
    delete env.WAYLAND_DISPLAY;
    delete env.WAYLAND_SOCKET;
    server = (deps.spawnProcess ?? spawn)(xvfb, [display, '-screen', '0', '1280x800x24',
      '-nolisten', 'tcp', '-noreset', '-auth', auth],
    { shell: false, detached: false, stdio: 'ignore', env: plan.childEnv });
    const ownServer = server;
    const serverStopped = () => {
      if (serverDone) return;
      serverDone = true;
      if (!requestedServerStop) fatal = true;
      if (browser && !browserDone) stopBrowser();
      done();
    };
    ownServer.once('exit', serverStopped);
    ownServer.once('close', serverStopped);
    ownServer.on('error', () => {
      fatal = true;
      // An error with a PID (including failed kill) does NOT prove death.
      if (!ownServer.pid) serverStopped();
      stopBrowser();
      done();
    });
    bus.on('SIGINT', signalInt);
    bus.on('SIGTERM', signalTerm);
    const deadline = Date.now() + Math.min(15000, deps.startupTimeoutMs ?? 15000);
    let ready = false;
    while (Date.now() < deadline && !serverDone && !stopping) {
      const remaining = Math.max(1, deadline - Date.now());
      const authenticated = deps.probe
        ? await deps.probe(display, env)
        : await nativeProbe(display, env, Math.min(900, remaining));
      if (authenticated) { ready = true; break; }
      if (!serverDone) await sleep(125);
    }
    if (!ready || serverDone || stopping) fail('Private Xvfb authenticated readiness failed');
    browser = (deps.spawnProcess ?? spawn)(plan.browser, plan.args, {
      shell: false, detached: false, stdio: 'inherit', env });
    const ownBrowser = browser;
    const browserStopped = (code: number | null, signal: string | null) => {
      if (browserDone) return;
      browserDone = true;
      browserStatus = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
      stopServer();
      done();
    };
    ownBrowser.once('exit', browserStopped);
    ownBrowser.once('close', browserStopped);
    ownBrowser.on('error', () => {
      fatal = true;
      if (!ownBrowser.pid) browserStopped(null, null);
      stopServer();
      armWatchdog();
      done();
    });
    // Xvfb can die during browser spawn, before browser is assigned/listeners attached.
    if (serverDone || fatal || stopping) stopBrowser();
    supervised = true;
    return ownBrowser;
  } catch (e) {
    fatal = true;
    // Even startup failure must not release auth/lease until EVERY spawned PID exits.
    supervised = true;
    if (!server) serverDone = true;
    if (!browser) browserDone = true;
    stopBrowser();
    done();
    const until = Date.now() + 3000;
    while ((!serverDone || !browserDone) && Date.now() < until) await sleep(30);
    if (!serverDone || !browserDone) {
      if (!serverDone) kill(server, 'SIGKILL');
      if (!browserDone) kill(browser, 'SIGKILL');
      armWatchdog();
      fail('Private child failed to terminate; lease and Xauthority retained');
    }
    throw e;
  }
}
