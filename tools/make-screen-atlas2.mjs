/**
 * 从 AI 亮屏版（room-lit-02）里量出每块屏幕的点亮面，生成可复用的亮屏贴图 + 逐席贴图矩形。
 *
 * 为什么只借屏幕像素、不整张切图：qwen-image 无法做像素级定点编辑，给了底图当参考也整张重绘
 * （家具、透视、地板色全变）。但它的屏幕画面本身是合格的像素画，所以只取屏幕面，位置仍用
 * 熄屏底图的坐标——两张图里显示器位置几乎重合（副屏 78x42 vs 80x45），贴回去天然对齐。
 *
 * 用法: node tools/make-screen-atlas2.mjs [--dry]
 */
import { readPNG, encodePNG } from './png.mjs'
import fs from 'node:fs/promises'
import path from 'node:path'

const LIT = 'assets/raw/room-lit-02.png'
const P = 'packages/dsh-pixel-office/assets'
const SCALE = 320 / 1664 // 熄屏底图 320 宽 / 源图 1664 宽

const img = readPNG(LIT)
const { w: W, h: H, data: D } = img
const at = (x, y) => {
  const i = (y * W + x) * 4
  return [D[i], D[i + 1], D[i + 2]]
}

/** 亮屏判定：青色系，绿蓝明显高于红。 */
function isLit(x, y) {
  const [r, g, b] = at(x, y)
  return g > 100 && b > 95 && g > r + 35 && b > r + 12
}

function bbox(wx, wy, ww, wh) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0
  for (let y = wy; y < wy + wh; y += 1) {
    for (let x = wx; x < wx + ww; x += 1) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue
      if (!isLit(x, y)) continue
      n += 1
      if (x < x0) x0 = x
      if (y < y0) y0 = y
      if (x > x1) x1 = x
      if (y > y1) y1 = y
    }
  }
  return n ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, n } : null
}

// 熄屏底图实测的列/行中心（源图坐标）
const COLS = [375, 698, 1018, 1338]
const ROWS = [1104, 1366, 1629]

const mainBox = bbox(660, 450, 460, 220)
console.log('主屏亮面', mainBox)

const subBoxes = []
for (let r = 0; r < 3; r += 1) {
  for (let c = 0; c < 4; c += 1) {
    const b = bbox(COLS[c] - 70, ROWS[r] - 60, 140, 120)
    subBoxes.push({ seatId: `sub:${r * 4 + c}`, ...b })
    console.log(`sub:${r * 4 + c}`, b)
  }
}

/** 面积加权重采样：源区域 -> dw x dh。 */
function resample(sx0, sy0, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4)
  for (let y = 0; y < dh; y += 1) {
    const y0 = sy0 + (y * sh) / dh
    const y1 = sy0 + ((y + 1) * sh) / dh
    for (let x = 0; x < dw; x += 1) {
      const x0 = sx0 + (x * sw) / dw
      const x1 = sx0 + ((x + 1) * sw) / dw
      let r = 0, g = 0, b = 0, ws = 0
      for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy += 1) {
        for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx += 1) {
          if (xx < 0 || xx >= W || yy < 0 || yy >= H) continue
          const cw = Math.min(x1, xx + 1) - Math.max(x0, xx)
          const ch = Math.min(y1, yy + 1) - Math.max(y0, yy)
          const wgt = Math.max(0, cw) * Math.max(0, ch)
          if (wgt <= 0) continue
          const i = (yy * W + xx) * 4
          r += D[i] * wgt
          g += D[i + 1] * wgt
          b += D[i + 2] * wgt
          ws += wgt
        }
      }
      const di = (y * dw + x) * 4
      if (ws > 0) {
        out[di] = Math.round(r / ws)
        out[di + 1] = Math.round(g / ws)
        out[di + 2] = Math.round(b / ws)
        out[di + 3] = 255
      }
    }
  }
  return out
}

const toLogical = (v) => Math.round(v * SCALE)

// --- 副屏贴图：取第一排第一块的尺寸为准，四边不带外扩 ---
const subRef = subBoxes[0]
const SUB_W = toLogical(subRef.w)   // 15
const SUB_H = toLogical(subRef.h)   // 8
const subSprite = resample(subRef.x, subRef.y, subRef.w, subRef.h, SUB_W, SUB_H)

// --- 主屏贴图：双屏并集，包含中间深色立柱 ---
const MAIN_W = toLogical(mainBox.w) // 58
const MAIN_H = toLogical(mainBox.h) // 19
const mainSprite = resample(mainBox.x, mainBox.y, mainBox.w, mainBox.h, MAIN_W, MAIN_H)

const dir = path.join(P, 'scene/screens')
await fs.mkdir(dir, { recursive: true })
await fs.writeFile(path.join(dir, 'lit-sub.png'), encodePNG(SUB_W, SUB_H, subSprite))
await fs.writeFile(path.join(dir, 'lit-main.png'), encodePNG(MAIN_W, MAIN_H, mainSprite))

// 逐席贴图矩形（320 逻辑坐标）
const mainRect = { x: toLogical(mainBox.x), y: toLogical(mainBox.y), w: MAIN_W, h: MAIN_H }
const seatRects = {}
for (const b of subBoxes) {
  seatRects[b.seatId] = { x: toLogical(b.x), y: toLogical(b.y), w: SUB_W, h: SUB_H }
}

const atlas = {
  $comment: '亮屏贴图与逐席矩形（320 逻辑坐标）。运行时按 seatRects 贴，副屏共用 lit-sub.png。',
  sub: { w: SUB_W, h: SUB_H, file: 'lit-sub.png' },
  main: { w: MAIN_W, h: MAIN_H, file: 'lit-main.png', rect: mainRect },
  seatRects,
  source: LIT,
}
await fs.writeFile(path.join(dir, 'atlas.json'), JSON.stringify(atlas, null, 2) + '\n')

console.log('lit-sub.png', SUB_W, 'x', SUB_H)
console.log('lit-main.png', MAIN_W, 'x', MAIN_H, 'rect', mainRect)
console.log('seatRects 已写入 atlas.json，共', Object.keys(seatRects).length, '席')
