// 只读盘点：读取 packages/dsh-pixel-office/assets 下全部 png 的尺寸与字节数
import fs from 'node:fs';
import path from 'node:path';
import { readPNG } from '../tools/png.mjs';

const ROOT = path.resolve(process.cwd(), 'packages/dsh-pixel-office/assets');

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(ROOT).filter((f) => f.toLowerCase().endsWith('.png')).sort();
const rows = [];
for (const f of files) {
  const rel = path.relative(ROOT, f).split(path.sep).join('/');
  const bytes = fs.statSync(f).size;
  let w = -1, h = -1, err = '';
  try {
    const img = readPNG(f);
    w = img.w; h = img.h;
  } catch (e) {
    err = String(e && e.message || e);
  }
  rows.push({ rel, w, h, bytes, err });
}

const groups = new Map();
for (const r of rows) {
  const g = path.posix.dirname(r.rel);
  if (!groups.has(g)) groups.set(g, []);
  groups.get(g).push(r);
}

console.log('TOTAL_PNG=' + rows.length);
for (const [g, list] of [...groups].sort()) {
  console.log('\n## ' + g + '  (' + list.length + ' 张)');
  for (const r of list) {
    console.log(`${path.posix.basename(r.rel)}\t${r.w}x${r.h}\t${r.bytes}\t${r.err}`);
  }
}

// 机器可读，便于后续比对
fs.writeFileSync(
  path.join(process.cwd(), 'tmp', 'audit-png-index.json'),
  JSON.stringify(rows, null, 2) + '\n'
);
