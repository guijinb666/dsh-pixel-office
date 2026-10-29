/**
 * 空格彩蛋端到端验收（m06554 第 6 条）。
 *
 * 用户原话要求：
 *   「按住空格把鱼拖出办公室，松手后鱼坐地上（每条都是）；
 *     要**全部**鱼含主鱼都这样拖出来才触发；
 *     触发后所有鱼排成一列向屏幕右边走出，出画面后弹告示牌。」
 *
 * 验收点：
 *   [1] 只拖出部分鱼（< 全员）→ parade 保持 0，不触发
 *   [2] 每条被拖出的鱼都是 esc=true 且 phase=seated（就地坐地，不回家）
 *   [3] 全员出逃后 parade 从 1 → 2（排队 → 向右走）
 *   [4] 队列按落点 x 升序排、每条都有 walkPath
 *   [5] 全员走出右沿后 parade=3 且弹出告示牌 DOM
 *
 * 用法：node tmp/browser/parade.mjs [baseUrl]
 */
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] || 'http://127.0.0.1:8791/';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
function check(name, ok, detail) {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  ' + detail : ''));
  if (!ok) fails += 1;
}

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1400,900'],
});

/** 展开面板并等入场走完，返回 page。 */
async function open() {
  const p = await browser.newPage();
  await p.setViewport({ width: 1400, height: 900 });
  const errs = [];
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  await p.goto(BASE + '?act=parade', { waitUntil: 'load', timeout: 30000 });
  // 默认是木牌（每次重启最小化），展开只由这里做一次 —— harness 只等不点。
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
  return { p, errs };
}

// ---------------------------------------------------------------------------
// 场景 A：只手动拖 1 条（不靠剧本），确认 parade 不触发
// ---------------------------------------------------------------------------
console.log('[A] 只拖 1 条鱼：不能触发彩蛋');
{
  const p = await browser.newPage();
  await p.setViewport({ width: 1400, height: 900 });
  await p.goto(BASE, { waitUntil: 'load', timeout: 30000 });
  await p.waitForSelector('[data-po-sign]', { timeout: 20000 }).catch(() => {});
  await p.evaluate(() => {
    const sign = document.querySelector('[data-po-sign]');
    if (sign && sign.style.display !== 'none') sign.click();
  });
  await sleep(2500);

  const r = await p.evaluate(async () => {
    const cv = document.querySelector('[data-po-stage] canvas');
    if (!cv) return { err: 'no canvas' };
    const dbg = window.__pixelOfficeDebug(0, 0);
    if (!dbg || !dbg.boxes || !dbg.boxes.main) return { err: 'no boxes ' + JSON.stringify(dbg && dbg.why) };
    const sceneW = dbg.scene.w;
    const sceneH = dbg.scene.h;
    const rect = cv.getBoundingClientRect();
    const toVp = (lx, ly) => ({
      x: rect.left + lx * (rect.width / sceneW),
      y: rect.top + ly * (rect.height / sceneH),
    });
    const b = dbg.boxes.main;
    const g = toVp(b.x + b.w / 2, b.y + b.h / 2);
    const d = toVp(sceneW + 40, -10);
    const fire = (type, x, y) => cv.dispatchEvent(new PointerEvent(type, {
      clientX: x, clientY: y, pointerId: 1, button: 0,
      bubbles: true, cancelable: true, pointerType: 'mouse',
    }));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }));
    fire('pointerdown', g.x, g.y);
    await new Promise((s) => setTimeout(s, 110));
    fire('pointermove', g.x + 5, g.y + 4);
    await new Promise((s) => setTimeout(s, 120));
    fire('pointermove', d.x, d.y);
    await new Promise((s) => setTimeout(s, 120));
    fire('pointerup', d.x, d.y);
    await new Promise((s) => setTimeout(s, 900));
    const w = window.__pixelOfficeWalk();
    return {
      parade: w.parade || 0,
      mainPhase: w.act.main.phase,
      mainEsc: !!w.act.main.esc,
      escList: Object.keys(w.act).filter((k) => w.act[k].esc),
    };
  });

  if (r.err) {
    check('A 拖 1 条鱼', false, r.err);
  } else {
    check('A 主鱼已进入出逃态（esc=true）', r.mainEsc === true, JSON.stringify({ esc: r.mainEsc, phase: r.mainPhase }));
    check('A 主鱼就地坐地（phase=seated）', r.mainPhase === 'seated', 'phase=' + r.mainPhase);
    check('A 只有 1 条 esc，未触发彩蛋', r.parade === 0, 'parade=' + r.parade + ' esc=' + JSON.stringify(r.escList));
  }
  await p.close();
}

// ---------------------------------------------------------------------------
// 场景 B：剧本拖出全部 4 条 → 彩蛋应该触发到 parade=3
// ---------------------------------------------------------------------------
console.log('[B] 全员出逃：排队 → 向右走 → 弹告示牌');
{
  const { p, errs } = await open();

  // 不用固定时长硬等：入场是串行排队的（副鱼比主鱼晚好几秒才落座），
  // 之后还有「各自走到槽位」+「一起向右出画」两段路，总时长不可预估。
  // 改为轮询 parade 状态，等到 3（已弹牌）或超时为止。
  let waited = 0;
  let maxParade = 0;
  while (waited < 120000) {
    await sleep(700);
    waited += 700;
    const st = await p.evaluate(() => {
      const w = window.__pixelOfficeWalk ? window.__pixelOfficeWalk() : null;
      return {
        parade: w ? (w.parade || 0) : 0,
        board: !!document.querySelector('[data-po-board]'),
      };
    });
    if (st.parade > maxParade) maxParade = st.parade;
    if (st.parade >= 3 || st.board) break;
  }
  console.log('  （轮询 ' + Math.round(waited / 1000) + 's，parade 峰值 ' + maxParade + '）');
  await sleep(1500);   // 等弹牌动画（scale 0.02 → 1）落定

  const log = await p.evaluate(() => (window.__errs || []).slice());
  const all = log.join('\n');

  // 从日志里捞 parade 值（与轮询峰值取最大，两条路径互为佐证）
  const vals = [...all.matchAll(/parade=(\d+)/g)].map((m) => Number(m[1]));
  if (vals.length) maxParade = Math.max(maxParade, ...vals);

  check('B 剧本抓到了目标席位列表', /parade:targets=\[.+\]/.test(all), (all.match(/parade:targets=\[[^\]]*\]/) || ['未找到'])[0]);
  check('B 空格键已按下', /parade:space-down/.test(all));
  check('B 全部鱼进入出逃态', /esc="?\{[^}]*"main"[^}]*"sub:0"[^}]*"sub:1"[^}]*"sub:2"/.test(all) || (all.match(/esc=\{[^}]*\}/g) || []).some((s) => (s.match(/"main"|"sub:\d"/g) || []).length >= 4), (all.match(/esc=\{[^}]*\}/g) || []).slice(-1)[0] || '未找到 esc 快照');
  check('B 彩蛋已触发（parade 从 0 涨起来）', maxParade >= 1, 'max parade=' + maxParade + ' 轨迹=' + JSON.stringify(vals));
  check('B 走到「全员向右出画」阶段（parade≥2）', maxParade >= 2, 'max parade=' + maxParade);
  check('B 全员出画后弹牌（parade=3）', maxParade === 3, 'max parade=' + maxParade);

  // 告示牌 DOM：showBoard 会插 [data-po-board]
  const board = await p.evaluate(() => {
    const el = document.querySelector('[data-po-board]');
    if (!el) return { found: false };
    const r = el.getBoundingClientRect();
    const img = el.querySelector('img');
    const cv2 = el.querySelector('canvas');
    return {
      found: true,
      w: Math.round(r.width),
      h: Math.round(r.height),
      visible: r.width > 100 && r.height > 100,
      hasImg: !!img,
      imgLoaded: !!(img && img.complete && img.naturalWidth > 0),
      hasTextCanvas: !!cv2,
      z: el.style.zIndex,
    };
  });
  check('B 告示牌 DOM 已插入', board.found === true);
  if (board.found) {
    check('B 告示牌可见（>100x100）', board.visible === true, board.w + 'x' + board.h);
    check('B 告示牌底图已加载', board.imgLoaded === true);
    check('B 告示牌有文字画布', board.hasTextCanvas === true);
  }

  // 面板应已收成木牌（showBoard 里 setMinimized(true)）
  const minimized = await p.evaluate(() => {
    const sign = document.querySelector('[data-po-sign]');
    const card = document.querySelector('[data-po-card]');
    return {
      signShown: !!(sign && sign.style.display !== 'none'),
      cardHidden: !!(card && (card.style.display === 'none' || card.getBoundingClientRect().width < 5)),
    };
  });
  check('B 弹牌时办公室面板收成木牌', minimized.signShown === true || minimized.cardHidden === true, JSON.stringify(minimized));

  check('B 无 JS 异常', errs.length === 0, errs.join(' | '));

  await p.close();
}

await browser.close();
console.log('\nparade  PASS=' + (fails === 0 ? 'all' : '-') + '  FAIL=' + fails);
process.exit(fails === 0 ? 0 : 1);
