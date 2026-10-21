"""Listener drain regression, using only a synthetic native callback fixture."""
import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tools.wake_checker import cli


class ListenerDrainTests(unittest.TestCase):
    def test_final_close_drains_queued_native_metadata(self):
        class Observer:
            def __init__(self, emit):
                self.emit = emit
                self.capability = {"status": "ready", "reason": "none"}
            def poll(self):
                return dict(self.capability)
            def close(self):
                # DBus callback already queued at the moment the observer
                # closes; it must not be dropped from the final run summary.
                self.emit({"kind": "desktop", "event": "window_added",
                           "window": "w1", "candidate": True,
                           "marker_confirmed": False, "baseline": False,
                           "initial": {
                               "active": False, "minimized": False,
                               "on_current_desktop": True, "above_previous": False,
                               "on_current_activity": True, "keep_above": False,
                               "keep_below": False, "demands_attention": False}})
                self.capability = {"status": "unsupported", "reason": "closed",
                                   "closed": True}
                return {"status": "ok", "reason": "none"}

        def start(_duration, emit):
            obs = Observer(emit)
            return obs, dict(obs.capability)

        with tempfile.TemporaryDirectory() as tmp:
            tmp = str(Path(tmp).resolve())
            output = Path(tmp) / "listen"
            with mock.patch.object(cli, "native_start", side_effect=start), \
                 contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(cli.main(["listen", "--duration", "1",
                                           "--output", str(output)]), 0)
            summary = json.loads((output / "summary.json").read_text())
            self.assertEqual(summary["counters"]["candidate_windows"], 1)
            self.assertEqual(summary["native_background"]["total_candidate_windows"], 1)
            self.assertEqual(summary["health"]["native"], "unsupported")
            self.assertEqual(summary["capability"]["reason"], "closed")
            self.assertEqual(summary["native_background"]["windows"][0]
                             ["background_verdict"], "indeterminate")


if __name__ == "__main__":
    unittest.main()
