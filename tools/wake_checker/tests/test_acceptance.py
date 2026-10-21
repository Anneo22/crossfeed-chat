"""Focused final-acceptance regressions. All fixtures are offline and synthetic."""
import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tools.wake_checker import cli
from tools.wake_checker.capabilities import safe_capability
from tools.wake_checker.cdp import DOM_QUERY, list_targets
from tools.wake_checker.engine import CheckerEngine, Recorder
from tools.wake_checker.status import valid_label
from tools.wake_checker.transport import valid_model


def capacity(tracked=2, overflow=0, unknown=0):
    return {"limit": 256, "tracked": tracked, "overflow": overflow, "unknown": unknown}


def native(**updates):
    result = {"status": "ready", "reason": "none", "backend": "kde-kwin",
              "stacking_mode": "sample_on_events", "capacity": capacity(),
              "capabilities": {"stacking_sampled": True, "stacking": False}}
    result.update(updates)
    return result


class AcceptanceTests(unittest.TestCase):
    def test_unified_native_projection_and_closed_health(self):
        raw = native()
        expected = safe_capability(raw)
        self.assertEqual(cli.safe_capability(raw), expected)
        self.assertEqual(expected["stacking_mode"], "sample_on_events")
        self.assertTrue(expected["capabilities"]["stacking_sampled"])
        self.assertEqual(expected["capacity"], capacity())
        e = CheckerEngine(origin=0, replay=True)
        e.native_capability(raw)
        self.assertEqual(e.capability, expected)
        self.assertEqual(e.health["native"], "ready")
        e.native_capability(native(closed=True))
        self.assertEqual(e.health["native"], "unsupported")
        self.assertEqual(e.capability["reason"], "closed")
        self.assertEqual(e.capability["capacity"], capacity())
        self.assertTrue(e.capability["closed"])
        self.assertEqual(safe_capability(native(reason="private device name"))["reason"], "unknown")

    def test_native_capacity_and_queue_gap_sticky_fail_closed(self):
        for cap, reason in ((capacity(256), "capacity_exhausted"),
                            (capacity(3, 1, 1), "capacity_overflow"),
                            (capacity(3, 2, 0), "capacity_overflow")):
            with self.subTest(cap=cap):
                e = CheckerEngine(origin=0, replay=True)
                e.native_capability(native())
                event = e.desktop({"kind": "desktop", "event": "capacity_changed",
                                   "capacity": cap, "native_ms": 1000}, now=1)
                self.assertEqual(event["capacity"], cap)
                self.assertEqual(e.capability["reason"], reason)
                self.assertEqual(e.health["native"], "unsupported")
                self.assertTrue(e.native_incomplete)
                e.desktop({"kind": "desktop", "event": "ready", "capacity": capacity()},
                          now=1.1)
                e.native_capability(native())
                self.assertNotEqual(e.health["native"], "ready")
        e = CheckerEngine(origin=0, replay=True)
        e.native_capability(native())
        e.source_health("native", "unknown", now=1)
        e.desktop({"kind": "desktop", "event": "ready"}, now=2)
        self.assertEqual(e.health["native"], "unknown")
        e.native_capability(native())
        self.assertEqual(e.health["native"], "unsupported")
        self.assertTrue(e.summary()["limits"]["native_coverage_incomplete"])

    def test_activation_before_add_replay_preserves_timing_and_native_wall(self):
        with tempfile.TemporaryDirectory() as home:
            home = str(Path(home).resolve())
            root = Path(home)
            original, played = root / "original", root / "played"
            e = CheckerEngine(Recorder(original), origin=0, replay=True)
            e.native_capability(native())
            e.desktop({"kind": "desktop", "event": "window_activated",
                       "window": "w1", "native_ms": 1800000000000}, now=10.125)
            added = e.desktop({"kind": "desktop", "event": "window_added",
                               "window": "w1", "candidate": True, "baseline": False,
                               "marker_confirmed": True,
                               "initial": {"active": True, "minimized": False,
                                           "on_current_desktop": True, "above_previous": None},
                               "native_ms": 1800000000123}, now=10.4)
            self.assertTrue(added["activation_buffered"])
            self.assertEqual(added["activation_elapsed_ms"], 10125)
            self.assertEqual(added["native_event_wall_ms"], 1800000000123)
            self.assertEqual(added["elapsed_ms"], 10400)
            e.probe(exact=True, baseline_candidates=0, native_ready=True, cdp_ready=False,
                    dispatched_ms=10000, completed_ms=11000)
            e.native_capability(native(closed=True))
            e.cleanup_result({"status": "ok"})
            expected = e.summary()
            self.assertEqual(expected["probes"][0]["first_added_after_dispatch_ms"], 400)
            self.assertEqual(expected["probes"][0]["first_activation_after_dispatch_ms"], 125)
            e.recorder.close(expected)
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(cli.main(["replay", str(original / "events.jsonl"),
                                           "--output", str(played)]), 0)
            actual = json.loads((played / "summary.json").read_text())
            for key in ("health", "capability", "cleanup", "counters", "probes",
                        "current", "pending", "limits", "records"):
                self.assertEqual(actual[key], expected[key], key)
            events = [json.loads(line) for line in (original / "events.jsonl").read_text().splitlines()]
            self.assertTrue(any(row.get("event") == "window_added"
                                and row.get("activation_elapsed_ms") == 10125 for row in events))

    def test_replay_capacity_and_normal_close_equivalence(self):
        with tempfile.TemporaryDirectory() as home:
            home = str(Path(home).resolve())
            src, dst = Path(home) / "src", Path(home) / "dst"
            e = CheckerEngine(Recorder(src), origin=0, replay=True)
            e.native_capability(native())
            e.desktop({"kind": "desktop", "event": "capacity_changed",
                       "capacity": capacity(256, 3, 2)}, now=5)
            e.native_capability(native(status="unsupported", reason="capacity_exhausted",
                                       capacity=capacity(256, 3, 2), closed=True))
            e.cleanup_result({"status": "ok"})
            expected = e.summary()
            e.recorder.close(expected)
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(cli.main(["replay", str(src / "events.jsonl"),
                                           "--output", str(dst)]), 0)
            actual = json.loads((dst / "summary.json").read_text())
            for key in ("capability", "cleanup", "health", "limits", "counters", "records"):
                self.assertEqual(actual[key], expected[key], key)

    def test_replay_ancestor_symlink_and_untrusted_strings(self):
        with tempfile.TemporaryDirectory() as home:
            home = str(Path(home).resolve())
            root = Path(home)
            original = root / "real"
            original.mkdir()
            (original / "events.jsonl").write_text('{"kind":"stop","reason":"sigterm"}\n')
            (root / "alias").symlink_to(original, target_is_directory=True)
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(cli.main(["replay", str(root / "alias" / "events.jsonl"),
                                           "--output", str(root / "symlinkout")]), 2)
            bad = [
                {"kind": "stop", "reason": "session=private"},
                {"kind": "probe_dispatch", "probe_number": 1, "deadline_ms": 2000,
                 "collector_ready": True, "session": "private"},
                {"kind": "probe_blocked", "reason": "private_data"},
                {"kind": "gap", "source": "native", "decision": "private"},
                {"kind": "status_sample", "lanes": 0, "pending": 0, "failed": 0,
                 "expired": 0, "ambiguous": 0, "stalled_suspect": {},
                 "jobs": {}, "workers": {}, "worker_flags": {},
                 "diagnostics": {"private/message": 1}, "limits": {}, "health": {}},
                {"kind": "desktop", "event": "window_added", "window": "w1",
                 "activation_buffered": True, "activation_elapsed_ms": 999,
                 "elapsed_ms": 1},
                {"kind": "desktop", "event": "capacity_changed",
                 "capacity": {"limit": 256, "tracked": 999,
                              "overflow": 1, "unknown": 1}},
                {"kind": "desktop", "event": "window_added", "window": "w1",
                 "candidate": 1},
                {"kind": "probe_result", "backend_completion": "unknown",
                 "native_new_window": 0, "dom_source_ready": 1,
                 "delivery": "unknown", "completion_unknown": True,
                 "correlation": "temporal_only_no_ownership"},
                {"kind": "status", "lanes": [], "limits": {"cooldown": 0},
                 "health": {"status": "ready", "host": 1}},
            ]
            for n, event in enumerate(bad):
                with self.subTest(record=n):
                    path = original / "events.jsonl"
                    path.write_text(json.dumps(event) + "\n")
                    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                        self.assertEqual(cli.main(["replay", str(path),
                                                   "--output", str(root / ("out" + str(n)))]), 2)

    def test_active_dispatch_requires_new_status_sample_and_own_run_replay(self):
        from tools.wake_checker.transport import TransportError

        class PassiveObserver:
            def __init__(self):
                self.capability = native()
            def poll(self):
                return dict(self.capability)
            def close(self):
                self.capability = native(closed=True)
                return {"status": "ok", "reason": "none"}

        count = [0]
        def sample(*_args, **kwargs):
            count[0] += 1
            if count[0] == 1:
                return {"kind": "status", "lanes": [],
                        "limits": {"daily": {"attempts": None, "cap": None},
                                   "hourly": {"attempts": None, "cap": None},
                                   "cooldown": None},
                        "health": {"status": "ready"}}
            kwargs["cancel"].stop.wait(5)
            raise TransportError("cancelled")

        with tempfile.TemporaryDirectory() as home:
            home = str(Path(home).resolve())
            root = Path(home)
            listener = root / "listener"
            playback = root / "playback"
            with mock.patch.object(cli, "native_start", return_value=(PassiveObserver(), native())), \
                 mock.patch.object(cli, "token_from_env", return_value="synthetic-token"), \
                 mock.patch.object(cli, "get_status", side_effect=sample), \
                 mock.patch.object(cli, "completion_once", return_value=True) as post, \
                 contextlib.redirect_stdout(io.StringIO()):
                result = cli.main(["listen", "--duration", "3", "--poll-interval", "1",
                                   "--status-url", "http://127.0.0.1:4319",
                                   "--probe-model", "chatgpt:Simulated Crew π",
                                   "--allow-active-probe", "--probe-count", "2",
                                   "--output", str(listener)])
                self.assertEqual(result, 0)
            self.assertEqual(post.call_count, 1)  # no reuse of prior status success
            before = json.loads((listener / "summary.json").read_text())
            self.assertEqual(before["counters"]["backend_exact"], 1)
            self.assertEqual(before["health"]["native"], "unsupported")
            self.assertEqual(before["capability"]["reason"], "closed")
            self.assertTrue(before["capability"]["closed"])
            self.assertEqual(before["cleanup"]["status"], "ok")
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(cli.main(["replay", str(listener / "events.jsonl"),
                                           "--output", str(playback)]), 0)
            after = json.loads((playback / "summary.json").read_text())
            for key in ("capability", "cleanup", "health", "counters",
                        "current", "pending", "probes", "limits", "records"):
                self.assertEqual(after[key], before[key], key)

    def test_model_matches_host_label_rule(self):
        labels = ("x" * 128, "é" * 64, "Crew A: π", "E/δ: batch #2")
        for label in labels:
            self.assertTrue(valid_label(label), repr(label))
            self.assertTrue(valid_model("chatgpt:" + label))
        for label in ("", " x", "x ", "é" * 65, "x\u200b", "a\n", "a\x7f"):
            self.assertFalse(valid_label(label), repr(label))
            self.assertFalse(valid_model("chatgpt:" + label))
        self.assertFalse(valid_model("other:x"))

    def test_cdp_identity_and_origin_check_precedes_selectors(self):
        self.assertLess(DOM_QUERY.index("location.origin !=="),
                        DOM_QUERY.index("document.querySelectorAll"))
        rows = [
            {"type": "page", "url": "https://chatgpt.com/", "id": "valid",
             "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/page/valid"},
            {"type": "page", "url": "https://chatgpt.com/", "id": "victim",
             "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/page/other"},
        ]
        response = mock.Mock()
        response.status = 200
        response.headers.get_content_type.return_value = "application/json"
        response.read.return_value = json.dumps(rows).encode()
        connection = mock.Mock()
        connection.getresponse.return_value = response
        with mock.patch("tools.wake_checker.cdp.http.client.HTTPConnection", return_value=connection), \
             mock.patch("tools.wake_checker.cdp.socket.create_connection", return_value=mock.Mock()):
            self.assertEqual(list_targets("http://127.0.0.1:9222"),
                             {"valid": "ws://127.0.0.1:9222/devtools/page/valid"})


if __name__ == "__main__":
    unittest.main()
