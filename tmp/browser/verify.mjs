/**
 * 浏览器验收：用真 Chromium（Edge）跑 lib/client.js，验证三件事
 *
 *   A. 正常 rAF：面板挂载、无 4xx 资产、鱼走进来坐下、帧率正常。
 *   B. rAF 停摆（模拟无头/后台标签页）：把 requestAnimationFrame 换成永不回调，
 *      watchdog 兜底应该继续推进帧，动画不再冻住 —— 本次收尾的核心回归点。
 *   C. 帧链不重复注册：停摆恢复后不会出现几十个 loop 并发（rafPending 守卫）。
 *
 * 用法：node tmp/browser/verify.mjs [baseUrl]
 */
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] || 'http://127.0.0.1:8791/';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
function check(name, ok, detail) {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  ' + detail : ''));
  if (!ok) fails += 1;
}

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1400,900'],
});

/** 采集一次现场。 */
async function probe(page) {
  return page.evaluate(() => {
    const cv = document.querySelector('[data-po-stage] canvas');
    const w = window.__pixelOfficeWalk ? window.__pixelOfficeWalk() : null;
    return {
      hasRoot: !!document.querySelector('[data-pixel-office-root]'),
      canvas: cv ? [cv.width, cv.height] : null,
      jsErrs: (window.__errs || []).slice(-6),
      frames: w ? w.frames : null,
      now: w ? w.now : null,
      phase: w && w.act.main ? w.act.main.phase : null,
      winMain: w && w.win.main ? w.win.main : null,
      bubbles: document.querySelectorAll('[data-po-seat]').length,
    };
  });
}

// ---------- 场景 A：正常 rAF ----------
console.log('[A] 正常 rAF');
const pageA = await browser.newPage();
await pageA.setViewport({ width: 1400, height: 900 });
const bad = [];
pageA.on('response', (r) => { if (r.status() >= 400 && !r.url().endsWith('favicon.ico')) bad.push(r.status() + ' ' + r.url()); });
const jsA = [];
pageA.on('pageerror', (e) => jsA.push('pageerror: ' + e.message));
await pageA.goto(BASE, { waitUntil: 'load', timeout: 30000 });
// 启动默认是木牌（用户要求每次重启最小化）。卡片藏着时 stage 宽高为 0，
// 气泡拿不到几何就被跳过 —— 先点开成卡片，否则"气泡已渲染"这条永远 0。
await pageA.evaluate(() => {
  const sign = document.querySelector('[data-po-sign]');
  if (sign && sign.style.display !== 'none') sign.click();
});
await sleep(900);
const a1 = await probe(pageA);
await sleep(4000);
const a2 = await probe(pageA);
const aDf = (a2.frames ?? 0) - (a1.frames ?? 0);

check('面板根节点已挂载', a2.hasRoot);
check('舞台 canvas 存在', !!a2.canvas, JSON.stringify(a2.canvas));
check('无 4xx 资产请求', bad.length === 0, [...new Set(bad)].join(' | '));
check('无 JS 异常', jsA.length === 0 && a2.jsErrs.length === 0, JSON.stringify(jsA.concat(a2.jsErrs)));
check('帧在推进（4s > 30 帧）', aDf > 30, 'Δ=' + aDf + ' total=' + a2.frames);
check('帧率未暴走（4s < 600 帧）', aDf < 600, 'Δ=' + aDf);
check('主鱼入场完成并落座', a2.phase === 'seated' || a2.phase === 'working', 'phase=' + a2.phase);
check('在座气泡已渲染', a2.bubbles >= 1, 'seats=' + a2.bubbles);
check('入场窗口曾建立（走位数据）', a1.winMain !== null || a2.winMain !== null, JSON.stringify(a1.winMain || a2.winMain));

// ---------- 场景 B：rAF 停摆 ----------
console.log('[B] rAF 停摆（watchdog 兜底）');
const pageB = await browser.newPage();
await pageB.setViewport({ width: 1400, height: 900 });
await pageB.evaluateOnNewDocument(() => {
  window.__rafCalls = 0;
  // 先把原生 rAF 存下来，恢复时直接还原引用。
  // 早先这里用 delete window.requestAnimationFrame 想"还回原型上的真 rAF"，
  // 但 headless 里原生 rAF 是实例自有属性，delete 之后拿到的是别的实现，
  // 帧率回不到 60fps —— 那是测试手法的坑，不是产品的兜底失效。
  window.__realRaf = window.requestAnimationFrame.bind(window);
  window.__realCancel = window.cancelAnimationFrame.bind(window);
  window.requestAnimationFrame = function () { window.__rafCalls += 1; return 0; };
  window.cancelAnimationFrame = function () {};
});
const jsB = [];
pageB.on('pageerror', (e) => jsB.push('pageerror: ' + e.message));
await pageB.goto(BASE, { waitUntil: 'load', timeout: 30000 });
await sleep(1200);
const b1 = await probe(pageB);
await sleep(4000);
const b2 = await probe(pageB);
const bDf = (b2.frames ?? 0) - (b1.frames ?? 0);
const rafCalls = await pageB.evaluate(() => window.__rafCalls || 0);

// 停摆下 watchdog 每 120ms 检查一次、超过 300ms 无帧才补一帧 → 约 3 帧/秒
check('停摆仍在推进帧（4s ≥ 8 帧）', bDf >= 8, 'Δ=' + bDf + ' total=' + b2.frames);
check('停摆下主鱼仍完成落座', b2.phase === 'seated' || b2.phase === 'working', 'phase=' + b2.phase);
check('停摆下无 JS 异常', jsB.length === 0 && b2.jsErrs.length === 0, JSON.stringify(jsB.concat(b2.jsErrs)));
// 每 1s 最多复活一次帧链（作废旧回调 + 重排一条），不该无限增长
check('rAF 注册未暴增（≤ 8 次）', rafCalls <= 8, 'calls=' + rafCalls);

// ---------- 场景 C：停摆后恢复 ----------
console.log('[C] rAF 恢复后帧链能自动复活');
await pageB.evaluate(() => {
  // 把真 rAF 还回去（模拟标签页重新可见）
  if (window.__realRaf) window.requestAnimationFrame = window.__realRaf;
  if (window.__realCancel) window.cancelAnimationFrame = window.__realCancel;
});
const c0 = await probe(pageB);
await sleep(2500);
const c1 = await probe(pageB);
const cDf = (c1.frames ?? 0) - (c0.frames ?? 0);
// 复活窗口最多 1s，剩下 1.5s 应该跑回 60fps（约 90 帧）
check('恢复后帧率回到 60fps 量级（2.5s 内 60~400 帧）', cDf > 60 && cDf < 400, 'Δ=' + cDf);

await pageA.screenshot({ path: 'tmp/browser/shot-normal.png' });
await browser.close();
console.log(fails === 0 ? '\n结果: 全部通过' : '\n结果: ' + fails + ' 项失败');
process.exit(fails === 0 ? 0 : 1);
