"""Synthetic-only regression tests: never contact the real KWin session."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import types
import weakref
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("wake_desktop_test_only", ROOT / "desktop.py")
desktop = importlib.util.module_from_spec(spec)
spec.loader.exec_module(desktop)


def packet(event="ready", **changes):
    caps = {name: True for name in desktop._FEATURES}
    item = {
        "kind": "desktop", "event": event, "window": "w1",
        "browser": True, "wake_marker": False,
        "active": True, "minimized": False,
        "on_current_desktop": True, "above_previous": None,
        "baseline": True, "native_ms": 100,
    }
    if event == "ready":
        item["capabilities"] = caps
    if event in ("ready", "heartbeat", "capacity_changed"):
        item["capacity"] = {"limit": 256, "tracked": 2,
                            "overflow": 0, "unknown": 0}
    if event in ("heartbeat", "desktop_changed", "activity_changed"):
        item.update(window=None, browser=False, active=None, minimized=None,
                    on_current_desktop=None, baseline=False)
    item.update(changes)
    return json.dumps(item)


class FakeBus:
    def __init__(self):
        self.owner = ":1.55"
        self.closed = False
        self.released_names = []

    def release_name(self, name):
        if self.closed:
            raise AssertionError("BusName deallocated after bus.close")
        self.released_names.append(name)

    def get_name_owner(self, _service):
        return self.owner

    def close(self):
        self.closed = True


class FakeContext:
    def __init__(self):
        self.queue = []

    def pending(self):
        return bool(self.queue)

    def iteration(self, _blocking):
        call = self.queue.pop(0)
        call()


class FakeReceiver:
    def __init__(self, name, path, observer):
        self.name = name
        self.path = path
        self.observer = observer
        self.removed = False

    def remove_from_connection(self):
        self.removed = True


class Harness:
    def __init__(self, ready=None, load="17", unload="", on_run=True):
        self.bus = FakeBus()
        self.context = FakeContext()
        self.calls = []
        self.readys = [ready or packet()]
        self.load = load
        self.unload = unload
        self.on_run = on_run
        self.name_ref = None
        self.receiver = None
        self.temp = None
        self.script = None

        harness = self

        class BusName:
            def __init__(self, service, bus, **options):
                assert options["do_not_queue"] is True
                assert options["replace_existing"] is False
                assert options["allow_replacement"] is False
                harness.name_ref = weakref.ref(self)
                self._name = service
                self._bus = bus

            def get_name(self):
                return self._name

            def __del__(self):
                self._bus.release_name(self._name)

        class SessionBus:
            def __new__(cls, **kw):
                assert kw["private"] is True
                return harness.bus

        self.dbus = types.SimpleNamespace(
            SessionBus=SessionBus, service=types.SimpleNamespace(BusName=BusName))
        self.glib = types.SimpleNamespace(
            MainContext=types.SimpleNamespace(default=lambda: harness.context))
        self.patches = [
            mock.patch.object(desktop, "_prerequisites",
                              return_value=(desktop._capability("ready", "none"),
                                            (self.dbus, lambda **kw: None, self.glib))),
            mock.patch.object(desktop, "_bus_probe",
                              return_value=(desktop._capability("ready", "none"), ":1.55")),
            mock.patch.object(desktop, "_receiver_class",
                              side_effect=lambda dbus: self.receiver_type()),
            mock.patch.object(desktop, "_command", side_effect=self.command),
        ]

    def receiver_type(self):
        harness = self

        class Receiver(FakeReceiver):
            def __init__(self, name, path, observer):
                super().__init__(name, path, observer)
                harness.receiver = self

        return Receiver

    def command(self, *args):
        self.calls.append(args)
        if args[1] == "org.kde.kwin.Scripting.loadScript":
            self.script = Path(args[2])
            self.temp = self.script.parent
            assert self.temp.stat().st_mode & 0o777 == 0o700
            assert self.script.stat().st_mode & 0o777 == 0o600
            generated = self.script.read_text()
            assert "__SERVICE__" not in generated
            assert "__TTL_MS__" not in generated
            assert "Crossfeed Wake" in generated
            return self.load
        if args[1].endswith(".run"):
            if self.on_run:
                for ready in self.readys:
                    payload, sender = ready if isinstance(ready, tuple) else (ready, ":1.55")
                    self.context.queue.append(
                        lambda p=payload, s=sender: self.receiver.observer._receive(p, s))
            return ""
        if args[1].endswith("unloadScript"):
            return self.unload
        raise AssertionError(args)

    def __enter__(self):
        for patch in self.patches:
            patch.start()
        return self

    def __exit__(self, *_args):
        for patch in reversed(self.patches):
            patch.stop()


class AdapterTests(unittest.TestCase):
    def test_allowlisted_schema_redacts_and_rejects_injection(self):
        good = desktop._decode(packet())
        self.assertEqual(good["window"], "w1")
        self.assertIsNone(desktop._decode(packet(caption="secret title")))
        self.assertIsNone(desktop._decode(packet(app_id="org.brave.Browser")))
        self.assertIsNone(desktop._decode(packet(window="real-id-42")))
        self.assertIsNone(desktop._decode(packet(window="w999")))
        self.assertIsNone(desktop._decode(packet(browser="yes")))
        self.assertIsNone(desktop._decode(packet(baseline=True, wake_marker=True)))
        self.assertIsNone(desktop._decode("{" + "x" * 5000))
        self.assertIsNone(desktop._decode(packet(native_ms=float("inf"))))
        self.assertIsNone(desktop._decode(packet(capabilities={"added": True})))
        self.assertIsNone(desktop._decode(packet(capacity={"limit": 257})))
        self.assertIsNone(desktop._decode(packet(capacity={"limit": 256,
            "tracked": 257, "overflow": 1, "unknown": 1})))
        self.assertIsNone(desktop._decode(packet(capacity={"limit": 256,
            "tracked": 1, "overflow": 0, "unknown": 1})))
        self.assertIsNotNone(desktop._decode(packet("capacity_changed",
            window=None, capacity={"limit": 256, "tracked": 256,
                                   "overflow": 1, "unknown": 0})))
        self.assertIsNone(desktop._decode(packet("window_changed", capabilities={})))
        self.assertIsNotNone(desktop._decode(packet("heartbeat")))

    def test_busname_real_lifetime_api_without_session_connection(self):
        # Exercise the installed dbus.service.BusName destructor semantics
        # with a synthetic bus; never connect to a running desktop session.
        probe = subprocess.run(["/usr/bin/python3", "-B", "-c", "import dbus.service"],
                               capture_output=True, text=True, timeout=5)
        if probe.returncode:
            self.skipTest("dbus.service is not importable by /usr/bin/python3")
        code = """import dbus.service, gc
class Bus:
    def __init__(self): self.releases = []
    def release_name(self, name): self.releases.append(name)
bus = Bus()
name = object.__new__(dbus.service.BusName)
name._bus = bus
name._name = 'org.example.BoundedTest'
assert not hasattr(name, 'release')
del name
gc.collect()
assert bus.releases == ['org.example.BoundedTest']
"""
        result = subprocess.run(["/usr/bin/python3", "-B", "-c", code],
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_lazy_offline_import_and_doctor_readonly(self):
        code = (ROOT / "desktop.py").read_text()
        self.assertNotIn("import dbus\n", code)
        self.assertNotIn("from gi", code)
        with mock.patch.object(desktop, "_prerequisites", return_value=(
            desktop._capability("ready", "none"), ("dbus", "mainloop", "glib"))), \
             mock.patch.object(desktop, "_bus_probe", return_value=(
                 desktop._capability("ready", "none"), ":1.9")), \
             mock.patch.object(desktop, "_command", side_effect=AssertionError("script run")):
            self.assertEqual(desktop.doctor()["status"], "ready")
        with mock.patch.object(desktop, "_prerequisites", return_value=(
            desktop._capability("unsupported", "not_kde"), None)):
            self.assertEqual(desktop.doctor()["reason"], "not_kde")

    def test_ready_requires_authenticated_sender_and_unloads(self):
        events = []
        with Harness() as h:
            observer = desktop.DesktopObserver(15, events.append)
            h.readys.insert(0, (packet(window="w2", browser=False), ":1.99"))
            # Forged early ready must be ignored; only unique KWin owner wins.
            capability = observer.start()
            self.assertEqual(capability["status"], "ready")
            self.assertEqual(len(events), 1)
            observer._receive(packet("window_added", window="w2", baseline=False,
                                     wake_marker=True), ":1.99")
            self.assertEqual(len(events), 1)
            observer._receive(packet("window_added", window="w2", baseline=False,
                                     wake_marker=True), ":1.55")
            self.assertEqual([e["event"] for e in events], ["ready", "window_added"])
            self.assertFalse(any("caption" in e for e in events))
            h.bus.owner = ":1.91"
            observer._receive(packet("window_changed", window="w2", baseline=False),
                              ":1.55")
            self.assertEqual(observer.capability["reason"], "owner_changed")
            result = observer.close()
            self.assertEqual(result["status"], "ok")
            self.assertTrue(h.bus.closed)
            self.assertEqual(len(h.bus.released_names), 1)
            self.assertIsNone(h.name_ref())
            self.assertTrue(h.receiver.removed)
            self.assertFalse(h.temp.exists())
            self.assertEqual(observer.close(), result)
            self.assertEqual(len([x for x in h.calls
                                  if x[1].endswith("unloadScript")]), 1)
            self.assertEqual(h.calls[1][0], "/Scripting/Script17")
            self.assertEqual(h.calls[1][1], "org.kde.kwin.Script.run")

    def test_zero_kwin_script_id_is_valid(self):
        with Harness(load="0") as h:
            observer = desktop.DesktopObserver(2, lambda _e: None)
            self.assertEqual(observer.start()["status"], "ready")
            self.assertEqual(h.calls[1][0], "/Scripting/Script0")
            self.assertEqual(observer.close()["unload"], "command_succeeded")
            self.assertEqual(h.bus.released_names.__len__(), 1)

    def test_load_failure_unloads_even_when_id_invalid(self):
        with Harness(load="unparseable") as h:
            observer = desktop.DesktopObserver(4, lambda e: None)
            result = observer.start()
            self.assertEqual(result["reason"], "load_failed")
            self.assertTrue(h.receiver.removed)
            self.assertEqual(len(h.bus.released_names), 1)
            self.assertFalse(h.temp.exists())
            self.assertEqual(len([x for x in h.calls
                                  if x[1].endswith("unloadScript")]), 1)

    def test_missing_signals_or_ttl_is_unsupported_not_false_ready(self):
        for feature, reason in (("activation", "missing_signals"),
                                ("added", "missing_signals"),
                                ("removed", "missing_signals"),
                                ("transport", "missing_signals"),
                                ("heartbeat", "ttl_unavailable"),
                                ("caption", "missing_signals"),
                                ("minimized", "missing_signals"),
                                ("ttl", "ttl_unavailable"),
                                ("baseline", "missing_signals")):
            bad = json.loads(packet())
            bad["capabilities"][feature] = False
            with self.subTest(feature=feature), Harness(ready=json.dumps(bad)) as h:
                events = []
                observer = desktop.DesktopObserver(4, events.append)
                self.assertEqual(observer.start()["reason"], reason)
                self.assertEqual(events, [])  # unsupported ready never escapes
                self.assertTrue(observer.capability["closed"])
                self.assertFalse(h.temp.exists())

    def test_delivery_timeout_and_cleanup_error(self):
        with Harness(on_run=False, unload=None) as h:
            observer = desktop.DesktopObserver(4, lambda _e: None)
            with mock.patch.object(desktop.time, "sleep", return_value=None):
                result = observer.start()
            self.assertEqual(result["reason"], "cleanup_failed")
            self.assertEqual(observer.close()["status"], "error")
            self.assertFalse(h.temp.exists())

    def test_heartbeat_expiry_duration_and_idempotent_close(self):
        with Harness() as h:
            observer = desktop.DesktopObserver(4, lambda _e: None)
            self.assertEqual(observer.start()["status"], "ready")
            observer._last_heartbeat -= 4.0
            observer.poll()
            self.assertEqual(observer.capability["reason"], "heartbeat_expired")
            self.assertTrue(observer.capability["closed"])
            self.assertEqual(observer.poll()["reason"], "heartbeat_expired")
            self.assertEqual(observer.close()["status"], "ok")
            self.assertEqual(len([x for x in h.calls
                                  if x[1].endswith("unloadScript")]), 1)

    def test_owner_loss_without_new_dbus_callbacks(self):
        with Harness() as h:
            observer = desktop.DesktopObserver(4, lambda _e: None)
            self.assertEqual(observer.start()["status"], "ready")
            h.bus.owner = ":1.42"
            health = observer.poll()
            self.assertEqual(health["status"], "unsupported")
            self.assertEqual(health["reason"], "owner_changed")
            self.assertTrue(health["closed"])
            self.assertTrue(health["capabilities"]["activation"])
            self.assertEqual(observer.close()["status"], "ok")

    def test_deadline_clean_close_and_initial_exhaustion_are_not_ready(self):
        with Harness() as h:
            observer = desktop.DesktopObserver(2, lambda _event: None)
            self.assertEqual(observer.start()["status"], "ready")
            prior = dict(observer.capability["capabilities"])
            observer._deadline = time.monotonic() - 1
            result = observer.poll()
            self.assertEqual(result["status"], "unsupported")
            self.assertEqual(result["reason"], "closed")
            self.assertTrue(result["closed"])
            self.assertEqual(result["capabilities"], prior)
            self.assertEqual(result["capacity"]["limit"], 256)
            self.assertEqual(observer.close()["status"], "ok")
            self.assertEqual(observer.poll(), result)
        exhausted = json.loads(packet())
        exhausted["capacity"]["tracked"] = 256
        with Harness(ready=json.dumps(exhausted)) as h:
            observer = desktop.DesktopObserver(2, lambda _event: None)
            result = observer.start()
            self.assertEqual(result["status"], "unsupported")
            self.assertEqual(result["reason"], "capacity_exhausted")
            self.assertTrue(result["closed"])
            self.assertEqual(result["capacity"]["tracked"], 256)
            self.assertEqual(observer.close()["status"], "ok")

    def test_capacity_health_updates_on_heartbeat_and_overflow(self):
        with Harness() as h:
            events = []
            observer = desktop.DesktopObserver(4, events.append)
            self.assertEqual(observer.start()["capacity"]["limit"], 256)
            counters = {"limit": 256, "tracked": 256, "overflow": 5, "unknown": 2}
            observer._receive(packet("capacity_changed", window=None,
                                     capacity=counters), h.bus.owner)
            self.assertEqual(observer.capability["capacity"], counters)
            self.assertEqual(events[-1]["event"], "capacity_changed")
            observer._receive(packet("heartbeat", capacity=counters), h.bus.owner)
            self.assertEqual(observer.poll()["capacity"], counters)
            self.assertEqual(observer.close()["status"], "ok")

    def test_command_fixed_binary_bounded_and_shell_free(self):
        result = types.SimpleNamespace(returncode=0, stdout=b"21\n")
        with mock.patch.object(desktop.subprocess, "run", return_value=result) as runner:
            self.assertEqual(desktop._command("/Scripting",
                "org.kde.kwin.Scripting.loadScript", "/private/observer.js", "plugin"), "21")
            args, options = runner.call_args
            self.assertEqual(args[0][0], "/usr/bin/qdbus6")
            self.assertEqual(args[0][1], "org.kde.KWin")
            self.assertIs(options["shell"], False)
            self.assertEqual(options["timeout"], 2.0)
        with mock.patch.object(desktop.subprocess, "run",
                               side_effect=subprocess.TimeoutExpired("qdbus6", 2)):
            self.assertIsNone(desktop._command("/Scripting", "method"))

    def test_false_unload_reports_cleanup_failure(self):
        with Harness(unload="false") as h:
            observer = desktop.DesktopObserver(4, lambda _e: None)
            self.assertEqual(observer.start()["status"], "ready")
            self.assertEqual(observer.close()["reason"], "cleanup_failed")
            self.assertFalse(h.temp.exists())

    def test_invalid_duration_never_loads(self):
        for invalid in (0, 3601, True, float("nan"), "60"):
            with self.subTest(invalid=invalid):
                observer = desktop.DesktopObserver(invalid, lambda e: None)
                self.assertEqual(observer.start()["reason"], "invalid_duration")
                self.assertEqual(observer.close()["status"], "ok")


# Node VM fixture simulates KWin Qt signals. It DOES NOT connect to KDE.
JS_FIXTURE = r"""
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const script = fs.readFileSync(process.argv[1], 'utf8')
  .replace('__SERVICE__', JSON.stringify('org.example.Test'))
  .replace('__OBJECT__', JSON.stringify('/org/example/Test'))
  .replace('__INTERFACE__', JSON.stringify('org.example.Observer'))
  .replace('__TTL_MS__', '1500');
class Signal {
  constructor() { this.handlers = []; }
  connect(fn) { this.handlers.push(fn); }
  emit(...args) { for (const fn of this.handlers) fn(...args); }
}
function windowObject(clazz, caption, active) {
  const out = {
    resourceClass: clazz, caption, active, minimized:false,
    onAllDesktops: false, desktops: ['desktop-object'],
    captionChanged: new Signal(), minimizedChanged:new Signal(),
    desktopsChanged:new Signal(), activitiesChanged:new Signal()
  };
  return new Proxy(out, {
    set(obj, field, val) {
      if (['active','minimized','caption','desktops','resourceClass'].includes(field) &&
          !allowFixtureMutation) throw Error('script wrote to window');
      obj[field]=val; return true;
    }
  });
}
let allowFixtureMutation = true;
let now = 0;
const existing = windowObject('brave-browser', 'Crossfeed Wake ' + 'a'.repeat(32), true);
const stack = [existing];
const ws = {
  windowAdded:new Signal(), windowRemoved:new Signal(),
  windowActivated:new Signal(), stackingOrderChanged:new Signal(),
  currentDesktopChanged:new Signal(), currentActivityChanged:new Signal(),
  activeWindow:existing, currentDesktop:'desktop-object',
  stackingOrder:stack, windowList:() => stack.slice()
};
const workspace = new Proxy(ws, {
  set(obj, field, value) {
    if (!allowFixtureMutation) throw Error('script wrote to workspace ' + field);
    obj[field]=value;return true;
  }
});
const timers=[];
class QTimer {
  constructor(){ this.timeout = new Signal(); this.running=false; }
  start(){this.running=true;timers.push(this);}
  stop(){this.running=false;}
}
const events=[];
const callDBus = (svc,path,iface,method,json) => {
  assert.strictEqual(method, 'Push');
  assert.strictEqual(svc,'org.example.Test');
  events.push(JSON.parse(json));
};
allowFixtureMutation=false;
vm.runInNewContext(script, {workspace, callDBus, QTimer,
                           Date:{now:() => now}, JSON, RegExp}, {timeout:2000});
assert.strictEqual(events[0].event, 'ready');
assert.strictEqual(events[0].window,'w1');
assert.strictEqual(events[0].baseline,true);
assert.strictEqual(events[0].wake_marker,false); // prior matching title excluded
assert.strictEqual(events[0].capabilities.activation,true);
assert.strictEqual(events[0].capabilities.caption,true);
assert.strictEqual(events[0].capabilities.minimized,true);
assert.strictEqual(events[0].capabilities.stacking,true);
assert.strictEqual(events[0].capabilities.stacking_sampled,true);
assert.strictEqual(events[0].capacity.limit,256);
assert.strictEqual(events.some(e=> e.event==='window_added' && e.window==='w1'), false);
const added = windowObject('brave-browser', '', true);
ws.windowAdded.emit(added);
let hit = events[events.length-1];
assert.strictEqual(hit.event,'window_added');
assert.strictEqual(hit.window,'w2');
assert.strictEqual(hit.active,true); // captured BEFORE caption hydration
assert.strictEqual(hit.wake_marker,false);
assert.strictEqual(hit.browser,true);
assert.strictEqual(hit.above_previous,null); // no stack evidence yet
allowFixtureMutation=true;
added.caption='Crossfeed Wake ' + 'b'.repeat(32);
allowFixtureMutation=false;
added.captionChanged.emit();
hit=events[events.length-1];
assert.strictEqual(hit.event,'window_changed');
assert.strictEqual(hit.window,'w2');
assert.strictEqual(hit.wake_marker,true);
stack.push(added);
ws.stackingOrderChanged.emit();
hit=events[events.length-1];
assert.strictEqual(hit.above_previous,true);
ws.windowActivated.emit(added);
hit=events[events.length-1];
assert.strictEqual(hit.event,'window_activated');
const suffixed = windowObject('brave-browser',
    'Crossfeed Wake ' + 'c'.repeat(32) + ' - Brave', false);
ws.windowAdded.emit(suffixed);
hit=events[events.length-1];
assert.strictEqual(hit.wake_marker,true);
const chromeSuffix = windowObject('google-chrome',
    'Crossfeed Wake ' + 'e'.repeat(32) + ' \u2014 Google Chrome', false);
ws.windowAdded.emit(chromeSuffix);
hit=events[events.length-1];
assert.strictEqual(hit.wake_marker,true);
const fakeSuffix = windowObject('brave-browser',
    'Crossfeed Wake ' + 'd'.repeat(32) + ' - Unrelated', false);
ws.windowAdded.emit(fakeSuffix);
hit=events[events.length-1];
assert.strictEqual(hit.wake_marker,false);
const same = windowObject('brave-browser','ordinary chat',false);
ws.windowAdded.emit(same);
hit=events[events.length-1];
assert.strictEqual(hit.browser,true);
assert.strictEqual(hit.wake_marker,false); // browser class alone is ambiguous
ws.currentDesktopChanged.emit();
assert(events.some(e=>e.event==='desktop_changed'));
assert(events.some(e=>e.event==='window_changed' && e.window==='w2'
    && e.above_previous===true)); // sampled without depending on stacking signal
ws.currentActivityChanged.emit();
assert(events.some(e=>e.event==='activity_changed'));
assert(!JSON.stringify(events).includes('ordinary chat'));
assert(!JSON.stringify(events).includes('brave-browser'));
assert(!JSON.stringify(events).includes('desktop-object'));
assert(!JSON.stringify(events).includes('Crossfeed Wake'));
const early = windowObject('brave-browser','',false);
ws.windowActivated.emit(early);
ws.windowAdded.emit(early);
hit=events[events.length-1];
assert.strictEqual(hit.event,'window_added');
assert.strictEqual(hit.baseline,false);
// Fill the 256-slot observer, then force overflow and unknown-ID reports.
for (let i = 0; i < 260; i++)
    ws.windowAdded.emit(windowObject('brave-browser','unmarked',true));
const untracked = windowObject('brave-browser','opaque',true);
ws.windowActivated.emit(untracked);
const capEvents = events.filter(e=>e.event==='capacity_changed');
assert(capEvents.some(e=>e.capacity.tracked===256 && e.capacity.overflow>0));
assert(capEvents.some(e=>e.capacity.unknown>0));
assert(events.every(e=>e.window===null || /^w(?:[1-9][0-9]{0,2})$/.test(e.window)));
assert.strictEqual(timers.length,3);
now=1501;
for (const t of timers) if(t.running) t.timeout.emit();
const count=events.length;
ws.windowAdded.emit(windowObject('brave-browser','late',true));
assert.strictEqual(events.length,count); // script-enforced TTL
console.log('KWin VM fixture: ready, baseline, hydration, signals, redaction, TTL, no mutation OK');
"""


class KWinVMTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "Node unavailable")
    def test_fake_kwin_vm(self):
        result = subprocess.run(
            [shutil.which("node"), "-e", JS_FIXTURE, str(ROOT / "kwin_observer.js")],
            capture_output=True, text=True, timeout=5, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("KWin VM fixture:", result.stdout)

    @unittest.skipUnless(shutil.which("node"), "Node unavailable")
    def test_missing_qtimer_is_explicitly_unsupported(self):
        # Run only the setup portion of the VM fixture, without any timers.
        prefix = JS_FIXTURE.split("assert.strictEqual(events[0].event, 'ready');")[0]
        prefix = prefix.replace(
            "vm.runInNewContext(script, {workspace, callDBus, QTimer,",
            "vm.runInNewContext(script, {workspace, callDBus, QTimer:undefined,")
        fixture = prefix + """
assert.strictEqual(events.length, 1);
assert.strictEqual(events[0].capabilities.ttl, false);
assert.strictEqual(events[0].capabilities.heartbeat, false);
"""
        result = subprocess.run(
            [shutil.which("node"), "-e", fixture, str(ROOT / "kwin_observer.js")],
            capture_output=True, text=True, timeout=5, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)

    @unittest.skipUnless(shutil.which("node"), "Node unavailable")
    def test_missing_signal_detection_in_vm(self):
        fixture = JS_FIXTURE.replace(
            "windowActivated:new Signal(), stackingOrderChanged:new Signal(),",
            "windowActivated:null, activeWindowChanged:null, stackingOrderChanged:null,")
        fixture = fixture.replace(
            "assert.strictEqual(events[0].capabilities.activation,true);",
            "assert.strictEqual(events[0].capabilities.activation,false);")
        fixture = fixture.replace(
            "assert.strictEqual(events[0].capabilities.stacking,true);",
            "assert.strictEqual(events[0].capabilities.stacking,false);\n"
            "assert.strictEqual(events[0].capabilities.stacking_sampled,true);")
        fixture = fixture.replace("ws.windowActivated.emit(added);",
                                  "// no activation signal present")
        fixture = fixture.replace("ws.windowActivated.emit(early);",
                                  "// no activation signal present")
        fixture = fixture.replace("ws.windowActivated.emit(untracked);",
                                  "// no activation signal present")
        fixture = fixture.replace(
            "assert(capEvents.some(e=>e.capacity.unknown>0));",
            "// no unknown-ID activation with a missing signal")
        fixture = fixture.replace(
            "assert.strictEqual(hit.event,'window_activated');",
            "assert.strictEqual(hit.event,'window_changed');")
        fixture = fixture.replace("ws.stackingOrderChanged.emit();",
                                  "// no stacking signal")
        fixture = fixture.replace(
            "assert.strictEqual(hit.above_previous,true);",
            "assert.strictEqual(hit.above_previous,null);")
        result = subprocess.run(
            [shutil.which("node"), "-e", fixture, str(ROOT / "kwin_observer.js")],
            capture_output=True, text=True, timeout=5, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
