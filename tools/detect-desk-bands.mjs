#!/usr/bin/env node
/**
 * detect-desks.mjs - find desk/chair bands in the scene by color projection.
 *
 * Wood desks are warm brown; chairs are dark desaturated blue-gray. Both stand
 * out against the purple wall/floor. We count matching pixels per row and per
 * column; contiguous runs above a threshold are the bands.
 *
 * Usage:
 *   node tools/detect-desks.mjs -i <scene> [--mode wood|chair] [--thresh 0.03]
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const FFMPEG = 'C:\\Users\\30612\\.dsh\\tools\\ffmpeg\\bin\\ffmpeg.exe';
const FFPROBE = 'C:\\Users\\30612\\.dsh\\tools\\ffmpeg\\bin\\ffprobe.exe';
// Derive project root from this script's own location (tools/..), so the
// non-ASCII workspace path never has to appear in source.
const ROOT = path.resolve(import.meta.dirname, '..');

function die(m) {
  console.error(m);
  process.exit(1);
}

function parseArgs(argv) {
  const o = { mode: 'wood', thresh: 0.03, rows: null, cols: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-i') o.input = argv[++i];
    else if (a === '--mode') o.mode = argv[++i];
    else if (a === '--thresh') o.thresh = Number(argv[++i]);
    else if (a === '--rows') {
      // restrict row scan to y0:y1 (inclusive), for isolating one desk row
      const p = argv[++i].split(':').map(Number);
      o.rows = [p[0], p[1]];
    } else if (a === '--cols') {
      const p = argv[++i].split(':').map(Number);
      o.cols = [p[0], p[1]];
    } else die('unknown arg ' + a);
  }
  return o;
}

const args = parseArgs(process.argv.slice(2));
if (!args.input) die('need -i <scene>');

const inPath = path.resolve(ROOT, args.input);
if (!fs.existsSync(inPath)) die('missing file: ' + inPath);

const probe = spawnSync(
  FFPROBE,
  ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', inPath],
  { cwd: ROOT, encoding: 'utf8' }
);
const dims = String(probe.stdout || '').trim().split(',');
const W = Number(dims[0]);
const H = Number(dims[1]);
if (!W || !H) die('bad dimensions, ffprobe said: ' + JSON.stringify(probe.stdout));

const raw = spawnSync(
  FFMPEG,
  ['-hide_banner', '-loglevel', 'error', '-i', inPath, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
  { cwd: ROOT, encoding: 'buffer', maxBuffer: 1 << 28 }
);
if (raw.status !== 0) die('decode failed');
const buf = raw.stdout;
if (buf.length < W * H * 4) die('short buffer ' + buf.length + ' vs ' + W * H * 4);

function isWood(r, g, b) {
  // warm brown: red clearly above blue, mid brightness, green between
  return r > 70 && r < 215 && r > b + 28 && g > b + 8 && g < r && r - g > 12;
}
function isChair(r, g, b) {
  // dark desaturated blue-gray
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  return mx < 100 && mx > 16 && mx - mn < 36 && b >= r - 8;
}

const test = args.mode === 'chair' ? isChair : isWood;

const rowCount = new Int32Array(H);
const colCount = new Int32Array(W);
let total = 0;

// Optional windows: --rows y0:y1 limits which rows contribute to the column
// projection, --cols x0:x1 limits which columns contribute to the row
// projection. This isolates one desk row from wall/window decorations.
const rowWin = args.rows || [0, H - 1];
const colWin = args.cols || [0, W - 1];
const colLo = Math.max(0, colWin[0]);
const colHi = Math.min(W - 1, colWin[1]);
const rowLo = Math.max(0, rowWin[0]);
const rowHi = Math.min(H - 1, rowWin[1]);

for (let y = rowLo; y <= rowHi; y++) {
  const rowOff = y * W * 4;
  for (let x = colLo; x <= colHi; x++) {
    const i = rowOff + x * 4;
    if (buf[i + 3] < 128) continue;
    if (test(buf[i], buf[i + 1], buf[i + 2])) {
      rowCount[y]++;
      colCount[x]++;
      total++;
    }
  }
}

// Normalize against the window that actually contributed, not the full image.
const rowDenom = Math.max(1, colHi - colLo + 1);
const colDenom = Math.max(1, rowHi - rowLo + 1);

const rowHit = new Array(H);
for (let y = 0; y < H; y++) rowHit[y] = rowCount[y] / rowDenom >= args.thresh;

const rowBands = [];
let start = -1;
for (let y = 0; y <= H; y++) {
  const on = y < H && rowHit[y];
  if (on && start < 0) start = y;
  else if (!on && start >= 0) {
    rowBands.push([start, y - 1, y - start]);
    start = -1;
  }
}

const colHit = new Array(W);
for (let x = 0; x < W; x++) colHit[x] = colCount[x] / colDenom >= args.thresh * 0.6;

const colBands = [];
start = -1;
for (let x = 0; x <= W; x++) {
  const on = x < W && colHit[x];
  if (on && start < 0) start = x;
  else if (!on && start >= 0) {
    colBands.push([start, x - 1, x - start]);
    start = -1;
  }
}

const fmt = (bands) =>
  bands
    .filter((b) => b[2] >= 3)
    .map((b) => ({ from: b[0], to: b[1], len: b[2], mid: Math.round((b[0] + b[1]) / 2) }));

console.log(
  JSON.stringify(
    {
      ok: true,
      file: path.relative(ROOT, inPath),
      size: { w: W, h: H },
      mode: args.mode,
      thresh: args.thresh,
      hits: total,
      hitRatio: Number((total / (W * H)).toFixed(4)),
      rowBands: fmt(rowBands),
      colBands: fmt(colBands),
    },
    null,
    2
  )
);
