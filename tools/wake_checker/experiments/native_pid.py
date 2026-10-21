"""Opt-in finite KWin PID attribution experiment; never loaded by production.

Only the host-approved PID allowlist enters a private temporary KWin script.
No PID, caption, class string, window handle, profile or command line is logged.
The host MUST review this file before authorizing a real KWin probe.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import stat
import tempfile
import time
from typing import Any

from tools.wake_checker import desktop

PROTOCOL = "native-pid-v1"
MAX_EVENTS = 1024
ID = re.compile(r"w([1-9][0-9]{0,2})\Z")
EVENTS = frozenset(("baseline", "added", "changed", "closed"))
WINDOW_KEYS = frozenset((
    "protocol", "event", "window", "baseline", "closed", "browser",
    "has_pid", "owner_match", "normal_window", "tooltip", "dialog",
    "active", "keep_above", "demands_attention",
))
STATUS_KEYS = frozenset((
    "protocol", "event", "calibrated", "baseline_positive_count",
    "baseline_truncated", "tracked", "events_dropped",
))
NULLABLE = ("normal_window", "tooltip", "dialog",
            "active", "keep_above", "demands_attention")


def valid_packet(payload: str) -> dict | None:
    """Strict field allowlist prevents raw identifiers from leaving receiver."""
    if type(payload) is not str or len(payload) > 1400:
        return None
    try:
        record = json.loads(payload)
    except (ValueError, TypeError):
        return None
    if type(record) is not dict or record.get("protocol") != PROTOCOL:
        return None
    event = record.get("event")
    if event in EVENTS:
        if record.keys() != WINDOW_KEYS:
            return None
        match = ID.fullmatch(record["window"]) if type(record["window"]) is str else None
        if not match or int(match.group(1)) > 256:
            return None
        if any(type(record[key]) is not bool for key in ("baseline", "closed", "browser", "has_pid")):
            return None
        if record["closed"] is not (event == "closed"):
            return None
        match_value = record["owner_match"]
        if (record["has_pid"] and type(match_value) is not bool or
                not record["has_pid"] and match_value is not None):
            return None
        if any(record[key] is not None and type(record[key]) is not bool for key in NULLABLE):
            return None
    elif event in ("ready", "done"):
        required = STATUS_KEYS | ({"timer"} if event == "ready" else set())
        if record.keys() != required:
            return None
        if type(record["calibrated"]) is not bool or type(record["baseline_truncated"]) is not bool:
            return None
        if any(type(record[key]) is not int or not 0 <= record[key] <= bound
               for key, bound in (("baseline_positive_count", 256),
                                  ("tracked", 256), ("events_dropped", 1000000000))):
            return None
        if record["calibrated"] is not (record["baseline_positive_count"] > 0):
            return None
        if event == "ready":
            if type(record["timer"]) is not dict or record["timer"].keys() != {
                    "added", "removed", "baseline", "ttl"}:
                return None
            if any(type(value) is not bool for value in record["timer"].values()):
                return None
    else:
        return None
    return record


def validate_args(pids: list[int], duration: int, output: Path) -> None:
    if not 1 <= len(pids) <= 32 or any(type(pid) is not int or
            pid <= 0 or pid > 2147483647 for pid in pids):
        raise ValueError("owner-pid must be 1..2147483647; 1..32 values")
    if len(pids) != len(set(pids)):
        raise ValueError("owner-pid values must be unique")
    if type(duration) is not int or not 1 <= duration <= 600:
        raise ValueError("duration must be 1..600 seconds")
    if not output.is_absolute():
        raise ValueError("output must be an absolute path")
    if output.exists() or output.is_symlink() or not output.name.endswith(".json"):
        raise ValueError("output must be a new .json file")
    parent = output.parent
    st = parent.stat()
    if (not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid() or
            stat.S_IMODE(st.st_mode) & 0o077):
        raise ValueError("output parent directory must be private (owner-only)")


def private_report(output: Path, result: dict) -> None:
    # O_NOFOLLOW and O_EXCL: cannot overwrite an existing or symlinked file.
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(result, stream, indent=2, sort_keys=True)
            stream.write("\n")
    except BaseException:
        try:
            output.unlink()
        except OSError:
            pass
        raise


class Probe:
    def __init__(self, pids: list[int], duration: int):
        self.pids = tuple(pids)
        self.duration = duration
        self.events: list[dict] = []
        self.ready: dict | None = None
        self.done: dict | None = None
        self.bus = self.name = self.receiver = self.context = None
        self.owner = self.plugin = self.temp = None
        self.load_attempted = False
        self.closed = False
        self.status = "unavailable"
        self.reason = "not_started"
        self.cleanup: dict = {"status": "not_started", "unload": "not_attempted"}

    def _receive(self, payload: str, sender: str | None) -> None:
        if self.closed or self.bus is None or sender != self.owner:
            return
        try:
            if str(self.bus.get_name_owner(desktop._KWIN)) != self.owner:
                return
        except Exception:
            return
        item = valid_packet(payload)
        if item is None:
            return
        if item["event"] == "ready":
            if self.ready is None:
                self.ready = item
        elif self.ready is None:
            return
        elif item["event"] == "done":
            self.done = item
        elif len(self.events) < MAX_EVENTS:
            self.events.append(item)

    def poll(self) -> None:
        if self.context is None:
            return
        started = time.monotonic()
        for _ in range(32):
            if time.monotonic() - started >= 0.025:
                break
            if not self.context.pending():
                break
            self.context.iteration(False)

    def start(self) -> bool:
        # All platform imports/checks are deferred until explicitly invoked.
        cap, deps = desktop._prerequisites()
        if deps is None:
            self.reason = cap["reason"]
            return False
        dbus, mainloop, glib = deps
        cap, owner = desktop._bus_probe(dbus, mainloop)
        if owner is None:
            self.reason = cap["reason"]
            return False
        self.owner = owner
        try:
            self.bus = dbus.SessionBus(private=True, mainloop=mainloop(set_as_default=False))
            if str(self.bus.get_name_owner(desktop._KWIN)) != owner:
                self.reason = "owner_changed"
                return False
            token = secrets.token_hex(12)
            self.plugin = "crossfeed_checker_" + token
            service = "org.crossfeed.WakeChecker.i" + token
            path = "/org/crossfeed/WakeChecker/i" + token
            self.name = dbus.service.BusName(
                service, bus=self.bus, do_not_queue=True,
                allow_replacement=False, replace_existing=False)
            # Same already-vetted private callback interface, own unique service.
            self.receiver = desktop._receiver_class(dbus)(self.bus, path, self)
            self.context = glib.MainContext.default()
            source = Path(__file__).with_suffix(".js").read_text(encoding="utf-8")
            owner_set = {str(pid): True for pid in self.pids}
            for key, value in (
                ("__SERVICE__", json.dumps(service)),
                ("__OBJECT__", json.dumps(path)),
                ("__INTERFACE__", json.dumps(desktop._INTERFACE)),
                ("__TTL_MS__", str(self.duration * 1000)),
                ("__OWNERS__", json.dumps(owner_set, separators=(",", ":"))),
            ):
                if source.count(key) != 1:
                    self.reason = "template_invalid"
                    return False
                source = source.replace(key, value)
            self.temp = tempfile.mkdtemp(prefix="crossfeed-native-pid-")
            os.chmod(self.temp, 0o700)
            script = os.path.join(self.temp, "native_pid.js")
            fd = os.open(script, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as out:
                out.write(source)
            self.load_attempted = True
            loaded = desktop._command(
                "/Scripting", "org.kde.kwin.Scripting.loadScript", script, self.plugin)
            if loaded is None or not desktop._SCRIPT_ID.fullmatch(loaded):
                self.reason = "load_failed"
                return False
            running = desktop._command(
                "/Scripting/Script" + loaded, "org.kde.kwin.Script.run")
            if running is None or running.lower() in ("false", "0"):
                self.reason = "run_failed"
                return False
            deadline = time.monotonic() + 2.0
            while self.ready is None and time.monotonic() < deadline:
                self.poll()
                time.sleep(0.01)
            if self.ready is None:
                self.reason = "ready_timeout"
                return False
            if not all(self.ready["timer"].values()):
                self.reason = "missing_required_capability"
                return False
            self.status = "ready"
            self.reason = "none"
            return True
        except Exception:
            self.reason = "startup_error"
            return False

    def run(self) -> dict:
        interrupted = False
        try:
            if self.start():
                end = time.monotonic() + self.duration
                while self.done is None and time.monotonic() < end:
                    self.poll()
                    if self.bus is not None:
                        try:
                            if str(self.bus.get_name_owner(desktop._KWIN)) != self.owner:
                                self.status = "unavailable"
                                self.reason = "owner_changed"
                                break
                        except Exception:
                            self.status = "unavailable"
                            self.reason = "owner_changed"
                            break
                    time.sleep(0.025)
                self.poll()
                if self.done is None and self.status == "ready":
                    self.status = "incomplete"
                    self.reason = "no_terminal_signal"
        except KeyboardInterrupt:
            interrupted = True
            self.status = "interrupted"
            self.reason = "sigint"
        except Exception:
            self.status = "error"
            self.reason = "probe_error"
        finally:
            self.close()
        calibrated = self.ready["calibrated"] if self.ready is not None else False
        if self.status == "ready" and not calibrated:
            self.status = "uncalibrated"
            self.reason = "no_positive_baseline_pid"
        if self.cleanup["status"] != "ok":
            self.status = "error"
            self.reason = "cleanup_failed"
        return {
            "schema": PROTOCOL, "status": self.status, "reason": self.reason,
            "pid_getter_availability": ("observed_positive_baseline" if calibrated
                                        else "unknown"),
            "owner_match_interpretation": ("calibrated" if calibrated else "uncalibrated"),
            "duration_limit_seconds": self.duration,
            "ready": self.ready, "done": self.done, "events": self.events,
            "captured_events": len(self.events),
            "controller_buffer_truncated": len(self.events) == MAX_EVENTS,
            "cleanup": self.cleanup, "interrupted": interrupted,
        }

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        failed = False
        unload = "not_attempted"
        if self.load_attempted and self.plugin is not None:
            try:
                value = desktop._command(
                    "/Scripting", "org.kde.kwin.Scripting.unloadScript", self.plugin)
                if value is None or value.lower() in ("false", "0"):
                    failed = True
                    unload = "command_failed"
                else:
                    unload = "command_succeeded"
            except Exception:
                failed = True
                unload = "command_failed"
        if self.receiver is not None:
            try:
                self.receiver.remove_from_connection()
            except Exception:
                failed = True
            self.receiver._observer = None
        self.receiver = None
        self.name = None
        if self.bus is not None:
            try:
                self.bus.close()
            except Exception:
                failed = True
        self.bus = self.context = self.owner = None
        if self.temp is not None:
            try:
                shutil.rmtree(self.temp)
            except Exception:
                failed = True
        self.temp = self.plugin = None
        self.cleanup = {"status": "error" if failed else "ok", "unload": unload}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--owner-pid", type=int, required=True, action="append",
                        help="Host-verified process ID; repeat for each approved PID")
    parser.add_argument("--duration", type=int, required=True, help="1..600 seconds")
    parser.add_argument("--output", type=Path, required=True,
                        help="New absolute .json path under an owner-only directory")
    args = parser.parse_args(argv)
    try:
        validate_args(args.owner_pid, args.duration, args.output)
    except (OSError, ValueError) as exc:
        parser.error(str(exc))
    prior = signal.getsignal(signal.SIGTERM)
    def terminate(_sig: int, _frame: Any) -> None:
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, terminate)
    try:
        result = Probe(args.owner_pid, args.duration).run()
        private_report(args.output, result)
    finally:
        signal.signal(signal.SIGTERM, prior)
    print("private report written; status=" + result["status"])
    return 0 if result["status"] == "ready" else 2


if __name__ == "__main__":
    raise SystemExit(main())
