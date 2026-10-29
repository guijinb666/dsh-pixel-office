/**
 * 拍验收图：用本地验收台（harness）渲染，证明这批修复的视觉效果。
 *
 * 拍三张：
 *   1. 常态 —— 主鱼背面坐在工位，副鱼各自就座
 *   2. 双击后 —— 主鱼转到正面，应当是**人形**（蓝长发 + 白蕾丝头饰 + 女仆裙）
 *   3. 副鱼走路 —— 侧面走 + 上下起伏
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire('C:/Users/30612/Desktop/像素工作台/tmp/browser/');
const puppeteer = require('puppeteer-core');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const BASE = 'http://127.0.0.1:8791/';
const OUT = 'tmp/shots';

fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 420, height: 560, deviceScaleFactor: 3 });

async function shot(act, file, waitMs) {
  await page.goto(BASE + (act ? '?act=' + act : ''), { waitUntil: 'load', timeout: 30000 });
  await new Promise((r) => setTimeout(r, waitMs));
  const el = await page.$('[data-po-card]');
  if (!el) {
    console.log('  FAIL 没找到面板 ' + file);
    return false;
  }
  await el.screenshot({ path: OUT + '/' + file });
  const st = fs.statSync(OUT + '/' + file);
  console.log('  OK   ' + file + '  ' + st.size + 'B');
  return true;
}

// 1) 常态：等入场动画走完
await shot('', '1-idle.png', 9000);
// 2) 双击一级：主鱼转正面（关键：看是不是人形）
await shot('dbl1', '2-front-human.png', 11000);
// 3) 拖出再松手：主鱼从画外进门走回工位
await shot('dragout-release2', '3-reenter.png', 10000);

await browser.close();
