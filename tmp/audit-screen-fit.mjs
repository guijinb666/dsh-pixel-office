// 只读：核对 seats.json 的 screen 矩形 vs lit-*.png 实际像素尺寸，以及缩放后的覆盖关系
import fs from 'node:fs';
import path from 'node:path';
import { readPNG } from '../tools/png.mjs';

const R = 'packages/dsh-pixel-office/assets';
const seats = JSON.parse(fs.readFileSync(path.join(R, 'scene/seats.json'), 'utf8'));
const atlas = JSON.parse(fs.readFileSync(path.join(R, 'scene/screens/atlas.json'), 'utf8'));

const litMain = readPNG(path.join(R, 'scene/screens/lit-main.png'));
const litSub = readPNG(path.join(R, 'scene/screens/lit-sub.png'));

console.log('lit-main.png', litMain.w + 'x' + litMain.h);
console.log('lit-sub.png ', litSub.w + 'x' + litSub.h);
console.log('atlas.main', JSON.stringify(atlas.main.rect), 'atlas.sub', JSON.stringify(atlas.sub));
console.log('');

// 主屏
const ms = seats.main.screen;
const mainInsetX = ms.w >= 40 ? 2 : 1;
const mainInsetY = ms.h >= 24 ? 2 : 1;
console.log(`main.screen 矩形 ${ms.w}x${ms.h}  (位置 x=${ms.x} y=${ms.y})`);
console.log(`  vs lit-main ${litMain.w}x${litMain.h}  → 尺寸差 ${litMain.w - ms.w}x${litMain.h - ms.h}`);
console.log(`  矩形长宽比 ${(ms.w / ms.h).toFixed(4)} / 贴图长宽比 ${(litMain.w / litMain.h).toFixed(4)}  偏差 ${((litMain.w / litMain.h) / (ms.w / ms.h) * 100 - 100).toFixed(2)}%`);
console.log(`  drawImage 目标 ${ms.w - mainInsetX * 2}x${ms.h - mainInsetY * 2}  缩放 sx=${((ms.w - mainInsetX * 2) / litMain.w).toFixed(4)} sy=${((ms.h - mainInsetY * 2) / litMain.h).toFixed(4)}`);
console.log('');

// 副屏
let mismatchW = 0, mismatchH = 0;
for (const s of seats.subs) {
  if (s.screen.w !== litSub.w || s.screen.h !== litSub.h) mismatchW += 1;
  mismatchH = Math.max(mismatchH, Math.abs(s.screen.h - litSub.h));
}
const s0 = seats.subs[0].screen;
const subInset = s0.w >= 40 ? 2 : 1;
console.log(`subs[0].screen 矩形 ${s0.w}x${s0.h} (位置 x=${s0.x} y=${s0.y})`);
console.log(`  12 个副席位矩形与 lit-sub ${litSub.w}x${litSub.h} 尺寸不一致的数量: ${mismatchW}`);
console.log(`  矩形长宽比 ${(s0.w / s0.h).toFixed(4)} / 贴图长宽比 ${(litSub.w / litSub.h).toFixed(4)}  偏差 ${((litSub.w / litSub.h) / (s0.w / s0.h) * 100 - 100).toFixed(2)}%`);
console.log(`  drawImage 目标 ${s0.w - subInset * 2}x${s0.h - subInset * 2}  缩放 sx=${((s0.w - subInset * 2) / litSub.w).toFixed(4)} sy=${((s0.h - subInset * 2) / litSub.h).toFixed(4)}`);
console.log('');

// 覆盖性：贴图源尺寸 >= 矩形 + 内缩 才能无损
console.log('覆盖判定（源像素 vs 目标绘制像素）：');
console.log(`  main: ${litMain.w}x${litMain.h} → ${ms.w - mainInsetX * 2}x${ms.h - mainInsetY * 2}  ` +
  `${litMain.w >= ms.w - mainInsetX * 2 && litMain.h >= ms.h - mainInsetY * 2 ? '源≥目标，缩小时不丢细节' : '源<目标，放大模糊'}`);
console.log(`  sub : ${litSub.w}x${litSub.h} → ${s0.w - subInset * 2}x${s0.h - subInset * 2}  ` +
  `${litSub.w >= s0.w - subInset * 2 && litSub.h >= s0.h - subInset * 2 ? '源≥目标，缩小时不丢细节' : '源<目标，放大模糊'}`);
