/**
 * 只读诊断探针（不改任何项目文件）：
 * 1) 用真实鼠标事件拖动「副鱼 sub:0」，抓取拖动瞬间的 drawImage 参数，验证是否缩小；
 * 2) 拖出 canvas（由 drawSky 浮层绘制）后再抓一次，比较两者尺寸；
 * 3) 画布外松手，逐帧采样 sub:0 的 phase/glyph/shakeUntil/walkPath，验证 bug 2/3。
 *
 * 用法：node tmp/browser/probe-sub-drag.mjs [baseUrl]
 */
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] || 'http://127.0.0.1:8791/';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const HOOK = () => {
  const recs = [];
  window.__recs = recs;
  window.__rec = false;
  const proto = CanvasRenderingContext2D.prototype;
  const origDraw = proto.drawImage;
  const origFill = proto.fillRect;
  function label(cv) {
    try {
      if (cv && cv.style && cv.style.position === 'fixed') return 'sky';
      return 'stage';
    } catch (e) { return '?'; }
  }
  proto.drawImage = function (img, ...rest) {
    if (window.__rec) {
      recs.push({
        k: 'draw', c: label(this.canvas),
        src: String((img && (img.currentSrc || img.src)) || '').split('/').slice(-2).join('/'),
        iw: img && img.width, ih: img && img.height,
        args: rest.map((v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v)),
        t: Math.round(performance.now()),
      });
    }
    return origDraw.apply(this, [img, ...rest]);
  };
  proto.fillRect = function (x, y, w, h) {
    if (window.__rec && label(this.canvas) === 'sky') {
      recs.push({ k: 'fill', c: 'sky', x: Math.round(x), y: Math.round(y), w, h, t: Math.round(performance.now()) });
    }
    return origFill.apply(this, arguments);
  };
  window.__markRec = () => recs.length;
  window.__since = (n) => recs.slice(n);
};

async function main() {
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--window-size=1400,1000'],
    defaultViewport: { width: 1400, height: 1000 },
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.evaluateOnNewDocument(HOOK);
  await page.goto(BASE, { waitUntil: 'load' });

  // 等所有人入场走完（walkIns 清空 = 排队闸门放行完毕，否则 hitTest 会跳过未就绪的鱼）
  await page.waitForFunction(() => {
    const w = window.__pixelOfficeWalk && window.__pixelOfficeWalk();
    if (!w) return false;
    const keys = Object.keys(w.win || {});
    return keys.length === 0;
  }, { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 800));

  const geo = await page.evaluate(() => {
    const doc = window.__pixelOfficeDebug ? null : null;
    const cv = document.querySelector('[data-po-stage] canvas');
    const r = cv.getBoundingClientRect();
    return { left: r.left, top: r.top, w: r.width, h: r.height };
  });
  const vp = (lx, ly) => ({ x: geo.left + lx * (geo.w / 320), y: geo.top + ly * (geo.h / 431) });

  // sub:0 的 bbox
  const box = await page.evaluate(() => {
    const d = window.__pixelOfficeDebug(59 + 13, 211 + 18);
    return d && d.boxes ? d.boxes['sub:0'] : null;
  });
  console.log('sub:0 box =', JSON.stringify(box), ' geo=', JSON.stringify(geo));
  if (!box) { console.log('!! 没拿到 sub:0 bbox'); await browser.close(); return; }

  const grab = vp(box.x + box.w / 2, box.y + box.h / 2);
  console.log('grab point =', JSON.stringify(grab));

  // ---- 阶段 A：按下 + 微动（面板内，原地）----
  await page.evaluate(() => { window.__rec = true; });
  let m = await page.evaluate(() => window.__markRec());
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + 2, grab.y + 2);
  await new Promise((r) => setTimeout(r, 350));
  const A = await page.evaluate((n) => window.__since(n), m);
  const actA = await page.evaluate(() => window.__pixelOfficeWalk().act['sub:0']);
  console.log('\n[A] 抓取后面板内 act[sub:0] =', JSON.stringify(actA));
  reportDraw('A 面板内抓取', A.filter((x) => x.k === 'draw' && /subs\//.test(x.src)).slice(-8));

  // ---- 阶段 B：拖到办公室内空白处（仍在 canvas 内）----
  m = await page.evaluate(() => window.__markRec());
  const inPos = vp(40, 355);
  await page.mouse.move(inPos.x, inPos.y, { steps: 8 });
  await new Promise((r) => setTimeout(r, 300));
  const B = await page.evaluate((n) => window.__since(n), m);
  const actB = await page.evaluate(() => window.__pixelOfficeWalk().act['sub:0']);
  console.log('\n[B] 面板内拖动 act[sub:0] =', JSON.stringify(actB));
  reportDraw('B 面板内拖到空白', B.filter((x) => x.k === 'draw' && /subs\//.test(x.src)).slice(-8));

  // ---- 阶段 C：拖出 canvas 左边（由 drawSky 绘制）----
  m = await page.evaluate(() => window.__markRec());
  const outX = geo.left - 70;
  const outY = vp(0, 355).y;
  await page.mouse.move(outX, outY, { steps: 8 });
  await new Promise((r) => setTimeout(r, 300));
  const C = await page.evaluate((n) => window.__since(n), m);
  console.log('\n[C] 画布外（drawSky）');
  reportDraw('C drawSky 绘制', C.filter((x) => x.k === 'draw' && /subs\//.test(x.src)).slice(-8));

  // ---- 阶段 D：画布外松手 → 逐帧采样懵逼 / 回家 ----
  m = await page.evaluate(() => window.__markRec());
  await page.mouse.up();
  console.log('\n[D] 画布外松手后逐帧采样：');
  for (const ms of [80, 200, 400, 700, 1000, 1300, 1700, 2400, 3200, 4200, 5600, 7000]) {
    await new Promise((r) => setTimeout(r, ms === 80 ? 80 : 0));
    const s = await page.evaluate(() => {
      const w = window.__pixelOfficeWalk();
      const a = w.act['sub:0'];
      const skyRecs = window.__since(window.__lastSky || 0);
      return { now: w.now, a: { phase: a.phase, facing: a.facing, glyph: a.glyph, hidden: a.hidden } };
    });
    const extra = await page.evaluate(() => {
      const w = window.__pixelOfficeWalk();
      const rec = window.__since(0);
      // 找 sub:0 最近的 sky 绘制（判断画布外有没有画、画多大）
      const sky = rec.filter((x) => x.k === 'draw' && x.c === 'sky' && /subs\//.test(x.src)).slice(-2);
      const fills = rec.filter((x) => x.k === 'fill' && x.t > (window.__lastT || 0)).length;
      window.__lastT = w.now;
      return { sky, fills };
    });
    console.log(`  t+${ms}ms now=${s.now} phase=${s.a.phase} facing=${s.a.facing} glyph=${s.a.glyph}`,
      'skyDraw=', JSON.stringify(extra.sky), 'skyFillRect=', extra.fills);
    if (ms < 7000) await new Promise((r) => setTimeout(r, 300));
  }

  const finalAct = await page.evaluate(() => {
    const w = window.__pixelOfficeWalk();
    return { act: w.act['sub:0'], pos: w.pos, path: w.path };
  });
  console.log('\n[E] 终局 sub:0 =', JSON.stringify(finalAct));

  await browser.close();
}

function reportDraw(title, arr) {
  console.log(`  -- ${title} (${arr.length} 条) --`);
  for (const d of arr) {
    const [dx, dy, dw, dh] = d.args;
    console.log(`     ${d.src}  img=${d.iw}x${d.ih}  dx=${dx} dy=${dy} dw=${dw === undefined ? '-' : dw} dh=${dh === undefined ? '-' : dh}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
