import test from 'node:test';
import assert from 'node:assert/strict';
import { prefillModel } from '../extension/prefill-model.ts';

const globals: any = globalThis;
const ticket = () => ({nonce:'a'.repeat(32),label:'wake-'+'a'.repeat(32),connector:'Crossfeed Chat',row:'Latest',level:2,expires_at:Date.now()+60000});
const prompt = (t:ReturnType<typeof ticket>) => `@${t.connector} wake up. First gateway_exchange: worker_label=${JSON.stringify(t.label)} exactly as issued, wake_nonce=${JSON.stringify(t.nonce)}, maximum_wait_seconds=20. Then use the server-returned worker_label and repeat wake_nonce=${JSON.stringify(t.nonce)} on all subsequent gateway_exchange calls. Poll until state=released and continue=false; do not send a final chat reply between jobs. Return local caller tools as structured tool_calls through gateway_exchange; do not execute them natively.`;
function fixture(options:Record<string,any>={}) {
  let modelReads=0, statusReads=0, sliderReads=0, hitReads=0;
  const node=(value='',attrs:Record<string,string>={}):any=>({textContent:value,isConnected:true,getClientRects:()=>[1],closest:()=>null,getAttribute:(name:string)=>attrs[name]??null,querySelectorAll:()=>[],getBoundingClientRect:()=>({x:10,y:20,width:40,height:30}),click:()=>assert.fail('page proof must not synthesize click'),dispatchEvent:()=>assert.fail('page proof must not synthesize pointer input')});
  let rowReads=0;
  const row=node(options.row??'Latest',{'aria-checked':'true'});
  if(options.rowLagReads) Object.defineProperty(row,'textContent',{get:()=>++rowReads<=options.rowLagReads?options.staleRow:options.row??'Latest'});
  const rows=options.rows?options.rows.map((r:any)=>{const el=node(r.text,r.checked?{'aria-checked':'true'}:{'aria-checked':'false'});if(r.hidden)el.getClientRects=()=>[];return el;}):options.duplicateRow?[row,row]:[row];
  const slider=node('',{'aria-valuemin':options.minimum??'0','aria-valuemax':options.maximum??'2','aria-valuenow':options.position??'2','data-reasoning-slider':'true'});
  const toggle=node('Select model',{'data-model-picker-view-toggle':'true'});
  const status=node(options.status??'High, 3 of 3.');
  const menu=node();menu.querySelectorAll=(selector:string)=>selector==='[role="menuitemradio"]'?rows:selector==='[data-reasoning-slider="true"]'?(options.noSlider?[]:[slider]):selector==='[data-model-picker-view-toggle="true"]'?(options.viewToggle?[toggle]:[]):selector==='[role="slider"]'?(options.noSlider?[]:[(++sliderReads <= (options.positionLagReads??0) ? {...slider,getAttribute:(name:string)=>name==='aria-valuenow'?options.stalePosition:slider.getAttribute(name)} : slider)]):selector==='[role="status"]'?[(status.textContent=++statusReads <= (options.statusLagReads??0) ? options.staleStatus : options.status??'High, 3 of 3.',status)]:[];
  const model=node('',options.disabled?{'aria-disabled':'true'}:{});
  const getAttribute=model.getAttribute; model.getAttribute=(name:string)=>name==='aria-disabled'&&modelReads<=(options.disabledReads??0)?'true':getAttribute(name);
  const child=node(), obstruction=node(); model.contains=(el:any)=>el===model||el===child;
  const doc:any={activeElement:null,elementFromPoint:()=>options.occluded||++hitReads<=(options.occludedReads??0)?obstruction:options.hitChild?child:model,querySelectorAll:(selector:string)=>{
    if(selector.includes('model-switcher')) {
      options.onModelRead?.();
      return options.noModel || ++modelReads <= (options.delayedModelReads ?? 0) ? [] : options.duplicateModel?[model,model]:[model];
    }
    if(selector==='[data-model-picker-view-toggle="true"]') return options.viewToggle&&options.open!==false?[toggle]:[];
    return selector==='[role="menu"]'&&options.open!==false?(options.duplicateMenu?[menu,menu]:[menu]):[];
  }};
  slider.focus=()=>{if(!options.focusRefused)doc.activeElement=slider;};
  return doc;
}
async function run(options:Record<string,any>={},fn=prefillModel) {
  const t={...ticket(),level:options.level??2},keys=['document','location'],previous=keys.map(k=>Object.getOwnPropertyDescriptor(globalThis,k));
  globals.document=fixture(options);globals.location={href:options.url??'https://chatgpt.com/?q='+encodeURIComponent(prompt(t))};
  try {return await fn(t,options.expectedMaximum??2,options.timeoutMs??10,1,options.action??'observe');}
  finally {keys.forEach((key,i)=>previous[i]?Object.defineProperty(globalThis,key,previous[i]!):delete globals[key]);}
}
test('configured prefill re-observes the host-opened exact row and High2 without page input',async()=>{
  assert.deepEqual(await run(),{verified:true,row:'Latest',level:2,maximum:2});
});
test('configured model proof waits for the picker trigger after the composer has hydrated',async()=>{
  assert.deepEqual(await run({delayedModelReads:2,timeoutMs:500}),{verified:true,row:'Latest',level:2,maximum:2});
});
test('configured Pro proof requires host-opened menu, never synthesizes pointer/click input',async()=>{
  const pro={level:4,expectedMaximum:4,position:'4',maximum:'4',status:'Pro, 5 of 5.'};
  assert.equal((await run({...pro,open:false})).verified,false);
  assert.deepEqual(await run(pro),{verified:true,row:'Latest',level:4,maximum:4});
});
test('configured model pointer target is read-only, unique and pinned to the authorized URL',async()=>{
  assert.deepEqual(await run({action:'point',open:false,delayedModelReads:2,timeoutMs:500}),{verified:false,ready:true,modelPoint:{x:30,y:35},open:false});
  assert.equal((await run({action:'point',open:true})).open,true);
  for(const options of [{duplicateModel:true},{duplicateMenu:true},{disabled:true},{url:'https://evil.example/'}])
    assert.notEqual((await run({...options,action:'point'})).ready,true);
});
test('point waits for a transiently disabled hydrated trigger without dispatching input',async()=>{
  assert.equal((await run({action:'point',open:false,disabledReads:2,timeoutMs:500})).ready,true);
});
test('point waits for an occluder to clear and accepts only the trigger or its descendant hit',async()=>{
  assert.notEqual((await run({action:'point',open:false,occluded:true})).ready,true);
  assert.equal((await run({action:'point',open:false,occludedReads:2,hitChild:true,timeoutMs:500})).ready,true);
});

test('configured Pro proof waits for the native picker announcement to catch up',async()=>{
  assert.deepEqual(await run({level:4,expectedMaximum:4,position:'4',maximum:'4',status:'Pro, 5 of 5.',statusLagReads:2,staleStatus:'Extra High, 4 of 5.',timeoutMs:500}),{verified:true,row:'Latest',level:4,maximum:4});
});
test('configured native proof waits for a hydrated old thumb to settle to the requested level',async()=>{
  assert.deepEqual(await run({positionLagReads:2,stalePosition:'1',timeoutMs:500}),{verified:true,row:'Latest',level:2,maximum:2});
});
test('configured native proof waits for a hydrated default row to settle to the saved row',async()=>{
  assert.deepEqual(await run({rowLagReads:3,staleRow:'Other',positionLagReads:3,stalePosition:'1',timeoutMs:500}),{verified:true,row:'Latest',level:2,maximum:2});
});
test('configured native proof refuses a row that never settles within the proof budget',async()=>{
  const result=await run({row:'Other',timeoutMs:50});
  assert.equal(result.verified,false);
  assert.equal(result.error,'level_unconfirmed');
  assert.equal(result.diagnostic?.rowMatches,false);
});
test('pointer acquisition waits up to the native hydration budget, without extending exact model proof',async t=>{
  let clock=Date.now(); t.mock.method(Date,'now',()=>clock);
  const options={delayedModelReads:7,timeoutMs:15000,onModelRead:()=>{clock+=1000;}};
  assert.equal((await run({...options,action:'point',open:false})).ready,true);
  assert.equal((await run(options)).verified,false); // Observe still has its strict five-second budget.
});
test('disabled model target failures retain bounded counts for diagnosis',async()=>{
  assert.deepEqual((await run({action:'point',disabled:true})).diagnostic,{action:'point',models:1,menus:1,enabled:false});
});
test('configured model proof refuses when the trigger stays missing',async()=>{
  assert.equal((await run({noModel:true})).verified,false);
});
test('configured model proof is self-contained when serialized for executeScript',async()=>{
  const serialized=new Function('return ('+prefillModel.toString()+')')();
  assert.equal((await run({},serialized)).verified,true);
});
test('configured prefill refuses wrong row, level, bounds, status and ambiguous controls',async()=>{
  for(const options of [{row:'Other'},{position:'1'},{minimum:'1'},{maximum:'4'},{status:'High, 3 of 5.'},{duplicateRow:true},{duplicateModel:true},{duplicateMenu:true},{disabled:true}])
    assert.equal((await run(options)).verified,false,JSON.stringify(options));
});
test('configured model proof refuses foreign or extra-query URLs',async()=>{
  for(const url of ['https://evil.example/','https://chatgpt.com/?q=other','https://chatgpt.com/?q=x&model=x','https://chatgpt.com/?temporary-chat=true','https://chatgpt.com/c/existing'])
    assert.equal((await run({url})).verified,false);
});

// From 23 Nov 2026 ChatGPT re-applies a default row at level 4 on each fresh
// document, so the native document must re-select the saved row and level.
test('select reports the saved row and view targets and the slider, without page input',async()=>{
  const result=await run({action:'select',rows:[{text:'GPT-6.2',checked:true},{text:'Latest'}],viewToggle:true,position:'4',maximum:'4',expectedMaximum:4,status:'Pro, 5 of 5.'});
  assert.equal(result.verified,false);assert.equal(result.open,true);
  assert.deepEqual(result.selection,{row:false,rowPoint:{x:30,y:35},viewPoint:{x:30,y:35},minimum:0,maximum:4,position:4,status:'Pro, 5 of 5.'});
  const saved=await run({action:'select',rows:[{text:'GPT-6.2'},{text:'Latest',checked:true}]});
  assert.equal(saved.selection?.row,true);assert.equal(saved.selection?.viewPoint,null);
});
test('select gives no row target for a hidden or ambiguous saved row, and reports a closed menu',async()=>{
  assert.equal((await run({action:'select',rows:[{text:'Other',checked:true},{text:'Latest',hidden:true}]})).selection?.rowPoint,null);
  assert.equal((await run({action:'select',rows:[{text:'Latest',checked:true},{text:'Latest'}]})).selection?.rowPoint,null);
  assert.equal((await run({action:'select',rows:[{text:'Latest',checked:true},{text:'Latest'}]})).selection?.row,false);
  const closed=await run({action:'select',open:false});
  assert.equal(closed.open,false);assert.equal(closed.selection,undefined);
});
test('select and sliderFocus refuse foreign or changed URLs',async()=>{
  for(const action of ['select','sliderFocus']) for(const url of ['https://evil.example/','https://chatgpt.com/?q=other','https://chatgpt.com/'+'?q=x&model=x']) {
    const result=await run({action,url});
    assert.equal(result.selection,undefined);assert.notEqual(result.focused,true);
  }
});
test('sliderFocus focuses only the open menu reasoning slider',async()=>{
  assert.equal((await run({action:'sliderFocus'})).focused,true);
  assert.notEqual((await run({action:'sliderFocus',focusRefused:true})).focused,true);
  assert.notEqual((await run({action:'sliderFocus',noSlider:true})).focused,true);
  assert.notEqual((await run({action:'sliderFocus',open:false})).focused,true);
});
