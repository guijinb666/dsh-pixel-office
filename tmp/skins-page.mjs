// 把 assets/char/subs/sit-front/*-front.png（1328 方图、品红底）做成介绍页用的高分辨率透明皮肤图。
// 为什么不用 sprite-prep：那是给 26px 游戏内 sprite 用的，会把细节量化没；页面要的是大图。
// 处理：品红抠底（带 despill）→ 清最外 8px（qwen 偶尔在画布边缘画一圈不透明描边，不清 bbox 会撑满 → 缩放后糊成一团）→ 量 bbox → 缩到目标宽 → 输出。
import path from 'node:path';
import { readPNG, writePNG } from '../tools/png.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'assets/char/subs/sit-front');
const OUT = path.join(ROOT, 'site/media');
const NAMES = ['m1-cat', 'm2-sakura', 'm3-gothic', 'm4-sailor', 'm5-sporty', 'm6-witch', 'm7-cafe', 'm8-idol'];
const TARGET_W = 460;
const BORDER = 8;

function px(img, x, y) { const i = (y * img.w + x) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]]; }

function detectBg(img) {
  const S = 8, s = [];
  for (const [ox, oy] of [[0, 0], [img.w - S, 0], [0, img.h - S], [img.w - S, img.h - S]]) {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) s.push(px(img, ox + x, oy + y));
  }
  const med = (i) => { const a = s.map((p) => p[i]).sort((p, q) => p - q); return a[a.length >> 1]; };
  return [med(0), med(1), med(2)];
}

function keyMagenta(img, near = 44, far = 130) {
  const [br, bg, bb] = detectBg(img);
  const out = Buffer.alloc(img.data.length);
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const i = (y * img.w + x) * 4;
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
      const d = Math.hypot(r - br, g - bg, b - bb);
      let a;
      if (d <= near) a = 0;
      else if (d >= far) a = 255;
      else a = Math.round(((d - near) / (far - near)) * 255);
      if (a > 0) {
        // despill：偏品红的像素把 R/B 往 G 拉回去，否则裙边留一圈洋红晕
        const mg = Math.min(r, b) - g;
        if (mg > 8) {
          const k = Math.min(1, (mg - 8) / 90);
          const t = Math.round(mg * 0.85 * k);
          out[i] = Math.max(0, r - t);
          out[i + 1] = g;
          out[i + 2] = Math.max(0, b - t);
          out[i + 3] = a;
          continue;
        }
      }
      out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = a;
    }
  }
  return { w: img.w, h: img.h, data: out };
}

function clearBorder(img, n) {
  let cleared = 0;
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      if (x < n || y < n || x >= img.w - n || y >= img.h - n) {
        const i = (y * img.w + x) * 4;
        if (img.data[i + 3] !== 0) { img.data[i + 3] = 0; cleared += 1; }
      }
    }
  }
  return cleared;
}

function bbox(img) {
  let x0 = img.w, y0 = img.h, x1 = -1, y1 = -1;
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      if (img.data[(y * img.w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// 面积平均降采样（比最近邻保留更多细节，适合 1328→460 这种非整数比）
function resize(img, box, tw, th) {
  const out = Buffer.alloc(tw * th * 4);
  const sx = box.w / tw, sy = box.h / th;
  for (let y = 0; y < th; y++) {
    const y0 = box.y + Math.floor(y * sy), y1 = Math.min(box.y + box.h, box.y + Math.ceil((y + 1) * sy));
    for (let x = 0; x < tw; x++) {
      const x0 = box.x + Math.floor(x * sx), x1 = Math.min(box.x + box.w, box.x + Math.ceil((x + 1) * sx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * img.w + xx) * 4;
          const al = img.data[i + 3];
          if (al === 0) continue;
          r += img.data[i] * al; g += img.data[i + 1] * al; b += img.data[i + 2] * al;
          a += al; n += 1;
        }
      }
      const o = (y * tw + x) * 4;
      if (a === 0) { out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0; continue; }
      out[o] = Math.round(r / a);
      out[o + 1] = Math.round(g / a);
      out[o + 2] = Math.round(b / a);
      out[o + 3] = Math.round(a / n);
    }
  }
  return { w: tw, h: th, data: out };
}

const report = [];
NAMES.forEach((name, idx) => {
  const raw = readPNG(path.join(SRC, `${name}-front.png`));
  const keyed = keyMagenta(raw);
  const cleared = clearBorder(keyed, BORDER);
  const box = bbox(keyed);
  const tw = TARGET_W;
  const th = Math.max(1, Math.round((box.h / box.w) * tw));
  const small = resize(keyed, box, tw, th);
  const file = path.join(OUT, `skin-${idx + 1}.png`);
  writePNG(file, small.w, small.h, small.data);
  report.push(`${name}  src=${raw.w}x${raw.h}  borderCleared=${cleared}  ink=${box.w}x${box.h}@${box.x},${box.y}  -> skin-${idx + 1}.png ${small.w}x${small.h}`);
});
console.log(report.join('\n'));
