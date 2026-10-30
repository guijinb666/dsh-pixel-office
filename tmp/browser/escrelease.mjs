/**
 * 空格彩蛋「双击解除」端到端验收（m08712）。
 *
 * 用户原话：`增加功能，空格拖出坐下状态时，双击解除，走回办公室`
 *
 * 验收点：
 *   [A] 面板内：按住空格拖到画布内松手 → esc=true / phase=seated / 用坐地帧
 *   [B] 面板内双击 → esc 立刻清掉，phase 进入 walkhome
 *   [C] 回家是走回去的，不是瞬移：中途采样到多个不同 pos，且最终 phase=seated / pos=null
 *   [D] 面板外（画布右侧越界）：拖出去坐地 → 双击能命中（走窗口级监听）
 *   [E] 面板外双击 → phase=reenter（从门口走进来），最终回到 seated
 *   [F] 单击不解除：esc 保持 true、phase 保持 seated
 *   [G] 窗口级监听已挂上（__pixelOfficeWalk().escDown）
 *
 * 用法：node tmp/browser/escrelease.mjs [baseUrl]
 */
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] || 'http://127.0.0.1:8791/';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
let passes = 0;
function check(name, ok, detail) {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  ' + detail : ''));
  if (ok) passes += 1; else fails += 1;
}

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1400,900'],
});

/** 开页 → 展开面板 → 等全员坐稳。返回 { p, errs, geo }。 */
async function open() {
  const p = await browser.newPage();
  await p.setViewport({ width: 1400, height: 900 });
  const errs = [];
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  await p.goto(BASE, { waitUntil: 'load', timeout: 30000 });
  // 默认是木牌（每次重启最小化），展开只在这里做一次。
  await p.waitForSelector('[data-po-sign]', { timeout: 20000 }).catch(() => {});
  await p.evaluate(() => {
    const sign = document.querySelector('[data-po-sign]');
    if (sign && sign.style.display !== 'none') sign.click();
  });
  await p.waitForFunction(
    () => {
      const stage = document.querySelector('[data-po-stage]');
      const c = stage && stage.querySelector('canvas');
      if (!c) return false;
      const r = c.getBoundingClientRect();
      return r.width > 10 && r.height > 10;
    },
    { timeout: 20000, polling: 100 }
  );
  // 入场是串行排队的（副鱼晚好几秒才落座），必须先等全员坐稳再取 bbox，
  // 否则拿到的还是入场途中的位置，pointerdown 一定落空。
  await p.waitForFunction(
    () => {
      const w = window.__pixelOfficeWalk && window.__pixelOfficeWalk();
      if (!w || !w.act) return false;
      const keys = Object.keys(w.act);
      return keys.length > 0 &&
        Object.keys(w.win).length === 0 &&
        keys.every((k) => ['seated', 'working', 'idle'].includes(w.act[k].phase));
    },
    { timeout: 45000, polling: 150 }
  ).catch(() => {});

  const geo = await p.evaluate(() => {
    const cv = document.querySelector('[data-po-stage] canvas');
    const r = cv.getBoundingClientRect();
    const dbg = window.__pixelOfficeDebug(0, 0);
    return { left: r.left, top: r.top, width: r.width, height: r.height, sw: dbg.scene.w, sh: dbg.scene.h };
  });
  return { p, errs, geo };
}

/** 逻辑坐标 → 视口坐标。 */
function toVp(geo, lx, ly) {
  return {
    x: geo.left + lx * (geo.width / geo.sw),
    y: geo.top + ly * (geo.height / geo.sh),
  };
}

/** 按住空格把某条鱼拖到 (lx,ly) 松手。 */
async function spaceDrag(p, geo, seatId, lx, ly) {
  const start = await p.evaluate((sid) => {
    const dbg = window.__pixelOfficeDebug(0, 0);
    const b = dbg.boxes && dbg.boxes[sid];
    if (!b) return null;
    return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  }, seatId);
  if (!start) throw new Error('拿不到 ' + seatId + ' 的包围盒');
  const g = toVp(geo, start.x, start.y);
  const d = toVp(geo, lx, ly);

  await p.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }));
  });
  await p.mouse.move(g.x, g.y);
  await p.mouse.down();
  await sleep(90);
  await p.mouse.move(g.x + 4, g.y + 3);
  await sleep(80);
  // 分两步移动，让 moveGrab 的 moved 判定稳定成立
  await p.mouse.move((g.x + d.x) / 2, (g.y + d.y) / 2);
  await sleep(80);
  await p.mouse.move(d.x, d.y);
  await sleep(120);
  await p.mouse.up();
  await p.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', key: ' ', bubbles: true }));
  });
  return d;
}

/** 兼容旧调用：只拖主鱼。 */
const spaceDragMain = (p, geo, lx, ly) => spaceDrag(p, geo, 'main', lx, ly);

/** 在视口坐标双击（两次 down/up，间隔 < DBL_MS=320）。 */
async function dblClickAt(p, x, y) {
  await p.mouse.move(x, y);
  await p.mouse.down();
  await p.mouse.up();
  await sleep(70);
  await p.mouse.down();
  await p.mouse.up();
}

const walk = (p) => p.evaluate(() => window.__pixelOfficeWalk());

/** 轮询直到 pred 为真。返回最后一次快照。 */
async function waitFor(p, pred, ms = 12000, step = 100) {
  let waited = 0;
  let last = null;
  while (waited < ms) {
    last = await walk(p);
    if (pred(last)) return { ok: true, snap: last, waited };
    await sleep(step);
    waited += step;
  }
  return { ok: false, snap: last, waited };
}

// ---------------------------------------------------------------------------
// 场景 A/B/C：面板内坐地 → 双击解除 → 走回工位
// ---------------------------------------------------------------------------
console.log('[A] 面板内坐地 → 双击解除 → 走回工位');
{
  const { p, errs, geo } = await open();

  check('G 窗口级指针监听已挂上', (await walk(p)).escDown === true);

  // 拖到画布内右下方（离开工位，但整条鱼在画布内）
  await spaceDragMain(p, geo, geo.sw - 46, geo.sh - 60);
  await sleep(500);

  const s0 = (await walk(p)).act.main;
  check('A 松手后进入彩蛋态（esc=true）', s0.esc === true, JSON.stringify({ esc: s0.esc, phase: s0.phase }));
  check('A 就地坐地（phase=seated）', s0.phase === 'seated', 'phase=' + s0.phase);
  check('A 用的是坐地帧（onFloor=true）', s0.frame && s0.frame.onFloor === true, JSON.stringify(s0.frame));
  const pos0 = s0.pos;
  check('A 落点在画布内', !!pos0 && pos0.x > 0 && pos0.x < geo.sw && pos0.y > 0 && pos0.y < geo.sh, JSON.stringify(pos0));

  // 在鱼的视口位置双击
  const hit = toVp(geo, pos0.x + 8, pos0.y + 8);
  await dblClickAt(p, hit.x, hit.y);
  await sleep(120);

  const s1 = (await walk(p)).act.main;
  check('B 双击立刻清掉彩蛋标记（esc=false）', s1.esc === false, JSON.stringify({ esc: s1.esc, phase: s1.phase }));
  check('B 进入回家相位（walkhome / reenter）', s1.phase === 'walkhome' || s1.phase === 'reenter', 'phase=' + s1.phase);
  check('B 已排好回家折线', Array.isArray(s1.path) && s1.path.length >= 2, 'path=' + (s1.path ? s1.path.length : 0) + ' 点');

  // 采样位移：不能瞬移
  const seen = [];
  for (let i = 0; i < 26; i += 1) {
    const a = (await walk(p)).act.main;
    if (a.pos) seen.push(a.pos.x + ',' + a.pos.y);
    await sleep(120);
  }
  const uniq = [...new Set(seen)];
  check('C 回家是走回去的（采样到多个不同位置）', uniq.length >= 3, '不同位置 ' + uniq.length + ' 个');

  const done = await waitFor(p, (w) => w.act.main.phase === 'seated' && w.act.main.pos === null, 15000);
  check('C 最终回到工位（phase=seated 且 pos 归位）', done.ok, done.ok ? '' : JSON.stringify(done.snap && done.snap.act.main));
  check('C 解除后不再残留彩蛋标记', done.snap && done.snap.act.main.esc === false);

  check('A/B/C 无 JS 异常', errs.length === 0, errs.join(' | '));
  await p.close();
}

// ---------------------------------------------------------------------------
// 场景 D/E：面板外坐地 → 双击解除（走窗口级监听）
// ---------------------------------------------------------------------------
console.log('[D] 面板外坐地 → 双击解除（窗口级监听）');
{
  const { p, errs, geo } = await open();

  // 拖到画布右侧外：鱼整条越界，由天空浮层绘制、canvas 收不到它的指针事件
  await spaceDragMain(p, geo, geo.sw + 34, geo.sh - 70);
  await sleep(500);

  const s0 = (await walk(p)).act.main;
  check('D 画布外的鱼也进入彩蛋态', s0.esc === true && s0.phase === 'seated', JSON.stringify({ esc: s0.esc, phase: s0.phase }));
  check('D 落点确实越界（x > 场景宽）', !!s0.pos && s0.pos.x > geo.sw, JSON.stringify(s0.pos));

  // 点击点必须在视口内：越界 34 逻辑像素换算到视口只有几十像素
  const hit = toVp(geo, s0.pos.x + 6, s0.pos.y + 8);
  const inView = hit.x > 0 && hit.x < 1400 && hit.y > 0 && hit.y < 900;
  check('D 点击点落在视口内（可点）', inView, JSON.stringify({ x: Math.round(hit.x), y: Math.round(hit.y) }));

  await dblClickAt(p, hit.x, hit.y);
  await sleep(150);

  const s1 = (await walk(p)).act.main;
  check('E 面板外双击也能解除（esc=false）', s1.esc === false, JSON.stringify({ esc: s1.esc, phase: s1.phase }));
  check('E 走「从门口进来」路线（phase=reenter）', s1.phase === 'reenter', 'phase=' + s1.phase);

  const done = await waitFor(p, (w) => w.act.main.phase === 'seated' && w.act.main.pos === null, 25000, 150);
  check('E 最终回到工位', done.ok, done.ok ? '' : JSON.stringify(done.snap && done.snap.act.main));

  check('D/E 无 JS 异常', errs.length === 0, errs.join(' | '));
  await p.close();
}

// ---------------------------------------------------------------------------
// 场景 F：单击不解除
// ---------------------------------------------------------------------------
console.log('[F] 单击不解除');
{
  const { p, errs, geo } = await open();

  await spaceDragMain(p, geo, geo.sw - 50, geo.sh - 64);
  await sleep(450);

  const s0 = (await walk(p)).act.main;
  check('F 先进入彩蛋态', s0.esc === true && s0.phase === 'seated', JSON.stringify({ esc: s0.esc, phase: s0.phase }));

  const hit = toVp(geo, s0.pos.x + 8, s0.pos.y + 8);
  await p.mouse.move(hit.x, hit.y);
  await p.mouse.down();
  await p.mouse.up();
  await sleep(400);   // 超过 DBL_MS，不会被判成双击

  const s1 = (await walk(p)).act.main;
  check('F 单击后仍是彩蛋态（esc=true）', s1.esc === true, JSON.stringify({ esc: s1.esc, phase: s1.phase }));
  check('F 单击后仍就地坐地（phase=seated）', s1.phase === 'seated', 'phase=' + s1.phase);
  check('F 单击后位置没被抖回工位', !!s1.pos && Math.abs(s1.pos.x - s0.pos.x) <= 2 && Math.abs(s1.pos.y - s0.pos.y) <= 2,
    JSON.stringify({ before: s0.pos, after: s1.pos }));

  check('F 无 JS 异常', errs.length === 0, errs.join(' | '));
  await p.close();
}

// ---------------------------------------------------------------------------
// 场景 H：副鱼双击解除（副鱼的 spriteW / spriteHeightFor / 坐地帧都与主鱼不同）
// ---------------------------------------------------------------------------
console.log('[H] 副鱼坐地 → 双击解除 → 走回工位');
{
  const { p, errs, geo } = await open();

  const seats = await p.evaluate(() => Object.keys(window.__pixelOfficeDebug(0, 0).boxes || {}));
  const sub = seats.find((k) => k.startsWith('sub:'));
  check('H 拿到了副鱼席位', !!sub, '席位=' + JSON.stringify(seats));

  if (sub) {
    await spaceDrag(p, geo, sub, geo.sw - 52, geo.sh - 58);
    await sleep(500);

    const s0 = (await walk(p)).act[sub];
    check('H 副鱼进入彩蛋态', s0.esc === true && s0.phase === 'seated', JSON.stringify({ esc: s0.esc, phase: s0.phase }));
    check('H 副鱼用坐地帧（onFloor=true）', s0.frame && s0.frame.onFloor === true, JSON.stringify(s0.frame));
    check('H 副鱼朝向正面（面对观众）', s0.facing === 'front', 'facing=' + s0.facing);

    const hit = toVp(geo, s0.pos.x + 8, s0.pos.y + 8);
    await dblClickAt(p, hit.x, hit.y);
    await sleep(140);

    const s1 = (await walk(p)).act[sub];
    check('H 副鱼双击解除（esc=false）', s1.esc === false, JSON.stringify({ esc: s1.esc, phase: s1.phase }));
    check('H 副鱼进入回家相位', s1.phase === 'walkhome' || s1.phase === 'reenter', 'phase=' + s1.phase);

    const done = await waitFor(p, (w) => w.act[sub].phase === 'seated' && w.act[sub].pos === null, 15000);
    check('H 副鱼最终回到工位', done.ok, done.ok ? '' : JSON.stringify(done.snap && done.snap.act[sub]));
  }

  check('H 无 JS 异常', errs.length === 0, errs.join(' | '));
  await p.close();
}

await browser.close();
console.log('\nescrelease  PASS=' + passes + '  FAIL=' + fails);
process.exit(fails === 0 ? 0 : 1);
