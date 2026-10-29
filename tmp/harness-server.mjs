/**
 * 本地验收台：起一个最小 HTTP 服务，把插件包 assets 当静态目录，
 * 用假数据喂 /api/pixel-office/state 与 /api/pixel-office/seats，
 * 并在页面里 stub 掉 window.__ModuleLoader__，直接跑真实的 lib/client.js。
 *
 * 目的：在没有 DSH 会话凭证的情况下，把渲染/动画/交互在真浏览器里跑起来看。
 *
 * 用法：node tmp/harness-server.mjs [port]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PKG = path.join(ROOT, 'packages', 'dsh-pixel-office');
const ASSETS = path.join(PKG, 'assets');

const PORT = Number(process.argv[2] || 8791);

// 自诊断槽（对应真 host index.js 里的 diagSlot）：浏览器 reportDiag POST 进来，验收脚本 GET 读回。
const diagSlot = { at: 0, from: '', body: null };

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
};

/** 场景：主鱼 + 3 条副鱼，含不同模型（会映射到不同装扮）。 */
let forceSleep = false;

function makeState() {
  const now = Date.now();
  return {
    seq: Math.floor(now / 1000),
    sessionId: 'harness-session',
    main: {
      seatId: 'main',
      agentId: 'main-agent',
      label: '主 agent',
      model: 'deepseek-chat',
      provider: 'deepseek',
      activity: 'working',
      bubble: { text: '正在把像素办公室接进插件', streaming: true, updatedAt: now },
      files: [
        { path: 'docs/像素工作台-总规划.md', name: '像素工作台-总规划.md' },
      ],
      progress: null,
      sessionId: 'harness-session',
    },
    subs: [
      {
        seatId: 'sub:0', agentId: 'sub-a', label: 'claude 子任务', model: 'claude-sonnet-4',
        provider: 'anthropic', activity: 'working',
        bubble: { text: '在核对转身帧的朝向', streaming: true, updatedAt: now },
        files: [], progress: null, sessionId: 'harness-sub-a',
      },
      {
        seatId: 'sub:1', agentId: 'sub-b', label: 'gpt 子任务', model: 'gpt-5',
        provider: 'openai', activity: 'done',
        bubble: { text: '交付：assets/scene/seats.json', streaming: false, updatedAt: now },
        files: [{ path: 'assets/scene/seats.json', name: 'seats.json' }], progress: null, sessionId: 'harness-sub-b',
      },
      {
        seatId: 'sub:2', agentId: 'sub-c', label: 'qwen 子任务', model: 'qwen3-max',
        provider: 'qwen', activity: 'working',
        bubble: { text: '生成第 3 套坐姿', streaming: true, updatedAt: now },
        files: [], progress: null, sessionId: 'harness-sub-c',
      },
    ].concat(
      Array.from({ length: 9 }, (_, i) => ({
        seatId: 'sub:' + (i + 3), agentId: null, label: null, model: null, provider: null,
        activity: 'empty', bubble: null, files: [], progress: null, sessionId: null,
      })),
    ),
  };
}

const HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>pixel-office harness</title>
<style>
  html,body{margin:0;height:100%;background:#0e0b14;font-family:system-ui,sans-serif;color:#c9c2dd}
  #fake-ui{position:fixed;left:0;top:0;right:0;bottom:0;padding:18px;box-sizing:border-box}
  #fake-ui h1{font-size:15px;color:#5ee6c8;font-weight:600;margin:0 0 8px}
  #fake-ui p{font-size:12px;opacity:.5;margin:4px 0;max-width:520px;line-height:1.7}
  #errbox{position:fixed;left:12px;bottom:12px;max-width:700px;max-height:44vh;overflow:auto;
    font:11px/1.5 ui-monospace,Consolas,monospace;color:#ff9aa8;background:#1a0f14cc;
    border:1px solid #ff5470;padding:8px;white-space:pre-wrap;display:block;z-index:9999}
  #errbox:empty{display:none}
</style></head>
<body>
<div id="fake-ui">
  <h1>DSH 界面替身（验收台）</h1>
  <p>这块只是背景板，用来验证像素办公室面板浮在真实页面上的观感。真正的插件不依赖它。</p>
</div>
<div id="errbox"></div>
<script>
window.__errs = [];
function _flush() {
  var b = document.getElementById('errbox');
  if (b) b.textContent = window.__errs.length ? window.__errs.join('  ||  ') : '';
}
window.onerror = function (m, s, l, c, e) { window.__errs.push('onerror: ' + m + ' @' + l + ':' + c + (e && e.stack ? ' | ' + e.stack : '')); _flush(); };
window.addEventListener('unhandledrejection', function (ev) { window.__errs.push('reject: ' + (ev.reason && ev.reason.stack ? ev.reason.stack : ev.reason)); _flush(); });
var _ce = console.error;
console.error = function () { try { window.__errs.push('console.error: ' + Array.prototype.join.call(arguments, ' ')); } catch (x) {} _ce.apply(console, arguments); _flush(); };
window.__ModuleLoader__ = { load: function (m) { try { var r = m.factory(); r.apply(); } catch (e) { window.__errs.push('apply failed: ' + (e && e.stack ? e.stack : e)); _flush(); } } };

// --- 自动化剧本：无头浏览器没法真用鼠标拖，这里合成 PointerEvent 驱动真实代码 ---
(function () {
  var q = new URLSearchParams(location.search);
  var act = q.get('act');
  if (!act) return;

  function stageCanvas() { return document.querySelector('[data-po-stage] canvas'); }

  /** 逻辑坐标 → 视口坐标（必须在使用时现算：canvas 布局会随面板定位变化）。 */
  function vp(cv, lx, ly) {
    var r = cv.getBoundingClientRect();
    return {
      x: r.left + lx * (r.width / 320),
      y: r.top + ly * (r.height / 431)
    };
  }

  function fire(cv, type, x, y) {
    cv.dispatchEvent(new PointerEvent(type, {
      clientX: x, clientY: y, pointerId: 1, button: 0,
      bubbles: true, cancelable: true, pointerType: 'mouse'
    }));
  }

  window.__poLog = function (m) { window.__errs.push(m); _flush(); };

  function dump(tag) {
    var w = window.__pixelOfficeWalk && window.__pixelOfficeWalk();
    if (!w) return;
    // esc/parade 是空格彩蛋的状态机，单独拼进日志以便断言
    var esc = {};
    Object.keys(w.act).forEach(function (k) { if (w.act[k].esc) esc[k] = w.act[k].phase; });
    window.__errs.push(tag + ' act=' + JSON.stringify(w.act.main) +
      ' pos=' + JSON.stringify(w.pos) + ' path=' + JSON.stringify(w.path) +
      ' frames=' + w.frames + ' lastTs=' + w.lastTs +
      ' parade=' + (w.parade || 0) + ' ids=' + JSON.stringify(w.paradeIds || []) +
      ' esc=' + JSON.stringify(esc));
    _flush();
  }

  function run() {
    var cv = stageCanvas();
    if (!cv) { setTimeout(run, 120); return; }

    // 启动默认是木牌（用户要求每次重启最小化）。**这里只等、绝不自己点开**：
    // card/sign 的显隐是 toggle，harness 和调用脚本各点一次就会互相顶回去
    //（点开→收起→点开…），canvas 永远量不到尺寸，剧本全体超时。
    // 谁来展开由调用脚本自己决定（d13.mjs 会点一次；panel.mjs / diag-report.mjs
    // 要断言"默认是木牌"，它们不点、也不走这里的剧本）。
    var r0 = cv.getBoundingClientRect();
    if (r0.width < 10 || r0.height < 10) { setTimeout(run, 120); return; }

    // 展开动画期间 canvas 是 320x361（还在长高），此时算出来的视口坐标会偏，
    // 合成的 pointerdown 可能落到鱼身上方 3px 就 miss 掉 —— 必须等矩形稳定。
    var lastW = -1;
    var lastH = -1;
    var stableTicks = 0;
    (function waitStable() {
      var r = cv.getBoundingClientRect();
      var w = Math.round(r.width);
      var h = Math.round(r.height);
      if (w > 10 && h > 10 && w === lastW && h === lastH) {
        stableTicks += 1;
        if (stableTicks >= 2) { waitSeated(); return; }
      } else {
        stableTicks = 0;
      }
      lastW = w;
      lastH = h;
      setTimeout(waitStable, 120);
    })();

    // 轮询等主鱼把入场那段路走完（virtual time 下入场耗时不稳，固定延时不可靠）
    function waitSeated() {
      var waited = 0;
      (function poll() {
        var w = window.__pixelOfficeWalk ? window.__pixelOfficeWalk() : null;
        var ok = false;
        if (w && w.act && w.act.main) {
          // 入场走完 walkIns 记录会被删掉，所以不能只看 win.main；
          // 以相位为准：seated / working / idle 就说明已经坐到工位上了。
          var p = w.act.main.phase;
          if (p === 'seated' || p === 'working' || p === 'idle') ok = true;
        }
        if (!ok && waited < 30000) { waited += 120; setTimeout(poll, 120); return; }
        window.__errs.push('seated after ' + Math.round(waited) + 'ms');
        _flush();
        go(cv);
      })();
    }
  }

  function go(cv) {
    if (act === 'probe') {
      var f = window.__pixelOfficeDebug;
      if (!f) { window.__errs.push('no debug hook'); _flush(); return; }
      window.__errs.push('probe(172,140)=' + JSON.stringify(f(172, 140)));
      window.__errs.push('walk=' + JSON.stringify(window.__pixelOfficeWalk()));
      _flush();
      return;
    }

    // 拖到面板外：抓主鱼 → 拖到画布右侧外 → 不松手
    // 目标点必须用**逻辑坐标**换算（vp），不能写死视口坐标：
    // 面板默认位置会变（现在默认最小化在左上角），写死的 (320,420) 会落回画布内。
    if (act === 'dragout') {
      var s0 = vp(cv, 172, 140);
      var o0 = vp(cv, 420, 210);
      setTimeout(function () { fire(cv, 'pointerdown', s0.x, s0.y); dump('down'); }, 0);
      setTimeout(function () { fire(cv, 'pointermove', s0.x + 6, s0.y + 4); }, 120);
      setTimeout(function () { fire(cv, 'pointermove', o0.x, o0.y); dump('moved-out'); }, 600);
      return;
    }

    // 拖到面板外 → 松手 → 懵逼 1s → 先到门口出画 → 再进门走回工位
    if (act === 'dragout-release') {
      var s1 = vp(cv, 172, 140);
      var o1 = vp(cv, 420, 210);
      setTimeout(function () { fire(cv, 'pointerdown', s1.x, s1.y); }, 0);
      setTimeout(function () { fire(cv, 'pointermove', s1.x + 6, s1.y + 4); }, 120);
      setTimeout(function () { fire(cv, 'pointermove', o1.x, o1.y); dump('before-up'); }, 600);
      setTimeout(function () { fire(cv, 'pointerup', o1.x, o1.y); dump('released'); }, 900);
      setTimeout(function () { dump('t+1600'); }, 1600);
      setTimeout(function () { dump('t+2800'); }, 2800);
      setTimeout(function () { dump('t+4200'); }, 4200);
      return;
    }

    // 拖到办公室内偏左下（会横穿整排桌子）→ 松手 → 沿过道走回家
    if (act === 'dragin') {
      var s2 = vp(cv, 172, 140);
      var dst = vp(cv, 30, 350);
      setTimeout(function () { fire(cv, 'pointerdown', s2.x, s2.y); }, 0);
      setTimeout(function () { fire(cv, 'pointermove', s2.x + 6, s2.y + 4); }, 120);
      setTimeout(function () { fire(cv, 'pointermove', dst.x, dst.y); dump('dropped-pos'); }, 500);
      setTimeout(function () { fire(cv, 'pointerup', dst.x, dst.y); dump('released'); }, 800);
      setTimeout(function () { dump('t+1800'); }, 1800);
      setTimeout(function () { dump('t+2600'); }, 2600);
      setTimeout(function () { dump('t+3600'); }, 3600);
      setTimeout(function () { dump('t+5000'); }, 5000);
      return;
    }

    // 双击三级：连点三次，验证爱心 → 烟雾 → 跳/裂/掉落
    // 注意：levelTwo 的 busyUntil 是 5600ms，第三级必须等它结束再点，否则会被忙锁吞掉
    // 各阶段时间轴（相对第二次点击 t=3420）：
    //   hidden=true  → +760  = 4180
    //   hidden=false + nerd → +2820 = 6240，nerd 持续到 8240
    // 第三次点击 t=9520：hop 从 9820 起，960ms 内跳 3 次（到 10780），
    //   crack 10480，fall 起点 10960。所以 dump 必须落在这些窗口内。
    if (act === 'dbl3') {
      var s3 = vp(cv, 172, 140);
      function tap() { fire(cv, 'pointerdown', s3.x, s3.y); fire(cv, 'pointerup', s3.x, s3.y); }
      setTimeout(tap, 0);
      setTimeout(tap, 120);
      setTimeout(function () { dump('dbl1'); }, 800);
      setTimeout(tap, 3300);
      setTimeout(tap, 3420);
      setTimeout(function () { dump('dbl2'); }, 4400);
      setTimeout(function () { dump('dbl2b'); }, 6600);
      setTimeout(function () { dump('dbl2c'); }, 7800);
      setTimeout(tap, 9400);
      setTimeout(tap, 9520);
      setTimeout(function () { dump('dbl3'); }, 9750);
      setTimeout(function () { dump('hop'); }, 10000);
      setTimeout(function () { dump('fall'); }, 11400);
      setTimeout(function () { dump('bottom'); }, 14000);
      setTimeout(function () { dump('back'); }, 19000);
      return;
    }

    // 单次双击：只验第一级（转正面 + 爱心）
    if (act === 'dbl1') {
      var s4 = vp(cv, 172, 140);
      function tap2() { fire(cv, 'pointerdown', s4.x, s4.y); fire(cv, 'pointerup', s4.x, s4.y); }
      setTimeout(tap2, 0);
      setTimeout(tap2, 120);
      setTimeout(function () { dump('t+600'); }, 600);
      setTimeout(function () { dump('t+1600'); }, 1600);
      setTimeout(function () { dump('t+2600'); }, 2600);
      return;
    }

    // 拖到面板外松手：懵逼 → 走到门口出画 → 进门走回工位
    if (act === 'dragout-release2') {
      var s5 = vp(cv, 172, 140);
      setTimeout(function () { fire(cv, 'pointerdown', s5.x, s5.y); }, 0);
      setTimeout(function () { fire(cv, 'pointermove', s5.x + 6, s5.y + 4); }, 120);
      var o5 = vp(cv, 260, 600);   // 逻辑坐标换算：画布下方外（600 > 431）
      setTimeout(function () { fire(cv, 'pointermove', o5.x, o5.y); dump('before-up'); }, 500);
      setTimeout(function () { fire(cv, 'pointerup', o5.x, o5.y); }, 700);
      setTimeout(function () { dump('confused'); }, 1100);
      setTimeout(function () { dump('walking-to-door'); }, 2200);
      setTimeout(function () { dump('at-door'); }, 3600);
      // 第一段（工位→门口外）约 2s，之后 stepAct 会把 walkPath 换成
      // 「画布外 → 门内 → 过道 → 工位」的第二段。这两个点必须落在第二段上，
      // 才能验证"是从门口走进来的、不是瞬移进来的"。
      setTimeout(function () { dump('reenter-in'); }, 5600);
      // 落点改用逻辑坐标 vp(cv,260,600) 后，第二段折线比原先长（约 620px，
      // 按 90px/s 要走 ~6.9s），8200ms 会卡在 reenter 还没走完 —— 所以放宽到 10500。
      setTimeout(function () { dump('reenter-done'); }, 10500);
      return;
    }

    // 空格彩蛋（m06554 第 6 条）：按住空格把**每一条**鱼（含主鱼）拖出办公室，
    // 松手后全员就地坐地，全部出逃完成 → 排队向右走出画面 → 弹告示牌。
    //
    // 抓取点**必须动态算**：写死逻辑坐标会随工位布局和面板矩形变化而落空
    //（之前 dragout 就踩过这个坑）。这里先用 __pixelOfficeDebug 拿到每条鱼
    // 的 actorBox（逻辑坐标），取包围盒中心当抓取点，再换算成视口坐标。
    if (act === 'parade') {
      // 可选 delay（毫秒）：给目视截图留观察窗（全员坐满但还没触发彩蛋）。
      // 验收脚本不传，行为完全不变。
      var delayMs = parseInt(q.get('delay') || '0', 10) || 0;
      // 先按下空格：pointerup 里 "if (S.spaceDown)" 是彩蛋的唯一入口，
      // 不按空格拖出去只会走普通「懵逼→走回工位」分支。
      // 注意本文件整段 JS 都嵌在 HTML 的模板字符串里，注释中不能出现反引号。
      // keydown 监听在 window 上（bindSpaceKey），所以派发给 window 就够。
      window.dispatchEvent(new KeyboardEvent('keydown', {
        code: 'Space', key: ' ', bubbles: true, cancelable: true,
      }));
      window.__errs.push('parade:space-down');
      _flush();

      // 必须先等**每一条**鱼都坐稳再取 boxes：
      // 入场是串行排队的（enterQueue），副鱼比主鱼晚好几秒才落座；
      // 提前取到的 actorBox 是入场途中的位置，等真正 pointerdown 时鱼早就挪走了，
      // hitTest 落空 → 副鱼永远进不了 esc（第一次跑 parade 就卡在这）。
      var waitedSeat = 0;
      (function waitAllSeated() {
        var w = window.__pixelOfficeWalk && window.__pixelOfficeWalk();
        var ok = false;
        if (w && w.act) {
          var keys = Object.keys(w.act);
          ok = keys.length > 0 && keys.every(function (k) {
            var p = w.act[k].phase;
            return p === 'seated' || p === 'working' || p === 'idle';
          }) && Object.keys(w.win).length === 0;
        }
        if (!ok && waitedSeat < 40000) { waitedSeat += 150; setTimeout(waitAllSeated, 150); return; }
        window.__errs.push('parade:all-seated after ' + Math.round(waitedSeat) + 'ms');
        _flush();
        // delayMs 是给目视截图留的观察窗：全员坐满但还没触发彩蛋的那一段。
        // 验收脚本不传，行为不变。
        if (delayMs > 0) {
          window.__errs.push('parade:delay ' + delayMs + 'ms');
          _flush();
          setTimeout(startParadeScript, delayMs);
        } else {
          startParadeScript();
        }
      })();

      function startParadeScript() {
      var cv0 = stageCanvas();
      var dbg = window.__pixelOfficeDebug ? window.__pixelOfficeDebug(0, 0) : null;
      if (!dbg || !dbg.boxes) {
        window.__errs.push('parade:no-debug ' + JSON.stringify(dbg && dbg.why));
        _flush();
        return;
      }
      var sceneW = (dbg.scene && dbg.scene.w) || 320;
      var sceneH = (dbg.scene && dbg.scene.h) || 431;
      var rect0 = cv0.getBoundingClientRect();
      function toVp(lx, ly) {
        return {
          x: rect0.left + lx * (rect0.width / sceneW),
          y: rect0.top + ly * (rect0.height / sceneH),
        };
      }
      // 每条鱼给一个不同的出画落点（右外 / 下外 / 左外），
      // 保证 escX 互不相同，排队排序才有区分度。
      var OUT = [
        { dx: sceneW + 40, dy: -10 },     // 右外
        { dx: sceneW + 40, dy: 10 },      // 右外（略低）
        { dx: -40, dy: 0 },               // 左外
        { dx: -40, dy: 20 },              // 左外（略低）
        { dx: 0, dy: sceneH + 60 },       // 下外
      ];
      var ids = Object.keys(dbg.boxes).filter(function (k) { return !!dbg.boxes[k]; });
      window.__errs.push('parade:targets=' + JSON.stringify(ids));
      _flush();

      ids.forEach(function (id, i) {
        var b = dbg.boxes[id];
        var cxL = b.x + b.w / 2;
        var cyL = b.y + b.h / 2;
        var grab = toVp(cxL, cyL);
        var out = OUT[i % OUT.length];
        var drop = toVp(out.dx, out.dy);
        var base = 400 + i * 620;
        setTimeout(function () {
          var c = stageCanvas();
          if (!c) { window.__errs.push('parade:no-canvas'); _flush(); return; }
          fire(c, 'pointerdown', grab.x, grab.y);
        }, base);
        setTimeout(function () {
          var c = stageCanvas();
          if (!c) return;
          fire(c, 'pointermove', grab.x + 5, grab.y + 4);
        }, base + 110);
        setTimeout(function () {
          var c = stageCanvas();
          if (!c) return;
          fire(c, 'pointermove', drop.x, drop.y);
        }, base + 230);
        setTimeout(function () {
          var c = stageCanvas();
          if (!c) return;
          fire(c, 'pointerup', drop.x, drop.y);
          dump('esc-' + i + '-' + id);
        }, base + 360);
      });
      // 全员落下后（~2900ms）才开始排队，留足时间。
      // 之后是两段行走：先各自走到队列槽位（parade=1→2），再一起向右出画（2→3）。
      // 满员 4 条、路径合计上千像素，按 90px/s 算要十几秒，采样点必须铺到 26s。
      // dump 是「瞬时快照」，外部截图脚本靠轮询 parade 定位阶段，
      // 中间态（1→2→3）可能在一两百毫秒内跳过，所以这里也额外记录阶段日志备查。
      setTimeout(function () { dump('parade-mid'); }, 3400);
      setTimeout(function () { dump('parade-queue'); }, 9000);
      setTimeout(function () { dump('parade-late'); }, 16000);
      setTimeout(function () { dump('parade-out'); }, 22000);
      setTimeout(function () { dump('parade-end'); }, 26000);
      }
      return;
    }
  }

  window.addEventListener('load', function () { setTimeout(run, 200); });
})();
setInterval(_flush, 500);
</script>
<script src="/lib/client.js"></script>
</body></html>`;

function send(res, code, body, type) {
  res.writeHead(code, { 'content-type': type || 'text/plain; charset=utf-8' });
  res.end(body);
}

function sendFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'not found');
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = decodeURIComponent(url.pathname);

  if (p === '/' || p === '/index.html') return send(res, 200, HTML, MIME['.html']);

  if (p === '/api/pixel-office/state') {
    res.writeHead(200, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
    // 真实 host 的外层形状是 { ok, snapshot }，client 读的是 body.snapshot
    const snap = makeState();
    // 睡姿模式：client 轮询 /state 时不会带自定义参数，所以开关放在服务端全局，
    // 由截图脚本先打 /__sleep?on=1。睡姿帧 / 头顶 zzz / 气泡隐藏都是纯 canvas，
    // 没有 DOM 可断言，只能这样出图目视。
    if (forceSleep) {
      snap.main.activity = 'asleep';
      snap.main.bubble = { text: '', headline: '', streaming: false, updatedAt: 0 };
      snap.subs.forEach((s) => {
        if (s && s.agentId) {
          s.activity = 'asleep';
          s.bubble = { text: '', headline: '', streaming: false, updatedAt: 0 };
        }
      });
    }
    return res.end(JSON.stringify({ ok: true, snapshot: snap }));
  }

  // 验收开关：/__sleep?on=1 让 /state 把全员切成 asleep（截图目视睡姿用）。
  if (p === '/__sleep') {
    forceSleep = url.searchParams.get('on') === '1';
    res.writeHead(200, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, sleep: forceSleep }));
  }

  if (p === '/api/pixel-office/seats') {
    return sendFile(res, path.join(ASSETS, 'scene', 'seats.json'));
  }

  // 自诊断槽：真 host 里是 index.js 的 diagRoute。这里用内存模拟同样的形状，
  // 让 tmp/browser/diag-report.mjs 能验证「浏览器上报 → host 读回」这条链路。
  if (p === '/api/pixel-office/diag') {
    if (req.method === 'POST') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try {
          body = JSON.parse(raw);
        } catch (err) {
          body = { raw: raw.slice(0, 2000) };
        }
        diagSlot.at = Date.now();
        diagSlot.from = req.socket.remoteAddress || '';
        diagSlot.body = body;
        res.writeHead(200, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true }));
      });
      return undefined;
    }
    res.writeHead(200, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, diag: diagSlot }));
  }

  if (p.startsWith('/lib/')) {
    return sendFile(res, path.join(PKG, p.replace(/^\/lib\//, 'lib/')));
  }

  if (p.startsWith('/pixel-office/')) {
    const rel = p.replace(/^\/pixel-office\//, '');
    const full = path.join(ASSETS, rel);
    if (!full.startsWith(ASSETS)) return send(res, 403, 'forbidden');
    return sendFile(res, full);
  }

  return send(res, 404, 'not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('harness on http://127.0.0.1:' + PORT + '/');
});
