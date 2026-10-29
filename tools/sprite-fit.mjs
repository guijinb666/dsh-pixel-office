#!/usr/bin/env node
/**
 * sprite-fit.mjs - 找出"AI 伪像素 sprite"能压到多小而不碎。
 *
 * 输出一条对比长图：同一张 sprite 在 N 个目标宽度下的效果，各自带
 *   a) 直接最近邻降采样      b) 先量化到 K 色再降采样
 * 并把 1px 描边加上，模拟真实上屏。
 *
 * 用法：
 *   node tools/sprite-fit.mjs -i <sprite.png> -o <out.png> \
 *        --widths 20,24,28,32,36 [--colors 10] [--threshold 128] [--scale 8]
 */
import path from 'node:path';
import fs from 'node:fs';
import { readPNG, writePNG } from './png.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUTLINE = [0x14, 0x12, 0x1f];

function die(m) {
  console.error(m);
  process.exit(1);
}

function binarize(img, threshold) {
  const d = Buffer.from(img.data);
  for (let i = 3; i < d.length; i += 4) d[i] = d[i] >= threshold ? 255 : 0;
  return { w: img.w, h: img.h, data: d };
}

function trimAlpha(img) {
  let x0 = img.w, y0 = img.h, x1 = -1, y1 = -1;
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      if (img.data[(y * img.w + x) * 4 + 3] !== 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return img;
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    img.data.copy(out, y * w * 4, ((y + y0) * img.w + x0) * 4, ((y + y0) * img.w + x0 + w) * 4);
  }
  return { w, h, data: out };
}

function scaleNearest(img, tw, th) {
  const out = Buffer.alloc(tw * th * 4);
  for (let dy = 0; dy < th; dy++) {
    const sy = Math.min(img.h - 1, Math.floor((dy * img.h) / th));
    for (let dx = 0; dx < tw; dx++) {
      const sx = Math.min(img.w - 1, Math.floor((dx * img.w) / tw));
      const si = (sy * img.w + sx) * 4, di = (dy * tw + dx) * 4;
      out[di] = img.data[si]; out[di + 1] = img.data[si + 1];
      out[di + 2] = img.data[si + 2]; out[di + 3] = img.data[si + 3];
    }
  }
  return { w: tw, h: th, data: out };
}

/**
 * 中值切分量化（median cut）。只处理 alpha!=0 的像素，alpha 原样保留。
 * 目的是把 AI 的渐变噪声归并成有限几个色块，降采样时每格才有明确归属。
 */
function quantize(img, maxColors) {
  const px = [];
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3] !== 0) px.push([img.data[i], img.data[i + 1], img.data[i + 2]]);
  }
  if (!px.length) return img;

  let boxes = [px];
  while (boxes.length < maxColors) {
    // 选跨度最大的盒子切开
    let bi = -1, best = -1, bestCh = 0;
    boxes.forEach((box, k) => {
      if (box.length < 2) return;
      for (let ch = 0; ch < 3; ch++) {
        let lo = 255, hi = 0;
        for (const p of box) { if (p[ch] < lo) lo = p[ch]; if (p[ch] > hi) hi = p[ch]; }
        const span = hi - lo;
        if (span > best) { best = span; bi = k; bestCh = ch; }
      }
    });
    if (bi < 0 || best <= 0) break;
    const box = boxes[bi].slice().sort((a, b) => a[bestCh] - b[bestCh]);
    const mid = box.length >> 1;
    boxes.splice(bi, 1, box.slice(0, mid), box.slice(mid));
  }

  const palette = boxes.map((box) => {
    let r = 0, g = 0, b = 0;
    for (const p of box) { r += p[0]; g += p[1]; b += p[2]; }
    const n = box.length || 1;
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  });

  const d = Buffer.from(img.data);
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    let bi = 0, bd = Infinity;
    for (let k = 0; k < palette.length; k++) {
      const dr = d[i] - palette[k][0], dg = d[i + 1] - palette[k][1], db = d[i + 2] - palette[k][2];
      const dist = dr * dr + dg * dg + db * db;
      if (dist < bd) { bd = dist; bi = k; }
    }
    d[i] = palette[bi][0]; d[i + 1] = palette[bi][1]; d[i + 2] = palette[bi][2];
  }
  return { w: img.w, h: img.h, data: d };
}

function addOutline(img) {
  const w = img.w + 2, h = img.h + 2;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < img.h; y++) {
    img.data.copy(out, ((y + 1) * w + 1) * 4, y * img.w * 4, (y + 1) * img.w * 4);
  }
  const solid = (x, y) =>
    x >= 0 && y >= 0 && x < w && y < h && out[(y * w + x) * 4 + 3] !== 0;
  const marks = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (out[(y * w + x) * 4 + 3] !== 0) continue;
      if (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1) ||
          solid(x - 1, y - 1) || solid(x + 1, y - 1) || solid(x - 1, y + 1) || solid(x + 1, y + 1)) {
        marks.push(y * w + x);
      }
    }
  }
  for (const p of marks) {
    out[p * 4] = OUTLINE[0]; out[p * 4 + 1] = OUTLINE[1]; out[p * 4 + 2] = OUTLINE[2]; out[p * 4 + 3] = 255;
  }
  return { w, h, data: out };
}

function blit(dst, src, ox, oy) {
  for (let y = 0; y < src.h; y++) {
    const dy = oy + y;
    if (dy < 0 || dy >= dst.h) continue;
    for (let x = 0; x < src.w; x++) {
      const dx = ox + x;
      if (dx < 0 || dx >= dst.w) continue;
      const si = (y * src.w + x) * 4, di = (dy * dst.w + dx) * 4;
      const a = src.data[si + 3];
      if (a === 0) continue;
      if (a === 255) {
        dst.data[di] = src.data[si]; dst.data[di + 1] = src.data[si + 1];
        dst.data[di + 2] = src.data[si + 2]; dst.data[di + 3] = 255;
        continue;
      }
      const k = a / 255;
      dst.data[di] = Math.round(src.data[si] * k + dst.data[di] * (1 - k));
      dst.data[di + 1] = Math.round(src.data[si + 1] * k + dst.data[di + 1] * (1 - k));
      dst.data[di + 2] = Math.round(src.data[si + 2] * k + dst.data[di + 2] * (1 - k));
      dst.data[di + 3] = 255;
    }
  }
}

function parseArgs(argv) {
  const o = { widths: [20, 24, 28, 32, 36], colors: 10, threshold: 128, scale: 8, bg: [0x3a, 0x2d, 0x47] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-i') o.in = argv[++i];
    else if (a === '-o') o.out = argv[++i];
    else if (a === '--widths') o.widths = argv[++i].split(',').map(Number);
    else if (a === '--colors') o.colors = Number(argv[++i]);
    else if (a === '--threshold') o.threshold = Number(argv[++i]);
    else if (a === '--scale') o.scale = Number(argv[++i]);
    else die('unknown arg ' + a);
  }
  return o;
}

const args = parseArgs(process.argv.slice(2));
if (!args.in || !args.out) die('need -i and -o');

let base = readPNG(path.resolve(ROOT, args.in));
base = binarize(base, args.threshold);
base = trimAlpha(base);
const quant = quantize(base, args.colors);

const variants = args.widths.map((w) => {
  const hRaw = Math.max(1, Math.round((base.h * w) / base.w));
  const raw = addOutline(scaleNearest(base, w, hRaw));
  const qh = Math.max(1, Math.round((quant.h * w) / quant.w));
  const pre = addOutline(scaleNearest(quant, w, qh));
  return { width: w, raw, quant: pre };
});

// 画布：两行（raw / quant），每列一个宽度
const s = args.scale;
const cellW = Math.max(...variants.map((v) => Math.max(v.raw.w, v.quant.w))) + 6;
const rowH = Math.max(...variants.map((v) => Math.max(v.raw.h, v.quant.h))) + 6;
const W = cellW * variants.length;
const H = rowH * 2;

const canvas = { w: W, h: H, data: Buffer.alloc(W * H * 4) };
for (let i = 0; i < W * H; i++) {
  canvas.data[i * 4] = args.bg[0];
  canvas.data[i * 4 + 1] = args.bg[1];
  canvas.data[i * 4 + 2] = args.bg[2];
  canvas.data[i * 4 + 3] = 255;
}

variants.forEach((v, k) => {
  // raw 在上一行，quant 在下一行，各自水平居中、底部对齐
  blit(canvas, v.raw, k * cellW + ((cellW - v.raw.w) >> 1), rowH - v.raw.h - 3);
  blit(canvas, v.quant, k * cellW + ((cellW - v.quant.w) >> 1), rowH + rowH - v.quant.h - 3);
});

const big = scaleNearest(canvas, W * s, H * s);
const outPath = path.resolve(ROOT, args.out);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
writePNG(outPath, big.w, big.h, big.data);

console.log(JSON.stringify({
  ok: true,
  out: path.relative(ROOT, outPath),
  src: { w: base.w, h: base.h },
  colors: args.colors,
  // 上行 = 直接降采样；下行 = 先量化再降采样
  rows: ['raw', 'quantized'],
  widths: args.widths,
  variants: variants.map((v) => ({ width: v.width, raw: { w: v.raw.w, h: v.raw.h }, quant: { w: v.quant.w, h: v.quant.h } })),
}, null, 2));
