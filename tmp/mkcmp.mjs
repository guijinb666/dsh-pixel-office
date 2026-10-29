import { readPNG, writePNG } from '../tools/png.mjs';
function up(src, dst, scale) {
  const { w, h, data } = readPNG(src);
  const W = w*scale, H = h*scale;
  const out = Buffer.alloc(W*H*4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const sx = Math.floor(x/scale), sy = Math.floor(y/scale);
    const si = (sy*w+sx)*4, di = (y*W+x)*4;
    out[di]=data[si]; out[di+1]=data[si+1]; out[di+2]=data[si+2]; out[di+3]=data[si+3];
  }
  writePNG(dst, W, H, out);
  console.log(dst, W+'x'+H);
}
up('packages/dsh-pixel-office/assets/char/main/stand-front/stand-1.png','tmp/cmp-stand/stand-1-x6.png',6);
up('packages/dsh-pixel-office/assets/char/main/sit-front/front-1.png','tmp/cmp-stand/front-1-x6.png',6);
up('packages/dsh-pixel-office/assets/char/main/stand-side/stand-side-1.png','tmp/cmp-stand/side-1-x6.png',6);
