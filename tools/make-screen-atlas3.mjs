/**
 * 生成亮屏贴图 + 逐席贴图矩形（v3：按熄屏底图的暗面板矩形拉伸贴合）。
 *
 * 背景：qwen-image 无法做像素级定点编辑（给了底图当参考也整张重画），但它的屏幕画面本身
 * 是合格的像素画。所以只借屏幕像素，位置/尺寸全部以熄屏底图实测的暗面板为准——两张图里
 * 显示器位置几乎重合，但亮面面积略小（主屏 58x19 vs 暗面板 69x27），所以必须拉伸贴满，
 * 否则四周露一圈暗底，看起来像屏幕缩小了。
 *
 * 用法: node tools/make-screen-atlas3.mjs [--dry]
 */
import { readPNG, encodePNG } from './png.mjs'
import fs from 'node:fs/promises'
import path from 'node:path'

const LIT = 'assets/raw/room-lit-02.png'
const DARK = 'assets/scene/office-dark-1664x2240.png'
const P = 'packages/dsh-pixel-office/assets'
const SCALE = 320 / 1664

const dry = process.argv.includes('--dry')

const lit = readPNG(LIT)
const dark = readPNG(DARK)
const LW = lit.w
const DH = dark.h
const lat = (x, y) => {
  const i = (y * LW + x) * 4
  return [lit.data[i], lit.data[i + 1], lit.data[i + 2]]
}
const dat = (x, y) => {
  const i = (y * dark.w + x) * 4
  return [dark.data[i], dark.data[i + 1], dark.data[i + 2]]
}

/** 亮屏：青色系。 */
const isLit = (x, y) => {
  const [r, g, b] = lat(x, y)
  return g > 100 && b > 95 && g > r + 35 && b > r + 12
}
/** 熄屏面板：暗且蓝不弱于红（灰蓝玻璃）。 */
const isPanel = (x, y) => {
  const [r, g, b] = dat(x, y)
  const luma = 0.299 * r + 0.587 * g + 0.114 * b
  return luma < 58 && b >= r - 4 && b > 16
}

function boxOf(test, wx, wy, ww, wh) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0
  for (let y = wy; y < wy + wh; y += 1) {
    for (let x = wx; x < wx + ww; x += 1) {
      if (x < 0 || y < 0 || x >= LW || y >= DH) continue
      if (!test(x, y)) continue
      n += 1
      if (x < x0) x0 = x
      if (y < y0) y0 = y
      if (x > x1) x1 = x
      if (y > y1) y1 = y
    }
  }
  return n ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, n } : null
}

const COLS = [375, 698, 1018, 1338]
const ROWS = [1104, 1366, 1629]

/** 面积加权重采样。 */
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
          if (xx < 0 || xx >= LW || yy < 0 || yy >= DH) continue
          const cw = Math.min(x1, xx + 1) - Math.max(x0, xx)
          const ch = Math.min(y1, yy + 1) - Math.max(y0, yy)
          const wgt = Math.max(0, cw) * Math.max(0, ch)
          if (wgt <= 0) continue
          const i = (yy * LW + xx) * 4
          r += lit.data[i] * wgt
          g += lit.data[i + 1] * wgt
          b += lit.data[i + 2] * wgt
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

// ---------- 主工位 ----------
const mainLit = boxOf(isLit, 660, 450, 460, 220)
// 暗面板：以亮面为中心扩一圈找
const mainDark = boxOf(isPanel, mainLit.x - 40, mainLit.y - 20, mainLit.w + 80, mainLit.h + 40)
console.log('主屏 亮面', mainLit, '\n     暗面板', mainDark)

const MAIN_W = toLogical(mainDark.w)
const MAIN_H = toLogical(mainDark.h)
const mainSprite = resample(mainLit.x, mainLit.y, mainLit.w, mainLit.h, MAIN_W, MAIN_H)
const mainRect = { x: toLogical(mainDark.x), y: toLogical(mainDark.y), w: MAIN_W, h: MAIN_H }
console.log('     逻辑矩形', mainRect)

// ---------- 副工位 ----------
const seats = []
for (let r = 0; r < 3; r += 1) {
  for (let c = 0; c < 4; c += 1) {
    const cx = COLS[c], cy = ROWS[r]
    const lb = boxOf(isLit, cx - 70, cy - 60, 140, 120)
    if (!lb) { seats.push({ seatId: `sub:${r * 4 + c}`, lit: null }); continue }
    const db = boxOf(isPanel, lb.x - 16, lb.y - 12, lb.w + 32, lb.h + 24)
    seats.push({ seatId: `sub:${r * 4 + c}`, lit: lb, panel: db })
    console.log(`sub:${r * 4 + c}`, '亮面', lb.w + 'x' + lb.h, '暗面板', db ? db.w + 'x' + db.h : 'null')
  }
}

// 副屏统一尺寸：取所有暗面板的中位宽高（避免个别席位被椅子/杯子污染）
const ws = seats.filter((s) => s.panel).map((s) => s.panel.w).sort((a, b) => a - b)
const hs = seats.filter((s) => s.panel).map((s) => s.panel.h).sort((a, b) => a - b)
const medW = ws[Math.floor(ws.length / 2)]
const medH = hs[Math.floor(hs.length / 2)]
const SUB_W = toLogical(medW)
const SUB_H = toLogical(medH)
console.log('副屏中位暗面板', medW + 'x' + medH, '-> 逻辑', SUB_W + 'x' + SUB_H)

// 副屏取样：用第一块亮面（最多像素的那块最干净）
const subSample = seats[0].lit
const subSprite = resample(subSample.x, subSample.y, subSample.w, subSample.h, SUB_W, SUB_H)

const seatRects = {}
for (const s of seats) {
  if (!s.panel) continue
  const rect = { x: toLogical(s.panel.x), y: toLogical(s.panel.y), w: SUB_W, h: SUB_H }
  seatRects[s.seatId] = rect
}

if (dry) {
  console.log('--dry，不写文件')
  console.log('seatRects', JSON.stringify(seatRects, null, 2))
  process.exit(0)
}

const dir = path.join(P, 'scene/screens')
await fs.mkdir(dir, { recursive: true })
await fs.writeFile(path.join(dir, 'lit-sub.png'), encodePNG(SUB_W, SUB_H, subSprite))
await fs.writeFile(path.join(dir, 'lit-main.png'), encodePNG(MAIN_W, MAIN_H, mainSprite))

const atlas = {
  $comment: '亮屏贴图与逐席矩形（320 逻辑坐标）。尺寸取自熄屏底图实测的暗面板，贴图由 AI 亮屏版的屏幕像素拉伸而来。',
  sub: { w: SUB_W, h: SUB_H, file: 'lit-sub.png' },
  main: { w: MAIN_W, h: MAIN_H, file: 'lit-main.png', rect: mainRect },
  seatRects,
  source: LIT,
}
await fs.writeFile(path.join(dir, 'atlas.json'), JSON.stringify(atlas, null, 2) + '\n')

console.log('lit-sub.png', SUB_W + 'x' + SUB_H)
console.log('lit-main.png', MAIN_W + 'x' + MAIN_H, 'rect', mainRect)
console.log('seatRects 共', Object.keys(seatRects).length, '席')
