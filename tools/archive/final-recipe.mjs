// v3 最终配方：中值滤波（在中间分辨率上做，半径才够抹掉地板石板纹）+ 强明暗分离。
// 一次出三档，选一档。
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

// 核心思路：
//   原图 1664 宽，地板石板纹理的"颗粒"约 20-30px。
//   直接降到 120 宽（13.9x）时，一个输出像素吃掉 13.9x13.9 个源像素，
//   纹理块没有完全被平均掉，就变成没规律的色斑。
//   解决办法：先降到"中间分辨率"，让纹理颗粒变成 2-4px 的小块，
//   再用中值滤波（半径 3-5）把小块的绝大多数抹成一致，
//   最后才降到目标分辨率 + 量化。中值滤波比 bilateral 更适合"抹纹理"。
async function build({ input, outFile, W, midMul, medianR, colors, gamma, contrast, sat, bright, scale }) {
  const src = await probe(input);
  const H = Math.round(W * src.h / src.w);
  const MW = W * midMul, MH = H * midMul;
  const tmp = path.resolve('assets/raw/.tmp-pixelize');
  fs.mkdirSync(tmp, { recursive: true });
  const pal = path.join(tmp, 'p.png');
  const small = path.join(tmp, 's.png');

  const eq = `eq=brightness=${bright}:contrast=${contrast}:saturation=${sat}:gamma=${gamma}`;
  // 2 次中值：第一遍去细纹，第二遍把残留的孤立色块吃掉
  const chain = `scale=${MW}:${MH}:flags=area,median=${medianR},median=${medianR},${eq},scale=${W}:${H}:flags=area`;

  await run(['-i', input, '-vf', `${chain},palettegen=max_colors=${colors}:stats_mode=full`, pal]);
  await run(['-i', input, '-i', pal, '-filter_complex', `[0:v]${chain}[x];[x][1:v]paletteuse=dither=none`, small]);

  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.copyFileSync(small, outFile);
  const prev = outFile.replace(/\.png$/i, `@${scale}x.png`);
  await run(['-i', small, '-vf', `scale=${W*scale}:${H*scale}:flags=neighbor`, prev]);
  return { pixelFile: path.resolve(outFile), previewFile: path.resolve(prev), pixelSize: `${W}x${H}` };
}

const input = 'assets/raw/room-topdown-01.png';
const base = path.dirname(input);

const configs = [
  // 目标宽 120：一张副桌约 13px 宽，接近元气骑士的粗颗粒
  { tag: 'A-w120', W: 120, midMul: 3, medianR: 3, colors: 18, gamma: 1.50, contrast: 1.32, sat: 1.26, bright: 0.028 },
  // 目标宽 140：细节稍多，副桌约 15px
  { tag: 'B-w140', W: 140, midMul: 3, medianR: 3, colors: 20, gamma: 1.48, contrast: 1.30, sat: 1.24, bright: 0.026 },
  // 目标宽 160：保守一格，主桌键盘鼠标还能分辨
  { tag: 'C-w160', W: 160, midMul: 2, medianR: 5, colors: 24, gamma: 1.46, contrast: 1.28, sat: 1.22, bright: 0.024 }
];

const out = [];
for (const c of configs) {
  const scale = Math.max(2, Math.round(1200 / c.W));
  const r = await build({ input, outFile: path.join(base, `v3-${c.tag}.png`), scale, ...c });
  out.push({ tag: c.tag, ...r });
  process.stdout.write(`  ${c.tag}  → ${r.pixelSize}  放大${scale}x\n`);
}
process.stdout.write(`\n${JSON.stringify(out, null, 2)}\n`);
