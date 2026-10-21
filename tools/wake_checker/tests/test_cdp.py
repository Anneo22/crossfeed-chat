import unittest
from unittest.mock import patch

from tools.wake_checker.cdp import (CDPError, CDPObserver, _chatgpt_target,
                                    websocket_endpoint, list_targets, ReadOnlyWebSocket)


class CDPTests(unittest.TestCase):
    def test_endpoint_restrictions(self):
        valid = "ws://127.0.0.1:9222/devtools/page/ABC-23"
        self.assertEqual(websocket_endpoint(valid, "http://127.0.0.1:9222")[0], 9222)
        for invalid in ("ws://evil.com:9222/devtools/page/ABC-23",
                        "wss://127.0.0.1:9222/devtools/page/ABC-23",
                        "ws://127.0.0.1:9000/devtools/page/ABC-23",
                        "ws://127.0.0.1:9222/devtools/browser/ABC-23",
                        "ws://user@127.0.0.1:9222/devtools/page/ABC-23",
                        "ws://127.0.0.1:9222/devtools/page/ABC-23?token=secret"):
            with self.subTest(invalid=invalid), self.assertRaises(CDPError):
                websocket_endpoint(invalid, "http://127.0.0.1:9222")

    def test_foreign_target_rejected(self):
        self.assertTrue(_chatgpt_target({"type": "page", "url": "https://chatgpt.com/c/abc"}))
        for url in ("https://evil.com", "https://chatgpt.com.evil.com",
                    "http://chatgpt.com", "https://evil.com@example.test/",
                    "https://chatgpt.com:444/"):
            self.assertFalse(_chatgpt_target({"type": "page", "url": url}))

    def test_new_only_after_baseline_and_fixture_exception(self):
        obs = CDPObserver("http://127.0.0.1:9222")
        old = "ws://127.0.0.1:9222/devtools/page/old"
        fresh = "ws://127.0.0.1:9222/devtools/page/new"
        with patch("tools.wake_checker.cdp.list_targets", side_effect=[
            {"old": old}, {"old": old, "new": fresh}, {"old": old, "new": fresh}]), patch(
                "tools.wake_checker.cdp.inspect_target",
                return_value={"ready": True, "composer": True}) as inspect:
            self.assertEqual(obs.start()["status"], "ready")
            one, two = obs.poll(), obs.poll()
            self.assertEqual(len(one), 1)
            self.assertEqual(len(two), 1)
            self.assertEqual(one[0]["target"], two[0]["target"])
            self.assertEqual(one[0]["scope"], "new_chatgpt_target")
            self.assertEqual(inspect.call_count, 2)
            inspect.assert_called_with(fresh, obs.url, screenshot_path=None, cancel=obs.cancel)

    def test_command_allowlist_refuses_mutation(self):
        ws = object.__new__(ReadOnlyWebSocket)
        with self.assertRaises(CDPError):
            ws.command("Page.navigate", {"url": "https://chatgpt.com"})


    def test_target_missing_then_recovery_and_fixture_scope(self):
        old = "ws://127.0.0.1:9222/devtools/page/old"
        fresh = "ws://127.0.0.1:9222/devtools/page/new"
        obs = CDPObserver("http://127.0.0.1:9222", target_id="old")
        with patch("tools.wake_checker.cdp.list_targets", side_effect=[
             {"old": old}, {"old": old, "new": fresh}, {}, {"old": old}]), patch(
             "tools.wake_checker.cdp.inspect_target", return_value={"ready": False, "composer": False}):
            obs.start()
            initial = obs.poll()
            self.assertEqual(len(initial), 1)
            self.assertEqual(initial[0]["scope"], "fixture_existing")
            self.assertEqual(obs.poll()[0]["error_code"], "target_missing")
            recovered = obs.poll()
            self.assertEqual(len(recovered), 1)
            self.assertEqual(recovered[0]["target"], initial[0]["target"])

    def test_inspect_target_rejects_foreign_origin_and_navigation_before_screenshot(self):
        import base64
        import tempfile
        from pathlib import Path
        from tools.wake_checker.cdp import inspect_target
        good = dict(origin="https://chatgpt.com", frame_url="https://chatgpt.com/",
                    nav_epoch=12345, ready=True, composer=True,
                    generating=False, login=False, error=False, dialog=False,
                    permission=False, composer_count=1, dialog_count=0)
        bad = {**good, "origin": "https://foreign.example"}
        class FakeWS:
            def __init__(self, *a):
                self.calls = 0
            def command(self, method, params):
                self.calls += 1
                if method == "Page.captureScreenshot":
                    return {"data": base64.b64encode(bytes.fromhex("89504e470d0a1a0a")).decode()}
                return {"result": {"value": good if self.calls == 1 else bad}}
            def close(self):
                pass
        with tempfile.TemporaryDirectory() as home:
            home = str(Path(home).resolve())
            dest = Path(home) / "image.png"
            with patch("tools.wake_checker.cdp.ReadOnlyWebSocket", FakeWS):
                with self.assertRaisesRegex(CDPError, "foreign_origin"):
                    inspect_target("ws://127.0.0.1:9222/devtools/page/a",
                                   "http://127.0.0.1:9222", screenshot_path=dest)
            self.assertFalse(dest.exists())
        class BadWS(FakeWS):
            def command(self, method, params):
                return {"result": {"value": bad}}
        with patch("tools.wake_checker.cdp.ReadOnlyWebSocket", BadWS):
            with self.assertRaisesRegex(CDPError, "foreign_origin"):
                inspect_target("ws://127.0.0.1:9222/devtools/page/a",
                               "http://127.0.0.1:9222")

    def test_websocket_refuses_non_fin_and_rsv_frames(self):
        for invalid in (b"\\x01\\x00", b"\\xc1\\x00", b"\\x89\\x7e"):
            socket_obj = object.__new__(ReadOnlyWebSocket)
            with patch.object(ReadOnlyWebSocket, "_frame"), patch.object(
                 ReadOnlyWebSocket, "_read", return_value=invalid):
                with self.assertRaises(CDPError):
                    socket_obj.command("Runtime.evaluate", {"expression": "fixed"})

    def test_per_target_error_does_not_permanently_suppress_sampling(self):
        obs = CDPObserver("http://127.0.0.1:9222")
        fresh = "ws://127.0.0.1:9222/devtools/page/new"
        with patch("tools.wake_checker.cdp.list_targets", side_effect=[
             {}, {"new": fresh}, {"new": fresh}]), patch(
             "tools.wake_checker.cdp.inspect_target",
             side_effect=[CDPError("dom_unsupported"), {"ready": True, "composer": True}]):
            obs.start()
            self.assertEqual(obs.poll()[0]["error_code"], "dom_unsupported")
            self.assertTrue(obs.poll()[0]["observation"]["composer"])

    def test_screenshot_rejects_private_chat_and_same_origin_navigation(self):
        import base64
        import tempfile
        from pathlib import Path
        from tools.wake_checker.cdp import inspect_target
        template = {"origin": "https://chatgpt.com", "frame_url": "https://chatgpt.com/",
                    "nav_epoch": 100, "ready": True, "composer": True,
                    "composer_count": 1, "dialog_count": 0, "generating": False,
                    "login": False, "error": False, "dialog": False, "permission": False}

        class Fake:
            def __init__(self, *args):
                self.calls = 0
            def command(self, method, params):
                self.calls += 1
                if method == "Page.captureScreenshot":
                    return {"data": base64.b64encode(bytes.fromhex("89504e470d0a1a0a")).decode()}
                value = template if self.calls == 1 else {**template, "frame_url": "https://chatgpt.com/c/private"}
                return {"result": {"value": value}}
            def close(self):
                pass
        with tempfile.TemporaryDirectory() as d:
            d = str(Path(d).resolve())
            dest = Path(d) / "capture.png"
            with patch("tools.wake_checker.cdp.ReadOnlyWebSocket", Fake):
                with self.assertRaisesRegex(CDPError, "screenshot_navigation_changed"):
                    inspect_target("ws://127.0.0.1:9222/devtools/page/a",
                                   "http://127.0.0.1:9222", screenshot_path=dest)
            self.assertFalse(dest.exists())

        class Private(Fake):
            def command(self, method, params):
                if method == "Page.captureScreenshot":
                    raise AssertionError("private path may not be captured")
                return {"result": {"value": {**template,
                    "frame_url": "https://chatgpt.com/c/private"}}}
        with tempfile.TemporaryDirectory() as d:
            d = str(Path(d).resolve())
            dest = Path(d) / "capture.png"
            with patch("tools.wake_checker.cdp.ReadOnlyWebSocket", Private):
                with self.assertRaisesRegex(CDPError, "screenshot_scope_refused"):
                    inspect_target("ws://127.0.0.1:9222/devtools/page/a",
                                   "http://127.0.0.1:9222", screenshot_path=dest)
            self.assertFalse(dest.exists())

if __name__ == "__main__":
    unittest.main()
