import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

interface HostOptions { platform?: string; node?: string; audio?: boolean; workbench?: boolean; fullShell?: boolean; exists?: (path: string) => boolean; compiler?: (name: string) => boolean }
export function hostChecks({platform = process.platform, node = process.versions.node, audio = true, workbench = false, fullShell = false, exists = fs.existsSync,
  compiler = name => spawnSync('/usr/bin/xcrun', ['--find', name], {stdio: 'ignore', timeout: 2000}).status === 0}: HostOptions = {}) {
  const issues: string[] = [], [major, minor] = node.split('.').map(Number);
  if (major < 24 || major === 24 && minor < 18) issues.push('Node is too old. Next: install Node 24.18 or newer, then restart serve.');
  if (audio && platform !== 'darwin') issues.push('Local speech transcription is unavailable on this host. Original audio is still delivered with an unavailable note. Next: supply a text transcript alongside audio, or use --no-audio-transcription for original bytes only.');
  if (audio && platform === 'darwin' && !compiler('swiftc')) issues.push('The local speech compiler is unavailable. Next: run xcode-select --install, enable dictation for your speech locale, or use --no-audio-transcription.');
  if (workbench && platform !== 'darwin') issues.push('Workbench commands are unavailable on this host; file and Git tools remain usable. Next: use --workbench ROOT without shell flags for file tools and run commands in your own Linux terminal. Full shell also requires the macOS process supervisor; it is not a Linux fallback.');
  if (workbench && platform === 'darwin' && !compiler('clang')) issues.push('The command supervisor compiler is unavailable. Next: run xcode-select --install before using workbench commands.');
  if (workbench && platform === 'darwin' && !fullShell && !exists('/usr/bin/sandbox-exec')) issues.push('The workbench sandbox is unavailable; commands are refused. Next: use file and Git tools until the macOS sandbox is restored.');
  return {platform, node, issues};
}
