/**
 * D13 交互剧本验收：在真 Chromium 里跑 tmp/harness-server.mjs 提供的自动化剧本，
 * 收集页面内 __errs 里 dump 的相位轨迹，逐条判定期望没有发生。
 *
 * 覆盖：
 *   1. probe             —— 命中测试能抓到主鱼
 *   2. dragout           —— 抓起来能拖到面板外（pos 离开 0..320/0..431）
 *   3. dragout-release2  —— 面板外松手：懵逼 → 走到门口出画 → 从门口走回工位
 *   4. dragin            —— 面板内松手：懵逼后沿过道走回工位
 *   5. dbl1              —— 一级双击：转正面 + 爱心
 *   6. dbl3              —— 三级双击：爱心 → 烟雾消失再出现/🤓👆 → 跳/裂纹/掉落/回位
 *
 * dump 行格式（harness-server.mjs）：
 *   <tag> act=<main 的 act JSON> pos=<pos JSON> path=<path JSON> frames=N lastTs=T
 *
 * 用法：node tmp/browser/d13.mjs [baseUrl]
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

/** 跑一个 act 剧本，返回整段日志。 */
async function runAct(act, ms) {
  const p = await browser.newPage();
  await p.setViewport({ width: 1400, height: 900 });
  const jsErrs = [];
  p.on('pageerror', (e) => jsErrs.push('pageerror: ' + e.message));
  await p.goto(BASE + '?act=' + act, { waitUntil: 'load', timeout: 30000 });
  // 启动后默认是木牌（用户要求每次重启最小化）。**展开只由这里做一次**，
  // harness 的 run() 只等着不点 —— 两边都点会互相顶回去（toggle），
  // canvas 尺寸永远归零，所有坐标点击落空（dbl1 恒 back/dbl=0 就是这么来的）。
  // 启动后默认是木牌（用户要求每次重启最小化）。**展开只由这里做一次**，
  // harness 的 run() 只等着不点 —— 两边都点会互相顶回去（toggle），
  // canvas 尺寸永远归零，所有坐标点击落空（dbl1 恒 back/dbl=0 就是这么来的）。
  // probe 也要展开：hitTest 走 toLogical 需要 canvas 的真实矩形，
  // 木牌态下矩形是 0x0，探测结果恒为 null（d13 自己不断言默认最小化，
  // 那条断言留给 panel.mjs / diag-report.mjs）。
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
  await sleep(ms);
  const log = await p.evaluate(() => (window.__errs || []).slice());
  await p.close();
  return { log, jsErrs };
}

/** 取某个 tag 的 dump 行。 */
function dumpLine(log, tag) {
  return log.filter((l) => l.indexOf(tag + ' act=') === 0)[0] || '';
}

/** 解析 dump 行 → { act, pos, path, frames }（act 是主鱼那一条的 act 对象）。 */
function parseDump(line) {
  if (!line) return null;
  const m = /^(\S+) act=(\{.*?\}) pos=(.*?) path=(.*?) frames=(\d+)/.exec(line);
  if (!m) return null;
  const j = (s) => { try { return JSON.parse(s); } catch { return null; } };
  return { tag: m[1], act: j(m[2]), pos: j(m[3]), path: j(m[4]), frames: Number(m[5]) };
}

// ---------- 1. probe ----------
console.log('[1] 命中测试');
{
  const { log, jsErrs } = await runAct('probe', 7000);
  const hit = log.filter((l) => l.indexOf('probe(172,140)=') === 0)[0] || '';
  check('命中主鱼', /"hit":"main"/.test(hit), hit.slice(0, 150) + (hit.length > 150 ? '…' : ''));
  const walk = log.filter((l) => l.indexOf('walk=') === 0)[0] || '';
  check('走位数据结构完整', /"win":/.test(walk) && /"act":/.test(walk), walk.slice(0, 90) + '…');
  check('无 JS 异常', jsErrs.length === 0, JSON.stringify(jsErrs));
}

// ---------- 2. dragout（只拖不松手）----------
console.log('[2] 拖到面板外（不松手）');
{
  const { log, jsErrs } = await runAct('dragout', 8000);
  const d = parseDump(dumpLine(log, 'moved-out'));
  check('已进入 grabbed 相位', !!(d && d.act && d.act.phase === 'grabbed'), d ? 'phase=' + d.act.phase : '无 dump');
  check('鱼确实被拖出画布边界（且尺寸未变）',
    !!(d && d.pos && (d.pos.x < 0 || d.pos.x > 320 || d.pos.y < 0 || d.pos.y > 431)),
    d ? JSON.stringify(d.pos) : '无 dump');
  check('无 JS 异常', jsErrs.length === 0, JSON.stringify(jsErrs));
}

// ---------- 3. dragout-release2：出画 → 门口 → 走回 ----------
console.log('[3] 面板外松手：懵逼 → 出画 → 从门口走回');
{
  const { log, jsErrs } = await runAct('dragout-release2', 12000);
  const be = parseDump(dumpLine(log, 'before-up'));
  const cf = parseDump(dumpLine(log, 'confused'));
  const wd = parseDump(dumpLine(log, 'walking-to-door'));
  const ad = parseDump(dumpLine(log, 'at-door'));
  check('松手前仍是 grabbed', !!(be && be.act && be.act.phase === 'grabbed'), be ? 'phase=' + be.act.phase : '无 dump');
  check('松手后进入 confused', !!(cf && cf.act && cf.act.phase === 'confused'), cf ? 'phase=' + cf.act.phase : '无 dump');
  check('懵逼结束进入 reenter', !!(wd && wd.act && wd.act.phase === 'reenter'), wd ? 'phase=' + (wd.act && wd.act.phase) : '无 dump');
  check('走向门口时仍处于 reenter', !!(ad && ad.act && ad.act.phase === 'reenter'), ad ? 'phase=' + (ad.act && ad.act.phase) : '无 dump');
  check('回家路径是绕障折线（≥2 点）', !!(wd && Array.isArray(wd.path) && wd.path.length >= 2),
    wd ? '点数=' + (wd.path ? wd.path.length : 0) : '无 dump');

  // 第二段必须从画布外接上：起点 y 要越过 scene.h(431)，且折线先竖直穿门
  const ri = parseDump(dumpLine(log, 'reenter-in'));
  check('第二段已切到进门折线（reenter 且 path 非空）',
    !!(ri && ri.act && ri.act.phase === 'reenter' && Array.isArray(ri.path) && ri.path.length >= 2),
    ri ? 'phase=' + (ri.act && ri.act.phase) + ' 点数=' + (ri.path ? ri.path.length : 0) : '无 dump');
  if (ri && Array.isArray(ri.path) && ri.path.length >= 2) {
    const head = ri.path[0];
    const next = ri.path[1];
    check('第二段起点在画布外（接上出画位置，无瞬移）', head.y > 431,
      '起点=' + JSON.stringify(head) + ' scene.h=431');
    check('进门第一段是竖直穿门（x 不跳变）', Math.abs(next.x - head.x) <= 1,
      'x ' + head.x + ' → ' + next.x);
    // 折线是 A* 化简后的拐点，长直线段本身就长（门到工位要竖直走 164px），
    // 所以不能拿顶点间距判瞬移 —— 真瞬移是"相邻两块地砖之间斜着跳"。
    // 正确判据：每段基本沿轴向（x 或 y 几乎不变），不出现长斜线。
    let maxDiag = 0;
    for (let i = 1; i < ri.path.length; i += 1) {
      const dx = Math.abs(ri.path[i].x - ri.path[i - 1].x);
      const dy = Math.abs(ri.path[i].y - ri.path[i - 1].y);
      if (dx > 4 && dy > 4 && dx + dy > 40) maxDiag = Math.max(maxDiag, dx + dy);
    }
    check('折线只走轴向（无长斜线穿墙）', maxDiag === 0, '最长斜段=' + maxDiag);
  }
  const rd = parseDump(dumpLine(log, 'reenter-done'));
  check('最终归位 seated', !!(rd && rd.act && rd.act.phase === 'seated'),
    rd ? 'phase=' + (rd.act && rd.act.phase) : '无 dump');
  check('无 JS 异常', jsErrs.length === 0, JSON.stringify(jsErrs));
}

// ---------- 4. dragin：面板内松手走回家 ----------
console.log('[4] 面板内松手：懵逼后沿过道走回工位');
{
  const { log, jsErrs } = await runAct('dragin', 12000);
  const rel = parseDump(dumpLine(log, 'released'));
  check('松手后进入 confused', !!(rel && rel.act && rel.act.phase === 'confused'), rel ? 'phase=' + rel.act.phase : '无 dump');
  const later = ['t+1800', 't+2600', 't+3600', 't+5000'].map((t) => parseDump(dumpLine(log, t))).filter(Boolean);
  const phases = later.map((x) => x.act && x.act.phase);
  check('随后回到 walkhome 或已归位 seated',
    phases.some((p) => p === 'walkhome' || p === 'seated'), JSON.stringify(phases));
  check('无 JS 异常', jsErrs.length === 0, JSON.stringify(jsErrs));
}

// ---------- 5. dbl1：一级双击 ----------
console.log('[5] 一级双击：转正面 + 爱心');
{
  const { log, jsErrs } = await runAct('dbl1', 9000);
  const d = ['t+600', 't+1600', 't+2600'].map((t) => parseDump(dumpLine(log, t))).filter(Boolean);
  const facings = d.map((x) => x.act && x.act.facing);
  const glyphs = d.map((x) => x.act && x.act.glyph);
  const dbls = d.map((x) => x.act && x.act.dbl);
  check('转到了正面', facings.indexOf('front') >= 0, JSON.stringify(facings));
  check('冒出了爱心', glyphs.indexOf('heart') >= 0, JSON.stringify(glyphs));
  check('dbl 计数=1', dbls.indexOf(1) >= 0, JSON.stringify(dbls));
  check('无 JS 异常', jsErrs.length === 0, JSON.stringify(jsErrs));
}

// ---------- 6. dbl3：三级双击 ----------
console.log('[6] 三级双击：爱心 → 烟雾/🤓👆 → 跳/裂/掉落/回位');
{
  const { log, jsErrs } = await runAct('dbl3', 24000);
  const pick = (t) => parseDump(dumpLine(log, t));
  const d1 = pick('dbl1');
  const d2 = pick('dbl2');
  const d2b = pick('dbl2b');
  const d2c = pick('dbl2c');
  const d3 = pick('dbl3');
  const hop = pick('hop');
  const fall = pick('fall');
  const bottom = pick('bottom');
  const back = pick('back');

  check('一级：正面 + 爱心', !!(d1 && d1.act && d1.act.facing === 'front'), d1 ? JSON.stringify({ f: d1.act.facing, g: d1.act.glyph }) : '无 dump');
  check('二级：曾隐身（烟雾消失）', !!(d2 && d2.act && d2.act.hidden === true),
    d2 ? JSON.stringify({ hidden: d2.act.hidden, phase: d2.act.phase }) : '无 dump');
  check('二级：重新出现并冒 🤓/👆', !!(d2b && d2b.act && d2b.act.hidden === false && d2b.act.glyph === 'nerd'),
    d2b ? JSON.stringify({ hidden: d2b.act.hidden, glyph: d2b.act.glyph }) : '无 dump');
  check('三级：dbl 计数=3', !!(d3 && d3.act && d3.act.dbl === 3), d3 ? 'dbl=' + (d3.act && d3.act.dbl) : '无 dump');
  check('三级：起跳', !!(hop && hop.act && hop.act.hop === true), hop ? JSON.stringify({ hop: hop.act.hop, phase: hop.act.phase }) : '无 dump');
  check('三级：进入掉落', !!(fall && fall.act && fall.act.fall), fall ? JSON.stringify(fall.act.f ? { y: fall.act.f.y, vy: fall.act.f.vy } : null) : '无 dump');
  check('三级：掉到屏幕底部并触底', !!(bottom && bottom.act && bottom.act.f && bottom.act.f.grounded),
    bottom ? JSON.stringify(bottom.act.f) : '无 dump');
  check('三级：最终回位（seated）', !!(back && back.act && back.act.phase === 'seated'),
    back ? 'phase=' + (back.act && back.act.phase) : '无 dump');
  check('无 JS 异常', jsErrs.length === 0, JSON.stringify(jsErrs));
}

await browser.close();
console.log(fails === 0 ? '\n结果: 全部通过' : '\n结果: ' + fails + ' 项失败');
process.exit(fails === 0 ? 0 : 1);
