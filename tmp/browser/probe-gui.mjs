/**
 * 探一下真实 GUI（http://127.0.0.1:59351）现在跑的是哪一版 client.js。
 *
 * 主机进程 12:28 启动、client.js 13:12 才改完，所以客户端极可能还是旧代码。
 * 这里直接开浏览器看面板里的主鱼是不是人形，比猜靠谱。
 */
import { createRequire } from 'node:module';
const require = createRequire('C:/Users/30612/Desktop/像素工作台/tmp/browser/');
const puppeteer = require('puppeteer-core');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = 'http://127.0.0.1:59351';

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-sandbox', '--window-size=1600,1000'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });

const errs = [];
page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));

await page.goto(URL, { waitUntil: 'networkidle2', timeout: 45000 }).catch((e) => errs.push('goto: ' + e.message));
await new Promise((r) => setTimeout(r, 6000));

const info = await page.evaluate(() => {
  const cv = document.querySelector('[data-po-stage] canvas') || document.querySelector('canvas');
  const panel = document.querySelector('[data-po-panel]');
  // client.js 里 MAIN_TURN 已改成 stand-front/stand-side；用资源请求判断版本
  const perf = performance.getEntriesByType('resource').map((r) => r.name);
  return {
    title: document.title,
    hasPanel: !!panel,
    hasCanvas: !!cv,
    canvasSize: cv ? [cv.width, cv.height] : null,
    clientSrcs: perf.filter((n) => /pixel-office|client\.js/.test(n)).slice(0, 6),
    standReqs: perf.filter((n) => /stand-(front|side)|stand-1|stand-side/.test(n)).slice(0, 8),
    sitReqs: perf.filter((n) => /sit-front|sit-side/.test(n)).slice(0, 8),
  };
});

console.log(JSON.stringify(info, null, 2));
console.log('页面错误: ' + (errs.length ? errs.join(' | ') : '无'));

if (info.hasCanvas) {
  await page.screenshot({ path: 'tmp/gui-live.png' });
  console.log('截图: tmp/gui-live.png');
}

await browser.close();
