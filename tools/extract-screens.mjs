/**
 * 从息屏底图里自动提取"屏幕可见面"的形状 mask 与 bbox。
 *
 * 做法：屏幕在底图里是低亮度、低饱和的深色块。按连通块找出来，
 * 面积够大的就是屏。输出每个屏的形状位图（1 字节/像素，0=透明 255=可见），
 * 供 client 侧贴亮屏纹理时抠形用 —— 这样双屏中间的立柱、屏幕的透视边缘
 * 全都天然正确，不需要手工描边。
 *
 * 用法: node tools/extract-screens.mjs
 */
import { readPNG, encodePNG } from './png.mjs'
import fs from 'node:fs/promises'
import path from 'node:path'

const P = 'packages/dsh-pixel-office/assets'
const SCENE = path.join(P, 'scene/office-dark-320.png')

const img = readPNG(SCENE)
const W = img.w
const H = img.h
const d = img.data

const luma = (i) => d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114

/** 屏幕像素判定：很暗 + 蓝紫偏色（底图里屏幕是 #1c1a2e 附近的冷暗色）。 */
function isScreenPixel(x, y) {
  const i = (y * W + x) * 4
  const r = d[i]
  const g = d[i + 1]
  const b = d[i + 2]
  if (luma(i) > 60) return false
  // 冷色：蓝 >= 红，且不是纯黑（纯黑是椅子阴影）
  return b >= r - 6 && b > 14
}

/** 找连通块（4 邻域）。 */
function components(bounds) {
  const { x0, y0, x1, y1 } = bounds
  const seen = new Set()
  const out = []
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const key = y * W + x
      if (seen.has(key) || !isScreenPixel(x, y)) continue
      const stack = [[x, y]]
      seen.add(key)
      const pts = []
      while (stack.length) {
        const [cx, cy] = stack.pop()
        pts.push([cx, cy])
        const nbrs = [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]
        for (const [nx, ny] of nbrs) {
          if (nx < x0 || nx >= x1 || ny < y0 || ny >= y1) continue
          const nk = ny * W + nx
          if (seen.has(nk) || !isScreenPixel(nx, ny)) continue
          seen.add(nk)
          stack.push([nx, ny])
        }
      }
      out.push(pts)
    }
  }
  return out
}

/** 在给定带里找所有屏幕块，返回 bbox + 形状。 */
function findScreensInBand(y0, y1, minArea) {
  const cs = components({ x0: 0, y0, x1: W, y1 })
    .filter((pts) => pts.length >= minArea)
    .map((pts) => {
      const xs = pts.map((p) => p[0])
      const ys = pts.map((p) => p[1])
      return {
        n: pts.length,
        x: Math.min(...xs),
        y: Math.min(...ys),
        w: Math.max(...xs) - Math.min(...xs) + 1,
        h: Math.max(...ys) - Math.min(...ys) + 1,
        pts,
      }
    })
    .sort((a, b) => a.y - b.y || a.x - b.x)
  return cs
}

// --- 主工位：双屏整体作为一块（中间立柱在 mask 里天然是空的） ---
const mainBlocks = findScreensInBand(80, 140, 400)
console.log('主工位屏幕块:', mainBlocks.map((b) => `${b.n}px ${b.x},${b.y} ${b.w}x${b.h}`))

// --- 副工位：三排，每排四块 ---
const subBlocks = findScreensInBand(195, 340, 80).filter((b) => b.h >= 10)
console.log('副工位屏幕块数:', subBlocks.length)
for (const b of subBlocks) console.log(`  ${b.n}px ${b.x},${b.y} ${b.w}x${b.h}`)

/** 把一块的 pts 写成 mask RGBA（白=可见，其余透明），尺寸=该块 bbox。 */
function maskFor(block) {
  const buf = Buffer.alloc(block.w * block.h * 4)
  for (const [px, py] of block.pts) {
    const lx = px - block.x
    const ly = py - block.y
    const i = (ly * block.w + lx) * 4
    buf[i] = 255
    buf[i + 1] = 255
    buf[i + 2] = 255
    buf[i + 3] = 255
  }
  return buf
}

await fs.mkdir(path.join(P, 'scene/screens'), { recursive: true })

// 主屏：取"包含最多点"的那一块（双屏整体）
const mainBlock = mainBlocks.sort((a, b) => b.n - a.n)[0]
if (mainBlock) {
  await fs.writeFile(
    path.join(P, 'scene/screens/main-mask.png'),
    encodePNG(mainBlock.w, mainBlock.h, maskFor(mainBlock)),
  )
  console.log(`写 main-mask.png ${mainBlock.w}x${mainBlock.h}`)
}

// 副屏：按行分组（每排 y 接近的归一组），取第一排的四块做模板
const rowTops = {}
for (const b of subBlocks) {
  const bucket = Math.round(b.y / 10) * 10
  if (!rowTops[bucket]) rowTops[bucket] = []
  rowTops[bucket].push(b)
}
const firstRowKey = Object.keys(rowTops).map(Number).sort((a, b) => a - b)[0]
const firstRow = (rowTops[firstRowKey] || []).sort((a, b) => a.x - b.x)
console.log('第一排副屏 4 块:', firstRow.map((b) => `${b.x},${b.y} ${b.w}x${b.h}`))

if (firstRow.length) {
  // 用一个"合成"的 mask：因为是 4 块同形，取第 1 块即可
  const tpl = firstRow[0]
  await fs.writeFile(
    path.join(P, 'scene/screens/sub-mask.png'),
    encodePNG(tpl.w, tpl.h, maskFor(tpl)),
  )
  console.log(`写 sub-mask.png ${tpl.w}x${tpl.h}`)
}

// --- 输出几何表 ---
const geo = {
  $comment: '从息屏底图自动量出的屏幕可见面。亮屏时按 bbox 贴纹理、用 mask 抠形。',
  main: mainBlock
    ? { x: mainBlock.x, y: mainBlock.y, w: mainBlock.w, h: mainBlock.h }
    : null,
  sub: firstRow.length ? { x: firstRow[0].x, y: firstRow[0].y, w: firstRow[0].w, h: firstRow[0].h } : null,
  subRowOffsets: firstRow.map((b) => ({ dx: b.x - firstRow[0].x, dy: b.y - firstRow[0].y })),
}
console.log(JSON.stringify(geo, null, 2))
await fs.writeFile(path.join(P, 'scene/screens/geometry.json'), JSON.stringify(geo, null, 2) + '\n')
