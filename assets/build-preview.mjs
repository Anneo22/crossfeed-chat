// An offline raster proof when sandbox permissions prevent a browser screenshot.
// This composes the actual exports at 1x and 4x; it does not capture preview.html.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
if (!process.env.CROSSFEED_SHARP_PACKAGE) throw Error('Set CROSSFEED_SHARP_PACKAGE to the package.json that provides sharp');
const require = createRequire(resolve(process.env.CROSSFEED_SHARP_PACKAGE));
const sharp = require('sharp');
const html = readFileSync(join(root, 'preview.html'), 'utf8');
const escape = text => text.replaceAll('&','&amp;').replaceAll('<','&lt;');
const layers = [];
function text(value, x, y, color='#14130F', size=14) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1250" height="40"><text x="0" y="25" font-family="sans-serif" font-size="${size}" fill="${color}">${escape(value)}</text></svg>`;
  layers.push({ input: Buffer.from(svg), left: x, top: y });
}
async function image(file, width, height, x, y) {
  let input = readFileSync(join(root, file));
  if (file==='mark.svg') {
    let source = input.toString();
    const palette = {i:'#14130F',p:'#FAF9F4',t:'#F1DFD4',h:'#C4552A',paper:'#FAF9F4',ink:'#14130F',tint:'#F1DFD4',accent:'#C4552A'};
    source = source.replace(/<style>.*?<\/style>/s, '');
    for (const [key,value] of Object.entries(palette)) source=source.replaceAll(`var(--${key})`,value);
    input=Buffer.from(source);
  }
  layers.push({input:await sharp(input,{density:384}).resize(Math.round(width),Math.round(height),file.endsWith('.png')?{kernel:'nearest'}:{}).png().toBuffer(),left:x,top:y});
}
let y=24;
text('Crossfeed Chat · raster export proof', 30, y, '#14130F', 24); y+=45;
text('Actual exports at 1× and 4× on their intended grounds. Assembled with sharp; this is not an HTML screenshot.',30,y); y+=50;
for (const ground of ['light','dark']) {
  const section=html.match(new RegExp(`<section class="theme ${ground}">(.*?)</section>`,'s'))[1];
  const ink=ground==='light'?'#14130F':'#E9E6DF';
  const paper=ground==='light'?'#FAF9F4':'#141311';
  const top=y;
  const layerStart=layers.length;
  text(ground.toUpperCase(),30,y+12,ink,20); y+=64;
  // Both actual tab exports at native 16 px and enlarged 4×.
  for (const zoom of [1,4]) {
    const tabStrip = `<svg xmlns="http://www.w3.org/2000/svg" width="${540*zoom}" height="${36*zoom}" viewBox="0 0 540 36"><rect width="540" height="36" fill="${ground==='light'?'#DDD8CC':'#37342E'}"/><rect x="4" y="4" width="250" height="32" rx="6" fill="${paper}"/><rect x="258" y="4" width="250" height="32" rx="6" fill="${paper}"/><text x="38" y="24" fill="${ink}" font-family="sans-serif" font-size="13">Crossfeed Chat</text><text x="292" y="24" fill="${ink}" font-family="sans-serif" font-size="13">Crossfeed</text></svg>`;
    text(`Browser tabs · ${zoom}×`,30,y,ink); y+=40;
    layers.push({input:Buffer.from(tabStrip),left:30,top:y});
    await image(`proofs/tab-chat-${ground}.svg`,16*zoom,16*zoom,30+12*zoom,y+12*zoom);
    await image(`proofs/tab-console-${ground}.svg`,16*zoom,16*zoom,30+266*zoom,y+12*zoom);
    y+=36*zoom+24;
  }
  for (const size of [16,32]) {
    for (const zoom of [1,4]) {
      text(`${size} px toolbar · ${zoom}×`,30,y,ink,14); y+=40;
      const h=(size+20)*zoom;
      const toolbar=`<svg xmlns="http://www.w3.org/2000/svg" width="${270*zoom}" height="${h}" viewBox="0 0 270 ${size+20}"><rect x=".5" y=".5" width="269" height="${size+19}" fill="${paper}" stroke="${ground==='light'?'#DDD8CC':'#37342E'}"/><path d="M19 ${size/2+5}L14 ${size/2+10}L19 ${size/2+15}" fill="none" stroke="${ink}" stroke-width="1.5" stroke-linecap="round"/><rect x="34" y="${size/2-3}" width="${270-size-84}" height="26" rx="13" fill="none" stroke="${ground==='light'?'#DDD8CC':'#37342E'}"/><text x="45" y="${size/2+14}" font-family="sans-serif" font-size="12" fill="${ink}">chatgpt.com</text><path d="M246 ${size/2+6}H256M246 ${size/2+10}H256M246 ${size/2+14}H256" stroke="${ink}" stroke-linecap="round"/></svg>`;
      layers.push({input:Buffer.from(toolbar),left:30,top:y});
      await image(`icon-${size}${ground==='dark'?'-dark':''}.png`,size*zoom,size*zoom,30+(270-size-40)*zoom,y+10*zoom);
      y+=h+24;
    }
  }
  for (const match of section.matchAll(/<article class="specimen"><h3><a href="([^"]+)">.*?<img src="[^"]+" width="([^"]+)" height="([^"]+)"/gs)) {
    const [,file,w,h]=match;
    const width=Number(w),height=Number(h);
    text(file,30,y,ink);text('1×',30,y+32,ink,12);text('4×',430,y+32,ink,12); y+=70;
    await image(file,width,height,30,y);
    await image(file,width*4,height*4,430,y);
    y+=Math.max(height*4,48)+28;
  }
  const background=await sharp({create:{width:2370,height:y-top,channels:4,background:paper}}).png().toBuffer();
  layers.splice(layerStart,0,{input:background,left:15,top});
  y+=26;
}
const width=2400,height=y+20;
await sharp({create:{width,height,channels:4,background:'#ECE9E1'}}).composite(layers).png({compressionLevel:9}).toFile(join(root,'preview.png'));
console.log(JSON.stringify({file:'preview.png',width,height,method:'sharp composition of actual exports; not an HTML screenshot'}));
