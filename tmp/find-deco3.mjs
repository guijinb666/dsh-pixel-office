import { readPNG } from "../tools/png.mjs";
const { w, h, data } = readPNG("packages/dsh-pixel-office/assets/scene/office-dark-320.png");
function at(x, y) { const i = (y * w + x) * 4; return [data[i], data[i+1], data[i+2]]; }
// 白板：浅色（亮度 > 0.55）大块
const light = [];
for (let y = 0; y < 140; y += 1) for (let x = 0; x < w; x += 1) {
  const [r, g, b] = at(x, y);
  if (r > 140 && g > 130 && b > 120) light.push([x, y]);
}
const cl = [];
for (const p of light) {
  let hit = null;
  for (const c of cl) if (Math.abs(c.cx / c.n - p[0]) < 60 && Math.abs(c.cy / c.n - p[1]) < 30) { hit = c; break; }
  if (!hit) { hit = { n: 0, cx: 0, cy: 0, minX: 999, maxX: -1, minY: 999, maxY: -1 }; cl.push(hit); }
  hit.n += 1; hit.cx += p[0]; hit.cy += p[1];
  hit.minX = Math.min(hit.minX, p[0]); hit.maxX = Math.max(hit.maxX, p[0]);
  hit.minY = Math.min(hit.minY, p[1]); hit.maxY = Math.max(hit.maxY, p[1]);
}
cl.filter(c => c.n > 400).forEach(c => console.log("浅色块 n=" + c.n + " bbox x=" + c.minX + ".." + c.maxX + " y=" + c.minY + ".." + c.maxY));
// 窗户：深蓝夜空。找 b>r+15 且 y<140 的像素
const night = [];
for (let y = 0; y < 140; y += 1) for (let x = 0; x < w; x += 1) {
  const [r, g, b] = at(x, y);
  if (b > r + 12 && b > g + 6 && b > 45) night.push([x, y]);
}
const nl = [];
for (const p of night) {
  let hit = null;
  for (const c of nl) if (Math.abs(c.cx / c.n - p[0]) < 50 && Math.abs(c.cy / c.n - p[1]) < 40) { hit = c; break; }
  if (!hit) { hit = { n: 0, cx: 0, cy: 0, minX: 999, maxX: -1, minY: 999, maxY: -1 }; nl.push(hit); }
  hit.n += 1; hit.cx += p[0]; hit.cy += p[1];
  hit.minX = Math.min(hit.minX, p[0]); hit.maxX = Math.max(hit.maxX, p[0]);
  hit.minY = Math.min(hit.minY, p[1]); hit.maxY = Math.max(hit.maxY, p[1]);
}
nl.filter(c => c.n > 200).forEach(c => console.log("夜空块 n=" + c.n + " bbox x=" + c.minX + ".." + c.maxX + " y=" + c.minY + ".." + c.maxY));