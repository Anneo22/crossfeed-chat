import { tempPrefix } from './temp.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { Workbench } from '../src/workbench.ts';
import { Fault } from '../src/security.ts';
import { defaultWorkbenchRoots, loadBashGuards } from '../src/workbench-guards.ts';

function fixture(t: import('node:test').TestContext, scripts: string[] = [], options: Record<string, any> = {}) {
  const base = fs.mkdtempSync(tempPrefix('crossfeed-guards-'));
  const root = path.join(base, 'folder'), directory = path.join(base, 'state'), settings = path.join(base, 'settings.json');
  fs.mkdirSync(root); fs.mkdirSync(directory, { mode: 0o700 });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const hooks = (scripts.length ? scripts : ['process.exit(0)']).map((script, index) => {
    const file = path.join(base, `hook-${index}.js`);
    fs.writeFileSync(file, `#!${process.execPath}\n${script}\n`, { mode: 0o700 });
    return { type: 'command', command: `'${file}'`, ...(options.timeout ? { timeout: options.timeout } : {}) };
  });
  const save = (groups: any) => fs.writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: groups } }));
  save([{ matcher: '^Bash$', hooks }]);
  const make = (extra: Record<string, any> = {}) => new Workbench({ roots: [root], directory, shell: 'full', guardSettings: settings, ...extra });
  return { base, root, directory, settings, hooks, save, make };
}
const mac = { skip: process.platform !== 'darwin' };
const run = (bench: any, shell: string, context: any = undefined) => bench.call('workbench_run', { root: 'root1', shell }, context);
const marker = "printf 'ran' > executed.txt";

test('full shell loads every matching synchronous Bash registration, including wildcard matchers', t => {
  const f = fixture(t);
  f.save([{ matcher: 'Write', hooks: [{ type: 'prompt' }] }, { matcher: 'Bash|Read', hooks: f.hooks }, { matcher: '*', hooks: f.hooks }, { hooks: f.hooks }]);
  assert.equal(loadBashGuards(f.settings).length, 3);
  assert.deepEqual(defaultWorkbenchRoots(), [path.join(homedir(), 'Second Brain', '2_Code'), path.join(homedir(), 'ws')]);
  const bench = f.make();
  assert.equal(bench.network, true);
  assert.equal(bench.roots[0].path, f.root);
  assert.match(bench.tools.find((tool: any) => tool.name === 'workbench_run')!.description!, /host user permissions/);
});

test('full shell refuses missing, disabled, empty, malformed or unsupported guard configurations at startup', t => {
  const f = fixture(t);
  assert.throws(() => f.make({ shell: 'anything' }), /shell mode/);
  assert.throws(() => f.make({ guardSettings: path.join(f.base, 'missing') }), /requires readable/);
  for (const settings of [null, {}, { disableAllHooks: true, hooks: { PreToolUse: [{ hooks: f.hooks }] } },
    { hooks: { PreToolUse: [] } }, { hooks: { PreToolUse: [{ matcher: '[', hooks: f.hooks }] } },
    ...[{ type: 'prompt' }, { ...f.hooks[0], async: true }, { ...f.hooks[0], timeout: 0 }, { ...f.hooks[0], if: 'Bash(rm *)' }].map(hook => ({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [hook] }] } })),
    { hooks: { PreToolUse: [{ matcher: 'Bash', if: 'Bash(rm *)', hooks: f.hooks }] } }]) {
    fs.writeFileSync(f.settings, JSON.stringify(settings));
    assert.throws(() => f.make(), /requires readable/);
  }
  fs.writeFileSync(f.settings, '{');
  assert.throws(() => f.make(), /requires readable/);
});

test('real allowing hooks receive exact Bash command and cwd before full execution; audit retains digests and verdicts', mac, async t => {
  const f = fixture(t, ["const fs=require('node:fs'); const p=JSON.parse(fs.readFileSync(0,'utf8')); if(p.tool_name!=='Bash'||p.hook_event_name!=='PreToolUse'||p.cwd!==process.cwd()||p.tool_input.command!==\"printf 'ran' > executed.txt\") process.exit(2); fs.writeFileSync('hook-seen.txt','yes');", "const fs=require('node:fs'); if(!fs.existsSync('hook-seen.txt')||fs.existsSync('executed.txt')) process.exit(2); console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow'}}));"]);
  const bench = f.make();
  // Registrations are captured at startup rather than supplied by the chat.
  fs.writeFileSync(f.settings, '{}');
  const result = await run(bench, marker);
  assert.equal(result.exit_code, 0, result.output);
  assert.equal(fs.readFileSync(path.join(f.root, 'executed.txt'), 'utf8'), 'ran');
  const audit = fs.readFileSync(path.join(f.directory, 'workbench.jsonl'), 'utf8');
  const rows = audit.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.filter((row: any) => row.state === 'guard_verdict' && row.allowed).length, 2);
  assert(rows.some((row: any) => row.state === 'command_finished' && row.exit_code === 0));
  assert(rows.some((row: any) => row.command_sha256 === createHash('sha256').update(marker).digest('hex')));
  assert(!audit.includes(marker));
});

test('real blocking hook returns stderr reason and prevents command execution', mac, async t => {
  const f = fixture(t, ["process.stderr.write('fixture policy refuses this command'); process.exit(2);"]);
  await assert.rejects(run(f.make(), marker), /fixture policy refuses this command/);
  assert.equal(fs.existsSync(path.join(f.root, 'executed.txt')), false);
  const rows = fs.readFileSync(path.join(f.directory, 'workbench.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert(rows.some((row: any) => row.state === 'guard_verdict' && row.allowed === false && row.exit_code === 2));
  assert(rows.some((row: any) => row.state === 'command_refused'));
  assert(!rows.some((row: any) => row.state === 'command_allowed'));
});

test('deny, ask, defer, legacy block, stop and invalid JSON decisions all fail closed', mac, async t => {
  for (const output of [
    ...['deny', 'ask', 'defer', 'unexpected'].map(permissionDecision => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason: 'fixture JSON refusal' } })),
    { decision: 'block', reason: 'fixture legacy refusal' }, { continue: false, stopReason: 'fixture stop refusal' },
    { hookSpecificOutput: { permissionDecision: 'allow', updatedInput: { command: 'echo different' } } }, [], '{invalid',
    'warning\n{"hookSpecificOutput":{"permissionDecision":"deny"}}', 'true', 'null', '123'
  ]) {
    const stdout = typeof output === 'string' ? output : JSON.stringify(output);
    const f = fixture(t, [`console.log(${JSON.stringify(stdout)});`]);
    await assert.rejects(run(f.make(), marker), /Bash guard 1:/);
    assert.equal(fs.existsSync(path.join(f.root, 'executed.txt')), false);
  }
});

test('guard crash, missing executable, timeout and excess output block execution', mac, async t => {
  for (const script of ["process.exit(1);", "process.kill(process.pid,'SIGKILL');", "setInterval(()=>{},1000);", "process.stdout.write('x'.repeat(100000));"]) {
    const f = fixture(t, [script], { timeout: 0.5 });
    await assert.rejects(run(f.make(), marker), /Bash guard 1:/);
    assert.equal(fs.existsSync(path.join(f.root, 'executed.txt')), false);
  }
  const f = fixture(t); f.save([{ matcher: 'Bash', hooks: [{ type: 'command', command: '/missing/crossfeed-hook' }] }]);
  await assert.rejects(run(f.make(), marker), /Bash guard 1:/);
});

test('cancellation during a guard prevents command and releases the workbench', mac, async t => {
  const f = fixture(t, ['setInterval(()=>{},1000);']);
  const abort = new AbortController(), bench = f.make();
  const pending = run(bench, marker, { signal: abort.signal });
  setTimeout(() => abort.abort(), 100);
  await assert.rejects(pending, /cancelled/);
  assert.equal(fs.existsSync(path.join(f.root, 'executed.txt')), false);
  assert.equal(bench.busy, false);
});

test('cancellation or deadline exhaustion during final audit cannot start the command', mac, async t => {
  for (const mode of ['cancel', 'deadline']) {
    const f = fixture(t), bench = f.make(), abort = new AbortController();
    const audit = bench.audit.bind(bench), now = Date.now; let offset = 0;
    t.mock.method(Date, 'now', () => now() + offset);
    bench.audit = row => {
      audit(row);
      if (row.state === 'command_allowed') { if (mode === 'cancel') abort.abort(); else offset = 21000; }
    };
    await assert.rejects(run(bench, marker, { signal: abort.signal }), /cancelled or timed out/);
    assert.equal(fs.existsSync(path.join(f.root, 'executed.txt')), false);
    t.mock.restoreAll();
  }
});

test('supervisor preparation consumes the deadline and checks cancellation before spawning', mac, async t => {
  for (const mode of ['cancel', 'deadline']) {
    const f = fixture(t), bench = f.make(), abort = new AbortController();
    const runner = bench.runner(), now = Date.now; let offset = 0;
    t.mock.method(Date, 'now', () => now() + offset);
    bench.runner = () => { if (mode === 'cancel') abort.abort(); else offset = 21000; return runner; };
    await assert.rejects(bench.execute(f.root, ['/bin/sh', '-c', marker], { signal: abort.signal }), /cancelled or timed out/);
    assert.equal(fs.existsSync(path.join(f.root, 'executed.txt')), false);
    t.mock.restoreAll();
  }
});

test('audit failure and supervisor startup failure prevent execution and preserve refusal evidence', mac, async t => {
  const f = fixture(t), bench = f.make(), audit = bench.audit.bind(bench);
  bench.audit = row => { if (row.state === 'guard_verdict') throw new Fault(500, 'audit_unavailable', 'Audit unavailable'); audit(row); };
  await assert.rejects(run(bench, marker), /Audit unavailable/);
  assert.equal(fs.existsSync(path.join(f.root, 'executed.txt')), false);
  bench.audit = audit;
  bench.runner = () => { throw new Fault(503, 'supervisor_unavailable', 'Supervisor unavailable'); };
  await assert.rejects(run(bench, marker), /Supervisor unavailable/);
  const rows = fs.readFileSync(path.join(f.directory, 'workbench.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert(rows.some((row: any) => row.state === 'guard_verdict' && row.allowed === false && row.code === 'supervisor_unavailable'));
  assert.equal(fs.existsSync(path.join(f.root, 'executed.txt')), false);
});

test('named commands pass guards too and execute the inspected quoted arguments exactly', mac, async t => {
  const f = fixture(t, ["const fs=require('node:fs'); const p=JSON.parse(fs.readFileSync(0,'utf8')); if(!p.tool_input.command.includes('named-marker')) {process.stderr.write('missing named command'); process.exit(2);} fs.writeFileSync('inspected.txt',p.tool_input.command);"]);
  const bench = f.make({ commands: { [f.root]: { named: ['/usr/bin/printf', '%s', "named-marker ' $HOME `echo injected`\n"] } } });
  const result = await bench.call('workbench_run', { root: 'root1', command: 'named' });
  assert.equal(result.exit_code, 0, result.output);
  assert.equal(result.output, "named-marker ' $HOME `echo injected`\n");
  const blocking = fixture(t, ["process.stderr.write('named denied');process.exit(2);"]);
  await assert.rejects(blocking.make({ commands: { [blocking.root]: { named: ['/usr/bin/printf', 'no'] } } }).call('workbench_run', { root: 'root1', command: 'named' }), /named denied/);
});

test('full shell has network and outside-folder access while file tools still refuse credentials and git internals', mac, async t => {
  const f = fixture(t), bench = f.make();
  const server = createServer((req: any, res: any) => res.end('fixture-network-ok'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await run(bench, `'${process.execPath}' -e 'fetch("http://127.0.0.1:${server.address().port}").then(r=>r.text()).then(console.log)'`);
  assert.equal(result.exit_code, 0, result.output); assert.match(result.output, /fixture-network-ok/);
  assert.equal((await run(bench, `printf outside > '${f.base}/outside.txt'`)).exit_code, 0);
  assert.equal(fs.readFileSync(path.join(f.base, 'outside.txt'), 'utf8'), 'outside');
  fs.mkdirSync(path.join(f.root, '.git'));
  for (const filename of ['.env', 'credentials.json', '.git/config']) {
    fs.writeFileSync(path.join(f.root, filename), 'synthetic-private-fixture');
    await assert.rejects(bench.call('workbench_read', { root: 'root1', path: filename }), /refused/);
    await assert.rejects(bench.call('workbench_apply_patch', { root: 'root1', path: filename, before: '', after: 'no' }), /refused/);
  }
});

test('full command output remains bounded and tracked detached descendants are stopped', mac, async t => {
  const f = fixture(t), bench = f.make();
  const flood = await run(bench, `'${process.execPath}' -e 'setInterval(()=>console.log("x".repeat(10000)),1)'`);
  assert.equal(flood.stopped, 'output_limit'); assert(flood.truncated); assert(Buffer.byteLength(flood.output) <= 65536);
  fs.writeFileSync(path.join(f.root, 'detach.c'), '#include <unistd.h>\n#include <fcntl.h>\nint main(void){if(fork())return 0;if(fork())_exit(0);setsid();usleep(500000);int fd=open("late.txt",O_CREAT|O_WRONLY,0600);if(fd>=0)write(fd,"ran",3);return 0;}\n');
  assert.equal((await run(bench, '/usr/bin/cc detach.c -o detach && ./detach')).exit_code, 0);
  await new Promise(resolve => setTimeout(resolve, 750));
  assert.equal(fs.existsSync(path.join(f.root, 'late.txt')), false);
});

test('background commands survive request cancellation, exceed 20 seconds and retain exit status', { ...mac, timeout: 30000 }, async t => {
  const f = fixture(t), bench = f.make(), request = new AbortController();
  t.after(() => bench.close());
  const started = await bench.call('workbench_start', {root:'root1', shell:'printf started; sleep 21; printf finished; exit 7'}, {client:'owner', signal:request.signal});
  assert.ok('job_id' in started); assert.equal(started.state,'running'); request.abort();
  await assert.rejects(bench.call('workbench_job',{job_id:started.job_id},{client:'worker'}),/Unknown background job/);
  await assert.rejects(run(bench,'printf competing'),/background command is running/);
  await bench.jobs.get(started.job_id)!.done;
  const finished = await bench.call('workbench_job',{job_id:started.job_id},{client:'owner'});
  assert.equal(finished.state,'finished'); assert.equal(finished.exit_code,7); assert.equal(finished.stopped,null);
  assert.equal(finished.output,'startedfinished'); assert(finished.finished_at! - finished.started_at >= 20000);
});

test('background start runs all guards before launch and refuses invalid runtime limits', mac, async t => {
  const f = fixture(t,["process.stderr.write('background denied');process.exit(2)"]), bench=f.make();
  t.after(() => bench.close());
  await assert.rejects(bench.call('workbench_start',{root:'root1',shell:marker}),/background denied/);
  assert.equal(bench.jobs.size,0); assert.equal(fs.existsSync(path.join(f.root,'executed.txt')),false);
  for(const timeout_seconds of [0,901,1.5,'3']) await assert.rejects(bench.call('workbench_start',{root:'root1',shell:marker,timeout_seconds}),/1-900/);
});

test('background output tails are bounded and timeout, cancellation, revocation and shutdown stop commands', mac, async t => {
  const f=fixture(t), bench=f.make(); t.after(() => bench.close());
  const start = (shell: string,extra: Record<string, any> = {}) => bench.call('workbench_start',{root:'root1',shell,...extra},{client:'owner'}) as Promise<ReturnType<Workbench['jobStatus']>>;
  const flood=await start(`'${process.execPath}' -e 'console.log("x".repeat(100000)); console.log("tail-marker")'`);
  await bench.jobs.get(flood.job_id)!.done;
  const tail=await bench.call('workbench_job',{job_id:flood.job_id},{client:'owner'});
  assert.equal(tail.exit_code,0); assert.match(tail.output,/tail-marker/); assert(tail.truncated); assert(Buffer.byteLength(tail.output)<=65536); assert(tail.output_bytes>100000);
  const exceeded=await start(`'${process.execPath}' -e 'setInterval(()=>console.log("x".repeat(10000)),1)'`);
  await bench.jobs.get(exceeded.job_id)!.done;
  assert.equal(bench.jobs.get(exceeded.job_id)!.stopped,'output_limit');
  const timeout=await start('sleep 60',{timeout_seconds:1}); await bench.jobs.get(timeout.job_id)!.done;
  assert.equal(bench.jobs.get(timeout.job_id)!.stopped,'timeout');
  const cancel=await start('sleep 60');
  assert.equal((await bench.call('workbench_job',{job_id:cancel.job_id,cancel:true},{client:'owner'})).stopped,'cancelled');
  const revoke=await start('sleep 60'); bench.revokeClient('owner'); await bench.jobs.get(revoke.job_id)!.done;
  assert.equal(bench.jobs.get(revoke.job_id)!.stopped,'cancelled');
  const shutdown=await start('sleep 60'); await bench.close();
  assert.equal(bench.jobs.get(shutdown.job_id)!.stopped,'cancelled');
});
