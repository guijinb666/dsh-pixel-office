/* 像素工作台 · 介绍页脚本
   三件事：① 点名字换皮肤（圆盘换色、说明文字换句）② 六个开关真的停那一行的动画
   ③ 快门与入场只播一次，遇到 prefers-reduced-motion 全部跳过。 */

(function () {
  'use strict';

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ── 1. 八套皮肤 ───────────────────────────────────────────── */

  var skin = document.getElementById('skin');
  var fact = document.getElementById('fact');
  var disc = document.querySelector('.disc');
  var picks = [].slice.call(document.querySelectorAll('.pick'));

  var TONE = {
    sky: '#cbe4f2',
    sand: '#f1e3b5',
    sun: '#ffc013'
  };

  // 预载，避免点击后先闪一下空白再出图
  var cache = {};
  picks.forEach(function (b) {
    var im = new Image();
    im.src = b.dataset.src;
    cache[b.dataset.src] = im;
  });

  picks.forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (btn.classList.contains('on')) return;
      picks.forEach(function (o) { o.classList.remove('on'); o.setAttribute('aria-pressed', 'false'); });
      btn.classList.add('on');
      btn.setAttribute('aria-pressed', 'true');

      var swap = function () {
        skin.src = btn.dataset.src;
        skin.alt = btn.dataset.alt;
        var probe = cache[btn.dataset.src];
        if (probe && probe.naturalWidth) {
          skin.width = probe.naturalWidth;
          skin.height = probe.naturalHeight;
        }
        if (disc) disc.style.backgroundColor = TONE[btn.dataset.tone] || TONE.sky;
        if (fact) fact.textContent = btn.dataset.fact;
        skin.classList.remove('swap');
      };

      if (reduce) { swap(); return; }
      skin.classList.add('swap');
      window.setTimeout(swap, 200);
    });
  });

  picks[0].setAttribute('aria-pressed', 'true');
  picks.slice(1).forEach(function (o) { o.setAttribute('aria-pressed', 'false'); });

  /* ── 2. 六个开关 ───────────────────────────────────────────── */

  // aria-label → 该行演示里所有要停的动画所在元素
  var DEMOS = {
    '气泡滚动': '.d-bubble span',
    '闲置睡姿': '.d-sleep img',
    '灯光呼吸': '.d-lamp b, .d-lamp u',
    '挂钟与屏幕': '.d-clock i, .d-clock s',
    '空格拖出': '.d-drag img, .d-drag i, .d-drag em',
    '设置面板': '.d-panel span'
  };

  [].slice.call(document.querySelectorAll('.sw')).forEach(function (sw) {
    sw.addEventListener('click', function () {
      var on = !sw.classList.contains('on');
      sw.classList.toggle('on', on);
      sw.setAttribute('aria-checked', on ? 'true' : 'false');

      var row = sw.closest('.row');
      if (row) row.classList.toggle('off', !on);

      var sel = DEMOS[sw.getAttribute('aria-label')];
      if (!sel) return;
      [].slice.call(document.querySelectorAll(sel)).forEach(function (el) {
        el.style.animationPlayState = on ? 'running' : 'paused';
      });
    });
  });

  /* ── 3. 快门与入场 ─────────────────────────────────────────── */

  var arch = document.querySelector('.arch');
  if (arch && !reduce) {
    var armed = false;
    var arm = function () {
      if (armed) return;
      armed = true;
      arch.classList.add('armed');
    };
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (rows) {
        rows.forEach(function (r) { if (r.isIntersecting) { arm(); io.disconnect(); } });
      }, { threshold: 0.18 });
      io.observe(arch);
    } else {
      arm();
    }
  }

  var targets = [].slice.call(document.querySelectorAll(
    '.cast .stage, .cast .roster > *, .beats h2, .beat, .moving h2, .moving-lead, .row, ' +
    '.ledger h2, .cell, .easter-copy > *, .board-fig, .faq h2, details, .install > *, .foot > *'
  ));

  targets.forEach(function (el) { el.classList.add('reveal'); });

  if (reduce || !('IntersectionObserver' in window)) {
    targets.forEach(function (el) { el.classList.add('in'); });
    return;
  }

  // 同一批里按 DOM 顺序错峰 70ms，让每节像卷帘一样落下来
  var seq = new Map();
  var io2 = new IntersectionObserver(function (rows) {
    rows.forEach(function (r) {
      if (!r.isIntersecting) return;
      var el = r.target;
      var group = el.parentElement;
      var n = seq.get(group) || 0;
      seq.set(group, n + 1);
      el.style.setProperty('--d', Math.min(n * 70, 420) + 'ms');
      el.classList.add('in');
      io2.unobserve(el);
    });
  }, { threshold: 0.08, rootMargin: '0px 0px -8% 0px' });

  targets.forEach(function (el) { io2.observe(el); });
}());
