/**
 * 录插件画布的真实动画，做成 docs/media/stage-loop.webm。
 *
 * 目的：介绍页需要一段真实动的东西（design-taste-frontend 的 no-footage 检查项），
 * 而且"会动"本身就是这个插件的卖点，用静态图说不清。
 *
 * 做法：只截 canvas 元素（不含标题条、不含验收台），每 80ms 一帧，录 4.2 秒 ≈ 52 帧，
 * 让气泡从右往左滚一整轮、屏光开机扫描线走一次。之后 ffmpeg 合成 12fps webm。
 *
 * 用法：node tmp/browser/record-stage.mjs [baseUrl]
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:8791/';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const FRAMES = 'tmp/record';
const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(FRAMES, { recursive: true, force: true });
fs.mkdirSync(FRAMES, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--force-device-scale-factor=2', '--window-size=800,900'],
});

const p = await browser.newPage();
await p.setViewport({ width: 800, height: 900, deviceScaleFactor: 2 });
await p.goto(BASE, { waitUntil: 'load', timeout: 30000 });

await p.waitForSelector('[data-po-sign]', { timeout: 20000 }).catch(() => {});
await p.evaluate(() => {
  const sign = document.querySelector('[data-po-sign]');
  if (sign && sign.style.display !== 'none') sign.click();
});

// 等全员坐稳，气泡都在滚
const ready = async () => p.evaluate(() => {
  const w = window.__pixelOfficeWalk ? window.__pixelOfficeWalk() : null;
  if (!w || !w.act) return false;
  const keys = Object.keys(w.act);
  return keys.length > 0
    && keys.every((k) => ['seated', 'working', 'idle'].includes(w.act[k].phase))
    && Object.keys(w.win).length === 0;
});
for (let i = 0; i < 160; i += 1) {
  await SLEEP(250);
  if (await ready()) break;
}
await SLEEP(600);

// 把舞台之外的干扰全关掉：验收台的报错面板和说明条不进裁剪，但保险起见先隐藏
await p.evaluate(() => {
  const eb = document.getElementById('errbox');
  if (eb) eb.style.display = 'none';
  const fu = document.getElementById('fake-ui');
  if (fu) fu.style.display = 'none';
});

const canvas = await p.$('[data-po-stage] canvas');
if (!canvas) throw new Error('找不到 [data-po-stage] canvas');
const box = await canvas.boundingBox();
console.log(`canvas ${Math.round(box.width)}x${Math.round(box.height)} @2x`);

const N = 52;
const GAP = 80;
for (let i = 0; i < N; i += 1) {
  await canvas.screenshot({ path: path.join(FRAMES, `f${String(i).padStart(4, '0')}.png`) });
  await SLEEP(GAP);
}
console.log(`录了 ${N} 帧，理论 ${(N * GAP / 1000).toFixed(1)} 秒`);

const errs = await p.evaluate(() => window.__errs.length);
console.log('页面异常数 = ' + errs);
await browser.close();
