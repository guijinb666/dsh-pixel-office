/**
 * 只读诊断探针 v2（不改任何项目文件）：
 * 记录**全部** drawImage / fillRect（不过滤源文件名），用 canvas 身份区分 stage / sky，
 * 分阶段验证 bug1（副鱼抓取后尺寸）、bug3（画布外懵逼动画）。
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
  const origDraw = proto.drawImage;
  const origFill = proto.fillRect;
  window.__cvIds = new WeakMap();
  let cvSeq = 0;
  function cid(cv) {
    if (!cv) return -1;
    let v = window.__cvIds.get(cv);
    if (v === undefined) { v = (cvSeq += 1); window.__cvIds.set(cv, v); }
    return v;
  }
  window.__cvInfo = () => {
    const out = [];
    document.querySelectorAll('canvas').forEach((c, i) => {
      const s = getComputedStyle(c);
      out.push({ i, id: cid(c), pos: s.position, z: s.zIndex, cls: c.className,
        attrW: c.width, attrH: c.height, cssW: s.width, cssH: s.height });
    });
    return out;
  };
  proto.drawImage = function (img) {
    if (window.__rec) {
      const a = Array.prototype.slice.call(arguments, 1);
      window.__recs.push({
        k: 'draw', cv: cid(this.canvas),
        src: String((img && (img.currentSrc || img.src)) || ''),
        iw: img && img.width, ih: img && img.height,
        a: a.map((v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : String(v))),
        t: Math.round(performance.now()),
      });
    }
    return origDraw.apply(this, arguments);
  };
  proto.fillRect = function (x, y, w, h) {
    if (window.__rec) {
      window.__recs.push({ k: 'fill', cv: cid(this.canvas),
        x: Math.round(x), y: Math.round(y), w, h, t: Math.round(performance.now()) });
    }
    return origFill.apply(this, arguments);
  };
};

async function main() {
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
  await new Promise((r) => setTimeout(r, 800));

  const cvs = await page.evaluate(() => window.__cvInfo());
  console.log('canvas 清单:', JSON.stringify(cvs));

  const geo = await page.evaluate(() => {
    const cv = document.querySelector('[data-po-stage] canvas');
    const r = cv.getBoundingClientRect();
    return { left: r.left, top: r.top, w: r.width, h: r.height };
  });
  const vp = (lx, ly) => ({ x: geo.left + lx * (geo.w / 320), y: geo.top + ly * (geo.h / 431) });
  const box = await page.evaluate(() => window.__pixelOfficeDebug(72, 229).boxes['sub:0']);
  console.log('sub:0 box =', JSON.stringify(box), ' geo=', JSON.stringify(geo));

  const grab = vp(box.x + box.w / 2, box.y + box.h / 2);
  await page.evaluate(() => { window.__rec = true; });

  function show(tag, recs, cvId) {
    const draws = recs.filter((r) => r.k === 'draw' && r.cv === cvId);
    const fills = recs.filter((r) => r.k === 'fill' && r.cv === cvId);
    console.log(`  ${tag}: drawImage=${draws.length} fillRect=${fills.length}`);
    const seen = new Set();
    for (const d of draws) {
      const key = d.src.split('/').slice(-1)[0] + '|' + d.a.join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      console.log(`     cv${d.cv} ${d.src.split('/').slice(-2).join('/')} img=${d.iw}x${d.ih} args=[${d.a.join(', ')}]`);
    }
    if (fills.length) {
      const bySize = {};
      fills.forEach((f) => { const k = f.w + 'x' + f.h; bySize[k] = (bySize[k] || 0) + 1; });
      console.log('     fillRect 尺寸分布:', JSON.stringify(bySize));
    }
  }

  // 阶段 A：面板内抓取（不动）
  let m = await page.evaluate(() => window.__mark());
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + 2, grab.y + 2);
  await new Promise((r) => setTimeout(r, 400));
  let recs = await page.evaluate((n) => window.__since(n), m);
  console.log('\n[A] 面板内抓取（phase=' +
    (await page.evaluate(() => window.__pixelOfficeWalk().act['sub:0'].phase)) + '）');
  show('stage canvas', recs, 1);

  // 阶段 B：拖到画布内空白（逻辑 40,355）
  m = await page.evaluate(() => window.__mark());
  const inPos = vp(40, 355);
  await page.mouse.move(inPos.x, inPos.y, { steps: 10 });
  await new Promise((r) => setTimeout(r, 400));
  recs = await page.evaluate((n) => window.__since(n), m);
  console.log('\n[B] 拖到画布内空白（仍在面板内绘制）');
  show('stage canvas', recs, 1);

  // 阶段 C：拖出画布左边界（由 drawSky 浮层绘制）
  m = await page.evaluate(() => window.__mark());
  const outY = vp(0, 355).y;
  await page.mouse.move(geo.left - 70, outY, { steps: 10 });
  await new Promise((r) => setTimeout(r, 400));
  recs = await page.evaluate((n) => window.__since(n), m);
  console.log('\n[C] 拖出画布左边界（drawSky）');
  show('stage canvas', recs, 1);
  const skyIds = cvs.filter((c) => c.pos === 'fixed').map((c) => c.id);
  for (const id of skyIds) show('sky canvas cv' + id, recs, id);
  if (!skyIds.length) console.log('  !! 没有 fixed 定位的 canvas（drawSky 未初始化？）');

  // 阶段 D：画布外松手 → 采样懵逼动画
  await page.mouse.up();
  console.log('\n[D] 画布外松手后每 120ms 采样（1500ms 内），之后每 500ms 采到 8s');
  const t0 = Date.now();
  const seen2 = [];
  for (let i = 0; i < 12; i += 1) {
    const s = await page.evaluate(() => {
      const w = window.__pixelOfficeWalk();
      const a = w.act['sub:0'];
      const n = window.__mark();
      return { now: w.now, phase: a.phase, facing: a.facing, glyph: a.glyph, hidden: a.hidden, n };
    });
    seen2.push(s);
    await new Promise((r) => setTimeout(r, 120));
  }
  // 在 confused 期间抓一轮 sky 绘制
  const m2 = await page.evaluate(() => window.__mark());
  await new Promise((r) => setTimeout(r, 250));
  const drecs = await page.evaluate((n) => window.__since(n), m2);
  console.log('  phase 序列:', seen2.map((s) => `${s.now}:${s.phase}/${s.facing}/${s.glyph || '-'}`).join(' → '));
  console.log('  confused 期间 drawSky 输出:');
  for (const id of skyIds) show('sky canvas cv' + id, drecs, id);

  for (let i = 0; i < 14; i += 1) {
    const s = await page.evaluate(() => {
      const w = window.__pixelOfficeWalk();
      const a = w.act['sub:0'];
      return { now: w.now, phase: a.phase, facing: a.facing, glyph: a.glyph, pos: w.pos, path: w.path };
    });
    console.log(`  t+${Date.now() - t0}ms now=${s.now} phase=${s.phase} facing=${s.facing} glyph=${s.glyph || '-'}`);
    await new Promise((r) => setTimeout(r, 500));
  }

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
