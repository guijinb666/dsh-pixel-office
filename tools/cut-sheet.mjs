// 图集切帧器：把 2x2 / 3x3 / 2x3 的 sprite sheet 切成单帧，并完成
// 抠色 → 降采样 → 量化 的全流程。
//
// 为什么要走这一步：
// AI 生图只能保证「同一张图内」形象一致，跨次生成必漂。所以动作帧必须
// 先让 AI 画成一张 sprite sheet，再由本脚本切成独立 PNG。
//
// 流水线（顺序不能换）：
//   1. crop      按网格切出每格
//   2. colorkey  抠掉纯品红背景 → alpha
//   3. despill   去品红溢色（AI 品红底会在描边边缘渗色）
//   4. scale     用 area 降到目标逻辑尺寸（这一步才产生"像素颗粒"）
//   5. palettegen/paletteuse  空降到统一色板，保证所有资产同色系
//
// 用法：
//   node tools/cut-sheet.mjs -i sheet.png -o out/ --cols 2 --rows 2 --names type-a,type-b,type-c,type-d
//   node tools/cut-sheet.mjs -i sheet.png -o out/ --cols 2 --rows 2 --size 96 --palette pal.png
//
// 参数：
//   -i/--in        输入 sprite sheet（必填）
//   -o/--out       输出目录（必填，不存在会建）
//   --cols/--rows  网格列数/行数，默认 2 2
//   --names        逗号分隔的帧名，按行优先顺序。省略则用 cell-r0c0 形式
//   --size         输出正方形边长（像素），默认 96（=32 逻辑 × 3 倍便于后续缩）
//   --trim         是否按 alpha 包围盒裁掉四周空白，默认开
//   --pad          裁完后四周留的空边像素，默认 2
//   --palette      统一色板 PNG 路径。给了就用它套色，不给就只降采样不量化
//   --colors       没有 --palette 时的色数，默认 32
//   --key          要抠掉的背景色，默认 0xFF00FF（品红）
//   --sim/--blend  colorkey 的相似度/混合度，默认 0.16 / 0.06
//   --json         只输出 JSON

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const FFMPEG = process.env.FFMPEG_PATH
  || 'C:\\Users\\30612\\.dsh\\tools\\ffmpeg\\bin\\ffmpeg.exe';
const FFPROBE = process.env.FFPROBE_PATH
  || 'C:\\Users\\30612\\.dsh\\tools\\ffmpeg\\bin\\ffprobe.exe';

function parseArgs(argv) {
  const o = { cols: 2, rows: 2, size: 96, trim: true, pad: 2, colors: 32, key: '0xFF00FF', sim: 0.22, blend: 0.10, keyAuto: true, keyExplicit: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-i' || a === '--in') o.input = argv[++i];
    else if (a === '-o' || a === '--out') o.outDir = argv[++i];
    else if (a === '--cols') o.cols = Number(argv[++i]);
    else if (a === '--rows') o.rows = Number(argv[++i]);
    else if (a === '--names') o.names = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--size') o.size = Number(argv[++i]);
    else if (a === '--trim') o.trim = argv[++i] !== 'false';
    else if (a === '--pad') o.pad = Number(argv[++i]);
    else if (a === '--palette') o.palette = argv[++i];
    else if (a === '--colors') o.colors = Number(argv[++i]);
    else if (a === '--key') { o.key = argv[++i]; o.keyExplicit = true; }
    else if (a === '--no-auto-key') o.keyAuto = false;
    else if (a === '--sim') o.sim = Number(argv[++i]);
    else if (a === '--blend') o.blend = Number(argv[++i]);
    else if (a === '--json') o.json = true;
  }
  return o;
}

function run(args) {
  return execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  });
}

function probeSize(file) {
  const out = execFileSync(FFPROBE, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file
  ], { encoding: 'utf8' }).trim();
  const [w, h] = out.split(',').map(Number);
  return { w, h };
}

// trim 需要知道实际内容边界。ffmpeg 的 cropdetect 对 alpha 无效，
// 所以改用 crop=... 结合 alphaextract + cropdetect 的替代方案：
// 简单可靠的做法是先用 alphaextract 导出灰度，再用 ffmpeg 的
// `cropdetect` 在黑底上找包围盒 —— 一次跑通，不依赖外部库。
// 自动探测背景色：取四个角落各 2x2 像素的众数。
// 为什么必须探测：提示词要求的 #FF00FF，AI 实际出的是 #C906C9 一带，
// 各家模型对"纯品红"的还原有偏差。写死色值会导致 colorkey 完全匹配不上，
// 抠图静默失效（不报错，只是背景留着），排查起来很费时间。
function detectKeyColor(file, tmpDir) {
  const raw = path.join(tmpDir, 'corner.raw');
  const { w: W, h: H } = probeSize(file);
  const samples = [];
  const corners = [[0, 0], [W - 2, 0], [0, H - 2], [W - 2, H - 2]];
  for (const [x, y] of corners) {
    run(['-i', file, '-vf', `crop=2:2:${x}:${y},format=rgb24`, '-frames:v', '1', '-f', 'rawvideo', raw]);
    const b = fs.readFileSync(raw);
    for (let i = 0; i + 2 < b.length; i += 3) {
      samples.push([b[i], b[i + 1], b[i + 2]]);
    }
  }
  fs.rmSync(raw, { force: true });
  if (samples.length === 0) return { hex: '0xFF00FF', rgb: [255, 0, 255] };
  // 取中位数，抗个别角落被角色压住的情况
  const med = [0, 1, 2].map((ch) => {
    const vals = samples.map((s) => s[ch]).sort((a, b) => a - b);
    return vals[vals.length >> 1];
  });
  const hex = `0x${med.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  return { hex, rgb: med };
}

function detectAlphaBox(file, w, h, tmpDir) {
  // 直接读 alpha 通道的原始灰度字节自己算包围盒。
  // 为什么不用 ffmpeg 的 cropdetect：它的结果打在 stderr 上，
  // 而 execFileSync 只回收 stdout，拿不到就静默退回全尺寸（trim 失效但不报错）。
  const raw = path.join(tmpDir, 'alpha.raw');
  run(['-i', file, '-vf', 'alphaextract', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', raw]);
  const buf = fs.readFileSync(raw);
  fs.rmSync(raw, { force: true });
  if (buf.length < w * h) return { w, h, x: 0, y: 0 };
  let minX = w; let minY = h; let maxX = -1; let maxY = -1;
  for (let y = 0; y < h; y += 1) {
    const row = y * w;
    for (let x = 0; x < w; x += 1) {
      if (buf[row + x] > 16) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { w, h, x: 0, y: 0 };
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) throw new Error('缺少 -i 输入 sprite sheet');
  if (!args.outDir) throw new Error('缺少 -o 输出目录');
  if (!fs.existsSync(args.input)) throw new Error(`输入不存在: ${args.input}`);

  const { w: W, h: H } = probeSize(args.input);
  const cw = Math.floor(W / args.cols);
  const ch = Math.floor(H / args.rows);
  fs.mkdirSync(args.outDir, { recursive: true });
  const tmpDir = path.join(args.outDir, '.tmp-cut');
  fs.mkdirSync(tmpDir, { recursive: true });

  // 背景色：显式给了 --key 就用它；否则自动探测四角。
  const probeKey = args.keyAuto ? detectKeyColor(args.input, tmpDir) : null;
  const keyColor = args.keyExplicit ? args.key : (probeKey?.hex || args.key);

  const frames = [];
  const total = args.cols * args.rows;

  for (let idx = 0; idx < total; idx += 1) {
    const r = Math.floor(idx / args.cols);
    const c = idx % args.cols;
    const name = args.names?.[idx] || `cell-r${r}c${c}`;

    // 1. 切格
    const cell = path.join(tmpDir, `${name}-cell.png`);
    run(['-i', args.input, '-vf', `crop=${cw}:${ch}:${c * cw}:${r * ch}`, cell]);

    // 2. 抠色 + 3. despill
    const keyed = path.join(tmpDir, `${name}-keyed.png`);
    run([
      '-i', cell,
      '-vf', `colorkey=${keyColor}:${args.sim}:${args.blend},despill=type=green:mix=0.4,format=rgba`,
      keyed
    ]);

    // 4. 按 alpha 包围盒裁紧，留 pad
    let box = { w: cw, h: ch, x: 0, y: 0 };
    if (args.trim) {
      box = detectAlphaBox(keyed, cw, ch, tmpDir);
      if (box.w < 4 || box.h < 4) box = { w: cw, h: ch, x: 0, y: 0 };
    }
    const p = args.pad;
    const tx = Math.max(0, box.x - p);
    const ty = Math.max(0, box.y - p);
    const tw = Math.min(cw - tx, box.w + p * 2);
    const th = Math.min(ch - ty, box.h + p * 2);
    const trimmed = path.join(tmpDir, `${name}-trim.png`);
    run(['-i', keyed, '-vf', `crop=${tw}:${th}:${tx}:${ty}`, trimmed]);

    // 5. 等比缩放到 size 的正方形（contain，不拉伸变形）
    const out = path.join(args.outDir, `${name}.png`);
    const fit = `scale=${args.size}:${args.size}:force_original_aspect_ratio=decrease:flags=area`;
    if (args.palette && fs.existsSync(args.palette)) {
      run(['-i', trimmed, '-vf', `${fit},paletteuse=dither=none:alpha_threshold=128`, '-i', args.palette,
        '-filter_complex', `[0:v]${fit}[a];[a][1:v]paletteuse=dither=none:alpha_threshold=128[o]`,
        '-map', '[o]', '-frames:v', '1', out]);
    } else {
      run(['-i', trimmed, '-vf', fit, out]);
    }

    const s = probeSize(out);
    frames.push({ name, file: out, w: s.w, h: s.h, trim: { tw, th, tx, ty } });
  }

  const summary = {
    ok: true,
    sheet: path.resolve(args.input),
    sheetSize: `${W}x${H}`,
    grid: `${args.cols}x${args.rows}`,
    cell: `${cw}x${ch}`,
    keyColor,
    keyAuto: !args.keyExplicit,
    outDir: path.resolve(args.outDir),
    frames
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
