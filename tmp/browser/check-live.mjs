// 打开线上 Pages 地址，确认样式/字体/视频/图片都真的加载了，并出一张首屏图
// 注意：本机到 github.io 的 QUIC 不通，必须 --disable-http3，否则 goto 会卡死到超时。
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = path.resolve('tmp/live-shots');
fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-sandbox', '--disable-http3', '--disable-quic'],
  userDataDir: path.join(os.tmpdir(), 'po-live-profile'),
  defaultViewport: { width: 1440, height: 900 }
});
const page = await browser.newPage();
const bad = [];
page.on('requestfailed', (r) => bad.push('FAILED ' + r.url() + ' :: ' + ((r.failure() || {}).errorText || '')));
page.on('response', (r) => { if (r.status() >= 400) bad.push('HTTP ' + r.status() + ' ' + r.url()); });
page.on('pageerror', (e) => bad.push('JS ' + e.message));

await page.goto('https://guijinb666.github.io/dsh-pixel-office/', {
  waitUntil: 'domcontentloaded',
  timeout: 60000
});

// 字体与媒体自己等，设上限，别被外网字体卡死
await page.evaluate(() => Promise.race([
  document.fonts.ready,
  new Promise((r) => setTimeout(r, 8000))
]));
await new Promise((r) => setTimeout(r, 3000));

const info = await page.evaluate(() => {
  const imgs = [].slice.call(document.images).map((i) => ({
    src: (i.currentSrc || i.src).split('/').pop(),
    ok: i.naturalWidth > 0,
    w: i.naturalWidth
  }));
  const v = document.querySelector('video');
  return {
    imgs,
    video: v ? {
      src: (v.currentSrc || '').split('/').pop(),
      w: v.videoWidth,
      h: v.videoHeight,
      playing: !v.paused,
      t: +v.currentTime.toFixed(2)
    } : null,
    fonts: [].slice.call(document.fonts).filter((f) => f.status === 'loaded').map((f) => f.family + ' ' + f.weight),
    headline: document.querySelector('h1') ? document.querySelector('h1').innerText.replace(/\n/g, ' / ') : null,
    h1Size: document.querySelector('h1') ? getComputedStyle(document.querySelector('h1')).fontSize : null,
    skins: document.querySelectorAll('.pick').length,
    switches: document.querySelectorAll('.sw').length
  };
});

await page.screenshot({ path: path.join(OUT, 'live-fold.png') });

// 点第三个开关（灯光呼吸），确认 JS 真的在跑
await page.evaluate(() => { document.querySelectorAll('.sw')[2].click(); return null; });
await new Promise((r) => setTimeout(r, 400));
const swState = await page.evaluate(() => {
  const sw = document.querySelectorAll('.sw')[2];
  const el = document.querySelector('.d-lamp b');
  return {
    ariaChecked: sw ? sw.getAttribute('aria-checked') : null,
    rowOff: sw && sw.closest('.row') ? sw.closest('.row').classList.contains('off') : null,
    playState: el ? el.style.animationPlayState : null
  };
});

console.log(JSON.stringify({ ...info, swState, bad }, null, 2));
await browser.close();
