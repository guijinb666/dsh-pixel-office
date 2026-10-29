// 网格寻路（A*）原型验证：只走"脚能站的地方"，自动绕开桌子。
// 用法 node tmp/test-nav.mjs
//
// 这段算法验证通过后会原样搬进 packages/dsh-pixel-office/lib/client.js，
// 两份必须保持一致（改一处记得同步另一处）。
import { readFileSync } from 'node:fs';

const doc = JSON.parse(readFileSync('packages/dsh-pixel-office/assets/scene/seats.json', 'utf8'));

const STEP = 2;          // 网格步长（逻辑像素）
const FOOT_W = 8;        // 脚区宽（与校验完全一致，这是关键）
const FOOT_H = 6;        // 脚区高（自脚中心向上量）
const COLS = Math.ceil(doc.scene.w / STEP);
const ROWS = Math.ceil(doc.scene.h / STEP);

// 障碍 = 所有桌面矩形。椅子不算（人本来就坐在椅子上）。
function deskRects() {
  const out = [];
  const m = doc.main;
  out.push({ x: m.deskL, y: m.deskTop, w: m.deskR - m.deskL, h: m.deskBottom - m.deskTop });
  for (const s of doc.subs) {
    out.push({ x: s.deskL, y: s.deskTop, w: s.deskR - s.deskL, h: s.deskBottom - s.deskTop });
  }
  return out;
}

// 建可行走网格：1 = 脚可以站
// 判定与 checkFeet 完全一致：以格点为中心，宽 FOOT_W、自中心向上 FOOT_H 的矩形不与任何桌子相交。
function buildGrid() {
  const walk = new Uint8Array(COLS * ROWS);
  for (let r = 0; r < ROWS; r += 1) {
    for (let c = 0; c < COLS; c += 1) {
      const x = c * STEP;
      const y = r * STEP;
      const fx = x - FOOT_W / 2;
      const fy = y - FOOT_H;
      let ok = 1;
      for (const d of DESKS) {
        if (fx < d.x + d.w && fx + FOOT_W > d.x && fy < d.y + d.h && fy + FOOT_H > d.y) { ok = 0; break; }
      }
      walk[r * COLS + c] = ok;
    }
  }
  return walk;
}

const DESKS = deskRects();
const WALK = buildGrid();

const toCell = (x, y) => ({ c: Math.max(0, Math.min(COLS - 1, Math.round(x / STEP))),
                            r: Math.max(0, Math.min(ROWS - 1, Math.round(y / STEP))) });
const toPoint = (c, r) => ({ x: c * STEP, y: r * STEP });

// 最近可站格（BFS 环形扩散）
function nearestWalkable(c, r) {
  if (WALK[r * COLS + c]) return { c, r };
  for (let rad = 1; rad < 40; rad += 1) {
    let best = null;
    let bestD = 1e9;
    for (let dr = -rad; dr <= rad; dr += 1) {
      for (let dc = -rad; dc <= rad; dc += 1) {
        if (Math.abs(dr) !== rad && Math.abs(dc) !== rad) continue;
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || rr >= ROWS || cc < 0 || cc >= COLS) continue;
        if (!WALK[rr * COLS + cc]) continue;
        const d = dr * dr + dc * dc;
        if (d < bestD) { bestD = d; best = { c: cc, r: rr }; }
      }
    }
    if (best) return best;
  }
  return null;
}

// A*（8 邻接，走对角线会更像人走路；代价 sqrt2）
function findPath(from, to) {
  const s0 = nearestWalkable(...Object.values(toCell(from.x, from.y)));
  const g0 = nearestWalkable(...Object.values(toCell(to.x, to.y)));
  if (!s0 || !g0) return null;
  const N = COLS * ROWS;
  const gScore = new Float64Array(N).fill(Infinity);
  const came = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const idx = (c, r) => r * COLS + c;
  const start = idx(s0.c, s0.r);
  const goal = idx(g0.c, g0.r);
  const h = (c, r) => {
    const dx = Math.abs(c - g0.c);
    const dy = Math.abs(r - g0.r);
    return (dx + dy) + (Math.SQRT2 - 2) * Math.min(dx, dy);
  };
  gScore[start] = 0;
  // 简单二叉堆
  const heap = [[h(s0.c, s0.r), start]];
  const push = (f, i) => {
    heap.push([f, i]);
    let k = heap.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (heap[p][0] <= heap[k][0]) break;
      [heap[p], heap[k]] = [heap[k], heap[p]];
      k = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const l = k * 2 + 1;
        const r2 = l + 1;
        let m = k;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r2 < heap.length && heap[r2][0] < heap[m][0]) m = r2;
        if (m === k) break;
        [heap[m], heap[k]] = [heap[k], heap[m]];
        k = m;
      }
    }
    return top;
  };

  const DIRS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1]];
  let found = false;
  while (heap.length) {
    const [, cur] = pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (cur === goal) { found = true; break; }
    const cc = cur % COLS;
    const cr = (cur - cc) / COLS;
    for (const [dc, dr, cost] of DIRS) {
      const nc = cc + dc;
      const nr = cr + dr;
      if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) continue;
      const ni = idx(nc, nr);
      if (!WALK[ni] || closed[ni]) continue;
      // 斜走禁止切角
      if (dc && dr && (!WALK[idx(cc + dc, cr)] || !WALK[idx(cc, cr + dr)])) continue;
      const ng = gScore[cur] + cost;
      if (ng < gScore[ni]) {
        gScore[ni] = ng;
        came[ni] = cur;
        push(ng + h(nc, nr), ni);
      }
    }
  }
  if (!found) return null;
  const cells = [];
  let cur = goal;
  while (cur !== -1) {
    const c = cur % COLS;
    cells.push(toPoint(c, (cur - c) / COLS));
    cur = came[cur];
  }
  cells.reverse();
  // 保留首尾真实坐标（网格会吸附到 2px 格点）
  if (cells.length) {
    cells[0] = { x: Math.round(from.x), y: Math.round(from.y) };
    cells[cells.length - 1] = { x: Math.round(to.x), y: Math.round(to.y) };
  }
  return simplify(cells);
}

// 折线简化：去掉共线的中间点
function simplify(pts) {
  if (pts.length <= 2) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i += 1) {
    const a = out[out.length - 1];
    const b = pts[i];
    const c = pts[i + 1];
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (cross !== 0) out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// ---- 校验：沿折线逐像素检查脚区是否压到桌子 ----
function overlap(ax, ay, aw, ah, b) {
  return ax < b.x + b.w && ax + aw > b.x && ay < b.y + b.h && ay + ah > b.y;
}
function checkFeet(pts, footW, footH) {
  const hits = new Set();
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1];
    const b = pts[i];
    const steps = Math.max(1, Math.abs(b.x - a.x) + Math.abs(b.y - a.y));
    for (let s = 0; s <= steps; s += 1) {
      const t = s / steps;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      // 脚区：以脚中心为原点，宽 footW 高 footH
      const fx = x - footW / 2;
      const fy = y - footH;
      for (const [di, d] of DESKS.entries()) {
        if (overlap(fx, fy, footW, footH, d)) hits.add(di + '@' + Math.round(x) + ',' + Math.round(y));
      }
    }
  }
  return [...hits];
}

function pathLen(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i += 1) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return Math.round(s);
}

// ---- 跑全部用例 ----
const door = doc.door;
const rows = [];
let fail = 0;

function feetOf(seat) { return { x: seat.seated.x + 13, y: seat.seated.y + 37 }; }
function feetMain() { return { x: doc.main.seated.x + 19, y: doc.main.seated.y + 51 }; }

function run(name, from, to) {
  const pts = findPath(from, to);
  if (!pts) { rows.push(`BAD ${name} 无解`); fail += 1; return; }
  const bad = checkFeet(pts, FOOT_W, FOOT_H);
  if (bad.length) fail += 1;
  rows.push(`${bad.length ? 'BAD' : 'OK '} ${name.padEnd(20)} 拐点=${String(pts.length).padStart(3)} 长度=${String(pathLen(pts)).padStart(4)} 碰撞=${bad.length} ${bad.slice(0, 2).join(' ')}`);
}

// 入场：从门外走进来
const doorFeet = { x: door.x + door.w / 2, y: door.bottom - 4 };
for (const s of doc.subs) run('door->' + s.seatId, doorFeet, feetOf(s));
run('door->main', doorFeet, feetMain());

// 回家：几个典型落点
const spots = [[30, 360], [160, 180], [280, 350], [100, 150], [60, 250], [300, 210]];
for (let i = 0; i < doc.subs.length; i += 3) {
  const s = doc.subs[i];
  for (const sp of spots) run('home:' + s.seatId + '@' + sp[0] + ',' + sp[1], { x: sp[0], y: sp[1] }, feetOf(s));
}
for (const sp of spots) run('home:main@' + sp[0] + ',' + sp[1], { x: sp[0], y: sp[1] }, feetMain());

console.log(rows.join('\n'));
console.log(`\n合计 ${rows.length} 条，失败 ${fail} 条`);

// 顺便验证入口/座位脚底本身是否可站
const seatBad = [];
for (const s of doc.subs) {
  const f = feetOf(s);
  const hits = checkFeet([f, f], FOOT_W, FOOT_H);
  if (hits.length) seatBad.push(s.seatId);
}
console.log('坐在工位上时脚压到桌子的座位（应为空）:', seatBad.length ? seatBad.join(',') : '无');
if (fail) process.exitCode = 1;
