import { readPNG, writePNG } from '../tools/png.mjs';
function up(src, dst, scale) {
  const { w, h, data } = readPNG(src);
  const W=w*scale, H=h*scale; const out=Buffer.alloc(W*H*4);
  for (let y=0;y<H;y++) for (let x=0;x<W;x++){ const si=(Math.floor(y/scale)*w+Math.floor(x/scale))*4, di=(y*W+x)*4; for(let k=0;k<4;k++) out[di+k]=data[si+k]; }
  writePNG(dst,W,H,out); console.log(dst,W+'x'+H);
}
const B='packages/dsh-pixel-office/assets/char/main/';
up(B+'sit-front/front-2.png','tmp/cmp-stand/f2-x6.png',6);
up(B+'sit-front/front-3.png','tmp/cmp-stand/f3-x6.png',6);
up(B+'sit-side/side-2.png','tmp/cmp-stand/s2-x6.png',6);
up(B+'stand-side/stand-side-2.png','tmp/cmp-stand/ss2-x6.png',6);
