import { apiURL } from './core.ts';
import type { APIConfig, Fetcher, PairingRecord, PollBrowser, StoredPairing } from './types.d.ts';

export const defaultAPI = 'http://127.0.0.1:4319';
const active = new WeakMap<Pick<PollBrowser, 'storage'>, Promise<APIConfig | null>>();

async function exchange(api: string, route: string, input: Record<string, string>, fetcher: Fetcher): Promise<PairingRecord | null> {
  const response = await fetcher(api + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(4000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw Error('pairing_refused');
  const raw = await response.text();
  if (raw.length > 4096) throw Error('invalid_pairing');
  const record = JSON.parse(raw) as PairingRecord | null;
  if (!record || !/^[A-Za-z0-9_-]{32}$/.test(record.id ?? '') || !/^[A-F0-9]{4}-[A-F0-9]{4}$/.test(record.code ?? '') ||
    !['pending', 'approved', 'expired'].includes(record.state) || record.state === 'pending' && (!Number.isSafeInteger(record.expires_at) || (record.expires_at as number) <= Date.now())) throw Error('invalid_pairing');
  return { id: record.id, code: record.code, state: record.state, ...(record.expires_at ? { expires_at: record.expires_at } : {}) };
}

export function ensurePairing(browser: Pick<PollBrowser, 'storage'>, fetcher: Fetcher = fetch): Promise<APIConfig | null> {
  if (active.has(browser)) return active.get(browser)!;
  const running = (async () => {
    if (browser.storage.local.setAccessLevel) await browser.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    let { apiURL: api, key, pairing, pairingVersion } = await browser.storage.local.get(['apiURL', 'key', 'pairing', 'pairingVersion']);
    api = apiURL(api) ?? defaultAPI;
    if (pairingVersion !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(key ?? '')) {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      key = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      pairing = null;
      await browser.storage.local.set({ apiURL: api, key, pairingVersion: 1, pairing: null });
    }
    if (pairing?.apiURL !== api) pairing = null;
    if (pairing?.state === 'approved' && Number.isSafeInteger(pairing.checked_at) && Date.now() - (pairing.checked_at as number) >= 0 && Date.now() - (pairing.checked_at as number) < 60_000) return { apiURL: api, key: key as string };
    if (pairing?.id) pairing = await exchange(api, '/extension/pair/status', { id: pairing.id, secret: key as string }, fetcher);
    if (!pairing || pairing.state === 'expired') pairing = await exchange(api, '/extension/pair', { secret: key as string }, fetcher);
    if (!pairing) throw Error('pairing_refused');
    pairing = { ...pairing, apiURL: api, checked_at: Date.now() };
    await browser.storage.local.set({ apiURL: api, pairing });
    return pairing.state === 'approved' ? { apiURL: api, key: key as string } : null;
  })();
  active.set(browser, running);
  return running.finally(() => active.delete(browser));
}
