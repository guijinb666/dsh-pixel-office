#!/usr/bin/env node
/**
 * seat-scan.mjs - 座位锚点扫描：同一张 sprite 在一系列 (x,y) 上试贴，
 * 输出并排对比图，用来肉眼挑出最像"坐在工位上"的位置。
 *
 * 用法：
 *   node tools/seat-scan.mjs -s <scene> -o <out.png> --sprite <path> --width 22 \
 *        --points "x,y;x,y;..."; 
 *   或者扫 y 偏移：
 *   node tools/seat-scan.mjs -s <scene> -o <out.png> --sprite <path> --width 22 \
 *        --anchor "72,235" --dy "-8,-4,0,4,8"
 *
 * 每个候选裁一块同样的窗口，横向拼起来，窗口以 anchor 为中心。
 */
import path from 'node:path';
import fs from 'node:fs';
import { readPNG, writePNG } from './png.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

function die(m) {
  console.error(m);
  process.exit(1);
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

function blendOver(base, top, ox, oy) {
  for (let y = 0; y < top.h; y++) {
    const by = oy + y;
    if (by < 0 || by >= base.h) continue;
    for (let x = 0; x < top.w; x++) {
      const bx = ox + x;
      if (bx < 0 || bx >= base.w) continue;
      const ti = (y * top.w + x) * 4;
      const a = top.data[ti + 3];
      if (a === 0) continue;
      const bi = (by * base.w + bx) * 4;
      if (a === 255) {
        base.data[bi] = top.data[ti]; base.data[bi + 1] = top.data[ti + 1];
        base.data[bi + 2] = top.data[ti + 2]; base.data[bi + 3] = 255;
        continue;
      }
      const k = a / 255;
      base.data[bi] = Math.round(top.data[ti] * k + base.data[bi] * (1 - k));
      base.data[bi + 1] = Math.round(top.data[ti + 1] * k + base.data[bi + 1] * (1 - k));
      base.data[bi + 2] = Math.round(top.data[ti + 2] * k + base.data[bi + 2] * (1 - k));
      base.data[bi + 3] = 255;
    }
  }
}

/** 裁一个窗口出来（越界补场景底色，不补黑）。 */
function cropWin(img, x, y, w, h, bg) {
  const out = Buffer.alloc(w * h * 4);
  for (let dy = 0; dy < h; dy++) {
    const sy = y + dy;
    for (let dx = 0; dx < w; dx++) {
      const sx = x + dx;
      const di = (dy * w + dx) * 4;
      if (sx < 0 || sy < 0 || sx >= img.w || sy >= img.h) {
        out[di] = bg[0]; out[di + 1] = bg[1]; out[di + 2] = bg[2]; out[di + 3] = 255;
      } else {
        const si = (sy * img.w + sx) * 4;
        out[di] = img.data[si]; out[di + 1] = img.data[si + 1];
        out[di + 2] = img.data[si + 2]; out[di + 3] = 255;
      }
    }
  }
  return { w, h, data: out };
}

function parseArgs(argv) {
  const o = { scale: 6, win: [56, 64] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-s') o.scene = argv[++i];
    else if (a === '-o') o.out = argv[++i];
    else if (a === '--sprite') o.sprite = argv[++i];
    else if (a === '--width') o.width = Number(argv[++i]);
    else if (a === '--points') o.points = argv[++i];
    else if (a === '--anchor') o.anchor = argv[++i];
    else if (a === '--dy') o.dy = argv[++i];
    else if (a === '--dx') o.dx = argv[++i];
    else if (a === '--scale') o.scale = Number(argv[++i]);
    else if (a === '--win') o.win = argv[++i].split(',').map(Number);
    else die('unknown arg ' + a);
  }
  return o;
}

const args = parseArgs(process.argv.slice(2));
if (!args.scene || !args.out || !args.sprite || !args.width) {
  die('need -s, -o, --sprite, --width');
}

const scene = readPNG(path.resolve(ROOT, args.scene));
const sprite = readPNG(path.resolve(ROOT, args.sprite));
const sw = Math.round(args.width);
const sh = Math.max(1, Math.round((sprite.h * sw) / sprite.w));
const scaled = scaleNearest(sprite, sw, sh);

// 解析候选锚点
const cands = [];
if (args.points) {
  for (const p of args.points.split(';')) {
    if (!p.trim()) continue;
    const [x, y] = p.split(',').map(Number);
    cands.push({ x, y });
  }
} else if (args.anchor && args.dy) {
  const [ax, ay] = args.anchor.split(',').map(Number);
  const dys = args.dy.split(',').map(Number);
  const dxs = args.dx ? args.dx.split(',').map(Number) : [0];
  for (const ddx of dxs) for (const ddy of dys) cands.push({ x: ax + ddx, y: ay + ddy });
} else {
  die('need --points or --anchor + --dy');
}

const bg = [0x3a, 0x2d, 0x47];
const [ww, wh] = args.win;
const scale = args.scale;

const tiles = cands.map((c) => {
  const canvas = { w: scene.w, h: scene.h, data: Buffer.from(scene.data) };
  blendOver(canvas, scaled, c.x, c.y);
  const cx = Math.round(c.x + sw / 2);
  const cy = Math.round(c.y + sh / 2);
  const win = cropWin(canvas, cx - (ww >> 1), cy - (wh >> 1), ww, wh, bg);
  const big = scaleNearest(win, ww * scale, wh * scale);
  return { cand: c, win, big };
});

const W = ww * scale * tiles.length;
const H = wh * scale;
const canvas = { w: W, h: H, data: Buffer.alloc(W * H * 4) };
for (let i = 0; i < W * H; i++) {
  canvas.data[i * 4] = bg[0]; canvas.data[i * 4 + 1] = bg[1];
  canvas.data[i * 4 + 2] = bg[2]; canvas.data[i * 4 + 3] = 255;
}
tiles.forEach((t, k) => blendOver(canvas, t.big, k * ww * scale, 0));

const outPath = path.resolve(ROOT, args.out);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
writePNG(outPath, canvas.w, canvas.h, canvas.data);

console.log(JSON.stringify({
  ok: true,
  out: path.relative(ROOT, outPath),
  spriteSize: { w: sw, h: sh },
  candidates: tiles.map((t) => ({ x: t.cand.x, y: t.cand.y })),
}, null, 2));
