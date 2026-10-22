// MANUAL EXPERIMENT ONLY; never imported or invoked by production or tests.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';
// Manual only. Exact /usr/bin/brave, dedicated fresh profile, no user/browser modifications.
const mode=process.argv[2];if(!['wayland','x11'].includes(mode))throw Error('invalid_mode');
const windowstate=process.argv[3]??'normal';if(!['normal','minimized'].includes(windowstate))throw Error('invalid_windowstate');
const focusArg=process.argv[4]??'false';if(!['false','omitted'].includes(focusArg))throw Error('invalid_focus_variant');
const suffix=process.argv[5];if(process.argv.length>6||suffix!==undefined&&!/^[a-z0-9-]{1,32}$/.test(suffix))throw Error('invalid_unique_suffix');
if((windowstate!=='normal'||focusArg!=='false')&&!suffix)throw Error('nonbaseline_requires_fresh_suffix');
const cwd=process.cwd(),base=path.resolve(cwd,'.review-context/native-focus'),fixture=path.join(base,'fixture');
const lane=mode+(suffix?'-'+suffix:'');
const profile=path.join(base,'profile-'+lane),runDir=path.join(base,'observer-'+lane);
const marker=randomBytes(16).toString('hex'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
// Offline fixture is generated only under the runner-owned private worktree directory.
const verifiedDoctor=JSON.parse(execFileSync('python3',['-B','-m','tools.wake_checker','doctor'],{cwd,timeout:5000,encoding:'utf8'}));
if(verifiedDoctor.native?.status!=='ready'||verifiedDoctor.native?.backend!=='kde-kwin')throw Error('native_doctor_not_ready');
if(!process.env.DISPLAY||!process.env.WAYLAND_DISPLAY)throw Error('display_environment_missing');
const fixtureAssets = {"anchor.html":"<!doctype html><meta charset=\"utf-8\"><title>Disposable Native Focus Anchor</title><body><p>Offline isolated test anchor</p></body>","candidate.html":"<!doctype html><html><head><meta charset=\"utf-8\"><title>Loading</title></head><body><textarea id=\"editor\" aria-label=\"local fixture editor\"></textarea><button id=\"button\">Local test</button><span id=\"count\">0</span><script src=\"candidate.js\"></script></body></html>\n","candidate.js":"'use strict';\nconst marker = location.hash.slice(1);\nif (!/^[0-9a-f]{32}$/.test(marker)) throw new Error('invalid_fixture_marker');\ndocument.title = 'Crossfeed Wake ' + marker;\nlet count = 0;\ndocument.getElementById('button').addEventListener('click', () => {\n  document.getElementById('count').textContent = String(++count);\n});\n","manifest.json":"{\n  \"manifest_version\": 3,\n  \"name\": \"Isolated Native Focus Probe\",\n  \"version\": \"1.0\",\n  \"permissions\": [\n    \"tabs\"\n  ],\n  \"background\": {\n    \"service_worker\": \"worker.js\"\n  }\n}\n","worker.js":"// Offline MV3 worker. Only a caller-attached instance in its own disposable profile is used.\nchrome.runtime.onStartup.addListener(() => {});\nchrome.runtime.onInstalled.addListener(() => {});\n"};
fs.mkdirSync(fixture,{recursive:true,mode:0o700});
for(const [name,content] of Object.entries(fixtureAssets)){
 const file=path.join(fixture,name);
 if(fs.existsSync(file)){if(fs.readFileSync(file,'utf8')!==content)throw Error('offline_fixture_content_changed');}
 else fs.writeFileSync(file,content,{flag:'wx',mode:0o600});
}


const requested={type:'normal',state:windowstate,...(focusArg==='false'?{focused:false}:{})};
const result={mode,requested,focus_variant:focusArg,version:'verify separately using /usr/bin/brave --version',profile_isolated:true,candidate_count:null,listener_ready:false,api:null,dom:null,native:null,preventive_pass:false,status:'blocked',reason:null,cleanup:{browser:false,observer:false,profile:false}};
let brave,listener,cdp,port,target,closedBrowser=false,closedObserver=false;
function fail(s){throw Error(s)}
async function wait(fn,timeout=8500){const t=Date.now();while(Date.now()-t<timeout){const r=await fn();if(r)return r;await sleep(100)}fail('deadline_expired')}
function rows(){try{return fs.readFileSync(path.join(runDir,'events.jsonl'),'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(x=>x.kind==='desktop')}catch{return[]}}
class CDP{
 constructor(ws){this.ws=ws;this.pending=new Map();this.seq=0;ws.addEventListener('message',e=>{let a;try{a=JSON.parse(e.data)}catch{return}const p=this.pending.get(a.id);if(!p)return;this.pending.delete(a.id);clearTimeout(p.timer);a.error?p.reject(Error('cdp_error')):p.resolve(a.result||{})})}
 call(method,params={},sessionId,timeout=4500){return new Promise((resolve,reject)=>{let id=++this.seq,timer=setTimeout(()=>{this.pending.delete(id);reject(Error('cdp_deadline'))},timeout);this.pending.set(id,{resolve,reject,timer});this.ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}))})}
 close(){try{this.ws.close()}catch{}}
}
async function connect(){
 const found=await wait(async()=>{try{const a=(await fsp.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).trim().split('\n');const n=Number(a[0]);return n>=1024&&n<=65535&&/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(a[1])?{port:n,route:a[1]}:null}catch{return null}},13000);
 port=found.port;
 const info=await(await fetch('http://127.0.0.1:'+port+'/json/version',{signal:AbortSignal.timeout(2500)})).json();
 if(!info.webSocketDebuggerUrl?.startsWith('ws://127.0.0.1:'+port+'/devtools/browser/'))fail('cdp_endpoint_not_own_loopback');
 const ws=new WebSocket('ws://127.0.0.1:'+port+found.route);
 await Promise.race([new Promise((ok,no)=>{ws.addEventListener('open',ok,{once:true});ws.addEventListener('error',()=>no(Error('socket_fail')),{once:true})}),sleep(4500).then(()=>fail('socket_deadline'))]);
 return new CDP(ws);
}
async function targets(){return(await cdp.call('Target.getTargets')).targetInfos||[]}
async function attach(t){const r=await cdp.call('Target.attachToTarget',{targetId:t.targetId,flatten:true});try{await cdp.call('Runtime.runIfWaitingForDebugger',{},r.sessionId,1600)}catch{}await cdp.call('Runtime.enable',{},r.sessionId);return r.sessionId}
async function evalOwn(s,e){const r=await cdp.call('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true},s,5500);if(r.exceptionDetails||r.result?.subtype==='error')fail('own_runtime_exception');return r.result?.value}
async function ownedGroup(){try{const s=execFileSync('/usr/bin/ps',['-o','args=','-g',String(brave.pid)],{timeout:1500,encoding:'utf8'});return s.includes('--user-data-dir='+profile)}catch{return false}}
try{
 if(!process.env.DISPLAY||!process.env.WAYLAND_DISPLAY)fail('display_unavailable');
 if(fs.existsSync(profile)||fs.existsSync(runDir)||!fs.existsSync(fixture))fail('fresh_profile_or_fixture_blocked');
 brave=spawn('/usr/bin/brave',['--user-data-dir='+profile,'--ozone-platform='+mode,'--load-extension='+fixture,'--remote-debugging-port=0','--no-first-run','--no-default-browser-check','--disable-background-networking','--new-window',pathToFileURL(path.join(fixture,'anchor.html')).href],{cwd,detached:true,stdio:'ignore'});
 brave.on('exit',()=>{closedBrowser=true});
 cdp=await connect();
 const anchorURL=pathToFileURL(path.join(fixture,'anchor.html')).href;
 const own=await wait(async()=>{const ts=await targets();const anchor=ts.find(x=>x.type==='page'&&x.url===anchorURL);const worker=ts.find(x=>x.type==='service_worker'&&/^chrome-extension:\/\/[a-p]{32}\/worker\.js$/.test(x.url));return anchor&&worker?{anchor,worker}:null},10500);
 await cdp.call('Browser.getWindowForTarget',{targetId:own.anchor.targetId});
 const ext=own.worker.url.match(/^chrome-extension:\/\/([a-p]{32})\//)[1],sw=await attach(own.worker);
 if(!await evalOwn(sw,'!!chrome.windows?.create && !!chrome.runtime?.getURL'))fail('worker_extension_api_not_ready');
 listener=spawn('python3',['-B','-m','tools.wake_checker','listen','--duration','9','--output',runDir],{cwd,stdio:['ignore','pipe','pipe']});
 listener.on('exit',()=>{closedObserver=true});listener.stdout.on('data',()=>{});listener.stderr.on('data',()=>{});
 const ready=await wait(async()=>rows().find(x=>x.event==='ready'),6500);
 const chromeBaseline=await evalOwn(sw,'chrome.windows.getAll({populate:true}).then(a=>a.map(w=>({focused:w.focused,state:w.state,type:w.type})))');
 if(!Array.isArray(chromeBaseline)||chromeBaseline.length!==1||chromeBaseline[0].focused!==true||chromeBaseline[0].type!=='normal'||ready.sampling?.healthy!==true||ready.capacity?.overflow!==0||ready.capacity?.unknown!==0||ready.capacity?.tracked<1)fail('fixture_anchor_or_native_readiness_unverified');
 result.listener_ready=true;
 const api=await evalOwn(sw,'(async()=>{const opts='+JSON.stringify(requested)+';opts.url=chrome.runtime.getURL("candidate.html#'+marker+'");const w=await chrome.windows.create(opts);return {id:w.id,state:w.state,focused:w.focused,type:w.type}})()');
 if(!Number.isInteger(api?.id)||api.type!=='normal')fail('normal_window_creation_failed');
 result.candidate_count=1;result.api={type:api.type,state:api.state,focused:api.focused};
 const ownURL='chrome-extension://'+ext+'/candidate.html#'+marker;
 target=await wait(async()=>(await targets()).find(x=>x.type==='page'&&x.url===ownURL),4500);
 const sess=await attach(target);
 await wait(async()=>await evalOwn(sess,'document.readyState==="complete"&&document.title==="Crossfeed Wake "+location.hash.slice(1)'),3300);
 result.dom=await evalOwn(sess,'(()=>{const e=document.getElementById("editor"),b=document.getElementById("button");e.focus();e.value="offline";b.click();const r=e.getBoundingClientRect();return {ready:document.readyState==="complete",editorFocused:document.activeElement===e,clicked:document.getElementById("count").textContent==="1",layout:r.width>0&&r.height>0}})()');
 await sleep(1450);
 const verified=(await targets()).find(x=>x.targetId===target.targetId&&x.url===ownURL&&x.type==='page');
 if(!verified)fail('candidate_ownership_lost');
 await cdp.call('Target.closeTarget',{targetId:verified.targetId});target=null;
 result.status='captured';
}catch(e){result.reason=String(e.message||'blocked').replace(/\/[^ ]+/g,'[path]').slice(0,100)}
finally{
 try{if(cdp)await cdp.call('Browser.close',{},undefined,2500)}catch{}
 try{cdp?.close()}catch{}
 if(brave){await sleep(700);if(await ownedGroup()){try{process.kill(-brave.pid,'SIGTERM')}catch{}await sleep(600)}try{process.kill(-brave.pid,0)}catch{result.cleanup.browser=true}}
 if(listener){const start=Date.now();while(!closedObserver&&Date.now()-start<10600)await sleep(150);if(!closedObserver){try{listener.kill('SIGTERM')}catch{}await sleep(500)}result.cleanup.observer=closedObserver}
 try{
 const all=rows(),added=all.filter(x=>x.event==='window_added'&&!x.baseline),marked=all.filter(x=>x.marker_confirmed),last=marked.find(x=>x.event==='window_closed'),first=added.length===1?added[0]:undefined;
 const summary=JSON.parse(fs.readFileSync(path.join(runDir,'summary.json'),'utf8')),bg=summary.native_background||{},w=bg.windows?.find(x=>x.ownership==='wake_marker');
 const initial=first?.initial,changes=all.filter(x=>x.event==='window_changed'&&x.current).map(x=>x.current),timeline=w?.timeline||[];
 const coverage=last?.window_sampling??null;
 const noUnminimize=initial?.minimized===true?changes.every(x=>x.minimized===true):true;
 const visualInitiallyClear=initial?.minimized===true||initial?.above_previous===false;
 const noVisualActivation=timeline.length>=2&&timeline.every(x=>x.visual_stack===false&&x.active_foreground===false&&x.attention===false);
 result.native={native_candidates:bg.total_candidate_windows??null,added_count:added.length,marked_events:marked.length,matched_close:!!last,first_added:initial??null,activation_buffered:first?.activation_buffered??null,coverage,verdict:w?.background_verdict??null,initial_failures:bg.initial_failures??null,activation_count:bg.activation_count??null,pre_add_activation_count:w?.pre_add_activation_count??null,later_active_episodes:bg.later_active_episodes??null,later_visual_episodes:bg.later_visual_episodes??null,reforeground_episodes:bg.reforeground_episodes??null,topmost_rises:bg.topmost_rises??null,attention_rises:bg.attention_rises??null,complete_period_coverage:w?.complete_period_coverage??null,first_visual_stack:initial?initial.minimized===true?false:initial.above_previous:null,no_unminimize:noUnminimize,no_visual_activation:noVisualActivation,extra_native_added:added.length>1};
 if(result.status==='captured'&&(!first||!last||added.length!==1||bg.total_candidate_windows!==1||!w||!coverage?.complete||coverage.ticks<2||coverage.gaps!==0||w.complete_period_coverage!==true)){result.status='indeterminate';result.reason='incomplete_terminal_sampling_or_ownership'}
 if(result.status==='captured'&&windowstate==='minimized'){
  const dom=result.dom||{};
  result.preventive_pass=last.marker_confirmed===true&&w.ownership==='wake_marker'&&initial?.active===false&&visualInitiallyClear&&initial?.demands_attention===false&&first.activation_buffered===false&&noUnminimize&&noVisualActivation&&bg.activation_count===0&&w.pre_add_activation_count===0&&bg.attention_rises===0&&bg.reforeground_episodes===0&&bg.topmost_rises===0&&bg.later_active_episodes===0&&bg.later_visual_episodes===0&&dom.ready===true&&dom.editorFocused===true&&dom.clicked===true&&dom.layout===true;
  result.status=result.preventive_pass?'native_metadata_pass':'native_metadata_fail';
 }
 }catch{if(result.status==='captured'){result.status='indeterminate';result.reason='missing_native_summary'}}
 if(result.cleanup.browser)try{await fsp.rm(profile,{recursive:true,force:true});result.cleanup.profile=true}catch{}
 if(result.preventive_pass&&(!result.cleanup.browser||!result.cleanup.observer||!result.cleanup.profile)){result.preventive_pass=false;result.status='indeterminate';result.reason='cleanup_incomplete'}
 console.log(JSON.stringify(result));
}
