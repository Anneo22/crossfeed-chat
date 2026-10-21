import { apiURL } from './core.js';

const api = /** @type {HTMLInputElement} */ (document.querySelector('#api'));
const status = /** @type {HTMLElement} */ (document.querySelector('#status'));
const code = /** @type {HTMLElement} */ (document.querySelector('#code'));
if (chrome.storage.local.setAccessLevel) await chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
const saved = await chrome.storage.local.get(['apiURL']);
if (apiURL(saved.apiURL)) api.value = /** @type {string} */ (saved.apiURL);
/** @returns {Promise<void>} */
async function refresh() {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'pairing' });
    code.textContent = result?.code ?? 'Waiting for the local server';
    status.textContent = result?.state === 'approved' ? 'Paired. Wake requests are checked every 30 seconds.' : result?.state === 'pending' ? 'Waiting for approval. Match this code on your host.' : 'Start the local server to pair this extension.';
  } catch { status.textContent = 'The local server could not be reached.'; }
}
await refresh();
setInterval(refresh, 5000);
(/** @type {HTMLFormElement} */ (document.querySelector('#settings'))).addEventListener('submit', async event => {
  event.preventDefault();
  if (!apiURL(api.value)) { status.textContent = 'Enter a loopback URL with a port.'; return; }
  try {
    await chrome.runtime.sendMessage({ type: 'pairing', apiURL: api.value });
    await refresh();
  } catch { status.textContent = 'Settings could not be saved.'; }
});
