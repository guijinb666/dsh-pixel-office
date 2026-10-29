/**
 * 闲置睡姿验收（规划 P11）。
 *
 * 直接驱动 host 半，不走浏览器：睡姿是 host 决定 activity，前端只是照着换帧。
 * 用极简 cordis 夹具把插件挂起来，喂事件，读 /state 快照。
 *
 * 为了不让验收跑 90 秒，这里用 `--sleep-ms` 覆盖 ASLEEP_AFTER_MS 的时机：
 * 插件读的是模块常量，所以改成在同进程里用假定时器（monkey-patch setTimeout）
 * 把所有 90s 的定时器压成 50ms —— 这样既不改进产品代码，也不用真等。
 *
 * 用法：node tmp\sleep-test.mjs
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..', 'packages', 'dsh-pixel-office');

let pass = 0;
let fail = 0;
const rows = [];
function check(name, ok, detail) {
  if (ok) { pass += 1; rows.push(`  PASS ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail += 1; rows.push(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 把 90s 的睡姿定时器压成 60ms（只影响本进程注册的定时器） ----------
const realSetTimeout = global.setTimeout;
const SHORT = 60;
const LONG_MIN = 5000;
global.setTimeout = function patched(fn, ms, ...rest) {
  // 只压缩"长定时器"，子工位 6s 清场那种也要压，否则等不到清场
  if (typeof ms === 'number' && ms >= LONG_MIN) return realSetTimeout(fn, SHORT, ...rest);
  return realSetTimeout(fn, ms, ...rest);
};

const { apply } = await import('file://' + join(pkgRoot, 'lib', 'index.js').replace(/\\/g, '/'));

// ---- 极简 host 夹具 ------------------------------------------------------
const handlers = new Map();
const routes = [];
const ctx = {
  logger: { warn() {}, info() {}, debug() {} },
  on(name, fn) {
    if (!handlers.has(name)) handlers.set(name, []);
    handlers.get(name).push(fn);
  },
  get(name) {
    if (name === 'agents') return { get() { return null; } };
    return null;
  },
  effect(fn) { try { fn(); } catch { /* ignore */ } },
  webServer: { register(r) { routes.push(r); } },
  fs: { readText: async () => '' },
};

apply(ctx);

const emit = (name, ...args) => {
  for (const fn of handlers.get(name) || []) fn(...args);
};

// 直接调 /state 的 handler 读快照
function readState() {
  const route = routes.find((r) => r.path === '/api/pixel-office/state');
  return new Promise((resolve, reject) => {
    const req = { method: 'GET', headers: {}, url: '/api/pixel-office/state', socket: { remoteAddress: '127.0.0.1' } };
    const res = {
      _body: '',
      writeHead() {},
      setHeader() {},
      write(chunk) { this._body += chunk; },
      end(chunk) {
        if (chunk) this._body += chunk;
        try { resolve(JSON.parse(this._body)); } catch (e) { reject(e); }
      },
    };
    try { route.handler(req, res); } catch (e) { reject(e); }
  });
}

const rootSession = { id: 'root-1', header: { id: 'root-1' } };
const ev = (type, data) => ({ type, seq: ++seqN, time: Date.now(), data });
let seqN = 0;

// ---- 1) working 期间不允许睡 --------------------------------------------
emit('session/event', rootSession, ev('turn/start', { turn: 1 }));
emit('session/event', rootSession, ev('assistant/message', {
  turn: 1, step: 1,
  message: { role: 'assistant', content: [{ type: 'text', text: '正在干活' }], source: { kind: 'model', provider: 'deepseek-account', model: 'deepseek-flash' } },
}));
let st = await readState();
check('忙碌时工位是 working', st.snapshot.main && st.snapshot.main.activity === 'working', st.snapshot.main && st.snapshot.main.activity);

await sleep(150);   // 已被压成 60ms 的定时器此时早该响了
st = await readState();
check('working 期间不会被睡姿覆盖', st.snapshot.main && st.snapshot.main.activity === 'working', st.snapshot.main && st.snapshot.main.activity);

// ---- 2) 收工后闲置到点入睡 ----------------------------------------------
emit('session/event', rootSession, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
st = await readState();
check('收工瞬间是 done', st.snapshot.main && st.snapshot.main.activity === 'done', st.snapshot.main && st.snapshot.main.activity);

await sleep(200);
st = await readState();
check('闲置到点后变成 asleep', st.snapshot.main && st.snapshot.main.activity === 'asleep', st.snapshot.main && st.snapshot.main.activity);

// ---- 3) 新事件必须把人叫醒 ----------------------------------------------
emit('session/event', rootSession, ev('turn/start', { turn: 2 }));
st = await readState();
check('新一轮开始立刻醒', st.snapshot.main && st.snapshot.main.activity === 'working', st.snapshot.main && st.snapshot.main.activity);

// 再睡一次，然后用 tool/call 叫醒
emit('session/event', rootSession, ev('turn/end', { turn: 2, reason: { kind: 'completed' } }));
await sleep(200);
st = await readState();
check('第二次也能睡', st.snapshot.main && st.snapshot.main.activity === 'asleep', st.snapshot.main && st.snapshot.main.activity);

emit('session/event', rootSession, ev('tool/call', { turn: 3, step: 1, callId: 'c1', name: 'write', arguments: JSON.stringify({ file_path: 'x.txt' }) }));
st = await readState();
check('tool/call 叫醒', st.snapshot.main && st.snapshot.main.activity === 'working', st.snapshot.main && st.snapshot.main.activity);

// ---- 4) 子工位：end 后同样入睡 ------------------------------------------
const subSession = { id: 'sub-1', header: { id: 'sub-1', origin: 'subagent' } };
emit('subagent/start', { runId: 'r1', id: 'sub-1', provider: 'openai', local: false, model: 'gpt-5' });
st = await readState();
check('子工位已占位', st.snapshot.subs.some((s, i) => s && s.seatId === 'sub:0'), JSON.stringify(st.snapshot.subs.findIndex((s) => s)));

emit('subagent/end', { runId: 'r1', id: 'sub-1', stopReason: 'completed' });
await sleep(200);
st = await readState();
const sub0 = st.snapshot.subs[0];
check('子工位收工后入睡', !!sub0 && sub0.activity === 'asleep', sub0 && sub0.activity);

// ---- 4b) 回归：turn/end 之后副鱼不许消失 --------------------------------
// 曾经 turn/end 分支挂了一个 6000ms 的 setTimeout 把座位 blank 掉，
// 于是副鱼被召唤出来、坐一会就凭空消失。这里把 6000 与 90000 都压成 60ms，
// 200ms 足以覆盖，能真实拦住这个回归。
emit('session/event', subSession, ev('tool/call', { turn: 1, step: 1, callId: 's1', name: 'write', arguments: JSON.stringify({ file_path: 'y.txt' }) }));
emit('session/event', subSession, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
await sleep(200);
st = await readState();
const sub0b = st.snapshot.subs[0];
check('turn/end 后副鱼仍在座', !!sub0b && sub0b.seatId === 'sub:0', sub0b ? sub0b.seatId : 'null');
check('turn/end 后副鱼气泡=子任务完成', !!sub0b && sub0b.bubble.text === '子任务完成', sub0b && sub0b.bubble.text);

// ---- 5) 切会话要清定时器：不能残留 asleep -------------------------------
const route = routes.find((r) => r.path === '/api/pixel-office/state');
await new Promise((resolve) => {
  const req = { method: 'GET', headers: {}, url: '/api/pixel-office/state?current=another', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writeHead() {}, setHeader() {}, write() {}, end() { resolve(); } };
  route.handler(req, res);
});
st = await readState();
check('切会话后清场（无 asleep 残留）', !st.snapshot.main, JSON.stringify(st.snapshot.main));

global.setTimeout = realSetTimeout;

console.log(rows.join('\n'));
console.log(`\nsleep  PASS=${pass}  FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
