"""Single-observation timestamp regression tests for the live checker clock."""
import json
import unittest
from unittest.mock import patch

from tools.wake_checker.engine import CheckerEngine

INITIAL = {
    "active": True, "minimized": False, "on_current_desktop": True,
    "above_previous": False, "on_current_activity": True,
    "keep_above": False, "keep_below": False, "demands_attention": False,
}


class Capture:
    def __init__(self):
        self.records = []

    def write(self, row):
        self.records.append(row)


def added(ident="w1", **updates):
    return {"kind": "desktop", "event": "window_added", "window": ident,
            "candidate": True, "baseline": False, "marker_confirmed": False,
            "initial": dict(INITIAL), **updates}


def window(engine):
    return engine.summary()["native_background"]["windows"][0]


class TimestampTests(unittest.TestCase):
    def test_real_clock_crosses_rounding_boundary_without_splitting_episode(self):
        recorder = Capture()
        e = CheckerEngine(recorder, origin=100.0)
        with patch("tools.wake_checker.engine.time.monotonic",
                   side_effect=[100.00049, 100.00151, 100.00449]) as clock:
            a = e.desktop(added())
            b = e.desktop({"kind": "desktop", "event": "window_changed",
                           "window": "w1", "current": dict(INITIAL)})
            c = e.desktop({"kind": "desktop", "event": "window_closed",
                           "window": "w1", "current": dict(INITIAL)})
        self.assertEqual(clock.call_count, 3)
        self.assertEqual([a["elapsed_ms"], b["elapsed_ms"], c["elapsed_ms"]], [0, 2, 4])
        self.assertEqual([r["seq"] for r in recorder.records], [1, 2, 3])
        self.assertEqual(window(e)["episodes"][0],
                         {"type": "active", "start_ms": 0, "end_ms": 4,
                          "completed_observable_ms": 4, "uncertain": False})
        self.assertEqual(window(e)["completed_observable_total_ms"]["active"], 4)
        replay = CheckerEngine(origin=0, replay=True)
        for row in recorder.records:
            replay.desktop(row, now=row["elapsed_ms"] / 1000)
        self.assertEqual(e.summary(), replay.summary())
        self.assertEqual(json.dumps(e.summary(), indent=2, sort_keys=True).encode(),
                         json.dumps(replay.summary(), indent=2, sort_keys=True).encode())
        self.assertTrue(all(set(r) <=
                            {"kind", "event", "window", "candidate", "marker_confirmed",
                             "baseline", "initial", "current", "activation_buffered",
                             "activation_observed", "seq", "elapsed_ms", "collector_wall_ms"}
                            for r in recorder.records))

    def test_real_clock_native_health_gap_closes_at_same_recorded_stamp(self):
        recorder = Capture()
        e = CheckerEngine(recorder, origin=100.0)
        e.desktop(added(), now=100.0)
        e.native_capability({"status": "ready", "reason": "none"}, now=100.0)
        with patch("tools.wake_checker.engine.time.monotonic",
                   side_effect=[100.00149, 100.00251]) as clock:
            e.source_health("native", "unknown")
        self.assertEqual(clock.call_count, 1)
        self.assertEqual(recorder.records[-1]["elapsed_ms"], 1)
        self.assertTrue(e.native_incomplete)
        report = window(e)
        self.assertEqual(report["episodes"][0]["end_ms"], 1)
        self.assertTrue(report["episodes"][0]["uncertain"])
        self.assertEqual(report["completed_observable_total_ms"]["active"], 0)

    def test_real_clock_capability_gap_and_two_emissions_share_stamp(self):
        recorder = Capture()
        e = CheckerEngine(recorder, origin=100.0)
        e.desktop(added(), now=100.0)
        with patch("tools.wake_checker.engine.time.monotonic",
                   side_effect=[100.00149, 100.00251]) as clock:
            e.native_capability({"status": "unsupported", "reason": "coverage_incomplete"})
        self.assertEqual(clock.call_count, 1)
        self.assertEqual([(r["kind"], r["elapsed_ms"]) for r in recorder.records[-2:]],
                         [("capability", 1), ("health", 1)])
        self.assertEqual(window(e)["episodes"][0]["end_ms"], 1)
        self.assertTrue(e.native_incomplete)

    def test_nested_desktop_capability_and_desktop_have_one_clock_read(self):
        recorder = Capture()
        e = CheckerEngine(recorder, origin=100.0)
        e.native_capability({"status": "ready", "reason": "none"}, now=100.0)
        sampling = {"interval_ms": 50, "ticks": 20, "gaps": 0, "max_gap_ms": 50,
                    "candidates": 1, "running": True, "healthy": True,
                    "min_candidate_ticks": 20}
        with patch("tools.wake_checker.engine.time.monotonic",
                   side_effect=[100.00149, 100.00251]) as clock:
            e.desktop({"kind": "desktop", "event": "heartbeat", "sampling": sampling})
        self.assertEqual(clock.call_count, 1)
        self.assertEqual(recorder.records[-1]["kind"], "desktop")
        self.assertEqual(recorder.records[-1]["elapsed_ms"], 1)
        self.assertEqual(recorder.records[-2]["kind"], "capability")
        self.assertEqual(recorder.records[-2]["elapsed_ms"], 1)

    def test_cleanup_error_and_cdp_health_use_single_clock_each(self):
        recorder = Capture()
        e = CheckerEngine(recorder, origin=100.0)
        with patch("tools.wake_checker.engine.time.monotonic",
                   side_effect=[100.00149, 100.00251]) as clock:
            e.cleanup_result({"status": "error"})
        self.assertEqual(clock.call_count, 1)
        self.assertEqual([(r["kind"], r["elapsed_ms"]) for r in recorder.records],
                         [("cleanup", 1), ("health", 1)])
        with patch("tools.wake_checker.engine.time.monotonic",
                   side_effect=[100.00349, 100.00451]) as clock:
            e.cdp({"observation": {"ready": True, "composer": True}})
        self.assertEqual(clock.call_count, 1)
        self.assertEqual([(r["kind"], r["elapsed_ms"]) for r in recorder.records[-2:]],
                         [("health", 3), ("cdp", 3)])

    def test_buffered_activation_preserves_original_stamp_across_replay(self):
        recorder = Capture()
        e = CheckerEngine(recorder, origin=100.0)
        with patch("tools.wake_checker.engine.time.monotonic",
                   side_effect=[100.00049, 100.00151, 100.00249]) as clock:
            self.assertIsNone(e.desktop({"kind": "desktop", "event": "window_activated",
                                         "window": "w2"}))
            row = e.desktop(added("w2"))
        self.assertEqual(clock.call_count, 2)
        self.assertEqual((row["activation_elapsed_ms"], row["elapsed_ms"]), (0, 2))
        replay = CheckerEngine(origin=0, replay=True)
        replay.desktop(row, now=0.002)
        self.assertEqual(window(e), window(replay))
        self.assertEqual(window(replay)["pre_add_activation_ms"], 0)
        self.assertEqual(window(replay)["initial_background"], "failed")


if __name__ == "__main__":
    unittest.main()
