import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { defaultDirectory } from '../src/config.ts';
import { hostChecks } from '../src/host-checks.ts';
import { diagnose } from '../src/cli.ts';
import { Workbench } from '../src/workbench.ts';
import { Audio } from '../src/audio.ts';
import { tempPrefix } from './temp.ts';

test('Linux home and XDG paths need no macOS directories and explicit state wins', () => {
  assert.equal(defaultDirectory({}, '/srv/example-home'), '/srv/example-home/.config/crossfeed-chat');
  assert.equal(defaultDirectory({XDG_CONFIG_HOME: '/srv/example-home/config'}, '/srv/example-home'), '/srv/example-home/config/crossfeed-chat');
  assert.equal(defaultDirectory({XDG_CONFIG_HOME: 'relative'}, '/srv/example-home'), '/srv/example-home/.config/crossfeed-chat');
  assert.equal(defaultDirectory({CROSSFEED_HOME: '/srv/cfc', XDG_CONFIG_HOME: '/srv/example-home/config'}, '/srv/example-home'), '/srv/cfc');
});

test('doctor checks Linux optional capabilities, compiler absence, and exact Plus refusal', () => {
  const linux = hostChecks({platform: 'linux', node: '24.18.0', workbench: true, fullShell: true, compiler: () => assert.fail('Linux must not call xcrun')});
  assert.equal(linux.issues.length, 2);
  assert.match(linux.issues.join('\n'), /text transcript/);
  assert.match(linux.issues.join('\n'), /Full shell.*not a Linux fallback/);
  assert.deepEqual(hostChecks({platform: 'linux', node: '24.18.0', audio: false}).issues, []);
  const mac = hostChecks({platform: 'darwin', node: '24.17.0', workbench: true, exists: () => false, compiler: () => false});
  assert.equal(mac.issues.length, 4);
  const status: any = {host_checks: linux, host_available: true, capacity: {claimed: 0, limit: 5}, workers: [], jobs: [], wakes: [{label: 'sol', state: 'failed', failure_code: 'level_unavailable'}], approvals: [], extension_enabled: false, wake_limits: {blocked: null, cooldown_until: 0}};
  const problems = diagnose(status).join('\n');
  assert.match(problems, /worker set sol --level LEVEL/); assert.match(problems, /brave:\/\/extensions/);
  assert.match(problems, /Linux terminal/);
});

test('Linux capability path preserves file tools and refuses command execution, without weakening the command guard', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  t.after(() => Object.defineProperty(process, 'platform', descriptor));
  Object.defineProperty(process, 'platform', {value: 'linux'});
  const base = fs.mkdtempSync(tempPrefix('crossfeed-linux-'));
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  const root = base + '/project'; fs.mkdirSync(root);
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  fs.writeFileSync(root + '/hello.txt', 'portable');
  const w = new Workbench({roots: [root], directory: base + '/state'});
  assert.deepEqual(await w.call('workbench_read', {root: 'root1', path: 'hello.txt'}), {path: 'hello.txt', text: 'portable'});
  const capabilities: any = await w.call('workbench_roots', {});
  assert.match(capabilities.sandbox, /unavailable/);
  await assert.rejects(w.call('workbench_run', {root: 'root1', command: 'test'}), /Linux.*own terminal/);
  const settings = base + '/guards.json';
  fs.writeFileSync(settings, JSON.stringify({hooks: {PreToolUse: [{matcher: 'Bash', hooks: [{type: 'command', command: 'true'}]}]}}));
  const full = new Workbench({roots: [root], directory: base + '/full-state', shell: 'full', guardSettings: settings});
  assert.match((await full.call('workbench_roots', {}) as any).sandbox, /unavailable/);
  await assert.rejects(full.call('workbench_run', {root: 'root1', shell: 'printf unsafe-fallback'}), /Linux.*own terminal/);
  const audio = new Audio(base);
  const note = await audio.blocks([{id: 'a', name: 'voice.wav', mime: 'audio/wav', bytes: 1, path: root + '/voice.wav'}]);
  assert.match(note[0].text, /local transcription unavailable/);
});
