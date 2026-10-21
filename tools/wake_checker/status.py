"""Allowlisted projection of authenticated /status, with no raw identifiers."""
import hashlib
import hmac
import json
import re
import math
import time
import unicodedata

MAX_STATUS_BYTES = 262144
MAX_ITEMS = 256
STATES = frozenset(("queued", "issued", "claimed", "confirmed", "failed", "expired", "cancelled", "completed", "done"))
PENDING = frozenset(("queued", "issued", "claimed"))
STAGES = frozenset(("claim", "create", "attach", "activate", "load", "ready", "modelFocus", "picker", "sliderFocus", "editorFocus", "mention", "resolved", "uploadInput", "upload", "uploads", "send", "registration", "input", "enter", "observe", "result"))
ERROR_CODES = frozenset(("invalid_ticket", "page_not_ready", "page_changed", "mode_unconfirmed", "level_unconfirmed", "upload_unconfirmed", "upload_failed", "composer_not_empty", "mention_unconfirmed", "send_unconfirmed", "claim_refused", "expired", "browser_error", "rate_limited"))
CONTACT = frozenset(("never", "stale", "recent"))
JOB_STATES = frozenset(("queued", "claimed", "active", "finished", "done", "failed", "cancelled", "expired", "completed"))
_HEX = re.compile(r"^[0-9a-f]{64}$")


class StatusError(ValueError):
    """Only safe error constants."""


def _items(data, key):
    value = data.get(key)
    if not isinstance(value, list) or len(value) > MAX_ITEMS or not all(isinstance(x, dict) for x in value):
        raise StatusError("invalid_schema")
    return value


def _integer(value, limit=1000000):
    return value if type(value) is int and 0 <= value <= limit else None


def _enum(value, allowed):
    return value if type(value) is str and value in allowed else "unknown"


def valid_label(label):
    """Host-compatible, trimmed UTF-8 <=128 bytes, excluding Unicode C controls."""
    return (type(label) is str and bool(label) and label == label.strip()
            and not any(unicodedata.category(ch).startswith("C") for ch in label)
            and len(label.encode("utf-8")) <= 128)


def lane_key(row):
    label, session = row.get("label"), row.get("worker_session")
    if not valid_label(label):
        raise StatusError("invalid_schema")
    if session is not None and (type(session) is not str or not _HEX.fullmatch(session)):
        raise StatusError("invalid_schema")
    return label + "\0" + (session or "")


def fingerprint(salt, label):
    return hmac.new(salt, label.encode("utf-8"), hashlib.sha256).hexdigest()[:16]


def project_status(raw, salt, *, now_ms=None):
    """Correlate only by lane; duplicate wakes are ambiguous, not attempt IDs."""
    if not isinstance(raw, dict):
        raise StatusError("invalid_schema")
    now_ms = time.time() * 1000 if now_ms is None else now_ms
    workers, wakes, jobs = (_items(raw, k) for k in ("workers", "wakes", "jobs"))
    lanes = {}

    def get(row):
        key = lane_key(row)
        return lanes.setdefault(key, {"lane": fingerprint(salt, key),
                                       "worker": "unknown", "wakes": {}, "jobs": {}})

    for worker in workers:
        row = get(worker)
        row["worker"] = _enum(worker.get("contact"), CONTACT)
        for field in ("awake", "polling", "busy", "processing_claim", "quota_blocked"):
            row[field] = worker.get(field) if type(worker.get(field)) is bool else None
        row["queued"] = _integer(worker.get("queued"))
        until = worker.get("quota_until")
        row["quota_active"] = (until > now_ms if type(until) in (int, float) and math.isfinite(until) and until >= 0 else None)
    for wake in wakes:
        row = get(wake)
        state = _enum(wake.get("state"), STATES)
        row["wakes"][state] = row["wakes"].get(state, 0) + 1
        if state in ("failed", "expired"):
            row.setdefault("diagnostics", []).append({
                "stage": _enum(wake.get("failure_stage", wake.get("stage")), STAGES),
                "code": _enum(wake.get("failure_code", wake.get("error_code")), ERROR_CODES)})
    for job in jobs:
        row = get(job)
        state = _enum(job.get("state"), JOB_STATES)
        row["jobs"][state] = row["jobs"].get(state, 0) + 1
        if state == "failed":
            row.setdefault("diagnostics", []).append({"stage": "unknown",
                "code": _enum(job.get("error"), ERROR_CODES)})

    limits = raw.get("wake_limits")
    limits = limits if isinstance(limits, dict) else {}
    caps = {
        "daily": {"attempts": _integer(limits.get("attempts")),
                  "cap": _integer(limits.get("daily_cap")),
                  "mode": "off" if limits.get("daily_cap") == 0
                  and type(limits.get("daily_cap")) is int else
                  "on" if _integer(limits.get("daily_cap")) is not None else "unknown"},
        "hourly": {"attempts": _integer(limits.get("hourly_attempts")),
                   "cap": _integer(limits.get("hourly_cap")),
                   "mode": "paused" if type(limits.get("hourly_cap")) is int
                   and limits["hourly_cap"] == 0 else
                   "on" if _integer(limits.get("hourly_cap")) is not None else "unknown"},
        "cooldown": (limits["cooldown_until"] > now_ms
                     if type(limits.get("cooldown_until")) in (int, float)
                     and math.isfinite(limits["cooldown_until"]) and limits["cooldown_until"] >= 0
                     else None),
    }
    # Installed /status exposes extension_poll, not an extension_heartbeat.
    poll = raw.get("extension_poll")
    poll = poll if isinstance(poll, dict) else {}
    contact = poll.get("last_contact_at")
    age = (min(round(now_ms - contact), 86400000)
           if type(contact) in (int, float) and math.isfinite(contact)
           and 0 <= contact <= now_ms else None)
    health = {"status": "ready",
              "host": raw.get("host_available") if type(raw.get("host_available")) is bool else None,
              "extension_enabled": raw.get("extension_enabled") if type(raw.get("extension_enabled")) is bool else None,
              "extension_heartbeat": "unknown", "extension_heartbeat_age_ms": None,
              "extension_poll_recent": poll.get("recent") if type(poll.get("recent")) is bool else None,
              "extension_contact_age_ms": age}
    capacity = raw.get("capacity")
    if (not isinstance(capacity, dict)
            or _integer(capacity.get("claimed")) is None
            or _integer(capacity.get("limit")) is None):
        claimed = None
    else:
        claimed = {"claimed": capacity["claimed"], "limit": capacity["limit"]}
    return {"kind": "status", "lanes": sorted(lanes.values(), key=lambda x: x["lane"]),
            "limits": caps, "health": health, "capacity": claimed}


def parse_status(data, salt):
    if len(data) > MAX_STATUS_BYTES:
        raise StatusError("oversize")
    try:
        raw = json.loads(data)
    except (UnicodeDecodeError, ValueError):
        raise StatusError("invalid_json") from None
    return project_status(raw, salt)
