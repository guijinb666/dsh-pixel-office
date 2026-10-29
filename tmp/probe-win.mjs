import { readPNG } from "../tools/png.mjs";
const img = readPNG("packages/dsh-pixel-office/assets/scene/office-dark-320.png");
const { w, h, data } = img;
function at(x, y) { const i = (y * w + x) * 4; return [data[i], data[i+1], data[i+2], data[i+3]]; }
console.log("size=" + w + "x" + h);
// 采样左上方区域，找窗
for (let y = 20; y <= 100; y += 10) {
  let row = "y=" + String(y).padStart(3) + " ";
  for (let x = 20; x <= 110; x += 10) {
    const [r, g, b] = at(x, y);
    row += r.toString(16).padStart(2,"0") + g.toString(16).padStart(2,"0") + b.toString(16).padStart(2,"0") + " ";
  }
  console.log(row);
}