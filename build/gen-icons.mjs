import { Resvg } from '@resvg/resvg-js';
import pngToIco from 'png-to-ico';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const dir = path.dirname(fileURLToPath(import.meta.url));
const svg = fs.readFileSync(path.join(dir, 'icon.svg'));
function render(size) {
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
  return r.render().asPng();
}
fs.writeFileSync(path.join(dir, 'icon.png'), render(512));
fs.writeFileSync(path.join(dir, 'icon-256.png'), render(256));
const ico = await pngToIco([render(256), render(64), render(48), render(32), render(16)]);
fs.writeFileSync(path.join(dir, 'icon.ico'), ico);
console.log('wrote icon.png (512), icon-256.png, icon.ico');
