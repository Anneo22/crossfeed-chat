import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { attachment, PART_BYTES } from '../src/files.ts';

// An opt-in acceptance caller. It never starts or changes a server or writes fixtures.
const {values} = parseArgs({options:{'api-port':{type:'string',default:'4319'},'job-deadline-ms':{type:'string',default:'1800000'},label:{type:'string'},image:{type:'string'},audio:{type:'string'},file:{type:'string'}}});
try {
  const port=Number(values['api-port']), deadlineMs=Number(values['job-deadline-ms']);
  if (!Number.isInteger(port)||port<1||port>65535||!Number.isSafeInteger(deadlineMs)||deadlineMs<1||deadlineMs>86400000||!values.label||!values.image||!values.audio||!values.file||!process.env.CROSSFEED_API_KEY) throw Error();
  const read=async (filename: string)=>{
    const stat=await fs.stat(filename);
    if(!stat.isFile()||stat.size<1||stat.size>PART_BYTES) throw Error();
    return (await fs.readFile(filename)).toString('base64');
  };
  const content=[
    {type:'text',text:'Inspect the three attachments. Describe the picture, transcribe the audio, and quote the unique marker from the text file. Do not guess any attachment you cannot perceive; state which one is unavailable. Create crossfeed-result.txt containing your observations and return that generated document through gateway_exchange files with your text response.'},
    {type:'image_url',image_url:{url:'data:application/octet-stream;base64,'+await read(values.image)}},
    {type:'input_audio',input_audio:{data:await read(values.audio),format:path.extname(values.audio).toLowerCase()==='.mp3'?'mp3':'wav'}},
    {type:'file',file:{filename:path.basename(values.file),file_data:await read(values.file)}},
  ];
  content.slice(1).forEach(part=>attachment(part));
  const base=`http://127.0.0.1:${port}`,headers={Authorization:`Bearer ${process.env.CROSSFEED_API_KEY}`};
  // fetch has a separate five-minute headers timeout, even with a longer signal.
  // The job may legitimately take longer; bound headers and body by its deadline.
  const response=await new Promise<{status: number; body: string}>((resolve,reject)=>{
    const request=http.request(base+'/v1/chat/completions',{method:'POST',headers:{...headers,'Content-Type':'application/json','Idempotency-Key':'live-'+randomUUID()},signal:AbortSignal.timeout(deadlineMs)},(res: any)=>{
      const chunks: Uint8Array[]=[];
      res.on('data',(chunk: Uint8Array)=>chunks.push(chunk));
      res.on('error',reject);
      res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString('utf8')}));
    });
    request.on('error',reject);
    request.end(JSON.stringify({model:'chatgpt:'+values.label,messages:[{role:'user',content}]}));
  });
  if(response.status<200||response.status>=300) {console.error(`Completion refused: HTTP ${response.status}`);process.exitCode=1;}
  else {
    const result=JSON.parse(response.body);console.log(result.choices[0].message.content);
    if(!result.files?.length) {console.error('No generated file returned. File-output acceptance failed.');process.exitCode=1;}
    for(const file of result.files??[]) {
      const downloaded=await fetch(base+`/v1/files/${file.id}/content`,{headers,signal:AbortSignal.timeout(30000)});
      if(!downloaded.ok) throw Error();const bytes=Buffer.from(await downloaded.arrayBuffer());
      if(bytes.length!==file.bytes) throw Error();
      console.log(`Returned file: ${file.name}, ${file.mime}, ${bytes.length} bytes`);
      if(file.mime==='text/plain') console.log(bytes.toString('utf8'));
    }
    console.log('Compare the observations with your unseen fixture facts; transport success alone does not prove perception.');
  }
} catch {
  console.error('Acceptance request failed. Supply --label, --image, --audio, --file, optional --api-port and --job-deadline-ms (matching the server), and the API key in your environment; check fixture formats, sizes, job deadline and server availability.');
  process.exitCode=1;
}
