import { readPNG, writePNG } from "../tools/png.mjs";
import { mkdirSync } from "node:fs";
mkdirSync("tmp/crop", { recursive: true });
const { w, h, data } = readPNG("packages/dsh-pixel-office/assets/scene/office-dark-320.png");
function crop(name, x0, y0, cw, ch, scale) {
  const out = Buffer.alloc(cw * scale * ch * scale * 4);
  for (let y = 0; y < ch * scale; y += 1) {
    for (let x = 0; x < cw * scale; x += 1) {
      const sx = x0 + Math.floor(x / scale);
      const sy = y0 + Math.floor(y / scale);
      const si = (sy * w + sx) * 4;
      const di = (y * cw * scale + x) * 4;
      out[di] = data[si]; out[di + 1] = data[si + 1]; out[di + 2] = data[si + 2]; out[di + 3] = 255;
    }
  }
  writePNG("tmp/crop/" + name, cw * scale, ch * scale, out);
  console.log("wrote tmp/crop/" + name);
}
crop("left-top.png", 0, 0, 130, 140, 5);
crop("right-btm.png", 250, 330, 70, 101, 5);
crop("board.png", 140, 25, 140, 60, 5);