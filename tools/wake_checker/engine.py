"""Independent, bounded sampled evidence; no temporal observation proves ownership."""
import datetime
import json
import math
import os
import re
import secrets
import time
from pathlib import Path

from .capabilities import safe_capability, safe_sampling, safe_window_sampling
from .background import BackgroundTracker, FIELDS
from .status import PENDING

THRESHOLDS = (15, 60, 180)
WINDOW = re.compile(r"^w(?:[1-9]|[1-9][0-9]{1,2})$")
EVENTS = frozenset(("ready", "window_added", "window_activated", "window_changed",
                    "window_closed", "desktop_changed", "activity_changed", "heartbeat",
                    "capacity_changed"))
BOOL_FIELDS = FIELDS
HEALTH_STATES = frozenset(("ready", "unknown", "unsupported", "error", "auth_error",
                           "invalid_json", "invalid_schema", "unreachable", "oversize",
                           "http_error", "redirect_refused", "invalid_content_type",
                           "timeout", "cancelled", "dom_unsupported", "cdp_unavailable"))
MAX_LINE = 65536


class Recorder:
    """Private exclusive run directory, bounded JSONL and summary."""

    def __init__(self, directory):
        self.path = Path(directory).absolute()
        if self.path.is_symlink() or self.path.exists():
            raise ValueError("output_exists")
        if any(p.is_symlink() for p in self.path.parents):
            raise ValueError("unsafe_output_parent")
        self.path.mkdir(mode=0o700, parents=False, exist_ok=False)
        self.path.chmod(0o700)
        fd = os.open(self.path / "events.jsonl",
                     os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
                     0o600)
        self._file = os.fdopen(fd, "w", encoding="utf-8")
        self.closed = False
        self.records = 0

    def write(self, value):
        if self.closed:
            raise ValueError("recorder_closed")
        line = json.dumps(value, separators=(",", ":"), sort_keys=True, ensure_ascii=True, allow_nan=False)
        if len(line.encode()) > MAX_LINE:
            raise ValueError("record_oversize")
        self._file.write(line + "\n")
        self._file.flush()
        self.records += 1

    def close(self, summary):
        if self.closed:
            return
        self.closed = True
        self._file.close()
        data = json.dumps(summary, indent=2, sort_keys=True, allow_nan=False).encode()
        if len(data) > MAX_LINE:
            raise ValueError("summary_oversize")
        fd = os.open(self.path / "summary.json",
                     os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
                     0o600)
        with os.fdopen(fd, "wb") as fp:
            fp.write(data)


class CheckerEngine:
    """Lane-level sampled transitions and separately timed native evidence."""

    def __init__(self, recorder=None, *, thresholds=THRESHOLDS, max_gap=12,
                 origin=None, replay=False):
        self.recorder = recorder
        self.origin = time.monotonic() if origin is None else origin
        self.replay = replay
        self.salt = secrets.token_bytes(32)
        self.thresholds = tuple(thresholds)
        self.max_gap = max_gap
        self.pending = {}
        self.last_status_at = None
        self.health = {"native": "unknown", "status": "unknown", "cdp": "unknown"}
        self.capability = {}
        self.native_incomplete = False
        self.cleanup = {"status": "not_started", "reason": "unknown"}
        self.windows = {}
        self.activations = {}
        self.background = BackgroundTracker()
        self.confirmed = {}
        self.cdp_targets = {}
        self.last_cdp = {}
        self.counters = {"threshold_crossings": 0, "vanished_unknown": 0,
                         "ambiguous": 0, "candidate_windows": 0, "marker_windows": 0,
                         "backend_exact": 0, "backend_mismatch": 0,
                         "warm_possible": 0, "cold_window_observed": 0,
                         "dom_ready": 0, "backend_confirmed_tickets": 0,
                         "backend_failed_current": 0, "backend_expired_current": 0,
                         "pending_current": 0, "stalled_suspect_current": 0,
                         "ambiguous_current": 0, "cdp_errors": 0,
                         "probe_unknown": 0}
        self.current = {"observation": "unknown", "pending": 0, "stalled_suspect": {},
                        "ambiguous": 0, "failed": 0, "expired": 0, "diagnostics": {},
                        "jobs": {}, "workers": {}, "limits": {}, "backend_health": {},
                        "capacity": None, "capacity_wait": {"count": None,
                        "reason": "queue_cause_not_exposed"},
                        "wake_pending_observed_lower_bound": None}
        self.probes = []
        self.events = 0
        self._last_now = self.origin

    def elapsed(self, now=None):
        value = time.monotonic() if now is None else float(now)
        return max(0, round((value - self.origin) * 1000))

    def _sample_now(self, now=None):
        """Take one monotonic observation per transition and its derived records.

        Replay uses the last validated input timestamp for untimed records;
        it must not sample the host clock.
        """
        observed = (self._last_now if self.replay else time.monotonic()) if now is None else float(now)
        self._last_now = observed
        return observed

    def emit(self, event, *, now=None):
        if not isinstance(event, dict):
            raise ValueError("invalid_event")
        self.events += 1
        record = dict(event)
        record["seq"] = self.events
        record["elapsed_ms"] = self.elapsed(self._sample_now(now))
        if not self.replay:
            record["collector_wall_ms"] = int(time.time() * 1000)
        if self.recorder:
            self.recorder.write(record)
        return record

    def source_health(self, source, code, *, now=None):
        if source not in self.health:
            return
        now = self._sample_now(now)
        state = code if code in HEALTH_STATES else "error"
        if self.health[source] != state:
            self.health[source] = state
            self.emit({"kind": "health", "source": source, "state": state}, now=now)
        if source == "native" and state == "unknown":
            self.native_incomplete = True  # lost samples cannot be undone in this run
            self.background.gap(self.elapsed(now))
            for win in self.windows.values():
                if not win.get("closed"):
                    win["current"] = {key: None for key in BOOL_FIELDS}
        if source == "status" and state != "ready":
            self.pending.clear()
            self.last_status_at = None
            self.current["observation"] = "unknown"
            self.current["pending"] = None
            self.current["stalled_suspect"] = {}
            self.current["ambiguous"] = None
            self.current["failed"] = None
            self.current["expired"] = None
            self.current["diagnostics"] = {}
            self.current["jobs"] = {}
            self.current["workers"] = {}
            self.current["worker_flags"] = {}
            self.current["limits"] = {}
            self.current["backend_health"] = {}
            self.current["capacity"] = None
            self.current["capacity_wait"] = {"count": None,
                                              "reason": "queue_cause_not_exposed"}
            self.current["wake_pending_observed_lower_bound"] = None
            self.counters["backend_failed_current"] = None
            self.counters["backend_expired_current"] = None
            self.counters["pending_current"] = None
            self.counters["stalled_suspect_current"] = None
            self.counters["ambiguous_current"] = None

    def native_capability(self, raw, *, now=None):
        now = self._sample_now(now)
        details = safe_capability(raw)
        if self.native_incomplete and details["status"] == "ready":
            details.update(status="unsupported", reason="coverage_incomplete")
        if details["status"] != "ready" and details["reason"] in (
                "capacity_exhausted", "capacity_overflow", "coverage_incomplete",
                "owner_changed", "heartbeat_expired", "delivery_timeout",
                "internal_error", "missing_signals"):
            self.native_incomplete = True
            self.background.gap(self.elapsed(now))
            for win in self.windows.values():
                if not win.get("closed"):
                    win["current"] = {key: None for key in BOOL_FIELDS}
        if details != self.capability:
            self.capability = details
            self.emit({"kind": "capability", "source": "native", "details": details}, now=now)
        self.source_health("native", details["status"], now=now)

    def cleanup_result(self, raw, *, now=None):
        now = self._sample_now(now)
        code = raw.get("status") if isinstance(raw, dict) else None
        self.cleanup = {"status": code if code in ("ok", "error", "not_started") else "error",
                        "reason": "cleanup_failed" if code == "error" else "none" if code == "ok" else "unknown"}
        self.emit({"kind": "cleanup", "source": "native", "result": dict(self.cleanup)}, now=now)
        if self.cleanup["status"] == "error":
            self.source_health("native", "error", now=now)

    def status(self, projection, now=None):
        now = self._sample_now(now)
        if self.last_status_at is not None and (now < self.last_status_at or now - self.last_status_at > self.max_gap):
            self.pending.clear()
            self.emit({"kind": "gap", "source": "status", "decision": "reset_lower_bounds"}, now=now)
        self.last_status_at = now
        self.source_health("status", "ready", now=now)
        current = {}
        confirmations = {}
        failed = expired = ambiguous = 0
        jobs, workers, diagnostics = {}, {}, {}
        worker_flags = {name: 0 for name in ("awake", "polling", "busy",
                        "processing_claim", "quota_blocked", "quota_active")}
        for lane in projection["lanes"]:
            ident = lane["lane"]
            wakes = lane["wakes"]
            failed += wakes.get("failed", 0)
            expired += wakes.get("expired", 0)
            for state, value in lane.get("jobs", {}).items():
                jobs[state] = jobs.get(state, 0) + value
            w = lane.get("worker", "unknown")
            workers[w] = workers.get(w, 0) + 1
            for flag in worker_flags:
                if lane.get(flag) is True:
                    worker_flags[flag] += 1
            for diagnostic in lane.get("diagnostics", []):
                key = diagnostic["stage"] + "/" + diagnostic["code"]
                diagnostics[key] = diagnostics.get(key, 0) + 1
            confirmed = wakes.get("confirmed", 0)
            if confirmed:
                confirmations[ident] = confirmed
                previous = self.confirmed.get(ident, 0)
                if confirmed > previous:
                    self.counters["backend_confirmed_tickets"] += confirmed - previous
                    self.emit({"kind": "backend_confirmation", "lane": ident,
                               "count_newly_observed": confirmed - previous,
                               "gui_ready": "unknown", "correlation": "lane_only"}, now=now)
            # Any lane state/stage/job progress is reason to reset the lower-bound clock.
            signature = (tuple(sorted(wakes.items())),
                         tuple(sorted(lane.get("jobs", {}).items())),
                         tuple(sorted((d["stage"], d["code"]) for d in lane.get("diagnostics", []))))
            for state, count in wakes.items():
                if state not in PENDING or count < 1:
                    continue
                key = (ident, state)
                prior = self.pending.get(key)
                if prior is None or prior["signature"] != signature:
                    prior = {"start": now, "count": count, "passed": set(), "signature": signature}
                current[key] = prior
                if count > 1:
                    ambiguous += count
                    if not prior.get("ambiguous"):
                        prior["ambiguous"] = True
                        self.counters["ambiguous"] += 1
                        self.emit({"kind": "wake", "lane": ident, "state": state, "count": count,
                                   "correlation": "ambiguous_duplicate"}, now=now)
                for threshold in self.thresholds:
                    if threshold not in prior["passed"] and now - prior["start"] >= threshold:
                        prior["passed"].add(threshold)
                        self.counters["threshold_crossings"] += 1
                        self.emit({"kind": "stuck_lower_bound", "lane": ident, "state": state,
                                   "count": count, "observed_at_least_seconds": threshold,
                                   "correlation": "lane_only"}, now=now)
        for (ident, state), previous in self.pending.items():
            if (ident, state) not in current:
                self.counters["vanished_unknown"] += 1
                self.emit({"kind": "wake", "lane": ident, "state": state, "count": previous["count"],
                           "decision": "vanished_or_progressed_unknown"}, now=now)
        self.pending = current
        self.confirmed = confirmations
        stalled = {str(t): sum(p["count"] for p in current.values() if t in p["passed"])
                   for t in self.thresholds}
        cap = projection.get("capacity")
        capacity = ({"claimed": cap["claimed"], "limit": cap["limit"],
                     "at_limit": cap["claimed"] >= cap["limit"]}
                    if isinstance(cap, dict) and
                    type(cap.get("claimed")) is int and type(cap.get("limit")) is int
                    else None)
        self.current = {"observation": "sampled", "pending": sum(p["count"] for p in current.values()),
                        "capacity": capacity,
                        "capacity_wait": {"count": None,
                                          "reason": "queue_cause_not_exposed"},
                        "wake_pending_observed_lower_bound":
                            sum(p["count"] for p in current.values()),
                        "stalled_suspect": stalled, "ambiguous": ambiguous,
                        "failed": failed, "expired": expired, "diagnostics": diagnostics,
                        "jobs": jobs, "workers": workers, "worker_flags": worker_flags,
                        "limits": projection["limits"],
                        "backend_health": projection["health"],
                        "identity": "exact_label_aggregates_no_per_job_ticket_join"}
        self.counters.update(pending_current=self.current["pending"],
                             stalled_suspect_current=stalled.get(str(min(self.thresholds)), 0) if self.thresholds else 0,
                             ambiguous_current=ambiguous, backend_failed_current=failed,
                             backend_expired_current=expired)
        ev = {"kind": "status_sample", "lanes": len(projection["lanes"]),
              "pending": self.current["pending"], "stalled_suspect": stalled,
              "failed": failed, "expired": expired, "ambiguous": ambiguous,
              "jobs": jobs, "workers": workers, "worker_flags": worker_flags,
              "diagnostics": diagnostics,
              "limits": projection["limits"], "health": projection["health"]}
        return self.emit(ev, now=now)

    def desktop(self, raw, *, now=None):
        if not isinstance(raw, dict) or raw.get("kind") != "desktop":
            return None
        event = raw.get("event")
        if event not in EVENTS:
            return None
        now = self._sample_now(now)
        stamp = self.elapsed(now)
        native_ms = raw.get("native_ms")
        native_ms = native_ms if type(native_ms) in (int, float) and math.isfinite(native_ms) and 0 <= native_ms < 1e15 else None
        extra = {"native_event_wall_ms": native_ms} if native_ms is not None else {}
        # Queued native packets are not fresh health evidence. They can degrade
        # capacity, but never re-arm a collector after a gap/closure.
        capacity = raw.get("capacity")
        sampling = safe_sampling(raw.get("sampling"))
        window_sampling = safe_window_sampling(raw.get("window_sampling"))
        if sampling is not None:
            self.background.sampled(sampling)
            if self.background.incomplete:
                self.native_incomplete = True
        if self.capability and (isinstance(capacity, dict) or sampling is not None):
            detail = dict(self.capability)
            if isinstance(capacity, dict):
                detail["capacity"] = capacity
            if sampling is not None:
                detail["sampling"] = sampling
            self.native_capability(detail, now=now)
        if event in ("ready", "heartbeat", "capacity_changed"):
            return self.emit({"kind": "desktop", "event": event,
                              **({"capacity": safe_capability({"capacity": capacity}).get("capacity")}
                                 if capacity is not None else {}),
                              **({"sampling": sampling} if sampling is not None else {}),
                              **extra}, now=now)
        ident = raw.get("window")
        if event in ("desktop_changed", "activity_changed") and ident is None:
            return self.emit({"kind": "desktop", "event": event, "scope": "global", **extra}, now=now)
        if not isinstance(ident, str) or not WINDOW.fullmatch(ident) or int(ident[1:]) > 256:
            return None
        if event == "window_activated" and ident not in self.windows:
            prev = self.activations.get(ident)
            self.activations[ident] = {"at": prev["at"] if prev else stamp,
                                       "count": min(256, prev["count"] + 1) if prev else 1}
            if len(self.activations) > 256:
                self.activations.clear()
                self.native_incomplete = True
                self.background.gap(stamp)
            return None
        if event == "window_added":
            if ident in self.windows or len(self.windows) >= 256:
                return None
            initial_raw = raw.get("initial", raw)
            if not isinstance(initial_raw, dict):
                initial_raw = {}
            initial = {field: initial_raw.get(field) if type(initial_raw.get(field)) is bool else None
                       for field in BOOL_FIELDS}
            browser = raw.get("candidate", raw.get("browser")) is True
            marker = raw.get("marker_confirmed", raw.get("wake_marker")) is True
            baseline = raw.get("baseline") is True
            buffered = self.activations.pop(ident, None)
            activated = buffered["at"] if buffered is not None else None
            buffered_count = buffered["count"] if buffered is not None else 0
            if activated is None and raw.get("activation_buffered") is True:
                recorded = raw.get("activation_elapsed_ms")
                activated = (recorded if type(recorded) is int and 0 <= recorded <= stamp
                             else stamp)  # legacy sanitized files lack the offset
                buffered_count = raw.get("activation_buffered_count", 1)
            win = {"browser": browser, "marker": marker, "baseline": baseline,
                   "initial": initial, "current": initial.copy(), "activated": activated is not None,
                   "added_ms": stamp, "activation_ms": activated}
            self.windows[ident] = win
            self.background.added(ident, initial, stamp, browser=browser, marker=marker,
                                  baseline=baseline, activated_before_add=activated is not None,
                                  buffered_count=buffered_count,
                                  pre_add_activation_ms=activated,
                                  window_sampling=window_sampling)
            if browser and not baseline:
                self.counters["candidate_windows"] += 1
                if marker:
                    self.counters["marker_windows"] += 1
            return self.emit({"kind": "desktop", "event": event, "window": ident,
                              "candidate": browser, "marker_confirmed": marker,
                              "baseline": baseline, "initial": initial,
                              "activation_buffered": activated is not None,
                              **({"window_sampling": window_sampling}
                                 if window_sampling is not None else {}),
                              **({"activation_elapsed_ms": activated,
                                  "activation_buffered_count": buffered_count}
                                 if activated is not None else {}),
                              **extra}, now=now)
        win = self.windows.get(ident)
        if win is None:
            return None
        if raw.get("candidate", raw.get("browser")) is True and not win["browser"]:
            win["browser"] = True
            if not win["baseline"]:
                self.counters["candidate_windows"] += 1
                if win["marker"]:
                    self.counters["marker_windows"] += 1
        if raw.get("marker_confirmed", raw.get("wake_marker")) is True and not win["marker"]:
            win["marker"] = True
            if win["browser"] and not win["baseline"]:
                self.counters["marker_windows"] += 1
        if event == "window_activated":
            win["activated"] = True
            win["activation_ms"] = stamp
        if event == "window_closed":
            win["closed"] = True
        # Each native packet is an independent snapshot, never a patch.
        # Missing and explicit-null flags both mean unavailable observation;
        # carrying older True/False values would fabricate continuous coverage.
        current_raw = raw.get("current", raw)
        win["current"] = {field: current_raw.get(field) if
                          isinstance(current_raw, dict) and type(current_raw.get(field)) is bool
                          else None for field in BOOL_FIELDS}
        self.background.changed(ident, win["current"], stamp, event,
                                browser=win["browser"], marker=win["marker"],
                                window_sampling=window_sampling)
        return self.emit({"kind": "desktop", "event": event, "window": ident,
                          "candidate": win["browser"], "marker_confirmed": win["marker"],
                          "baseline": win["baseline"], "activation_observed": win["activated"],
                          "current": win["current"].copy(),
                          **({"window_sampling": window_sampling}
                             if window_sampling is not None else {}), **extra}, now=now)

    def cdp(self, projected, *, now=None):
        if not isinstance(projected, dict):
            return
        now = self._sample_now(now)
        if projected.get("error_code"):
            token = projected.get("target")
            if token in self.cdp_targets:
                self.cdp_targets[token] = False
            self.counters["cdp_errors"] += 1
            self.source_health("cdp", "error", now=now)
            return self.emit({"kind": "cdp", "error_code": projected["error_code"],
                              "target": projected.get("target"),
                              "scope": projected.get("scope", "unknown")}, now=now)
        flags_raw = projected.get("observation", projected)
        if not isinstance(flags_raw, dict):
            return
        flags = {x: flags_raw.get(x) if type(flags_raw.get(x)) is bool else None
                 for x in ("ready", "composer", "generating", "login", "error", "dialog", "permission")}
        counts = {x: min(flags_raw.get(x), 100) if type(flags_raw.get(x)) is int and 0 <= flags_raw.get(x) else 0
                  for x in ("composer_count", "dialog_count")}
        token = projected.get("target")
        if isinstance(token, str) and re.fullmatch("[0-9a-f]{16}", token):
            was_ready = self.cdp_targets.get(token, False)
            is_ready = flags["ready"] is True and flags["composer"] is True
            if is_ready and not was_ready:
                self.counters["dom_ready"] += 1
            self.cdp_targets[token] = is_ready
        # No target token => sample cannot establish unique readiness.
        self.last_cdp = {"observation": flags, "counts": counts, "target": token,
                         "indicator_semantics": "structural_potential_only"}
        self.source_health("cdp", "ready", now=now)
        return self.emit({"kind": "cdp", "observation": flags, "counts": counts,
                          "target": token, "scope": projected.get("scope", "new_chatgpt_target"),
                          "indicator_semantics": "structural_potential_only",
                          "pixel_frame": "unknown"}, now=now)

    def probe(self, *, exact, baseline_candidates, native_ready, cdp_ready,
              dispatched_ms=None, completed_ms=None, deadline_ms=None):
        if exact is True:
            self.counters["backend_exact"] += 1
        elif exact is False:
            self.counters["backend_mismatch"] += 1
        else:
            self.counters["probe_unknown"] += 1
        recent = [w for w in self.windows.values()
                  if w["browser"] and not w["baseline"] and dispatched_ms is not None
                  and w["added_ms"] >= dispatched_ms]
        first_added = min((w["added_ms"] - dispatched_ms for w in recent), default=None)
        first_activation = min((w["activation_ms"] - dispatched_ms for w in recent
                                if w["activation_ms"] is not None and w["activation_ms"] >= dispatched_ms),
                               default=None)
        new_window = self.counters["candidate_windows"] > baseline_candidates if native_ready else None
        if exact is True and new_window is False:
            self.counters["warm_possible"] += 1
        if new_window:
            self.counters["cold_window_observed"] += 1
        duration = (max(0, completed_ms - dispatched_ms) if dispatched_ms is not None and completed_ms is not None
                    else None)
        record = {"kind": "probe_result",
                  "backend_completion": "exact" if exact is True else "mismatch" if exact is False else "unknown",
                  "native_new_window": new_window, "dom_source_ready": cdp_ready,
                  "delivery": "observed_new_window" if new_window else "warm_possible_no_new_window" if exact is True and native_ready else "no_new_window_observed" if native_ready else "unknown",
                  "duration_ms": duration, "first_added_after_dispatch_ms": first_added,
                  "first_activation_after_dispatch_ms": first_activation,
                  "open_not_observed_within_ms": (duration if duration is not None else deadline_ms)
                  if new_window is False else None,
                  "completion_unknown": exact is None, "correlation": "temporal_only_no_ownership"}
        self.probes.append({k: v for k, v in record.items() if k not in ("kind",)})
        return self.emit(record)

    def replay_probe_result(self, raw):
        value = raw["backend_completion"]
        self.counters["backend_exact"] += (value == "exact")
        self.counters["backend_mismatch"] += (value == "mismatch")
        self.counters["probe_unknown"] += (value == "unknown")
        self.counters["cold_window_observed"] += (raw.get("native_new_window") is True)
        self.counters["warm_possible"] += (raw.get("delivery") == "warm_possible_no_new_window")
        self.probes.append({k: v for k, v in raw.items() if k not in ("kind", "seq", "elapsed_ms", "collector_wall_ms")})

    def summary(self):
        result = {"schema": 3, "records": self.events,
                  "native_background": self.background.summary(self.native_incomplete),
                  "health": dict(self.health),
                  "capability": dict(self.capability), "cleanup": dict(self.cleanup),
                  "counters": dict(self.counters), "current": dict(self.current),
                  "pending": [{"lane": k[0], "state": k[1], "count": p["count"],
                               "passed": sorted(p["passed"])}
                              for k, p in sorted(self.pending.items())],
                  "probes": list(self.probes),
                  "limits": {"pixel_first_frame": "not_observed", "focus_intent": "unknown",
                             "backend_success_not_gui_success": True,
                             "stalled_times": "first_observed_lower_bound_only",
                             "lane_identity": "unobserved_churn_possible",
                             "status_capacity_wait": "queue_cause_not_exposed",
                             "job_wake_correlation": "aggregate_labels_not_attempt_ids",
                             "native_window_ids": "256_cumulative_per_run_fail_closed",
                             "native_coverage_incomplete": self.native_incomplete}}

        # Bound the *pretty-printed* form that Recorder actually writes.
        # Deterministic ordering gives live CLI, saved and replayed summaries
        # the same representation. Preserve global counts and verdicts as
        # long as possible; only shed high-volume per-window detail first.
        def over_limit():
            return len(json.dumps(result, indent=2, sort_keys=True,
                                  ensure_ascii=True, allow_nan=False).encode()) > MAX_LINE

        if not over_limit():
            return result
        bg = result["native_background"]
        trunc = {"window_episode_timelines": 0, "windows_omitted": 0,
                 "pending_omitted": 0, "probes_omitted": 0,
                 "current_fields_omitted": []}
        result["summary_truncation"] = trunc
        for report in reversed(bg["windows"]):
            if not over_limit():
                break
            if report["episodes"] or report["timeline"]:
                report["episodes"] = []
                report["timeline"] = []
                trunc["window_episode_timelines"] += 1
        while bg["windows"] and over_limit():
            bg["windows"].pop()
            trunc["windows_omitted"] += 1
            bg["truncated"] = True
            bg["reported_windows"] = len(bg["windows"])
        while result["pending"] and over_limit():
            result["pending"].pop()
            trunc["pending_omitted"] += 1
        while result["probes"] and over_limit():
            result["probes"].pop()
            trunc["probes_omitted"] += 1
        for field in ("diagnostics", "jobs", "workers", "worker_flags",
                      "limits", "backend_health", "stalled_suspect"):
            if not over_limit():
                break
            if result["current"].get(field):
                result["current"][field] = {}
                trunc["current_fields_omitted"].append(field)
        if over_limit():
            # The retained fixed-size aggregate counters are still available.
            raise ValueError("summary_aggregate_oversize")
        return result
