/**
 * 诊断：列出 404 资产 URL，并采样 rAF 停摆下的帧节奏。
 * 用法：node tmp/browser/diag.mjs
 */
import puppeteer from 'puppeteer-core';

const BASE = 'http://127.0.0.1:8791/';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: EDGE, headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1400,900'],
});

// --- 正常页：抓 404 ---
const p = await browser.newPage();
const failed = [];
p.on('response', (r) => { if (r.status() >= 400) failed.push(r.status() + ' ' + r.url()); });
await p.goto(BASE, { waitUntil: 'load' });
await sleep(3000);
console.log('=== 404/4xx ===');
console.log([...new Set(failed)].join('\n') || '(none)');
const dom = await p.evaluate(() => ({
  seats: document.querySelectorAll('[data-po-seat]').length,
  seatAttrs: Array.from(document.querySelectorAll('[data-po-seat]')).map((e) => e.getAttribute('data-po-seat')),
  html: document.querySelector('[data-po-card]') ? document.querySelector('[data-po-card]').outerHTML.slice(0, 400) : null,
}));
console.log('=== DOM ===', JSON.stringify(dom, null, 1));

// --- 停摆页：帧节奏 ---
const b = await browser.newPage();
await b.evaluateOnNewDocument(() => {
  window.requestAnimationFrame = function () { return 0; };
  window.cancelAnimationFrame = function () {};
});
await b.goto(BASE, { waitUntil: 'load' });
const samples = [];
for (let i = 0; i < 12; i += 1) {
  await sleep(500);
  samples.push(await b.evaluate(() => {
    const w = window.__pixelOfficeWalk();
    return { t: w.now, frames: w.frames, vis: document.visibilityState, phase: w.act.main && w.act.main.phase };
  }));
}
console.log('=== 停摆页采样（每 500ms）===');
for (const s of samples) console.log('  t=' + s.t + 'ms frames=' + s.frames + ' vis=' + s.vis + ' phase=' + s.phase);

await browser.close();
