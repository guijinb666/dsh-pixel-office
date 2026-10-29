/**
 * png.mjs - 最小 PNG 编解码器（零依赖，只依赖 node:zlib）。
 *
 * 只支持本项目用到的子集：
 *   - bitDepth 8（调色板图额外支持 1/2/4/8）
 *   - colorType 6 (RGBA) / 2 (RGB) / 0 (灰度) / 4 (灰度+alpha) / 3 (调色板)
 *   - 调色板图的 PLTE + tRNS
 *   - 所有标准 filter（0 None / 1 Sub / 2 Up / 3 Average / 4 Paeth）
 *   - 非隔行
 *
 * 编码只输出 colorType 6 (RGBA)，filter 全 0。
 *
 * 为什么不用 ffmpeg 做合成：ffmpeg 的 overlay 滤镜默认走 YUV420，
 * 像素画的纯色块会在色度下采样中糊掉、色值漂移。标定阶段必须看出
 * 真实的上屏效果，所以这里直接做 RGBA 整数 alpha 混合，一个字节都不损失。
 */
import zlib from 'node:zlib';
import fs from 'node:fs';

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = data.length;
  const out = Buffer.alloc(len + 12);
  out.writeUInt32BE(len, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  const crc = crc32(out, 4, 8 + len);
  out.writeUInt32BE(crc, 8 + len);
  return out;
}

/** Encode RGBA bytes (w*h*4) into a PNG buffer. */
export function encodePNG(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Decode a PNG into { w, h, data } where data is RGBA (w*h*4).
 * Unsupported variants throw with a clear message instead of silently
 * returning garbage.
 */
export function decodePNG(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) {
    throw new Error('not a PNG');
  }

  let off = 8;
  let w = 0;
  let h = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  let plte = null;
  let trns = null;

  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const dataStart = off + 8;
    const dataEnd = dataStart + len;

    if (type === 'IHDR') {
      w = buf.readUInt32BE(dataStart);
      h = buf.readUInt32BE(dataStart + 4);
      bitDepth = buf[dataStart + 8];
      colorType = buf[dataStart + 9];
      interlace = buf[dataStart + 12];
    } else if (type === 'PLTE') {
      plte = buf.subarray(dataStart, dataEnd);
    } else if (type === 'tRNS') {
      trns = buf.subarray(dataStart, dataEnd);
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      break;
    }

    off = dataEnd + 4; // skip CRC
  }

  if (!w || !h) throw new Error('missing IHDR');
  if (interlace !== 0) throw new Error('interlaced PNG not supported');

  const channels =
    colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 0 ? 1
    : colorType === 3 ? 1 : -1;
  if (channels < 0) throw new Error('unsupported color type ' + colorType);
  if (colorType !== 3 && bitDepth !== 8) throw new Error('unsupported bit depth ' + bitDepth);
  if (colorType === 3 && ![1, 2, 4, 8].includes(bitDepth)) {
    throw new Error('unsupported palette bit depth ' + bitDepth);
  }
  if (colorType === 3 && !plte) throw new Error('palette PNG without PLTE');

  const bitsPerPixel = channels * bitDepth;
  const bpp = Math.max(1, bitsPerPixel >> 3); // filter 距离以字节计
  const stride = Math.ceil((w * bitsPerPixel) / 8);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(stride * h);

  let pos = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[pos++];
    const rowStart = y * stride;
    const prevStart = (y - 1) * stride;

    for (let x = 0; x < stride; x++) {
      const v = raw[pos++];
      const a = x >= bpp ? out[rowStart + x - bpp] : 0;
      const b = y > 0 ? out[prevStart + x] : 0;
      const c = x >= bpp && y > 0 ? out[prevStart + x - bpp] : 0;

      let recon;
      switch (filter) {
        case 0:
          recon = v;
          break;
        case 1:
          recon = v + a;
          break;
        case 2:
          recon = v + b;
          break;
        case 3:
          recon = v + ((a + b) >> 1);
          break;
        case 4:
          recon = v + paeth(a, b, c);
          break;
        default:
          throw new Error('bad filter ' + filter + ' on row ' + y);
      }
      out[rowStart + x] = recon & 0xff;
    }
  }

  const rgba = Buffer.alloc(w * h * 4);

  // 调色板图：索引可能不足一字节，逐位取。
  if (colorType === 3) {
    const palCount = (plte.length / 3) | 0;
    const mask = (1 << bitDepth) - 1;
    for (let y = 0; y < h; y++) {
      const rowStart = y * stride;
      for (let x = 0; x < w; x++) {
        const bitPos = x * bitDepth;
        const byte = out[rowStart + (bitPos >> 3)];
        const shift = 8 - bitDepth - (bitPos & 7);
        const idx = (byte >> shift) & mask;
        const di = (y * w + x) * 4;
        if (idx < palCount) {
          rgba[di] = plte[idx * 3];
          rgba[di + 1] = plte[idx * 3 + 1];
          rgba[di + 2] = plte[idx * 3 + 2];
          rgba[di + 3] = trns && idx < trns.length ? trns[idx] : 255;
        }
      }
    }
    return { w, h, data: rgba };
  }

  // Normalize everything else to RGBA so callers never branch on color type.
  if (channels === 4) return { w, h, data: out };

  for (let i = 0, j = 0; i < w * h; i++, j += channels) {
    if (channels === 3) {
      rgba[i * 4] = out[j];
      rgba[i * 4 + 1] = out[j + 1];
      rgba[i * 4 + 2] = out[j + 2];
      rgba[i * 4 + 3] = 255;
    } else if (channels === 1) {
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = out[j];
      rgba[i * 4 + 3] = 255;
    } else {
      // gray + alpha
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = out[j];
      rgba[i * 4 + 3] = out[j + 1];
    }
  }
  return { w, h, data: rgba };
}

export function readPNG(file) {
  return decodePNG(fs.readFileSync(file));
}

export function writePNG(file, w, h, rgba) {
  fs.writeFileSync(file, encodePNG(w, h, rgba));
}
