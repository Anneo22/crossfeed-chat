import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { check, Fault, hash, privateDirectory } from './security.ts';

// A worker chat holds the gateway protocol, its wake nonce and claim tokens. On 6 Nov 2026
// ChatGPT's image tool drew that chat (a gateway_exchange UI showing a live wake nonce) and the
// worker returned it as the requested image. Returned files are checked here before any caller
// can download them: a file showing gateway protocol text or a live token is refused.
const source = fs.readFileSync(new URL('./ocr.swift', import.meta.url));
const MARKERS = ['gatewayexchange', 'wakenonce', 'claimtoken', 'workerlabel'];
const TEXT_LIMIT = 256 * 1024;
export type ReadImageText = (file: string, signal?: AbortSignal) => Promise<string>;

// Lowercase letters and digits only, so OCR spacing, quotes and underscores do not matter.
const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
function near(text: string, word: string, limit: number) {
  if (text.includes(word)) return true;
  for (let length = word.length - limit; length <= word.length + limit; length++) {
    for (let start = 0; start + length <= text.length; start++) {
      const window = text.slice(start, start + length);
      if (window[0] !== word[0] && window.at(-1) !== word.at(-1)) continue;
      if (distance(window, word, limit) <= limit) return true;
    }
  }
  return false;
}
function distance(a: string, b: string, limit: number) {
  let previous = Array.from({length: b.length + 1}, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (Math.min(...row) > limit) return limit + 1;
    previous = row;
  }
  return previous[b.length];
}
/** The reason a returned file must not reach the caller, or null. OCR text is matched loosely, raw bytes exactly. */
export function exposure(text: string, secrets: readonly string[], ocr: boolean) {
  const flat = normalize(text.slice(0, ocr ? TEXT_LIMIT : text.length));
  for (const secret of secrets) if (secret.length >= 16 && flat.includes(normalize(secret))) return 'live_token';
  for (const marker of MARKERS) if (ocr ? near(flat, marker, 1) : flat.includes(marker)) return 'gateway_protocol';
  return null;
}
function run(command: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {stdio: ['ignore', 'pipe', 'ignore'], env: {PATH: '/usr/bin:/bin', HOME: process.env.HOME}, signal});
    const output: Buffer[] = []; let bytes = 0;
    // The first Vision run on a host loads its model, which can take tens of seconds.
    const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
    child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes <= TEXT_LIMIT) output.push(chunk); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(Buffer.concat(output).toString('utf8')) : reject(Error('Image text recognition failed')); });
  });
}
export class FileScan {
  declare directory: string; declare readImageText: ReadImageText; declare ready?: Promise<string>;
  constructor(directory: string, readImageText?: ReadImageText) {
    this.directory = directory;
    this.readImageText = readImageText ?? (async (file, signal) => {
      check(process.platform === 'darwin', 'Returned images are checked with macOS Vision', 503, 'file_unverified');
      this.ready ??= this.compile().catch(error => { this.ready = undefined; throw error; });
      return run(await this.ready, [file], signal);
    });
  }
  async compile() {
    const directory = path.join(this.directory, 'ocr'); privateDirectory(directory);
    const helper = path.join(directory, `ocr-${hash(source)}`);
    const stat = fs.lstatSync(helper, {throwIfNoEntry: false});
    if (stat) { check(stat.isFile() && !stat.isSymbolicLink() && !(stat.mode & 0o077) && stat.uid === process.getuid?.(), 'Unsafe image text helper', 500); return helper; }
    const swift = helper + '.swift'; fs.writeFileSync(swift, source, {mode: 0o600});
    await run('/usr/bin/swiftc', [swift, '-o', helper + '.building']);
    fs.chmodSync(helper + '.building', 0o700); fs.renameSync(helper + '.building', helper);
    return helper;
  }
  async warm() { await this.readImageText(fileURLToPath(new URL('../assets/icon-16.png', import.meta.url))); }
  /** Refuse a stored returned file that shows the gateway protocol or a live token. Fails closed for images it cannot read. */
  async check(file: string, data: Buffer, mime: string, secrets: readonly string[], signal?: AbortSignal) {
    let reason = exposure(data.toString('latin1'), secrets, false);
    if (!reason && mime.startsWith('image/')) {
      let text: string;
      try { text = await this.readImageText(file, signal); }
      catch (error) {
        signal?.throwIfAborted();
        throw new Fault(503, 'file_unverified', 'A returned image could not be checked for gateway text, so it was discarded. Next: retry; on a host without macOS Vision, return images are unavailable.');
      }
      reason = exposure(text, secrets, true);
    }
    if (reason) throw new Fault(422, 'unsafe_file', 'A returned file shows Crossfeed gateway protocol text or a live token, so it was discarded. Generate the requested content again from request.messages alone; never draw, capture or quote this chat, its gateway_exchange calls or any token.');
  }
}
