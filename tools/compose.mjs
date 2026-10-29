#!/usr/bin/env node
/**
 * compose.mjs - 把角色 sprite 合成到场景上，用于锚点与比例标定。
 *
 * 纯 Node 实现（tools/png.mjs），不走 ffmpeg：ffmpeg 的 overlay 默认 YUV420，
 * 会把像素画的纯色块糊掉、色值漂移，标定阶段必须看见真实上屏效果。
 *
 * 用法：
 *   node tools/compose.mjs -s <scene> -o <out> [--preview 4] \
 *        --seat "X,Y,W,spritePath" [--seat ...]
 *
 * X,Y 是 sprite 左上角在场景坐标系里的位置；W 是目标宽度，高度按原图比例推导。
 * 缩放一律用最近邻（整数计算，无插值）。
 */
import path from 'node:path';
import fs from 'node:fs';
import { readPNG, writePNG } from './png.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

function die(m) {
  console.error(m);
  process.exit(1);
}

function rgbaAt(img, x, y) {
  const i = (y * img.w + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}

/** 最近邻缩放：目标像素 (dx,dy) 反查源像素 (sx,sy)。 */
function scaleNearest(img, tw, th) {
  const out = Buffer.alloc(tw * th * 4);
  for (let dy = 0; dy < th; dy++) {
    const sy = Math.min(img.h - 1, Math.floor((dy * img.h) / th));
    for (let dx = 0; dx < tw; dx++) {
      const sx = Math.min(img.w - 1, Math.floor((dx * img.w) / tw));
      const si = (sy * img.w + sx) * 4;
      const di = (dy * tw + dx) * 4;
      out[di] = img.data[si];
      out[di + 1] = img.data[si + 1];
      out[di + 2] = img.data[si + 2];
      out[di + 3] = img.data[si + 3];
    }
  }
  return { w: tw, h: th, data: out };
}

/**
 * 整数 alpha 混合（straight alpha，非预乘）。
 * 半透明像素在剪影边缘很常见，必须按 alpha 加权而不是硬覆盖。
 */
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
        base.data[bi] = top.data[ti];
        base.data[bi + 1] = top.data[ti + 1];
        base.data[bi + 2] = top.data[ti + 2];
        base.data[bi + 3] = 255;
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

function parseArgs(argv) {
  const o = { seats: [], preview: 4 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-s') o.scene = argv[++i];
    else if (a === '-o') o.output = argv[++i];
    else if (a === '--preview') o.preview = Number(argv[++i]);
    else if (a === '--seat') o.seats.push(argv[++i]);
    else die('unknown arg ' + a);
  }
  return o;
}

const args = parseArgs(process.argv.slice(2));
if (!args.scene || !args.output) die('need -s <scene> and -o <out>');

const scenePath = path.resolve(ROOT, args.scene);
if (!fs.existsSync(scenePath)) die('missing scene: ' + scenePath);
const scene = readPNG(scenePath);
console.log('scene ' + path.basename(scenePath) + ' ' + scene.w + 'x' + scene.h);

if (!args.seats.length) die('need at least one --seat "X,Y,W,sprite"');

// 复制一份做画布，避免改动源图缓冲。
const canvas = { w: scene.w, h: scene.h, data: Buffer.from(scene.data) };

args.seats.forEach((spec, idx) => {
  const p = spec.split(',');
  if (p.length !== 4) die('--seat must be "X,Y,W,sprite", got: ' + spec);
  const x = Math.round(Number(p[0]));
  const y = Math.round(Number(p[1]));
  const w = Math.round(Number(p[2]));
  const spritePath = path.resolve(ROOT, p[3]);
  if (!fs.existsSync(spritePath)) die('missing sprite: ' + spritePath);

  const src = readPNG(spritePath);
  const th = Math.max(1, Math.round((src.h * w) / src.w));
  const scaled = scaleNearest(src, w, th);
  blendOver(canvas, scaled, x, y);
  console.log(
    '  seat#' + idx + ' ' + path.basename(spritePath) + ' ' + src.w + 'x' + src.h +
      ' -> (' + x + ',' + y + ') ' + w + 'x' + th
  );
});

const outPath = path.resolve(ROOT, args.output);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
writePNG(outPath, canvas.w, canvas.h, canvas.data);

const prevPath = outPath.replace(/\.png$/i, '@' + args.preview + 'x.png');
writePNG(prevPath, canvas.w * args.preview, canvas.h * args.preview,
  scaleNearest(canvas, canvas.w * args.preview, canvas.h * args.preview).data);

console.log(
  JSON.stringify(
    {
      ok: true,
      composite: path.relative(ROOT, outPath),
      preview: path.relative(ROOT, prevPath),
      sceneSize: { w: scene.w, h: scene.h },
      seats: args.seats.length,
    },
    null,
    2
  )
);
