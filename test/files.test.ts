import { tempPrefix } from './temp.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
type ClaimedExchange = Extract<Awaited<ReturnType<import('../src/gateway.ts').Gateway['exchange']>>, {request: unknown}>;
import fs from 'node:fs';
import https from 'node:https';
import dns from 'node:dns';
import {EventEmitter} from 'node:events';
import { Files, PART_BYTES, REQUEST_BYTES, attachment, sniff, downloadHTTPS } from '../src/files.ts';
import { Gateway, validateRequest } from '../src/gateway.ts';
import { nonce } from '../src/security.ts';
import type { TextPart, Attachment } from '../src/types.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jgekAAAAASUVORK5CYII=', 'base64');
const image = () => ({type:'image_url',image_url:{url:`data:image/wrong;base64,${png.toString('base64')}`}});
const file = (name='note.txt',data=Buffer.from('known document content')) => ({type:'file',file:{filename:name,file_data:data.toString('base64')}});
const input = (content: any) => ({model:'chatgpt:sol',messages:[{role:'user',content}]});
function store(t: import('node:test').TestContext,options: Record<string, any> = {}) {
  const directory = fs.mkdtempSync(tempPrefix('crossfeed-files-'));
  t.after(() => fs.rmSync(directory,{recursive:true,force:true}));
  return {directory,files:new Files(directory,options)};
}
function gateway(t: import('node:test').TestContext, files: any,options: Record<string, any> = {}) {
  const g = new Gateway({prefix:'chatgpt',labels:{sol:{row:'Latest',level:2}},...options.config},{files,pollMs:2,timeoutMs:5000,...options});
  t.after(() => g.close()); return g;
}
test('content normalization sniffs image/audio/files and never trusts caller MIME', () => {
  const wav=Buffer.alloc(44); wav.write('RIFF'); wav.write('WAVE',8);
  const r=validateRequest(input([{type:'text',text:'Look'},image(),{type:'input_audio',input_audio:{format:'wav',data:wav.toString('base64')}},file()]),'chatgpt');
  assert.deepEqual((r.messages[0].content as (TextPart | Attachment)[]).map((p: any)=>p.mime),[undefined,'image/png','audio/wav','text/plain']);
  assert(!JSON.stringify(r).includes(png.toString('base64')));
  assert.equal(sniff(Buffer.from('%PDF-1.7\n')),'application/pdf');
  assert.equal(sniff(Buffer.from([0,1,2])),'application/octet-stream');
});
test('remote URLs, malformed bytes, mismatched audio, traversal, excess parts and sizes are refused', () => {
  for (const part of [
    {type:'image_url',image_url:{url:'https://example.com/private'}},
    {type:'image_url',image_url:{url:'data:image/png;base64,eA=='}},
    {type:'input_audio',input_audio:{data:png.toString('base64'),format:'mp3'}},
    file('../secret'),file('sub/name'),file('bad\nname'),file('..'),file(''),
    {type:'file',file:{filename:'x',file_data:'eA='}},
    {type:'attachment',kind:'file',name:'x',mime:'text/plain',bytes:1,sha256:'x'.repeat(43)},
  ]) assert.throws(()=>validateRequest(input([part]),'chatgpt'));
  assert.throws(()=>validateRequest(input(Array.from({length:11},image)),'chatgpt'),e=>e.status===413);
  const large=Buffer.alloc(PART_BYTES+1,0);
  assert.throws(()=>attachment(file('big',large)),e=>e.status===413);
  const within=Buffer.alloc(18*1024*1024,0);
  assert.throws(()=>validateRequest(input([file('a',within),file('b',within),file('c',within)]),'chatgpt'),e=>e.status===413);
  assert.equal(REQUEST_BYTES,50*1024*1024);
});
test('private input storage, native MCP blocks and finish cleanup keep payloads out of job state',async t=>{
  const f=store(t); let state;
  const g=gateway(t,f.files,{save:(value: any)=>{state=value;}});
  await g.exchange('client',{worker_label:'sol'});
  const wav=Buffer.alloc(44);wav.write('RIFF');wav.write('WAVE',8);
  const content=[image(),file(),{type:'input_audio',input_audio:{data:wav.toString('base64'),format:'wav'}}];
  const pending=g.submit(input(content),'retry-input');
  const job=[...g.jobs.values()][0];
  const descriptors=f.files.descriptors(job);
  assert.equal(descriptors.length,3);
  for(const d of descriptors) { assert.equal(fs.statSync(d.path).mode&0o777,0o600); assert.equal(fs.statSync(f.directory+'/files').mode&0o777,0o700); }
  assert(!JSON.stringify(state).includes(png.toString('base64')));
  assert(!JSON.stringify(state).includes(f.directory));
  assert.strictEqual(g.submit(input(content),'retry-input'),pending);
  assert.equal(f.files.rows.length,3);
  const blocks=f.files.blocks(job);
  assert.deepEqual(blocks.map((b: any)=>b.type),['image','resource','resource','audio','resource']);
  assert.deepEqual(blocks[0],{type:'image',mimeType:'image/png',data:png.toString('base64')});
  assert.deepEqual(blocks[3],{type:'audio',mimeType:'audio/wav',data:wav.toString('base64')});
  for (const [block, descriptor, bytes] of [[blocks[1],descriptors[0],png],[blocks[2],descriptors[1],Buffer.from('known document content')],[blocks[4],descriptors[2],wav]] as [Extract<(typeof blocks)[number],{resource:unknown}>,(typeof descriptors)[number],Buffer][]) {
    assert.equal(block.resource.uri,`crossfeed-file://${descriptor.id}/${encodeURIComponent(descriptor.name)}`);
    assert.equal(block.resource.mimeType,descriptor.mime);
    assert.deepEqual(Buffer.from(block.resource.blob,'base64'),bytes);
  }
  const work=await g.exchange('client',{worker_label:'sol'}); assert.ok(work.state === 'request');
  await g.exchange('client',{worker_label:'sol',request_id:work.request.request_id,claim_token:work.request.claim_token,response:'answer'});
  await pending; assert.equal(f.files.rows.length,0); assert(descriptors.every((d: any)=>!fs.existsSync(d.path)));
});
test('PDF, Office, OpenDocument and text documents retain names, MIME and exact embedded bytes across restart',t=>{
  const f=store(t),owner=nonce(),zip=Buffer.from([80,75,3,4,0,1]),ole=Buffer.from([208,207,17,224,161,177,26,225,0,1]);
  const documents: [string, Buffer, string][] = [
    ['report final.pdf',Buffer.from('%PDF-1.7\n'),'application/pdf'],
    ['report.DOCX',zip,'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['sheet.xlsx',zip,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['slides.pptx',zip,'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ['report.odt',zip,'application/vnd.oasis.opendocument.text'],
    ['sheet.ods',zip,'application/vnd.oasis.opendocument.spreadsheet'],
    ['slides.odp',zip,'application/vnd.oasis.opendocument.presentation'],
    ['report.doc',ole,'application/msword'],['sheet.xls',ole,'application/vnd.ms-excel'],['slides.ppt',ole,'application/vnd.ms-powerpoint'],
    ['report.rtf',Buffer.from('{\\rtf1 document}'),'application/rtf'],
    ['table.csv',Buffer.from('a,b\n1,2'),'text/csv'],['note.md',Buffer.from('# Notes'),'text/markdown'],
    ['page.html',Buffer.from('<p>Notes</p>'),'text/html'],['page.htm',Buffer.from('<p>Notes</p>'),'text/html'],
    ['data.xml',Buffer.from('<notes/>'),'application/xml'],['data.json',Buffer.from('{"notes":1}'),'application/json'],
    ['note.txt',Buffer.from('Notes'),'text/plain'],['archive.zip',zip,'application/zip'],['unknown.bin',Buffer.from([0,1,2]),'application/octet-stream'],
  ];
  for(const [name,bytes,mime] of documents) {
    assert.equal(attachment(file(name,bytes)).mime,mime);
    assert.equal(f.files.put(owner,'input',name,bytes,Date.now()+5000).mime,mime);
  }
  const restored=new Files(f.directory),blocks=restored.blocks({id:owner}) as Extract<ReturnType<Files['blocks']>[number],{resource:unknown}>[];
  assert.equal(blocks.length,documents.length);
  for(const [i,[name,bytes,mime]] of documents.entries()) {
    assert.equal(blocks[i].type,'resource');assert.equal(blocks[i].resource.mimeType,mime);
    assert.equal(new URL(blocks[i].resource.uri).pathname,`/${encodeURIComponent(name)}`);
    assert.deepEqual(Buffer.from(blocks[i].resource.blob,'base64'),bytes);
  }
  // Extensions refine a compatible container; they never override a known signature.
  assert.equal(sniff(png,'report.docx'),'image/png');
  assert.equal(sniff(Buffer.from('plain text'),'report.docx'),'text/plain');
  assert.equal(sniff(Buffer.from([0,1,2]),'report.pdf'),'application/octet-stream');
  assert.equal(sniff(zip,'report.doc'),'application/zip');assert.equal(sniff(ole,'report.docx'),'application/octet-stream');
});
test('queued keyed input survives restart and cancellation/TTL removes files',async t=>{
  let now=Date.now(); const f=store(t,{now:()=>now});let state;
  const g=gateway(t,f.files,{now:()=>now,save:(s: any)=>{state=s;}});
  await g.exchange('client',{worker_label:'sol'});
  const pending=g.submit(input([image()]),'restart'); g.close(); await assert.rejects(pending);
  const files=new Files(f.directory,{now:()=>now});
  const next=gateway(t,files,{now:()=>now,records:state});
  const replay=next.submit(input([image()]),'restart'); const job=[...next.jobs.values()][0]; assert.equal(files.descriptors(job).length,1);
  now=job.deadline+1; next.prune(); files.prune(); await assert.rejects(replay); assert.equal(files.rows.length,0);
});
test('composer exact claims cannot steal normal polling work and release after their one job',async t=>{
  const f=store(t); let composed: any;
  const g=gateway(t,f.files,{config:{attachment_delivery:'composer'},composer:(job: any)=>{composed=job;}});
  await g.exchange('client',{worker_label:'sol'});
  const normal=g.submit(input('normal work')); const special=g.submit(input([image()]));
  assert.equal(composed.delivery,'composer');
  const work=await g.exchange('client',{worker_label:'sol'}); assert.ok(work.state === 'request'); assert.equal(work.request.messages[0].content,'normal work');
  const worker=g.workers.get('sol');
  const exact=await g.exchange('client',{worker_label:'sol',request_id:composed.id}); assert.ok(exact.state === 'request'); assert.equal(exact.request.request_id,composed.id); assert.equal(g.workers.get('sol'),worker); assert.equal(worker!.active!.request.messages[0].content,'normal work');
  const done=await g.exchange('client',{worker_label:'sol',request_id:exact.request.request_id,claim_token:exact.request.claim_token,response:'image answer'});
  assert.equal(done.state,'released'); await special;
  const workers=g.workers.size;
  await g.exchange('client',{worker_label:'sol',request_id:exact.request.request_id,claim_token:exact.request.claim_token,response:'image answer'});
  assert.equal(g.workers.size,workers,'a completed one-shot retry never retains another worker');
  await g.exchange('client',{worker_label:'sol',request_id:work.request.request_id,claim_token:work.request.claim_token,response:'normal answer'}); await normal;
  await assert.rejects(g.exchange('client',{worker_label:'sol',request_id:'unknown'}));
});
test('user labels beginning composer: remain routable and cannot collide with temporary worker keys',async t=>{
  const f=store(t),g=gateway(t,f.files);
  await g.exchange('client',{worker_label:'composer:research'});
  assert.equal(g.status().find(w=>w.label==='composer:research')!.awake,true);
  const request={model:'chatgpt:composer:research',messages:[{role:'user',content:'normal'}]};
  const pending=g.submit(request);const work=(await g.exchange('client',{worker_label:'composer:research'}) as ClaimedExchange).request;
  await g.exchange('client',{worker_label:'composer:research',request_id:work.request_id,claim_token:work.claim_token,response:'answer'});
  assert.equal((await pending).choices[0].message.content,'answer');
});
test('an active one-shot claim preserves connector ownership even without a normal polling worker',async t=>{
  const f=store(t),g=gateway(t,f.files,{config:{attachment_delivery:'composer'}});
  const pending=g.submit(input([image()]));const job=[...g.jobs.values()][0];
  const work=(await g.exchange('client',{worker_label:'sol',request_id:job.id}) as ClaimedExchange).request;
  await assert.rejects(g.exchange('other',{worker_label:'sol'}),e=>e.status===409);
  await g.exchange('client',{worker_label:'sol',request_id:work.request_id,claim_token:work.claim_token,response:'answer'});await pending;
});
test('duplicate image and file names get deterministic unique disk names across all messages',async t=>{
  const f=store(t),g=gateway(t,f.files,{config:{attachment_delivery:'composer'}});
  const request=input([image(),image(),file('attachment.png'),file('note.txt'),file('note.txt')]);
  const normalized=validateRequest(request,'chatgpt');
  assert.deepEqual((normalized.messages[0].content as (TextPart | Attachment)[]).map((p: any)=>p.name),['attachment.png','attachment-2.png','attachment-3.png','note.txt','note-2.txt']);
  const pending=g.submit(request,'duplicate-names');const job=[...g.jobs.values()][0];
  assert.deepEqual(f.files.descriptors(job).map((p: any)=>p.name),(normalized.messages[0].content as (TextPart | Attachment)[]).map((p: any)=>p.name));
  assert.strictEqual(g.submit(request,'duplicate-names'),pending);
  g.finish(job,new Error('cancel') as Parameters<Gateway['finish']>[1]);await assert.rejects(pending);
});
test('a cleanup failure settles the committed answer and stops new work instead of hanging callers',async t=>{
  const f=store(t),g=gateway(t,f.files);await g.exchange('client',{worker_label:'sol'});
  const pending=g.submit(input([image()]),'cleanup-failure');const work=(await g.exchange('client',{worker_label:'sol'}) as ClaimedExchange).request;
  const original=f.files.removeOwner.bind(f.files);f.files.removeOwner=()=>{throw Error('ledger unavailable');};
  await assert.rejects(g.exchange('client',{worker_label:'sol',request_id:work.request_id,claim_token:work.claim_token,response:'committed'}),e=>e.code==='attachment_cleanup_failed');
  assert.equal((await pending).choices[0].message.content,'committed');assert.equal(g.closed,true);
  f.files.removeOwner=original;
});
test('returned files download once, sniff MIME, replay and expire',async t=>{
  let now=Date.now(),downloads=0;
  const f=store(t,{now:()=>now,download:async()=>{downloads++;return{status:200,data:png};}});
  const g=gateway(t,f.files,{now:()=>now});await g.exchange('client',{worker_label:'sol'});
  const pending=g.submit(input('make image'),'output');const work=(await g.exchange('client',{worker_label:'sol'}) as ClaimedExchange).request;
  const args={worker_label:'sol',request_id:work.request_id,claim_token:work.claim_token,response:'Here',files:[{download_url:'https://example.com/signed',file_id:'file-test',file_name:'output.png',mime_type:'text/plain'}]};
  await g.exchange('client',args);const result=await pending;
  assert.equal(result.choices[0].message.content,'Here');assert.equal(result.files![0].mime,'image/png');assert.equal(result.files![0].bytes,png.length);
  assert(!JSON.stringify(result).includes('signed'));
  assert.deepEqual(f.files.output(result.files![0].id).data,png);
  await g.exchange('client',args);assert.equal(downloads,1);
  now+=600001;assert.throws(()=>f.files.output(result.files![0].id),e=>e.status===404);
});
test('download timeout errors are redacted and HTTPS redirects are bounded',async t=>{
  const owner={id:nonce(),finished:false};
  const f=store(t,{download:async()=>({status:302,location:'http://localhost/private',data:Buffer.alloc(0)})});
  await assert.rejects(f.files.outputs(owner,[{download_url:'https://example.com/a',file_id:'f'}]),e=>e.status===400);
  f.files.download=async()=>({status:302,location:'/again',data:Buffer.alloc(0)});
  await assert.rejects(f.files.outputs(owner,[{download_url:'https://example.com/a',file_id:'f'}]));
  f.files.download=async()=>{throw Error('signed-secret-url');};
  await assert.rejects(f.files.outputs(owner,[{download_url:'https://example.com/a',file_id:'f'}]),e=>e.code==='file_download_failed'&&!e.message.includes('secret'));
  for(const url of ['http://example.com/a','https://127.0.0.1/a','https://[::1]/a','https://user:pass@example.com/a','https://example.com:444/a']) await assert.rejects(downloadHTTPS(url));
});
test('download transport never receives IPv4 or IPv6 literals or private DNS answers',async t=>{
  let calls=0;
  t.mock.method(https,'get',(_url: any,options: any)=>{
    calls++;const request=new EventEmitter();
    queueMicrotask(()=>options.lookup('example.com',{all:true},(error: any)=>{assert(error);request.emit('error',error);}));
    return request;
  });
  for(const address of ['https://127.0.0.1/a','https://[::1]/a','https://[::ffff:127.0.0.1]/a','https://[fe80::1]/a']) await assert.rejects(downloadHTTPS(address));
  assert.equal(calls,0,'literal URLs must be rejected before TLS creation');
  let answers: any[] = [];
  t.mock.method(dns,'lookup',(_host: any,_options: any,done: any)=>done(null,answers));
  for(const address of ['127.0.0.1','10.1.2.3','169.254.169.254','172.16.0.1','192.168.1.1','100.64.0.1','::1','fd00::1','fe80::1','::ffff:127.0.0.1','2002:7f00:1::','2001:0:1::','2001::1','2001:0db8::1']) {
    answers=[{address:'1.1.1.1',family:4},{address,family:address.includes(':')?6:4}];
    await assert.rejects(downloadHTTPS('https://example.com/file'));
  }
});
test('partial returned-file batches roll back and ended jobs cannot publish files',async t=>{
  const f=store(t,{download:async()=>({status:200,data:Buffer.from('result')})});const owner={id:nonce(),finished:false};
  await assert.rejects(f.files.outputs(owner,[{download_url:'https://example.com/a',file_id:'f'}, {download_url:'http://example.com/b',file_id:'g'}]));assert.equal(f.files.rows.length,0);
  owner.finished=true; await assert.rejects(f.files.outputs(owner,[{download_url:'https://example.com/a',file_id:'f'}]));assert.equal(f.files.rows.length,0);
  f.files.download=async()=>({status:200,data:Buffer.alloc(PART_BYTES+1)});owner.finished=false;
  await assert.rejects(f.files.outputs(owner,[{download_url:'https://example.com/a',file_id:'f'}]),e=>e.status===413);
});
test('the aggregate returned-file cap rolls back an otherwise valid batch',async t=>{
  const bytes=Buffer.alloc(18*1024*1024);
  const f=store(t,{download:async()=>({status:200,data:bytes})});
  await assert.rejects(f.files.outputs({id:nonce(),finished:false},[1,2,3].map(n=>({download_url:'https://example.com/'+n,file_id:'file'+n}))),e=>e.status===413);
  assert.equal(f.files.rows.length,0);assert.deepEqual(fs.readdirSync(f.directory+'/files'),[]);
});
test('a caller cancellation aborts the download batch and rolls back earlier files',async t=>{
  const controller=new AbortController();let calls=0,signal;
  const f=store(t,{download:async(_url: any,options: any)=>{
    calls++;signal=options.signal;
    if(calls===2) controller.abort();
    return{status:200,data:Buffer.from('result')};
  }});
  await assert.rejects(f.files.outputs({id:nonce(),finished:false},[
    {download_url:'https://example.com/first',file_id:'one'},
    {download_url:'https://example.com/second',file_id:'two'},
  ],controller.signal));
  assert.equal(signal!.aborted,true);assert.equal(f.files.rows.length,0);
});
test('attachment file permissions, changed bytes and symlink directories fail closed',t=>{
  const f=store(t);const row=f.files.put(nonce(),'input','file.txt',Buffer.from('data'),Date.now()+1000);const location=f.files.path(row);
  fs.chmodSync(location,0o644);assert.throws(()=>f.files.read(row));fs.chmodSync(location,0o600);
  fs.writeFileSync(location,'evil');assert.throws(()=>f.files.read(row));
  const second=fs.mkdtempSync(tempPrefix('crossfeed-file-link-'));t.after(()=>fs.rmSync(second,{recursive:true,force:true}));fs.symlinkSync(f.directory+'/files',second+'/files');
  assert.throws(()=>new Files(second));
});
