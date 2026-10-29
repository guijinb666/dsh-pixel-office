// probe v5：单条副鱼（sub:2 = m5-sporty）全生命周期绘制实测
// 目的：一次性锁定 bug1（抓取/出画时的帧与屏幕尺寸）、bug3（画布外 glyph/fillRect 与抖动）、bug2（相位序列）
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] || 'http://127.0.0.1:8791/';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const SEAT = process.argv[3] || 'sub:2';
const SEAT_LX = Number(process.argv[4] || 182); // seats.json sub:2 seated.x
const SEAT_LY = Number(process.argv[5] || 211); // seats.json sub:2 seated.y
const SW = 26, SH = 40;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1400,1000'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 1000 });

await page.evaluateOnNewDocument(() => {
  window.__errs = [];
  window.__rec = [];
  window.__fr = {};
  window.__cvIds = new WeakMap();
  window.__nextCv = 1;
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
        const args = Array.prototype.slice.call(arguments, 1);
        window.__rec.push({
          k: 'img', cv: idOf(this), src: img.src, iw: img.width, ih: img.height,
          args: args, a: t.a, d: t.d, e: t.e, f: t.f,
        });
      }
    } catch (e) { /* ignore */ }
    return oDI.apply(this, arguments);
  };
  const oFR = P.fillRect;
  P.fillRect = function () {
    try { const id = idOf(this); window.__fr[id] = (window.__fr[id] || 0) + 1; } catch (e) { /* ignore */ }
    return oFR.apply(this, arguments);
  };
  window.__mark = function () { window.__rec = []; window.__fr = {}; };
  window.__rep = function () {
    const out = [];
    const seen = {};
    for (let i = 0; i < window.__rec.length; i += 1) {
      const r = window.__rec[i];
      const key = r.cv + '|' + r.src + '|' + r.args.join(',') + '|' + Math.round(r.e) + ',' + Math.round(r.f);
      if (seen[key]) continue;
      seen[key] = 1;
      const name = r.src.split('/').slice(-3).join('/');
      const sc = (Math.abs(r.a) * r.iw).toFixed(1) + 'x' + (Math.abs(r.d) * r.ih).toFixed(1);
      out.push('cv' + r.cv + ' ' + name + ' img=' + r.iw + 'x' + r.ih +
        ' args=[' + r.args.map((v) => (typeof v === 'number' ? Math.round(v) : String(v))).join(',') + ']' +
        ' scr=' + sc + ' org=(' + Math.round(r.e) + ',' + Math.round(r.f) + ')');
    }
    return { draws: out, fillRects: JSON.parse(JSON.stringify(window.__fr)) };
  };
  window.__cvInfo = function () {
    return Array.prototype.map.call(document.querySelectorAll('canvas'), function (c) {
      const s = getComputedStyle(c);
      const ctx = c.getContext('2d');
      let id = null;
      try { window.__cvIds.get(c); id = window.__cvIds.get(c) || null; } catch (e) { /* ignore */ }
      return { id: id, pos: s.position, z: s.zIndex, aw: c.width, ah: c.height, cw: c.clientWidth, ch: c.clientHeight };
    });
  };
  window.__phase = function (id) {
    const w = window.__pixelOfficeWalk ? window.__pixelOfficeWalk() : null;
    if (!w) return null;
    const a = w.act[id];
    if (!a) return null;
    return { phase: a.phase, facing: a.facing, glyph: a.glyph, hidden: a.hidden };
  };
});

page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text()); });

await page.goto(BASE, { waitUntil: 'networkidle2' });
await page.waitForFunction(() => {
  const w = window.__pixelOfficeWalk && window.__pixelOfficeWalk();
  return !!(w && Object.keys(w.win).length === 0);
}, { timeout: 40000 });
await sleep(800);

const cvInfo = await page.evaluate(() => window.__cvInfo());
console.log('== canvas 清单 ==');
for (const c of cvInfo) console.log(' ', JSON.stringify(c));

const geo = await page.evaluate(() => {
  const cv = document.querySelector('[data-po-stage] canvas');
  const r = cv.getBoundingClientRect();
  return { left: r.left, top: r.top, w: r.width, h: r.height };
});
console.log('== stage geo ==', JSON.stringify(geo));
const vx = (lx) => geo.left + lx * (geo.w / 320);
const vy = (ly) => geo.top + ly * (geo.h / 431);

async function report(tag) {
  const st = await page.evaluate((id) => window.__phase(id), SEAT);
  await sleep(120);
  const r = await page.evaluate(() => window.__rep());
  console.log('\n--- ' + tag + ' phase=' + JSON.stringify(st));
  if (!r.draws.length) console.log('    (无 drawImage)');
  for (const d of r.draws) console.log('    ' + d);
  console.log('    fillRect=' + JSON.stringify(r.fillRects));
  return { st, r };
}

const cx = vx(SEAT_LX + SW / 2);
const cy = vy(SEAT_LY + SH / 2);
const hit = await page.evaluate((lx, ly) => window.__pixelOfficeDebug(lx, ly), SEAT_LX + SW / 2, SEAT_LY + SH / 2);
console.log('== 命中探测 ==', JSON.stringify({ hit: hit.hit, why: hit.why }));

// A：按下并保持不动
await page.mouse.move(cx, cy);
await page.evaluate(() => window.__mark());
await page.mouse.down();
await sleep(300);
await report('A 按下后（面板内、未移动）');

// B：在画布内移动
await page.mouse.move(vx(160), vy(300), { steps: 8 });
await sleep(300);
await report('B 画布内拖动');

// C：拖到画布外（左侧 80px）
await page.mouse.move(geo.left - 80, vy(340), { steps: 10 });
await sleep(300);
await report('C 拖到画布外（未松手）');

// D：松手，逐点采样
await page.mouse.up();
for (let i = 0; i < 6; i += 1) {
  await sleep(90);
  await report('D' + i + ' 松手后 +' + ((i + 1) * 90) + 'ms');
}

// E：继续采到 6s，只看相位
console.log('\n== 相位时间线 ==');
for (let t = 0; t < 32; t += 1) {
  await sleep(200);
  const st = await page.evaluate((id) => window.__phase(id), SEAT);
  console.log('  +' + (540 + t * 200) + 'ms ' + JSON.stringify(st));
  if (st && st.phase === 'seated') break;
}

await browser.close();
