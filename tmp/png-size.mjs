// 只读 PNG/图像尺寸，不依赖 System.Drawing。
import fs from 'node:fs';
import path from 'node:path';

function pngSize(buf) {
  if (buf.length < 24) return null;
  if (buf.toString('ascii', 1, 4) !== 'PNG') return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

const dirs = process.argv.slice(2);
for (const d of dirs) {
  console.log('=== ' + d + ' ===');
  const abs = path.resolve(d);
  if (!fs.existsSync(abs)) { console.log('  (不存在)'); continue; }
  const files = fs.readdirSync(abs).filter((f) => f.toLowerCase().endsWith('.png')).sort();
  for (const f of files) {
    const p = path.join(abs, f);
    const s = pngSize(fs.readFileSync(p));
    console.log('  ' + f + '  ' + (s ? s.w + 'x' + s.h : '?') + '  ' + fs.statSync(p).size + 'B');
  }
}
