// 气泡滚动速度专项验收：
//   · 正文几千字时，气泡内文字必须被收到可读上限内
//   · 动画时长必须夹在 [MIN, MAX] 内，速度不能失控
//   · 短文本不滚动
import puppeteer from 'puppeteer-core';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://127.0.0.1:8791';
const pass = [];
const fail = [];
function check(name, ok, detail) {
  (ok ? pass : fail).push(name);
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail !== undefined ? ' — ' + detail : ''));
}

const LONG = '这是一段非常长的汇报正文，'.repeat(200); // 约 2800 字

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  defaultViewport: { width: 420, height: 560 },
});

async function measure(longText) {
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));

  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    const u = req.url();
    if (u.includes('/api/pixel-office/state')) {
      try {
        const r = await fetch(u);
        const j = await r.json();
        if (j && j.snapshot && j.snapshot.main) {
          j.snapshot.main.bubble = {
            text: longText, headline: longText.slice(0, 10),
            streaming: false, updatedAt: Date.now(),
          };
        }
        req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(j) });
        return;
      } catch { /* 落到下面继续 */ }
    }
    req.continue();
  });

  await page.goto(BASE + '/?act=probe', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-po-card]', { timeout: 15000 }).catch(() => {});
  // 启动默认是木牌（用户要求每次重启最小化）。气泡挂在 stage 里，卡片藏着时
  // 量不到 clientWidth，也就判不出要不要滚动 —— 必须先点开成卡片。
  await page.evaluate(() => {
    const sign = document.querySelector('[data-po-sign]');
    if (sign && sign.style.display !== 'none') sign.click();
  });
  await new Promise((r) => setTimeout(r, 1500));
  await new Promise((r) => setTimeout(r, 6000));

  const out = await page.evaluate(() => {
    const main = document.querySelector('[data-po-card] [data-po-scroll]');
    if (!main) return null;
    const inner = main;
    const win = inner.parentElement;
    const host = inner.closest('[data-po-bubble]') || win;
    return {
      innerLen: inner.textContent.replace(/▍/g, '').length,
      scrollW: inner.scrollWidth,
      winW: win.clientWidth,
      dur: getComputedStyle(inner).animationDuration,
      name: getComputedStyle(inner).animationName,
      shift: (inner.style.getPropertyValue('--po-shift') || '').trim(),
    };
  });
  await page.close();
  return { out, errs };
}

// --- 长文本
const long = await measure(LONG);
console.log('长文本测量:', JSON.stringify(long.out));
check('长文本气泡已渲染', !!long.out);
if (long.out) {
  // 上限跟着 SCROLL_MAX_DUR × SCROLL_CPS 走（40 × 3 = 120 字）：
  // 用户要求「显示全部输出文字」，所以不能只留一屏 48 字，但也不可能滚 4000 字。
  check('气泡内文字收到可读上限内（≤ 120 + 省略号）',
    long.out.innerLen <= 121, 'len=' + long.out.innerLen + '（原文 ' + LONG.length + ' 字）');
  const dur = parseFloat(long.out.dur) || 0;
  check('动画时长不超过上限 40s', dur > 0 && dur <= 40.01, dur + 's');
  check('动画时长不低于下限 2.2s', dur >= 2.2, dur + 's');
  const pxPerSec = long.out.scrollW / Math.max(dur, 0.001);
  // 上限：每像素对应的字速不能超过约 3 字/秒 × 字宽 ≈ 40px/s（含两端停顿放宽到 120px/s）
  check('滚动速度可控（≤ 120px/s）', pxPerSec <= 120, Math.round(pxPerSec) + 'px/s');
  check('滚动动画确实启用', long.out.name === 'po-bubble-scroll', long.out.name);
}
check('长文本无 JS 异常', long.errs.length === 0, long.errs.join(' | ') || '0');

// --- 短文本
const short = await measure('在做');
console.log('短文本测量:', JSON.stringify(short.out));
check('短文本气泡已渲染', !!short.out);
if (short.out) {
  check('短文本不滚动', short.out.name === 'none', short.out.name);
  check('短文本原样显示', short.out.innerLen <= 3, 'len=' + short.out.innerLen);
}

console.log('\n结果: ' + (fail.length === 0 ? '全部通过' : fail.length + ' 项失败') + '（' + pass.length + ' 通过）');
await browser.close();
process.exit(fail.length === 0 ? 0 : 1);
