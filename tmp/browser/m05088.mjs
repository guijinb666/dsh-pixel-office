// m05088 五条修复的针对性验收（先起验收台：node tmp\harness-server.mjs 8791）。
//
// 全部靠 __pixelOfficeWalk().act[k].frame 断言「这一帧用的是哪张图、多大、拉高多少」，
// 因为坐地帧/正面行走帧/等比归一化都是纯 canvas 绘制，截图看不出文件名。
//
// 用法：node tmp\browser\m05088.mjs
import puppeteer from 'puppeteer-core'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const BASE = 'http://127.0.0.1:8791/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let fails = 0
let passes = 0
function check(name, ok, detail) {
  if (ok) { passes += 1; console.log('  PASS  ' + name) } else {
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
await p.evaluateOnNewDocument(() => { try { localStorage.clear() } catch (e) { } })
await p.goto(BASE, { waitUntil: 'load', timeout: 30000 })

// 默认最小化成木牌，先展开
await p.waitForSelector('[data-po-sign]', { timeout: 20000 })
await p.evaluate(() => {
  const s = document.querySelector('[data-po-sign]')
  if (s && s.style.display !== 'none') s.click()
})
await p.waitForFunction(() => {
  const st = document.querySelector('[data-po-stage]')
  const c = st && st.querySelector('canvas')
  if (!c) return false
  const r = c.getBoundingClientRect()
  return r.width > 10 && r.height > 10
}, { timeout: 20000, polling: 100 })
// 等全员落座
await p.waitForFunction(() => {
  const w = window.__pixelOfficeWalk && window.__pixelOfficeWalk()
  return w && Object.keys(w.win || {}).length === 0
}, { timeout: 45000, polling: 250 })
await sleep(600)

const walk = () => p.evaluate(() => window.__pixelOfficeWalk())
const boxes = () => p.evaluate(() => {
  const st = document.querySelector('[data-po-stage]')
  const cv = st && st.querySelector('canvas')
  const r = cv.getBoundingClientRect()
  // 逻辑坐标 → 视图坐标：debug 钩子给的是逻辑矩形，这里按画布缩放映射
  const dbg = window.__pixelOfficeDebug
  return { rect: { x: r.x, y: r.y, w: r.width, h: r.height }, dbg: dbg ? true : false }
})
// 用 __pixelOfficeDebug 的 boxes 拿每个席位的逻辑矩形，再换算成屏幕坐标
async function seatBox(seatId) {
  const meta = await p.evaluate((sid) => {
    const cv = document.querySelector('[data-po-stage] canvas')
    const r = cv.getBoundingClientRect()
    // 逐个逻辑像素以 8 为步长扫，找命中该席位的点 —— 简单可靠，画布只有 320×431
    for (let ly = 0; ly < 431; ly += 4) {
      for (let lx = 0; lx < 320; lx += 4) {
        const d = window.__pixelOfficeDebug(lx, ly)
        if (d && d.boxes && d.boxes[sid]) {
          // 命中即可反推该席位矩形；命中点必在矩形内
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
  return {
    // 点取矩形中心（垂直到身体中部，避免点到头顶符号位置）
    x: meta.cr.x + (meta.lx + meta.w / 2) * sx,
    y: meta.cr.y + (meta.ly + meta.h * 0.55) * sy,
    logical: meta,
  }
}

console.log('\n[1] 副鱼帧高归一化（m05088 第 3 条：拖动不再缩小）')
// 取三条副鱼在 seated 状态下的帧高与拉伸系数，比较「拉高后有效高度」
const seated = await walk()
const subIds = Object.keys(seated.act).filter((k) => k !== 'main' && seated.act[k].frame)
// 归一化基准 = 该皮肤背面帧自身高度，所以 seated 态（背面帧）ny 必然 = 1。
// 想验「矮帧被拉高」必须在**换成非基准帧**的时候看（懵逼正面帧 / 正面行走帧），
// 原断言写成「seated 时至少一条 ny>1」是从原理上就永远不成立的测试错误。
const backH = {}
subIds.forEach((k) => { backH[k] = seated.act[k].frame.h })
console.log('    背面基准高 ' + JSON.stringify(backH) + '  帧 ' +
  JSON.stringify(subIds.map((k) => seated.act[k].frame.file)))
check('至少 3 条副鱼可观测', subIds.length >= 3, subIds)
check('基准态（背面帧）ny 恒为 1', subIds.every((k) => seated.act[k].frame.ny === 1),
  subIds.map((k) => seated.act[k].frame.ny))

console.log('\n[2] 副鱼拖出 → 懵逼 → 转正面（m05088 第 2 条）')
const target = subIds.find((k) => k !== 'sub:0') || subIds[0]
const tb = await seatBox(target)
check('找到目标副鱼 ' + target, !!tb, tb && tb.logical)
if (tb) {
  await p.mouse.move(tb.x, tb.y)
  await p.mouse.down()
  for (let i = 1; i <= 10; i += 1) {
    await p.mouse.move(tb.x + i * 6, tb.y - i * 22)
    await sleep(18)
  }
  const dragging = await walk()
  check('拖动中已切背面（不在拖动时露正面）', dragging.act[target].facing === 'back', dragging.act[target].facing)
  await p.mouse.up()
  await sleep(160)
  const confused = await walk()
  check('松手进入懵逼', confused.act[target].phase === 'confused', confused.act[target].phase)
  check('懵逼时已转正面（第 2 条核心）', confused.act[target].facing === 'front', confused.act[target].facing)
  check('懵逼时头顶冒问号', confused.act[target].glyph === 'question', confused.act[target].glyph)
  check('懵逼时仍在抖', confused.act[target].shake > 300, confused.act[target].shake)
  await sleep(1400)
  const after = await walk()
  check('1 秒后开始往回走', ['walkhome', 'reenter'].includes(after.act[target].phase), after.act[target].phase)
  check('往回走时有折线', (after.act[target].path || []).length >= 2, (after.act[target].path || []).length)
  // 等回到座位
  await p.waitForFunction((sid) => {
    const w = window.__pixelOfficeWalk()
    return w && w.act[sid] && w.act[sid].phase === 'seated'
  }, { timeout: 25000, polling: 200 }, target).catch(() => { })
  const back = await walk()
  check('回到座位 seated', back.act[target].phase === 'seated', back.act[target].phase)
}

console.log('\n[3] 主鱼空格拖拽 → 坐地帧（m05088 第 1 条）')
const mb = await seatBox('main')
check('找到主鱼', !!mb, mb && mb.logical)
if (mb) {
  await p.keyboard.down('Space')
  await sleep(80)
  await p.mouse.move(mb.x, mb.y)
  await p.mouse.down()
  for (let i = 1; i <= 8; i += 1) {
    await p.mouse.move(mb.x + i * 10, mb.y + i * 12)
    await sleep(18)
  }
  await p.mouse.up()
  await sleep(200)
  await p.keyboard.up('Space')
  await sleep(200)
  const esc = await walk()
  check('主鱼进入彩蛋待机（esc）', esc.act.main.esc === true, esc.act.main.esc)
  check('主鱼 phase=seated', esc.act.main.phase === 'seated', esc.act.main.phase)
  const fr = esc.act.main.frame
  check('用的是人形坐地帧 main-floor.png（第 1 条核心）', !!fr && fr.file === 'main-floor.png', fr)
  check('坐地帧被识别为 onFloor', !!fr && fr.onFloor === true, fr && fr.onFloor)
  check('坐地帧不做等比拉高（本来就该矮）', !!fr && fr.ny === 1, fr && fr.ny)
  check('坐地帧朝向为正面', esc.act.main.facing === 'front', esc.act.main.facing)
}

console.log('\n[4] 副鱼正面行走帧（m05088 第 5 条）')
// 关键是造出一条**足够长的朝下走段**，否则抓不到。
// reenter 第一段是「从落点竖直落到出画线 exitY(=scene.h+6)」：
//   - 拖到画布**下方**外侧 → 落点已接近 exitY，这段只有几像素、几毫秒就过去（原来是这么写的，永远抓不到）；
//   - 拖到画布**上方**外侧 → 落点 y<0，这段有近一整个画布高度，dir='down' 且持续 1.5s 以上。
const t2 = subIds.find((k) => k !== target) || subIds[0]
const tb2 = await seatBox(t2)
check('找到第二条副鱼 ' + t2, !!tb2, tb2 && tb2.logical)
if (tb2) {
  await p.mouse.move(tb2.x, tb2.y)
  await p.mouse.down()
  for (let i = 1; i <= 14; i += 1) {
    await p.mouse.move(tb2.x - i * 6, tb2.y - i * 26)
    await sleep(16)
  }
  await p.mouse.up()
  // 高频抓 walkDir==='down' 那一帧（长段持续 ~1.5s，80ms 一采样足够）
  let hit = null
  let seen = []
  for (let i = 0; i < 130; i += 1) {
    const w = await walk()
    const f = w.act[t2] && w.act[t2].frame
    if (f && f.walking) {
      seen.push(w.act[t2].phase + ':' + f.file)
      if (/-walkfront\.png$/.test(f.file)) { hit = { f, phase: w.act[t2].phase }; break }
    }
    await sleep(80)
  }
  check('朝下走时取到正面行走帧 *-walkfront.png（第 5 条核心）', !!hit, hit || seen.slice(0, 12))
  if (hit) console.log('    ' + JSON.stringify(hit))
  // 顺带验第 3 条的正反两面：
  //   subFrameNorm 只放大不压缩（上限 1.6），所以
  //   - 帧比背面基准**矮** → ny>1，拉到基准高（这才是用户说的"缩小"要修的情形）
  //   - 帧比背面基准**高** → ny=1，不压缩，脚底交给 walkFootFix 对齐
  if (hit) {
    const bh = backH[t2]
    if (hit.f.h < bh) {
      const eff = Math.round(hit.f.h * hit.f.ny)
      check('矮于基准的帧被拉高到基准高（第 3 条）',
        hit.f.ny > 1 && Math.abs(eff - bh) <= 2,
        { backH: bh, frameH: hit.f.h, ny: hit.f.ny, eff })
    } else {
      check('高于基准的帧不做压缩、交由 walkFootFix 对齐（第 3 条）',
        hit.f.ny === 1,
        { backH: bh, frameH: hit.f.h, ny: hit.f.ny })
    }
  }
}

console.log('\n[5] 无 JS 异常')
check('无 JS 异常', jsErrs.length === 0, jsErrs.slice(0, 3))

console.log(`\nPASS=${passes} FAIL=${fails}`)
await browser.close()
process.exit(fails === 0 ? 0 : 1)
