"""On-demand, read-only KDE/KWin window-metadata transport.

No desktop or DBus dependency is imported at module import time. This is
metadata evidence, not a pixel/focus guarantee or proof of a Crossfeed wake.
Do not use this module to modify desktop/window state.
"""
from __future__ import annotations

import importlib
import json
import math
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import tempfile
import time

from tools.wake_checker.capabilities import FEATURES, safe_sampling, safe_capability, safe_window_sampling

_BACKEND = "kde-kwin"
_KWIN = "org.kde.KWin"
_INTERFACE = "org.crossfeed.WakeChecker.Observer"
_QDBUS = "/usr/bin/qdbus6"
_EVENTS = frozenset((
    "ready", "window_added", "window_activated", "window_changed",
    "window_closed", "desktop_changed", "activity_changed", "heartbeat",
    "capacity_changed",
))
_FEATURES = frozenset(FEATURES)
_REQUIRED_FEATURES = frozenset((
    "added", "removed", "activation", "caption", "minimized",
    "sampling_timer", "baseline", "transport", "ttl", "heartbeat",
))
_FIELDS = frozenset((
    "kind", "event", "window", "browser", "wake_marker", "active",
    "minimized", "on_current_desktop", "above_previous", "baseline",
    "native_ms", "capabilities", "capacity", "sampling", "window_sampling",
    "on_current_activity", "keep_above", "keep_below", "demands_attention",
))
_NULLABLE = ("active", "minimized", "on_current_desktop", "above_previous",
             "on_current_activity", "keep_above", "keep_below", "demands_attention")
_WINDOW = re.compile(r"w(?:[1-9]|[1-9][0-9]{1,2})\Z")
_SCRIPT_ID = re.compile(r"(?:0|[1-9][0-9]{0,7})\Z")
_PLUGIN = re.compile(r"crossfeed_checker_[0-9a-f]{24}\Z")


def _capability(status: str, reason: str) -> dict:
    return {"status": status, "reason": reason, "backend": _BACKEND}


def _deps():
    """Load optional bindings only after the KDE capability preflight."""
    dbus = importlib.import_module("dbus")
    importlib.import_module("dbus.service")
    mainloop = importlib.import_module("dbus.mainloop.glib")
    gi = importlib.import_module("gi")
    glib = importlib.import_module("gi.repository.GLib")
    return dbus, mainloop.DBusGMainLoop, glib


def _prerequisites():
    if not os.path.isfile(_QDBUS) or not os.access(_QDBUS, os.X_OK):
        return _capability("unsupported", "missing_qdbus"), None
    # Missing environment metadata is uncertainty, never proof of Wayland.
    # Explicitly incompatible values must not be bypassed by a KWin bus owner.
    session = os.environ.get("XDG_SESSION_TYPE", "").strip().lower()
    if session and session != "wayland":
        return {**_capability("unsupported", "not_wayland"),
                "platform_mode": "incompatible"}, None
    desktop = os.environ.get("XDG_CURRENT_DESKTOP", "").upper()
    if desktop and not any(value in ("KDE", "PLASMA") for value in desktop.split(":")):
        return {**_capability("unsupported", "not_kde"),
                "platform_mode": "incompatible"}, None
    try:
        deps = _deps()
    except (ImportError, AttributeError):
        return _capability("unsupported", "missing_python_bindings"), None
    return _capability("ready", "none"), deps


def _bus_probe(dbus, mainloop):
    """DBus owner and read-only introspection; never loads or runs scripts."""
    bus = dbus.SessionBus(private=True, mainloop=mainloop(set_as_default=False))
    try:
        owner = str(bus.get_name_owner(_KWIN))
        if not re.fullmatch(r":[0-9]+\.[0-9]+", owner):
            return _capability("unsupported", "kwin_unavailable"), None
        proxy = bus.get_object(_KWIN, "/Scripting", introspect=False)
        introspectable = dbus.Interface(proxy, "org.freedesktop.DBus.Introspectable")
        xml = str(introspectable.Introspect(timeout=1.0))
        if ('name="loadScript"' not in xml or
                'name="unloadScript"' not in xml):
            return _capability("unsupported", "scripting_unavailable"), None
        return _capability("ready", "none"), owner
    except Exception:
        return _capability("unsupported", "scripting_unavailable"), None
    finally:
        try:
            bus.close()
        except Exception:
            pass


def _platform_mode():
    session = os.environ.get("XDG_SESSION_TYPE", "").strip().lower()
    desktop = os.environ.get("XDG_CURRENT_DESKTOP", "").upper().split(":")
    return ("explicit_wayland_kde" if session == "wayland" and
            any(value in ("KDE", "PLASMA") for value in desktop) else "uncertain")


def doctor() -> dict:
    """Read-only exact session-bus KWin probe; no script loads."""
    capability, deps = _prerequisites()
    if deps is None:
        return capability
    dbus, mainloop, _glib = deps
    checked, _owner = _bus_probe(dbus, mainloop)
    return {**checked, "platform_mode": _platform_mode()}


def _decode(payload: str):
    """Allowlisted, bounded, non-identifying payload from one trusted sender."""
    if not isinstance(payload, str) or len(payload) > 2048:
        return None
    try:
        record = json.loads(payload)
    except (ValueError, TypeError):
        return None
    if not isinstance(record, dict):
        return None
    if not set(record).issubset(_FIELDS):
        return None
    if not {
        "kind", "event", "window", "browser", "wake_marker", "active",
        "minimized", "on_current_desktop", "above_previous", "baseline"
    }.issubset(record):
        return None
    if record["kind"] != "desktop" or record["event"] not in _EVENTS:
        return None
    window = record["window"]
    if window is not None:
        if not isinstance(window, str) or not _WINDOW.fullmatch(window):
            return None
        if int(window[1:]) > 256:
            return None
    for key in ("browser", "wake_marker", "baseline"):
        if type(record[key]) is not bool:
            return None
    for key in _NULLABLE:
        if record.get(key) is not None and type(record[key]) is not bool:
            return None
    if record["baseline"] and record["wake_marker"]:
        return None
    if "sampling" in record:
        if record["event"] not in ("ready", "heartbeat") or safe_sampling(record["sampling"]) is None:
            return None
    if "window_sampling" in record:
        if window is None or safe_window_sampling(record["window_sampling"]) is None:
            return None
        if record["window_sampling"]["complete"] and record["event"] != "window_closed":
            return None
    if record["event"] in ("heartbeat", "desktop_changed", "activity_changed",
                           "capacity_changed") and window is not None:
        return None
    if "capacity" in record:
        cap = record["capacity"]
        if (record["event"] not in ("ready", "heartbeat", "capacity_changed") or
                not isinstance(cap, dict) or
                set(cap) != {"limit", "tracked", "overflow", "unknown"} or
                type(cap["limit"]) is not int or cap["limit"] != 256 or
                any(type(cap[k]) is not int or not 0 <= cap[k] <= 1000000000
                    for k in ("tracked", "overflow", "unknown")) or
                cap["tracked"] > cap["limit"] or cap["unknown"] > cap["overflow"]):
            return None
    elif record["event"] in ("ready", "capacity_changed"):
        return None
    if "native_ms" in record:
        n = record["native_ms"]
        if type(n) not in (int, float) or not math.isfinite(n) or not 0 <= n < 1e15:
            return None
    if record["event"] == "ready":
        caps = record.get("capabilities")
        if not isinstance(caps, dict) or set(caps) != _FEATURES:
            return None
        if any(value is not None and type(value) is not bool for value in caps.values()):
            return None
    elif "capabilities" in record:
        return None
    return record


def _receiver_class(dbus):
    """Keep dbus.service out of offline/core imports."""
    class Receiver(dbus.service.Object):
        def __init__(self, bus_name, path, observer):
            self._observer = observer
            super().__init__(bus_name, path)

        @dbus.service.method(_INTERFACE, in_signature="s", out_signature="",
                             sender_keyword="sender")
        def Push(self, payload, sender=None):
            self._observer._receive(str(payload), str(sender) if sender else None)

    return Receiver


def _command(*args):
    # Fixed absolute binary and fixed KWin method paths; never shell=True.
    try:
        result = subprocess.run([_QDBUS, _KWIN, *args], shell=False,
                                capture_output=True, timeout=2.0, check=False)
        if result.returncode != 0 or len(result.stdout) > 128:
            return None
        return result.stdout.decode("ascii", "strict").strip()
    except (OSError, subprocess.TimeoutExpired, UnicodeError):
        return None


class DesktopObserver:
    """Owned, finite DBus service and KWin scripting adapter for one run."""

    def __init__(self, duration, emit):
        self.duration = duration
        self.emit = emit
        self.capability = _capability("unsupported", "not_started")
        self._bus = None
        self._name = None
        self._receiver = None
        self._context = None
        self._owner = None
        self._temp = None
        self._plugin = None
        self._load_attempted = False
        self._ready = None
        self._last_heartbeat = None
        self._deadline = None
        self._started = False
        self._closed = False
        self._cleanup = None
        self._capacity = None

    def _mark_unavailable(self, status, reason):
        # Preserve last verified signal/capacity evidence when runtime health
        # degrades; status and reason are authoritative, never silently ready.
        health = dict(self.capability)
        health.update(status=status, reason=reason)
        self.capability = health

    def _receive(self, payload, sender):
        if self._closed or not self._bus or sender != self._owner:
            return
        try:
            if str(self._bus.get_name_owner(_KWIN)) != self._owner:
                self._mark_unavailable("unsupported", "owner_changed")
                return
        except Exception:
            self._mark_unavailable("unsupported", "owner_changed")
            return
        packet = _decode(payload)
        if packet is None:
            # A verified owner's unparseable packet is lost observation, not
            # harmless traffic. It must invalidate any clean negative result.
            # Never echo the untrusted payload or reopen this observer.
            self._mark_unavailable("unsupported", "coverage_incomplete")
            self.close()
            return
        now = time.monotonic()
        if packet["event"] == "ready":
            if self._ready is not None:
                return
            caps = packet["capabilities"]
            self._ready = _capability(
                "ready" if all(caps.get(k) is True for k in _REQUIRED_FEATURES)
                else "unsupported",
                "none" if all(caps.get(k) is True for k in _REQUIRED_FEATURES)
                else ("ttl_unavailable" if caps.get("ttl") is not True or caps.get("heartbeat") is not True
                      else "missing_signals"),
            )
            self._ready["capabilities"] = dict(caps)
            self._ready["platform_mode"] = _platform_mode()
            self._ready["stacking_mode"] = (
                "signal" if caps["stacking"] is True else
                "targeted_50ms" if caps["stacking_sampled"] is True else "unavailable"
            )
            self._last_heartbeat = now
        elif self._ready is None or self._ready["status"] != "ready":
            return
        elif packet["event"] == "heartbeat":
            self._last_heartbeat = now
        if "sampling" in packet:
            # Sampling cadence is independent of workspace signal availability.
            if self._ready is not None:
                self._ready = safe_capability({**self._ready, "sampling": packet["sampling"]})
            if self.capability["status"] == "ready":
                self.capability = safe_capability({**self.capability, "sampling": packet["sampling"]})
        if "capacity" in packet:
            self._capacity = dict(packet["capacity"])
            if self._ready is not None:
                self._ready = safe_capability({**self._ready, "capacity": self._capacity})
            if self.capability["status"] == "ready":
                self.capability = safe_capability({**self.capability, "capacity": self._capacity})
        # An unsupported ready is health evidence, not a ready notification.
        if packet["event"] == "ready" and self._ready["status"] != "ready":
            return
        # Emit only schema-validated metadata. Subscriber exceptions cannot
        # break DBus delivery or expose private exception text.
        try:
            self.emit(packet)
        except Exception:
            pass

    def poll(self) -> dict:
        """Deliver bounded metadata, returning current health including closure."""
        if self._closed:
            return dict(self.capability)
        if self._context is not None:
            started = time.monotonic()
            for _ in range(32):
                try:
                    if not self._context.pending():
                        break
                    self._context.iteration(False)
                except Exception:
                    self._mark_unavailable("error", "internal_error")
                    self.close()
                    return dict(self.capability)
                if time.monotonic() - started >= 0.03:
                    break
        now = time.monotonic()
        if self._bus is not None and self._owner is not None:
            try:
                owner_unchanged = str(self._bus.get_name_owner(_KWIN)) == self._owner
            except Exception:
                owner_unchanged = False
            if not owner_unchanged:
                self._mark_unavailable("unsupported", "owner_changed")
        if self.capability["reason"] == "owner_changed":
            self.close()
            return dict(self.capability)
        if self._ready is not None and self._ready["status"] == "ready":
            if self._last_heartbeat is not None and now - self._last_heartbeat > 3.5:
                self._mark_unavailable("unsupported", "heartbeat_expired")
                self.close()
                return dict(self.capability)
        if self._deadline is not None and now >= self._deadline:
            self.close()
        return dict(self.capability)

    def start(self) -> dict:
        if self._started or self._closed:
            return _capability("error", "already_started")
        self._started = True
        if (type(self.duration) not in (int, float) or
                not math.isfinite(self.duration) or
                not 1 <= self.duration <= 3600 or not callable(self.emit)):
            self.capability = _capability("error", "invalid_duration")
            return dict(self.capability)
        capability, deps = _prerequisites()
        if deps is None:
            self.capability = capability
            return dict(self.capability)
        dbus, mainloop, glib = deps
        capability, owner = _bus_probe(dbus, mainloop)
        if owner is None:
            self.capability = capability
            return dict(self.capability)
        self._owner = owner
        try:
            self._bus = dbus.SessionBus(private=True, mainloop=mainloop(set_as_default=False))
            if str(self._bus.get_name_owner(_KWIN)) != owner:
                raise RuntimeError("owner_changed")
            token = secrets.token_hex(12)
            self._plugin = "crossfeed_checker_" + token
            if not _PLUGIN.fullmatch(self._plugin):
                raise RuntimeError("invalid_plugin")
            service = "org.crossfeed.WakeChecker.i" + token
            path = "/org/crossfeed/WakeChecker/i" + token
            self._name = dbus.service.BusName(
                service, bus=self._bus, do_not_queue=True,
                allow_replacement=False, replace_existing=False)
            # Export on the bus, not on BusName: the receiver must not hold
            # the BusName after our own reference is dropped during close.
            self._receiver = _receiver_class(dbus)(self._bus, path, self)
            self._context = glib.MainContext.default()

            template = Path(__file__).with_name("kwin_observer.js").read_text(encoding="utf-8")
            for key, value in (
                ("__SERVICE__", json.dumps(service)),
                ("__OBJECT__", json.dumps(path)),
                ("__INTERFACE__", json.dumps(_INTERFACE)),
                ("__TTL_MS__", str(int(self.duration * 1000))),
            ):
                if template.count(key) != 1:
                    raise RuntimeError("invalid_template")
                template = template.replace(key, value)
            self._temp = tempfile.mkdtemp(prefix="crossfeed-kwin-")
            os.chmod(self._temp, 0o700)
            script = os.path.join(self._temp, "observer.js")
            fd = os.open(script, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as out:
                out.write(template)
            self._load_attempted = True
            loaded = _command("/Scripting", "org.kde.kwin.Scripting.loadScript",
                              script, self._plugin)
            if loaded is None or not _SCRIPT_ID.fullmatch(loaded):
                self.capability = _capability("unsupported", "load_failed")
                return self._failed()
            running = _command("/Scripting/Script" + loaded, "org.kde.kwin.Script.run")
            if running is None or running.lower() in ("false", "0"):
                self.capability = _capability("unsupported", "run_failed")
                return self._failed()
            # Nothing counts as ready until trusted DBus callback is received.
            end = time.monotonic() + 2.0
            while self._ready is None and time.monotonic() < end:
                self.poll()
                if self.capability["reason"] == "owner_changed":
                    break
                time.sleep(0.01)
            if self._ready is None:
                if self.capability["reason"] != "owner_changed":
                    self.capability = _capability("unsupported", "delivery_timeout")
                return self._failed()
            self.capability = dict(self._ready)
            if self.capability["status"] != "ready":
                return self._failed()
            self._deadline = time.monotonic() + float(self.duration)
            return dict(self.capability)
        except Exception:
            self.capability = _capability("error", "internal_error")
            return self._failed()

    def _failed(self):
        result = dict(self.capability)
        cleanup = self.close()
        if cleanup["status"] != "ok":
            result = _capability("error", "cleanup_failed")
        result["closed"] = True
        self.capability = result
        return dict(result)

    def close(self) -> dict:
        if self._closed:
            return dict(self._cleanup)
        self._closed = True
        failed = False
        unload = "not_attempted"
        if self._load_attempted and self._plugin and _PLUGIN.fullmatch(self._plugin):
            unloaded = _command("/Scripting", "org.kde.kwin.Scripting.unloadScript",
                                self._plugin)
            if unloaded is None or unloaded.lower() in ("false", "0"):
                failed = True
                unload = "command_failed"
            else:
                unload = "command_succeeded"
        receiver = self._receiver
        self._receiver = None
        if receiver is not None:
            try:
                receiver.remove_from_connection()
            except Exception:
                failed = True
            # Break receiver -> observer references even on unexport failure.
            receiver._observer = None
        del receiver
        # dbus.service.BusName has no release() API. Its documented lifetime
        # releases the DBus name in __del__ via bus.release_name(). The
        # receiver was exported directly on the Bus, so no remaining service
        # object reference should defer this until after bus.close().
        self._name = None
        if self._bus is not None:
            try:
                self._bus.close()
            except Exception:
                failed = True
        self._bus = None
        self._context = None
        self._owner = None
        if self._temp:
            try:
                shutil.rmtree(self._temp)
            except Exception:
                failed = True
        self._temp = None
        self._plugin = None
        if self.capability.get("status") == "ready":
            self._mark_unavailable("unsupported", "closed")
        self.capability["closed"] = True
        self._cleanup = {
            "status": "error" if failed else "ok",
            "reason": "cleanup_failed" if failed else "none",
            "backend": _BACKEND,
            "unload": unload,
        }
        return dict(self._cleanup)
