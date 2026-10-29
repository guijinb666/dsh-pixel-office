import { readPNG } from "../tools/png.mjs";
const img = readPNG("packages/dsh-pixel-office/assets/scene/office-dark-320.png");
const { w, h, data } = img;
function at(x, y) { const i = (y * w + x) * 4; return [data[i], data[i+1], data[i+2], data[i+3]]; }
// 找窗户：底图里窗户是深蓝夜色玻璃（蓝通道明显高于红/绿，且整体偏暗）
const blue = [];
for (let y = 0; y < 160; y += 1) {
  for (let x = 0; x < w; x += 1) {
    const [r, g, b] = at(x, y);
    if (b > r + 25 && b > g + 10 && b > 40 && b < 150) blue.push([x, y]);
  }
}
if (blue.length) {
  const xs = blue.map(p => p[0]); const ys = blue.map(p => p[1]);
  console.log("窗蓝色像素数=" + blue.length + " bbox x=" + Math.min(...xs) + ".." + Math.max(...xs) + " y=" + Math.min(...ys) + ".." + Math.max(...ys));
}
// 找绿植：绿色明显（g 高于 r 与 b）
const green = [];
for (let y = 0; y < h; y += 1) {
  for (let x = 0; x < w; x += 1) {
    const [r, g, b] = at(x, y);
    if (g > r + 18 && g > b + 8 && g > 50) green.push([x, y]);
  }
}
console.log("绿像素数=" + green.length);
// 按列聚合，找出几个绿植簇的 x 中心
const cols = {};
for (const [x] of green) cols[Math.floor(x / 20)] = (cols[Math.floor(x / 20)] || 0) + 1;
console.log("绿植列分布(每20px)=" + JSON.stringify(cols));
const rows = {};
for (const [, y] of green) rows[Math.floor(y / 20)] = (rows[Math.floor(y / 20)] || 0) + 1;
console.log("绿植行分布(每20px)=" + JSON.stringify(rows));