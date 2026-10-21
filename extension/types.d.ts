/** Boundary types for the unpacked JavaScript extension, not runtime code. */
export interface AttachmentMetadata { name: string; mime: string; bytes: number }
export interface Attachment extends AttachmentMetadata { path: string }
export interface TicketFields {
  nonce: string;
  row: string;
  level: number;
  wake_mode?: 'configured' | 'native';
  label: string;
  title?: string;
  connector: string;
  expires_at: number;

}
export type Ticket = TicketFields & (
  {type?: undefined; job_id?: undefined; attachments?: undefined} |
  {type: 'composer'; job_id: string; attachments: Attachment[]}
);
/** Page scripts deliberately receive no local disk paths. */
export type PageTicket = TicketFields & (
  {type?: undefined; job_id?: undefined; attachments?: undefined} |
  {type: 'composer'; job_id: string; attachments: AttachmentMetadata[]}
);
export interface ArchiveTicket { nonce: string; url: string; expires_at: number; remove?: boolean }
export interface APIConfig { apiURL: string; key: string }
export interface APIReply {
  /** Untrusted until validTicket narrows it in the poller. */
  ticket?: unknown;
  archive?: ArchiveTicket | null;
  ok?: boolean;
  /** Advisory only; v2 replies are boolean; v3 and legacy replies carry a marker.
   * Neither absence nor a failed advisory vetoes an authenticated wake. */
  focus_guard?: boolean | {status: 'armed'; marker: string} | {status: 'unsupported'};
  registered?: boolean;
  media_pending?: boolean;
}
export interface PairingRecord {
  id: string;
  code: string;
  state: 'pending' | 'approved' | 'expired';
  expires_at?: number;
}
export interface StoredPairing extends PairingRecord { apiURL?: string; checked_at?: number }
export interface OwnedWakeTab { tab: number; window?: number; at: number }
export interface StorageState {
  apiURL?: string;
  key?: string;
  pairing?: StoredPairing | null;
  pairingVersion?: number;
  crossfeedWakeDiagnostic?: string;
  crossfeedWakeTabs?: OwnedWakeTab[];
}
export interface LocalStorage {
  get(keys: string[]): Promise<StorageState>;
  set(values: Partial<StorageState>): Promise<unknown>;
  setAccessLevel?(options: {accessLevel: 'TRUSTED_CONTEXTS'}): Promise<unknown>;
}
/** Only the response members actually consumed by the extension are required. */
export interface FetchResponse { ok: boolean; status?: number; text(): Promise<string> }
export interface FetchOptions extends Omit<RequestInit, 'headers' | 'body'> {
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}
export type Fetcher = (url: string, options: FetchOptions) => Promise<FetchResponse>;
export interface Point { x: number; y: number }
export interface PrefillLocationDiagnostic {
  uri_class: 'missing' | 'blank' | 'native_q' | 'native_prompt' | 'root' | 'root_other_query' | 'login' | 'conversation' | 'foreign' | 'other';
  parsed_phase: -1 | 0 | 1 | 2;
  query_count: number;
  query_names: string[];
  q_matches: boolean;
  prompt_matches: boolean;
}
export interface PrefillProbeResult { ready: boolean; error?: string; phase?: 0 | 1 | 2; diagnostic?: PrefillLocationDiagnostic }
export interface PrefillModelResult { verified: boolean; error?: string; row?: string; level?: number; maximum?: number }
export interface PrefillWakeResult { sent: boolean; error?: string; url?: string }
export type PageAction = 'ready' | 'registration' | 'modelFocus' | 'picker' | 'sliderFocus' | 'editorFocus' | 'mention' | 'resolved' | 'send' | 'uploadInput' | 'uploads' | 'discardOwnDraft' | 'discardBareMention';
/** Each action returns a subset; consumers verify the needed members. */
export interface PageProbe {
  rateLimited?: boolean;
  ready?: boolean;
  chat?: boolean;
  empty?: boolean;
  focused?: boolean;
  open?: boolean;
  resolved?: boolean;
  url?: string;
  row?: string | null;
  minimum?: string | null;
  maximum?: string | null;
  position?: number | null;
  status?: string | null;
  chatPoint?: Point | null;
  rowPoint?: Point | null;
  modelPoint?: Point | null;
  viewPoint?: Point | null;
  mentionPoint?: Point | null;
  allowPoint?: Point | null;
  optionsPoint?: Point | null;
  permissionPending?: boolean;
  allowOption?: string;
  uploadSelector?: string;
}
export interface Tab { id: number; windowId?: number; active?: boolean; title?: string; url?: string; pendingUrl?: string; status?: string }
export interface DebugTarget { tabId: number }
export interface DebugReply { root?: {nodeId: number}; nodeId?: number }
export interface ScriptTarget { tabId: number; documentIds?: string[] }
export interface Injection<T> { result?: T; documentId?: string }
export interface PollBrowser {
  runtime?: {getURL(path: string): string};
  storage: {local: LocalStorage};
  windows: {
    create(options: {url: string; type: 'normal'; focused?: boolean; state?: 'minimized'}): Promise<{
      id?: number; type?: string; focused?: boolean; tabs?: Tab[]
    }>;
    remove(id: number): Promise<unknown>;
  };
  tabs: {
    create(options: {url: string; active: boolean}): Promise<Tab>;
    group(options: {tabIds: number[]}): Promise<number>;
    get(id: number): Promise<Tab>;
    update(id: number, options: {url: string}): Promise<Tab>;
    remove(id: number): Promise<unknown>;
  };
  tabGroups: {
    update(id: number, properties: {title: string; color: 'blue'; collapsed: boolean}): Promise<unknown>;
  };
  debugger: {
    attach(target: DebugTarget, version: string): Promise<unknown>;
    detach(target: DebugTarget): Promise<unknown>;
    sendCommand(target: DebugTarget, method: string, params: Record<string, unknown>): Promise<DebugReply | undefined>;
  };
  scripting: {
    executeScript<A extends unknown[], R>(options: {
      target: ScriptTarget;
      world?: 'MAIN';
      func: (...args: A) => R;
      args: A;
    }): Promise<Injection<Awaited<R>>[]>;
  };
}
export interface PairingMessage { type?: string; apiURL?: string }
export interface PairingResponse { state: PairingRecord['state'] | 'unpaired' | 'unreachable'; code?: string }
export interface Sender { id?: string; url?: string }
export interface Listener<T extends unknown[]> { addListener(callback: (...args: T) => unknown): void }
export interface ChromeBrowser extends PollBrowser {
  alarms: {
    create(name: string, options: {periodInMinutes: number}): Promise<unknown>;
    onAlarm: Listener<[{name: string}]>;
  };
  runtime: {
    id: string;
    getURL(path: string): string;
    sendMessage(message: PairingMessage): Promise<PairingResponse | undefined>;
    onMessage: Listener<[PairingMessage, Sender, (response: PairingResponse) => void]>;
    onInstalled: Listener<[]>;
    onStartup: Listener<[]>;
  };
}
declare global { var chrome: ChromeBrowser }
