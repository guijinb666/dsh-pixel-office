/**
 * 真实事件回放验收。
 *
 * 冒烟测试用的是手写的小事件，这里直接拿**另一个会话的真实 jsonl**（也就是
 * 用户抱怨「气泡不显示」的那段时间）灌进插件，看它能不能自己吐出气泡文本、
 * 模型名和交付文件。
 *
 * 这件事等价于「重启 GUI 后的效果」，而且能在不掐断当前会话的前提下验证。
 *
 * 用法：node tmp/replay-real.mjs [jsonl路径] [最多喂多少行]
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const FILE = process.argv[2] || 'tmp/_sess2/session.v4.jsonl';
const LIMIT = Number(process.argv[3] || 400);
const PKG = path.resolve('packages/dsh-pixel-office/lib/index.js');

if (!fs.existsSync(FILE)) {
  console.error('找不到事件流：' + FILE);
  process.exit(2);
}

// --- 极简 host 夹具 ---------------------------------------------------------
const registered = [];
const handlers = new Map();

function makeRes() {
  const out = { status: 0, headers: {}, body: '', finished: false };
  return {
    out,
    setHeader(k, v) { out.headers[String(k).toLowerCase()] = v; },
    writeHead(code, hdrs) {
      out.status = code;
      if (hdrs) for (const k of Object.keys(hdrs)) out.headers[k.toLowerCase()] = hdrs[k];
    },
    end(chunk) {
      if (chunk !== undefined) out.body += String(chunk);
      out.finished = true;
    },
    write(chunk) { out.body += String(chunk); },
  };
}

function makeReq(pathAndQuery, remote) {
  return {
    url: pathAndQuery,
    method: 'GET',
    socket: { remoteAddress: remote || '127.0.0.1' },
    headers: { host: '127.0.0.1' },
  };
}

const ctx = {
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  on(name, fn) {
    if (!handlers.has(name)) handlers.set(name, []);
    handlers.get(name).push(fn);
  },
  effect(fn) { fn(); },
  webServer: {
    register(route) { registered.push(route); },
  },
  get() { return undefined; },
};

function emit(name, ...args) {
  const list = handlers.get(name) || [];
  for (const fn of list) {
    try { fn(...args); } catch (e) { console.error('handler 抛错：' + e.message); }
  }
}

const mod = await import(pathToFileURL(PKG).href);
mod.apply(ctx);

function findRoute(pathname) {
  const exact = registered.find(
    (r) => r.kind === 'exact' && (r.path === pathname || pathname.startsWith(r.path + '?')),
  );
  if (exact) return exact;
  return registered.find((r) => r.kind === 'prefix' && pathname.startsWith(r.path));
}

async function call(pathAndQuery) {
  const pathname = pathAndQuery.split('?')[0];
  const route = findRoute(pathname);
  if (!route) throw new Error('no route for ' + pathAndQuery);
  const res = makeRes();
  await route.handler(makeReq(pathAndQuery), res);
  return res.out;
}

// --- 读真实事件流 -----------------------------------------------------------
const lines = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean);
const rootSession = { id: 'replay-root', header: { origin: 'root' } };

let fed = 0;
let assistantMsgs = 0;
let toolCalls = 0;
let turnEnds = 0;
// 每喂若干条就看一眼快照，记录气泡"最高水位"——气泡会被后面的 assistant
// 消息覆盖，只看最后一条会误判成空。
let best = { text: '', model: '', files: 0, at: 0 };

for (const line of lines) {
  if (fed >= LIMIT) break;
  let ev;
  try { ev = JSON.parse(line); } catch { continue; }
  if (!ev || typeof ev.type !== 'string') continue;
  // 只喂插件关心的四类事件
  if (!['turn/start', 'assistant/message', 'tool/call', 'turn/end'].includes(ev.type)) continue;

  fed += 1;
  if (ev.type === 'assistant/message') assistantMsgs += 1;
  if (ev.type === 'tool/call') toolCalls += 1;
  if (ev.type === 'turn/end') turnEnds += 1;

  emit('session/event', rootSession, ev);

  if (ev.type === 'assistant/message' || ev.type === 'tool/call') {
    const r = await call('/api/pixel-office/state');
    const snap = JSON.parse(r.body).snapshot;
    const main = snap.main;
    if (main) {
      const score = (main.bubble.text || '').length + (main.model ? 100 : 0) + main.files.length * 10;
      const bestScore = best.text.length + (best.model ? 100 : 0) + best.files * 10;
      if (score > bestScore) {
        best = {
          text: main.bubble.text || '',
          model: main.model || '',
          files: main.files.length,
          at: ev.seq,
        };
      }
    }
  }
}

const r = await call('/api/pixel-office/state');
const snap = JSON.parse(r.body).snapshot;

let fails = 0;
function check(name, ok, detail) {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  ' + detail : ''));
  if (!ok) fails += 1;
}

console.log('回放：' + FILE);
console.log('  喂入 ' + fed + ' 条（assistant/message ' + assistantMsgs +
  '，tool/call ' + toolCalls + '，turn/end ' + turnEnds + '）\n');

check('主工位已被真实事件占位', snap.main !== null, JSON.stringify(snap.main && snap.main.agentId));
check('气泡在回放过程中拿到过非空正文', best.text.length > 0,
  'seq=' + best.at + ' 长度=' + best.text.length + ' 内容=' + JSON.stringify(best.text.slice(0, 40)));
check('模型名被解出（不是空串）', best.model.length > 0, JSON.stringify(best.model));
check('交付文件被记下', best.files > 0, 'files=' + best.files);
check('气泡正文不是原始 markup / 换行', best.text.indexOf('\n') < 0,
  JSON.stringify(best.text.slice(0, 60)));
// 新设定（m01404）：正文不再截断，气泡靠 10 字窗口横向滚动展示全文，
// 所以这里只校验"确实拿到了完整原文（上限 4000 字兜底）"，不再校验 240 字。
check('气泡正文未被截断（4000 字兜底内）', best.text.length <= 4000, '长度=' + best.text.length);
check('气泡正文保留了完整一句（不止 10 字窗口）', best.text.length > 10,
  '长度=' + best.text.length + '（窗口 10 字，超出的靠滚动展示）');

console.log('\n结果: ' + (fails === 0 ? '全部通过' : fails + ' 项失败'));
process.exit(fails === 0 ? 0 : 1);
