// 最小复现：验证 palettegen / paletteuse 两步落盘能否保住 alpha。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const FFMPEG = 'C:\\Users\\30612\\.dsh\\tools\\ffmpeg\\bin\\ffmpeg.exe';
const FFPROBE = 'C:\\Users\\30612\\.dsh\\tools\\ffmpeg\\bin\\ffprobe.exe';
const IN = process.argv[2];
const TMP = path.resolve('assets/char/main/_scale-test/.diag');
fs.mkdirSync(TMP, { recursive: true });

function run(args) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, err: (r.stderr || '').trim().split('\n')[0] };
}

function info(file) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,pix_fmt', '-of', 'csv=p=0', file],
    { encoding: 'utf8' });
  return String(r.stdout).trim();
}

function alphaPct(file, w, h) {
  const raw = path.join(TMP, 'z.raw');
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', file,
    '-vf', 'alphaextract', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', raw],
  { encoding: 'utf8' });
  if (r.status !== 0) return 'NO-ALPHA-PLANE';
  const b = fs.readFileSync(raw);
  let zero = 0;
  const n = Math.min(w * h, b.length);
  for (let i = 0; i < n; i += 1) if (b[i] < 8) zero += 1;
  fs.rmSync(raw, { force: true });
  return `${(zero / n * 100).toFixed(1)}% transparent`;
}

const KEY = '0xC900C5';
const base = `colorkey=${KEY}:0.22:0.10,format=rgba,median=2,scale=56:-1:flags=area`;
const step1 = path.join(TMP, 'k1.png');
console.log('A 降采样后:', info(step1), run(['-i', IN, '-vf', base, step1]).ok ? '' : 'FAIL');

// 方案1：palettegen 落盘（默认 reserve_transparent=1）→ paletteuse
const pal1 = path.join(TMP, 'pal1.png');
const r1 = run(['-i', step1, '-vf', 'palettegen=max_colors=24:stats_mode=full', pal1]);
const o1 = path.join(TMP, 'o1.png');
const r1b = run(['-i', step1, '-i', pal1, '-lavfi', 'paletteuse=dither=none:alpha_threshold=128', o1]);
console.log('方案1 palettegen默认   :', r1.ok && r1b.ok ? `${info(o1)}  ${alphaPct(o1, 56, 61)}` : `FAIL ${r1.err} ${r1b.err}`);

// 方案2：palettegen 显式 reserve_transparent=1
const pal2 = path.join(TMP, 'pal2.png');
const r2 = run(['-i', step1, '-vf', 'palettegen=max_colors=24:stats_mode=full:reserve_transparent=1', pal2]);
const o2 = path.join(TMP, 'o2.png');
const r2b = run(['-i', step1, '-i', pal2, '-lavfi', 'paletteuse=dither=none:alpha_threshold=128', o2]);
console.log('方案2 reserve=1        :', r2.ok && r2b.ok ? `${info(o2)}  ${alphaPct(o2, 56, 61)}` : `FAIL ${r2.err} ${r2b.err}`);

// 方案3：palettegen 带 stats_mode=single + reserve
const pal3 = path.join(TMP, 'pal3.png');
const r3 = run(['-i', step1, '-vf', 'palettegen=max_colors=24', pal3]);
const o3 = path.join(TMP, 'o3.png');
const r3b = run(['-i', step1, '-i', pal3, '-lavfi', 'paletteuse=dither=none', o3]);
console.log('方案3 全默认          :', r3.ok && r3b.ok ? `${info(o3)}  ${alphaPct(o3, 56, 61)}` : `FAIL ${r3.err} ${r3b.err}`);

// 方案4：不用 paletteuse，改用 split 内的 palettegen（确认是否链内才有 alpha）
const o4 = path.join(TMP, 'o4.png');
const r4 = run(['-i', IN, '-vf',
  `${base},split[a][b];[a]palettegen=max_colors=24:reserve_transparent=1[p];[b][p]paletteuse=dither=none`,
  o4]);
console.log('方案4 链内无alphaThr  :', r4.ok ? `${info(o4)}  ${alphaPct(o4, 56, 61)}` : `FAIL ${r4.err}`);

// 方案5：paletteuse 前显式 format=rgba，后面再强转
const o5 = path.join(TMP, 'o5.png');
const r5 = run(['-i', step1, '-i', pal2, '-lavfi',
  'paletteuse=dither=none:alpha_threshold=128,format=rgba', o5]);
console.log('方案5 use后format rgba:', r5.ok ? `${info(o5)}  ${alphaPct(o5, 56, 61)}` : `FAIL ${r5.err}`);
