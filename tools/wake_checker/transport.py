"""Bounded no-proxy, no-redirect loopback HTTP. No implicit config lookup."""
import http.client
import json
import os
import re
import socket
import threading
import time
import urllib.error
import urllib.request

from .status import MAX_STATUS_BYTES, StatusError, parse_status, valid_label

URL_RE = re.compile(r"^http://127\.0\.0\.1:([0-9]{1,5})$")
ENV_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")


def valid_model(model):
    return type(model) is str and model.startswith("chatgpt:") and valid_label(model[8:])


class TransportError(ValueError):
    """Fixed safe error category only."""


def loopback_url(value):
    match = URL_RE.fullmatch(value or "")
    if not match or not 1 <= int(match.group(1)) <= 65535:
        raise TransportError("invalid_loopback_url")
    return value


def token_from_env(name):
    if not ENV_RE.fullmatch(name or ""):
        raise TransportError("invalid_token_env_name")
    token = os.environ.get(name)
    if not token or not 32 <= len(token) <= 256 or not re.fullmatch(r"[A-Za-z0-9._~-]+", token):
        raise TransportError("missing_or_invalid_token")
    return token


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise TransportError("redirect_refused")


_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())


class Cancellation:
    """Tracks sockets and interrupts all in-flight reads on stop."""
    def __init__(self):
        self.stop = threading.Event()
        self.lock = threading.Lock()
        self.active = set()

    def add(self, sock):
        with self.lock:
            if self.stop.is_set():
                raise TransportError("cancelled")
            self.active.add(sock)

    def remove(self, sock):
        with self.lock:
            self.active.discard(sock)

    def cancel(self):
        self.stop.set()
        with self.lock:
            active = tuple(self.active)
        for sock in active:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                sock.close()
            except OSError:
                pass


def _request(url, token, path, *, method="GET", payload=None, timeout=2,
             limit=MAX_STATUS_BYTES, cancel=None, extra_headers=None):
    loopback_url(url)
    if not 0 < timeout <= 755:
        raise TransportError("invalid_timeout")
    if cancel is not None and cancel.stop.is_set():
        raise TransportError("cancelled")
    port = int(url.rsplit(":", 1)[1])
    deadline = time.monotonic() + timeout
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=min(2, timeout))
    sock = None
    finished = threading.Event()

    def watchdog():
        while not finished.is_set():
            if (cancel is not None and cancel.stop.is_set()) or time.monotonic() >= deadline:
                if sock is not None:
                    try:
                        sock.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
                return
            finished.wait(min(0.1, max(0, deadline - time.monotonic())))

    try:
        sock = socket.create_connection(("127.0.0.1", port), timeout=min(2, timeout))
        if cancel is not None:
            cancel.add(sock)
        connection.sock = sock
        sock.settimeout(timeout)
        threading.Thread(target=watchdog, name="wake-http-deadline", daemon=True).start()
        headers = {"Authorization": "Bearer " + token, "Accept": "application/json",
                   "Connection": "close"}
        if payload is not None:
            headers["Content-Type"] = "application/json"
        if extra_headers:
            headers.update(extra_headers)
        connection.request(method, path, body=payload, headers=headers)
        response = connection.getresponse()
        if 300 <= response.status <= 399:
            raise TransportError("redirect_refused")
        if response.status in (401, 403):
            raise TransportError("auth_error")
        if response.status != 200:
            raise TransportError("http_error")
        if response.headers.get_content_type() != "application/json":
            raise TransportError("invalid_content_type")
        body = response.read(limit + 1)
        if len(body) > limit:
            raise TransportError("oversize")
        if time.monotonic() >= deadline:
            raise TransportError("timeout")
        if cancel is not None and cancel.stop.is_set():
            raise TransportError("cancelled")
        return body
    except TransportError:
        raise
    except (OSError, ValueError, http.client.HTTPException):
        raise TransportError("cancelled" if cancel is not None and cancel.stop.is_set()
                             else "timeout" if time.monotonic() >= deadline else "unreachable") from None
    finally:
        finished.set()
        if sock is not None and cancel is not None:
            cancel.remove(sock)
        connection.close()


def _get(url, token, path, *, timeout=2, limit=MAX_STATUS_BYTES, cancel=None):
    return _request(url, token, path, timeout=timeout, limit=limit, cancel=cancel)


def get_status(url, token, salt, *, timeout=2, cancel=None):
    try:
        return parse_status(_get(url, token, "/status", timeout=timeout, cancel=cancel), salt)
    except StatusError as exc:
        raise TransportError(str(exc)) from None


def completion_once(url, token, model, session, challenge, *, timeout=300, cancel=None):
    """Exactly one scoped cold completion; compare exact content in memory only."""
    loopback_url(url)
    if not valid_model(model):
        raise TransportError("invalid_model")
    if not re.fullmatch(r"[A-Za-z0-9._~-]{32,128}", session):
        raise TransportError("invalid_session")
    if not re.fullmatch(r"[A-Za-z0-9_-]{20,80}", challenge):
        raise TransportError("invalid_challenge")
    if not 0 < timeout <= 755:
        raise TransportError("invalid_timeout")
    payload = json.dumps({"model": model, "stream": False, "messages": [
        {"role": "user", "content": "Reply with exactly this token and no other characters: " + challenge}
    ]}, separators=(",", ":")).encode()
    body = _request(url, token, "/v1/chat/completions", method="POST",
                    payload=payload, timeout=timeout, cancel=cancel,
                    extra_headers={"X-Crossfeed-Session": session})
    try:
        answer = json.loads(body)["choices"][0]["message"]["content"]
        if type(answer) is not str:
            raise ValueError()
    except (ValueError, KeyError, IndexError, TypeError):
        raise TransportError("invalid_completion") from None
    return answer == challenge
