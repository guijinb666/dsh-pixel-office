import { promises as fs } from "node:fs";
const src = await fs.readFile("packages/dsh-pixel-office/lib/index.js", "utf8");
const start = src.indexOf("const BUBBLE_MAX_CHARS = 10");
const end = src.indexOf("/** 从 assistant 消息里抽正文。");
const mod = new Function(src.slice(start, end) + "\nreturn { headlineFor };")();
const cases = [
  "好的，现在开始把气泡定位那段重写。面板逻辑宽只有 320px，副气泡最宽 150px。",
  "交付：assets/scene/office-dark-320.png 已经落盘，尺寸 320×431。",
  "我正在检查这条链路是否完整，稍等。",
  "先跑一遍冒烟测试，确认 46 项全过。",
  "The quick brown fox jumps over the lazy dog repeatedly.",
  "出错：端口 8791 已被占用，需要先杀掉旧进程。",
  "把 `drawScreens` 里的内缩量改成 2px，避免亮屏越出桌子。",
  "整理好流程继续开始做",
  "接下来我要生成 8 张背面坐姿的图，每张都要串行。",
  "嗯",
  "已把 drawActor 里的 a.fall 分支提前，掉落交给天空层处理。",
  "面板宽度 320，气泡最宽 150，四列间距只有 62，所以必须三层错开。",
];
let bad = 0;
for (const c of cases) {
  const out = mod.headlineFor(c);
  if (out.length > 10) { bad++; console.log("!! 超长 " + out.length + ": " + out); }
  console.log(String(out.length).padStart(2) + "字 | " + out);
}
console.log(bad === 0 ? "=== 全部 <=10 字 ===" : "=== 有超长 ===");
