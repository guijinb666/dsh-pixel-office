// 只读：亮屏贴图边缘 alpha 覆盖率 + 睡姿帧相对坐姿帧的几何偏差
import path from 'node:path';
import { readPNG } from '../tools/png.mjs';

const R = 'packages/dsh-pixel-office/assets';

function alphaStats(rel) {
  const { w, h, data } = readPNG(path.join(R, rel));
  const rows = [];
  for (let y = 0; y < h; y += 1) {
    let n = 0;
    for (let x = 0; x < w; x += 1) if (data[(y * w + x) * 4 + 3] > 8) n += 1;
    rows.push(n);
  }
  const cols = [];
  for (let x = 0; x < w; x += 1) {
    let n = 0;
    for (let y = 0; y < h; y += 1) if (data[(y * w + x) * 4 + 3] > 8) n += 1;
    cols.push(n);
  }
  return { w, h, rows, cols };
}

for (const f of ['scene/screens/lit-main.png', 'scene/screens/lit-sub.png']) {
  const s = alphaStats(f);
  console.log(`\n== ${f} ${s.w}x${s.h}`);
  console.log('前3行非透明像素数:', s.rows.slice(0, 3).join(','), '| 后3行:', s.rows.slice(-3).join(','));
  console.log('前3列非透明像素数:', s.cols.slice(0, 3).join(','), '| 后3列:', s.cols.slice(-3).join(','));
  // 内缩 2px / 1px 后，被丢掉的像素占比
  const inset = s.w >= 40 ? 2 : 1;
  const kept = (s.w - inset * 2) * (s.h - inset * 2);
  console.log(`内缩 ${inset}px → 绘制框 ${s.w - inset * 2}x${s.h - inset * 2}`,
    `缩放 sx=${((s.w - inset * 2) / s.w).toFixed(4)} sy=${((s.h - inset * 2) / s.h).toFixed(4)}`,
    `源长宽比 ${(s.w / s.h).toFixed(4)} 目标长宽比 ${((s.w - inset * 2) / (s.h - inset * 2)).toFixed(4)}`,
    `横向拉伸 ${(((s.w - inset * 2) / (s.h - inset * 2)) / (s.w / s.h) * 100 - 100).toFixed(2)}%`);
}

const SUBS = ['m1-cat', 'm2-sakura', 'm3-gothic', 'm4-sailor', 'm5-sporty', 'm6-witch', 'm7-cafe', 'm8-idol'];
console.log('\n== 睡姿 vs 坐姿（背面 final）几何偏差，席位 spriteSize.main=36 / sub=26');
const mainSit = readPNG(path.join(R, 'char/main/final/main-sit-1.png'));
const mainSleep = readPNG(path.join(R, 'char/main/sleep/main-sleep.png'));
console.log(`main: sit ${mainSit.w}x${mainSit.h} → sleep ${mainSleep.w}x${mainSleep.h}`,
  `| 宽比 ${(mainSleep.w / mainSit.w).toFixed(2)} 高比 ${(mainSleep.h / mainSit.h).toFixed(2)}`,
  `| 中心右移 ${((mainSleep.w - mainSit.w) / 2).toFixed(1)}px`,
  `| 脚底 ${mainSleep.h - mainSit.h > 0 ? '下溢 +' : '上浮 '}${mainSleep.h - mainSit.h}px`);
for (const n of SUBS) {
  const sit = readPNG(path.join(R, `char/subs/final/${n}.png`));
  const sl = readPNG(path.join(R, `char/subs/sleep/${n}-sleep.png`));
  console.log(`${n}: sit ${sit.w}x${sit.h} → sleep ${sl.w}x${sl.h}`,
    `| 宽比 ${(sl.w / sit.w).toFixed(2)} 高比 ${(sl.h / sit.h).toFixed(2)}`,
    `| 中心右移 ${((sl.w - sit.w) / 2).toFixed(1)}px`,
    `| 脚底 ${sl.h - sit.h > 0 ? '下溢 +' : '上浮 '}${sl.h - sit.h}px`);
}
