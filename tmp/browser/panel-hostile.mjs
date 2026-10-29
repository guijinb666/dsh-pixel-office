// 模拟真实 GUI 里"宿主吞掉 pointerdown"的场景，验证捕获阶段监听能救回来。
import puppeteer from 'puppeteer-core';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const URL = 'http://127.0.0.1:8791/?act=probe';
const pass = [];
const fail = [];
function check(name, ok, detail) {
  (ok ? pass : fail).push(name + (detail !== undefined ? ' — ' + detail : ''));
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail !== undefined ? ' — ' + detail : ''));
}

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  defaultViewport: { width: 420, height: 560 },
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));

// 在页面脚本之前装好"恶宿主"：在 document 捕获阶段吃掉所有指针事件。
// 这是最狠的拦截位置 —— 任何绑在元素自身（冒泡）或 document 冒泡的监听都收不到，
// 只有 window 捕获阶段（事件传播第一站）才能拿到。
await page.evaluateOnNewDocument(() => {
  window.__hostSwallowed = 0;
  const eat = (e) => {
    window.__hostSwallowed += 1;
    e.stopPropagation();
    e.stopImmediatePropagation();
  };
  document.addEventListener('pointerdown', eat, true);
  document.addEventListener('pointermove', eat, true);
  document.addEventListener('click', eat, true);
});

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-po-card]', { timeout: 15000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 2500));

const swallowedBefore = await page.evaluate(() => window.__hostSwallowed || 0);
console.log('交互前拦截次数（应为 0，尚未产生指针事件）:', swallowedBefore);

// 启动默认是木牌（用户要求每次重启最小化）。恶宿主会在 document 捕获阶段吞掉
// pointerdown/click，所以这里不能用 sign.click()，改用 mouse 直接点木牌中心 ——
// 走的是 window 捕获那条兜底路径，正好顺带验证它在恶宿主下也生效。
const bootSign = await page.evaluate(() => {
  const sign = document.querySelector('[data-po-sign]');
  const card = document.querySelector('[data-po-card]');
  if (!sign || sign.style.display === 'none') return null;
  const r = sign.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, card: card.style.display };
});
if (bootSign) {
  await page.mouse.click(Math.round(bootSign.x), Math.round(bootSign.y));
  await new Promise((r) => setTimeout(r, 900));
}
const expanded = await page.evaluate(() => document.querySelector('[data-po-card]').style.display);
check('恶宿主下点木牌也能展开', expanded !== 'none', 'card display=' + expanded);

const before = await page.evaluate(() => {
  const root = document.querySelector('[data-pixel-office-root]');
  const bar = document.querySelector('[data-po-bar]');
  return { left: root.style.left, top: root.style.top, bar: bar.getBoundingClientRect().toJSON() };
});

// --- 拖动
const bx = Math.round(before.bar.x + before.bar.width / 2);
const by = Math.round(before.bar.y + before.bar.height / 2);
await page.mouse.move(bx, by);
await page.mouse.down();
for (let i = 1; i <= 10; i += 1) {
  await page.mouse.move(bx - i * 12, by + i * 6);
  await new Promise((r) => setTimeout(r, 16));
}
await page.mouse.up();
await new Promise((r) => setTimeout(r, 300));

const afterDrag = await page.evaluate(() => {
  const root = document.querySelector('[data-pixel-office-root]');
  return { left: root.style.left, top: root.style.top };
});
check('宿主拦截下仍能拖动', before.left !== afterDrag.left || before.top !== afterDrag.top,
  before.left + ',' + before.top + ' → ' + afterDrag.left + ',' + afterDrag.top);

// --- 最小化
const btn = await page.evaluate(() => {
  const bar = document.querySelector('[data-po-bar]');
  const btns = Array.from(bar.querySelectorAll('button'));
  return btns.length ? btns[btns.length - 1].getBoundingClientRect().toJSON() : null;
});
if (btn) {
  await page.mouse.click(Math.round(btn.x + btn.width / 2), Math.round(btn.y + btn.height / 2));
  await new Promise((r) => setTimeout(r, 900));
}
const afterMin = await page.evaluate(() => {
  const card = document.querySelector('[data-po-card]');
  const sign = document.querySelector('[data-po-sign]');
  return { cardDisplay: card.style.display, signDisplay: sign.style.display };
});
check('宿主拦截下仍能最小化', afterMin.cardDisplay === 'none' && afterMin.signDisplay === 'block',
  JSON.stringify(afterMin));

// --- 展开（点木牌）
if (afterMin.signDisplay === 'block') {
  const sr = await page.evaluate(() => document.querySelector('[data-po-sign]').getBoundingClientRect().toJSON());
  await page.mouse.click(Math.round(sr.x + sr.width / 2), Math.round(sr.y + sr.height / 2));
  await new Promise((r) => setTimeout(r, 900));
  const afterExpand = await page.evaluate(() => {
    const card = document.querySelector('[data-po-card]');
    return card.style.display;
  });
  check('宿主拦截下仍能点木牌展开', afterExpand !== 'none', 'card display=' + afterExpand);
}

check('无 JS 异常', errs.length === 0, errs.join(' | ') || '0');

const swallowedAfter = await page.evaluate(() => window.__hostSwallowed || 0);
console.log('交互后拦截次数（>0 说明恶宿主确实在拦，测试不是空转）:', swallowedAfter);
check('恶宿主确实拦到了事件', swallowedAfter > 0, String(swallowedAfter));

console.log('\n结果: ' + (fail.length === 0 ? '全部通过' : fail.length + ' 项失败') + '（' + pass.length + ' 通过）');
await browser.close();
process.exit(fail.length === 0 ? 0 : 1);
