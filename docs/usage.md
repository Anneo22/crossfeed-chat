# Usage and permissions

[Install and connect](../README.md) before using these commands.

## Send work

Set your caller's base URL to `http://127.0.0.1:4319/v1`, its bearer key to `CROSSFEED_API_KEY` and its model to `chatgpt:sol`. The endpoint accepts a subset of OpenAI-style Chat Completions. Here is a request you can run with Node after setup:

```sh
node --input-type=module <<'JS'
const response = await fetch('http://127.0.0.1:4319/v1/chat/completions', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.CROSSFEED_API_KEY}`,
    'Content-Type': 'application/json',
    'Idempotency-Key': 'example-review-1',
  },
  body: JSON.stringify({
    model: 'chatgpt:sol',
    messages: [{
      role: 'user',
      content: 'Review this retry policy: retry every failed payment request three times.',
    }],
  }),
});
if (!response.ok) throw new Error(`Crossfeed returned ${response.status}`);
console.log((await response.json()).choices[0].message.content);
JS
```

Use a new `Idempotency-Key` for each distinct request, and reuse it with the same payload when retrying. Within its retention window, the server returns the original outcome instead of submitting the work twice. A changed payload with the same key returns 409.

An optional top-level `title` gives the extension a short human label for the worker tab group, such as `review · Task Manager`. Crossfeed normalizes whitespace, removes control characters and caps it at 80 characters. It is not included in the request sent to ChatGPT; without a title, the group uses the worker label.

Text messages and content parts are supported, as are `tools`, `tool_choice` and `parallel_tool_calls`. Workers return structured function calls for your local caller to execute. Crossfeed never executes those functions. Sampling and token-limit fields become instructions to the worker; they do not guarantee API-style numerical behaviour. `stream: true` returns buffered SSE after the whole answer. Token usage is `null`.

Results contain `metadata.worker_label` and `metadata.picker_receipt`. New labels default to `native` and store that mode explicitly. Existing labels keep their recorded mode; saved row/level settings without a recorded or explicit mode retain `configured`. Native ordinary wakes use fresh-chat defaults and have a null/no extension picker receipt; they never attest a model row, `Sol High`, or a reasoning effort. Explicit `configured` ordinary wakes and composer attachment jobs use the saved row and numeric level; when the extension selects them, its receipt records the exact observed row, level, observation time and source. A label can change mode only before it has been used. Removing and recreating a used label does not clear its retained mode fence, and a used legacy configured label can explicitly restore `configured`. A non-null receipt is still only an observation of the picker, not proof of the model behind it; ChatGPT controls the model and how long a worker keeps generating.

`GET /v1/models` lists saved and known labels with `awake` and `saved`; saved labels include `row`, `level` and the **effective** ordinary `wake_mode`. Existing configured labels remain configured in this catalog, including saved labels with an omitted mode. This catalog field describes wake behavior, not model/effort attestation. Orchestrator excludes native workers from its model-and-effort catalog. `GET /v1/gateway/status` reports contacts, wakes, capacity and approval metadata. Both require the API key. Contact can be `recent`, `stale` or `never`; `polling` and `processing_claim` distinguish a worker waiting for work from one answering. Recent contact alone does not promise another ChatGPT turn. Unknown labels and failed wakes return 503.

The API-key-authenticated `GET /status` and `GET /v1/gateway/status` also expose `focus_guard: {attempts, counts, last}` for *requested ordinary wake* cosmetic focus preparations only. `counts` contains fixed reasons (`unsupported_desktop`, `unsupported_bus`, `timeout`, `prepare_failed`, `prepared`, `cancelled`) and saturates at one billion; `last` is null or `{reason, at_ms}`. Data is in-memory, sanitized, and excludes errors, stderr, window titles, URLs, environment values, D-Bus addresses and proof markers. A `prepared` outcome means a valid guard handle after a bounded KWin `Script.run` response and stable bus ownership checks; it does **not** prove script callbacks, a focused or restored window, or a first frame. Focus failure cannot deny an otherwise eligible authenticated wake. On Linux, missing or partial XDG desktop/session metadata alone allows a bounded fixed D-Bus owner/introspection probe **only if a session bus exists**. Explicit non-Wayland, non-KDE or non-Linux environments and missing session buses cannot probe. New windows must still prove ownership with their exact private wake marker and the expected browser class; arbitrary new browser windows are never restoration targets. Desktop behavior and timing require independent native observation, not fixture inference.

## Cancel work

Run `crossfeed-chat cancel <job-id>` with the ID from `status` to cancel a queued or claimed job. The caller receives HTTP 499 with `caller_cancelled`. Cancellation releases the worker's claim and stops further wakes for that job; it cannot stop an answer already generating in ChatGPT. Retrying the same idempotency key returns the recorded cancellation until its ten-minute retention expires.

Programmatic callers can POST to `/jobs/cancel` or `/v1/jobs/cancel` on the local control API with the API bearer key and exactly one of these JSON bodies:

```json
{"id":"<32-character job ID>"}
```

```json
{"idempotency_key":"example-review-1","session":"orchestrator:example-review-1"}
```

Use the same key and session value supplied in `Idempotency-Key` and `X-Crossfeed-Session` when submitting. The key lookup belongs to that session. Success returns the job's `id`, `label`, `state: "failed"`, `error: "caller_cancelled"` and previous state in `was`. Unknown jobs return 404 `job_not_found`; finished jobs return 409 `job_finished` without changing their outcome.

## Several chats per level

A label can have several worker chats, called replicas. Five replicas of `sol` share the same row and level, and each can claim a different request. Set the server's `--max-claimed-jobs` to at least five; its default of four would keep one chat idle.

```sh
crossfeed-chat worker add sol --row "GPT-6" --level 2 --replicas 5
# For an existing label:
crossfeed-chat worker set sol --replicas 5
crossfeed-chat status
crossfeed-chat doctor
```

Copy the exact row text from your ChatGPT model menu; it changes when OpenAI ships new models. Configured levels are 0 Instant, 1 Medium, 2 High, 3 Extra High and 4 Pro. Configured automatic wakes and composer attachment jobs select these saved settings: the extension reads the picker's actual 1–5 positions, requires the requested position to exist, verifies the exact row/level/count after each change, and refuses an unavailable or changing range before observation or send instead of clamping or remapping it. See [OpenAI's plan availability](https://help.openai.com/en/articles/20001354-gpt-56-and-gpt-6-pro-in-chatgpt).

Send five requests concurrently to `chatgpt:sol`, each with its own idempotency key. Queued work wakes sleeping replicas one at a time; do not run `wake sol` five times. The first replica keeps `sol`; the others use internal identities such as `sol~replica-2`. Callers keep using `chatgpt:sol`. Different levels use separate labels, for example `medium` with level 1 and `high` with level 2, each with its own `--replicas N`. All labels share the global claim limit and fresh-chat caps: 12 per rolling hour by default. The daily cap is off when `--wake-daily-cap` is omitted or zero; a positive value adds a daily limit. Replicas increase capacity; they do not extend ChatGPT's account allowance.

### Linux setup

On Linux, start the server with `node src/cli.ts serve --public-url https://YOUR-TUNNEL --connector YOUR-CONNECTOR --max-claimed-jobs 5`. Supply the API key through `CROSSFEED_API_KEY`. State follows `CROSSFEED_HOME`, otherwise `$XDG_CONFIG_HOME/crossfeed-chat`, otherwise `~/.config/crossfeed-chat`. Load `extension/` as an unpacked extension in `brave://extensions` or `chrome://extensions`, open its options, and match its pairing code with `extension list` and `extension approve CODE`. Keep the browser signed in and allow the extension's ChatGPT and loopback permissions. Local speech, workbench commands and the tools bridge currently require macOS. Linux can deliver original audio and use workbench file and Git tools; `doctor` explains unavailable host features. Omit `--bridge` and use `--workbench ROOT` without shell flags for those file tools.

Configured ordinary and composer wakes use background tabs grouped, best-effort, in a collapsed blue `Crossfeed · <title-or-worker>` tab group. Native ordinary wakes request `state:"minimized"` for their own separate normal window without grouping its active tab (which could raise it); Chrome may still show foreground frames, and desktop focus restoration remains advisory rather than a native no-focus guarantee. A private ownership bootstrap is used only when desktop restoration is armed. Configured ordinary wakes use the bare root only to select and receipt the saved model/effort, without requiring, focusing, typing into or clearing a restored/shared draft. They detach the debugger, navigate the same owned tab to an exact nonce-bearing native prefill, then independently re-observe the saved row, effort and slider range in the new attested document before one sealed Send. Changed model/document refuses rather than silently falling back to fresh-chat defaults. Composer attachment delivery retains its separate empty-draft/typed-input safeguards. Finally cleanup attempts to close only the exact owned wake tab when the poll ends, even after uncertain send outcomes; failed closes are retained in the owned-tab registry for retry on the next idle poll. The host-side chat registration/disposal tracker and orphan sweeps address unfinished chats. Browser shutdown, extension reload or a failed wake can interrupt registration; inspect `status` and `doctor` before retrying after the cooldown. Accept one wake on Linux/Brave/Plus before testing five concurrent requests.

## Attachments

**Audio is transcribed locally on macOS by default.** Send an `input_audio` part with `{format: "wav" | "mp3", data: "<base64>"}`, or an audio file part. The worker receives a labelled transcript alongside the original bytes. Apple's [Speech framework](https://developer.apple.com/documentation/speech/sfspeechrecognitionrequest/requiresondevicerecognition) runs on-device, with no paid API or model download. The tiny Swift helper compiles on first audio use with macOS Command Line Tools. Recordings must be at most 60 seconds and dictation support for the language must already be installed. Pass `--speech-locale en-GB` to change the default `en-US`, or `--no-audio-transcription` to deliver only the original bytes. Unsupported languages, invalid recordings and recognition failures produce an explicit unavailable note; they never fall back to a network recognizer. Native audio perception by ChatGPT is unverified. A message's `content` array can mix text with OpenAI-style `image_url` and `file` parts. Images require base64 data URLs; remote image URLs are refused. Files use `{file_data, filename}`, with raw base64 or a base64 data URL. The server detects MIME type from the bytes, checks image/audio formats, and refuses unsafe filenames. Filenames distinguish Office and OpenDocument types within compatible ZIP or legacy Office containers, and identify CSV, Markdown, HTML, XML and JSON text. This labels the files without parsing or validating their document contents. PDF and RTF have their own byte signatures. Binary input is limited to 20 MiB per part, 50 MiB per request and ten attachment parts. The JSON body limit is 72 MiB to allow base64 overhead; the existing 1 MiB normalized text/request limit still applies.

```js
{
  model: 'chatgpt:sol',
  messages: [{role: 'user', content: [
    {type: 'text', text: 'Describe the picture and compare it with the document.'},
    {type: 'image_url', image_url: {url: 'data:image/png;base64,...'}},
    {type: 'file', file: {file_data: '...', filename: 'report.pdf'}},
  ]}],
}
```

Choose delivery with `serve --attachment-delivery mcp` or `serve --attachment-delivery composer`. The provisional default is `mcp`; both modes need live acceptance before choosing the working default for your account. MCP delivery includes an embedded file resource for every attachment, preserving its filename, MIME type and original bytes. Images and audio also keep their native blocks. It uses the normal worker chat. Composer delivery opens a separate fresh chat with the saved row and level, uploads only that job's files, waits for completed upload chips, and asks the connector for that exact job ID. The normal polling chat and its saved URL stay intact. One-shot chats share the wake volume guards and are queued for archive after the job ends.

Workers can return generated files through `gateway_exchange.files`, declared with OpenAI's [`openai/fileParams`](https://developers.openai.com/plugins/reference#file-apis). ChatGPT supplies `{download_url, file_id, mime_type?, file_name?}`. Crossfeed immediately downloads the HTTPS URLs, follows at most three HTTPS redirects, refuses private network destinations, and applies a 30-second deadline to the whole batch. Returned files have the same 20 MiB, 50 MiB and ten-file caps. A failed batch removes its partial downloads and can be retried while the claim remains active.

The completion's `choices[0].message.content` stays text, and a top-level `files` array lists `{id, name, mime, bytes}`. Buffered SSE frames carry the same `files` array. Download each result from `GET /v1/files/<id>/content` with the local API key. OAuth and paired extension credentials cannot read this endpoint. Retrieve results within ten minutes; expired files return 404. Temporary download URLs are never returned or retained in job records.

Attachment bytes live in 0600 files under the private state directory, with a 512 MiB total storage cap. Job records contain metadata and hashes. Queued input files remain available through wake pauses and are removed when their job ends; returned files expire after ten minutes. The server sweeps expired files every second and reconciles the file ledger on restart. Duplicate input names are numbered so upload chips can be matched safely. Prompts and attachments still pass through your ChatGPT account.

## Deadlines and recovery

| Setting | Default | Change it with |
| --- | --- | --- |
| Local API port | 4319 | `--api-port PORT` or `CROSSFEED_API_PORT` |
| MCP port | 4320 | `--mcp-port PORT` |
| State directory | `~/.config/crossfeed-chat` | `--state-dir PATH` or `CROSSFEED_HOME` |
| Attachment delivery | `mcp` (provisional) | `--attachment-delivery mcp\|composer` |
| Per-claim absolute deadline | 30 minutes from claim | `--job-deadline-ms`, in milliseconds; never extended by polls |
| Unkeyed scoped ordinary queue admission | 45 minutes from initial enqueue | Gateway `startupMs` default 2700000; finite even with continuously polling matching workers; does not apply after claim |
| Keyed and non-scoped queue wait | Until claim or explicit cancellation (subject to existing controls) | No scoped admission deadline; legacy non-`waitForWake` queues still use `unclaimedMs` default 15 minutes |
| Worker contact lease | Job deadline (30 minutes by default) | `--worker-lease-ms`, in milliseconds; heartbeat renewals cannot extend the per-claim deadline |
| Concurrent claimed jobs, across all labels | 4 | `--max-claimed-jobs N`, 1-128 |
| Wake attempts since local midnight | Off | `--wake-daily-cap N`, 0-1000; omitted or 0 means no daily limit |
| Wake attempts in a rolling hour | 12 | `--wake-hourly-cap N`, 0-1000; 0 pauses wakes |

Pass server options to `serve`. The worker contact lease defaults to `--job-deadline-ms`; set `--worker-lease-ms` explicitly to choose how long an idle worker keeps polling. Each completed answer renews its idle lease. Queued jobs wait through account caps, quota pauses and cooldowns. A queued request with no polling worker requests a wake immediately. The 45-second contact indicator is informational and does not delay a wake.

The rolling hourly wake budget is shared by all worker labels and scoped sessions, not assigned per session. The default remains **12 fresh-chat wake attempts/hour**. A separately configured `--wake-hourly-cap 64` changes only admission of fresh-chat attempts, not execution concurrency: at most **4 claimed jobs** may run across labels by default. Browser wake dispatch is serialized to **one pending fresh-chat navigation at a time**, with a fixed **240-second** ticket lifetime. The extension's nominal **30-second** polling/alarm cadence can delay recognition of an available slot by up to another poll interval; the synthetic timing tests model this quantization, not a guaranteed real-browser completion time. A failed wake also has per-label backoff. Raising the hourly cap does not eliminate navigation head-of-line blocking, cooldowns, claim limits, or account-side restrictions.

The owner-authenticated `GET /status` and `GET /v1/gateway/status` expose a compact `startup` diagnostic: `scoped_queued` (`cold_scoped_queued` is a compatibility alias, now counting warm queues), `budget_ms`, and a fixed `blocker` enum. The priority is `none` when empty, then `capacity_full`, `wake_paused` (hourly cap 0), `wake_budget`, `quota_cooldown` (quota, backoff or cooldown on all waiting labels), `archive_full`, `extension_unpaired`, `no_extension_contact`, `serialized_wake`, then `awaiting_worker`. A blocker is a current admission diagnostic, not a claim-completion prediction. The compact fields contain no prompts or session identifiers. They also expose `extension_poll.last_seen_at` for the last successful paired `GET`/`POST /extension/next` poll, `last_contact_at` for the last successful authenticated paired extension request (including `/next`, `/claim`, `/check`, `/result`, valid observations and archive requests), `recent` based on contact, and `grace_ms`. Invalid wake nonces, rejected requests, unpaired origin/key and owner API calls cannot refresh browser liveness. The Chromium/Brave browser hosting the paired extension must remain open; another ChatGPT desktop app does not count. Unkeyed queued scoped local Pi requests have a 90-second grace from enqueue or most recent genuine extension contact, whichever is later. Browser liveness is GLOBAL: one serialized issued or claimed non-composer wake protects every cold waiting scope for the wake's fixed 240-second lifetime plus a single 90-second grace, even when other scopes lack tickets. This does not grant any scope permission to claim that wake or receive another scope's work; nonce, identity and conversation authorization remain exact. Genuine paired `/check` activity during slow navigation refreshes global contact, but does not renew the ticket expiry; absent further real contact, cold scopes eventually fail HTTP 503 `extension_unavailable` after fixed expiry plus grace. A warm matching scoped worker can continue without extension contact. Independently, **every unkeyed scoped ordinary queued request**, whether cold or with a matching worker continuously polling, has a finite **45-minute queue admission budget** (`GatewayOptions.startupMs = 2700000`) anchored to its original enqueue. This accommodates ten modeled globally serialized wake intervals of 240 seconds plus 30-second polling gaps (2700 seconds total); it is a finite bound, **not a guaranteed wake, admission, completion or provider-generation SLA**. Authenticated `/extension/next` polls returning `ticket: null`, repeated heartbeats, newly issued unrelated global tickets, matching worker polls, and quota/cap/cooldown pacing cannot reset or bypass admission, including when other scopes occupy every global claim slot. If still queued at expiry, HTTP 503 `wake_stalled` settles the job durably; it cannot later be claimed. The browser-contact/no-extension 90-second `extension_unavailable` diagnostic remains separate and takes precedence if due first. Matching warm workers bypass only this *browser-contact requirement*, not queued admission. Explicitly keyed retries, non-scoped lanes, composer jobs and already-claimed generations do not use the scoped queue admission timer; legacy non-`waitForWake` queues still have the old `unclaimedMs` 15-minute timeout. Claimed generations have their own 30-minute default absolute deadline and contact lease. Browser-heartbeat contact does not imply queued scope admission, and claimed progress does not imply that the browser extension is polling. Claimed jobs keep their own lease and deadline, keyed work remains durable, and quota/cap pauses are not bypassed by browser contact. An unkeyed scoped request with no live HTTP waiters is cancelled while queued; identical content retries from one caller share a queued job only while a waiter remains. No browser is launched automatically.

A claimed job is bounded by the earlier of its worker contact lease and its hard per-claim deadline (30 minutes by default). Heartbeats renew the contact lease only up to that fixed deadline. Expiry releases its capacity slot and durably records HTTP 503 `uncertain_delivery`, because ChatGPT might still have generated an answer. Late answers and file uploads are rejected, and scoped wake nonces are fenced even after worker eviction. Do not automatically replay an uncertain result; inspect the worker and submit distinct new work only after deciding whether a duplicate would be safe. These host-side limits do not determine ChatGPT provider execution time, token quotas, reasoning effort or account allowances.

Jobs and retry records are written atomically to private `jobs.json`, with a 256 MiB limit and space reserved for active answers. Finished outcomes are retained for ten minutes. Explicit retry keys survive transport disconnection and restart; legacy non-scoped caller correlation also remains durable without a key. Unkeyed *scoped* queued jobs exist only while HTTP waiters remain and are discarded on restart (already claimed work follows its existing uncertain-delivery handling). Unidentified unkeyed jobs are discarded on restart and cancel on transport disconnection. Retained completed results replay.

Existing saved `worker_lease_ms` values are preserved. If a service has a saved 10-minute lease, pass `--worker-lease-ms 1800000` to `serve` for a 30-minute reasoning job; changing the default does not migrate that saved setting.

**A claimed job is never automatically requeued after restart.** Shutdown or restart records `uncertain_delivery`: the answer may already exist in ChatGPT. Inspect that worker before submitting new work. Retrying its key returns the recorded error; a late answer cannot revive it.

Run `node src/cli.ts doctor` for problems and a next step for each. It checks worker contact, quota pauses, uncertain delivery, wake failures, pending approvals, capacity and wake limits.

Only one server can own a state directory. A clean shutdown releases `server.lock`. After a crash, confirm the old process has stopped, then move that lock to the Bin before restarting. The server refuses to steal it. Changing the public URL requires a fresh state directory and reconnecting because OAuth grants belong to that exact URL.

## Pi sessions and retries

Pi must send its session ID so the gateway can give two Pi conversations separate ChatGPT workers. In each Crossfeed model in Pi's `models.json`, enable its existing session header support:

```json
"compat": {
  "sendSessionAffinityHeaders": true,
  "sessionAffinityFormat": "openai"
}
```

Pi generates the ID and sends it on each request, including tool-result turns. You do not choose a label or pass a flag for each session. A resumed Pi session keeps its worker scope. Callers still select `chatgpt:sol`; the gateway creates internal identities for that caller and its replicas. Pi runs started with `--no-extensions` still use this model configuration. Requests identified as Pi without a session header are refused with `caller_session_required`.

Other clients can use `X-Crossfeed-Session`, `X-Session-Affinity`, `session_id` or `X-Session-ID`. `X-Crossfeed-Caller` supplies retry correlation without a separate worker scope. These values identify a conversation; the API key still authorizes the request. ChatGPT's [`_meta["openai/session"]`](https://developers.openai.com/plugins/reference) identifies the worker conversation and is required for scoped workers. Its salted binding is saved before any request is delivered, including media jobs, and survives server restarts. A missing worker ID or wake nonce causes a refusal.

Within 60 seconds of enqueue, an identical normalized request from the same caller, scope and label attaches to the existing pending or successful job, even with a different retry key. Different callers remain separate. After that window, a new key creates new work; reusing the original key still replays its retained outcome. Unidentified callers get key-based retry behavior only. Work already claimed by a worker is never retried automatically after an uncertain delivery.

Private `receipts.json` retains the latest 10,000 job receipts: salted caller ID, label and worker identity, request size bucket, enqueue/claim/wake/finish times, whether a wake was needed, and outcome. It contains no messages, responses, tool arguments, raw caller IDs or retry keys. Wake timestamps join receipts to the account wake ledger. `receipt-identity.json` holds the local correlation salt. A receipt write failure stops new work; an answer already saved still reaches its caller.

Stale idle workers free memory while their conversation URLs and ownership bindings remain saved. Session URL storage is bounded at 1,024 worker identities and conversation ownership at 4,096 bindings. Admission counts queued reservations and refuses new sessions before either limit is exceeded. Existing retry keys still replay. Status reports `receipts_available` and includes scoped workers in the label's replica list.

When upgrading from an older service, first drain its queue and active claims. Old queued attachment files retain their former expiry; the indefinite wait applies to new requests accepted by this version. The server supports the paired extension's picker path. Scoped wakes carry their nonce in a short routing label; the worker must repeat that exact label. The gateway still requires ChatGPT conversation metadata before delivering scoped work.

## What the extension does

Explicit configured wakes use bounded debugger input to select the saved model row and reasoning level, then verify the picker before sending. Composer attachment delivery remains on this configured path. New labels default to native behavior; existing configured labels retain their saved picker settings.

For a native wake, the paired Crossfeed extension creates a separate owned normal window in the already approved browser profile with `chrome.windows.create({type:"normal",state:"minimized"})`, then uses `chrome.scripting.executeScript` for the pinned page probe and sender at the exact nonce-bearing native `?q=` URL. It does not invoke Brave `--new-window` or a system-opener fallback; those are PiLink source-driver mechanisms. The owned window/tab IDs must match later observations. The window may still momentarily become foreground despite the minimized-state request (which does not guarantee native no-focus); that is not itself send authority. This native window is not tab-grouped because grouping could raise it. The exact prefill requests the first `gateway_exchange` with that exact `worker_label`, `wake_nonce` and `maximum_wait_seconds=20`, then repeats the nonce with the server-returned label on every subsequent call. It asks the worker to poll until `state=released` with `continue=false`, not end with a chat reply between jobs, and return local caller tools as structured `tool_calls` rather than execute them natively. Crossfeed's injected page execution requires the exact expected text and a bounded one-click Send path (15 seconds); it never opens the model picker. Crossfeed declares no manifest `content_scripts`. It accepts only the owned tab's monotonic native `?q=` → `?prompt=` → bare-root transition. If ChatGPT consumes `?q=` before the first complete observation, a non-sending probe must still attest the exact unique prefill in that same owned document. Direct bare-root drafts do not get this authority. After an exact ready-DOM probe pins the document/sender/owner/phase and confirms no pending navigation, the final before-Send tab status may be `loading` or `complete`; this does not relax URL/document/pending-navigation ownership. The attempt is sealed before one native Send click and is never replayed after an uncertain execution result. Native mode does not attach Chrome's debugger, type into the composer, press Enter, open the model picker or report any model/effort/picker observation. The composer attachment path separately keeps bounded debugger file, picker and keyboard input; Chrome may show a debugging banner for those jobs.

For native ordinary wakes only, current code requests `focus_guard:true` with protocol version 4 when claiming the exact nonce. On KDE Wayland, the server may generate a fresh 128-bit marker and prearm a private, short-lived KWin script after the authenticated claim and before returning to the browser. The script still requires the exact owned marker plus new-window/browser-class/previous-window/desktop-activity checks; arbitrary Chromium/Brave windows never become restoration authority. The fixed, shell-free `/usr/bin/qdbus6` helper and private temporary script retain bounded expiry and cleanup. Cosmetic preparation failure does not block an otherwise authenticated wake. Already-loaded version 3 compatibility deliberately receives `unsupported` and goes directly to the exact native `?q=` URL rather than using the newer private bootstrap; this advisory does not bypass claim, nonce, scope, pairing, ownership or send checks.

When version 4 receives an armed marker, its private `wake-window.html?marker=<marker>` is permitted only as the exact still-owned **initial wait-only** bootstrap while the authorized native query is pending. No page probe, injected page execution, composer pin or Send authority exists in that bootstrap. Only that same owned tab may advance to the exact native ChatGPT prefill; foreign navigation, ownership loss and expiry remain mandatory refusals. The bootstrap contains no credentials or ChatGPT content and is not web-accessible in the manifest. Without an armed marker, or on the loaded-v3 `unsupported` compatibility path, the driver opens the authorized native URL directly. Cosmetic focus preparation does not promise zero foreground frames.

**Upgrade compatibility:** Reload the existing extension while no wake is active to load the current v4 bootstrap and DOM-readiness checks. Reinstalling or re-pairing is not required. Already-loaded v3 receives `unsupported` for focus preparation and continues through the exact native query path. Older v2/legacy replies retain their existing shape and nonce, scope and ownership checks. Unknown fields or invalid versions are refused before claim. Composer claims and requests without a guard do not arm it. No protocol version guarantees zero foreground frames, absence of focus changes or pixel-level visibility.

Scoped workers receive a short routing label containing the wake nonce. The native wake path passes that exact label through the native prefill without deriving or rewriting it. Repeating the label and nonce binds the new worker to its claimed wake; another ChatGPT conversation cannot take over an active worker. MCP preserves the supplied nonce-bearing alias in responses for older-extension compatibility, while direct gateway exchange returns the canonical identity. The worker must use the returned label without guessing the base routing label and keep the same nonce. A native reply that only says the base worker is awake/idle is not proof that a scoped caller's queued work was served. Registration still requires new authenticated polling contact and a fresh canonical saved conversation URL. Normal post-send navigation may create a new document; the extension binds registration once to the canonical saved-chat document and refuses a later replacement, while never invoking the sender again. In a finally cleanup, the extension attempts to close only its exact owned tab when the wake poll ends, including after an uncertain send or tab movement; the owned-tab registry retries failed closes on the next idle poll. The sealed Send is never retried, and backend `uncertain_delivery` does not automatically replay the job. Archive requests run in the extension service worker and do not open ChatGPT tabs. Delete mode only hides chats whose URLs were confirmed as created by this lane; legacy URLs without that proof are archived instead. Failed archive requests remain queued for retry after restart. Archiving keeps the conversation in your account.

The `tabGroups` permission allows the extension to name, colour and collapse these groups. Chrome displays its “View and manage your tab groups” permission warning when the updated extension is loaded. Check the signed-in archive and delete calls in Chrome before relying on background cleanup; unit tests cannot prove ChatGPT's live session behavior.

**Chat disposal is durably tracked and retried, but remote deletion is not guaranteed.** Every conversation the extension starts is recorded durably (`wake_state.started_chats`, with its first-seen time) the moment its URL exists, through `POST /extension/chat`, not only in the final result. In `--chat-disposal` mode, a replacing wake or `POST /v1/sessions/release` can queue cleanup; automatic retirement, orphan detection and idle sweeps also operate without a caller request. First, the service checks every 30 seconds for retained chats whose worker is no longer alive (lease expired, chat closed, service restarted; at least two minutes after the chat appeared and no wake pending for that identity) and queues them. Second, a tracked chat that no label, session, live ticket or queue entry holds (a failed or expired wake, a removed label, a service restart) is queued the same way. Third, when the extension has nothing else to do it sweeps every ten minutes: it lists recent conversations, asks the service which of the old ones nothing holds (`POST /extension/sweep`), opens at most ten of those, and deletes only those whose first message is a Crossfeed wake message. Every other conversation is listed but never changed. Fourth, an archive or delete request for a conversation ChatGPT no longer has (404) counts as done. `GET /status` shows `chat_disposal` (mode, queued, tracked, last sweep); the extension keeps its last sweep report under `crossfeedSweep` in extension storage. Cleanup depends on ChatGPT’s signed-in conversation endpoints, which may change; remote deletion is not guaranteed. Receiver selection stays fixed during an approved sweep until its completion report or lease expiry.

Native wakes refuse altered or restored drafts, ambiguous or changed composers, pre-send URL/document authority changes, foreign navigation, attachments or generation, and ambiguous, disabled or unowned Send controls. A send attempt is sealed before the single click and is never repeated after an uncertain execution result. Composer targets the form-owned input labelled "Attach files" and allows only its own named files with matching sizes and completed upload chips; unexpected attachments, ambiguous upload controls, an unavailable saved reasoning level or a changing picker range cause refusal before send. After sending, the extension can choose "Always allow" on ChatGPT's approval card for the exact configured connector. For file materialization, it opens that card's linked approval menu and chooses "Allow <connector> for this conversation". Other connectors and ambiguous controls are refused. Selected allowances appear in the wake status receipt. The tab stays open until the initial MCP media job finishes or its conversation-wide file allowance is selected, within the four-minute wake window.

`gateway_exchange` accepts an omitted `worker_label` only when exactly one effective worker identity exists. Replicas, remembered caller scopes and other workers make omission ambiguous; use the identity named in the wake. Responses return the routing `worker_label` to repeat, and omitted and explicit singleton calls share one polling lane. Labels are routing names, not model identities.

Only one wake is issued at a time. An issued wake has four minutes to finish; a failed label retries after one minute for the first three consecutive failures, then waits ten minutes. Accepted queued jobs remain available through these retries. Failed or expired attempts stay in status for ten minutes.

A visible ChatGPT rate-limit alert or dialog, or a worker's `rate_limited` error, pauses its label for 60 minutes. New submissions and wakes return `quota_blocked`; other labels keep working. Status reports `quota_until`. Conversation messages and navigation are excluded from the extension's alert check. Wake volume and cooldown guards survive restart. The quota ledger holds at most 256 distinct active labels; another rate-limit report while it is full pauses all labels for 60 minutes.

### Upgrade from 0.1

The old `wake --url --level TEXT` commands are removed. If `config.json` has old saved-chat entries, stop the server and replace each entry in `labels` with a model row and numeric level. Keep its existing URL so the next successful wake can archive it:

```json
{"sol": {"row": "GPT-6", "level": 2, "url": "https://chatgpt.com/c/your-existing-chat-id"}}
```

Keep the other fields and the file's 0600 permissions. Choose the row and level from your account's controls; old effort text does not establish a row. A fresh state directory is another option and requires reconnecting.

## Access and stored data

The API key authorizes local completions and control commands. OAuth tokens authorize MCP only. A paired extension can claim wakes, receive job-owned upload paths, report picker observations for composer jobs, confirm contact and acknowledge archives; ordinary wakes do not fabricate a picker observation. It cannot approve OAuth, submit completions, download returned files or read local status. Its secret stays in trusted extension storage and never reaches the ChatGPT page. Approval stores only its hash in a 0600 file and binds it to the requesting `chrome-extension://` origin. Pairing creation is limited to 12 requests per origin per minute and 60 globally, with at most 64 pending requests and 128 approved extensions.

Both listeners bind to 127.0.0.1 and validate Host and Origin; forwarded host headers are ignored. OAuth admits exact registered ChatGPT callbacks, uses S256 PKCE and binds tokens to the MCP resource. Refresh tokens rotate, and reuse revokes their family. OAuth credentials are stored as hashes in 0600 files. The state directory must be owned by you and 0700; unsafe permissions and symlinks are refused.

Your prompts and answers pass through your ChatGPT account and are written to `jobs.json`. Expired records can remain on disk until a later job-state write removes them. Worker settings, archive queues, cooldowns and OAuth grants persist locally. Pending OAuth approvals, extension pairings and live wake tickets are held in memory; approved extension pairings persist. The server logs no request payloads or credentials.

To inspect or revoke a connector:

```sh
node src/cli.ts client list
```

Run `node src/cli.ts client revoke <id-from-the-list>` for the connector you want to disconnect.

Revocation removes that client's access and refresh grants and pending authorizations, releases its polls, and records a claimed job as uncertain. Other clients stay connected. `worker add` updates saved settings; `worker remove <label>` removes them. Both refuse changes while that label has pending work or a wake in progress. Removing settings does not delete its ChatGPT conversation or stop a polling chat.

MCP uses stateless HTTP POST with JSON responses and worker polls of up to 20 seconds. In-flight gateway RPC IDs are scoped to the authenticated connector and worker label, so separate worker chats may reuse an ID. Duplicate IDs within a label still refuse concurrent calls, except a completion may replace its pending poll. Cancellation by RPC ID is honored only when it identifies one in-flight call for that connector; ambiguous IDs are ignored rather than cancelling another chat. Supported protocol versions are 2025-03-26, 2025-06-18 and 2025-11-25. This server implements ChatGPT's dynamic client registration path; it does not claim the 2026 transport protocol or client-metadata-document support.

## Local workbench

A ChatGPT chat can also work directly on a local git worktree: list, read and search files, apply an exact edit, run a named check, and inspect git status or diff. Enable it at server startup:

```sh
node src/cli.ts serve --public-url https://your-tunnel.example --workbench /absolute/path/to/repo
```

Repeat `--workbench /absolute/path/to/another-worktree` for another root. Connect a separate owner plugin, such as `crossfeed-tools`, to `https://your-tunnel.example/tools/mcp`. This endpoint advertises the workbench tools; `/mcp` exposes only `gateway_exchange` for queue workers. Each endpoint has its own OAuth resource and host approval. A worker token cannot call the tools endpoint, and a tools token cannot call the queue endpoint. Workbench access is off at every startup unless roots are supplied or full shell is explicitly enabled; it is never restored from saved configuration. All approved tools clients can access every enabled root.

Commands default to the root's npm scripts named `test`, `check`, `lint` or `typecheck`, including suffixes such as `test:unit`. The allowlist is captured at startup. For a different project, supply `--workbench-commands /path/to/commands.json`, with canonical root paths as keys and fixed argument arrays as values:

```json
{
  "/absolute/path/to/repo": {
    "unit": ["python3", "-m", "unittest"],
    "check": ["npm", "run", "check"]
  }
}
```

`workbench_run` takes a command name, with no extra arguments. `--workbench-shell sandboxed` enables arbitrary shell input inside the same sandbox (the original bare `--workbench-shell` flag still means this); `--workbench-network` separately enables network access. Commands use macOS Seatbelt, with writes confined to the chosen root, a private temp/cache directory inside it, a stripped environment, a 20-second deadline, and 64 KiB of combined output. Timeout, cancellation and excess output terminate the command and its tracked descendants. Command execution is refused on systems without that sandbox or macOS Command Line Tools. A small native supervisor is compiled into the private state directory and uses a separate macOS responsibility identity to find and terminate detached descendants too. Checks must honor `TMPDIR`; tests that hardcode an outside temporary directory or require a local HTTP listener will fail under the default restrictions. Runtime libraries and executables remain readable so commands can start.

### Full terminal and security

Enable full terminal access explicitly:

```sh
node src/cli.ts serve --public-url https://your-tunnel.example --workbench-shell full
```

Full mode defaults to `~/Second Brain/2_Code` and `~/ws`. Repeat `--workbench PATH` to replace those defaults with your own folders. These roots can be ordinary directories; they do not need to be git worktrees. `workbench_git` needs a git repository at the selected root. Full shell runs `/bin/bash -c` with the host user's permissions and network access enabled. **Roots choose the starting folder; full commands can read and write outside them.** The host environment is inherited, with `CROSSFEED_*` variables removed. Programs can still access credentials available to that user. Approved tools connectors gain this authority. Use them only in trusted owner chats; keep worker chats on the queue connector.

At startup the workbench reads `~/.claude/settings.json` and captures every `PreToolUse` command hook whose matcher includes `Bash`, including wildcard registrations. Use `--workbench-guards /absolute/path/to/settings.json` to select a different trusted settings file. Each full command, including a named allowlisted command, is sent to every guard on stdin as a Bash hook payload with its exact command and starting directory. Guards run in registration order. A refusal stops the sequence, returns its reason to the chat, and prevents execution. Exit code 2, any other nonzero exit, a crash, timeout, cancellation, excessive output, invalid JSON, a JSON denial or a request for interactive approval blocks the command. An allow from one guard cannot override another guard. Input rewrites require a newly submitted command so every guard can inspect it. This follows the [Claude Code hook decision format](https://code.claude.com/docs/en/hooks), with stricter failure handling.

Full mode refuses startup when guard settings are missing, disabled, empty or invalid. Matching non-command, asynchronous or conditional hooks are unsupported and also refuse startup. Nonempty guard stdout must be a valid JSON object; advisory text belongs in its `additionalContext` field. Each guard defaults to five seconds unless its registration supplies a timeout. `workbench_run` has a 20-second budget including guards and supervisor preparation, with 64 KiB of command output. Every guard has a 64 KiB output cap. Both modes use the native macOS supervisor to terminate tracked descendants on completion, timeout or cancellation and require macOS Command Line Tools. Hook registrations are refreshed by restarting the server; hook scripts themselves remain the existing executable files.

For longer full-shell commands, call `workbench_start` with `root`, exactly one of `shell` or `command`, and optional `timeout_seconds`. Guards must approve within 20 seconds before launch. The returned `job_id` can be polled with `workbench_job`; it reports the last 64 KiB of output, total output bytes, state, exit code and stop reason. The default command runtime is five minutes and the maximum is 15 minutes; exceeding 4 MiB of total output stops execution. One background command runs at a time; other command launches and file edits wait until it finishes. Set `cancel: true` on a job call to stop it. Disconnecting after launch leaves it running, while connector revocation or service shutdown stops it and its tracked descendants. Only its launching connector can inspect or cancel it. Jobs stay in memory for one hour, up to 32 retained records, and disappear on restart.

These guards inspect the submitted shell text. They can catch the actions their scripts recognize, such as forbidden deletes, publishing without an audit or printing known secret files. A hook that internally skips a check and exits successfully still counts as allowing the command; some existing hooks do this when a dependency is missing. They cannot inspect every action inside a Python program, npm script or nested agent, contain a compromised process, or stop an authorized full command from changing guard scripts or the audit log. Settings from projects, plugins and managed policies, Claude's permission rules, and hooks for other tools or events are not imported. File-tool edits do not run Bash guards. Full mode is for trusted use on your own machine and is not a sandbox or a guarantee against secret disclosure.

Every full command receives a private audit record in `workbench.jsonl`: a unique command identifier, a SHA-256 digest of its exact shell input, each guard's verdict and exit status, and execution or refusal outcome. Raw commands, guard reasons and output are omitted because they may contain credentials. The digest lets you correlate a known command with its verdict without saving its text. Audit writes must succeed before execution; the log is local evidence, not tamper-proof storage.

File tools reject symlinks, hardlinks, traversal, git internals, dotenv files and credential-shaped paths. Exact edits require one occurrence of the supplied `before` text; an empty `before` creates a new file only. Reads accept UTF-8 text up to 256 KiB. List, search and git responses are bounded. Each call gets a private local audit entry in `workbench.jsonl`, containing the tool, client, root identifier, time and outcome, without contents or command output. Credential refusal is based on filenames; ordinary source files are not scanned for embedded secrets. Use a worktree intended for the chat, with one writer at a time.

## Local MCP bridge

`--bridge /path/to/bridge.json` adds selected tools from existing local MCP servers to the owner endpoint at `/tools/mcp`. It is off at every startup unless the flag is supplied. V1 supports qmd, OmniRead and Gaddi on macOS; every approved tools client can use the enabled capabilities. It does not expose mail, messaging, desktop control, arbitrary JavaScript, sign-in, uploads, screenshots or approval controls.

A minimal configuration enables qmd's indexed-note reads:

```sh
cat > bridge.json <<'JSON'
{
  "servers": {
    "qmd": {
      "command": "/opt/homebrew/bin/qmd",
      "args": ["mcp"],
      "tools": {}
    }
  }
}
JSON
chmod 600 bridge.json
node src/cli.ts serve --public-url https://your-tunnel.example --bridge "$PWD/bridge.json"
```

The JSON must be a regular, owner-owned 0600 file, without symlinks or hardlinks. Each server has an absolute `command`, an `args` array, optional `env`, and a `tools` map whose values are `allow` or `deny`. A tool defaults to denied unless its trusted local server advertises `readOnlyHint: true`. Explicit denial wins; an explicit allowance still cannot exceed the fixed v1 tool ceiling. OmniRead's `read_url`, `read_section` and `read_more` lack read-only annotations and need explicit allowances. Gaddi's navigation and interaction tools also need explicit allowances. Discovery exposes names such as `bridge_qmd_query` and `bridge_gaddi_browser_look`, with descriptive metadata rather than the upstream's imperative instructions. Refresh the connector after changing startup configuration.

The bridge launches stdio peers with a stripped environment and a macOS sandbox that denies loopback TCP. OmniRead runs as a public reader: its authenticated acquisition plugin, Gaddi socket and stored login profiles are unavailable. Direct URLs must resolve to public addresses; credential-bearing URLs and known mail/messaging hosts are rejected. Gaddi calls require explicit tabs opened by the same connector client. The bridge checks the current page before interactions and refuses actions when Gaddi's policy is disabled. Browser-originated requests to this instance's control API are refused even with a control credential. The extension's separate pairing routes retain their existing authentication.

Every dispatched or refused bridge call gets a private `bridge.jsonl` entry with time, client, tool and outcome, without input or returned contents. Calls are serialized, time out after 20 seconds, and return at most 64 KiB. Optional `timeout_ms` can lower the deadline to 100 ms; `output_bytes` can lower the output cap to 1 KiB. Transport frames are capped at 1 MiB. A timeout, cancellation or crash stops the peer. A peer that cannot start, or stops later, is logged by name with its exit code (its own error output stays hidden because it can contain secrets), its tools leave the tool list, and the bridge retries it every minute; the gateway and the other peers keep serving. `status` and `doctor` show each unavailable peer. An already-dispatched browser action may have an unknown outcome, so it must not be blindly retried.

Gaddi's existing action policy remains responsible for classifying one-way actions. A HELD result retains its approval ID; this bridge never grants approvals, supplies approval IDs or retries held actions. **These gates are not a guarantee that every irreversible website action is detected.** Chrome and Gaddi's existing broker are outside the peer sandbox, so a public page can redirect or run its own JavaScript. Public URL checks and returned-page checks reduce that exposure but do not sandbox the logged-in browser.

Text and structured output redact known process/configuration credentials, credential-labelled fields, bearer tokens, common service tokens and private keys. Images and opaque resources are not forwarded. Unlabelled secrets in ordinary note or page prose cannot be reliably identified; use trusted sources whose credentials live outside their readable content. This bridge trusts the owner-selected local server executables and their existing safety mechanisms. MCP annotations are hints, not an isolation boundary ([MCP tool annotations](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2025-06-18/schema.ts)).

For an isolated acceptance trial, `node scripts/live-bridge.ts start` discovers the local Gaddi and OmniRead launch commands from Codex's configuration, adds qmd, and starts a separate server and quick tunnel. Its private runtime receipt is `.scratch/bridge-live.json`; `control pending`, `control approve ID` and `control stop` operate only that instance. Its synthetic Delete page is for observing HELD, with no approval. The trial does not change production service or saved configuration.
