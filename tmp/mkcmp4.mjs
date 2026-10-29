import { readPNG, writePNG } from '../tools/png.mjs';
function up(src, dst, scale) {
  const { w, h, data } = readPNG(src);
  const W=w*scale, H=h*scale; const out=Buffer.alloc(W*H*4);
  for (let y=0;y<H;y++) for (let x=0;x<W;x++){ const si=(Math.floor(y/scale)*w+Math.floor(x/scale))*4, di=(y*W+x)*4; for(let k=0;k<4;k++) out[di+k]=data[si+k]; }
  writePNG(dst,W,H,out); console.log(dst,W+'x'+H);
}
const B='packages/dsh-pixel-office/assets/char/';
up(B+'subs/sit-front/m1-cat-front.png','tmp/cmp-stand/sub-front-x8.png',8);
up(B+'subs/walk-side/m1-cat-walk.png','tmp/cmp-stand/sub-walk-x8.png',8);
up(B+'main/final/main-walkside-1.png','tmp/cmp-stand/main-walkside-x8.png',8);
up(B+'main/final/main-walkside-2.png','tmp/cmp-stand/main-walkside2-x8.png',8);
up(B+'subs/final/m1-cat.png','tmp/cmp-stand/sub-back-x8.png',8);
