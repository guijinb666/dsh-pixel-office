#!/usr/bin/env node
/**
 * key-magenta.mjs —— 把 AI 出的纯品红底 sprite 转成带 alpha 的 PNG。
 *
 * 为什么单独一步：sprite-prep 只处理"已经有 alpha"的图。而 8 套副角色背面图
 * 是 rgb24 + 纯品红底的。如果直接把它丢给 sprite-prep，alpha 通道恒为 255，
 * trimAlpha 会认为整张图都是前景，包围盒 = 整图，最后得到 26×26 的正方形废图。
 * 所以必须先抠色。
 *
 * 抠色策略（比 ffmpeg colorkey 更适合硬边像素画）：
 *   1. 自动探测背景色：取四角 8×8 块的中位色，避免单点噪点误判。
 *   2. 按"到背景色的欧氏距离"判定前景：d > far 全前景，d < near 全背景，
 *      中间带按线性过渡给半透明 alpha（AI 边缘有抗锯齿圈，硬切会留白边）。
 *   3. 反溢色（despill）：对被判为前景但偏品红的像素，把 R/B 往 G 拉回去，
 *      否则鱼身/裙边会残留一圈洋红色晕。
 *
 * 用法：
 *   node tools/key-magenta.mjs -i <in.png> -o <out.png> [--near 40] [--far 110]
 *   node tools/key-magenta.mjs --batch <manifest.json>
 */
import path from 'node:path';
import fs from 'node:fs';
import { readPNG, writePNG } from './png.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

function die(m) {
  console.error(m);
  process.exit(1);
}

/** 取一个像素的 rgb。 */
function px(img, x, y) {
  const i = (y * img.w + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

/** 四角 8×8 块的中位色。 */
function detectBackground(img) {
  const samples = [];
  const S = 8;
  const corners = [
    [0, 0],
    [img.w - S, 0],
    [0, img.h - S],
    [img.w - S, img.h - S],
  ];
  for (const [ox, oy] of corners) {
    for (let y = 0; y < S; y += 1) {
      for (let x = 0; x < S; x += 1) {
        samples.push(px(img, ox + x, oy + y));
      }
    }
  }
  const median = (idx) => {
    const v = samples.map((s) => s[idx]).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
  };
  return [median(0), median(1), median(2)];
}

/**
 * 抠色主流程。
 * @param {{w:number,h:number,data:Buffer}} img
 * @param {{near:number,far:number,bg:number[]}} opt
 */
function keyMagenta(img, opt) {
  const [br, bg, bb] = opt.bg;
  const out = Buffer.alloc(img.w * img.h * 4);
  const near = opt.near;
  const far = opt.far;
  for (let i = 0, n = img.w * img.h; i < n; i += 1) {
    const r = img.data[i * 4];
    const g = img.data[i * 4 + 1];
    const b = img.data[i * 4 + 2];
    // 到背景色的欧氏距离
    const dr = r - br;
    const dg = g - bg;
    const db = b - bb;
    const d = Math.sqrt(dr * dr + dg * dg + db * db);

    let a;
    if (d <= near) a = 0;
    else if (d >= far) a = 255;
    else a = Math.round(((d - near) / (far - near)) * 255);

    // despill：品红底会把前景边缘染成 R 高 B 高 G 低。
    // 真前景（如鱼身深青蓝、裙子白/粉）里 R 与 B 不会"同时远高于 G"到这个程度，
    // 所以用 G 做基准把 R、B 拉回来，只在检测到明显品红溢出时动。
    let or_ = r;
    let og = g;
    let ob = b;
    const magentaExcess = Math.min(r, b) - g;
    if (magentaExcess > 24) {
      const pull = Math.min(magentaExcess, 96) * 0.75;
      or_ = Math.round(Math.max(0, r - pull));
      ob = Math.round(Math.max(0, b - pull));
    }

    out[i * 4] = or_;
    out[i * 4 + 1] = og;
    out[i * 4 + 2] = ob;
    out[i * 4 + 3] = a;
  }
  return { w: img.w, h: img.h, data: out };
}

/** 处理一条。 */
function processOne(spec, defaults) {
  const inPath = path.resolve(ROOT, spec.in);
  const outPath = path.resolve(ROOT, spec.out);
  if (!fs.existsSync(inPath)) die('missing input: ' + spec.in);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const img = readPNG(inPath);
  const bg = spec.bg ?? detectBackground(img);
  const keyed = keyMagenta(img, {
    near: spec.near ?? defaults.near,
    far: spec.far ?? defaults.far,
    bg,
  });
  writePNG(outPath, keyed.w, keyed.h, keyed.data);

  // 抠完再算一次包围盒，方便确认真的抠出了瘦长的人形
  let x0 = keyed.w;
  let y0 = keyed.h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < keyed.h; y += 1) {
    for (let x = 0; x < keyed.w; x += 1) {
      if (keyed.data[(y * keyed.w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  const bbox = x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  return { in: spec.in, out: spec.out, bg, bbox };
}

// --- 参数解析 -------------------------------------------------------------

const argv = process.argv.slice(2);
const args = { near: 40, far: 110 };
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '-i') args.in = argv[++i];
  else if (a === '-o') args.out = argv[++i];
  else if (a === '--near') args.near = Number(argv[++i]);
  else if (a === '--far') args.far = Number(argv[++i]);
  else if (a === '--batch') args.batch = argv[++i];
  else if (a === '--json') args.json = true;
  else die('unknown arg: ' + a);
}

if (args.batch) {
  const man = JSON.parse(fs.readFileSync(path.resolve(ROOT, args.batch), 'utf8'));
  const results = [];
  for (const it of man.items ?? []) {
    const spec = {
      ...it,
      near: it.near === undefined ? args.near : it.near,
      far: it.far === undefined ? args.far : it.far,
    };
    results.push(processOne(spec, args));
  }
  console.log(JSON.stringify({ count: results.length, items: results }, null, 2));
} else {
  if (!args.in || !args.out) die('need -i and -o (or --batch)');
  const r = processOne(args, args);
  console.log(args.json ? JSON.stringify(r) : `${r.out}  bbox=${JSON.stringify(r.bbox)}  bg=${r.bg.join(',')}`);
}
