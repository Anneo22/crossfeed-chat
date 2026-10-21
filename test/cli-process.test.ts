import { tempPrefix } from './temp.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
const secret = 'synthetic-not-a-real-key-'.repeat(3);
const run = (args: any, env: Record<string, any> = {}) => spawnSync(process.execPath, ['src/cli.ts', ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
test('CLI help runs without credentials and invalid flags/arguments exit unsuccessfully without echoing input', () => {
  const help = run(['--help']); assert.equal(help.status, 0); assert.match(help.stdout, /Crossfeed Chat/);
  for (const args of [['status', '--row', 'Latest'], ['worker', 'remove', 'x', '--level', '2'], ['worker', 'add', 'x', '--row', 'Latest', '--level', '5'], ['unknown'], ['--'+secret], ['status', 'extra']]) {
    const result = run(args, { CROSSFEED_API_KEY: secret });
    assert.equal(result.status, 1); assert(!result.stdout.includes(secret)); assert(!result.stderr.includes(secret));
  }
});
test('unexpected CLI fetch failures print a safe actionable error and a real failing exit code', () => {
  const result = run(['status', '--api-port', '1'], { CROSSFEED_API_KEY: secret });
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.match(result.stderr, /Command failed; check flags/); assert(!result.stderr.includes(secret));
});

test('doctor gives a next step when the host cannot be reached', () => {
  const result = run(['doctor', '--api-port', '1'], {CROSSFEED_API_KEY: secret});
  assert.equal(result.status, 1); assert.match(result.stderr, /Host is not reachable. Next: start serve and check --api-port/); assert(!result.stderr.includes(secret));
});

test('CLI exposes attachment delivery and rejects invalid modes before starting a listener', () => {
  assert.match(run(['--help']).stdout, /--attachment-delivery mcp\|composer/);
  const result = run(['serve', '--attachment-delivery', 'remote'], { CROSSFEED_API_KEY: secret });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Attachment delivery must be mcp or composer/);
  assert(!result.stderr.includes(secret));
});


test('workbench CLI options are opt-in and permissions require a root', () => {
  const help=run(['--help']); assert.match(help.stdout,/--workbench ROOT/);
  for (const flag of ['--workbench-shell','--workbench-network']) {
    const result=run(['serve',flag],{CROSSFEED_API_KEY:secret});
    assert.equal(result.status,1); assert.match(result.stderr,/require --workbench/);
  }
  const beforeCommand = run(['--workbench-shell', 'serve'], { CROSSFEED_API_KEY: secret });
  assert.equal(beforeCommand.status, 1); assert.match(beforeCommand.stderr, /require --workbench/);
  assert.equal(run(['status','--workbench','/tmp'],{CROSSFEED_API_KEY:secret}).status,1);
});

test('full shell CLI is explicit, accepts default roots and fails closed on missing guard settings', t => {
  assert.match(run(['--help']).stdout, /--workbench-shell sandboxed\|full/);
  for (const args of [['serve', '--workbench-shell', 'unsafe'], ['serve', '--workbench-guards', '/tmp/settings.json']]) {
    const result = run(args, { CROSSFEED_API_KEY: secret });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Workbench shell must be|guards require/);
  }
  const directory = fs.mkdtempSync(tempPrefix('crossfeed-cli-guards-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const result = run(['serve', '--public-url', 'https://connector.example.test', '--state-dir', directory, '--workbench-shell', 'full', '--workbench-guards', '/missing/crossfeed-guard-settings.json'], { CROSSFEED_API_KEY: secret });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Full shell requires readable/);
  assert(!result.stderr.includes(secret));
});

test('CLI cancel help and invalid IDs or flags produce safe failures', () => {
  assert.match(run(['--help']).stdout,/cancel <job-id>\s+Remove a queued or running job; its caller gets caller_cancelled/);
  for (const args of [['cancel'],['cancel',secret],['cancel','a'.repeat(31)],['cancel','a'.repeat(33)],['cancel','!'.repeat(32)],['cancel','a'.repeat(32),'extra'],['cancel','a'.repeat(32),'--row','Latest']]) {
    const result = run(args,{CROSSFEED_API_KEY:secret});
    assert.equal(result.status,1); assert.equal(result.stdout,''); assert(!result.stderr.includes(secret));
  }
});
