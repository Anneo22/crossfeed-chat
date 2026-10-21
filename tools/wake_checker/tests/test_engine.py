import json
import os
import stat
import tempfile
import unittest
from pathlib import Path

from tools.wake_checker.engine import CheckerEngine, Recorder


def projection(count=1):
    return {"kind": "status", "lanes": [{"lane": "0" * 16, "wakes": {"claimed": count}}],
            "limits": {"hourly": {}, "daily": {}}, "health": {"status": "ready"}}


class EngineTests(unittest.TestCase):
    def test_thresholds_first_observed_lower_bound_and_progress_reset(self):
        e = CheckerEngine(thresholds=(2, 4), max_gap=10)
        e.status(projection(), now=10)
        e.status(projection(), now=12)
        self.assertEqual(e.counters["threshold_crossings"], 1)
        e.status(projection(), now=14)
        self.assertEqual(e.counters["threshold_crossings"], 2)
        e.status({"kind": "status", "lanes": [{"lane": "0" * 16, "wakes": {"issued": 1}}],
                  "limits": {}, "health": {}}, now=15)
        self.assertEqual(e.counters["vanished_unknown"], 1)
        self.assertEqual(e.counters["backend_exact"], 0)
        e.status(projection(), now=16)
        self.assertEqual(e.counters["threshold_crossings"], 2)

    def test_gap_does_not_accumulate_stuck(self):
        e = CheckerEngine(thresholds=(5,), max_gap=10)
        e.status(projection(), now=0)
        e.status(projection(), now=30)
        self.assertEqual(e.counters["threshold_crossings"], 0)
        e.status(projection(), now=35)
        self.assertEqual(e.counters["threshold_crossings"], 1)
        e.source_health("status", "auth_error")
        e.status(projection(), now=37)
        self.assertEqual(e.counters["threshold_crossings"], 1)

    def test_duplicate_ambiguous_and_vanished(self):
        e = CheckerEngine(thresholds=(3,))
        e.status(projection(2), now=0)
        e.status(projection(2), now=3)
        self.assertEqual(e.counters["ambiguous"], 1)
        self.assertEqual(e.counters["threshold_crossings"], 1)
        e.status({"kind": "status", "lanes": [], "limits": {}, "health": {}}, now=4)
        self.assertEqual(e.counters["vanished_unknown"], 1)

    def test_activation_before_caption_and_first_flags(self):
        e = CheckerEngine()
        e.desktop({"kind": "desktop", "event": "window_activated", "window": "w1"})
        e.desktop({"kind": "desktop", "event": "window_added", "window": "w1",
                   "browser": True, "wake_marker": False, "active": False,
                   "minimized": False, "on_current_desktop": False,
                   "above_previous": False, "title": "NEVER_LOG_THIS"})
        self.assertTrue(e.windows["w1"]["activated"])
        self.assertFalse(e.windows["w1"]["initial"]["active"])
        e.desktop({"kind": "desktop", "event": "window_changed", "window": "w1",
                   "active": True, "above_previous": True})
        self.assertFalse(e.windows["w1"]["initial"]["active"])
        self.assertTrue(e.windows["w1"]["current"]["above_previous"])
        self.assertEqual(e.counters["candidate_windows"], 1)
        self.assertEqual(e.counters["marker_windows"], 0)
        e.probe(exact=True, baseline_candidates=1, native_ready=True, cdp_ready=False)
        self.assertEqual(e.counters["backend_exact"], 1)
        self.assertEqual(e.counters["warm_possible"], 1)
        self.assertEqual(e.counters["dom_ready"], 0)

    def test_failed_window_opening_no_inferred_success(self):
        e = CheckerEngine()
        e.desktop({"kind": "desktop", "event": "window_added", "window": "w2",
                   "browser": False, "wake_marker": False})
        e.probe(exact=None, baseline_candidates=0, native_ready=True, cdp_ready=False)
        self.assertEqual(e.counters["cold_window_observed"], 0)
        self.assertEqual(e.counters["backend_exact"], 0)

    def test_files_private_exclusive(self):
        with tempfile.TemporaryDirectory() as home:
            home = str(Path(home).resolve())
            dest = Path(home) / "run"
            r = Recorder(dest)
            r.write({"kind": "safe"})
            r.close({"ok": True})
            self.assertEqual(stat.S_IMODE(dest.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE((dest / "events.jsonl").stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE((dest / "summary.json").stat().st_mode), 0o600)
            with self.assertRaises(ValueError):
                Recorder(dest)
            link = Path(home) / "alias"
            link.symlink_to(dest, target_is_directory=True)
            with self.assertRaises(ValueError):
                Recorder(link)
            with self.assertRaisesRegex(ValueError, "unsafe_output_parent"):
                Recorder(link / "nested")
            self.assertEqual(json.loads((dest / "summary.json").read_text()), {"ok": True})

    def test_oversize_record_refused(self):
        with tempfile.TemporaryDirectory() as home:
            home = str(Path(home).resolve())
            r = Recorder(Path(home) / "run")
            with self.assertRaises(ValueError):
                r.write({"x": "z" * 70000})
            r.close({})


    def test_backend_confirmed_not_gui_confirmed(self):
        e = CheckerEngine()
        data = {"kind": "status", "lanes": [
            {"lane": "f" * 16, "wakes": {"confirmed": 1}}],
            "limits": {}, "health": {}}
        e.status(data, now=1)
        e.status(data, now=2)
        self.assertEqual(e.counters["backend_confirmed_tickets"], 1)
        self.assertEqual(e.counters["dom_ready"], 0)
        self.assertEqual(e.counters["candidate_windows"], 0)

    def test_workspace_global_change_without_window_identifier(self):
        e = CheckerEngine()
        ev = e.desktop({"kind": "desktop", "event": "desktop_changed", "window": None})
        self.assertEqual(ev["scope"], "global")

    def test_browser_classification_after_caption(self):
        e = CheckerEngine()
        e.desktop({"kind": "desktop", "event": "window_activated", "window": "w3"})
        e.desktop({"kind": "desktop", "event": "window_added", "window": "w3",
                   "browser": False, "wake_marker": False, "active": False})
        self.assertEqual(e.counters["candidate_windows"], 0)
        e.desktop({"kind": "desktop", "event": "window_changed", "window": "w3",
                   "browser": True, "wake_marker": True, "active": True})
        self.assertEqual(e.counters["candidate_windows"], 1)
        self.assertEqual(e.counters["marker_windows"], 1)
        self.assertTrue(e.windows["w3"]["activated"])
        self.assertIs(e.windows["w3"]["initial"]["active"], False)

    def test_monotonic_order_native_wall_and_activation_intervals(self):
        with tempfile.TemporaryDirectory() as home:
            home = str(Path(home).resolve())
            e = CheckerEngine(Recorder(Path(home) / "run"), origin=0, replay=True)
            e.desktop({"kind": "desktop", "event": "window_added", "window": "w1",
                       "browser": True, "wake_marker": True, "native_ms": 1800000000123,
                       "baseline": False, "active": False}, now=10.1)
            e.desktop({"kind": "desktop", "event": "window_activated", "window": "w1",
                       "native_ms": 1800000000234, "active": True}, now=10.2)
            e.probe(exact=True, baseline_candidates=0, native_ready=True, cdp_ready=False,
                    dispatched_ms=10000, completed_ms=10500)
            result = e.summary()["probes"][0]
            self.assertEqual(result["duration_ms"], 500)
            self.assertEqual(result["first_added_after_dispatch_ms"], 100)
            self.assertEqual(result["first_activation_after_dispatch_ms"], 200)
            self.assertEqual(result["correlation"], "temporal_only_no_ownership")
            e.recorder.close(e.summary())
            rows = [json.loads(line) for line in
                    (Path(home) / "run" / "events.jsonl").read_text().splitlines()]
            self.assertEqual([x["seq"] for x in rows], list(range(1, len(rows) + 1)))
            self.assertEqual(rows[0]["elapsed_ms"], 10100)
            self.assertEqual(rows[0]["native_event_wall_ms"], 1800000000123)
            self.assertNotIn("collector_wall_ms", rows[0])

    def test_current_stalled_failures_jobs_ambiguity_and_progress_reset(self):
        e = CheckerEngine(thresholds=(2, 5), origin=0, replay=True)
        projection0 = {"kind": "status", "lanes": [
            {"lane": "a" * 16, "worker": "stale",
             "awake": False, "processing_claim": True, "quota_blocked": True,
             "wakes": {"claimed": 2, "failed": 1}, "jobs": {"queued": 3, "claimed": 1},
             "diagnostics": [{"stage": "load", "code": "page_changed"}]}],
             "limits": {"cooldown": True}, "health": {"host": False, "extension_enabled": False}}
        e.status(projection0, now=0)
        e.status(projection0, now=3)
        self.assertEqual(e.current["pending"], 2)
        self.assertEqual(e.current["stalled_suspect"]["2"], 2)
        self.assertEqual(e.current["failed"], 1)
        self.assertEqual(e.current["jobs"]["queued"], 3)
        self.assertEqual(e.current["worker_flags"]["quota_blocked"], 1)
        self.assertEqual(e.current["ambiguous"], 2)
        advanced = json.loads(json.dumps(projection0))
        advanced["lanes"][0]["jobs"]["queued"] = 2
        advanced["lanes"][0]["jobs"]["claimed"] = 2
        e.status(advanced, now=4)
        self.assertEqual(e.current["stalled_suspect"]["2"], 0)
        e.status(advanced, now=6)
        self.assertEqual(e.current["stalled_suspect"]["2"], 2)
        e.source_health("status", "unreachable")
        self.assertIsNone(e.current["pending"])
        self.assertIsNone(e.counters["stalled_suspect_current"])

    def test_cdp_unique_target_readiness_and_errors(self):
        e = CheckerEngine(origin=0, replay=True)
        base = {"target": "a" * 16, "scope": "new_chatgpt_target",
                "observation": {"ready": True, "composer": True,
                                "generating": False, "login": False,
                                "error": False, "dialog": False, "permission": False}}
        e.cdp(base, now=1)
        e.cdp(base, now=2)
        self.assertEqual(e.counters["dom_ready"], 1)
        e.cdp({"error_code": "target_missing", "target": "a" * 16,
               "scope": "new_chatgpt_target"}, now=3)
        self.assertEqual(e.health["cdp"], "error")
        e.cdp(base, now=4)
        self.assertEqual(e.counters["dom_ready"], 2)
        self.assertEqual(e.health["cdp"], "ready")

    def test_missing_open_observation_has_bounded_unknown(self):
        e = CheckerEngine(origin=0, replay=True)
        e.probe(exact=None, baseline_candidates=0, native_ready=True, cdp_ready=False,
                dispatched_ms=100, completed_ms=None, deadline_ms=2500)
        p = e.summary()["probes"][0]
        self.assertIsNone(p["duration_ms"])
        self.assertEqual(p["open_not_observed_within_ms"], 2500)
        self.assertTrue(p["completion_unknown"])

if __name__ == "__main__":
    unittest.main()
