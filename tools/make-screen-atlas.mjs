/**
 * 从 AI 生成的"亮屏版办公室"里裁出真实的亮屏像素，缩放到熄屏底图实测的屏幕矩形，
 * 存成两张贴图 atlas：
 *   assets/scene/screens/lit-sub.png   （副工位单屏，17x16 可用区 + 3px 光晕边）
 *   assets/scene/screens/lit-main.png  （主工位双屏，69x27 可用区 + 3px 光晕边）
 *
 * 为什么这么做：AI 的亮屏版整间房间的构图跟熄屏版对不上（家具、透视、门都变了），
 * 不能直接当第二张底图切换。但它的屏幕像素本身——青色底、浅色 UI 条、屏幕对桌面的
 * 溢光——是真材实料的像素画，比运行时用 'lighter' 叠纯色真实得多。
 * 所以只借用它的屏幕，位置仍用熄屏版实测的矩形。
 *
 * 用法: node tools/make-screen-atlas.mjs
 */
import { readPNG, encodePNG } from './png.mjs'
import fs from 'node:fs/promises'
import path from 'node:path'

const P = 'packages/dsh-pixel-office/assets'
const LIT = 'assets/raw/room-lit-01.png'

const lit = readPNG(LIT)
const W = lit.w
const H = lit.h
const d = lit.data

const px = (x, y) => {
  const i = (y * W + x) * 4
  return [d[i], d[i + 1], d[i + 2]]
}

/** 亮屏像素：青色系（绿蓝明显高于红，且足够亮）。 */
function isLitScreen(x, y) {
  const [r, g, b] = px(x, y)
  return g > 110 && b > 100 && g > r + 42 && b > r + 18
}

/** 4 邻域连通块。 */
function components(x0, y0, x1, y1, minArea) {
  const seen = new Set()
  const out = []
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const k = y * W + x
      if (seen.has(k) || !isLitScreen(x, y)) continue
      const stack = [[x, y]]
      seen.add(k)
      const pts = []
      while (stack.length) {
        const [cx, cy] = stack.pop()
        pts.push([cx, cy])
        for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]) {
          if (nx < x0 || nx >= x1 || ny < y0 || ny >= y1) continue
          const nk = ny * W + nx
          if (seen.has(nk) || !isLitScreen(nx, ny)) continue
          seen.add(nk)
          stack.push([nx, ny])
        }
      }
      if (pts.length < minArea) continue
      const xs = pts.map((p) => p[0])
      const ys = pts.map((p) => p[1])
      out.push({
        n: pts.length,
        x: Math.min(...xs),
        y: Math.min(...ys),
        w: Math.max(...xs) - Math.min(...xs) + 1,
        h: Math.max(...ys) - Math.min(...ys) + 1,
      })
    }
  }
  return out.sort((a, b) => a.y - b.y || a.x - b.x)
}

const blocks = components(0, 400, W, 1900, 300)
console.log('亮屏块数:', blocks.length)
for (const b of blocks) console.log(`  ${b.n}px  x${b.x} y${b.y}  ${b.w}x${b.h}`)

// 主工位：最靠上的、横向最宽的两块（上下双屏各一块）
const sortedByY = blocks.slice().sort((a, b) => a.y - b.y)
const mainCandidates = sortedByY.slice(0, 2).sort((a, b) => a.x - b.x)
// 副工位：剩下的，按 y 分行
const subBlocks = blocks.filter((b) => !mainCandidates.includes(b)).sort((a, b) => a.y - b.y || a.x - b.x)

/** 保持宽高比，把 src 区域面积平均缩放到 dw x dh。 */
function resample(src, sx0, sy0, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4)
  for (let y = 0; y < dh; y += 1) {
    // 目标像素在源上覆盖的范围
    const y0 = sy0 + (y * sh) / dh
    const y1 = sy0 + ((y + 1) * sh) / dh
    for (let x = 0; x < dw; x += 1) {
      const x0 = sx0 + (x * sw) / dw
      const x1 = sx0 + ((x + 1) * sw) / dw
      let r = 0
      let g = 0
      let b = 0
      let wsum = 0
      for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy += 1) {
        for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx += 1) {
          if (xx < 0 || xx >= src.w || yy < 0 || yy >= src.h) continue
          // 覆盖权重
          const wx = Math.min(x1, xx + 1) - Math.max(x0, xx)
          const wy = Math.min(y1, yy + 1) - Math.max(y0, yy)
          const w = Math.max(0, wx) * Math.max(0, wy)
          if (w <= 0) continue
          const i = (yy * src.w + xx) * 4
          r += src.data[i] * w
          g += src.data[i + 1] * w
          b += src.data[i + 2] * w
          wsum += w
        }
      }
      const di = (y * dw + x) * 4
      if (wsum > 0) {
        out[di] = Math.round(r / wsum)
        out[di + 1] = Math.round(g / wsum)
        out[di + 2] = Math.round(b / wsum)
      }
      out[di + 3] = 255
    }
  }
  return out
}

const GLOW = 3

// --- 副屏 atlas：取第一排中间那块当代表 ---
const subRef = subBlocks[0]
const subBlock = subBlocks.find((b) => Math.abs(b.y - subRef.y) < 12 && b.x > subRef.x) || subRef
console.log('副屏取样块:', `x${subBlock.x} y${subBlock.y} ${subBlock.w}x${subBlock.h}`)

const SUB_TARGET_W = 17
const SUB_TARGET_H = 16
const subPad = 4 // 源上多带几像素，含屏幕外壳
const subOut = resample(
  lit,
  subBlock.x - subPad,
  subBlock.y - subPad,
  subBlock.w + subPad * 2,
  subBlock.h + subPad * 2,
  SUB_TARGET_W + GLOW * 2,
  SUB_TARGET_H + GLOW * 2,
)

// --- 主屏 atlas：上下双屏合起来一块 —— 取两块 bbox 的并集 ---
const m0 = mainCandidates[0]
const m1 = mainCandidates[1]
const mainX = Math.min(m0.x, m1.x)
const mainY = Math.min(m0.y, m1.y)
const mainR = Math.max(m0.x + m0.w, m1.x + m1.w)
const mainB = Math.max(m0.y + m0.h, m1.y + m1.h)
const mainW = mainR - mainX
const mainH = mainB - mainY
console.log('主屏取样块:', `x${mainX} y${mainY} ${mainW}x${mainH}`)

const MAIN_TARGET_W = 69
const MAIN_TARGET_H = 27
const mainPad = 8
const mainOut = resample(
  lit,
  mainX - mainPad,
  mainY - mainPad,
  mainW + mainPad * 2,
  mainH + mainPad * 2,
  MAIN_TARGET_W + GLOW * 2,
  MAIN_TARGET_H + GLOW * 2,
)

const dir = path.join(P, 'scene/screens')
await fs.mkdir(dir, { recursive: true })
await fs.writeFile(path.join(dir, 'lit-sub.png'), encodePNG(SUB_TARGET_W + GLOW * 2, SUB_TARGET_H + GLOW * 2, subOut))
await fs.writeFile(path.join(dir, 'lit-main.png'), encodePNG(MAIN_TARGET_W + GLOW * 2, MAIN_TARGET_H + GLOW * 2, mainOut))

const meta = {
  $comment: '亮屏贴图。每张比屏幕可用区四周各大 GLOW 像素，用来带出屏幕溢光。运行时按 rect 居中贴。',
  glow: GLOW,
  sub: { w: SUB_TARGET_W, h: SUB_TARGET_H, file: 'lit-sub.png' },
  main: { w: MAIN_TARGET_W, h: MAIN_TARGET_H, file: 'lit-main.png' },
  source: LIT,
}
await fs.writeFile(path.join(dir, 'atlas.json'), JSON.stringify(meta, null, 2) + '\n')

console.log('写出 lit-sub.png', SUB_TARGET_W + GLOW * 2, 'x', SUB_TARGET_H + GLOW * 2)
console.log('写出 lit-main.png', MAIN_TARGET_W + GLOW * 2, 'x', MAIN_TARGET_H + GLOW * 2)
