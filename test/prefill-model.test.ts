import test from 'node:test';
import assert from 'node:assert/strict';
import { prefillModel } from '../extension/prefill-model.ts';

const globals: any = globalThis;
const ticket = () => ({nonce:'a'.repeat(32),label:'wake-'+'a'.repeat(32),connector:'Crossfeed Chat',row:'Latest',level:2,expires_at:Date.now()+60000});
const prompt = (t:ReturnType<typeof ticket>) => `@${t.connector} wake up. First gateway_exchange: worker_label=${JSON.stringify(t.label)} exactly as issued, wake_nonce=${JSON.stringify(t.nonce)}, maximum_wait_seconds=20. Then use the server-returned worker_label and repeat wake_nonce=${JSON.stringify(t.nonce)} on all subsequent gateway_exchange calls. Poll until state=released and continue=false; do not send a final chat reply between jobs. Return local caller tools as structured tool_calls through gateway_exchange; do not execute them natively.`;
function fixture(options:Record<string,any>={}) {
  let open=false, clicks=0;
  const node=(value='',attrs:Record<string,string>={}):any=>({textContent:value,isConnected:true,getClientRects:()=>[1],closest:()=>null,getAttribute:(name:string)=>attrs[name]??null,querySelectorAll:()=>[]});
  const row=node(options.row??'Latest',{'aria-checked':'true'});
  const slider=node('',{'aria-valuemin':options.minimum??'0','aria-valuemax':options.maximum??'2','aria-valuenow':options.position??'2'});
  const status=node(options.status??'High, 3 of 3.');
  const menu=node();menu.querySelectorAll=(selector:string)=>selector==='[role="menuitemradio"]'?(options.duplicateRow?[row,row]:[row]):selector==='[role="slider"]'?[slider]:selector==='[role="status"]'?[status]:[];
  const model=node('',options.disabled?{'aria-disabled':'true'}:{});
  model.click=()=>{clicks++;open=!open;if(options.foreignAfterClick)globals.location.href='https://evil.example/';};
  const doc={querySelectorAll:(selector:string)=>selector.includes('model-switcher')?(options.duplicateModel?[model,model]:[model]):selector==='[role="menu"]'&&open?(options.duplicateMenu?[menu,menu]:[menu]):[]};
  return {doc,clicks:()=>clicks};
}
async function run(options:Record<string,any>={},fn=prefillModel) {
  const t=ticket(),f=fixture(options),keys=['document','location'],previous=keys.map(k=>Object.getOwnPropertyDescriptor(globalThis,k));
  globals.document=f.doc;globals.location={href:options.url??'https://chatgpt.com/?q='+encodeURIComponent(prompt(t))};
  try {return {result:await fn(t,2,10,1),clicks:f.clicks()};}
  finally {keys.forEach((key,i)=>previous[i]?Object.defineProperty(globalThis,key,previous[i]!):delete globals[key]);}
}
test('configured prefill re-observes the exact selected row and High2 of three, without changing it',async()=>{
  assert.deepEqual(await run(),{result:{verified:true,row:'Latest',level:2,maximum:2},clicks:2});
});
test('configured model proof is self-contained when serialized for executeScript',async()=>{
  const serialized=new Function('return ('+prefillModel.toString()+')')();
  assert.equal((await run({},serialized)).result.verified,true);
});
test('configured prefill refuses wrong row, level, bounds, status and ambiguous controls',async()=>{
  for(const options of [{row:'Other'},{position:'1'},{minimum:'1'},{maximum:'4'},{status:'High, 3 of 5.'},{duplicateRow:true},{duplicateModel:true},{duplicateMenu:true},{disabled:true}]) {
    const {result}=await run(options);assert.equal(result.verified,false,JSON.stringify(options));
  }
});
test('configured model proof refuses foreign or extra-query URLs before touching picker',async()=>{
  for(const url of ['https://evil.example/','https://chatgpt.com/?q=other','https://chatgpt.com/?q=x&model=x','https://chatgpt.com/?temporary-chat=true','https://chatgpt.com/c/existing']) {
    const value=await run({url});assert.equal(value.result.verified,false);assert.equal(value.clicks,0);
  }
});
test('navigation during model proof refuses and does not toggle a foreign document',async()=>{
  const value=await run({foreignAfterClick:true});assert.equal(value.result.verified,false);assert.equal(value.clicks,1);
});
