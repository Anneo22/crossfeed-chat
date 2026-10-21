import json
import secrets
import unittest
from unittest.mock import patch

from tools.wake_checker.status import StatusError, parse_status, project_status
from tools.wake_checker.transport import TransportError, loopback_url, token_from_env, completion_once


class StatusTests(unittest.TestCase):
    def setUp(self):
        self.salt = secrets.token_bytes(32)
        self.raw = {
            "workers": [{"label": "test", "worker_session": "a" * 64,
                         "contact": "recent", "queued": 1, "awake": True}],
            "wakes": [{"label": "test", "worker_session": "a" * 64,
                       "state": "failed", "error": "private token and body",
                       "error_code": "page_changed", "stage": "load",
                       "nonce": "SECRET-TICKET"}],
            "jobs": [{"label": "test", "worker_session": "a" * 64, "id": "JOB_ID",
                      "state": "queued"}],
            "wake_limits": {"daily_cap": 30, "attempts": 2},
        }

    def test_projection_redacts_identifiers_and_errors(self):
        output = project_status(self.raw, self.salt)
        serialized = json.dumps(output)
        for forbidden in ("SECRET", "private", "JOB_ID", "a" * 64, '"test"'):
            self.assertNotIn(forbidden, serialized)
        self.assertEqual(output["lanes"][0]["diagnostics"], [{"stage": "load", "code": "page_changed"}])
        self.assertEqual(output["limits"]["hourly"]["cap"], None)
        self.assertEqual(output["limits"]["daily"]["attempts"], 2)

    def test_lane_fingerprint_unique_run(self):
        first = project_status(self.raw, self.salt)["lanes"][0]["lane"]
        self.assertNotEqual(first, project_status(self.raw, secrets.token_bytes(32))["lanes"][0]["lane"])

    def test_unknown_errors_not_logged(self):
        self.raw["wakes"][0]["error_code"] = "this is a secret"
        self.raw["wakes"][0]["stage"] = "private"
        output = project_status(self.raw, self.salt)
        self.assertEqual(output["lanes"][0]["diagnostics"][0], {"stage": "unknown", "code": "unknown"})

    def test_invalid_schema_bounded(self):
        with self.assertRaises(StatusError):
            parse_status(b"{" + b"a" * 300000 + b"}", self.salt)
        self.raw["workers"][0]["worker_session"] = "private"
        with self.assertRaises(StatusError):
            project_status(self.raw, self.salt)

    def test_url_refuses_dns_proxy_redirect_path(self):
        self.assertEqual(loopback_url("http://127.0.0.1:4319"), "http://127.0.0.1:4319")
        for bad in ("http://localhost:4319", "http://127.0.0.1:4319/status",
                    "http://127.0.0.1:4319@example.test", "https://127.0.0.1:4319",
                    "http://127.0.0.2:4319", "http://127.0.0.1:0",
                    "http://127.0.0.1:65536", "http://127.0.0.1:4319?x=y"):
            with self.subTest(bad=bad), self.assertRaises(TransportError):
                loopback_url(bad)

    def test_env_not_inspected_when_not_specified(self):
        with patch.dict("os.environ", {"CROSSFEED_API_KEY": "private"}, clear=True):
            with self.assertRaises(TransportError):
                token_from_env("CROSSFEED_API_KEY")

    def test_active_parameters_fail_before_network(self):
        with self.assertRaises(TransportError):
            completion_once("http://evil.com:80", "TOKEN" * 10, "chatgpt:alpha",
                            "x" * 32, "z" * 32)
        with self.assertRaises(TransportError):
            completion_once("http://127.0.0.1:4319", "TOKEN" * 10, "other:alpha",
                            "x" * 32, "z" * 32)


    def test_transport_uses_no_proxy_and_refuses_redirect(self):
        from tools.wake_checker import transport
        proxy = [h for h in transport._OPENER.handlers
                 if isinstance(h, transport.urllib.request.ProxyHandler)]
        self.assertTrue(all(h.proxies == {} for h in proxy))
        with self.assertRaises(TransportError):
            transport._NoRedirect().redirect_request(None, None, 302, "redirect", {},
                                                       "http://other.example/path")
        with patch.object(transport, "_request", side_effect=TransportError("redirect_refused")):
            with self.assertRaisesRegex(TransportError, "^redirect_refused$"):
                transport._get("http://127.0.0.1:4319", "safe" * 10, "/status")

    def test_get_status_request_is_only_authenticated_get_status(self):
        from tools.wake_checker import transport
        calls = []
        def fake(url, token, path, **kwargs):
            calls.append((url, token, path, kwargs))
            return b'{"workers":[],"wakes":[],"jobs":[]}'
        with patch.object(transport, "_request", side_effect=fake):
            result = transport.get_status("http://127.0.0.1:4319", "secret" * 6, self.salt)
        self.assertEqual(result["kind"], "status")
        self.assertEqual(calls[0][:3], ("http://127.0.0.1:4319", "secret" * 6, "/status"))
        with patch.object(transport, "_request", side_effect=TransportError("oversize")):
            with self.assertRaisesRegex(TransportError, "oversize"):
                transport._get("http://127.0.0.1:4319", "secret" * 6, "/status")

    def test_label_contract_completed_jobs_and_real_cooldown(self):
        from tools.wake_checker.status import lane_key
        self.assertTrue(lane_key({"label": "x" * 128}).startswith("x" * 128))
        self.assertTrue(lane_key({"label": "é" * 64}).startswith("é"))
        with self.assertRaises(StatusError):
            lane_key({"label": "x" * 129})
        self.raw["jobs"][0]["state"] = "completed"
        self.raw["workers"][0]["quota_until"] = 1200
        self.raw["wake_limits"]["cooldown_until"] = 800
        projection = project_status(self.raw, self.salt, now_ms=1000)
        self.assertEqual(projection["lanes"][0]["jobs"], {"completed": 1})
        self.assertTrue(projection["lanes"][0]["quota_active"])
        self.assertFalse(projection["limits"]["cooldown"])
        self.raw["wake_limits"]["cooldown_until"] = 1100
        self.assertTrue(project_status(self.raw, self.salt, now_ms=1000)["limits"]["cooldown"])
        del self.raw["wake_limits"]["cooldown_until"]
        self.assertIsNone(project_status(self.raw, self.salt, now_ms=1000)["limits"]["cooldown"])

    def test_socket_deadline_and_cancel_interrupt_silent_response(self):
        import socket
        import threading
        import time
        import concurrent.futures
        from tools.wake_checker.transport import Cancellation, _get
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.settimeout(3)
        server.bind(("127.0.0.1", 0))
        server.listen(2)
        port = server.getsockname()[1]
        received = threading.Event()
        finish = threading.Event()

        def listener():
            try:
                conn, _addr = server.accept()
                with conn:
                    conn.settimeout(3)
                    conn.recv(4096)
                    received.set()
                    finish.wait(3)
            except OSError:
                pass

        thread = threading.Thread(target=listener, daemon=True)
        thread.start()
        try:
            cancellation = Cancellation()
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                pending = executor.submit(_get, f"http://127.0.0.1:{port}", "x" * 32,
                                          "/status", timeout=10, cancel=cancellation)
                self.assertTrue(received.wait(2))
                began = time.monotonic()
                cancellation.cancel()
                with self.assertRaisesRegex(TransportError, "cancelled"):
                    pending.result(timeout=2)
                self.assertLess(time.monotonic() - began, 2)
        finally:
            finish.set()
            server.close()
            thread.join(timeout=2)

    def test_completion_timeout_above_30_and_uncertain_transport_error(self):
        from tools.wake_checker import transport
        import json
        challenge = "c" * 30
        with patch.object(transport, "_request", return_value=json.dumps({
                "choices": [{"message": {"content": challenge}}]}).encode()) as call:
            self.assertTrue(completion_once("http://127.0.0.1:4319", "t" * 32,
                    "chatgpt:example", "s" * 32, challenge, timeout=100))
        self.assertEqual(call.call_args.kwargs["timeout"], 100)
        self.assertEqual(call.call_args.kwargs["method"], "POST")

if __name__ == "__main__":
    unittest.main()
