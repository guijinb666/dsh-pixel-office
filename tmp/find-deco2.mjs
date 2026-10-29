import { readPNG } from "../tools/png.mjs";
const { w, h, data } = readPNG("packages/dsh-pixel-office/assets/scene/office-dark-320.png");
function at(x, y) { const i = (y * w + x) * 4; return [data[i], data[i+1], data[i+2]]; }
// 绿植：g 明显高于 r/b。按连通块粗聚类（贪心：距离 < 24 归一块）
const green = [];
for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
  const [r, g, b] = at(x, y);
  if (g > r + 18 && g > b + 8 && g > 50) green.push([x, y]);
}
const clusters = [];
for (const p of green) {
  let hit = null;
  for (const c of clusters) if (Math.abs(c.cx / c.n - p[0]) < 26 && Math.abs(c.cy / c.n - p[1]) < 40) { hit = c; break; }
  if (!hit) { hit = { n: 0, cx: 0, cy: 0, minX: 999, maxX: -1, minY: 999, maxY: -1 }; clusters.push(hit); }
  hit.n += 1; hit.cx += p[0]; hit.cy += p[1];
  hit.minX = Math.min(hit.minX, p[0]); hit.maxX = Math.max(hit.maxX, p[0]);
  hit.minY = Math.min(hit.minY, p[1]); hit.maxY = Math.max(hit.maxY, p[1]);
}
clusters.filter(c => c.n > 80).forEach(c => {
  console.log("植物 n=" + c.n + " 中心=(" + Math.round(c.cx / c.n) + "," + Math.round(c.cy / c.n) + ") bbox x=" + c.minX + ".." + c.maxX + " y=" + c.minY + ".." + c.maxY);
});
// 窗户：找最亮的深蓝/夜色块 —— 采样几块候选区域的平均色
function avg(x0, y0, x1, y1) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) { const c = at(x, y); r += c[0]; g += c[1]; b += c[2]; n += 1; }
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}
console.log("窗候选 A(20,24)-(78,72)=" + JSON.stringify(avg(20, 24, 78, 72)));
console.log("窗候选 B(24,28)-(70,66)=" + JSON.stringify(avg(24, 28, 70, 66)));
console.log("墙基准 (150,60)-(200,90)=" + JSON.stringify(avg(150, 60, 200, 90)));