/**
 * 把八套副角皮肤放大成"能看清"的尺寸，供介绍页的圆盘用。
 *
 * 问题：原始 sit-front 帧只有 26×30 像素。介绍页里放大到 300px 宽等于 11.5 倍，
 * 最近邻放大虽然不糊，但一个 26 像素宽的小人在 300px 框里只占一条窄缝，
 * 周围全是空白，看起来像"图错了"。
 *
 * 做法：最近邻整数倍放大 8 倍 → 208×240 左右的画布，像素边缘绝对锐利；
 * 页面里再用 CSS 控制显示尺寸（此时缩小显示，比放大清晰得多）。
 * 顺带把透明边裁掉，让每套皮肤的画布比例贴近它自己的姿态宽高。
 *
 * 用法：node tmp/scaleskins.mjs
 */
import { readPNG, writePNG } from '../tools/png.mjs';
import fs from 'node:fs';

const OUT = 'docs/media';
const NAMES = ['猫耳', '樱色', '哥特', '水手', '运动', '女巫', '店员', '偶像'];
const SCALE = 8;

for (let i = 1; i <= 8; i += 1) {
  const src = `${OUT}/skin-${i}.png`;
  const img = readPNG(src);
  const { w, h, data } = img;

  // 1. 找不透明像素的包围盒（裁掉四周空白）
  let x0 = w; let y0 = h; let x1 = -1; let y1 = -1;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (data[(y * w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) { console.log(`skin-${i} ${NAMES[i - 1]} 全透明，跳过`); continue; }

  const cw = x1 - x0 + 1;
  const ch = y1 - y0 + 1;

  // 2. 最近邻整数倍放大
  const ow = cw * SCALE;
  const oh = ch * SCALE;
  const out = Buffer.alloc(ow * oh * 4);
  for (let y = 0; y < oh; y += 1) {
    const sy = y0 + Math.floor(y / SCALE);
    for (let x = 0; x < ow; x += 1) {
      const sx = x0 + Math.floor(x / SCALE);
      const si = (sy * w + sx) * 4;
      const di = (y * ow + x) * 4;
      out[di] = data[si];
      out[di + 1] = data[si + 1];
      out[di + 2] = data[si + 2];
      out[di + 3] = data[si + 3];
    }
  }

  writePNG(src, ow, oh, out);
  console.log(`skin-${i} ${NAMES[i - 1]}  ${w}x${h} → 裁 ${cw}x${ch} → ${ow}x${oh}`);
}
