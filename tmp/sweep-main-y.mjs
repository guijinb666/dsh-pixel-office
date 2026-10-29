/**
 * 主鱼落座 y 扫描：同一张坐姿帧贴在四个 y 上，出一张放大对比。
 * 用法: node tmp/sweep-main-y.mjs
 */
import { readPNG, encodePNG } from '../tools/png.mjs'
import fs from 'node:fs/promises'

const P = 'packages/dsh-pixel-office/assets'
const scene = readPNG(P + '/scene/office-dark-320.png')
const doc = JSON.parse(await fs.readFile(P + '/scene/seats.json', 'utf8'))
const W = scene.w
const H = scene.h
const out = Buffer.from(scene.data)

function paste(sp, ox, oy) {
  for (let y = 0; y < sp.h; y += 1) {
    const ty = oy + y
    if (ty < 0 || ty >= H) continue
    for (let x = 0; x < sp.w; x += 1) {
      const tx = ox + x
      if (tx < 0 || tx >= W) continue
      const si = (y * sp.w + x) * 4
      const a = sp.data[si + 3] / 255
      if (a <= 0) continue
      const di = (ty * W + tx) * 4
      if (a >= 1) {
        out[di] = sp.data[si]
        out[di + 1] = sp.data[si + 1]
        out[di + 2] = sp.data[si + 2]
        out[di + 3] = 255
      } else {
        const k = 1 - a
        out[di] = Math.round(sp.data[si] * a + out[di] * k)
        out[di + 1] = Math.round(sp.data[si + 1] * a + out[di + 1] * k)
        out[di + 2] = Math.round(sp.data[si + 2] * a + out[di + 2] * k)
        out[di + 3] = 255
      }
    }
  }
}

// 把主桌水平分四段，每段放一个人的不同 y，避免重叠
const sprite = readPNG(P + '/char/main/final/main-sit-1.png')
const ys = [100, 108, 116, 124]
const xs = [118, 152, 186, 220]
ys.forEach((y, i) => {
  paste(sprite, xs[i], y)
})

const S = 6
const WW = W * S
const HH = H * S
const big = Buffer.alloc(WW * HH * 4)
for (let y = 0; y < HH; y += 1) {
  for (let x = 0; x < WW; x += 1) {
    const si = (Math.floor(y / S) * W + Math.floor(x / S)) * 4
    const di = (y * WW + x) * 4
    big[di] = out[si]
    big[di + 1] = out[si + 1]
    big[di + 2] = out[si + 2]
    big[di + 3] = 255
  }
}
await fs.writeFile('tmp/sweep-main-y.png', encodePNG(WW, HH, big))
console.log('ok ys', ys.join(','), 'sprite', sprite.w + 'x' + sprite.h)
