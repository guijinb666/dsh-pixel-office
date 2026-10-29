// 诊断：为什么 confuse-out.mjs 拖不动副鱼。
// 逐步打印按下前 / 按下后 / 拖动中 / 松手后的 act 状态。
import puppeteer from 'puppeteer-core'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const BASE = 'http://127.0.0.1:8791/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1400,1000'],
})
const p = await browser.newPage()
await p.setViewport({ width: 1200, height: 900, deviceScaleFactor: 1 })
await p.evaluateOnNewDocument(() => { try { localStorage.clear() } catch (e) { } })
await p.goto(BASE, { waitUntil: 'load' })
await p.waitForSelector('[data-po-sign]')
await p.evaluate(() => { const s = document.querySelector('[data-po-sign]'); if (s.style.display !== 'none') s.click() })
await p.waitForFunction(() => {
  const c = document.querySelector('[data-po-stage] canvas')
  if (!c) return false
  const r = c.getBoundingClientRect()
  return r.width > 10 && r.height > 10
}, { timeout: 20000, polling: 100 })
await p.waitForFunction(() => Object.keys(window.__pixelOfficeWalk().win || {}).length === 0, { timeout: 45000, polling: 250 }).catch(() => { })
await sleep(1200)

const snap = () => p.evaluate(() => {
  const w = window.__pixelOfficeWalk()
  const a = w.act['sub:1'] || {}
  return { phase: a.phase, facing: a.facing, pos: a.pos, shake: a.shake, glyph: a.glyph, esc: a.esc, skyShake: w.skyShake, skyGlyph: w.skyGlyph, q: w.q.length, win: Object.keys(w.win).length }
})

// 扫 box
const box = await p.evaluate(() => {
  const c = document.querySelector('[data-po-stage] canvas')
  const r = c.getBoundingClientRect()
  const sx = r.width / c.width, sy = r.height / c.height
  for (let ly = 0; ly <= c.height; ly += 2) {
    for (let lx = 0; lx <= c.width; lx += 2) {
      const hit = window.__pixelOfficeDebug(lx, ly)
      if (hit && hit.hit === 'sub:1') {
        return { lx, ly, box: hit.box, sx, sy, rect: { left: r.left, top: r.top, w: r.width, h: r.height }, cvw: c.width, cvh: c.height }
      }
    }
  }
  return null
})
console.log('box =', JSON.stringify(box))
console.log('before  =', JSON.stringify(await snap()))

if (!box) { await browser.close(); process.exit(1) }

const cx = box.rect.left + (box.box.x + box.box.w / 2) * box.sx
const cy = box.rect.top + (box.box.y + box.box.h / 2) * box.sy
console.log('press at', cx, cy)

await p.mouse.move(cx, cy)
await p.mouse.down()
await sleep(80)
console.log('after down =', JSON.stringify(await snap()))

for (let i = 1; i <= 6; i += 1) {
  await p.mouse.move(cx + i * 4, cy - i * 40)
  await sleep(50)
}
console.log('after move =', JSON.stringify(await snap()))

await p.mouse.up()
await sleep(120)
console.log('after up   =', JSON.stringify(await snap()))
await sleep(400)
console.log('+400ms     =', JSON.stringify(await snap()))

await browser.close()
