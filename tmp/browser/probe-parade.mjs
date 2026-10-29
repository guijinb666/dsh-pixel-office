/**
 * 临时诊断：跑 ?act=parade&delay=3000，把 window.__errs 全量打出来，
 * 看 delay 之后 startParadeScript 到底有没有执行、拖拽落到哪一步。
 */
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] || 'http://127.0.0.1:8791/';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1400,900'],
});
const p = await browser.newPage();
await p.setViewport({ width: 1400, height: 900 });
p.on('pageerror', (e) => console.log('PAGEERROR ' + e.message));
p.on('console', (m) => {
  const t = m.text();
  if (t.includes('parade') || t.includes('Error')) console.log('CONSOLE ' + t.slice(0, 200));
});
await p.goto(BASE + '?act=parade&delay=3000', { waitUntil: 'load', timeout: 30000 });

for (let i = 0; i < 14; i += 1) {
  await sleep(3000);
  const st = await p.evaluate(() => {
    const w = window.__pixelOfficeWalk ? window.__pixelOfficeWalk() : null;
    return {
      parade: w ? (w.parade || 0) : -1,
      act: w ? Object.fromEntries(Object.entries(w.act).map(([k, v]) => [k, v.phase])) : null,
      esc: w ? Object.fromEntries(Object.entries(w.act).filter(([, v]) => v.esc).map(([k]) => [k, 1])) : null,
      nerrs: (window.__errs || []).length,
    };
  });
  console.log(`t=${(i + 1) * 3}s parade=${st.parade} act=${JSON.stringify(st.act)} esc=${JSON.stringify(st.esc)} errs=${st.nerrs}`);
}

const log = await p.evaluate(() => (window.__errs || []).slice(-60));
console.log('--- __errs 末尾 ---');
log.forEach((l) => console.log('  ' + l));
await browser.close();
