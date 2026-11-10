import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Node 26 removed stripTypeScriptTypes mode 'transform'; npm run check must pass on every supported Node.
test('npm run check passes on the installed Node', {timeout: 120000}, () => {
  const result = spawnSync(process.execPath, ['scripts/check.ts'], {cwd: new URL('..', import.meta.url), encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr.slice(-2000));
  assert.match(result.stdout, /Syntax checked \d+ JS\/TS files/);
});
