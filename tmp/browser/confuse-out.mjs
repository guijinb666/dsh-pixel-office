// 画布外懵逼动画验收（m03550 第 12 条）：
// 把副鱼拖到画布外松手，断言它在画布外也抖动 + 冒问号，持续约 1 秒后才往回走。
//
// 这三样全是纯 canvas 绘制（stage canvas 会裁掉越界像素，画布外那份画在
// 全屏浮层上），DOM 里没有任何节点可断言，所以靠 __pixelOfficeWalk() 暴露的
// skyShake / skyGlyph 计数 + 每条鱼自己的 act.phase / act.shake 来验。
//
// 用法：先起验收台，再 `node tmp\browser\confuse-out.mjs`
import puppeteer from 'puppeteer-core'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const BASE = 'http://127.0.0.1:8791/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let fails = 0
function check(name, ok, detail) {
  if (ok) console.log('  PASS  ' + name)
  else {
    fails += 1
    console.log('  FAIL  ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail)))
  }
}

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1400,1000'],
})
const p = await browser.newPage()
await p.setViewport({ width: 1200, height: 900, deviceScaleFactor: 1 })
const jsErrs = []
p.on('pageerror', (e) => jsErrs.push(String(e.message)))
await p.evaluateOnNewDocument(() => {
  try { localStorage.clear() } catch (e) { }
})
await p.goto(BASE, { waitUntil: 'load', timeout: 30000 })

// 默认是木牌，先展开
await p.waitForSelector('[data-po-sign]', { timeout: 20000 })
await p.evaluate(() => {
  const s = document.querySelector('[data-po-sign]')
  if (s && s.style.display !== 'none') s.click()
})
await p.waitForFunction(
  () => {
    const st = document.querySelector('[data-po-stage]')
    const c = st && st.querySelector('canvas')
    if (!c) return false
    const r = c.getBoundingClientRect()
    return r.width > 10 && r.height > 10
  },
  { timeout: 20000, polling: 100 }
)
// 等入场走完（主鱼 + 副鱼都落座），否则抓不到副鱼
await p.waitForFunction(
  () => {
    const w = window.__pixelOfficeWalk && window.__pixelOfficeWalk()
    return w && Object.keys(w.win || {}).length === 0
  },
  { timeout: 45000, polling: 250 }
).catch(() => {})
await sleep(1200)

// 找一条副鱼，用它的逻辑座位坐标换算成视口坐标
const target = await p.evaluate(() => {
  const st = document.querySelector('[data-po-stage]')
  const c = st.querySelector('canvas')
  const r = c.getBoundingClientRect()
  const doc = window.__pixelOfficeWalk().doc
  void doc
  const seats = ['sub:0', 'sub:1', 'sub:2']
  const boxes = window.__pixelOfficeDebug ? null : null
  void boxes
  // 直接用 client 暴露的命中探测：__pixelOfficeDebug(lx, ly) 需要逻辑坐标。
  // 逻辑坐标 → 视口：stage canvas 的 CSS 尺寸与 320×431 等比。
  const sx = r.width / c.width
  const sy = r.height / c.height
  const res = []
  for (let i = 0; i < 12; i += 1) {
    const id = 'sub:' + i
    // seats.json 里 sub 的 walkLaneX 与 seated.y 已知；直接用 seated 探一遍
    const probe = window.__pixelOfficeWalk().act[id]
    if (probe && probe.phase === 'seated') {
      // 猜：x 从 seats.json 的 seated 拿不到，改用二分探测太慢；
      // 直接遍历整条工位行扫一遍命中
      res.push(id)
    }
  }
  return { sx, sy, cardRect: r, seatedSubs: res }
})
void target

// 直接对每条在座的副鱼做一次「按下 → 拖到画布外 → 松手」，看状态机
async function dragOut(seatId) {
  // 用画面上真实存在的位置：让 client 自己报包围盒。
  // ⚠️ __pixelOfficeDebug 的 `box` 恒指主鱼，副鱼在 `boxes[seatId]` 里。
  const box = await p.evaluate((id) => {
    const st = document.querySelector('[data-po-stage]')
    const c = st.querySelector('canvas')
    const r = c.getBoundingClientRect()
    const sx = r.width / c.width
    const sy = r.height / c.height
    for (let ly = 0; ly <= c.height; ly += 2) {
      for (let lx = 0; lx <= c.width; lx += 2) {
        const hit = window.__pixelOfficeDebug(lx, ly)
        if (hit && hit.hit === id) {
          const b = hit.boxes && hit.boxes[id]
          if (!b) return null
          return {
            x: r.left + b.x * sx,
            y: r.top + b.y * sy,
            w: b.w * sx,
            h: b.h * sy,
          }
        }
      }
    }
    return null
  }, seatId)
  if (!box) return null

  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  await p.mouse.move(cx, cy)
  await p.mouse.down()
  await sleep(60)
  // 拖到画布上方外（视口 y 很小的地方，逻辑 y 为负）
  const outX = box.x + box.w / 2
  const outY = Math.max(6, box.y - 260)
  for (let i = 1; i <= 8; i += 1) {
    await p.mouse.move(outX + i * 6, cy + (outY - cy) * (i / 8))
    await sleep(30)
  }
  await sleep(120)
  await p.mouse.up()
  return box
}

const out = await dragOut('sub:1')
check('找到一条副鱼并把它拖出画布', !!out, out)

// 松手后立刻进 confused：采样 3 次确认抖动与问号都在画布外发生
await sleep(160)
const s1 = await p.evaluate(() => {
  const w = window.__pixelOfficeWalk()
  const a = w.act['sub:1'] || null
  return { phase: a && a.phase, pos: a && a.pos, shake: a && a.shake, glyph: a && a.glyph, skyShake: w.skyShake, skyGlyph: w.skyGlyph }
})
check('松手后进入 confused', s1.phase === 'confused', s1.phase)
check('落点在画布外（逻辑 y<0 或 x<0 或超出 320x431）', !!s1.pos && (s1.pos.x < 0 || s1.pos.y < 0 || s1.pos.x > 320 || s1.pos.y > 431), s1.pos)
check('画布外那一帧确实画了抖动（skyShake>0）', (s1.skyShake || 0) > 0, s1.skyShake)
check('画布外那一帧确实画了头顶符号（skyGlyph>0）', (s1.skyGlyph || 0) > 0, s1.skyGlyph)
check('符号是问号', s1.glyph === 'question', s1.glyph)
check('shackUntil 还剩时间（抖 1 秒）', (s1.shake || 0) > 300, s1.shake)

// 1 秒后应该结束懵逼、开始走回
await sleep(1300)
const s2 = await p.evaluate(() => {
  const w = window.__pixelOfficeWalk()
  const a = w.act['sub:1'] || null
  return { phase: a && a.phase, glyph: a && a.glyph, path: a && a.path }
})
check('懵逼结束后开始回程（walkhome/reenter）', s2.phase === 'walkhome' || s2.phase === 'reenter', s2.phase)
check('回程有折线（不是瞬移）', !!s2.path && s2.path.length >= 2, s2.path && s2.path.length)

check('没有 JS 异常', jsErrs.length === 0, jsErrs)

await browser.close()
console.log('结果: ' + (fails === 0 ? '全部通过' : fails + ' 项失败'))
process.exit(fails === 0 ? 0 : 1)
