/**
 * 介绍页截图 + 几何量测。1440 视口，出首屏与逐屏图，并打印关键元素矩形。
 * 用法：node tmp/browser/shot-site.mjs
 *
 * 注意：注释里不要出现反引号；本文件曾因用 PowerShell 改写而被转成乱码，
 * 而且那次改写把「注释」和下一行代码并到了一起（语法合法但 h 变成 undefined），
 * node --check 查不出来。所以一律用 write/edit 工具改，不要走 PowerShell 管道。
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = path.resolve('tmp/site-shots');
fs.mkdirSync(OUT, { recursive: true });

const url = 'file:///' + path.resolve('docs/index.html').replace(/\\/g, '/');

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

await page.goto(url, { waitUntil: 'load' });
await page.evaluate(() => document.fonts && document.fonts.ready);
await new Promise((r) => setTimeout(r, 1200));

// 整页滚一遍，触发 reveal 与快门
const pageH = await page.evaluate(() => document.documentElement.scrollHeight);
for (let y = 0; y < pageH; y += 600) {
  await page.evaluate((yy) => window.scrollTo(0, yy), y);
  await new Promise((r) => setTimeout(r, 90));
}
await page.evaluate(() => window.scrollTo(0, 0));
await new Promise((r) => setTimeout(r, 700));

await page.screenshot({ path: path.join(OUT, 'fold.png') });

// 逐屏
const screens = Math.ceil(pageH / 900);
for (let i = 0; i < screens; i += 1) {
  await page.evaluate((yy) => window.scrollTo(0, yy), i * 900);
  await new Promise((r) => setTimeout(r, 260));
  await page.screenshot({ path: path.join(OUT, 's' + String(i).padStart(2, '0') + '.png') });
}

// 关键元素的位置，用来判断有没有叠
const geo = await page.evaluate(() => {
  const one = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.x),
      y: Math.round(r.y + window.scrollY),
      w: Math.round(r.width),
      h: Math.round(r.height)
    };
  };
  const many = (sel) => [].slice.call(document.querySelectorAll(sel)).map((el) => {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.x),
      y: Math.round(r.y + window.scrollY),
      w: Math.round(r.width),
      h: Math.round(r.height)
    };
  });
  return {
    pageH: document.documentElement.scrollHeight,
    cast: one('.cast'),
    stage: one('.stage'),
    disc: one('.disc'),
    skin: one('.skin'),
    roster: one('.roster'),
    picks: many('.pick'),
    strip: many('.beat img'),
    demos: many('.demo'),
    hero: one('.hero'),
    sun: one('.sun'),
    shot: one('.hero-shot'),
    mega: one('.mega'),
    installLead: one('.install-lead')
  };
});

console.log(JSON.stringify(geo, null, 2));
console.log('--- logs', logs.length ? logs : 'none');
await browser.close();
