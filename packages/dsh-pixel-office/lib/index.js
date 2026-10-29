/**
 * dsh-pixel-office host 半。
 *
 * 职责只有两件：
 *   1. 订阅 Host 侧事件（session/event、subagent/*、agent/status），聚合成一份
 *      "当前办公室里谁坐在哪儿、头顶气泡说什么、交付了什么文件"的快照。
 *   2. 开同源 HTTP 端点把快照喂给 client 半；开 prefix 路由把像素资产发出去；
 *      再开一个文件读取端点，供气泡里点击交付文件时预览。
 *
 * 为什么是轮询而不是推送：本机实测 client 侧只有 4 个全局事件
 * （connection/reset、locale/change、slots/changed、theme/change），拿不到 agent 运行态。
 * dsh-pet 走的就是"host 侧订阅 + 自己开 /api 端点 + 前端拉"这条路，这里照同一套。
 *
 * 座位模型：
 *   - seatId 是稳定坐标（'main' / 'sub:0'…'sub:11'），底图里已经画好了这些桌子。
 *   - agentId 是临时身份，前端靠它变化判断"换人了"，从而触发入场走路动画。
 *   - 主工位由父会话驱动；副工位由 origin==='subagent' 的会话驱动。
 *
 * @module dsh-pixel-office
 */

import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, extname, join, normalize, sep } from 'node:path'

/** Stable cordis plugin name（与 cordis.patch.yml 的 insert id 对应）。 */
export const name = 'pixel-office'

/** 只需要 webServer：其余数据源都通过 ctx.on 订阅，不额外 require 服务。 */
export const inject = ['webServer']

/** 浏览器侧的 API 前缀。 */
export const API_PREFIX = '/api/pixel-office'

/** 像素资产的前缀路由。 */
export const ASSET_PREFIX = '/pixel-office'

/** 包根目录：lib/ 的上一级。 */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 资产目录。 */
const ASSET_ROOT = join(PACKAGE_ROOT, 'assets')

/** 单个资产文件的体积上限。 */
const ASSET_MAX_BYTES = 24 * 1024 * 1024

/** 预览端点单文件上限。 */
const PREVIEW_MAX_BYTES = 2 * 1024 * 1024

/** 气泡原始文本的长度上限。气泡现在是 10 字窗口横向滚动展示全文，所以这里留足余量。 */
const BUBBLE_RAW_MAX_CHARS = 4000

/** 主鱼气泡同时可见的字数；超过这个字数就在气泡里横向滚动。 */
const BUBBLE_MAIN_WINDOW = 10

/**
 * headline 抽取时的「句子长度上限」——和上面的可视窗口是两件事。
 *
 * 气泡 10/5 字是窗口宽度，只决定同时看到几个字，长出来的会在窗口里循环滚动；
 * 而 headlineFor 的 max 参数是"这一句总共多长"。之前把窗口宽度直接传进去
 * （副鱼 5），于是 isCleanClause 把所有 ≥6 字的中文分句全判掉，副鱼气泡长期
 * 只剩「在忙」「交付」这类两字标签。这里把两者分开：窗口窄，但抽句子时给足长度。
 */
const BUBBLE_SUB_HEADLINE_CHARS = 14

/**
 * 一轮结束时的固定气泡文案。
 *
 * 用户反馈：输出几千字时 10 字窗口横向滚动的速度必然快得看不清。
 * 所以一轮结束后不再滚汇报全文，只留一句提示，正文去会话框看。
 */
const BUBBLE_DONE_MAIN = '本轮已完成，请在会话框查看汇报结果'
const BUBBLE_DONE_SUB = '子任务完成'
const BUBBLE_DONE_ERROR = '本轮出错，请在会话框查看'

/** 副工位数量（底图里画了 12 个）。 */
const SUB_SEAT_COUNT = 12

/**
 * 闲置多久之后趴下睡（规划 §P11「闲置睡姿」）。
 *
 * 语义是「坐着但长时间没活」：一轮结束状态先落到 `done`（正常坐姿），
 * 静置这么久没有新事件才切 `asleep`（蜷缩睡帧）。任何新事件都会把它叫醒。
 *
 * 主鱼也取 10s（用户 m04641：「主鱼也是10秒切睡姿」）——
 * 与副鱼同一口径，睡姿资产也是同一套姿势生成的，视觉上主副一致。
 */
const ASLEEP_AFTER_MS = 10 * 1000

/**
 * 副鱼的入睡时限（用户 m03755：「结束后等待10秒切换睡姿」）。
 *
 * 副鱼的生命周期短、事件密集，10s 没动静就是真的干完了 ——
 * 而且用户就是要在"等着我下一步"的空档里看到它们睡着。
 * 与主鱼现在同值，保留两个常量是因为两者将来可能再分叉。
 */
const ASLEEP_AFTER_MS_SUB = 10 * 1000

/**
 * 浏览器端自诊断的上报槽。
 *
 * 真实 GUI 的 `/plugins/??<id>/client.js` 需要浏览器鉴权，从外部 fetch 拿不到，
 * 所以无法直接判断「改过的 client.js 到底有没有进浏览器」。让 client 每次启动
 * 往这里报一行握手信息（REV、面板 z-index、监听是否装上、最小化后的 display 等），
 * 用 GET /api/pixel-office/diag 读回来，就能在不动浏览器的情况下定位现场。
 */
const diagSlot = {
  at: 0,
  from: '',
  body: null,
}

/** 上报体上限，防止误报把内存撑爆。 */
const DIAG_MAX_BYTES = 64 * 1024

/** 每个座位最多记住几个交付文件。 */
const FILES_PER_SEAT = 6

const CONTENT_TYPES = {
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
}

/** 预览端点认定可当图片直接显示的扩展名。 */
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'])

// ---------------------------------------------------------------------------
// HTTP 小工具
// ---------------------------------------------------------------------------

/** 只允许 loopback 访问。 */
function isLoopback(req) {
  const addr = req.socket?.remoteAddress ?? ''
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

/** 写 JSON 响应。 */
function writeJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

/** 取查询参数。 */
function query(req, key) {
  try {
    return new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get(key)
  } catch {
    return null
  }
}

/**
 * 把一个相对路径解析到 base 之下，并拒绝越界。
 * 用 normalize + 前缀比对，不依赖 realpath（资产都是包内自带的普通文件）。
 */
function resolveInside(base, rel) {
  const abs = normalize(join(base, rel))
  const guard = base.endsWith(sep) ? base : base + sep
  if (abs !== base && !abs.startsWith(guard)) return null
  return abs
}

// ---------------------------------------------------------------------------
// 文本 / 文件提取
// ---------------------------------------------------------------------------

/** 压成单行安全文本。 */
function sanitizeText(input, max) {
  if (typeof input !== 'string') return ''
  const flat = input
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // 省略号本身也算一个字符，否则截完会变成 max+1 个，越过调用方给的上限。
  if (flat.length <= max) return flat
  return max <= 0 ? '' : flat.slice(0, max - 1) + '…'
}

// 气泡只显示"这一句在干什么"的关键内容，长度硬上限 10 个字，且必须说得通顺。
const BUBBLE_MAX_CHARS = 10

// 动词 → 现成的短口语。命中最具体的优先，保证结果永远是完整的说法、不硬截。
const ACTION_LABELS = [
  [/安装|装上|装机|enable/, '装机中'],
  [/生成|生图|出图|画一/, '在生图'],
  [/验证|校验|测试|冒烟|跑通/, '验结果'],
  [/修复|修好|改掉|纠正|修一/, '改代码'],
  [/量测|测量|标定|对齐/, '量尺寸'],
  [/合成|拼图|拼帧|拼一张/, '合帧'],
  [/编译|构建|打包|tsc/, '编个包'],
  [/落盘|写入|保存|存档|写到/, '写文件'],
  [/读取|打开|看一下|读一下/, '看文件'],
  [/搜索|查询|找一下|搜一下/, '查资料'],
  [/接力|召唤|派工|下发|派出/, '派活'],
  [/收尾|暂停|停下|结束这块/, '收尾'],
  [/整理|归档|清理|归置/, '整文件'],
  [/检查|排查|核对|审一遍/, '查细节'],
  [/设计|规划|想方案|拆解/, '想方案'],
  [/分析|比对|过一遍|复盘/, '过一遍'],
  [/上传|下载|传输/, '传文件'],
  [/部署|上线|发布/, '上线'],
  [/失败|报错|出错|挂了/, '出错了'],
  [/等待|等一|稍等|卡住/, '等回报'],
  [/交付|完成|做完|搞定|好了/, '做完了'],
  [/运行|跑一遍|执行/, '跑一遍'],
  [/更新|刷新/, '刷新'],
  [/创建|新建|建一个/, '新建'],
]

/** 去掉 markdown 记号与列表前缀，留下一句人话。 */
function stripMarkup(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}[-*+>]\s+/gm, '')
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')
}

// 句尾不能悬空的虚词，剪到这里要往前退。
const DANGLING_TAIL = /[的了着过把将被让给对为在从和与跟向至到是有没不也都就还又再才只更很最已正将想要会能可]$/

// 分句不能以副词开头（"已/正/将/也/都"这类读起来是半句）。
// 注意：不能把"把/被/给/对/让"列为禁头——"把X重写"本身是完整的祈使句。
const BAD_HEAD = /^(已|正|将|也|都|就|还|又|再|才|只|更|很|最|想|要|会|能|可|并|且|却|仍|曾|刚|偏)/

/** 这一小句是不是一个能独立成立的完整说法。 */
function isCleanClause(c, limit) {
  if (typeof c !== 'string') return false
  const s = c.trim()
  if (s.length < 2 || s.length > limit) return false
  if (BAD_HEAD.test(s)) return false
  if (DANGLING_TAIL.test(s)) return false
  return true
}

/** 纯英文句子：整句放得下才用，放不下就退到空格取完整单词，绝不留半个词。 */
function headlineAscii(flat, limit) {
  const first = flat.split(/[.!?;]+/)[0].trim()
  if (!first) return ''
  if (first.length <= limit) return first
  // 只取前 limit 个字符内能完整容纳的单词序列
  const words = first.split(/\s+/)
  let out = ''
  for (const w of words) {
    const next = out ? out + ' ' + w : w
    if (next.length > limit) break
    out = next
  }
  // 一个词都放不下（超长单词）就放弃，交给动作标签
  return out.length >= 3 ? out : ''
}

/**
 * 从一段输出里抽"关键内容"，硬性不超过 max 个字，且保证是完整通顺的说法。
 * 优先级：① 本来就够短的自然分句 → ② 动作短语标签 → ③ 剪到词边界的前缀。
 */
function headlineFor(input, max) {
  const limit = max || BUBBLE_MAX_CHARS
  if (typeof input !== 'string' || input.length === 0) return ''
  const flat = stripMarkup(input).replace(/\s+/g, ' ').trim()
  if (!flat) return ''

  // 纯英文/代码类输出：中文气泡里塞英文代码没有意义，直接给一个动作标签。
  const cjk = (flat.match(/[\u4e00-\u9fa5]/g) || []).length
  if (cjk === 0) {
    if (/error|failed|exception|Error/i.test(flat)) return '出错了'
    return headlineAscii(flat, limit) || '在忙'
  }

  // 切分句：只按自然标点（句号、逗号、分号、括号）切，绝不按介词切。
  // 按介词切会把词切断（"掉落交"、"在开始"这类半句都出现过），比不切更糟。
  const clauses = []
  for (const sentence of flat.split(/[。！？!?；;\n]+/)) {
    for (const piece of sentence.split(/[，,、：:（）()【】\[\]—]+/)) {
      let t = piece.trim().replace(/^[.\-…\s]+/, '').replace(/[.．\-…\s]+$/, '')
      t = t.replace(/^(那么|然后|所以|但是|不过|另外|此外|首先|其次|最后|其实|目前|现在|这里|我|我们|接下来|下面)[，,]?\s*/, '')
      t = t.replace(/^[的了着过把被给对让使从向往在和跟与用按靠以于为由到至]+/, '')
      if (t.length >= 2) clauses.push(t)
    }
  }
  if (clauses.length === 0) return ''

  // ① 已经有现成的、本来就 ≤10 字的完整分句：挑信息量最大的那句
  const FILLER = /^(好的?|好|嗯+|哦+|OK|ok|可以|行|对的?|是的?|收到|明白|了解|稍等|等等|那么|然后|所以|但是|不过|另外|此外|首先|其次|最后|其实|目前|现在|这里|我|我们|接下来|下面|开始|继续|以上|如下)$/
  let best = ''
  let bestScore = -Infinity
  for (let i = 0; i < clauses.length; i += 1) {
    const c = clauses[i]
    if (FILLER.test(c)) continue
    if (!isCleanClause(c, limit)) continue
    let score = 0
    if (ACTION_LABELS.some(([re]) => re.test(c))) score += 4
    if (/[\u4e00-\u9fa5]/.test(c)) score += 1
    if (c.length >= 3) score += 1
    if (c.length >= 4) score += 2
    if (c.length >= 6) score += 1
    if (/[0-9]/.test(c)) score += 1
    score -= i * 0.05
    if (score > bestScore) { bestScore = score; best = c }
  }
  if (best) return best

  // ② 所有分句都太长：用现成的动作短语。它永远是完整的一句话，且永远 ≤10 字，
  //    比硬剪安全得多。逐条按 ACTION_LABELS 的优先级（最具体的在前）匹配全文。
  for (const [re, label] of ACTION_LABELS) {
    if (re.test(flat)) return label
  }

  // ③ 实在没有动作词可归：用"在忙"，也是一个完整说法。
  return '在忙'
}

/** 从 assistant 消息里抽正文。 */
function textFromAssistantMessage(message) {
  const blocks = message?.content ?? []
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

/** 从消息里抽 provider / model。 */
function modelFromAssistantMessage(message) {
  const source = message?.source ?? {}
  return {
    provider: typeof source.provider === 'string' ? source.provider : '',
    model: typeof source.model === 'string' ? source.model : '',
  }
}

/**
 * 取会话事件的业务负载。
 *
 * DSH 的 `SessionEvent` 形状是 `{ type, seq, time, data }`：只有 `type` / `seq` /
 * `time` 在顶层，正文、工具名、结束原因全部装在 `data` 里（见 dsh-session 的
 * types.d.ts）。曾经这里直接读 `event.message` / `event.name` / `event.reason`，
 * 于是气泡、交付文件、模型名全部取到 undefined —— 办公室永远没有文字。
 * 这里统一剥一层，同时兼容将来可能直接投递 data 的调用方。
 */
function eventPayload(event) {
  if (!event || typeof event !== 'object') return {}
  const data = event.data
  return data && typeof data === 'object' ? data : event
}

/** 从 turn/end 的 reason 里取稳定字符串。`reason` 是对象（`{kind}`），不是裸字符串。 */
function turnEndKind(reason) {
  if (typeof reason === 'string') return reason
  if (reason && typeof reason === 'object' && typeof reason.kind === 'string') return reason.kind
  return 'completed'
}

/** 工具参数是模型产出的原始 JSON 字符串，这里安全解析成对象。 */
function parseToolArgs(raw) {
  if (!raw) return null
  if (typeof raw === 'object') return raw
  if (typeof raw !== 'string') return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** 从工具调用参数里挑出"这是产出文件"的路径。 */
function filesFromToolCall(toolName, args) {
  if (!args || typeof args !== 'object') return []
  const out = []
  const push = (p, kind) => {
    if (typeof p !== 'string' || p.length === 0) return
    const name = p.split(/[\\/]/).pop() || p
    out.push({ path: p, name, kind })
  }
  if (toolName === 'write' || toolName === 'edit') push(args.file_path, 'file')
  if (toolName === 'present' && Array.isArray(args.files)) {
    for (const f of args.files) {
      if (typeof f === 'string') push(f, 'file')
      else if (f && typeof f.path === 'string') push(f.path, 'file')
    }
  }
  if (toolName === 'univer_export' && typeof args.output === 'string') push(args.output, 'file')
  if (toolName === 'univer_print_pdf' && typeof args.output === 'string') push(args.output, 'file')
  if (toolName === 'univer_import' && typeof args.source === 'string') push(args.source, 'file')
  if (toolName === 'gen-pixel' || toolName === 'gen-pixel.mjs' || toolName === 'gen-batch') {
    push(args.out || args.o, 'image')
  }
  return out
}

// ---------------------------------------------------------------------------
// 状态聚合
// ---------------------------------------------------------------------------

/**
 * 把 Host 事件流折叠成一份可序列化的办公室快照。
 *
 * 动画不进 Host：这里只回答"谁在哪个座位、状态是什么"，
 * 帧率、插值、走路路径全部由前端自己算。
 */
class OfficeState {
  constructor() {
    /** 当前展示的会话 id。 */
    this.sessionId = null
    /** seatId -> seat。 */
    this.seats = new Map()
    /** sessionId -> seatId，用于把子会话事件路由到座位。 */
    this.sessionSeat = new Map()
    /** 快照版本号，前端用来丢弃乱序回包。 */
    this.seq = 0
    /** 没座位时的兜底计数，只为生成稳定 agentId。 */
    this.fallbackCursor = 0
  }

  /** 造一个空座位。 */
  static blank(seatId) {
    return {
      seatId,
      agentId: null,
      label: '',
      model: '',
      provider: '',
      activity: 'empty',
      bubble: { text: '', headline: '', streaming: false, updatedAt: 0 },
      files: [],
      progress: null,
      sessionId: null,
    }
  }

  /** 取主工位（一定存在）。 */
  mainSeat() {
    let seat = this.seats.get('main')
    if (!seat) {
      seat = OfficeState.blank('main')
      this.seats.set('main', seat)
    }
    return seat
  }

  /**
   * 把某个会话绑定到一个座位。
   * 主会话绑 'main'；子会话按 sessionId 找现成的，找不到就占第一个空席。
   */
  seatForSession(sessionId, { isSub, meta = {} }) {
    const key = String(sessionId ?? '')
    if (!isSub) {
      const seat = this.mainSeat()
      if (seat.agentId === null) {
        seat.agentId = 'main'
        seat.label = meta.label || 'DSH'
      }
      if (meta.model) seat.model = meta.model
      if (meta.provider) seat.provider = meta.provider
      if (key) {
        seat.sessionId = key
        this.sessionSeat.set(key, 'main')
      }
      return seat
    }

    const known = key ? this.sessionSeat.get(key) : null
    if (known) {
      const seat = this.seats.get(known)
      if (seat) {
        if (meta.model) seat.model = meta.model
        if (meta.provider) seat.provider = meta.provider
        if (meta.label) seat.label = meta.label
        return seat
      }
    }

    // 找一个空席
    let seatId = null
    for (let i = 0; i < SUB_SEAT_COUNT; i += 1) {
      const candidate = `sub:${i}`
      const seat = this.seats.get(candidate)
      if (!seat || seat.agentId === null) {
        seatId = candidate
        break
      }
    }
    if (seatId === null) {
      // 全满：淘汰「最久没动静」的那条（LRU），而不是无条件压 sub:11。
      // 优先淘汰已经收工的（done/idle/asleep/error），working 的排到最后，
      // 避免把正在干活的座位抢掉；12 条全在 working 时才按时间淘汰最旧的一条。
      // bubble.updatedAt 就是"最后一次有动静"的时间戳。
      let bestId = null
      let bestKey = Infinity
      for (let i = 0; i < SUB_SEAT_COUNT; i += 1) {
        const candidate = `sub:${i}`
        const seat = this.seats.get(candidate)
        const busy = seat && seat.activity === 'working'
        const stamp = (seat && seat.bubble && seat.bubble.updatedAt) || 0
        const key = (busy ? 1e13 : 0) + stamp
        if (key < bestKey) { bestKey = key; bestId = candidate }
      }
      seatId = bestId ?? `sub:${SUB_SEAT_COUNT - 1}`
      // 关键：淘汰时把旧会话的 sessionSeat 映射一起删掉。否则被挤掉的子会话
      // 后续事件会按旧映射写进新人的座位（实测复现：sub-12 的正文出现在 sub-13 的气泡里）。
      const evicted = this.seats.get(seatId)
      if (evicted && evicted.sessionId) this.sessionSeat.delete(String(evicted.sessionId))
    }

    this.fallbackCursor += 1
    const seat = OfficeState.blank(seatId)
    // agentId 用会话 id 更稳；没有会话 id 时给一个递增兜底
    seat.agentId = key || `sub-anon-${this.fallbackCursor}`
    seat.sessionId = key || null
    seat.label = meta.label || ''
    seat.model = meta.model || ''
    seat.provider = meta.provider || ''
    seat.activity = 'working'
    seat.bubble.streaming = true
    this.seats.set(seatId, seat)
    if (key) this.sessionSeat.set(key, seatId)
    return seat
  }

  /** 按 sessionId 找到座位。映射与实际占座者不一致时视为已离场（防串座）。 */
  seatBySession(sessionId) {
    const key = String(sessionId ?? '')
    const seatId = this.sessionSeat.get(key)
    if (!seatId) return null
    const seat = this.seats.get(seatId)
    if (!seat) { this.sessionSeat.delete(key); return null }
    if (seat.agentId !== null && seat.sessionId !== key) {
      // 座位已经被别人占了：这条旧映射作废，否则旧会话的事件会写到新人的气泡里
      this.sessionSeat.delete(key)
      return null
    }
    return seat
  }

  /** 清场。 */
  reset(sessionId) {
    this.sessionId = sessionId ?? null
    for (const seat of this.seats.values()) {
      Object.assign(seat, OfficeState.blank(seat.seatId))
    }
    this.sessionSeat.clear()
  }

  /** 输出快照。 */
  snapshot() {
    this.seq += 1
    const subs = []
    for (let i = 0; i < SUB_SEAT_COUNT; i += 1) {
      const seat = this.seats.get(`sub:${i}`)
      subs.push(seat && seat.agentId !== null ? clone(seat) : null)
    }
    const main = this.seats.get('main')
    return {
      seq: this.seq,
      sessionId: this.sessionId,
      main: main && main.agentId !== null ? clone(main) : null,
      subs,
    }
  }
}

/** 浅拷贝座位（bubble / files 要断开引用，避免快照被后续事件改写）。 */
function clone(seat) {
  return {
    seatId: seat.seatId,
    agentId: seat.agentId,
    label: seat.label,
    model: seat.model,
    provider: seat.provider,
    activity: seat.activity,
    bubble: { ...seat.bubble },
    files: seat.files.map((f) => ({ ...f })),
    progress: seat.progress ? { ...seat.progress } : null,
    sessionId: seat.sessionId,
  }
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

/**
 * 挂载 host 半。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
function applyImpl(ctx) {
  const state = new OfficeState()

  /** 判断一个 session 是不是子 agent 的。 */
  const isSubSession = (session) => {
    try {
      return session?.header?.origin === 'subagent'
    } catch {
      return false
    }
  }

  /** 从 session 上尽力取 id。 */
  const sessionIdOf = (session) => {
    try {
      return session?.id ?? session?.header?.id ?? null
    } catch {
      return null
    }
  }

  /** 往座位里追加交付文件，去重并限长。 */
  const addFiles = (seat, incoming) => {
    for (const f of incoming) {
      if (!seat.files.some((x) => x.path === f.path)) seat.files.push(f)
    }
    if (seat.files.length > FILES_PER_SEAT) {
      seat.files = seat.files.slice(-FILES_PER_SEAT)
    }
  }

  // --- 闲置睡姿（规划 §P11） ----------------------------------------------
  //
  // 「坐着但长时间没活」趴桌睡。状态本身仍然是快照里的 activity，只是由
  // 这里的定时器推进，前端 frameFor() 见到 `asleep` 就换趴睡帧。
  //
  // 关键约束：
  //  · 任何新事件都必须立刻把人叫醒（wakeSeat），否则会出现"打着字还在睡"；
  //  · 只有 done/idle 才允许入睡，working 期间定时器即便漏清也不能覆盖；
  //  · 定时器 unref，绝不能让一个睡姿定时器把 Node 进程钉住不退。
  const sleepTimers = new Map()

  const clearSleepTimer = (seatId) => {
    const t = sleepTimers.get(seatId)
    if (t) {
      try {
        clearTimeout(t)
      } catch {
        // 清不掉也不影响，回调里还会再校验一次
      }
      sleepTimers.delete(seatId)
    }
  }

  const wakeSeat = (seat) => {
    if (!seat) return
    clearSleepTimer(seat.seatId)
    if (seat.activity === 'asleep') seat.activity = 'done'
  }

  const scheduleSleep = (seat) => {
    if (!seat || seat.agentId === null) return
    clearSleepTimer(seat.seatId)
    const agentId = seat.agentId
    const isSub = seat.seatId !== 'main'
    const timer = setTimeout(() => {
      sleepTimers.delete(seat.seatId)
      try {
        const cur = state.seats.get(seat.seatId)
        // 这期间换人 / 已清场 / 又有活了 —— 都不该睡
        if (!cur || cur.agentId !== agentId) return
        if (cur.activity !== 'done' && cur.activity !== 'idle') return
        cur.activity = 'asleep'
      } catch {
        // 睡姿切换失败不能影响别的事件
      }
    }, isSub ? ASLEEP_AFTER_MS_SUB : ASLEEP_AFTER_MS)
    if (typeof timer.unref === 'function') timer.unref()
    sleepTimers.set(seat.seatId, timer)
  }

  /** 清掉全部睡姿定时器（切会话 / 卸载时用）。 */
  const clearAllSleepTimers = () => {
    for (const id of Array.from(sleepTimers.keys())) clearSleepTimer(id)
  }

  // --- 会话事件：主工位与副工位共同的主数据源 -----------------------------

  ctx.on('session/event', (session, event) => {
    try {
      if (!event || typeof event.type !== 'string') return
      const sub = isSubSession(session)
      const sid = sessionIdOf(session)
      const type = event.type
      // 正文 / 工具名 / 结束原因都在 event.data 里，顶层只有 type·seq·time
      const ev = eventPayload(event)

      // 用户发消息：主工位一定上班；子工位说明它被父 agent 唤醒了
      if (type === 'turn/start') {
        const seat = state.seatForSession(sid, { isSub: sub })
        clearSleepTimer(seat.seatId)
        seat.activity = 'working'
        seat.bubble.streaming = true
        // 新一轮开始：把上一轮那句"已完成"清掉，否则气泡会一直挂着旧提示
        seat.bubble.text = ''
        seat.bubble.headline = ''
        if (!sub && sid) state.sessionId = sid
        return
      }

      if (type === 'assistant/message') {
        const seat = state.seatForSession(sid, { isSub: sub })
        wakeSeat(seat)
        const text = textFromAssistantMessage(ev.message)
        if (text) {
          // 正文不截断：气泡按 10 字窗口滚动展示全文，所以这里只做"单行化 + 安全字符"清洗。
          seat.bubble.text = sanitizeText(text, BUBBLE_RAW_MAX_CHARS)
          // 10 字 / 5 字是「窗口宽度」（超出滚动），不是「句子长度上限」：
          // 抽 headline 时要给足长度，才能挑出一句有信息量的完整分句。
          // 曾经把窗口宽度 5 直接当 max 传进来，于是 isCleanClause 把所有 ≥6 字的
          // 中文分句全判掉，副鱼气泡长期只剩「在忙」「交付」这类两字标签。
          seat.bubble.headline = sub
            ? headlineFor(text, BUBBLE_SUB_HEADLINE_CHARS)
            : headlineFor(text, BUBBLE_MAIN_WINDOW)
          seat.bubble.updatedAt = Date.now()
        }
        const m = modelFromAssistantMessage(ev.message)
        if (m.model) seat.model = m.model
        if (m.provider) seat.provider = m.provider
        // 正文落地即认为这一轮说完了一段，但整体还在跑
        seat.bubble.streaming = false
        seat.activity = 'working'
        return
      }

      if (type === 'tool/call') {
        const seat = state.seatForSession(sid, { isSub: sub })
        wakeSeat(seat)
        addFiles(seat, filesFromToolCall(ev.name, parseToolArgs(ev.arguments)))
        seat.activity = 'working'
        return
      }

      if (type === 'tool/result') {
        const seat = state.seatForSession(sid, { isSub: sub })
        wakeSeat(seat)
        if (ev.error) {
          seat.activity = 'error'
        }
        return
      }

      if (type === 'turn/end') {
        const seat = state.seatForSession(sid, { isSub: sub })
        const reason = turnEndKind(ev.reason)
        seat.bubble.streaming = false
        seat.activity = reason === 'error' ? 'error' : 'done'
        // 一轮结束不再把整段汇报塞进气泡滚（几千字怎么滚都看不清），
        // 只留一句固定提示，正文去会话框看。
        const doneText = reason === 'error' ? BUBBLE_DONE_ERROR : (sub ? BUBBLE_DONE_SUB : BUBBLE_DONE_MAIN)
        seat.bubble.text = doneText
        seat.bubble.headline = doneText
        seat.bubble.updatedAt = Date.now()
        // 一轮收工：开始计闲置。到点仍没有新事件就趴桌睡（规划 P11）。
        scheduleSleep(seat)
        // 子工位不在 turn/end 离场。
        // 曾经这里挂了一个 6000ms 的 setTimeout 把座位 blank 掉，于是副鱼被召唤
        // 出来、坐一会就凭空消失（用户反馈「不希望消失」）。一轮结束只表示"这一轮
        // 做完了"，子 agent 随时可能接着跑下一轮，把他清走是错的。
        // 副鱼真正的离场点只有三个：
        //   ① session/disposed：子会话被销毁（这是权威的"这个会话没了"）
        //   ② 主会话切换：stateRoute 里的 state.reset() 全清
        //   ③ 12 个副席全满时被 LRU 淘汰（见 seatForSession）
        return
      }
    } catch (error) {
      // 单条事件处理失败不能影响其余事件
      try {
        ctx.logger?.warn?.('pixel-office: session/event 处理失败', error)
      } catch {
        // 连日志都失败就彻底放弃这条
      }
    }
  })

  // --- 子 agent 生命周期：补 sessionSeat 映射，并把模型带进座位 -----------
  //
  // 注意回调签名：`subagent/start` / `subagent/end` 只投递一个 info 参数
  // （见 dsh-subagent 的 Events 声明 `(info: SubagentRunInfo) => void`）。
  // 曾经这里写成 `(runtime, info)`，于是 info 恒为 undefined、sid 恒为 null，
  // 副工位永远拿不到身份。info 形状：`{ runId, provider, id, local }`，
  // end 另带 `stopReason` 与可选 `lastAssistantMessage`。
  //
  // 双参兼容：早期版本和部分测试夹具仍按 `(runtime, info)` 投递，这里统一
  // 归一化——谁带 `id`/`sessionId` 就用谁，避免两种调用形态各自炸一次。

  function subagentInfo(a, b) {
    if (b && typeof b === 'object' && (b.id || b.sessionId)) return b
    if (a && typeof a === 'object' && (a.id || a.sessionId)) return a
    return b && typeof b === 'object' ? b : a || {}
  }

  ctx.on('subagent/start', (first, second) => {
    try {
      const info = subagentInfo(first, second)
      const sid = info?.id ?? info?.sessionId ?? null
      if (!sid) return
      const seat = state.seatForSession(sid, {
        isSub: true,
        meta: {
          // label 用子会话自己的 provider 名兜底；真正的展示名由事件流补齐
          label: info?.label ?? info?.request?.label ?? '',
          model: info?.model ?? '',
          provider: info?.provider ?? '',
        },
      })
      seat.activity = 'working'
      seat.bubble.streaming = true
    } catch {
      // 同上
    }
  })

  ctx.on('subagent/end', (first, second) => {
    try {
      const info = subagentInfo(first, second)
      const sid = info?.id ?? info?.sessionId ?? null
      if (!sid) return
      const seat = state.seatBySession(sid)
      if (!seat) return
      const stop = turnEndKind(info?.stopReason ?? info?.reason)
      seat.bubble.streaming = false
      seat.activity = stop === 'completed' ? 'done' : stop === 'error' ? 'error' : 'idle'
      scheduleSleep(seat)
    } catch {
      // 同上
    }
  })

  // --- 会话销毁：主工位下班，子工位清场 -----------------------------------

  ctx.on('session/disposed', (session) => {
    try {
      const sub = isSubSession(session)
      const sid = sessionIdOf(session)
      if (sub) {
        const seat = state.seatBySession(sid)
        if (seat) {
          // 子会话被销毁 ≠ 这条鱼要离开办公室。
          // 用户明确要求「副鱼召唤出来后不要消失」：DSH 里子 agent 跑完一轮就
          // dispose 会话是常态，若在这里清场，鱼就会出现"坐一会凭空消失"。
          // 所以只把状态定格成 done（在座但不干活），**座位、agentId、sessionId、
          // sessionSeat 映射全部保留** —— 同一个子 agent 继续跑下一轮时要能回到
          // 原来那个工位，拆掉映射会让他重新抢一个新席，画面里就多出一条幽灵鱼。
          // 座位真正被收走只有两个途径：主会话切换 state.reset()、12 席满时 LRU 淘汰。
          if (seat.activity === 'working' || seat.activity === 'idle') seat.activity = 'done'
          seat.bubble.streaming = false
          scheduleSleep(seat)
        }
        return
      }
      const main = state.seats.get('main')
      if (main) {
        clearSleepTimer('main')
        Object.assign(main, OfficeState.blank('main'))
      }
    } catch {
      // 同上
    }
  })

  // --- HTTP 路由 ----------------------------------------------------------

  const stateRoute = {
    kind: 'exact',
    path: `${API_PREFIX}/state`,
    handler: (req, res) => {
      if (!isLoopback(req)) return writeJson(res, 403, { ok: false, error: 'loopback only' })
      if ((req.method ?? 'GET') !== 'GET') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
      const current = query(req, 'current')
      if (current && state.sessionId && current !== state.sessionId) {
        // 前端切会话了：清场重来，避免上一场的残留坐在工位上。
        // 睡姿定时器也要一起清，否则上一个会话的到点回调会去改新会话的座位。
        clearAllSleepTimers()
        state.reset(current)
      }      writeJson(res, 200, { ok: true, snapshot: state.snapshot() })
    },
  }

  /**
   * 座位锚点表。
   * 前端所有几何（座位落点、屏幕矩形、门的位置、气泡锚点、钟与吊灯坐标）都来自这张表，
   * 改底图只需重跑 tools/measure-seats.mjs 再覆盖文件，前端不用动。
   */
  const seatsRoute = {
    kind: 'exact',
    path: `${API_PREFIX}/seats`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return writeJson(res, 403, { ok: false, error: 'loopback only' })
      try {
        const text = await readFile(join(ASSET_ROOT, 'scene', 'seats.json'), 'utf8')
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(text),
          'cache-control': 'no-cache',
        })
        res.end(text)
      } catch {
        writeJson(res, 404, { ok: false, error: 'seats.json missing' })
      }
    },
  }

  const assetRoute = {
    kind: 'prefix',
    path: ASSET_PREFIX,
    handler: async (req, res) => {
      if (!isLoopback(req)) return writeJson(res, 403, { ok: false, error: 'loopback only' })
      let rel = ''
      try {
        rel = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname.slice(ASSET_PREFIX.length))
          .replace(/^\/+/, '')
      } catch {
        return writeJson(res, 400, { ok: false, error: 'bad url' })
      }
      if (rel === '') return writeJson(res, 404, { ok: false, error: 'not found' })
      const abs = resolveInside(ASSET_ROOT, rel)
      if (abs === null) return writeJson(res, 403, { ok: false, error: 'forbidden' })
      try {
        const info = await stat(abs)
        if (!info.isFile()) return writeJson(res, 404, { ok: false, error: 'not found' })
        if (info.size > ASSET_MAX_BYTES) return writeJson(res, 413, { ok: false, error: 'too large' })
        const bytes = await readFile(abs)
        const type = CONTENT_TYPES[extname(abs).toLowerCase()] ?? 'application/octet-stream'
        res.writeHead(200, {
          'content-type': type,
          'content-length': bytes.length,
          'cache-control': 'no-cache',
        })
        res.end(bytes)
      } catch {
        writeJson(res, 404, { ok: false, error: 'not found' })
      }
    },
  }

  /**
   * 交付文件预览端点。
   * 只读、只接受绝对路径、限体积；不跟随到 assets 之外的白名单，因为要预览的是
   * 工作区里刚生成的文件，这里只做"是不是普通文件 + 够不够小"两道闸。
   */
  const fileRoute = {
    kind: 'exact',
    path: `${API_PREFIX}/file`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return writeJson(res, 403, { ok: false, error: 'loopback only' })
      const target = query(req, 'path')
      if (!target) return writeJson(res, 400, { ok: false, error: 'path required' })
      try {
        const info = await stat(target).catch(() => null)
        if (!info || !info.isFile()) {
          writeJson(res, 200, { ok: false, error: '文件不存在或不是普通文件' })
          return
        }
        if (info.size > PREVIEW_MAX_BYTES) {
          writeJson(res, 200, {
            ok: false,
            error: `文件过大（${Math.round(info.size / 1024)} KB），预览上限 ${PREVIEW_MAX_BYTES / 1024} KB`,
          })
          return
        }
        const ext = extname(target).toLowerCase()
        if (IMAGE_EXTS.has(ext)) {
          // 图片走资产端点同源转发，前端直接给 img.src
          writeJson(res, 200, {
            ok: true,
            kind: 'image',
            url: `${API_PREFIX}/file-bytes?path=${encodeURIComponent(target)}`,
          })
          return
        }
        const text = await readFile(target, 'utf8')
        writeJson(res, 200, { ok: true, kind: 'text', text: text.slice(0, 200_000) })
      } catch (error) {
        writeJson(res, 200, { ok: false, error: String(error?.message ?? error) })
      }
    },
  }

  /** 预览用图片字节转发。 */
  const fileBytesRoute = {
    kind: 'exact',
    path: `${API_PREFIX}/file-bytes`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return writeJson(res, 403, { ok: false, error: 'loopback only' })
      const target = query(req, 'path')
      if (!target) return writeJson(res, 400, { ok: false, error: 'path required' })
      try {
        const info = await stat(target).catch(() => null)
        if (!info || !info.isFile() || info.size > PREVIEW_MAX_BYTES) {
          return writeJson(res, 404, { ok: false, error: 'not available' })
        }
        const bytes = await readFile(target)
        const type = CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream'
        res.writeHead(200, { 'content-type': type, 'content-length': bytes.length, 'cache-control': 'no-store' })
        res.end(bytes)
      } catch {
        writeJson(res, 404, { ok: false, error: 'not available' })
      }
    },
  }

  /**
   * 浏览器端自诊断端点。
   *
   * POST 收 client 的握手/状态上报（只收 loopback，body 限 64KB，原样当 JSON 存）；
   * GET 读回最近一次上报。只用于排障，不参与渲染。
   */
  const diagRoute = {
    kind: 'exact',
    path: `${API_PREFIX}/diag`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return writeJson(res, 403, { ok: false, error: 'loopback only' })
      const method = req.method ?? 'GET'
      if (method === 'GET') {
        if (!diagSlot.body) return writeJson(res, 200, { ok: true, diag: null })
        return writeJson(res, 200, { ok: true, diag: diagSlot })
      }
      if (method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
      const chunks = []
      let size = 0
      try {
        await new Promise((resolve, reject) => {
          req.on('data', (chunk) => {
            size += chunk.length
            if (size > DIAG_MAX_BYTES) {
              reject(new Error('too large'))
              return
            }
            chunks.push(chunk)
          })
          req.on('end', resolve)
          req.on('error', reject)
        })
      } catch {
        return writeJson(res, 413, { ok: false, error: 'too large' })
      }
      let parsed = null
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        parsed = { raw: Buffer.concat(chunks).toString('utf8').slice(0, 2000) }
      }
      diagSlot.at = Date.now()
      diagSlot.from = String(req.socket?.remoteAddress ?? '')
      diagSlot.body = parsed
      writeJson(res, 200, { ok: true })
    },
  }

  ctx.effect(() => {
    const disposers = []
    for (const route of [stateRoute, seatsRoute, assetRoute, fileRoute, fileBytesRoute, diagRoute]) {
      try {
        disposers.push(ctx.webServer.register(route))
      } catch (error) {
        try {
          ctx.logger?.warn?.(`pixel-office: 路由 ${route.path} 注册失败`, error)
        } catch {
          // 日志失败忽略
        }
      }
    }
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // 拆装失败不阻塞
        }
      }
    }
  }, 'pixel-office: routes')
}

/** 用全局标记包一层，保证重复挂载只会有一个实例在跑。 */
export const apply = (ctx) => {
  const marker = Symbol.for('dsh-pixel-office.mounted')
  const registry = globalThis
  const mounted = (registry[marker] ??= new Set())
  if (mounted.has('pixel-office')) return undefined
  mounted.add('pixel-office')
  ctx?.effect?.(() => () => {
    mounted.delete('pixel-office')
  })
  return applyImpl(ctx)
}
