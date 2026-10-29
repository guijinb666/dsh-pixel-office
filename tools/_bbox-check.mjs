// 检查品红背景留白 + 尺寸/色彩类型，用于背面坐姿图验收
import fs from 'node:fs';
import path from 'node:path';
import { decodePNG } from './png.mjs';

const files = process.argv.slice(2);
for (const f of files) {
  const buf = fs.readFileSync(f);
  const colorType = buf.readUInt8(8 + 4 + 4 + 8 + 1);
  const bitDepth = buf.readUInt8(8 + 4 + 4 + 8);
  const png = decodePNG(buf);
  const w = png.w, h = png.h, data = png.data;
  let minX = w, minY = h, maxX = -1, maxY = -1, total = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const isMagenta = r > 235 && g < 40 && b > 235;
      if (!isMagenta) {
        total += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  console.log(JSON.stringify({
    file: path.basename(f), w, h, bitDepth, colorType,
    bbox: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
    pad: { left: minX, right: w - 1 - maxX, top: minY, bottom: h - 1 - maxY },
    fgRatio: +(total / (w * h)).toFixed(4)
  }));
}
