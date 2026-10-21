import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

export interface TestResponse {
  status: number; ok: boolean; headers: Headers; text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBufferLike>; json(): Promise<any>;
}
interface FakeRequest extends Readable {
  headers: Record<string, string>; url: string; method: string; socket: { localPort: number };
}
interface FakeResponse extends EventEmitter {
  headers: Headers; status: number; chunks: Buffer[]; destroyed: boolean; writableEnded: boolean;
  setHeader(name: string, value: string): void; writeHead(status: number, headers?: Record<string,string>): void;
  write(value: string | Buffer): number; end(value?: string | Buffer): void; destroy(): void;
}
interface FakeServer extends EventEmitter {
  active: Set<FakeResponse>; port: number; handler(req: FakeRequest, res: FakeResponse): unknown;
  listen(port: number, host: string, done: () => void): void; address(): {address:string;port:number};
  close(done: () => void): void; closeAllConnections(): void;
}

// Injected transport only: the production HTTP handlers and state machines run unchanged.
export function fakeHTTP() {
  let port = 48000;
  const servers = new Map<number, FakeServer>();
  const factory = (_options: any, handler: FakeServer['handler']) => {
    const server = new EventEmitter() as FakeServer; server.active = new Set();
    server.listen = (requested: any, host: any, done: any) => {
      if (host !== '127.0.0.1') throw Error('Non-loopback bind');
      server.port = requested || ++port; servers.set(server.port, server); done();
    };
    server.address = () => ({ address: '127.0.0.1', port: server.port });
    server.close = (done: any) => { servers.delete(server.port); done(); };
    server.closeAllConnections = () => { for (const res of server.active) res.destroy(); };
    server.handler = handler;
    return server;
  };
  const fetcher = (address: string | URL, init: RequestInit = {}) => new Promise<TestResponse>((resolve, reject) => {
    const url = new URL(address); const server = servers.get(Number(url.port));
    if (!server) return reject(Error('Fake listener is closed'));
    const req = Readable.from(init.body ? [Buffer.from(init.body)] : []) as FakeRequest;
    req.headers = { host: url.host, accept: '*/*', ...Object.fromEntries([...new Headers(init.headers)]) };
    req.url = url.pathname + url.search; req.method = init.method ?? 'GET'; req.socket = { localPort: server.port };
    const res = new EventEmitter() as FakeResponse; res.headers = new Headers(); res.status = 200; res.chunks = []; res.destroyed = false; res.writableEnded = false;
    res.setHeader = (name: any, value: any) => res.headers.set(name, value);
    res.writeHead = (status: number, headers: Record<string, any> = {}) => { res.status = status; for (const [name, value] of Object.entries(headers)) res.setHeader(name, value); };
    res.write = (value: any) => res.chunks.push(Buffer.from(value));
    const cleanup = () => { server.active.delete(res); init.signal?.removeEventListener('abort', abort); res.emit('close'); };
    res.end = (value: any) => {
      if (res.destroyed) return;
      if (value !== undefined) res.write(value); res.writableEnded = true;
      const bytes = Buffer.concat(res.chunks); const text = bytes.toString('utf8'); cleanup();
      resolve({ status: res.status, ok: res.status >= 200 && res.status < 300, headers: res.headers, text: async () => text, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength), json: async () => JSON.parse(text) });
    };
    res.destroy = () => { if (res.destroyed || res.writableEnded) return; res.destroyed = true; cleanup(); reject(Error('Fake connection closed')); };
    const abort = () => res.destroy();
    server.active.add(res); init.signal?.addEventListener('abort', abort, { once: true });
    if (init.signal?.aborted) abort(); else Promise.resolve(server.handler(req, res)).catch(reject);
  });
  return { factory: factory as unknown as NonNullable<import('../src/server.ts').AppOptions['serverFactory']>, fetcher };
}
