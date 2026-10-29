// 把生成图里的品红背景统一成纯 #FF00FF，输出 RGB(colorType=2) PNG，并统计留白。
// 用法: node tools/_bg-flatten.mjs <in.png> <out.png>
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { decodePNG } from './png.mjs';

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf, start, end) {
  let c = -1;
  for (let i = start; i < end; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out, 4, 8 + data.length), 8 + data.length);
  return out;
}
function encodeRGB(w, h, rgb) {
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function rgbToHsv(r, g, b) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}
function isMagentaBg(r, g, b) {
  const { h, s, v } = rgbToHsv(r, g, b);
  return s > 0.35 && v > 0.25 && h >= 283 && h <= 327 && g < Math.min(r, b) - 20;
}

const [inFile, outFile] = process.argv.slice(2);
const png = decodePNG(fs.readFileSync(inFile));
const { w, h, data } = png;
const rgb = Buffer.alloc(w * h * 3);

let bgCount = 0;
for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
  const r = data[i], g = data[i + 1], b = data[i + 2];
  if (isMagentaBg(r, g, b)) {
    rgb[j] = 255; rgb[j + 1] = 0; rgb[j + 2] = 255;
    bgCount += 1;
  } else {
    rgb[j] = r; rgb[j + 1] = g; rgb[j + 2] = b;
  }
}
fs.writeFileSync(outFile, encodeRGB(w, h, rgb));

let minX = w, minY = h, maxX = -1, maxY = -1;
for (let y = 0; y < h; y += 1) {
  for (let x = 0; x < w; x += 1) {
    const j = (y * w + x) * 3;
    if (!(rgb[j] === 255 && rgb[j + 1] === 0 && rgb[j + 2] === 255)) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
}
console.log(JSON.stringify({
  file: path.basename(outFile), w, h, colorType: 2,
  bgRatio: +(bgCount / (w * h)).toFixed(4),
  bbox: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
  pad: { left: minX, right: w - 1 - maxX, top: minY, bottom: h - 1 - maxY }
}));
