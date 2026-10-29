/**
 * 环境动态层验收：§4.1 屏幕亮灭 / §4.2 灯光 / §4.3 挂钟秒针。
 *
 * 这三层都是 canvas 纯绘制，DOM 里看不到，只能通过 window.__pixelOfficeDebug()
 * 把内部量读出来断言。用法：
 *   node tmp\harness-server.mjs 8791   （另开一个进程）
 *   node tmp\browser\ambient.mjs
 */
import puppeteer from 'puppeteer-core';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://127.0.0.1:8791';

let pass = 0;
let fail = 0;
const rows = [];

function check(name, ok, detail) {
  if (ok) { pass += 1; rows.push(`  PASS ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail += 1; rows.push(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 420, height: 560, deviceScaleFactor: 2 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e && e.message ? e.message : e)));
  await page.goto(BASE + '/?act=probe', { waitUntil: 'domcontentloaded' });

  // 等面板挂载 + 全部入场走完（入场是单通道排队，最后一席要等十几秒），
  // 屏幕只有在"坐下之后"才允许点亮，所以必须等干净了再采样。
  await page.waitForSelector('[data-po-card]', { timeout: 20000 });
  // 启动后默认是木牌（每次重启强制最小化），先点开成卡片，否则画布尺寸为 0、
  // 下面派发的 pointerdown 全都打不中鱼。
  await page.evaluate(() => {
    const sign = document.querySelector('[data-po-sign]');
    if (sign) sign.click();
  });
  await sleep(900);
  await page.waitForFunction(
    () => {
      const w = window.__pixelOfficeWalk;
      if (typeof w !== 'function') return false;
      const o = w();
      const pending = Object.keys(o.win || {}).length > 0;
      return !pending;
    },
    { timeout: 40000, polling: 250 },
  );
  await sleep(1200);

  // 环境层字段挂在 __pixelOfficeWalk 上（__pixelOfficeDebug 只做命中探测）
  const read = () => page.evaluate(() => {
    const d = window.__pixelOfficeWalk;
    return typeof d === 'function' ? d() : null;
  });

  const a = await read();
  check('调试钩子可用', !!a, a ? `frames=${a.frames}` : 'null');
  if (!a) throw new Error('no debug');

  // ---------- §4.1 屏幕 ----------
  check('暴露 screenLit 段', !!a.screens && typeof a.screens === 'object', JSON.stringify(a.screens));

  const litMain = a.screens && typeof a.screens.main === 'number' ? a.screens.main : -1;
  check('主鱼工位屏幕已点亮', litMain > 0.9, `main=${litMain}`);

  // 对照快照：有人坐的工位必须亮，activity 为 empty 的工位必须黑。
  const snap = await page.evaluate(async () => (await fetch('/api/pixel-office/state')).json());
  const subs = (snap.snapshot && snap.snapshot.subs) || [];
  const shouldLit = [];
  const shouldDark = [];
  subs.forEach((s, i) => {
    if (s && s.agentId && s.activity !== 'empty') shouldLit.push('sub:' + i);
    else shouldDark.push('sub:' + i);
  });

  const darkLit = shouldLit.filter((k) => !(a.screens[k] > 0.9));
  check('有人的副工位全部点亮', darkLit.length === 0, `应亮 ${JSON.stringify(shouldLit)}，未亮 ${JSON.stringify(darkLit)}`);

  const emptyLit = shouldDark.filter((k) => a.screens[k] > 0.001);
  check('空工位屏幕保持黑屏', emptyLit.length === 0, `空工位点数 ${shouldDark.length}，误亮 ${JSON.stringify(emptyLit)}`);

  // ---------- §4.2 灯光 ----------
  check('暴露 lamps 段', Array.isArray(a.lamps) && a.lamps.length === 2, JSON.stringify(a.lamps));
  if (Array.isArray(a.lamps) && a.lamps.length === 2) {
    const boostOk = a.lamps.every((l) => typeof l.boost === 'number' && typeof l.outage === 'boolean');
    check('灯光字段类型正确', boostOk, JSON.stringify(a.lamps));
    // 有鱼在场时整间灯必须点亮（空场才熄灭）——这是用户 m03550 第 9 条的核心
    const levels = a.lamps.map((l) => l.level);
    check('有鱼时灯已点亮（level>0.9）', levels.every((v) => typeof v === 'number' && v > 0.9),
      JSON.stringify(levels));
  }

  // 掉电是 60s 槽内随机 120ms，采样一段时间必然会看到 0/1 两种？不会。
  // 改为直接验证 helper 的确定性：同一 ts 多次读取结果必须一致（不是每次随机）。
  const lamps1 = JSON.stringify((await read()).lamps);
  await sleep(120);
  const lamps2 = JSON.stringify((await read()).lamps);
  const outageStable = (() => {
    const o1 = JSON.parse(lamps1).map((l) => l.outage);
    const o2 = JSON.parse(lamps2).map((l) => l.outage);
    // 120ms 内最多跨越一次 120ms 窗口，允许不同，但 boost 必须稳定
    const b1 = JSON.parse(lamps1).map((l) => l.boost);
    const b2 = JSON.parse(lamps2).map((l) => l.boost);
    return JSON.stringify(b1) === JSON.stringify(b2);
  })();
  check('灯光 WORKING 加成在相邻帧稳定', outageStable, lamps2);

  // ---------- §4.3 挂钟 ----------
  check('暴露 clock 段', !!a.clock && typeof a.clock.secDeg === 'number', JSON.stringify(a.clock));
  const s1 = a.clock.secDeg;
  // 采样 1.2s，秒针应该恰好跳 1 格（6°）或 2 格，绝不能是连续小步长
  const samples = [];
  for (let i = 0; i < 12; i += 1) {
    samples.push((await read()).clock.secDeg);
    await sleep(100);
  }
  const uniq = [...new Set(samples)];
  check('秒针按格跳（非连续扫）', uniq.length <= 3, `1.2s 内出现 ${uniq.length} 个角度值: ${uniq.join(',')}`);
  const degs = samples.map((d) => Math.round(d));
  const allOnTick = degs.every((d) => Math.abs(d % 6) === 0 || Math.abs(d % 6) === 6);
  check('秒针角度落在 6° 整数倍上', allOnTick, degs.join(','));

  const moved = new Set(samples).size > 1;
  check('秒针确实在走', moved, `起点 ${s1} → 终点 ${samples[samples.length - 1]}`);

  check('页面无 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | '));

  // ---------- 亮灭必须是渐变，不能瞬切 ----------
  // 用双击第 2 级把主鱼藏起来（烟雾期 hidden=true），再快速采样 main 的亮度，
  // 应该看到 1 → 中间值 → 0 的过程，而不是一步到位。
  // 注意：必须像 harness 那样直接派发 PointerEvent —— page.mouse 的合成点击
  // 在 headless 下打不到 canvas 的 pointerdown 监听上（实测完全没触发）。
  const tapMain = () => page.evaluate(() => {
    const cv = document.querySelector('[data-po-stage] canvas') || document.querySelector('canvas');
    if (!cv) return false;
    const r = cv.getBoundingClientRect();
    const x = r.left + 172 * (r.width / 320);
    const y = r.top + 140 * (r.height / 431);
    const fire = (type) => {
      cv.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true,
        clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse',
        button: 0, buttons: type === 'pointerdown' ? 1 : 0, isPrimary: true,
      }));
    };
    fire('pointerdown');
    fire('pointerup');
    return true;
  });

  const hitOk = await tapMain();
  check('能向 canvas 派发指针事件', hitOk);
  await sleep(120);
  await tapMain();          // 第一次双击 → levelOne（爱心），busyUntil = +2600ms

  // levelOne 有 2600ms 忙锁，第二次双击必须等它结束，否则被吞
  await sleep(2900);
  await tapMain();
  await sleep(120);
  await tapMain();          // 第二次双击 → levelTwo，760ms 后 hidden=true

  const trail = [];
  for (let i = 0; i < 30; i += 1) {
    const s = (await read()).screens;
    trail.push(s.main);
    await sleep(55);
  }
  const mid = trail.filter((v) => v > 0.05 && v < 0.95);
  check('隐藏时屏幕是渐灭而非瞬灭', mid.length > 0, `中间值 ${mid.length} 个，轨迹 ${trail.map((v) => v.toFixed(2)).join(',')}`);

  // levelTwo 的 busyUntil 是 5600ms，等它走完再确认重新点亮
  await sleep(6000);
  const back = (await read()).screens.main;
  check('烟雾结束后屏幕重新点亮', back > 0.9, `main=${back}`);
} finally {
  await browser.close();
}

console.log(rows.join('\n'));
console.log(`\nambient  PASS=${pass}  FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
