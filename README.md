<h1><img src="assets/readme-header.svg" width="112" height="72" align="absmiddle" alt=""> <img src="assets/crossfeed-chat-title.svg" width="238" align="absmiddle" alt="Crossfeed Chat*"></h1>

Your ChatGPT subscription as a tool for your local agents, and your computer's tools for your ChatGPT chats, on macOS and Linux.

It runs a local server with two [MCP](https://modelcontextprotocol.io/) connectors: `crossfeed` lets agents such as [Pi](https://github.com/badlogic/pi-mono) ask a ChatGPT worker for text answers or structured tool calls; `crossfeed-tools` lets your own ChatGPT chats use local files, guarded shell commands and selected [Gaddi](https://github.com/ABCastor/gaddi), [OmniRead](https://github.com/ABCastor/omniread) and [qmd](https://github.com/tobi/qmd) tools. Images and documents go in; generated files can come back out.

Chat has its own usage limits, separate from the shared Work and Codex allowance. API usage is billed separately. That makes a ChatGPT subscription useful to local agents that would otherwise spend API tokens or Codex allowance on each request. [OpenAI's usage guidance](https://help.openai.com/en/articles/20001516-managing-usage-with-gpt-6-astra-in-work-and-codex) explains the distinction, checked 4 October 2026. Your plan's chat and reasoning limits still apply.

Crossfeed Chat works alone or with [Crossfeed Orchestrator](https://github.com/ABCastor/crossfeed-orchestrator), which dispatches work to different agents.

## Current checkout and optional diagnostic (17 October 2026)

This checkout is the **TypeScript** source (`src/*.ts`, `test/*.test.ts`) with the unpacked JavaScript extension; the removed root JS draft and earlier `extension/merged-3308cb0` paths are historical, not alternate current runtimes. The reviewed gateway keeps unkeyed scoped ordinary **queued** work finite at **45 minutes from original enqueue even with warm polling**, separate from a **30-minute per-claim** absolute deadline/contact lease yielding `uncertain_delivery` and no automatic replay. Neither is a whole-agent timeout or a guarantee of browser delivery or non-interrupting first frames.

The **manual-only, finite** KDE/Wayland wake checker is in [`tools/wake_checker/`](tools/wake_checker/README.md): `npm run wake:check -- doctor` performs a capability preflight, `npm run wake:check -- listen --duration 60` starts an operator-requested bounded observation, and `npm run test:wake-checker` runs its Python unit suite. Native KDE/DBus dependencies are optional; status/CDP, active browser probes and sensitive capture need their separately documented explicit permissions. No autostart, daemon, default screenshot, credential access or automatic service hook is added. Source tests do not establish exact physical first pixels or universal foreground safety. The [optional headed automation browser](docs/automation-browser.md) is a separately provisioned, explicitly opt-in workflow; this repository does not automatically install, enable or start its user service.

## How it does at coding

In a 12-task coding trial completed on 5 October 2026, Codex Sol High passed 12/12 and Luna High passed 11/12. ChatGPT through Pi passed 9/11 measured tasks at High and 9/10 at Extra High. Pro passed 2/2, with ten tasks unmeasured. Median times were 232 seconds for Sol High, 341 for ChatGPT High and 402 for Extra High.

The tasks required code changes and were scored by independent checks. Pi supplied local tools and test feedback; these results do not measure the native text-only connector. Missing tasks are unmeasured, and scored transport deadlines count as failures. The underlying ChatGPT model was unconfirmed. This partial comparison does not establish a ChatGPT advantage; use Sol High when its allowance is available and ChatGPT when a separate allowance is useful.

## In use

A ChatGPT chat repairs a failing test using the local workbench. This trial used a connector named `crossfeed-bench`:

![A real ChatGPT workbench trial changes subtraction to addition and reports two passing tests](assets/chat-tools.png)

A worker picks up a queued repair request through `crossfeed`:

![A real ChatGPT worker receives a queued repair request through the Crossfeed connector](assets/chat-worker.png)

## Limits and account risk

**Audio uses local transcription on macOS.** The worker receives a labelled text transcript from Apple's built-in Speech framework. Recognition stays on your Mac; the transcript and original attachment go to ChatGPT. Recordings are limited to 60 seconds, the default language is `en-US`, and recognition can make mistakes. Images and documents use MCP attachment delivery. Direct audio perception in ChatGPT remains unverified.

The ChatGPT UI can change, workers can stop generating, and model controls depend on your account. New labels default to native fresh-chat behavior: they verify the exact prefill and connector before one Send click, but they do not open the picker or attest a model/reasoning level. Set `wake_mode` to `configured` when you require strict saved picker-row/effort verification. Composer attachment jobs always use the configured saved settings. Streaming is buffered until the answer is complete; token usage is unknown. This implements a subset of Chat Completions, and rejects unsupported fields and JSON response schemas. For dependable API semantics, use the API.

**Automating the ChatGPT web app may conflict with OpenAI's terms.** The [Terms of Use](https://openai.com/policies/row-terms-of-use/) prohibit automatically or programmatically extracting data or output, as do the [Europe Terms of Use](https://openai.com/policies/eu-terms-of-use/). Both prohibit bypassing rate limits or protective measures and allow suspension or termination for a breach. Checked 4 October 2026. I accept this risk for my account. You decide whether to accept it for yours.

## Install and connect

You need macOS or Linux, [Node.js](https://nodejs.org/) 24.18 or newer, Chrome 120 or newer or a compatible Chromium browser such as Brave for automatic wakes, an HTTPS tunnel, and a ChatGPT account that supports custom MCP connectors. Node runs the TypeScript source directly using its [built-in type stripping](https://nodejs.org/api/typescript.html). There are no runtime npm dependencies or build step. The unpacked Chrome extension stays JavaScript, with JSDoc types checked by TypeScript.

| Capability | macOS | Linux |
|---|---|---|
| Gateway, ChatGPT workers, attachments and browser wakes | Available | Available |
| Local file and Git tools | Available | Available |
| Local speech transcription | Apple Speech; Command Line Tools required | Unavailable; original audio can still be delivered |
| Workbench shell commands | Command Line Tools required | Unavailable; run commands in your own terminal |
| Gaddi, OmniRead and qmd tools bridge | Available | Unavailable |
| Optional native-wake focus restoration | Unavailable | KDE Wayland with KWin; other desktops continue without it |

See the [Linux setup and limitations](docs/usage.md#linux-setup) for state paths and browser pairing. The gateway supports both platforms; the optional host features above do not have full platform parity.

Clone this repository and work from its directory; Node does not strip TypeScript inside `node_modules`, so installing a packed copy with npm is unsupported. Supply `CROSSFEED_API_KEY` through your password manager into the server and CLI environments. It must contain 32-256 URL-safe characters (`A-Z a-z 0-9 . _ ~ -`). The CLI never generates or displays it.

Start the server:

```sh
node src/cli.ts serve --public-url https://your-tunnel.example --connector crossfeed
```

Replace the URL with your tunnel's HTTPS origin. **Tunnel only `127.0.0.1:4320`, the MCP listener.** Keep the control API at `127.0.0.1:4319` on your computer.

In another terminal, open connector registration for five minutes:

```sh
node src/cli.ts link
```

Add `crossfeed` in ChatGPT as a custom connector with OAuth and URL `https://your-tunnel.example/mcp`. It uses a public client ID, with no client secret. When the host-approval page opens:

```sh
node src/cli.ts approve --pending
node src/cli.ts approve <id-from-the-list>
```

Inspect the client and callback before approving. Approval is bound to the original browser and expires after 90 seconds.

### Wake a worker

Save a label with a model row and reasoning level. Explicitly `configured` ordinary wakes and composer attachment jobs verify the saved model-row/effort settings before sending; the default `native` ordinary wake does not open the picker and supplies no model or reasoning-level attestation. Copy the exact row text from your ChatGPT model menu; it changes when OpenAI ships new models. For example:

```sh
node src/cli.ts worker add sol --row "GPT-6" --level 2
```

The configured level values are 0 Instant, 1 Medium, 2 High, 3 Extra High and 4 Pro. **New labels default to `native`; existing labels keep their recorded mode, or `configured` for saved row/level settings without an explicit mode.** Native wakes inherit the current defaults of a fresh ChatGPT chat, do not open the picker, and have no extension picker observation; a label such as `sol` is therefore a routing name, not proof of the model or effort behind it. Use `node src/cli.ts worker set sol --wake-mode configured` before first use when you require strict saved picker-row/effort verification. Configured wakes refuse an unavailable level instead of remapping it. Used labels cannot change wake mode, and deleting/recreating a used label does not clear its retained mode fence. Used legacy configured labels may explicitly restore `configured`. Composer jobs always select the saved settings.

For concurrent requests to the same label, run `node src/cli.ts worker set sol --replicas 2`, or pass `--replicas 2` when adding it. Counts range from 1 to 16 and default to 1. Callers still use `chatgpt:sol`. Each replica has its own chat; the extension wakes another only when work is waiting beyond the awake workers' capacity. Wake limits and quota pauses apply to the whole label. Status lists each worker identity, and completion metadata identifies the replica that answered. Reducing the count requires no pending work; removed idle workers are released and their chat URLs stay saved.

In Chrome or Brave's extensions page, enable Developer mode and load `extension/` as an unpacked extension. Open its Options page to see the pairing code, then approve the matching code on the computer running the server:

```sh
node src/cli.ts extension list
node src/cli.ts extension approve <matching-code-or-id>
node src/cli.ts wake sol
```

For a native automatic wake, the extension creates its own separate normal window requesting `state:"minimized"` (not a guarantee of native no-focus), without grouping its tab in a way that would raise the window, and uses the exact native ChatGPT prefill naming the connector, issued label and nonce. It verifies the owned document and clicks its unambiguous Send control once, without debugger keyboard input or a model picker. On KDE Wayland, an optional short-lived KWin guard can restore the prior window only after the new window displays that claim's private ownership marker. Another user-created browser window cannot qualify merely by appearing at the same time. Initial foreground frames can still occur while the title hydrates; desktop efficacy requires a live check. Missing or failed focus support preserves the authorized wake. Finally cleanup attempts to close only the exact owned tab even after an uncertain Send outcome; the owned-tab registry retries failed closes on the next idle poll. A sealed uncertain Send is not clicked again. Completed answers renew the idle polling lease, so subsequent requests reuse the warm chat. Fresh wakes default to 12 per rolling hour with the daily cap off. Each claim has an absolute 30-minute deadline/contact lease: when it expires, the result is `uncertain_delivery`, not a promise of late delivery or automatic replay. See [timing, focus and upgrade controls](docs/usage.md#deadlines-and-recovery). You can wake a worker manually in a fresh Chat-mode conversation by selecting the settings and `crossfeed` mention, then sending `@crossfeed wake up as sol`.

### Send a request from your agent

Set its base URL to `http://127.0.0.1:4319/v1`, bearer key to `CROSSFEED_API_KEY`, and model to `chatgpt:sol`. It can send text, attachments and function definitions using the supported Chat Completions fields. The worker returns function calls for your local agent to execute.

For separate Pi conversations, enable `sendSessionAffinityHeaders: true` and `sessionAffinityFormat: "openai"` in the Crossfeed model configuration. Each caller session then gets its own ChatGPT chat. See [Pi sessions and retries](docs/usage.md#pi-sessions-and-retries).

Use an `Idempotency-Key` for retries: the same key and payload return the original result within the ten-minute retention window. Reusing a key with changed input returns 409. [Request examples, attachments and permissions](docs/usage.md) cover the supported fields and returned files.

### Give your own chats local tools

Enable a folder at startup:

```sh
node src/cli.ts serve --public-url https://your-tunnel.example --connector crossfeed --workbench /absolute/path/to/repo
```

Open registration again with `link`, then add `crossfeed-tools` using `https://your-tunnel.example/tools/mcp` and approve it on the host. The two endpoints have separate OAuth audiences: queue workers cannot call owner tools, and owner tools cannot poll the queue.

File tools list, read, search and apply exact edits on macOS and Linux. On macOS, named commands come from the root's test, check, lint and typecheck npm scripts and run in a sandbox by default. `--workbench-shell full` enables the host user's shell authority after every configured Bash guard allows the command. **Full shell can read and write outside the selected folders and access the user's credentials.** Use it only in trusted owner chats. Long commands use `workbench_start` and `workbench_job`. On Linux, use the file and Git tools and run commands in your own terminal; neither shell mode is supported.

On macOS, `--bridge /absolute/path/to/bridge.json` adds selected tools from local Gaddi, OmniRead and qmd servers. It defaults to read-only annotations within a fixed tool ceiling; browser interactions require explicit allowance. Held actions keep their approval IDs and cannot be approved or retried through the bridge. See [bridge configuration and safety limits](docs/usage.md#local-mcp-bridge).

## Data and checks

Requests pass through your ChatGPT account. Jobs, attachments, hashed grants and worker settings persist in an owner-only local state directory. Expired records may remain until the next state write. Audit logs omit payloads and credentials; ordinary files or pages can still contain secrets the filters cannot recognize. To inspect or revoke a connector, use `node src/cli.ts client list` and `node src/cli.ts client revoke <id>`.

```sh
npm ci
npm test
npm run test:tcp
npm run check
npm run typecheck
```

`npm ci` installs TypeScript, the only development dependency. The typecheck covers TypeScript and the extension's JSDoc, using local declarations for the Node APIs this project consumes.

The suites exercise production handlers, OAuth isolation, attachment transport, persistence, cancellation, wake controls, command guards and real ephemeral TCP listeners. They do not contact ChatGPT; live UI behavior remains a separate check.

## Credit and licence

Thank you to Rocco Angelella for [PiLink](https://github.com/roccoangelella/PiLink), the project this gateway builds on. The code is [Apache 2.0](LICENSE), with PiLink's copyright and permission notice retained in [NOTICE](NOTICE). The name, marks and signature artwork are outside that licence.

<p><a href="https://abcastor.com"><img src="docs/castor-footer.svg" width="350" alt="Chip, the Castor beaver, Castor, we give a dam"></a></p>
