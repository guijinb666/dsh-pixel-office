/**
 * 落座 y 偏移扫描：把同一 sprite 按多个 y 贴在多个座位上，出一张对比图。
 * 用法: node tmp/sweep-y.mjs
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

// 副工位第一排四席，y 偏移分别 -8 / 0 / +8 / +16（相对 deskTop）
const subSprite = readPNG(P + '/char/subs/final/m1-cat.png')
const offsets = [-8, 0, 8, 16]
const subs = doc.subs.slice(0, 4)
offsets.forEach((off, i) => {
  const s = subs[i]
  paste(subSprite, s.deskCx - Math.round(subSprite.w / 2), s.deskTop + off)
})

// 主工位：同一 sprite 用四种偏移不方便，改在主桌右侧试两档
const mainSprite = readPNG(P + '/char/main/final/main-sit-1.png')
paste(mainSprite, doc.main.deskCx - Math.round(mainSprite.w / 2), doc.main.deskTop + 10)

// 4x
const S = 5
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
await fs.writeFile('tmp/sweep-y.png', encodePNG(WW, HH, big))
console.log('ok offsets', offsets.join(','))
