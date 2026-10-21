// Rasterise each native SVG without rescaling the 16/32 px pixel grids.
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const root = dirname(fileURLToPath(import.meta.url));
if (!process.env.CROSSFEED_SHARP_PACKAGE) throw Error('Set CROSSFEED_SHARP_PACKAGE to the package.json that provides sharp');
const require = createRequire(resolve(process.env.CROSSFEED_SHARP_PACKAGE));
const sharp = require('sharp');
const results = [];
for (const suffix of ['', '-dark']) {
  for (const size of [16, 32, 48, 128]) {
    const output = join(root, `icon-${size}${suffix}.png`);
    await sharp(readFileSync(join(root, `icon-${size}${suffix}.svg`)), { density: 72 }).png({ compressionLevel: 9 }).toFile(output);
    const { data, info } = await sharp(output).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let clear = 0, painted = 0;
    let left=size, top=size, right=-1, bottom=-1;
    for (let y=0; y<size; y++) for (let x=0; x<size; x++) {
      const alpha=data[(y*size+x)*4+3];
      if (!alpha) clear++;
      if (alpha) { painted++; left=Math.min(left,x); right=Math.max(right,x); top=Math.min(top,y); bottom=Math.max(bottom,y); }
    }
    if (info.width !== size || info.height !== size || !clear || !painted) throw new Error(`Invalid raster ${output}`);
    if (data[3] || data[(size*size-1)*4+3]) throw new Error(`Nontransparent corners ${output}`);
    if ((right-left+1)/size<.9 || (bottom-top+1)/size<.85) throw new Error(`Glyph does not fill square ${output}`);
    results.push({file:`icon-${size}${suffix}.png`,width:size,height:size,transparentPixels:clear,paintedPixels:painted,bounds:{left,top,right,bottom}});
  }
}
mkdirSync(join(root,'proofs'),{recursive:true});
writeFileSync(join(root,'proofs/raster-check.json'), JSON.stringify({renderer:'existing sharp, native SVG grids',results},null,2)+'\n');
console.log(JSON.stringify({renderer:'existing sharp, native SVG grids',results},null,2));
