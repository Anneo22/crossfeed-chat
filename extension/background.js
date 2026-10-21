// Explicit ordinary gateway alias/nonce protocol: refresh the packaged entrypoint and modules.
import { apiURL, clearOwnedWakeTabs, makePoller } from './core.js';
import { ensurePairing } from './pairing.js';

const poll = makePoller(chrome);
const alarmName = 'crossfeed-fresh-chat-wake';
/** @returns {Promise<void>} */
async function setup() {
  if (chrome.storage.local.setAccessLevel) await chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
  await chrome.alarms.create(alarmName, {periodInMinutes: 0.5});
}
const ready = setup();
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('options.html') || message?.type !== 'pairing') return;
  void ready.then(async () => {
    if (message.apiURL !== undefined) {
      if (!apiURL(message.apiURL)) throw Error('invalid_api');
      // Finish an install/alarm pairing before changing its storage scope.
      await ensurePairing(chrome).catch(() => {});
      await chrome.storage.local.set({ apiURL: message.apiURL, pairing: null });
    }
    await ensurePairing(chrome);
    const { pairing } = await chrome.storage.local.get(['pairing']);
    sendResponse(pairing ? { state: pairing.state, code: pairing.code } : { state: 'unpaired' });
  }).catch(() => sendResponse({ state: 'unreachable' }));
  return true;
});
void ready.then(poll).catch(() => {});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === alarmName) void ready.then(poll).catch(() => {}); });
chrome.runtime.onInstalled.addListener(() => { void ready.then(poll).catch(() => {}); });
chrome.runtime.onStartup.addListener(() => {
  void ready.then(async () => {
    // Tab ids are reused after a Chrome restart; never close a stranger's tab.
    if (typeof chrome.storage?.local?.set === 'function') await clearOwnedWakeTabs(chrome);
    await poll();
  }).catch(() => {});
});
