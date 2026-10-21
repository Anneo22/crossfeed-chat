"""One strict, bounded, privacy-safe native capability projection for all interfaces."""

REASONS = frozenset((
    "adapter_missing", "adapter_failure", "platform_unsupported",
    "kwin_unavailable", "permission_denied", "not_running", "available",
    "ready", "unknown", "script_unavailable", "none", "missing_qdbus",
    "not_wayland", "not_kde", "missing_python_bindings",
    "scripting_unavailable", "not_started", "owner_changed",
    "ttl_unavailable", "missing_signals", "heartbeat_expired",
    "internal_error", "already_started", "invalid_duration",
    "load_failed", "run_failed", "delivery_timeout", "cleanup_failed",
    "closed", "capacity_exhausted", "capacity_overflow", "coverage_incomplete",
))
FEATURES = (
    "added", "removed", "activation", "stacking", "stacking_sampled",
    "sampling_timer", "desktop", "activity", "caption", "resource_class",
    "active_changed", "minimized", "window_desktops", "window_activities",
    "keep_above_changed", "keep_below_changed", "demands_attention_changed",
    "on_all_desktops_changed", "on_all_activities_changed", "property_changed",
    "property_active", "property_minimized", "property_keep_above",
    "property_keep_below", "property_demands_attention",
    "property_on_current_desktop", "property_on_current_activity",
    "baseline", "transport", "ttl", "heartbeat",
)
STACKING_MODES = frozenset(("signal", "targeted_50ms", "sample_on_events", "unavailable"))


PLATFORM_MODES = frozenset(("explicit_wayland_kde", "uncertain", "incompatible"))
SAMPLING_FIELDS = frozenset(("interval_ms", "ticks", "gaps", "max_gap_ms",
                             "candidates", "running", "healthy", "min_candidate_ticks"))


def safe_sampling(raw):
    if not isinstance(raw, dict) or set(raw) != SAMPLING_FIELDS:
        return None
    if (type(raw.get("min_candidate_ticks")) not in (int, type(None))
            or type(raw.get("min_candidate_ticks")) is int
            and not 0 <= raw["min_candidate_ticks"] <= 1000000000
            or type(raw.get("interval_ms")) is not int or raw["interval_ms"] != 50
            or any(type(raw.get(k)) is not int or not 0 <= raw[k] <= 1000000000
                   for k in ("ticks", "gaps", "max_gap_ms"))
            or type(raw.get("candidates")) is not int
            or not 0 <= raw["candidates"] <= 256
            or any(type(raw.get(k)) is not bool for k in ("running", "healthy"))
            or raw["healthy"] and not raw["running"]):
        return None
    return {k: raw[k] for k in SAMPLING_FIELDS}


WINDOW_SAMPLING_FIELDS = frozenset(("ticks", "gaps", "max_gap_ms", "complete"))


def safe_window_sampling(raw):
    """Optional per-window terminal coverage evidence, never a global inference."""
    if (not isinstance(raw, dict) or set(raw) != WINDOW_SAMPLING_FIELDS
            or any(type(raw[k]) is not int or not 0 <= raw[k] <= 1000000000
                   for k in ("ticks", "gaps", "max_gap_ms"))
            or type(raw["complete"]) is not bool
            or raw["complete"] and (raw["ticks"] < 2 or raw["gaps"] != 0)):
        return None
    return {key: raw[key] for key in WINDOW_SAMPLING_FIELDS}


def safe_capability(raw):
    """No native arbitrary strings, objects, or unbounded counters can escape."""
    raw = raw if isinstance(raw, dict) else {}
    status = raw.get("status")
    if status not in ("ready", "unsupported", "error"):
        status = "error"
    reason = raw.get("reason")
    reason = reason if type(reason) is str and reason in REASONS else "unknown"
    result = {"status": status, "reason": reason, "backend": "kde-kwin"}
    caps = raw.get("capabilities")
    if isinstance(caps, dict):
        result["capabilities"] = {
            name: caps[name] if type(caps.get(name)) is bool else None
            for name in FEATURES
        }
    mode = raw.get("stacking_mode")
    if mode is not None:
        result["stacking_mode"] = mode if type(mode) is str and mode in STACKING_MODES else "unavailable"
    if "platform_mode" in raw:
        mode = raw["platform_mode"]
        result["platform_mode"] = mode if type(mode) is str and mode in PLATFORM_MODES else "uncertain"
    if "sampling" in raw:
        sampling = safe_sampling(raw["sampling"])
        if sampling is None:
            if result["status"] == "ready":
                result.update(status="unsupported", reason="coverage_incomplete")
        else:
            result["sampling"] = sampling
            if result["status"] == "ready" and (sampling["gaps"] or not sampling["healthy"]):
                result.update(status="unsupported", reason="coverage_incomplete")
    capacity = raw.get("capacity")
    if capacity is not None:
        if (isinstance(capacity, dict) and set(capacity) == {"limit", "tracked", "overflow", "unknown"}
                and type(capacity["limit"]) is int and capacity["limit"] == 256
                and all(type(capacity[k]) is int and 0 <= capacity[k] <= 1000000000
                        for k in ("tracked", "overflow", "unknown"))
                and capacity["tracked"] <= 256 and capacity["unknown"] <= capacity["overflow"]):
            result["capacity"] = {k: capacity[k] for k in ("limit", "tracked", "overflow", "unknown")}
            if status == "ready":
                if capacity["tracked"] >= 256:
                    result.update(status="unsupported", reason="capacity_exhausted")
                elif capacity["overflow"] or capacity["unknown"]:
                    result.update(status="unsupported", reason="capacity_overflow")
        elif status == "ready":
            result.update(status="unsupported", reason="coverage_incomplete")
    if "closed" in raw:
        result["closed"] = raw.get("closed") is True
        if type(raw.get("closed")) is not bool and status == "ready":
            result.update(status="unsupported", reason="coverage_incomplete")
        elif result["closed"] and result["status"] == "ready":
            result.update(status="unsupported", reason="closed")
    return result
