/**
 * 只读诊断探针 v3（不改任何项目文件）：
 *  ① 拖 sub:2（m5-sporty，walk-side 只有 13px 宽内容）验证「一抓就缩小」；
 *  ② 拖到画布内、远离地面处（天花板）松手，采样轨迹，看它是从哪儿走回来的；
 *  ③ 拖到画布外左侧松手，逐帧采样 actorBox 轨迹，检测是否有瞬移（跳变）；
 *  ④ 指针在画布外、鱼框仍在画布内（拉尾巴）松手，验证 inside 判定与鱼自身边界不一致。
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
  const ids = new WeakMap();
  let seq = 0;
  const cid = (cv) => {
    if (!cv) return -1;
    let v = ids.get(cv);
    if (v === undefined) { v = (seq += 1); ids.set(cv, v); }
    return v;
  };
  window.__cvOfPos = () => {
    const out = {};
    document.querySelectorAll('canvas').forEach((c) => {
      out[cid(c)] = getComputedStyle(c).position;
    });
    return out;
  };
  proto.drawImage = function (img) {
    if (window.__rec) {
      window.__recs.push({
        k: 'draw', cv: cid(this.canvas),
        src: String((img && (img.currentSrc || img.src)) || ''),
        iw: img && img.width, ih: img && img.height,
        a: Array.prototype.slice.call(arguments, 1).map((v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : String(v))),
        t: Math.round(performance.now()),
      });
    }
    return origDraw.apply(this, arguments);
  };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  await sleep(900);

  const geo = await page.evaluate(() => {
    const cv = document.querySelector('[data-po-stage] canvas');
    const r = cv.getBoundingClientRect();
    return { left: r.left, top: r.top, w: r.width, h: r.height };
  });
  const vp = (lx, ly) => ({ x: geo.left + lx * (geo.w / 320), y: geo.top + ly * (geo.h / 431) });
  const cvPos = await page.evaluate(() => window.__cvOfPos());
  console.log('canvas 身份:', JSON.stringify(cvPos), ' geo=', JSON.stringify(geo));
  const skyId = Number(Object.keys(cvPos).find((k) => cvPos[k] === 'fixed'));

  const boxOf = async (seat) => page.evaluate((s) => {
    const d = window.__pixelOfficeDebug(0, 0);
    return d.boxes[s] || null;
  }, seat);

  // 最近一帧某 canvas 上、某 seat 相关 sprite 的绘制（用 skin 文件名过滤）
  async function lastSprite(cvId, nameRe, fromMark) {
    return page.evaluate((cv, re, n) => {
      const rs = window.__since(n).filter((r) => r.k === 'draw' && r.cv === cv && new RegExp(re).test(r.src));
      const last = rs[rs.length - 1];
      return last ? { src: last.src.split('/').slice(-2).join('/'), iw: last.iw, ih: last.ih, a: last.a } : null;
    }, cvId, nameRe, fromMark);
  }

  // ---------- ① 拖 sub:2（m5-sporty）看「一抓就缩小」 ----------
  const b2 = await boxOf('sub:2');
  console.log('\n=== ① sub:2 bbox =', JSON.stringify(b2));
  let m = await page.evaluate(() => window.__mark());
  await page.evaluate(() => { window.__rec = true; });
  const g2 = vp(b2.x + b2.w / 2, b2.y + b2.h / 2);
  await page.mouse.move(g2.x, g2.y);
  await page.mouse.down();
  await page.mouse.move(g2.x + 2, g2.y + 2);
  await sleep(350);
  console.log('  抓取前(上一帧静止):', JSON.stringify(await lastSprite(1, 'm5-sporty', m)));
  const after2 = await lastSprite(1, 'm5-sporty', m);
  console.log('  抓取后:', JSON.stringify(after2));

  // 拖到画布内空白并松手（不移动指针则不会触发 moveGrab；先拖到 (40,355)）
  const inPos = vp(40, 355);
  await page.mouse.move(inPos.x, inPos.y, { steps: 8 });
  await sleep(150);
  await page.mouse.up();
  await sleep(200);

  // ---------- ② 拖 sub:0 到画布内天花板松手 ----------
  await page.waitForFunction(() => {
    const w = window.__pixelOfficeWalk();
    const a = w.act['sub:0'];
    return a && a.phase === 'seated';
  }, { timeout: 20000 });
  const b0 = await boxOf('sub:0');
  console.log('\n=== ② sub:0 bbox =', JSON.stringify(b0));
  const g0 = vp(b0.x + b0.w / 2, b0.y + b0.h / 2);
  await page.mouse.move(g0.x, g0.y);
  await page.mouse.down();
  await page.mouse.move(g0.x + 2, g0.y + 2);
  await sleep(120);
  const ceil = vp(200, 60);
  await page.mouse.move(ceil.x, ceil.y, { steps: 8 });
  await sleep(150);
  await page.mouse.up();
  console.log('  在画布内天花板(200,60)松手 → 采样轨迹（box 左上角）:');
  for (let i = 0; i < 8; i += 1) {
    const s = await page.evaluate(() => {
      const w = window.__pixelOfficeWalk();
      const a = w.act['sub:0'];
      return { now: w.now, phase: a.phase, b: window.__pixelOfficeDebug(0, 0).boxes['sub:0'] };
    });
    console.log(`    t+${i * 250}ms phase=${s.phase} box=${JSON.stringify(s.b)}`);
    await sleep(250);
  }

  // 等它回到 seated
  await page.waitForFunction(() => {
    const w = window.__pixelOfficeWalk();
    return w.act['sub:0'].phase === 'seated';
  }, { timeout: 30000 });

  // ---------- ③ 拖 sub:0 到画布外左侧松手，采样轨迹找瞬移 ----------
  const b0b = await boxOf('sub:0');
  const g0b = vp(b0b.x + b0b.w / 2, b0b.y + b0b.h / 2);
  await page.mouse.move(g0b.x, g0b.y);
  await page.mouse.down();
  await page.mouse.move(g0b.x + 2, g0b.y + 2);
  await sleep(120);
  const outLeft = { x: geo.left - 80, y: vp(0, 340).y };
  await page.mouse.move(outLeft.x, outLeft.y, { steps: 10 });
  await sleep(150);
  await page.mouse.up();
  console.log('\n=== ③ 画布外左侧松手 → 采样轨迹（找瞬移）:');
  let prev = null;
  for (let i = 0; i < 30; i += 1) {
    const s = await page.evaluate(() => {
      const w = window.__pixelOfficeWalk();
      const a = w.act['sub:0'];
      return { now: w.now, phase: a.phase, b: window.__pixelOfficeDebug(0, 0).boxes['sub:0'] };
    });
    const b = s.b;
    let jump = '';
    if (prev && b) {
      const d = Math.abs(b.x - prev.x) + Math.abs(b.y - prev.y);
      if (d > 12) jump = `  <<== 跳变 ${d}px`;
    }
    console.log(`    now=${s.now} phase=${s.phase} box=${b ? `(${b.x},${b.y},${b.w},${b.h})` : 'null'}${jump}`);
    if (b) prev = b;
    if (s.phase === 'seated' && i > 6) break;
    await sleep(120);
  }

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
