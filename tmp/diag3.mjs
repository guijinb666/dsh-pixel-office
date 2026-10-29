import { readPNG } from '../tools/png.mjs';
const list = [
  'packages/dsh-pixel-office/assets/char/main/final/main-sit-1.png',
  'packages/dsh-pixel-office/assets/char/main/sit-front/front-1.png',
  'packages/dsh-pixel-office/assets/char/main/sit-front/front-2.png',
  'packages/dsh-pixel-office/assets/char/main/sit-front/front-3.png',
  'packages/dsh-pixel-office/assets/char/main/sit-side/side-1.png',
  'packages/dsh-pixel-office/assets/char/main/sit-side/side-2.png',
  'packages/dsh-pixel-office/assets/char/main/sit-side/side-3.png',
  'packages/dsh-pixel-office/assets/char/main/stand-front/stand-1.png',
  'packages/dsh-pixel-office/assets/char/main/stand-front/stand-2.png',
  'packages/dsh-pixel-office/assets/char/main/stand-side/stand-side-1.png',
  'packages/dsh-pixel-office/assets/char/main/stand-side/stand-side-2.png',
];
for (const f of list) {
  const { w, h, data } = readPNG(f);
  // 量实际不透明包围盒
  let x0=1e9,y0=1e9,x1=-1,y1=-1;
  for (let y=0;y<h;y++) for (let x=0;x<w;x++){ if(data[(y*w+x)*4+3]>8){ if(x<x0)x0=x; if(y<y0)y0=y; if(x>x1)x1=x; if(y>y1)y1=y; } }
  console.log(f.split('/').pop().padEnd(20), (w+'x'+h).padEnd(8), 'bbox='+(x1-x0+1)+'x'+(y1-y0+1), '@('+x0+','+y0+')');
}
