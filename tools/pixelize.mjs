// 像素化（真像素颗粒）v2：把 AI 出的"伪像素画"压成元气骑士那种干净色块。
//
// 为什么 v1 不够：
//   v1 只是"降采样 + 量化"，颗粒感是有了，但墙面/地板那层细噪点在降采样后
//   变成椒盐粒，整体还偏暗——看起来像"低分辨率的插画"，不是"像素画"。
//
// 元气骑士的画面特征其实是三条，缺一不可：
//   1. 干净的色块（每个区域是一块纯色，不是一片噪点）
//   2. 有限的调色板（十几二十色，不是几百色）
//   3. 明确的明暗分层（亮面/暗面/描边三级，不是柔和渐变）
//
// 所以正确顺序是「先洗掉噪点 → 再拉开明暗 → 最后才降采样量化」：
//   bilateral（边缘保留降噪，保留家具轮廓，抹平墙面噪点）
//     → eq（gamma 提亮暗部 + contrast 拉对比 + saturation 提饱和）
//     → scale=area（降采样到真实像素网格）
//     → palettegen/paletteuse dither=none（量化成纯色块）
//     → scale=neighbor（整数放大，仅供肉眼看颗粒）
//
// 用法：
//   node tools/pixelize.mjs -i in.png -w 132 -c 24                 # 标准
//   node tools/pixelize.mjs -i in.png -w 132 -c 24 --denoise 0.6 --gamma 1.45 --contrast 1.25
//   node tools/pixelize.mjs -i in.png --sweep                      # 出 4 档密度
//   node tools/pixelize.mjs -i in.png --variants                   # 出 3 种处理配方对比

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const FFMPEG = 'C:\\Users\\30612\\.dsh\\tools\\ffmpeg\\bin\\ffmpeg.exe';
const FFPROBE = 'C:\\Users\\30612\\.dsh\\tools\\ffmpeg\\bin\\ffprobe.exe';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-i' || a === '--in') out.input = argv[++i];
    else if (a === '-w' || a === '--width') out.width = Number(argv[++i]);
    else if (a === '-c' || a === '--colors') out.colors = Number(argv[++i]);
    else if (a === '-o' || a === '--out') out.out = argv[++i];
    else if (a === '--scale') out.scale = Number(argv[++i]);
    else if (a === '--denoise') out.denoise = Number(argv[++i]);
    else if (a === '--gamma') out.gamma = Number(argv[++i]);
    else if (a === '--contrast') out.contrast = Number(argv[++i]);
    else if (a === '--saturation') out.saturation = Number(argv[++i]);
    else if (a === '--brightness') out.brightness = Number(argv[++i]);
    else if (a === '--sweep') out.sweep = true;
    else if (a === '--variants') out.variants = true;
  }
  return out;
}

async function probeSize(file) {
  const { stdout } = await execFileAsync(FFPROBE, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file
  ], { windowsHide: true });
  const [w, h] = stdout.trim().split(',').map(Number);
  return { width: w, height: h };
}

async function run(args) {
  await execFileAsync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    windowsHide: true, maxBuffer: 8 * 1024 * 1024
  });
}

// 前处理链：洗噪点 + 拉明暗。这一步作用在原始大图上，效果比缩完再处理干净得多。
function preFilter({ denoise, gamma, contrast, saturation, brightness }) {
  const chain = [];
  if (denoise > 0) {
    // bilateral 的 sigmaS（空间半径）越大，抹的横向范围越宽；
    // sigmaR（颜色容差）越大，越容易把不同颜色的边缘也抹平。
    // 注意本机 ffmpeg 的 sigmaR 取值范围是 0~1（不是像素值），
    // 所以用"空间半径大 + 颜色容差小"的组合，正好"抹纹理不抹轮廓"。
    const ss = Math.max(1, Math.round(denoise * 24));
    const sr = Math.min(1, Math.max(0.02, +(denoise * 0.18).toFixed(3)));
    chain.push(`bilateral=sigmaS=${ss}:sigmaR=${sr}`);
  }
  const eq = [];
  if (brightness !== 0) eq.push(`brightness=${brightness}`);
  if (contrast !== 1) eq.push(`contrast=${contrast}`);
  if (saturation !== 1) eq.push(`saturation=${saturation}`);
  if (gamma !== 1) eq.push(`gamma=${gamma}`);
  if (eq.length) chain.push(`eq=${eq.join(':')}`);
  return chain;
}

// 完整流水线。返回真·像素尺寸文件（插件运行时用这个）+ 放大预览图。
async function pixelize(opts) {
  const {
    input, width, colors, outFile, scale = 1, tmpDir,
    denoise = 0.5, gamma = 1.34, contrast = 1.18, saturation = 1.16, brightness = 0.015
  } = opts;

  const src = await probeSize(input);
  const w = Math.max(8, Math.round(width));
  const h = Math.max(8, Math.round((w * src.height) / src.width));

  const pre = preFilter({ denoise, gamma, contrast, saturation, brightness });
  const preStr = pre.length ? pre.join(',') + ',' : '';

  const paletteFile = path.join(tmpDir, 'palette.png');
  const smallFile = path.join(tmpDir, 'small.png');

  // 1. 前处理 + 降采样 + 取调色板
  await run([
    '-i', input,
    '-vf', `${preStr}scale=${w}:${h}:flags=area,palettegen=max_colors=${colors}:stats_mode=full`,
    paletteFile
  ]);

  // 2. 前处理 + 降采样 + 套调色板（dither=none 保证是纯色块而不是抖动噪点）
  await run([
    '-i', input, '-i', paletteFile,
    '-filter_complex',
    `[0:v]${preStr}scale=${w}:${h}:flags=area[x];[x][1:v]paletteuse=dither=none:alpha_threshold=128`,
    smallFile
  ]);

  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.copyFileSync(smallFile, outFile);

  // 3. nearest 整数放大，只给眼睛看
  let previewFile = null;
  if (scale > 1) {
    previewFile = outFile.replace(/\.png$/i, `@${scale}x.png`);
    await run([
      '-i', smallFile,
      '-vf', `scale=${w * scale}:${h * scale}:flags=neighbor`,
      previewFile
    ]);
  }

  return {
    source: path.resolve(input),
    sourceSize: `${src.width}x${src.height}`,
    pixelFile: path.resolve(outFile),
    pixelSize: `${w}x${h}`,
    cellSize: +(src.width / w).toFixed(2),
    colors,
    recipe: { denoise, gamma, contrast, saturation, brightness },
    previewFile: previewFile ? path.resolve(previewFile) : null,
    previewSize: previewFile ? `${w * scale}x${h * scale}` : null
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) throw new Error('缺少 -i 输入图');
  const tmpDir = path.resolve('assets/raw/.tmp-pixelize');
  fs.mkdirSync(tmpDir, { recursive: true });
  const base = path.dirname(args.input);
  const results = [];

  if (args.sweep) {
    const densities = [
      { width: 104, colors: 16, label: '粗 104/16色' },
      { width: 132, colors: 24, label: '中粗 132/24色' },
      { width: 176, colors: 32, label: '中 176/32色' },
      { width: 240, colors: 48, label: '细 240/48色' }
    ];
    for (const d of densities) {
      const r = await pixelize({
        input: args.input, width: d.width, colors: d.colors,
        outFile: path.join(base, `sweep-w${d.width}.png`),
        scale: Math.max(2, Math.round(1200 / d.width)), tmpDir,
        denoise: args.denoise ?? 0.5
      });
      results.push({ label: d.label, ...r });
      process.stdout.write(`  ${d.label}  → ${r.pixelSize}，每格 ${r.cellSize}px\n`);
    }
    process.stdout.write(`\n${JSON.stringify(results, null, 2)}\n`);
    return;
  }

  if (args.variants) {
    // 三种前处理强度，同一密度，看"洗得多干净"差多少
    const variants = [
      { tag: 'soft', label: '轻洗 denoise0.35', denoise: 0.35, gamma: 1.28, contrast: 1.12, saturation: 1.10, brightness: 0.010 },
      { tag: 'mid', label: '中洗 denoise0.60', denoise: 0.60, gamma: 1.42, contrast: 1.24, saturation: 1.20, brightness: 0.018 },
      { tag: 'hard', label: '重洗 denoise0.85', denoise: 0.85, gamma: 1.58, contrast: 1.36, saturation: 1.30, brightness: 0.026 }
    ];
    for (const v of variants) {
      const r = await pixelize({
        input: args.input, width: args.width || 132, colors: args.colors || 24,
        outFile: path.join(base, `variant-${v.tag}.png`),
        scale: Math.max(2, Math.round(1200 / (args.width || 132))), tmpDir,
        ...v
      });
      results.push({ label: v.label, ...r });
      process.stdout.write(`  ${v.label}  → ${r.pixelSize}\n`);
    }
    process.stdout.write(`\n${JSON.stringify(results, null, 2)}\n`);
    return;
  }

  const width = args.width || 132;
  const colors = args.colors || 24;
  const outFile = args.out || path.join(base, `pixel-w${width}.png`);
  const r = await pixelize({
    input: args.input, width, colors, outFile,
    scale: args.scale || Math.max(2, Math.round(1200 / width)), tmpDir,
    denoise: args.denoise ?? 0.6,
    gamma: args.gamma ?? 1.42,
    contrast: args.contrast ?? 1.24,
    saturation: args.saturation ?? 1.20,
    brightness: args.brightness ?? 0.018
  });
  process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(`失败: ${String(err?.message || err)}\n`);
  process.exitCode = 1;
});
