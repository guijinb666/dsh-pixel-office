/**
 * 诊断：把 harness 剧本的原始 __errs 全打印出来，看卡在哪。
 * 用法：node tmp/browser/diag-d13.mjs [act]
 */
import puppeteer from 'puppeteer-core';

const BASE = 'http://127.0.0.1:8791/';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const act = process.argv[2] || 'probe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: EDGE, headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1400,900'],
});
const p = await browser.newPage();
await p.setViewport({ width: 1400, height: 900 });
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
p.on('requestfailed', (r) => errs.push('reqfail: ' + r.url()));

await p.goto(BASE + '?act=' + act, { waitUntil: 'load', timeout: 30000 });
await sleep(6000);

const state = await p.evaluate(() => ({
  hasCanvas: !!document.querySelector('[data-po-stage] canvas'),
  hasWalk: typeof window.__pixelOfficeWalk,
  hasDebug: typeof window.__pixelOfficeDebug,
  errs: (window.__errs || []).slice(),
}));
console.log('canvas=', state.hasCanvas, 'walk=', state.hasWalk, 'debug=', state.hasDebug);
console.log('--- __errs ---');
state.errs.forEach((l, i) => console.log(i + ': ' + l));
console.log('--- page errs ---');
errs.slice(0, 20).forEach((l) => console.log(l));
await browser.close();
