// 面板交互实测：最小化按钮、标题条拖动、木牌展开。
//
// 与 panel-hostile.mjs 的分工：
//   panel.mjs          —— 正常宿主（无外来拦截层）下的基准行为
//   panel-hostile.mjs  —— 恶意宿主在 document 捕获阶段吞掉 pointerdown/click 时的兜底行为
//
// 用法：先起验收台，再 `node tmp\browser\panel.mjs`
//   Start-Process node tmp\harness-server.mjs 8791 -WindowStyle Hidden

import puppeteer from 'puppeteer-core'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const URL = 'http://127.0.0.1:8791/?act=probe'

let failures = 0
function check(name, ok, detail) {
  if (ok) console.log('  PASS  ' + name)
  else {
    failures += 1
    console.log('  FAIL  ' + name + (detail ? ' — ' + detail : ''))
  }
}

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  defaultViewport: { width: 420, height: 560 },
})

const page = await browser.newPage()
const errs = []
page.on('pageerror', (e) => errs.push(String(e)))
page.on('console', (m) => {
  if (m.type() !== 'error') return
  const t = m.text()
  // favicon 缺失是验收台自己的事，与插件无关
  if (t.indexOf('favicon') >= 0) return
  if (t.indexOf('Failed to load resource') >= 0) return
  errs.push('console: ' + t)
})

await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('[data-po-card]', { timeout: 15000 }).catch(() => {})
await new Promise((r) => setTimeout(r, 2500))

// 启动后默认是木牌（用户要求：每次重启最小化），先点开再跑拖动/最小化断言
const bootSign = await page.evaluate(() => {
  const sign = document.querySelector('[data-po-sign]')
  const card = document.querySelector('[data-po-card]')
  const root = document.querySelector('[data-pixel-office-root]')
  return {
    sign: sign ? sign.style.display : null,
    card: card ? card.style.display : null,
    left: root ? root.style.left : null,
    top: root ? root.style.top : null,
  }
})
check('重启后默认是木牌', bootSign.card === 'none' && bootSign.sign !== 'none', JSON.stringify(bootSign))
check(
  '木牌落在视口左上区域',
  parseFloat(bootSign.left) >= 0 && parseFloat(bootSign.left) < 400 && parseFloat(bootSign.top) >= 52,
  'left=' + bootSign.left + ' top=' + bootSign.top
)
await page.evaluate(() => {
  const sign = document.querySelector('[data-po-sign]')
  if (sign) sign.click()
})
await new Promise((r) => setTimeout(r, 900))

const exists = await page.evaluate(() => !!document.querySelector('[data-po-card]'))
check('面板卡片已挂载', exists, 'data-po-card 不存在')
if (!exists) {
  console.log('  errs: ' + errs.join(' | '))
  await browser.close()
  console.log('\n结果: 1 项失败')
  process.exit(1)
}

// --- 1. 初始位置与层级
const before = await page.evaluate(() => {
  const root = document.querySelector('[data-pixel-office-root]')
  const card = document.querySelector('[data-po-card]')
  const bar = document.querySelector('[data-po-bar]')
  return {
    left: root.style.left,
    top: root.style.top,
    cardDisplay: card.style.display,
    barRect: bar.getBoundingClientRect().toJSON(),
    rootPE: getComputedStyle(root).pointerEvents,
    rootZ: root.style.zIndex,
    ui: localStorage.getItem('dsh-pixel-office.ui'),
  }
})
console.log('       初始: left=' + before.left + ' top=' + before.top + ' rootZ=' + before.rootZ + ' rootPE=' + before.rootPE)
check('面板可接收指针事件', before.rootPE !== 'none', 'pointerEvents=' + before.rootPE)
check('面板层级足够高', Number(before.rootZ) >= 2147000000, 'zIndex=' + before.rootZ)
check('标题条有几何尺寸', before.barRect.width > 0 && before.barRect.height > 0, JSON.stringify(before.barRect))

// --- 2. 标题条中心点的命中链：bar 之前只能有它自己的内层元素
const chain = await page.evaluate(() => {
  const bar = document.querySelector('[data-po-bar]')
  const r = bar.getBoundingClientRect()
  return document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2).slice(0, 6).map((el) => {
    if (el.getAttribute && el.getAttribute('data-po-bar') !== null) return 'bar'
    if (el.getAttribute && el.getAttribute('data-pixel-office-root') !== null) return 'panel-root'
    if (el.getAttribute && el.getAttribute('data-po-card') !== null) return 'card'
    return el.tagName + '.' + String(el.className || '').slice(0, 30)
  })
})
const barAt = chain.indexOf('bar')
const foreign = chain.slice(0, barAt < 0 ? chain.length : barAt).filter((s) => s.indexOf('SPAN.') !== 0)
check('命中链里找得到标题条', barAt >= 0, chain.join(' > '))
check('标题条上方没有外来覆盖层', foreign.length === 0, '外来层=' + foreign.join(' | ') + ' 全链=' + chain.join(' > '))

// --- 3. 拖动标题条
const x0 = Math.round(before.barRect.left + before.barRect.width / 2)
const y0 = Math.round(before.barRect.top + before.barRect.height / 2)
await page.mouse.move(x0, y0)
await page.mouse.down()
for (let i = 1; i <= 10; i += 1) {
  await page.mouse.move(x0 - i * 8, y0 + i * 6)
  await new Promise((r) => setTimeout(r, 16))
}
await page.mouse.up()
await new Promise((r) => setTimeout(r, 400))

const afterDrag = await page.evaluate(() => {
  const root = document.querySelector('[data-pixel-office-root]')
  return { left: root.style.left, top: root.style.top, ui: localStorage.getItem('dsh-pixel-office.ui') }
})
console.log('       拖动后: left=' + afterDrag.left + ' top=' + afterDrag.top)
check('拖动改变了面板位置', afterDrag.left !== before.left || afterDrag.top !== before.top, before.left + ',' + before.top + ' → ' + afterDrag.left + ',' + afterDrag.top)
check('拖动结果写进 localStorage', !!(afterDrag.ui && afterDrag.ui.indexOf('"x"') >= 0), afterDrag.ui)

// --- 4. 点最小化按钮
const minBox = await page.evaluate(() => {
  const bar = document.querySelector('[data-po-bar]')
  if (!bar) return null
  const btns = bar.querySelectorAll('button')
  const b = btns[btns.length - 1]
  if (!b) return null
  const r = b.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: b.textContent }
})
check('找到最小化按钮', !!minBox, JSON.stringify(minBox))
if (minBox) {
  await page.mouse.click(Math.round(minBox.x), Math.round(minBox.y))
  await new Promise((r) => setTimeout(r, 1200))
  const afterMin = await page.evaluate(() => {
    const card = document.querySelector('[data-po-card]')
    const sign = document.querySelector('[data-po-sign]')
    return { cardDisplay: card.style.display, signDisplay: sign.style.display, ui: localStorage.getItem('dsh-pixel-office.ui') }
  })
  console.log('       最小化后: card=' + afterMin.cardDisplay + ' sign=' + afterMin.signDisplay)
  check('最小化后卡片隐藏', afterMin.cardDisplay === 'none', 'cardDisplay=' + afterMin.cardDisplay)
  check('最小化后木牌出现', afterMin.signDisplay === 'block', 'signDisplay=' + afterMin.signDisplay)
  check('最小化状态已持久化', !!(afterMin.ui && afterMin.ui.indexOf('"minimized":true') >= 0), afterMin.ui)

  // --- 5. 点木牌展开
  const signBox = await page.evaluate(() => {
    const sign = document.querySelector('[data-po-sign]')
    if (!sign) return null
    const r = sign.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  if (signBox) {
    await page.mouse.click(Math.round(signBox.x), Math.round(signBox.y))
    await new Promise((r) => setTimeout(r, 1200))
    const afterExpand = await page.evaluate(() => {
      const card = document.querySelector('[data-po-card]')
      return { cardDisplay: card.style.display, ui: localStorage.getItem('dsh-pixel-office.ui') }
    })
    console.log('       展开后: card=' + afterExpand.cardDisplay)
    check('点木牌能展开回来', afterExpand.cardDisplay === 'flex', 'cardDisplay=' + afterExpand.cardDisplay)
  } else {
    check('找到木牌位置', false, 'data-po-sign 无几何')
  }
}

check('无 JS 异常', errs.length === 0, errs.join(' | '))

await browser.close()
console.log(failures === 0 ? '\n结果: 全部通过' : '\n结果: ' + failures + ' 项失败')
process.exit(failures === 0 ? 0 : 1)
