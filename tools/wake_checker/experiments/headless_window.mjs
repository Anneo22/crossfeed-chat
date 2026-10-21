// MANUAL, FINITE HEADLESS EXPERIMENT ONLY. Never import into production or tests.
// Launches only /usr/bin/brave with a fresh throwaway profile; no real user profile access.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';

if(process.argv.length!==3||!/^[a-z0-9-]{1,24}$/.test(process.argv[2]))throw Error('fresh_suffix_required');
const cwd=process.cwd(),base=path.resolve(cwd,'.review-context/native-focus');
const fixture=path.join(base,'fixture'), lane='headless-'+process.argv[2];
const profile=path.join(base,'profile-'+lane), observerDir=path.join(base,'observer-'+lane);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function insist(ok,code){if(!ok)throw Error(code);}
function wait(check,ms=7000){return (async()=>{const start=Date.now();while(Date.now()-start<ms){const value=await check();if(value)return value;await sleep(120);}throw Error('deadline_expired');})();}
function desktopEvents(){try{return fs.readFileSync(path.join(observerDir,'events.jsonl'),'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(x=>x.kind==='desktop');}catch{return [];}}
function nativeStats(){
 const rows=desktopEvents();
 const added=rows.filter(x=>x.event==='window_added'&&x.baseline!==true);
 const activation=rows.filter(x=>x.activation_buffered===true||x.activation_observed===true||(x.event==='window_changed'&&x.current?.active===true));
 const attention=rows.filter(x=>x.event==='window_added'&&x.initial?.demands_attention===true||x.event==='window_changed'&&x.current?.demands_attention===true);
 const heartbeat=rows.filter(x=>x.event==='heartbeat');
 return {added:added.length,activation:activation.length,attention:attention.length,changed:rows.filter(x=>x.event==='window_changed').length,closed:rows.filter(x=>x.event==='window_closed'&&!x.baseline).length,heartbeat:heartbeat.length,healthy_heartbeats:heartbeat.filter(x=>x.sampling?.healthy===true&&x.capacity?.overflow===0&&x.capacity?.unknown===0).length,gaps:Math.max(0,...heartbeat.map(x=>x.sampling?.gaps??0)),max_gap_ms:Math.max(0,...heartbeat.map(x=>x.sampling?.max_gap_ms??0)),unknown:Math.max(0,...heartbeat.map(x=>x.capacity?.unknown??0)),overflow:Math.max(0,...heartbeat.map(x=>x.capacity?.overflow??0))};
}
class CDP {
 constructor(ws){this.ws=ws;this.pending=new Map();this.seq=0;ws.addEventListener('message',event=>{let data;try{data=JSON.parse(event.data);}catch{return;}const item=this.pending.get(data.id);if(!item)return;this.pending.delete(data.id);clearTimeout(item.timer);data.error?item.reject(Error('cdp_method_failed')):item.resolve(data.result||{});});}
 call(method,params={},sessionId,timeout=5500){return new Promise((resolve,reject)=>{const id=++this.seq,timer=setTimeout(()=>{this.pending.delete(id);reject(Error('cdp_deadline'));},timeout);this.pending.set(id,{resolve,reject,timer});this.ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});}
 close(){try{this.ws.close();}catch{}}
}
const result={case:'isolated_headless_new_ozone_headless',requested:{type:'normal',focused:false},profile_fresh:false,listener_ready_before_launch:false,listener_alive_at_browser_close:false,own_process:{launched_exact_binary:false,flags_verified:false,environment_display_absent:false,loopback_cdp:false},anchor:{normal:false,focused:false,one_window:false,one_active_tab:false},mv3_worker:false,attempted:0,cases:[],native:null,decision:'unsupported_or_blocked',reason:null,cleanup:{browser_close_sent:false,browser_group_gone:false,observer_finished:false,profile_removed:false}};
let brave,listener,cdp,sw,extension,listenerClosed=false,braveClosed=false,groupVerified=false;
function ownedProcessGroup(){
 if(!brave?.pid)return false;
 try {const lines=execFileSync('/usr/bin/ps',['-o','args=','-g',String(brave.pid)],{timeout:2000,encoding:'utf8'}).split('\n');
 return lines.some(line=>line.includes('--user-data-dir='+profile)&&line.includes('--headless=new')&&line.includes('--ozone-platform=headless'));
 }catch{return false;}
}
async function connect(){
 const entry=await wait(async()=>{
  try{const raw=(await fsp.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).trim().split('\n'),port=Number(raw[0]);
  return port>=1024&&port<=65535&&/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(raw[1])?{port,route:raw[1]}:null;}catch{return null;}
 },14000);
 const info=await(await fetch('http://127.0.0.1:'+entry.port+'/json/version',{signal:AbortSignal.timeout(2500)})).json();
 insist(info.webSocketDebuggerUrl?.startsWith('ws://127.0.0.1:'+entry.port+'/devtools/browser/'),'foreign_cdp_endpoint');
 const ws=new WebSocket('ws://127.0.0.1:'+entry.port+entry.route);
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('ws_timeout')),5000);ws.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});ws.addEventListener('error',()=>{clearTimeout(timer);reject(Error('ws_failure'));},{once:true});});
 result.own_process.loopback_cdp=true;
 return new CDP(ws);
}
async function targets(){return (await cdp.call('Target.getTargets')).targetInfos||[];}
async function attach(target){
 const {sessionId}=await cdp.call('Target.attachToTarget',{targetId:target.targetId,flatten:true});
 try{await cdp.call('Runtime.runIfWaitingForDebugger',{},sessionId,1700);}catch{}
 await cdp.call('Runtime.enable',{},sessionId);return sessionId;
}
async function evaluate(session,expression){
 const r=await cdp.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},session,7000);
 insist(!r.exceptionDetails&&r.result?.subtype!=='error','own_realm_exception');
 return r.result?.value;
}
// Only a strictly identified OWN tab may await its initial committed URL; all other states abort.
function navigationStage(tab,expectedURL,expectedTitle){
 insist(tab&&['loading','complete'].includes(tab.status),'unknown_tab_navigation_status');
 const committed=tab.url??'',pending=tab.pendingUrl??'',title=tab.title??'';
 insist(pending===''||pending===expectedURL,'foreign_pending_url');
 insist(committed===''||committed==='about:blank'||committed===expectedURL,'foreign_committed_url');
 insist(committed===expectedURL ? (title===''||title==='Loading'||title===expectedTitle) : title==='','foreign_tab_title');
 if(committed===expectedURL&&tab.status==='complete')insist(title===expectedTitle,'completed_tab_title_mismatch');
 return {ready:committed===expectedURL&&tab.status==='complete'&&title===expectedTitle,wait_only:committed!==expectedURL||tab.status!=='complete'};
}
async function main(){
 insist(!fs.existsSync(profile)&&!fs.existsSync(observerDir),'existing_profile_or_capture');
 insist(fs.existsSync(path.join(fixture,'manifest.json'))&&fs.existsSync(path.join(fixture,'candidate.html')),'private_fixture_missing');
 const manifest=JSON.parse(fs.readFileSync(path.join(fixture,'manifest.json'),'utf8'));
 insist(manifest.manifest_version===3&&manifest.background?.service_worker==='worker.js','unexpected_fixture');
 const doctor=JSON.parse(execFileSync('python3',['-B','-m','tools.wake_checker','doctor'],{cwd,timeout:6000,encoding:'utf8'}));
 insist(doctor.native?.status==='ready'&&doctor.native?.backend==='kde-kwin','native_doctor_not_ready');
 // Listener MUST be healthy before any headless browser process exists.
 listener=spawn('python3',['-B','-m','tools.wake_checker','listen','--duration','40','--output',observerDir],{cwd,stdio:'ignore'});
 listener.on('exit',()=>{listenerClosed=true;});
 const ready=await wait(async()=>desktopEvents().find(x=>x.event==='ready'),6500);
 insist(ready.sampling?.healthy===true&&ready.capacity?.overflow===0&&ready.capacity?.unknown===0&&ready.capacity?.tracked>=1,'native_listener_unhealthy');
 result.listener_ready_before_launch=true;
 insist(!listenerClosed,'native_listener_exited_before_launch');
 result.profile_fresh=true;
 const childEnv={...process.env};for(const key of ['DISPLAY','WAYLAND_DISPLAY','WAYLAND_SOCKET'])delete childEnv[key];
 const args=['--user-data-dir='+profile,'--headless=new','--ozone-platform=headless','--load-extension='+fixture,'--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--no-first-run','--no-default-browser-check','--disable-background-networking','--new-window',pathToFileURL(path.join(fixture,'anchor.html')).href];
 brave=spawn('/usr/bin/brave',args,{cwd,env:childEnv,detached:true,stdio:'ignore'});
 brave.on('exit',()=>{braveClosed=true;});
 result.own_process.launched_exact_binary=true;
 await wait(async()=>{try{const cmd=fs.readFileSync('/proc/'+brave.pid+'/cmdline','utf8').split('\0');return cmd.includes('--headless=new')&&cmd.includes('--ozone-platform=headless')&&cmd.includes('--user-data-dir='+profile);}catch{return false;}},5500);
 const cmd=fs.readFileSync('/proc/'+brave.pid+'/cmdline','utf8').split('\0');
 groupVerified=ownedProcessGroup();
 insist(groupVerified&&cmd.includes('--remote-debugging-port=0')&&cmd.includes('--load-extension='+fixture),'own_process_flags_unverified');
 result.own_process.flags_verified=true;
 const envKeys=fs.readFileSync('/proc/'+brave.pid+'/environ','utf8').split('\0').map(x=>x.split('=')[0]);
 result.own_process.environment_display_absent=['DISPLAY','WAYLAND_DISPLAY','WAYLAND_SOCKET'].every(k=>!envKeys.includes(k));
 insist(result.own_process.environment_display_absent,'own_process_display_leak');
 cdp=await connect();
 const anchorURL=pathToFileURL(path.join(fixture,'anchor.html')).href;
 const owns=await wait(async()=>{const t=await targets();const anchor=t.find(x=>x.type==='page'&&x.url===anchorURL);
 const worker=t.find(x=>x.type==='service_worker'&&/^chrome-extension:\/\/[a-p]{32}\/worker\.js$/.test(x.url));return anchor&&worker?{anchor,worker}:null;},10000);
 const ownerWindow=await cdp.call('Browser.getWindowForTarget',{targetId:owns.anchor.targetId});
 insist(Number.isInteger(ownerWindow.windowId),'anchor_window_missing');
 extension=owns.worker.url.match(/^chrome-extension:\/\/([a-p]{32})\//)[1];
 sw=await attach(owns.worker);
 const apiAvailable=await evaluate(sw,'!!chrome.windows?.create&&!!chrome.tabs?.query&&!!chrome.runtime?.getURL');
 insist(apiAvailable===true,'headless_mv3_window_api_unsupported');
 result.mv3_worker=true;
 const base=await evaluate(sw,'chrome.windows.getAll({populate:true}).then(a=>a.map(w=>({id:w.id,normal:w.type==="normal",focused:w.focused===true,activeTabs:w.tabs?.filter(t=>t.active).length,tabCount:w.tabs?.length})))');
 const anchorId=base[0]?.id;
 result.anchor={normal:base.length===1&&base[0].normal,focused:base.length===1&&base[0].focused,one_window:base.length===1,one_active_tab:base[0]?.activeTabs===1&&base[0]?.tabCount===1};
 insist(Object.values(result.anchor).every(Boolean)&&Number.isInteger(anchorId),'headless_virtual_anchor_not_focused');
 // Stop before candidate if the headless startup produced unexpected desktop events.
 let stats=nativeStats();
 insist(stats.added===0&&stats.activation===0&&stats.attention===0&&stats.changed===0,'native_activity_during_startup');
 for(let index=0;index<2;index++){
  insist(!listenerClosed,'observer_stopped_before_candidate');
  const nonce=randomBytes(16).toString('hex');
  const localURL='chrome-extension://'+extension+'/candidate.html#'+nonce;
  const response=await evaluate(sw,'(async()=>{const u=chrome.runtime.getURL("candidate.html#'+nonce+'");const w=await chrome.windows.create({url:u,type:"normal",focused:false});const a=await chrome.tabs.query({windowId:w.id,active:true});const x=await chrome.windows.get(w.id,{populate:true});const t=a[0];return {id:w.id,tabId:t?.id,type:w.type,state:w.state,focused:w.focused,windowIdValid:Number.isInteger(w.id),tabIdValid:Number.isInteger(t?.id),tabWindowMatches:a.length===1&&t?.windowId===w.id,windowContainsTab:Array.isArray(x.tabs)&&x.tabs.length===1&&x.tabs[0].id===t?.id&&x.tabs[0].active===true,initial:t?{url:t.url,pendingUrl:t.pendingUrl,title:t.title,status:t.status}:null};})()');
  result.attempted++;
  const item={order:index+1,api:{normal:response?.type==='normal',focused_false:response?.focused===false,state:response?.state??null,valid_window_id:response?.windowIdValid===true,valid_tab_id:response?.tabIdValid===true,active_tab_window_match:response?.tabWindowMatches===true,own_window_contains_tab:response?.windowContainsTab===true},navigation:{initial_wait_only:false,initial_ready:false,exact_owned_tab_complete:false,polls:0},cdp_target_bound:false,cdp_window_id_match:false,location_attested:false,dom:null,tab_cleaned:false,isolated_anchor_restored:false};
  result.cases.push(item);
  insist(Object.values(item.api).every(v=>v===true||v==='normal'||v==='minimized'),'window_or_tab_ownership_fail');
  const expectedTitle='Crossfeed Wake '+nonce;
  const initial=navigationStage(response.initial,localURL,expectedTitle);
  item.navigation.initial_wait_only=initial.wait_only;
  item.navigation.initial_ready=initial.ready;
  // Re-read ONLY the returned tab/window IDs in this extension realm. A wrong pending
  // URL, title, window binding, extra tab or extra window stops instead of extending trust.
  await wait(async()=>{
   const snap=await evaluate(sw,'(async()=>{const [t,w,a,all]=await Promise.all([chrome.tabs.get('+response.tabId+'),chrome.windows.get('+response.id+',{populate:true}),chrome.tabs.query({windowId:'+response.id+',active:true}),chrome.windows.getAll({populate:true})]);return {tab:t,bound:t.id==='+response.tabId+'&&t.windowId==='+response.id+'&&t.active===true&&w.id==='+response.id+'&&w.type==="normal"&&w.focused===false&&w.tabs?.length===1&&w.tabs[0].id===t.id&&a.length===1&&a[0].id===t.id,anchor_intact:all.length===2&&all.some(v=>v.id==='+anchorId+'&&v.type==="normal"&&v.focused===true&&v.tabs?.length===1&&v.tabs[0].active===true)&&all.some(v=>v.id==='+response.id+')};})()');
   item.navigation.polls++;
   insist(snap?.bound&&snap?.anchor_intact,'owned_tab_window_binding_lost');
   const stage=navigationStage(snap.tab,localURL,expectedTitle);
   item.navigation.exact_owned_tab_complete=stage.ready;
   return stage.ready;
  },5000);
  // Only AFTER the exact tab completed its own URL do we enumerate CDP targets.
  const page=await wait(async()=>{const matches=(await targets()).filter(t=>t.type==='page'&&t.url===localURL);insist(matches.length<=1,'ambiguous_own_cdp_target');return matches[0]??null;},6000);
  item.cdp_target_bound=true;
  const targetWindow=await cdp.call('Browser.getWindowForTarget',{targetId:page.targetId});
  item.cdp_window_id_match=targetWindow.windowId===response.id;
  insist(item.cdp_window_id_match,'cdp_window_identity_mismatch');
  const session=await attach(page);
  item.location_attested=(await evaluate(session,'location.href'))===localURL;
  insist(item.location_attested,'own_candidate_location_mismatch');
  await wait(async()=>await evaluate(session,'document.readyState==="complete"&&document.title==="Crossfeed Wake "+location.hash.slice(1)'),4500);
  item.dom=await evaluate(session,'(()=>{const e=document.getElementById("editor"),b=document.getElementById("button");e.focus();e.value="offline";b.click();const r=e.getBoundingClientRect();return {ready:document.readyState==="complete",nonce_document_bound:document.title==="Crossfeed Wake "+location.hash.slice(1),editor_focused:document.activeElement===e,clicked:document.getElementById("count").textContent==="1",layout:r.width>0&&r.height>0};})()');
  insist(Object.values(item.dom).every(Boolean),'own_dom_interaction_failed');
  await sleep(1450);
  const stillOwn=(await targets()).filter(t=>t.type==='page'&&t.url===localURL);
  insist(stillOwn.length===1&&stillOwn[0].targetId===page.targetId,'own_target_disappeared_or_ambiguous');
  const beforeRemove=await evaluate(sw,'(async()=>{const t=await chrome.tabs.get('+response.tabId+'),w=await chrome.windows.get('+response.id+',{populate:true});return {tab:t,bound:t.windowId==='+response.id+'&&t.active===true&&w.type==="normal"&&w.tabs?.length===1&&w.tabs[0].id===t.id};})()');
  insist(beforeRemove.bound&&navigationStage(beforeRemove.tab,localURL,expectedTitle).ready,'own_tab_lost_before_cleanup');
  await evaluate(sw,'chrome.tabs.remove('+response.tabId+').then(()=>true)');
  await wait(async()=>{
   const v=await evaluate(sw,'Promise.all([chrome.tabs.query({}),chrome.windows.getAll({populate:true})]).then(([t,w])=>({absent:!t.some(x=>x.id==='+response.tabId+'),anchorOnly:w.length===1&&w[0].id==='+anchorId+'&&w[0].type==="normal"&&w[0].focused===true&&w[0].tabs?.length===1&&w[0].tabs[0].active===true}))');
   item.tab_cleaned=v.absent;item.isolated_anchor_restored=v.anchorOnly;return item.tab_cleaned&&item.isolated_anchor_restored;
  },4500);
  await sleep(250);
  stats=nativeStats();
  // Any native activity is unassigned interference: stop immediately.
  insist(stats.added===0&&stats.closed===0&&stats.activation===0&&stats.attention===0&&stats.changed===0,'native_activity_ambiguous_stop');
 }
 result.decision='candidate_supported_pending_native_coverage';
}
try{await main();}
catch(e){result.reason=/^[a-z0-9_]+$/.test(e?.message||'')?e.message:'unexpected_run_error';}
finally{
 result.listener_alive_at_browser_close=!!listener&&!listenerClosed;
 try{if(cdp){await cdp.call('Browser.close',{},undefined,2500);result.cleanup.browser_close_sent=true;}}catch{}
 try{cdp?.close();}catch{}
 if(brave){
  await sleep(900);
  if(ownedProcessGroup()) {try{process.kill(-brave.pid,'SIGTERM');}catch{}await sleep(750);}
  try{process.kill(-brave.pid,0);}catch{result.cleanup.browser_group_gone=true;}
 }
 if(listener){
  const start=Date.now();while(!listenerClosed&&Date.now()-start<30000)await sleep(150);
  if(!listenerClosed){try{listener.kill('SIGTERM');}catch{}await sleep(450);}
  result.cleanup.observer_finished=listenerClosed;
 }
 const stats=nativeStats(),rows=desktopEvents(),ready=rows.find(x=>x.event==='ready');
 let sampling;
 try{const summary=JSON.parse(fs.readFileSync(path.join(observerDir,'summary.json'),'utf8'));sampling=summary.native_background?.sampling??null;}catch{sampling=null;}
 result.native={ready_healthy:ready?.sampling?.healthy===true,ready_capacity_clean:ready?.capacity?.overflow===0&&ready?.capacity?.unknown===0,added:stats.added,closed:stats.closed,changed:stats.changed,activation:stats.activation,attention:stats.attention,heartbeats:stats.heartbeat,healthy_heartbeats:stats.healthy_heartbeats,heartbeat_gaps:stats.gaps,max_heartbeat_gap_ms:stats.max_gap_ms,overflow:stats.overflow,unknown:stats.unknown,summary_sampling_healthy:sampling?.healthy===true,summary_sampling_gaps:sampling?.gaps??null,summary_sampling_ticks:sampling?.ticks??null};
 if(result.cleanup.browser_group_gone){try{await fsp.rm(profile,{recursive:true,force:true});result.cleanup.profile_removed=true;}catch{}}
 const nativeClean=stats.added===0&&stats.changed===0&&stats.activation===0&&stats.attention===0&&stats.closed===0&&stats.heartbeat>=2&&stats.heartbeat===stats.healthy_heartbeats&&stats.gaps===0&&stats.unknown===0&&stats.overflow===0&&sampling?.healthy===true&&sampling?.gaps===0;
 const clean=Object.values(result.cleanup).every(Boolean)&&result.listener_alive_at_browser_close&&result.listener_ready_before_launch;
 if(result.decision==='candidate_supported_pending_native_coverage'){
  result.decision=nativeClean&&clean?'preventive_architecture_candidate_supported':'indeterminate_native_coverage_or_cleanup';
  if(result.decision!=='preventive_architecture_candidate_supported')result.reason='native_coverage_or_cleanup_incomplete';
 }
 console.log(JSON.stringify(result));
}
