// 只读：计算 alpha 墨迹包围盒（不去透明像素的影响），用于睡姿比例判定
import path from 'node:path';
import { readPNG } from '../tools/png.mjs';

const R = 'packages/dsh-pixel-office/assets';

function bbox(rel) {
  const img = readPNG(path.join(R, rel));
  const { w, h, data } = img;
  let x0 = w, y0 = h, x1 = -1, y1 = -1, n = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const a = data[(y * w + x) * 4 + 3];
      if (a > 8) {
        n += 1;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return { w, h, inkW: 0, inkH: 0, inkRatio: 0, fill: 0 };
  const inkW = x1 - x0 + 1, inkH = y1 - y0 + 1;
  return {
    w, h, inkW, inkH,
    inkRatio: +(inkW / inkH).toFixed(3),
    fill: +(n / (inkW * inkH)).toFixed(3),
    box: `${x0},${y0}..${x1},${y1}`,
  };
}

const list = [
  'char/main/final/main-sit-1.png',
  'char/main/sit-front/front-1.png',
  'char/main/sleep/main-sleep.png',
  'char/main/final/main-pose-asleep.png',
  'char/main/stand-front/stand-1.png',
];
for (let i = 1; i <= 8; i += 1) {
  const n = ['m1-cat', 'm2-sakura', 'm3-gothic', 'm4-sailor', 'm5-sporty', 'm6-witch', 'm7-cafe', 'm8-idol'][i - 1];
  list.push(`char/subs/final/${n}.png`);
  list.push(`char/subs/sleep/${n}-sleep.png`);
}

console.log('file\tcanvas\tink\tinkW/inkH\tfill\tbox');
for (const f of list) {
  const b = bbox(f);
  console.log(`${f}\t${b.w}x${b.h}\t${b.inkW}x${b.inkH}\t${b.inkRatio}\t${b.fill}\t${b.box || '-'}`);
}
