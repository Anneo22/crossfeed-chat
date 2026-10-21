import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { createInterface } from 'node:readline';
import type { App } from '../src/server.ts';
import { main } from '../src/cli.ts';
import { hash, nonce } from '../src/security.ts';

const packageText = JSON.stringify({name:'crossfeed-workbench-trial',private:true,type:'module',scripts:{test:'node --test',check:'node --check sum.js'}},null,2)+'\n';
const testText = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {sum} from './sum.js';\ntest('adds positive numbers',()=>assert.equal(sum(2,3),5));\ntest('adds a negative number',()=>assert.equal(sum(-2,3),1));\n";
const brokenText = 'export const sum = (a, b) => a - b;\n';
const fixedText = 'export const sum = (a, b) => a + b;\n';
const [mode, suppliedRoot] = process.argv.slice(2);
const runtimeFile=path.resolve('.scratch/workbench-live.json');
const git=(root: string,args: string[])=>spawnSync('/usr/bin/git',['-C',root,...args],{encoding:'utf8',timeout:5000});

function setup() {
  const root=fs.mkdtempSync('/private/tmp/crossfeed-workbench-trial-');
  fs.writeFileSync(root+'/package.json',packageText);
  fs.writeFileSync(root+'/sum.js',brokenText);
  fs.writeFileSync(root+'/sum.test.js',testText);
  fs.writeFileSync(root+'/.gitignore','.crossfeed-workbench-tmp/\n');
  for(const args of [['init','-q'],['add','package.json','sum.js','sum.test.js','.gitignore'],['-c','user.name=Crossfeed trial','-c','user.email=trial@example.test','commit','-qm','Failing sum fixture']]) {
    if(git(root,args).status!==0) throw Error('Scratch repository setup failed');
  }
  return root;
}

function verify(root: string) {
  let ok=true;
  for(const [file,expected] of [['package.json',packageText],['sum.test.js',testText],['sum.js',fixedText]]) {
    const filename=path.join(root,file),stat=fs.lstatSync(filename);
    if(!stat.isFile()||stat.nlink!==1||fs.readFileSync(filename,'utf8')!==expected) {console.error(`${file}: unexpected content or file type`);ok=false;}
  }
  const status=git(root,['status','--porcelain=v1']);
  if(status.status!==0||status.stdout.trim()!=='M sum.js'){console.error('Only sum.js may change');ok=false;}
  // Never execute chat-edited code outside the sandbox unless it matches the known fixture.
  if(!ok){console.error('Trial result fails; changed fixture was not executed.');process.exitCode=1;return;}
  const tests=spawnSync(process.execPath,['--test','sum.test.js'],{cwd:root,encoding:'utf8',timeout:10000});
  console.log(tests.stdout); if(tests.status!==0)ok=false;
  const independent=spawnSync(process.execPath,['--input-type=module','-e',"import assert from 'node:assert/strict'; import {sum} from './sum.js'; for(const [a,b] of [[0,0],[7,11],[-8,-3],[0,12]]) assert.equal(sum(a,b),a+b);"],{cwd:root,encoding:'utf8',timeout:10000});
  if(independent.status!==0){console.error('Independent held-out sums failed');ok=false;}
  console.log(ok?'Trial result passes: original tests intact, two tests and held-out sums pass, only sum.js changed.':'Trial result fails.');
  if(!ok)process.exitCode=1;
}

async function start() {
  if(fs.existsSync(runtimeFile)) {
    const old=JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
    try {process.kill(old.pid,0);throw Error('An isolated trial is already running');} catch(error) {if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
  }
  const root=setup(),directory=fs.mkdtempSync('/private/tmp/crossfeed-workbench-state-');
  const apiPort=14319,mcpPort=14320;
  const tunnel=spawn('/opt/homebrew/bin/cloudflared',['tunnel','--url',`http://127.0.0.1:${mcpPort}`,'--no-autoupdate'],{stdio:['ignore','pipe','pipe']});
  let app: App | undefined, controlServer: any, input: any, stopped=false;
  const stop=async()=>{if(stopped)return;stopped=true;input?.close();controlServer?.close();await app?.close();tunnel.kill('SIGTERM');};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  const origin=await new Promise<string>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('Tunnel URL timeout')),30000);
    let logs='';const read=(chunk: Uint8Array)=>{logs=(logs+chunk.toString()).slice(-20000);const match=logs.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);if(match){clearTimeout(timer);resolve(match[0]);}};
    tunnel.stdout.on('data',read);tunnel.stderr.on('data',read);
    tunnel.once('error',()=>{clearTimeout(timer);reject(Error('Tunnel could not start'));});
    tunnel.once('exit',()=>{clearTimeout(timer);reject(Error('Tunnel exited'));});
  }).catch(async error=>{await stop();throw error;});
  try {
    // The temporary control credential exists only in this process's memory.
    app=await main(['serve','--public-url',origin,'--connector','Crossfeed Workbench Trial','--api-port',String(apiPort),'--mcp-port',String(mcpPort),'--state-dir',directory,'--workbench',root],{CROSSFEED_API_KEY:nonce()+nonce()});
    const controlSocket=path.join(directory,'control.sock');
    const control=async (line: string)=>{
      const [command,id]=line.trim().split(/\s+/);
      if(command==='link')return app!.oauth.open();
      if(command==='pending')return app!.oauth.list();
      if(command==='approve')return app!.oauth.approve(id);
      if(command==='status')return {approvals:app!.oauth.list(),clients:app!.oauth.clients(),root,public_url:origin};
      if(command==='probe'){await probe(app!,origin,root);return {ok:true,synthetic:true,fixture_restored:true};}
      if(command==='stop'){await stop();return {stopped:true};}
      throw Error('Unknown control command');
    };
    controlServer=net.createServer((socket: any)=>{
      let request='';socket.setTimeout(30000,()=>socket.destroy());
      socket.on('error',()=>{});
      socket.on('data',async (chunk: Uint8Array)=>{
        request+=chunk.toString();if(request.length>4096){socket.destroy();return;}
        if(!request.includes('\n'))return;socket.removeAllListeners('data');
        try{socket.end(JSON.stringify({result:await control(request.trim())})+'\n');}
        catch{socket.end(JSON.stringify({error:'Control action refused'})+'\n');}
      });
    });
    await new Promise<void>((resolve,reject)=>{controlServer.once('error',reject);controlServer.listen(controlSocket,resolve);});
    fs.chmodSync(controlSocket,0o600);
    fs.mkdirSync(path.dirname(runtimeFile),{recursive:true});
    fs.writeFileSync(runtimeFile,JSON.stringify({pid:process.pid,tunnel_pid:tunnel.pid,root,directory,api_port:apiPort,mcp_port:mcpPort,public_url:origin,control_socket:controlSocket,started_at:new Date().toISOString()},null,2)+'\n');
    console.log(`Scratch root: ${root}\nPrivate state: ${directory}\nRuntime receipt: ${runtimeFile}\nControl here: link | pending | approve <id> | probe | status | stop`);
    app!.oauth.open();console.log('Five-minute registration window opened.');
    input=createInterface({input:process.stdin,terminal:false});
    input.on('line',async (line: string)=>{try{console.log(await control(line));}catch{console.error('Control action refused');}});
    tunnel.once('exit',()=>{input.close();void stop();});
  } catch(error){await stop();throw error;}
}

async function probe(app: App,origin: string,root: string) {
  // Public HTTPS/OAuth/MCP smoke test. This is a synthetic client, not ChatGPT acceptance.
  app.oauth.open();
  const client=app.oauth.register({client_name:'Synthetic local smoke test',redirect_uris:['https://chatgpt.com/connector/oauth/workbench_probe'],token_endpoint_auth_method:'none'});
  const verifier=nonce()+nonce();
  const pending=app.oauth.authorize({client_id:client.client_id,redirect_uri:client.redirect_uris[0],response_type:'code',code_challenge_method:'S256',code_challenge:hash(verifier),state:'smoke',scope:'mcp:tools offline_access',resource:origin+'/tools/mcp'});
  app.oauth.approve(pending.id);
  const callback=new URL(app.oauth.consent(pending.id,pending.browser).redirect!);
  const tokens=app.oauth.token({grant_type:'authorization_code',client_id:client.client_id,code:callback.searchParams.get('code'),redirect_uri:client.redirect_uris[0],code_verifier:verifier,resource:origin+'/tools/mcp'});
  let sequence=0;
  const rpc=async(method: string,params?: Record<string, unknown>)=>{
    const response=await fetch(origin+'/tools/mcp',{method:'POST',headers:{Authorization:'Bearer '+tokens.access_token,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:++sequence,method,params})});
    const result=await response.json();if(!response.ok||result.error||result.result?.isError)throw Error('MCP smoke call failed');return result.result;
  };
  const call=async(name: string,args: Record<string, unknown>)=> (await rpc('tools/call',{name:'workbench_'+name,arguments:args})).structuredContent;
  try {
    if(fs.readFileSync(root+'/sum.js','utf8')!==brokenText)throw Error('Probe requires pristine failing fixture');
    const tools=await rpc('tools/list'); if(tools.tools.length!==7)throw Error('Discovery failed');
    const failed=await call('run',{root:'root1',command:'test'});if(failed.exit_code!==1||!failed.output.includes('fail 2'))throw Error('Failing tests not observed');
    await call('read',{root:'root1',path:'sum.js'});
    await call('apply_patch',{root:'root1',path:'sum.js',before:'a - b',after:'a + b'});
    const passed=await call('run',{root:'root1',command:'test'});if(passed.exit_code!==0||!passed.output.includes('pass 2'))throw Error('Passing tests not observed');
    const diff=await call('git',{root:'root1',view:'diff'});if(!diff.diff.includes('a + b'))throw Error('Diff failed');
    fs.writeFileSync(path.resolve('.scratch/workbench-smoke.json'),JSON.stringify({time:new Date().toISOString(),public_url:origin,tools:7,failed_tests:2,passed_tests:2,client:'synthetic',chatgpt_acceptance:false},null,2)+'\n');
    console.log('Synthetic HTTPS/OAuth/MCP smoke passed: 7 tools, 2 failing tests -> exact edit -> 2 passing tests -> git diff.');
  } finally {
    if(fs.readFileSync(root+'/sum.js','utf8')===fixedText)await call('apply_patch',{root:'root1',path:'sum.js',before:'a + b',after:'a - b'});
    app.oauth.revoke(client.client_id);app.oauth.open();
    console.log('Scratch fixture restored to its failing baseline; registration window reopened.');
  }
}

try {
  if(mode==='start')await start();
  else if(mode==='control') {
    const runtime=JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
    const reply=await new Promise<{error?: string}>((resolve,reject)=>{
      const socket=net.connect(runtime.control_socket);let output='';
      socket.setTimeout(30000,()=>socket.destroy(Error('Control timed out')));socket.once('error',reject);
      socket.once('connect',()=>socket.write(process.argv.slice(3).join(' ')+'\n'));
      socket.on('data',(chunk: Uint8Array)=>{output+=chunk.toString();if(output.length>65536)socket.destroy(Error('Control response too large'));});
      socket.once('end',()=>{try{resolve(JSON.parse(output));}catch{reject(Error('Invalid control response'));}});
    });
    console.log(JSON.stringify(reply,null,2));if(reply.error)process.exitCode=1;
  }
  else if(mode==='verify')verify(suppliedRoot??JSON.parse(fs.readFileSync(runtimeFile, 'utf8')).root);
  else {console.error('Usage: node scripts/live-workbench.ts start | control link|pending|approve ID|status|probe|stop | verify [scratch-root]');process.exitCode=1;}
} catch {console.error('Workbench trial failed; check scratch state, free ports 14319/14320 and cloudflared availability.');process.exitCode=1;}
