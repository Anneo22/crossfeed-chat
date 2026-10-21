import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export class Fault extends Error {
  declare status: number; declare code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
export function check(ok: unknown, message: string, status = 400, code = 'invalid_request'): asserts ok {
  if (!ok) throw new Fault(status, code, message);
}
export const nonce = () => randomBytes(24).toString('base64url');
export const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('base64url');
export const equal = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
export const object = <T>(x: T): x is T & Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
export function text(x: unknown, name: string, max = 128, empty = false) {
  check(typeof x === 'string' && (empty || x.length > 0) && Buffer.byteLength(x) <= max, `Invalid ${name}`);
  return x;
}
export function line(value: unknown, name: string, max = 128) {
  const x = text(value, name, max);
  check(x === x.trim() && !/[\p{C}]/u.test(x), `Invalid ${name}`);
  return x;
}
export function shortTitle(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  check(typeof value === 'string' && Buffer.byteLength(value) <= 4096, 'Invalid title');
  const normalized = value.normalize('NFKC').replace(/[\p{C}]/gu, ' ').replace(/\s+/gu, ' ').trim();
  return Array.from(normalized).slice(0, 80).join('').trim() || undefined;
}
export const label = (x: unknown) => line(x, 'worker label');
export function publicOrigin(value: string) {
  let url;
  try { url = new URL(value); } catch { throw new Fault(400, 'invalid_request', 'Invalid public URL'); }
  check(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'Public URL must be an HTTPS origin');
  return url.origin;
}
export function chatUrl(value: string) {
  let url;
  try { url = new URL(value); } catch { throw new Fault(400, 'invalid_request', 'Invalid saved chat URL'); }
  check(url.origin === 'https://chatgpt.com' && !url.username && !url.password && !url.search && !url.hash && /^\/c\/[A-Za-z0-9-]{1,128}$/.test(url.pathname), 'Save an existing chatgpt.com/c/<id> URL');
  return url.href;
}
export function privateDirectory(directory: string) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const s = fs.lstatSync(directory);
  check(s.isDirectory() && !s.isSymbolicLink() && !(s.mode & 0o077) && (!process.getuid || s.uid === process.getuid()), 'State directory must be private and owned by this user', 500);
}
export function readPrivate<T = unknown>(directory: string, name: string, fallback: T = undefined as T, maxBytes = 2 * 1024 * 1024) {
  privateDirectory(directory);
  let fd: number | undefined;
  try {
    fd = fs.openSync(path.join(directory, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const s = fs.fstatSync(fd);
    check(s.isFile() && !(s.mode & 0o077) && s.size <= maxBytes && (!process.getuid || s.uid === process.getuid()), 'Unsafe state file', 500);
    return JSON.parse(fs.readFileSync(fd, 'utf8')) as T;
  } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw e; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
export function writePrivate(directory: string, name: string, value: unknown) {
  privateDirectory(directory);
  const destination = path.join(directory, name);
  try {
    const s = fs.lstatSync(destination);
    check(s.isFile() && !s.isSymbolicLink() && !(s.mode & 0o077) && (!process.getuid || s.uid === process.getuid()), 'Unsafe state file', 500);
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const temporary = path.join(directory, `.${name}.${nonce()}`);
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, destination);
}
export function lease(directory: string) {
  privateDirectory(directory);
  const file = path.join(directory, 'server.lock');
  const owner = nonce();
  let fd: number | undefined;
  try { fd = fs.openSync(file, 'wx', 0o600); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    readPrivate<{owner: string} | null>(directory, 'server.lock', null);
    throw new Fault(409, 'already_running', 'State directory is locked; after confirming the server has stopped, trash its server.lock before restarting');
  }
  try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, owner })); } finally { fs.closeSync(fd); }
  return () => {
    const current = readPrivate<{owner: string} | null>(directory, 'server.lock', null);
    if (current?.owner === owner) fs.unlinkSync(file);
  };
}
export async function body(req: IncomingMessage, form = false, maxBytes = 1024 * 1024) {
  const type = req.headers['content-type']?.split(';')[0];
  check(type === (form ? 'application/x-www-form-urlencoded' : 'application/json'), 'Unsupported content type', 415);
  check(!req.headers['content-encoding'], 'Encoded bodies are not supported', 415);
  const chunks: Uint8Array[] = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    check(bytes <= maxBytes, `Request body exceeds ${maxBytes / 1024 / 1024} MiB`, 413);
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    if (form) {
      const entries = new URLSearchParams(raw);
      check(new Set(entries.keys()).size === [...entries].length, 'Duplicate form field');
      return Object.fromEntries(entries);
    }
    const value = JSON.parse(raw);
    check(object(value), 'Body must be an object');
    return value;
  } catch (e) { if (e instanceof Fault) throw e; throw new Fault(400, 'invalid_request', 'Invalid request body'); }
}
export function json(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(JSON.stringify(value));
}
export function bearer(req: Pick<IncomingMessage, 'headers'>) { return /^Bearer ([A-Za-z0-9._~+\/-]+=*)$/.exec(req.headers.authorization ?? '')?.[1]; }
