// 精确量测底图里每块"电脑屏深色面"的真实包围盒。
// 之前 seats.json 里的 screen 矩形是凭肉眼/连通块粗估的，贴亮屏贴图时会左右越界，所以这里重新量。
// 判据：屏幕是画面里最暗的蓝黑块（RGB 三通道都很低，且偏蓝），并与桌子木色形成强反差。
// 用法: node tools/measure-screens2.mjs -i <scene png> [-o out.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { readPNG } from './png.mjs';

function arg(name, def) {
  const i = process.argv.indexOf('-' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const input = arg('i');
const out = arg('o', '');
if (!input) {
  console.error('用法: node tools/measure-screens2.mjs -i <scene.png> [-o out.json]');
  process.exit(1);
}

const img = readPNG(input);
const { w, h, data } = img;
const at = (x, y) => {
  const o = (y * w + x) * 4;
  return [data[o], data[o + 1], data[o + 2]];
};

// 屏幕像素判定：亮度低 + 蓝通道 >= 红通道（屏幕偏蓝紫），且不是纯黑描边(全 <12)
function isScreen(x, y) {
  const r = at(x, y);
  const [R, G, B] = r;
  const lum = 0.299 * R + 0.587 * G + 0.114 * B;
  if (lum > 46) return false;
  if (B < R) return false;
  if (R < 6 && G < 6 && B < 6) return false;
  return true;
}

// 简单并查集求 4-邻接连通块
const seen = new Uint8Array(w * h);
const blocks = [];
const stack = [];
for (let y = 0; y < h; y += 1) {
  for (let x = 0; x < w; x += 1) {
    const id = y * w + x;
    if (seen[id]) continue;
    seen[id] = 1;
    if (!isScreen(x, y)) continue;
    let minX = x; let maxX = x; let minY = y; let maxY = y; let n = 0;
    stack.length = 0;
    stack.push(id);
    while (stack.length) {
      const cur = stack.pop();
      const cx = cur % w;
      const cy = (cur - cx) / w;
      n += 1;
      if (cx < minX) minX = cx;
      if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy;
      if (cy > maxY) maxY = cy;
      const nb = [cur - 1, cur + 1, cur - w, cur + w];
      for (const nid of nb) {
        if (nid < 0 || nid >= w * h) continue;
        if (seen[nid]) continue;
        const nx = nid % w;
        const ny = (nid - nx) / w;
        if (Math.abs(nx - cx) + Math.abs(ny - cy) !== 1) continue;
        seen[nid] = 1;
        if (isScreen(nx, ny)) stack.push(nid);
      }
    }
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    if (n >= 40 && bw >= 6 && bh >= 6 && bw <= 120 && bh <= 60) {
      blocks.push({ x: minX, y: minY, w: bw, h: bh, px: n, fill: +(n / (bw * bh)).toFixed(3) });
    }
  }
}

blocks.sort((a, b) => (a.y - b.y) || (a.x - b.x));

// 主工位双屏：最靠上且最宽的两块（左右各一）
const wide = blocks.filter((b) => b.w >= 24);
const report = { scene: { w, h, file: input }, count: blocks.length, all: blocks, wide };
if (out) writeFileSync(out, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ count: blocks.length, blocks }, null, 2));
