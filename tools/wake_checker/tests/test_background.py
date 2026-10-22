"""Offline background/annoyance and replay regressions; never touch live GUI/API."""
import contextlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

from tools.wake_checker import cli, desktop
from tools.wake_checker.capabilities import safe_capability
from tools.wake_checker.engine import CheckerEngine, Recorder
from tools.wake_checker.status import project_status

ROOT = Path(__file__).resolve().parents[1]
FULL = {"active": False, "minimized": False, "above_previous": False,
        "on_current_desktop": True, "on_current_activity": True,
        "keep_above": False, "keep_below": False, "demands_attention": False}
HEALTHY = {"interval_ms": 50, "ticks": 20, "gaps": 0, "max_gap_ms": 50,
           "candidates": 1, "running": True, "healthy": True,
           "min_candidate_ticks": 20}


def add(engine, key="w1", at=1, **values):
    return engine.desktop({"kind": "desktop", "event": "window_added",
                           "window": key, "candidate": True,
                           "marker_confirmed": False, "baseline": False,
                           **{**FULL, **values}}, now=at)


def change(engine, event="window_changed", key="w1", at=1.1, **values):
    # These synthetic schema-v3 events represent complete KWin snapshots.
    # Missing flags in a real partial/legacy packet stay unknown, not stale.
    return engine.desktop({"kind": "desktop", "event": event,
                           "window": key, **{**FULL, **values}}, now=at)


def report(engine):
    return engine.summary()["native_background"]["windows"][0]


class BackgroundTests(unittest.TestCase):
    def test_initial_true_is_irreversible_after_restore(self):
        e = CheckerEngine(origin=0, replay=True)
        add(e, active=True)
        change(e, at=1.02, active=False)
        change(e, "window_activated", at=1.04, active=True)
        change(e, at=1.06, active=False)
        r = report(e)
        self.assertEqual(r["initial_background"], "failed")
        self.assertEqual(r["background_verdict"], "initial_foreground_failed")
        self.assertEqual(r["completed_observable_total_ms"]["active"], 40)
        self.assertEqual(r["max_completed_foreground_ms"]["active"], 20)
        self.assertEqual(r["activation_count"], 1)
        self.assertEqual(r["reforeground_episodes"], 1)
        self.assertFalse(r["current_active_foreground"])

    def test_brief_activation_is_positive_failure_even_if_no_duration(self):
        e = CheckerEngine(origin=0, replay=True)
        e.desktop({"kind": "desktop", "event": "window_activated",
                   "window": "w1", "active": True}, now=0.99)
        add(e, active=False)
        self.assertEqual(report(e)["initial_background"], "failed")
        self.assertEqual(report(e)["activation_count"], 1)
        self.assertEqual(report(e)["completed_observable_total_ms"]["active"], 0)

    def test_multiple_preadd_activations_are_counted_and_retained(self):
        e = CheckerEngine(origin=0, replay=True)
        e.desktop({"kind": "desktop", "event": "window_activated", "window": "w1"}, now=0.8)
        e.desktop({"kind": "desktop", "event": "window_activated", "window": "w1"}, now=0.9)
        emitted = add(e)
        self.assertEqual(emitted["activation_elapsed_ms"], 800)
        self.assertEqual(emitted["activation_buffered_count"], 2)
        self.assertEqual(report(e)["activation_count"], 2)
        self.assertEqual(report(e)["initial_background"], "failed")

    def test_visual_stack_not_conflated_with_active_or_user_intent(self):
        e = CheckerEngine(origin=0, replay=True)
        add(e)
        change(e, above_previous=True)
        r = report(e)
        self.assertEqual(r["initial_background"], "observed_background")
        self.assertEqual(r["background_verdict"], "later_foreground_observed")
        self.assertIs(r["current_visual_stack"], True)
        self.assertIs(r["current_active_foreground"], False)
        self.assertEqual(r["later_exposure_episodes"]["visual"], 1)
        self.assertEqual(r["later_exposure_episodes"]["active"], 0)
        self.assertNotIn("intent", json.dumps(r))

    def test_initial_visual_stack_fail_requires_visible_context(self):
        e = CheckerEngine(origin=0, replay=True)
        add(e, above_previous=True)
        self.assertEqual(report(e)["initial_background"], "failed")
        other = CheckerEngine(origin=0, replay=True)
        add(other, above_previous=True, on_current_activity=False)
        self.assertEqual(report(other)["initial_background"], "observed_background")
        last = CheckerEngine(origin=0, replay=True)
        add(last, above_previous=True, minimized=True)
        self.assertEqual(report(last)["initial_background"], "observed_background")

    def test_unknown_activity_and_flags_cannot_pass_as_background(self):
        e = CheckerEngine(origin=0, replay=True)
        add(e, on_current_activity=None, keep_above=None)
        e.native_capability({"status": "ready", "reason": "none"})
        e.desktop({"kind": "desktop", "event": "heartbeat", "sampling": HEALTHY}, now=2)
        r = report(e)
        # The below-prior stacking relation and inactive state are negative
        # evidence even if activity is unavailable; unknown topmost/activity
        # must still prevent a clean healthy no-foreground verdict.
        self.assertEqual(r["initial_background"], "observed_background")
        self.assertEqual(r["background_verdict"], "indeterminate")

    def test_healthy_no_foreground_is_observed_only_not_pixel_pass(self):
        e = CheckerEngine(origin=0, replay=True)
        e.native_capability({"status": "ready", "reason": "none"})
        add(e)
        e.desktop({"kind": "desktop", "event": "heartbeat", "sampling": HEALTHY}, now=2)
        self.assertEqual(report(e)["background_verdict"], "indeterminate")
        # Aggregate ticks from another candidate cannot assert this window's
        # complete lifetime. Terminal per-window coverage is required.
        change(e, "window_closed", at=2.1, active=False,
               window_sampling={"ticks": 20, "gaps": 0,
                                "max_gap_ms": 50, "complete": True})
        r = report(e)
        self.assertEqual(r["background_verdict"], "no_observed_foreground_at_50ms")
        self.assertEqual(r["window_sampling"]["ticks"], 20)
        self.assertTrue(r["complete_period_coverage"])
        self.assertEqual(r["sampling_resolution_ms"], 50)
        self.assertIn("never_first_pixel_pass", e.summary()["native_background"]["meaning"])

    def test_attention_topmost_flags_and_aggregate_counts(self):
        e = CheckerEngine(origin=0, replay=True)
        add(e)
        change(e, demands_attention=True, keep_above=True)
        change(e, demands_attention=False, keep_above=False)
        change(e, demands_attention=True, keep_above=True)
        r = report(e)
        self.assertEqual(r["attention_rises"], 2)
        self.assertEqual(r["topmost_rises"], 2)
        self.assertTrue(r["current"]["keep_above"])
        self.assertTrue(r["current"]["demands_attention"])
        aggregate = e.summary()["native_background"]
        self.assertEqual(aggregate["attention_rises"], 2)
        self.assertEqual(aggregate["topmost_rises"], 2)

    def test_gap_drop_and_close_cannot_create_clean_negative(self):
        e = CheckerEngine(origin=0, replay=True)
        add(e)
        e.native_capability({"status": "ready", "reason": "none"})
        e.desktop({"kind": "desktop", "event": "heartbeat", "sampling": HEALTHY}, now=2)
        e.source_health("native", "unknown", now=3)
        change(e, "window_closed", at=3.1, active=False)
        self.assertTrue(e.native_incomplete)
        self.assertEqual(report(e)["background_verdict"], "indeterminate")
        self.assertTrue(report(e)["closed"])
        self.assertTrue(report(e)["duration_uncertain"])

    def test_sampling_gap_sticky_failclosed_even_after_healthy(self):
        e = CheckerEngine(origin=0, replay=True)
        e.native_capability({"status": "ready", "reason": "none"})
        add(e)
        bad = dict(HEALTHY, gaps=1, healthy=False, max_gap_ms=200)
        e.desktop({"kind": "desktop", "event": "heartbeat", "sampling": bad}, now=2)
        e.desktop({"kind": "desktop", "event": "heartbeat", "sampling": HEALTHY}, now=3)
        self.assertTrue(e.native_incomplete)
        self.assertNotEqual(report(e)["background_verdict"], "no_observed_foreground_at_50ms")

    def test_redaction_decoder_and_native_capacity_bounds(self):
        base = {"kind": "desktop", "event": "window_added", "window": "w2",
                "browser": True, "wake_marker": False, "baseline": False,
                **FULL}
        self.assertIsNotNone(desktop._decode(json.dumps(base)))
        for key in ("caption", "resourceClass", "desktop_id", "app", "title", "contents"):
            self.assertIsNone(desktop._decode(json.dumps({**base, key: "private"})))
        self.assertIsNone(desktop._decode(json.dumps({**base, "window": "w257"})))
        self.assertIsNone(desktop._decode(json.dumps({**base, "keep_above": "yes"})))
        self.assertIsNone(desktop._decode(json.dumps({**base, "sampling": HEALTHY})))
        self.assertEqual(safe_capability({"status": "ready", "reason": "none",
                                         "sampling": dict(HEALTHY, gaps=1)})["reason"],
                         "coverage_incomplete")

    def test_missing_xdg_uses_exact_kwin_probe_without_wayland_claim(self):
        with mock.patch.dict("os.environ", {}, clear=True), \
             mock.patch.object(desktop.os.path, "isfile", return_value=True), \
             mock.patch.object(desktop.os, "access", return_value=True), \
             mock.patch.object(desktop, "_deps", return_value=("dbus", "mainloop", "glib")), \
             mock.patch.object(desktop, "_bus_probe", return_value=(
                 {"status": "ready", "reason": "none", "backend": "kde-kwin"}, ":1.33")) as probe:
            result = desktop.doctor()
            self.assertEqual(result["status"], "ready")
            self.assertEqual(result["platform_mode"], "uncertain")
            probe.assert_called_once()
        with mock.patch.dict("os.environ", {"XDG_SESSION_TYPE": "x11",
                                            "XDG_CURRENT_DESKTOP": "KDE"}, clear=True), \
             mock.patch.object(desktop.os.path, "isfile", return_value=True), \
             mock.patch.object(desktop.os, "access", return_value=True):
            result, deps = desktop._prerequisites()
            self.assertEqual(result["reason"], "not_wayland")
            self.assertIsNone(deps)

    def test_installed_status_cap_off_and_wait_cause_unknown(self):
        raw = {"workers": [{"label": "alpha", "contact": "recent"}],
               "wakes": [{"label": "alpha", "state": "claimed",
                          "failure_stage": "load", "failure_code": "page_changed"}],
               "jobs": [{"label": "alpha", "state": "queued"}],
               "wake_limits": {"daily_cap": 0, "daily_cap_status": "off",
                               "hourly_cap": 12, "attempts": 1,
                               "hourly_attempts": 1},
               "extension_poll": {"recent": True, "last_contact_at": 900},
               "capacity": {"claimed": 4, "limit": 4}}
        projection = project_status(raw, b"0" * 32, now_ms=1000)
        self.assertEqual(projection["limits"]["daily"]["mode"], "off")
        self.assertEqual(projection["limits"]["hourly"]["cap"], 12)
        self.assertTrue(projection["health"]["extension_poll_recent"])
        self.assertEqual(projection["health"]["extension_contact_age_ms"], 100)
        self.assertEqual(projection["health"]["extension_heartbeat"], "unknown")
        e = CheckerEngine(origin=0, replay=True)
        e.status(projection, now=2)
        self.assertTrue(e.current["capacity"]["at_limit"])
        self.assertIsNone(e.current["capacity_wait"]["count"])
        self.assertEqual(e.current["wake_pending_observed_lower_bound"], 1)

    def test_no_alias_join_when_canonical_label_differs(self):
        raw = {"workers": [{"label": "alpha~session-2"}],
               "wakes": [{"label": "alpha~session-2", "state": "claimed"}],
               "jobs": [{"label": "alpha", "state": "queued"}]}
        lanes = project_status(raw, b"a" * 32)["lanes"]
        self.assertEqual(len(lanes), 2)
        self.assertFalse(any(row["wakes"] and row["jobs"] for row in lanes))

    def test_native_replay_episode_equivalence(self):
        with tempfile.TemporaryDirectory() as home:
            home = str(Path(home).resolve())
            root = Path(home)
            src, dst = root / "src", root / "dst"
            e = CheckerEngine(Recorder(src), origin=0, replay=True)
            e.native_capability({"status": "ready", "reason": "none"})
            add(e, at=1)
            change(e, "window_activated", at=1.1, active=True)
            change(e, at=1.2, active=False, demands_attention=True)
            e.desktop({"kind": "desktop", "event": "heartbeat", "sampling": HEALTHY}, now=1.3)
            change(e, "window_closed", at=1.4, active=False)
            e.native_capability({"status": "unsupported", "reason": "closed", "closed": True})
            e.cleanup_result({"status": "ok"})
            expected = e.summary()
            e.recorder.close(expected)
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(cli.main(["replay", str(src / "events.jsonl"),
                                           "--output", str(dst)]), 0)
            actual = json.loads((dst / "summary.json").read_text())
            self.assertEqual(actual["native_background"], expected["native_background"])
            self.assertEqual(actual["capability"], expected["capability"])

    @unittest.skipUnless(shutil.which("node"), "Node unavailable")
    def test_vm_50ms_native_sampler(self):
        result = subprocess.run(
            ["node", str(ROOT / "tests" / "kwin_sampler_vm.ts"),
             str(ROOT / "kwin_observer.js")],
            capture_output=True, text=True, timeout=5, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("offline sampler VM:", result.stdout)


if __name__ == "__main__":
    unittest.main()
