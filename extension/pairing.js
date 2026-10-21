import { apiURL } from './core.js';

export const defaultAPI = 'http://127.0.0.1:4319';
/** @type {WeakMap<Pick<import('./types.js').PollBrowser, 'storage'>, Promise<import('./types.js').APIConfig | null>>} */
const active = new WeakMap();

/**
 * @param {string} api
 * @param {string} route
 * @param {Record<string, string>} input
 * @param {import('./types.js').Fetcher} fetcher
 * @returns {Promise<import('./types.js').PairingRecord | null>}
 */
async function exchange(api, route, input, fetcher) {
  const response = await fetcher(api + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(4000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw Error('pairing_refused');
  const raw = await response.text();
  if (raw.length > 4096) throw Error('invalid_pairing');
  const record = /** @type {import('./types.js').PairingRecord | null} */ (JSON.parse(raw));
  if (!record || !/^[A-Za-z0-9_-]{32}$/.test(record.id ?? '') || !/^[A-F0-9]{4}-[A-F0-9]{4}$/.test(record.code ?? '') ||
    !['pending', 'approved', 'expired'].includes(record.state) || record.state === 'pending' && (!Number.isSafeInteger(record.expires_at) || /** @type {number} */ (record.expires_at) <= Date.now())) throw Error('invalid_pairing');
  return { id: record.id, code: record.code, state: record.state, ...(record.expires_at ? { expires_at: record.expires_at } : {}) };
}

/**
 * @param {Pick<import('./types.js').PollBrowser, 'storage'>} browser
 * @param {import('./types.js').Fetcher} [fetcher]
 * @returns {Promise<import('./types.js').APIConfig | null>}
 */
export function ensurePairing(browser, fetcher = fetch) {
  if (active.has(browser)) return /** @type {Promise<import('./types.js').APIConfig | null>} */ (active.get(browser));
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
    if (pairing?.state === 'approved' && Number.isSafeInteger(pairing.checked_at) && Date.now() - /** @type {number} */ (pairing.checked_at) >= 0 && Date.now() - /** @type {number} */ (pairing.checked_at) < 60_000) return { apiURL: api, key: /** @type {string} */ (key) };
    if (pairing?.id) pairing = await exchange(api, '/extension/pair/status', { id: pairing.id, secret: /** @type {string} */ (key) }, fetcher);
    if (!pairing || pairing.state === 'expired') pairing = await exchange(api, '/extension/pair', { secret: /** @type {string} */ (key) }, fetcher);
    if (!pairing) throw Error('pairing_refused');
    pairing = { ...pairing, apiURL: api, checked_at: Date.now() };
    await browser.storage.local.set({ apiURL: api, pairing });
    return pairing.state === 'approved' ? { apiURL: api, key: /** @type {string} */ (key) } : null;
  })();
  active.set(browser, running);
  return running.finally(() => active.delete(browser));
}
