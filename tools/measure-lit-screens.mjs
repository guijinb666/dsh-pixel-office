// 量测亮屏版（room-lit-02）里每块屏幕的亮屏矩形，并与熄屏版矩形对比。
// 用法: node tools/measure-lit-screens.mjs <litPng> <darkPng> [jsonOut]
import { writeFileSync } from 'node:fs';
import { readPNG } from './png.mjs';

const litPath = process.argv[2];
const darkPath = process.argv[3];
const outPath = process.argv[4];

function load(p) {
  const { w, h, data } = readPNG(p); // RGBA
  return {
    w, h,
    at(x, y) {
      const i = (y * w + x) * 4;
      return [data[i], data[i + 1], data[i + 2]];
    },
  };
}

// 亮屏判定：青色系，绿蓝明显高于红
function isLitAt(img, x, y) {
  const [r, g, b] = img.at(x, y);
  return g > 100 && b > 95 && g > r + 35 && b > r + 12;
}

// 熄屏判定：暗，蓝略不低于红
function isDarkAt(img, x, y) {
  const [r, g, b] = img.at(x, y);
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  return luma < 60 && b >= r - 6 && b > 14;
}

// 在给定窗口内求判定为真的像素包围盒
function bboxIn(img, test, wx, wy, ww, wh) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0;
  for (let y = wy; y < wy + wh; y++) {
    for (let x = wx; x < wx + ww; x++) {
      if (x < 0 || y < 0 || x >= img.w || y >= img.h) continue;
      if (test(img, x, y)) {
        n++;
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  if (!n) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, count: n };
}

const lit = load(litPath);
const dark = load(darkPath);

// 列中心 / 行中心（源图 1664×2240 坐标，来自熄屏版实测）
const colCenters = [375, 698, 1018, 1338];
const rowCenters = [1104, 1366, 1629];

const report = { lit: litPath, dark: darkPath, main: null, subs: [] };

// 主工位：双屏并集，窗口放宽
report.main = {
  lit: bboxIn(lit, isLitAt, 660, 450, 460, 220),
  dark: bboxIn(dark, isDarkAt, 660, 450, 460, 220),
};

for (let r = 0; r < 3; r++) {
  for (let c = 0; c < 4; c++) {
    const seatId = `sub:${r * 4 + c}`;
    const cx = colCenters[c], cy = rowCenters[r];
    const wx = cx - 70, wy = cy - 60;
    report.subs.push({
      seatId,
      lit: bboxIn(lit, isLitAt, wx, wy, 140, 120),
      dark: bboxIn(dark, isDarkAt, wx, wy, 140, 120),
    });
  }
}

console.log('main lit :', JSON.stringify(report.main.lit));
console.log('main dark:', JSON.stringify(report.main.dark));
for (const s of report.subs) {
  console.log(s.seatId.padEnd(6), 'lit', JSON.stringify(s.lit), 'dark', JSON.stringify(s.dark));
}

if (outPath) {
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log('wrote', outPath);
}
