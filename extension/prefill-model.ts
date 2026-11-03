import type { PageTicket, PrefillModelResult } from './types.d.ts';

/** Read-only model attestation in the same document authorized by prefillProbe.
 * The host opens/closes the picker with trusted pointer/Escape input, never .click(). */
export async function prefillModel(ticket: PageTicket, expectedMaximum: number, timeoutMs = 5000, pollMs = 50, action: 'point' | 'observe' = 'observe'): Promise<PrefillModelResult> {
  const ownedDocument = document;
  const tail = ` wake up. First gateway_exchange: worker_label=${JSON.stringify(ticket.label)} exactly as issued, wake_nonce=${JSON.stringify(ticket.nonce)}, maximum_wait_seconds=20. Then use the server-returned worker_label and repeat wake_nonce=${JSON.stringify(ticket.nonce)} on all subsequent gateway_exchange calls. Poll until state=released and continue=false; do not send a final chat reply between jobs. Return local caller tools as structured tool_calls through gateway_exchange; do not execute them natively.`;
  const prompt = `@${ticket.connector}${tail}`;
  const levels = ['Instant', 'Medium', 'High', 'Extra High', 'Pro'];
  const deadline = Math.min(ticket.expires_at, Date.now() + Math.max(1, Math.min(timeoutMs, 5000)));
  const text = (el: Element | null | undefined): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const visible = <E extends Element>(el: E | null | undefined): el is E => !!el && el.isConnected !== false && !el.closest('[hidden], [inert]') && el.getClientRects().length > 0 && (typeof getComputedStyle !== 'function' || !['hidden', 'collapse'].includes(getComputedStyle(el).visibility));
  const all = (root: ParentNode, selector: string): HTMLElement[] => [...root.querySelectorAll(selector)].filter(visible) as HTMLElement[];
  let phase = -1;
  const authorized = (): boolean => {
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
  let diagnostic: NonNullable<PrefillModelResult['diagnostic']> = {action, models:0, menus:0};
  const fail = (error: string): PrefillModelResult => ({verified:false,error,diagnostic});
  let model: HTMLElement | undefined, ownedMenu: HTMLElement | undefined;
  while (Date.now() < deadline) {
    if (!authorized()) return fail('page_changed');
    const models = all(document, 'button[aria-label="Select ChatGPT model"], [data-testid="model-switcher-dropdown-button"]');
    const menus = all(document, '[role="menu"]');
    diagnostic = {action, models:Math.min(8,models.length), menus:Math.min(8,menus.length)};
    if (models.length > 1 || menus.length > 1) return fail('level_unconfirmed');
    if (model && (models.length !== 1 || models[0] !== model)) return {verified: false, error: 'page_changed'};
    if (models.length === 1) {
      model = models[0];
      if (model.getAttribute('aria-disabled') === 'true' || (model as HTMLButtonElement).disabled) return {verified: false, error: 'level_unconfirmed'};
      if (action === 'point') {
        const r = model.getBoundingClientRect();
        const x = r.x + r.width / 2, y = r.y + r.height / 2;
        if (![x, y, r.width, r.height].every(Number.isFinite) || r.width <= 0 || r.height <= 0) return {verified: false, error: 'level_unconfirmed'};
        return {verified: false, ready: true, modelPoint: {x, y}, open: menus.length === 1};
      }
      if (menus.length === 1) {
        if (ownedMenu && ownedMenu !== menus[0]) return {verified: false, error: 'page_changed'};
        ownedMenu = menus[0];
        const rows = [...ownedMenu.querySelectorAll('[role="menuitemradio"]')] as HTMLElement[];
        const selected = rows.filter(row => row.getAttribute('aria-checked') === 'true');
        const sliders = all(ownedMenu, '[role="slider"]');
        Object.assign(diagnostic,{selected:Math.min(8,selected.length),sliders:Math.min(8,sliders.length)});
        if (selected.length === 1 && sliders.length === 1) {
          const row = selected[0], slider = sliders[0];
          const exactRow = text(row) === ticket.row || all(row, 'span').some(span => text(span) === ticket.row);
          const position = slider.getAttribute('aria-valuenow');
          const status = all(ownedMenu, '[role="status"]').map(text).filter(value => / of /i.test(value));
          const bounded = (value: string | null) => value !== null && /^[0-4]$/.test(value) ? Number(value) : -1;
          Object.assign(diagnostic,{rowMatches:exactRow,minimum:bounded(slider.getAttribute('aria-valuemin')),maximum:bounded(slider.getAttribute('aria-valuemax')),position:bounded(position),statusMatches:status.length===1&&status[0]===`${levels[ticket.level]}, ${ticket.level+1} of ${expectedMaximum+1}.`});
          if (!exactRow || slider.getAttribute('aria-valuemin') !== '0' || slider.getAttribute('aria-valuemax') !== String(expectedMaximum)) return fail('level_unconfirmed');
          // Thumb and announcement hydrate independently. Wait for exact
          // agreement, never change the selection or accept a stale proof.
          if (position === String(ticket.level) && status.length === 1 && status[0] === `${levels[ticket.level]}, ${ticket.level + 1} of ${expectedMaximum + 1}.`)
            return {verified: true, row: ticket.row, level: ticket.level, maximum: expectedMaximum};
        }
      }
    }
    await new Promise(resolve => setTimeout(resolve, Math.max(1, Math.min(pollMs, deadline - Date.now()))));
  }
  return fail('level_unconfirmed');
}
