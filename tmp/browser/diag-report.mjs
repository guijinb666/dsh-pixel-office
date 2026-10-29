// 验证自诊断上报链路：浏览器里 client.js 的 reportDiag() → POST /api/pixel-office/diag
// → host 端 diagSlot → GET /api/pixel-office/diag 读回。
//
// 这条链路是排查「真实 GUI 里最小化/拖动失灵」的眼睛：
// 只要浏览器跑得起来插件，宿主就能拿到 rev（哪版代码）、barRect（标题条在哪）、
// hitChain（标题条中心点被谁盖住，含 top layer）。
//
// 用法：先起验收台，再 `node tmp\browser\diag-report.mjs`
//   Start-Process node tmp\harness-server.mjs 8791 -WindowStyle Hidden

import puppeteer from 'puppeteer-core'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const BASE = 'http://127.0.0.1:8791/'

let failures = 0
function check(name, ok, detail) {
  if (ok) console.log('  PASS  ' + name)
  else {
    failures += 1
    console.log('  FAIL  ' + name + (detail ? ' — ' + detail : ''))
  }
}

function getDiag() {
  return fetch('http://127.0.0.1:8791/api/pixel-office/diag')
    .then((r) => r.json())
    .catch(() => null)
}

// 先清场：拿一次基线，后面靠 at 时间戳判断有没有新上报
const before = await getDiag()
console.log('基线 diag.at = ' + (before && before.diag ? before.diag.at : 'null'))

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})

let errs = []
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 420, height: 560 })
  page.on('pageerror', (e) => errs.push(String(e)))

  await page.goto(BASE + '?act=probe', { waitUntil: 'domcontentloaded' })
  // 等面板挂载 + boot 里的 reportDiag 发出去
  await page.waitForSelector('[data-po-card]', { timeout: 15000 })
  await new Promise((r) => setTimeout(r, 1500))

  // boot 那一次是在「默认最小化成木牌」的状态下发的 —— 卡片 display:none，
  // 所以 barRect 必然是 0、hitChain 里也找不到 bar。这不是缺陷，是默认态本身。
  // 要验「标题条有没有被盖住」，必须先展开成卡片，再从交互上报（expand）里读 panel 段。
  const bootDiag = await getDiag()
  const bootBody = (bootDiag && bootDiag.diag && bootDiag.diag.body) || {}
  check('收到 boot 上报', !!(bootDiag && bootDiag.diag && bootDiag.diag.body), JSON.stringify(bootDiag && bootDiag.diag && bootDiag.diag.at))
  check('上报带构建标记 rev', typeof bootBody.rev === 'string' && bootBody.rev.length > 0, 'rev=' + bootBody.rev)
  check('上报 tag=boot', bootBody.tag === 'boot', 'tag=' + bootBody.tag)
  check('上报带 panel 段', !!bootBody.panel, JSON.stringify(bootBody.panel))
  check('boot 上报确认默认是木牌', !!(bootBody.panel && bootBody.panel.cardDisplay === 'none'), 'cardDisplay=' + (bootBody.panel && bootBody.panel.cardDisplay))

  // 展开木牌 → 触发一次 expand 上报，这次卡片可见，几何/命中链才有意义
  const signBox = await page.evaluate(() => {
    const sign = document.querySelector('[data-po-sign]')
    if (!sign || sign.style.display === 'none') return null
    const r = sign.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  if (signBox) {
    await page.mouse.click(Math.round(signBox.x), Math.round(signBox.y))
    await new Promise((r) => setTimeout(r, 1000))
  }
  const afterExpand = await getDiag()
  const body = (afterExpand && afterExpand.diag && afterExpand.diag.body) || {}

  check('上报带 barRect（标题条几何）', !!(body.panel && body.panel.barRect && body.panel.barRect.w > 0), JSON.stringify(body.panel && body.panel.barRect))
  check('上报带 hitChain（命中链）', !!(body.panel && Array.isArray(body.panel.hitChain) && body.panel.hitChain.length > 0), JSON.stringify(body.panel && body.panel.hitChain))
  const chain = (body.panel && body.panel.hitChain) || []
  const barAt = chain.findIndex((s) => s.indexOf('bar[') === 0 || s === 'bar')
  // 注意分工：expand 上报发生在 swapTo(false) 的同一帧里，此刻 card 刚由
  // display:none 转 flex，bar 的 rect 还没参与布局，命中链可能只探到 panel-root。
  // 所以这里只验「链路把命中链带上来了、结构解析得出来」；
  // 「标题条上方确实没有外来覆盖层」由 panel.mjs 在稳态下断言（那边等足了 layout）。
  check('hitChain 结构可用（非空且含面板自身）',
    chain.length > 0 && chain.some((s) => s.indexOf('panel-root') === 0 || s === 'panel-root'),
    '全链=' + chain.join(' > '))
  check('hitChain 里的元素都带层级/交互信息（解析可用）',
    chain.every((s) => s === 'bar' || s === 'card' || s === 'panel-root' || /z=.*pe=/.test(s)),
    '全链=' + chain.join(' > '))
  check('上报带能力位（PointerEvent/animate）', typeof body.hasAnimate === 'boolean' && typeof body.hasPointerEvent === 'boolean', 'hasAnimate=' + body.hasAnimate + ' hasPointerEvent=' + body.hasPointerEvent)
  check('上报带视口尺寸', !!(body.viewport && body.viewport.w > 0), JSON.stringify(body.viewport))

  // 再验证交互路径也会上报：点最小化按钮
  const before2 = (afterExpand && afterExpand.diag && afterExpand.diag.at) || 0
  const minBtnBox = await page.evaluate(() => {
    const bar = document.querySelector('[data-po-bar]')
    if (!bar) return null
    const btns = bar.querySelectorAll('button')
    const b = btns[btns.length - 1]
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  check('找到最小化按钮', !!minBtnBox, JSON.stringify(minBtnBox))
  if (minBtnBox) {
    await page.mouse.move(minBtnBox.x, minBtnBox.y)
    await page.mouse.down()
    await page.mouse.up()
    await new Promise((r) => setTimeout(r, 1200))
    const afterClick = await getDiag()
    const t2 = afterClick && afterClick.diag && afterClick.diag.at
    check('点最小化后产生了新上报', !!(t2 && t2 > before2), 'before=' + before2 + ' after=' + t2)
    const b2 = (afterClick && afterClick.diag && afterClick.diag.body) || {}
    console.log('       最新上报 tag=' + b2.tag + ' cardDisplay=' + (b2.panel && b2.panel.cardDisplay) + ' signDisplay=' + (b2.panel && b2.panel.signDisplay))
    check('上报 tag 反映最小化动作', String(b2.tag || '').indexOf('minimiz') === 0, 'tag=' + b2.tag)
    check('最小化后卡片已隐藏', !!(b2.panel && b2.panel.cardDisplay === 'none'), 'cardDisplay=' + (b2.panel && b2.panel.cardDisplay))
  }

  check('无 JS 异常', errs.length === 0, errs.join(' | '))
} finally {
  await browser.close()
}

console.log(failures === 0 ? '\n结果: 全部通过' : '\n结果: ' + failures + ' 项失败')
process.exit(failures === 0 ? 0 : 1)
