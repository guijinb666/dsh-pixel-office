/**
 * 验证亮屏贴图：把 atlas 的亮屏精灵贴到熄屏底图的对应矩形上，出对比图。
 * 两套矩形来源同时出图，肉眼选更贴合的：
 *   A = atlas.json 的 seatRects（亮面推导的暗面板）
 *   B = seats.json 的 screen 矩形（原本实测的深色连通块）
 *
 * 用法: node tools/verify-lit.mjs
 */
import { readPNG, encodePNG } from './png.mjs'
import fs from 'node:fs'
import path from 'node:path'

const P = 'packages/dsh-pixel-office/assets'
const scene = readPNG(`${P}/scene/office-dark-320.png`)
const atlas = JSON.parse(fs.readFileSync(`${P}/scene/screens/atlas.json`, 'utf8'))
const seats = JSON.parse(fs.readFileSync(`${P}/scene/seats.json`, 'utf8'))
const litSub = readPNG(`${P}/scene/screens/${atlas.sub.file}`)
const litMain = readPNG(`${P}/scene/screens/${atlas.main.file}`)

const { w: SW, h: SH, data: SD } = scene

/** 最近邻缩放精灵到 dw x dh。 */
function scaleSprite(sp, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4)
  for (let y = 0; y < dh; y += 1) {
    const sy = Math.min(sp.h - 1, Math.floor((y * sp.h) / dh))
    for (let x = 0; x < dw; x += 1) {
      const sx = Math.min(sp.w - 1, Math.floor((x * sp.w) / dw))
      const si = (sy * sp.w + sx) * 4
      const di = (y * dw + x) * 4
      out[di] = sp.data[si]
      out[di + 1] = sp.data[si + 1]
      out[di + 2] = sp.data[si + 2]
      out[di + 3] = 255
    }
  }
  return out
}

/** 把精灵整块贴到 canvas 的 (x,y)。 */
function blit(canvas, sprite, dw, dh, x, y) {
  for (let yy = 0; yy < dh; yy += 1) {
    const cy = y + yy
    if (cy < 0 || cy >= SH) continue
    for (let xx = 0; xx < dw; xx += 1) {
      const cx = x + xx
      if (cx < 0 || cx >= SW) continue
      const si = (yy * dw + xx) * 4
      const di = (cy * SW + cx) * 4
      canvas[di] = sprite[si]
      canvas[di + 1] = sprite[si + 1]
      canvas[di + 2] = sprite[si + 2]
    }
  }
}

function build(variant) {
  const canvas = Buffer.from(SD) // 复制
  // 主工位
  const mRect = variant === 'A'
    ? atlas.main.rect
    : { x: seats.main.screen.x, y: seats.main.screen.y, w: seats.main.screen.w, h: seats.main.screen.h }
  blit(canvas, scaleSprite(litMain, mRect.w, mRect.h), mRect.w, mRect.h, mRect.x, mRect.y)

  // 副工位
  for (const s of seats.subs) {
    const r = variant === 'A'
      ? atlas.seatRects[s.seatId]
      : { x: s.screen.x, y: s.screen.y, w: s.screen.w, h: s.screen.h }
    if (!r) continue
    blit(canvas, scaleSprite(litSub, r.w, r.h), r.w, r.h, r.x, r.y)
  }
  return canvas
}

/** 整数放大看颗粒。 */
function upscale(rgba, k) {
  const dw = SW * k, dh = SH * k
  const out = Buffer.alloc(dw * dh * 4)
  for (let y = 0; y < dh; y += 1) {
    const sy = Math.floor(y / k)
    for (let x = 0; x < dw; x += 1) {
      const sx = Math.floor(x / k)
      const si = (sy * SW + sx) * 4
      const di = (y * dw + x) * 4
      out[di] = rgba[si]
      out[di + 1] = rgba[si + 1]
      out[di + 2] = rgba[si + 2]
      out[di + 3] = 255
    }
  }
  return { w: dw, h: dh, data: out }
}

const dir = 'tmp'
fs.mkdirSync(dir, { recursive: true })
for (const v of ['A', 'B']) {
  const canvas = build(v)
  fs.writeFileSync(`${dir}/lit-${v}.png`, encodePNG(SW, SH, canvas))
  const up = upscale(canvas, 3)
  fs.writeFileSync(`${dir}/lit-${v}@3x.png`, encodePNG(up.w, up.h, up.data))
  console.log('wrote', `tmp/lit-${v}.png`, `tmp/lit-${v}@3x.png`)
}
console.log('atlas.main.rect', atlas.main.rect, ' seats.main.screen', seats.main.screen)
console.log('atlas sub:0', atlas.seatRects['sub:0'], ' seats sub:0', seats.subs[0].screen)
