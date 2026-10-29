/**
 * 只读诊断探针 v4：用 canvas 当前变换矩阵算出「屏幕上实际绘制的像素宽高」。
 * 目的：确认拖拽副鱼（尤其 m5-sporty）时，可见尺寸到底变没变、变成多少。
 *
 * 用法：node tmp/browser/probe-sub-drag4.mjs
 */
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] || 'http://127.0.0.1:8791/';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const HOOK = () => {
  window.__recs = [];
  window.__rec = false;
  window.__mark = () => window.__recs.length;
  window.__since = (n) => window.__recs.slice(n);
  const proto = CanvasRenderingContext2D.prototype;
  const orig = proto.drawImage;
  proto.drawImage = function (img) {
    if (window.__rec) {
      const m = this.getTransform();
      window.__recs.push({
        src: String((img && (img.currentSrc || img.src)) || '').replace(/^.*\/assets\//, ''),
        iw: img && img.width,
        ih: img && img.height,
        // 屏幕（逻辑像素）绘制宽高：无旋转时 = iw*|a| × ih*|d|
        sw: Math.round((img ? img.width : 0) * Math.abs(m.a) * 100) / 100,
        sh: Math.round((img ? img.height : 0) * Math.abs(m.d) * 100) / 100,
        // 绘制原点（逻辑坐标）
        ox: Math.round(m.e * 100) / 100,
        oy: Math.round(m.f * 100) / 100,
        sc: Math.round(m.a * 1000) / 1000,
        t: Math.round(performance.now()),
      });
    }
    return orig.apply(this, arguments);
  };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: EDGE, headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1400,1000'],
  defaultViewport: { width: 1400, height: 1000 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.evaluateOnNewDocument(HOOK);
await page.goto(BASE, { waitUntil: 'load' });
await page.waitForFunction(() => {
  const w = window.__pixelOfficeWalk && window.__pixelOfficeWalk();
  return w && Object.keys(w.win || {}).length === 0;
}, { timeout: 60000 });
await sleep(900);

const geo = await page.evaluate(() => {
  const cv = document.querySelector('[data-po-stage] canvas');
  const r = cv.getBoundingClientRect();
  return { left: r.left, top: r.top, w: r.width, h: r.height, dpr: window.devicePixelRatio };
});
const vp = (lx, ly) => ({ x: geo.left + lx * (geo.w / 320), y: geo.top + ly * (geo.h / 431) });
console.log('geo=', JSON.stringify(geo), ' css 缩放 =', (geo.w / 320).toFixed(3), 'x', (geo.h / 431).toFixed(3));

const boxes = await page.evaluate(() => {
  const d = window.__pixelOfficeDebug(0, 0);
  return d.boxes;
});
console.log('boxes=', JSON.stringify(boxes));

// 抓取前：记录一整帧所有 subs sprite 的 transform
await page.evaluate(() => { window.__rec = true; });
let m = await page.evaluate(() => window.__mark());
await sleep(120);
const before = await page.evaluate((n) => window.__since(n), m);
console.log('\n=== 抓取前（静止）subs sprite 绘制 ===');
dumpList(before.filter((r) => /subs\//.test(r.src)).slice(-24), boxes);

// 对每个有鱼的座位：按下 → 测抓取中 → 立刻松开
const seats = Object.keys(boxes).filter((k) => boxes[k]);
for (const seat of seats.slice(0, 4)) {
  const b = boxes[seat];
  if (!b) continue;
  const g = vp(b.x + b.w / 2, b.y + b.h / 2);
  m = await page.evaluate(() => window.__mark());
  await page.mouse.move(g.x, g.y);
  await page.mouse.down();
  await page.mouse.move(g.x + 3, g.y + 3);
  await sleep(260);
  const grabbed = await page.evaluate((n) => window.__since(n), m);
  const act = await page.evaluate((s) => window.__pixelOfficeWalk().act[s], seat);
  // 只挑「绘制原点落在当前抓取位置附近」的那条，避免撞衫串台
  const near = grabbed.filter((r) => /subs\//.test(r.src) && Math.abs(r.ox - (b.x - b.w / 2 + b.w / 2 - 13)) < 40 && Math.abs(r.oy - b.y) < 80);
  console.log(`\n=== 抓 ${seat}（box ${b.w}x${b.h}）phase=${act.phase} ===`);
  dumpList(grabbed.filter((r) => /subs\//.test(r.src)).slice(-12), boxes);
  await page.mouse.up();
  await sleep(150);
  // 松开后可能进入 confused 1s，等它回到 seated
  await page.waitForFunction((s) => {
    const w = window.__pixelOfficeWalk();
    return w.act[s] && (w.act[s].phase === 'seated' || w.act[s].phase === 'walkhome');
  }, { timeout: 20000 }, seat).catch(() => {});
  await page.waitForFunction((s) => window.__pixelOfficeWalk().act[s].phase === 'seated', { timeout: 30000 }, seat).catch(() => {});
  await sleep(200);
}

await browser.close();

function dumpList(arr, boxes) {
  for (const r of arr) {
    console.log(`   ${r.src}  img=${r.iw}x${r.ih}  →  屏幕 ${r.sw}x${r.sh}  原点(${r.ox},${r.oy})  scale=${r.sc}`);
  }
}
