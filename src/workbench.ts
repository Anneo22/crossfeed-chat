import type { ExecutionResult, CallContext, LocalTool, ToolSchema } from './types.ts';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { defaultWorkbenchRoots, loadBashGuards, guardVerdict } from './workbench-guards.ts';
import { check, Fault, object, privateDirectory } from './security.ts';

// Capture trusted source before any workbench edit can change this repo.
const runnerSource = fs.readFileSync(new URL('./workbench-runner.c', import.meta.url));
const runnerDigest = createHash('sha256').update(runnerSource).digest('hex').slice(0,16);
const FILE_BYTES = 256 * 1024, OUTPUT_BYTES = 64 * 1024, WALK_LIMIT = 20000;
// Apply the same deny policy to file tools, git paths and sandboxed commands.
const forbidden = /^(?:\.git|\.env(?:[._-].*)?|\.npmrc|\.netrc|\.ssh|\.aws|\.gnupg|\.crossfeed-workbench-tmp|(?:.*[._-])?(?:api[_-]?)?(?:keys?|tokens?|passwords?)(?:[._-].*)?|credentials?(?:[._-].*)?|secrets?(?:[._-].*)?|.*\.(?:pem|key|p12|pfx|keystore|keychain(?:-db)?|kdbx)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/i;
const safe = (relative: string) => !relative.split('/').some(part => forbidden.test(part));
const fields = (args: unknown, allowed: string[]) => check(object(args) && Object.keys(args).every(k => allowed.includes(k)), 'Invalid workbench arguments');
const bounded: (value: unknown, max: number, empty?: boolean) => asserts value is string = (value, max, empty = false) => check(typeof value === 'string' && (empty || value.length > 0) && Buffer.byteLength(value) <= max && !value.includes('\0'), 'Invalid workbench text');
const annotations = (read: boolean, destructive = false, network = false) => ({ readOnlyHint: read, destructiveHint: destructive, idempotentHint: read, openWorldHint: network });
const schema = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, properties, required: ['root'] });
const rootProperty = { type: 'string', description: 'Root identifier returned by workbench_roots.' };
const pathProperty = { type: 'string', description: 'Relative path inside the selected root.' };

function executable(name: string) {
  if (path.isAbsolute(name)) return fs.realpathSync(name);
  check(!name.includes('/'), 'Command executable must be absolute or a PATH name');
  for (const directory of (process.env.PATH ?? '/usr/bin:/bin').split(':').filter(path.isAbsolute)) {
    try { const file = fs.realpathSync(path.join(directory, name)); fs.accessSync(file, fs.constants.X_OK); return file; } catch {}
  }
  throw new Fault(400, 'workbench_command', 'Command executable is unavailable');
}
function gitSync(root: string, args: string[]): string {
  const result = spawnSync('/usr/bin/git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, encoding: 'utf8', timeout: 5000, maxBuffer: FILE_BYTES, env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1' } });
  check(result.status === 0, 'Git inspection failed');
  return result.stdout;
}

interface WorkbenchRoot { id: string; path: string; commands: Record<string, string[]>; inode: number; device: number }
interface BackgroundJob { id: string; client: string; state: string; started_at: number; output: string; bytes: number; abort: AbortController; done?: Promise<void>; finished_at?: number; exit_code?: number | null; stopped?: string | null }
interface WorkbenchOptions { roots?: string[]; directory: string; commands?: Record<string, Record<string, string[]>>; shell?: boolean | 'sandboxed' | 'full'; network?: boolean; guardSettings?: string }
interface WorkbenchArgs { root: string; path: string; query: string; job_id: string; cancel?: boolean; before: string; after: string; timeout_seconds?: number; command: string; shell?: string; view?: string; staged?: boolean }
interface ExecuteOptions { env?: Record<string, string | undefined>; signal?: AbortSignal; input?: string; timeout?: number; outputLimit?: number; tail?: boolean; onStart?: () => void; onProgress?: (output: string, bytes: number) => void }
export interface WorkbenchResults {
  workbench_roots: {roots: {root: string; path: string; commands: string[]}[]; shell: boolean | 'sandboxed' | 'full'; network: boolean; guards: number; sandbox: string};
  workbench_list: {files: string[]; truncated: boolean};
  workbench_read: {path: string; text: string};
  workbench_search: {matches: {path: string; line: number; text: string}[]; truncated: boolean};
  workbench_apply_patch: {path: string; edited: boolean};
  workbench_git: {status?: {status: string; path: string; previous?: string}[]; diff?: string; truncated: boolean};
  workbench_run: Omit<ExecutionResult, 'stdout' | 'stderr'>;
  workbench_start: ReturnType<Workbench['jobStatus']>;
  workbench_job: ReturnType<Workbench['jobStatus']>;
}
export class Workbench {
  declare fullShell: boolean; declare guards: ReturnType<typeof loadBashGuards>; declare logPath: string; declare directory: string; declare closed: boolean;
  declare shell: boolean | 'sandboxed' | 'full'; declare network: boolean; declare busy: boolean; declare roots: WorkbenchRoot[]; declare tools: LocalTool[];
  declare jobs: Map<string, BackgroundJob>;

  constructor({ roots, directory, commands = {}, shell = false, network = false, guardSettings }: WorkbenchOptions) {
    check([false, true, 'sandboxed', 'full'].includes(shell), 'Invalid workbench shell mode');
    this.fullShell = shell === 'full';
    roots ??= this.fullShell ? defaultWorkbenchRoots() : undefined;
    this.guards = this.fullShell ? loadBashGuards(guardSettings) : [];
    check(Array.isArray(roots) && roots.length > 0 && roots.length <= 16, 'Supply 1-16 workbench roots');
    check(object(commands), 'Invalid workbench command configuration');
    privateDirectory(directory);
    directory = fs.realpathSync(directory);
    this.logPath = path.join(directory, 'workbench.jsonl');
    this.directory = directory;
    this.jobs = new Map(); this.closed = false;
    this.shell = shell; this.network = this.fullShell || network; this.busy = false;
    this.roots = roots.map((input, index) => {
      const root = fs.realpathSync(input);
      check(fs.statSync(root).isDirectory() && (this.fullShell || gitSync(root, ['rev-parse', '--show-toplevel']).trim() === root), 'Workbench root must be a directory; sandboxed roots must be git worktree top levels');
      check(safe(root) && !roots.slice(0, index).some(other => { const previous = fs.realpathSync(other); return root === previous || root.startsWith(previous + '/') || previous.startsWith(root + '/'); }), 'Workbench roots must be safe and disjoint');
      check(!directory.startsWith(root + '/') && directory !== root, 'State directory must be outside workbench roots');
      let configured = commands[root];
      if (configured === undefined) {
        configured = {};
        try {
          const pkg = JSON.parse(this.readAt(root, 'package.json'));
          for (const name of Object.keys(pkg.scripts ?? {}).filter(name => /^(test|check|lint|typecheck)(?::[a-z0-9_-]+)?$/.test(name))) configured[name] = ['npm', 'run', name];
        } catch (e) { if (e instanceof Fault && e.status === 403) throw e; }
      }
      check(object(configured) && Object.keys(configured).length <= 32, 'Invalid root command allowlist');
      const allowlist: Record<string, string[]> = {};
      for (const [name, argv] of Object.entries(configured)) {
        check(/^[a-zA-Z0-9:_-]{1,64}$/.test(name) && Array.isArray(argv) && argv.length > 0 && argv.length <= 32, 'Invalid allowed command');
        argv.forEach(arg => bounded(arg, 4096, true));
        allowlist[name] = [executable(argv[0]), ...argv.slice(1)];
      }
      const identity = fs.statSync(root);
      return { id: `root${index + 1}`, path: root, commands: allowlist, inode: identity.ino, device: identity.dev };
    });
    check(Object.keys(commands).every(key => this.roots.some(root => root.path === key)), 'Command configuration names an unknown canonical root');
    this.tools = [
      { name: 'workbench_roots', description: 'Lists enabled local working folders, their root identifiers, allowed command names, and command permissions.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: annotations(true) },
      { name: 'workbench_list', description: 'Lists regular files in a local worktree. Symlinks, git internals and credential-shaped paths are excluded. Returns at most 2000 paths.', inputSchema: schema({ root: rootProperty, path: pathProperty }), annotations: annotations(true) },
      { name: 'workbench_read', description: 'Reads a UTF-8 text file in a local worktree, up to 256 KiB. Credential-shaped files, symlinks and hardlinks are refused.', inputSchema: { ...schema({ root: rootProperty, path: pathProperty }), required: ['root', 'path'] }, annotations: annotations(true) },
      { name: 'workbench_search', description: 'Searches text files for a literal string in a local worktree. Returns matching paths, line numbers and bounded excerpts.', inputSchema: { ...schema({ root: rootProperty, path: pathProperty, query: { type: 'string', maxLength: 1024 } }), required: ['root', 'query'] }, annotations: annotations(true) },
      { name: 'workbench_apply_patch', description: 'Applies an exact text edit to one file in a local worktree. The before text must occur exactly once. Empty before creates a new file; existing files are never overwritten by creation. Returns the edited path.', inputSchema: { ...schema({ root: rootProperty, path: pathProperty, before: { type: 'string', maxLength: FILE_BYTES }, after: { type: 'string', maxLength: FILE_BYTES } }), required: ['root', 'path', 'before', 'after'] }, annotations: annotations(false, true) },
      { name: 'workbench_run', description: `Runs a named, fixed-argument command from the root's allowlist. ${this.fullShell ? 'Full shell commands run with host user permissions and network access, after every registered Bash guard allows them. Roots select the starting folder, not a filesystem boundary.' : `Commands use a macOS filesystem sandbox. ${shell ? 'Arbitrary shell input is enabled.' : 'Arbitrary shell input is disabled.'} ${this.network ? 'Network access is enabled.' : 'Network access is denied.'}`} Calls are limited to 20 seconds including guards and 64 KiB of command output; cancellation, timeout or excess output terminates tracked descendants.`, inputSchema: schema({ root: rootProperty, command: { type: 'string' }, ...(shell ? { shell: { type: 'string', maxLength: 8192 } } : {}) }), annotations: annotations(false, true, this.network) },
      ...(this.fullShell ? [
        { name: 'workbench_start', description: 'Starts a long command after all registered Bash guards approve. Returns a job_id immediately after launch; poll workbench_job for output tail and exit status. One background command runs at a time. Default runtime is 300 seconds, maximum 900; output stops execution after 4 MiB. Jobs belong to this OAuth connector, are retained for one hour (at most 32), and stop on service shutdown.', inputSchema: schema({ root: rootProperty, command: { type: 'string' }, shell: { type: 'string', maxLength: 8192 }, timeout_seconds: { type: 'integer', minimum: 1, maximum: 900, default: 300 } }), annotations: annotations(false, true, true) },
        { name: 'workbench_job', description: 'Returns a background command state, last 64 KiB of output, total output bytes, exit code and stop reason. Only the connector that started it can inspect it. Set cancel=true to stop the command and tracked descendants.', inputSchema: { type: 'object', additionalProperties: false, properties: { job_id: { type: 'string' }, cancel: { type: 'boolean' } }, required: ['job_id'] }, annotations: annotations(false, true) }
      ] : []),
      { name: 'workbench_git', description: 'Returns git status or diff for safe regular files in a local worktree. Git internals and credential-shaped paths are excluded. No external diff drivers or text conversion run.', inputSchema: schema({ root: rootProperty, view: { type: 'string', enum: ['status', 'diff'], default: 'status' }, staged: { type: 'boolean', default: false } }), annotations: annotations(true) }
    ];
  }

  resolve(root: string, relative: string, create = false) {
    bounded(relative, 4096);
    check(!path.isAbsolute(relative) && !relative.includes('\\') && !/[\p{C}]/u.test(relative) && relative.split('/').every(part => part && part !== '..' && part !== '.'), 'Use a normal relative path', 403);
    check(safe(relative), 'Credential paths and git internals are refused', 403);
    const target = path.join(root, relative);
    let current = root;
    for (const part of relative.split('/')) {
      current = path.join(current, part);
      let stat;
      try { stat = fs.lstatSync(current); } catch (e) { if (create && (e as NodeJS.ErrnoException).code === 'ENOENT') return target; throw e; }
      check(!stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile() && stat.nlink === 1), 'Symlinks, hardlinks and special files are refused', 403);
      check(fs.realpathSync(current).startsWith(root + '/'), 'Path escapes root', 403);
    }
    return target;
  }
  readAt(root: string, relative: string) {
    const fd = fs.openSync(this.resolve(root, relative), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      check(stat.isFile() && stat.nlink === 1 && stat.size <= FILE_BYTES, 'File must be regular text, at most 256 KiB');
      const bytes = fs.readFileSync(fd);
      check(bytes.length <= FILE_BYTES && !bytes.includes(0), 'File must be text, at most 256 KiB');
      const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return value;
    } finally { fs.closeSync(fd); }
  }
  walk(root: string, relative = '') {
    const base = relative ? this.resolve(root, relative) : root;
    const files: string[] = []; let visited = 0;
    const visit = (directory: string, prefix: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
        check(++visited <= WALK_LIMIT, 'Worktree scan exceeds 20000 entries; select a smaller directory');
        const name = prefix + entry.name;
        if (!safe(name) || entry.isSymbolicLink()) continue;
        if (entry.isDirectory() && !['node_modules', 'dist'].includes(entry.name)) visit(path.join(directory, entry.name), name + '/');
        else if (entry.isFile() && fs.lstatSync(path.join(root, name)).nlink === 1) files.push(name);
      }
    };
    check(fs.statSync(base).isDirectory(), 'List/search path must be a directory');
    visit(base, relative ? relative + '/' : ''); return files;
  }
  audit(row: Record<string, unknown>) {
    const fd = fs.openSync(this.logPath, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    try {
      const stat = fs.fstatSync(fd);
      check(stat.isFile() && stat.nlink === 1 && !(stat.mode & 0o077), 'Unsafe workbench audit log', 500);
      // No raw shell input, guard reasons, file contents, queries, edits or output.
      // Command digests correlate verdicts without persisting potential credentials.
      fs.writeSync(fd, JSON.stringify({ time: new Date().toISOString(), ...row }) + '\n'); fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  }
  call<Name extends keyof WorkbenchResults>(name: Name, value: unknown, context?: CallContext): Promise<WorkbenchResults[Name]>;
  call(name: string, value: unknown, context?: CallContext): Promise<WorkbenchResults[keyof WorkbenchResults]>;
  async call(name: string, value: unknown, { client, signal }: CallContext = {}) {
    const args = value as WorkbenchArgs;
    const operation = this.tools.find(tool => tool.name === name);
    check(operation, 'Unknown workbench tool');
    const call: {tool: string; client: string; root?: string} = { tool: name, client: typeof client === 'string' ? client : 'local' };
    this.audit({ ...call, state: 'started' });
    let owned = false, refused = false;
    try {
      check(!this.closed, 'Workbench is closed', 503);
      check(!this.busy, 'Workbench is busy; retry after the active call', 409);
      this.busy = true; owned = true;
      check(!signal?.aborted, 'Workbench call cancelled', 499);
      fields(args, Object.keys(operation.inputSchema.properties!));
      if (name === 'workbench_job') {
        bounded(args.job_id, 64);
        check(args.cancel === undefined || typeof args.cancel === 'boolean', 'Invalid cancel option');
        this.pruneJobs();
        const job = this.jobs.get(args.job_id);
        check(job && job.client === call.client, 'Unknown background job for this connector', 404);
        if (args.cancel) { job.abort.abort(); await job.done; }
        return this.jobStatus(job);
      }
      check(!['workbench_run', 'workbench_start', 'workbench_apply_patch'].includes(name) || ![...this.jobs.values()].some(job => job.state === 'running'), 'A background command is running; inspect or cancel it first', 409);
      if (name === 'workbench_roots') return { roots: this.roots.map(root => ({ root: root.id, path: root.path, commands: Object.keys(root.commands) })), shell: this.shell, network: this.network, guards: this.guards.length, sandbox: process.platform !== 'darwin' ? 'unavailable; commands refused' : this.fullShell ? 'none; host permissions with Bash guards' : 'macOS Seatbelt' };
      const root = this.roots.find(root => root.id === args.root);
      check(root, 'Unknown workbench root'); call.root = root.id;
      const identity = fs.lstatSync(root.path);
      check(fs.realpathSync(root.path) === root.path && !identity.isSymbolicLink() && identity.ino === root.inode && identity.dev === root.device, 'Workbench root changed', 403);
      check(args.path === undefined || typeof args.path === 'string', 'Invalid workbench path');
      if (name === 'workbench_list') {
        const all = this.walk(root.path, args.path), files = []; let bytes = 0;
        for (const file of all) { bytes += Buffer.byteLength(JSON.stringify(file)) + 1; if (files.length === 2000 || bytes > OUTPUT_BYTES) break; files.push(file); }
        return { files, truncated: files.length < all.length };
      }
      if (name === 'workbench_read') return { path: args.path, text: this.readAt(root.path, args.path) };
      if (name === 'workbench_search') {
        bounded(args.query, 1024); const matches = []; let bytes = 0;
        for (const file of this.walk(root.path, args.path)) {
          let text; try { text = this.readAt(root.path, file); } catch (e) { if (e instanceof Fault && e.status === 403) throw e; continue; }
          for (const [index, line] of text.split('\n').entries()) if (line.includes(args.query)) {
            const match = { path: file, line: index + 1, text: line.slice(0, 1000) }; bytes += Buffer.byteLength(JSON.stringify(match));
            if (matches.length >= 200 || bytes > OUTPUT_BYTES) return { matches, truncated: true };
            matches.push(match);
          }
        }
        return { matches, truncated: false };
      }
      if (name === 'workbench_apply_patch') {
        bounded(args.before, FILE_BYTES, true); bounded(args.after, FILE_BYTES, true);
        const target = this.resolve(root.path, args.path, !args.before);
        if (!args.before) {
          const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
          try { fs.writeFileSync(fd, args.after); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        } else {
          const old = this.readAt(root.path, args.path), index = old.indexOf(args.before);
          check(index >= 0 && old.indexOf(args.before, index + 1) < 0, 'Before text must occur exactly once; no edit applied', 409);
          const next = old.slice(0,index) + args.after + old.slice(index + args.before.length);
          check(Buffer.byteLength(next) <= FILE_BYTES, 'Edited file exceeds 256 KiB');
          const fd = fs.openSync(this.resolve(root.path, args.path), fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
          try { check(fs.fstatSync(fd).nlink === 1, 'Hardlink refused', 403); fs.ftruncateSync(fd); fs.writeFileSync(fd, next); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        }
        return { path: args.path, edited: true };
      }
      if (name === 'workbench_start') {
        check(args.timeout_seconds === undefined || Number.isInteger(args.timeout_seconds) && args.timeout_seconds >= 1 && args.timeout_seconds <= 900, 'Job timeout must be 1-900 seconds');
        return await this.run(root, args, signal, call.client);
      }
      if (name === 'workbench_run') return await this.run(root, args, signal);
      check(args.view === undefined || ['status', 'diff'].includes(args.view), 'Invalid git view');
      check(args.staged === undefined || typeof args.staged === 'boolean', 'Invalid staged option');
      const records = gitSync(root.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).split('\0');
      const status = []; const paths = [];
      for (let index = 0; index < records.length; index++) {
        const record = records[index]; if (!record) continue;
        const relative = record.slice(3), previous = /[RC]/.test(record.slice(0,2)) ? records[++index] : undefined;
        if (!safe(relative) || previous && !safe(previous)) continue;
        try { this.resolve(root.path, relative, true); if (previous) this.resolve(root.path, previous, true); } catch { continue; }
        status.push({ status: record.slice(0,2), path: relative, ...(previous ? { previous } : {}) }); paths.push(relative); if (previous) paths.push(previous);
      }
      if (args.view !== 'diff') {
        let bytes = 0, end = 0;
        for (const row of status) { bytes += Buffer.byteLength(JSON.stringify(row)); if (bytes > OUTPUT_BYTES) break; end++; }
        return { status: status.slice(0,end), truncated: end < status.length };
      }
      // Path-by-path keeps argument size bounded and excludes secrets even from staged diffs.
      let diff = '', truncated = false;
      for (const relative of [...new Set(paths)]) {
        const part = gitSync(root.path, ['diff', '--no-ext-diff', '--no-textconv', ...(args.staged ? ['--cached'] : []), '--', relative]);
        if (Buffer.byteLength(diff + part) > OUTPUT_BYTES) { truncated = true; break; } diff += part;
      }
      return { diff, truncated };
    } catch (error) {
      refused = true;
      this.audit({ ...call, state: 'refused', code: error instanceof Fault ? error.code : 'workbench_failed' });
      throw error instanceof Fault ? error : new Fault(400, 'workbench_failed', 'Workbench operation failed; check path, file format and permissions');
    } finally { if (owned) { this.busy = false; if (!refused) this.audit({ ...call, state: 'finished' }); } }
  }

  runner(timeout = 15000) {
    const destination = path.join(this.directory, `workbench-runner-${runnerDigest}`);
    if (!fs.existsSync(destination)) {
      const result = spawnSync('/usr/bin/cc', ['-Wall','-Wextra','-Werror','-O2','-x','c','-','-o',destination], { input: runnerSource, timeout, maxBuffer: OUTPUT_BYTES, env: { PATH: '/usr/bin:/bin' } });
      check(result.status === 0, 'Command supervisor unavailable; install macOS Command Line Tools', 503);
      fs.chmodSync(destination,0o700);
    }
    const stat = fs.lstatSync(destination);
    check(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && !(stat.mode & 0o077) && stat.uid === process.getuid!(), 'Unsafe command supervisor', 503);
    return destination;
  }

  async run(root: WorkbenchRoot, args: WorkbenchArgs, signal?: AbortSignal, backgroundClient?: string) {
    check(process.platform === 'darwin' && (this.fullShell || fs.existsSync('/usr/bin/sandbox-exec')), 'Workbench commands require the macOS supervisor and sandbox support; on Linux use file and Git tools, and run commands in your own terminal', 503);
    check((typeof args.command === 'string') !== (typeof args.shell === 'string'), 'Supply exactly one command name or enabled shell command');
    let argv: string[];
    if (args.shell !== undefined) { check(this.shell, 'Arbitrary shell is disabled', 403); bounded(args.shell,8192); argv = ['/bin/sh', '-c', args.shell]; }
    else { check(Object.hasOwn(root.commands, args.command), 'Command is not allowlisted', 403); argv = root.commands[args.command]; }
    if (this.fullShell) return await this.runFull(root, args, argv, signal, backgroundClient);
    // Refuse pre-existing hardlinks anywhere executable code may access, including dependencies.
    let visited = 0;
    const links = (directory: string): void => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (forbidden.test(entry.name) && entry.name !== '.crossfeed-workbench-tmp' || entry.isSymbolicLink()) continue;
      check(++visited <= 100000, 'Command safety scan exceeds 100000 entries');
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) links(target);
      else if (entry.isFile()) check(fs.lstatSync(target).nlink === 1, 'Command root contains a hardlink', 403);
    } };
    links(root.path);
    const temporary = path.join(root.path, '.crossfeed-workbench-tmp');
    try { fs.mkdirSync(temporary, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = fs.lstatSync(temporary);
    check(stat.isDirectory() && !stat.isSymbolicLink() && !(stat.mode & 0o077) && fs.realpathSync(temporary) === temporary, 'Unsafe command temporary directory', 403);
    const quote = (value: string) => JSON.stringify(value);
    const denyPattern = '(^|/)([.]git|[.]env([._-][^/]*)?|[.]npmrc|[.]netrc|[.]ssh|[.]aws|[.]gnupg|([^/]*[._-])?(api[_-]?)?(keys?|tokens?|passwords?)([._-][^/]*)?|credentials?([._-][^/]*)?|secrets?([._-][^/]*)?|[^/]*[.](pem|key|p12|pfx|keystore|keychain(-db)?|kdbx)|id_(rsa|dsa|ecdsa|ed25519)([.][^/]*)?)(/|$)';
    // Seatbelt regex does not implement JS's case-insensitive modifier.
    let inClass = false;
    const casePattern = [...denyPattern].map(char => {
      if (char === '[') inClass = true;
      if (char === ']') { inClass = false; return char; }
      return !inClass && /[a-z]/.test(char) ? `[${char}${char.toUpperCase()}]` : char;
    }).join('');
    const profile = `(version 1)(deny default)
(allow process-fork)(allow process-exec)(allow signal (target self))(allow sysctl-read)(allow file-read-metadata)
(allow file-read* (literal "/") ${['/System','/usr','/bin','/sbin','/Library/Apple','/Library/Developer','/Library/Frameworks','/private/var/db/dyld','/opt/homebrew/Cellar','/opt/homebrew/opt','/opt/homebrew/lib',path.dirname(path.dirname(fs.realpathSync(process.execPath))),root.path].map(p=>`(subpath ${quote(p)})`).join(' ')} (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))
(allow file-write* (subpath ${quote(root.path)}) (literal "/dev/null"))
(deny file-read* file-write* (regex ${quote(casePattern)}))
${this.network ? '(allow network*)' : '(deny network*)'}`;
    const { stdout, stderr, ...result } = await this.execute(root.path, ['/usr/bin/sandbox-exec', '-p', profile, ...argv], { env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin', HOME: temporary, TMPDIR: temporary, npm_config_cache: temporary, npm_config_userconfig: '/dev/null', npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false', NO_COLOR: '1', CI: '1', OPENSSL_CONF: '/dev/null' }, signal });
    return result;
  }

  async runFull(root: WorkbenchRoot, args: WorkbenchArgs, argv: string[], signal?: AbortSignal, backgroundClient?: string) {
    const command = args.shell ?? argv.map(arg => "'" + arg.replaceAll("'", "'\\''") + "'").join(' ');
    const commandId = randomUUID(), digest = createHash('sha256').update(command).digest('hex');
    const record = { tool: backgroundClient === undefined ? 'workbench_run' : 'workbench_start', root: root.id, command_id: commandId, command_sha256: digest, kind: args.shell === undefined ? 'named' : 'shell' };
    const deadline = Date.now() + 20000;
    this.audit({ ...record, state: 'command_started' });
    // Preserve the owner's terminal environment, without handing gateway credentials
    // to child processes. This is not a secret isolation boundary in full mode.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CROSSFEED_')));
    env.CLAUDE_PROJECT_DIR = root.path;
    const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: root.path, hook_event_name: 'PreToolUse', session_id: `crossfeed-${commandId}`, permission_mode: 'default' });
    try {
      for (const [index, hook] of this.guards.entries()) {
        check(!signal?.aborted && Date.now() < deadline, 'Guard execution cancelled or timed out', 403, 'workbench_guard');
        let result;
        try {
          result = await this.execute(root.path, ['/bin/sh', '-c', hook.command], { env, signal, input: payload, timeout: Math.min(hook.timeout, deadline - Date.now()) });
        } catch (error) {
          this.audit({ ...record, state: 'guard_verdict', guard: index + 1, allowed: false, code: error instanceof Fault ? error.code : 'workbench_failed' });
          throw error;
        }
        const verdict = guardVerdict(result);
        this.audit({ ...record, state: 'guard_verdict', guard: index + 1, allowed: verdict.allowed, exit_code: result.exit_code, stopped: result.stopped });
        check(verdict.allowed, `Bash guard ${index + 1}: ${verdict.reason}`, 403, 'workbench_guard');
      }
      check(!signal?.aborted && Date.now() < deadline, 'Guard execution cancelled or timed out', 403, 'workbench_guard');
      this.audit({ ...record, state: 'command_allowed' });
      check(!signal?.aborted && Date.now() < deadline, 'Command execution cancelled or timed out', 403, 'workbench_guard');
      if (backgroundClient !== undefined) return await this.startJob(root, command, env, args.timeout_seconds ?? 300, backgroundClient, record);
      // Execute the exact command string inspected by every hook, including named commands.
      const { stdout, stderr, ...result } = await this.execute(root.path, ['/bin/bash', '-c', command], { env, signal, timeout: deadline - Date.now() });
      this.audit({ ...record, state: 'command_finished', exit_code: result.exit_code, stopped: result.stopped });
      return result;
    } catch (error) {
      this.audit({ ...record, state: 'command_refused', code: error instanceof Fault ? error.code : 'workbench_failed' });
      throw error;
    }
  }

  pruneJobs() {
    for (const [id, job] of this.jobs) if (job.finished_at && job.finished_at < Date.now() - 3600000) this.jobs.delete(id);
  }
  jobStatus(job: BackgroundJob) {
    return { job_id: job.id, state: job.state, started_at: job.started_at, finished_at: job.finished_at ?? null, output: job.output, output_bytes: job.bytes, truncated: job.bytes > OUTPUT_BYTES, exit_code: job.exit_code ?? null, stopped: job.stopped ?? null };
  }
  async startJob(root: WorkbenchRoot, command: string, env: Record<string, string | undefined>, seconds: number, client: string, record: Record<string, unknown>) {
    this.pruneJobs();
    if (this.jobs.size >= 32) {
      const completed = [...this.jobs.values()].find(job => job.state !== 'running');
      check(completed, 'Background job capacity reached', 409);
      this.jobs.delete(completed.id);
    }
    const job: BackgroundJob = { id: randomUUID(), client, state: 'running', started_at: Date.now(), output: '', bytes: 0, abort: new AbortController() };
    let started!: () => void; let failed!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => { started = resolve; failed = reject; });
    this.jobs.set(job.id, job);
    job.done = this.execute(root.path, ['/bin/bash', '-c', command], { env, signal: job.abort.signal, timeout: seconds * 1000, outputLimit: 4 * 1024 * 1024, tail: true, onStart: started, onProgress: (output, bytes) => { job.output = output; job.bytes = bytes; } }).then(result => {
      Object.assign(job, { state: 'finished', finished_at: Date.now(), output: result.output, exit_code: result.exit_code, stopped: result.stopped });
      this.audit({ ...record, job_id: job.id, state: 'command_finished', exit_code: result.exit_code, stopped: result.stopped });
    }).catch(error => {
      Object.assign(job, { state: 'failed', finished_at: Date.now(), stopped: error instanceof Fault ? error.code : 'workbench_failed' });
      failed(error);
    });
    await ready;
    return this.jobStatus(job);
  }
  revokeClient(client: string) { for (const job of this.jobs.values()) if (job.client === client) job.abort.abort(); }
  async close() { this.closed = true; for (const job of this.jobs.values()) job.abort.abort(); await Promise.all([...this.jobs.values()].map(job => job.done)); }

  execute(cwd: string, argv: string[], { env, signal, input, timeout = 20000, outputLimit = OUTPUT_BYTES, tail = false, onStart, onProgress }: ExecuteOptions = {}): Promise<ExecutionResult> {
    return new Promise<ExecutionResult>((resolve, reject) => {
      const deadline = Date.now() + timeout;
      check(!signal?.aborted && Date.now() < deadline, 'Command execution cancelled or timed out', 403, 'workbench_guard');
      const runner = this.runner(Math.max(1, Math.min(15000, deadline - Date.now())));
      check(!signal?.aborted && Date.now() < deadline, 'Command execution cancelled or timed out', 403, 'workbench_guard');
      const child = spawn(runner, argv, { cwd, detached: true, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], env });
      child.once('spawn', () => onStart?.());
      if (input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input); }
      let stdout = '', stderr = '';
      let output = '', bytes = 0; let stopped: string | undefined;
      const stop = (reason: string) => { if (!stopped) stopped = reason; try { child.kill('SIGTERM'); } catch {} };
      const capture = (chunk: Buffer, stream: string) => {
        const remaining = outputLimit - bytes; bytes += chunk.length;
        if (remaining > 0) {
          const text = chunk.subarray(0, remaining).toString('utf8');
          output += text;
          if (tail) {
            if (Buffer.byteLength(output) > OUTPUT_BYTES) output = Buffer.from(output).subarray(-OUTPUT_BYTES + 3).toString('utf8');
          } else if (stream === 'stdout') stdout += text; else stderr += text;
        }
        onProgress?.(output, bytes);
        if (bytes > outputLimit) stop('output_limit');
      };
      child.stdout.on('data',(chunk: Buffer) => capture(chunk, 'stdout')); child.stderr.on('data',(chunk: Buffer) => capture(chunk, 'stderr'));
      const timer = setTimeout(()=>stop('timeout'),Math.max(1, deadline - Date.now()));
      const cancel = () => stop('cancelled'); signal?.addEventListener('abort',cancel,{once:true}); if (signal?.aborted) cancel();
      child.once('error', () => { clearTimeout(timer); signal?.removeEventListener('abort',cancel); reject(new Fault(503,'workbench_spawn','Command could not start')); });
      child.once('close', (code: number | null, termination: string | null) => {
        clearTimeout(timer); signal?.removeEventListener('abort',cancel);
        // Kill surviving descendants even when their parent exited successfully.
        try { process.kill(-child.pid!,'SIGKILL'); } catch {}
        // Replacement characters from non-UTF8 output also count toward the cap.
        if (Buffer.byteLength(output) > OUTPUT_BYTES) output = Buffer.from(output).subarray(0,OUTPUT_BYTES - 3).toString('utf8');
        resolve({ stdout, stderr, exit_code: code, signal: termination ?? (stopped ? 'SIGKILL' : null), output, stopped: stopped ?? null, truncated: bytes > OUTPUT_BYTES });
      });
    });
  }
}
