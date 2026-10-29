// 副角色坐姿帧生成驱动（turn-b 专用，只放进 tmp/，不改 tools/）
// 用法：node tmp/turnb-run.mjs --char m5-sporty --view front [--try 1]
// 串行、单张、失败自动重试（最多 3 次），输出 JSON 摘要。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const GEN = path.join(ROOT, 'tools', 'gen-pixel.mjs');

const CHARS = {
  'm5-sporty': {
    desc: '深蓝色长发、头顶一撮呆毛、橙色发带、右侧蓝色小蝴蝶结、灰蓝色兽耳、灰蓝色鲸鱼尾巴，一双蓝色大眼睛，白色橙色撞色运动背心（胸前有橙色数字 07）、白色百褶短裙配橙色滚边、橙色运动鞋',
    back: 'assets/char/subs/sit-back/m5-sporty-sit.png',
    outfit: 'assets/char/subs/outfits/m5-sporty.png',
  },
  'm6-witch': {
    desc: '深蓝色长发、头顶一撮呆毛、黑色蕾丝边头饰带白色荷叶边、右侧蓝色小蝴蝶结、灰蓝色兽耳、灰蓝色鲸鱼尾巴，一双蓝色大眼睛，深紫色魔女风连衣长裙配白色荷叶边围裙、黑色蝴蝶领结、胸口金色星星吊坠、深色圆头小皮鞋',
    back: 'assets/char/subs/sit-back/m6-witch-sit.png',
    outfit: 'assets/char/subs/outfits/m6-witch.png',
  },
  'm7-cafe': {
    desc: '深蓝色长发、头顶一撮呆毛、米色荷叶边女仆头饰、右侧蓝色小蝴蝶结、灰蓝色兽耳、灰蓝色鲸鱼尾巴，一双蓝色大眼睛，米色卡其色咖啡店女仆连衣裙配白色围裙（围裙上印着棕色咖啡杯图案）、棕色小皮鞋',
    back: 'assets/char/subs/sit-back/m7-cafe-sit.png',
    outfit: 'assets/char/subs/outfits/m7-cafe.png',
  },
  'm8-idol': {
    desc: '深蓝色长发、头顶一撮呆毛、白色蕾丝荷叶边头饰配粉色小蝴蝶结、头顶戴一顶金色小皇冠（皇冠必须画出来）、右侧蓝色小蝴蝶结、灰蓝色兽耳、灰蓝色鲸鱼尾巴，一双蓝色大眼睛，粉色偶像风连衣裙配白色荷叶边围裙、粉色蝴蝶结、粉白色小皮鞋',
    back: 'assets/char/subs/sit-back/m8-idol-sit.png',
    outfit: 'assets/char/subs/outfits/m8-idol.png',
  },
};

const NO_PROP = '画面里只有角色和一把最简单的椅子，椅子上没有扶手、没有小桌板、没有托盘、没有台面；角色双手悬空向前平伸、手指微微弯曲，悬空的手不接触任何物体；绝对不画桌面、不画键盘、不画显示器、不画电脑、不画墙、不画地板线、不画任何其他家具。';

const FRONT = (d) => `像素风游戏角色立绘，16 位像素美术风格，硬边像素画，无渐变无抗锯齿。一个 Q 版二次元角色，${d}，端正坐在一把简单的椅子上，正面朝向观众，完整正脸正对镜头，两只眼睛都清楚可见，双手向前平伸、手指微微弯曲做出敲键盘的动作。${NO_PROP}角色连同椅子只占画面高度 45%~65%，正中间居中，四周留出充足纯品红色 #FF00FF 背景。纯平涂上色，只用纯色块与 1px 深色描边，绝对不要渐变、不要高光过渡、不要阴影模糊、不要景深、不要文字、不要水印、不要多个角色。`;

const SIDE = (d) => `像素风游戏角色立绘，16 位像素美术风格，硬边像素画，无渐变无抗锯齿。一个 Q 版二次元角色，${d}，端正坐在一把简单的椅子上，严格 90 度正侧面、脸和身体完全侧对镜头、面朝画面右侧，只能看到一只眼睛和侧脸鼻子轮廓，看不见另一只眼睛，双手向画面右侧平伸、手指微微弯曲做出敲键盘的动作。${NO_PROP}角色连同椅子只占画面高度 45%~65%，正中间居中，四周留出充足纯品红色 #FF00FF 背景。纯平涂上色，只用纯色块与 1px 深色描边，绝对不要渐变、不要高光过渡、不要阴影模糊、不要景深、不要文字、不要水印、不要多个角色。`;

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : def;
}

const charKey = arg('--char');
const view = arg('--view', 'front');
const cfg = CHARS[charKey];
if (!cfg) throw new Error(`未知角色: ${charKey}`);
if (view !== 'front' && view !== 'side') throw new Error(`未知朝向: ${view}`);
if (!fs.existsSync(cfg.back)) throw new Error(`背面参考图不存在: ${cfg.back}`);
if (!fs.existsSync(cfg.outfit)) throw new Error(`服装参考图不存在: ${cfg.outfit}`);

const outRel = `assets/char/subs/sit-${view}/${charKey}-${view}.png`;
const outAbs = path.join(ROOT, outRel);
fs.mkdirSync(path.dirname(outAbs), { recursive: true });

const prompt = view === 'front' ? FRONT(cfg.desc) : SIDE(cfg.desc);

let lastErr = '';
for (let attempt = 1; attempt <= 3; attempt += 1) {
  const r = spawnSync(process.execPath, [
    GEN,
    '-p', prompt,
    '-o', outRel,
    '-s', '1328*1328',
    '-i', cfg.back,
    '-i', cfg.outfit,
  ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 240000 });

  const so = (r.stdout || '').trim();
  const se = (r.stderr || '').trim();
  if (r.status === 0 && fs.existsSync(outAbs) && fs.statSync(outAbs).size > 1000) {
    let info = {};
    try { info = JSON.parse(so.split('\n').pop()); } catch { /* 忽略 */ }
    process.stdout.write(`${JSON.stringify({ ok: true, char: charKey, view, out: outRel, attempt, bytes: fs.statSync(outAbs).size, info })}\n`);
    process.exit(0);
  }
  lastErr = se || so || `exit ${r.status}`;
  await new Promise((res) => setTimeout(res, 3000));
}

process.stderr.write(`${JSON.stringify({ ok: false, char: charKey, view, out: outRel, error: lastErr.slice(0, 500) })}\n`);
process.exit(1);
