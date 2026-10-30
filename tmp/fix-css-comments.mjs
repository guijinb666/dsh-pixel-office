// 一次性：修回 styles.css 里被 PowerShell 转码损坏的注释行（全部是 /* */ 注释，功能行未受损）
import fs from 'node:fs';

const F = 'site/styles.css';
const lines = fs.readFileSync(F, 'utf8').split('\n');

const PATCH = {
  1: `/* 像素工作台 · 介绍页
   方向 one-motif / giant-cropped-shape：全页只有一个母题 —— 办公室底图上那扇圆拱门洞的圆。
   它在这里依次变成：首屏被裁掉的巨圆、圆里那块实机录屏、皮肤舞台的圆盘、告示牌的圆角。
   字体 Libre Franklin 700（标题）+ Source Serif 4（正文）；色板 sky / sand / sun / ink。
   禁：渐变、静止阴影、字号过多种、等宽正文、细描边盒、emoji、编号 01/02/03。 */`,
  15: '  /* 五档字号 + 一个展示级。全站只用这些，改这里等于改全站。 */',
  16: '  --s1: 13px;                                          /* 注释、图说、页脚 */',
  19: '  --s4: clamp(34px, 3.4vw, 56px);                      /* 节标题、名字列、数字 */',
  118: '/* 母题：一个被视口右缘裁掉的巨圆，圆心落在 78% 宽 / 56% 高处。 */',
  143: '/* 录屏装在一个正圆里，正圆坐在那个被裁掉的巨圆上 —— 全页唯一的母题 */',
  176: '/* ───────────── 实机录屏（正圆 = 门洞的圆） ───────────── */',
  301: '/* ───────────── 四个瞬间（高度交替，不用卡片） ───────────── */',
  372: '/* 气泡滚动：容器裁切 + 内部整条平移 */',
  397: '/* 灯：一根灯绳 + 一个灯泡 + 一圈光晕，光晕在呼吸，灯丝偶尔掉电 */',
  425: '/* 钟：按 12 格跳，盘面上有刻度，秒针跟着转 */',
  473: '/* 设置面板：四行分段按钮依次亮，末行是「恢复默认」 */',
  507: '/* ───────────── 账目（不等宽拼贴） ───────────── */',
};

let hit = 0;
for (const [k, v] of Object.entries(PATCH)) {
  const i = Number(k) - 1;
  if (lines[i] === undefined) { console.error('缺行', k); continue; }
  lines[i] = v;
  hit += 1;
}

const out = lines.join('\n');
fs.writeFileSync(F, out, 'utf8');

const left = out.split('\n').filter((l) => l.includes('\uFFFD'));
console.log(`修回 ${hit} 行；残留替换字符行 ${left.length}`);
left.slice(0, 10).forEach((l) => console.log('  ', l.slice(0, 90)));
