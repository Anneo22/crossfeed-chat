/*
 * Finite, read-only KWin 6 metadata observer. No window/focus/state writes.
 * Strings read locally for boolean classification never cross DBus.
 */
(function () {
    "use strict";
    var SERVICE = __SERVICE__;
    var OBJECT_PATH = __OBJECT__;
    var INTERFACE = __INTERFACE__;
    var TTL_MS = __TTL_MS__;
    var INTERVAL_MS = 50;
    var maximum = 256, alive = true, started = Date.now();
    var windows = [], tracked = [], baseline = [], sampled = [], lastSample = [], sampleCounts = [];
    var addedAt = [], lastCandidateTick = [], candidateGaps = [], candidateMaxGap = [];
    var previous = null, heartbeatTimer = null, ttlTimer = null, sampleTimer = null;
    var overflow = 0, unknown = 0, ticks = 0, gaps = 0, maxGap = 0, lastTick = null;
    var RE_WAKE = /^Crossfeed Wake [0-9a-f]{32}(?: [\u2014-] (?:Brave|Brave Browser|Google Chrome|Chromium))?$/;
    var RE_BROWSER = /^(brave|brave-browser|chromium|chromium-browser|google-chrome(?:-stable|-beta|-unstable)?|firefox(?:-esr)?|librewolf|vivaldi(?:-stable)?|microsoft-edge(?:-stable|-beta|-dev)?)$/;

    function property(o, name) {
        try { return o == null ? undefined : o[name]; } catch (_error) { return undefined; }
    }
    function safeBool(o, name) {
        var value = property(o, name);
        return typeof value === "boolean" ? value : null;
    }
    function signal(o, name, cb) {
        try {
            if (o && o[name] && typeof o[name].connect === "function") {
                o[name].connect(cb);
                return true;
            }
        } catch (_error) {}
        return false;
    }
    function feature(name, present) {
        if (features[name] === null) features[name] = present;
        else features[name] = features[name] && present;
    }
    function indexOfWindow(w) {
        for (var i = 0; i < windows.length; i++) if (windows[i] === w) return i;
        return -1;
    }
    function capacity() {
        return {limit: maximum, tracked: windows.length, overflow: overflow, unknown: unknown};
    }
    function stack() {
        var order = property(workspace, "stackingOrder");
        if (typeof order === "function") {
            try { order = order.call(workspace); } catch (_error) { return null; }
        }
        return order && typeof order.length === "number" ? order : null;
    }
    function abovePrevious(w) {
        if (!w || !previous || w === previous) return null;
        var order = stack();
        if (!order) return null;
        var own = -1, old = -1;
        for (var i = 0; i < order.length; i++) {
            if (order[i] === w) own = i;
            if (order[i] === previous) old = i;
        }
        return own < 0 || old < 0 ? null : own > old;
    }
    function currentDesktop(w) {
        if (!w) return null;
        if (safeBool(w, "onAllDesktops") === true) return true;
        var desktops = property(w, "desktops");
        if (!desktops || typeof desktops.length !== "number") return null;
        if (desktops.length === 0) return true; // KWin all-desktops convention
        var active = property(workspace, "currentDesktop");
        if (active === undefined || active === null) return null;
        for (var i = 0; i < desktops.length; i++) if (desktops[i] === active) return true;
        return false;
    }
    function currentActivity(w) {
        if (!w) return null;
        if (safeBool(w, "onAllActivities") === true) return true;
        var activities = property(w, "activities");
        if (!activities || typeof activities.length !== "number") return null;
        if (activities.length === 0) return true; // KWin empty list means all activities
        var active = property(workspace, "currentActivity");
        if (typeof active !== "string" || active.length === 0) return null;
        for (var i = 0; i < activities.length; i++) if (activities[i] === active) return true;
        return false;
    }
    function browser(w) {
        var klass = property(w, "resourceClass");
        return typeof klass === "string" && RE_BROWSER.test(klass.toLowerCase());
    }
    function marker(w) {
        var caption = property(w, "caption");
        return typeof caption === "string" && RE_WAKE.test(caption);
    }
    function flags(w) {
        return {
            active: safeBool(w, "active"),
            minimized: safeBool(w, "minimized"),
            on_current_desktop: currentDesktop(w),
            on_current_activity: currentActivity(w),
            above_previous: abovePrevious(w),
            keep_above: safeBool(w, "keepAbove"),
            keep_below: safeBool(w, "keepBelow"),
            demands_attention: safeBool(w, "demandsAttention")
        };
    }
    function fingerprint(o) {
        return JSON.stringify(flags(o));
    }
    function windowSampling(n, event) {
        var elapsed = lastCandidateTick[n] === null ? null :
            Math.max(0, Date.now() - lastCandidateTick[n]);
        var maxGap = Math.max(candidateMaxGap[n] || 0, elapsed || 0);
        var gapsHere = candidateGaps[n] || 0;
        if (elapsed !== null && elapsed > 125) gapsHere++;
        return {ticks: sampleCounts[n] || 0,
                gaps: Math.min(1000000000, gapsHere),
                max_gap_ms: Math.min(1000000000, maxGap),
                complete: event === "window_closed" &&
                    addedAt[n] !== null && lastCandidateTick[n] !== null &&
                    sampleCounts[n] >= 2 && gapsHere === 0 &&
                    !!sampleTimer && alive};
    }
    function samplingHealth() {
        var minCandidateTicks = null;
        for (var i = 0; i < sampled.length; i++) {
            var index = indexOfWindow(sampled[i]);
            if (index >= 0) {
                var count = sampleCounts[index];
                minCandidateTicks = minCandidateTicks === null ? count :
                    Math.min(minCandidateTicks, count);
            }
        }
        return {interval_ms: INTERVAL_MS, ticks: ticks, gaps: gaps,
                min_candidate_ticks: minCandidateTicks,
                max_gap_ms: maxGap, candidates: sampled.length,
                running: !!sampleTimer && alive,
                healthy: !!sampleTimer && alive && gaps === 0 &&
                    (lastTick === null || Date.now() - lastTick <= 150)};
    }
    function send(event, w, special) {
        if (!alive || typeof callDBus !== "function") return;
        var id = w ? identify(w, false) : null;
        var n = w ? indexOfWindow(w) : -1;
        if (w && id === null) {
            unknown = Math.min(1000000000, unknown + 1);
            if (unknown === 1 || (unknown & (unknown - 1)) === 0)
                send("capacity_changed", null);
        }
        var isBase = n >= 0 && baseline[n];
        var state = w ? flags(w) : flags(null);
        var packet = {
            kind: "desktop", event: event, window: id,
            browser: !!(w && browser(w)),
            wake_marker: !!(w && !isBase && marker(w)),
            baseline: !!isBase, native_ms: Date.now(),
            active: state.active, minimized: state.minimized,
            on_current_desktop: state.on_current_desktop,
            on_current_activity: state.on_current_activity,
            above_previous: state.above_previous, keep_above: state.keep_above,
            keep_below: state.keep_below, demands_attention: state.demands_attention
        };
        if (n >= 0) packet.window_sampling = windowSampling(n, event);
        if (special) packet.capabilities = special;
        if (event === "ready" || event === "heartbeat" || event === "capacity_changed")
            packet.capacity = capacity();
        if (event === "ready" || event === "heartbeat")
            packet.sampling = samplingHealth();
        try { callDBus(SERVICE, OBJECT_PATH, INTERFACE, "Push", JSON.stringify(packet)); }
        catch (_error) {}
    }
    function identify(w, isBaseline) {
        if (!w) return null;
        var n = indexOfWindow(w);
        if (n < 0) {
            if (windows.length >= maximum) {
                overflow = Math.min(1000000000, overflow + 1);
                if (overflow === 1 || (overflow & (overflow - 1)) === 0)
                    send("capacity_changed", null);
                return null;
            }
            n = windows.length;
            windows.push(w);
            tracked.push(false);
            baseline.push(!!isBaseline);
            lastSample.push(null);
            sampleCounts.push(0);
            addedAt.push(null);
            lastCandidateTick.push(null);
            candidateGaps.push(0);
            candidateMaxGap.push(0);
            attach(w);
        }
        return "w" + (n + 1);
    }
    function consider(w) {
        var n = indexOfWindow(w);
        if (n < 0 || !tracked[n] || baseline[n] || !browser(w)) return;
        if (sampled.indexOf(w) < 0) {
            sampled.push(w);
            lastSample[n] = fingerprint(w);
            // Anchor coverage to first-added, never to later classification.
            lastCandidateTick[n] = addedAt[n];
            if (sampled.length === 1) lastTick = null;
        }
    }
    function attach(w) {
        var updated = function () {
            var n = indexOfWindow(w);
            if (n < 0 || !alive) return;
            consider(w); // e.g. resourceClass/caption hydrated after addition
            send("window_changed", w);
            lastSample[n] = fingerprint(w);
        };
        var pairs = [
            ["caption", "captionChanged"],
            ["resource_class", "resourceClassChanged"],
            ["active_changed", "activeChanged"],
            ["minimized", "minimizedChanged"],
            ["window_desktops", "desktopsChanged"],
            ["window_activities", "activitiesChanged"],
            ["keep_above_changed", "keepAboveChanged"],
            ["keep_below_changed", "keepBelowChanged"],
            ["demands_attention_changed", "demandsAttentionChanged"],
            ["on_all_desktops_changed", "onAllDesktopsChanged"],
            ["on_all_activities_changed", "onAllActivitiesChanged"],
            ["property_changed", "propertyChanged"]
        ];
        for (var i = 0; i < pairs.length; i++)
            feature(pairs[i][0], signal(w, pairs[i][1], updated));
        var props = [
            ["property_active", safeBool(w, "active") !== null],
            ["property_minimized", safeBool(w, "minimized") !== null],
            ["property_keep_above", safeBool(w, "keepAbove") !== null],
            ["property_keep_below", safeBool(w, "keepBelow") !== null],
            ["property_demands_attention", safeBool(w, "demandsAttention") !== null],
            ["property_on_current_desktop", currentDesktop(w) !== null],
            ["property_on_current_activity", currentActivity(w) !== null]
        ];
        for (var j = 0; j < props.length; j++) feature(props[j][0], props[j][1]);
    }
    var features = {
        added: false, removed: false, activation: false, stacking: false,
        stacking_sampled: false, sampling_timer: false, desktop: false, activity: false,
        caption: null, resource_class: null, active_changed: null, minimized: null,
        window_desktops: null, window_activities: null,
        keep_above_changed: null, keep_below_changed: null,
        demands_attention_changed: null, on_all_desktops_changed: null,
        on_all_activities_changed: null, property_changed: null,
        property_active: null, property_minimized: null,
        property_keep_above: null, property_keep_below: null,
        property_demands_attention: null, property_on_current_desktop: null,
        property_on_current_activity: null,
        baseline: false, transport: typeof callDBus === "function",
        ttl: false, heartbeat: false
    };
    function stop() {
        if (!alive) return;
        alive = false;
        try { if (sampleTimer) sampleTimer.stop(); } catch (_error) {}
        try { if (heartbeatTimer) heartbeatTimer.stop(); } catch (_error) {}
        try { if (ttlTimer) ttlTimer.stop(); } catch (_error) {}
        sampled = []; // release target references, never continue polling
    }
    function makeTimer(ms, cb) {
        try {
            if (typeof QTimer !== "function") return null;
            var timer = new QTimer();
            timer.interval = ms;
            timer.singleShot = false;
            if (!signal(timer, "timeout", cb)) return null;
            timer.start();
            return timer;
        } catch (_error) { return null; }
    }
    function listedWindows() {
        try { if (typeof workspace.windowList === "function") return workspace.windowList(); }
        catch (_error) {}
        return stack();
    }
    function onAdded(w) {
        if (!alive || !w || !identify(w, false)) return;
        var n = indexOfWindow(w);
        if (tracked[n]) return;
        baseline[n] = false; // early activation may have identified it provisionally
        tracked[n] = true;
        addedAt[n] = Date.now();
        send("window_added", w); // immutable first-added snapshot, even before hydration
        consider(w);
    }
    function onRemoved(w) {
        if (!alive || !w) return;
        var n = indexOfWindow(w);
        if (n < 0) return;
        send("window_closed", w);
        if (previous === w) previous = null;
        var sampledAt = sampled.indexOf(w);
        if (sampledAt >= 0) sampled.splice(sampledAt, 1);
        windows[n] = null; // never reuse an ID
        lastSample[n] = null;
        addedAt[n] = null;
        lastCandidateTick[n] = null;
        if (sampled.length === 0) lastTick = null;
    }
    function onActivated(w) {
        if (!alive) return;
        var active = w || property(workspace, "activeWindow");
        if (!active) return;
        identify(active, true); // provisional; not proof of a newly opened window
        send("window_activated", active);
        consider(active);
    }
    function onStackChanged() {
        if (!alive) return;
        for (var i = 0; i < sampled.length; i++) {
            var w = sampled[i], n = indexOfWindow(w);
            if (n >= 0) {
                send("window_changed", w);
                lastSample[n] = fingerprint(w);
            }
        }
    }
    function onDesktopChanged() { send("desktop_changed", null); onStackChanged(); }
    function onActivityChanged() { send("activity_changed", null); onStackChanged(); }
    function sampleCandidates() {
        if (!alive) return;
        var now = Date.now();
        if (now - started >= TTL_MS) { stop(); return; }
        if (sampled.length === 0) return;
        if (lastTick !== null) {
            var delta = Math.max(0, now - lastTick);
            maxGap = Math.min(1000000000, Math.max(maxGap, delta));
            if (delta > 125) gaps = Math.min(1000000000, gaps + 1);
        }
        lastTick = now;
        ticks = Math.min(1000000000, ticks + 1);
        // Only new nonbaseline browser candidates, never rescan native 256 IDs.
        for (var i = 0; i < sampled.length; i++) {
            var w = sampled[i], n = indexOfWindow(w);
            if (n < 0 || !tracked[n] || baseline[n]) continue;
            var previousTick = lastCandidateTick[n];
            if (previousTick !== null) {
                var gap = Math.max(0, now - previousTick);
                candidateMaxGap[n] = Math.min(1000000000,
                    Math.max(candidateMaxGap[n], gap));
                if (gap > 125) candidateGaps[n] =
                    Math.min(1000000000, candidateGaps[n] + 1);
            }
            lastCandidateTick[n] = now;
            sampleCounts[n] = Math.min(1000000000, sampleCounts[n] + 1);
            var state = fingerprint(w);
            if (state !== lastSample[n] || sampleCounts[n] % 20 === 0) {
                // Report per-window counts periodically even without changes.
                send("window_changed", w);
                lastSample[n] = state;
            }
        }
    }

    // Install callbacks before baseline enumeration to avoid an initial blind spot.
    features.added = signal(workspace, "windowAdded", onAdded);
    features.removed = signal(workspace, "windowRemoved", onRemoved) ||
        signal(workspace, "windowClosed", onRemoved);
    features.activation = signal(workspace, "windowActivated", onActivated) ||
        signal(workspace, "activeWindowChanged", onActivated);
    features.stacking = signal(workspace, "stackingOrderChanged", onStackChanged);
    features.desktop = signal(workspace, "currentDesktopChanged", onDesktopChanged);
    features.activity = signal(workspace, "currentActivityChanged", onActivityChanged);
    var initial = property(workspace, "activeWindow");
    if (initial) { identify(initial, true); previous = initial; }
    var existing = listedWindows();
    if (existing && typeof existing.length === "number") {
        features.baseline = true;
        for (var k = 0; k < existing.length; k++) identify(existing[k], true);
    }
    if (Date.now() - started >= TTL_MS) { stop(); return; }
    ttlTimer = makeTimer(Math.max(1, TTL_MS - (Date.now() - started)), stop);
    sampleTimer = makeTimer(INTERVAL_MS, sampleCandidates);
    heartbeatTimer = makeTimer(1000, function () {
        if (Date.now() - started >= TTL_MS) { stop(); return; }
        send("heartbeat", null);
    });
    features.ttl = !!ttlTimer;
    features.heartbeat = !!heartbeatTimer;
    features.sampling_timer = !!sampleTimer;
    features.stacking_sampled = stack() !== null && !!sampleTimer;
    send("ready", initial || null, features);
    if (!features.ttl || !features.heartbeat || !features.sampling_timer) stop();
})();