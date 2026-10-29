// 只读：核对 client.js 注释里声称的尺寸是否与磁盘实际一致
import path from 'node:path';
import { readPNG } from '../tools/png.mjs';

const R = 'packages/dsh-pixel-office/assets';

function info(rel) {
  const f = path.join(R, rel);
  const { w, h, data } = readPNG(f);
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    if (data[(y * w + x) * 4 + 3] > 8) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  const ink = x1 < 0 ? 'empty' : `${x1 - x0 + 1}x${y1 - y0 + 1}`;
  return `${w}x${h}  ink=${ink}`;
}

const checks = [
  ['char/subs/walk-side/m5-sporty-walk.png', '注释 L2126: 行走帧 26x26 且墨迹 13x23'],
  ['char/subs/sit-front/m5-sporty-front.png', '注释 L2348: m5 正面 26x26'],
  ['char/subs/sit-front/m8-idol-front.png', '注释 L2349: m8 正面 26x24'],
  ['char/subs/final/m8-idol.png', '注释 L2349: m8 背面 26x41'],
  ['char/main/stand-front/stand-1.png', '注释 L315: 38x50'],
  ['char/main/stand-side/stand-side-1.png', '注释 L315: 34x54'],
  ['char/main/stand-side/stand-side-2.png', '注释 L315 隐含同尺寸 34x54'],
  ['char/main/sit-floor/floor-1.png', '注释 L2093: 36x37'],
  ['char/main/sleep/main-sleep.png', '注释 L348: 55x53'],
  ['char/main/final/main-pose-asleep.png', '注释 L346: 36x51'],
  ['ui/board.png', '注释 L3110: 262x247'],
];
for (const [f, note] of checks) console.log(`${f}\t${info(f)}\t<- ${note}`);

// 副屏命中框与睡姿宽度关系
const spriteW = 26;
const sleep = ['m1-cat', 'm2-sakura', 'm3-gothic', 'm4-sailor', 'm5-sporty', 'm6-witch', 'm7-cafe', 'm8-idol'];
console.log('\n席位宽 26，睡姿帧实际宽度溢出量：');
for (const n of sleep) {
  const { w } = readPNG(path.join(R, `char/subs/sleep/${n}-sleep.png`));
  console.log(`${n}-sleep.png\tw=${w}\t溢出 ${w - spriteW}px`);
}
