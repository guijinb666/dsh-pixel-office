// 最终化单张 sprite：从 AI 出的大图走到「可直接进 canvas 的低分辨率贴图」。
//
// 为什么需要这个脚本而不是直接 scale：
// AI 出的"像素画"其实不是真像素网格 —— 它的每个色块边缘有 1-2px 的亚像素
// 过渡（JPEG 压缩 + 模型的柔边倾向）。直接 area 降采样会把那些过渡揉成
// 脏灰边，越降越糊。正确顺序是先在中分辨率上做中值滤波把柔边抹平，
// 再降到目标尺寸，最后空降到统一色板把色数压死。
//
// 流水线（顺序不能换）：
//   crop → colorkey(自动探测键色) → trim → median(抹柔边) → scale(area)
//   → paletteuse(dither=none, 可选) → 输出
//
// 用法：
//   node tools/finalize-sprite.mjs -i in.png -o out.png --width 56
//   node tools/finalize-sprite.mjs -i in.png -o out/ --width 56 --palette pal.png
//   node tools/finalize-sprite.mjs -i in.png -o out/ --widths 64,56,48 --preview 4
//
// 参数：
//   -i/--in        输入（必填）
//   -o/--out       输出文件，或目录（配 --widths 时按 s<N>.png 命名）
//   --width/--widths  目标逻辑宽度（像素）。给 --widths 会一次出多档
//   --palette      统一色板 PNG。给了就用它套色
//   --colors       无 --palette 时的色数，默认 24
//   --median       中值滤波半径，默认 2（在降采样前、原尺寸上做）
//   --key          手动指定键色 0xRRGGBB；省略则自动探测
//   --sim/--blend  colorkey 参数
//   --preview N    额外输出一个 N 倍最近邻放大图，仅供肉眼看
//   --json         只输出 JSON

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const FFMPEG = process.env.FFMPEG_PATH
  || 'C:\\Users\\30612\\.dsh\\tools\\ffmpeg\\bin\\ffmpeg.exe';
const FFPROBE = process.env.FFPROBE_PATH
  || 'C:\\Users\\30612\\.dsh\\tools\\ffmpeg\\bin\\ffprobe.exe';

function parseArgs(argv) {
  const o = { width: 56, median: 2, colors: 24, sim: 0.22, blend: 0.10 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-i' || a === '--in') o.input = argv[++i];
    else if (a === '-o' || a === '--out') o.output = argv[++i];
    else if (a === '--width') o.width = Number(argv[++i]);
    else if (a === '--widths') o.widths = argv[++i].split(',').map(Number);
    else if (a === '--palette') o.palette = argv[++i];
    else if (a === '--colors') o.colors = Number(argv[++i]);
    else if (a === '--median') o.median = Number(argv[++i]);
    else if (a === '--key') o.key = argv[++i];
    else if (a === '--sim') o.sim = Number(argv[++i]);
    else if (a === '--blend') o.blend = Number(argv[++i]);
    else if (a === '--preview') o.preview = Number(argv[++i]);
    else if (a === '--json') o.json = true;
  }
  return o;
}

function ff(args) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
  });
  if (r.status !== 0) throw new Error(r.stderr || `ffmpeg exit ${r.status}`);
}

function probeSize(file) {
  const r = spawnSync(FFPROBE, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file
  ], { encoding: 'utf8' });
  const [w, h] = String(r.stdout).trim().split(',').map(Number);
  return { w, h };
}

// 四角取中位数作为键色。AI 对提示词里的 #FF00FF 还原有偏差，
// 实测出过 #C903C7 / #C601C3 / #C101B1 等，写死必然抠不掉。
function detectKey(file, tmpDir) {
  const { w: W, h: H } = probeSize(file);
  const raw = path.join(tmpDir, 'corner.raw');
  const samples = [];
  for (const [x, y] of [[0, 0], [W - 2, 0], [0, H - 2], [W - 2, H - 2]]) {
    ff(['-i', file, '-vf', `crop=2:2:${x}:${y},format=rgb24`, '-frames:v', '1', '-f', 'rawvideo', raw]);
    const b = fs.readFileSync(raw);
    for (let i = 0; i + 2 < b.length; i += 3) samples.push([b[i], b[i + 1], b[i + 2]]);
  }
  fs.rmSync(raw, { force: true });
  if (!samples.length) return '0xFF00FF';
  const med = [0, 1, 2].map((ch) => {
    const v = samples.map((s) => s[ch]).sort((a, b) => a - b);
    return v[v.length >> 1];
  });
  return `0x${med.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

// alpha 包围盒。不用 cropdetect：它把结果打到 stderr，拿不到就静默全尺寸。
function alphaBox(file, w, h, tmpDir) {
  const raw = path.join(tmpDir, 'alpha.raw');
  ff(['-i', file, '-vf', 'alphaextract', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', raw]);
  const buf = fs.readFileSync(raw);
  fs.rmSync(raw, { force: true });
  if (buf.length < w * h) return { x: 0, y: 0, w, h };
  let minX = w; let minY = h; let maxX = -1; let maxY = -1;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (buf[y * w + x] > 12) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { x: 0, y: 0, w, h };
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function oneWidth(args, tmpDir, keyColor, width) {
  const { w: W, h: H } = probeSize(args.input);
  const cell = path.join(tmpDir, 'cell.png');
  ff(['-i', args.input, '-vf',
    `colorkey=${keyColor}:${args.sim}:${args.blend},format=rgba`,
    cell]);

  const box = alphaBox(cell, W, H, tmpDir);
  const trimmed = path.join(tmpDir, 'trim.png');
  ff(['-i', cell, '-vf', `crop=${box.w}:${box.h}:${box.x}:${box.y}`, trimmed]);

  // 中值滤波必须在降采样之前、在原尺寸上做：
  // 目的是抹掉 AI 柔边（1-2px 亚像素过渡），尺度太小抹不动，太大会吃掉五官。
  const med = args.median > 0 ? `,median=${args.median}` : '';

  const pre = `${med.slice(1) ? med.slice(1) + ',' : ''}format=rgba,scale=${width}:-1:flags=area`;
  const scaled = path.join(tmpDir, `s${width}.png`);

  // 量化必须分三步做，不能挤在一条 -vf 里：
  //  1) 降采样落盘（保留 alpha）
  //  2) palettegen 生成色板（reserve_transparent=1 让色板首项是透明槽）
  //  3) paletteuse 套色，**后面必须跟 format=rgba**
  //
  // 第 3 步的 format=rgba 是关键：paletteuse 的输出像素格式是 pal8，
  // 而 pal8 在本机 ffmpeg 里没有 alpha 平面 —— 直接落盘 PNG 时透明区会被
  // 填成色板里某个不透明颜色（表现就是整片绿底或品红底）。
  // 实测：paletteuse 后接 format=rgba 透明率 36.3%，不接则 alpha 平面整个消失。
  const prepped = path.join(tmpDir, `pre${width}.png`);
  fs.mkdirSync(tmpDir, { recursive: true });
  ff(['-i', trimmed, '-vf', pre, prepped]);

  const pal = path.join(tmpDir, `pal${width}.png`);
  const palSrc = args.palette && fs.existsSync(args.palette) ? args.palette : prepped;
  ff(['-i', palSrc, '-vf',
    `palettegen=max_colors=${args.colors}:stats_mode=full:reserve_transparent=1`, pal]);

  ff(['-i', prepped, '-i', pal, '-lavfi',
    'paletteuse=dither=none:alpha_threshold=128,format=rgba', scaled]);

  const outPath = args.widths
    ? path.join(args.output, `s${width}.png`)
    : args.output;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.copyFileSync(scaled, outPath);
  const result = { width, file: path.resolve(outPath), logical: probeSize(outPath) };

  if (args.preview > 0) {
    const prev = outPath.replace(/\.png$/, `@${args.preview}x.png`);
    ff(['-i', outPath, '-vf',
      `scale=iw*${args.preview}:ih*${args.preview}:flags=neighbor`, prev]);
    result.preview = path.resolve(prev);
  }
  return result;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) throw new Error('缺少 -i');
  if (!args.output) throw new Error('缺少 -o');
  if (!fs.existsSync(args.input)) throw new Error(`输入不存在: ${args.input}`);

  const tmpDir = path.join(path.dirname(path.resolve(args.output)), '.tmp-finalize');
  fs.mkdirSync(tmpDir, { recursive: true });

  const keyColor = args.key || detectKey(args.input, tmpDir);
  const widths = args.widths || [args.width];
  const results = widths.map((w) => oneWidth(args, tmpDir, keyColor, w));

  const summary = {
    ok: true,
    input: path.resolve(args.input),
    keyColor,
    keyAuto: !args.key,
    median: args.median,
    palette: args.palette || null,
    colors: args.palette ? null : args.colors,
    results
  };
  if (args.json) process.stdout.write(`${JSON.stringify(summary)}\n`);
  else process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

try {
  main();
} catch (err) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: String(err?.message || err) })}\n`);
  process.exitCode = 1;
}
