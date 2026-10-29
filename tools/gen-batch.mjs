// 批量像素资产生成器。
//
// 为什么要有这个文件：
//   1. 单个生成 ~9s，20 张串行要 3 分钟；并行发 4 路能把墙钟压到 1/3。
//   2. 动作帧必须"同一张脸"——靠 -i 参考图（img2img）锁住造型，不能靠提示词重复描述。
//   3. manifest 落盘成 JSON，生成的资产清单可复现、可 diff。
//
// 用法：
//   node tools/gen-batch.mjs tools/manifest.json            # 跑全部
//   node tools/gen-batch.mjs tools/manifest.json --only fish # 只跑名字含 fish 的
//   node tools/gen-batch.mjs tools/manifest.json --jobs 4

import fs from 'node:fs';
import path from 'node:path';

const DASHSCOPE = 'https://dashscope.aliyuncs.com';
const GEN_URL = `${DASHSCOPE}/api/v1/services/aigc/multimodal-generation/generation`;
const BRIDGE_CONFIG = 'C:\\Users\\30612\\Desktop\\qq\\qq-bridge\\config.json';

function resolveKey() {
  if (process.env.QWEN_API_KEY) return process.env.QWEN_API_KEY.trim();
  if (process.env.DASHSCOPE_API_KEY) return process.env.DASHSCOPE_API_KEY.trim();
  try {
    const cfg = JSON.parse(fs.readFileSync(BRIDGE_CONFIG, 'utf8'));
    const key = cfg?.socialV2?.image?.apiKey;
    if (key && String(key).trim()) return String(key).trim();
  } catch { /* 读不到就落到下面报错 */ }
  return '';
}

function dataUri(file) {
  const buf = fs.readFileSync(file);
  const ext = path.extname(file).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
    : ext === '.webp' ? 'image/webp' : 'image/png';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

function fetchWithTimeout(url, options, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(5000, timeoutMs || 180000));
  return fetch(url, { ...options, signal: ac.signal }).finally(() => clearTimeout(timer));
}

async function generateOne(item, key, root) {
  const started = Date.now();
  const content = [];
  for (const rel of (item.refs || []).slice(0, 4)) {
    const abs = path.resolve(root, rel);
    if (!fs.existsSync(abs)) throw new Error(`参考图不存在: ${rel}`);
    content.push({ image: dataUri(abs) });
  }
  content.push({ text: item.prompt });

  const body = {
    model: item.model || 'qwen-image-3.0-pro',
    input: { messages: [{ role: 'user', content }] },
    parameters: {
      n: 1,
      prompt_extend: false,
      watermark: false,
      size: item.size || '1328*1328'
    }
  };

  const res = await fetchWithTimeout(GEN_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }, item.timeoutMs);
  const raw = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 300)}`);

  let json;
  try { json = JSON.parse(raw); } catch { throw new Error(`返回非 JSON: ${raw.slice(0, 200)}`); }
  const node = (json.output?.choices?.[0]?.message?.content ?? []).find((c) => c && c.image);
  if (!node?.image) throw new Error(`无图片: ${raw.slice(0, 300)}`);

  const imgRes = await fetchWithTimeout(node.image, { method: 'GET' }, item.timeoutMs);
  if (!imgRes.ok) throw new Error(`下载失败 HTTP ${imgRes.status}`);
  const buf = Buffer.from(await imgRes.arrayBuffer());

  const out = path.resolve(root, item.out);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buf);

  return {
    ok: true,
    name: item.name,
    file: out,
    bytes: buf.length,
    width: json.usage?.output_width ?? null,
    height: json.usage?.output_height ?? null,
    refs: content.filter((c) => c.image).length,
    elapsed_ms: Date.now() - started
  };
}

async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = await worker(items[index], index);
      } catch (err) {
        results[index] = { ok: false, name: items[index].name, error: String(err?.message || err) };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const manifestPath = args.find((a) => !a.startsWith('--'));
  if (!manifestPath) throw new Error('缺少 manifest 路径');
  const onlyIndex = args.indexOf('--only');
  const only = onlyIndex >= 0 ? args[onlyIndex + 1] : null;
  const jobsIndex = args.indexOf('--jobs');
  const jobs = jobsIndex >= 0 ? Math.max(1, Number(args[jobsIndex + 1]) || 4) : 4;

  const root = process.cwd();
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  let items = Array.isArray(manifest) ? manifest : manifest.items || [];
  if (only) items = items.filter((i) => String(i.name).includes(only));
  if (!items.length) throw new Error('没有匹配的条目');

  const key = resolveKey();
  if (!key) throw new Error('没拿到千问 API key');

  process.stdout.write(`开始生成 ${items.length} 张，并发 ${jobs}\n`);
  const started = Date.now();
  let done = 0;
  const results = await pool(items, jobs, async (item) => {
    const r = await generateOne(item, key, root);
    done += 1;
    process.stdout.write(`  [${done}/${items.length}] ${r.ok ? '✓' : '✗'} ${item.name} ${r.ok ? `${r.bytes}B ${r.elapsed_ms}ms` : r.error}\n`);
    return r;
  });

  const reportFile = path.resolve(root, 'assets/raw/_report.json');
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, `${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`);

  const okCount = results.filter((r) => r.ok).length;
  process.stdout.write(`\n完成 ${okCount}/${items.length}，总耗时 ${Math.round((Date.now() - started) / 1000)}s\n`);
  process.stdout.write(`报告: ${reportFile}\n`);
  if (okCount !== items.length) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`失败: ${String(err?.message || err)}\n`);
  process.exitCode = 1;
});
