import { tempPrefix } from './temp.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Workbench } from '../src/workbench.ts';
import type { WorkbenchResults } from '../src/workbench.ts';

function fixture(t: import('node:test').TestContext, options: Record<string, any> = {}) {
  const base = fs.mkdtempSync(tempPrefix('crossfeed-workbench-'));
  const root = path.join(base, 'repo'), directory = path.join(base, 'state');
  fs.mkdirSync(root); fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node --test', check: 'node --check sum.js', publish: 'echo unsafe' } }));
  fs.writeFileSync(path.join(root, 'sum.js'), 'export const sum = (a, b) => a - b;\n');
  fs.writeFileSync(path.join(root, 'sum.test.js'), "import test from 'node:test'; import assert from 'node:assert/strict'; import {sum} from './sum.js'; test('sum',()=>assert.equal(sum(2,3),5));\n");
  assert.equal(spawnSync('/usr/bin/git',['init','-q',root]).status!,0);
  assert.equal(spawnSync('/usr/bin/git',['-C',root,'add','package.json','sum.js','sum.test.js']).status!,0);
  assert.equal(spawnSync('/usr/bin/git',['-C',root,'-c','user.name=Test','-c','user.email=test@example.test','commit','-qm','Fixture']).status!,0);
  t.after(()=>fs.rmSync(base,{ recursive:true, force:true }));
  const bench = new Workbench({ roots: [root], directory, ...options });
  const call = <Name extends 'roots' | 'list' | 'read' | 'search' | 'apply_patch' | 'git' | 'run'>(name: Name, args: Record<string, unknown> = {}, context: import('../src/types.ts').CallContext = {}) => bench.call(`workbench_${name}` as `workbench_${Name}`, name === 'roots' ? args : { root: 'root1', ...args }, context) as Promise<WorkbenchResults[`workbench_${Name}`]>;
  return { base, root, directory, bench, call };
}

test('workbench lists roots, reads and searches text, edits exactly, and inspects git', async t => {
  const f = fixture(t);
  assert.deepEqual((await f.call('roots')).roots[0].commands, ['test','check']);
  assert((await f.call('list')).files.includes('sum.js'));
  assert.match((await f.call('read',{path:'sum.js'})).text,/a - b/);
  assert.equal((await f.call('search',{query:'a - b'})).matches[0].path,'sum.js');
  await f.call('apply_patch',{path:'sum.js',before:'a - b',after:'a + b'});
  assert.match((await f.call('git',{view:'diff'})).diff!,/\+export.*a \+ b/);
  assert.equal((await f.call('git')).status![0].path,'sum.js');
  await f.call('apply_patch',{path:'new.js',before:'',after:'hello\n'});
  await assert.rejects(f.call('apply_patch',{path:'new.js',before:'',after:'overwrite'}));
  await assert.rejects(f.call('apply_patch',{path:'sum.js',before:'missing',after:'wrong'}));
  fs.writeFileSync(path.join(f.root,'double.txt'),'a a');
  await assert.rejects(f.call('apply_patch',{path:'double.txt',before:'a',after:'b'}));
  assert.equal(fs.readFileSync(path.join(f.root,'double.txt'),'utf8'),'a a');
  const logs = fs.readFileSync(path.join(f.directory,'workbench.jsonl'),'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert(logs.some((row: any)=>row.state==='refused')); assert(logs.every((row: any)=>!Object.hasOwn(row,'args')));
});

test('workbench refuses traversal, symlinks, hardlinks, secrets, git internals and special files', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.base,'outside.txt'),'outside');
  fs.symlinkSync(path.join(f.base,'outside.txt'),path.join(f.root,'escape.txt'));
  fs.symlinkSync('sum.js',path.join(f.root,'inside.txt'));
  fs.linkSync(path.join(f.base,'outside.txt'),path.join(f.root,'hard.txt'));
  fs.symlinkSync(f.base,path.join(f.root,'escape-dir'));
  for(const file of ['.env','.env.local','private.key','id_ed25519','credentials.json']) fs.writeFileSync(path.join(f.root,file),'synthetic-denied-marker');
  for(const file of ['../outside.txt','/etc/passwd','.git/config','.env','.env.local','private.key','id_ed25519','credentials.json','escape.txt','inside.txt','hard.txt','escape-dir/outside.txt']) {
    await assert.rejects(f.call('read',{path:file}));
    await assert.rejects(f.call('apply_patch',{path:file,before:'',after:'changed'}));
  }
  assert.equal(fs.readFileSync(path.join(f.base,'outside.txt'),'utf8'),'outside');
  const files=(await f.call('list')).files;
  assert(!files.some((file: any)=>/escape|hard|\.env|\.key|credentials|id_ed25519/.test(file)));
  assert.equal((await f.call('search',{query:'synthetic-denied-marker'})).matches.length,0);
  await assert.rejects(f.call('list',{path:'escape-dir'}));
  await assert.rejects(f.call('read',{path:'sum.js',extra:true}));
  await assert.rejects(f.call('read',{root:'unknown',path:'sum.js'}));
});

test('staged git secrets and symlinks are excluded from status and diff', async t => {
  const f=fixture(t);
  fs.writeFileSync(path.join(f.root,'.env'),'synthetic-private-marker');
  fs.symlinkSync('/etc/passwd',path.join(f.root,'link'));
  spawnSync('/usr/bin/git',['-C',f.root,'add','.env','link']);
  assert.equal((await f.call('git')).status!.length,0);
  assert.equal((await f.call('git',{view:'diff',staged:true})).diff!,'');
});

test('reads reject binary, oversized files and non-unique patches without exposing content in audit', async t => {
  const f=fixture(t);
  fs.writeFileSync(path.join(f.root,'binary'),Buffer.from([0,1]));
  fs.writeFileSync(path.join(f.root,'large'),'x'.repeat(300000));
  await assert.rejects(f.call('read',{path:'binary'})); await assert.rejects(f.call('read',{path:'large'}));
  await f.call('apply_patch',{path:'sum.js',before:'a - b',after:'a + b /* edit-marker */'});
  assert(!fs.readFileSync(path.join(f.directory,'workbench.jsonl'),'utf8').includes('edit-marker'));
});

test('command allowlist runs a failing test, exact patch, passing tests cycle', {skip:process.platform!=='darwin'}, async t => {
  const f=fixture(t);
  await assert.rejects(f.call('run',{command:'publish'}));
  await assert.rejects(f.call('run',{shell:'echo unsafe'}));
  const failed=await f.call('run',{command:'test'}); assert.equal(failed.exit_code,1,failed.output); assert.match(failed.output,/fail 1/);
  await f.call('apply_patch',{path:'sum.js',before:'a - b',after:'a + b'});
  const passed=await f.call('run',{command:'test'}); assert.equal(passed.exit_code,0,passed.output); assert.match(passed.output,/pass 1/);
  assert.equal((await f.call('run',{command:'check'})).exit_code,0);
});

test('sandbox denies outside reads/writes, symlink escape, git internals, secrets and network even with shell enabled', {skip:process.platform!=='darwin'}, async t => {
  const f=fixture(t,{shell:true});
  fs.writeFileSync(path.join(f.base,'outside'),'outside'); fs.writeFileSync(path.join(f.root,'.env'),'synthetic-private-marker');
  fs.symlinkSync(f.base,path.join(f.root,'escape'));
  for(const shell of [`cat '${f.base}/outside'`,`echo bad > '${f.base}/written'`,'cat .env','cat .git/config','cat escape/outside',`echo bad > escape/written`]) {
    const result=await f.call('run',{shell}); assert.notEqual(result.exit_code,0,JSON.stringify(result)); assert(!result.output.includes('synthetic-private-marker'));
  }
  const net=await f.call('run',{shell:"node -e 'fetch(\"https://example.com\").then(()=>process.exit(0)).catch(()=>process.exit(42))'"}); assert.equal(net.exit_code,42,net.output);
  assert(!fs.existsSync(path.join(f.base,'written')));
  assert.equal((await f.call('run',{shell:'echo ok > allowed.txt'})).exit_code,0);
  assert.equal(fs.readFileSync(path.join(f.root,'allowed.txt'),'utf8').trim(),'ok');
});

test('output limit, cancellation, concurrency and environment stripping are enforced', {skip:process.platform!=='darwin'}, async t => {
  const f=fixture(t,{shell:true});
  const flood=await f.call('run',{shell:"node -e 'setInterval(()=>console.log(\"x\".repeat(10000)),1)'"});
  assert.equal(flood.stopped,'output_limit'); assert(flood.truncated); assert(Buffer.byteLength(flood.output)<=65536);
  const env=await f.call('run',{shell:"node -e 'console.log(process.env.CROSSFEED_API_KEY,process.env.TEST_WORKBENCH_SECRET)'"});
  assert.match(env.output,/undefined undefined/);
  const abort=new AbortController(); const pending=f.call('run',{shell:'sleep 30'},{signal:abort.signal});
  await assert.rejects(f.call('read',{path:'sum.js'}),/busy/); setTimeout(()=>abort.abort(),50);
  assert.equal((await pending).stopped,'cancelled');
});

test('root and command configuration validation is fail closed', t => {
  const f=fixture(t);
  assert.throws(()=>new Workbench({roots:[f.base],directory:f.directory}));
  assert.throws(()=>new Workbench({roots:[f.root,f.root],directory:f.directory}));
  assert.throws(()=>new Workbench({roots:[f.root],directory:f.directory,commands:{unknown:{test:['node','--test']}}}));
  const configured=new Workbench({roots:[f.root],directory:f.directory,commands:{[f.root]:{unit:['node','--test']}}});
  assert.deepEqual(Object.keys(configured.roots[0].commands),['unit']);
});

test('command temp directory hardlinks cannot mutate or read an outside file', {skip:process.platform!=='darwin'}, async t => {
  const f=fixture(t,{shell:true});
  fs.writeFileSync(path.join(f.base,'outside'),'synthetic-external-marker');
  const temporary=path.join(f.root,'.crossfeed-workbench-tmp');fs.mkdirSync(temporary,{mode:0o700});
  fs.linkSync(path.join(f.base,'outside'),path.join(temporary,'alias'));
  await assert.rejects(f.call('run',{shell:'cat .crossfeed-workbench-tmp/alias'}),/hardlink/);
  await assert.rejects(f.call('run',{shell:'echo bad > .crossfeed-workbench-tmp/alias'}),/hardlink/);
  assert.equal(fs.readFileSync(path.join(f.base,'outside'),'utf8'),'synthetic-external-marker');
});

test('sandbox and file tools share credential-shaped file refusal', {skip:process.platform!=='darwin'}, async t => {
  const f=fixture(t,{shell:true});
  for(const file of ['.ENV','private.KEY','api-key.json','access_token.txt','password.txt','secrets.json']) {
    fs.writeFileSync(path.join(f.root,file),'synthetic-private-marker');
    await assert.rejects(f.call('read',{path:file}));
    const result=await f.call('run',{shell:`cat '${file}'`});
    assert.notEqual(result.exit_code,0,result.output);assert(!result.output.includes('synthetic-private-marker'));
  }
});

test('git includes safe deleted files and multi-root selection isolates reads', async t => {
  const f=fixture(t);fs.unlinkSync(path.join(f.root,'sum.js'));
  assert((await f.call('git')).status!.some((row: any)=>row.path==='sum.js'&&row.status!.includes('D')));
  assert.match((await f.call('git',{view:'diff'})).diff!,/deleted file/);
  const root2=path.join(f.base,'second');fs.mkdirSync(root2);spawnSync('/usr/bin/git',['init','-q',root2]);
  fs.writeFileSync(path.join(root2,'second.txt'),'second root');
  const multi=new Workbench({roots:[f.root,root2],directory:f.directory});
  assert.equal((await multi.call('workbench_read',{root:'root2',path:'second.txt'})).text,'second root');
  await assert.rejects(multi.call('workbench_read',{root:'root1',path:'second.txt'}));
});

test('command timeout kills the command and network requires an explicit startup flag', {skip:process.platform!=='darwin'}, async t => {
  const f=fixture(t,{shell:true});
  const result=await f.call('run',{shell:'sleep 60'});assert.equal(result.stopped,'timeout');assert.equal((result as import('../src/types.ts').ExecutionResult).signal,'SIGKILL');
  const {createServer}=await import('node:http');const server=createServer((req: any,res: any)=>res.end('ok'));
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>((resolve,reject)=>server.close(error => error ? reject(error) : resolve())));
  const url=`http://127.0.0.1:${server.address().port}`;
  const shell=`node -e 'fetch("${url}").then(r=>r.text()).then(t=>console.log(t)).catch(()=>process.exit(42))'`;
  assert.equal((await f.call('run',{shell})).exit_code,42);
  const network=new Workbench({roots:[f.root],directory:f.directory,shell:true,network:true});
  const allowed=await network.call('workbench_run',{root:'root1',shell});assert.equal(allowed.exit_code,0,allowed.output);assert.match(allowed.output,/ok/);
});

test('supervisor stops detached descendants when their command parent exits', {skip:process.platform!=='darwin'}, async t => {
  const f=fixture(t,{shell:true});
  fs.writeFileSync(path.join(f.root,'descendant.js'),"import {spawn} from 'node:child_process'; const child=spawn(process.execPath,['-e',\"setTimeout(()=>require('node:fs').writeFileSync('late-write.txt','escaped'),500)\"],{detached:true,stdio:'ignore'}); child.unref();\n");
  const result=await f.call('run',{shell:'node descendant.js'});
  assert.equal(result.exit_code,0,result.output);
  await new Promise(resolve=>setTimeout(resolve,750));
  assert.equal(fs.existsSync(path.join(f.root,'late-write.txt')),false);
  // Both intermediate parents exit before the supervisor's next polling interval.
  fs.writeFileSync(path.join(f.root,'double-fork.c'),'#include <unistd.h>\n#include <fcntl.h>\nint main(void){if(fork())return 0;if(fork())_exit(0);setsid();usleep(500000);int fd=open("fork-write.txt",O_CREAT|O_WRONLY,0600);if(fd>=0){write(fd,"escaped",7);close(fd);}return 0;}\n');
  const compiled=spawnSync('/usr/bin/cc',[path.join(f.root,'double-fork.c'),'-o',path.join(f.root,'double-fork')],{encoding:'utf8'});
  assert.equal(compiled.status!,0,compiled.stderr);
  assert.equal((await f.call('run',{shell:'./double-fork'})).exit_code,0);
  await new Promise(resolve=>setTimeout(resolve,750));
  assert.equal(fs.existsSync(path.join(f.root,'fork-write.txt')),false);
});
