// 只读诊断脚本 2：验证 12 席占满后的「串座」与 sessionSeat 坏映射。
const realSetTimeout = global.setTimeout;
global.setTimeout = function patched(fn, ms, ...rest) {
  if (typeof ms === 'number' && ms >= 5000) return realSetTimeout(fn, 60, ...rest);
  return realSetTimeout(fn, ms, ...rest);
};

const { apply } = await import('../packages/dsh-pixel-office/lib/index.js');
const handlers = new Map();
const routes = [];
apply({
  on(n, f) { if (!handlers.has(n)) handlers.set(n, []); handlers.get(n).push(f); },
  effect(f) { f(); },
  webServer: { register(r) { routes.push(r); } },
  fs: { readText: async () => '' },
  logger: { warn() {} },
  get() { return undefined; },
});
const emit = (n, ...a) => (handlers.get(n) || []).forEach((f) => f(...a));
let seq = 0;
const ev = (type, data) => ({ type, seq: (seq += 1), time: Date.now(), data });
const route = routes.find((r) => String(r.path).endsWith('/state'));
const readState = () => new Promise((resolve) => {
  const req = { method: 'GET', url: route.path.split('?')[0], headers: { host: '127.0.0.1:1' }, socket: { remoteAddress: '127.0.0.1' } };
  const res = { setHeader() {}, end(c) { resolve(JSON.parse(c)); }, writeHead() {} };
  route.handler(req, res);
});
const sleep = (ms) => new Promise((r) => realSetTimeout(r, ms));
const out = [];
const check = (n, ok, extra) => out.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra !== undefined ? '  — ' + extra : ''}`);

const mainS = { id: 'main-1', header: { id: 'main-1' } };
emit('session/event', mainS, ev('turn/start', {}));

// 占满 12 席：sub-1 .. sub-12
for (let i = 1; i <= 12; i += 1) {
  emit('subagent/start', { runId: 'r' + i, id: 'sub-' + i, model: 'gpt-5' });
}
let st = await readState();
check('E1 12 席全占', st.snapshot.subs.filter(Boolean).length === 12, st.snapshot.subs.map((s) => (s ? s.sessionId : '空')).join(','));

// 第 13 个
emit('subagent/start', { runId: 'r13', id: 'sub-13', model: 'gpt-5' });
st = await readState();
check('E2 sub-12 被挤下座', !st.snapshot.subs.some((s) => s && s.sessionId === 'sub-12'), st.snapshot.subs.map((s) => (s ? s.sessionId : '空')).join(','));

// 关键：被挤掉的 sub-12 再发一条事件，会不会写到 sub:11（现在属于 sub-13）？
const sub12 = { id: 'sub-12', header: { id: 'sub-12', origin: 'subagent' } };
const sub13 = { id: 'sub-13', header: { id: 'sub-13', origin: 'subagent' } };
emit('session/event', sub12, ev('assistant/message', { message: { content: [{ type: 'text', text: '我是被挤掉的 sub-12，这条不该出现在 sub-13 的气泡里。' }] } }));
st = await readState();
const s11 = st.snapshot.subs[11];
check('E3 串座：sub-12 的事件写进了 sub:11', !!s11 && s11.sessionId === 'sub-13' && s11.bubble.text.indexOf('sub-12') >= 0,
  s11 && (s11.sessionId + ' | ' + s11.bubble.text));

// 再来一个 sub-14，看 sub-13 又被挤掉，但 sessionSeat 里 sub-13 还指着 sub:11
emit('subagent/start', { runId: 'r14', id: 'sub-14', model: 'gpt-5' });
st = await readState();
check('E4 sub:11 又换成 sub-14', st.snapshot.subs[11] && st.snapshot.subs[11].sessionId === 'sub-14', st.snapshot.subs[11] && st.snapshot.subs[11].sessionId);
emit('session/event', sub13, ev('assistant/message', { message: { content: [{ type: 'text', text: '我是 sub-13，现在也会写到 sub-14 的座位上。' }] } }));
st = await readState();
check('E5 sub-13 也串座到 sub:11', st.snapshot.subs[11] && st.snapshot.subs[11].bubble.text.indexOf('sub-13') >= 0, st.snapshot.subs[11] && st.snapshot.subs[11].bubble.text);

// turn/end 清场后，被清的人是否还残留在 sessionSeat（会不会复活到别人座位上）
const sub1 = { id: 'sub-1', header: { id: 'sub-1', origin: 'subagent' } };
emit('session/event', sub1, ev('turn/end', { reason: 'completed' }));
await sleep(150);
st = await readState();
check('E6 sub-1 已被 6s 清场', !st.snapshot.subs.some((s) => s && s.sessionId === 'sub-1'), st.snapshot.subs.map((s) => (s ? s.sessionId : '空')).join(','));
emit('session/event', sub1, ev('assistant/message', { message: { content: [{ type: 'text', text: '我回来了' }] } }));
st = await readState();
const back = st.snapshot.subs.findIndex((s) => s && s.sessionId === 'sub-1');
check('E7 清场后再来事件会重新占空席', back >= 0, 'sub:' + back);

console.log(out.join('\n'));
global.setTimeout = realSetTimeout;
