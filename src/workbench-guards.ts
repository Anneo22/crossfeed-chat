import type { ExecutionResult } from './types.ts';
interface GuardSettings { disableAllHooks?: boolean; hooks?: { PreToolUse?: {matcher?: string; if?: unknown; hooks: {type: string; command: string; timeout?: number; async?: boolean; asyncRewake?: boolean; if?: unknown}[]}[] } }
interface VerdictData { continue?: boolean; hookSpecificOutput?: {hookEventName?: string; permissionDecision?: string; updatedInput?: unknown; permissionDecisionReason?: string}; decision?: string; updatedInput?: unknown; stopReason?: string; reason?: string }
import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { check, Fault, object } from './security.ts';

export const defaultGuardSettings = () => path.join(homedir(), '.claude', 'settings.json');
export const defaultWorkbenchRoots = () => [path.join(homedir(), 'Second Brain', '2_Code'), path.join(homedir(), 'ws')];

// Snapshot registrations, not policy logic. Only synchronous executable Bash hooks
// can protect this noninteractive command path; unsupported policies fail closed.
export function loadBashGuards(filename = defaultGuardSettings()) {
  try {
    check(fs.statSync(filename).size <= 1024 * 1024, 'Guard settings are too large');
    const settings = JSON.parse(fs.readFileSync(filename, 'utf8')) as GuardSettings;
    check(object(settings) && !settings.disableAllHooks && Array.isArray(settings.hooks?.PreToolUse), 'Bash guard registrations are required');
    const guards = [];
    for (const group of settings.hooks.PreToolUse) {
      check(object(group) && (group.matcher === undefined || typeof group.matcher === 'string'), 'Invalid guard matcher');
      if (group.matcher && group.matcher !== '*' && !new RegExp(group.matcher).test('Bash')) continue;
      check(Array.isArray(group.hooks) && group.if === undefined, 'Unsupported Bash guard group');
      for (const hook of group.hooks) {
        check(object(hook) && hook.type === 'command' && typeof hook.command === 'string' && hook.command.trim() && !hook.command.includes('\0') && !hook.async && !hook.asyncRewake && hook.if === undefined, 'Unsupported Bash guard');
        const timeout = hook.timeout === undefined ? 5 : hook.timeout;
        check(typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0 && timeout <= 600, 'Invalid guard timeout');
        guards.push(Object.freeze({ command: hook.command, timeout: timeout * 1000 }));
      }
    }
    check(guards.length > 0 && guards.length <= 128, 'Supply 1-128 Bash guards');
    return Object.freeze(guards);
  } catch {
    throw new Fault(503, 'workbench_guards', 'Full shell requires readable, valid settings with synchronous Bash PreToolUse command guards');
  }
}

export function guardVerdict(result: Pick<ExecutionResult, 'stopped' | 'exit_code' | 'stderr' | 'stdout'>) {
  if (result.stopped) return { allowed: false, reason: `Guard stopped: ${result.stopped}` };
  if (result.exit_code !== 0) return { allowed: false, reason: result.stderr.trim() || `Guard failed with exit code ${result.exit_code}` };
  const stdout = result.stdout.trim();
  if (!stdout) return { allowed: true };
  // Mixed advisory text and a decision is malformed, never implicit permission.
  // Advisory context belongs in the JSON additionalContext field.
  try {
    const data = JSON.parse(stdout) as VerdictData;
    check(object(data), 'Invalid guard JSON');
    check(data.continue === undefined || typeof data.continue === 'boolean', 'Invalid guard continuation');
    const specific = data.hookSpecificOutput;
    check(specific === undefined || object(specific) && (specific.hookEventName === undefined || specific.hookEventName === 'PreToolUse'), 'Invalid guard event');
    const decision = specific?.permissionDecision;
    check(decision === undefined || ['allow', 'deny', 'ask', 'defer'].includes(decision!), 'Invalid guard decision');
    check(data.decision === undefined || ['approve', 'block', 'allow', 'deny'].includes(data.decision!), 'Invalid legacy guard decision');
    // Never silently execute the original input after a guard rewrote it.
    if (specific?.updatedInput !== undefined || data.updatedInput !== undefined) return { allowed: false, reason: 'Guard requested an input change; submit a new command for all guards to inspect' };
    if (data.continue === false || ['deny', 'ask', 'defer'].includes(decision!) || ['block', 'deny'].includes(data.decision!)) {
      const reason = specific?.permissionDecisionReason ?? data.stopReason ?? data.reason;
      return { allowed: false, reason: typeof reason === 'string' && reason.trim() ? reason : 'Guard refused execution or requires interactive approval' };
    }
    return { allowed: true };
  } catch { return { allowed: false, reason: 'Guard returned invalid JSON or an unsupported decision' }; }
}
