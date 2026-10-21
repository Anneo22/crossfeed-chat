interface OAuthClient { id: string; name: string; redirect: string; expires?: number }
interface Grant { client: string; scope: string; family: string; resource: string; expires: number }
interface AuthCode { client: string; redirect: string; scope: string; resource: string; challenge: string; expires: number }
interface Approval { id: string; client: OAuthClient; challenge: string; scope: string; resource: string; state: string; browser: string; expires: number; approved: boolean }
interface OAuthState { issuer: string; clients: Record<string, OAuthClient>; tokens: Record<string, Grant>; refresh: Record<string, Grant>; spent: Record<string, {family: string; expires: number}> }
interface Registration { redirect_uris: string[]; token_endpoint_auth_method?: string; grant_types?: string[]; response_types?: string[]; scope?: string; client_name?: string }
import { check, equal, Fault, hash, line, nonce, readPrivate, text, writePrivate } from './security.ts';

const TAB_ICON = 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2016%2016%22%3E%3Ctitle%3ECrossfeed%20Chat%3C%2Ftitle%3E%3Cstyle%3E%3Aroot%7B--i%3A%23E9E6DF%3B--p%3A%23141311%3B--t%3A%23301E15%3B--h%3A%23C4552A%7D%40media%28prefers-color-scheme%3Alight%29%7B%3Aroot%7B--i%3A%2314130F%3B--p%3A%23FAF9F4%3B--t%3A%23F1DFD4%7D%7D%3C%2Fstyle%3E%3Crect%20width%3D%2216%22%20height%3D%2216%22%20rx%3D%223%22%20fill%3D%22var%28--p%29%22%2F%3E%3Cg%20id%3D%22square-chat-tank%22%20transform%3D%22translate%2816%200%29%20scale%28-1%201%29%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%221%22%3E%0A%3Cdefs%3E%3CclipPath%20id%3D%22tank-tab%22%3E%3Cpath%20d%3D%22M7.5%201.5H11.5Q14.5%201.5%2014.5%204.5V9.5Q14.5%2012.5%2011.5%2012.5H9.5L6.5%2014.5V12.5Q4.5%2012.5%204.5%2010.5V4.5Q4.5%201.5%207.5%201.5Z%22%2F%3E%3C%2FclipPath%3E%3C%2Fdefs%3E%0A%3Cpath%20id%3D%22outgoing-feed%22%20d%3D%22M0.5%209.5H4.5%22%20fill%3D%22none%22%20stroke%3D%22var%28--i%29%22%2F%3E%0A%3Cpath%20id%3D%22chat-tank%22%20d%3D%22M7.5%201.5H11.5Q14.5%201.5%2014.5%204.5V9.5Q14.5%2012.5%2011.5%2012.5H9.5L6.5%2014.5V12.5Q4.5%2012.5%204.5%2010.5V4.5Q4.5%201.5%207.5%201.5Z%22%20fill%3D%22var%28--p%29%22%2F%3E%0A%3Cg%20clip-path%3D%22url%28%23tank-tab%29%22%3E%3Crect%20x%3D%224.5%22%20y%3D%224.5%22%20width%3D%2210.0%22%20height%3D%2216%22%20fill%3D%22var%28--t%29%22%2F%3E%0A%3Cpath%20id%3D%22fuel-level%22%20d%3D%22M4.5%204.5H14.5%22%20stroke%3D%22var%28--h%29%22%2F%3E%3C%2Fg%3E%0A%3Cpath%20d%3D%22M7.5%201.5H11.5Q14.5%201.5%2014.5%204.5V9.5Q14.5%2012.5%2011.5%2012.5H9.5L6.5%2014.5V12.5Q4.5%2012.5%204.5%2010.5V4.5Q4.5%201.5%207.5%201.5Z%22%20fill%3D%22none%22%20stroke%3D%22var%28--i%29%22%2F%3E%0A%3Cg%20id%3D%22feed-valve%22%3E%3Ccircle%20cx%3D%222.5%22%20cy%3D%229.5%22%20r%3D%221.5%22%20fill%3D%22var%28--p%29%22%20stroke%3D%22var%28--i%29%22%2F%3E%0A%3Cpath%20d%3D%22M2.5%208.5V10.5%22%20stroke%3D%22var%28--h%29%22%2F%3E%3C%2Fg%3E%3C%2Fg%3E%3C%2Fsvg%3E';

const SCOPE = 'mcp:tools offline_access';
const escapeHtml = (x: string) => x.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export class OAuth {
  declare directory: string; declare issuer: string; declare resource: string; declare now: () => number; declare state: OAuthState;
  declare registered: Map<string, OAuthClient & {expires: number}>; declare pending: Map<string, Approval>; declare codes: Map<string, AuthCode>; declare window: number;

  constructor(directory: string, issuer: string, now = Date.now) {
    this.directory = directory; this.issuer = issuer; this.resource = `${issuer}/mcp`; this.now = now;
    this.state = readPrivate<OAuthState>(directory, 'oauth.json', { issuer, clients: {}, tokens: {}, refresh: {}, spent: {} });
    check(this.state.issuer === issuer, 'Public URL changed: use a fresh Crossfeed state directory and reconnect', 500);
    this.registered = new Map(); this.pending = new Map(); this.codes = new Map(); this.window = 0;
    this.prune();
  }
  prune() {
    const now = this.now();
    for (const type of ['tokens', 'refresh', 'spent'] as const) for (const [key, row] of Object.entries(this.state[type])) if (row.expires <= now) delete this.state[type][key];
    for (const map of [this.registered, this.pending, this.codes]) for (const [key, row] of map) if (row.expires <= now) map.delete(key);
  }
  save() { writePrivate(this.directory, 'oauth.json', this.state); }
  open() { this.registered.clear(); this.pending.clear(); this.window = this.now() + 300000; return { expires_at: this.window, public_url: this.issuer }; }
  metadata() {
    return { issuer: this.issuer, authorization_endpoint: `${this.issuer}/oauth/authorize`, token_endpoint: `${this.issuer}/oauth/token`, registration_endpoint: `${this.issuer}/oauth/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'], scopes_supported: ['mcp:tools', 'offline_access'], authorization_response_iss_parameter_supported: true };
  }
  resourceMetadata(resource = this.resource) { return { resource, authorization_servers: [this.issuer], scopes_supported: ['mcp:tools'], bearer_methods_supported: ['header'] }; }
  register(value: unknown) {
    const input = value as Registration;
    this.prune();
    check(this.window > this.now(), 'Run crossfeed-chat link on the host to open registration', 403, 'registration_window_closed');
    check(Array.isArray(input.redirect_uris) && input.redirect_uris.length === 1, 'Register exactly one ChatGPT callback');
    let uri;
    try { uri = new URL(input.redirect_uris[0]); } catch { throw new Fault(400, 'invalid_client_metadata', 'Invalid callback'); }
    check(uri.origin === 'https://chatgpt.com' && !uri.username && !uri.password && !uri.hash && !uri.search && /^\/(?:connector\/oauth\/[A-Za-z0-9_-]{6,160}|connector_platform_oauth_redirect)$/.test(uri.pathname), 'Only ChatGPT connector OAuth callbacks are admitted', 400, 'invalid_redirect_uri');
    check(input.token_endpoint_auth_method === undefined || input.token_endpoint_auth_method === 'none', 'Only public PKCE clients are supported');
    check(input.grant_types === undefined || Array.isArray(input.grant_types) && input.grant_types.length <= 2 && input.grant_types.includes('authorization_code') && input.grant_types.every(g => ['authorization_code', 'refresh_token'].includes(g)), 'Invalid grants');
    check(input.response_types === undefined || Array.isArray(input.response_types) && input.response_types.length === 1 && input.response_types[0] === 'code', 'Invalid response_types');
    this.scope(input.scope ?? SCOPE);
    const name = line(input.client_name ?? 'ChatGPT', 'client name', 128);
    const same = [...this.registered.values(), ...Object.values(this.state.clients)].find(c => c.redirect === uri.href && c.name === name);
    check(same || this.registered.size < 32 && Object.keys(this.state.clients).length < 32, 'Client limit reached', 429);
    const client = { ...(same ?? { id: nonce(), redirect: uri.href, name }), expires: this.window };
    this.registered.set(client.id, client);
    return { client_id: client.id, client_name: name, redirect_uris: [client.redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: SCOPE };
  }
  scope(input: unknown) {
    const value = text(input, 'scope');
    text(value, 'scope');
    const scopes = value.split(' ');
    check(scopes.includes('mcp:tools') && scopes.every(s => ['mcp:tools', 'offline_access'].includes(s)) && new Set(scopes).size === scopes.length, 'Invalid scope', 400, 'invalid_scope');
    return scopes.join(' ');
  }
  authorize(value: unknown) {
    const params = value as Record<string, string>;
    this.prune();
    check(this.window > this.now(), 'Host connection window is closed', 403);
    const client = this.registered.get(params.client_id) ?? (Object.hasOwn(this.state.clients, params.client_id) ? this.state.clients[params.client_id] : null);
    check(client && params.redirect_uri === client.redirect, 'Unknown client or callback', 400);
    check(params.response_type === 'code' && params.code_challenge_method === 'S256' && /^[A-Za-z0-9_-]{43}$/.test(params.code_challenge ?? ''), 'S256 PKCE is required');
    check([this.resource, `${this.issuer}/tools/mcp`].includes(params.resource), 'Invalid token resource', 400, 'invalid_target');
    text(params.state, 'OAuth state', 512);
    const scope = this.scope(params.scope ?? SCOPE);
    check(this.pending.size < 32, 'Too many pending approvals', 429);
    const id = `approval_${nonce()}`, browser = nonce();
    const pending = { id, client, challenge: params.code_challenge, scope, resource: params.resource, state: params.state, browser: hash(browser), expires: Math.min(this.window, this.now() + 90000), approved: false };
    this.pending.set(id, pending);
    return { id, browser };
  }
  list() {
    this.prune();
    return [...this.pending.values()].filter(p => !p.approved).map(p => ({ id: p.id, client_name: p.client.name, callback_host: 'chatgpt.com', requested_scope: p.scope, resource: p.resource, expires_at: p.expires }));
  }
  clients() {
    this.prune();
    return Object.values(this.state.clients).map(client => ({id: client.id, name: client.name, callback_host: 'chatgpt.com', access_tokens: Object.values(this.state.tokens).filter(row => row.client === client.id).length, refresh_grants: Object.values(this.state.refresh).filter(row => row.client === client.id).length}));
  }
  revoke(id: string) {
    line(id, 'client ID'); check(Object.hasOwn(this.state.clients, id), 'Unknown approved client', 404);
    const next = structuredClone(this.state), families = new Set();
    delete next.clients[id];
    for (const type of ['tokens', 'refresh'] as const) for (const [key, row] of Object.entries(next[type])) if (row.client === id) { families.add(row.family); delete next[type][key]; }
    for (const [key, row] of Object.entries(next.spent)) if (families.has(row.family)) delete next.spent[key];
    writePrivate(this.directory, 'oauth.json', next); this.state = next;
    this.registered.delete(id);
    for (const map of [this.pending, this.codes]) for (const [key, row] of map) if ((typeof row.client === 'string' ? row.client : row.client.id) === id) map.delete(key);
    return {revoked: id};
  }
  approve(id: string) {
    this.prune();
    const p = this.pending.get(id);
    check(this.window > this.now() && p && !p.approved, 'Approval is missing or expired', 404);
    const previous = this.state;
    this.state = structuredClone(previous);
    this.state.clients[p.client.id] = { id: p.client.id, name: p.client.name, redirect: p.client.redirect };
    try { this.save(); } catch (error) { this.state = previous; throw error; }
    p.approved = true; this.window = 0; this.registered.clear();
    for (const [key, value] of this.pending) if (!value.approved) this.pending.delete(key);
    return { approved: id };
  }
  consent(id: string, browser: string | undefined) {
    this.prune();
    const p = this.pending.get(id);
    check(p && browser && equal(p.browser, hash(browser)), 'Approval is missing or expired', 404);
    if (!p.approved) return { html: `<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="refresh" content="2"><title>Crossfeed host approval</title><link rel="icon" type="image/svg+xml" href="${TAB_ICON}"><body><h1>Approve on your computer</h1><p>${escapeHtml(p.client.name)} requests access to ${escapeHtml(p.resource)}. Callback: chatgpt.com.</p><p>On the host, run:</p><pre>crossfeed-chat approve ${id}</pre><p>This page continues after approval. Expires in 90 seconds.</p></body></html>` };
    const code = nonce();
    this.codes.set(hash(code), { client: p.client.id, redirect: p.client.redirect, scope: p.scope, resource: p.resource, challenge: p.challenge, expires: this.now() + 60000 });
    this.pending.delete(id);
    const target = new URL(p.client.redirect);
    target.searchParams.set('code', code); target.searchParams.set('state', p.state); target.searchParams.set('iss', this.issuer);
    return { redirect: target.href };
  }
  token(value: unknown) {
    const input = value as Record<string, string>;
    this.prune();
    check([this.resource, `${this.issuer}/tools/mcp`].includes(input.resource), 'Invalid token resource', 400, 'invalid_target');
    check(Object.hasOwn(this.state.clients, input.client_id), 'Unknown approved client', 400, 'invalid_client');
    const next = structuredClone(this.state);
    let row: Grant; let codeKey: string | undefined;
    if (input.grant_type === 'authorization_code') {
      text(input.code, 'code', 128);
      const code = this.codes.get(hash(input.code));
      check(code && code.resource === input.resource && code.client === input.client_id && code.redirect === input.redirect_uri && /^[A-Za-z0-9._~-]{43,128}$/.test(input.code_verifier ?? '') && equal(code.challenge, hash(input.code_verifier)), 'Invalid authorization grant', 400, 'invalid_grant');
      check(Object.keys(next.tokens).length < 128, 'Token limit reached', 429);
      codeKey = hash(input.code);
      row = { client: code.client, resource: code.resource, scope: code.scope, family: nonce(), expires: this.now() + 30 * 86400000 };
    } else if (input.grant_type === 'refresh_token') {
      text(input.refresh_token, 'refresh token', 128);
      const key = hash(input.refresh_token);
      const spent = next.spent[key];
      if (spent) {
        for (const type of ['tokens', 'refresh'] as const) for (const [k, v] of Object.entries(next[type])) if (v.family === spent.family) delete next[type][k];
        writePrivate(this.directory, 'oauth.json', next); this.state = next;
        throw new Fault(400, 'invalid_grant', 'Refresh token reuse revoked its token family');
      }
      row = next.refresh[key];
      check(row && row.resource === input.resource && row.client === input.client_id, 'Invalid refresh grant', 400, 'invalid_grant');
      if (input.scope !== undefined) check(this.scope(input.scope).split(' ').every(s => row.scope.split(' ').includes(s)), 'Cannot widen refresh scope', 400, 'invalid_scope');
      check(Object.keys(next.spent).length < 1024, 'Refresh ledger is full', 429);
      check(Object.values(next.tokens).filter(v => v.family !== row.family).length < 128, 'Token limit reached', 429);
      delete next.refresh[key];
      next.spent[key] = { family: row.family, expires: row.expires };
      for (const [k, v] of Object.entries(next.tokens)) if (v.family === row.family) delete next.tokens[k];
      if (input.scope !== undefined) row = { ...row, scope: input.scope };
    } else throw new Fault(400, 'unsupported_grant_type', 'Unsupported grant');
    const access = nonce(), refresh = nonce();
    next.tokens[hash(access)] = { client: row.client, scope: row.scope, family: row.family, resource: row.resource, expires: this.now() + 3600000 };
    const offline = row.scope.split(' ').includes('offline_access');
    if (offline) {
      check(Object.keys(next.refresh).length < 128, 'Refresh family limit reached', 429);
      next.refresh[hash(refresh)] = { ...row };
    }
    writePrivate(this.directory, 'oauth.json', next); this.state = next;
    if (codeKey) this.codes.delete(codeKey);
    return { access_token: access, token_type: 'Bearer', expires_in: 3600, scope: row.scope, ...(offline ? { refresh_token: refresh } : {}) };
  }
  authenticate(token: unknown, resource = this.resource) {
    if (typeof token !== 'string' || token.length > 256) return null;
    const row = this.state.tokens[hash(token)];
    return row && row.expires > this.now() && row.resource === resource && row.scope.split(' ').includes('mcp:tools') ? row.client : null;
  }
}
