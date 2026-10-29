// 诊断：打印若干原图的四角与中心像素，判断背景色/是否已有 alpha。
import { readPNG } from '../tools/png.mjs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const files = process.argv.slice(2);
const defs = files.length ? files : [
  'assets/char/main/sit-front/front-1.png',
  'assets/char/main/sit-side/side-1.png',
  'assets/char/main/stand-front/stand-1.png',
  'assets/char/main/stand-side/stand-side-1.png',
  'assets/char/subss/../../char/subs/sit-front/m1-cat-front.png',
  'assets/char/subs/walk-side/m1-cat-walk.png',
  'assets/char/subs/sit-floor/m1-cat-floor.png',
  'assets/char/main/sit-floor/floor-1.png',
];

for (const rel of defs) {
  const p = path.join(ROOT, rel);
  let img;
  try { img = readPNG(p); } catch (e) { console.log(rel, 'ERR', String(e.message || e).slice(0, 80)); continue; }
  const { w, h, data } = img;
  const px = (x, y) => {
    const i = (y * w + x) * 4;
    return [data[i], data[i + 1], data[i + 2], data[i + 3]];
  };
  const corners = [
    ['TL', px(3, 3)],
    ['TR', px(w - 4, 3)],
    ['BL', px(3, h - 4)],
    ['BR', px(w - 4, h - 4)],
    ['C', px(w >> 1, h >> 1)],
  ];
  console.log(rel, w + 'x' + h, corners.map(([k, v]) => k + '=' + v.join(',')).join('  '));
}
