#!/usr/bin/env node
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { createApp } from './server.ts';
import type { App, AppOptions } from './server.ts';
import { defaultDirectory } from './config.ts';
import { check, Fault } from './security.ts';

const help = `Crossfeed Chat
  serve --public-url https://your-tunnel.example --connector Crossfeed
        [--api-port 4319] [--mcp-port 4320] [--state-dir PATH]
        [--job-deadline-ms 1800000] [--worker-lease-ms MS, default: job deadline] [--max-claimed-jobs 4] [--wake-daily-cap 0, off] [--wake-hourly-cap 12]
        [--attachment-delivery mcp|composer] [--chat-disposal archive|delete] [--no-audio-transcription] [--speech-locale en-US]
        [--workbench ROOT ...] [--workbench-commands JSON_FILE]
        [--workbench-shell sandboxed|full] [--workbench-network]
        [--workbench-guards SETTINGS_FILE, default: ~/.claude/settings.json]
        [--bridge OWNER_ONLY_JSON_FILE]
  link                     Open a five-minute ChatGPT registration window
  approve --pending        List host approvals
  approve <id>             Approve that exact pending OAuth request
  doctor                   Print problems and a next step for each
  status                   Show known/awake labels and wake requests
  cancel <job-id>           Remove a queued or running job; its caller gets caller_cancelled
  worker add <label> --row ROW --level 0..4 [--replicas N] [--wake-mode configured|native]
  worker set <label> [--replicas N] [--wake-mode configured|native]
  worker list
  worker remove <label>
  client list              List approved OAuth connectors
  client revoke <id>       Revoke that connector and all its grants
  extension list           List pending and paired extensions
  extension approve <id/code> Approve the matching extension pairing
  extension revoke <id>    Revoke that extension's access
  wake <label>             Start a fresh chat for a saved worker
All control commands accept --api-port. Supply CROSSFEED_API_KEY through
the environment. Install the extension and approve its pairing code.
Keys are never printed or written by this CLI.`;

export function diagnose(status: ReturnType<App['status']>) {
  const problems = [];
  if (!status.host_available) problems.push('The host has stopped accepting work. Next: restart serve, then retry with the same key.');
  if (status.capacity.claimed >= status.capacity.limit) problems.push(`All ${status.capacity.limit} concurrent claim slots are occupied. Next: wait for current answers; queued jobs will be claimed as slots open.`);
  if (!status.workers.length) problems.push('No workers are configured. Next: run worker add <label> --row ROW --level 0..4.');
  for (const worker of status.workers) {
    if (worker.quota_blocked) problems.push(`${worker.label}: ChatGPT quota is paused until ${new Date(worker.quota_until).toISOString()}. Next: wait for that time or use another label.`);
    else if (!worker.awake) problems.push(`${worker.label}: no active worker contact. Next: ${worker.saved && status.extension_enabled ? 'run wake ' + worker.label : 'open a fresh ChatGPT chat and wake this label with the connector'}.`);
  }
  for (const job of status.jobs) if (job.error === 'uncertain_delivery') problems.push(`${job.label}: a delivered request has an unknown outcome (${job.id}). Next: inspect its ChatGPT chat before submitting new work; retrying its key returns the recorded error.`);
  for (const wake of status.wakes) if (['failed', 'expired'].includes(wake.state)) {
    const details = [wake.failure_code ? `reason=${wake.failure_code}` : '', wake.failure_stage ? `stage=${wake.failure_stage}` : ''].filter(Boolean).join(', ');
    const next = wake.failure_code === 'level_unavailable' ? 'choose a level available on your ChatGPT plan (Plus: 0 Instant, 1 Medium, 2 High), then run worker set ' + wake.label + ' --level LEVEL and retry after the cooldown' : 'check the extension pairing, browser extension permissions and the signed-in ChatGPT page, then retry after the cooldown';
    problems.push(`${wake.label}: fresh-chat wake failed${details ? ` (${details})` : ''}. Next: ${next}.`);
  }
  for (const issue of status.host_checks?.issues ?? []) problems.push(issue);
  for (const [name, peer] of Object.entries(status.bridge ?? {})) if (!peer.available) problems.push(`Bridge ${name} is unavailable since ${peer.since} (${peer.error}: ${peer.message}). Next: run its server by hand to read the error (for a Node server after a Node upgrade, rebuild its native modules); the bridge retries every minute.`);
  if (!status.extension_enabled) problems.push('No paired wake extension. Next: load extension/ in chrome://extensions or brave://extensions, open its options, then match and approve the code with extension list and extension approve CODE.');
  for (const approval of status.approvals) problems.push(`A connector is waiting for host approval. Next: run approve ${approval.id} if you requested this connection.`);
  if (status.wake_limits.blocked) problems.push(status.wake_limits.blocked);
  if (status.wake_limits.cooldown_until > Date.now()) problems.push('A saved global wake cooldown is active. Next: wait until the cooldown expires.');
  return problems;
}

interface CLIResponse { ok: boolean; status: number; json(): Promise<any> }
interface CLIIO { fetch: (url: string, init: RequestInit) => Promise<CLIResponse>; log: (message: string) => void }
export async function main(argv: string[] = process.argv.slice(2), env: Record<string, string | undefined> = process.env, io: CLIIO = { fetch, log: console.log }) {
  if (argv[0] === 'cancel' && argv[1]?.startsWith('-') && /^[A-Za-z0-9_-]{32}$/.test(argv[1])) argv = [argv[0], ...argv.slice(2), '--', argv[1]];
  // OAuth IDs are URL-safe and can start with a hyphen; treat the revoke ID as data.
  if (argv[0] === 'client' && argv[1] === 'revoke' && argv[2]?.startsWith('-') && argv[2] !== '--') argv = [...argv.slice(0, 2), ...argv.slice(3), '--', argv[2]];
  // Preserve the original bare flag as the confined shell opt-in.
  argv = argv.flatMap((arg, index) => arg === '--workbench-shell' && (!argv[index + 1] || argv[index + 1].startsWith('--') || argv[index + 1] === 'serve') ? [arg, 'sandboxed'] : [arg]);
  const { values: flags, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    'public-url': { type: 'string' }, connector: { type: 'string' }, 'api-port': { type: 'string' }, 'mcp-port': { type: 'string' },
    'workbench': { type: 'string', multiple: true }, 'workbench-commands': { type: 'string' }, 'workbench-shell': { type: 'string' }, 'workbench-network': { type: 'boolean' }, 'workbench-guards': { type: 'string' },
    bridge: { type: 'string' },
    'no-audio-transcription': {type: 'boolean'}, 'speech-locale': {type: 'string'},
    'state-dir': { type: 'string' }, row: { type: 'string' }, 'job-deadline-ms': { type: 'string' }, 'max-claimed-jobs': { type: 'string' }, 'worker-lease-ms': { type: 'string' }, 'wake-daily-cap': { type: 'string' }, 'wake-hourly-cap': { type: 'string' }, 'attachment-delivery': { type: 'string' }, 'chat-disposal': { type: 'string' }, level: { type: 'string' }, replicas: {type: 'string'}, 'wake-mode': {type: 'string'}, pending: { type: 'boolean' }, help: { type: 'boolean' }
  } });
  const [command, arg, workerLabel] = positionals;
  if (flags.help || !command) { io.log(help); return; }
  const port = Number(flags['api-port'] ?? env.CROSSFEED_API_PORT ?? 4319);
  check(Number.isInteger(port) && port > 0 && port <= 65535, 'Invalid API port');
  check(typeof env.CROSSFEED_API_KEY === 'string' && /^[A-Za-z0-9._~-]{32,256}$/.test(env.CROSSFEED_API_KEY), 'Supply CROSSFEED_API_KEY, at least 32 URL-safe characters');
  check(positionals.length <= (['worker', 'client', 'extension'].includes(command) ? 3 : ['approve', 'wake', 'cancel'].includes(command) ? 2 : 1), 'Unexpected arguments');
  const allowed = ({ serve: ['public-url', 'connector', 'api-port', 'mcp-port', 'state-dir', 'job-deadline-ms', 'worker-lease-ms', 'max-claimed-jobs', 'wake-daily-cap', 'wake-hourly-cap', 'attachment-delivery', 'chat-disposal', 'no-audio-transcription', 'speech-locale', 'workbench', 'workbench-commands', 'workbench-shell', 'workbench-network', 'workbench-guards', 'bridge'], link: ['api-port'], approve: ['api-port', 'pending'], status: ['api-port'], doctor: ['api-port'], cancel: ['api-port'], wake: ['api-port'], client: ['api-port'], extension: ['api-port'], worker: ['api-port', 'row', 'level', 'replicas', 'wake-mode'] } as Record<string, string[]>)[command];
  check(allowed && Object.keys(flags).every(k => allowed.includes(k)), 'Unknown command or inappropriate flag');
  if (command === 'serve') {
    const config: Partial<ReturnType<typeof import('./config.ts').loadConfig>> = {};
    if (flags['public-url']) config.public_url = flags['public-url'];
    if (flags.connector) config.connector = flags.connector;
    if (flags['job-deadline-ms'] !== undefined) config.job_deadline_ms = Number(flags['job-deadline-ms']);
    if (flags['max-claimed-jobs'] !== undefined) config.max_claimed_jobs = Number(flags['max-claimed-jobs']);
    if (flags['worker-lease-ms'] !== undefined) config.worker_lease_ms = Number(flags['worker-lease-ms']);
    if (flags['wake-hourly-cap'] !== undefined) config.wake_hourly_cap = Number(flags['wake-hourly-cap']);
    config.wake_daily_cap = flags['wake-daily-cap'] === undefined ? 0 : Number(flags['wake-daily-cap']);
    if (flags['chat-disposal'] !== undefined) {
      check(['archive', 'delete'].includes(flags['chat-disposal']), 'Chat disposal must be archive or delete');
      config.chat_disposal = flags['chat-disposal'] as 'archive' | 'delete';
    }
    if (flags['attachment-delivery'] !== undefined) {
      check(['mcp', 'composer'].includes(flags['attachment-delivery']), 'Attachment delivery must be mcp or composer');
      config.attachment_delivery = flags['attachment-delivery'] as 'mcp' | 'composer';
    }
    check(flags['workbench-shell'] === undefined || ['sandboxed', 'full'].includes(flags['workbench-shell']), 'Workbench shell must be sandboxed or full');
    check(flags['workbench-guards'] === undefined || flags['workbench-shell'] === 'full', 'Workbench guards require --workbench-shell full');
    check(flags.workbench?.length || flags['workbench-shell'] === 'full' || !['workbench-commands','workbench-shell','workbench-network'].some(key => flags[key as keyof typeof flags] !== undefined), 'Workbench permissions require --workbench');
    let workbench: AppOptions['workbench'];
    if (flags.workbench || flags['workbench-shell'] === 'full') {
      let commands = {};
      if (flags['workbench-commands']) {
        const filename = flags['workbench-commands'];
        check(fs.lstatSync(filename).isFile() && fs.statSync(filename).size <= 65536, 'Invalid workbench command file');
        commands = JSON.parse(fs.readFileSync(filename, 'utf8'));
      }
      workbench = { roots: flags.workbench, commands, shell: flags['workbench-shell'] as 'sandboxed' | 'full' | undefined ?? false, network: !!flags['workbench-network'], guardSettings: flags['workbench-guards'] };
    }
    check(!flags.bridge || process.platform === 'darwin', 'The tools bridge requires the macOS local-network sandbox. On Linux, omit --bridge; workers and file tools can run without it.', 503);
    const app = await createApp({ workbench, bridge: flags.bridge, audio: {enabled: !flags['no-audio-transcription'], locale: flags['speech-locale']}, directory: flags['state-dir'] ?? defaultDirectory(env), apiKey: env.CROSSFEED_API_KEY, apiPort: port, mcpPort: Number(flags['mcp-port'] ?? 4320), config });
    let closing = false;
    const stop = async () => { if (closing) return; closing = true; await app.close(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    io.log(`Local API: ${app.apiUrl}/v1\nMCP tunnel target: ${app.mcpUrl}\nWorker connector: ${app.config.public_url}/mcp\nOwner tools connector: ${app.config.public_url}/tools/mcp\nRun crossfeed-chat link, then approve the pending request on this host.`);
    return app;
  }
  const call = async (route: string, input?: Record<string, unknown>) => {
    const response = await io.fetch(`http://127.0.0.1:${port}${route}`, { method: input === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${env.CROSSFEED_API_KEY}`, ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(10000) });
    const data = await response.json();
    check(response.ok, data.error?.message ?? 'Control request failed', response.status);
    return data;
  };
  if (command === 'link') {
    const result = await call('/link', {});
    io.log(`Connection window open for five minutes.\n1. Tunnel ONLY the MCP listener (default 127.0.0.1:4320).\n2. In ChatGPT add a custom connector with OAuth: ${result.public_url}/mcp\n3. When the approval page appears, run crossfeed-chat approve --pending, then approve <id>.\n4. Choose Always allow for this connector if ChatGPT prompts.\n5. Save a worker with worker add <label> --row ROW --level 0..4, using the exact row text shown in your ChatGPT model picker.\n6. Install the wake extension, then run wake <label>, or open a fresh Chat mode chat and send @<connector> wake up. Call gateway_exchange with worker_label=<label>..`);
  } else if (command === 'approve') {
    check(flags.pending ? !arg : !!arg, 'Use approve --pending or approve <id>');
    io.log(JSON.stringify(await call(flags.pending ? '/approvals' : '/approve', flags.pending ? undefined : { id: arg }), null, 2));
  } else if (command === 'doctor') {
    let status;
    try { status = await call('/status'); } catch (error) {
      if (error instanceof Fault) throw new Fault(error.status, 'doctor_refused', error.status === 401 ? 'Control authentication was refused. Next: supply the server CROSSFEED_API_KEY and check --api-port.' : 'The host could not read its status. Next: check private state permissions and restart serve.');
      throw new Fault(503, 'host_unreachable', 'Host is not reachable. Next: start serve and check --api-port.');
    }
    const problems = diagnose(status);
    io.log(problems.length ? problems.join('\n') : 'No problems found.');
  } else if (command === 'status') io.log(JSON.stringify(await call('/status'), null, 2));
  else if (command === 'cancel') {
    check(typeof arg === 'string' && /^[A-Za-z0-9_-]{32}$/.test(arg), 'Use cancel <32-character job-id>');
    io.log(JSON.stringify(await call('/jobs/cancel', {id:arg}), null, 2));
  }
  else if (command === 'extension') {
    check(['list', 'approve', 'revoke'].includes(arg) && (arg === 'list' ? !workerLabel : !!workerLabel), 'Use extension list, approve <id/code>, or revoke <id>');
    io.log(JSON.stringify(await call(arg === 'list' ? '/extensions' : `/extensions/${arg}`, arg === 'list' ? undefined : { id: workerLabel }), null, 2));
  } else if (command === 'client') {
    check(['list', 'revoke'].includes(arg) && (arg === 'list' ? !workerLabel : !!workerLabel), 'Use client list or client revoke <id>');
    io.log(JSON.stringify(await call(arg === 'list' ? '/clients' : '/clients/revoke', arg === 'list' ? undefined : {id: workerLabel}), null, 2));
  } else if (command === 'worker') {
    check(['add', 'set', 'list', 'remove'].includes(arg), 'Use worker add, set, list, or remove');
    check(arg === 'list' ? !workerLabel && flags.row === undefined && flags.level === undefined && flags.replicas === undefined && flags['wake-mode'] === undefined : !!workerLabel, 'Invalid worker arguments');
    check(arg !== 'remove' || flags.row === undefined && flags.level === undefined && flags.replicas === undefined && flags['wake-mode'] === undefined, 'Remove takes only a label');
    check(arg !== 'add' || flags.row !== undefined && /^[0-4]$/.test(flags.level ?? ''), 'Use worker add <label> --row ROW --level 0..4');
    check(arg !== 'set' || flags.row !== undefined || flags.level !== undefined || flags.replicas !== undefined || flags['wake-mode'] !== undefined, 'Worker set needs settings');
    check(flags['wake-mode'] === undefined || ['configured', 'native'].includes(flags['wake-mode']), 'Wake mode must be configured or native');
    check(flags.replicas === undefined || /^[0-9]+$/.test(flags.replicas) && Number(flags.replicas) >= 1 && Number(flags.replicas) <= 16, 'Replicas must be an integer from 1 to 16');
    io.log(JSON.stringify(await call(arg === 'list' ? '/workers' : `/workers/${arg}`, arg === 'list' ? undefined : { label: workerLabel, ...(['add', 'set'].includes(arg) ? {...(flags.row !== undefined ? {row: flags.row} : {}), ...(flags.level !== undefined ? {level: Number(flags.level)} : {}), ...(flags.replicas !== undefined ? {replicas: Number(flags.replicas)} : {}), ...(flags['wake-mode'] !== undefined ? {wake_mode: flags['wake-mode']} : {})} : {}) }), null, 2));
  } else {
    check(arg, 'Use wake <label>');
    io.log(JSON.stringify(await call('/wake', { label: arg }), null, 2));
  }
}
if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  main().catch(e => {
    // Never echo parseArgs/fetch/filesystem errors: they can contain caller input.
    console.error(e instanceof Fault ? e.message : 'Command failed; check flags, listener ports, and private state permissions');
    process.exitCode = 1;
  });
}
