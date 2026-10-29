// m05088 三样目视验证截图：主鱼坐地、副鱼懵逼转正面、副鱼正面走路。
// 用法：node tmp\browser\shots-m05088.mjs   → 输出到 tmp\shots-m05088\
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const BASE = 'http://127.0.0.1:8791/'
const OUT = 'tmp/shots-m05088'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
fs.mkdirSync(OUT, { recursive: true })

const browser = await puppeteer.launch({
  executablePath: EDGE, headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1400,1000'],
})
const p = await browser.newPage()
await p.setViewport({ width: 1200, height: 900, deviceScaleFactor: 2 })
await p.evaluateOnNewDocument(() => { try { localStorage.clear() } catch (e) { } })
await p.goto(BASE, { waitUntil: 'load', timeout: 30000 })
await p.waitForSelector('[data-po-sign]', { timeout: 20000 })
await p.evaluate(() => { const s = document.querySelector('[data-po-sign]'); if (s && s.style.display !== 'none') s.click() })
await p.waitForFunction(() => {
  const c = document.querySelector('[data-po-stage] canvas')
  if (!c) return false
  const r = c.getBoundingClientRect()
  return r.width > 10 && r.height > 10
}, { timeout: 20000, polling: 100 })
await p.waitForFunction(() => {
  const w = window.__pixelOfficeWalk && window.__pixelOfficeWalk()
  return w && Object.keys(w.win || {}).length === 0
}, { timeout: 45000, polling: 250 })
await sleep(800)

const walk = () => p.evaluate(() => window.__pixelOfficeWalk())
// 只截 canvas + 弹层所在的 stage，避免整页太杂
async function shotCanvas(name) {
  const el = await p.$('[data-po-stage]')
  await el.screenshot({ path: `${OUT}/${name}.png` })
  console.log('  shot ' + name + '.png')
}
async function seatBox(seatId) {
  const meta = await p.evaluate((sid) => {
    const cv = document.querySelector('[data-po-stage] canvas')
    const r = cv.getBoundingClientRect()
    for (let ly = 0; ly < 431; ly += 4) {
      for (let lx = 0; lx < 320; lx += 4) {
        const d = window.__pixelOfficeDebug(lx, ly)
        if (d && d.boxes && d.boxes[sid]) {
          const b = d.boxes[sid]
          return { lx: b.x, ly: b.y, w: b.w, h: b.h, cr: { x: r.x, y: r.y, w: r.width, h: r.height } }
        }
      }
    }
    return null
  }, seatId)
  if (!meta) return null
  const sx = meta.cr.w / 320
  const sy = meta.cr.h / 431
  return { x: meta.cr.x + (meta.lx + meta.w / 2) * sx, y: meta.cr.y + (meta.ly + meta.h * 0.55) * sy }
}

console.log('[A] 主鱼坐地')
const mb = await seatBox('main')
if (mb) {
  await p.keyboard.down('Space'); await sleep(80)
  await p.mouse.move(mb.x, mb.y); await p.mouse.down()
  for (let i = 1; i <= 8; i += 1) { await p.mouse.move(mb.x + i * 9, mb.y + i * 11); await sleep(18) }
  await p.mouse.up(); await sleep(250); await p.keyboard.up('Space'); await sleep(350)
  console.log('    ' + JSON.stringify((await walk()).act.main.frame))
  await shotCanvas('A-main-floor')
  // 退出彩蛋：再按一次空格拖一下放回来
  await p.keyboard.down('Space'); await sleep(60)
  await p.mouse.move(mb.x, mb.y); await p.mouse.down(); await p.mouse.move(mb.x, mb.y + 4); await p.mouse.up()
  await p.keyboard.up('Space'); await sleep(400)
}

console.log('[B] 副鱼懵逼转正面')
const ids = Object.keys((await walk()).act).filter((k) => k !== 'main')
const t = ids[0]
const tb = await seatBox(t)
if (tb) {
  await p.mouse.move(tb.x, tb.y); await p.mouse.down()
  for (let i = 1; i <= 10; i += 1) { await p.mouse.move(tb.x + i * 6, tb.y - i * 20); await sleep(18) }
  await p.mouse.up()
  await sleep(260)
  console.log('    ' + t + ' phase=' + (await walk()).act[t].phase + ' facing=' + (await walk()).act[t].facing)
  await shotCanvas('B-sub-confuse-front')
  await sleep(2200)
}

console.log('[C] 副鱼正面走路（朝下）')
const ids2 = Object.keys((await walk()).act).filter((k) => k !== 'main')
const t2 = ids2.find((k) => k !== t) || ids2[0]
const tb2 = await seatBox(t2)
if (tb2) {
  await p.mouse.move(tb2.x, tb2.y); await p.mouse.down()
  for (let i = 1; i <= 14; i += 1) { await p.mouse.move(tb2.x - i * 6, tb2.y - i * 26); await sleep(16) }
  await p.mouse.up()
  let got = null
  for (let i = 0; i < 130; i += 1) {
    const w = await walk()
    const f = w.act[t2] && w.act[t2].frame
    if (f && f.walking && /-walkfront\.png$/.test(f.file)) { got = f; break }
    await sleep(70)
  }
  console.log('    ' + JSON.stringify(got))
  await shotCanvas('C-sub-walkfront')
}
await browser.close()
console.log('\n输出目录 ' + OUT)
