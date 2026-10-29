import { readPNG } from '../tools/png.mjs';
const list = [
  'packages/dsh-pixel-office/assets/char/main/stand-front/stand-1.png',
  'packages/dsh-pixel-office/assets/char/main/stand-front/stand-2.png',
  'packages/dsh-pixel-office/assets/char/main/stand-side/stand-side-1.png',
  'packages/dsh-pixel-office/assets/char/main/stand-side/stand-side-2.png',
  'packages/dsh-pixel-office/assets/char/main/sit-front/front-1.png',
  'packages/dsh-pixel-office/assets/char/main/final/main-sit-1.png',
  'packages/dsh-pixel-office/assets/char/main/sit-floor/floor-1.png',
];
for (const f of list) {
  try {
    const { w, h, data } = readPNG(f);
    let opaque = 0, mag = 0;
    const n = w * h;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];
      if (a > 8) opaque++;
      if (a > 8 && r > 120 && b > 120 && g < 100 && Math.abs(r-b) < 100) mag++;
    }
    console.log(f.replace('packages/dsh-pixel-office/',''), w+'x'+h, 'opaque='+(opaque/n*100).toFixed(1)+'%', 'magenta='+(mag/n*100).toFixed(1)+'%');
  } catch(e) { console.log(f, 'ERR', e.message); }
}
