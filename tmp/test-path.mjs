// 路径规划纯函数级校验：沿折线走一遍，逐像素检查精灵矩形是否压到桌子/椅子。
// 用法 node tmp/test-path.mjs
import { readFileSync } from 'node:fs';

const doc = JSON.parse(readFileSync('packages/dsh-pixel-office/assets/scene/seats.json', 'utf8'));
const ROW_GAPS = [355, 301, 250, 185];
const COL_GAPS = [26, 103, 164, 225, 297];

// ---- 从 client.js 抄过来的同一套算法（改了要同步） ----
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function laneBelow(footY) {
  let best = null;
  let lowest = ROW_GAPS[0];
  for (const g of ROW_GAPS) {
    if (g > lowest) lowest = g;
    if (g > footY && (best === null || g < best)) best = g;
  }
  return best === null ? lowest : best;
}
const laneTop = (footY, h) => Math.round(footY - (h || 37));

function nearestCol(x) {
  let best = COL_GAPS[0];
  let bestD = Math.abs(best - x);
  for (let i = 1; i < COL_GAPS.length; i += 1) {
    const d = Math.abs(COL_GAPS[i] - x);
    if (d < bestD) { bestD = d; best = COL_GAPS[i]; }
  }
  return best;
}

function dedupePath(pts) {
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    out.push({ x: Math.round(p.x), y: Math.round(p.y) });
  }
  return out;
}

function planRoute(from, target, spriteH) {
  const sh = spriteH || 37;
  const l1 = laneTop(laneBelow(from.y + sh), sh);
  const l2 = laneTop(laneBelow(target.y + sh), sh);
  const c1 = nearestCol(from.x);
  const c2 = nearestCol(target.x);
  const pts = [{ x: from.x, y: from.y }, { x: from.x, y: l1 }, { x: c1, y: l1 }];
  if (l2 !== l1) pts.push({ x: c1, y: l2 });
  pts.push({ x: c2, y: l2 });
  if (c2 !== target.x) pts.push({ x: target.x, y: l2 });
  pts.push({ x: target.x, y: target.y });
  return dedupePath(pts);
}

// ---- 障碍物矩形：桌子整块 + 椅子区 ----
// 桌子 = 实木台面（deskL..deskR, deskTop..deskBottom）。
// 椅子 = 桌前沿下方，宽度收到 seat 的 sprite 宽（人坐在上面时这里本来就有人）。
function obstacles() {
  const out = [];
  const m = doc.main;
  out.push({ id: 'main-desk', x: m.deskL, y: m.deskTop, w: m.deskR - m.deskL, h: m.deskBottom - m.deskTop });
  for (const s of doc.subs) {
    out.push({ id: s.seatId + '-desk', x: s.deskL, y: s.deskTop, w: s.deskR - s.deskL, h: s.deskBottom - s.deskTop });
  }
  // 茶水区/矮柜等底图家具（下沿留白上方那一圈）
  out.push({ id: 'bar', x: 236, y: 336, w: 84, h: 40 });
  out.push({ id: 'cabinet-l', x: 0, y: 336, w: 26, h: 40 });
  return out;
}

const OBS = obstacles();

function overlap(ax, ay, aw, ah, b) {
  return ax < b.x + b.w && ax + aw > b.x && ay < b.y + b.h && ay + ah > b.y;
}

// 沿折线每 1px 采样，用精灵矩形（宽 w、高 h，左上角在采样点）测碰撞
function checkPath(pts, w, h) {
  const hits = new Set();
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1];
    const b = pts[i];
    const steps = Math.max(1, Math.abs(b.x - a.x) + Math.abs(b.y - a.y));
    for (let s = 0; s <= steps; s += 1) {
      const t = s / steps;
      const x = Math.round(a.x + (b.x - a.x) * t);
      const y = Math.round(a.y + (b.y - a.y) * t);
      for (const o of OBS) {
        if (overlap(x, y, w, h, o)) hits.add(o.id + '@' + x + ',' + y);
      }
    }
  }
  return [...hits];
}

const door = doc.door;
const results = [];

function doorTo(seatId, target, w, h) {
  const startX = Math.round(door.x + door.w / 2 - w / 2);
  // 入场：从门洞下沿往上走进来，脚底在 door.y 附近
  const pts = planRoute({ x: startX, y: door.y - h }, { x: target.x, y: target.y }, h);
  const bad = checkPath(pts, w, h);
  results.push({ name: 'door->' + seatId, pts: pts.length, bad: bad.length, sample: bad.slice(0, 3) });
}

// 主鱼
doorTo('main', doc.main.seated, 38, 51);
// 12 个副工位
doc.subs.forEach((s) => doorTo(s.seatId, s.seated, 26, 37));

// 回家：从任意落点回工位
function homeFrom(seatId, from, target, w, h) {
  const pts = planRoute(from, { x: target.x, y: target.y }, h);
  const bad = checkPath(pts, w, h);
  results.push({ name: 'home:' + seatId, pts: pts.length, bad: bad.length, sample: bad.slice(0, 3) });
}
// 模拟几个典型落点：过道里、主地毯上、面板左下、面板右下
const spots = [[30, 360], [160, 180], [280, 350], [100, 150]];
for (let i = 0; i < doc.subs.length; i += 4) {
  const s = doc.subs[i];
  for (const sp of spots) homeFrom(s.seatId, { x: sp[0], y: sp[1] }, s.seated, 26, 37);
}
homeFrom('main', { x: 40, y: 300 }, doc.main.seated, 38, 51);

console.log('=== 路径碰撞校验（bad=0 才算全程走在自己能走的地方） ===');
for (const r of results) {
  const flag = r.bad === 0 ? 'OK ' : 'BAD';
  console.log(`${flag} ${r.name.padEnd(18)} 拐点=${r.pts} 碰撞=${r.bad} ${r.sample.length ? JSON.stringify(r.sample) : ''}`);
}
const fail = results.filter((r) => r.bad > 0);
console.log(`\n合计 ${results.length} 条，失败 ${fail.length} 条`);
if (fail.length) process.exitCode = 1;
