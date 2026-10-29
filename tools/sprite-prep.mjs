#!/usr/bin/env node
/**
 * sprite-prep.mjs - 把 AI 出的"伪像素" sprite 处理成能上像素场景的真 sprite。
 *
 * 处理链（顺序不能乱，每一步都是为了修上一步暴露的问题）：
 *
 *   1. area 降采样    按目标像素覆盖的源像素区域做 alpha 加权平均，再二值化。
 *                     不用最近邻：最近邻会随机丢掉细小的白荷叶边像素，导致
 *                     "白边破碎"。area 平均能保住"覆盖率过半"的细节。
 *   2. 填洞           剪影内部的透明小缝（荷叶边每片之间的缝）必须填掉。
 *                     不填的话下一步描边会把缝填成深色，白点变成孤立的亮点。
 *                     从画布边界 flood fill 找"外部透明"，其余透明一律转不透明。
 *   3. 量化           把 AI 的渐变噪声归并成有限色块，色数少才有像素画味。
 *   4. 1px 描边       元气骑士的"万物描边"：剪影外圈 1px 深色。在目标尺寸上
 *                     生成，所以永远正好 1px。
 *
 * 用法：
 *   node tools/sprite-prep.mjs -i <sprite.png> -o <out.png> --width 24 [--preview 8]
 *   node tools/sprite-prep.mjs --batch <manifest.json>
 *
 * 参数：
 *   --width N          目标宽度（高度按原比例）
 *   --colors N         量化色数，默认 16，0 表示不量化
 *   --threshold N      alpha 二值化阈值，默认 128
 *   --outline #RRGGBB  描边色，默认 #14121f；--no-outline 关闭
 *   --no-fill          关闭填洞
 *   --preview N        输出 N 倍最近邻放大图
 */
import path from 'node:path';
import fs from 'node:fs';
import { readPNG, writePNG } from './png.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

function die(m) {
  console.error(m);
  process.exit(1);
}

function hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  if (h.length !== 6) die('bad hex: ' + hex);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
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

/**
 * area 平均降采样 + alpha 二值化。
 * 颜色按 alpha 加权（半透明像素不该稀释颜色），覆盖率超阈值才判为不透明。
 */
function areaDownsample(img, tw, threshold) {
  const th = Math.max(1, Math.round((img.h * tw) / img.w));
  const out = Buffer.alloc(tw * th * 4);

  for (let dy = 0; dy < th; dy++) {
    const sy0 = Math.floor((dy * img.h) / th);
    const sy1 = Math.max(sy0 + 1, Math.floor(((dy + 1) * img.h) / th));
    for (let dx = 0; dx < tw; dx++) {
      const sx0 = Math.floor((dx * img.w) / tw);
      const sx1 = Math.max(sx0 + 1, Math.floor(((dx + 1) * img.w) / tw));

      let r = 0, g = 0, b = 0, aSum = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const si = (sy * img.w + sx) * 4;
          const a = img.data[si + 3];
          r += img.data[si] * a;
          g += img.data[si + 1] * a;
          b += img.data[si + 2] * a;
          aSum += a;
          n++;
        }
      }
      const di = (dy * tw + dx) * 4;
      const coverage = n ? aSum / (n * 255) : 0;
      if (coverage * 255 < threshold) {
        out[di + 3] = 0;
      } else {
        // aSum 是 alpha 加权和，用它当分母还原真实颜色
        out[di] = aSum ? Math.round(r / aSum) : 0;
        out[di + 1] = aSum ? Math.round(g / aSum) : 0;
        out[di + 2] = aSum ? Math.round(b / aSum) : 0;
        out[di + 3] = 255;
      }
    }
  }
  return { w: tw, h: th, data: out };
}

/**
 * 填洞：从画布四边 flood fill 标记"外部透明"，剩下没被标记的透明像素
 * 就是被剪影包住的洞，填成相邻不透明像素的众数色。
 */
function fillHoles(img) {
  const { w, h } = img;
  const outside = new Uint8Array(w * h);
  const stack = [];

  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = y * w + x;
    if (outside[i]) return;
    if (img.data[i * 4 + 3] !== 0) return;
    outside[i] = 1;
    stack.push(i);
  };

  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }

  while (stack.length) {
    const i = stack.pop();
    const x = i % w;
    const y = (i / w) | 0;
    push(x - 1, y); push(x + 1, y); push(x, y - 1); push(x, y + 1);
  }

  const out = Buffer.from(img.data);
  let filled = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (out[i * 4 + 3] !== 0 || outside[i]) continue;
      // 取 8 邻接不透明像素的众数色
      const counts = new Map();
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (out[ni * 4 + 3] === 0) continue;
          const key = (out[ni * 4] << 16) | (out[ni * 4 + 1] << 8) | out[ni * 4 + 2];
          counts.set(key, (counts.get(key) || 0) + 1);
        }
      }
      let bestKey = -1, bestN = 0;
      for (const [k, v] of counts) if (v > bestN) { bestN = v; bestKey = k; }
      if (bestKey >= 0) {
        out[i * 4] = (bestKey >> 16) & 0xff;
        out[i * 4 + 1] = (bestKey >> 8) & 0xff;
        out[i * 4 + 2] = bestKey & 0xff;
        out[i * 4 + 3] = 255;
        filled++;
      }
    }
  }
  return { img: { w, h, data: out }, filled };
}

/** 中值切分量化，只动不透明像素。 */
function quantize(img, maxColors) {
  if (!maxColors || maxColors < 2) return img;
  const px = [];
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3] !== 0) px.push([img.data[i], img.data[i + 1], img.data[i + 2]]);
  }
  if (!px.length) return img;

  let boxes = [px];
  while (boxes.length < maxColors) {
    let bi = -1, best = -1, bestCh = 0;
    boxes.forEach((box, k) => {
      if (box.length < 2) return;
      for (let ch = 0; ch < 3; ch++) {
        let lo = 255, hi = 0;
        for (const p of box) { if (p[ch] < lo) lo = p[ch]; if (p[ch] > hi) hi = p[ch]; }
        if (hi - lo > best) { best = hi - lo; bi = k; bestCh = ch; }
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

/** 1px 描边，8 邻接（4 邻接在斜角会断线）。先扩 1px 边距保证贴边也能描。 */
function addOutline(img, rgb) {
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
    out[p * 4] = rgb[0]; out[p * 4 + 1] = rgb[1];
    out[p * 4 + 2] = rgb[2]; out[p * 4 + 3] = 255;
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

function prepOne(spec) {
  const inPath = path.resolve(ROOT, spec.in);
  if (!fs.existsSync(inPath)) die('missing sprite: ' + inPath);

  let img = readPNG(inPath);
  const srcSize = { w: img.w, h: img.h };

  img = trimAlpha(img);

  const targetW = Math.round(spec.width);
  if (!targetW || targetW < 4) die('bad --width for ' + spec.in);

  const steps = [];
  img = areaDownsample(img, targetW, spec.threshold == null ? 128 : spec.threshold);
  steps.push('downsample');

  let filled = 0;
  if (spec.fill !== false) {
    const r = fillHoles(img);
    img = r.img;
    filled = r.filled;
    steps.push('fillHoles:' + filled);
  }

  if (spec.colors) {
    img = quantize(img, spec.colors);
    steps.push('quantize:' + spec.colors);
  }

  if (spec.outline !== false) {
    img = addOutline(img, hexToRgb(spec.outline || '#14121f'));
    steps.push('outline');
  }

  const outPath = path.resolve(ROOT, spec.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  writePNG(outPath, img.w, img.h, img.data);

  let previewPath = null;
  const pv = spec.preview || 0;
  if (pv > 1) {
    previewPath = outPath.replace(/\.png$/i, '@' + pv + 'x.png');
    const big = scaleNearest(img, img.w * pv, img.h * pv);
    writePNG(previewPath, big.w, big.h, big.data);
  }

  return {
    in: path.relative(ROOT, inPath),
    out: path.relative(ROOT, outPath),
    preview: previewPath ? path.relative(ROOT, previewPath) : null,
    srcSize,
    size: { w: img.w, h: img.h },
    steps,
  };
}

function parseArgs(argv) {
  const o = { preview: 0, colors: 16 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-i') o.in = argv[++i];
    else if (a === '-o') o.out = argv[++i];
    else if (a === '--width') o.width = Number(argv[++i]);
    else if (a === '--colors') o.colors = Number(argv[++i]);
    else if (a === '--threshold') o.threshold = Number(argv[++i]);
    else if (a === '--outline') o.outline = argv[++i];
    else if (a === '--no-outline') o.outline = false;
    else if (a === '--no-fill') o.fill = false;
    else if (a === '--preview') o.preview = Number(argv[++i]);
    else if (a === '--batch') o.batch = argv[++i];
    else die('unknown arg ' + a);
  }
  return o;
}

const args = parseArgs(process.argv.slice(2));

if (args.batch) {
  const man = JSON.parse(fs.readFileSync(path.resolve(ROOT, args.batch), 'utf8'));
  if (!Array.isArray(man.items)) die('manifest needs { items: [...] }');
  const results = man.items.map((it) =>
    prepOne({
      in: it.in,
      out: it.out,
      width: it.width,
      colors: it.colors === undefined ? args.colors : it.colors,
      threshold: it.threshold,
      outline: it.outline,
      fill: it.fill,
      preview: it.preview || 0,
    })
  );
  console.log(JSON.stringify({ ok: true, count: results.length, results }, null, 2));
} else {
  if (!args.in || !args.out || !args.width) die('need -i, -o, --width');
  console.log(JSON.stringify({ ok: true, results: [prepOne(args)] }, null, 2));
}
