import type { JobRecord } from './types.ts';
import { hash, nonce, readPrivate, writePrivate } from './security.ts';

export interface RequestReceipt {
  request: string; caller: string; label: string; replica: string | null;
  size_bucket: string; enqueue_at: number | null; claim_at: number | null;
  wake_at: number | null; finish_at: number | null; wake_needed: boolean; outcome: string;
}
// Salted correlation identifiers cannot be joined to caller IDs outside this state directory.
export class Receipts {
  declare directory: string; declare salt: string; declare rows: RequestReceipt[];
  constructor(directory: string) {
    this.directory = directory;
    const identity = readPrivate<{salt: string}>(directory,'receipt-identity.json',{salt:nonce()});
    this.salt = identity.salt; writePrivate(directory,'receipt-identity.json',identity);
    this.rows = readPrivate<{version: number; receipts: RequestReceipt[]}>(directory,'receipts.json',{version:1,receipts:[]},16 * 1024 * 1024).receipts;
  }
  pseudonym(value: string) { return hash(`${this.salt}\0${value}`).slice(0,22); }
  record(job: JobRecord) {
    const bytes = Buffer.byteLength(JSON.stringify(job.request));
    const row: RequestReceipt = {
      request: job.id, caller: job.caller ?? this.pseudonym(`unidentified:${job.id}`), label: job.label,
      replica: job.worker ?? null, size_bucket: bytes < 1024 ? '<1KiB' : bytes < 16384 ? '1-16KiB' : bytes < 65536 ? '16-64KiB' : '>=64KiB',
      enqueue_at: job.enqueued_at ?? null, claim_at: job.claimed_at ?? null, wake_at: job.wake_at ?? null,
      finish_at: job.finished_at ?? null, wake_needed: job.wake_needed ?? false, outcome: job.error?.code ?? job.state,
    };
    const rows = [...this.rows.filter(r => r.request !== row.request),row].slice(-10000);
    writePrivate(this.directory,'receipts.json',{version:1,receipts:rows}); this.rows = rows;
  }
}
