// 只读诊断脚本：验证「副鱼坐一会就消失」的确切触发时序。
// 手法照抄 tmp/sleep-test.mjs：monkey-patch global.setTimeout，把 >=5000ms 压成 60ms。
const realSetTimeout = global.setTimeout;
const SHORT = 60;
const LONG_MIN = 5000;
const scheduled = [];
global.setTimeout = function patched(fn, ms, ...rest) {
  if (typeof ms === 'number' && ms >= LONG_MIN) {
    scheduled.push(ms);
    return realSetTimeout(fn, SHORT, ...rest);
  }
  return realSetTimeout(fn, ms, ...rest);
};

const { apply } = await import('../packages/dsh-pixel-office/lib/index.js');

const handlers = new Map();
const routes = [];
const ctx = {
  on(name, fn) {
    if (!handlers.has(name)) handlers.set(name, []);
    handlers.get(name).push(fn);
  },
  effect(fn) { fn(); },
  webServer: { register(r) { routes.push(r); } },
  fs: { readText: async () => '' },
  logger: { warn() {}, info() {}, error() {} },
  get() { return undefined; },
};
apply(ctx);

function emit(name, ...args) {
  const list = handlers.get(name) || [];
  for (const fn of list) fn(...args);
}

let seqN = 0;
const ev = (type, data) => ({ type, seq: (seqN += 1), time: Date.now(), data });

const stateRoute = routes.find((r) => String(r.path).endsWith('/state'));
async function readState() {
  return await new Promise((resolve, reject) => {
    const req = {
      method: 'GET',
      url: stateRoute.path.split('?')[0],
      headers: { host: '127.0.0.1:64182' },
      socket: { remoteAddress: '127.0.0.1' },
    };
    const res = {
      statusCode: 0,
      _body: '',
      setHeader() {},
      end(chunk) {
        this._body += chunk || '';
        try { resolve(JSON.parse(this._body)); } catch (e) { reject(e); }
      },
      writeHead(code) { this.statusCode = code; },
    };
    try { stateRoute.handler(req, res); } catch (e) { reject(e); }
  });
}

const sleep = (ms) => new Promise((r) => realSetTimeout(r, ms));
const out = [];
const check = (name, ok, extra) => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== undefined ? '  — ' + extra : ''}`);
};

const mainSession = { id: 'main-1', header: { id: 'main-1' } };
const subSession = { id: 'sub-1', header: { id: 'sub-1', origin: 'subagent' } };

emit('session/event', mainSession, ev('turn/start', {}));

// ---- 场景 A：真实路径 subagent/start → turn/start → assistant → turn/end ----
emit('subagent/start', { runId: 'r1', id: 'sub-1', provider: 'openai', local: false, model: 'gpt-5' });
let st = await readState();
let seatOf = (sid) => {
  const arr = st.snapshot.subs || [];
  for (let i = 0; i < arr.length; i += 1) if (arr[i] && arr[i].sessionId === sid) return 'sub:' + i;
  return null;
};
check('A1 副鱼已占位', seatOf('sub-1') === 'sub:0', seatOf('sub-1'));

emit('session/event', subSession, ev('turn/start', {}));
emit('session/event', subSession, ev('assistant/message', {
  message: { content: [{ type: 'text', text: '我查了三个来源，分别是官方文档、GitHub issue 和源码。' }] },
}));
st = await readState();
const s0 = () => st.snapshot.subs[0];
check('A2 副鱼 headline', !!s0() && !!s0().bubble.headline, s0() && JSON.stringify(s0().bubble.headline));
check('A3 副鱼全文 text 未被截到 5 字', !!s0() && s0().bubble.text.length > 5, s0() && s0().bubble.text.length);

const before = scheduled.length;
emit('session/event', subSession, ev('turn/end', { reason: 'completed' }));
st = await readState();
check('A4 turn/end 当刻仍在座', !!s0(), s0() && s0().activity);
check('A5 turn/end 注册的 5s+ 定时器', true, JSON.stringify(scheduled.slice(before)));

await sleep(200);
st = await readState();
check('A6 6s 后副鱼座位被清空（=消失）', seatOf('sub-1') === null, JSON.stringify(st.snapshot.subs.map((s) => (s ? s.seatId : null))));

// ---- 场景 B：清场后同一子会话再开一轮 → 换座 ----
emit('session/event', subSession, ev('turn/start', {}));
st = await readState();
check('B1 同一子会话重新出现（可能换座）', seatOf('sub-1') !== null, seatOf('sub-1'));

// ---- 场景 C：只走 subagent/end，不注册清场 ----
emit('subagent/end', { runId: 'r1', id: 'sub-1', stopReason: 'completed' });
await sleep(200);
st = await readState();
check('C1 仅 subagent/end 不会清场', seatOf('sub-1') !== null, seatOf('sub-1'));

// ---- 场景 D：12 席占满后再来新 agent ----
const seatIdsBefore = st.snapshot.subs.map((s) => (s ? s.sessionId : null));
for (let i = 2; i <= 13; i += 1) {
  emit('subagent/start', { runId: 'r' + i, id: 'sub-' + i, provider: 'openai', model: 'gpt-5' });
}
st = await readState();
const occupied = st.snapshot.subs.map((s, i) => (s ? i + ':' + s.sessionId : i + ':null'));
check('D1 12 席是否全占', st.snapshot.subs.filter(Boolean).length === 12, occupied.join(' '));
check('D2 sub-13 是否覆盖了 sub-11 的旧人', st.snapshot.subs[11] && st.snapshot.subs[11].sessionId === 'sub-13', st.snapshot.subs[11] && st.snapshot.subs[11].sessionId);
check('D3 被覆盖的旧 sub-12 是否还在', st.snapshot.subs.some((s) => s && s.sessionId === 'sub-12'), '');

console.log(out.join('\n'));
console.log('\n5s+ 定时器时长集合:', JSON.stringify(Array.from(new Set(scheduled)).sort((a, b) => a - b)));
global.setTimeout = realSetTimeout;
