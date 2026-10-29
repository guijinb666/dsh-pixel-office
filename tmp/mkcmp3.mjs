import { readPNG, writePNG } from '../tools/png.mjs';
function up(src, dst, scale) {
  const { w, h, data } = readPNG(src);
  const W=w*scale, H=h*scale; const out=Buffer.alloc(W*H*4);
  for (let y=0;y<H;y++) for (let x=0;x<W;x++){ const si=(Math.floor(y/scale)*w+Math.floor(x/scale))*4, di=(y*W+x)*4; for(let k=0;k<4;k++) out[di+k]=data[si+k]; }
  writePNG(dst,W,H,out); console.log(dst,W+'x'+H);
}
up('packages/dsh-pixel-office/assets/char/main/stand-side/stand-side-1.png','tmp/cmp-stand/standside-1-x6.png',6);
