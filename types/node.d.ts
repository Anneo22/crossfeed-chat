// Local declarations for the Node interfaces used by this project. They keep
// TypeScript the only development dependency; Node supplies the runtime APIs.
// Dynamic native I/O results are refined by the product's validation functions.
interface NodeProcess {
  argv: string[];
  env: Record<string, string | undefined>;
  pid: number;
  platform: string;
  versions: {node: string};
  execPath: string;
  exitCode?: number;
  stdin: any;
  stdout: any;
  stderr: any;
  getuid?: () => number;
  cwd(): string;
  chdir(path: string): void;
  kill(pid: number, signal?: string | number): boolean;
  exit(code?: number): never;
  once(event: string, listener: (...args: any[]) => void): this;
  on(event: string, listener: (...args: any[]) => void): this;
  removeListener(event: string, listener: (...args: any[]) => void): this;
  off(event: string, listener: (...args: any[]) => void): this;
}
declare var process: NodeProcess;
interface Buffer extends Uint8Array {
  toString(encoding?: string, start?: number, end?: number): string;
  subarray(start?: number, end?: number): Buffer;
  equals(other: Uint8Array): boolean;
  readUInt32BE(offset: number): number;
  write(value: string, offset?: number, encoding?: string): number;
}
declare var Buffer: {
  from(value: any, encodingOrOffset?: string | number, length?: number): Buffer;
  alloc(size: number, fill?: number | string): Buffer;
  concat(chunks: readonly Uint8Array[]): Buffer;
  byteLength(value: string | Uint8Array, encoding?: string): number;
  isBuffer(value: unknown): value is Buffer;
};
declare namespace NodeJS {
  interface Timeout { unref(): this; ref(): this; }
  interface ErrnoException extends Error { code?: string; }
  type Signals = string;
}
declare function setTimeout(callback: (...args: any[]) => void, ms?: number, ...args: any[]): NodeJS.Timeout;
declare function setInterval(callback: (...args: any[]) => void, ms?: number, ...args: any[]): NodeJS.Timeout;
declare function clearTimeout(timer?: NodeJS.Timeout | number): void;
declare function clearInterval(timer?: NodeJS.Timeout | number): void;
declare function setImmediate(callback: (...args: any[]) => void): NodeJS.Timeout;
declare module 'node:fs' {
  export interface Stats { mode: number; size: number; uid: number; nlink: number; ino: number; dev: number; mtimeMs: number; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; }
  export interface Dirent { name: string; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; }
  interface FileSystem {
    constants: Record<string, number>;
    mkdirSync(path: string, options?: {recursive?: boolean; mode?: number}): string | undefined;
    mkdtempSync(prefix: string): string;
    lstatSync(path: string): Stats; lstatSync(path: string, options: {throwIfNoEntry: false}): Stats | undefined; statSync(path: string): Stats; fstatSync(fd: number): Stats;
    readFileSync(path: string | URL | number, encoding: string): string;
    readFileSync(path: string | URL | number): Buffer;
    writeFileSync(path: string | URL | number, value: string | Uint8Array, options?: string | {mode?: number; flag?: string; encoding?: string}): void;
    readdirSync(path: string, options: {withFileTypes: true}): Dirent[];
    readdirSync(path: string): string[];
    existsSync(path: string): boolean; accessSync(path: string, mode?: number): void;
    openSync(path: string, flags: string | number, mode?: number): number;
    closeSync(fd: number): void; fsyncSync(fd: number): void; ftruncateSync(fd: number, len?: number): void;
    writeSync(fd: number, value: string | Uint8Array): number;
    chmodSync(path: string, mode: number): void; renameSync(from: string, to: string): void;
    readlinkSync(path: string): string; rmdirSync(path: string): void;
    realpathSync(path: string): string; unlinkSync(path: string): void;
    rmSync(path: string, options?: {recursive?: boolean; force?: boolean}): void;
    copyFileSync(from: string, to: string): void;
    cpSync(from: string, to: string, options?: {recursive?: boolean}): void;
    linkSync(from: string, to: string): void; symlinkSync(from: string, to: string): void;
    truncateSync(path: string, len?: number): void;
  }
  const fs: FileSystem; export default fs;
  export const mkdtempSync: (prefix: string) => string;
  export const rmSync: (path: string, options?: {recursive?: boolean; force?: boolean}) => void;
}
declare module 'node:fs/promises' {
  import type { Stats } from 'node:fs';
  export function readFile(path: string | URL, encoding: string): Promise<string>;
  export function readFile(path: string | URL): Promise<Buffer>;
  const fs: {
    readFile: typeof readFile; stat(path: string): Promise<Stats>;
    mkdir(path: string, options?: {recursive?: boolean; mode?: number}): Promise<string | undefined>;
    mkdtemp(prefix: string): Promise<string>; rm(path: string, options?: {recursive?: boolean; force?: boolean}): Promise<void>;
    writeFile(path: string, data: string | Uint8Array, options?: any): Promise<void>;
  }; export default fs;
}
declare module 'node:path' {
  interface PathAPI {
    join(...paths: string[]): string; resolve(...paths: string[]): string;
    dirname(path: string): string; basename(path: string, suffix?: string): string;
    extname(path: string): string; relative(from: string, to: string): string;
    isAbsolute(path: string): boolean; sep: string; posix: PathAPI;
  }
  const path: PathAPI; export default path;
}
declare module 'node:os' { const os: { homedir(): string; tmpdir(): string; hostname(): string }; export default os; export const homedir: () => string; export const tmpdir: () => string; export const hostname: () => string; }
declare module 'node:crypto' {
  interface Hash { update(value: string | Uint8Array): this; digest(encoding: string): string; }
  export function createHash(algorithm: string): Hash;
  export function randomBytes(size: number): Buffer;
  export function randomUUID(): string;
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}
declare module 'node:events' {
  export class EventEmitter {
    on(event: string, listener: (...args: any[]) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    off(event: string, listener: (...args: any[]) => void): this;
    emit(event: string, ...args: any[]): boolean;
    removeListener(event: string, listener: (...args: any[]) => void): this;
    removeAllListeners(event?: string): this;
    listenerCount(event: string): number;
  }
  export function once(emitter: EventEmitter, event: string): Promise<any[]>;
}
declare module 'node:child_process' {
  import { EventEmitter } from 'node:events';
  export interface ChildProcess extends EventEmitter {
    pid?: number; exitCode: number | null; signalCode: string | null;
    stdin: any; stdout: EventEmitter; stderr: EventEmitter;
    killed: boolean; kill(signal?: string | number): boolean;
  }
  export function spawn(command: string, args?: string[], options?: any): ChildProcess;
  export function spawnSync(command: string, args?: string[], options?: any): {status: number | null; signal: string | null; stdout: any; stderr: any; error?: Error; pid: number};
}
declare module 'node:url' { export const fileURLToPath: (url: URL | string) => string; }
declare module 'node:net' { const net: any; export default net; export const isIP: (value: string) => number; }
declare module 'node:http' {
  import { EventEmitter } from 'node:events';
  export interface IncomingMessage extends EventEmitter, AsyncIterable<Buffer> {
    // The server boundary validates host, origin, method and target before routing.
    headers: Record<string, string | undefined>;
    socket: {localPort?: number}; url: string; method: string;
    statusCode: number; destroy(error?: Error): void;
  }
  export interface ServerResponse extends EventEmitter {
    destroyed: boolean; writableEnded: boolean;
    setHeader(name: string, value: string | number): void;
    writeHead(status: number, headers?: Record<string, string | number>): this;
    write(data: string | Uint8Array): boolean;
    end(data?: string | Uint8Array): void;
    destroy(error?: Error): void;
  }
  export interface ServerOptions { requestTimeout?: number; headersTimeout?: number; maxHeaderSize?: number; connectionsCheckingInterval?: number; }
  export interface Server extends EventEmitter {
    maxConnections: number; maxRequestsPerSocket: number; listening: boolean;
    listen(port: number, host: string, callback?: () => void): this;
    listen(path: string, callback?: () => void): this;
    address(): {port: number; address: string; family?: string};
    close(callback?: (error?: Error) => void): this;
    closeAllConnections(): void;
  }
  export function createServer(options: ServerOptions, handler: (req: IncomingMessage, res: ServerResponse) => void): Server;
  export function createServer(handler?: (req: IncomingMessage, res: ServerResponse) => void): Server;
  export function request(url: string | URL, options: any, handler?: (response: IncomingMessage) => void): any;
  const http: {createServer: typeof createServer; request: typeof request}; export default http;
}
declare module 'node:https' { import type { request } from 'node:http'; const https: {request: typeof request; get: typeof request}; export default https; }
declare module 'node:dns' { const dns: any; export default dns; }
declare module 'node:dns/promises' { export const lookup: any; }
declare module 'node:readline' { const readline: any; export default readline; export const createInterface: any; }
declare module 'node:util' {
  type ArgOptions = Record<string, {type: 'string' | 'boolean'; multiple?: boolean; default?: string | boolean}>;
  type Value<O> = O extends {multiple: true} ? string[] : O extends {type: 'boolean'} ? boolean : string;
  export function parseArgs<O extends ArgOptions>(config: {args?: string[]; allowPositionals?: boolean; strict?: boolean; options: O}): {values: {[K in keyof O]?: Value<O[K]>}; positionals: string[]};
}
declare module 'node:module' { export const createRequire: any; export function stripTypeScriptTypes(code: string): string; }
declare module 'node:vm' {
  const vm: {runInNewContext(code: string, context?: Record<string, any>): any};
  export default vm;
}
declare module 'node:stream' {
  import { EventEmitter } from 'node:events';
  export class Readable extends EventEmitter { [key: string]: any; static from(data: any): Readable; }
  export class PassThrough extends Readable {}
}
declare module 'node:test' {
  export interface TestContext { after(fn: () => any): void; before(fn: () => any): void; mock: any; }
  type TestFn = (t: TestContext) => any;
  function test(name: string, fn: TestFn): any;
  function test(name: string, options: {skip?: boolean; timeout?: number}, fn: TestFn): any;
  export default test;
}
declare module 'node:assert/strict' {
  interface Assert {
    (value: unknown, message?: any): asserts value;
    ok(value: unknown, message?: any): asserts value;
    equal(actual: any, expected: any, message?: any): void;
    strictEqual(actual: any, expected: any, message?: any): void;
    notStrictEqual(actual: any, expected: any, message?: any): void;
    deepEqual(actual: any, expected: any, message?: any): void;
    notEqual(actual: any, expected: any, message?: any): void;
    notDeepEqual(actual: any, expected: any, message?: any): void;
    match(actual: string, expected: RegExp, message?: any): void;
    doesNotMatch(actual: string, expected: RegExp, message?: any): void;
    throws(fn: () => any, expected?: RegExp | ((e: any) => boolean) | object, message?: any): void;
    rejects(fn: Promise<any> | (() => Promise<any>), expected?: RegExp | ((e: any) => boolean) | object, message?: any): Promise<void>;
    doesNotThrow(fn: () => any): void;
    fail(message?: string): never;
  }
  const assert: Assert; export default assert;
}
