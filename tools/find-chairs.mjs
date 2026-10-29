#!/usr/bin/env node
/**
 * find-chairs.mjs - locate chairs under each desk by looking for the dark
 * blob in the strip immediately below each desk band.
 *
 * Chairs in this scene are dark and only slightly bluer than the floor, so a
 * whole-image color test drowns in floor pixels. Instead we scan a narrow
 * vertical strip under each desk and look for the darkest contiguous run,
 * reported per desk column. That is exactly what we need: the chair's top edge
 * y, which becomes each seat's anchor.
 *
 * Usage:
 *   node tools/find-chairs.mjs -i <scene> --deskCols "52:92,114:154,175:215,235:275" \
 *        --from 227 --to 253 [--bias -6]
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const FFMPEG = 'C:\\Users\\30612\\.dsh\\tools\\ffmpeg\\bin\\ffmpeg.exe';
const FFPROBE = 'C:\\Users\\30612\\.dsh\\tools\\ffmpeg\\bin\\ffprobe.exe';
const ROOT = path.resolve(import.meta.dirname, '..');

function die(m) {
  console.error(m);
  process.exit(1);
}

function parseArgs(argv) {
  const o = { bias: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-i') o.input = argv[++i];
    else if (a === '--deskCols') o.deskCols = argv[++i];
    else if (a === '--from') o.from = Number(argv[++i]);
    else if (a === '--to') o.to = Number(argv[++i]);
    else if (a === '--bias') o.bias = Number(argv[++i]);
    else die('unknown arg ' + a);
  }
  return o;
}

const args = parseArgs(process.argv.slice(2));
if (!args.input || !args.deskCols || args.from == null || args.to == null) {
  die('need -i, --deskCols, --from, --to');
}

const inPath = path.resolve(ROOT, args.input);
if (!fs.existsSync(inPath)) die('missing: ' + inPath);

const probe = spawnSync(
  FFPROBE,
  ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', inPath],
  { cwd: ROOT, encoding: 'utf8' }
);
const d = String(probe.stdout || '').trim().split(',');
const W = Number(d[0]);
const H = Number(d[1]);
if (!W || !H) die('bad dims');

const raw = spawnSync(
  FFMPEG,
  ['-hide_banner', '-loglevel', 'error', '-i', inPath, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
  { cwd: ROOT, encoding: 'buffer', maxBuffer: 1 << 28 }
);
if (raw.status !== 0) die('decode failed');
const buf = raw.stdout;
if (buf.length < W * H * 3) die('short buffer');

const cols = args.deskCols.split(',').map((s) => s.split(':').map(Number));
const y0 = Math.max(0, args.from);
const y1 = Math.min(H - 1, args.to);

// Luma per pixel; we want the darkest band (chair back) inside the strip.
const luma = (i) => 0.299 * buf[i] + 0.587 * buf[i + 1] + 0.114 * buf[i + 2];

const results = [];

cols.forEach(([cx0, cx1], idx) => {
  // Use the middle 60% of the desk width so desk legs don't pollute the sample.
  const inset = Math.round((cx1 - cx0) * 0.2);
  const sx0 = cx0 + inset;
  const sx1 = cx1 - inset;

  const rowLuma = [];
  for (let y = y0; y <= y1; y++) {
    let sum = 0;
    for (let x = sx0; x <= sx1; x++) {
      sum += luma((y * W + x) * 3);
    }
    rowLuma.push({ y, avg: sum / (sx1 - sx0 + 1) });
  }

  // Floor reference: the floor is the darkest thing outside the desk area, so
  // pick the minimum luma across the strip and take everything within +8 of it.
  let min = Infinity;
  for (const r of rowLuma) if (r.avg < min) min = r.avg;
  const cut = min + 8 + args.bias;

  const hit = rowLuma.map((r) => r.avg <= cut);
  const bands = [];
  let start = -1;
  for (let i = 0; i <= hit.length; i++) {
    const on = i < hit.length && hit[i];
    if (on && start < 0) start = i;
    else if (!on && start >= 0) {
      bands.push({ from: rowLuma[start].y, to: rowLuma[i - 1].y, len: i - start });
      start = -1;
    }
  }

  const best = bands.slice().sort((a, b) => b.len - a.len)[0] || null;

  results.push({
    seat: idx,
    deskX: [cx0, cx1],
    deskMidX: Math.round((cx0 + cx1) / 2),
    floorMinLuma: +min.toFixed(1),
    cut: +cut.toFixed(1),
    chairBands: bands,
    chair: best,
    // The anchor the renderer uses: horizontal center of the desk, y = chair top
    seatAnchor: best ? { x: Math.round((cx0 + cx1) / 2), y: best.from } : null,
  });
});

console.log(JSON.stringify({ ok: true, strip: { from: y0, to: y1 }, results }, null, 2));
