import { readPNG } from '../tools/png.mjs';
import fs from 'node:fs';
import path from 'node:path';
const ROOT='packages/dsh-pixel-office/assets';
function walk(d, out=[]) { for (const e of fs.readdirSync(d,{withFileTypes:true})) { const p=path.join(d,e.name); if(e.isDirectory()) walk(p,out); else if(e.name.endsWith('.png')) out.push(p); } return out; }
const groups = {};
for (const f of walk(ROOT)) {
  const rel = f.replace(ROOT+'\\','').replace(ROOT+'/','');
  const dir = path.dirname(rel).replace(/\\/g,'/');
  if (!groups[dir]) groups[dir] = [];
  try { const {w,h}=readPNG(f); groups[dir].push([path.basename(f), w+'x'+h]); }
  catch(e){ groups[dir].push([path.basename(f), 'ERR']); }
}
for (const k of Object.keys(groups).sort()) {
  console.log('\n== ' + k + '  (' + groups[k].length + ')');
  console.log('   ' + groups[k].map(([n,s])=>n+' '+s).join(' | '));
}
