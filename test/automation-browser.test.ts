import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, statSync, rmSync } = fs;
import { tempPrefix } from './temp.ts';
import path from 'node:path';
const { join } = path;
import test from 'node:test';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { acquireLease, launchPrivateDisplay, recoverStopped, validateRuntime, xauthorityRecord, type DisplayDeps } from '../scripts/automation-display.ts';
import { execute as executeBrowser, launchOwned, layoutAt, parseArgs, prepareManaged, verifyManaged } from '../scripts/automation-browser.ts';

// Exercise Linux supervision with inert fake children on every test host.
const execute = (plan: Parameters<typeof executeBrowser>[0], source: string, deps: DisplayDeps = {}) =>
  executeBrowser(plan, source, {...deps, platform: 'linux'});

const ASSETS = ['manifest.json', 'background.js', 'pairing.js', 'wake-window.js', 'prefill-model.js',
  'wake-window.html', 'core.js', 'page.js', 'options.js', 'options.html',
  'icons/icon-16.png', 'icons/icon-32.png', 'icons/icon-48.png', 'icons/icon-128.png', 'icons/favicon.svg'];

function fixture(t: { after(fn: () => void): void }) {
  const base = mkdtempSync(tempPrefix('crossfeed-owned-test-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const source = join(base, 'repo-extension');
  mkdirSync(join(source, 'icons'), { recursive: true });
  for (const asset of ASSETS) writeFileSync(join(source, asset), 'test-fixture-' + asset);
  const root = join(base, 'managed');
  const layout = layoutAt(root);
  const browser = join(base, 'browser');
  writeFileSync(browser, '#!/bin/false\n', { mode: 0o700 }); // NEVER executed
  return { base, source, layout, browser };
}
test('non-Linux entry points refuse before profile writes or launch', async t => {
  const f = fixture(t);
  for (const platform of ['darwin', 'win32']) {
    const deps = {platform, spawnProcess: (() => assert.fail('unsupported platform spawned a child')) as unknown as DisplayDeps['spawnProcess']};
    for (const command of ['prepare', 'setup', 'run', 'recover']) {
      for (const flags of [[], ['--dry-run']]) {
        const plan = parseArgs([command, '--root', f.layout.root, '--browser', f.browser, ...flags], {}, f.base);
        assert.throws(() => executeBrowser(plan, f.source, deps), /requires Linux/);
        assert.equal(existsSync(f.layout.root), false);
      }
    }
    const plan = parseArgs(['run', '--root', f.layout.root, '--browser', f.browser], {}, f.base);
    await assert.rejects(launchPrivateDisplay(plan, deps), /requires Linux/);
    assert.equal(existsSync(f.layout.root), false);
  }
  if (process.platform !== 'linux') {
    assert.throws(() => executeBrowser(parseArgs(['prepare', '--root', f.layout.root], {}, f.base), f.source), /requires Linux/);
    assert.equal(existsSync(f.layout.root), false);
  }
});
test('import is inert; headed run plan is pure and never uses desktop display', t => {
  const f = fixture(t);
  const env = { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0', WAYLAND_SOCKET: 'socket', FOO: 'keep' };
  const run = parseArgs(['run', '--root', f.layout.root, '--browser', f.browser], env, f.base);
  assert.deepEqual(run.args, [
    '--ozone-platform=x11',
    `--user-data-dir=${f.layout.profile}`, `--load-extension=${f.layout.extension}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking', 'about:blank',
  ]);
  assert.equal(run.childEnv.FOO, 'keep');
  for (const key of ['DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'WAYLAND_SOCKET']) {
    assert.equal(run.childEnv[key], undefined);
    if (key !== 'XAUTHORITY') assert.ok(env[key as keyof typeof env]);
  }
  // Managed path values may legitimately include words like "automation"; inspect switches only.
  assert.ok(!run.args.filter(s => !s.startsWith('--user-data-dir=') &&
    !s.startsWith('--load-extension=')).some(s =>
      /headless|debugg|no-sandbox|password-store|user-agent|automation|disable-blink-features/i.test(s)));
  assert.ok(!existsSync(f.layout.root));
  const headed = parseArgs(['setup', '--root', f.layout.root, '--browser', f.browser], env, f.base);
  assert.equal(headed.childEnv.DISPLAY, ':0');
  assert.ok(!headed.args.some(v => v.startsWith('--headless') || v.includes('remote-debugging')));
  assert.ok(headed.args.includes('https://chatgpt.com/'));
});
test('strict argv, default profile exclusion and dry-run no-write', t => {
  const f = fixture(t);
  const base = ['prepare', '--root', f.layout.root];
  for (const args of [[], ['whoops'], [...base, '--mystery'], [...base, '--root', f.layout.root],
    [...base, '--browser'], ['prepare', '--root', 'relative'],
    ['prepare', '--root', f.layout.root + '\0bad'], ['prepare', '--root', f.base + '/x/../y']])
    assert.throws(() => parseArgs(args), undefined, args.join(' '));
  assert.throws(() => layoutAt(join(f.base, 'BraveSoftware', 'Brave-Browser', 'Default')), /profile/i);
  assert.throws(() => layoutAt(join(f.base, 'chromium')), /profile/i);
  const plan = parseArgs([...base, '--dry-run'], {}, f.base);
  execute(plan, f.source);
  assert.equal(existsSync(f.layout.root), false);
  assert.throws(() => execute(parseArgs(['run', '--root', f.layout.root, '--browser', f.browser, '--dry-run'], {}, f.base), f.source), /unsafe|Missing/i);
});
test('private staged preparation, ownership marker, idempotency and private auth preserved', t => {
  const f = fixture(t);
  prepareManaged(f.layout, f.source);
  verifyManaged(f.layout);
  assert.equal(statSync(f.layout.root).mode & 0o077, 0);
  assert.equal(statSync(f.layout.profile).mode & 0o077, 0);
  assert.equal(statSync(f.layout.marker).mode & 0o077, 0);
  const auth = join(f.layout.profile, 'user-auth-do-not-read');
  writeFileSync(auth, 'sensitive-private-fixture', { mode: 0o000 });
  prepareManaged(f.layout, f.source);
  assert.equal(statSync(auth).mode & 0o777, 0); // unreadable sentinel must remain untouched
  assert.equal(readFileSync(join(f.layout.extension, 'options.html'), 'utf8'), 'test-fixture-options.html');
  writeFileSync(join(f.source, 'options.html'), 'changed');
  assert.throws(() => prepareManaged(f.layout, f.source), /differs/);
  assert.equal(readFileSync(join(f.layout.extension, 'options.html'), 'utf8'), 'test-fixture-options.html');
  assert.ok(existsSync(auth));
});
test('reject nonempty unmarked roots and symlink traversal / dangling locks', t => {
  const f = fixture(t);
  mkdirSync(f.layout.root);
  writeFileSync(join(f.layout.root, 'personal'), 'do not adopt');
  assert.throws(() => prepareManaged(f.layout, f.source), /Nonempty unmarked/);
  const other = layoutAt(join(f.base, 'symlink-managed'));
  symlinkSync(f.layout.root, other.root);
  assert.throws(() => prepareManaged(other, f.source), /Symlink/);
  const parentLink = join(f.base, 'foreign-parent');
  symlinkSync(f.base, parentLink);
  assert.throws(() => prepareManaged(layoutAt(join(parentLink, 'new-managed')), f.source), /Symlink/);
});
test('source symlinks and file size caps fail before any managed files are created', t => {
  const f = fixture(t);
  rmSync(join(f.source, 'page.js'));
  symlinkSync(join(f.source, 'options.js'), join(f.source, 'page.js'));
  assert.throws(() => prepareManaged(f.layout, f.source), /Unsafe/);
  assert.equal(existsSync(f.layout.root), false);
  rmSync(join(f.source, 'page.js'));
  writeFileSync(join(f.source, 'page.js'), Buffer.alloc(1024 * 1024 + 1));
  assert.throws(() => prepareManaged(f.layout, f.source), /size cap/);
  assert.equal(existsSync(f.layout.root), false);
});
test('marked roots refuse dangling singleton lock, marker mismatch, private symlink', t => {
  const f = fixture(t);
  prepareManaged(f.layout, f.source);
  const lock = join(f.layout.profile, 'SingletonLock');
  symlinkSync('/nonexistent/crossfeed-test-lock', lock);
  assert.throws(() => verifyManaged(f.layout), /lock exists/);
  rmSync(lock);
  const marker = readFileSync(f.layout.marker);
  writeFileSync(f.layout.marker, marker.toString().replace('version":1', 'version":2'));
  assert.throws(() => verifyManaged(f.layout), /mismatch/);
});
test('extension copy refuses later symlink substitution and unapproved files', t => {
  const f = fixture(t);
  prepareManaged(f.layout, f.source);
  writeFileSync(join(f.layout.extension, 'unexpected.js'), 'injected');
  assert.throws(() => verifyManaged(f.layout), /unexpected assets/);
  rmSync(join(f.layout.extension, 'unexpected.js'));
  rmSync(join(f.layout.extension, 'icons'), { recursive: true, force: true });
  symlinkSync(join(f.source, 'icons'), join(f.layout.extension, 'icons'));
  assert.throws(() => verifyManaged(f.layout), /Symlink/);
});
test('only injected child receives signals; no unrelated PID is ever touched', t => {
  const f = fixture(t);
  const plan = parseArgs(['setup', '--root', f.layout.root, '--browser', f.browser], {}, f.base);
  const signals = new EventEmitter();
  const fake = new EventEmitter() as EventEmitter & { pid: number; kill: (signal: string) => boolean };
  fake.pid = 53266;
  const forwarded: string[] = [];
  fake.kill = s => { forwarded.push(s); return true; };
  let called = 0;
  const spawnProcess = ((_command: string, args: string[], options: { shell: boolean; detached: boolean }) => {
    called++;
    assert.deepEqual(args, plan.args);
    assert.equal(options.shell, false);
    assert.equal(options.detached, false);
    return fake as unknown as ChildProcess;
  }) as unknown as typeof import('node:child_process').spawn;
  const child = launchOwned(plan, { spawnProcess, signals: signals as unknown as Pick<NodeProcess, 'on' | 'off'> });
  assert.equal(child, fake);
  assert.equal(called, 1);
  signals.emit('SIGINT');
  signals.emit('SIGTERM');
  assert.deepEqual(forwarded, ['SIGINT', 'SIGTERM']);
  fake.emit('exit', 0, null);
  signals.emit('SIGINT');
  assert.deepEqual(forwarded, ['SIGINT', 'SIGTERM']);
  assert.equal(signals.listenerCount('SIGINT'), 0);
});
test('setup uses only test-injected process and run validates exact managed root', t => {
  const f = fixture(t);
  const signals = new EventEmitter();
  const fake = new EventEmitter() as EventEmitter & { pid: number; kill: () => boolean };
  fake.pid = 1;
  fake.kill = () => true;
  let times = 0;
  const spawnProcess = ((cmd: string, args: string[]) => {
    assert.equal(cmd, f.browser);
    assert.ok(args.includes('https://chatgpt.com/'));
    times++;
    return fake as unknown as ChildProcess;
  }) as unknown as typeof import('node:child_process').spawn;
  const plan = parseArgs(['setup', '--root', f.layout.root, '--browser', f.browser], {}, f.base);
  execute(plan, f.source, { spawnProcess, signals: signals as unknown as Pick<NodeProcess, 'on' | 'off'> });
  assert.equal(times, 1);
  fake.emit('exit', 0, null);
  assert.throws(() => execute(parseArgs(['run', '--root', f.layout.root, '--browser', f.browser, '--dry-run'], {}, f.base), f.source), /runtime/i);
});

function addFakeRuntime(f: ReturnType<typeof fixture>) {
  const runtime = join(f.layout.root, 'runtime');
  mkdirSync(runtime, { mode: 0o700 });
  const binary = join(runtime, 'Xvfb');
  writeFileSync(binary, 'FAKE-XVFB-NEVER-EXECUTE', { mode: 0o700 });
  const sha256 = createHash('sha256').update(readFileSync(binary)).digest('hex');
  writeFileSync(join(runtime, 'provenance.json'),
    JSON.stringify({ schema: 'crossfeed-chat-private-xvfb', version: 1, sha256 }), { mode: 0o600 });
  return { runtime, binary };
}
function fakeChild(pid: number, log: string[]) {
  const child = new EventEmitter() as EventEmitter & ChildProcess;
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal?: string | number) => {
    log.push(pid + ':' + String(signal));
    queueMicrotask(() => {
      if (child.exitCode === null) {
        child.exitCode = 0;
        child.emit('exit', 0, null);
      }
    });
    return true;
  };
  return child;
}
function runHarness(t: { after(fn: () => void): void }) {
  const f = fixture(t);
  prepareManaged(f.layout, f.source);
  addFakeRuntime(f);
  const plan = parseArgs(['run', '--root', f.layout.root, '--browser', f.browser],
    { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0', DBUS_SESSION_BUS_ADDRESS: 'test-keyring' }, f.base);
  const signals = new EventEmitter();
  const kills: string[] = [], statuses: number[] = [], spawns: { cmd: string; args: string[]; opts: any }[] = [];
  const server = fakeChild(11222, kills), browser = fakeChild(11223, kills);
  const spawnProcess = ((cmd: string, args: string[], opts: any) => {
    spawns.push({ cmd, args, opts });
    return spawns.length === 1 ? server : browser;
  }) as unknown as typeof import('node:child_process').spawn;
  const launch = (overrides: Record<string, unknown> = {}) => execute(plan, f.source, {
    spawnProcess, signals: signals as unknown as Pick<NodeProcess, 'on' | 'off'>,
    slotStart: 9100, probe: async () => true,
    reportExitStatus: (status: number) => statuses.push(status), ...overrides,
  }) as Promise<ChildProcess>;
  return { ...f, plan, signals, kills, statuses, spawns, server, browserChild: browser, launch };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('runtime admission requires owned binary, exact schema, bound SHA and safe paths', t => {
  const f = fixture(t);
  prepareManaged(f.layout, f.source);
  assert.throws(() => validateRuntime(f.layout), /runtime/i);
  const { runtime, binary } = addFakeRuntime(f);
  assert.equal(validateRuntime(f.layout), binary);
  writeFileSync(binary, 'TAMPER', { mode: 0o700 });
  assert.throws(() => validateRuntime(f.layout), /SHA-256/);
  const sha256 = createHash('sha256').update(readFileSync(binary)).digest('hex');
  const manifest = join(runtime, 'provenance.json');
  writeFileSync(manifest, JSON.stringify({ schema: 'wrong', version: 1, sha256 }));
  assert.throws(() => validateRuntime(f.layout), /schema/);
  writeFileSync(manifest, JSON.stringify({ schema: 'crossfeed-chat-private-xvfb', version: 1, sha256 }), { mode: 0o600 });
  rmSync(binary);
  symlinkSync(f.browser, binary);
  assert.throws(() => validateRuntime(f.layout), /unsafe/i);
  rmSync(binary);
  writeFileSync(binary, 'TAMPER', { mode: 0o700 });
  rmSync(manifest);
  symlinkSync(f.browser, manifest);
  assert.throws(() => validateRuntime(f.layout), /unsafe/i);
});

test('run dry-run is read-only, headed run uses owned auth before browser, no suspicious flags', async t => {
  const h = runHarness(t);
  const sentinel = join(h.layout.profile, 'private-auth-sentinel');
  writeFileSync(sentinel, 'NEVER_READ_THIS', { mode: 0o000 });
  const dry = parseArgs(['run', '--root', h.layout.root, '--browser', h.browser, '--dry-run'], {}, h.base);
  await execute(dry, h.source);
  assert.equal(h.spawns.length, 0);
  assert.equal(existsSync(join(h.layout.root, '.automation-manager.json')), false);
  const result = await h.launch({ probe: async (display: string, env: any) => {
    assert.match(display, /^:9100$/);
    assert.equal(env.DISPLAY, display);
    assert.equal(env.DBUS_SESSION_BUS_ADDRESS, 'test-keyring');
    assert.ok(existsSync(env.XAUTHORITY));
    assert.equal(statSync(env.XAUTHORITY).mode & 0o777, 0o600);
    const record = readFileSync(env.XAUTHORITY);
    assert.equal(record[0], 1); // FamilyLocal, big-endian 256
    assert.equal(record[1], 0);
    assert.ok(record.toString('latin1').includes('MIT-MAGIC-COOKIE-1'));
    assert.equal(h.spawns.length, 1); // genuine authenticated readiness before Chrome
    return true;
  }});
  assert.equal(result, h.browserChild);
  assert.equal(h.spawns.length, 2);
  const [display, browser] = h.spawns;
  assert.equal(display!.cmd, join(h.layout.root, 'runtime', 'Xvfb'));
  assert.deepEqual(display!.args.slice(0, 6), [':9100', '-screen', '0', '1280x800x24', '-nolisten', 'tcp']);
  assert.deepEqual(display!.args.slice(6, 8), ['-noreset', '-auth']);
  assert.equal(display!.opts.shell, false);
  assert.equal(browser!.cmd, h.browser);
  assert.deepEqual(browser!.args, h.plan.args);
  assert.ok(browser!.args.includes('about:blank'));
  assert.ok(browser!.args.includes('--ozone-platform=x11'));
  assert.ok(!browser!.args.some((s: string) => /headless|remote-debug|no-sandbox|password-store|user-agent|disable-blink-features/i.test(s)));
  assert.equal(browser!.opts.env.DISPLAY, ':9100');
  assert.equal(browser!.opts.env.WAYLAND_DISPLAY, undefined);
  assert.equal(browser!.opts.env.WAYLAND_SOCKET, undefined);
  assert.equal(browser!.opts.env.DBUS_SESSION_BUS_ADDRESS, 'test-keyring');
  const auth = browser!.opts.env.XAUTHORITY;
  h.browserChild.exitCode = 0; h.browserChild.emit('exit', 0, null);
  await tick();
  assert.deepEqual(h.kills, ['11222:SIGTERM']);
  assert.equal(existsSync(auth), false);
  assert.equal(existsSync(join(h.layout.root, '.automation-manager.json')), false);
  assert.equal(statSync(sentinel).mode & 0o777, 0);
  // Permission-000 auth sentinel is never opened.
});

test('Xvfb startup error aborts without browser and releases only own lease', async t => {
  const h = runHarness(t);
  await assert.rejects(h.launch({ probe: async () => { throw Error('offline-probe-error'); } }), /offline-probe-error/);
  assert.equal(h.spawns.length, 1);
  assert.deepEqual(h.kills, ['11222:SIGTERM']);
  assert.equal(existsSync(join(h.layout.root, '.automation-manager.json')), false);
  assert.equal(fs.readdirSync(join(h.layout.root, 'runtime')).filter(s => s.startsWith('session-')).length, 0);
});

test('server death stops only own browser; browser exit stops only own server; signals unregister', async t => {
  const h = runHarness(t);
  await h.launch();
  h.server.exitCode = 1; h.server.emit('exit', 1, null);
  await tick();
  assert.deepEqual(h.kills, ['11223:SIGTERM']);
  assert.equal(existsSync(join(h.layout.root, '.automation-manager.json')), false);
  assert.equal(h.signals.listenerCount('SIGTERM'), 0);
  const h2 = runHarness(t);
  await h2.launch();
  h2.signals.emit('SIGTERM');
  await tick();
  assert.deepEqual(h2.kills, ['11223:SIGTERM', '11222:SIGTERM']);
  assert.equal(existsSync(join(h2.layout.root, '.automation-manager.json')), false);
  assert.equal(h2.signals.listenerCount('SIGINT'), 0);
});

test('competing manager lease is refused; setup and recover do not need Xvfb runtime', async t => {
  const h = runHarness(t);
  await h.launch();
  await assert.rejects(h.launch(), /lease exists/i);
  assert.equal(h.spawns.length, 2);
  h.browserChild.exitCode = 0; h.browserChild.emit('exit', 0, null);
  await tick();
  const f = fixture(t);
  const setup = parseArgs(['setup', '--root', f.layout.root, '--browser', f.browser], {}, f.base);
  execute(setup, f.source, {
    spawnProcess: ((_cmd: string, _args: string[]) => {
      const child = fakeChild(11224, []);
      queueMicrotask(() => { child.exitCode = 0; child.emit('exit', 0, null); });
      return child;
    }) as unknown as typeof import('node:child_process').spawn,
    signals: new EventEmitter() as unknown as Pick<NodeProcess, 'on' | 'off'>,
  });
  await tick();
  assert.ok(existsSync(f.layout.marker));
  assert.equal(existsSync(join(f.layout.root, 'runtime')), false);
  execute(parseArgs(['recover', '--root', f.layout.root], {}, f.base), f.source, { alive: () => false });
  assert.equal(existsSync(join(f.layout.root, 'runtime')), false);
});

test('explicit recovery of dead managed singleton links, not their link targets', t => {
  const f = fixture(t);
  prepareManaged(f.layout, f.source);
  const lock = join(f.layout.profile, 'SingletonLock');
  const socket = join(f.layout.profile, 'SingletonSocket');
  const cookie = join(f.layout.profile, 'SingletonCookie');
  const sentinel = join(f.layout.profile, 'private-auth-sentinel');
  writeFileSync(sentinel, 'UNTOUCHED', { mode: 0o000 });
  symlinkSync(hostname() + '-22334', lock);
  symlinkSync(sentinel, socket);
  symlinkSync(sentinel, cookie);
  assert.throws(() => verifyManaged(f.layout), /lock exists/);
  const removed = recoverStopped(f.layout, { alive: pid => pid === 22334 ? false : null });
  assert.equal(removed, 3);
  assert.ok(!existsSync(lock) && !existsSync(socket) && !existsSync(cookie));
  assert.equal(statSync(sentinel).mode & 0o777, 0);
  // Permission-000 auth sentinel is never opened.
});

test('recovery refuses live, cross-host, ambiguous and regular singleton entries', t => {
  const f = fixture(t);
  prepareManaged(f.layout, f.source);
  const lock = join(f.layout.profile, 'SingletonLock');
  symlinkSync(hostname() + '-22334', lock);
  assert.throws(() => recoverStopped(f.layout, { alive: () => true }), /Live or ambiguous/);
  assert.throws(() => recoverStopped(f.layout, { alive: () => null }), /Live or ambiguous/);
  rmSync(lock);
  symlinkSync('different-host-22334', lock);
  assert.throws(() => recoverStopped(f.layout, { alive: () => false }), /Cross-host/);
  rmSync(lock);
  symlinkSync(hostname() + '-invalid', lock);
  assert.throws(() => recoverStopped(f.layout, { alive: () => false }), /ambiguous/);
  rmSync(lock);
  writeFileSync(lock, 'regular-not-safe');
  assert.throws(() => recoverStopped(f.layout, { alive: () => false }), /Regular/);
  rmSync(lock);
  symlinkSync(hostname() + '-22334', lock);
  writeFileSync(join(f.layout.profile, 'SingletonCookie'), 'regular');
  assert.throws(() => recoverStopped(f.layout, { alive: () => false }), /Regular/);
  assert.ok(fs.lstatSync(lock).isSymbolicLink());
});

test('stale manager lease requires explicit proven-dead same-host recovery', t => {
  const f = fixture(t);
  prepareManaged(f.layout, f.source);
  const lease = join(f.layout.root, '.automation-manager.json');
  const make = (owner: string) => writeFileSync(lease, JSON.stringify({
    schema: 'crossfeed-chat-automation-manager', version: 1,
    hostname: owner, pid: 22887, nonce: 'a'.repeat(32),
  }), { mode: 0o600 });
  make(hostname());
  assert.throws(() => acquireLease(f.layout), /lease exists/);
  assert.throws(() => recoverStopped(f.layout, { alive: () => true }), /Live/);
  assert.ok(existsSync(lease));
  assert.equal(recoverStopped(f.layout, { alive: () => false }), 0);
  assert.equal(existsSync(lease), false);
  make('unrelated-host');
  assert.throws(() => recoverStopped(f.layout, { alive: () => false }), /Cross-host/);
  assert.ok(existsSync(lease));
  rmSync(lease);
  make(hostname());
  writeFileSync(lease, '{corrupt');
  assert.throws(() => recoverStopped(f.layout, { alive: () => false }), /Ambiguous/);
});

test('Xauthority encoder requires exact 16-byte cookie and records MIT scheme', () => {
  assert.throws(() => xauthorityRecord(9000, 'localhost', Buffer.alloc(4)), /Invalid/);
  const b = xauthorityRecord(9000, 'localhost', Buffer.alloc(16, 7));
  assert.equal(b[0], 1);
  assert.equal(b[1], 0);
  assert.ok(b.toString('latin1').includes('MIT-MAGIC-COOKIE-1'));
  assert.equal(b.subarray(-16).toString('hex'), '07'.repeat(16));
});


test('unexpected server exit is fatal even when the browser exits 0; cleanup waits for both', async t => {
  const h = runHarness(t);
  h.browserChild.kill = (signal?: string | number) => {
    h.kills.push('11223:' + String(signal));
    return true; // Still alive: SIGTERM only requested, not proved.
  };
  await h.launch();
  const lease = join(h.layout.root, '.automation-manager.json');
  const authDir = fs.readdirSync(join(h.layout.root, 'runtime')).find(s => s.startsWith('session-'))!;
  const auth = join(h.layout.root, 'runtime', authDir, 'Xauthority');
  h.server.exitCode = 1; h.server.emit('exit', 1, null);
  await tick();
  assert.equal(existsSync(lease), true);
  assert.equal(existsSync(auth), true);
  assert.deepEqual(h.statuses, []);
  h.browserChild.exitCode = 0; h.browserChild.emit('exit', 0, null);
  await tick();
  assert.deepEqual(h.statuses, [1]); // Real terminal reporter receives fatal status.
  assert.equal(existsSync(lease), false);
  assert.equal(existsSync(auth), false);
});

test('normal browser 0 and expected server termination produce success status', async t => {
  const h = runHarness(t);
  await h.launch();
  h.browserChild.exitCode = 0;
  h.browserChild.emit('exit', 0, null);
  await tick();
  assert.deepEqual(h.statuses, [0]);
  assert.deepEqual(h.kills, ['11222:SIGTERM']);
  assert.equal(existsSync(join(h.layout.root, '.automation-manager.json')), false);
});

test('operator SIGINT and SIGTERM are intentional success, not display crashes', async t => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const h = runHarness(t);
    await h.launch();
    h.signals.emit(signal);
    await tick();
    assert.deepEqual(h.statuses, [0]);
    assert.deepEqual(h.kills, ['11223:SIGTERM', '11222:SIGTERM']);
    assert.equal(h.signals.listenerCount(signal), 0);
  }
});

test('server error while PID alive retains manager lease and Xauthority until actual exit', async t => {
  const h = runHarness(t);
  h.server.kill = (signal?: string | number) => {
    h.kills.push('11222:' + String(signal));
    return false; // Failed kill does NOT constitute exit.
  };
  await h.launch();
  const lease = join(h.layout.root, '.automation-manager.json');
  const dir = fs.readdirSync(join(h.layout.root, 'runtime')).find(s => s.startsWith('session-'))!;
  const auth = join(h.layout.root, 'runtime', dir, 'Xauthority');
  h.server.emit('error', Error('synthetic-kill-failed'));
  await tick(); // Browser exits from requested shutdown; display does not.
  assert.ok(existsSync(lease));
  assert.ok(existsSync(auth));
  assert.deepEqual(h.statuses, []);
  assert.equal(h.signals.listenerCount('SIGINT'), 1);
  h.server.exitCode = 0; h.server.emit('exit', 0, null);
  await tick();
  assert.deepEqual(h.statuses, [1]);
  assert.ok(!existsSync(lease) && !existsSync(auth));
});

test('browser error while PID alive retains auth/lease even after display exits', async t => {
  const h = runHarness(t);
  h.browserChild.kill = (signal?: string | number) => {
    h.kills.push('11223:' + String(signal));
    return false;
  };
  await h.launch();
  const lease = join(h.layout.root, '.automation-manager.json');
  const dir = fs.readdirSync(join(h.layout.root, 'runtime')).find(s => s.startsWith('session-'))!;
  const auth = join(h.layout.root, 'runtime', dir, 'Xauthority');
  h.browserChild.emit('error', Error('synthetic-broken-kill'));
  await tick();
  assert.ok(existsSync(lease));
  assert.ok(existsSync(auth));
  assert.deepEqual(h.statuses, []);
  h.browserChild.exitCode = 0; h.browserChild.emit('close', 0, null);
  await tick();
  assert.deepEqual(h.statuses, [1]);
  assert.ok(!existsSync(lease) && !existsSync(auth));
});

test('physical setup error while child alive retains lease; genuine exit releases and fails', t => {
  const f = fixture(t);
  const plan = parseArgs(['setup', '--root', f.layout.root, '--browser', f.browser], {}, f.base);
  const signals = new EventEmitter();
  const child = fakeChild(11224, []);
  child.kill = () => false;
  const statuses: number[] = [];
  execute(plan, f.source, {
    spawnProcess: (() => child) as unknown as typeof import('node:child_process').spawn,
    signals: signals as unknown as Pick<NodeProcess, 'on' | 'off'>,
    reportExitStatus: code => statuses.push(code),
  });
  const lease = join(f.layout.root, '.automation-manager.json');
  child.emit('error', Error('synthetic-error-while-alive'));
  assert.ok(existsSync(lease));
  assert.equal(signals.listenerCount('SIGTERM'), 1);
  assert.deepEqual(statuses, []);
  child.exitCode = 0; child.emit('close', 0, null);
  assert.equal(existsSync(lease), false);
  assert.deepEqual(statuses, [1]);
});

test('startup failure with unkillable server retains manager lease/auth until proven exit', async t => {
  const h = runHarness(t);
  h.server.kill = () => false;
  const lease = join(h.layout.root, '.automation-manager.json');
  await assert.rejects(h.launch({probe: async () => {throw Error('synthetic-probe-failed');}}),
    /lease and Xauthority retained/);
  assert.equal(h.spawns.length, 1);
  assert.ok(existsSync(lease));
  const dir = fs.readdirSync(join(h.layout.root, 'runtime')).find(s => s.startsWith('session-'))!;
  const auth = join(h.layout.root, 'runtime', dir, 'Xauthority');
  assert.ok(existsSync(auth));
  assert.deepEqual(h.statuses, []);
  h.server.exitCode = 1; h.server.emit('exit', 1, null);
  await tick();
  assert.deepEqual(h.statuses, [1]);
  assert.ok(!existsSync(lease) && !existsSync(auth));
});

test('readiness positive but immediate Xvfb exit fails closed before browser spawn', async t => {
  const h = runHarness(t);
  await assert.rejects(h.launch({probe: async () => {
    queueMicrotask(() => {
      h.server.exitCode = 1;
      h.server.emit('exit', 1, null);
    });
    return true;
  }}), /authenticated readiness failed/);
  assert.equal(h.spawns.length, 1);
  assert.deepEqual(h.statuses, [1]);
  assert.ok(!existsSync(join(h.layout.root, '.automation-manager.json')));
});

test('failed spawn with no PID safely releases after proven failure (both children)', async t => {
  const a = runHarness(t);
  (a.server as ChildProcess).pid = undefined;
  await assert.rejects(a.launch({probe: async () => {
    a.server.emit('error', Error('ENOENT'));
    return false;
  }}), /authenticated readiness failed/);
  assert.equal(a.spawns.length, 1);
  assert.deepEqual(a.statuses, [1]);
  assert.ok(!existsSync(join(a.layout.root, '.automation-manager.json')));
  const b = runHarness(t);
  (b.browserChild as ChildProcess).pid = undefined;
  await b.launch();
  b.browserChild.emit('error', Error('ENOENT'));
  await tick();
  assert.deepEqual(b.statuses, [1]);
  assert.ok(!existsSync(join(b.layout.root, '.automation-manager.json')));
});

test('server death synchronously during browser spawn still forces fatal shutdown', async t => {
  const h = runHarness(t);
  let spawned = 0;
  const spawnProcess = ((_cmd: string, _args: string[], _opts: unknown) => {
    spawned++;
    if (spawned === 1) return h.server;
    h.server.exitCode = 1;
    h.server.emit('exit', 1, null); // Browser reference is not assigned yet.
    return h.browserChild;
  }) as unknown as typeof import('node:child_process').spawn;
  await h.launch({ spawnProcess });
  await tick();
  assert.equal(spawned, 2);
  assert.deepEqual(h.kills, ['11223:SIGTERM']);
  assert.deepEqual(h.statuses, [1]);
  assert.ok(!existsSync(join(h.layout.root, '.automation-manager.json')));
});

test('setup spawn error without PID safely releases own manager lease', t => {
  const f = fixture(t);
  const plan = parseArgs(['setup', '--root', f.layout.root, '--browser', f.browser], {}, f.base);
  const child = fakeChild(11224, []);
  (child as ChildProcess).pid = undefined;
  const statuses: number[] = [];
  execute(plan, f.source, {
    spawnProcess: (() => child) as unknown as typeof import('node:child_process').spawn,
    signals: new EventEmitter() as unknown as Pick<NodeProcess, 'on' | 'off'>,
    reportExitStatus: code => statuses.push(code),
  });
  child.emit('error', Error('synthetic-spawn-failure'));
  assert.deepEqual(statuses, [1]);
  assert.ok(!existsSync(join(f.layout.root, '.automation-manager.json')));
});
