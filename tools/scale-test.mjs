// 分辨率档位试验：把 128 尺寸的动作帧降到不同逻辑分辨率，再整数放大，
// 用来看「降到多少还能读出角色特征、又能拿到够粗的像素颗粒」。
//
// 背景：AI 出的 sprite 是 664px 一格，本身远不是像素画网格。
// 必须重采样到低分辨率才能得到《元气骑士》那种颗粒。
// 但降太狠会把五官糊掉，所以要用肉眼过一遍。
//
// 用法：
//   node tools/scale-test.mjs -i assets/char/main/type/type-a.png -o assets/char/main/_scale-test

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const FFMPEG = process.env.FFMPEG_PATH
  || 'C:\\Users\\30612\\.dsh\\tools\\ffmpeg\\bin\\ffmpeg.exe';

function parseArgs(argv) {
  const o = { widths: [96, 80, 64, 48, 36], upTo: 256 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-i' || a === '--in') o.input = argv[++i];
    else if (a === '-o' || a === '--out') o.outDir = argv[++i];
    else if (a === '--widths') o.widths = argv[++i].split(',').map(Number);
    else if (a === '--up') o.upTo = Number(argv[++i]);
  }
  return o;
}

function ff(args) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024
  });
  if (r.status !== 0) throw new Error(r.stderr || `ffmpeg exit ${r.status}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input || !args.outDir) throw new Error('需要 -i 与 -o');
  fs.mkdirSync(args.outDir, { recursive: true });

  const made = [];
  for (const w of args.widths) {
    const scale = Math.max(1, Math.floor(args.upTo / w));
    const out = path.join(args.outDir, `s${w}.png`);
    // area 降采样得到真实低分辨率（这一步产生像素颗粒），
    // neighbor 整数放大只是为了肉眼看，不改变逻辑分辨率。
    ff([
      '-i', args.input,
      '-vf', `scale=${w}:-1:flags=area,scale=iw*${scale}:ih*${scale}:flags=neighbor`,
      out
    ]);
    made.push({ width: w, scale, out });
  }
  process.stdout.write(`${JSON.stringify({ ok: true, made }, null, 2)}\n`);
}

try {
  main();
} catch (err) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: String(err?.message || err) })}\n`);
  process.exitCode = 1;
}
