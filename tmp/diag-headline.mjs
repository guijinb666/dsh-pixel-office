// 只读诊断脚本 3：把 index.js 里的文本函数原样抽出来跑，比较
// headlineFor(text, 5)（现状）与 headlineFor(text, 14)（补丁建议）的差别。
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../packages/dsh-pixel-office/lib/index.js', import.meta.url), 'utf8');
const lines = src.split(/\r?\n/);
const slice = (a, b) => lines.slice(a - 1, b).join('\n');

// 158-264: sanitizeText / BUBBLE_MAX_CHARS / ACTION_LABELS / stripMarkup / 尾部量词 / headlineAscii
// 221-228: isCleanClause
// 270-324: headlineFor
const code = [
  slice(158, 264),
  slice(221, 228),
  slice(270, 324),
].join('\n');

const factory = new Function(code + '\nreturn { headlineFor, sanitizeText };');
const { headlineFor } = factory();

const samples = [
  '我查了三个来源，分别是官方文档、GitHub issue 和源码。',
  '交付：assets/scene/office-dark-320.png 已经落盘，尺寸 320×431。',
  '先跑一遍冒烟测试，确认 57 项全过。',
  '整理好流程继续开始做',
  '把 drawScreens 里的内缩量改成 2px。',
  '接下来我要生成 8 张背面坐姿的图。',
  '好的，现在开始把气泡定位那段重写。',
  '嗯',
  '副鱼的生命周期改成只有会话销毁才离场。',
  'run the smoke test again',
  '先看一眼 seats.json 里的 staggerY，再决定错层间距。',
];

const rows = [];
for (const s of samples) {
  rows.push({
    原文: s,
    '现在(5)': headlineFor(s, 5),
    '补丁(14)': headlineFor(s, 14),
    '主鱼(10)': headlineFor(s, 10),
  });
}
console.table(rows);

// 收工固定文案
for (const t of ['子任务已完成', '本轮出错，请在会话框查看', '本轮已完成，请在会话框查看汇报结果']) {
  console.log(`收工文案 ${JSON.stringify(t)} (len=${t.length}) → headlineFor(...,5) = ${JSON.stringify(headlineFor(t, 5))}`);
}
