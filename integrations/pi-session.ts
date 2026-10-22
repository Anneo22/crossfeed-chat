const SESSION = /^[A-Za-z0-9._~-]{1,128}$/;

function crossfeedModel(model: any): boolean {
  if (!model || typeof model.id !== 'string' || !model.id.startsWith('chatgpt:') || typeof model.baseUrl !== 'string') return false;
  if (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/v1$/.test(model.baseUrl)) return false;
  try {
    const url = new URL(model.baseUrl);
    const port = Number(url.port);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.pathname === '/v1' &&
      !url.username && !url.password && !url.search && !url.hash && Number.isInteger(port) && port >= 1 && port <= 65535;
  } catch {
    return false;
  }
}

export function beforeProviderHeaders(event: any, ctx: any): void {
  if (event?.type !== 'before_provider_headers' || !crossfeedModel(ctx?.model)) return;
  if (!event.headers || typeof event.headers !== 'object') throw Error('Crossfeed provider headers are unavailable');
  const setSession = (value: string) => typeof event.headers.set === 'function' ? event.headers.set('X-Crossfeed-Session', value) : event.headers['X-Crossfeed-Session'] = value;
  let session;
  try { session = ctx?.sessionManager?.getSessionId?.(); }
  catch { setSession(''); throw Error('Crossfeed requires a URL-safe Pi session ID'); }
  if (typeof session !== 'string' || !SESSION.test(session)) { setSession(''); throw Error('Crossfeed requires a URL-safe Pi session ID'); }
  setSession(session);
}

export default function crossfeedSession(pi: any): void {
  pi.on('before_provider_headers', beforeProviderHeaders);
}
