// probe v6：验证「面板 CSS 缩放 / devicePixelRatio ≠ 1」时，面板内(drawActor)与面板外(drawSky)的绘制尺寸是否一致
// 用来解释「拖出办公室又恢复原大小」是否来自两条绘制路径的口径差异
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] || 'http://127.0.0.1:8791/';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const SEAT = 'sub:2';
const SEAT_LX = 182, SEAT_LY = 211, SW = 26, SH = 40;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(vpW, vpH, dsf, label) {
  const browser = await puppeteer.launch({
    executablePath: EDGE, headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', `--window-size=${vpW},${vpH}`],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: vpW, height: vpH, deviceScaleFactor: dsf });
  await page.evaluateOnNewDocument(() => {
    window.__rec = [];
    window.__cvIds = new WeakMap();
    window.__nextCv = 1;
    window.__dpr = window.devicePixelRatio;
    function idOf(ctx) {
      let v = window.__cvIds.get(ctx.canvas);
      if (!v) { v = window.__nextCv++; window.__cvIds.set(ctx.canvas, v); }
      return v;
    }
    const P = CanvasRenderingContext2D.prototype;
    const oDI = P.drawImage;
    P.drawImage = function (img) {
      try {
        if (img && img.src) {
          const t = this.getTransform();
          window.__rec.push({ cv: idOf(this), src: img.src, iw: img.width, ih: img.height, a: t.a, d: t.d, e: t.e, f: t.f });
        }
      } catch (e) { /* ignore */ }
      return oDI.apply(this, arguments);
    };
    window.__mark = function () { window.__rec = []; };
    window.__rep = function (needle) {
      const out = [];
      const seen = {};
      for (let i = 0; i < window.__rec.length; i += 1) {
        const r = window.__rec[i];
        if (r.src.indexOf(needle) < 0) continue;
        const key = r.cv + '|' + r.src;
        if (seen[key]) continue;
        seen[key] = 1;
        out.push('cv' + r.cv + ' ' + r.src.split('/').slice(-2).join('/') +
          ' img=' + r.iw + 'x' + r.ih +
          ' dev=' + (Math.abs(r.a) * r.iw).toFixed(2) + 'x' + (Math.abs(r.d) * r.ih).toFixed(2) +
          ' org=(' + Math.round(r.e) + ',' + Math.round(r.f) + ')');
      }
      return out;
    };
  });
  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => {
    const w = window.__pixelOfficeWalk && window.__pixelOfficeWalk();
    return !!(w && Object.keys(w.win).length === 0);
  }, { timeout: 40000 });
  await sleep(700);

  const geo = await page.evaluate(() => {
    const cv = document.querySelector('[data-po-stage] canvas');
    const r = cv.getBoundingClientRect();
    return { left: r.left, top: r.top, w: r.width, h: r.height, dpr: window.devicePixelRatio, aw: cv.width, ah: cv.height };
  });
  const vx = (lx) => geo.left + lx * (geo.w / 320);
  const vy = (ly) => geo.top + ly * (geo.h / 431);

  console.log('\n===== ' + label + ' viewport=' + vpW + 'x' + vpH + ' dsf=' + dsf);
  console.log('  geo=' + JSON.stringify(geo) + '  cssScale=' + (geo.w / 320).toFixed(3));

  await page.mouse.move(vx(SEAT_LX + SW / 2), vy(SEAT_LY + SH / 2));
  await page.mouse.down();
  await sleep(200);
  await page.mouse.move(vx(SEAT_LX + SW / 2 + 10), vy(SEAT_LY + SH / 2 + 10), { steps: 4 });
  await sleep(250);
  await page.evaluate(() => window.__mark());
  await sleep(200);
  const inDraw = await page.evaluate((n) => window.__rep(n), 'm5-sporty');
  console.log('  面板内(grabbed): ' + JSON.stringify(inDraw));

  await page.mouse.move(geo.left - 60, vy(340), { steps: 8 });
  await sleep(300);
  await page.evaluate(() => window.__mark());
  await sleep(250);
  const outDraw = await page.evaluate((n) => window.__rep(n), 'm5-sporty');
  console.log('  面板外(grabbed): ' + JSON.stringify(outDraw));
  await page.mouse.up();
  await browser.close();
}

await run(1400, 1000, 1, 'A 基准');
await run(900, 1400, 1, 'B 窄视口');
await run(1400, 1000, 2, 'C 高清 dpr2');
