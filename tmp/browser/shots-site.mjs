/**
 * 介绍页专用干净截图：只截插件面板元素本身（不含验收台背景、不含 JSON dump、不含 errbox）。
 *
 * 之前的 A-all-seated / B-queueing / C-walking-out 是全页截图，把验收台的
 * "DSH 界面替身" 标题、__pixelOfficeWalk() 的 JSON 调试面板、#errbox 红字全拍进去了，
 * 直接放到介绍页上完全不能用。这里改成 element.screenshot() + deviceScaleFactor=3，
 * 既没背景也没调试层，而且 3 倍分辨率放大后不糊。
 *
 * 产出（docs/media/）：
 *   stage-live.png    正常态：主鱼 + 三副鱼各就位，气泡在滚（气泡文字来自 harness 假 state）
 *   stage-queue.png   彩蛋阶段 1：全员就地坐地、排队成一列（空房间时会是废图，弃用）
 *   stage-parade.png  彩蛋阶段 2：一起向右走出画布
 *
 * 用法：node tmp/browser/shots-site.mjs [baseUrl]
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:8791/';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = 'docs/media';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--window-size=900,900', '--force-device-scale-factor=3'],
});

async function newPage(query) {
  const p = await browser.newPage();
  await p.setViewport({ width: 900, height: 900, deviceScaleFactor: 3 });
  await p.goto(BASE + query, { waitUntil: 'load', timeout: 30000 });
  // 木牌默认最小化，点开才有 canvas
  await p.waitForSelector('[data-po-sign]', { timeout: 20000 }).catch(() => {});
  await p.evaluate(() => {
    const sign = document.querySelector('[data-po-sign]');
    if (sign && sign.style.display !== 'none') sign.click();
  });
  // 验收台的报错面板和调试提示条必须清掉，否则可能进裁剪框
  await p.evaluate(() => {
    const eb = document.getElementById('errbox');
    if (eb) eb.style.display = 'none';
    const fu = document.getElementById('fake-ui');
    if (fu) fu.style.display = 'none';
  });
  return p;
}

const walkState = (p) => p.evaluate(() => {
  const w = window.__pixelOfficeWalk ? window.__pixelOfficeWalk() : null;
  if (!w || !w.act) return { ready: false, parade: 0, errors: window.__errs.length };
  const keys = Object.keys(w.act);
  return {
    ready: keys.length > 0
      && keys.every((k) => ['seated', 'working', 'idle'].includes(w.act[k].phase))
      && Object.keys(w.win).length === 0,
    parade: w.parade || 0,
    errors: window.__errs.length,
  };
});

async function shootCard(p, name) {
  const el = await p.$('[data-po-card]');
  if (!el) throw new Error('找不到 [data-po-card]');
  const box = await el.boundingBox();
  const file = `${OUT}/${name}.png`;
  await el.screenshot({ path: file });
  const size = fs.statSync(file).size;
  console.log(`  ${name}.png  ${Math.round(box.width)}x${Math.round(box.height)} @3x  ${size}B`);
}

// ---- 1. 正常态 -------------------------------------------------------------
{
  console.log('[live] 等全员坐稳');
  const p = await newPage('');
  for (let i = 0; i < 120; i += 1) {
    await sleep(250);
    const st = await walkState(p);
    if (st.ready) break;
  }
  await sleep(1200);          // 让气泡滚到中间偏右，字看得见
  await shootCard(p, 'stage-live');
  const st = await walkState(p);
  console.log('  ready=' + st.ready + ' errors=' + st.errors);
  await p.close();
}

// ---- 2/3. 彩蛋两阶段 -------------------------------------------------------
{
  console.log('[parade] 等全员坐稳后按空格拖出（delay=6000 留出坐满时间）');
  const p = await newPage('?act=parade&delay=6000');
  let gotQueue = false;
  let gotParade = false;
  for (let i = 0; i < 700; i += 1) {
    await sleep(220);
    const st = await walkState(p);
    if (st.parade === 1 && !gotQueue) {
      gotQueue = true;
      await sleep(420);
      await shootCard(p, 'stage-queue');
    }
    if (st.parade === 2 && !gotParade) {
      gotParade = true;
      await sleep(750);       // 走出几个身位，队形看得清
      await shootCard(p, 'stage-parade');
      break;
    }
    if (st.parade >= 3 && !gotParade) {
      // 走太快没抓到，退回排队前那张也能用
      console.log('  WARN parade 直接到 3，没抓到阶段 2');
      break;
    }
  }
  console.log('  queue=' + gotQueue + ' parade=' + gotParade);
  await p.close();
}

await browser.close();

for (const f of ['stage-live', 'stage-queue', 'stage-parade']) {
  const path = `${OUT}/${f}.png`;
  if (!fs.existsSync(path)) {
    console.log('MISSING ' + path);
    process.exitCode = 1;
  }
}
