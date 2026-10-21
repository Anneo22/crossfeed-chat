interface PairingRecord { id: string; code: string; origin: string; state: string; created_at: number; approved_at?: number; expires_at?: number; secret_hash: string }
import { randomBytes } from 'node:crypto';
import { check, equal, hash, nonce, object, readPrivate, writePrivate } from './security.ts';

const originOK = (value: unknown): value is string => typeof value === 'string' && /^chrome-extension:\/\/[a-p]{32}$/.test(value);
const secretOK = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._~-]{32,256}$/.test(value);
const publicRecord = ({ secret_hash, ...record }: PairingRecord) => record;

export class Pairing {
  declare directory: string; declare now: () => number; declare pending: Map<string, PairingRecord>; declare approved: Map<string, PairingRecord>; declare attempts: {origin: string; at: number}[];

  constructor(directory: string, now = Date.now) {
    this.directory = directory;
    this.now = now;
    this.pending = new Map();
    this.attempts = [];
    const stored = readPrivate<{approved: PairingRecord[]}>(directory, 'extension-pairings.json', { approved: [] });
    check(object(stored) && Object.keys(stored).length === 1 && Array.isArray(stored.approved) && stored.approved.length <= 128, 'Invalid extension pairings', 500);
    this.approved = new Map();
    for (const entry of stored.approved) {
      check(object(entry) && Object.keys(entry).every(key => ['id', 'code', 'origin', 'state', 'created_at', 'approved_at', 'secret_hash'].includes(key)) &&
        /^[A-Za-z0-9_-]{32}$/.test(entry.id ?? '') && /^[A-F0-9]{4}-[A-F0-9]{4}$/.test(entry.code ?? '') && originOK(entry.origin) &&
        entry.state === 'approved' && Number.isSafeInteger(entry.created_at) && entry.created_at >= 0 &&
        Number.isSafeInteger(entry.approved_at) && entry.approved_at! >= entry.created_at && /^[A-Za-z0-9_-]{43}$/.test(entry.secret_hash ?? '') &&
        !this.approved.has(entry.id), 'Invalid extension pairings', 500);
      this.approved.set(entry.id, entry);
    }
  }
  get enabled() { return this.approved.size > 0; }
  persist() { writePrivate(this.directory, 'extension-pairings.json', { approved: [...this.approved.values()] }); }
  prune() {
    for (const [id, record] of this.pending) if (record.expires_at! <= this.now()) this.pending.delete(id);
  }
  validate(origin: unknown, secret: unknown) {
    check(originOK(origin), 'Extension origin required', 403);
    check(secretOK(secret), 'Invalid extension credential');
  }
  create(origin: string, secret: string) {
    this.validate(origin, secret);
    const now = this.now();
    this.attempts = this.attempts.filter(entry => entry.at > now - 60_000);
    check(this.attempts.length < 60 && this.attempts.filter(entry => entry.origin === origin).length < 12, 'Pairing requests are rate limited', 429, 'rate_limited');
    this.attempts.push({ origin, at: now });
    this.prune();
    const secret_hash = hash(secret);
    const existing = [...this.approved.values(), ...this.pending.values()].find(entry => entry.origin === origin && equal(entry.secret_hash, secret_hash));
    if (existing) return publicRecord(existing);
    check(this.pending.size < 64 && this.approved.size < 128, 'Extension pairing capacity reached', 429, 'capacity');
    let code: string;
    do { code = randomBytes(4).toString('hex').toUpperCase().replace(/^(.{4})/, '$1-'); }
    while ([...this.pending.values(), ...this.approved.values()].some(entry => entry.code === code));
    const record = { id: nonce(), code, origin, state: 'pending', created_at: now, expires_at: now + 300_000, secret_hash };
    this.pending.set(record.id, record);
    return publicRecord(record);
  }
  status(id: string, origin: string, secret: string) {
    this.validate(origin, secret);
    const record = this.pending.get(id) ?? this.approved.get(id);
    check(record && record.origin === origin && equal(record.secret_hash, hash(secret)), 'Pairing not found', 404, 'not_found');
    if (record.state === 'pending' && record.expires_at! <= this.now()) {
      this.pending.delete(id);
      return { ...publicRecord(record), state: 'expired' };
    }
    return publicRecord(record);
  }
  list() {
    this.prune();
    return { pending: [...this.pending.values()].map(publicRecord), approved: [...this.approved.values()].map(publicRecord) };
  }
  approve(selector: string) {
    this.prune();
    const record = [...this.pending.values()].find(entry => entry.id === selector || entry.code === selector);
    check(record, 'Pending pairing not found', 404, 'not_found');
    check(this.approved.size < 128, 'Extension pairing capacity reached', 429, 'capacity');
    const { expires_at, ...rest } = record;
    const approved = { ...rest, state: 'approved', approved_at: this.now() };
    this.approved.set(record.id, approved);
    try { this.persist(); } catch (error) { this.approved.delete(record.id); throw error; }
    this.pending.delete(record.id);
    return publicRecord(approved);
  }
  revoke(id: string) {
    const record = this.approved.get(id);
    check(record, 'Approved pairing not found', 404, 'not_found');
    this.approved.delete(id);
    try { this.persist(); } catch (error) { this.approved.set(id, record); throw error; }
    return { ...publicRecord(record), state: 'revoked' };
  }
  /** Distinguish independently paired credentials even when they share an extension origin. */
  identify(secret: unknown, origin: unknown): string | undefined {
    if (!originOK(origin) || !secretOK(secret)) return undefined;
    const secret_hash = hash(secret);
    return [...this.approved.values()].find(entry => entry.origin === origin && equal(entry.secret_hash, secret_hash))?.id;
  }
  authenticate(secret: unknown, origin: unknown) {
    return this.identify(secret, origin) !== undefined;
  }
}
