/*
 * Manual read-only KWin 6 PID ownership probe. The PID allowlist is embedded
 * in a private transient script, never sent over DBus or written to a report.
 * No caption/title/document/pixel access, no window mutations.
 */
(function () {
    "use strict";
    var SERVICE = __SERVICE__, PATH = __OBJECT__, IFACE = __INTERFACE__;
    var TTL = __TTL_MS__, OWNERS = __OWNERS__;
    var MAX_WINDOWS = 256, MAX_EVENTS = 1024;
    var alive = true, started = Date.now(), sent = 0, dropped = 0;
    var windows = [], connections = [], timeoutTimer = null, baselinePositive = 0;
    var baselineOverflow = false;
    var RE_BROWSER = /^(brave|brave-browser|chromium|chromium-browser|google-chrome(?:-stable|-beta|-unstable)?|firefox(?:-esr)?|librewolf|vivaldi(?:-stable)?|microsoft-edge(?:-stable|-beta|-dev)?)$/;
    function prop(w, key) {
        try { return w == null ? undefined : w[key]; } catch (_e) { return undefined; }
    }
    function bool(w, key) {
        var v = prop(w, key);
        return typeof v === "boolean" ? v : null;
    }
    function pid(w) {
        var p = prop(w, "pid");
        // No coercion, false, zero, fractions, negative or invalid PIDs.
        if (typeof p !== "number" || !isFinite(p) || p < 1 ||
                p > 2147483647 || Math.floor(p) !== p)
            return {has_pid: false, owner_match: null};
        return {has_pid: true, owner_match: OWNERS[String(p)] === true};
    }
    function browser(w) {
        var klass = prop(w, "resourceClass");
        return typeof klass === "string" && RE_BROWSER.test(klass.toLowerCase());
    }
    function connect(w, name, fn) {
        if (connections.length >= 1536) return false;
        try {
            var sig = prop(w, name);
            if (sig && typeof sig.connect === "function") {
                sig.connect(fn);
                connections.push([sig, fn]);
                return true;
            }
        } catch (_e) {}
        return false;
    }
    function find(w) {
        for (var i = 0; i < windows.length; i++)
            if (windows[i].ref === w) return windows[i];
        return null;
    }
    function emit(event, entry, extras) {
        if (!alive && event !== "done") return;
        if (event !== "done" && sent >= MAX_EVENTS) {
            dropped = Math.min(1000000000, dropped + 1);
            return;
        }
        var data = {protocol: "native-pid-v1", event: event};
        if (entry) {
            var info = pid(entry.ref);
            data.window = entry.id;
            data.baseline = entry.baseline;
            data.closed = event === "closed";
            data.browser = browser(entry.ref);
            data.has_pid = info.has_pid;
            data.owner_match = info.owner_match;
            data.normal_window = bool(entry.ref, "normalWindow");
            data.tooltip = bool(entry.ref, "tooltip");
            data.dialog = bool(entry.ref, "dialog");
            data.active = bool(entry.ref, "active");
            data.keep_above = bool(entry.ref, "keepAbove");
            data.demands_attention = bool(entry.ref, "demandsAttention");
        } else {
            data.calibrated = baselinePositive > 0;
            data.baseline_positive_count = baselinePositive;
            data.baseline_truncated = baselineOverflow;
            data.tracked = windows.length;
            data.events_dropped = dropped;
        }
        if (extras) data.timer = extras;
        if (typeof callDBus === "function") {
            try { callDBus(SERVICE, PATH, IFACE, "Push", JSON.stringify(data)); }
            catch (_e) {}
        }
        if (event !== "done") sent++;
    }
    function identify(w, baseline) {
        if (!w) return null;
        var existing = find(w);
        if (existing) return existing;
        if (windows.length >= MAX_WINDOWS) {
            baselineOverflow = true;
            return null;
        }
        var entry = {ref: w, id: "w" + (windows.length + 1),
                     baseline: !!baseline};
        windows.push(entry);
        if (baseline && pid(w).has_pid) baselinePositive++;
        var update = function () { if (alive && entry.ref) emit("changed", entry); };
        connect(w, "propertyChanged", update);
        connect(w, "pidChanged", update);
        connect(w, "activeChanged", update);
        connect(w, "demandsAttentionChanged", update);
        connect(w, "keepAboveChanged", update);
        return entry;
    }
    function added(w) {
        if (!alive || !w) return;
        var entry = identify(w, false);
        if (entry) emit("added", entry);
    }
    function removed(w) {
        if (!alive || !w) return;
        var entry = find(w);
        if (!entry) return;
        emit("closed", entry);
        entry.ref = null; // opaque ID is never reused
    }
    function finish() {
        if (!alive) return;
        if (timeoutTimer) {
            try { timeoutTimer.stop(); } catch (_e) {}
        }
        emit("done", null);
        alive = false;
        for (var i = 0; i < connections.length; i++) {
            try {
                if (typeof connections[i][0].disconnect === "function")
                    connections[i][0].disconnect(connections[i][1]);
            } catch (_e) {}
        }
        connections = [];
        for (var j = 0; j < windows.length; j++) windows[j].ref = null;
    }
    // Connect first, then snapshot baseline, then READY, then bounded watch.
    var canAdd = connect(workspace, "windowAdded", added);
    var canRemove = connect(workspace, "windowRemoved", removed) ||
                    connect(workspace, "windowClosed", removed);
    var existing = null;
    try {
        if (typeof workspace.windowList === "function")
            existing = workspace.windowList();
        else {
            existing = prop(workspace, "stackingOrder");
            if (typeof existing === "function") existing = existing.call(workspace);
        }
    } catch (_e) {}
    var baselineEnumerated = !!existing && typeof existing.length === "number";
    if (baselineEnumerated) {
        var size = Math.min(existing.length, MAX_WINDOWS + 1);
        for (var k = 0; k < size; k++) identify(existing[k], true);
        if (existing.length > MAX_WINDOWS) baselineOverflow = true;
    }
    var timerWorks = false;
    try {
        if (typeof QTimer === "function") {
            timeoutTimer = new QTimer();
            timeoutTimer.interval = Math.max(1, TTL - (Date.now() - started));
            timeoutTimer.singleShot = true;
            if (connect(timeoutTimer, "timeout", finish)) {
                timeoutTimer.start();
                timerWorks = true;
            }
        }
    } catch (_e) {}
    emit("ready", null, {added: canAdd, removed: canRemove,
         baseline: baselineEnumerated, ttl: timerWorks});
    if (!canAdd || !canRemove || !baselineEnumerated || !timerWorks) {
        finish();
    } else {
        for (var m = 0; m < windows.length; m++)
            if (windows[m].ref) emit("baseline", windows[m]);
    }
})();
