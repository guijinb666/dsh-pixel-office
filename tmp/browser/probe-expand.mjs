// 诊断 d13 的「点木牌 → 展开」这一步到底哪出了问题。
// 用法：node tmp\browser\probe-expand.mjs [act]
import puppeteer from 'puppeteer-core';

const BASE = 'http://127.0.0.1:8791/';
const act = process.argv[2] || 'dbl1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu'],
});

const p = await browser.newPage();
await p.setViewport({ width: 1400, height: 900 });
const jsErrs = [];
p.on('pageerror', (e) => jsErrs.push('pageerror: ' + e.message));

await p.goto(BASE + '?act=' + act, { waitUntil: 'load', timeout: 30000 });

const snap = async (t) => {
  const s = await p.evaluate(() => {
    const card = document.querySelector('[data-po-card]');
    const sign = document.querySelector('[data-po-sign]');
    const stage = document.querySelector('[data-po-stage]');
    const c = stage && stage.querySelector('canvas');
    const r = c ? c.getBoundingClientRect() : null;
    return {
      card: card ? getComputedStyle(card).display : null,
      sign: sign ? getComputedStyle(sign).display : null,
      signInline: sign ? sign.style.display : null,
      cv: r ? Math.round(r.width) + 'x' + Math.round(r.height) : 'none',
    };
  });
  console.log(JSON.stringify({ t, ...s }));
};

await snap('before');

const clicked = await p.evaluate(() => {
  const sign = document.querySelector('[data-po-sign]');
  if (!sign) return 'no-sign';
  const before = getComputedStyle(sign).display;
  sign.click();
  return 'clicked, sign display was ' + before;
});
console.log('click ->', clicked);

await sleep(1200);
await snap('stable');

// 展开后做一次双击（与 harness 的 dbl1 剧本同样手法），看事件是否到达 client.js
const info = await p.evaluate(() => {
  const cv = document.querySelector('[data-po-stage] canvas');
  const r = cv.getBoundingClientRect();
  const vp = (lx, ly) => ({ x: r.left + lx * (r.width / 320), y: r.top + ly * (r.height / 431) });
  const s = vp(172, 140);
  const fire = (type, x, y) => cv.dispatchEvent(new PointerEvent(type, {
    clientX: x, clientY: y, pointerId: 1, button: 0,
    bubbles: true, cancelable: true, pointerType: 'mouse',
  }));
  window.__errs = window.__errs || [];
  fire('pointerdown', s.x, s.y);
  fire('pointerup', s.x, s.y);
  return { pt: s, rect: { x: r.left, y: r.top, w: r.width, h: r.height } };
});
console.log('tap1 ->', JSON.stringify(info));
await sleep(120);
await p.evaluate(() => {
  const cv = document.querySelector('[data-po-stage] canvas');
  const r = cv.getBoundingClientRect();
  const s = { x: r.left + 172 * (r.width / 320), y: r.top + 140 * (r.height / 431) };
  const fire = (type) => cv.dispatchEvent(new PointerEvent(type, {
    clientX: s.x, clientY: s.y, pointerId: 1, button: 0,
    bubbles: true, cancelable: true, pointerType: 'mouse',
  }));
  fire('pointerdown'); fire('pointerup');
});
for (const t of [300, 700, 1400]) {
  await sleep(t === 300 ? 300 : 500);
  const st = await p.evaluate(() => {
    const w = window.__pixelOfficeWalk && window.__pixelOfficeWalk();
    if (!w || !w.act || !w.act.main) return { act: null, errs: (window.__errs || []).slice(-4) };
    const a = w.act.main;
    return { f: a.facing, g: a.glyph, dbl: a.dbl, phase: a.phase, errs: (window.__errs || []).slice(-4) };
  });
  console.log('after double +' + t + 'ms ->', JSON.stringify(st));
}

console.log('jsErrs=' + JSON.stringify(jsErrs));
await browser.close();