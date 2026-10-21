import type { ChildProcess } from 'node:child_process';
import type { CallContext, LocalTool, ToolSchema } from './types.ts';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { check, Fault, object, privateDirectory } from './security.ts';

const FRAME_BYTES = 1024 * 1024;
const INPUT_BYTES = 32768;
const ceiling: Record<string, Set<string>> = {
  qmd: new Set(['query', 'get', 'multi_get', 'status']),
  omniread: new Set(['read_url', 'read_section', 'read_more']),
  gaddi: new Set(['browser_status', 'browser_open', 'browser_goto', 'browser_look', 'browser_read', 'browser_wait', 'browser_click', 'browser_type', 'browser_press', 'browser_hover', 'browser_scroll', 'browser_select', 'browser_close']),
};
const secretKey = /password|passwd|secret|credential|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|private[_-]?key|^token$/i;
const fail = (code: string, message: string) => new Fault(400, code, message);

export function loadBridge(filename: string) {
  let fd;
  try {
    fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    check(stat.isFile() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600 && stat.uid === process.getuid!() && stat.size <= 65536, 'Bridge config must be an owner-only 0600 regular file');
    const config = JSON.parse(fs.readFileSync(fd, 'utf8')) as BridgeConfig;
    check(object(config) && Object.keys(config).every(k => ['servers', 'timeout_ms', 'output_bytes'].includes(k)), 'Invalid bridge config');
    check(object(config.servers) && Object.keys(config.servers).length > 0 && Object.keys(config.servers).length <= 3, 'Bridge requires one to three servers');
    for (const [name, server] of Object.entries(config.servers)) {
      check(Object.hasOwn(ceiling, name) && object(server) && Object.keys(server).every(k => ['command', 'args', 'env', 'tools'].includes(k)), 'Bridge v1 supports only gaddi, omniread and qmd');
      check(typeof server.command === 'string' && path.isAbsolute(server.command) && fs.statSync(server.command).isFile(), 'Invalid bridge server command');
      check(Array.isArray(server.args) && server.args.length <= 32 && server.args.every(arg => typeof arg === 'string' && arg.length <= 8192 && !arg.includes('\0')), 'Invalid bridge server arguments');
      check(server.env === undefined || object(server.env) && Object.entries(server.env).every(([key, value]) => /^[A-Z_][A-Z0-9_]*$/.test(key) && !/^CROSSFEED|^NODE_OPTIONS$|^LD_|^DYLD_/.test(key) && typeof value === 'string' && value.length <= 8192 && !value.includes('\0')), 'Invalid bridge environment');
      check(object(server.tools) && Object.entries(server.tools).every(([tool, policy]) => /^[a-zA-Z0-9_]{1,64}$/.test(tool) && ['allow', 'deny'].includes(policy)), 'Tool policies must be allow or deny');
    }
    for (const [key, min, max, fallback] of [['timeout_ms', 100, 20000, 20000], ['output_bytes', 1024, 65536, 65536]] as const) {
      config[key] ??= fallback;
      check(Number.isInteger(config[key]) && config[key] >= min && config[key] <= max, 'Invalid bridge limits');
    }
    return config;
  } catch (error) {
    throw error instanceof Fault ? error : fail('bridge_config', 'Bridge config could not be loaded');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

// Loopback TCP is blocked in the peer process, including HTTP redirects/rebinding.
// Gaddi's existing Chrome is outside this sandbox; the API separately refuses
// browser-originated control requests and URL policy guards its direct calls.
const sandbox = '(version 1)(allow default)(deny network-outbound (remote ip "localhost:*"))';

export interface BridgeServer { command: string; args: string[]; env?: Record<string, string>; tools: Record<string, 'allow' | 'deny'> }
export interface BridgeConfig { servers: Record<string, BridgeServer>; timeout_ms: number; output_bytes: number }
interface PageData { url?: string; tabId?: number; id?: number; tab?: number | {id: number}; closed?: number[]; policy?: {off: boolean}; result?: {provenance?: {final_url: string}}; provenance?: {final_url: string} }
interface PeerResult { content?: {type: string; text?: string}[]; structuredContent?: PageData; tools?: LocalTool[]; nextCursor?: string; isError?: boolean }
interface BridgeRoute {server: string; tool: string; schema: ToolSchema}
class Peer {
  declare timeout: number; declare pending: Map<number, {resolve: (result: PeerResult) => void; reject: (error: unknown) => void}>; declare sequence: number; declare closed: boolean;
  declare child: ChildProcess; declare buffer: Buffer; declare onStop?: (code: string, message: string) => void;

  constructor(config: BridgeServer, timeout: number, { name, directory }: {name: string; directory: string}) {
    this.timeout = timeout;
    this.pending = new Map(); this.sequence = 0; this.closed = false;
    check(process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec'), 'Bridge requires the macOS local-network sandbox; on Linux omit --bridge and use the gateway without bridged tools', 503);
    const env: Record<string, string | undefined> = {};
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG']) if (process.env[key]) env[key] = process.env[key];
    Object.assign(env, config.env);
    if (name === 'omniread') {
      // Public reader v1 does not borrow logged-in Chrome or stored login profiles.
      delete env.OMNIREAD_ACQUIRER_PLUGIN;
      env.GADDI_SOCKET = path.join(directory, 'bridge-no-browser.sock');
      env.OMNIREAD_PROFILE_DIR = path.join(directory, 'bridge-no-profiles');
    }
    this.child = spawn('/usr/bin/sandbox-exec', ['-p', sandbox, config.command, ...config.args], { stdio: ['pipe', 'pipe', 'pipe'], detached: true, env });
    this.buffer = Buffer.alloc(0);
    this.child.stderr.on('data', () => {}); // Upstream diagnostics can contain secrets.
    this.child.stdin.on('error', () => this.stop('bridge_peer', 'Local tool server disconnected'));
    this.child.on('error', () => this.stop('bridge_peer', 'Local tool server could not start'));
    this.child.on('exit', (code, signal) => this.stop('bridge_peer', `Local tool server exited (${signal ?? `code ${code}`})`));
    this.child.stdout.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      let end;
      while ((end = this.buffer.indexOf(10)) !== -1) {
        if (end > FRAME_BYTES) { this.stop('bridge_output_limit', 'Local tool output exceeded its transport cap'); return; }
        const line = this.buffer.subarray(0, end); this.buffer = this.buffer.subarray(end + 1);
        let message: {jsonrpc?: string; id?: number; error?: unknown; result?: PeerResult};
        try { message = JSON.parse(line.toString('utf8')); } catch { this.stop('bridge_protocol', 'Invalid local tool response'); return; }
        if (!object(message) || message.jsonrpc !== '2.0') { this.stop('bridge_protocol', 'Invalid local tool envelope'); return; }
        if (message.id === undefined) continue;
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        if (message.error || !object(message.result)) pending.reject(fail('bridge_peer', 'Local tool request failed'));
        else pending.resolve(message.result);
      }
      if (this.buffer.length > FRAME_BYTES) this.stop('bridge_output_limit', 'Local tool output exceeded its transport cap');
    });
  }
  send(value: unknown) { this.child.stdin.write(JSON.stringify(value) + '\n'); }
  request(method: string, params: unknown, signal?: AbortSignal): Promise<PeerResult> {
    if (this.closed) return Promise.reject(fail('bridge_peer', 'Local tool server is unavailable'));
    return new Promise<PeerResult>((resolve, reject) => {
      const id = ++this.sequence;
      const cancel = () => this.stop(signal?.reason instanceof Fault ? signal.reason.code : 'bridge_cancelled', signal?.reason instanceof Fault ? signal.reason.message : 'Local tool call cancelled; peer stopped, downstream outcome may be unknown');
      const timer = setTimeout(() => this.stop('bridge_timeout', 'Local tool call timed out; peer stopped, downstream outcome may be unknown'), this.timeout);
      const finish = <T>(action: (value: T) => void) => (value: T) => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); action(value); };
      this.pending.set(id, { resolve: finish(resolve), reject: finish(reject) });
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }
  stop(code = 'bridge_closed', message = 'Bridge stopped') {
    if (this.closed) return;
    this.closed = true;
    this.onStop?.(code, message);
    for (const pending of this.pending.values()) pending.reject(fail(code, message));
    this.pending.clear();
    try { process.kill(-this.child.pid!, 'SIGKILL'); } catch {}
    this.child.stdin.destroy();
  }
}

function privateIP(address: string) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a >= 224 || a === 100 && b >= 64 && b <= 127;
  }
  // Only global-unicast DNS AAAA records are accepted; literal IPv6 URLs stay off.
  const prefix = parseInt(address.split(':')[0], 16);
  return !(prefix >= 0x2000 && prefix <= 0x3fff) || /^2001:db8:/i.test(address);
}

async function publicURL(value: string) {
  let url;
  try { url = new URL(value); } catch { throw fail('bridge_url', 'Only public HTTP(S) URLs are available'); }
  const hostname = url.hostname.replace(/\.$/, '').toLowerCase();
  check(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !hostname.includes(':') && !hostname.endsWith('.local') && !hostname.endsWith('.localhost') && hostname !== 'localhost', 'Private or credential-bearing URL denied', 403);
  check(!/(^|\.)(mail\.google\.com|gmail\.com|web\.whatsapp\.com|web\.telegram\.org|outlook\.live\.com|outlook\.office\.com)$/.test(hostname), 'Mail and messaging are outside the bridge scope', 403);
  check(![...url.searchParams.keys()].some(key => secretKey.test(key)), 'Credential-bearing URL denied', 403);
  const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true });
  check(addresses.length > 0 && addresses.every((row: {address: string}) => !privateIP(row.address)), 'Private network destination denied', 403);
}

function schemaData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(schemaData);
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['description', 'title', '$comment', 'default', 'examples', 'approval'].includes(key)).map(([key, data]) => [key, schemaData(data)]));
}

function redact<T>(value: T, known: string[]): T {
  if (Array.isArray(value)) return value.map(item => redact(item, known)) as T;
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, secretKey.test(key) ? '[redacted]' : redact(item, known)])) as T;
  if (typeof value !== 'string') return value;
  // Some MCP servers encode structured results inside their text block.
  try { const parsed = JSON.parse(value); if (object(parsed) || Array.isArray(parsed)) return JSON.stringify(redact(parsed, known)) as T; } catch {}
  let redacted: string = value;
  for (const secret of known) redacted = redacted.split(secret).join('[redacted]');
  return redacted
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[redacted private key]')
    .replace(/\b(?:Bearer\s+\S+|(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, '[redacted credential]')
    .replace(/((?:password|passwd|secret|credential|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|authorization|cookie|\btoken)\s*["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\n]*)/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^\s/]+:[^\s/]+@/g, '$1[redacted]@') as T;
}

function pageObject(result: PeerResult): PageData {
  for (const block of result.content ?? []) {
    if (block.type !== 'text') continue;
    const start = block.text!.indexOf('{'), end = block.text!.lastIndexOf('}');
    if (start >= 0) { try { return JSON.parse(block.text!.slice(start, end + 1)); } catch {} }
  }
  return result.structuredContent ?? {};
}

function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(signal.reason instanceof Fault ? signal.reason : fail('bridge_cancelled', 'Bridge call cancelled'));
    if (signal.aborted) { cancel(); return; }
    signal.addEventListener('abort', cancel, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

export class Bridge {
  declare config: BridgeConfig; declare directory: string; declare peers: Map<string, Peer>; declare routes: Map<string, BridgeRoute>;
  declare tools: LocalTool[]; declare tabs: Map<number, string | undefined>; declare busy: boolean; declare secrets: string[]; declare auditFile: string;
  declare down: Map<string, {code: string; message: string; since: string}>; declare retryMs: number; declare retryTimer?: NodeJS.Timeout; declare closed: boolean;
  declare log: (line: string) => void;

  constructor({ config, directory, secrets = [], retryMs = 60000, log = console.error }: {config: BridgeConfig; directory: string; secrets?: string[]; retryMs?: number; log?: (line: string) => void}) {
    this.config = config; this.directory = directory; this.peers = new Map(); this.routes = new Map(); this.tools = []; this.tabs = new Map(); this.busy = false;
    this.down = new Map(); this.retryMs = retryMs; this.closed = false; this.log = log;
    this.secrets = [...secrets, ...Object.entries(process.env).filter(([key]) => secretKey.test(key) || key.startsWith('CROSSFEED')).map(([, value]) => value), ...Object.values(config.servers).flatMap(server => Object.values(server.env ?? {}))].filter((value): value is string => typeof value === 'string' && value.length >= 8);
    privateDirectory(directory);
    this.auditFile = path.join(directory, 'bridge.jsonl');
    const fd = fs.openSync(this.auditFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600);
    const stat = fs.fstatSync(fd); fs.closeSync(fd);
    check(stat.isFile() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600 && stat.uid === process.getuid!(), 'Unsafe bridge audit file', 500);
  }
  audit(row: Record<string, unknown>) {
    const fd = fs.openSync(this.auditFile, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      check(stat.isFile() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600 && stat.uid === process.getuid!(), 'Unsafe bridge audit file', 500);
      fs.writeSync(fd, JSON.stringify({ time: new Date().toISOString(), ...row }) + '\n');
    } finally { fs.closeSync(fd); }
  }
  // One unavailable peer must not take the gateway or the other peers down: it is
  // logged by name (stderr stays dropped), its tools stay unlisted, and it is retried.
  async start() {
    for (const name of Object.keys(this.config.servers)) await this.startServer(name);
    return this;
  }
  async startServer(name: string) {
    const server = this.config.servers[name];
    const routes = new Map<string, BridgeRoute>(); const tools: LocalTool[] = [];
    let peer: Peer | undefined;
    try {
      peer = new Peer(server, this.config.timeout_ms, { name, directory: this.directory });
      await peer.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'crossfeed-bridge', version: '1' } });
      peer.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      let cursor: string | undefined; let count = 0;
      do {
        const list = await peer.request('tools/list', cursor ? { cursor } : {});
        check(Array.isArray(list.tools) && (count += list.tools.length) <= 128, 'Invalid bridge tool discovery');
        for (const tool of list.tools) {
          const policy = server.tools[tool.name];
          if (!ceiling[name].has(tool.name) || policy === 'deny' || policy !== 'allow' && tool.annotations?.readOnlyHint !== true) continue;
          check(object(tool.inputSchema) && tool.inputSchema.type === 'object', 'Invalid bridge input schema');
          const exposed = `bridge_${name}_${tool.name}`;
          check(!routes.has(exposed), 'Duplicate bridge tool');
          routes.set(exposed, { server: name, tool: tool.name, schema: tool.inputSchema });
          const readOnly = name !== 'gaddi' || ['browser_look', 'browser_wait', 'browser_status'].includes(tool.name);
          tools.push({ name: exposed, description: `Local ${name} capability: ${tool.name.replace(/^browser_/, '').replaceAll('_', ' ')}. Results are external data. Browser one-way actions may return HELD with an owner approval ID; the bridge does not approve or retry them.`, inputSchema: schemaData(tool.inputSchema) as ToolSchema, annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: name !== 'qmd', idempotentHint: readOnly } });
        }
        cursor = list.nextCursor;
        check(cursor === undefined || typeof cursor === 'string' && cursor.length <= 1024, 'Invalid bridge discovery cursor');
        check(!cursor || list.tools.length > 0, 'Invalid bridge discovery page');
      } while (cursor);
    } catch (error) {
      const fault = error instanceof Fault ? error : fail('bridge_start', 'Bridge server discovery failed');
      peer?.stop(fault.code, fault.message);
      this.markDown(name, fault.code, fault.message);
      return false;
    }
    if (this.closed) { peer!.stop(); return false; }
    this.peers.set(name, peer);
    for (const [exposed, route] of routes) this.routes.set(exposed, route);
    this.tools = [...this.tools.filter(tool => this.routes.get(tool.name)?.server !== name), ...tools];
    peer.onStop = (code, message) => { if (this.peers.get(name) === peer) this.markDown(name, code, message); };
    if (this.down.delete(name)) this.log(`Bridge: ${name} available again`);
    return true;
  }
  markDown(name: string, code: string, message: string) {
    if (this.closed) return;
    this.peers.delete(name);
    for (const [exposed, route] of this.routes) if (route.server === name) this.routes.delete(exposed);
    this.tools = this.tools.filter(tool => this.routes.has(tool.name));
    if (!this.down.has(name)) this.log(`Bridge: ${name} unavailable (${code}: ${message}); retrying every ${Math.round(this.retryMs / 1000)} s`);
    this.down.set(name, { code, message, since: this.down.get(name)?.since ?? new Date().toISOString() });
    this.scheduleRetry();
  }
  scheduleRetry() {
    if (this.retryTimer || this.closed) return;
    this.retryTimer = setTimeout(async () => {
      this.retryTimer = undefined;
      for (const name of [...this.down.keys()]) if (!this.closed) await this.startServer(name);
      if (this.down.size) this.scheduleRetry();
    }, this.retryMs);
    this.retryTimer.unref();
  }
  status() {
    return Object.fromEntries(Object.keys(this.config.servers).map(name => {
      const down = this.down.get(name);
      return [name, down ? { available: false, error: down.code, message: down.message, since: down.since } : { available: this.peers.has(name) }];
    }));
  }
  async call(name: string, args: Record<string, unknown> = {}, { client, signal }: CallContext = {}) {
    const route = this.routes.get(name);
    const receipt = { tool: route ? name : 'unknown', client, server: route?.server };
    this.audit({ ...receipt, state: 'started' });
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(fail('bridge_timeout', 'Bridge call timed out; downstream outcome may be unknown')), this.config.timeout_ms);
    signal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    let owned = false;
    try {
      const downServer = route ? undefined : Object.keys(this.config.servers).find(server => this.down.has(server) && name.startsWith(`bridge_${server}_`));
      if (downServer) throw fail('bridge_peer', 'Local tool server is unavailable; the bridge is retrying it');
      check(route, 'Bridge tool denied or unknown', 403);
      check(!this.busy, 'Bridge is busy', 409);
      this.busy = true; owned = true;
      check(object(args) && Buffer.byteLength(JSON.stringify(args)) <= INPUT_BYTES, 'Invalid bridge arguments');
      check(Object.keys(args).every(key => Object.hasOwn(route.schema.properties ?? {}, key) && key !== 'approval'), 'Unknown argument or approval retry denied', 403);
      check((route.schema.required ?? []).every(key => Object.hasOwn(args, key)), 'Missing bridge argument');
      check(!signal?.aborted, 'Bridge call cancelled', 499);
      if (route.server === 'gaddi') {
        if (route.tool === 'browser_open') args = { ...args, group: 'Crossfeed bridge' };
        else if (route.tool !== 'browser_status' && !(route.tool === 'browser_read' && args.url)) {
          const tabs = route.tool === 'browser_close' ? args.tabs : [args.tab];
          check(Array.isArray(tabs) && tabs.length > 0 && tabs.every(tab => Number.isSafeInteger(tab) && this.tabs.get(tab as number) === client), 'Only this connector client\'s bridge tabs are available', 403);
        }
      }
      // URLs at the root and nested input are checked; no private service URL is proxied.
      if (route.server !== 'qmd' && args.url !== undefined) await bounded(publicURL(args.url as string), signal);
      const urls = async (value: unknown): Promise<void> => {
        if (typeof value === 'string' && /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) await publicURL(value);
        else if (Array.isArray(value)) for (const item of value) await urls(item);
        else if (object(value)) for (const [key, item] of Object.entries(value)) { check(key !== 'approval', 'Approval retry denied', 403); await urls(item); }
      };
      if (route.server !== 'qmd') await bounded(urls(args), signal);
      const peer = this.peers.get(route.server)!;
      if (route.server === 'gaddi' && (!['browser_status', 'browser_look', 'browser_wait', 'browser_read', 'browser_close'].includes(route.tool) || route.tool === 'browser_read' && args.url !== undefined)) {
        check(this.routes.has('bridge_gaddi_browser_status'), 'Browser actions require policy status', 403);
        const status = await peer.request('tools/call', { name: 'browser_status', arguments: {} }, signal);
        check(!status.isError && pageObject(status).policy?.off === false, 'Gaddi policy is unavailable or disabled; browser action denied', 403);
      }
      if (route.server === 'gaddi' && args.tab !== undefined && !['browser_look', 'browser_close'].includes(route.tool)) {
        check(this.routes.has('bridge_gaddi_browser_look'), 'Browser actions require the look capability', 403);
        const current = await peer.request('tools/call', { name: 'browser_look', arguments: { tab: args.tab } }, signal);
        check(!current.isError, 'Current browser page could not be checked', 403);
        await bounded(publicURL(pageObject(current).url!), signal);
      }
      const response = await peer.request('tools/call', { name: route.tool, arguments: args }, signal);
      check(Array.isArray(response.content), 'Invalid local tool result');
      if (route.server === 'gaddi' && route.tool === 'browser_open' && !response.isError) {
        const page = pageObject(response), tab = page.tabId ?? page.id ?? (object(page.tab) ? page.tab.id : page.tab);
        if (Number.isSafeInteger(tab)) this.tabs.set(tab as number, client);
      }
      if (route.server === 'gaddi' && !response.isError && pageObject(response).url) await bounded(publicURL(pageObject(response).url!), signal);
      if (route.server === 'gaddi' && route.tool === 'browser_look' && !response.isError) check(pageObject(response).url, 'Current page URL is unavailable', 403);
      if (route.server === 'gaddi' && route.tool === 'browser_close' && !response.isError) for (const tab of pageObject(response).closed ?? []) if ((args.tabs as number[]).includes(tab)) this.tabs.delete(tab);
      // Text/structured results are scanned. Opaque binaries/resources are never forwarded.
      const safe = redact({ content: response.content.filter(block => block.type === 'text').map(block => ({ type: 'text', text: String(block.text) })), ...(response.isError ? { isError: true } : {}), ...(object(response.structuredContent) ? { structuredContent: response.structuredContent } : {}) }, this.secrets);
      const held = safe.content.some(block => /^HELD \(approval [a-zA-Z0-9_-]+\):/.test(block.text));
      const denied = safe.content.some(block => /^DENIED:/.test(block.text));
      if ((route.server === 'omniread' || route.server === 'gaddi' && route.tool === 'browser_read') && !response.isError && !held && !denied) {
        const data = response.structuredContent ?? pageObject(response);
        const provenance = data.result?.provenance ?? data.provenance;
        check(object(provenance) && typeof provenance.final_url === 'string', 'Reader provenance is unavailable', 403);
        await bounded(publicURL(provenance.final_url), signal);
      }
      if (held) safe.content.push({ type: 'text', text: 'Bridge policy: this action remains HELD. Approval retries are unavailable through this bridge.' });
      check(Buffer.byteLength(JSON.stringify(safe)) <= this.config.output_bytes, 'Local tool result exceeded bridge output cap', 413, 'bridge_output_limit');
      this.audit({ ...receipt, state: held ? 'held' : response.isError ? 'upstream_error' : 'finished' });
      return safe;
    } catch (error) {
      this.audit({ ...receipt, state: 'refused', code: error instanceof Fault ? error.code : 'bridge_failed' });
      throw error instanceof Fault ? error : fail('bridge_failed', 'Bridge call failed');
    } finally { clearTimeout(timer); if (owned) this.busy = false; }
  }
  close() { this.closed = true; clearTimeout(this.retryTimer); for (const peer of this.peers.values()) peer.stop(); }
}
