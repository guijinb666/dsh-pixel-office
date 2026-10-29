// 代码直绘像素办公室 v3 —— 3/4 斜俯视 + 元气骑士式画法
//
// 三条决定"颗粒感"的画法规则（压 AI 图压不出来，只能靠代码保证）：
//   1. 纯色填充   一个面就是一块颜色，绝无纹理噪点
//   2. 万物描边   每个剪影外圈 1px 深色，把物体从背景里"切"出来
//   3. 分段明暗   亮面/暗面用两三块台阶色，不做连续渐变
// 加上"绝不做抗锯齿"（全部整数坐标 + 最近邻放大），就有了那股颗粒感。
//
// 第四条是 3/4 斜俯视的立体感，做法是每个立体件画成两层：
//   「顶面（亮、大） + 朝观众的前立面（暗、窄）」，中间夹 1px 深色分界。
// 这不是透视投影，是像素画的固定套路——不需要真的算矩阵。
//
// 零依赖：自带 PNG 编码（zlib 内置），1x 画完再整数放大。

import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

// ---------- PNG 编码 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------- 调色板 ----------
const hex = (s) => [parseInt(s.slice(1,3),16), parseInt(s.slice(3,5),16), parseInt(s.slice(5,7),16), 255];
const mul = (c, k) => [Math.min(255, ((c[0]*k)|0)), Math.min(255, ((c[1]*k)|0)), Math.min(255, ((c[2]*k)|0)), 255];
const P = {
  ink:      '#100b17',   // 统一描边色
  bg:       '#08050b',
  wall:     '#31263e',
  wallHi:   '#3f3150',
  wallLo:   '#241b30',
  floor:    '#3a2d47',
  floorDark:'#332741',
  floorHi:  '#43354f',
  wood:     '#7a4e33',   // 桌面顶面
  woodHi:   '#94603e',
  woodLo:   '#502f1e',   // 桌面前立面
  woodEdge: '#2e1a10',
  metal:    '#282635',
  metalHi:  '#42405a',
  screen:   '#0b1424',
  glow:     '#4fd6bb',
  glowHi:   '#b8fff0',
  dark:     '#1b1526',
  carpet:   '#7a4652',
  carpetHi: '#96596a',
  lampLo:   '#b8863a',
  lamp:     '#ffd166',
  lampHi:   '#fff6d2',
  leafLo:   '#173a21',
  leaf:     '#2d6b39',
  leafHi:   '#52a35c',
  cream:    '#e8dcc8',
  coffee:   '#7a4a2e',
  fish:     '#2f8496',
  fishHi:   '#48a8bd',
  fishLo:   '#1d5b6b',
  belly:    '#d9e8e0',
  gold:     '#ffd166',
  badgeOn:  '#5ee6a8',
  badgeOff: '#4a4458'
};
const C = Object.fromEntries(Object.entries(P).map(([k, v]) => [k, hex(v)]));

// ---------- 画布 ----------
function makeCanvas(w, h) {
  const buf = Buffer.alloc(w * h * 4);
  const set = (x, y, c) => {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4;
    buf[i] = c[0]; buf[i+1] = c[1]; buf[i+2] = c[2]; buf[i+3] = c[3];
  };
  const api = {
    w, h, buf, set,
    rect(x, y, rw, rh, c) {
      for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) set(x+i, y+j, c);
    },
    hline(x, y, len, c) { api.rect(x, y, len, 1, c); },
    vline(x, y, len, c) { api.rect(x, y, 1, len, c); },
    disc(cx, cy, r, c) {
      for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++)
        if (i*i + j*j <= r*r + r) set(cx+i, cy+j, c);
    },
    // 3/4 立体件：整块描边 → 顶面 → 1px 分界 → 前立面
    solid(x, y, rw, depth, hFront, top, front) {
      api.rect(x, y, rw, depth + hFront, C.ink);
      api.rect(x+1, y+1, rw-2, depth-1, top);
      api.rect(x+1, y+depth, rw-2, hFront, front);
      api.hline(x+1, y+depth, rw-2, mul(front, 0.55));
    },
    // 落在桌面上的小物件（自带描边，显得"放在上面"）
    prop(x, y, rw, rh, fill, edge) {
      api.rect(x, y, rw, rh, C.ink);
      if (rw > 2 && rh > 2) api.rect(x+1, y+1, rw-2, rh-2, fill);
      if (edge && rh > 3) api.hline(x+1, y+rh-2, rw-2, edge);
    },
    upscale(n) {
      const ow = w*n, oh = h*n;
      const out = Buffer.alloc(ow*oh*4);
      for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
        const si = ((y/n|0) * w + (x/n|0)) * 4;
        const di = (y*ow + x) * 4;
        out[di]=buf[si]; out[di+1]=buf[si+1]; out[di+2]=buf[si+2]; out[di+3]=buf[si+3];
      }
      return { w: ow, h: oh, buf: out };
    }
  };
  return api;
}

// ================= 布局常量 =================
const W = 176, H = 260;
const c = makeCanvas(W, H);

const WALL_TOP = 2, WALL_BOT = 44;      // 上墙内立面
const FLOOR_TOP = 45;

// 主工位
const MAIN = { x: 40, w: 96, top: 56, depth: 18, hf: 12 };
const MAIN_DESK_BOT = MAIN.top + MAIN.depth + MAIN.hf;   // 86
const MAIN_FISH_CY = 104;

// 副工位
const SUB = { w: 34, depth: 13, hf: 10 };
const SUB_XS = [8, 50, 92, 134];
const SUB_ROWS = [150, 194];

// ================= 场景 =================
c.rect(0, 0, W, H, C.bg);
c.rect(WALL_TOP, WALL_TOP, W-4, H-4, C.floor);

// ---- 上墙内立面 ----
c.rect(WALL_TOP, WALL_TOP, W-4, WALL_BOT-WALL_TOP, C.wall);
c.hline(WALL_TOP, WALL_TOP, W-4, C.wallHi);
c.rect(WALL_TOP+1, WALL_TOP+1, W-6, 2, C.wallHi);
c.rect(WALL_TOP, WALL_BOT-4, W-4, 4, C.wallLo);     // 踢脚线
c.hline(WALL_TOP, WALL_BOT, W-4, C.ink);

// 窗（夜景）：窗框 + 十字棂 + 星点
c.rect(64, 9, 48, 30, C.ink);
c.rect(65, 10, 46, 28, C.screen);
c.rect(87, 10, 2, 28, C.ink);
c.hline(65, 23, 46, C.ink);
for (const [sx, sy] of [[70,15],[77,13],[94,17],[100,26],[83,29],[104,14],[91,32]]) c.set(sx, sy, C.glowHi);
c.rect(63, 38, 50, 2, C.metalHi);                   // 窗台
c.hline(63, 38, 50, mul(C.metalHi, 1.2));

// 两盏吊灯：同心圆做光晕（不用模糊）
function pendant(cx) {
  c.vline(cx, WALL_TOP, 9, C.metal);
  c.disc(cx, 16, 9, C.lampLo);
  c.disc(cx, 16, 7, C.lamp);
  c.disc(cx-1, 15, 4, C.lampHi);
}
pendant(22); pendant(154);

// ---- 地板 ----
// 纯净色 + 墙根暗带 + 稀疏反光点。不画格线：元气骑士的房间地面就是一块纯色。
c.rect(WALL_TOP, FLOOR_TOP, W-4, H-FLOOR_TOP-WALL_TOP, C.floor);
c.rect(WALL_TOP, FLOOR_TOP, W-4, 7, C.floorDark);
c.hline(WALL_TOP, FLOOR_TOP+7, W-4, mul(C.floor, 1.06));
for (let y = FLOOR_TOP + 20; y < H - 6; y += 26) {
  for (let x = 12 + ((y/26|0) % 2) * 22; x < W - 10; x += 44) {
    c.hline(x, y, 3, C.floorHi);
  }
}
// 房间内框
c.rect(WALL_TOP, WALL_TOP, W-4, 2, C.ink);
c.rect(WALL_TOP, WALL_TOP, 2, H-4, C.ink);
c.rect(W-2-WALL_TOP, WALL_TOP, 2, H-4, C.ink);
c.rect(WALL_TOP, H-2-WALL_TOP, W-4, 2, C.ink);

// ---- 主工位地毯（先画，被桌子和鱼压住）----
c.rect(52, 92, 68, 46, C.ink);
c.rect(53, 93, 66, 44, C.carpet);
c.rect(56, 96, 60, 2, C.carpetHi);
c.rect(56, 133, 60, 1, C.carpetHi);

// ---- 主工位 ----
c.rect(MAIN.x + 3, MAIN_DESK_BOT + 1, MAIN.w - 2, 3, C.ink);   // 桌前地面投影
c.solid(MAIN.x, MAIN.top, MAIN.w, MAIN.depth, MAIN.hf, C.wood, C.woodLo);
c.hline(MAIN.x + 2, MAIN.top + 2, MAIN.w - 4, C.woodHi);
c.hline(MAIN.x + 2, MAIN.top + 3, MAIN.w - 4, mul(C.wood, 1.08));

// 双屏：背朝观众（人坐在下方往里看），只从顶边漏一线屏光
function monitorBack(x, y, mw, mh) {
  c.rect(x, y, mw, mh, C.ink);
  c.rect(x+1, y+1, mw-2, mh-2, C.metal);
  c.hline(x+1, y+1, mw-2, C.metalHi);
  c.hline(x+1, y+2, mw-2, mul(C.metal, 0.8));
  c.hline(x+1, y+mh-2, mw-2, C.glow);              // 顶边漏光
  c.rect((x+mw/2-2)|0, y+mh, 5, 3, C.metal);        // 支架
  c.rect((x+mw/2-4)|0, y+mh+2, 9, 2, C.metal);      // 底座
}
monitorBack(MAIN.x + 15, MAIN.top + 3, 28, 13);
monitorBack(MAIN.x + 48, MAIN.top + 3, 28, 13);

// 键盘 + 鼠标 + 咖啡
c.prop(MAIN.x + 29, MAIN.top + 17, 32, 6, C.metalHi, mul(C.metalHi, 0.7));
c.prop(MAIN.x + 65, MAIN.top + 18, 7, 5, C.metalHi);
c.prop(MAIN.x + 5,  MAIN.top + 15, 9, 9, C.cream, C.coffee);

// ---- 大肥鱼（主工位，背对观众敲键盘）----
// 之前两版都画成"球"，根因是：只给了身体轮廓，没给**分层的剪影**。
// 修法是把角色拆成四个各自带描边的独立剪影，按远→近贴：
//   椅子(最远) → 尾扇 → 身体 → 双鳍(最近)
// 每个剪影都有完整 1px 外轮廓，叠在一起就有"零件感"，而不是一团色块。
// 再加两条硬规则：鳍必须是扇形（根细尖宽）且厚 3px；尾必须比身体更宽更暗。
//
// 读点优先级（从背后看）：
//   1. 尾扇在下方张开 —— "是条鱼"的第一读点
//   2. 双鳍在中段向斜上扫 —— "在敲键盘"的动作读点
//   3. 呆毛 + 背鳍脊 —— 破圆形的签名特征

// 逐行 [dy, halfWidth] 定义的实心块，带 1px 描边
function blob(cx, cy, profile, fill, ink = C.ink) {
  for (const [dy, hw] of profile) c.rect(cx - hw - 1, cy + dy - 1, hw * 2 + 3, 3, ink);
  for (const [dy, hw] of profile) c.rect(cx - hw, cy + dy, hw * 2 + 1, 1, fill);
}

function fishMain(cx, cy, frame) {
  const chairTop = cy + 12;

  // === 1. 椅背（最远层）===
  c.rect(cx - 16, chairTop, 33, 10, C.ink);
  c.rect(cx - 15, chairTop + 1, 31, 8, C.dark);
  c.hline(cx - 13, chairTop + 2, 27, mul(C.metalHi, 0.7));
  c.hline(cx - 13, chairTop + 3, 27, mul(C.dark, 0.7));

  // === 2. 尾扇（比身体宽、更暗）===
  const tail = [
    [8, 5], [9, 8], [10, 11], [11, 13], [12, 14], [13, 13], [14, 11], [15, 8]
  ];
  blob(cx, cy, tail, C.fishLo);
  // 尾鳍分叉：两道深色缺口，扇形就不糊成一片
  c.rect(cx - 2, cy + 11, 5, 4, mul(C.fishLo, 0.55));
  c.hline(cx - 11, cy + 12, 4, mul(C.fishLo, 1.4));
  c.hline(cx + 8, cy + 12, 4, mul(C.fishLo, 1.4));
  c.hline(cx - 6, cy + 10, 3, mul(C.fishLo, 1.25));
  c.hline(cx + 4, cy + 10, 3, mul(C.fishLo, 1.25));

  // === 3. 身体（胖桶：上圆下宽，重心在坐姿上）===
  const body = [
    [-15, 2], [-14, 4], [-13, 6], [-12, 8], [-11, 10], [-10, 11],
    [-9, 12], [-8, 13], [-7, 14], [-6, 14], [-5, 15], [-4, 15],
    [-3, 16], [-2, 16], [-1, 16], [0, 16], [1, 16], [2, 15],
    [3, 15], [4, 14], [5, 13], [6, 11], [7, 9]
  ];
  blob(cx, cy, body, C.fish);
  // 头顶受光（上方 7 行依高度收窄提亮）
  for (const [dy, hw] of body) {
    if (dy > -8) continue;
    const inset = dy < -13 ? 2 : 1;
    c.rect(cx - hw + inset, cy + dy, hw * 2 + 1 - inset * 2, 1, C.fishHi);
  }
  c.rect(cx - 5, cy - 13, 8, 3, mul(C.fishHi, 1.14));
  c.rect(cx - 6, cy - 14, 3, 2, mul(C.fishHi, 1.2));
  // 左右轮廓压暗，做出圆桶
  for (const [dy, hw] of body) {
    if (dy > 5) continue;
    c.set(cx - hw, cy + dy, C.fishLo);
    c.set(cx + hw, cy + dy, C.fishLo);
    if (dy > -6 && dy < 4) c.set(cx + hw - 1, cy + dy, mul(C.fishLo, 1.15));
  }

  // === 4. 背鳍脊（后背中线一道窄脊）===
  c.rect(cx - 2, cy - 19, 5, 5, C.ink);
  c.rect(cx - 1, cy - 18, 3, 4, C.fishLo);
  c.set(cx - 1, cy - 18, mul(C.fishHi, 0.85));
  c.set(cx + 1, cy - 15, C.ink);

  // === 5. 呆毛（往右上弯，不是直线）===
  c.set(cx, cy - 20, C.ink);
  c.set(cx, cy - 21, C.gold); c.set(cx + 1, cy - 21, C.gold);
  c.set(cx + 1, cy - 22, C.gold); c.set(cx + 2, cy - 23, C.gold);
  c.set(cx + 3, cy - 23, C.gold); c.set(cx + 2, cy - 22, C.fishHi);
  c.set(cx - 1, cy - 20, C.ink);

  // === 6. 眼镜腿（从背后看到的是镜腿）===
  c.rect(cx - 14, cy - 9, 4, 2, C.ink);
  c.rect(cx + 11, cy - 9, 4, 2, C.ink);
  c.set(cx - 12, cy - 9, C.metalHi);
  c.set(cx + 12, cy - 9, C.metalHi);

  // === 7. 双鳍（最近层，扇形轮廓：根细尖宽，向斜上扫）===
  // frame 交替：左鳍抬时右鳍落，做出敲击节奏
  const lift = [0, 2, 1, -1][frame & 3];
  const finRows = 9;
  for (let side = 0; side < 2; side++) {
    const dir = side === 0 ? -1 : 1;
    const lf = side === 0 ? lift : -lift;
    const edge = side === 0 ? cx - 16 : cx + 16;
    for (let i = 0; i < finRows; i++) {
      // 越往外越向上抬，形成扇形斜扫
      const yy = cy - 1 + lf - Math.round(i * 0.55);
      const len = 2 + Math.round(i * 0.35);       // 厚度随距离变厚，做扇面
      const x = edge + dir * i;
      const x0 = dir > 0 ? x : x - len;
      c.rect(x0 - 1, yy - 1, len + 2, len > 3 ? 4 : 3, C.ink);
      c.rect(x0, yy, len, len > 3 ? 2 : 1, C.fishLo);
    }
    // 鳍尖一块亮色，读作"指尖在按键"
    const tipY = cy - 1 + lf - 5;
    const tipX = side === 0 ? edge - 8 : edge + 3;
    c.rect(tipX, tipY, 4, 2, mul(C.fishHi, 0.85));
  }
}
fishMain(MAIN.x + 48, MAIN_FISH_CY + 2, 1);

// ---- 副工位 ----
function chair(x, y, w2, occupied) {
  c.rect(x, y, w2, 13, C.ink);
  c.rect(x+1, y+1, w2-2, 5, occupied ? C.dark : mul(C.dark, 0.8));
  c.rect(x+1, y+6, w2-2, 6, mul(C.dark, 0.62));
  c.hline(x+2, y+2, w2-4, occupied ? C.metalHi : mul(C.metalHi, 0.75));
}

// 一个副工位。occupied/running 由调用方给，默认空岗。
// 布局（相对 y）：0 屏幕顶 → 8 屏幕底 → 9 桌面键盘行 → depth 桌沿 → depth..depth+hf 桌前立面
function subDesk(x, y, st = {}) {
  const { w, depth, hf } = SUB;
  c.rect(x + 2, y + depth + hf + 1, w - 2, 2, C.ink);      // 地面投影
  c.solid(x, y, w, depth, hf, C.wood, C.woodLo);
  c.hline(x + 2, y + 2, w - 4, C.woodHi);

  // 单屏：居中，背朝观众，顶边漏光表示在用
  const sx = x + ((w - 14) / 2 | 0);
  c.rect(sx, y + 1, 14, 8, C.ink);
  c.rect(sx + 1, y + 2, 12, 6, C.metal);
  c.hline(sx + 1, y + 2, 12, C.metalHi);
  c.hline(sx + 1, y + 7, 12, st.running ? C.glow : mul(C.glow, 0.40));

  // 键盘：落在桌面里（y+depth-3 这一行，不是桌沿外）
  c.rect(x + 11, y + depth - 4, 13, 4, C.ink);
  c.rect(x + 12, y + depth - 4, 11, 2, C.metalHi);

  // 杯子（桌面左侧）
  c.rect(x + 3, y + depth - 6, 5, 6, C.ink);
  c.rect(x + 4, y + depth - 5, 3, 4, C.cream);
  c.hline(x + 4, y + depth - 4, 3, C.coffee);

  // 工牌立牌（桌面右侧）：空岗灰、在岗绿点
  c.rect(x + w - 9, y + depth - 8, 6, 8, C.ink);
  c.rect(x + w - 8, y + depth - 7, 4, 6, C.metalHi);
  c.rect(x + w - 7, y + depth - 6, 2, 3, st.occupied ? C.badgeOn : C.badgeOff);

  chair(x + ((w - 14) / 2 | 0), y + depth + hf + 1, 14, !!st.occupied);
}

// 预演：sub:0 和 sub:5 有人在岗（证明"有人/没人"的视觉差）
const occupancy = { 0: { occupied: true, running: true }, 5: { occupied: true, running: true } };
let idx = 0;
for (const y of SUB_ROWS) {
  for (const x of SUB_XS) { subDesk(x, y, occupancy[idx] || {}); idx++; }
}

// ---- 绿植（左墙根、右墙根各两盆）----
function plant(x, y) {
  c.rect(x, y + 12, 13, 11, C.ink);
  c.rect(x + 1, y + 13, 11, 9, C.woodLo);
  c.rect(x + 1, y + 13, 11, 2, mul(C.woodLo, 1.5));
  c.disc(x + 6, y + 7, 8, C.leafLo);
  c.disc(x + 3, y + 5, 5, C.leaf);
  c.disc(x + 10, y + 4, 5, C.leaf);
  c.disc(x + 2, y + 3, 2, C.leafHi);
  c.disc(x + 10, y + 2, 2, C.leafHi);
}
plant(7, 50); plant(155, 50);
plant(7, 112); plant(155, 112);

// ---- 底部：矮柜 + 落地灯 ----
c.solid(10, 236, 36, 6, 10, C.woodLo, mul(C.woodLo, 0.7));
c.hline(12, 238, 32, mul(C.woodLo, 1.35));
c.vline(28, 237, 8, C.ink);
c.rect(120, 234, 9, 18, C.ink);
c.rect(121, 235, 7, 16, C.metal);
c.disc(124, 231, 6, C.lampLo);
c.disc(124, 231, 4, C.lamp);
c.disc(123, 230, 2, C.lampHi);

// ---------- 输出 ----------
const outDir = path.resolve('assets/pixel');
fs.mkdirSync(outDir, { recursive: true });
const small = path.join(outDir, 'office-v3-1x.png');
fs.writeFileSync(small, encodePNG(W, H, c.buf));
const up = c.upscale(5);
const big = path.join(outDir, 'office-v3-5x.png');
fs.writeFileSync(big, encodePNG(up.w, up.h, up.buf));
// 8x 一份，肉眼看细节
const up8 = c.upscale(8);
fs.writeFileSync(path.join(outDir, 'office-v3-8x.png'), encodePNG(up8.w, up8.h, up8.buf));

process.stdout.write(JSON.stringify({
  pixelFile: small, pixelSize: `${W}x${H}`,
  preview5x: big, preview8x: path.join(outDir, 'office-v3-8x.png')
}, null, 2) + '\n');
