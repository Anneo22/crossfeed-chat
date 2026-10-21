# Opt-in private headed automation browser (Linux Brave / Xvfb)

> **Optional Linux helper.** Requires Brave, Xvfb and a supported graphical user session. Other platforms are refused before profile writes or launch. The systemd unit is a manual installation template; nothing is installed, enabled or started automatically. Sign-in, pairing and receiver selection require operator setup. Unattended startup and crash recovery depend on the host.

This is a manually invoked, separately owned Brave profile and unpacked extension, **not** a login bypass or a replacement for the working signed-in Brave. Its profile, extension origin/ID, login, pairing and storage are independent of all existing browser profiles. No existing profile, cookie, session, or token is copied, inspected, or adopted. Importing either helper module is inert.

## Commands (manual operator only)

```sh
node scripts/automation-browser.ts prepare
node scripts/automation-browser.ts setup
# Human signs in and pairs in the dedicated, physically headed setup window,
# then closes ONLY that separate browser window.
node scripts/automation-browser.ts run
# ONLY if the owned browser has stopped but left singleton IPC symlinks:
node scripts/automation-browser.ts recover
```

Optional `--root /absolute/private/path`, `--browser /absolute/executable` and `--dry-run` work as applicable. Default root is `${XDG_DATA_HOME:-$HOME/.local/share}/crossfeed-chat/automation-browser`; default Brave binary is `/usr/bin/brave`. The stable `extension/` copy and the `profile/` belong exclusively to this managed root. The private ownership marker is `.automation-browser.json`. Unmarked nonempty roots, symlinks in managed paths, default browser profiles, unexpected extension files, live browser locks and changed extension contents fail closed. A partial unmarked preparation is deliberately *not* adopted. Setup validates its browser executable before writing to the profile. Prepare/setup do **not** need an Xvfb runtime.

`setup` uses a **physical** headed desktop browser for human login to chatgpt.com and existing extension Options pairing. Sign-in, any human/security challenge and app authorization must be completed by a person. In `chrome://extensions`, locate **Crossfeed Chat Wake** and open Options; do not guess the ID. The local service URL is normally `http://127.0.0.1:4319`. Select the **NEW** pending receiver with the pre-existing API-key-only `POST /extensions/receiver` endpoint *while idle* and before approving its matching pairing code through the normal `extension approve CODE` workflow. This helper never changes receiver selection, never disables the working extension, and never falls back to the normal desktop if its private display fails. An unset `wake_receiver_id` retains existing backend behavior. Complete a new manual pairing/selection review after interruptions; do not dispatch unattended jobs to an unaccepted candidate.

`run` is **genuinely headed**, but entirely on a private virtual X11 display (not `--headless`). It validates the host-admitted Xvfb executable and a strictly bounded provenance record on **every run**, takes an exclusive private manager lease, refuses outstanding singleton locks, selects at most three high-numbered displays based *only* on preexisting sockets/locks (never deleting foreign X11 state), writes its own private MIT-MAGIC-COOKIE-1 Xauthority binary record (0600) in a private session directory, launches one owned Xvfb and waits at most 15 seconds for authenticated `xdpyinfo` readiness **before** launching Brave. Xvfb uses `:N -screen 0 1280x800x24 -nolisten tcp -noreset -auth <private-Xauthority>`, **without** `-ac`. Browser receives only the private `DISPLAY=:N` and `XAUTHORITY` (and inherits ordinary OS/DBus/keyring environment); `WAYLAND_DISPLAY` and `WAYLAND_SOCKET` are removed in that child only. Parent desktop environment is untouched.

Brave runs with `--ozone-platform=x11`, the same owned `--user-data-dir` and stable `--load-extension`, `--no-first-run`, `--no-default-browser-check`, `--disable-background-networking` and an `about:blank` keeper tab, so individual wake windows closing need not terminate the browser. The helper never sets `--headless`, CDP/remote-debugging flags, `--no-sandbox`, `--password-store=basic`, user-agent overrides, debugger hooks, or automation hiding. Signed-in Chromium preferences (including the manually chosen High default) and system keyring are not modified by the helper.

If the server cannot authenticate/start, the browser is **never** launched. Server failure terminates only the browser that this manager spawned; browser exit stops only its spawned Xvfb. SIGINT/SIGTERM stops its browser first, then its server, with an owned-child termination watchdog. The lease remains until those children have exited. No `pkill`, `killall`, global process scan, process attachment, desktop window control, GUI focus calls, CDP, browser profile import, network download or global X11 cleanup is performed.

**Exit status contract:** A normally exiting browser reports its exit code (0 is success) once both owned children are confirmed terminated. An unexpected Xvfb exit, Xvfb/browser process error, startup/readiness failure or other supervisor failure is latched as exit status **1**, even if the browser subsequently exits 0. SIGINT or SIGTERM received by the manager is an **intentional operator shutdown** and reports **0** after both children stop, unless another fatal process error/failure occurred. Direct browser termination by a signal without an operator stop reports 130 for SIGINT or 143 for SIGTERM; other unknown signal exits report 1. This is suitable for restart-on-failure policies without treating operator stops as crashes.

A ChildProcess `error` event while its PID exists is **not proof of termination**, including when a kill request fails. The manager requests bounded, escalating **owned-child-only** shutdown; the manager lease, live Xauthority and signal/watchdog handlers are preserved until each spawned child emits `exit`/`close`. A definitively failed spawn with no PID may be treated as stopped. If a startup failure cannot terminate its own child within the bounded 3-second shutdown attempt, it rejects **without deleting** the lease/auth; the pending watchdog remains for that owned PID, and recovery still requires positive stopped-owner proof. Physical `setup` follows the same lease-retention rule on process errors.

## Optional desktop-session systemd **user** unit (opt-in template)

The repository includes `contrib/systemd/crossfeed-automation-browser.service` as a **manual opt-in** template. It isolates the supervisor in its own user-service cgroup, so closing the launching shell, terminal or Pi does not itself terminate the controller. It does **not** install, enable, start, select a receiver, prepare or sign in to a profile. The existing `prepare`, `setup`, `run` and `recover` manual workflows remain available, and importing the helper never autostarts a browser.

Preconditions **before any installation/start**: Linux with an active graphical login session and the normal user DBus session bus / unlocked OS keyring; an already-running `crossfeed-chat.service` backend; a properly marked, permission-checked, user-owned dedicated profile at `$HOME/.local/share/crossfeed-chat/automation-browser`; manually completed login, host-approved selected receiver and pairing; a host-admitted, provenance-checked private `runtime/Xvfb` and `runtime/provenance.json`; `/usr/bin/xdpyinfo`, `/usr/bin/brave` and publicly executable `/usr/bin/node`; and the deployed helper/extension checkout at `$HOME/.local/share/crossfeed-chat/repo`. This unit intentionally pins the profile root with `--root`, independent of differing interactive-shell and service `XDG_DATA_HOME` values. If manual preparation used another root, redo the path review **while idle** before proceeding; do not copy browser sessions. Sign-in and pairing use `setup --root "$HOME/.local/share/crossfeed-chat/automation-browser"` on the physical desktop and are always performed separately by the person. Do not attempt to automate OS unlock, security challenges, site login, or browser profile migration.

**Exclusive-profile handoff:** if a manual `run` or `setup` helper was used, first stop *that known helper normally*, close only its dedicated windows, and verify its spawned Brave and (for `run`) Xvfb have exited; also verify no other service/manual instance owns the profile. Only then start the user service. Never stop `crossfeed-chat.service`, kill unrelated Brave/Chrome, issue `pkill`/`killall`, remove locks blindly, or reuse a signed-in personal browser profile. Switching back to manual mode requires first stopping the user service and verifying its owned children exited.

If the operator explicitly authorizes installation and start on their own host, perform the following **manually**, from the deployed repo (these commands are documentation, not executed by this change):

```sh
cd "$HOME/.local/share/crossfeed-chat/repo"
install -Dm644 contrib/systemd/crossfeed-automation-browser.service \
  "$HOME/.config/systemd/user/crossfeed-automation-browser.service"
systemctl --user daemon-reload
systemctl --user start crossfeed-automation-browser.service
```

Only when explicitly opting into starts at subsequent graphical desktop logins:

```sh
systemctl --user enable crossfeed-automation-browser.service
```

To stop the user controller and cancel future login autostart without stopping the backend:

```sh
systemctl --user stop crossfeed-automation-browser.service
systemctl --user disable crossfeed-automation-browser.service
```

The template is `Type=simple`, has `Wants=` and `After=crossfeed-chat.service` (it does **not** stop the backend), and is `PartOf=` / `WantedBy=graphical-session.target`. Enabling means opt-in start when that target activates, **not** an unattended system-boot or pre-unlock login service; desktop environments that do not activate the target need operator-specific review. `Restart=on-failure`, 10-second delay and a 3-starts-in-120-seconds limiter bound repeated failure. `ExecStartPre` invokes only explicit, fail-closed `recover`: it removes a dead same-host manager lease or Chromium singleton IPC **only** when exact ownership/PID/identity checks prove the owners stopped; active, ambiguous, cross-host and unknown locks cause startup to fail rather than be stolen. `ExecStart` invokes only private-display `run` (never `setup`/`prepare` or a physical-display fallback).

`KillMode=mixed` sends the initial SIGTERM to the manager so it can stop its owned Brave and Xvfb children before releasing the lease. `TimeoutStopSec=20` allows time for escalation. systemd can clean up only processes that remain in the unit cgroup; a browser moved outside it may survive an unexpected manager death. Recovery refuses live or ambiguous singleton owners and requires operator intervention. Normal operator shutdown exits 0 unless a fatal error occurred; unexpected Xvfb death exits 1. `UMask=0077` protects created files. The normal user bus (`DBUS_SESSION_BUS_ADDRESS=unix:path=%t/bus`) remains available for the OS keyring.

`StandardOutput=null` and `StandardError=null` reduce risk of browser URL or private details appearing in unit logs; **systemd metadata/status/journal may still expose service details** and this is not a blanket logging guarantee. Check status without dumping browser environment or sensitive profile data. After crashes, abandoned private Xauthority session directories and global X11 lock/socket artifacts are **not** automatically reclaimed; this unit never force-cleans foreign or unproven stale state. Resolve ambiguities by conservative operator review, not deleting locks or session files to force an unattended restart. The service itself does **not** establish ChatGPT authentication, High model selection, site permissions, native/desktop foreground equivalence, pixel/focus guarantees, or reliable success at every startup. Saved model level is not native attestation. Each host must independently validate the specific service before relying on it; the repo template makes no claim about existing host activation.

## Host runtime admission (host must supply separately; never committed)

```text
<managed-root>/runtime/Xvfb
<managed-root>/runtime/provenance.json
```

The binary must be regular, executable, owned by the invoking user and reached without symlinks. The runtime directory and provenance must be private. Provenance is exactly `{"schema":"crossfeed-chat-private-xvfb","version":1,"sha256":"<64 lowercase hex characters>"}`, matching the binary bytes. The operator must supply and verify the runtime independently; the helper does not download, install or authenticate its source. `/usr/bin/xdpyinfo` and the required X11 libraries must be available for the authenticated readiness probe.

## Conservative manual crash recovery

Chromium can leave `SingletonLock`, `SingletonSocket`, and `SingletonCookie` symbolic links after SIGTERM. Run `recover` **only after** the dedicated automation browser is stopped and no manager is running. Recovery requires the correct managed marker/extension, private ownership checks, the same host name, a syntactically valid owner PID, and positive proof of a **dead** PID (ESRCH). EPERM, an alive/reused PID, cross-host ownership, a regular/malformed lock, missing owner lock with orphan links, unknown locks, or mismatched identities all **refuse** deletion. Recovery removes *only those three exact symbolic link entries* without following their targets and without reading or removing cookies or any browser authentication files. Dead manager leases are similarly removed **only by explicit recover**, with identity rechecks; live or ambiguous leases block both recovery and fresh starts. `run` never implicitly steals a lease or removes stale IPC.

Install and enable the optional unit only after validating sign-in, selected-receiver delivery and shutdown on the target host. The template provides no guarantee of desktop focus, pixel visibility or reliable unattended recovery.

**Sensitive data:** once signed in, `profile/` contains private authentication; never commit, inspect with an LLM, upload, archive or copy it. The `runtime/session-*/Xauthority` file is ephemeral secret data and never logged. Changing the stable extension path changes its origin, requiring re-pairing.

Tests use temporary fixtures and mocked children/readiness. They do not launch a real browser or X11 server, sign in, or activate a service.
