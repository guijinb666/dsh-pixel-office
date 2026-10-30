// 自己截：1440 视口下首屏、以及整页缩略（每 900px 一张），直接看真实布局
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = path.resolve('tmp/site-shots');
fs.mkdirSync(OUT, { recursive: true });

const url = 'file:///' + path.resolve('site/index.html').replace(/\\/g, '/');

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--force-device-scale-factor=1', '--hide-scrollbars', '--allow-file-access-from-files'],
  defaultViewport: { width: 1440, height: 900 }
});
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => logs.push(m.type() + ': ' + m.text()));
page.on('pageerror', (e) => logs.push('pageerror: ' + e.message));

await page.goto(url, { waitUntil: 'networkidle2' });
// 等字体与图片
await page.evaluate(() => document.fonts && document.fonts.ready);
await new Promise((r) => setTimeout(r, 1200));

// 全页滚动一遍，触发 reveal 与快门
const h = await page.evaluate(() => document.documentElement.scrollHeight);
for (let y = 0; y < h; y += 600) {
  await page.evaluate((yy) => window.scrollTo(0, yy), y);
  await new Promise((r) => setTimeout(r, 90));
}
await page.evaluate(() => window.scrollTo(0, 0));
await new Promise((r) => setTimeout(r, 700));

await page.screenshot({ path: path.join(OUT, 'fold.png') });

// 逐屏
const screens = Math.ceil(h / 900);
for (let i = 0; i < screens; i += 1) {
  await page.evaluate((yy) => window.scrollTo(0, yy), i * 900);
  await new Promise((r) => setTimeout(r, 260));
  await page.screenshot({ path: path.join(OUT, `s${String(i).padStart(2, '0')}.png`) });
}

// 关键元素的位置，用来判断有没有叠
const geo = await page.evaluate(() => {
  const g = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y + window.scrollY), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const all = (sel) => [].slice.call(document.querySelectorAll(sel)).map((el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y + window.scrollY), w: Math.round(r.width), h: Math.round(r.height) };
  });
  return {
    pageH: document.documentElement.scrollHeight,
    cast: g('.cast'), stage: g('.stage'), disc: g('.disc'), skin: g('.skin'),
    roster: g('.roster'), picks: all('.pick'), strip: all('.beat img'),
    demos: all('.demo'), hero: g('.hero'), sun: g('.sun'), shot: g('.hero-shot'),
    mega: g('.mega'), installLead: g('.install-lead')
  };
});

console.log(JSON.stringify(geo, null, 2));
console.log('--- logs', logs.length ? logs : 'none');
await browser.close();
