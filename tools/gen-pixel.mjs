// 像素资产生成器：调用 qq-bridge 已配置的 qwen-image-3.0-pro 生图模型。
//
// 设计依据（都是从 C:\Users\30612\Desktop\qq\qq-bridge\src\image-qwen.js 实测出来的）：
// 1. qwen-image-3.0-pro 只吃 multimodal-generation 这一个端点；异步 text2image 和
//    compatible-mode/images 都不通。
// 2. 返回的是 OSS 临时 URL，必须再 GET 一次才能拿到字节。
// 3. 返回格式是 output.choices[0].message.content 里 content 数组的一项 .image。
// 4. 参考图走 extra 的 content: [{image: 'data:image/png;base64,...'}]，最多 4 张。
//
// 用法：
//   node tools/gen-pixel.mjs -p "提示词" -o assets/raw/x.png
//   node tools/gen-pixel.mjs -p "提示词" -s 1328*1328 -o assets/raw/x.png
//   node tools/gen-pixel.mjs -p "提示词" -i ref.png -o assets/raw/x.png --json
//
// 参数：
//   -p/--prompt   必填
//   -o/--out      输出文件路径（必填）
//   -s/--size     尺寸，默认 1328*1328（正方形，便于后续切 16px 网格）
//   -i/--image    参考图，可重复（图生图/风格锁定）
//   -m/--model    默认 qwen-image-3.0-pro
//   --seed        随机种子（写进提示词尾部，用于可复现）
//   --json        只输出 JSON 摘要
//   --timeout-ms  默认 180000

import fs from 'node:fs';
import path from 'node:path';

const DASHSCOPE = 'https://dashscope.aliyuncs.com';
const GEN_URL = `${DASHSCOPE}/api/v1/services/aigc/multimodal-generation/generation`;
const BRIDGE_CONFIG = 'C:\\Users\\30612\\Desktop\\qq\\qq-bridge\\config.json';

function parseArgs(argv) {
  const out = { images: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-p' || a === '--prompt') out.prompt = argv[++i];
    else if (a === '-o' || a === '--out') out.out = argv[++i];
    else if (a === '-s' || a === '--size') out.size = argv[++i];
    else if (a === '-i' || a === '--image') out.images.push(argv[++i]);
    else if (a === '-m' || a === '--model') out.model = argv[++i];
    else if (a === '--seed') out.seed = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--timeout-ms') out.timeoutMs = Number(argv[++i]);
  }
  return out;
}

// 从 qq-bridge 的配置里取 key —— 不重复造配置，跟 QQ 侧用同一个账号。
function resolveKey() {
  if (process.env.QWEN_API_KEY) return process.env.QWEN_API_KEY.trim();
  if (process.env.DASHSCOPE_API_KEY) return process.env.DASHSCOPE_API_KEY.trim();
  try {
    const raw = fs.readFileSync(BRIDGE_CONFIG, 'utf8');
    const cfg = JSON.parse(raw);
    const key = cfg?.socialV2?.image?.apiKey;
    if (key && String(key).trim()) return String(key).trim();
  } catch { /* 配置读不到就走环境变量 */ }
  return '';
}

function dataUri(file) {
  const buf = fs.readFileSync(file);
  const ext = path.extname(file).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
    : ext === '.webp' ? 'image/webp'
      : 'image/png';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(5000, timeoutMs || 180000));
  try {
    return await fetch(url, { ...options, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.prompt) throw new Error('缺少 -p 提示词');
  if (!args.out) throw new Error('缺少 -o 输出路径');

  const key = resolveKey();
  if (!key) throw new Error('没拿到千问 API key（qq-bridge/config.json 的 socialV2.image.apiKey 或 QWEN_API_KEY）');

  const content = [];
  for (const img of args.images.slice(0, 4)) {
    if (!fs.existsSync(img)) throw new Error(`参考图不存在: ${img}`);
    content.push({ image: dataUri(img) });
  }
  content.push({ text: args.prompt });

  const body = {
    model: args.model || 'qwen-image-3.0-pro',
    input: { messages: [{ role: 'user', content }] },
    parameters: {
      n: 1,
      prompt_extend: false,
      watermark: false,
      size: args.size || '1328*1328'
    }
  };

  const started = Date.now();
  const res = await fetchWithTimeout(GEN_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }, args.timeoutMs);
  const raw = await res.text();
  if (!res.ok) throw new Error(`生图失败 HTTP ${res.status}: ${raw.slice(0, 400)}`);

  let json;
  try { json = JSON.parse(raw); } catch { throw new Error(`返回非 JSON: ${raw.slice(0, 200)}`); }

  const item = (json.output?.choices?.[0]?.message?.content ?? []).find((c) => c && c.image);
  const url = item?.image;
  if (!url) throw new Error(`返回里没有图片: ${raw.slice(0, 400)}`);

  const imgRes = await fetchWithTimeout(url, { method: 'GET' }, args.timeoutMs);
  if (!imgRes.ok) throw new Error(`下载生成图失败 HTTP ${imgRes.status}`);
  const buf = Buffer.from(await imgRes.arrayBuffer());

  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(args.out, buf);

  const summary = {
    ok: true,
    file: path.resolve(args.out),
    bytes: buf.length,
    width: json.usage?.output_width ?? null,
    height: json.usage?.output_height ?? null,
    model: body.model,
    size: body.parameters.size,
    refs: content.filter((c) => c.image).length,
    elapsed_ms: Date.now() - started,
    remote_url: url
  };
  if (args.json) process.stdout.write(`${JSON.stringify(summary)}\n`);
  else process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: String(err?.message || err) })}\n`);
  process.exitCode = 1;
});
