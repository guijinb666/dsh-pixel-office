/** 放大裁切某个区域，用于肉眼判读几何。 */
import { readPNG, encodePNG } from '../tools/png.mjs'
import fs from 'node:fs/promises'

const file = 'assets/scene/office-dark-320.png'
const img = readPNG(file)
const [x0, y0, cw, ch, S] = process.argv.slice(2, 7).map(Number)
const W = cw * S
const H = ch * S
const out = Buffer.alloc(W * H * 4)
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    const sx = x0 + Math.floor(x / S)
    const sy = y0 + Math.floor(y / S)
    const si = (sy * img.w + sx) * 4
    const di = (y * W + x) * 4
    out[di] = img.data[si]
    out[di + 1] = img.data[si + 1]
    out[di + 2] = img.data[si + 2]
    out[di + 3] = 255
  }
}
const target = process.argv[7] || 'tmp/crop.png'
await fs.writeFile(target, encodePNG(W, H, out))
console.log('wrote', target, W + 'x' + H)
