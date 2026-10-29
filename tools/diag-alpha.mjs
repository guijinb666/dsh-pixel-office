// 逐阶段检查 alpha 是否还在，定位流水线里哪一步把透明通道搞丢了。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const FFMPEG = 'C:\\Users\\30612\\.dsh\\tools\\ffmpeg\\bin\\ffmpeg.exe';
const FFPROBE = 'C:\\Users\\30612\\.dsh\\tools\\ffmpeg\\bin\\ffprobe.exe';
const IN = process.argv[2];
const TMP = path.resolve('assets/char/main/_scale-test/.diag');
fs.mkdirSync(TMP, { recursive: true });

function ff(args) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
}

function probe(file) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,pix_fmt', '-of', 'csv=p=0', file],
    { encoding: 'utf8' });
  return String(r.stdout).trim();
}

// 统计 alpha 直方图：多少像素全透明、多少全不透明、多少半透明
function alphaStats(file, w, h) {
  const raw = path.join(TMP, 'a.raw');
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', file,
    '-vf', 'alphaextract', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', raw],
  { encoding: 'utf8' });
  if (r.status !== 0) return { total: w * h, noAlpha: true };
  ff(['-i', file, '-vf', 'alphaextract', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', raw]);
  const b = fs.readFileSync(raw);
  fs.rmSync(raw, { force: true });
  let zero = 0; let full = 0; let mid = 0;
  for (let i = 0; i < w * h && i < b.length; i += 1) {
    if (b[i] < 8) zero += 1;
    else if (b[i] > 247) full += 1;
    else mid += 1;
  }
  const total = Math.min(w * h, b.length);
  return { total, zeroPct: +(zero / total * 100).toFixed(1), fullPct: +(full / total * 100).toFixed(1), midPct: +(mid / total * 100).toFixed(1) };
}

function step(name, vf, out) {
  ff(['-i', IN, '-vf', vf, out]);
  const p = probe(out);
  const [w, h] = p.split(',').map((v, i) => (i < 2 ? Number(v) : v));
  const st = alphaStats(out, w, h);
  console.log(`${name.padEnd(26)} ${p.padEnd(16)} alpha{zero:${String(st.zeroPct).padStart(5)}% full:${String(st.fullPct).padStart(5)}% mid:${String(st.midPct).padStart(5)}%}`);
}

const KEY = '0xC900C5';
step('0 原图', 'format=rgba', path.join(TMP, '0.png'));
step('1 colorkey', `colorkey=${KEY}:0.22:0.10,format=rgba`, path.join(TMP, '1.png'));
step('2 +median=2', `colorkey=${KEY}:0.22:0.10,format=rgba,median=2`, path.join(TMP, '2.png'));
step('3 +scale56', `colorkey=${KEY}:0.22:0.10,format=rgba,median=2,scale=56:-1:flags=area`, path.join(TMP, '3.png'));
step('4 +quant-alphaThr', `colorkey=${KEY}:0.22:0.10,format=rgba,median=2,scale=56:-1:flags=area,split[a][b];[a]palettegen=max_colors=24:stats_mode=full[p];[b][p]paletteuse=dither=none:alpha_threshold=128`, path.join(TMP, '4.png'));
step('5 +quant-reserve', `colorkey=${KEY}:0.22:0.10,format=rgba,median=2,scale=56:-1:flags=area,split[a][b];[a]palettegen=max_colors=24:stats_mode=full:reserve_transparent=1[p];[b][p]paletteuse=dither=none:alpha_threshold=128:reserve_transparent=1`, path.join(TMP, '5.png'));
step('6 不量化', `colorkey=${KEY}:0.22:0.10,format=rgba,median=2,scale=56:-1:flags=area`, path.join(TMP, '6.png'));
