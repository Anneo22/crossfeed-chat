import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {kwinWakeFocusScript} from '../src/wake-focus.ts';

const mark = 'a'.repeat(32);
function signal() {
  const callbacks = new Set<(...args: any[]) => void>();
  return {connect(f: (...args:any[]) => void) {callbacks.add(f);},
    disconnect(f: (...args:any[]) => void) {callbacks.delete(f);},
    emit(...args:any[]) {for (const cb of [...callbacks]) cb(...args);}};
}
function setup() {
  let now = 100, active: any, desktop='desk', activity='activity';
  const previous: any = {resourceClass:'konsole',normalWindow:true};
  active=previous;
  const windows: any[]=[previous], restores: any[]=[];
  const added=signal(), activated=signal(), removed=signal(), desktopChanged=signal(), activityChanged=signal();
  const workspace = {
    get activeWindow() {return active;},
    set activeWindow(w:any) {restores.push(w); active=w;},
    get currentDesktop() {return desktop;},
    get currentActivity() {return activity;},
    windowList:()=>windows.slice(), windowAdded:added, windowActivated:activated,
    windowRemoved:removed, currentDesktopChanged:desktopChanged, currentActivityChanged:activityChanged,
  };
  vm.runInNewContext(kwinWakeFocusScript(mark), {workspace, Date:{now:()=>now}});
  const make = (caption='unmarked') => ({resourceClass:'brave-browser', normalWindow:true, caption, captionChanged:signal()});
  return {previous,restores,make, get active() {return active;},
    add(w:any) {windows.push(w);added.emit(w);},
    activate(w:any) {active=w;activated.emit(w);},
    preactivate(w:any) {active=w;},
    caption(w:any) {w.caption='Crossfeed Wake '+mark;w.captionChanged.emit();},
    switchUser() {const user={resourceClass:'konsole',normalWindow:true};active=user;activated.emit(user);},
    expire() {now+=4001;},
    switchDesktop() {desktop='other';desktopChanged.emit();},
    switchActivity() {activity='other';activityChanged.emit();},
  };
}
test('unmarked added then activated stays foreground until exact marker hydrates',()=>{
  const f=setup(), w=f.make();f.add(w);f.activate(w);
  assert.equal(f.active,w);assert.equal(f.restores.length,0);
  f.caption(w);assert.equal(f.active,f.previous);assert.deepEqual(f.restores,[f.previous]);
});
test('pre-add activation and late caption leave an active interval',()=>{
  const f=setup(),w=f.make();f.activate(w);f.add(w);
  assert.equal(f.active,w);assert.equal(f.restores.length,0);
  f.caption(w);assert.equal(f.active,f.previous);
});
test('already marked and active on addition restores only after initial activation',()=>{
  const f=setup(),w=f.make('Crossfeed Wake '+mark);
  f.preactivate(w);assert.equal(f.active,w);f.add(w);
  assert.deepEqual(f.restores,[f.previous]);
});
test('late marker beyond 4s cannot restore',()=>{
  const f=setup(),w=f.make();f.add(w);f.activate(w);f.expire();f.caption(w);
  assert.equal(f.active,w);assert.equal(f.restores.length,0);
});
test('user switch and context changes cancel restore rather than stealing focus',()=>{
  for(const which of ['user','desktop','activity']) {
    const f=setup(),w=f.make();f.add(w);f.activate(w);
    if(which==='user')f.switchUser();
    else if(which==='desktop')f.switchDesktop();
    else f.switchActivity();
    f.caption(w);assert.equal(f.restores.length,0,which);
  }
});
test('duplicate pre-add browser activation is a hypothetical cancellation edge',()=>{
  const f=setup(),a=f.make();f.activate(a);f.activate(a);f.add(a);f.caption(a);
  assert.equal(f.restores.length,0);
});
test('observer: missing resourceClassChanged signal does NOT mean resourceClass absent',()=>{
  let now=0;
  class Timer {
    timeout=signal();interval=0;
    setSingleShot(_value:boolean) {}
    start() {}
    stop() {}
  }
  const old:any={resourceClass:'konsole',caption:'prior',active:true};
  const window:any={resourceClass:'brave-browser',caption:'Crossfeed Wake '+mark,
    active:true,minimized:false,desktops:['desk'],activities:[],onAllDesktops:false,
    onAllActivities:false,keepAbove:false,keepBelow:false,demandsAttention:false,
    captionChanged:signal(),activeChanged:signal(),propertyChanged:signal()};
  const order=[old];
  const workspace:any={activeWindow:old,currentDesktop:'desk',currentActivity:'activity',
    stackingOrder:order,windowList:()=>order.slice(), windowAdded:signal(),windowRemoved:signal(),
    windowActivated:signal(),currentDesktopChanged:signal(),currentActivityChanged:signal()};
  const packets:any[]=[];
  const observer=fs.readFileSync('tools/wake_checker/kwin_observer.js','utf8')
    .replace('__SERVICE__',JSON.stringify('org.test.Observer'))
    .replace('__OBJECT__',JSON.stringify('/org/test/Observer'))
    .replace('__INTERFACE__',JSON.stringify('org.test.Observer'))
    .replace('__TTL_MS__','1500');
  vm.runInNewContext(observer,{workspace,QTimer:Timer,callDBus:(_s:any,_p:any,_i:any,_m:any,json:string)=>packets.push(JSON.parse(json)),
    Date:{now:()=>now},JSON,RegExp});
  order.push(window);workspace.windowAdded.emit(window);
  const candidate=packets.find(p=>p.event==='window_added'&&p.browser===true&&p.wake_marker===true);
  assert(candidate,'marker/browser independently read from property values');
  const capabilityPacket=packets.find(p=>p.capabilities?.resource_class===false);
  assert(capabilityPacket,'resource_class capability tracks missing change signal, not property value');
});
