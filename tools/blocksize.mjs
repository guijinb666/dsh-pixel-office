// 测量一张像素画的「真实像素块大小」。
//
// 为什么必须测：AI 出的像素图是"伪像素"——整图可能被放大过 N 倍，也可能
// 每个色块本来就只有 1px。角色和场景如果块大小不一致，放在一起会一眼看出
// 是两个世界的东西（一个颗粒粗、一个颗粒细）。
//
// 做法：沿每一行扫描，统计「连续同色像素的游程长度」直方图。真像素画的
// 游程长度会集中在块的整数倍上（1,2,3...），峰值位置即块大小。
// 同时对水平边和垂直边做同样的统计，取两者众数。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const FFMPEG = 'C:\\Users\\30612\\.dsh\\tools\\ffmpeg\\bin\\ffmpeg.exe';
const FFPROBE = 'C:\\Users\\30612\\.dsh\\tools\\ffmpeg\\bin\\ffprobe.exe';

function probe(file) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,pix_fmt', '-of', 'csv=p=0', file],
    { encoding: 'utf8' });
  const [w, h] = String(r.stdout).trim().split(',').map(Number);
  return { w, h };
}

function rgba(file) {
  const { w, h } = probe(file);
  const raw = path.join(path.dirname(file), '.blocksize.raw');
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-i', file, '-vf', 'format=rgba', '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', raw], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  const buf = fs.readFileSync(raw);
  fs.rmSync(raw, { force: true });
  return { w, h, buf };
}

// 统计游程长度分布。step 决定是横扫还是竖扫。
function runs(w, h, buf, horizontal) {
  const hist = new Map();
  const outer = horizontal ? h : w;
  const inner = horizontal ? w : h;
  for (let o = 0; o < outer; o += 1) {
    let run = 0;
    let prev = null;
    for (let i = 0; i < inner; i += 1) {
      const x = horizontal ? i : o;
      const y = horizontal ? o : i;
      const p = (y * w + x) * 4;
      // 量化到 8 级，避免亚像素渐变把游程切碎
      const key = `${buf[p] >> 5},${buf[p + 1] >> 5},${buf[p + 2] >> 5},${buf[p + 3] >> 7}`;
      if (key === prev) {
        run += 1;
      } else {
        if (prev !== null && run > 0) hist.set(run, (hist.get(run) || 0) + 1);
        prev = key;
        run = 1;
      }
    }
    if (prev !== null) hist.set(run, (hist.get(run) || 0) + 1);
  }
  return hist;
}

function report(file) {
  const { w, h, buf } = rgba(file);
  const hr = runs(w, h, buf, true);
  const vr = runs(w, h, buf, false);
  const merge = new Map();
  for (const [k, v] of hr) merge.set(k, (merge.get(k) || 0) + v);
  for (const [k, v] of vr) merge.set(k, (merge.get(k) || 0) + v);

  const total = [...merge.values()].reduce((a, b) => a + b, 0);
  const sorted = [...merge.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 8).map(([len, cnt]) => ({
    runLen: len, share: +(cnt / total * 100).toFixed(1)
  }));

  // 块大小判据：游程长度的加权中位数偏低端，真像素画的众数就在块大小上
  const mode = sorted[0][0];
  const mean = [...merge.entries()].reduce((a, [len, cnt]) => a + len * cnt, 0) / total;

  console.log(path.basename(file).padEnd(26),
    `${w}x${h}`.padEnd(11),
    `众数游程=${String(mode).padStart(3)}px`,
    ` 均值=${mean.toFixed(2)}px`,
    ` 前8:${top.map((t) => `${t.runLen}px(${t.share}%)`).join(' ')}`);
  return { file, w, h, mode, mean, top };
}

const files = process.argv.slice(2);
for (const f of files) {
  try {
    report(f);
  } catch (e) {
    console.log(`${path.basename(f).padEnd(26)} 失败: ${e.message.split('\n')[0]}`);
  }
}
