"""Synthetic v2/v3 loss-of-observability and terminal-coverage contract tests."""
import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from tools.wake_checker import cli, desktop
from tools.wake_checker.capabilities import safe_window_sampling
from tools.wake_checker.engine import CheckerEngine, Recorder
from tools.wake_checker.status import project_status

BASE = {"active": False, "minimized": False, "above_previous": False,
        "on_current_desktop": True, "on_current_activity": True,
        "keep_above": False, "keep_below": False, "demands_attention": False}
SAMPLING = {"interval_ms": 50, "ticks": 20, "gaps": 0, "max_gap_ms": 50,
            "candidates": 2, "running": True, "healthy": True,
            "min_candidate_ticks": 20}
COMPLETE = {"ticks": 20, "gaps": 0, "max_gap_ms": 50, "complete": True}


def desktop_event(e, event, ident="w1", at=1, **fields):
    return e.desktop({"kind": "desktop", "event": event, "window": ident, **fields}, now=at)


def add(e, ident="w1", at=1, flags=None):
    desktop_event(e, "window_added", ident, at, candidate=True, baseline=False,
                  marker_confirmed=False, initial=BASE if flags is None else flags)


def report(e, ident="w1"):
    return next(w for w in e.summary()["native_background"]["windows"]
                if w["window"] == ident)


class CoverageContractTests(unittest.TestCase):
    def test_explicit_null_must_not_retain_earlier_true(self):
        e = CheckerEngine(origin=0, replay=True)
        add(e)
        # Full v3 snapshot first: both the visual stack and other flags known.
        desktop_event(e, "window_changed", at=1.05,
                      current={**BASE, "above_previous": True,
                               "demands_attention": True})
        self.assertIs(report(e)["current_visual_stack"], True)
        desktop_event(e, "window_changed", at=1.1,
                      current={"above_previous": None, "demands_attention": None,
                               "on_current_activity": None, "keep_above": None})
        w = report(e)
        # A partial packet with explicit nulls also invalidates flags omitted
        # from this event; it cannot borrow any previously known v3 values.
        self.assertEqual(set(w["current"]), set(BASE))
        self.assertTrue(all(value is None for value in w["current"].values()))
        self.assertIsNone(w["current_visual_stack"])
        self.assertIsNone(w["current_active_foreground"])
        self.assertTrue(w["duration_uncertain"])
        self.assertNotEqual(w["background_verdict"], "no_observed_foreground_at_50ms")
        e.source_health("native", "unknown", now=1.2)
        self.assertTrue(e.native_incomplete)
        self.assertTrue(all(v is None for v in report(e)["current"].values()))
        self.assertTrue(all(v is None for v in e.windows["w1"]["current"].values()))

    def test_known_active_at_close_records_bounded_completed_episode(self):
        e = CheckerEngine(origin=0, replay=True)
        add(e, flags={**BASE, "active": True})
        desktop_event(e, "window_closed", at=1.2, current={"active": True})
        w = report(e)
        self.assertEqual(w["initial_background"], "failed")
        self.assertEqual(w["background_verdict"], "initial_foreground_failed")
        self.assertEqual(w["completed_observable_total_ms"]["active"], 200)
        self.assertEqual(w["max_completed_foreground_ms"]["active"], 200)
        self.assertTrue(w["closed"])
        self.assertEqual(w["episodes"][0]["completed_observable_ms"], 200)
        self.assertEqual(w["duration_semantics"],
                         "bounded_observed_episode_not_pixel_exposure")

    def test_global_ticks_do_not_clean_an_unsampled_window(self):
        e = CheckerEngine(origin=0, replay=True)
        e.native_capability({"status": "ready", "reason": "none"})
        add(e, "w1", at=1)
        add(e, "w2", at=1.6)
        e.desktop({"kind": "desktop", "event": "heartbeat",
                   "sampling": SAMPLING}, now=2)
        desktop_event(e, "window_closed", "w1", at=2.1, current=BASE)
        self.assertEqual(report(e, "w1")["background_verdict"], "indeterminate")
        desktop_event(e, "window_closed", "w2", at=2.2, current=BASE,
                      window_sampling=COMPLETE)
        self.assertEqual(report(e, "w2")["background_verdict"],
                         "no_observed_foreground_at_50ms")
        self.assertTrue(report(e, "w2")["complete_period_coverage"])

    def test_window_schema_closed_only_privacy_and_bounds(self):
        raw = {"kind": "desktop", "event": "window_closed", "window": "w1",
               "browser": True, "wake_marker": False, "baseline": False,
               **BASE, "window_sampling": COMPLETE}
        self.assertIsNotNone(desktop._decode(json.dumps(raw)))
        self.assertIsNone(safe_window_sampling(dict(COMPLETE, ticks=1)))
        self.assertIsNone(safe_window_sampling(dict(COMPLETE, gaps=1)))
        self.assertIsNone(desktop._decode(json.dumps(
            dict(raw, event="window_changed"))))
        self.assertIsNone(desktop._decode(json.dumps(
            dict(raw, window_sampling=dict(COMPLETE, private="injected")))))
        self.assertIsNone(desktop._decode(json.dumps(
            dict(raw, private_title="sensitive"))))
        self.assertTrue(cli._safe_desktop_record(
            {"kind": "desktop", "event": "window_closed", "window": "w1",
             "window_sampling": COMPLETE}))
        self.assertFalse(cli._safe_desktop_record(
            {"kind": "desktop", "event": "window_closed", "window": "w1",
             "window_sampling": dict(COMPLETE, ticks=0)}))

    def test_legacy_four_flags_and_extended_status_replay_exact(self):
        with tempfile.TemporaryDirectory() as temp:
            temp = str(Path(temp).resolve())
            src, dst = Path(temp) / "src", Path(temp) / "dst"
            e = CheckerEngine(Recorder(src), origin=0, replay=True)
            raw = {"workers": [{"label": "Fixture", "contact": "recent"}],
                   "wakes": [{"label": "Fixture", "state": "claimed"}],
                   "jobs": [{"label": "Fixture", "state": "queued"}],
                   "wake_limits": {"attempts": 1, "daily_cap": 0,
                                   "hourly_attempts": 0, "hourly_cap": 0},
                   "extension_poll": {"recent": True, "last_contact_at": 950},
                   "capacity": {"claimed": 2, "limit": 4}}
            projected = project_status(raw, b"a"*32, now_ms=1000)
            self.assertEqual(projected["limits"]["daily"]["mode"], "off")
            self.assertEqual(projected["limits"]["hourly"]["mode"], "paused")
            self.assertIsNone(projected["health"]["extension_heartbeat_age_ms"])
            e.status(projected, now=1)
            e.emit(projected, now=1)
            e.native_capability({"status": "ready", "reason": "none"}, now=1)
            legacy = {key: BASE[key] for key in
                      ("active", "minimized", "on_current_desktop", "above_previous")}
            add(e, at=1.1, flags=legacy)
            self.assertIsNone(report(e)["initial"]["on_current_activity"])
            desktop_event(e, "window_changed", at=1.2,
                          current={"active": False, "above_previous": False})
            e.desktop({"kind": "desktop", "event": "heartbeat",
                       "sampling": dict(SAMPLING, candidates=1)}, now=1.3)
            e.source_health("native", "unknown", now=1.4)
            desktop_event(e, "window_closed", at=1.5, current=legacy)
            e.native_capability({"status": "unsupported", "reason": "closed",
                                 "closed": True}, now=1.6)
            e.cleanup_result({"status": "ok"})
            expected = e.summary()
            e.recorder.close(expected)
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(cli.main(["replay", str(src / "events.jsonl"),
                                           "--output", str(dst)]), 0)
            actual = json.loads((dst / "summary.json").read_text())
            for key in ("health", "current", "native_background", "capability",
                        "cleanup", "counters", "pending", "records", "limits"):
                self.assertEqual(actual[key], expected[key], key)
            serialized = json.dumps(actual)
            self.assertNotIn("Fixture", serialized)
            self.assertNotIn("last_contact_at", serialized)

            # Also feed genuine four-key legacy records to the strict replay
            # parser, not just engine-rewritten v3 snapshots (which have all
            # eight keys). Missing newer fields must survive as unknown.
            legacy_path = Path(temp) / "legacy-v2.jsonl"
            legacy_dst = Path(temp) / "legacy-v2-replay"
            legacy_records = [
                {"kind": "desktop", "event": "window_added", "window": "w1",
                 "candidate": True, "baseline": False, "initial": legacy,
                 "seq": 1, "elapsed_ms": 1000},
                {"kind": "desktop", "event": "window_closed", "window": "w1",
                 "current": legacy, "seq": 2, "elapsed_ms": 1100},
            ]
            legacy_path.write_text("".join(json.dumps(row) + "\n"
                                           for row in legacy_records))
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(cli.main(["replay", str(legacy_path),
                                           "--output", str(legacy_dst)]), 0)
            replayed_v2 = json.loads((legacy_dst / "summary.json").read_text())
            v2_window = replayed_v2["native_background"]["windows"][0]
            self.assertEqual(v2_window["background_verdict"], "indeterminate")
            for flag in set(BASE) - set(legacy):
                self.assertIsNone(v2_window["initial"][flag], flag)
                self.assertIsNone(v2_window["current"][flag], flag)


if __name__ == "__main__":
    unittest.main()
