// 单张生图助手：从文件读提示词，调用 tools/gen-pixel.mjs。
// 用法：node tmp/turn-gen.mjs -f tmp/turn-prompt-front1.txt -o tmp/turn-raw/front-1-r1.png -i a.png -i b.png
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
let file = '', out = '', size = '1328*1328';
const images = [];
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '-f') file = argv[++i];
  else if (a === '-o') out = argv[++i];
  else if (a === '-s') size = argv[++i];
  else if (a === '-i') images.push(argv[++i]);
}
if (!file || !out) {
  process.stderr.write('缺少 -f 或 -o\n');
  process.exit(1);
}
const prompt = fs.readFileSync(file, 'utf8').trim();
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
const args = ['tools/gen-pixel.mjs', '-p', prompt, '-o', out, '-s', size, '--json'];
for (const img of images) args.push('-i', img);
const r = spawnSync(process.execPath, args, {
  cwd: 'C:\\Users\\30612\\Desktop\\像素工作台',
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024
});
process.stdout.write(r.stdout || '');
process.stderr.write(r.stderr || '');
if (r.status !== 0) process.exitCode = 1;
