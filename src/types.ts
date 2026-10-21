// Host domain records. JSON boundaries remain validated by their original runtime checks.
export interface WorkerSettings { row: string; level: number; wake_mode?: 'configured' | 'native'; url?: string; replicas?: number; replica_urls?: Record<string, string> }
export interface PickerReceipt { row: string; level: number; source?: string; observed_at?: number }
export interface WakeState { worker_modes?: Record<string, 'configured' | 'native'>; wakes: number[]; failed: Record<string, number>; failed_attempts?: Record<string, number>; cooldown_until: number; archives: string[]; started_chats?: string[]; chat_started_at?: Record<string, number> }
export interface SessionWorker { label: string; scope: string; url?: string }
export interface Config {
  prefix: string; connector: string; labels: Record<string, WorkerSettings>; public_url?: string;
  quota_until?: Record<string, number>; quota_pause_until?: number; job_deadline_ms?: number;
  max_claimed_jobs?: number; worker_lease_ms?: number; wake_daily_cap?: number; wake_hourly_cap?: number; chat_disposal?: 'archive' | 'delete';
  session_workers?: Record<string, SessionWorker>; conversation_bindings?: Record<string,string>;
  attachment_delivery?: 'mcp' | 'composer'; wake_state?: WakeState;
  /** Explicit approved pairing ID which alone receives extension work; unset is legacy routing. */
  wake_receiver_id?: string;
}
export type GatewayConfig = Pick<Config, 'prefix' | 'labels'> & Partial<Config>;
export type WakeConfig = Pick<Config, 'labels'> & Partial<Config>;
export interface Attachment { type: 'attachment'; kind: string; name: string; mime: string; bytes: number; sha256: string }
export interface TextPart { type: 'text'; text: string }
export interface ToolCall { id: string; type: string; function: { name: string; arguments: string } }
export interface FunctionTool { type: string; function: { name: string; parameters?: Record<string, unknown>; description?: string; strict?: boolean } }
export interface Message { role: string; content: string | null | (TextPart | Attachment)[]; name?: string; tool_calls?: ToolCall[]; tool_call_id?: string }
export interface Request {
  model: string; messages: Message[]; title?: string; store?: false; tools?: FunctionTool[]; tool_choice?: string | { type: string; function: { name: string } };
  parallel_tool_calls?: boolean; stream?: boolean; stream_options?: { include_usage: boolean };
  temperature?: number; top_p?: number; max_tokens?: number; max_completion_tokens?: number; stop?: string | string[];
}
export interface FileDescriptor { id: string; name: string; mime: string; bytes: number; path?: string }
export interface FileRecord extends FileDescriptor { owner: string; kind: 'input' | 'output'; expires: number; sha256: string }
export interface Completion { role?: string; content?: string | null; tool_calls?: ToolCall[]; files?: FileDescriptor[]; error?: boolean; code?: string }
export interface CompletionResult {
  id: string; object: string; created: number; model: string;
  choices: { index: number; message: Omit<Completion, 'files'>; finish_reason: string }[];
  usage: null; files?: FileDescriptor[]; metadata: {worker_label: string; worker_identity?: string; picker_receipt: PickerReceipt | null};
}
export interface JobRecord {
  id: string; label: string; request: Request; digest: string; key?: string; state: string;
  caller?: string; scope?: string; enqueued_at?: number; claimed_at?: number; wake_at?: number; finished_at?: number; wake_needed?: boolean; retry_keys?: string[];
  deadline: number; claimBy: number; expires: number; client?: string; worker?: string; claim?: string; leaseUntil?: number;
  finished?: boolean; completionDigest?: string; receipt?: PickerReceipt | null; result?: CompletionResult;
  error?: {status: number; code: string; message: string}; delivery?: 'mcp' | 'composer';
}
export interface Job extends JobRecord {
  promise: Promise<CompletionResult>; resolve: (result: CompletionResult) => void; reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>; claimTimer?: ReturnType<typeof setTimeout>; leaseTimer?: ReturnType<typeof setTimeout>;
  cleanup?: () => void; downloading?: boolean;
  waiters?: Set<{ signal?: AbortSignal; abort?: () => void }>;
}
export interface JobState { version: number; jobs: JobRecord[] }
export interface Worker {
  client: string; label: string; seen: number; polling: boolean; active: Job | null; stale?: boolean;
  conversation?: string; wake_nonce?: string;
  notify?: (() => void) | null; picker_receipt?: PickerReceipt; contacts?: number; idleUntil?: number; exchange?: object; revoked?: boolean;
}
export interface ExchangeArguments {
  worker_label: string; wake_nonce?: string; request_id?: string; claim_token?: string; response?: string | null; tool_calls?: unknown;
  error?: string; maximum_wait_seconds?: number; picker_receipt?: PickerReceipt; files?: unknown[];
}
export interface ComposerJob { id: string; label: string; scope?: string; title?: string; attachments: FileDescriptor[] }
export interface WakeTicket {
  nonce: string; label: string; routing_label?: string; automatic?: boolean; title?: string; row: string; level: number; wake_mode?: 'configured' | 'native'; connector: string; expires_at: number; state: string;
  type?: string; job_id?: string; attachments?: FileDescriptor[]; retain_until?: number; error?: string | null;
  url?: string; chat_url?: string; issued_at?: number; contact?: number; claimed?: boolean; cleanupReceived?: boolean; picker_receipt?: PickerReceipt;
  permissions?: {connector: string; option: string}[];
  failure_code?: string; failure_stage?: string;
}
export interface CallContext { client?: string; signal?: AbortSignal }
export interface ToolSchema { type?: string; properties?: Record<string, unknown>; required?: string[]; [key: string]: unknown }
export interface LocalTool { name: string; description?: string; inputSchema: ToolSchema; annotations?: Record<string, boolean> }
export interface ExecutionResult { stdout: string; stderr: string; exit_code: number | null; signal: string | null; output: string; stopped: string | null; truncated: boolean }
