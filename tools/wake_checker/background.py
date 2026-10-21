"""Bounded metadata-only KDE background/annoyance evidence.

Neither relative stacking nor active flags prove user intent or first painted pixels.
All durations are completed observed intervals, not continuous pixel measurements.
"""
FIELDS = ("active", "minimized", "on_current_desktop", "above_previous",
          "on_current_activity", "keep_above", "keep_below", "demands_attention")


def flags(raw):
    raw = raw if isinstance(raw, dict) else {}
    return {key: raw.get(key) if type(raw.get(key)) is bool else None for key in FIELDS}


def visual_stack(state):
    gates = (state["above_previous"], state["on_current_desktop"],
             state["on_current_activity"],
             None if state["minimized"] is None else not state["minimized"])
    if any(v is False for v in gates):
        return False
    return True if all(v is True for v in gates) else None


class BackgroundTracker:
    """No image, title, application, activity ID, desktop ID or private join."""

    def __init__(self):
        self.windows = {}
        self.sampling = None
        self.incomplete = False

    @staticmethod
    def _close(win, channel, at, uncertain=False):
        start = win["opened"][channel]
        if start is None:
            return
        win["opened"][channel] = None
        duration = max(0, at - start)
        if not uncertain:
            win["completed"][channel] += duration
            win["maximum"][channel] = max(win["maximum"][channel], duration)
        else:
            win["uncertain"] = True
        if len(win["episodes"]) < 4:
            win["episodes"].append({
                "type": channel, "start_ms": start, "end_ms": at,
                "completed_observable_ms": None if uncertain else duration,
                "uncertain": uncertain})

    def _observe(self, win, at, event, *, first=False):
        state = win["current"]
        # A verified removal bounds a previously observed episode; it is not
        # an exact first/last painted-pixel timestamp.
        closing = event == "window_closed"
        active = False if closing else True if event == "window_activated" else state["active"]
        visual = False if closing else visual_stack(state)
        for kind, value in (("active", active), ("visual", visual)):
            previous = win["observed"][kind]
            if previous is True and value is not True:
                self._close(win, kind, at, uncertain=value is None)
            if value is True and previous is not True:
                win["episode_counts"][kind] += 1
                win["opened"][kind] = at
                if not first:
                    win["later"][kind] += 1
                    if kind == "active" and win["episode_counts"][kind] > 1:
                        win["reforeground"] += 1
            if value is None:
                win["uncertain"] = True
            win["observed"][kind] = value
        for field in ("demands_attention", "keep_above"):
            if state[field] is True and (win["previous_flags"][field] is False
                                         or first and win["previous_flags"][field] is None):
                win["rises"][field] += 1
            win["previous_flags"][field] = state[field]
        snap = {"at_ms": at, "event": event, "active_foreground": active,
                "visual_stack": visual, "attention": state["demands_attention"],
                "topmost": state["keep_above"]}
        if len(win["timeline"]) < 4:
            win["timeline"].append(snap)
        else:
            win["timeline"] = [win["timeline"][0]] + win["timeline"][-2:] + [snap]

    def added(self, ident, first_state, at, *, browser=False, marker=False,
              baseline=False, activated_before_add=False, buffered_count=0,
              pre_add_activation_ms=None, window_sampling=None):
        if len(self.windows) >= 256 or ident in self.windows:
            self.incomplete = True
            return
        initial = flags(first_state)
        positive = (activated_before_add or initial["active"] is True
                    or visual_stack(initial) is True)
        first = ("failed" if positive else "observed_background"
                 if initial["active"] is False and visual_stack(initial) is False
                 else "unknown")
        win = {
            "initial": initial, "current": initial.copy(), "browser": bool(browser),
            "marker": bool(marker), "baseline": bool(baseline),
            "initial_background": first, "activated_before_add": bool(activated_before_add),
            "pre_add_activation_ms": pre_add_activation_ms,
            "pre_add_activation_count": buffered_count if activated_before_add else 0,
            "activation_count": min(256, buffered_count) if activated_before_add else 0,
            "observed": {"active": None, "visual": None},
            "episode_counts": {"active": 0, "visual": 0},
            "later": {"active": 0, "visual": 0},
            "opened": {"active": None, "visual": None},
            "completed": {"active": 0, "visual": 0},
            "maximum": {"active": 0, "visual": 0},
            "rises": {"demands_attention": 0, "keep_above": 0},
            "previous_flags": {"demands_attention": None, "keep_above": None},
            "reforeground": 0, "episodes": [], "timeline": [],
            "uncertain": any(v is None for v in initial.values()),
            "gaps": 0, "sampled": False, "closed": False,
            "window_sampling": window_sampling,
        }
        self.windows[ident] = win
        self._observe(win, at, "window_activated" if activated_before_add else
                      "window_added", first=True)

    def changed(self, ident, current, at, event, *, browser=False, marker=False,
                window_sampling=None):
        win = self.windows.get(ident)
        if win is None or win["closed"]:
            return
        win["browser"] = win["browser"] or bool(browser)
        win["marker"] = win["marker"] or bool(marker)
        # Null is an observation of unavailable metadata, not an invitation
        # to keep an old, falsely confident boolean.
        win["current"].update(flags(current))
        if window_sampling is not None:
            win["window_sampling"] = window_sampling
        if event == "window_activated":
            win["activation_count"] += 1
        self._observe(win, at, event)
        if any(v is None for v in win["current"].values()):
            win["uncertain"] = True
        if event == "window_closed":
            win["closed"] = True

    def gap(self, at):
        self.incomplete = True
        for win in self.windows.values():
            if win["closed"]:
                continue
            win["gaps"] += 1
            win["current"] = {field: None for field in FIELDS}
            win["previous_flags"] = {"demands_attention": None, "keep_above": None}
            for channel in ("active", "visual"):
                self._close(win, channel, at, uncertain=True)
                win["observed"][channel] = None

    def sampled(self, sample):
        self.sampling = sample
        if sample["gaps"] or not sample["healthy"]:
            self.incomplete = True
            return
        # Exact KWin minimum over currently monitored browser candidates:
        # all targets must have received at least two timer callbacks.
        if sample["ticks"] == 0 or sample.get("min_candidate_ticks") is None:
            return
        # Aggregated candidate ticks cannot prove an individual window had
        # coverage from first observation through its removal. Only a
        # window-specific terminal coverage record may establish that.

    @staticmethod
    def _report(ident, win, healthy):
        no_observed = (win["initial_background"] == "observed_background"
                       and not any(win["episode_counts"].values())
                       and healthy and win["closed"]
                       and isinstance(win["window_sampling"], dict)
                       and win["window_sampling"].get("complete") is True
                       and win["window_sampling"]["ticks"] >= 2
                       and win["window_sampling"]["gaps"] == 0
                       and not win["uncertain"] and not win["gaps"])
        verdict = ("initial_foreground_failed" if win["initial_background"] == "failed"
                   else "later_foreground_observed" if any(win["later"].values())
                   else "no_observed_foreground_at_50ms" if no_observed
                   else "indeterminate")
        return {
            "window": ident, "ownership": "wake_marker" if win["marker"]
            else "browser_candidate", "initial_background": win["initial_background"],
            "background_verdict": verdict, "initial": win["initial"],
            "current": win["current"],
            "current_active_foreground": win["observed"]["active"],
            "current_visual_stack": win["observed"]["visual"],
            "activation_count": win["activation_count"],
            "pre_add_activation_ms": win["pre_add_activation_ms"],
            "pre_add_activation_count": win["pre_add_activation_count"],
            "reforeground_episodes": win["reforeground"],
            "later_exposure_episodes": win["later"],
            "completed_observable_total_ms": win["completed"],
            "max_completed_foreground_ms": win["maximum"],
            "open_episode_start_ms": win["opened"],
            "attention_rises": win["rises"]["demands_attention"],
            "topmost_rises": win["rises"]["keep_above"],
            "sampling_resolution_ms": 50,
            "duration_semantics": "bounded_observed_episode_not_pixel_exposure",
            "window_sampling": win["window_sampling"],
            "complete_period_coverage": bool(win["closed"] and
                isinstance(win["window_sampling"], dict) and
                win["window_sampling"].get("complete") is True),
            "duration_uncertain": bool(win["uncertain"] or win["gaps"]
                                       or not isinstance(win["window_sampling"], dict)
                                       or not win["window_sampling"].get("complete")),
            "closed": win["closed"], "episodes": win["episodes"],
            "timeline": win["timeline"],
        }

    def summary(self, incomplete=False):
        candidates = [(key, win) for key, win in self.windows.items()
                      if win["browser"] and not win["baseline"]]
        sample = self.sampling
        healthy = (not (self.incomplete or incomplete) and sample is not None
                   and sample["healthy"] and sample["gaps"] == 0
                   and sample["ticks"] > 0)
        reports = [self._report(key, win, healthy) for key, win in candidates[:24]]
        return {
            "meaning": "sampled_metadata_only_never_first_pixel_pass",
            "sampling_interval_ms": 50, "sampling": sample,
            "total_candidate_windows": len(candidates), "reported_windows": len(reports),
            "truncated": len(reports) < len(candidates),
            "initial_failures": sum(win["initial_background"] == "failed"
                                    for _key, win in candidates),
            "activation_count": sum(win["activation_count"] for _key, win in candidates),
            "reforeground_episodes": sum(win["reforeground"] for _key, win in candidates),
            "later_active_episodes": sum(win["later"]["active"] for _key, win in candidates),
            "later_visual_episodes": sum(win["later"]["visual"] for _key, win in candidates),
            "attention_rises": sum(win["rises"]["demands_attention"]
                                   for _key, win in candidates),
            "topmost_rises": sum(win["rises"]["keep_above"] for _key, win in candidates),
            "windows": reports
        }
