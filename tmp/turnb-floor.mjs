// 坐地板帧生成驱动（turn-b 专用，tmp/ 内）
// 用法：node tmp/turnb-floor.mjs --char m5-sporty
// 串行单张、失败/限流自动重试（最多 3 次，间隔 20 秒）

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const GEN = path.join(ROOT, 'tools', 'gen-pixel.mjs');

const CHARS = {
  'm5-sporty': {
    desc: '深蓝色长发、头顶一撮呆毛、橙色发带、右侧蓝色小蝴蝶结、灰蓝色兽耳、灰蓝色鲸鱼尾巴，一双蓝色大眼睛，白色橙色撞色运动背心（胸前有橙色数字 07）、白色百褶短裙配橙色滚边、橙色运动鞋',
    outfit: 'assets/char/subs/outfits/m5-sporty.png',
  },
  'm6-witch': {
    desc: '深蓝色长发、头顶一撮呆毛、黑色蕾丝边头饰带白色荷叶边、右侧蓝色小蝴蝶结、灰蓝色兽耳、灰蓝色鲸鱼尾巴，一双蓝色大眼睛，深紫色魔女风连衣长裙配白色荷叶边围裙、黑色蝴蝶领结、胸口金色星星吊坠、深色圆头小皮鞋',
    outfit: 'assets/char/subs/outfits/m6-witch.png',
  },
  'm7-cafe': {
    desc: '深蓝色长发、头顶一撮呆毛、米色荷叶边女仆头饰、右侧蓝色小蝴蝶结、灰蓝色兽耳、灰蓝色鲸鱼尾巴，一双蓝色大眼睛，米色卡其色咖啡店女仆连衣裙配白色围裙（围裙上印着棕色咖啡杯图案）、棕色小皮鞋',
    outfit: 'assets/char/subs/outfits/m7-cafe.png',
  },
  'm8-idol': {
    desc: '深蓝色长发、头顶一撮呆毛、白色蕾丝荷叶边头饰配粉色小蝴蝶结、头顶戴一顶金色小皇冠（皇冠必须画出来）、右侧蓝色小蝴蝶结、灰蓝色兽耳、灰蓝色鲸鱼尾巴，一双蓝色大眼睛，粉色偶像风连衣裙配白色荷叶边围裙、粉色蝴蝶结、粉白色小皮鞋',
    outfit: 'assets/char/subs/outfits/m8-idol.png',
  },
};

const PROMPT = (d) => `像素风游戏角色立绘，16 位像素美术风格，硬边像素画，无渐变无抗锯齿。一个 Q 版二次元角色，${d}，正面对着观众，完整正脸正对镜头、两只眼睛都清楚可见，双腿向一侧弯着、屁股直接坐在地板上（可爱的少女坐地姿势），双手撑在身侧或放在膝上。画面里绝对没有椅子、没有板凳、没有沙发、没有桌子、没有电脑、没有家具，只有角色自己坐在地板上，地面也不画出来、背景保持纯色。角色只占画面高度 40%~58%，整体缩小一点、正中间居中，头发和尾巴都不要碰到画面边缘，四周至少留出相当于画面宽度 8% 的纯品红色 #FF00FF 背景留白。纯平涂上色，只用纯色块与 1px 深色描边，绝对不要渐变、不要高光过渡、不要阴影模糊、不要景深、不要文字、不要水印、不要多个角色。`;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const charKey = arg('--char');
const cfg = CHARS[charKey];
if (!cfg) throw new Error(`未知角色: ${charKey}`);
if (!fs.existsSync(cfg.outfit)) throw new Error(`服装参考图不存在: ${cfg.outfit}`);

const outRel = `assets/char/subs/sit-floor/${charKey}-floor.png`;
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
    '-i', cfg.outfit,
  ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 240000 });

  const okFile = fs.existsSync(outAbs) && fs.statSync(outAbs).size > MIN_BYTES;
  if (r.status === 0 && okFile) {
    process.stdout.write(`${JSON.stringify({ ok: true, char: charKey, out: outRel, attempt, bytes: fs.statSync(outAbs).size })}\n`);
    process.exit(0);
  }
  lastErr = ((r.stderr || '') + (r.stdout || '') || `exit ${r.status}`).trim();
  if (attempt < 3) await new Promise((res) => setTimeout(res, 20000));
}

process.stderr.write(`${JSON.stringify({ ok: false, char: charKey, out: outRel, error: lastErr.slice(0, 400) })}\n`);
process.exit(1);
