"""Scoped regressions for fail-closed native evidence and bounded summaries.

Synthetic input only; no KWin or production API access.
"""
import json
import tempfile
import unittest
from pathlib import Path

from tools.wake_checker.engine import CheckerEngine, Recorder, MAX_LINE
from tools.wake_checker.desktop import DesktopObserver

FLAGS = {
    "active": False, "minimized": False, "above_previous": False,
    "on_current_desktop": True, "on_current_activity": True,
    "keep_above": False, "keep_below": False, "demands_attention": False,
}
LEGACY = {key: FLAGS[key] for key in
          ("active", "minimized", "on_current_desktop", "above_previous")}
COMPLETE = {"ticks": 20, "gaps": 0, "max_gap_ms": 50, "complete": True}
SAMPLE = {"interval_ms": 50, "ticks": 25, "gaps": 0, "max_gap_ms": 50,
          "candidates": 1, "running": True, "healthy": True,
          "min_candidate_ticks": 25}


def native(e, event, window="w1", when=1.0, **data):
    return e.desktop({"kind": "desktop", "event": event, "window": window, **data},
                     now=when)


def report(e, name="w1"):
    return next(w for w in e.summary()["native_background"]["windows"]
                if w["window"] == name)


class ScopedWakeRegressions(unittest.TestCase):
    def test_legacy_changed_and_terminal_closed_invalidate_eight_flag_snapshot(self):
        e = CheckerEngine(origin=0, replay=True)
        e.native_capability({"status": "ready", "reason": "none"}, now=0)
        native(e, "window_added", when=1.0, candidate=True, initial=FLAGS)
        native(e, "heartbeat", window=None, when=1.05, sampling=SAMPLE)
        native(e, "window_changed", when=1.1, current=LEGACY)
        self.assertTrue(all(e.windows["w1"]["current"][k] is None
                            for k in set(FLAGS) - set(LEGACY)))
        native(e, "window_closed", when=1.2, current=LEGACY, window_sampling=COMPLETE)
        w = report(e)
        self.assertTrue(w["duration_uncertain"])
        self.assertTrue(w["complete_period_coverage"])
        # Complete sampling cannot rehabilitate incomplete flag observations.
        self.assertEqual(w["background_verdict"], "indeterminate")
        self.assertEqual(set(w["current"]), set(FLAGS))
        self.assertTrue(all(w["current"][k] is None
                            for k in set(FLAGS) - set(LEGACY)))

    def test_trusted_malformed_signal_degrades_but_foreign_sender_does_not(self):
        class FakeBus:
            owner = ":1.55"
            def get_name_owner(self, _name):
                return self.owner
            def close(self):
                pass

        sent = []
        obs = DesktopObserver(10, sent.append)
        obs._bus = FakeBus()
        obs._owner = ":1.55"
        obs._ready = {"status": "ready"}
        obs.capability = {"status": "ready", "reason": "none"}
        malformed_activation = json.dumps({"kind": "desktop",
                                           "event": "window_activated",
                                           "window": "w1",
                                           "private_title": "do_not_echo"})
        obs._receive(malformed_activation, ":1.99")
        self.assertEqual(obs.capability["status"], "ready")
        self.assertFalse(obs._closed)
        obs._receive(malformed_activation, ":1.55")
        self.assertEqual(obs.capability["status"], "unsupported")
        self.assertEqual(obs.capability["reason"], "coverage_incomplete")
        self.assertTrue(obs._closed)
        self.assertEqual(sent, [])

        e = CheckerEngine(origin=0, replay=True)
        e.native_capability({"status": "ready", "reason": "none"}, now=0)
        native(e, "window_added", candidate=True, initial=FLAGS)
        native(e, "heartbeat", window=None, when=1.05, sampling=SAMPLE)
        native(e, "window_closed", when=1.1, current=FLAGS, window_sampling=COMPLETE)
        self.assertEqual(report(e)["background_verdict"],
                         "no_observed_foreground_at_50ms")
        e.native_capability(obs.capability, now=1.2)
        self.assertTrue(e.summary()["limits"]["native_coverage_incomplete"])
        self.assertNotEqual(report(e)["background_verdict"],
                            "no_observed_foreground_at_50ms")

    def test_pretty_summary_bound_24_detailed_windows_and_pending_diagnostics(self):
        with tempfile.TemporaryDirectory() as root:
            root = str(Path(root).resolve())
            path = Path(root) / "run"
            e = CheckerEngine(Recorder(path), origin=0, replay=True)
            e.native_capability({"status": "ready", "reason": "none"}, now=0)
            for index in range(1, 25):
                wid = f"w{index}"
                at = index * 1.0
                native(e, "window_added", wid, at, candidate=True,
                       marker_confirmed=True, initial=FLAGS)
                for tick in range(8):
                    changing = dict(FLAGS)
                    changing["active"] = (tick % 2 == 0)
                    changing["above_previous"] = (tick % 2 == 0)
                    native(e, "window_changed", wid, at + (tick + 1) / 100,
                           current=changing)
                native(e, "window_closed", wid, at + .1, current=FLAGS,
                       window_sampling=COMPLETE)
            self.assertEqual(e.background.summary()["reported_windows"], 24)
            self.assertEqual(len(e.background.summary()["windows"][0]["timeline"]), 4)
            self.assertEqual(len(e.background.summary()["windows"][0]["episodes"]), 4)
            # Exercise high-cardinality safe aggregate views, independently
            # from status transport/replay sanitization.
            e.pending = {(f"lane_{i:03d}", "claimed"): {"count": 100,
                         "passed": {15, 60, 180}} for i in range(128)}
            e.current["diagnostics"] = {
                f"lane_{i:03d}": {"reason": "unknown", "observed": 100,
                                  "candidate": "not_known", "flags": [False] * 8}
                for i in range(128)}
            first = e.summary()
            second = e.summary()
            self.assertEqual(first, second)
            self.assertEqual(first["native_background"]["total_candidate_windows"], 24)
            self.assertEqual(first["counters"]["candidate_windows"], 24)
            self.assertIn("summary_truncation", first)
            encoded = json.dumps(first, indent=2, sort_keys=True, allow_nan=False).encode()
            self.assertLessEqual(len(encoded), MAX_LINE)
            e.recorder.close(first)
            saved = (path / "summary.json").read_bytes()
            self.assertLessEqual(len(saved), MAX_LINE)
            self.assertEqual(json.loads(saved), first)


    def test_replay_and_cli_print_share_bounded_24_window_summary(self):
        import contextlib
        import io
        from tools.wake_checker import cli

        with tempfile.TemporaryDirectory() as root:
            root = str(Path(root).resolve())
            source = Path(root) / "source"
            replayed = Path(root) / "replayed"
            e = CheckerEngine(Recorder(source), origin=0, replay=True)
            e.native_capability({"status": "ready", "reason": "none"}, now=0)
            for index in range(1, 25):
                wid, at = f"w{index}", float(index)
                native(e, "window_added", wid, at, candidate=True,
                       marker_confirmed=True, initial=FLAGS)
                for tick in range(8):
                    snapshot = dict(FLAGS)
                    snapshot["above_previous"] = tick % 2 == 0
                    snapshot["active"] = tick % 2 == 0
                    native(e, "window_changed", wid, at + (tick + 1) / 100,
                           current=snapshot)
                native(e, "window_closed", wid, at + .1, current=FLAGS,
                       window_sampling=COMPLETE)
            expected = e.summary()
            self.assertEqual(expected["native_background"]["total_candidate_windows"], 24)
            self.assertLessEqual(len(json.dumps(expected, indent=2,
                                    sort_keys=True, allow_nan=False).encode()), MAX_LINE)
            e.recorder.close(expected)
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(cli.main(["replay", str(source / "events.jsonl"),
                                           "--output", str(replayed)]), 0)
            replay_summary = json.loads((replayed / "summary.json").read_text())
            self.assertEqual(replay_summary, expected)
            printed = [s[len("summary="):] for s in output.getvalue().splitlines()
                       if s.startswith("summary=")]
            self.assertEqual(len(printed), 1)
            self.assertEqual(json.loads(printed[0]), expected)


if __name__ == "__main__":
    unittest.main()
