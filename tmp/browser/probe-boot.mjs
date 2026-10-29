// 启动态诊断：卡片/木牌显隐、canvas 尺寸、是否进入 expand。
// 用途：d13 等剧本脚本在 waitForFunction(等待 canvas >10px) 超时时，先用它看清卡在哪。
import puppeteer from 'puppeteer-core';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const act = process.argv[2] || 'probe';
const BASE = 'http://127.0.0.1:8791/?act=' + act;

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  defaultViewport: { width: 420, height: 560 },
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

await page.goto(BASE, { waitUntil: 'load', timeout: 30000 });

function snap(tag) {
  return page.evaluate((t) => {
    const card = document.querySelector('[data-po-card]');
    const sign = document.querySelector('[data-po-sign]');
    const root = document.querySelector('[data-pixel-office-root]');
    const stage = document.querySelector('[data-po-stage]');
    const cv = stage && stage.querySelector('canvas');
    const r = cv ? cv.getBoundingClientRect() : null;
    return {
      t,
      card: card ? card.style.display : null,
      sign: sign ? sign.style.display : null,
      root: root ? root.style.left + ',' + root.style.top : null,
      stage: stage ? stage.style.display : null,
      cv: r ? Math.round(r.width) + 'x' + Math.round(r.height) : null,
      errs: (window.__errs || []).slice(-4),
    };
  }, tag);
}

for (const ms of [300, 800, 1500, 2500, 4000]) {
  await new Promise((r) => setTimeout(r, ms === 300 ? 300 : 500));
  console.log(JSON.stringify(await snap(ms + 'ms')));
}
console.log('jsErrs=' + JSON.stringify(errs.slice(-6)));
await browser.close();
