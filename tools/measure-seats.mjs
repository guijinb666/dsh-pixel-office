#!/usr/bin/env node
/**
 * measure-seats.mjs - 从场景底图反推每个座位的精确锚点。
 *
 * 不靠肉眼：直接用像素统计找出每个副工位的
 *   - 桌面木色区块的左右边界（→ 桌中心 x）
 *   - 桌前沿 y（木色行带的下边界）
 *   - 椅子（桌下方最深的那块连通暗色）的 x 中心与 y 范围
 *
 * 输出 assets/scene/seats.json。
 *
 * 用法：
 *   node tools/measure-seats.mjs -s assets/scene/office-dark-320.png \
 *        -o assets/scene/seats.json [--rows "203:226,254:275,305:326"] \
 *        [--cols "52:92,114:154,175:215,235:275"]
 */
import path from 'node:path';
import fs from 'node:fs';
import { readPNG } from './png.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

function die(m) {
  console.error(m);
  process.exit(1);
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-s') o.scene = argv[++i];
    else if (a === '-o') o.out = argv[++i];
    else if (a === '--rows') o.rows = argv[++i];
    else if (a === '--cols') o.cols = argv[++i];
    else if (a === '--main') o.main = argv[++i];
    else die('unknown arg ' + a);
  }
  return o;
}

const args = parseArgs(process.argv.slice(2));
if (!args.scene || !args.out) die('need -s and -o');

const img = readPNG(path.resolve(ROOT, args.scene));
const px = (x, y) => {
  const i = (y * img.w + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};

const luma = (x, y) => {
  const [r, g, b] = px(x, y);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

// 木色：红显著高于蓝，且整体不太暗
const isWood = (x, y) => {
  const [r, g, b] = px(x, y);
  return r > 55 && r > b + 14 && g > 32 && g < r;
};

/** 找椅子：在给定 x 窗口、y 窗口里，逐行统计"明显暗于地板"的像素区间。 */
const FLOOR = luma(6, Math.round(img.h * 0.5));

function findChair(x0, x1, y0, y1) {
  let best = null;
  for (let y = y0; y < y1; y++) {
    const dark = [];
    for (let x = x0; x < x1; x++) {
      if (luma(x, y) < FLOOR - 9) dark.push(x);
    }
    if (!dark.length) continue;
    // 取该行最长连续段
    let runStart = dark[0], runEnd = dark[0], runBest = [dark[0], dark[0]];
    for (let k = 1; k < dark.length; k++) {
      if (dark[k] === dark[k - 1] + 1) {
        runEnd = dark[k];
      } else {
        if (runEnd - runStart > runBest[1] - runBest[0]) runBest = [runStart, runEnd];
        runStart = dark[k];
        runEnd = dark[k];
      }
    }
    if (runEnd - runStart > runBest[1] - runBest[0]) runBest = [runStart, runEnd];
    const width = runBest[1] - runBest[0] + 1;
    if (!best || width > best.width) best = { y, x0: runBest[0], x1: runBest[1], width };
  }
  return best;
}

function parseRanges(s) {
  return s.split(',').map((p) => p.split(':').map(Number));
}

const rowBands = args.rows ? parseRanges(args.rows) : [[203, 226], [254, 275], [305, 326]];
const colBands = args.cols ? parseRanges(args.cols) : [[52, 92], [114, 154], [175, 215], [235, 275]];

const seats = [];
const notes = [];

// 主工位：先按木色找桌面范围
let mainBand = null;
if (args.main) {
  const [my0, my1] = args.main.split(':').map(Number);
  let left = img.w, right = -1;
  for (let y = my0; y <= my1; y++) {
    for (let x = 0; x < img.w; x++) {
      if (isWood(x, y)) { if (x < left) left = x; if (x > right) right = x; }
    }
  }
  mainBand = { left, right, y0: my0, y1: my1 };
}

rowBands.forEach(([ry0, ry1], rowIdx) => {
  colBands.forEach(([cx0, cx1], colIdx) => {
    // 桌中心：在该桌 x 窗口内，用木色像素的质心
    let sumX = 0, n = 0, left = img.w, right = -1;
    for (let y = ry0; y <= ry1; y++) {
      for (let x = cx0; x <= cx1; x++) {
        if (isWood(x, y)) {
          sumX += x; n++;
          if (x < left) left = x;
          if (x > right) right = x;
        }
      }
    }
    const deskCx = n ? Math.round(sumX / n) : Math.round((cx0 + cx1) / 2);

    // 椅子在桌下方 y+4 .. y+22 范围里找
    const chair = findChair(left + 3, right - 2, ry1 + 2, ry1 + 22);

    const id = 'sub:' + (rowIdx * colBands.length + colIdx);
    seats.push({
      seatId: id,
      kind: 'sub',
      deskCx,
      deskL: left,
      deskR: right,
      deskTop: ry0,
      deskBottom: ry1,
      chair: chair
        ? { cx: Math.round((chair.x0 + chair.x1) / 2), x0: chair.x0, x1: chair.x1, top: chair.y }
        : null,
    });
  });
});

const outPath = path.resolve(ROOT, args.out);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(
  outPath,
  JSON.stringify({ scene: path.basename(args.scene), sceneSize: { w: img.w, h: img.h }, mainBand, seats, notes }, null, 2)
);

console.log(JSON.stringify({ ok: true, out: path.relative(ROOT, outPath), floorLuma: Math.round(FLOOR), mainBand, count: seats.length, seats }, null, 2));
