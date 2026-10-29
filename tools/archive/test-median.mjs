// 二级降采样 + 中值滤波，专门对付"源图本身带细纹理"的情况。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';

const execFileAsync = promisify(execFile);
const FFMPEG = 'C:\\Users\\30612\\.dsh\\tools\\ffmpeg\\bin\\ffmpeg.exe';
const FFPROBE = 'C:\\Users\\30612\\.dsh\\tools\\ffmpeg\\bin\\ffprobe.exe';

async function probe(file) {
  const { stdout } = await execFileAsync(FFPROBE, ['-v','error','-select_streams','v:0','-show_entries','stream=width,height','-of','csv=p=0', file], { windowsHide: true });
  const [w,h] = stdout.trim().split(',').map(Number);
  return { w, h };
}
async function run(args) {
  await execFileAsync(FFMPEG, ['-hide_banner','-loglevel','error','-y',...args], { windowsHide: true, maxBuffer: 8*1024*1024 });
}

// 配方：原图 → 中间分辨率(mid) → 中值滤波(merc) → 目标分辨率 → 调色板
async function recipe({ input, outFile, W, midMul, medianR, colors, scale, gamma, contrast, sat, bright }) {
  const src = await probe(input);
  const H = Math.round(W * src.h / src.w);
  const MW = W * midMul, MH = H * midMul;
  const tmp = path.resolve('assets/raw/.tmp-pixelize');
  fs.mkdirSync(tmp, { recursive: true });
  const pal = path.join(tmp, 'p.png');
  const small = path.join(tmp, 's.png');

  const eq = `eq=brightness=${bright}:contrast=${contrast}:saturation=${sat}:gamma=${gamma}`;
  const chain = `scale=${MW}:${MH}:flags=area,median=${medianR},${eq},scale=${W}:${H}:flags=area`;

  await run(['-i', input, '-vf', `${chain},palettegen=max_colors=${colors}:stats_mode=full`, pal]);
  await run(['-i', input, '-i', pal, '-filter_complex', `[0:v]${chain}[x];[x][1:v]paletteuse=dither=none`, small]);

  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.copyFileSync(small, outFile);
  const prev = outFile.replace(/\.png$/i, `@${scale}x.png`);
  await run(['-i', small, '-vf', `scale=${W*scale}:${H*scale}:flags=neighbor`, prev]);
  return { outFile: path.resolve(outFile), prev: path.resolve(prev), size: `${W}x${H}` };
}

const input = 'assets/raw/room-topdown-01.png';
const base = path.dirname(input);
const W = Number(process.argv[2] || 176);
const scale = Math.max(2, Math.round(1200 / W));

const recipes = [
  { tag: 'm2-med3', midMul: 2, medianR: 3, colors: 24, gamma: 1.45, contrast: 1.30, sat: 1.22, bright: 0.02 },
  { tag: 'm3-med3', midMul: 3, medianR: 3, colors: 24, gamma: 1.45, contrast: 1.30, sat: 1.22, bright: 0.02 },
  { tag: 'm2-med5', midMul: 2, medianR: 5, colors: 20, gamma: 1.50, contrast: 1.34, sat: 1.26, bright: 0.025 },
  { tag: 'm3-med5', midMul: 3, medianR: 5, colors: 20, gamma: 1.50, contrast: 1.34, sat: 1.26, bright: 0.025 }
];

const out = [];
for (const r of recipes) {
  const res = await recipe({ input, outFile: path.join(base, `med-${r.tag}.png`), W, scale, ...r });
  out.push({ tag: r.tag, ...res });
  process.stdout.write(`  ${r.tag} → ${res.size}\n`);
}
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
