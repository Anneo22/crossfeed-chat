"""Pure offline unit + actual generated KWin JS VM tests. No DBus activation."""
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from unittest import mock

from tools.wake_checker.experiments import native_pid as probe

SCRIPT = Path(probe.__file__).with_suffix(".js")
JS_VM = r"""
'use strict';
const fs=require('node:fs'), vm=require('node:vm'), assert=require('node:assert/strict');
const template=fs.readFileSync(process.argv[1], 'utf8');
let script=template;
const values={
  '__SERVICE__':JSON.stringify('org.test.Private'),
  '__OBJECT__':JSON.stringify('/org/test/Private'),
  '__INTERFACE__':JSON.stringify('org.test.Observer'),
  '__TTL_MS__':'1000',
  '__OWNERS__':JSON.stringify({'100':true,'400':true})
};
for(const [k,v] of Object.entries(values)){
  assert.equal(script.split(k).length,2, k);
  script=script.replace(k,v);
}
let captionReads=0;
class Sig {
  constructor(){this.subscribers=[];}
  connect(fn){this.subscribers.push(fn);}
  disconnect(fn){this.subscribers=this.subscribers.filter(x=>x!==fn);}
  emit(...args){for(const fn of [...this.subscribers])fn(...args);}
}
function w(pid,normalWindow=true,tooltip=false,dialog=false,klass='brave-browser'){
  const r={pid,normalWindow,tooltip,dialog,resourceClass:klass,active:false,
    keepAbove:true,demandsAttention:false,propertyChanged:new Sig(),
    pidChanged:new Sig(),activeChanged:new Sig(),
    demandsAttentionChanged:new Sig(),keepAboveChanged:new Sig()};
  Object.defineProperty(r,'caption',{get(){captionReads++;return 'private title';}});
  return r;
}
const owner=w(100), foreign=w(201), missing=w(undefined),
  zero=w(0), invalid=w(-1), text=w('100'), fraction=w(2.5),
  tip=w(400,false,true,false);
const baseline=[owner,foreign,missing,zero,invalid,text,fraction,tip];
const workspace={windowList:()=>baseline.slice(),windowAdded:new Sig(),
  windowRemoved:new Sig()};
const timers=[];
class QTimer {
  constructor(){this.timeout=new Sig();this.running=false;timers.push(this);}
  start(){this.running=true;}stop(){this.running=false;}
}
const packets=[];
function callDBus(s,p,i,method,data){
  assert.equal(s,'org.test.Private');assert.equal(method,'Push');
  assert(data.length<1400);
  packets.push(JSON.parse(data));
}
vm.runInNewContext(script,{workspace,QTimer,callDBus,Date,JSON,
  Math,RegExp,String,isFinite},{timeout:3000});
assert.equal(packets[0].event,'ready');
assert.equal(packets[0].calibrated,true);
assert.equal(packets[0].baseline_positive_count,3); // owner,foreign,tip
assert.equal(packets[0].baseline_truncated,false);
assert.deepEqual(JSON.parse(JSON.stringify(packets[0].timer)),
                 {added:true,removed:true,baseline:true,ttl:true});
const snaps=packets.filter(x=>x.event==='baseline');
assert.equal(snaps.length,8);
assert.equal(snaps[0].has_pid,true);
assert.equal(snaps[0].owner_match,true);
assert.equal(snaps[1].owner_match,false);
for (const index of [2,3,4,5,6]) {
  assert.equal(snaps[index].has_pid,false);
  assert.equal(snaps[index].owner_match,null);
}
assert.equal(snaps[7].normal_window,false);
assert.equal(snaps[7].tooltip,true);
assert.equal(snaps[7].dialog,false);
const newcomer=w(400,false,false,true,'google-chrome');
workspace.windowAdded.emit(newcomer);
const added=packets.at(-1);
assert.equal(added.event,'added');
assert.equal(added.baseline,false);
assert.equal(added.browser,true);
assert.equal(added.owner_match,true);
assert.equal(added.normal_window,false);
assert.equal(added.dialog,true);
newcomer.active=true;newcomer.activeChanged.emit();
assert.equal(packets.at(-1).event,'changed');
assert.equal(packets.at(-1).active,true);
workspace.windowRemoved.emit(newcomer);
assert.equal(packets.at(-1).event,'closed');
assert.equal(packets.at(-1).window,added.window);
assert.equal(packets.at(-1).closed,true);
assert.equal(captionReads,0);
assert(!JSON.stringify(packets).includes('private title'));
assert(!JSON.stringify(packets).includes('google-chrome'));
assert(!JSON.stringify(packets).includes('brave-browser'));
for(let k=0;k<1100;k++)owner.propertyChanged.emit();
assert(packets.length<=1024);
assert.equal(timers.length,1);
assert(timers[0].running);
timers[0].timeout.emit();
assert.equal(packets.at(-1).event,'done');
assert(packets.at(-1).events_dropped>0);
assert(!timers[0].running);
const length=packets.length;
workspace.windowAdded.emit(w(100));owner.propertyChanged.emit();
assert.equal(packets.length,length);
assert.equal(workspace.windowAdded.subscribers.length,0);
console.log('offline KWin PID VM: attribution, nulls, kinds, lifecycle, privacy, cap OK');
"""


def state_record(event="ready", **kwargs):
    out = {"protocol": probe.PROTOCOL, "event": event,
           "calibrated": True, "baseline_positive_count": 2,
           "baseline_truncated": False, "tracked": 3,
           "events_dropped": 0}
    if event == "ready":
        out["timer"] = {key: True for key in ("added", "removed", "baseline", "ttl")}
    out.update(kwargs)
    return out


def window_record(**kwargs):
    out = {"protocol": probe.PROTOCOL, "event": "added", "window": "w1",
           "baseline": False, "closed": False, "browser": True,
           "has_pid": True, "owner_match": True, "normal_window": True,
           "tooltip": False, "dialog": False, "active": False,
           "keep_above": True, "demands_attention": False}
    out.update(kwargs)
    return out


class TestNativePid(unittest.TestCase):
    def test_actual_generated_js_vm(self):
        run = subprocess.run(["node", "-e", JS_VM, str(SCRIPT)],
                             capture_output=True, text=True, check=False, timeout=10)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn("privacy, cap OK", run.stdout)

    def test_packet_allowlist_and_unknown_pid(self):
        self.assertEqual(probe.valid_packet(json.dumps(window_record()))["owner_match"], True)
        self.assertIsNone(probe.valid_packet(json.dumps(window_record(
            has_pid=False, owner_match=None)))["owner_match"])
        for change in (
            {"has_pid": False, "owner_match": False},
            {"has_pid": True, "owner_match": None},
            {"owner_match": 1234}, {"window": "w999"},
            {"normal_window": "true"}, {"browser": "brave"},
            {"pid": 100},
        ):
            self.assertIsNone(probe.valid_packet(json.dumps(window_record(**change))), change)
        self.assertIsNotNone(probe.valid_packet(json.dumps(state_record())))
        self.assertIsNone(probe.valid_packet(json.dumps(state_record(
            calibrated=True, baseline_positive_count=0))))
        self.assertIsNone(probe.valid_packet(json.dumps(state_record(
            timer={"added": True}))))
        self.assertIsNone(probe.valid_packet("not json"))

    def test_cli_validation_no_live_activity(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = str(Path(directory).resolve())
            dest = Path(directory) / "private.json"
            probe.validate_args([100, 200], 12, dest)
            for pids, duration in (([], 12), ([0], 12), ([-1], 12),
                                   ([1, 1], 12), ([1], 0), ([1], 601),
                                   ([1], True), ([2147483648], 4)):
                with self.assertRaises(ValueError):
                    probe.validate_args(pids, duration, dest)
            probe.private_report(dest, {"status": "unsupported", "events": []})
            self.assertEqual(stat.S_IMODE(dest.stat().st_mode), 0o600)
            with self.assertRaises(ValueError):
                probe.validate_args([100], 12, dest)
            with self.assertRaises(FileExistsError):
                probe.private_report(dest, {})
            with mock.patch.object(probe.Probe, "run", side_effect=AssertionError(
                    "must not run platform")), self.assertRaises(SystemExit):
                probe.main(["--owner-pid", "0", "--duration", "3",
                            "--output", str(dest)])
        with tempfile.TemporaryDirectory() as directory:
            directory = str(Path(directory).resolve())
            Path(directory).chmod(0o755)
            with self.assertRaises(ValueError):
                probe.validate_args([123], 2, Path(directory) / "a.json")

    def test_clean_unload_only_owned_script_and_idempotent(self):
        obj = probe.Probe([100], 2)
        obj.load_attempted = True
        obj.plugin = "crossfeed_checker_" + "a" * 24
        obj.receiver = mock.Mock()
        obj.bus = mock.Mock()
        with tempfile.TemporaryDirectory() as base:
            base = str(Path(base).resolve())
            obj.temp = tempfile.mkdtemp(dir=base)
            with mock.patch.object(probe.desktop, "_command",
                                   return_value="true") as command:
                obj.close()
                obj.close()
                command.assert_called_once_with(
                    "/Scripting", "org.kde.kwin.Scripting.unloadScript",
                    "crossfeed_checker_" + "a" * 24)
        self.assertEqual(obj.cleanup["status"], "ok")
        self.assertEqual(obj.cleanup["unload"], "command_succeeded")
        obj.receiver = None

    def test_start_failure_and_interrupt_cleanup(self):
        obj = probe.Probe([100], 1)
        with mock.patch.object(probe.desktop, "_prerequisites", return_value=(
                {"reason": "missing_qdbus"}, None)):
            report = obj.run()
        self.assertEqual(report["status"], "unavailable")
        self.assertEqual(report["cleanup"]["status"], "ok")
        self.assertEqual(report["pid_getter_availability"], "unknown")
        obj2 = probe.Probe([123], 1)
        obj2.load_attempted = True
        obj2.plugin = "crossfeed_checker_" + "b" * 24
        with mock.patch.object(obj2, "start", side_effect=KeyboardInterrupt), \
                mock.patch.object(probe.desktop, "_command",
                                  return_value="true") as command:
            report = obj2.run()
        command.assert_called_once_with(
            "/Scripting", "org.kde.kwin.Scripting.unloadScript",
            "crossfeed_checker_" + "b" * 24)
        self.assertEqual(report["status"], "interrupted")
        self.assertEqual(report["cleanup"]["status"], "ok")

    def test_receiver_private_owner_and_bound(self):
        obj = probe.Probe([100], 3)
        obj.bus = mock.Mock()
        obj.bus.get_name_owner.return_value = ":1.44"
        obj.owner = ":1.44"
        obj._receive(json.dumps(state_record()), ":1.other")
        self.assertIsNone(obj.ready)
        obj._receive(json.dumps(state_record()), ":1.44")
        self.assertIsNotNone(obj.ready)
        obj._receive(json.dumps(window_record(pid=100)), ":1.44")
        self.assertEqual(obj.events, [])
        for _ in range(probe.MAX_EVENTS + 4):
            obj._receive(json.dumps(window_record()), ":1.44")
        self.assertEqual(len(obj.events), probe.MAX_EVENTS)
        obj.bus.get_name_owner.return_value = ":1.changed"
        obj._receive(json.dumps(state_record("done")), ":1.44")
        self.assertIsNone(obj.done)


if __name__ == "__main__":
    unittest.main()
