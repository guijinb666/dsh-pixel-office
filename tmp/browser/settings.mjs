// P12 设置项验收：显隐 / 尺寸 / 速度 / 动画 / 持久化 / 重置
// 跑法：node tmp\browser\settings.mjs   （需先起 node tmp\harness-server.mjs 8791）
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://127.0.0.1:8791/';

let pass = 0;
let fail = 0;
function check(name, ok, extra) {
  if (ok) {
    pass += 1;
    console.log('  PASS ' + name + (extra ? '  ' + extra : ''));
  } else {
    fail += 1;
    console.log('  FAIL ' + name + (extra ? '  ' + extra : ''));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 860 });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e && e.message ? e.message : e)));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-po-card]', { timeout: 20000 });
await sleep(600);

// 启动后默认是木牌（用户要求：每次重启最小化），先展开成卡片再跑原有断言
const bootState = await page.evaluate(() => {
  const sign = document.querySelector('[data-po-sign]');
  const card = document.querySelector('[data-po-card]');
  const root = document.querySelector('[data-pixel-office-root]');
  return {
    sign: sign ? sign.style.display : null,
    card: card ? card.style.display : null,
    left: root ? root.style.left : null,
    top: root ? root.style.top : null,
  };
});
await page.evaluate(() => {
  const sign = document.querySelector('[data-po-sign]');
  if (sign) sign.click();
});
await sleep(900);

// 读一份当前设置态
async function snap() {
  return page.evaluate(() => {
    const card = document.querySelector('[data-po-card]');
    const stage = document.querySelector('[data-po-stage]');
    const settings = document.querySelector('[data-po-settings]');
    const bar = document.querySelector('[data-po-bar]');
    const btns = Array.from(bar.querySelectorAll('button')).map((b) => b.textContent);
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('dsh-pixel-office.settings') || 'null'); } catch (e) { saved = null; }
    return {
      cardW: Math.round(card.getBoundingClientRect().width),
      stageDisplay: stage ? getComputedStyle(stage).display : null,
      settingsOpen: settings ? settings.getAttribute('data-po-open') : null,
      settingsDisplay: settings ? getComputedStyle(settings).display : null,
      rows: settings ? settings.querySelectorAll('div').length : 0,
      btns,
      saved,
      left: card.style.left,
      top: card.style.top,
    };
  });
}

// 点设置按钮（标题条上带 ⚙ 的那个）
async function toggleSettings() {
  await page.evaluate(() => {
    const bar = document.querySelector('[data-po-bar]');
    const btns = Array.from(bar.querySelectorAll('button'));
    const b = btns[btns.length - 2]; // [dot][label][⚙][—]
    b.click();
  });
  await sleep(250);
}

// 点设置面板里某一行的第 n 个分段按钮
async function pickRow(rowIndex, valIndex) {
  await page.evaluate(({ rowIndex, valIndex }) => {
    const settings = document.querySelector('[data-po-settings]');
    const rows = Array.from(settings.children).filter((el) => el.querySelector('[data-po-val]'));
    const row = rows[rowIndex];
    const btns = Array.from(row.querySelectorAll('[data-po-val]'));
    btns[valIndex].click();
  }, { rowIndex, valIndex });
  await sleep(350);
}

console.log('[0] 启动默认态');
{
  check('重启后默认是木牌（卡片隐藏）', bootState.card === 'none' && bootState.sign !== 'none',
    JSON.stringify(bootState));
  check('木牌落在视口左上区域（x 小、y 避开标题栏带）',
    parseFloat(bootState.left) >= 0 && parseFloat(bootState.left) < 400 && parseFloat(bootState.top) >= 52,
    'left=' + bootState.left + ' top=' + bootState.top);
}

console.log('[1] 初始形态');
{
  const s = await snap();
  check('面板已挂载', s.cardW > 0, 'w=' + s.cardW);
  // dot 与 label 是 span，标题条上真正的 button 只有 ⚙ 与 —
  check('标题条上有 ⚙ 与 — 两个按钮', s.btns.length === 2, JSON.stringify(s.btns));
  check('设置面板默认收起', s.settingsOpen === '0' || s.settingsDisplay === 'none', 'open=' + s.settingsOpen);
  // 卡片没有 border-box，width:320 加上左右各 2px 边框 = 324
  check('默认卡片宽度 = 320', s.cardW >= 322 && s.cardW <= 326, 'w=' + s.cardW);
  check('默认场景可见', s.stageDisplay !== 'none', 'display=' + s.stageDisplay);
}

console.log('[2] 展开设置面板');
{
  await toggleSettings();
  const s = await snap();
  check('点 ⚙ 后设置面板展开', s.settingsOpen === '1', 'open=' + s.settingsOpen);
  check('展开后是 flex 布局', s.settingsDisplay === 'flex', 'display=' + s.settingsDisplay);
  check('四行设置项都在', s.rows >= 5, 'rows=' + s.rows);
}

console.log('[3] 尺寸档位');
{
  const widthOf = async () => (await snap()).cardW;
  const w0 = await widthOf();
  await pickRow(1, 3); // 特大 1.5
  const w1 = await widthOf();
  check('选「特大」后卡片变宽', w1 > w0 + 40, w0 + ' -> ' + w1);
  check('特大宽度 ≈ 320*1.5 = 480', w1 >= 476 && w1 <= 486, 'w=' + w1);

  await pickRow(1, 0); // 小 0.8
  const w2 = await widthOf();
  check('选「小」后卡片变窄', w2 < w0, w0 + ' -> ' + w2);
  check('小宽度 ≈ 320*0.8 = 256', w2 >= 252 && w2 <= 262, 'w=' + w2);

  await pickRow(1, 1); // 回标准
  const w3 = await widthOf();
  check('回「标准」恢复 320', w3 >= 322 && w3 <= 326, 'w=' + w3);
}

console.log('[4] 显隐');
{
  await pickRow(0, 1); // 关
  let s = await snap();
  check('选「关」后场景画布隐藏', s.stageDisplay === 'none', 'display=' + s.stageDisplay);
  check('关掉后标题条仍在（能再打开）', s.btns.length === 2, JSON.stringify(s.btns));
  check('关掉后设置面板仍在', s.settingsDisplay === 'flex', 'display=' + s.settingsDisplay);

  await pickRow(0, 0); // 开
  s = await snap();
  check('选「开」后场景画布恢复', s.stageDisplay !== 'none', 'display=' + s.stageDisplay);
}

console.log('[5] 速度与动画写入 localStorage');
{
  await pickRow(2, 2); // 快
  await pickRow(3, 1); // 动画关
  const s = await snap();
  check('localStorage 记下 speed=2', s.saved && s.saved.speed === 2, JSON.stringify(s.saved));
  check('localStorage 记下 animate=false', s.saved && s.saved.animate === false, JSON.stringify(s.saved));

  // 关动画后气泡应完全静止
  const anim = await page.evaluate(() => {
    const inner = document.querySelector('[data-po-scroll]');
    if (!inner) return null;
    const cs = getComputedStyle(inner);
    return { name: cs.animationName, state: cs.animationPlayState };
  });
  check('关动画后气泡滚动停止', anim === null || anim.name === 'none' || anim.state === 'paused',
    JSON.stringify(anim));
}

console.log('[6] 刷新后设置仍在');
{
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-po-card]', { timeout: 20000 });
  await sleep(800);
  // 刷新后同样是木牌态（每次启动都强制最小化），先点开再继续
  await page.evaluate(() => {
    const sign = document.querySelector('[data-po-sign]');
    if (sign) sign.click();
  });
  await sleep(900);
  await toggleSettings();
  const s = await snap();
  check('刷新后 speed 仍是 2', s.saved && s.saved.speed === 2, JSON.stringify(s.saved));
  check('刷新后 animate 仍是 false', s.saved && s.saved.animate === false, JSON.stringify(s.saved));
  // 关动画时不该有走路过程：入场 walkIns 应瞬间清空
  const win = await page.waitForFunction(
    () => {
      const w = window.__pixelOfficeWalk && window.__pixelOfficeWalk();
      return w && w.act && w.act.main ? w : null;
    },
    { timeout: 20000, polling: 200 }
  ).then((h) => h.jsonValue());
  check('关动画后主鱼直接落座（无入场折线）',
    !win || !win.path || win.path.length === 0,
    'path=' + JSON.stringify(win && win.path ? win.path.length : 0));
}

console.log('[7] 重置');
{
  await page.evaluate(() => {
    const settings = document.querySelector('[data-po-settings]');
    const btn = settings.querySelector('button:last-of-type');
    // 重置按钮在最后一行里，且是唯一的 button
    const rows = Array.from(settings.children);
    const last = rows[rows.length - 1];
    last.querySelector('button').click();
  });
  await sleep(400);
  const s = await snap();
  check('重置后 scale 回 1', s.saved && s.saved.scale === 1, JSON.stringify(s.saved));
  check('重置后 speed 回 1', s.saved && s.saved.speed === 1, JSON.stringify(s.saved));
  check('重置后 animate 回 true', s.saved && s.saved.animate === true, JSON.stringify(s.saved));
  check('重置后卡片宽度回 320', s.cardW >= 322 && s.cardW <= 326, 'w=' + s.cardW);
}

console.log('[8] 无 JS 异常');
{
  const bad = errs.filter((e) => !/favicon/i.test(e));
  check('页面无 JS 异常', bad.length === 0, bad.slice(0, 3).join(' | '));
}

console.log('');
console.log('PASS=' + pass + '  FAIL=' + fail);
await browser.close();
process.exit(fail ? 1 : 0);
