/**
 * 诊断场景 C：rAF 被覆盖后能否还原。
 * 用法：node tmp/browser/diag-c.mjs
 */
import puppeteer from 'puppeteer-core';

const BASE = 'http://127.0.0.1:8791/';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: EDGE, headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1400,900'],
});
const p = await browser.newPage();
await p.setViewport({ width: 1400, height: 900 });
await p.evaluateOnNewDocument(() => {
  window.__orgRaf = window.requestAnimationFrame;
  window.requestAnimationFrame = function () { return 0; };
});
await p.goto(BASE, { waitUntil: 'load' });
await sleep(1500);

console.log('own before:', await p.evaluate(() => ({
  own: Object.prototype.hasOwnProperty.call(window, 'requestAnimationFrame'),
  desc: JSON.stringify(Object.getOwnPropertyDescriptor(window, 'requestAnimationFrame') && { w: true }),
  type: typeof window.requestAnimationFrame,
  saved: typeof window.__orgRaf,
})));

// 方式 1：delete 自己造的属性
const del = await p.evaluate(() => {
  delete window.requestAnimationFrame;
  return {
    ownAfter: Object.prototype.hasOwnProperty.call(window, 'requestAnimationFrame'),
    type: typeof window.requestAnimationFrame,
  };
});
console.log('after delete:', JSON.stringify(del));

const fired = await p.evaluate(() => new Promise((resolve) => {
  let done = false;
  try {
    window.requestAnimationFrame(() => { done = true; resolve('fired'); });
  } catch (e) { resolve('throw: ' + e.message); }
  setTimeout(() => { if (!done) resolve('timeout'); }, 1500);
}));
console.log('rAF fires after delete:', fired);

const walk = await p.evaluate(() => {
  const w = window.__pixelOfficeWalk();
  return { frames: w.frames, now: w.now, phase: w.act.main && w.act.main.phase };
});
console.log('frames:', JSON.stringify(walk));

await browser.close();
