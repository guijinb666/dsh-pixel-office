import { readPNG } from "../tools/png.mjs";
const { w, h, data } = readPNG("packages/dsh-pixel-office/assets/scene/office-dark-320.png");
function at(x, y) { const i = (y * w + x) * 4; return [data[i], data[i+1], data[i+2]]; }
// 输出左上角 0..120 x 0..140 的字符画（按亮度分档），用来肉眼定位窗户
const chars = " .:-=+*#%@";
for (let y = 0; y < 140; y += 2) {
  let row = String(y).padStart(3) + " ";
  for (let x = 0; x < 130; x += 1) {
    const [r, g, b] = at(x, y);
    const lum = (r * 0.3 + g * 0.59 + b * 0.11) / 255;
    row += chars[Math.min(9, Math.floor(lum * 10))];
  }
  console.log(row);
}