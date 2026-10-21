import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
const excluded = new Set(['.git', '.scratch', 'node_modules', 'dist']);
const files: string[] = [];
function walk(directory: string) {
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory() && !excluded.has(entry.name)) walk(file);
    else if (entry.isFile() && !entry.name.endsWith('.d.ts') && /\.(?:m?js|ts)$/.test(entry.name)) files.push(file);
  }
}
walk('.');
for (const file of files.sort()) {
  const result = file.endsWith('.ts')
    ? spawnSync(process.execPath, ['--input-type=module', '--check'], {input: (stripTypeScriptTypes as (source: string, options: {mode: 'transform'}) => string)(fs.readFileSync(file, 'utf8'), {mode: 'transform'}), stdio: ['pipe', 'inherit', 'inherit']})
    : spawnSync(process.execPath, ['--check', file], {stdio: 'inherit'});
  if (result.status !== 0) process.exit(1);
}
console.log(`Syntax checked ${files.length} JS/TS files`);

if (process.platform === 'darwin') {
  const result = spawnSync('/usr/bin/cc', ['-Wall', '-Wextra', '-Werror', '-fsyntax-only', 'src/workbench-runner.c'], {stdio:'inherit'});
  if (result.status !== 0) process.exit(1);
  console.log('Syntax checked macOS command supervisor');
  const speech = spawnSync('/usr/bin/swiftc', ['-typecheck', 'src/speech.swift'], {stdio:'inherit'});
  if (speech.status !== 0) process.exit(1);
  console.log('Typechecked macOS speech helper');
}
