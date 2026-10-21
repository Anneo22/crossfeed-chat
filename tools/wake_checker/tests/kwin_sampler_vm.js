// Offline Node VM regression. No GUI/DBus process or private browser.
'use strict';
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert';
const source = fs.readFileSync(process.argv[2], 'utf8')
  .replace('__SERVICE__', JSON.stringify('org.test.Checked'))
  .replace('__OBJECT__', JSON.stringify('/org/test/Checked'))
  .replace('__INTERFACE__', JSON.stringify('org.test.Observer'))
  .replace('__TTL_MS__', '1500');
let clock = 0;
class Signal {
  constructor(){ this.subscribers=[]; }
  connect(f){ this.subscribers.push(f); }
  emit(...args){ for(const f of this.subscribers) f(...args); }
}
function window(name='brave-browser', active=false, activities=[]) {
  return {
    resourceClass:name, caption:'private window title', active,
    minimized:false, desktops:['desk-secret'], onAllDesktops:false,
    activities, onAllActivities:false, keepAbove:false, keepBelow:false,
    demandsAttention:false,
    captionChanged:new Signal(), resourceClassChanged:new Signal(),
    activeChanged:new Signal(), minimizedChanged:new Signal(),
    desktopsChanged:new Signal(), activitiesChanged:new Signal(),
    demandsAttentionChanged:new Signal(), propertyChanged:new Signal()
    // KeepAboveChanged absent on purpose: property availability != signals.
  };
}
const old = window();
old.caption='Prior private title';
const order=[old];
let enumeration=0;
const workspace = {
  activeWindow:old, currentDesktop:'desk-secret', currentActivity:'activity-secret',
  stackingOrder:order, windowList:()=>{ enumeration++; return order.slice(); },
  windowAdded:new Signal(), windowRemoved:new Signal(),
  windowActivated:new Signal(), currentDesktopChanged:new Signal(),
  currentActivityChanged:new Signal()
  // No stackingOrderChanged signal (as observed on actual KWin).
};
const timers = [];
class QTimer {
  constructor(){ this.timeout=new Signal(); this.running=false; }
  start(){ this.running=true; timers.push(this); }
  stop(){ this.running=false; }
}
const packets=[];
const callDBus = (svc,path,iface,method,text) => {
  assert.equal(svc,'org.test.Checked'); assert.equal(method,'Push');
  assert(text.length<2048); packets.push(JSON.parse(text));
};
vm.runInNewContext(source, {workspace, QTimer, callDBus,
  Date:{now:()=>clock}, JSON, RegExp}, {timeout:3000});
const sample=timers.find(t=>t.interval===50);
const heartbeat=timers.find(t=>t.interval===1000);
const ttl=timers.find(t=>t.interval===1500);
assert.equal(timers.length,3); assert(sample&&heartbeat&&ttl);
assert.equal(packets[0].event,'ready');
const caps=packets[0].capabilities;
assert.equal(caps.stacking,false);
assert.equal(caps.stacking_sampled,true);
assert.equal(caps.sampling_timer,true);
assert.equal(caps.property_active,true);
assert.equal(caps.active_changed,true);
assert.equal(caps.property_keep_above,true);
assert.equal(caps.keep_above_changed,false);
assert.equal(caps.property_on_current_activity,true);
assert.equal(enumeration,1);
function tick(ms){clock=ms; if(sample.running) sample.timeout.emit();}
function beat(ms){clock=ms; if(heartbeat.running) heartbeat.timeout.emit();}

// Initial active foreground must remain in the FIRST add, before hydration.
const first = window('',true);
first.caption='TopSecret private data';
workspace.windowActivated.emit(first);
workspace.windowAdded.emit(first);
const added=packets.find(x=>x.event==='window_added'&&x.window==='w2');
assert(added); assert.equal(added.active,true);
assert.equal(added.browser,false); assert.equal(added.wake_marker,false);
first.active=false; first.activeChanged.emit();
first.resourceClass='brave-browser'; first.resourceClassChanged.emit();
first.caption='Crossfeed Wake '+'a'.repeat(32); first.captionChanged.emit();
assert(packets.some(x=>x.window==='w2'&&x.event==='window_changed'&&
  x.browser===true&&x.wake_marker===true));
assert.equal(added.active,true); // no first-state overwrite

// No stacking signal: only targeted sampler notices a stack-only exposure.
order.push(first); tick(50);
assert(packets.some(x=>x.window==='w2'&&x.event==='window_changed'&&
  x.above_previous===true&&x.active===false));
assert.equal(enumeration,1); // never re-enumerate workspace on a timer

// Per-window activeChanged captures shorter-than-tick activation episodes.
first.active=true; first.activeChanged.emit();
first.active=false; first.activeChanged.emit();
const changes=packets.filter(x=>x.window==='w2'&&x.event==='window_changed');
assert(changes.some(x=>x.active===true));
assert.equal(changes[changes.length-1].active,false);

// PropertyChanged fallback and attention/topmost without signal availability.
first.keepAbove=true; first.propertyChanged.emit();
assert.equal(packets[packets.length-1].keep_above,true);
first.keepBelow=true; first.propertyChanged.emit();
assert.equal(packets[packets.length-1].keep_below,true);
first.demandsAttention=true; first.demandsAttentionChanged.emit();
assert.equal(packets[packets.length-1].demands_attention,true);

// Empty KWin activities means all; missing activity support remains UNKNOWN.
const all=window('brave-browser',false,[]);
workspace.windowAdded.emit(all);
assert.equal(packets[packets.length-1].on_current_activity,true);
const unsupported=window('brave-browser',false,undefined);
delete unsupported.activities;
delete unsupported.onAllActivities;
workspace.windowAdded.emit(unsupported);
assert.equal(packets[packets.length-1].on_current_activity,null);
const other=window('brave-browser',false,['different-activity']);
workspace.windowAdded.emit(other);
assert.equal(packets[packets.length-1].on_current_activity,false);
workspace.currentActivity=undefined;
other.propertyChanged.emit();
assert.equal(packets[packets.length-1].on_current_activity,null);

// A delayed sample gap is measurable and never healthy negative coverage.
tick(100); tick(400); beat(400);
const health=packets[packets.length-1].sampling;
assert.equal(health.interval_ms,50);
assert(health.ticks>=3);
assert(health.gaps>=1);
assert.equal(health.healthy,false);
assert(health.candidates>=1);
workspace.windowRemoved.emit(first);
assert.equal(packets[packets.length-1].event,'window_closed');
assert(packets[packets.length-1].window_sampling.gaps>=1);
assert.equal(packets[packets.length-1].window_sampling.complete,false);
tick(450); beat(450);
assert.equal(packets[packets.length-1].sampling.candidates,3);
assert.equal(enumeration,1);
// A separate fully sampled lifetime has its own terminal coverage counters;
// older candidates' global ticks/gaps cannot be imputed to this window.
const clean=window('brave-browser',false);
workspace.windowAdded.emit(clean);
const cleanAdd=packets[packets.length-1];
assert.equal(cleanAdd.window_sampling.ticks,0);
assert.equal(cleanAdd.window_sampling.complete,false);
tick(500); tick(550); tick(600);
workspace.windowRemoved.emit(clean);
const cleanClose=packets[packets.length-1];
assert.equal(cleanClose.event,'window_closed');
assert.equal(cleanClose.window_sampling.ticks,3);
assert.equal(cleanClose.window_sampling.gaps,0);
assert.equal(cleanClose.window_sampling.complete,true);
const text=JSON.stringify(packets);
for(const forbidden of ['TopSecret','Prior private','brave-browser',
                        'desk-secret','activity-secret','different-activity'])
  assert(!text.includes(forbidden), forbidden);
clock=1501; if(sample.running)sample.timeout.emit();
assert(timers.every(t=>!t.running));
const length=packets.length;
workspace.windowAdded.emit(window());
tick(1600); beat(1600);
assert.equal(packets.length,length);
console.log('offline sampler VM: property/signal separation, 50ms stack, no leakage, gap and TTL OK');
