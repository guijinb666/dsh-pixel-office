/**
 * 生成亮屏贴图（定稿版 v4）。
 *
 * 结论链：
 * 1. qwen-image 无法做像素级定点编辑（给了底图当参考也整张重画），所以「AI 出一张同机位亮屏
 *    底图、运行时两图切换」走不通。
 * 2. 但 AI 画的屏幕像素本身是合格像素画，值得复用。
 * 3. 贴图矩形必须用**熄屏底图实测的暗面板**（seats.json 的 screen 字段），不能用亮屏图上
 *    亮面的包围盒——亮面偏小且位置有微差，贴回去会露一圈暗边或越出显示器外壳。
 *
 * 所以：源区域从亮屏图的亮面取，目标尺寸 = seats.json 的 screen 矩形，面积加权重采样。
 *
 * 用法: node tools/make-screen-atlas4.mjs
 */
import { readPNG, encodePNG } from './png.mjs'
import fs from 'node:fs/promises'
import path from 'node:path'

const LIT = 'assets/raw/room-lit-02.png'
const P = 'packages/dsh-pixel-office/assets'
const SCALE = 320 / 1664

const lit = readPNG(LIT)
const seats = JSON.parse(await fs.readFile(`${P}/scene/seats.json`, 'utf8'))
const LW = lit.w
const LH = lit.h

/** 亮屏：青色系，绿蓝明显高于红。 */
const isLit = (x, y) => {
  const i = (y * LW + x) * 4
  const r = lit.data[i], g = lit.data[i + 1], b = lit.data[i + 2]
  return g > 100 && b > 95 && g > r + 35 && b > r + 12
}

function boxOf(wx, wy, ww, wh) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0
  for (let y = wy; y < wy + wh; y += 1) {
    for (let x = wx; x < wx + ww; x += 1) {
      if (x < 0 || y < 0 || x >= LW || y >= LH) continue
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

/** 面积加权重采样。trimPct 把包围盒四边各内缩一定比例，避开亮面边缘的过渡像素。 */
function resample(box, dw, dh, trimPct = 0) {
  const tx = Math.round(box.w * trimPct)
  const ty = Math.round(box.h * trimPct)
  const sx0 = box.x + tx
  const sy0 = box.y + ty
  const sw = box.w - tx * 2
  const sh = box.h - ty * 2
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
          if (xx < 0 || xx >= LW || yy < 0 || yy >= LH) continue
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

// ---------- 主工位 ----------
const mainScreen = seats.main.screen            // {x,y,w,h} 逻辑坐标
const mainLit = boxOf(660, 450, 460, 220)
const mainSprite = resample(mainLit, mainScreen.w, mainScreen.h, 0.06)
console.log('主屏 亮面', mainLit.w + 'x' + mainLit.h, '-> 目标', mainScreen.w + 'x' + mainScreen.h)

// ---------- 副工位 ----------
const COLS = [375, 698, 1018, 1338]
const ROWS = [1104, 1366, 1629]
const litBoxes = []
for (let r = 0; r < 3; r += 1) {
  for (let c = 0; c < 4; c += 1) {
    const b = boxOf(COLS[c] - 70, ROWS[r] - 60, 140, 120)
    litBoxes.push({ seatId: `sub:${r * 4 + c}`, box: b })
  }
}
// 用像素数最多的一块当取样源（最干净、最完整）
const sample = litBoxes.slice().sort((a, b) => b.box.n - a.box.n)[0]
const subScreen = seats.subs[0].screen        // 所有副席位尺寸相同
const subSprite = resample(sample.box, subScreen.w, subScreen.h, 0.06)
console.log('副屏 取样', sample.seatId, sample.box.w + 'x' + sample.box.h,
  '-> 目标', subScreen.w + 'x' + subScreen.h)

// 逐席矩形（320 逻辑坐标），直接来自 seats.json
const seatRects = {}
for (const s of seats.subs) seatRects[s.seatId] = { ...s.screen }

const dir = path.join(P, 'scene/screens')
await fs.mkdir(dir, { recursive: true })
await fs.writeFile(path.join(dir, 'lit-sub.png'), encodePNG(subScreen.w, subScreen.h, subSprite))
await fs.writeFile(path.join(dir, 'lit-main.png'), encodePNG(mainScreen.w, mainScreen.h, mainSprite))

const atlas = {
  $comment:
    '亮屏贴图。尺寸与逐席矩形全部取自 seats.json（熄屏底图实测的暗面板），贴图内容来自 AI 亮屏版 room-lit-02 的屏幕像素。运行时：工位有人才贴这张图。',
  sub: { w: subScreen.w, h: subScreen.h, file: 'lit-sub.png' },
  main: { w: mainScreen.w, h: mainScreen.h, file: 'lit-main.png', rect: { ...mainScreen } },
  seatRects,
  source: LIT,
}
await fs.writeFile(path.join(dir, 'atlas.json'), JSON.stringify(atlas, null, 2) + '\n')

console.log('lit-sub.png', subScreen.w + 'x' + subScreen.h)
console.log('lit-main.png', mainScreen.w + 'x' + mainScreen.h)
console.log('seatRects 共', Object.keys(seatRects).length, '席')
