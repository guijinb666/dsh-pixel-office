// 验收自检：品红底占比、角色包围盒、四边留白、边缘软像素（抗锯齿）计数、颜色数
// 用法：node tmp/turnb-check.mjs a.png b.png ...
// 纯 Node 解码 PNG（复用 tools/png.mjs 若存在，否则用自带轻解析）

import fs from 'node:fs';
import zlib from 'node:zlib';

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let off = 8;
  let w = 0; let h = 0; let bitDepth = 0; let colorType = 0;
  const idat = [];
  let palette = null;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'PLTE') palette = data;
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const chan = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : colorType === 4 ? 2 : 1;
  const bpp = chan * (bitDepth / 8);
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let pos = 0;
  for (let y = 0; y < h; y += 1) {
    const ft = raw[pos]; pos += 1;
    const line = raw.subarray(pos, pos + stride); pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 255;
    }
  }
  const get = (x, y) => {
    const i = y * stride + x * bpp;
    if (colorType === 3 && palette) {
      const idx = out[i] * 3;
      return [palette[idx], palette[idx + 1], palette[idx + 2]];
    }
    if (chan === 1) return [out[i], out[i], out[i]];
    if (chan === 2) return [out[i], out[i], out[i]];
    return [out[i], out[i + 1], out[i + 2]];
  };
  return { w, h, get, colorType };
}

function isMagenta(r, g, b) {
  // 品红底判定：R 高、B 高、G 低（允许轻微浮动）
  return r > 200 && b > 200 && g < 90;
}

for (const file of process.argv.slice(2)) {
  const img = decodePng(fs.readFileSync(file));
  const { w, h } = img;
  let minX = w; let minY = h; let maxX = -1; let maxY = -1;
  let magenta = 0; let offMask = 0;
  const colors = new Set();
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const [r, g, b] = img.get(x, y);
      colors.add((r << 16) | (g << 8) | b);
      if (isMagenta(r, g, b)) { magenta += 1; continue; }
      offMask += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const total = w * h;
  // 角落取样，确认底色统一
  const corners = [img.get(2, 2), img.get(w - 3, 2), img.get(2, h - 3), img.get(w - 3, h - 3)];
  const bgOk = corners.every(([r, g, b]) => isMagenta(r, g, b));
  // 边框一圈是否全为品红（不贴边）
  let edgeHit = 0;
  for (let x = 0; x < w; x += 1) {
    for (const y of [0, 1, h - 2, h - 1]) if (!isMagenta(...img.get(x, y))) edgeHit += 1;
  }
  for (let y = 0; y < h; y += 1) {
    for (const x of [0, 1, w - 2, w - 1]) if (!isMagenta(...img.get(x, y))) edgeHit += 1;
  }
  const bbox = { minX, minY, maxX, maxY };
  const pad = { left: minX, top: minY, right: w - 1 - maxX, bottom: h - 1 - maxY };
  const heightPct = ((maxY - minY + 1) / h * 100).toFixed(1);
  const ok5 = Math.min(pad.left, pad.top, pad.right, pad.bottom) >= 40;
  process.stdout.write(`${JSON.stringify({
    file,
    size: `${w}x${h}`,
    bbox,
    pad,
    height_pct: Number(heightPct),
    bg_corner_magenta: bgOk,
    border_pixels_not_magenta: edgeHit,
    magenta_pct: Number((magenta / total * 100).toFixed(1)),
    distinct_colors: colors.size,
    pass_no_touch: ok5,
  })}\n`);
}
