import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.wake_checker import cli


class CLITests(unittest.TestCase):
    def test_doctor_no_network_or_native_load(self):
        with patch.object(cli, "native_doctor", return_value={"status": "unsupported",
                         "reason": "adapter_missing", "backend": "kde-kwin"}):
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(cli.main(["doctor"]), 0)
        self.assertEqual(json.loads(output.getvalue())["native"]["status"], "unsupported")

    def test_native_missing_module(self):
        with patch.object(cli.importlib, "import_module", side_effect=ImportError()):
            self.assertEqual(cli.native_doctor()["status"], "unsupported")
            self.assertEqual(cli.native_start(1, lambda event: None)[1]["status"], "unsupported")

    def test_active_requires_explicit_cold_count_and_consent(self):
        for argv in (
            ["listen", "--duration", "1", "--probe-model", "chatgpt:alpha"],
            ["listen", "--duration", "1", "--probe-model", "chatgpt:alpha",
             "--allow-active-probe", "--status-url", "http://127.0.0.1:4319"],
            ["listen", "--duration", "1", "--probe-model", "chatgpt:alpha",
             "--allow-active-probe", "--status-url", "http://127.0.0.1:4319", "--probe-count", "5"],
            ["listen", "--duration", "3601"],
            ["listen", "--duration", "1", "--screenshots"],
        ):
            with self.subTest(argv=argv), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(cli.main(argv), 2)

    def test_passive_listen_closes_and_never_accesses_backend(self):
        with tempfile.TemporaryDirectory() as d:
            d = str(Path(d).resolve())
            output = Path(d) / "run"
            with patch.object(cli, "native_start", return_value=(None, {"status": "unsupported",
                         "reason": "adapter_missing", "backend": "kde-kwin"})):
                with contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(cli.main(["listen", "--duration", "1", "--output", str(output)]), 0)
            self.assertTrue((output / "summary.json").exists())
            summary = json.loads((output / "summary.json").read_text())
            self.assertEqual(summary["health"]["native"], "unsupported")
            self.assertEqual(summary["health"]["status"], "unsupported")
            self.assertEqual(summary["counters"]["backend_exact"], 0)

    def test_sanitized_replay(self):
        with tempfile.TemporaryDirectory() as d:
            d = str(Path(d).resolve())
            path = Path(d) / "input.jsonl"
            path.write_text(json.dumps({"kind": "status", "lanes": [
                {"lane": "e" * 16, "wakes": {"queued": 1}}]}) + "\n" +
                json.dumps({"kind": "status", "lanes": [
                    {"lane": "e" * 16, "wakes": {"queued": 1}}]}) + "\n")
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(cli.main(["replay", str(path), "--output", str(Path(d)/"out"),
                                           "--sample-seconds", "20"]), 0)
            result = json.loads((Path(d)/"out"/"summary.json").read_text())
            self.assertGreater(result["counters"]["threshold_crossings"], 0)

    def test_replay_rejects_untrusted_lane(self):
        with tempfile.TemporaryDirectory() as d:
            d = str(Path(d).resolve())
            source = Path(d) / "in.jsonl"
            source.write_text(json.dumps({"kind": "status", "lanes": [
                {"lane": "secret session", "wakes": {"queued": 1}}]}) + "\n")
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(cli.main(["replay", str(source), "--output", str(Path(d)/"out")]), 2)


    def test_ctrl_c_cleanup(self):
        class Observer:
            closed = False
            def poll(self):
                return None
            def close(self):
                self.closed = True
                return {"status": "ready"}
        with tempfile.TemporaryDirectory() as d:
            d = str(Path(d).resolve())
            obs = Observer()
            with patch.object(cli, "native_start", return_value=(
                    obs, {"status": "ready", "reason": "ready", "backend": "kde-kwin"}
            )), patch.object(cli.time, "sleep", side_effect=KeyboardInterrupt):
                with contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(cli.main(["listen", "--duration", "10",
                                               "--output", str(Path(d) / "run")]), 0)
            self.assertTrue(obs.closed)
            rows = (Path(d) / "run" / "events.jsonl").read_text()
            self.assertIn("keyboard_interrupt", rows)

    def test_own_event_replay_preserves_counters_state_timing_and_limits(self):
        from tools.wake_checker.engine import CheckerEngine, Recorder
        with tempfile.TemporaryDirectory() as d:
            d = str(Path(d).resolve())
            origin = Path(d) / "origin"
            out = Path(d) / "replayed"
            e = CheckerEngine(Recorder(origin), origin=0, replay=True, thresholds=(15, 60, 180))
            e.emit({"kind": "run_config", "status_max_gap_seconds": 12})
            e.native_capability({"status": "ready", "reason": "none"})
            state = {"kind": "status", "lanes": [{
                "lane": "a" * 16, "wakes": {"queued": 2, "failed": 1},
                "worker": "stale", "queued": 3, "jobs": {"completed": 1, "queued": 2},
                "diagnostics": [{"stage": "load", "code": "page_changed"}]}],
                "limits": {"hourly": {"cap": None, "attempts": None},
                           "daily": {"cap": 30, "attempts": 2}, "cooldown": True},
                "health": {"status": "ready", "host": False, "extension_enabled": True,
                           "extension_heartbeat": "unknown", "extension_heartbeat_age_ms": None}}
            e.status(state, now=0)
            e.emit(state, now=0)
            e.desktop({"kind": "desktop", "event": "window_added", "window": "w1",
                       "browser": True, "baseline": False, "wake_marker": True,
                       "active": False, "native_ms": 1800000000000}, now=1.2)
            e.desktop({"kind": "desktop", "event": "window_activated", "window": "w1",
                       "active": True}, now=1.3)
            e.cdp({"target": "f" * 16, "scope": "new_chatgpt_target",
                   "observation": {"ready": True, "composer": True, "generating": False,
                                   "login": False, "error": False, "dialog": False,
                                   "permission": False}}, now=1.4)
            e.status(state, now=16)
            e.emit(state, now=16)
            e.probe(exact=True, baseline_candidates=0, native_ready=True, cdp_ready=True,
                    dispatched_ms=1000, completed_ms=17000)
            e.source_health("status", "auth_error", now=17)
            e.cleanup_result({"status": "ok"})
            summary = e.summary()
            e.recorder.close(summary)
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(cli.main(["replay", str(origin / "events.jsonl"),
                                           "--output", str(out)]), 0)
            restored = json.loads((out / "summary.json").read_text())
            for key in ("health", "counters", "current", "pending", "probes",
                        "capability", "cleanup", "records"):
                self.assertEqual(restored[key], summary[key], key)
            self.assertEqual(restored["probes"][0]["duration_ms"], 16000)
            self.assertEqual(restored["probes"][0]["first_added_after_dispatch_ms"], 200)
            self.assertEqual(restored["probes"][0]["first_activation_after_dispatch_ms"], 300)

    def test_replay_rejects_injected_nested_private_fields_and_fake_timestamps(self):
        with tempfile.TemporaryDirectory() as d:
            d = str(Path(d).resolve())
            src = Path(d) / "events"
            for idx, row in enumerate((
                {"kind": "status", "lanes": [{"lane": "a" * 16,
                                            "wakes": {"queued": 1}, "jobs": {"completed": 1},
                                            "credentials": "private"}]},
                {"kind": "desktop", "event": "window_added", "window": "w1",
                 "initial": {"active": True, "caption": "private"}},
                {"kind": "status", "seq": 4, "elapsed_ms": 2, "lanes": []},
            )):
                src.write_text(json.dumps(row) + "\n")
                with contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(cli.main(["replay", str(src),
                                               "--output", str(Path(d) / ("out" + str(idx)))]), 2)

    def test_unsupported_native_ready_event_cannot_enable_probe_dispatch(self):
        class Observer:
            closed = False
            def close(self):
                self.closed = True
                return {"status": "ok", "reason": "none"}
            def poll(self):
                raise AssertionError("unsupported observer must never be polled")
        with tempfile.TemporaryDirectory() as d:
            d = str(Path(d).resolve())
            obs = Observer()
            with patch.object(cli, "native_start", return_value=(
                obs, {"status": "unsupported", "reason": "heartbeat_expired"})), patch.object(
                cli, "token_from_env", return_value="dummy"), patch.object(
                cli, "get_status", return_value={"kind": "status", "lanes": [],
                       "limits": {}, "health": {}}), patch.object(
                cli, "completion_once") as active, contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(cli.main(["listen", "--duration", "1", "--poll-interval", "1",
                                           "--status-url", "http://127.0.0.1:4319",
                                           "--probe-model", "chatgpt:valid",
                                           "--allow-active-probe", "--output",
                                           str(Path(d) / "run")]), 0)
            active.assert_not_called()
            summary = json.loads((Path(d) / "run" / "summary.json").read_text())
            self.assertEqual(summary["health"]["native"], "unsupported")
            self.assertEqual(summary["capability"]["reason"], "heartbeat_expired")
            self.assertTrue(obs.closed)

    def test_silent_native_heartbeat_failure_and_cleanup_error(self):
        class Observer:
            def __init__(self):
                self.capability = {"status": "ready", "reason": "none"}
            def poll(self):
                self.capability = {"status": "unsupported", "reason": "heartbeat_expired"}
            def close(self):
                return {"status": "error", "reason": "cleanup_failed"}
        with tempfile.TemporaryDirectory() as d:
            d = str(Path(d).resolve())
            observer = Observer()
            with patch.object(cli, "native_start", return_value=(
                observer, {"status": "ready", "reason": "none"})), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(cli.main(["listen", "--duration", "1",
                                           "--output", str(Path(d) / "run")]), 0)
            summary = json.loads((Path(d) / "run" / "summary.json").read_text())
            self.assertEqual(summary["health"]["native"], "error")
            self.assertEqual(summary["cleanup"]["reason"], "cleanup_failed")
            self.assertEqual(summary["capability"]["reason"], "heartbeat_expired")

    def test_sigterm_during_native_start_restores_handler_and_summary(self):
        import signal
        old = signal.getsignal(signal.SIGTERM)
        def start(*_args):
            signal.getsignal(signal.SIGTERM)(signal.SIGTERM, None)
        with tempfile.TemporaryDirectory() as d:
            d = str(Path(d).resolve())
            with patch.object(cli, "native_start", side_effect=start), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(cli.main(["listen", "--duration", "1",
                                           "--output", str(Path(d) / "run")]), 0)
            self.assertIs(signal.getsignal(signal.SIGTERM), old)
            rows = (Path(d) / "run" / "events.jsonl").read_text()
            self.assertIn('"reason":"sigterm"', rows)

    def test_inflight_status_shutdown_cancels_all_work(self):
        import threading
        from tools.wake_checker.transport import TransportError
        begun = threading.Event()
        ended = threading.Event()
        def waiting_status(_url, _token, _salt, *, timeout, cancel):
            begun.set()
            if not cancel.stop.wait(3):
                raise AssertionError("request must be cancelled")
            ended.set()
            raise TransportError("cancelled")
        with tempfile.TemporaryDirectory() as d:
            d = str(Path(d).resolve())
            with patch.object(cli, "native_start", return_value=(
                None, {"status": "unsupported", "reason": "adapter_missing"})), patch.object(
                cli, "token_from_env", return_value="dummy"), patch.object(
                cli, "get_status", side_effect=waiting_status), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(cli.main(["listen", "--duration", "1",
                                           "--status-url", "http://127.0.0.1:4319",
                                           "--output", str(Path(d) / "run")]), 0)
            self.assertTrue(begun.is_set())
            self.assertTrue(ended.is_set())

    def test_probe_default_count_and_timeout_options(self):
        import argparse
        args = argparse.Namespace(status_url="http://127.0.0.1:4319", cdp_url=None,
                screenshots=False, target_id=None, probe_model="chatgpt:test",
                allow_active_probe=True, probe_count=None)
        cli.validate_options(args)
        self.assertEqual(args.probe_count, 1)
        args.probe_model = None
        with self.assertRaisesRegex(ValueError, "active_probe"):
            cli.validate_options(args)
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(cli.main(["listen", "--probe-count", "1"]), 2)
            self.assertEqual(cli.main(["listen", "--probe-timeout", "756"]), 2)

if __name__ == "__main__":
    unittest.main()
