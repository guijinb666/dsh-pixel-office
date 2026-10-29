import { readPNG } from '../tools/png.mjs';
import fs from 'node:fs';
import path from 'node:path';
const ROOT='packages/dsh-pixel-office/assets';
function walk(d, out=[]) { for (const e of fs.readdirSync(d,{withFileTypes:true})) { const p=path.join(d,e.name); if(e.isDirectory()) walk(p,out); else if(e.name.endsWith('.png')) out.push(p); } return out; }
const files = walk(ROOT);
for (const f of files) {
  try { const {w,h}=readPNG(f); if (w>200) console.log('BIG ', (w+'x'+h).padEnd(10), f.replace(ROOT+'/','')); }
  catch(e){ console.log('ERR ', f, e.message); }
}
console.log('--- total png:', files.length);
