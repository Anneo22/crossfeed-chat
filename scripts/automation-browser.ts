/**
 * Explicit, local-only automation browser profile. Importing this module is inert.
 * No signed-in browser profiles are discovered, copied, or modified.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { acquireLease, launchPrivateDisplay, recoverStopped, requireLinux, validateRuntime, type DisplayDeps } from './automation-display.ts';
import fs from 'node:fs';
const { accessSync, chmodSync, constants, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } = fs;
import { homedir } from 'node:os';
import path from 'node:path';
const { dirname, isAbsolute, join, resolve, sep } = path;
import { fileURLToPath } from 'node:url';

const MARKER = '.automation-browser.json';
const SCHEMA = 'crossfeed-chat-automation-browser';
const VERSION = 1;
const MAX_FILE = 1024 * 1024;
const MAX_TOTAL = 4 * 1024 * 1024;
const ASSETS = ['manifest.json', 'background.js', 'pairing.js', 'wake-window.js',
  'prefill-model.js', 'wake-window.html', 'core.js', 'page.js', 'options.js',
  'options.html', 'icons/icon-16.png', 'icons/icon-32.png', 'icons/icon-48.png',
  'icons/icon-128.png', 'icons/favicon.svg'] as const;
const LOCKS = ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'profile.lock', '.parentlock', 'lock'];
const SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), '../extension');

export type Command = 'prepare' | 'setup' | 'run' | 'recover';
export type Layout = { root: string; profile: string; extension: string; marker: string };
export type Plan = { command: Command; dryRun: boolean; layout: Layout; browser: string;
  args: string[]; childEnv: Record<string, string | undefined> };

function reject(message: string): never { throw new Error(message); }
function pathStat(path: string) {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
function absolute(path: string): string {
  if (!path || !isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path) ||
    path.split(sep).some(s => s === '.' || s === '..')) reject('Expected a clean absolute path');
  return resolve(path);
}
function noSymlinks(path: string): void {
  let current = sep;
  for (const part of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const st = pathStat(current);
    if (st?.isSymbolicLink()) reject('Symlink in managed path: ' + current);
    if (st && !st.isDirectory()) reject('Non-directory in managed path: ' + current);
  }
}
function protectProfilePath(root: string): void {
  const segments = root.toLowerCase().split(sep).filter(Boolean);
  const path = segments.join('/');
  if (/(^|\/)(google-chrome|google-chrome-beta|chromium|bravesoftware|brave-browser|brave-browser-beta)(\/|$)/.test(path) ||
    /(^|\/)(default|profile [0-9]+)(\/|$)/.test(path) ||
    root === '/') reject('Refusing a browser/default profile path');
}
export function layoutAt(root: string): Layout {
  const path = absolute(root);
  protectProfilePath(path);
  return { root: path, profile: join(path, 'profile'), extension: join(path, 'extension'), marker: join(path, MARKER) };
}
export function defaultRoot(env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
  return join(env.XDG_DATA_HOME ? absolute(env.XDG_DATA_HOME) : join(absolute(home), '.local', 'share'),
    'crossfeed-chat', 'automation-browser');
}
export function parseArgs(argv: string[], env: Record<string, string | undefined> = process.env, home?: string): Plan {
  const [cmd, ...rest] = argv;
  if (cmd !== 'prepare' && cmd !== 'setup' && cmd !== 'run' && cmd !== 'recover') reject('Usage: prepare|setup|run|recover [--root ABS] [--browser ABS] [--dry-run]');
  let root = defaultRoot(env, home), browser = '/usr/bin/brave', dryRun = false;
  const seen = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    if (!['--root', '--browser', '--dry-run'].includes(flag) || seen.has(flag)) reject('Unknown or repeated option: ' + flag);
    seen.add(flag);
    if (flag === '--dry-run') { dryRun = true; continue; }
    if (!rest[i + 1] || rest[i + 1]!.startsWith('--')) reject('Missing option value: ' + flag);
    if (flag === '--root') root = rest[++i]!;
    else browser = rest[++i]!;
  }
  const layout = layoutAt(root);
  browser = absolute(browser);
  const common = [`--user-data-dir=${layout.profile}`, `--load-extension=${layout.extension}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking'];
  const args = cmd === 'run'
    ? ['--ozone-platform=x11', ...common, 'about:blank']
    : cmd === 'setup' ? [...common, 'https://chatgpt.com/'] : [];
  const childEnv = { ...env };
  if (cmd === 'run') {
    delete childEnv.DISPLAY;
    delete childEnv.XAUTHORITY;
    delete childEnv.WAYLAND_DISPLAY;
    delete childEnv.WAYLAND_SOCKET;
  }
  return { command: cmd, dryRun, layout, browser, args, childEnv };
}
function verifyPermissions(path: string, mode: number, kind: 'directory' | 'file'): void {
  const st = pathStat(path);
  if (!st || (kind === 'directory' ? !st.isDirectory() : !st.isFile()) ||
    (st.mode & 0o077) !== 0 || st.uid !== process.getuid?.() || (st.mode & 0o700) !== (mode & 0o700))
    reject('Missing or unsafe managed ' + kind + ': ' + path);
}
function checkLocks(layout: Layout): void {
  for (const name of LOCKS) if (pathStat(join(layout.profile, name))) reject('Browser profile lock exists; close automation browser windows first: ' + name);
}
function markerValue(layout: Layout) {
  return { schema: SCHEMA, version: VERSION, root: layout.root, profile: 'profile', extension: 'extension' };
}
export function verifyManaged(layout: Layout, requireUnlocked = true): void {
  noSymlinks(layout.root);
  noSymlinks(layout.profile);
  noSymlinks(layout.extension);
  verifyPermissions(layout.root, 0o700, 'directory');
  verifyPermissions(layout.profile, 0o700, 'directory');
  verifyPermissions(layout.extension, 0o700, 'directory');
  const mst = pathStat(layout.marker);
  if (!mst || mst.isSymbolicLink()) reject('Unmarked automation root (refusing adoption)');
  verifyPermissions(layout.marker, 0o600, 'file');
  if (mst.size > 2048) reject('Invalid ownership marker');
  let marker: unknown;
  try { marker = JSON.parse(readFileSync(layout.marker, 'utf8')); }
  catch { reject('Invalid ownership marker'); }
  if (JSON.stringify(marker) !== JSON.stringify(markerValue(layout))) reject('Ownership marker mismatch');
  if (requireUnlocked) checkLocks(layout);
  const top = ASSETS.filter(name => !name.includes('/'));
  const icons = ASSETS.filter(name => name.startsWith('icons/')).map(name => name.slice(6));
  noSymlinks(join(layout.extension, 'icons'));
  verifyPermissions(join(layout.extension, 'icons'), 0o700, 'directory');
  if (JSON.stringify(readdirSync(layout.extension).sort()) !== JSON.stringify([...top, 'icons'].sort()) ||
      JSON.stringify(readdirSync(join(layout.extension, 'icons')).sort()) !== JSON.stringify(icons.sort()))
    reject('Managed extension contains unexpected assets');
  let total = 0;
  for (const name of ASSETS) {
    const p = join(layout.extension, name);
    const st = pathStat(p);
    if (!st || st.isSymbolicLink() || !st.isFile() || st.size > MAX_FILE || (total += st.size) > MAX_TOTAL)
      reject('Missing or unsafe extension asset: ' + name);
  }
}
function ensureParents(path: string): void {
  const missing: string[] = [];
  let p = path;
  while (!pathStat(p)) { missing.push(p); p = dirname(p); }
  noSymlinks(p);
  for (const dir of missing.reverse()) {
    mkdirSync(dir, { mode: 0o700 });
    noSymlinks(dir);
  }
}
function sources(source: string): { name: string; source: string; size: number }[] {
  source = absolute(source);
  noSymlinks(source);
  let total = 0;
  return ASSETS.map(name => {
    const path = join(source, name);
    const stat = pathStat(path);
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) reject('Unsafe/missing extension source asset: ' + name);
    noSymlinks(dirname(path));
    if (stat.size > MAX_FILE || (total += stat.size) > MAX_TOTAL) reject('Extension source asset size cap exceeded');
    return { name, source: path, size: stat.size };
  });
}
function identicalCopy(layout: Layout, files: ReturnType<typeof sources>): boolean {
  return files.every(file => {
    const target = join(layout.extension, file.name);
    noSymlinks(dirname(target));
    const st = pathStat(target);
    return !!st && st.isFile() && !st.isSymbolicLink() && st.size === file.size &&
      readFileSync(target).equals(readFileSync(file.source));
  });
}
/** Creates only a fresh, owned root; never deletes or adopts existing profile data. */
export function prepareManaged(layout: Layout, source = SOURCE, dryRun = false, skipLockCheck = false): void {
  noSymlinks(layout.root);
  const existing = pathStat(layout.root);
  if (existing && pathStat(layout.marker)) {
    verifyManaged(layout, !skipLockCheck);
    const files = sources(source);
    if (!identicalCopy(layout, files)) reject('Managed extension differs from source; stopped manual update/review required');
    return;
  }
  if (existing && readdirSync(layout.root).length) reject('Nonempty unmarked root; refusing adoption after partial/foreign setup');
  const files = sources(source); // before any writes
  if (dryRun) return;
  ensureParents(dirname(layout.root));
  if (!existing) mkdirSync(layout.root, { mode: 0o700 });
  verifyPermissions(layout.root, 0o700, 'directory');
  // Marker is written LAST: a failed copy cannot be misidentified as an owned root.
  if (pathStat(layout.profile) || pathStat(layout.extension)) reject('Unmarked existing managed subdirectory');
  mkdirSync(layout.profile, { mode: 0o700 });
  const staged = mkdtempSync(join(layout.root, '.extension-staging-'));
  chmodSync(staged, 0o700);
  mkdirSync(join(staged, 'icons'), { mode: 0o700 });
  for (const file of files) {
    const to = join(staged, file.name);
    copyFileSync(file.source, to);
    chmodSync(to, 0o600);
  }
  renameSync(staged, layout.extension);
  writeFileSync(layout.marker, JSON.stringify(markerValue(layout)) + '\n',
    { flag: 'wx', mode: 0o600 });
}
export function validateBrowser(browser: string): void {
  const st = statSync(browser);
  if (!st.isFile()) reject('Browser must be a regular executable file');
  accessSync(browser, constants.X_OK);
}
/** Only this child process object can be signalled; no global kill, process scan or attach. */
export function launchOwned(plan: Plan, deps: Pick<DisplayDeps, 'spawnProcess' | 'signals' | 'reportExitStatus'> = {}, release?: () => void): ChildProcess {
  if (plan.command !== 'setup') reject('Only interactive setup may launch on physical display');
  const signalBus = deps.signals ?? process;
  const child = (deps.spawnProcess ?? spawn)(plan.browser, plan.args, {
    shell: false, detached: false, stdio: 'inherit', env: plan.childEnv,
  });
  let alive = true, failed = false, shuttingDown = false;
  let watchdog: NodeJS.Timeout | undefined;
  const report = deps.reportExitStatus ?? ((status: number) => { process.exitCode = status; });
  const kill = (signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL') => {
    if (!alive || !child.pid) return;
    try { child.kill(signal); } catch { failed = true; }
  };
  const armWatchdog = () => {
    if (watchdog || !alive) return;
    watchdog = setTimeout(() => {
      watchdog = undefined;
      if (alive) { kill('SIGKILL'); armWatchdog(); }
    }, 3000);
    watchdog.unref();
  };
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    kill('SIGTERM');
    armWatchdog();
  };
  const forwardInt = () => kill('SIGINT');
  const forwardTerm = () => kill('SIGTERM');
  const cleanup = (status: number) => {
    if (!alive) return;
    alive = false;
    if (watchdog) clearTimeout(watchdog);
    signalBus.off('SIGINT', forwardInt);
    signalBus.off('SIGTERM', forwardTerm);
    release?.();
    report(failed ? 1 : status);
  };
  signalBus.on('SIGINT', forwardInt);
  signalBus.on('SIGTERM', forwardTerm);
  const stopped = (code: number | null, signal: string | null) => {
    cleanup(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1));
  };
  child.once('exit', stopped);
  child.once('close', stopped);
  child.on('error', () => {
    failed = true;
    // A failed kill may emit error with a still-running PID.
    if (!child.pid) cleanup(1); // Definitively failed spawn only.
    else shutdown();
  });
  return child;
}
/** A run is always headed on its own authenticated private display; never on the physical desktop. */
export function execute(plan: Plan, source = SOURCE, deps: DisplayDeps = {}): ChildProcess | Promise<ChildProcess> | undefined {
  requireLinux(deps.platform);
  if (plan.command === 'prepare') { prepareManaged(plan.layout, source, plan.dryRun); return; }
  if (plan.command === 'setup') {
    validateBrowser(plan.browser); // BEFORE any profile writes
    prepareManaged(plan.layout, source, plan.dryRun, true);
    if (plan.dryRun) return;
    const release = acquireLease(plan.layout);
    try { verifyManaged(plan.layout); return launchOwned(plan, deps, release); }
    catch (e) { release(); throw e; }
  }
  verifyManaged(plan.layout, false);
  if (plan.command === 'recover') {
    if (!plan.dryRun) recoverStopped(plan.layout, deps);
    return;
  }
  validateBrowser(plan.browser);
  validateRuntime(plan.layout);
  if (plan.dryRun) { checkLocks(plan.layout); return; }
  return launchPrivateDisplay(plan, deps);
}
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const plan = parseArgs(argv);
  const child = await execute(plan);
  if (plan.dryRun) { console.log('Validated dry-run plan (no launch or writes):', plan.command, plan.layout.root); return; }
  if (plan.command === 'prepare' || plan.command === 'recover') {
    console.log(plan.command === 'prepare' ? 'Private automation profile prepared; no browser launched.' : 'Explicit stopped-owner recovery completed; no browser launched.'); return;
  }
  if (plan.command === 'setup') console.log('Sign in manually at chatgpt.com in the separate automation browser. Pair the NEW pending receiver after host selects it. Close only the automation windows before run.');
  else console.log('Running headed Brave on isolated authenticated private X11 display; Ctrl-C stops owned children only.');
  void child;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(error => { console.error('Automation browser:', (error as Error).message); process.exitCode = 1; });
}
