// 出「睡姿」截图：主鱼 + 副鱼全部 asleep，看侧蜷帧、头顶 zzz、气泡是否已隐藏。
//
// 睡姿是纯 canvas 绘制，DOM 里没有任何可断言的节点，只能靠图目视。
// harness 提供 /__sleep?on=1 把 /state 里的所有在座鱼切成 asleep。
//
// 用法：node tmp\browser\shot-sleep.mjs
import puppeteer from 'puppeteer-core';

const BASE = 'http://127.0.0.1:8791/';
const OUT = 'tmp/shots';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu'],
});

const p = await browser.newPage();
await p.setViewport({ width: 900, height: 900, deviceScaleFactor: 2 });
const jsErrs = [];
p.on('pageerror', (e) => jsErrs.push('pageerror: ' + e.message));

// 先打开睡姿开关，再进页面：client 一进页面就会拉 /state。
const sw = await p.evaluate(async (b) => {
  const r = await fetch(b + '__sleep?on=1');
  return await r.json();
}, BASE).catch(async () => {
  // about:blank 上不能 fetch 同源，先用 goto 拿到 origin 再切
  await p.goto(BASE, { waitUntil: 'domcontentloaded' });
  return await p.evaluate(async (b) => (await fetch(b + '__sleep?on=1')).json(), BASE);
});
console.log('sleep switch ->', JSON.stringify(sw));

await p.goto(BASE, { waitUntil: 'load', timeout: 30000 });

// 默认是木牌，点开
await p.waitForSelector('[data-po-sign]', { timeout: 20000 }).catch(() => {});
await p.evaluate(() => {
  const sign = document.querySelector('[data-po-sign]');
  if (sign && sign.style.display !== 'none') sign.click();
});
await p.waitForFunction(
  () => {
    const stage = document.querySelector('[data-po-stage]');
    const c = stage && stage.querySelector('canvas');
    if (!c) return false;
    const r = c.getBoundingClientRect();
    return r.width > 10 && r.height > 10;
  },
  { timeout: 20000, polling: 100 }
);

// 等入场折线走完（睡姿只在 seated 时才画得对）
await p.waitForFunction(
  () => {
    const w = window.__pixelOfficeWalk && window.__pixelOfficeWalk();
    return !!w && Object.keys(w.win || {}).length === 0;
  },
  { timeout: 45000, polling: 250 }
).catch(() => console.log('（入场等待超时，继续截图）'));

await sleep(1600);

const info = await p.evaluate(() => {
  const w = window.__pixelOfficeWalk && window.__pixelOfficeWalk();
  const bubbles = document.querySelectorAll('[data-po-scroll]');
  return {
    actMain: w && w.act && w.act.main ? { phase: w.act.main.phase, facing: w.act.main.facing } : null,
    subPhases: w && w.act ? Object.keys(w.act).filter((k) => k !== 'main').map((k) => k + ':' + w.act[k].phase) : [],
    bubbleCount: bubbles.length,
  };
});
console.log('state ->', JSON.stringify(info));

const card = await p.$('[data-po-card]');
await card.screenshot({ path: OUT + '/s1-sleep.png' });

// 再拍一张画家区域放大图（睡姿像素细节）
const cv = await p.$('[data-po-stage] canvas');
await cv.screenshot({ path: OUT + '/s2-sleep-canvas.png' });

// 关掉开关，恢复常动态
await p.evaluate(async (b) => { await fetch(b + '__sleep?on=0'); }, BASE);

console.log('jsErrs=' + JSON.stringify(jsErrs));
await browser.close();
