import fs from 'node:fs';
import { decodePNG } from './png.mjs';

const f = process.argv[2];
const png = decodePNG(fs.readFileSync(f));
const { w, h, data } = png;
const px = (x, y) => {
  const i = (y * w + x) * 4;
  return [data[i], data[i + 1], data[i + 2]];
};
console.log('corners', px(0, 0), px(w - 1, 0), px(0, h - 1), px(w - 1, h - 1));
const hist = new Map();
for (let y = 0; y < h; y += 2) {
  for (let x = 0; x < w; x += 2) {
    const k = px(x, y).join(',');
    hist.set(k, (hist.get(k) || 0) + 1);
  }
}
const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
console.log(top);
