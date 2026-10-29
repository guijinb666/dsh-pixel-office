/** 放大裁切任意图。用法: node tmp/crop2.mjs <file> <x0> <y0> <cw> <ch> <S> <out> */
import { readPNG, encodePNG } from '../tools/png.mjs'
import fs from 'node:fs/promises'

const [file, x0s, y0s, cws, chs, Ss, target] = process.argv.slice(2)
const x0 = Number(x0s)
const y0 = Number(y0s)
const cw = Number(cws)
const ch = Number(chs)
const S = Number(Ss)
const img = readPNG(file)
const W = cw * S
const H = ch * S
const out = Buffer.alloc(W * H * 4)
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    const sx = Math.min(img.w - 1, x0 + Math.floor(x / S))
    const sy = Math.min(img.h - 1, y0 + Math.floor(y / S))
    const si = (sy * img.w + sx) * 4
    const di = (y * W + x) * 4
    out[di] = img.data[si]
    out[di + 1] = img.data[si + 1]
    out[di + 2] = img.data[si + 2]
    out[di + 3] = 255
  }
}
await fs.writeFile(target, encodePNG(W, H, out))
console.log('wrote', target, W + 'x' + H)
