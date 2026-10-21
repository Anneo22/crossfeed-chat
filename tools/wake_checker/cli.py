"""Bounded on-demand CLI: doctor, passive listen, sanitized replay."""
import argparse
import concurrent.futures
import importlib
import json
import os
import stat
import math
from contextlib import contextmanager
import queue
import secrets
import signal
import sys
import time
from pathlib import Path

from .cdp import CDPError, CDPObserver
from .capabilities import safe_capability, safe_window_sampling
from .engine import CheckerEngine, Recorder, MAX_LINE, HEALTH_STATES
from .status import PENDING, STATES, STAGES, ERROR_CODES, CONTACT, JOB_STATES
from .transport import (valid_model, Cancellation, TransportError, completion_once, get_status,
                        loopback_url, token_from_env)

MAX_REPLAY_BYTES = 16777216


def native_doctor():
    try:
        module = importlib.import_module(".desktop", __package__)
    except ImportError:
        return {"status": "unsupported", "reason": "adapter_missing", "backend": "kde-kwin"}
    try:
        result = module.doctor()  # Capability checks only; no script loaded.
        return safe_capability(result)
    except Exception:
        return {"status": "error", "reason": "adapter_failure", "backend": "kde-kwin"}


def native_start(duration, emit):
    try:
        module = importlib.import_module(".desktop", __package__)
    except ImportError:
        return None, {"status": "unsupported", "reason": "adapter_missing", "backend": "kde-kwin"}
    try:
        observer = module.DesktopObserver(duration, emit)
        return observer, safe_capability(observer.start())
    except BaseException as exc:
        if "observer" in locals():
            try:
                observer.close()
            except Exception:
                pass
        if not isinstance(exc, Exception):
            raise
        return None, {"status": "error", "reason": "adapter_failure", "backend": "kde-kwin"}


def _close_native(engine, observer):
    """Preserve cleanup separately, and never leave a closed collector ready."""
    try:
        result = observer.close()
    except Exception:
        result = {"status": "error", "reason": "cleanup_failed"}
    raw = getattr(observer, "capability", engine.capability)
    details = safe_capability({**raw, "closed": True})
    engine.native_capability(details)
    engine.cleanup_result(result)


def default_output():
    parent = Path.cwd() / ".wake-check-runs"
    if parent.is_symlink():
        raise ValueError("unsafe_output_parent")
    parent.mkdir(mode=0o700, exist_ok=True)
    parent.chmod(0o700)
    return parent / ("run-" + time.strftime("%Y%m%dT%H%M%S") + "-" + secrets.token_hex(6))


def create_engine(path):
    return CheckerEngine(Recorder(path if path is not None else default_output()))


def validate_options(args):
    if args.status_url:
        loopback_url(args.status_url)
    if args.cdp_url:
        loopback_url(args.cdp_url)
    if getattr(args, "screenshots", False) and not args.cdp_url:
        raise ValueError("screenshots_require_cdp")
    if getattr(args, "target_id", None) and not args.cdp_url:
        raise ValueError("target_requires_cdp")
    if getattr(args, "probe_model", None):
        if not valid_model(args.probe_model):
            raise ValueError("invalid_model")
        if args.probe_count is None:
            args.probe_count = 1
        if not args.allow_active_probe or not args.status_url or not 1 <= args.probe_count <= 4:
            raise ValueError("active_probe_requires_explicit_model_consent_count_and_status")
    elif getattr(args, "allow_active_probe", False) or getattr(args, "probe_count", None) is not None:
        raise ValueError("active_probe_requires_explicit_model_consent_count_and_status")


def _status_tick(engine, result):
    try:
        projection = result.result()
        sampled_at = time.monotonic()
        engine.status(projection, now=sampled_at)
        engine.emit(projection, now=sampled_at)  # exact replay sample clock
        return True
    except TransportError as exc:
        engine.source_health("status", str(exc))
    except Exception:
        engine.source_health("status", "error")
    return False


def _replay_projection(raw):
    """Accept only sanitized status projection, retaining every evidence field."""
    if not isinstance(raw, dict) or raw.get("kind") != "status":
        return None
    if set(raw) - {"kind", "lanes", "limits", "health", "capacity", "seq", "elapsed_ms", "collector_wall_ms"}:
        return None
    lanes = raw.get("lanes")
    if not isinstance(lanes, list) or len(lanes) > 256:
        return None
    safe_lanes = []
    for lane in lanes:
        if not isinstance(lane, dict) or set(lane) - {
            "lane", "worker", "wakes", "jobs", "diagnostics", "awake", "polling",
            "busy", "processing_claim", "quota_blocked", "quota_active", "queued"}:
            return None
        key = lane.get("lane")
        if not isinstance(key, str) or len(key) != 16 or any(ch not in "0123456789abcdef" for ch in key):
            return None
        wakes = lane.get("wakes")
        jobs = lane.get("jobs", {})
        if (not isinstance(wakes, dict) or not isinstance(jobs, dict)
                or any(k not in STATES | {"unknown"} or type(v) is not int or not 0 <= v <= 256 for k, v in wakes.items())
                or any(k not in JOB_STATES | {"unknown"} or type(v) is not int or not 0 <= v <= 256 for k, v in jobs.items())):
            return None
        diagnostics = lane.get("diagnostics", [])
        if (not isinstance(diagnostics, list) or len(diagnostics) > 256
                or any(not isinstance(d, dict) or set(d) != {"stage", "code"}
                       or d["stage"] not in STAGES | {"unknown"}
                       or d["code"] not in ERROR_CODES | {"unknown"} for d in diagnostics)):
            return None
        if lane.get("worker", "unknown") not in CONTACT | {"unknown"}:
            return None
        if any(type(lane.get(k)) not in (bool, type(None)) for k in
               ("awake", "polling", "busy", "processing_claim", "quota_blocked", "quota_active")):
            return None
        if lane.get("queued") is not None and (type(lane["queued"]) is not int or not 0 <= lane["queued"] <= 1000000):
            return None
        safe_lanes.append(dict(lane))
    limits = raw.get("limits", {})
    health = raw.get("health", {})
    if not isinstance(limits, dict) or not isinstance(health, dict):
        return None
    if set(limits) - {"daily", "hourly", "cooldown"}:
        return None
    for scope in ("daily", "hourly"):
        part = limits.get(scope, {})
        if (not isinstance(part, dict) or set(part) - {"attempts", "cap", "mode"}
                or part.get("mode") not in (None, "unknown", "on", "off", "paused")
                or any(part.get(k) is not None and
                       (type(part[k]) is not int or not 0 <= part[k] <= 1000000)
                       for k in ("attempts", "cap"))):
            return None
    if type(limits.get("cooldown")) not in (bool, type(None)):
        return None
    if set(health) - {"status", "host", "extension_enabled", "extension_heartbeat",
                      "extension_heartbeat_age_ms", "extension_poll_recent",
                      "extension_contact_age_ms"}:
        return None
    if health.get("status", "ready") != "ready":
        return None
    if any(type(health.get(k)) not in (bool, type(None)) for k in ("host", "extension_enabled")):
        return None
    if health.get("extension_heartbeat", "unknown") not in ("unknown", "exposed_unverified"):
        return None
    for key in ("extension_heartbeat_age_ms", "extension_contact_age_ms"):
        age = health.get(key)
        if age is not None and (type(age) is not int or not 0 <= age <= 86400000):
            return None
    if type(health.get("extension_poll_recent")) not in (bool, type(None)):
        return None
    capacity = raw.get("capacity")
    if (capacity is not None
            and (not isinstance(capacity, dict) or set(capacity) != {"claimed", "limit"}
                 or any(type(capacity.get(k)) is not int or not 0 <= capacity[k] <= 1000000
                        for k in ("claimed", "limit")))):
        return None
    return {"kind": "status", "lanes": safe_lanes,
            "limits": {"hourly": limits.get("hourly", {"attempts": None, "cap": None}),
                       "daily": limits.get("daily", {"attempts": None, "cap": None}),
                       "cooldown": limits.get("cooldown")},
            "health": dict(health) if health else {"status": "ready"},
            "capacity": capacity}


def _safe_desktop_record(raw):
    from .engine import BOOL_FIELDS, WINDOW, EVENTS
    event = raw.get("event")
    if event not in EVENTS:
        return False
    window = raw.get("window")
    if window is not None and (not isinstance(window, str) or not WINDOW.fullmatch(window)):
        return False
    if event in ("window_added", "window_changed", "window_closed", "window_activated") and not window:
        return False
    if event in ("desktop_changed", "activity_changed", "heartbeat", "ready", "capacity_changed") and window:
        return False
    if any(type(raw.get(k)) not in (bool, type(None))
           for k in ("candidate", "marker_confirmed", "baseline",
                     "activation_buffered", "activation_observed")):
        return False
    for k in ("initial", "current"):
        flags = raw.get(k)
        if flags is not None and (not isinstance(flags, dict) or not set(flags).issubset(BOOL_FIELDS)
                                  or any(type(v) not in (bool, type(None)) for v in flags.values())):
            return False
    sampling = raw.get("sampling")
    if sampling is not None:
        from .capabilities import safe_sampling
        if event not in ("heartbeat", "ready") or safe_sampling(sampling) != sampling:
            return False
    ws = raw.get("window_sampling")
    if ws is not None and (not window or safe_window_sampling(ws) != ws
                           or ws["complete"] and event != "window_closed"):
        return False
    cap = raw.get("capacity")
    if cap is not None:
        projected = safe_capability({"status": "ready", "reason": "none", "capacity": cap})
        if projected.get("capacity") != cap or event not in ("ready", "heartbeat", "capacity_changed"):
            return False
    if event == "capacity_changed" and cap is None:
        return False
    activation = raw.get("activation_elapsed_ms")
    if activation is not None and (event != "window_added"
            or raw.get("activation_buffered") is not True
            or type(activation) is not int or not 0 <= activation <= 36000000
            or type(raw.get("elapsed_ms")) is int and activation > raw["elapsed_ms"]):
        return False
    buffered_count = raw.get("activation_buffered_count")
    if buffered_count is not None and (event != "window_added"
            or raw.get("activation_buffered") is not True
            or type(buffered_count) is not int or not 1 <= buffered_count <= 256):
        return False
    native = raw.get("native_event_wall_ms", raw.get("native_ms"))
    if native is not None and (type(native) not in (int, float) or not 0 <= native < 1e15):
        return False
    return raw.get("scope", "global") in ("global",)


def _safe_cdp_record(raw):
    import re
    token = raw.get("target")
    if token is not None and (type(token) is not str or re.fullmatch("[0-9a-f]{16}", token) is None):
        return False
    if raw.get("scope") not in ("new_chatgpt_target", "fixture_existing", "unknown"):
        return False
    if raw.get("error_code") is not None:
        return type(raw["error_code"]) is str and raw["error_code"] in ("foreign_origin", "dom_unsupported", "cdp_timeout",
                                      "screenshot_invalid", "screenshot_scope_refused",
                                      "screenshot_navigation_changed", "invalid_websocket_frame",
                                      "cdp_target_error", "target_missing")
    flags = raw.get("observation")
    counts = raw.get("counts")
    if (not isinstance(flags, dict) or set(flags) !=
            {"ready", "composer", "generating", "login", "error", "dialog", "permission"}
            or any(type(v) not in (bool, type(None)) for v in flags.values())
            or not isinstance(counts, dict) or set(counts) != {"composer_count", "dialog_count"}
            or any(type(v) is not int or not 0 <= v <= 100 for v in counts.values())):
        return False
    return (raw.get("pixel_frame") == "unknown"
            and raw.get("indicator_semantics") == "structural_potential_only")


def _safe_probe_record(raw):
    if raw.get("backend_completion") not in ("exact", "mismatch", "unknown"):
        return False
    if type(raw.get("native_new_window")) not in (bool, type(None)):
        return False
    if type(raw.get("dom_source_ready")) not in (bool, type(None)):
        return False
    if raw.get("delivery") not in ("observed_new_window",
            "warm_possible_no_new_window", "no_new_window_observed", "unknown"):
        return False
    if raw.get("correlation") != "temporal_only_no_ownership" or type(raw.get("completion_unknown")) is not bool:
        return False
    return all(raw.get(k) is None or type(raw.get(k)) is int and 0 <= raw[k] <= 3600000
               for k in ("duration_ms", "first_added_after_dispatch_ms",
                         "first_activation_after_dispatch_ms", "open_not_observed_within_ms"))



@contextmanager
def _replay_source(filename):
    """Directory-fd walk forbids ancestor/final symlinks even during opening."""
    parts = os.path.abspath(os.fspath(filename)).split(os.sep)
    directory = os.open(os.sep, os.O_RDONLY | os.O_DIRECTORY)
    fp = None
    try:
        for part in parts[1:-1]:
            new = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = new
        final = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                        dir_fd=directory)
        info = os.fstat(final)
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_REPLAY_BYTES:
            os.close(final)
            raise ValueError("invalid_replay_file")
        fp = os.fdopen(final, "r", encoding="utf-8")
        yield fp
    except (OSError, UnicodeError):
        raise ValueError("invalid_replay_file") from None
    finally:
        if fp is not None:
            fp.close()
        os.close(directory)


def _count(value, maximum=256):
    return type(value) is int and 0 <= value <= maximum


def _lane(value):
    return (type(value) is str and len(value) == 16
            and all(ch in "0123456789abcdef" for ch in value))


def _count_dict(value, allowed, maximum=256):
    return (isinstance(value, dict) and len(value) <= 256 and
            all(type(k) is str and k in allowed and _count(v, maximum)
                for k, v in value.items()))


def _safe_derived_record(kind, raw):
    """Validate ignored/rederived records too: never accept untrusted text."""
    if kind == "backend_confirmation":
        return (_lane(raw.get("lane")) and _count(raw.get("count_newly_observed"))
                and raw.get("gui_ready") == "unknown"
                and raw.get("correlation") == "lane_only")
    if kind in ("wake", "stuck_lower_bound"):
        if not _lane(raw.get("lane")) or raw.get("state") not in PENDING or not _count(raw.get("count")):
            return False
        if kind == "wake":
            return (raw.get("decision") in (None, "vanished_or_progressed_unknown")
                    and raw.get("correlation") in (None, "ambiguous_duplicate")
                    and (raw.get("decision") is None) != (raw.get("correlation") is None))
        return (raw.get("observed_at_least_seconds") in (15, 60, 180)
                and raw.get("correlation") == "lane_only")
    if kind == "status_sample":
        if not all(_count(raw.get(key)) for key in (
                "lanes", "pending", "failed", "expired", "ambiguous")):
            return False
        if not _count_dict(raw.get("stalled_suspect"), {"15", "60", "180"}):
            return False
        if not _count_dict(raw.get("jobs"), JOB_STATES | {"unknown"}):
            return False
        if not _count_dict(raw.get("workers"), CONTACT | {"unknown"}):
            return False
        if not _count_dict(raw.get("worker_flags"), {
                "awake", "polling", "busy", "processing_claim", "quota_blocked", "quota_active"}):
            return False
        diagnostics = raw.get("diagnostics")
        if not isinstance(diagnostics, dict) or len(diagnostics) > 256:
            return False
        if any(type(k) is not str or not _count(v) or "/" not in k or
               k.split("/", 1)[0] not in STAGES | {"unknown"} or
               k.split("/", 1)[1] not in ERROR_CODES | {"unknown"}
               for k, v in diagnostics.items()):
            return False
        return _replay_projection({
            "kind": "status", "lanes": [], "health": raw.get("health"),
            "limits": raw.get("limits")}) is not None
    return False


def _safe_small_record(kind, raw):
    if kind == "run_config":
        x = raw.get("status_max_gap_seconds")
        return type(x) in (int, float) and math.isfinite(x) and 1 <= x <= 3600
    if kind == "probe_dispatch":
        return (type(raw.get("probe_number")) is int and 1 <= raw["probe_number"] <= 4
                and type(raw.get("deadline_ms")) is int
                and 1 <= raw["deadline_ms"] <= 755000
                and raw.get("collector_ready") is True and raw.get("session") == "unique_cold")
    if kind == "probe_blocked":
        return raw.get("reason") == "collectors_or_status_not_ready"
    if kind == "stop":
        return raw.get("reason") in ("sigterm", "sigint", "keyboard_interrupt")
    if kind == "gap":
        return (raw.get("source") in ("native", "status", "cdp")
                and raw.get("decision") in ("reset_lower_bounds", "evidence_unknown"))
    return False


def replay(args):
    engine = create_engine(args.output)
    engine.origin = 0.0
    engine.replay = True
    engine._last_now = 0.0
    engine.max_gap = max(12, args.sample_seconds * 1.5)
    processed = status_samples = 0
    last_seq = last_elapsed = None
    # Unknown/untrusted input must fail closed rather than being copied.
    fields = {
        "run_config": {"status_max_gap_seconds"},
        "status": {"lanes", "limits", "health", "capacity"},
        "status_sample": {"lanes", "pending", "stalled_suspect", "failed", "expired",
                          "ambiguous", "jobs", "workers", "worker_flags", "diagnostics",
                          "limits", "health"},
        "health": {"source", "state"},
        "capability": {"source", "details"},
        "cleanup": {"source", "result"},
        "gap": {"source", "decision"},
        "backend_confirmation": {"lane", "count_newly_observed", "gui_ready", "correlation"},
        "wake": {"lane", "state", "count", "decision", "correlation"},
        "stuck_lower_bound": {"lane", "state", "count", "observed_at_least_seconds", "correlation"},
        "desktop": {"event", "window", "candidate", "marker_confirmed", "baseline",
                    "initial", "current", "activation_buffered", "activation_elapsed_ms",
                    "activation_buffered_count",
                    "activation_observed", "native_ms", "native_event_wall_ms",
                    "capacity", "sampling", "window_sampling", "scope"},
        "cdp": {"observation", "counts", "target", "scope", "pixel_frame",
                "indicator_semantics", "error_code"},
        "probe_dispatch": {"probe_number", "deadline_ms", "collector_ready", "session"},
        "probe_result": {"backend_completion", "native_new_window", "dom_source_ready",
                         "delivery", "duration_ms", "first_added_after_dispatch_ms",
                         "first_activation_after_dispatch_ms", "open_not_observed_within_ms",
                         "completion_unknown", "correlation"},
        "probe_blocked": {"reason"},
        "stop": {"reason"},
    }
    try:
        with _replay_source(args.input) as fp:
            read_bytes = 0
            while True:
                line = fp.readline(MAX_LINE + 2)
                if not line:
                    break
                size = len(line.encode("utf-8"))
                read_bytes += size
                if size > MAX_LINE + 1 or read_bytes > MAX_REPLAY_BYTES:
                    raise ValueError("invalid_replay_line")
                try:
                    raw = json.loads(line)
                except ValueError:
                    raise ValueError("invalid_replay_json") from None
                if not isinstance(raw, dict) or raw.get("kind") not in fields:
                    raise ValueError("invalid_replay_schema")
                kind = raw["kind"]
                if set(raw) - fields[kind] - {"kind", "seq", "elapsed_ms", "collector_wall_ms"}:
                    raise ValueError("invalid_replay_schema")
                seq, elapsed = raw.get("seq"), raw.get("elapsed_ms")
                if (seq is None) != (elapsed is None):
                    raise ValueError("invalid_replay_schema")
                if seq is not None:
                    if (type(seq) is not int or seq != processed + 1
                            or type(elapsed) is not int or not 0 <= elapsed <= 36000000
                            or last_elapsed is not None and elapsed < last_elapsed):
                        raise ValueError("invalid_replay_schema")
                    last_seq, last_elapsed = seq, elapsed
                wall = raw.get("collector_wall_ms")
                if wall is not None and (type(wall) is not int or not 0 <= wall <= 1e16):
                    raise ValueError("invalid_replay_schema")
                at = elapsed / 1000 if elapsed is not None else status_samples * args.sample_seconds
                engine._last_now = at
                if kind == "run_config":
                    value = raw.get("status_max_gap_seconds")
                    if not _safe_small_record(kind, raw):
                        raise ValueError("invalid_replay_schema")
                    engine.max_gap = value
                elif kind == "status":
                    projection = _replay_projection(raw)
                    if projection is None:
                        raise ValueError("invalid_replay_schema")
                    engine.status(projection, now=at)
                    engine.emit(projection, now=at)
                    status_samples += 1
                elif kind == "desktop":
                    if not _safe_desktop_record(raw):
                        raise ValueError("invalid_replay_schema")
                    engine.desktop(raw, now=at)
                elif kind == "cdp":
                    if not _safe_cdp_record(raw):
                        raise ValueError("invalid_replay_schema")
                    engine.cdp(raw, now=at)
                elif kind == "health":
                    if (raw.get("source") not in engine.health
                            or raw.get("state") not in HEALTH_STATES):
                        raise ValueError("invalid_replay_schema")
                    engine.source_health(raw["source"], raw["state"], now=at)
                elif kind == "capability":
                    details = raw.get("details")
                    if raw.get("source") != "native" or not isinstance(details, dict) or (
                            safe_capability(details) != details):
                        raise ValueError("invalid_replay_schema")
                    engine.native_capability(details)
                elif kind == "cleanup":
                    value = raw.get("result")
                    if (raw.get("source") != "native" or not isinstance(value, dict)
                            or value.get("status") not in ("ok", "error", "not_started")
                            or set(value) != {"status", "reason"}
                            or value["reason"] != {"ok": "none", "error": "cleanup_failed",
                                                   "not_started": "unknown"}[value["status"]]):
                        raise ValueError("invalid_replay_schema")
                    engine.cleanup_result(value)
                elif kind == "probe_result":
                    if not _safe_probe_record(raw):
                        raise ValueError("invalid_replay_schema")
                    engine.replay_probe_result(raw)
                elif kind == "gap":
                    if not _safe_small_record(kind, raw):
                        raise ValueError("invalid_replay_schema")
                    engine.emit({"kind": "gap", "source": raw["source"], "decision": raw["decision"]})
                elif kind in ("status_sample", "wake", "stuck_lower_bound", "backend_confirmation"):
                    if not _safe_derived_record(kind, raw):
                        raise ValueError("invalid_replay_schema")
                    # Re-derived from the next validated timed status record.
                else:
                    if not _safe_small_record(kind, raw):
                        raise ValueError("invalid_replay_schema")
                    engine.emit({k: v for k, v in raw.items()
                                 if k not in ("seq", "elapsed_ms", "collector_wall_ms")}, now=at)
                processed += 1
        engine.events = processed
        # This is the same deterministically bounded summary written in finally.
        print("replay accepted_samples=" + str(processed))
        print("summary=" + json.dumps(engine.summary(), separators=(",", ":")))
        return 0
    finally:
        engine.recorder.close(engine.summary())


def listen(args):
    validate_options(args)
    token = token_from_env(args.token_env) if args.status_url else None
    engine = create_engine(args.output)
    engine.max_gap = max(12, args.poll_interval * 1.5)
    engine.emit({"kind": "run_config", "status_max_gap_seconds": engine.max_gap})
    source_queue = queue.Queue(maxsize=512)
    dropped = [False]
    cancel = Cancellation()
    stop_reason = [None]
    saved_signals = {}

    def handle_signal(number, _frame):
        stop_reason[0] = "sigterm" if number == signal.SIGTERM else "sigint"
        cancel.cancel()
        raise KeyboardInterrupt

    def on_desktop(event):
        try:
            source_queue.put_nowait(event)
        except queue.Full:
            dropped[0] = True

    def drain_native():
        # Flush bounded queued metadata before final closure. Loss is sticky;
        # queued packets do not repair a missed sample or re-arm readiness.
        if dropped[0]:
            dropped[0] = False
            engine.source_health("native", "unknown")
            engine.emit({"kind": "gap", "source": "native", "decision": "evidence_unknown"})
        for _ in range(512):
            try:
                item = source_queue.get_nowait()
            except queue.Empty:
                break
            engine.desktop(item)

    observer = None
    pool = None
    status_future = cdp_future = probe_future = None
    cdp = None
    baseline_windows = 0
    dispatched = 0
    next_status = next_cdp = 0.0
    ready_status = False
    cdp_recent = None
    started = time.monotonic()
    last_print = started
    native_closed = False
    probe_started_ms = probe_timeout_ms = None
    for number in (signal.SIGINT, signal.SIGTERM):
        saved_signals[number] = signal.getsignal(number)
        signal.signal(number, handle_signal)
    try:
        observer, native = native_start(args.duration, on_desktop)
        engine.native_capability(native)
        if native["status"] != "ready" and observer is not None:
            _close_native(engine, observer)
            observer = None
            native_closed = True
        if args.cdp_url:
            try:
                cdp = CDPObserver(args.cdp_url, target_id=args.target_id,
                                  screenshots=args.screenshots, run_dir=engine.recorder.path,
                                  salt=engine.salt)
                cdp.start()  # Baseline before active dispatch.
                engine.source_health("cdp", "ready")
            except (CDPError, Exception):
                engine.source_health("cdp", "unsupported")
                cdp = None
        else:
            engine.source_health("cdp", "unsupported")
        if not args.status_url:
            engine.source_health("status", "unsupported")
        pool = concurrent.futures.ThreadPoolExecutor(max_workers=3, thread_name_prefix="wake-observe")
        print("listen started; duration_seconds=" + str(args.duration) +
              " active_probe=" + ("opted_in" if args.probe_model else "disabled"))
        while time.monotonic() - started < args.duration:
            now = time.monotonic()
            if observer is not None:
                try:
                    observer.poll()
                    capability = safe_capability(getattr(observer, "capability", native))
                    if capability["status"] != "ready":
                        engine.native_capability(capability)
                        _close_native(engine, observer)
                        observer = None
                        native_closed = True
                    elif capability != engine.capability:
                        engine.native_capability(capability)
                except Exception:
                    engine.native_capability({"status": "error", "reason": "adapter_failure"})
                    _close_native(engine, observer)
                    observer = None
                    native_closed = True
            drain_native()
            ready_status = False  # success authorizes only this iteration's dispatch
            if args.status_url and (status_future is None or status_future.done()):
                if status_future is not None:
                    ready_status = _status_tick(engine, status_future)
                    status_future = None
                if now >= next_status:
                    status_future = pool.submit(get_status, args.status_url, token, engine.salt,
                                                timeout=min(5, args.poll_interval + 1), cancel=cancel)
                    next_status = now + args.poll_interval
            if cdp and (cdp_future is None or cdp_future.done()):
                if cdp_future is not None:
                    try:
                        for item in cdp_future.result():
                            engine.cdp(item)
                        cdp_recent = time.monotonic()
                    except Exception:
                        engine.source_health("cdp", "error")
                    cdp_future = None
                if now >= next_cdp:
                    cdp_future = pool.submit(cdp.poll)
                    next_cdp = now + args.poll_interval
            if probe_future is not None and probe_future.done():
                try:
                    exact = probe_future.result()
                except Exception:
                    exact = None
                engine.probe(exact=exact, baseline_candidates=baseline_windows,
                             native_ready=engine.health["native"] == "ready",
                             cdp_ready=engine.health["cdp"] == "ready",
                             dispatched_ms=probe_started_ms, completed_ms=engine.elapsed(),
                             deadline_ms=probe_timeout_ms if exact is None else None)
                probe_future = None
            if args.probe_model and probe_future is None and dispatched < args.probe_count:
                native_ready = (observer is not None and engine.health["native"] == "ready"
                                and not engine.native_incomplete)
                cdp_ready = (cdp is not None and cdp_recent is not None
                             and now - cdp_recent <= engine.max_gap
                             and engine.health["cdp"] == "ready")
                collectors_ready = ((native_ready or cdp_ready)
                                    and (not args.cdp_url or cdp_ready))
                if ready_status and engine.health["status"] == "ready" and collectors_ready and not cancel.stop.is_set() and args.duration - (time.monotonic() - started) > 1:
                    remaining = args.duration - (time.monotonic() - started)
                    effective_timeout = min(args.probe_timeout or 755, remaining - 0.1)
                    baseline_windows = engine.counters["candidate_windows"]
                    # New unpredictable session and exact-answer token for each one-time attempt.
                    session = secrets.token_urlsafe(32)
                    challenge = secrets.token_urlsafe(24)
                    probe_started_ms = engine.elapsed()
                    probe_timeout_ms = round(effective_timeout * 1000)
                    probe_future = pool.submit(completion_once, args.status_url, token,
                                               args.probe_model, session, challenge,
                                               timeout=effective_timeout, cancel=cancel)
                    dispatched += 1
                    engine.emit({"kind": "probe_dispatch", "probe_number": dispatched,
                                 "deadline_ms": probe_timeout_ms,
                                 "collector_ready": True, "session": "unique_cold"})
            if now - last_print >= 15:
                print("health native=" + engine.health["native"] + " status=" +
                      engine.health["status"] + " cdp=" + engine.health["cdp"] +
                      " pending=" + str(engine.current["pending"]) +
                      " stalled_suspect=" + str(engine.current["stalled_suspect"]) +
                      " failed=" + str(engine.current["failed"]) +
                      " expired=" + str(engine.current["expired"]) +
                      " jobs=" + str(engine.current["jobs"]) +
                      " worker_flags=" + str(engine.current.get("worker_flags")) +
                      " backend_health=" + str(engine.current["backend_health"]) +
                      " cap=" + str(engine.current["limits"]) +
                      " native_candidates=" + str(engine.counters["candidate_windows"]))
                last_print = now
            time.sleep(0.05)
        if args.probe_model and dispatched < args.probe_count:
            engine.emit({"kind": "probe_blocked", "reason": "collectors_or_status_not_ready"})
    except KeyboardInterrupt:
        engine.emit({"kind": "stop", "reason": stop_reason[0] or "keyboard_interrupt"})
        print("listen stopped by Ctrl-C")
    finally:
        cancel.cancel()
        if status_future is not None:
            # A result not consumed before stop is unknown, even if it finishes
            # concurrently with cancellation. Never inherit a prior success.
            engine.source_health("status", "unknown")
            engine.emit({"kind": "gap", "source": "status", "decision": "evidence_unknown"})
        if cdp is not None:
            cdp.close()
        drain_native()
        if observer is not None:
            _close_native(engine, observer)
        drain_native()
        if observer is None and not native_closed:
            engine.cleanup_result({"status": "not_started"})
        if probe_future is not None:
            try:
                outcome = probe_future.result() if probe_future.done() else None
            except Exception:
                outcome = None
            engine.probe(exact=outcome, baseline_candidates=baseline_windows,
                         native_ready=engine.health["native"] == "ready",
                         cdp_ready=engine.health["cdp"] == "ready",
                         dispatched_ms=probe_started_ms,
                         completed_ms=engine.elapsed() if outcome is not None else None,
                         deadline_ms=probe_timeout_ms if outcome is None else None)
        if pool is not None:
            pool.shutdown(wait=True, cancel_futures=True)
        for number, previous in saved_signals.items():
            signal.signal(number, previous)
        engine.recorder.close(engine.summary())
        bg = engine.summary()["native_background"]
        print("annoyance_observations initial_failures=" + str(bg["initial_failures"]) +
              " activations=" + str(bg["activation_count"]) +
              " reforeground=" + str(bg["reforeground_episodes"]) +
              " attention_rises=" + str(bg["attention_rises"]) +
              " topmost_rises=" + str(bg["topmost_rises"]) +
              " sampling_resolution_ms=50 pixel_first_frame=unknown")
        for win in bg["windows"]:
            print("window=" + win["window"] + " verdict=" + win["background_verdict"] +
                  " active_completed_ms=" + str(win["completed_observable_total_ms"]["active"]) +
                  " visual_completed_ms=" + str(win["completed_observable_total_ms"]["visual"]) +
                  " duration_uncertain=" + str(win["duration_uncertain"]))
        print("run_dir=" + str(engine.recorder.path))
        print("summary=" + json.dumps(engine.summary(), separators=(",", ":")))
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(prog="python3 -m tools.wake_checker")
    commands = parser.add_subparsers(dest="command", required=True)
    doctor = commands.add_parser("doctor", help="Check capabilities only; no script loaded")
    listener = commands.add_parser("listen", help="Finite on-demand passive observer")
    listener.add_argument("--duration", type=int, default=300)
    listener.add_argument("--poll-interval", type=int, default=2)
    listener.add_argument("--status-url")
    listener.add_argument("--token-env", default="CROSSFEED_API_KEY")
    listener.add_argument("--cdp-url")
    listener.add_argument("--target-id")
    listener.add_argument("--screenshots", action="store_true")
    listener.add_argument("--probe-model")
    listener.add_argument("--allow-active-probe", action="store_true")
    listener.add_argument("--probe-count", type=int)
    listener.add_argument("--probe-timeout", type=int)
    listener.add_argument("--output", type=Path)
    player = commands.add_parser("replay", help="Replay sanitized checker JSONL")
    player.add_argument("input")
    player.add_argument("--output", type=Path)
    player.add_argument("--sample-seconds", type=float, default=2)
    args = parser.parse_args(argv)
    try:
        if args.command == "doctor":
            print(json.dumps({"native": native_doctor(),
                              "cdp": {"status": "unsupported", "reason": "not_requested"},
                              "status": {"status": "unsupported", "reason": "not_requested"},
                              "active": "disabled"}, sort_keys=True))
            return 0
        if args.command == "replay":
            if not 0 < args.sample_seconds <= 3600:
                raise ValueError("invalid_replay_sample_interval")
            return replay(args)
        if not 1 <= args.duration <= 3600 or not 1 <= args.poll_interval <= 30:
            raise ValueError("invalid_duration_or_interval")
        if args.probe_timeout is not None and not 1 <= args.probe_timeout <= min(755, args.duration):
            raise ValueError("invalid_probe_timeout")
        return listen(args)
    except (ValueError, TypeError, TransportError, OSError) as exc:
        allowed = {"output_exists", "unsafe_output_parent", "invalid_replay_file",
                   "invalid_replay_line", "invalid_replay_json", "invalid_replay_schema",
                   "invalid_replay_sample_interval", "invalid_duration_or_interval",
                   "screenshots_require_cdp", "target_requires_cdp",
                   "active_probe_requires_explicit_model_consent_count_and_status",
                   "invalid_model", "invalid_probe_timeout", "missing_or_invalid_token", "invalid_token_env_name",
                   "invalid_loopback_url"}
        text = str(exc)
        print("wake_checker: " + (text if text in allowed else "operation_failed"), file=sys.stderr)
        return 2
