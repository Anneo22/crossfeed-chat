// MANUAL finite fixture experiment. Never import from production. Offline synthetic data only.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {spawn, execFileSync} from 'node:child_process';
import {createHash, randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';

if (process.argv.length !== 3 || !/^[a-z0-9-]{2,28}$/.test(process.argv[2])) throw Error('fresh_suffix_required');
const cwd=process.cwd(), root=path.resolve(cwd,'.review-context/xvfb-fixture'), run=path.join(root,'run-'+process.argv[2]);
const fixture=path.join(root,'fixture'), profile=path.join(run,'profile'), observer=path.join(run,'observer');
const xvfb=path.resolve(cwd,'.review-context/xvfb-runtime/payload/usr/bin/Xvfb');
const expectedHash='567a9b39284e303522fdc178059fe60d0e9917b811bd5066fb63260fd198a97c';
const auth=path.join(run,'Xauthority'), emptyAuth=path.join(run,'empty-authority'), xvfbLog=path.join(run,'xvfb.stderr.log');
const anchorURL=pathToFileURL(path.join(fixture,'anchor.html')).href;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function check(x,code){if(!x)throw Error(code);}
async function waitFor(fn,ms=7000){const start=Date.now();while(Date.now()-start<ms){const x=await fn();if(x)return x;await sleep(110);}throw Error('timeout_waiting_for_expected_fixture_state');}
function cmd(file,args,env,timeout=4500){return execFileSync(file,args,{cwd,env:env||process.env,timeout,encoding:'utf8',stdio:['ignore','pipe','pipe']});}
function alive(pid){try{process.kill(-pid,0);return true;}catch{return false;}}
function ownPGID(pid,marker){
  if(!pid)return false;
  try{
    const lines=cmd('/usr/bin/ps',['-o','args=','-g',String(pid)],undefined,1600).split('\n');
    return lines.some(s=>s.includes(marker));
  }catch{return false;}
}
function processArgv(pid){return fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\0').filter(Boolean);}
function flagsInArgv(pid){
  const tokens=processArgv(pid).flatMap(s=>s.split(/\s+/)).filter(Boolean);
  const needs=['--user-data-dir='+profile,'--ozone-platform=x11','--load-extension='+fixture,'--remote-debugging-port=0','--no-first-run','--no-default-browser-check','--disable-background-networking'];
  check(needs.every(x=>tokens.includes(x)),'browser_flags_absent');
  check(!tokens.some(x=>/^--headless(?:=|$)/.test(x)||x==='--no-sandbox'||/^--user-agent(?:=|$)/.test(x)||x==='--disable-blink-features=AutomationControlled'),'forbidden_browser_flag');
  return true;
}
function nativeRows(){try{return fs.readFileSync(path.join(observer,'events.jsonl'),'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(x=>x.kind==='desktop');}catch{return [];}}
function nativeStats(){
  const a=nativeRows(), h=a.filter(x=>x.event==='heartbeat');
  return {added:a.filter(x=>x.event==='window_added'&&x.baseline!==true).length,
    closed:a.filter(x=>x.event==='window_closed'&&!x.baseline).length,
    changed:a.filter(x=>x.event==='window_changed').length,
    activation:a.filter(x=>x.event==='window_activated'||x.activation_buffered===true||x.activation_observed===true||(x.event==='window_changed'&&x.current?.active===true)).length,
    attention:a.filter(x=>(x.event==='window_added'&&x.initial?.demands_attention===true)||(x.event==='window_changed'&&x.current?.demands_attention===true)).length,
    heartbeats:h.length,healthy:h.filter(x=>x.sampling?.healthy===true&&x.capacity?.unknown===0&&x.capacity?.overflow===0).length,
    gaps:Math.max(0,...h.map(x=>x.sampling?.gaps??0)),
    unknown:Math.max(0,...h.map(x=>x.capacity?.unknown??0)),
    overflow:Math.max(0,...h.map(x=>x.capacity?.overflow??0))};
}
class CDP {
  constructor(ws){this.ws=ws;this.seq=0;this.pending=new Map();
    ws.addEventListener('message',ev=>{let obj;try{obj=JSON.parse(ev.data);}catch{return;}
      const req=this.pending.get(obj.id);if(!req)return;this.pending.delete(obj.id);clearTimeout(req.timer);
      obj.error?req.reject(Error('cdp_method_failed')):req.resolve(obj.result||{});
    });
  }
  call(method,params={},sessionId,deadline=5500){return new Promise((resolve,reject)=>{
    const id=++this.seq,timer=setTimeout(()=>{this.pending.delete(id);reject(Error('cdp_timeout'));},deadline);
    this.pending.set(id,{resolve,reject,timer});this.ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));
  });}
  close(){try{this.ws.close();}catch{}}
}
let listener,xserver,brave,cdp,sw,ext,listenerClosed=false,xserverClosed=false,braveClosed=false;
let browserGroupVerified=false,xserverGroupVerified=false,xnum,envX;
const result={experiment:'private_headed_xvfb_mv3_two_normal_windows',build:'Brave 152.1.94.117',xvfb_sha256_verified:false,
  observer:{ready:false,alive_during_cleanup:false},x11:{free_display:false,auth_positive:false,noauth_rejected:false,wrongauth_rejected:false,server_backend:false,root_children_before:null,root_children_during:null},
  process:{headed_flags:false,virtual_display_only:false,loopback_cdp:false,headed_ua:false,own_group:false},mv3:false,
  anchor:false,cases:[],native:null,cleanup:{browser_closed:false,xserver_closed:false,listener_closed:false,profile_removed:false,auth_removed:false},
  decision:'blocked',reason:null};
const assets={
  'anchor.html':'<!doctype html><meta charset="utf-8"><title>Private Fixture Anchor</title><body><p>Offline anchor</p></body>\n',
  'candidate.html':'<!doctype html><html><head><meta charset="utf-8"><title>Loading</title></head><body><textarea id="editor"></textarea><button id="button">Local test</button><span id="count">0</span><script src="candidate.js"></script></body></html>\n',
  'candidate.js':"'use strict';\nconst marker=location.hash.slice(1);\nif(!/^[a-f0-9]{32}$/.test(marker))throw Error('wrong_fixture_nonce');\ndocument.title='Crossfeed Wake '+marker;\nlet count=0;document.getElementById('button').addEventListener('click',()=>{document.getElementById('count').textContent=String(++count);});\n",
  'manifest.json':'{"manifest_version":3,"name":"Private Xvfb Synthetic Probe","version":"1.0","permissions":["tabs","windows"],"background":{"service_worker":"worker.js"}}\n',
  'worker.js':'// Offline MV3 dummy-only worker.\nchrome.runtime.onInstalled.addListener(()=>{});chrome.runtime.onStartup.addListener(()=>{});\n'
};
function createPrivate(){
  if(!fs.existsSync(root))fs.mkdirSync(root,{mode:0o700});
  check(!fs.existsSync(run),'run_exists');
  fs.mkdirSync(run,{mode:0o700});
  if(!fs.existsSync(fixture))fs.mkdirSync(fixture,{mode:0o700});
  for(const [name,content] of Object.entries(assets)){
    const file=path.join(fixture,name);
    if(fs.existsSync(file))check(fs.readFileSync(file,'utf8')===content,'private_fixture_asset_changed');
    else fs.writeFileSync(file,content,{flag:'wx',mode:0o600});
  }
}
async function connect(){
  const ep=await waitFor(async()=>{
    try{const lines=(await fsp.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).trim().split('\n');
      const port=Number(lines[0]);return port>=1024&&port<=65535&&/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(lines[1])?{port,route:lines[1]}:null;}
    catch{return null;}
  },13000);
  const version=await (await fetch('http://127.0.0.1:'+ep.port+'/json/version',{signal:AbortSignal.timeout(2500)})).json();
  check(version.webSocketDebuggerUrl==='ws://127.0.0.1:'+ep.port+ep.route,'cdp_not_profile_loopback');
  const ws=new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((ok,no)=>{const t=setTimeout(()=>no(Error('cdp_socket_timeout')),4000);
    ws.addEventListener('open',()=>{clearTimeout(t);ok();},{once:true});
    ws.addEventListener('error',()=>{clearTimeout(t);no(Error('cdp_socket_error'));},{once:true});});
  result.process.loopback_cdp=true;
  return new CDP(ws);
}
async function targets(){return (await cdp.call('Target.getTargets')).targetInfos||[];}
async function attach(t){
  const r=await cdp.call('Target.attachToTarget',{targetId:t.targetId,flatten:true});
  try{await cdp.call('Runtime.runIfWaitingForDebugger',{},r.sessionId,1700);}catch{}
  await cdp.call('Runtime.enable',{},r.sessionId);return r.sessionId;
}
async function evalOwn(sess,expr){
  const r=await cdp.call('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true},sess,6500);
  check(!r.exceptionDetails&&r.result?.subtype!=='error','own_realm_runtime_error');return r.result?.value;
}
function verifyStage(t,url,title){
  check(t&&['loading','complete'].includes(t.status),'invalid_tab_status');
  check(!t.pendingUrl||t.pendingUrl===url,'unowned_pending_url');
  check(!t.url||t.url==='about:blank'||t.url===url,'unowned_committed_url');
  check(t.url===url?(!t.title||t.title==='Loading'||t.title===title):!t.title,'unowned_title');
  return t.url===url&&t.status==='complete'&&t.title===title;
}
function rootChildren(){
  // Query only the OWN authenticated virtual display; never touch physical display.
  const py=String.raw`import ctypes
x=ctypes.CDLL("libX11.so.6")
x.XOpenDisplay.restype=ctypes.c_void_p
d=x.XOpenDisplay(None)
if not d: raise SystemExit(2)
x.XDefaultRootWindow.argtypes=[ctypes.c_void_p]
x.XDefaultRootWindow.restype=ctypes.c_ulong
root=x.XDefaultRootWindow(d)
r=ctypes.c_ulong();p=ctypes.c_ulong();children=ctypes.POINTER(ctypes.c_ulong)();n=ctypes.c_uint()
x.XQueryTree.argtypes=[ctypes.c_void_p,ctypes.c_ulong,ctypes.POINTER(ctypes.c_ulong),ctypes.POINTER(ctypes.c_ulong),ctypes.POINTER(ctypes.POINTER(ctypes.c_ulong)),ctypes.POINTER(ctypes.c_uint)]
ok=x.XQueryTree(d,root,ctypes.byref(r),ctypes.byref(p),ctypes.byref(children),ctypes.byref(n))
if not ok: raise SystemExit(3)
print(n.value)
if children: x.XFree.argtypes=[ctypes.c_void_p]; x.XFree(children)
x.XCloseDisplay.argtypes=[ctypes.c_void_p]; x.XCloseDisplay(d)`;
  return Number(cmd('python3',['-c',py],envX,3000).trim());
}
function statusClean(){
  const s=nativeStats();
  check(s.added===0&&s.closed===0&&s.changed===0&&s.activation===0&&s.attention===0&&s.unknown===0&&s.overflow===0&&s.gaps===0,'native_ambiguous_activity');
}
async function main(){
  check(fs.readFileSync(xvfb)&&createHash('sha256').update(fs.readFileSync(xvfb)).digest('hex')===expectedHash,'xvfb_binary_hash_mismatch');
  result.xvfb_sha256_verified=true;
  const doctor=JSON.parse(cmd('python3',['-B','-m','tools.wake_checker','doctor'],undefined,6500));
  check(doctor.native?.status==='ready'&&doctor.native?.backend==='kde-kwin','native_observer_not_ready');
  createPrivate();
  listener=spawn('python3',['-B','-m','tools.wake_checker','listen','--duration','120','--output',observer],{cwd,stdio:'ignore'});
  listener.on('exit',()=>{listenerClosed=true;});
  const ready=await waitFor(()=>nativeRows().find(e=>e.event==='ready'),6500);
  check(ready.sampling?.healthy===true&&ready.capacity?.overflow===0&&ready.capacity?.unknown===0&&ready.capacity?.tracked>=1,'native_listener_not_healthy');
  result.observer.ready=true;
  check(!listenerClosed,'observer_closed_early');
  for(let n=90;n<125;n++){
    if(!fs.existsSync('/tmp/.X11-unix/X'+n)&&!fs.existsSync('/tmp/.X'+n+'-lock')){xnum=n;break;}
  }
  check(Number.isInteger(xnum),'no_free_private_display');
  result.x11.free_display=true;
  fs.writeFileSync(auth,'',{mode:0o600,flag:'wx'});
  fs.writeFileSync(emptyAuth,'',{mode:0o600,flag:'wx'});
  check((fs.statSync(auth).mode&0o777)===0o600,'authority_permissions_wrong');
  const cookie=randomBytes(16).toString('hex');
  cmd('/usr/bin/xauth',['-f',auth,'add',':'+xnum,'.',cookie],undefined,4500);
  const display=':'+xnum;
  envX={...process.env,DISPLAY:display,XAUTHORITY:auth};
  delete envX.WAYLAND_DISPLAY;delete envX.WAYLAND_SOCKET;
  const logfd=fs.openSync(xvfbLog,'wx',0o600);
  xserver=spawn(xvfb,[display,'-screen','0','1280x800x24','-nolisten','tcp','-noreset','-auth',auth],{cwd,env:envX,detached:true,stdio:['ignore','ignore',logfd]});
  fs.closeSync(logfd);xserver.on('exit',()=>{xserverClosed=true;});
  xserverGroupVerified=true; // Direct executable started detached, hash checked; verify live argv before acting on PGID.
  const positive=await waitFor(()=>{
    if(xserverClosed)return null;
    try{cmd('/usr/bin/xdpyinfo',['-display',display],envX,1500);return true;}catch{return null;}
  },6500);
  result.x11.auth_positive=positive;
  check(fs.realpathSync('/proc/'+xserver.pid+'/exe')===xvfb,'xserver_exe_unowned');
  const xargv=processArgv(xserver.pid);
  check(xargv.includes(display)&&xargv.includes(auth)&&xargv.includes('-nolisten')&&xargv.includes('tcp')&&!xargv.includes('-ac'),'xserver_auth_arg_mismatch');
  result.x11.server_backend=true;
  const negativeEnv={...envX,XAUTHORITY:emptyAuth};
  try{cmd('/usr/bin/xdpyinfo',['-display',display],negativeEnv,1800);}catch{result.x11.noauth_rejected=true;}
  check(result.x11.noauth_rejected,'x11_noauth_was_accepted');
  const wrongAuth=path.join(run,'wrong-authority');
  fs.writeFileSync(wrongAuth,'',{mode:0o600,flag:'wx'});
  cmd('/usr/bin/xauth',['-f',wrongAuth,'add',display,'.',randomBytes(16).toString('hex')],undefined,3500);
  try{cmd('/usr/bin/xdpyinfo',['-display',display],{...envX,XAUTHORITY:wrongAuth},1800);}catch{result.x11.wrongauth_rejected=true;}
  check(result.x11.wrongauth_rejected,'x11_wrongauth_was_accepted');
  result.x11.root_children_before=rootChildren();
  check(result.x11.root_children_before===0,'unexpected_existing_virtual_root_child');
  check(!listenerClosed,'native_observer_ended_before_browser');
  const browserEnv={...envX};
  const args=['--user-data-dir='+profile,'--ozone-platform=x11','--load-extension='+fixture,
    '--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--no-first-run',
    '--no-default-browser-check','--disable-background-networking','--password-store=basic','--new-window',anchorURL];
  brave=spawn('/usr/bin/brave',args,{cwd,env:browserEnv,detached:true,stdio:'ignore'});
  brave.on('exit',()=>{braveClosed=true;});
  await waitFor(()=>{try{flagsInArgv(brave.pid);return true;}catch{return null;}},6000);
  browserGroupVerified=ownPGID(brave.pid,'--user-data-dir='+profile);
  check(browserGroupVerified,'unverifiable_owned_browser_process_group');
  result.process.own_group=true;result.process.headed_flags=true;
  const bEnv=fs.readFileSync('/proc/'+brave.pid+'/environ','utf8').split('\0');
  check(bEnv.includes('DISPLAY='+display)&&bEnv.includes('XAUTHORITY='+auth)&&!bEnv.some(s=>s.startsWith('WAYLAND_DISPLAY=')||s.startsWith('WAYLAND_SOCKET=')),'browser_not_private_x11');
  result.process.virtual_display_only=true;
  cdp=await connect();
  const found=await waitFor(async()=>{
    const ts=await targets(), anchor=ts.filter(x=>x.type==='page'&&x.url===anchorURL),
      workers=ts.filter(x=>x.type==='service_worker'&&/^chrome-extension:\/\/[a-p]{32}\/worker\.js$/.test(x.url));
    return anchor.length===1&&workers.length===1?{anchor:anchor[0],worker:workers[0]}:null;
  },11000);
  const owner=await cdp.call('Browser.getWindowForTarget',{targetId:found.anchor.targetId});
  check(Number.isInteger(owner.windowId),'anchor_not_normal_window');
  ext=found.worker.url.match(/^chrome-extension:\/\/([a-p]{32})\//)[1];
  sw=await attach(found.worker);
  check(await evalOwn(sw,'!!chrome.windows?.create&&!!chrome.tabs?.query&&!!chrome.runtime?.getURL'),'mv3_api_missing');
  result.mv3=true;
  const base=await evalOwn(sw,'chrome.windows.getAll({populate:true}).then(a=>a.map(w=>({id:w.id,type:w.type,focused:w.focused,tabs:w.tabs?.length,active:w.tabs?.filter(t=>t.active).length})))');
  check(base.length===1&&base[0].type==='normal'&&base[0].tabs===1&&base[0].active===1&&Number.isInteger(base[0].id),'anchor_not_single_normal_window');
  result.anchor=true;
  const anchorSess=await attach(found.anchor);
  const ua=await evalOwn(anchorSess,'navigator.userAgent');
  check(typeof ua==='string'&&/\bChrome\/[0-9]+/.test(ua)&&!ua.includes('HeadlessChrome'),'not_genuinely_headed_chromium');
  result.process.headed_ua=true;
  result.x11.root_children_during=rootChildren();
  check(result.x11.root_children_during>result.x11.root_children_before,'headed_x11_surface_not_created');
  statusClean();
  for(let k=0;k<2;k++){
    check(!listenerClosed,'observer_stopped_before_case');
    const nonce=randomBytes(16).toString('hex');
    const ownURL='chrome-extension://'+ext+'/candidate.html#'+nonce;
    const created=await evalOwn(sw,'(async()=>{const w=await chrome.windows.create({url:chrome.runtime.getURL("candidate.html#'+nonce+'"),type:"normal",focused:false});const a=await chrome.tabs.query({windowId:w.id,active:true});const x=await chrome.windows.get(w.id,{populate:true});return {id:w.id,tabId:a[0]?.id,type:w.type,focused:w.focused,tabCount:a.length,belongs:a[0]?.windowId===w.id,oneOwnTab:x.tabs?.length===1&&x.tabs[0]?.active===true&&x.tabs[0]?.id===a[0]?.id,stage:a[0]?{url:a[0].url,pendingUrl:a[0].pendingUrl,title:a[0].title,status:a[0].status}:null};})()');
    const caseResult={case:k+1,normal:created?.type==='normal',unfocused:created?.focused===false,
      active_tab_bound:false,initial_own_navigation:false,unique_target:false,location_proved:false,
      headed_ua:false,dom_ready:false,editor_focus:false,click:false,layout:false,tab_closed:false,anchor_retained:false};
    result.cases.push(caseResult);
    check(Number.isInteger(created?.id)&&Number.isInteger(created?.tabId)&&created.type==='normal'&&created.focused===false&&created.tabCount===1&&created.belongs&&created.oneOwnTab,'new_window_api_or_tab_binding_failed');
    caseResult.active_tab_bound=true;
    verifyStage(created.stage,ownURL,'Crossfeed Wake '+nonce);caseResult.initial_own_navigation=true;
    await waitFor(async()=>{
      const q=await evalOwn(sw,'chrome.tabs.get('+created.tabId+').then(t=>({id:t.id,windowId:t.windowId,url:t.url,pendingUrl:t.pendingUrl,title:t.title,status:t.status}))');
      check(q.id===created.tabId&&q.windowId===created.id,'tab_ownership_changed');
      return verifyStage(q,ownURL,'Crossfeed Wake '+nonce);
    },5000);
    const matches=(await targets()).filter(t=>t.type==='page'&&t.url===ownURL);
    check(matches.length===1,'candidate_target_not_unique');caseResult.unique_target=true;
    const ownTarget=matches[0], page=await attach(ownTarget);
    const loaded=await evalOwn(page,'({same:location.href==='+JSON.stringify(ownURL)+',ready:document.readyState==="complete",ua:navigator.userAgent})');
    check(loaded?.same===true,'candidate_live_location_mismatch');caseResult.location_proved=true;
    check(loaded.ready===true,'candidate_document_not_ready');caseResult.dom_ready=true;
    check(/\bChrome\/[0-9]+/.test(loaded.ua)&&!loaded.ua.includes('HeadlessChrome'),'candidate_not_headed');
    caseResult.headed_ua=true;
    const dom=await evalOwn(page,'(()=>{const e=document.getElementById("editor"),b=document.getElementById("button");e.focus();e.value="offline";b.click();const r=e.getBoundingClientRect();return {focus:document.activeElement===e,clicked:document.getElementById("count").textContent==="1",layout:r.width>0&&r.height>0};})()');
    caseResult.editor_focus=dom.focus===true;caseResult.click=dom.clicked===true;caseResult.layout=dom.layout===true;
    check(caseResult.editor_focus&&caseResult.click&&caseResult.layout,'candidate_dom_function_failed');
    const current=(await targets()).filter(t=>t.targetId===ownTarget.targetId&&t.type==='page'&&t.url===ownURL);
    check(current.length===1,'candidate_target_changed_before_cleanup');
    await evalOwn(sw,'chrome.tabs.remove('+created.tabId+').then(()=>true)');
    await waitFor(async()=>{const windows=await evalOwn(sw,'chrome.windows.getAll({populate:true}).then(a=>a.map(w=>({id:w.id,tabs:w.tabs?.length})))');
      return windows.length===1&&windows[0].id===base[0].id&&windows[0].tabs===1;},4500);
    caseResult.tab_closed=true;caseResult.anchor_retained=true;
    statusClean();
  }
  result.decision='candidate_supported_pending_full_cleanup_and_native_coverage';
}
try{await main();}
catch(e){result.reason=/^[a-z0-9_]+$/.test(e?.message||'')?e.message:'unexpected_experiment_failure';}
finally{
  try{if(cdp){await cdp.call('Browser.close',{},undefined,2500);result.cleanup.browser_closed=true;}}catch{}
  try{cdp?.close();}catch{}
  if(brave){
    await sleep(900);
    if(alive(brave.pid)&&browserGroupVerified&&ownPGID(brave.pid,'--user-data-dir='+profile)){
      try{process.kill(-brave.pid,'SIGTERM');}catch{}await sleep(650);
    }
    if(!alive(brave.pid))result.cleanup.browser_closed=true;
    else result.cleanup.browser_closed=false;
  }
  if(xserver){
    // Kill exclusively the spawned Xvfb group after checking the exact authenticated server argv and exe.
    let own=false;
    try{own=fs.realpathSync('/proc/'+xserver.pid+'/exe')===xvfb&&processArgv(xserver.pid).includes(auth);}catch{}
    if(own&&xserverGroupVerified)try{process.kill(-xserver.pid,'SIGTERM');}catch{}
    await sleep(550);
    result.cleanup.xserver_closed=!alive(xserver.pid);
  }
  result.observer.alive_during_cleanup=!!listener&&!listenerClosed;
  if(listener){
    if(!listenerClosed){try{listener.kill('SIGTERM');}catch{}}
    const start=Date.now();while(!listenerClosed&&Date.now()-start<6500)await sleep(120);
    result.cleanup.listener_closed=listenerClosed;
  }
  let sample=null;
  try{sample=JSON.parse(fs.readFileSync(path.join(observer,'summary.json'),'utf8')).native_background?.sampling??null;}catch{}
  const n=nativeStats();
  result.native={...n,summary_sampling_healthy:sample?.healthy===true,
    summary_sampling_gaps:sample?.gaps??null,summary_sampling_ticks:sample?.ticks??null};
  if(result.cleanup.browser_closed&&result.cleanup.xserver_closed){
    try{await fsp.rm(profile,{recursive:true,force:true});result.cleanup.profile_removed=!fs.existsSync(profile);}catch{}
    try{for(const p of [auth,emptyAuth,path.join(run,'wrong-authority')])await fsp.rm(p,{force:true});result.cleanup.auth_removed=!fs.existsSync(auth);}catch{}
  }
  const nativeClean=n.added===0&&n.closed===0&&n.changed===0&&n.activation===0&&n.attention===0&&n.heartbeats>=2&&n.heartbeats===n.healthy&&n.gaps===0&&n.unknown===0&&n.overflow===0&&sample?.healthy===true&&sample?.gaps===0;
  const clean=Object.values(result.cleanup).every(Boolean)&&result.observer.alive_during_cleanup;
  if(result.decision==='candidate_supported_pending_full_cleanup_and_native_coverage'){
    result.decision=nativeClean&&clean&&result.cases.length===2&&result.cases.every(c=>Object.values(c).every(v=>typeof v==='number'||v===true))?
      'bounded_private_fixture_supports_virtual_headed_candidate':'indeterminate_native_coverage_or_cleanup';
    if(result.decision!=='bounded_private_fixture_supports_virtual_headed_candidate')result.reason='native_coverage_or_cleanup_not_clean';
  }
  try{fs.writeFileSync(path.join(run,'result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});}catch{}
  console.log(JSON.stringify(result));
}
