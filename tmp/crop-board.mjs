// 把 board.png 裁到牌子本身 + 一点留白（原图 1400x900 大片黑底，页面上全是空虚）
import { readPNG, writePNG } from '../tools/png.mjs';

const SRC = 'docs/media/board.png';
const img = readPNG(SRC);
const { w, h, data } = img;

let minX = w, minY = h, maxX = -1, maxY = -1;
for (let y = 0; y < h; y += 1) {
  for (let x = 0; x < w; x += 1) {
    const i = (y * w + x) * 4;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    // 牌子是暖木色；黑底 r/g/b 都很低
    if (r > 60 || g > 45 || b > 40) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
}
console.log(`ink box = ${maxX - minX + 1}x${maxY - minY + 1} at ${minX},${minY}`);

const PAD = 36;
const x0 = Math.max(0, minX - PAD);
const y0 = Math.max(0, minY - PAD);
const x1 = Math.min(w - 1, maxX + PAD);
const y1 = Math.min(h - 1, maxY + PAD);
const cw = x1 - x0 + 1;
const ch = y1 - y0 + 1;

const out = Buffer.alloc(cw * ch * 4);
for (let y = 0; y < ch; y += 1) {
  const src = ((y + y0) * w + (x0)) * 4;
  data.copy(out, y * cw * 4, src, src + cw * 4);
}
writePNG('docs/media/board.png', cw, ch, out);
console.log(`裁剪为 ${cw}x${ch}，比例 ${(cw / ch).toFixed(3)}`);
