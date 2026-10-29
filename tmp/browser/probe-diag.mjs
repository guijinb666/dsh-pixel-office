/**
 * 最小排查：headless 环境下 ① rAF 是否在跑 ② pointerdown 是否到得了 canvas
 * ③ elementFromPoint 命中谁 ④ hitTest 是否命中 sub:0
 */
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] || 'http://127.0.0.1:8791/';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const HOOK = () => {
  window.__cd = 0;
  const p = CanvasRenderingContext2D.prototype;
  const o = p.drawImage;
  p.drawImage = function (img) { window.__cd += 1; return o.apply(this, arguments); };
};

const browser = await puppeteer.launch({
  executablePath: EDGE, headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1400,1000'],
  defaultViewport: { width: 1400, height: 1000 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.evaluateOnNewDocument(HOOK);
await page.goto(BASE, { waitUntil: 'load' });

await page.waitForFunction(() => {
  const w = window.__pixelOfficeWalk && window.__pixelOfficeWalk();
  return w && w.act && w.act.main && ['seated', 'working', 'idle'].includes(w.act.main.phase);
}, { timeout: 40000 });
await new Promise((r) => setTimeout(r, 1500));

const info = await page.evaluate(() => {
  const w = window.__pixelOfficeWalk();
  const cv = document.querySelector('[data-po-stage] canvas');
  const r = cv.getBoundingClientRect();
  const d = window.__pixelOfficeDebug ? window.__pixelOfficeDebug(72, 229) : null;
  return {
    vis: document.visibilityState, hidden: document.hidden,
    frames: w.frames, lastTs: w.lastTs, drawCalls: window.__cd,
    canvasCount: document.querySelectorAll('canvas').length,
    rect: { l: r.left, t: r.top, w: r.width, h: r.height },
    debug: d && { hit: d.hit, why: d.why, box0: d.boxes['sub:0'] },
    errs: (window.__errs || []).slice(-6),
  };
});
console.log(JSON.stringify(info, null, 2));

// frames 是否增长
const f1 = await page.evaluate(() => window.__pixelOfficeWalk().frames);
await new Promise((r) => setTimeout(r, 700));
const f2 = await page.evaluate(() => window.__pixelOfficeWalk().frames);
console.log('frames', f1, '->', f2, ' rAF alive =', f2 > f1);

// 命中测试：拿到 screen 坐标后问 elementFromPoint
const pt = await page.evaluate(() => {
  const cv = document.querySelector('[data-po-stage] canvas');
  const r = cv.getBoundingClientRect();
  const x = r.left + 72 * (r.width / 320);
  const y = r.top + 229 * (r.height / 431);
  const el = document.elementFromPoint(x, y);
  return { x, y, tag: el && el.tagName, cls: el && el.className, isCanvas: el === cv };
});
console.log('elementFromPoint:', JSON.stringify(pt));

// 派发 pointerdown 看命中
const down = await page.evaluate((p) => {
  const cv = document.querySelector('[data-po-stage] canvas');
  const before = window.__pixelOfficeWalk().act['sub:0'].phase;
  cv.dispatchEvent(new PointerEvent('pointerdown', {
    clientX: p.x, clientY: p.y, pointerId: 1, button: 0,
    bubbles: true, cancelable: true, pointerType: 'mouse',
  }));
  const after = window.__pixelOfficeWalk().act['sub:0'].phase;
  return { before, after };
}, pt);
console.log('dispatch pointerdown on cv:', JSON.stringify(down));

await browser.close();
