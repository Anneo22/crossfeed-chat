import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const sourceRoot = process.env.CROSSFEED_ASSET_INPUT_ROOT ?? path.resolve(repo, '../../Second Brain/2_Code');
const inputs: Record<string, string> = {
  castor: path.join(sourceRoot, 'castor-identity/logo/castor.svg'),
  crossfeed: path.join(sourceRoot, 'orchestrator/scripts/console-assets/crossfeed.svg'),
  font: path.join(sourceRoot, 'castor-identity/proposals/2026-09-28-family/index.html'),
  sharp: path.join(sourceRoot, 'castor-identity/package.json'),
};
const available = ['castor', 'crossfeed', 'font'].every(key => fs.existsSync(inputs[key])) && fs.existsSync(path.join(sourceRoot, 'castor-identity/node_modules/sharp/package.json'));
const sharp = available ? createRequire(inputs.sharp)('sharp') : null;
function snapshot(root: string) {
  const files: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) files[path.relative(root, file)] = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    }
  };
  walk(root); return files;
}
function run(command: string, args: any, env: any) {
  const result = spawnSync(command, args, { encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(result.status, 0, result.stderr);
}
test('asset builders produce stable vectors, native transparent rasters and an identical offline proof in an isolated tree', {skip: !available}, async t => {
  const root = fs.mkdtempSync('/private/tmp/crossfeed-assets-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const product = path.join(root, 'crossfeed-chat'), assets = path.join(product, 'assets');
  fs.cpSync(path.join(repo, 'assets'), assets, { recursive: true });
  for (const name of ['src', 'extension']) fs.cpSync(path.join(repo, name), path.join(product, name), { recursive: true });
  const copy = (source: string, target: string) => { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target); };
  copy(inputs.castor, path.join(root, 'castor-identity/logo/castor.svg'));
  copy(inputs.font, path.join(root, 'castor-identity/proposals/2026-09-28-family/index.html'));
  copy(inputs.crossfeed, path.join(root, 'orchestrator/scripts/console-assets/crossfeed.svg'));
  fs.writeFileSync(path.join(root, 'orchestrator/scripts/console.py'), '# Fixture console\nTHEME_TOGGLE = True\n');
  fs.writeFileSync(path.join(root, 'castor-identity/package.json'), '{}');
  fs.symlinkSync(path.join(sourceRoot, 'castor-identity/node_modules'), path.join(root, 'castor-identity/node_modules'));
  const env = { CROSSFEED_CASTOR_SVG: inputs.castor, CROSSFEED_SOURCE_SVG: inputs.crossfeed, CROSSFEED_FONT_PAGE: inputs.font, CROSSFEED_SHARP_PACKAGE: inputs.sharp };
  const build = () => {
    run('python3', [path.join(assets, 'build.py')], env);
    run(process.execPath, [path.join(assets, 'build-icons.mjs')], env);
    run(process.execPath, [path.join(assets, 'build-preview.mjs')], env);
  };
  const before = snapshot(root);
  build(); const first = snapshot(root);
  build(); assert.deepEqual(snapshot(root), first);
  const changed = Object.keys(first).filter(name => first[name] !== before[name]);
  assert(changed.every(name => name.startsWith('crossfeed-chat/assets/')), changed.join('\n'));
  for (const suffix of ['', '-dark']) for (const size of [16, 32, 48, 128]) {
    const file = path.join(assets, `icon-${size}${suffix}.png`);
    const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, size); assert.equal(info.height, size);
    assert.equal(data[3], 0); assert.equal(data.at(-1), 0);
    assert(data.some((value: any, index: number) => index % 4 === 3 && value > 0));
    assert.deepEqual(fs.readFileSync(file), fs.readFileSync(path.join(repo, `assets/icon-${size}${suffix}.png`)));
  }
  for (const name of ['favicon.svg', 'mark.svg', 'mark-light.svg', 'mark-dark.svg', 'lockup-light.svg', 'lockup-dark.svg']) assert.deepEqual(fs.readFileSync(path.join(assets, name)), fs.readFileSync(path.join(repo, 'assets', name)), name);
  assert.deepEqual(fs.readFileSync(path.join(assets, 'favicon.svg')), fs.readFileSync(path.join(product, 'extension/icons/favicon.svg')));
  const uri = /const TAB_ICON = '([^']+)'/.exec(fs.readFileSync(path.join(product, 'src/oauth.ts'), 'utf8'))![1];
  assert.equal(decodeURIComponent(uri.split(',')[1]), fs.readFileSync(path.join(assets, 'favicon.svg'), 'utf8').trim());
});
