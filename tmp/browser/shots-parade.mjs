/**
 * 空格彩蛋目视截图（m06554 第 6 条）：
 *   A 全员坐地待机（刚拖完，还没排队）
 *   B 排队中（各就各位成一列）
 *   C 一起向右走出画面
 *   D 告示牌弹出后的全屏观感
 *
 * 关键：用 ?delay= 给剧本留观察窗，先拍 A，再进拖拽流程。
 * 上一版没有 delay，A 的等待循环条件写错（要求 parade>=1），
 * 一直等到 45s 超时，此时早已弹牌 —— B/C 被整段跳过、A 与 D 拍成同一张。
 *
 * 用法：node tmp/browser/shots-parade.mjs [baseUrl]
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:8791/';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = 'tmp/shots-parade';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1400,900'],
});
const p = await browser.newPage();
await p.setViewport({ width: 1400, height: 900 });
// delay=9000：坐满后留 9 秒给 A 截图，之后剧本才开始按住空格拖鱼
await p.goto(BASE + '?act=parade&delay=9000', { waitUntil: 'load', timeout: 30000 });

// 木牌默认是最小化：不展开就没有 canvas，剧本里 stageCanvas() 返回 null，
// 拖拽全部落空（probe-parade 里表现成 parade 永远 0、errs 被 _flush 清空看不出原因）。
await p.waitForSelector('[data-po-sign]', { timeout: 20000 }).catch(() => {});
await p.evaluate(() => {
  const sign = document.querySelector('[data-po-sign]');
  if (sign && sign.style.display !== 'none') sign.click();
});
await sleep(800);

async function shot(name) {
  const file = `${OUT}/${name}.png`;
  await p.screenshot({ path: file });
  console.log('  saved ' + file);
}

const state = () => p.evaluate(() => {
  const w = window.__pixelOfficeWalk ? window.__pixelOfficeWalk() : null;
  return {
    parade: w ? (w.parade || 0) : 0,
    board: !!document.querySelector('[data-po-board]'),
    ready: (() => {
      if (!w || !w.act) return false;
      const keys = Object.keys(w.act);
      return keys.length > 0
        && keys.every((k) => ['seated', 'working', 'idle'].includes(w.act[k].phase))
        && Object.keys(w.win).length === 0;
    })(),
  };
});

// A：等全员坐稳（此时彩蛋受 delay 保护还没启动），立刻拍
console.log('[A] 等全员坐稳');
let waited = 0;
while (waited < 45000) {
  await sleep(400);
  waited += 400;
  const st = await state();
  if (st.ready) break;
}
await sleep(600);
const stA = await state();
console.log('  A 时 parade=' + stA.parade + ' ready=' + stA.ready);
await shot('A-all-seated');

// B/C/D：按 parade 阶段逐个抓（用轮询峰值判断，避免中间态被跳过）
let seen = {};
let maxParade = stA.parade;
waited = 0;
while (waited < 150000) {
  await sleep(250);
  waited += 250;
  const st = await state();
  if (st.parade > maxParade) maxParade = st.parade;
  if (st.parade === 1 && !seen.b) { seen.b = 1; await sleep(500); await shot('B-queueing'); }
  if (st.parade === 2 && !seen.c) { seen.c = 1; await sleep(900); await shot('C-walking-out'); }
  if ((st.parade >= 3 || st.board) && !seen.d) {
    seen.d = 1;
    await sleep(1800);        // 等弹牌 scale 动画（0.02 → 1）落定
    await shot('D-board');
    break;
  }
}

const st = await state();
console.log('最终 parade=' + st.parade + ' board=' + st.board
  + ' 抓到阶段：' + JSON.stringify(Object.keys(seen)));
await browser.close();

if (!seen.b || !seen.c || !seen.d) {
  console.log('WARN 有阶段没抓到，需要放宽 delay 或缩短短采样间隔');
  process.exitCode = 1;
}
