// 联系图（contact sheet）：把多张图按网格拼成一张，用来一次看完所有变体。
//
// 为什么要有这个脚本：
// PowerShell 传参给 ffmpeg 时会把 filter 里的 `[0:v]` 这类方括号标签吃掉，
// 导致 `Bad (empty?) label found`；本机这版 ffmpeg 又没有
// `-filter_complex_script` 选项。用 Node 的 spawn 传数组参数最干净。
//
// 用法：
//   node tools/contact-sheet.mjs -o out.png -c 4 -s 300 a.png b.png c.png ...
// 参数：
//   -o/--out    输出路径（必填）
//   -c/--cols   列数，默认 4
//   -s/--size   每格边长，默认 300
//   --bg        底色，默认 0x101018
//   --labels    可选，逗号分隔的标签（当前不绘制文字，仅作占位）

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const FFMPEG = process.env.FFMPEG_PATH
  || 'C:\\Users\\30612\\.dsh\\tools\\ffmpeg\\bin\\ffmpeg.exe';

function parseArgs(argv) {
  const o = { cols: 4, size: 300, bg: '0x101018' };
  const files = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-o' || a === '--out') o.out = argv[++i];
    else if (a === '-c' || a === '--cols') o.cols = Number(argv[++i]);
    else if (a === '-s' || a === '--size') o.size = Number(argv[++i]);
    else if (a === '--bg') o.bg = argv[++i];
    else if (a === '--labels') o.labels = argv[++i].split(',');
    else files.push(a);
  }
  o.files = files;
  return o;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.out) throw new Error('缺少 -o 输出路径');
  if (args.files.length === 0) throw new Error('缺少输入图片');

  const missing = args.files.filter((f) => !fs.existsSync(f));
  if (missing.length) throw new Error(`输入不存在: ${missing.join(', ')}`);

  const n = args.files.length;
  const cols = Math.min(args.cols, n);
  const rows = Math.ceil(n / cols);
  const S = args.size;

  const graph = [];
  for (let i = 0; i < n; i += 1) {
    graph.push(`[${i}:v]scale=${S}:${S}:force_original_aspect_ratio=decrease:flags=area,pad=${S}:${S}:(ow-iw)/2:(oh-ih)/2:color=${args.bg}[v${i}]`);
  }
  // 尾部不足一格时用纯色补位，保证 xstack 网格对齐
  const padCount = cols * rows - n;
  for (let i = 0; i < padCount; i += 1) {
    graph.push(`color=c=${args.bg}:s=${S}x${S}:d=1[v${n + i}]`);
  }
  const total = cols * rows;
  const layout = [];
  for (let i = 0; i < total; i += 1) {
    layout.push(`${(i % cols) * S}_${Math.floor(i / cols) * S}`);
  }
  const inputs = Array.from({ length: total }, (_, i) => `[v${i}]`).join('');
  graph.push(`${inputs}xstack=inputs=${total}:layout=${layout.join('|')}:fill=${args.bg}[o]`);

  const spawnArgs = ['-hide_banner', '-loglevel', 'error'];
  for (const f of args.files) spawnArgs.push('-i', f);
  spawnArgs.push('-filter_complex', graph.join(';'), '-map', '[o]', '-frames:v', '1', '-y', args.out);

  const r = spawnSync(FFMPEG, spawnArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    throw new Error(`ffmpeg 失败: ${r.stderr || r.stdout}`);
  }
  const out = {
    ok: true,
    file: path.resolve(args.out),
    grid: `${cols}x${rows}`,
    cell: S,
    inputs: n,
    bytes: fs.statSync(args.out).size
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

try {
  main();
} catch (err) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: String(err?.message || err) })}\n`);
  process.exitCode = 1;
}
