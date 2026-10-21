"""Optional bounded read-only Chrome DevTools observation.

No browser launch, debugging activation, page navigation, interaction, storage,
cookies, arbitrary page text, extension APIs, or desktop screen capture.
"""
import base64
import hashlib
import http.client
import json
import os
import re
import secrets
import socket
import struct
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

from .transport import _NoRedirect, loopback_url, Cancellation
from .status import fingerprint

WS_RE = re.compile(r"^ws://127\.0\.0\.1:([0-9]{1,5})/devtools/page/([A-Za-z0-9_-]{1,160})$")
TARGET_RE = re.compile(r"^[A-Za-z0-9_-]{1,160}$")
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
MAX_CDP_LIST = 65536
MAX_WS_FRAME = 1572864

# No value from a text node or from a browser credential context is returned.
DOM_QUERY = """(() => {
  // A target can navigate between /json/list and Runtime.evaluate.
  // Never even query DOM selectors on a foreign origin.
  if (location.origin !== 'https://chatgpt.com')
    return {origin: location.origin};
  const count = s => document.querySelectorAll(s).length;
  const composer = count('#prompt-textarea, [contenteditable="true"][role="textbox"]');
  const dialogs = count('[role="dialog"], dialog[open]');
  return {
    origin: location.origin,
    frame_url: location.href,
    nav_epoch: performance.timeOrigin,
    ready: document.readyState === 'complete' || document.readyState === 'interactive',
    composer: composer > 0, composer_count: Math.min(composer,100),
    generating: count('button[aria-label="Stop generating"],button[data-testid="stop-button"]') > 0,
    login: count('form[action*="login"],input[autocomplete="current-password"]') > 0,
    error: count('[role="alert"]') > 0,
    dialog: dialogs > 0, dialog_count: Math.min(dialogs,100),
    permission: count('[data-testid*="permission"],[aria-modal="true"]') > 0
  };
})()"""


class CDPError(ValueError):
    """Fixed safe error only."""


def websocket_endpoint(url, status_url):
    loopback_url(status_url)
    match = WS_RE.fullmatch(url or "")
    if not match or int(match.group(1)) != int(status_url.rsplit(":", 1)[1]):
        raise CDPError("foreign_websocket")
    return int(match.group(1)), "/devtools/page/" + match.group(2)


def _chatgpt_target(row):
    if not isinstance(row, dict) or row.get("type") != "page":
        return False
    url = row.get("url")
    if not isinstance(url, str) or len(url) > 4096:
        return False
    try:
        parsed = urlsplit(url)
        return parsed.scheme == "https" and parsed.hostname == "chatgpt.com" and parsed.port in (None, 443) and not parsed.username and not parsed.password
    except ValueError:
        return False


def list_targets(url):
    loopback_url(url)
    port = int(url.rsplit(":", 1)[1])
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
    sock = None
    finished = threading.Event()
    deadline = time.monotonic() + 2

    def watchdog():
        if not finished.wait(max(0, deadline - time.monotonic())) and sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    try:
        sock = socket.create_connection(("127.0.0.1", port), timeout=2)
        connection.sock = sock
        sock.settimeout(2)
        threading.Thread(target=watchdog, daemon=True).start()
        connection.request("GET", "/json/list", headers={"Connection": "close"})
        resp = connection.getresponse()
        if resp.status != 200 or resp.headers.get_content_type() != "application/json":
            raise CDPError("cdp_unavailable")
        data = resp.read(MAX_CDP_LIST + 1)
        if len(data) > MAX_CDP_LIST:
            raise CDPError("cdp_oversize")
        rows = json.loads(data)
        if not isinstance(rows, list) or len(rows) > 100:
            raise CDPError("cdp_invalid_schema")
        result = {}
        for row in rows:
            if not _chatgpt_target(row):
                continue
            ident = row.get("id")
            if not isinstance(ident, str) or not TARGET_RE.fullmatch(ident):
                continue
            ws = row.get("webSocketDebuggerUrl")
            try:
                _port, ws_path = websocket_endpoint(ws, url)
                if ws_path != "/devtools/page/" + ident:
                    continue
            except CDPError:
                continue
            result[ident] = ws
        return result
    except CDPError:
        raise
    except (urllib.error.URLError, TimeoutError, OSError, ValueError, http.client.HTTPException):
        raise CDPError("cdp_unavailable") from None
    finally:
        finished.set()
        connection.close()


class ReadOnlyWebSocket:
    def __init__(self, endpoint, base_url, *, cancel=None):
        port, path = websocket_endpoint(endpoint, base_url)
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=2)
        self.cancel = cancel
        if cancel is not None:
            cancel.add(self.sock)
        self.deadline = time.monotonic() + 3
        self.sock.settimeout(2)
        key = base64.b64encode(secrets.token_bytes(16)).decode()
        request = ("GET " + path + " HTTP/1.1\r\nHost: 127.0.0.1:" + str(port) +
                   "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: " +
                   key + "\r\n\r\n").encode()
        try:
            self.sock.sendall(request)
            headers = bytearray()
            while b"\r\n\r\n" not in headers and len(headers) < 4096:
                self._set_timeout()
                block = self.sock.recv(512)
                if not block:
                    break
                headers.extend(block)
            expected = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest())
            if not bytes(headers).startswith(b"HTTP/1.1 101 ") or b"sec-websocket-accept: " + expected.lower() not in bytes(headers).lower():
                raise CDPError("websocket_handshake")
            if bytes(headers).split(b"\r\n\r\n", 1)[1]:
                raise CDPError("websocket_extra_data")
        except Exception:
            self.close()
            raise CDPError("websocket_handshake") from None

    def close(self):
        if self.cancel is not None:
            self.cancel.remove(self.sock)
        self.sock.close()

    def _set_timeout(self):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise CDPError("cdp_timeout")
        self.sock.settimeout(min(2, remaining))

    def _read(self, count):
        data = bytearray()
        while len(data) < count:
            self._set_timeout()
            try:
                part = self.sock.recv(count - len(data))
            except socket.timeout:
                raise CDPError("cdp_timeout") from None
            if not part:
                raise CDPError("websocket_closed")
            data.extend(part)
        return bytes(data)

    def _frame(self, opcode, payload):
        if len(payload) > 8192:
            raise CDPError("websocket_send_oversize")
        mask = secrets.token_bytes(4)
        n = len(payload)
        header = bytes([0x80 | opcode, 0x80 | n]) if n < 126 else bytes([0x80 | opcode, 0x80 | 126]) + struct.pack("!H", n)
        self._set_timeout()
        self.sock.sendall(header + mask + bytes(x ^ mask[i % 4] for i, x in enumerate(payload)))

    def command(self, method, params):
        if method not in ("Runtime.evaluate", "Page.captureScreenshot"):
            raise CDPError("method_refused")
        payload = json.dumps({"id": 1, "method": method, "params": params}, separators=(",", ":")).encode()
        self.deadline = time.monotonic() + 3
        self._frame(1, payload)
        for _ in range(32):
            header = self._read(2)
            if not header[0] & 0x80 or header[0] & 0x70:
                raise CDPError("invalid_websocket_frame")  # FIN required; RSV forbidden
            opcode, masked = header[0] & 15, bool(header[1] & 128)
            size = header[1] & 127
            if size == 126:
                size = struct.unpack("!H", self._read(2))[0]
            elif size == 127:
                size = struct.unpack("!Q", self._read(8))[0]
            if size > MAX_WS_FRAME or masked or (opcode >= 8 and size > 125):
                raise CDPError("invalid_websocket_frame")
            packet = self._read(size)
            if opcode == 9:
                self._frame(10, packet)
                continue
            if opcode == 8:
                raise CDPError("websocket_closed")
            if opcode == 10:
                continue
            if opcode != 1:
                raise CDPError("invalid_websocket_frame")
            try:
                response = json.loads(packet)
                if not isinstance(response, dict):
                    raise ValueError()
                if response.get("id") == 1:
                    if "error" in response:
                        raise CDPError("cdp_command_failed")
                    return response.get("result")
            except (ValueError, TypeError):
                raise CDPError("cdp_invalid_json") from None
        raise CDPError("cdp_response_missing")


def inspect_target(ws_url, base_url, *, screenshot_path=None, cancel=None):
    connection = ReadOnlyWebSocket(ws_url, base_url) if cancel is None else ReadOnlyWebSocket(ws_url, base_url, cancel=cancel)

    def evaluate():
        result = connection.command("Runtime.evaluate", {
            "expression": DOM_QUERY, "returnByValue": True, "awaitPromise": False,
            "userGesture": False, "silent": True})
        value = result.get("result", {}).get("value") if isinstance(result, dict) else None
        if not isinstance(value, dict):
            raise CDPError("dom_unsupported")
        if value.get("origin") != "https://chatgpt.com":
            raise CDPError("foreign_origin")
        return value

    try:
        value = evaluate()
        frame_url, nav_epoch = value.get("frame_url"), value.get("nav_epoch")
        names = ("ready", "composer", "generating", "login", "error", "dialog", "permission")
        if not all(type(value.get(x)) is bool for x in names):
            raise CDPError("dom_unsupported")
        observation = {x: value[x] for x in names}
        for name in ("composer_count", "dialog_count"):
            count = value.get(name)
            if type(count) is not int or not 0 <= count <= 100:
                raise CDPError("dom_unsupported")
            observation[name] = count
        if screenshot_path is not None:
            if (not isinstance(frame_url, str) or len(frame_url) > 4096
                    or not _chatgpt_target({"type": "page", "url": frame_url})
                    or urlsplit(frame_url).path != "/"
                    or type(nav_epoch) not in (int, float)):
                raise CDPError("screenshot_scope_refused")
            image = connection.command("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False})
            try:
                png = base64.b64decode(image["data"], validate=True)
            except (TypeError, ValueError, KeyError):
                raise CDPError("screenshot_invalid") from None
            if len(png) > 1048576 or not png.startswith(b"\x89PNG\r\n\x1a\n"):
                raise CDPError("screenshot_invalid")
            # Never save pixels if the inspected frame navigated off-site
            # while the screenshot command was being processed.
            after = evaluate()
            if after.get("frame_url") != frame_url or after.get("nav_epoch") != nav_epoch:
                raise CDPError("screenshot_navigation_changed")
            fd = os.open(screenshot_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
            with os.fdopen(fd, "wb") as fp:
                fp.write(png)
        observation["classification"] = "structural_indicators_unverified"
        return observation
    finally:
        connection.close()


class CDPObserver:
    def __init__(self, url, *, target_id=None, screenshots=False, run_dir=None, salt=None):
        self.url = loopback_url(url)
        if target_id is not None and not TARGET_RE.fullmatch(target_id):
            raise CDPError("invalid_target")
        self.target_id = target_id
        self.screenshots = screenshots
        self.run_dir = Path(run_dir) if run_dir is not None else None
        self.salt = salt if salt is not None else secrets.token_bytes(32)
        self.cancel = Cancellation()
        self.baseline_ids = set()
        self.shot_targets = set()
        self.tracked = {}
        self.missing = set()
        self.shots = 0
        self.cursor = 0
        self.ready = False

    def start(self):
        self.baseline_ids = set(list_targets(self.url))
        self.ready = True
        return {"status": "ready", "reason": "read_only_baseline"}

    def close(self):
        self.cancel.cancel()
        self.ready = False

    def poll(self):
        if not self.ready or self.cancel.stop.is_set():
            return []
        # Per-cycle bounds prevent a growing target list from stalling listen.
        began = time.monotonic()
        targets = list_targets(self.url)
        candidates = sorted((ident, ws) for ident, ws in targets.items()
                            if (ident not in self.baseline_ids or ident == self.target_id)
                            and (self.target_id is None or ident == self.target_id))
        lost = []
        active_ids = {ident for ident, _ in candidates}
        for ident, scope in self.tracked.items():
            if ident not in active_ids and ident not in self.missing:
                lost.append({"error_code": "target_missing",
                             "target": fingerprint(self.salt, "cdp:" + ident), "scope": scope})
                self.missing.add(ident)
        if not candidates:
            return lost
        selected = [candidates[(self.cursor + n) % len(candidates)]
                    for n in range(min(4, len(candidates)))]
        self.cursor = (self.cursor + len(selected)) % len(candidates)
        result = list(lost)
        for ident, ws in selected:
            if self.cancel.stop.is_set():
                break
            if time.monotonic() - began >= 10:
                break
            token = fingerprint(self.salt, "cdp:" + ident)
            scope = "fixture_existing" if ident in self.baseline_ids else "new_chatgpt_target"
            self.tracked[ident] = scope
            self.missing.discard(ident)
            screenshot_path = None
            if (self.screenshots and ident not in self.shot_targets and self.shots < 4
                    and self.run_dir is not None):
                self.shots += 1
                self.shot_targets.add(ident)
                screenshot_path = self.run_dir / ("browser-viewport-" + str(self.shots) + ".png")
            try:
                observed = inspect_target(ws, self.url, screenshot_path=screenshot_path,
                                          cancel=self.cancel)
                result.append({"observation": observed, "target": token, "scope": scope})
            except (CDPError, OSError, ValueError) as exc:
                error = str(exc)
                allowed = ("foreign_origin", "dom_unsupported", "cdp_timeout",
                           "screenshot_invalid", "screenshot_scope_refused",
                           "screenshot_navigation_changed", "invalid_websocket_frame",
                           "target_missing")
                result.append({"error_code": error if error in allowed else "cdp_target_error",
                               "target": token, "scope": scope})
        return result
