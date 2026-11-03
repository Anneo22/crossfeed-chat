import test from 'node:test';
import assert from 'node:assert/strict';
import { prefillModel } from '../extension/prefill-model.ts';

const globals: any = globalThis;
const ticket = () => ({nonce:'a'.repeat(32),label:'wake-'+'a'.repeat(32),connector:'Crossfeed Chat',row:'Latest',level:2,expires_at:Date.now()+60000});
const prompt = (t:ReturnType<typeof ticket>) => `@${t.connector} wake up. First gateway_exchange: worker_label=${JSON.stringify(t.label)} exactly as issued, wake_nonce=${JSON.stringify(t.nonce)}, maximum_wait_seconds=20. Then use the server-returned worker_label and repeat wake_nonce=${JSON.stringify(t.nonce)} on all subsequent gateway_exchange calls. Poll until state=released and continue=false; do not send a final chat reply between jobs. Return local caller tools as structured tool_calls through gateway_exchange; do not execute them natively.`;
function fixture(options:Record<string,any>={}) {
  let modelReads=0, statusReads=0, sliderReads=0;
  const node=(value='',attrs:Record<string,string>={}):any=>({textContent:value,isConnected:true,getClientRects:()=>[1],closest:()=>null,getAttribute:(name:string)=>attrs[name]??null,querySelectorAll:()=>[],getBoundingClientRect:()=>({x:10,y:20,width:40,height:30}),click:()=>assert.fail('page proof must not synthesize click'),dispatchEvent:()=>assert.fail('page proof must not synthesize pointer input')});
  const row=node(options.row??'Latest',{'aria-checked':'true'});
  const slider=node('',{'aria-valuemin':options.minimum??'0','aria-valuemax':options.maximum??'2','aria-valuenow':options.position??'2'});
  const status=node(options.status??'High, 3 of 3.');
  const menu=node();menu.querySelectorAll=(selector:string)=>selector==='[role="menuitemradio"]'?(options.duplicateRow?[row,row]:[row]):selector==='[role="slider"]'?[(++sliderReads <= (options.positionLagReads??0) ? {...slider,getAttribute:(name:string)=>name==='aria-valuenow'?options.stalePosition:slider.getAttribute(name)} : slider)]:selector==='[role="status"]'?[(status.textContent=++statusReads <= (options.statusLagReads??0) ? options.staleStatus : options.status??'High, 3 of 3.',status)]:[];
  const model=node('',options.disabled?{'aria-disabled':'true'}:{});
  const doc={querySelectorAll:(selector:string)=>{
    if(selector.includes('model-switcher')) {
      options.onModelRead?.();
      return options.noModel || ++modelReads <= (options.delayedModelReads ?? 0) ? [] : options.duplicateModel?[model,model]:[model];
    }
    return selector==='[role="menu"]'&&options.open!==false?(options.duplicateMenu?[menu,menu]:[menu]):[];
  }};
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
test('configured Pro proof waits for the native picker announcement to catch up',async()=>{
  assert.deepEqual(await run({level:4,expectedMaximum:4,position:'4',maximum:'4',status:'Pro, 5 of 5.',statusLagReads:2,staleStatus:'Extra High, 4 of 5.',timeoutMs:500}),{verified:true,row:'Latest',level:4,maximum:4});
});
test('configured native proof waits for a hydrated old thumb to settle to the requested level',async()=>{
  assert.deepEqual(await run({positionLagReads:2,stalePosition:'1',timeoutMs:500}),{verified:true,row:'Latest',level:2,maximum:2});
});
test('pointer acquisition waits up to the native hydration budget, without extending exact model proof',async t=>{
  let clock=Date.now(); t.mock.method(Date,'now',()=>clock);
  const options={delayedModelReads:7,timeoutMs:15000,onModelRead:()=>{clock+=1000;}};
  assert.equal((await run({...options,action:'point',open:false})).ready,true);
  assert.equal((await run(options)).verified,false); // Observe still has its strict five-second budget.
});
test('disabled model target failures retain bounded counts for diagnosis',async()=>{
  assert.deepEqual((await run({action:'point',disabled:true})).diagnostic,{action:'point',models:1,menus:1});
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
