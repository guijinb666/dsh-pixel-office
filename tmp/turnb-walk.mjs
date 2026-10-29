// 侧面行走帧生成驱动（turn-b 专用，tmp/ 内）
// 用法：node tmp/turnb-walk.mjs --char 5-sporty
// 串行单张；失败/限流自动重试（最多 3 次，间隔 15 秒）

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const GEN = path.join(ROOT, 'tools', 'gen-pixel.mjs');

// 角色特征：只保留人形 + 兽耳；明确不写尾巴/鱼鳍
const CHARS = {
  '5-sporty': {
    desc: '深蓝色及腰长卷发、头顶一撮呆毛、橙色发带、右侧蓝色小蝴蝶结、头顶两侧一对灰蓝色兽耳，一双蓝色大眼睛；穿白色橙色撞色运动风连衣裙（胸前橙色数字 07）、白色百褶短裙配橙色滚边、白袜、橙色运动鞋',
    side: 'assets/char/subs/sit-side/m5-sporty-side.png',
    outfit: 'assets/char/subs/outfits/m5-sporty.png',
  },
  '6-witch': {
    desc: '深蓝色及腰长卷发、头顶一撮呆毛、黑色蕾丝边头饰带白色荷叶边、右侧蓝色小蝴蝶结、头顶两侧一对灰蓝色兽耳，一双蓝色大眼睛；穿深紫色魔女风连衣长裙配白色荷叶边围裙、黑色蝴蝶领结、胸口金色星星吊坠、白袜、深色圆头小皮鞋',
    side: 'assets/char/subs/sit-side/m6-witch-side.png',
    outfit: 'assets/char/subs/outfits/m6-witch.png',
  },
  '7-cafe': {
    desc: '深蓝色及腰长卷发、头顶一撮呆毛、米色荷叶边女仆头饰、右侧蓝色小蝴蝶结、头顶两侧一对灰蓝色兽耳，一双蓝色大眼睛；穿米色卡其色咖啡店女仆连衣裙配白色围裙（围裙上印着棕色咖啡杯图案）、白袜、棕色小皮鞋',
    side: 'assets/char/subs/sit-side/m7-cafe-side.png',
    outfit: 'assets/char/subs/outfits/m7-cafe.png',
  },
  '8-idol': {
    desc: '深蓝色及腰长卷发、头顶一撮呆毛、白色蕾丝荷叶边头饰配粉色小蝴蝶结、头顶戴一顶金色小皇冠（皇冠必须画出来）、右侧蓝色小蝴蝶结、头顶两侧一对灰蓝色兽耳，一双蓝色大眼睛；穿粉色偶像风连衣裙配白色荷叶边围裙、粉色蝴蝶结、白袜、粉白色小皮鞋',
    side: 'assets/char/subs/sit-side/m8-idol-side.png',
    outfit: 'assets/char/subs/outfits/m8-idol.png',
  },
};

const PROMPT = (d) => `像素画，16 位像素游戏美术风格。一个穿女仆装的小女孩，${d}，正在向画面右侧行走的半侧面动作定格，全身，四分之三侧面偏侧视（能看见侧脸轮廓、一只眼睛、鼻尖朝右）。

角色造型与身体比例严格参照第一张参考图；服装细节与配色严格参照第二张参考图，不要改动服装。

动作要求：正在迈步走路，靠近观众一侧的腿向前迈出、另一条腿在后，手臂自然前后摆动；身体直立，头部朝正前方（画面右侧），不要回头。

画面要求：
- 硬边像素画，色块分明，绝对不要渐变、不要抗锯齿、不要柔化边缘、不要写实光影
- 只有角色自己，绝对不要画椅子、桌子、地板、地毯、阴影、道具、文字、边框
- 角色整体只占画面高度 45%~65%，画面四周留出大片纯品红色空白，角色不贴边
- 背景为纯品红色 #FF00FF 纯色平涂
- 角色是纯人形小女孩，绝对不要画尾巴、不要画鱼鳍、不要画鱼鳞、不要画翅膀、不要画任何非人肢体`;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const key = arg('--char');
const cfg = CHARS[key];
if (!cfg) throw new Error(`未知角色: ${key}`);
if (!fs.existsSync(cfg.side)) throw new Error(`侧面参考图不存在: ${cfg.side}`);
if (!fs.existsSync(cfg.outfit)) throw new Error(`服装参考图不存在: ${cfg.outfit}`);

const outRel = `assets/char/subs/walk-side/m${key}-walk.png`;
const outAbs = path.join(ROOT, outRel);
fs.mkdirSync(path.dirname(outAbs), { recursive: true });

const prompt = PROMPT(cfg.desc);
const MIN_BYTES = 200000;

let lastErr = '';
for (let attempt = 1; attempt <= 3; attempt += 1) {
  const r = spawnSync(process.execPath, [
    GEN,
    '-p', prompt,
    '-o', outRel,
    '-s', '1328*1328',
    '-i', cfg.side,
    '-i', cfg.outfit,
  ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 240000 });

  const okFile = fs.existsSync(outAbs) && fs.statSync(outAbs).size > MIN_BYTES;
  if (r.status === 0 && okFile) {
    process.stdout.write(`${JSON.stringify({ ok: true, char: key, out: outRel, attempt, bytes: fs.statSync(outAbs).size })}\n`);
    process.exit(0);
  }
  lastErr = ((r.stderr || '') + (r.stdout || '') || `exit ${r.status}`).trim();
  if (attempt < 3) await new Promise((res) => setTimeout(res, 15000));
}

process.stderr.write(`${JSON.stringify({ ok: false, char: key, out: outRel, error: lastErr.slice(0, 400) })}\n`);
process.exit(1);
