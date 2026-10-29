// 最终目视验收：默认 / 设置面板展开 / 大尺寸 / 隐藏场景
// 跑法：node tmp\browser\shot-final.mjs   （需先起 node tmp\harness-server.mjs 8791）
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = 'tmp/shots';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

async function shot(file, fn, opts) {
  const o = opts || {};
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 900, deviceScaleFactor: 2 });
  // 每张图都从干净的设置起步：上一张如果把「显示办公室」关掉并写进
  // localStorage，下一张开页时 stage 就是 display:none，canvas 恒 0×0，
  // 这里的 canvas>10 等待就会超时。
  await page.evaluateOnNewDocument(() => {
    try { localStorage.clear(); } catch (e) { }
  });
  await page.goto('http://127.0.0.1:8791/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-po-sign]', { timeout: 20000 });
  // 客户端现在默认收起为木牌（m03550 第 14 条）。除 f1/f5 之外都要先展开，
  // 否则后面点标题条 / 设置面板全是隐藏在 display:none 里的元素，点了没反应。
  if (o.expand !== false) {
    await page.evaluate(() => {
      const s = document.querySelector('[data-po-sign]');
      if (s && s.style.display !== 'none') s.click();
    });
    await page.waitForFunction(
      () => {
        const st = document.querySelector('[data-po-stage]');
        const c = st && st.querySelector('canvas');
        if (!c) return false;
        const r = c.getBoundingClientRect();
        return r.width > 10 && r.height > 10;
      },
      { timeout: 20000, polling: 100 }
    );
  }
  // 等入场全部结束（walkIns 清空），画面才是稳定态
  await page.waitForFunction(
    () => {
      const w = window.__pixelOfficeWalk && window.__pixelOfficeWalk();
      return w && w.win && Object.keys(w.win).length === 0;
    },
    { timeout: 40000, polling: 200 }
  ).catch(() => {});
  await sleep(1500);
  if (fn) await fn(page);
  await sleep(500);
  // 最小化后 card 是 display:none —— 截图目标要换成木牌，否则
  // puppeteer 会报 "Node is either not visible or not an HTMLElement"。
  var signVisible = await page.evaluate(function () {
    var s = document.querySelector('[data-po-sign]');
    return !!(s && getComputedStyle(s).display !== 'none');
  });
  var target = signVisible ? await page.$('[data-po-sign]') : await page.$('[data-po-card]');
  await target.screenshot({ path: OUT + '/' + file });  console.log('saved ' + OUT + '/' + file);
  await page.close();
}

// 默认态：重启后就是木牌（m03550 第 14 条），不展开。
await shot('f1-default.png', null, { expand: false });

await shot('f2-settings.png', async (page) => {
  await page.evaluate(() => {
    const bar = document.querySelector('[data-po-bar]');
    const btns = Array.from(bar.querySelectorAll('button'));
    btns[btns.length - 2].click();
  });
  await sleep(300);
});

await shot('f3-large.png', async (page) => {
  await page.evaluate(() => {
    const bar = document.querySelector('[data-po-bar]');
    const btns = Array.from(bar.querySelectorAll('button'));
    btns[btns.length - 2].click();
  });
  await sleep(200);
  await page.evaluate(() => {
    const settings = document.querySelector('[data-po-settings]');
    const rows = Array.from(settings.children).filter((el) => el.querySelector('[data-po-val]'));
    rows[1].querySelectorAll('[data-po-val]')[3].click(); // 特大
  });
  await sleep(500);
});

await shot('f4-hidden.png', async (page) => {
  await page.evaluate(() => {
    const bar = document.querySelector('[data-po-bar]');
    const btns = Array.from(bar.querySelectorAll('button'));
    btns[btns.length - 2].click();
  });
  await sleep(200);
  await page.evaluate(() => {
    const settings = document.querySelector('[data-po-settings]');
    const rows = Array.from(settings.children).filter((el) => el.querySelector('[data-po-val]'));
    rows[0].querySelectorAll('[data-po-val]')[1].click(); // 显隐=关
  });
  await sleep(500);
});

// 木牌态
await shot('f5-sign.png', async (page) => {
  await page.evaluate(() => {
    const bar = document.querySelector('[data-po-bar]');
    const btns = Array.from(bar.querySelectorAll('button'));
    btns[btns.length - 1].click();
  });
  await sleep(1200);
});

await browser.close();
