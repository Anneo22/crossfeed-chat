import type { ExchangeArguments, WakeTicket, Worker } from './types.ts';
import { check, object } from './security.ts';

// Older extensions type only the label. Carry the claimed nonce in that label
// for scoped wakes; the gateway still verifies nonce and conversation ownership.
export const wakeAlias = (nonce: string) => `wake-${nonce}`;
export function extensionTicket<T extends Omit<WakeTicket, 'state'>>(ticket: T, scoped: boolean): T {
  return scoped ? {...ticket, label: wakeAlias(ticket.nonce)} : ticket;
}
export function routeWake(value: unknown, tickets: Iterable<WakeTicket>, workers: Map<string, Worker>): unknown {
  if (!object(value) || typeof value.worker_label !== 'string') return value;
  const match = /^wake-([A-Za-z0-9_-]{32})$/.exec(value.worker_label);
  if (!match) return value;
  const nonce = match[1];
  const ticket = [...tickets].find(t => t.nonce === nonce && ['claimed', 'confirmed'].includes(t.state));
  const identity = ticket?.label ?? [...workers].find(([,w]) => w.wake_nonce === nonce)?.[0];
  if (!identity) return value;
  check(value.wake_nonce === undefined || value.wake_nonce === nonce, 'Wake routing nonce mismatch', 409);
  return {...value, worker_label: identity, wake_nonce: nonce} as ExchangeArguments;
}
