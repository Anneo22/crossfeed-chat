/**
 * Re-observe (never change) the configured picker after an owned native-prefill
 * navigation. Serialized into the same document attested by prefillProbe.
 * @param {import('./types.js').PageTicket} ticket
 * @param {number} expectedMaximum
 * @param {number} [timeoutMs]
 * @param {number} [pollMs]
 * @returns {Promise<import('./types.js').PrefillModelResult>}
 */
export async function prefillModel(ticket, expectedMaximum, timeoutMs = 1500, pollMs = 50) {
  const ownedDocument = document;
  const tail = ` wake up. First gateway_exchange: worker_label=${JSON.stringify(ticket.label)} exactly as issued, wake_nonce=${JSON.stringify(ticket.nonce)}, maximum_wait_seconds=20. Then use the server-returned worker_label and repeat wake_nonce=${JSON.stringify(ticket.nonce)} on all subsequent gateway_exchange calls. Poll until state=released and continue=false; do not send a final chat reply between jobs. Return local caller tools as structured tool_calls through gateway_exchange; do not execute them natively.`;
  const prompt = `@${ticket.connector}${tail}`;
  const levels = ['Instant', 'Medium', 'High', 'Extra High', 'Pro'];
  const deadline = Math.min(ticket.expires_at, Date.now() + Math.max(1, Math.min(timeoutMs, 1500)));
  /** @param {Element | null | undefined} el */
  const text = el => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  /** @template {Element} E @param {E | null | undefined} el @returns {el is E} */
  const visible = el => /** @type {boolean} */ (!!el && el.isConnected !== false && !el.closest('[hidden], [inert]') && el.getClientRects().length > 0 && (typeof getComputedStyle !== 'function' || !['hidden', 'collapse'].includes(getComputedStyle(el).visibility)));
  /** @param {ParentNode} root @param {string} selector @returns {HTMLElement[]} */
  const all = (root, selector) => /** @type {HTMLElement[]} */ ([...root.querySelectorAll(selector)].filter(visible));
  let phase = -1;
  const authorized = () => {
    if (document !== ownedDocument || Date.now() >= ticket.expires_at) return false;
    let url;
    try { url = new URL(location.href); } catch { return false; }
    if (url.href !== location.href || url.origin !== 'https://chatgpt.com' || url.username || url.password || url.port || url.hash || url.pathname !== '/') return false;
    const entries = [...url.searchParams.entries()];
    const next = !url.search ? 2 : entries.length === 1 && entries[0][1] === prompt && url.search.startsWith(`?${entries[0][0]}=`) ? entries[0][0] === 'q' ? 0 : entries[0][0] === 'prompt' ? 1 : -1 : -1;
    if (next < 0 || next < phase) return false;
    phase = next;
    return true;
  };
  if (ticket.type === 'composer' || ticket.wake_mode === 'native' || !Number.isInteger(expectedMaximum) || expectedMaximum < 0 || expectedMaximum > 4 || !Number.isInteger(ticket.level) || ticket.level < 0 || ticket.level > expectedMaximum) return {verified: false, error: 'level_unconfirmed'};
  if (!authorized()) return {verified: false, error: 'page_changed'};
  const models = all(document, 'button[aria-label="Select ChatGPT model"], [data-testid="model-switcher-dropdown-button"]');
  if (models.length !== 1 || all(document, '[role="menu"]').length) return {verified: false, error: 'level_unconfirmed'};
  const model = models[0];
  if (typeof model.click !== 'function' || model.getAttribute('aria-disabled') === 'true' || /** @type {HTMLButtonElement} */ (model).disabled) return {verified: false, error: 'level_unconfirmed'};
  /** @type {HTMLElement | undefined} */
  let ownedMenu;
  try {
    model.click();
    while (Date.now() < deadline) {
      if (!authorized() || !visible(model)) return {verified: false, error: 'page_changed'};
      const menus = all(document, '[role="menu"]');
      if (menus.length > 1) return {verified: false, error: 'level_unconfirmed'};
      if (menus.length === 1) {
        if (ownedMenu && ownedMenu !== menus[0]) return {verified: false, error: 'page_changed'};
        ownedMenu = menus[0];
        // An inactive picker track can still carry its actual selected row.
        const rows = /** @type {HTMLElement[]} */ ([...ownedMenu.querySelectorAll('[role="menuitemradio"]')]);
        const selected = rows.filter(row => row.getAttribute('aria-checked') === 'true');
        const sliders = all(ownedMenu, '[role="slider"]');
        if (selected.length === 1 && sliders.length === 1) {
          const row = selected[0], slider = sliders[0];
          const exactRow = text(row) === ticket.row || all(row, 'span').some(span => text(span) === ticket.row);
          const position = slider.getAttribute('aria-valuenow');
          const status = all(ownedMenu, '[role="status"]').map(text).filter(value => / of /i.test(value));
          if (!exactRow || slider.getAttribute('aria-valuemin') !== '0' || slider.getAttribute('aria-valuemax') !== String(expectedMaximum) || position !== String(ticket.level) || status.length !== 1 || status[0] !== `${levels[ticket.level]}, ${ticket.level + 1} of ${expectedMaximum + 1}.`) return {verified: false, error: 'level_unconfirmed'};
          return {verified: true, row: ticket.row, level: ticket.level, maximum: expectedMaximum};
        }
      }
      await new Promise(resolve => setTimeout(resolve, Math.max(1, Math.min(pollMs, deadline - Date.now()))));
    }
    return {verified: false, error: 'level_unconfirmed'};
  } catch {
    return {verified: false, error: 'level_unconfirmed'};
  } finally {
    // Only close the same observed picker in this same authorized document.
    if (ownedMenu && authorized() && visible(model)) {
      const menus = all(document, '[role="menu"]');
      if (menus.length === 1 && menus[0] === ownedMenu) {
        try { model.click(); } catch { /* Never repair state by typing or clearing. */ }
      }
    }
  }
}
