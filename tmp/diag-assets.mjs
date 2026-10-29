// 诊断：检查每个 sprite 资产「是否真的是像素 sprite」——尺寸、是否带 alpha、是否还有品红底。
// 原始 AI 出图是 1328×1328 且背景接近纯品红；成品 sprite 应该只有几十像素宽。
import { readPNG } from '../tools/png.mjs';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

function stat(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return { rel, missing: true };
  let img;
  try { img = readPNG(p); } catch (e) { return { rel, err: String(e.message || e) }; }
  const { w, h, data } = img;
  let opaque = 0;
  let magenta = 0;
  const step = 1;
  for (let i = 0; i < data.length; i += 4 * step) {
    const a = data[i + 3];
    if (a > 8) opaque += 1;
    // 品红判定：R 高、G 低、B 高
    if (data[i] > 200 && data[i + 1] < 80 && data[i + 2] > 200) magenta += 1;
  }
  const total = Math.ceil(data.length / (4 * step));
  return {
    rel,
    size: w + 'x' + h,
    bytes: fs.statSync(p).size,
    opaquePct: Math.round((opaque / total) * 100),
    magentaPct: Math.round((magenta / total) * 100),
  };
}

const targets = [
  'assets/char/main/final/main-sit-1.png',
  'assets/char/main/walk-side/side-1.png',
  'assets/char/main/walk-up/up-1.png',
  'assets/char/main/sit-front/front-1.png',
  'assets/char/main/sit-side/side-1.png',
  'assets/char/main/stand-front/stand-1.png',
  'assets/char/main/stand-side/stand-side-1.png',
  'assets/char/subs/final/m1-cat.png',
  'assets/char/subs/walk-side/m1-cat-walk.png',
  'assets/char/subs/sit-front/m1-cat-front.png',
  'assets/char/subs/sit-side/m1-cat-side.png',
  'assets/char/subs/sit-back/m1-cat-sit.png',
  'assets/char/subs/sit-floor/m1-cat-floor.png',
  'assets/scene/office-dark-320.png',
  'assets/ui/board.png',
];

for (const t of targets) {
  const s = stat(t);
  console.log(JSON.stringify(s));
}
