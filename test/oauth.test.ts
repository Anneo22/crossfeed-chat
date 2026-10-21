import { tempPrefix } from './temp.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { OAuth } from '../src/oauth.ts';
import { hash } from '../src/security.ts';
import { Gateway } from '../src/gateway.ts';

const issuer = 'https://crossfeed.example';
const redirect = 'https://chatgpt.com/connector/oauth/connector_123';
const verifier = 'v'.repeat(43);
const fault = (status: number, code?: string) => (error: any) => error.status === status && (!code || error.code === code);
function fixture(t: import('node:test').TestContext) {
  const root = fs.mkdtempSync(tempPrefix('crossfeed-oauth-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'state');
  let clock = 1_000_000;
  const now = () => clock;
  return { directory, oauth: new OAuth(directory, issuer, now), now, advance: (ms: number) => { clock += ms; } };
}
const registration = (extra?: Record<string, any>) => ({ redirect_uris: [redirect], token_endpoint_auth_method: 'none', ...extra });
function authorization(oauth: any, client: any, extra: Record<string, any> = {}) {
  return { client_id: client.client_id, redirect_uri: client.redirect_uris[0], response_type: 'code', code_challenge: hash(verifier), code_challenge_method: 'S256', resource: oauth.resource, scope: 'mcp:tools offline_access', state: 'opaque-client-state', ...extra };
}
function approveCode(oauth: any, extra: Record<string, any> = {}) {
  oauth.open();
  const client = oauth.register(registration(extra.registration));
  const pending = oauth.authorize(authorization(oauth, client, extra.authorization));
  oauth.approve(pending.id);
  const callback = new URL(oauth.consent(pending.id, pending.browser).redirect!);
  return { client, pending, code: callback.searchParams.get('code'), callback };
}
function redeem(oauth: any, grant: any, extra: Record<string, any> = {}) {
  return oauth.token({ grant_type: 'authorization_code', client_id: grant.client.client_id, redirect_uri: grant.client.redirect_uris[0], resource: oauth.resource, code: grant.code, code_verifier: verifier, ...extra });
}
const refresh = (oauth: any, client: any, token: any, extra: Record<string, any> = {}) => oauth.token({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: token, resource: oauth.resource, ...extra });

test('reconnecting the same paired client preserves access to its existing worker labels', async t => {
  const { oauth, advance } = fixture(t);
  const first = approveCode(oauth); const g = new Gateway({ prefix: 'chatgpt', labels: {} }, { pollMs: 1 });
  t.after(() => g.close());
  await g.exchange(first.client.client_id, { worker_label: 'sol' });
  advance(46000);
  const second = approveCode(oauth);
  assert.equal(second.client.client_id, first.client.client_id);
  assert.equal((await g.exchange(second.client.client_id, { worker_label: 'sol' })).state, 'idle');
});

test('token capacity refusal preserves an auth code and refresh grant for a later retry', t => {
  const { oauth } = fixture(t);
  const grant = approveCode(oauth);
  for (let i = 0; i < 128; i++) oauth.state.tokens[`occupied-${i}`] = { family: `other-${i}`, expires: oauth.now() + 3600000 } as (typeof oauth.state.tokens)[string];
  assert.throws(() => redeem(oauth, grant), fault(429));
  assert(oauth.codes.has(hash(grant.code!)));
  delete oauth.state.tokens['occupied-0'];
  const issued = redeem(oauth, grant);
  delete oauth.state.tokens[hash(issued.access_token)];
  oauth.state.tokens['occupied-0'] = { family: 'other-0', expires: oauth.now() + 3600000 } as (typeof oauth.state.tokens)[string];
  assert.throws(() => refresh(oauth, grant.client, issued.refresh_token), fault(429));
  assert(oauth.state.refresh[hash(issued.refresh_token)]);
  assert(!oauth.state.spent[hash(issued.refresh_token)]);
  delete oauth.state.tokens['occupied-0'];
  assert(refresh(oauth, grant.client, issued.refresh_token).access_token);
});

test('token persistence failure and refresh-family capacity never consume a valid grant', t => {
  const { oauth, directory } = fixture(t);
  const grant = approveCode(oauth);
  fs.chmodSync(path.join(directory, 'oauth.json'), 0o644);
  assert.throws(() => redeem(oauth, grant), fault(500));
  assert(oauth.codes.has(hash(grant.code!)));
  assert.equal(Object.keys(oauth.state.tokens).length, 0);
  fs.chmodSync(path.join(directory, 'oauth.json'), 0o600);
  for (let i = 0; i < 128; i++) oauth.state.refresh[`occupied-${i}`] = { expires: oauth.now() + 3600000 } as (typeof oauth.state.tokens)[string];
  assert.throws(() => redeem(oauth, grant), fault(429));
  assert(oauth.codes.has(hash(grant.code!)));
  delete oauth.state.refresh['occupied-0'];
  assert(redeem(oauth, grant).access_token);
});

test('registration is host-window gated and expires after five minutes', t => {
  const { oauth, advance } = fixture(t);
  assert.throws(() => oauth.register(registration()), fault(403, 'registration_window_closed'));
  const opened = oauth.open();
  assert.equal(opened.public_url, issuer);
  const first = oauth.register(registration());
  assert.equal(oauth.register(registration()).client_id, first.client_id);
  advance(300000);
  assert.throws(() => oauth.register(registration()), fault(403, 'registration_window_closed'));
  assert.throws(() => oauth.authorize(authorization(oauth, first)), fault(403));
});

test('callback registration admits only the exact bounded ChatGPT connector route', t => {
  const { oauth } = fixture(t); oauth.open();
  for (const id of ['a'.repeat(6), 'a'.repeat(160), 'abc_12-DEF'])
    assert.equal(oauth.register(registration({ redirect_uris: [`https://chatgpt.com/connector/oauth/${id}`] })).redirect_uris[0], `https://chatgpt.com/connector/oauth/${id}`);
  assert.equal(oauth.register(registration({ redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'] })).redirect_uris[0], 'https://chatgpt.com/connector_platform_oauth_redirect');
  for (const uri of [
    'https://chatgpt.com/connector_platform_oauth_redirect/', 'https://chatgpt.com/connector_platform_oauth_redirect?x=1', 'https://chatgpt.com/connector_platform_oauth_redirectx',
    'http://chatgpt.com/connector/oauth/abc123', 'https://chatgpt.com.evil.test/connector/oauth/abc123',
    'https://user:pass@chatgpt.com/connector/oauth/abc123', 'https://chatgpt.com/connector/oauth/abc123?next=evil',
    'https://chatgpt.com/connector/oauth/abc123#fragment', 'https://chatgpt.com/connector/oauth/abc12',
    `https://chatgpt.com/connector/oauth/${'a'.repeat(161)}`, 'https://chatgpt.com/connector/oauth/abc123/extra',
    'https://chatgpt.com/connector/oauth/abc123/', 'https://chatgpt.com/connector/oauth/abc%20123',
    'https://chatgpt.com/connector/oauth', 'https://chatgpt.com/connector/oauth_extra',
    'https://chatgpt.com/connector_platform/oauth/abc123', 'https://chatgpt.com/aip/oauth/abc123',
    'https://chatgpt.com/c/abc123',
  ]) assert.throws(() => oauth.register(registration({ redirect_uris: [uri] })), fault(400, 'invalid_redirect_uri'), uri);
});

test('registration rejects multiple callbacks, private client secrets, wrong grants and scopes', t => {
  const { oauth } = fixture(t); oauth.open();
  for (const extra of [
    { redirect_uris: [] }, { redirect_uris: [redirect, redirect] }, { token_endpoint_auth_method: 'client_secret_basic' },
    { grant_types: ['refresh_token'] }, { grant_types: ['authorization_code', 'password'] }, { response_types: ['token'] },
    { scope: 'offline_access' }, { scope: 'mcp:tools admin' }, { scope: 'mcp:tools mcp:tools' }, { client_name: 'Name\nInjected' },
  ]) assert.throws(() => oauth.register(registration(extra)), fault(400));
});

test('registration and pending approval counts are bounded', t => {
  const { oauth } = fixture(t); oauth.open();
  const client = oauth.register(registration());
  for (let i = 1; i < 32; i++) oauth.register(registration({ client_name: `Client ${i}` }));
  assert.throws(() => oauth.register(registration({ client_name: 'Client 33' })), fault(429));
  for (let i = 0; i < 32; i++) oauth.authorize(authorization(oauth, client));
  assert.throws(() => oauth.authorize(authorization(oauth, client)), fault(429));
});

test('authorization requires S256 PKCE, exact callback, resource and worker scope', t => {
  const { oauth } = fixture(t); oauth.open(); const client = oauth.register(registration());
  for (const extra of [
    { response_type: 'token' }, { code_challenge_method: 'plain' }, { code_challenge_method: undefined },
    { code_challenge: undefined }, { code_challenge: 'a'.repeat(42) }, { code_challenge: '+'.repeat(43) },
    { resource: undefined }, { resource: issuer }, { resource: `${issuer}/mcp/` }, { redirect_uri: `${redirect}/changed` },
    { client_id: 'unknown-client' }, { scope: 'offline_access' }, { scope: 'mcp:tools extra' }, { state: '' },
  ]) assert.throws(() => oauth.authorize(authorization(oauth, client, extra)), fault(400));
  assert.equal(oauth.list().length, 0);
});

test('host approval is mandatory and consent is bound to its original browser', t => {
  const { oauth } = fixture(t); oauth.open(); const client = oauth.register(registration());
  const pending = oauth.authorize(authorization(oauth, client));
  assert.equal(oauth.list()[0].id, pending.id);
  assert.equal(oauth.consent(pending.id, pending.browser).redirect, undefined);
  assert.match(oauth.consent(pending.id, pending.browser).html!, /Approve on your computer/);
  assert.throws(() => oauth.consent(pending.id, 'wrong-browser'), fault(404));
  assert.throws(() => oauth.consent(pending.id, undefined), fault(404));
  assert.throws(() => oauth.approve('approval_unknown'), fault(404));
  oauth.approve(pending.id);
  assert.throws(() => oauth.consent(pending.id, 'wrong-browser'), fault(404));
  const target = new URL(oauth.consent(pending.id, pending.browser).redirect!);
  assert.equal(target.origin + target.pathname, redirect);
  assert.equal(target.searchParams.get('state'), 'opaque-client-state');
  assert.equal(target.searchParams.get('iss'), issuer);
  assert.ok(target.searchParams.get('code'));
  assert.throws(() => oauth.consent(pending.id, pending.browser), fault(404));
});

test('approval closes registration and discards competing approvals', t => {
  const { oauth } = fixture(t); oauth.open(); const client = oauth.register(registration());
  const chosen = oauth.authorize(authorization(oauth, client));
  const other = oauth.authorize(authorization(oauth, client));
  oauth.approve(chosen.id);
  assert.throws(() => oauth.register(registration()), fault(403));
  assert.throws(() => oauth.approve(chosen.id), fault(404));
  assert.throws(() => oauth.approve(other.id), fault(404));
  assert.throws(() => oauth.consent(other.id, other.browser), fault(404));
  assert.ok(oauth.consent(chosen.id, chosen.browser).redirect);
});

test('pending approvals expire and client names are escaped in consent HTML', t => {
  const { oauth, advance } = fixture(t); oauth.open();
  const client = oauth.register(registration({ client_name: '<script>alert("x")</script>' }));
  const pending = oauth.authorize(authorization(oauth, client));
  const html = oauth.consent(pending.id, pending.browser).html;
  assert.ok(html!.includes('&lt;script&gt;'));
  assert.ok(!html!.includes('<script>'));
  advance(90000);
  assert.equal(oauth.list().length, 0);
  assert.throws(() => oauth.approve(pending.id), fault(404));
  assert.throws(() => oauth.consent(pending.id, pending.browser), fault(404));
});

test('authorization codes bind verifier, client, callback and resource and are single-use', t => {
  const { oauth } = fixture(t); const grant = approveCode(oauth);
  for (const extra of [
    { code_verifier: 'wrong'.repeat(9) }, { code_verifier: 'v'.repeat(42) }, { code_verifier: 'v'.repeat(129) },
    { redirect_uri: `${redirect}/changed` }, { client_id: 'unknown' }, { resource: undefined }, { resource: `${issuer}/other` },
  ]) assert.throws(() => redeem(oauth, grant, extra), fault(400));
  const tokens = redeem(oauth, grant);
  assert.equal(oauth.authenticate(tokens.access_token), grant.client.client_id);
  assert.equal(tokens.token_type, 'Bearer'); assert.equal(tokens.expires_in, 3600);
  assert.throws(() => redeem(oauth, grant), fault(400, 'invalid_grant'));
});

test('an approved second client cannot redeem another client authorization code', t => {
  const { oauth } = fixture(t);
  const first = approveCode(oauth);
  const second = approveCode(oauth, { registration: { client_name: 'Other client' } });
  assert.throws(() => redeem(oauth, first, { client_id: second.client.client_id }), fault(400, 'invalid_grant'));
  assert.equal(oauth.authenticate(redeem(oauth, first).access_token), first.client.client_id);
});

test('authorization codes expire after sixty seconds', t => {
  const { oauth, advance } = fixture(t); const grant = approveCode(oauth);
  advance(60000);
  assert.throws(() => redeem(oauth, grant), fault(400, 'invalid_grant'));
});

test('refresh rotates tokens, invalidates old access and reuse revokes only its family', t => {
  const { oauth } = fixture(t);
  const first = approveCode(oauth); const initial = redeem(oauth, first);
  const independent = approveCode(oauth, { registration: { client_name: 'Independent' } });
  const unrelated = redeem(oauth, independent);
  const rotated = refresh(oauth, first.client, initial.refresh_token);
  assert.notEqual(rotated.access_token, initial.access_token);
  assert.notEqual(rotated.refresh_token, initial.refresh_token);
  assert.equal(oauth.authenticate(initial.access_token), null);
  assert.equal(oauth.authenticate(rotated.access_token), first.client.client_id);
  assert.throws(() => refresh(oauth, first.client, initial.refresh_token), fault(400, 'invalid_grant'));
  assert.equal(oauth.authenticate(rotated.access_token), null);
  assert.throws(() => refresh(oauth, first.client, rotated.refresh_token), fault(400, 'invalid_grant'));
  assert.equal(oauth.authenticate(unrelated.access_token), independent.client.client_id);
});

test('refresh is client/resource bound and cannot widen scope', t => {
  const { oauth } = fixture(t);
  const first = approveCode(oauth); const tokens = redeem(oauth, first);
  const second = approveCode(oauth, { registration: { client_name: 'Other' } });
  assert.throws(() => refresh(oauth, second.client, tokens.refresh_token), fault(400, 'invalid_grant'));
  assert.throws(() => refresh(oauth, first.client, tokens.refresh_token, { resource: undefined }), fault(400, 'invalid_target'));
  assert.throws(() => refresh(oauth, first.client, tokens.refresh_token, { scope: 'mcp:tools admin' }), fault(400, 'invalid_scope'));
  const narrowed = refresh(oauth, first.client, tokens.refresh_token, { scope: 'mcp:tools' });
  assert.equal(narrowed.scope, 'mcp:tools');
  assert.equal(narrowed.refresh_token, undefined);
  assert.equal(oauth.authenticate(narrowed.access_token), first.client.client_id);
});

test('offline_access determines refresh issuance and access expires independently', t => {
  const { oauth, advance } = fixture(t);
  const grant = approveCode(oauth, { authorization: { scope: 'mcp:tools' } });
  const tokens = redeem(oauth, grant);
  assert.equal(tokens.refresh_token, undefined);
  assert.equal(oauth.authenticate(tokens.access_token), grant.client.client_id);
  advance(3600000);
  assert.equal(oauth.authenticate(tokens.access_token), null);
  assert.equal(oauth.authenticate(undefined), null);
  assert.equal(oauth.authenticate('x'.repeat(257)), null);
});

test('refresh expires at the original thirty-day family deadline', t => {
  const { oauth, advance } = fixture(t); const grant = approveCode(oauth);
  const tokens = redeem(oauth, grant);
  advance(29 * 86400000);
  const rotated = refresh(oauth, grant.client, tokens.refresh_token);
  advance(86400000);
  assert.throws(() => refresh(oauth, grant.client, rotated.refresh_token), fault(400, 'invalid_grant'));
});

test('restart retains hashed tokens and rotation/reuse state, never raw secrets on disk', t => {
  const { oauth, directory, now } = fixture(t); const grant = approveCode(oauth);
  const tokens = redeem(oauth, grant);
  const raw = fs.readFileSync(path.join(directory, 'oauth.json'), 'utf8');
  for (const secret of [tokens.access_token, tokens.refresh_token, grant.code, grant.pending.browser, verifier]) assert.ok(!raw.includes(secret));
  const disk = JSON.parse(raw);
  assert.ok(disk.tokens[hash(tokens.access_token)]);
  assert.ok(disk.refresh[hash(tokens.refresh_token)]);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(directory, 'oauth.json')).mode & 0o777, 0o600);
  const restarted = new OAuth(directory, issuer, now);
  assert.equal(restarted.authenticate(tokens.access_token), grant.client.client_id);
  assert.throws(() => restarted.register(registration()), fault(403));
  const rotated = refresh(restarted, grant.client, tokens.refresh_token);
  const again = new OAuth(directory, issuer, now);
  assert.equal(again.authenticate(rotated.access_token), grant.client.client_id);
  assert.throws(() => refresh(again, grant.client, tokens.refresh_token), fault(400, 'invalid_grant'));
  const revoked = new OAuth(directory, issuer, now);
  assert.equal(revoked.authenticate(rotated.access_token), null);
  assert.throws(() => refresh(revoked, grant.client, rotated.refresh_token), fault(400, 'invalid_grant'));
});

test('restart discards pending grants and rejects a changed issuer', t => {
  const { oauth, directory, now } = fixture(t); const grant = approveCode(oauth);
  const restarted = new OAuth(directory, issuer, now);
  assert.throws(() => redeem(restarted, grant), fault(400, 'invalid_grant'));
  assert.throws(() => new OAuth(directory, 'https://different.example', now), fault(500));
});

test('OAuth metadata advertises the paired PKCE public-client protocol', t => {
  const { oauth } = fixture(t);
  assert.deepEqual(oauth.metadata().code_challenge_methods_supported, ['S256']);
  assert.deepEqual(oauth.metadata().token_endpoint_auth_methods_supported, ['none']);
  assert.equal(oauth.resourceMetadata().resource, `${issuer}/mcp`);
  assert.deepEqual(oauth.resourceMetadata().authorization_servers, [issuer]);
});

test('failed host approval does not commit client access in memory or disk and remains retryable', t => {
  const { oauth } = fixture(t); oauth.open();
  const client = oauth.register(registration()); const pending = oauth.authorize(authorization(oauth, client));
  const before = structuredClone(oauth.state); const save = oauth.save.bind(oauth);
  oauth.save = () => { throw Error('injected persistence failure'); };
  assert.throws(() => oauth.approve(pending.id));
  assert.deepEqual(oauth.state, before); assert.equal(oauth.pending.get(pending.id)!.approved, false);
  oauth.save = save; oauth.approve(pending.id); assert.equal(oauth.pending.get(pending.id)!.approved, true);
});

test('client listing omits tokens and revocation removes only the selected client and its live/pending grants across restart', t => {
  const {oauth, directory, now} = fixture(t); const a = approveCode(oauth); const tokens = redeem(oauth, a);
  const b = approveCode(oauth, {registration: {client_name: 'Other', redirect_uris: ['https://chatgpt.com/connector/oauth/other_client']}}); const other = redeem(oauth, b);
  oauth.open(); const pending = oauth.authorize(authorization(oauth, a.client));
  const list = oauth.clients(); assert.equal(list.length, 2); assert(!JSON.stringify(list).includes(tokens.access_token)); assert(!JSON.stringify(list).includes(tokens.refresh_token));
  assert.deepEqual(oauth.revoke(a.client.client_id), {revoked: a.client.client_id});
  assert.equal(oauth.authenticate(tokens.access_token), null); assert.equal(oauth.authenticate(other.access_token), b.client.client_id);
  assert.throws(() => refresh(oauth, a.client, tokens.refresh_token), fault(400, 'invalid_client')); assert(!oauth.pending.has(pending.id));
  const next = new OAuth(directory, issuer, now); assert.equal(next.clients().length, 1); assert.equal(next.authenticate(other.access_token), b.client.client_id);
  assert.throws(() => next.revoke(a.client.client_id), fault(404));
});
test('failed revoke persistence preserves all access and pending authorizations for retry', t => {
  const {oauth} = fixture(t), grant = approveCode(oauth), tokens = redeem(oauth, grant);
  const before = structuredClone(oauth.state); const mock = t.mock.method(fs, 'renameSync', () => {throw Error('disk full');});
  assert.throws(() => oauth.revoke(grant.client.client_id)); mock.mock.restore();
  assert.deepEqual(oauth.state, before); assert.equal(oauth.authenticate(tokens.access_token), grant.client.client_id);
  oauth.revoke(grant.client.client_id); assert.equal(oauth.authenticate(tokens.access_token), null);
});
