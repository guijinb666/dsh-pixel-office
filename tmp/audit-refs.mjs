// 只读盘点 B 部分：把 client.js 的资产引用展开成具体路径，逐个大小写严格核对磁盘
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd(), 'packages/dsh-pixel-office/assets');

// 与 client.js 保持一致的常量（逐字抄自源码）
const SUB_NAMES = ['m1-cat', 'm2-sakura', 'm3-gothic', 'm4-sailor', 'm5-sporty', 'm6-witch', 'm7-cafe', 'm8-idol'];
const MAIN_FRAMES = {
  sit: ['main-sit-1.png', 'main-sit-2.png', 'main-sit-3.png', 'main-sit-4.png'],
  type: ['main-type-a.png', 'main-type-b.png', 'main-type-c.png', 'main-type-d.png'],
  walkUp: ['main-walkup-1.png', 'main-walkup-2.png', 'main-walkup-3.png', 'main-walkup-4.png'],
  walkDown: ['main-walkdown-1.png', 'main-walkdown-2.png', 'main-walkdown-3.png', 'main-walkdown-4.png'],
  walkSide: ['main-walkside-1.png', 'main-walkside-2.png', 'main-walkside-3.png', 'main-walkside-4.png'],
  poseIdle: ['main-pose-idle.png'],
  poseThinking: ['main-pose-thinking.png'],
  poseDone: ['main-pose-done.png'],
  poseAsleep: ['main-pose-asleep.png'],
};
const MAIN_TURN = {
  front: ['stand-1.png', 'stand-2.png'],
  side: ['stand-side-1.png', 'stand-side-2.png'],
  floor: ['floor-1.png'],
};
const MAIN_SLEEP_SRC = ['main-sleep.png'];

const refs = []; // { path, site }
const add = (p, site) => refs.push({ path: p, site });

add('scene/office-dark-320.png', 'L838 loadAssets');
add('scene/screens/lit-sub.png', 'L849 loadAssets');
add('scene/screens/lit-main.png', 'L852 loadAssets');
for (const [k, names] of Object.entries(MAIN_FRAMES)) {
  for (const n of names) add('char/main/final/' + n, `L859 MAIN_FRAMES.${k}`);
}
for (const n of SUB_NAMES) add('char/subs/final/' + n + '.png', 'L866 SUB_SKINS');
for (const n of MAIN_TURN.front) add('char/main/stand-front/' + n, 'L878 MAIN_TURN.front');
for (const n of MAIN_TURN.side) add('char/main/stand-side/' + n, 'L881 MAIN_TURN.side');
for (const n of SUB_NAMES) add('char/subs/sit-front/' + n + '-front.png', 'L885 SUB_NAMES');
for (const n of SUB_NAMES) add('char/subs/sit-side/' + n + '-side.png', 'L888 SUB_NAMES');
for (const n of MAIN_TURN.front) add('char/main/stand-front/' + n, 'L893 MAIN_STAND.front');
for (const n of MAIN_TURN.side) add('char/main/stand-side/' + n, 'L896 MAIN_STAND.side');
for (const n of SUB_NAMES) add('char/subs/walk-side/' + n + '-walk.png', 'L899 SUB_WALK');
for (const n of SUB_NAMES) add('char/subs/sleep/' + n + '-sleep.png', 'L904 SUB_SLEEP');
for (const n of MAIN_SLEEP_SRC) add('char/main/sleep/' + n, 'L909 MAIN_SLEEP_SRC');
for (const n of MAIN_TURN.floor) add('char/main/sit-floor/' + n, 'L914 MAIN_TURN.floor');
for (const n of SUB_NAMES) add('char/subs/sit-floor/' + n + '-floor.png', 'L917 SUB_NAMES');
add('ui/board.png', 'L921 + L3090');
add('ui/sign.png', 'L86 SIGN_SRC -> L926 / L4690');
add('scene/seats.json', 'index.js L914 /api/seats 读盘');

// 大小写严格存在性检查：逐级 readdir 比对
function exactExists(rel) {
  const segs = rel.split('/');
  let cur = ROOT;
  for (let i = 0; i < segs.length; i += 1) {
    let entries;
    try { entries = fs.readdirSync(cur); } catch { return { ok: false, at: 'dir-missing:' + cur, seg: segs[i] }; }
    if (!entries.includes(segs[i])) {
      const ci = entries.find((e) => e.toLowerCase() === segs[i].toLowerCase());
      return { ok: false, at: cur, seg: segs[i], near: ci || null };
    }
    cur = path.join(cur, segs[i]);
  }
  return { ok: true, abs: cur };
}

const uniq = new Map();
for (const r of refs) {
  if (!uniq.has(r.path)) uniq.set(r.path, []);
  uniq.get(r.path).push(r.site);
}

console.log('REF_UNIQUE=' + uniq.size + ' REF_CALLS=' + refs.length);
let bad = 0;
for (const [p, sites] of [...uniq].sort()) {
  const e = exactExists(p);
  if (!e.ok) {
    bad += 1;
    console.log('MISS\t' + p + '\tseg=' + e.seg + '\tnear=' + e.near + '\tsite=' + sites.join(','));
  }
}
console.log('MISSING_COUNT=' + bad);

// 磁盘全量（png + json）→ 反查孤儿
function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const disk = walk(ROOT).map((f) => path.relative(ROOT, f).split(path.sep).join('/')).sort();
const refSet = new Set(uniq.keys());
console.log('\nDISK_TOTAL=' + disk.length);
for (const d of disk) {
  if (!refSet.has(d)) console.log('ORPHAN\t' + d);
}
