import type { Attachment, FileDescriptor, FileRecord, JobRecord, Request } from './types.ts';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { check, Fault, hash, nonce, object, privateDirectory, readPrivate, writePrivate } from './security.ts';

export const PART_BYTES = 20 * 1024 * 1024;
export const REQUEST_BYTES = 50 * 1024 * 1024;
export const BODY_BYTES = 72 * 1024 * 1024;
const DATA = Symbol('attachment bytes');
type ByteAttachment = Attachment & { [DATA]?: Buffer };
interface DownloadResult { status: number; location?: string; data: Buffer }
interface DownloadOptions { signal?: AbortSignal; limit?: number }
type Download = (value: string, options?: DownloadOptions) => Promise<DownloadResult>;
interface RawPart { type: string; kind: string; name: string; sha256: string; bytes: number; mime: string; image_url: {url: string; detail?: string}; input_audio: {format: string; data: string}; file: {file_data: string; filename: string} }

const identifier = (x: unknown) => typeof x === 'string' && /^[A-Za-z0-9_-]{32}$/.test(x);
const filename = (value: unknown): string => {
  check(typeof value === 'string' && value.length > 0 && value === value.trim() && Buffer.byteLength(value) <= 180 && !/[\p{C}\/\\]/u.test(value) && !['.', '..'].includes(value), 'Invalid attachment filename');
  return value;
};
export function sniff(data: Buffer, name = ''): string {
  const extension = path.extname(name).toLowerCase();
  if (data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a/.test(data.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WAVE') return 'audio/wav';
  if (data.subarray(0, 3).toString() === 'ID3' || data[0] === 255 && (data[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  if (data.subarray(0, 4).toString() === 'OggS') return 'audio/ogg';
  if (data.subarray(0, 4).toString() === 'fLaC') return 'audio/flac';
  if (data.subarray(4, 8).toString() === 'ftyp' && /^(M4A |M4B )/.test(data.subarray(8, 12).toString())) return 'audio/mp4';
  if (data.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  if (data.subarray(0, 4).equals(Buffer.from([80,75,3,4]))) return ({
    '.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.odt':'application/vnd.oasis.opendocument.text',
    '.ods':'application/vnd.oasis.opendocument.spreadsheet',
    '.odp':'application/vnd.oasis.opendocument.presentation',
  } as Record<string, string>)[extension] ?? 'application/zip';
  if (data.subarray(0, 8).equals(Buffer.from([208,207,17,224,161,177,26,225]))) return ({
    '.doc':'application/msword', '.xls':'application/vnd.ms-excel', '.ppt':'application/vnd.ms-powerpoint',
  } as Record<string, string>)[extension] ?? 'application/octet-stream';
  if (data.subarray(0, 5).toString() === '{\\rtf') return 'application/rtf';
  const text = data.toString('utf8');
  if (!text.includes('\uFFFD') && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) return ({
    '.csv':'text/csv', '.md':'text/markdown', '.html':'text/html', '.htm':'text/html', '.xml':'application/xml', '.json':'application/json',
  } as Record<string, string>)[extension] ?? 'text/plain';
  return 'application/octet-stream';
}
function decode(input: unknown, dataURL = false) {
  let value = input as string;
  check(typeof value === 'string', 'Attachment must be base64');
  if (dataURL || value.startsWith('data:')) {
    const match = /^data:[a-zA-Z0-9.+/-]+;base64,([A-Za-z0-9+/]*={0,2})$/.exec(value);
    check(match, 'Use a base64 data URL, remote attachment URLs are refused'); value = match[1];
  }
  check(value.length > 0 && value.length <= Math.ceil(PART_BYTES / 3) * 4 && /^[A-Za-z0-9+/]*={0,2}$/.test(value) && value.length % 4 === 0, 'Invalid or oversized attachment base64', value.length > Math.ceil(PART_BYTES / 3) * 4 ? 413 : 400);
  const data = Buffer.from(value, 'base64');
  check(data.length > 0 && data.length <= PART_BYTES && data.toString('base64') === value, 'Invalid or oversized attachment base64', 413);
  return data;
}
export function attachment(value: unknown, stored = false): ByteAttachment {
  const part = value as RawPart;
  check(object(part), 'Invalid content part');
  if (stored && part.type === 'attachment') {
    check(['image', 'audio', 'file'].includes(part.kind) && typeof part.sha256 === 'string' && /^[A-Za-z0-9_-]{43}$/.test(part.sha256) && Number.isSafeInteger(part.bytes) && part.bytes > 0 && part.bytes <= PART_BYTES && typeof part.mime === 'string' && /^[a-z]+\/[a-z0-9.+-]+$/.test(part.mime), 'Invalid stored attachment', 500);
    filename(part.name); return part as ByteAttachment;
  }
  let kind: string; let data: Buffer; let name: string | undefined;
  if (part.type === 'image_url') {
    check(object(part.image_url) && Object.keys(part.image_url).every(k => ['url', 'detail'].includes(k)) && (part.image_url.detail === undefined || ['auto', 'low', 'high'].includes(part.image_url.detail)), 'Invalid image_url');
    kind = 'image'; data = decode(part.image_url.url, true);
  } else if (part.type === 'input_audio') {
    check(object(part.input_audio) && ['wav', 'mp3'].includes(part.input_audio.format), 'Audio format must be wav or mp3');
    kind = 'audio'; data = decode(part.input_audio.data);
    check(sniff(data) === (part.input_audio.format === 'wav' ? 'audio/wav' : 'audio/mpeg'), 'Audio bytes do not match the format');
  } else if (part.type === 'file') {
    check(object(part.file), 'Invalid file part'); kind = 'file'; data = decode(part.file.file_data); name = filename(part.file.filename);
  } else throw new Fault(400, 'invalid_request', 'Unsupported content part');
  const mime = sniff(data, name);
  check(kind !== 'image' || mime.startsWith('image/'), 'Image bytes are not a supported image');
  name ??= `attachment.${({'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp','audio/wav':'wav','audio/mpeg':'mp3'} as Record<string, string>)[mime] ?? 'bin'}`;
  const result: ByteAttachment = {type: 'attachment', kind, name, mime, bytes: data.length, sha256: hash(data)};
  Object.defineProperty(result, DATA, {value: data}); return result;
}
export const parts = (request: Request): ByteAttachment[] => request.messages.flatMap(m => Array.isArray(m.content) ? m.content.filter((p): p is ByteAttachment => p.type === 'attachment') : []);
export function uniqueName(name: string, names: Set<string>) {
  let result = name;
  const dot = name.lastIndexOf('.'), extension = dot > 0 ? name.slice(dot) : '';
  const stem = dot > 0 ? name.slice(0,dot) : name;
  for (let i = 2; names.has(result); i++) {
    let characters = Array.from(stem), ending = `-${i}${extension}`;
    // Very long extensions are treated as part of the stem.
    if (Buffer.byteLength(ending) > 100) { characters = Array.from(name); ending = `-${i}`; }
    while (Buffer.byteLength(characters.join('') + ending) > 180) characters.pop();
    result = characters.join('') + ending;
  }
  names.add(result); return result;
}

// Pin public DNS answers into the actual TLS connection; redirects get a fresh check.
function publicAddress(address: string) {
  if (net.isIP(address) === 4) {
    const [a,b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 || a === 198 && [18,19].includes(b));
  }
  // Only global IPv6 unicast; embedded IPv4 forms and local ranges are refused.
  return /^[23][0-9a-f]{3}:/i.test(address) && !/^2002:|^2001:(?:0{0,4}:|0?db8:)/i.test(address);
}
export function downloadHTTPS(value: string, {signal, limit = PART_BYTES}: DownloadOptions = {}): Promise<DownloadResult> {
  return new Promise<DownloadResult>((resolve, reject) => {
    let url;
    try { url = new URL(value); } catch { return reject(new Fault(400, 'invalid_request', 'Invalid returned file URL')); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port && url.port !== '443' || net.isIP(url.hostname.replace(/^\[|\]$/g,''))) return reject(new Fault(400, 'invalid_request', 'Returned files require a public HTTPS URL'));
    const req = https.get(url, {signal, lookup: (host: string, opts: {all?: boolean}, done: (error: Error | null, address?: string | {address: string; family: number}[], family?: number) => void) => dns.lookup(host, {...opts, all: true}, (err: Error | null, addresses: {address: string; family: number}[]) => {
      if (err || !addresses?.length || addresses.some(a => !publicAddress(a.address))) return done(new Error('Unsafe download address'));
      done(null, opts.all ? addresses : addresses[0].address, addresses[0].family);
    })}, (res: {statusCode: number; headers: {location?: string}; on(event: string, callback: (...args: Buffer[]) => void): void}) => {
      const chunks: Buffer[] = []; let size = 0;
      res.on('error', reject);
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) { req.destroy(new Fault(413, 'file_too_large', 'Returned file exceeds 20 MiB')); return; }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({status: res.statusCode, location: res.headers.location, data: Buffer.concat(chunks)}));
    });
    req.on('error', reject);
  });
}

export class Files {
  declare directory: string; declare root: string; declare now: () => number; declare download: Download; declare rows: FileRecord[];

  constructor(directory: string, {now = Date.now, download = downloadHTTPS}: {now?: () => number; download?: Download} = {}) {
    this.directory = directory; this.root = path.join(directory, 'files'); privateDirectory(this.root);
    this.now = now; this.download = download;
    this.rows = readPrivate<FileRecord[]>(directory, 'files.json', []);
    check(Array.isArray(this.rows) && this.rows.length <= 2560, 'Invalid file ledger', 500);
    for (const row of this.rows) { check(identifier(row.id) && identifier(row.owner) && ['input','output'].includes(row.kind) && Number.isSafeInteger(row.expires) && Number.isSafeInteger(row.bytes) && row.bytes > 0 && row.bytes <= PART_BYTES && typeof row.mime === 'string', 'Invalid file record', 500); filename(row.name); }
    this.prune();
    // Files not published to the atomic ledger are failed writes, safe to discard.
    for (const id of fs.readdirSync(this.root)) { check(identifier(id), 'Unexpected attachment directory', 500); if (!this.rows.some(r => r.id === id)) this.removeDisk(id); }
  }
  save() { writePrivate(this.directory, 'files.json', this.rows); }
  path(row: FileRecord) { privateDirectory(this.root); privateDirectory(path.join(this.root, row.id)); return path.join(this.root, row.id, row.name); }
  removeDisk(id: string) {
    const folder = path.join(this.root, id);
    const s = fs.lstatSync(folder, {throwIfNoEntry:false});
    if (!s) return;
    check(s.isDirectory() && !s.isSymbolicLink(), 'Unsafe attachment directory', 500);
    // Only this gateway's generated data is removed, never arbitrary user paths.
    fs.rmSync(folder, {recursive:true});
  }
  prune() {
    const expired = this.rows.filter(r => r.expires <= this.now());
    for (const row of expired) this.removeDisk(row.id);
    if (expired.length) { this.rows = this.rows.filter(r => r.expires > this.now()); this.save(); }
  }
  put(owner: string, kind: FileRecord['kind'], name: string, data: Buffer, expires: number) {
    this.prune(); filename(name);
    check(this.rows.length < 2560 && this.rows.reduce((n,r) => n+r.bytes,0)+data.length <= 512*1024*1024, 'Attachment storage is full', 429, 'storage_full');
    check(data.length > 0 && data.length <= PART_BYTES, 'Returned file exceeds 20 MiB', 413);
    const row: FileRecord = {id:nonce(),owner,kind,name,mime:sniff(data,name),bytes:data.length,sha256:hash(data),expires};
    fs.mkdirSync(path.join(this.root,row.id), {mode:0o700});
    try {
      fs.writeFileSync(this.path(row), data, {flag:'wx',mode:0o600});
      this.rows.push(row); this.save();
    } catch (error) { this.rows = this.rows.filter(r => r !== row); this.removeDisk(row.id); throw error; }
    return row;
  }
  inputs(job: JobRecord) {
    try { return parts(job.request).map(p => this.put(job.id,'input',p.name,p[DATA]!,Number.MAX_SAFE_INTEGER)); }
    catch (error) { this.removeOwner(job.id,'input'); throw error; }
  }
  removeOwner(owner: string, kind?: FileRecord['kind']) {
    const removed = this.rows.filter(r => r.owner === owner && (!kind || r.kind === kind));
    for (const row of removed) this.removeDisk(row.id);
    if (removed.length) { this.rows = this.rows.filter(r => !removed.includes(r)); this.save(); }
  }
  reconcile(jobs: ReadonlyMap<string, JobRecord>) {
    for (const row of [...this.rows]) if (!jobs.has(row.owner) || row.kind === 'input' && jobs.get(row.owner)!.finished || row.kind === 'output' && jobs.get(row.owner)!.state !== 'completed') this.removeOwner(row.owner,row.kind);
  }
  read(row: FileRecord) {
    const fd = fs.openSync(this.path(row), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const s = fs.fstatSync(fd); check(s.isFile() && !(s.mode & 0o077) && s.size === row.bytes && (!process.getuid || s.uid === process.getuid()), 'Unsafe attachment file', 500);
      const data = fs.readFileSync(fd); check(hash(data) === row.sha256, 'Attachment changed on disk', 500); return data;
    } finally { fs.closeSync(fd); }
  }
  descriptors(job: Pick<JobRecord, 'id'>) { return this.rows.filter(r => r.owner === job.id && r.kind === 'input').map(r => ({id:r.id,name:r.name,mime:r.mime,bytes:r.bytes,path:this.path(r)})); }
  blocks(job: Pick<JobRecord, 'id'>) {
    return this.rows.filter(r => r.owner === job.id && r.kind === 'input').flatMap(row => {
      const data = this.read(row).toString('base64');
      const resource = {type:'resource' as const,resource:{uri:`crossfeed-file://${row.id}/${encodeURIComponent(row.name)}`,mimeType:row.mime,blob:data}};
      const type = row.mime.startsWith('image/') ? 'image' : row.mime.startsWith('audio/') ? 'audio' : null;
      return type ? [{type,mimeType:row.mime,data},resource] : [resource];
    });
  }
  async outputs(job: Pick<JobRecord, 'id' | 'finished'>, values: unknown, callerSignal?: AbortSignal) {
    check(Array.isArray(values) && values.length > 0 && values.length <= 10, 'Return 1-10 files');
    const rows: FileRecord[] = []; let total = 0;
    const timeout = AbortSignal.timeout(30000);
    const signal = callerSignal ? AbortSignal.any([timeout,callerSignal]) : timeout;
    try {
      for (const value of values) {
        check(object(value) && Object.keys(value).every(k => ['download_url','file_id','mime_type','file_name'].includes(k)) && typeof value.file_id === 'string' && value.file_id.length > 0 && value.file_id.length <= 512 && typeof value.download_url === 'string' && value.download_url.length <= 8192, 'Invalid returned file');
        const name = filename(value.file_name ?? 'output.bin');
        let address = value.download_url, result;
        for (let redirects=0; ; redirects++) {
          let url; try { url = new URL(address); } catch { throw new Fault(400,'invalid_request','Invalid returned file URL'); }
          check(url.protocol === 'https:' && !url.username && !url.password && !url.hash, 'Returned files require HTTPS');
          signal.throwIfAborted();
          result = await this.download(url.href,{signal});
          signal.throwIfAborted();
          if (![301,302,303,307,308].includes(result.status)) break;
          check(redirects < 3 && typeof result.location === 'string', 'Too many returned file redirects');
          address = new URL(result.location,url).href;
        }
        check(result.status === 200 && Buffer.isBuffer(result.data), 'Returned file download failed', 502);
        total += result.data.length; check(total <= REQUEST_BYTES, 'Returned files exceed 50 MiB',413);
        check(!job.finished, 'Job ended during download',409,'stale_claim');
        const row = this.put(job.id,'output',name,result.data,this.now()+600000); rows.push(row);
      }
      return rows.map(({id,name,mime,bytes}) => ({id,name,mime,bytes}));
    } catch (error) {
      for (const row of rows) { this.removeDisk(row.id); this.rows = this.rows.filter(r => r !== row); }
      if (rows.length) this.save();
      if (error instanceof Fault) throw error;
      throw new Fault(502,'file_download_failed','Returned file download failed');
    }
  }
  output(id: string) { this.prune(); const row = this.rows.find(r => r.id === id && r.kind === 'output'); check(row,'File not found or expired',404,'not_found'); return {row,data:this.read(row)}; }
}
