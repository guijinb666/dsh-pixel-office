/**
 * smoke-test.mjs — 在装机之前先把 host 半跑起来验证。
 *
 * 用一个假的 ctx 提供 webServer.register / ctx.on / ctx.effect，
 * 然后直接调各个 route handler，检查：
 *   1. 路由是否都注册上；
 *   2. /seats 是否返回合法 JSON；
 *   3. /pixel-office/** 能否正确发资产、是否挡住路径逃逸；
 *   4. /state 在灌入事件后快照是否正确；
 *   5. /file 对文本与图片的响应形状是否正确。
 */
import { EventEmitter } from 'node:events'

const mod = await import('../packages/dsh-pixel-office/lib/index.js')

const registered = []
const emitter = new EventEmitter()

/** 假 ctx。 */
const ctx = {
  logger: { warn: () => {}, info: () => {} },
  on: (name, fn) => emitter.on(name, fn),
  effect: (fn) => {
    const dispose = fn()
    return () => dispose?.()
  },
  webServer: {
    register: (route) => {
      registered.push(route)
      return () => {
        const i = registered.indexOf(route)
        if (i >= 0) registered.splice(i, 1)
      }
    },
  },
}

/** 假 req。 */
function makeReq(url, method = 'GET') {
  return {
    url,
    method,
    socket: { remoteAddress: '127.0.0.1' },
  }
}

/** 假 res：收集写出的内容。 */
function makeRes() {
  const out = { status: 0, headers: null, body: null, finished: false }
  return {
    out,
    writeHead(status, headers) {
      out.status = status
      out.headers = headers
    },
    end(chunk) {
      out.body = chunk
      out.finished = true
    },
  }
}

/** 找到匹配的 route：exact 优先，其次 prefix。 */
function findRoute(pathname) {
  const exact = registered.find(
    (r) => r.kind === 'exact' && (r.path === pathname || pathname.startsWith(r.path + '?')),
  )
  if (exact) return exact
  return registered.find((r) => r.kind === 'prefix' && pathname.startsWith(r.path))
}

/** 调一个 route。 */
async function call(pathAndQuery) {
  const pathname = pathAndQuery.split('?')[0]
  const route = findRoute(pathname)
  if (!route) throw new Error('no route for ' + pathAndQuery)
  const res = makeRes()
  await route.handler(makeReq(pathAndQuery), res)
  if (!res.out.finished) throw new Error('handler never ended response for ' + pathAndQuery)
  return res.out
}

let failures = 0
function check(name, ok, detail) {
  if (ok) {
    console.log('  PASS  ' + name)
  } else {
    failures += 1
    console.log('  FAIL  ' + name + (detail ? ' — ' + detail : ''))
  }
}

// ---------------------------------------------------------------------------
console.log('\n[1] 装载插件')
mod.apply(ctx)
check('apply 不抛异常', true)
check('注册了 6 条路由', registered.length === 6, '实际 ' + registered.length)
{
  const paths = registered.map((r) => r.kind + ' ' + r.path)
  const want = [
    'exact /api/pixel-office/state',
    'exact /api/pixel-office/seats',
    'prefix /pixel-office',
    'exact /api/pixel-office/file',
    'exact /api/pixel-office/file-bytes',
    'exact /api/pixel-office/diag',
  ]
  const missing = want.filter((w) => paths.indexOf(w) < 0)
  check('6 条路由路径正确', missing.length === 0, '缺 ' + missing.join(' / '))
}
console.log('       routes: ' + registered.map((r) => r.kind + ' ' + r.path).join(', '))

// ---------------------------------------------------------------------------
console.log('\n[2] /api/pixel-office/seats')
{
  const r = await call('/api/pixel-office/seats')
  check('200', r.status === 200, 'status=' + r.status)
  const doc = JSON.parse(r.body)
  check('scene 尺寸 = 320x431', doc.scene.w === 320 && doc.scene.h === 431, JSON.stringify(doc.scene))
  check('12 个副工位', doc.subs.length === 12, 'subs=' + doc.subs.length)
  check('主工位 seated 存在', !!doc.main.seated, JSON.stringify(doc.main.seated))
  check('门存在', !!doc.door, JSON.stringify(doc.door))
  check('钟坐标存在', !!doc.clock && doc.clock.cx > 0, JSON.stringify(doc.clock))
  check('两盏吊灯', Array.isArray(doc.lamps) && doc.lamps.length === 2, JSON.stringify(doc.lamps))
}

// ---------------------------------------------------------------------------
console.log('\n[3] /pixel-office/** 资产')
{
  const r = await call('/pixel-office/scene/office-dark-320.png')
  check('底图 200', r.status === 200, 'status=' + r.status)
  check('content-type=image/png', r.headers['content-type'] === 'image/png', r.headers['content-type'])
  check('体积 = 24186', r.body.length === 24186, 'len=' + r.body.length)

  const r2 = await call('/pixel-office/char/main/final/main-sit-1.png')
  check('主鱼帧 200', r2.status === 200, 'status=' + r2.status)

  const r3 = await call('/pixel-office/char/subs/final/m1-cat.png')
  check('副鱼帧 200', r3.status === 200, 'status=' + r3.status)

  const r4 = await call('/pixel-office/../package.json')
  check('路径逃逸被挡（403/404）', r4.status === 403 || r4.status === 404, 'status=' + r4.status)

  const r5 = await call('/pixel-office/char/main/final/main-sit-1@6x.png')
  check('不存在的文件 404', r5.status === 404, 'status=' + r5.status)
}

// ---------------------------------------------------------------------------
console.log('\n[4] /api/pixel-office/state + 事件聚合')
{
  // 先清一遍
  const r0 = await call('/api/pixel-office/state')
  const s0 = JSON.parse(r0.body).snapshot
  check('初始快照 main=null', s0.main === null, JSON.stringify(s0.main))
  check('初始 12 席全空', s0.subs.every((x) => x === null), JSON.stringify(s0.subs.length))

  // 主会话开跑
  const rootSession = { id: 'sess-root', header: { origin: 'root' } }
  emitter.emit('session/event', rootSession, { type: 'turn/start', turn: 1 })
  emitter.emit('session/event', rootSession, {
    type: 'assistant/message',
    message: {
      content: [{ type: 'text', text: '好的，我先看一下目录结构。' }],
      source: { provider: 'deepseek', model: 'deepseek-chat' },
    },
  })
  emitter.emit('session/event', rootSession, {
    type: 'tool/call',
    name: 'write',
    arguments: { file_path: 'C:\\tmp\\report.md' },
  })

  let r1 = await call('/api/pixel-office/state')
  let s1 = JSON.parse(r1.body).snapshot
  check('主工位有人在座', s1.main !== null && s1.main.agentId === 'main', JSON.stringify(s1.main && s1.main.agentId))
  check('主工位状态=working', s1.main.activity === 'working', s1.main.activity)
  check('气泡有文本', s1.main.bubble.text.indexOf('目录结构') >= 0, s1.main.bubble.text)
  check('气泡记下模型', s1.main.model === 'deepseek-chat', s1.main.model)
  check('气泡记下交付文件', s1.main.files.length === 1 && s1.main.files[0].name === 'report.md', JSON.stringify(s1.main.files))

  // 子 agent 上工
  const subA = { id: 'sess-sub-a', header: { origin: 'subagent' } }
  emitter.emit('subagent/start', null, {
    sessionId: 'sess-sub-a',
    label: '调研',
    request: { agentOptions: { model: 'claude-sonnet-4', provider: 'anthropic' } },
  })
  emitter.emit('session/event', subA, { type: 'turn/start', turn: 1 })
  emitter.emit('session/event', subA, {
    type: 'assistant/message',
    message: {
      content: [{ type: 'text', text: '我查了三个来源。' }],
      source: { provider: 'anthropic', model: 'claude-sonnet-4' },
    },
  })

  let r2 = await call('/api/pixel-office/state')
  let s2 = JSON.parse(r2.body).snapshot
  const occupied = s2.subs.filter(Boolean)
  check('1 个副工位有人', occupied.length === 1, 'occupied=' + occupied.length)
  check('副工位在 sub:0', occupied[0] && occupied[0].seatId === 'sub:0', occupied[0] && occupied[0].seatId)
  check('副工位气泡有文本', occupied[0] && occupied[0].bubble.text.indexOf('三个来源') >= 0, occupied[0] && occupied[0].bubble.text)
  check('副工位记下 model', occupied[0] && occupied[0].model === 'claude-sonnet-4', occupied[0] && occupied[0].model)

  // 第二个子 agent：应当分到 sub:1
  const subB = { id: 'sess-sub-b', header: { origin: 'subagent' } }
  emitter.emit('subagent/start', null, {
    sessionId: 'sess-sub-b',
    label: '写测试',
    request: { agentOptions: { model: 'gpt-5', provider: 'openai' } },
  })
  let r3 = await call('/api/pixel-office/state')
  let s3 = JSON.parse(r3.body).snapshot
  check('2 个副工位有人', s3.subs.filter(Boolean).length === 2, 'occupied=' + s3.subs.filter(Boolean).length)
  check('第二个在 sub:1', s3.subs[1] && s3.subs[1].seatId === 'sub:1', s3.subs[1] && s3.subs[1].seatId)

  // 子 agent 收工
  emitter.emit('session/event', subB, { type: 'turn/end', reason: 'completed' })
  let r4 = await call('/api/pixel-office/state')
  let s4 = JSON.parse(r4.body).snapshot
  check('sub:1 状态=done', s4.subs[1] && s4.subs[1].activity === 'done', s4.subs[1] && s4.subs[1].activity)

  // 主工位收工
  emitter.emit('session/event', rootSession, { type: 'turn/end', reason: 'completed' })
  let r5 = await call('/api/pixel-office/state')
  let s5 = JSON.parse(r5.body).snapshot
  check('主工位状态=done', s5.main.activity === 'done', s5.main.activity)

  // 收工后气泡换成固定提示，不再挂着整段汇报（否则几千字滚起来看不清）
  const doneText = s5.main.bubble && s5.main.bubble.text
  check('收工气泡=固定提示', doneText === '本轮已完成，请在会话框查看汇报结果', JSON.stringify(doneText))
  check('收工气泡=短句不滚动', typeof doneText === 'string' && doneText.length <= 20, 'len=' + (doneText || '').length)
  check('收工 headline 与正文一致', s5.main.bubble.headline === doneText, s5.main.bubble.headline)

  // 子工位同理
  check('副工位收工气泡=子任务完成',
    s4.subs[1] && s4.subs[1].bubble && s4.subs[1].bubble.text === '子任务完成',
    s4.subs[1] && s4.subs[1].bubble && s4.subs[1].bubble.text)

  // 新一轮 turn/start 要把旧提示清掉
  emitter.emit('session/event', rootSession, { type: 'turn/start', turn: 99 })
  let r5b = await call('/api/pixel-office/state')
  let s5b = JSON.parse(r5b.body).snapshot
  check('新一轮开始清空旧提示',
    s5b.main.bubble && s5b.main.bubble.text === '',
    JSON.stringify(s5b.main.bubble && s5b.main.bubble.text))
  check('新一轮开始 streaming=true',
    s5b.main.bubble && s5b.main.bubble.streaming === true,
    s5b.main.bubble && s5b.main.bubble.streaming)

  // seq 单调递增
  check('seq 递增', s5.seq > s0.seq, s0.seq + ' → ' + s5.seq)

  // 切会话清场
  let r6 = await call('/api/pixel-office/state?current=sess-other')
  let s6 = JSON.parse(r6.body).snapshot
  check('切会话后清场', s6.main === null && s6.subs.every((x) => x === null), JSON.stringify(s6.main))
}

// ---------------------------------------------------------------------------
console.log('\n[4b] 真实信封形状（payload 在 event.data 里）')
{
  // DSH 的 SessionEvent 是 `{ type, seq, time, data }`，正文/工具/结束原因全在
  // data 内。上面 [4] 用的是扁平老形状，只覆盖到兼容分支；这里按官方信封再发
  // 一遍，覆盖真正的主路径 —— 曾经这些字段全按顶层读，于是气泡永久空白。
  const now = Date.now()
  const envSession = { id: 'sess-env', header: { origin: 'root' } }
  emitter.emit('session/event', envSession, {
    type: 'turn/start',
    seq: 1,
    time: now,
    data: { turn: 1 },
  })
  emitter.emit('session/event', envSession, {
    type: 'assistant/message',
    seq: 2,
    time: now,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '信封路径的正文也要显示出来。' }],
        source: { kind: 'model', provider: 'deepseek-account', model: 'deepseek-flash' },
      },
      stream: [],
    },
  })
  emitter.emit('session/event', envSession, {
    type: 'tool/call',
    seq: 3,
    time: now,
    data: { turn: 1, step: 1, callId: 'c1', name: 'write', arguments: '{"file_path":"C:\\\\tmp\\\\env.md"}' },
  })

  const re1 = await call('/api/pixel-office/state')
  const se1 = JSON.parse(re1.body).snapshot
  check('信封：主工位在座', se1.main !== null, JSON.stringify(se1.main))
  check(
    '信封：气泡取到 data.message 正文',
    !!se1.main && se1.main.bubble.text.indexOf('信封路径') >= 0,
    se1.main && se1.main.bubble.text,
  )
  check(
    '信封：模型取到 data.message.source',
    !!se1.main && se1.main.model === 'deepseek-flash',
    se1.main && se1.main.model,
  )
  check(
    '信封：arguments 是 JSON 字符串也能解析出交付文件',
    !!se1.main && se1.main.files.length === 1 && se1.main.files[0].name === 'env.md',
    se1.main && JSON.stringify(se1.main.files),
  )

  emitter.emit('session/event', envSession, {
    type: 'turn/end',
    seq: 4,
    time: now,
    data: { turn: 1, reason: { kind: 'completed' } },
  })
  const re2 = await call('/api/pixel-office/state')
  const se2 = JSON.parse(re2.body).snapshot
  check(
    '信封：turn/end 的 reason 对象解成 completed',
    !!se2.main && se2.main.activity === 'done',
    se2.main && se2.main.activity,
  )
}

// ---------------------------------------------------------------------------
console.log('\n[5] /api/pixel-office/file')
{
  const r1 = await call('/api/pixel-office/file?path=' + encodeURIComponent('C:\\Users\\30612\\Desktop\\像素工作台\\packages\\dsh-pixel-office\\package.json'))
  const d1 = JSON.parse(r1.body)
  check('文本文件 ok', d1.ok === true && d1.kind === 'text', JSON.stringify({ ok: d1.ok, kind: d1.kind }))
  check('文本含包名', typeof d1.text === 'string' && d1.text.indexOf('dsh-pixel-office') >= 0, (d1.text || '').slice(0, 40))

  const r2 = await call('/api/pixel-office/file?path=' + encodeURIComponent('C:\\Users\\30612\\Desktop\\像素工作台\\assets\\scene\\office-dark-320.png'))
  const d2 = JSON.parse(r2.body)
  check('图片 ok + 给 url', d2.ok === true && d2.kind === 'image' && typeof d2.url === 'string', JSON.stringify({ ok: d2.ok, kind: d2.kind }))

  const r3 = await call(d2.url.replace('/api/pixel-office', '/api/pixel-office'))
  check('图片字节可下载', r3.status === 200 && r3.headers['content-type'] === 'image/png', 'status=' + r3.status)

  const r4 = await call('/api/pixel-office/file?path=' + encodeURIComponent('C:\\definitely\\not\\here.txt'))
  const d4 = JSON.parse(r4.body)
  check('不存在的文件 ok=false', d4.ok === false, JSON.stringify(d4))
}

// ---------------------------------------------------------------------------
console.log('\n[6] 非 loopback 拒绝')
{
  const route = findRoute('/api/pixel-office/state')
  const res = makeRes()
  await route.handler({ url: '/api/pixel-office/state', method: 'GET', socket: { remoteAddress: '10.0.0.5' } }, res)
  check('外网地址 403', res.out.status === 403, 'status=' + res.out.status)
}

// ---------------------------------------------------------------------------
console.log('\n[7] /api/pixel-office/diag 自诊断槽')
{
  // 干净起点：还没有人上报过
  const r0 = await call('/api/pixel-office/diag')
  const d0 = JSON.parse(r0.body)
  check('未上报时 GET 返回 diag=null', r0.status === 200 && d0.ok === true && d0.diag === null, JSON.stringify(d0))

  // POST 一份诊断体（模拟 client.js 的 reportDiag）
  const payload = JSON.stringify({ rev: 'rtest', tag: 'boot', panel: { barRect: { x: 1, y: 2, w: 3, h: 4 }, hitChain: ['bar[z=auto,pe=auto]'] } })
  const postRoute = findRoute('/api/pixel-office/diag')
  const pres = makeRes()
  const preq = {
    url: '/api/pixel-office/diag',
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    on(event, fn) {
      if (event === 'data') fn(Buffer.from(payload))
      else if (event === 'end') fn()
      return undefined
    },
  }
  await postRoute.handler(preq, pres)
  check('POST 上报返回 ok', pres.out.status === 200 && JSON.parse(pres.out.body).ok === true, 'status=' + pres.out.status)

  const r1 = await call('/api/pixel-office/diag')
  const d1 = JSON.parse(r1.body)
  check('GET 读回最近一次上报', !!(d1.diag && d1.diag.body), JSON.stringify(d1.diag && d1.diag.at))
  check('上报内容原样保存', !!(d1.diag && d1.diag.body && d1.diag.body.rev === 'rtest'), JSON.stringify(d1.diag && d1.diag.body))
  check('上报记下来源地址', !!(d1.diag && typeof d1.diag.from === 'string' && d1.diag.from.length > 0), d1.diag && d1.diag.from)

  // 非 loopback 必须拒绝
  const dres = makeRes()
  await postRoute.handler({ url: '/api/pixel-office/diag', method: 'POST', socket: { remoteAddress: '10.0.0.5' }, on: () => undefined }, dres)
  check('非 loopback 上报 403', dres.out.status === 403, 'status=' + dres.out.status)
}

// ---------------------------------------------------------------------------
console.log('\n结果: ' + (failures === 0 ? '全部通过' : failures + ' 项失败'))
process.exit(failures === 0 ? 0 : 1)
