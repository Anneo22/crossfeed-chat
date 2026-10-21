import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {kwinWakeFocusScript, prepareWakeFocusGuard} from '../src/wake-focus.ts';

const marker = 'c'.repeat(32);
function compositor(preexisting: any[] = [], activationAlias = 'windowActivated') {
  let clock = 100, active: any, desktop = 'main', activity = 'a';
  const previous: any = {resourceClass: 'konsole', normalWindow: true};
  active = previous;
  const windows: any[] = [previous, ...preexisting], restored: any[] = [];
  const signal = () => {
    const listeners = new Set<(w: any) => void>();
    return {
      connect(fn: (w: any) => void) {listeners.add(fn);},
      disconnect(fn: (w: any) => void) {listeners.delete(fn);},
      fire(w: any) {for (const fn of [...listeners]) fn(w);},
    };
  };
  const windowAdded = signal(), windowActivated = signal(), windowRemoved = signal();
  const currentDesktopChanged = signal(), currentActivityChanged = signal();
  const workspace = {
    get activeWindow() {return active;},
    set activeWindow(w: any) {restored.push(w); active = w;},
    get currentDesktop() {return desktop;},
    get currentActivity() {return activity;},
    windowList: () => windows,
    windowAdded, ...(activationAlias ? {[activationAlias]: windowActivated} : {}), windowRemoved,
    currentDesktopChanged, currentActivityChanged,
  };
  vm.runInNewContext(kwinWakeFocusScript(marker), {workspace, Date: {now: () => clock}});
  const browser = (resourceClass = 'brave-browser', normalWindow = true) => ({resourceClass, normalWindow, caption:'Crossfeed Wake '+marker, captionChanged:signal()});
  return {
    previous, restored, browser,
    caption(w:any, value:string) {w.caption=value; w.captionChanged.fire(w);},
    add(w: any) {windows.push(w); windowAdded.fire(w);},
    activate(w: any) {active = w; windowActivated.fire(w);},
    activateNoSignalArgument(w: any) {active = w; windowActivated.fire(undefined);},
    activateBeforeAdded(w: any) {active = w; windowActivated.fire(w); windows.push(w); windowAdded.fire(w);},
    activeWithoutEvent(w: any) {active = w;},
    setDesktop(value: string) {desktop = value; currentDesktopChanged.fire(value);},
    setActivity(value: string) {activity = value; currentActivityChanged.fire(value);},
    removePrevious() {windows.splice(windows.indexOf(previous), 1); windowRemoved.fire(previous);},
    advance(value: number) {clock += value;},
  };
}

test('KWin restores prior window immediately after new normal browser activation, once', () => {
  const f = compositor(), window = f.browser();
  f.add(window); f.activate(window);
  assert.deepEqual(f.restored, [f.previous]);
  f.activate(window); assert.equal(f.restored.length, 1);
});
test('KWin covers activation-before-added and already-active-on-added with exact title proof', () => {
  const early = compositor(), window = early.browser('chromium');
  early.activateBeforeAdded(window); assert.deepEqual(early.restored, [early.previous]);
  const direct = compositor(), other = direct.browser('google-chrome');
  direct.activeWithoutEvent(other); direct.add(other);
  assert.deepEqual(direct.restored, [direct.previous]);
});
test('KWin leaves unrelated user activations, existing browsers and unrelated windows untouched', () => {
  for (const which of ['existing', 'other', 'second']) {
    const f = compositor(), first = f.browser(), second = f.browser();
    if (which === 'existing') {f.activate(f.previous); f.activate(first);}
    if (which === 'other') {f.activate({resourceClass:'firefox',normalWindow:true}); f.add(first); f.activate(first);}
    if (which === 'second') {f.add(first); f.add(second); f.activate(second);}
    assert.deepEqual(f.restored, [], which);
  }
  const preexisting = {resourceClass:'brave-browser',normalWindow:true};
  const prior = compositor([preexisting]);
  prior.activate(preexisting);
  assert.deepEqual(prior.restored, [], 'pre-arm browser must not be restored');
  const f = compositor(), newBrowser = f.browser();
  f.add(newBrowser); f.activate(newBrowser);
  assert.equal(f.restored.length, 1);
});
test('KWin cancels when desktop/activity changes, old window closes or TTL expires', () => {
  for (const caseName of ['desktop', 'activity', 'closed', 'expired']) {
    const f = compositor(), w = f.browser('chromium-browser');
    f.add(w);
    if (caseName === 'desktop') f.setDesktop('other');
    if (caseName === 'activity') f.setActivity('other');
    if (caseName === 'closed') f.removePrevious();
    if (caseName === 'expired') f.advance(4001);
    f.activate(w); assert.equal(f.restored.length, 0, caseName);
  }
  const transient = compositor(), candidate = transient.browser();
  transient.add(candidate);
  transient.setDesktop('other'); transient.setDesktop('main');
  transient.activate(candidate);
  assert.deepEqual(transient.restored, [], 'transient desktop switch cancels guard');
  const f = compositor(), wrong = f.browser('firefox');
  f.add(wrong); f.activate(wrong); assert.deepEqual(f.restored, []);
});
test('KWin helper uses fixed DBus binary, a private script, and idempotent cleanup', async () => {
  const calls: string[][] = [], removed: string[] = [], writes: any[] = [];
  const ctrl = new AbortController();
  const deps: any = {
    marker, platform:'linux', env:{XDG_SESSION_TYPE:'wayland',XDG_CURRENT_DESKTOP:'KDE',DBUS_SESSION_BUS_ADDRESS:'mock-bus'},
    access: async () => {}, mkdtemp: async () => '/private/focus',
    writeFile: async (...args: any[]) => {writes.push(args);},
    rm: async (where: string) => {removed.push(where);},
    run: async (binary: string, args: string[]) => {
      assert.equal(binary, '/usr/bin/qdbus6'); calls.push(args);
      return qdbusOutput(args);
    },
  };
  const guard = await prepareWakeFocusGuard(ctrl.signal, deps);
  assert(guard);
  assert.equal(writes[0][0], '/private/focus/restore.js');
  assert.equal(writes[0][2].mode, 0o600);
  assert.match(writes[0][1], /windowAdded\.connect/);
  assert.deepEqual(calls.slice(0,3).map(args => args[2]),
    ['org.freedesktop.DBus.GetNameOwner','org.freedesktop.DBus.Introspectable.Introspect','org.freedesktop.DBus.GetNameOwner']);
  assert(calls.some(args => args[2] === 'org.kde.kwin.Script.run'));
  assert(calls.filter(args => args[2] === 'org.freedesktop.DBus.GetNameOwner').length >= 4);
  await guard.close(); await guard.close();
  assert.equal(calls.filter(args => args[2] === 'org.kde.kwin.Scripting.unloadScript').length, 1);
  assert.deepEqual(removed, ['/private/focus']);
});
test('KWin guard cleanup completes within its bound even when unload hangs', {timeout:2500}, async () => {
  const removed: string[] = [];
  const deps: any = {
    marker, platform:'linux', env:{XDG_SESSION_TYPE:'wayland',XDG_CURRENT_DESKTOP:'KDE',DBUS_SESSION_BUS_ADDRESS:'mock-bus'},
    access:async () => {}, mkdtemp:async () => '/private/hung-unload',
    writeFile:async () => {}, rm:async (where:string) => {removed.push(where);},
    run:async (_binary:string, args:string[]) => {
      if (args[2] === 'org.kde.kwin.Scripting.unloadScript') return new Promise<string>(() => {});
      return qdbusOutput(args, '9');
    },
  };
  const guard = await prepareWakeFocusGuard(new AbortController().signal, deps);
  assert(guard);
  const result = await Promise.race([
    guard.close().then(() => 'closed'),
    new Promise(resolve => setTimeout(() => resolve('hung'), 950)),
  ]);
  assert.equal(result, 'closed');
  assert.deepEqual(removed, ['/private/hung-unload']);
});
test('unsupported compositor or abort cannot arm a KWin script', async () => {
  const calls: string[] = [];
  const deps: any = {marker, platform:'linux',env:{XDG_SESSION_TYPE:'x11',XDG_CURRENT_DESKTOP:'KDE'},
    access:async () => calls.push('access')};
  assert.equal(await prepareWakeFocusGuard(new AbortController().signal,deps),undefined);
  assert.deepEqual(calls, []);
  const ctrl = new AbortController(); ctrl.abort();
  deps.env.XDG_SESSION_TYPE = 'wayland';
  assert.equal(await prepareWakeFocusGuard(ctrl.signal,deps),undefined);
});

test('a user-created same-class browser window is never a wake ownership proof', () => {
  const f = compositor(), user = {...f.browser(), caption:'My research - Brave'};
  f.add(user); f.activate(user);
  assert.deepEqual(f.restored, [], 'the helper must not take focus away from a user-created Brave window');
});

test('KWin waits for its private marker and rejects similar or different markers', () => {
  for (const caption of ['ChatGPT', 'Crossfeed Wake '+ 'd'.repeat(32), 'Crossfeed Wake '+marker+'x', 'Other Crossfeed Wake '+marker]) {
    const f = compositor(), w = {...f.browser(),caption};
    f.add(w); f.activate(w);
    assert.deepEqual(f.restored, [], caption);
    f.caption(w,'Crossfeed Wake '+marker+' - Brave');
    assert.deepEqual(f.restored,[f.previous]);
  }
});

test('a later user activation cancels restoration even when the owned caption arrives', () => {
  const f = compositor(), owned = {...f.browser(),caption:'Loading'}, user = {...f.browser(),caption:'My browser'};
  f.add(owned); f.activate(owned); f.add(user); f.activate(user);
  f.caption(owned,'Crossfeed Wake '+marker);
  assert.deepEqual(f.restored, []);
});

test('invalid or missing focus markers cannot arm desktop restoration', async () => {
  for (const marker of [undefined,'', 'c'.repeat(31), 'C'.repeat(32), 'c'.repeat(32)+'x']) {
    let accessed = false;
    assert.equal(await prepareWakeFocusGuard(new AbortController().signal,{
      marker, platform:'linux',env:{XDG_SESSION_TYPE:'wayland',XDG_CURRENT_DESKTOP:'KDE',DBUS_SESSION_BUS_ADDRESS:'mock-bus'},
      access:async () => {accessed=true;},
    }), undefined);
    assert.equal(accessed,false);
  }
});

const validScriptingXML = '<node><interface name="org.kde.kwin.Scripting"><method name="loadScript"/><method name="unloadScript"/></interface></node>';
const standardDoctype = '<!DOCTYPE node PUBLIC "-//freedesktop//DTD D-BUS Object Introspection 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd">';
const introspectionBody = `<?xml version="1.0" encoding="UTF-8"?>\n${standardDoctype}\n<node>\n  <interface name="org.freedesktop.DBus.Introspectable"><method name="Introspect"/></interface>\n  <interface name="org.kde.kwin.Scripting">\n    <method name="loadScript"><arg name="filePath" type="s" direction="in"/><arg name="pluginName" type="s" direction="in"/></method>\n    <method name="unloadScript"><arg name="pluginName" type="s" direction="in"/></method>\n  </interface>\n</node>`;
const realDoctypeXML = introspectionBody.replace('</node>', ' '.repeat(2657 - introspectionBody.length) + '</node>');
// Real KWin/qdbus may line-wrap between the fixed DTD identifiers and URL.
const multilineDoctype = '<!DOCTYPE\n node\tPUBLIC\r\n "-//freedesktop//DTD D-BUS Object Introspection 1.0//EN"\n "http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd"\n>';
const multilineBody = introspectionBody.replace(standardDoctype, multilineDoctype);
const multiline2657 = multilineBody.replace('</node>', ' '.repeat(2657 - multilineBody.length) + '</node>');
const qdbusOutput = (args: string[], id = '17') => {
  if (args[2] === 'org.freedesktop.DBus.GetNameOwner') return ':1.42';
  if (args[2] === 'org.freedesktop.DBus.Introspectable.Introspect') return validScriptingXML;
  if (args[2] === 'org.kde.kwin.Scripting.loadScript') return id;
  return '';
};

const prepareNative = (signal: AbortSignal, deps: Parameters<typeof prepareWakeFocusGuard>[1] = {}) =>
  prepareWakeFocusGuard(signal, {...deps, marker});

test('realistic 2657-byte standard D-Bus DOCTYPE introspection admits exact KWin methods without entity expansion', async () => {
  assert.equal(Buffer.byteLength(realDoctypeXML), 2657);
  const calls: string[] = [], removed: string[] = [];
  const guard = await prepareNative(new AbortController().signal, {
    platform:'linux', env:{XDG_SESSION_TYPE:'', XDG_CURRENT_DESKTOP:'', DBUS_SESSION_BUS_ADDRESS:'bus'},
    access:async () => {}, mkdtemp:async () => '/mock/introspection', writeFile:async () => {},
    rm:async (directory: string) => {removed.push(directory);},
    run:async (_binary: string, args: string[]) => {
      calls.push(args[2]);
      return args[2] === 'org.freedesktop.DBus.Introspectable.Introspect' ? realDoctypeXML : qdbusOutput(args);
    },
  });
  assert(guard);
  assert.equal(calls.filter(method => method === 'org.kde.kwin.Scripting.loadScript').length, 1);
  assert.equal(calls.filter(method => method === 'org.kde.kwin.Script.run').length, 1);
  await guard.close();
  assert.deepEqual(removed, ['/mock/introspection']);
});

test('live-shape 2657-byte multiline freedesktop DTD admits KWin with fake nonmutating run/load', async () => {
  assert.equal(Buffer.byteLength(multiline2657), 2657);
  const called: string[] = [];
  const guard = await prepareNative(new AbortController().signal, {
    platform:'linux', env:{DBUS_SESSION_BUS_ADDRESS:'mock-bus'},
    access:async () => {}, mkdtemp:async () => '/fake/multiline',
    writeFile:async () => {}, rm:async () => {},
    run:async (_binary, args) => {
      called.push(args[2]);
      return args[2] === 'org.freedesktop.DBus.Introspectable.Introspect'
        ? multiline2657 : qdbusOutput(args);
    },
  });
  assert(guard, 'the parser must reach the fake guard-arm path');
  assert.equal(called.includes('org.kde.kwin.Scripting.loadScript'), true);
  assert.equal(called.includes('org.kde.kwin.Script.run'), true);
  await guard.close();
});

test('missing desktop and session metadata with session bus safely probes KWin before loading, including script id zero', async () => {
  const calls: string[][] = [], removed: string[] = [], written: any[] = [], tempPrefixes: string[] = [];
  const secret = 'SENSITIVE_SESSION_BUS_VALUE_MUST_NOT_LEAK';
  const deps: any = {
    platform:'linux', env:{XDG_SESSION_TYPE:'', XDG_CURRENT_DESKTOP:'', DBUS_SESSION_BUS_ADDRESS: secret},
    access:async (bin: string) => { assert.equal(bin, '/usr/bin/qdbus6'); },
    mkdtemp:async (prefix: string) => {tempPrefixes.push(prefix); return '/mock/private-focus';},
    writeFile:async (...args: any[]) => {written.push(args);},
    rm:async (dir: string) => {removed.push(dir);},
    run:async (bin: string, args: string[]) => {
      assert.equal(bin, '/usr/bin/qdbus6');
      assert.equal(JSON.stringify(args).includes(secret), false);
      calls.push(args); return qdbusOutput(args, '0');
    },
  };
  const guard = await prepareNative(new AbortController().signal, deps);
  assert(guard);
  assert(tempPrefixes[0].endsWith('crossfeed-wake-focus-'));
  assert.equal(written.length, 1);
  assert.equal(written[0][2].mode, 0o600);
  assert(calls.some(args => args[0] === 'org.kde.KWin' && args[1] === '/Scripting/Script0' && args[2] === 'org.kde.kwin.Script.run'));
  assert(calls.some(args => args[0] === 'org.freedesktop.DBus' && args[2] === 'org.freedesktop.DBus.GetNameOwner'));
  assert(calls.some(args => args[0] === 'org.kde.KWin' && args[2] === 'org.freedesktop.DBus.Introspectable.Introspect'));
  await guard.close(); await guard.close();
  assert.equal(calls.filter(args => args[2] === 'org.kde.kwin.Scripting.unloadScript').length, 1);
  assert.deepEqual(removed, ['/mock/private-focus']);
});

test('no session bus, explicit X11, non-KDE and non-Linux cannot enter KWin probing', async () => {
  const rejected = [
    {platform:'linux',env:{XDG_SESSION_TYPE:'', XDG_CURRENT_DESKTOP:''}},
    {platform:'linux',env:{XDG_SESSION_TYPE:'x11', XDG_CURRENT_DESKTOP:'KDE', DBUS_SESSION_BUS_ADDRESS:'bus'}},
    {platform:'linux',env:{XDG_SESSION_TYPE:'wayland', XDG_CURRENT_DESKTOP:'GNOME',DBUS_SESSION_BUS_ADDRESS:'bus'}},
    {platform:'darwin',env:{DBUS_SESSION_BUS_ADDRESS:'bus'}},
  ];
  for (const scenario of rejected) {
    let touched = false;
    const guard = await prepareNative(new AbortController().signal,{
      ...scenario,
      access:async () => {touched=true;},
      run:async () => {touched=true; return 'invalid';},
    });
    assert.equal(guard, undefined);
    assert.equal(touched, false, JSON.stringify(scenario.platform));
  }
});

test('malformed KWin owner, missing script methods and oversized XML fail safely without writing or loading', async () => {
  for (const [kind, faulty] of [
    ['owner',''],
    ['owner','org.kde.KWin'],
    ['owner',':1.42\n:1.43'],
    ['owner',':1.42 extra'],
    ['xml','<node><interface name="org.kde.kwin.Scripting"><method name="loadScript"/></interface></node>'],
    ['xml','<node><interface name="org.kde.kwin.Other"><method name="loadScript"/><method name="unloadScript"/></interface></node>'],
    ['xml',validScriptingXML.repeat(80)],
    ['xml','<!DOCTYPE node><node></node>'],
    ['xml',validScriptingXML.replace('<node>', '<!DOCTYPE node SYSTEM "http://example.org/malicious.dtd"><node>')],
    ['xml',realDoctypeXML.replace(standardDoctype, '<!DOCTYPE node [<!ENTITY x "evil">]>')],
    ['xml',realDoctypeXML.replace(standardDoctype, standardDoctype + standardDoctype)],
    ['xml',realDoctypeXML.replace(standardDoctype, standardDoctype.replace('freedesktop.org', 'evil.example'))],
    ['xml',multiline2657.replace(multilineDoctype, multilineDoctype.replace('PUBLIC', 'SYSTEM'))],
    ['xml',multiline2657.replace(multilineDoctype, multilineDoctype.replace('freedesktop//DTD', 'free\tdesktop//DTD'))],
    ['xml',multiline2657.replace(multilineDoctype, multilineDoctype.replace('introspect.dtd', 'introspect.dtd?x=1'))],
    ['xml',multiline2657.replace(multilineDoctype, multilineDoctype.replace('>', ' [<!ENTITY x "evil">]>'))],
    ['xml','<node><interface name="org.kde.kwin.Scripting"><method name="loadScript"><method name="unloadScript"/></interface></node>'],
  ] as const) {
    const calls: string[] = [];
    let wrote = false;
    const guard = await prepareNative(new AbortController().signal,{
      platform:'linux', env:{DBUS_SESSION_BUS_ADDRESS:'bus'},
      access:async () => {},
      mkdtemp:async () => {wrote = true; return '/mock/should-not-create';},
      run:async (_binary: string, args: string[]) => {
        calls.push(args[2]);
        if (kind === 'owner' && args[2] === 'org.freedesktop.DBus.GetNameOwner') return faulty;
        if (kind === 'xml' && args[2] === 'org.freedesktop.DBus.Introspectable.Introspect') return faulty;
        return qdbusOutput(args);
      },
    });
    assert.equal(guard, undefined, kind + String(faulty).slice(0,50));
    assert.equal(wrote, false);
    assert.equal(calls.includes('org.kde.kwin.Scripting.loadScript'), false);
  }
});

test('KWin owner change before or after Script.run returns unsupported and unloads safely', async () => {
  for (const failOwnerCheck of [4,5]) {
    let n = 0, loads = 0, runs = 0, unloads = 0;
    const guard = await prepareNative(new AbortController().signal,{
      platform:'linux',env:{DBUS_SESSION_BUS_ADDRESS:'bus'},
      access:async () => {},
      mkdtemp:async () => '/mock/owner-change',
      writeFile:async () => {},
      rm:async () => {},
      run:async (_binary: string, args: string[]) => {
        if (args[2] === 'org.freedesktop.DBus.GetNameOwner') return ++n >= failOwnerCheck ? ':1.43' : ':1.42';
        if (args[2] === 'org.kde.kwin.Scripting.loadScript') loads++;
        if (args[2] === 'org.kde.kwin.Script.run') runs++;
        if (args[2] === 'org.kde.kwin.Scripting.unloadScript') unloads++;
        return qdbusOutput(args);
      },
    });
    assert.equal(guard, undefined);
    assert.equal(loads, 1);
    assert.equal(runs, failOwnerCheck === 4 ? 0 : 1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(unloads, 1);
  }
});

test('late ignored-abort filesystem and DBus operations receive a second cleanup after the prep bound', {timeout:5000}, async () => {
  const deferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;});
    return {promise, resolve, reject};
  };
  const flush = async () => {await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));};
  const base: any = {
    platform:'linux', env:{DBUS_SESSION_BUS_ADDRESS:'mock-bus'}, access:async () => {},
    run:async (_binary: string, args: string[]) => qdbusOutput(args),
  };
  const lateDir = deferred<string>(), dirs: string[] = [];
  assert.equal(await prepareNative(new AbortController().signal, {
    ...base, mkdtemp:async () => lateDir.promise,
    rm:async (dir: string) => {dirs.push(dir);},
  }), undefined);
  assert.deepEqual(dirs, []);
  lateDir.resolve('/mock/late-dir'); await flush();
  assert.deepEqual(dirs, ['/mock/late-dir'], 'late mkdtemp must not leave an orphan');

  const lateWrite = deferred<void>(), writesRemoved: string[] = [];
  assert.equal(await prepareNative(new AbortController().signal, {
    ...base, mkdtemp:async () => '/mock/late-write', writeFile:async () => lateWrite.promise,
    rm:async (dir: string) => {writesRemoved.push(dir);},
  }), undefined);
  assert.deepEqual(writesRemoved, ['/mock/late-write']);
  lateWrite.reject(Error('late partial write')); await flush();
  assert.deepEqual(writesRemoved, ['/mock/late-write','/mock/late-write'], 'late failed write must attempt cleanup again');

  const lateLoad = deferred<string>(); let unloads = 0;
  assert.equal(await prepareNative(new AbortController().signal, {
    ...base, mkdtemp:async () => '/mock/late-load', writeFile:async () => {}, rm:async () => {},
    run:async (_binary: string, args: string[]) => {
      if (args[2] === 'org.kde.kwin.Scripting.loadScript') return lateLoad.promise;
      if (args[2] === 'org.kde.kwin.Scripting.unloadScript') unloads++;
      return qdbusOutput(args);
    },
  }), undefined);
  await flush(); assert.equal(unloads, 1);
  lateLoad.resolve('17'); await flush();
  assert.equal(unloads, 2, 'late load must try unloading again after script materializes');
});

test('KWin probe abort and hanging DBus reply never exceed bounded preparation and disclose no environment values', {timeout:2500}, async () => {
  const controller = new AbortController();
  let executed = 0;
  const deps: any = {
    platform:'linux',env:{DBUS_SESSION_BUS_ADDRESS:'NO_LOGGING_SECRET'},
    access:async () => {},
    run:async () => {executed++; return new Promise<string>(() => {});},
  };
  const start = Date.now();
  assert.equal(await prepareNative(controller.signal, deps), undefined);
  assert(Date.now() - start < 1300, 'internal DBus timeout must be below host total bound');
  assert.equal(executed, 1);
  const second = new AbortController();
  const pending = prepareNative(second.signal, deps);
  second.abort();
  assert.equal(await pending, undefined);
  const already = new AbortController(); already.abort();
  assert.equal(await prepareNative(already.signal, deps), undefined);
});

test('KWin preparation exposes allowlisted, sanitized native outcomes without native access', {timeout: 4000}, async () => {
  const seen: string[] = [];
  const onOutcome = (reason: string) => { seen.push(reason); };
  const base = {
    platform: 'linux', env: {DBUS_SESSION_BUS_ADDRESS: 'PRIVATE_BUS_VALUE'},
    access: async () => {}, mkdtemp: async () => '/fake/focus',
    writeFile: async () => {}, rm: async () => {},
    run: async (_binary: string, args: string[]) => qdbusOutput(args),
    onOutcome,
  };
  assert.equal(await prepareNative(new AbortController().signal, {
    ...base, env: {DBUS_SESSION_BUS_ADDRESS: 'PRIVATE_BUS_VALUE', XDG_CURRENT_DESKTOP: 'GNOME'},
  }), undefined);
  assert.equal(seen.at(-1), 'unsupported_desktop');

  assert.equal(await prepareNative(new AbortController().signal, {
    ...base, env: {},
  }), undefined);
  assert.equal(seen.at(-1), 'unsupported_bus');

  assert.equal(await prepareNative(new AbortController().signal, {
    ...base, run: async (_binary: string, args: string[]) =>
      args[2] === 'org.freedesktop.DBus.GetNameOwner' ? '' : qdbusOutput(args),
  }), undefined);
  assert.equal(seen.at(-1), 'unsupported_bus');

  assert.equal(await prepareNative(new AbortController().signal, {
    ...base, run: async (_binary: string, args: string[]) =>
      args[2] === 'org.freedesktop.DBus.Introspectable.Introspect' ?
        '<node><interface name="org.kde.kwin.Scripting"><method name="loadScript"/></interface></node>' : qdbusOutput(args),
  }), undefined);
  assert.equal(seen.at(-1), 'unsupported_bus');

  const successful = await prepareNative(new AbortController().signal, base);
  assert(successful);
  assert.equal(seen.at(-1), 'prepared');
  await successful.close();

  assert.equal(await prepareNative(new AbortController().signal, {
    ...base, writeFile: async () => {throw Error('PRIVATE_FAILURE_VALUE');},
  }), undefined);
  assert.equal(seen.at(-1), 'prepare_failed');

  assert.equal(await prepareNative(new AbortController().signal, {
    ...base, run: async () => new Promise<string>(() => {}),
  }), undefined);
  assert.equal(seen.at(-1), 'timeout');

  const aborted = new AbortController(); aborted.abort();
  assert.equal(await prepareNative(aborted.signal, base), undefined);
  assert.equal(seen.at(-1), 'cancelled');
  assert.equal(seen.length, 8, 'exactly one fixed outcome per attempt');
  assert(!JSON.stringify(seen).includes('PRIVATE_'));
});

test('partial desktop metadata permits only a verified KWin scripting protocol', async () => {
  for (const env of [
    {DBUS_SESSION_BUS_ADDRESS:'bus', XDG_SESSION_TYPE:'wayland'},
    {DBUS_SESSION_BUS_ADDRESS:'bus', XDG_CURRENT_DESKTOP:'KDE'},
    {DBUS_SESSION_BUS_ADDRESS:'bus', XDG_SESSION_TYPE:'', XDG_CURRENT_DESKTOP:'KDE'},
    {DBUS_SESSION_BUS_ADDRESS:'bus', XDG_SESSION_TYPE:'wayland', XDG_CURRENT_DESKTOP:'Other:KDE'},
  ]) {
    let verified = false;
    const outcome: string[] = [];
    const guard = await prepareNative(new AbortController().signal, {
      platform:'linux',env, access:async () => {}, mkdtemp:async () => '/mock/partial',
      writeFile:async () => {}, rm:async () => {},
      onOutcome: reason => outcome.push(reason),
      run: async (_binary, args) => {
        if (args[2] === 'org.freedesktop.DBus.Introspectable.Introspect') verified = true;
        return qdbusOutput(args);
      },
    });
    assert(verified, 'partial metadata must not suppress bounded protocol detection');
    assert(guard);
    assert.deepEqual(outcome,['prepared']);
    await guard.close();
  }
});

test('KWin activation aliases are safe only for the exactly marked new window', () => {
  for (const alias of ['windowActivated', 'activeWindowChanged', 'clientActivated', 'activeClientChanged']) {
    const f = compositor([], alias), unmarked = {...f.browser(), caption:'My Brave window'};
    f.add(unmarked); f.activateNoSignalArgument(unmarked);
    assert.deepEqual(f.restored, [], alias + ' must not restore a user window');
    const owned = compositor([], alias), fresh = owned.browser();
    owned.add(fresh); owned.activateNoSignalArgument(fresh);
    assert.deepEqual(owned.restored, [owned.previous], alias);
  }
  const unsupported = compositor([], ''), fresh = unsupported.browser();
  unsupported.add(fresh); unsupported.activate(fresh);
  assert.deepEqual(unsupported.restored, []);
});
