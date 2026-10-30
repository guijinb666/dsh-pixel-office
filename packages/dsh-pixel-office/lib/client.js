/**
 * dsh-pixel-office client 半。
 *
 * 挂载策略：不注册 slot，直接往 document.body 塞一个 fixed 定位的右侧栏容器。
 * 理由（实证）：
 *   1. dsh-pet 走的就是这条 body-mount 路，在 rc 版 shell 上验证可用；
 *   2. 一旦 client 插件 inject 了本版本未注册的服务，整个 web boot 会直接失败
 *      （本机 web-ui-pet / web-ui-skin-center 就因此被用户手工 disabled 过）；
 *   3. 纯 DOM + canvas 不依赖 react，也不依赖任何 client service，风险最低。
 *
 * 渲染分工：
 *   canvas —— 场景底图 + 熄屏/亮屏 + 钟面指针 + 吊灯呼吸 + 角色 sprite（nearest 放大）
 *   DOM    —— 气泡（文字要换行、可滚动、可点，canvas 画不了文本交互）
 *
 * 绘制层序（顺序错了会穿帮，别乱动）：
 *   1. 场景底图
 *   2. 亮屏叠色（只给有人的工位，要先画，之后被角色挡住下半部分才像"人坐在屏前"）
 *   3. 角色（按脚底 y 排序）
 *   4. 钟面指针 + 吊灯暖光（都在后墙上，加色混合，不会压到角色身上）
 *
 * 循环：一个 rAF 驱动全部动画，一个 1s 轮询拉 Host 快照。
 */
(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // 常量
  // -------------------------------------------------------------------------

  /** Host 端点前缀。 */
  var API = '/api/pixel-office';
  /** 资产前缀。 */
  var ASSET = '/pixel-office';
  /**
   * 本次构建标记。
   *
   * 真实 GUI 拿不到 `/plugins/??<id>/client.js`（需浏览器鉴权），没法从外面
   * 判断浏览器到底跑的是哪一版 client.js。所以把标记随自诊断一起报回 host，
   * 通过 `/api/pixel-office/diag` 读回来 —— 这是唯一能确认"改的代码有没有
   * 真的进到浏览器"的办法。改 client.js 时顺手加一个后缀。
   */
  var REV = 'r2026-10-30.t7';
  /** 快照轮询间隔（ms）。 */
  var POLL_MS = 1000;
  /** 敲键盘帧切换间隔（ms）。 */
  var BASE_TYPE_FRAME_MS = 140;
  var TYPE_FRAME_MS = BASE_TYPE_FRAME_MS;
  /** 待机帧切换间隔（ms）。 */
  var BASE_IDLE_FRAME_MS = 700;
  var IDLE_FRAME_MS = BASE_IDLE_FRAME_MS;
  /** 走路帧切换间隔（ms）。 */
  var BASE_WALK_FRAME_MS = 150;
  var WALK_FRAME_MS = BASE_WALK_FRAME_MS;
  /** 走路速度（px/ms）。320 逻辑宽的房间，0.09 ≈ 每秒 90px，从门口走到最深一排约 2.5s。 */
  var BASE_WALK_SPEED = 0.09;
  var WALK_SPEED = BASE_WALK_SPEED;
  /** 横向走道 y（桌面之间的空档，从下往上）。第一排下方 250 / 第二排下方 301 / 第三排下方 355 / 主工位下方 185。 */
  var ROW_GAPS = [355, 301, 250, 185];
  /** 纵向通道 x（桌与桌之间的空档：左墙26 / 92~114→103 / 154~175→164 / 215~235→225 / 右墙297）。 */
  var COL_GAPS = [26, 103, 164, 225, 297];
  /** 卡片宽度（px）。 */
  var PANEL_W = 320;
  /**
   * 面板层级。
   *
   * 历史上这里是 90，而 sky（95）、curtain（95）、board（96）都比它高。
   * sky 是 pointer-events:none 无害，但 **curtain 是 pointer-events:auto 的全屏层**，
   * 一旦空格彩蛋的幕布还在，面板就被它整片盖住 —— 看得见（透明/半透明），
   * 但 pointerdown 全被幕布吃掉，表现就是「按钮点不动、标题条拖不动」。
   * DSH 自身前端最高只用到 z-index 1100，所以取一个明确高于全部浮层的基准值，
   * 其余浮层按偏移量依次叠在它之上，保证相对次序稳定。
   */
  var PANEL_Z = 2147480000;
  /** 拖动期间临时抬到更高的层级。 */
  var PANEL_Z_TOP = PANEL_Z + 10;
  /** 全景层（掉落/出逃的鱼要压过面板）。 */
  var SKY_Z = PANEL_Z + 100;
  /** 空格彩蛋的幕布。 */
  var CURTAIN_Z = PANEL_Z + 200;
  /** 幕布上的木头告示牌。 */
  var BOARD_Z = PANEL_Z + 300;

  /** 最小化后木牌显示宽度（px）。 */
  var SIGN_W = 64;
  /** 木牌素材路径。 */
  var SIGN_SRC = 'ui/sign.png';
  /** 主气泡最大高度（px）。 */
  var BUBBLE_MAXH_MAIN = 132;
  /** 副气泡最大高度（px）。 */
  var BUBBLE_MAXH_SUB = 88;
  /** 主鱼气泡的可见字数窗口；正文超过这个字数就在窗口里横向滚动。 */
  var MAIN_WINDOW_CHARS = 10;
  /** 副鱼气泡的可见字数窗口：只看到 5 个字，超出部分横向滚动。 */
  var BUBBLE_SUB_CHARS = 5;
  /** 气泡滚动速度上限（字/秒）。几千字的正文按固定字速滚 → 每秒几千像素，看不清。 */
  var SCROLL_CPS = 3;
  /** 气泡滚动的最慢/最快一轮时长（秒）。 */
  var SCROLL_MIN_DUR = 2.2;
  /**
   * 滚动一轮的时长上限（秒）。
   *
   * 这个值同时决定「一屏最多放多少字」：maxBubbleChars = SCROLL_MAX_DUR * SCROLL_CPS。
   * 取 40 秒 → 120 字，是「用户要求显示全部文字」与「滚太快看不清」之间的折衷：
   * 一轮结束已由 host 换成固定短句，长正文只会出现在 streaming 期间（通常几十到
   * 一两百字），120 字窗口既保住了完整一段，速度又稳定在 3 字/秒可读区间。
   * 曾经是 16 秒（48 字），会把正在输出的段落砍掉大半。
   */
  var SCROLL_MAX_DUR = 40;

  // -------------------------------------------------------------------------
  // 设置项与本地化（规划 P12）
  // -------------------------------------------------------------------------

  /**
   * 默认设置。
   *
   * `scale` 是面板整体字号缩放比（0.8 / 1 / 1.25 / 1.5），不是 CSS transform
   * —— 缩放要连 canvas 一起放大，交给 initCanvas 的 devicePixelRatio 与 stage
   * 尺寸重算，用 transform 放大 canvas 只会糊。
   * `speed` 是走路与帧动画的统一倍率（0.5 慢 / 1 正常 / 2 快）。
   * `animate` 关掉后不做折纸动效、不做走动（直接落座）、不滚气泡 —— 给
   * 只想看静态快照或无 GPU 的机器留一条退路。
   */
  var SETTING_DEFAULTS = {
    visible: true,
    scale: 1,
    speed: 1,
    animate: true,
  };

  var SETTING_KEYS = ['visible', 'scale', 'speed', 'animate'];

  /** 尺寸档位（面板宽度 px → 场景按比例放大）。 */
  var SCALE_STEPS = [0.8, 1, 1.25, 1.5];
  /** 速度档位。 */
  var SPEED_STEPS = [0.5, 1, 2];

  /** 运行中的设置快照。`applySettings` 会把它刷成 localStorage 里的值。 */
  var CFG = {
    visible: SETTING_DEFAULTS.visible,
    scale: SETTING_DEFAULTS.scale,
    speed: SETTING_DEFAULTS.speed,
    animate: SETTING_DEFAULTS.animate,
  };

  /**
   * 文案表。只放用户真正会看到的字符串；内部的 activity 名、CSS 类名不进这里。
   * 语言由 DSH 的 `locale` 服务注入（见 `pickLocale`），拿不到就按浏览器
   * navigator.language 兜底，再兜底就是中文。
   */
  var TEXT = {
    zh: {
      title: '像素办公室',
      min: '—',
      minTitle: '最小化为像素木牌',
      close: '✕',
      closeTitle: '关闭预览',
      signTitle: '拖动可移动，点击展开像素办公室',
      signFallback: '办公室',
      loading: '读取中…',
      loadFail: '读取失败：',
      unknownError: '未知错误',
      settings: '⚙',
      settingsTitle: '设置',
      visible: '显示办公室',
      scale: '尺寸',
      speed: '速度',
      animate: '播放动画',
      reset: '恢复默认',
      on: '开',
      off: '关',
      scaleNames: ['小', '标准', '大', '特大'],
      speedNames: ['慢', '正常', '快'],
    },
    en: {
      title: 'PIXEL OFFICE',
      min: '—',
      minTitle: 'Minimize to signboard',
      close: '✕',
      closeTitle: 'Close preview',
      signTitle: 'Drag to move, click to expand',
      signFallback: 'OFFICE',
      loading: 'Loading…',
      loadFail: 'Load failed: ',
      unknownError: 'unknown error',
      settings: '⚙',
      settingsTitle: 'Settings',
      visible: 'Show office',
      scale: 'Size',
      speed: 'Speed',
      animate: 'Play animation',
      reset: 'Reset',
      on: 'on',
      off: 'off',
      scaleNames: ['Small', 'Normal', 'Large', 'Huge'],
      speedNames: ['Slow', 'Normal', 'Fast'],
    },
  };

  /** 当前语言包。 */
  var L = TEXT.zh;

  /**
   * 决定用哪套文案。
   *
   * 优先用注入的 `locale` 服务（DSH 会把它作为 client inject 提供给插件），
   * 但 inject 里列了不存在的服务会让整个 web boot 失败（规划 §7 风险表，
   * 本机已踩过两次），所以这里**只读不 inject**：从全局容器里探一下，
   * 探不到就用 navigator.language。
   */
  function pickLocale(inject) {
    var tag = '';
    try {
      var loc = inject && inject.locale;
      if (loc) {
        if (typeof loc.current === 'string') tag = loc.current;
        else if (typeof loc.lang === 'string') tag = loc.lang;
        else if (typeof loc.locale === 'string') tag = loc.locale;
      }
    } catch (e) { /* 服务形状未知，忽略 */ }
    if (!tag) {
      try { tag = navigator.language || navigator.userLanguage || ''; } catch (e) { tag = ''; }
    }
    return /^zh/i.test(String(tag)) ? TEXT.zh : (tag ? TEXT.en : TEXT.zh);
  }

  /** 小数档位就近吸附。 */
  function snapTo(steps, v) {
    var best = steps[0];
    var bestD = Infinity;
    for (var i = 0; i < steps.length; i += 1) {
      var d = Math.abs(steps[i] - v);
      if (d < bestD) { bestD = d; best = steps[i]; }
    }
    return best;
  }

  /** 把外部值收敛成合法设置（localStorage 可能被手改坏）。 */
  function normalizeSettings(raw) {
    var o = raw && typeof raw === 'object' ? raw : {};
    return {
      visible: typeof o.visible === 'boolean' ? o.visible : SETTING_DEFAULTS.visible,
      scale: snapTo(SCALE_STEPS, typeof o.scale === 'number' && isFinite(o.scale) ? o.scale : SETTING_DEFAULTS.scale),
      speed: snapTo(SPEED_STEPS, typeof o.speed === 'number' && isFinite(o.speed) ? o.speed : SETTING_DEFAULTS.speed),
      animate: typeof o.animate === 'boolean' ? o.animate : SETTING_DEFAULTS.animate,
    };
  }


  // --- D13 互动层常量 -------------------------------------------------------

  /** 转身一程时长（ms）。back→side→front 两程合计 320ms。 */
  var TURN_MS = 160;
  /** 懵逼时长（ms）。 */
  var CONFUSE_MS = 1000;
  /** 双击判定窗口（ms）。 */
  var DBL_MS = 320;
  /** 双击判定允许的最大位移（px）。 */
  var DBL_SLOP = 6;
  /** 跳跃一次时长（ms）与跳高（px）。 */
  var HOP_MS = 220;
  var HOP_PX = 9;
  /** 第三级连跳次数。 */
  var HOP_TIMES = 3;
  /** 裂纹扩散时长（ms）。 */
  var CRACK_MS = 480;
  /** 掉落重力（px/ms²）与触底反弹保留量。 */
  var FALL_G = 0.0016;
  var FALL_BOUNCE = 0.22;
  /** 烟雾单程时长（ms）。 */
  var SMOKE_MS = 420;
  /** 就地坐下动画时长（ms）。 */
  var SITDOWN_MS = 260;
  /** 眨眼：间隔范围（ms）与闭眼时长（ms）。 */
  var BLINK_MIN = 2400;
  var BLINK_MAX = 4800;
  var BLINK_MS = 120;
  /** 出逃排队间距（px）。 */
  var QUEUE_GAP = 6;
  /** 告示牌弹出时长（ms）。 */
  var BOARD_MS = 620;

  /** 入场排队：同一时刻只放一条鱼进门（用户要求 m02951）。 */
  var ENTER_GAP_MS = 180;

  /** 主鱼动作帧表：语义 → 文件名数组。 */
  var MAIN_FRAMES = {
    sit: ['main-sit-1.png', 'main-sit-2.png', 'main-sit-3.png', 'main-sit-4.png'],
    type: ['main-type-a.png', 'main-type-b.png', 'main-type-c.png', 'main-type-d.png'],
    walkUp: ['main-walkup-1.png', 'main-walkup-2.png', 'main-walkup-3.png', 'main-walkup-4.png'],
    walkDown: ['main-walkdown-1.png', 'main-walkdown-2.png', 'main-walkdown-3.png', 'main-walkdown-4.png'],
    walkSide: ['main-walkside-1.png', 'main-walkside-2.png', 'main-walkside-3.png', 'main-walkside-4.png'],
    poseIdle: ['main-pose-idle.png'],
    poseThinking: ['main-pose-thinking.png'],
    poseDone: ['main-pose-done.png'],
    poseAsleep: ['main-pose-asleep.png'],
    // 正面 / 侧面坐姿帧不在这里：它们在 sit-front/ 与 sit-side/ 两个别的目录，
    // 由下面的 MAIN_TURN 单独加载（此表的所有条目会被当作 final/ 下的文件批量预载，
    // 早先把 front/side 塞进这里导致每次进页面都 6 个 404）。
  };

  /** 8 套副角色服装。背面坐姿在 final/，正面在 sit-front/，侧面在 sit-side/。 */
  var SUB_NAMES = ['m1-cat', 'm2-sakura', 'm3-gothic', 'm4-sailor', 'm5-sporty', 'm6-witch', 'm7-cafe', 'm8-idol'];

  /** 兼容旧引用：背面坐姿文件名表。 */
  var SUB_SKINS = SUB_NAMES.map(function (n) { return n + '.png'; });

  /**
   * 主角色朝向帧：正面 / 侧面 / 坐地。
   *
   * 正面与侧面都用 `char/main/stand-front/` 与 `char/main/stand-side/` 里的人形帧：
   * 那才是用户参考图（whale-maid-ref：蓝长发 + 白蕾丝女仆头饰 + 圆框眼镜 +
   * 深蓝女仆裙 + 鲸尾）的像素版。旧的 `sit-front` / `sit-side` 是早期「圆球胖鱼」
   * 造型，已废弃 —— 用户多次反馈「双击正面还是鱼造型」就是这里取错了图。
   * 同一套人形帧兼作坐姿与站姿，尺寸 38×50 / 34×54，脚底对齐后无跳变。
   */
  var MAIN_TURN = {
    front: ['stand-1.png', 'stand-2.png'],
    side: ['stand-side-1.png', 'stand-side-2.png'],
    floor: ['floor-1.png'],
  };

  /**
   * 主角色「盘腿坐在地上」帧（用户 m05088 第 1 条）。
   *
   * 空格彩蛋要求「拖出来松手后坐在地上」。旧的 `char/main/sit-floor/floor-1.png`
   * 是早期圆球胖鱼造型的瘫坐帧（36×37，放大目视确认），和现在的人形帧不是一套，
   * 用它会突然变成鱼。所以 m05088 重新 AI 生成了一张人形盘腿坐地帧
   * （`char/main/floor/main-floor.png`，39×48），只给 esc 态用。
   */
  var MAIN_FLOOR_SRC = ['main-floor.png'];

  /**
   * 主角色「站着」的全身帧（被拖拽、被拖到面板外行走时用）。指向与 MAIN_TURN 相同的
   * 人形帧：换图不会缩水，因为坐姿正面现在本来就是这套。
   */
  var MAIN_STAND = {
    front: MAIN_TURN.front.slice(),
    side: MAIN_TURN.side.slice(),
  };

  /** 副角色侧面行走帧（真·走姿，替代早期用坐姿拆上下半身的合成方案）。 */
  var SUB_WALK = SUB_NAMES.map(function (n) { return n + '-walk.png'; });

  /**
   * 副角色正面行走帧（用户 m05088 第 5 条：副鱼正面没有走路动画，补上）。
   *
   * 资产侧原本只有一张侧面走姿帧，朝下走（走向观众）时只能回落成 sit-front 的
   * 静止坐姿帧，迈步全靠代码叠 bob/lean 硬凑。这里补 8 套正面迈步帧，
   * movingFrame 的 down 分支优先取它，缺帧才回落到正面坐姿。
   */
  var SUB_WALK_FRONT = SUB_NAMES.map(function (n) { return n + '-walkfront.png'; });

  /**
   * 副角色睡姿帧（m03755）。
   * 侧身蜷缩在工位上、脸朝屏幕露出、闭眼张嘴；由 AI 生图后走
   * key-magenta → sprite-prep --width 26 处理成 26 宽的小 sprite。
   * 缺帧时回落背面坐姿，不会破图。
   */
  var SUB_SLEEP = SUB_NAMES.map(function (n) { return n + '-sleep.png'; });

  /**
   * 主角睡姿帧（m04641：主鱼也 10 秒切睡姿，姿势与副鱼同一套）。
   *
   * 旧实现用的是 `main-pose-asleep.png`（36×51，还是那个「圆球胖鱼」造型的
   * 半身趴桌帧），和现在的人形帧不是一套。这里换成专门生成的
   * `char/main/sleep/main-sleep.png`（55×53，侧身蜷缩、脸朝观众、闭眼张嘴），
   * 姿势与 8 套副鱼睡姿同源。
   * 取不到就回落到 poseAsleep → sit，不会破图。
   */
  var MAIN_SLEEP_SRC = ['main-sleep.png'];

  /**
   * 头顶符号点阵（D13.5）。
   * 用户硬约束（m02671）：头上冒出的东西不要用 AI 绘图 —— 全部在这里手写。
   * 每行一个字符串，'.' 为透明；数字是 PALETTE 的键。
   * 绘制时先按 1px 外扩画深色描边，再填色，保证深底亮底都读得清。
   */
  var PALETTE = {
    1: '#fdf6e3', // 奶白
    2: '#2b2136', // 深紫（眼镜框）
    3: '#ff5470', // 红
    4: '#ffd166', // 金
    5: '#5ee6c8', // 青
    6: '#c9c2dd', // 灰紫
  };

  var GLYPHS = {
    question: [
      '..111..',
      '.11111.',
      '11...11',
      '11...11',
      '.....11',
      '....11.',
      '...11..',
      '...11..',
      '.......',
      '...11..',
    ],
    heart: [
      '..33.33..',
      '.3333333.',
      '333333333',
      '333333333',
      '.3333333.',
      '..33333..',
      '...333...',
      '....3....',
    ],
    angry: [
      '..33333..',
      '.3333333.',
      '332333233',
      '333333333',
      '333333333',
      '332323233',
      '.3333333.',
      '..33333..',
    ],
    nerd: [
      '...1111111...',
      '..111111111..',
      '.11111111111.',
      '1112222122211',
      '1112122121211',
      '1112222122211',
      '1111111111111',
      '.11111211111.',
      '..111111111..',
    ],
    pointUp: [
      '...44..',
      '...44..',
      '...44..',
      '.44444.',
      '4444444',
      '4444444',
      '4444444',
      '.44444.',
      '..444..',
    ],
    zzz: [
      '11111111.',
      '......11.',
      '.....11..',
      '....11...',
      '...11....',
      '11111111.',
    ],
    check: [
      '........5',
      '.......55',
      '......55.',
      '5....55..',
      '55..55...',
      '.5555....',
      '..555....',
      '...5.....',
    ],
    dots: [
      '.11...11...',
      '.11...11...',
      '.11...11...',
    ],
  };

  // -------------------------------------------------------------------------
  // 小工具
  // -------------------------------------------------------------------------

  /** 稳定字符串 hash → 非负整数（FNV-1a）。 */
  function hashString(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return Math.abs(h);
  }

  /**
   * 模型 → 装扮索引（**只作为偏好**，最终以 assignSkins 的独占分配为准）。
   * 用户要求（m02968）：所有鱼的穿搭必须全部不同。
   * 同一家的子 agent 全穿同一套会撞衫，所以这里给的只是"首选"，冲突时让位。
   */
  function skinIndexFor(model, agentId) {
    var m = String(model || '').toLowerCase();
    if (m.indexOf('deepseek') >= 0) return 0;
    if (m.indexOf('claude') >= 0 || m.indexOf('anthropic') >= 0) return 1;
    if (m.indexOf('gpt') >= 0 || m.indexOf('openai') >= 0) return 2;
    if (m.indexOf('gemini') >= 0 || m.indexOf('google') >= 0) return 3;
    if (m.indexOf('qwen') >= 0 || m.indexOf('tongyi') >= 0) return 4;
    if (m.indexOf('glm') >= 0 || m.indexOf('zhipu') >= 0) return 5;
    if (m.indexOf('grok') >= 0 || m.indexOf('xai') >= 0) return 6;
    return hashString(String(agentId || 'sub')) % SUB_SKINS.length;
  }

  /**
   * 给每个在岗副工位独占一个装扮索引（0..7），保证同屏不撞衫。
   * 规则：先来的优先拿"模型偏好"那一套；已被占就按 agentId hash 起点向后线性探测第一个空位。
   * 超过 8 个同时在岗时才不得不复用（8 套资产的上限），此时用 tint 稍微区分。
   */
  function assignSkins(snap) {
    var used = {};
    var next = {};
    var subs = Array.isArray(snap && snap.subs) ? snap.subs : [];
    for (var i = 0; i < subs.length; i += 1) {
      var seat = subs[i];
      if (!seat || !seat.agentId) continue;
      var seatId = 'sub:' + i;
      var prev = S.skinAssign[seatId];
      // 同一 agent 继续占着原来那套，避免每次轮询都换衣服
      if (prev && prev.agentId === seat.agentId && !used[prev.idx]) {
        used[prev.idx] = true;
        next[seatId] = prev;
        continue;
      }
      var want = skinIndexFor(seat.model, seat.agentId);
      var idx = -1;
      for (var step = 0; step < SUB_SKINS.length; step += 1) {
        var cand = (want + step) % SUB_SKINS.length;
        if (!used[cand]) { idx = cand; break; }
      }
      if (idx < 0) {
        // 8 席已满，只能复用；用代数错开色相区分（>=8 的并发极少）
        idx = want;
      }
      used[idx] = true;
      next[seatId] = { agentId: seat.agentId, idx: idx };
    }
    S.skinAssign = next;
  }

  /** 取某工位当前独占的装扮索引（未分配时回落到模型偏好）。 */
  function skinOf(seatId, seat) {
    var rec = S.skinAssign[seatId];
    if (rec) return rec.idx;
    return skinIndexFor(seat ? seat.model : '', seat ? seat.agentId : '');
  }

  /** 加载一张图；失败返回 null。 */
  function loadImage(src) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { resolve(null); };
      img.src = src;
    });
  }

  /** 取 JSON（失败不抛）。 */
  function getJson(url) {
    return fetch(url, { headers: { accept: 'application/json' } }).then(function (res) {
      return res.ok ? res.json() : null;
    });
  }

  /**
   * 浏览器端自诊断上报。
   *
   * 真实 GUI 的 `/plugins/??<id>/client.js` 需要浏览器鉴权，外部 fetch 拿不到，
   * 所以无法从宿主机确认「浏览器到底跑的是哪一版 client.js、面板监听装没装上」。
   * 这里把关键现场（REV、面板 DOM 是否存在、z-index、监听标记、最小化后的
   * display）POST 回 host 的 `/api/pixel-office/diag`，再用 curl 读回来即可定位。
   * 只做排障，任何失败都静默——绝不能因为诊断把插件本体拖下水。
   */
  function reportDiag(tag, extra) {
    try {
      var body = {
        rev: REV,
        tag: String(tag || ''),
        at: Date.now(),
        href: String(location.href).slice(0, 300),
        ua: String(navigator.userAgent).slice(0, 200),
        dpr: window.devicePixelRatio,
        viewport: { w: window.innerWidth, h: window.innerHeight },
        hasPointerEvent: typeof window.PointerEvent !== 'undefined',
        hasAnimate: typeof document.documentElement.animate === 'function',
      };
      var root = document.querySelector('[data-pixel-office-root]');
      if (root) {
        var cs = window.getComputedStyle(root);
        body.panel = {
          zIndex: root.style.zIndex,
          computedZ: cs.zIndex,
          pointerEvents: cs.pointerEvents,
          display: cs.display,
          left: root.style.left,
          top: root.style.top,
          rect: (function (r) {
            return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
          })(root.getBoundingClientRect()),
        };
        var card = root.querySelector('[data-po-card]');
        var sign = root.querySelector('[data-po-sign]');
        var bar = root.querySelector('[data-po-bar]');
        body.panel.cardDisplay = card ? card.style.display : null;
        body.panel.signDisplay = sign ? sign.style.display : null;
        body.panel.cardPointerEvents = card ? card.style.pointerEvents : null;
        if (bar) {
          var br = bar.getBoundingClientRect();
          body.panel.barRect = { x: Math.round(br.left), y: Math.round(br.top), w: Math.round(br.width), h: Math.round(br.height) };
          // 标题条中心点的整条命中链 —— 面板被谁盖住时这里会直接点名。
          // elementsFromPoint 会把 top layer（<dialog open> / popover）也列出来，
          // 那些层 z-index 完全无效，正是"看得见但点不到"的典型成因。
          var cx = br.left + br.width / 2;
          var cy = br.top + br.height / 2;
          var chain = [];
          try {
            var list = document.elementsFromPoint(cx, cy) || [];
            for (var i2 = 0; i2 < list.length && i2 < 8; i2 += 1) {
              var el2 = list[i2];
              var mark = '';
              if (el2.getAttribute && el2.getAttribute('data-po-bar') !== null) mark = 'bar';
              else if (el2.getAttribute && el2.getAttribute('data-pixel-office-root') !== null) mark = 'panel-root';
              else if (el2.getAttribute && el2.getAttribute('data-po-card') !== null) mark = 'card';
              chain.push(
                (mark || el2.tagName) +
                (mark ? '' : '.' + String(el2.className || '').slice(0, 40)) +
                '[z=' + (window.getComputedStyle(el2).zIndex || 'auto') +
                ',pe=' + window.getComputedStyle(el2).pointerEvents + ']'
              );
            }
          } catch (e) { chain.push('elementsFromPoint failed: ' + e); }
          body.panel.hitChain = chain;
        }
      } else {
        body.panel = null;
      }
      body.ui = (function () {
        try { return JSON.parse(localStorage.getItem('dsh-pixel-office.ui') || 'null'); } catch (e) { return 'unreadable'; }
      })();
      if (extra && typeof extra === 'object') body.extra = extra;
      var payload = JSON.stringify(body);
      fetch(API + '/diag', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
        keepalive: true,
      }).catch(function () { /* 诊断失败不影响本体 */ });
    } catch (e) { /* 诊断失败不影响本体 */ }
  }

  /**
   * 一次性的输入探针。
   *
   * 面板在 DOM 里没被遮挡、z-index 最高、pointer-events 也正常，但按下事件
   * 一个都没进处理器 —— 那问题就不在页面内部，而在"事件到底有没有送进这个
   * 渲染进程的这块区域"。Electron 桌面壳会把顶部一条带交给窗口标题栏
   * （独立 WebContentsView 或 app-region 拖拽区），那里的鼠标事件到不了页面，
   * 而 elementsFromPoint 依然能列出 DOM 元素 —— 正是我们这个现场。
   *
   * 这个探针在 window 捕获阶段记录**页面收到的第一个按下事件**，不管它命中的
   * 是不是面板，把坐标和真实 target 报回 host。用它一次就能区分：
   *   - 点了完全没上报 → 那块区域的事件被壳层吞了
   *   - 点了有上报但 x/y 在别处 → 面板位置算错了
   */
  function probeFirstInput() {
    var seen = 0;
    function chainAt(x, y) {
      var out = [];
      try {
        var list = document.elementsFromPoint(x, y) || [];
        for (var i = 0; i < list.length && i < 4; i += 1) {
          var el = list[i];
          var mark = '';
          if (el.getAttribute && el.getAttribute('data-po-bar') !== null) mark = 'bar';
          else if (el.getAttribute && el.getAttribute('data-pixel-office-root') !== null) mark = 'panel-root';
          out.push(mark || (el.tagName + '.' + String(el.className || '').slice(0, 24)));
        }
      } catch (e) { out.push('err'); }
      return out;
    }
    function onAny(ev) {
      if (seen >= 5) return;
      seen += 1;
      try {
        var t = ev.target;
        var x = ev.clientX;
        var y = ev.clientY;
        reportDiag('input-' + seen, {
          type: ev.type,
          x: Math.round(x),
          y: Math.round(y),
          target: t ? (t.tagName + (t.getAttribute && t.getAttribute('data-po-bar') !== null ? '[bar]' : '')) : null,
          // 逐条纵向扫描视口顶部的命中链：如果某一段高度里 chain 只有 BODY/HTML，
          // 说明那一带根本没有页面元素（被壳层自己的 view 占了），
          // 而如果 chain 有元素却没事件，就是被别的 WebContentsView 盖住。
          topScan: [4, 14, 24, 36, 52, 70].map(function (yy) {
            return yy + ':' + (chainAt(640, yy).join('>') || 'empty');
          }),
          dragRegion: (function () {
            try {
              var b = window.getComputedStyle(document.body);
              var h = window.getComputedStyle(document.documentElement);
              return {
                bodyAppRegion: b.webkitAppRegion || b.getPropertyValue('-webkit-app-region') || '',
                htmlAppRegion: h.webkitAppRegion || h.getPropertyValue('-webkit-app-region') || '',
                bodyPE: b.pointerEvents,
                htmlPE: h.pointerEvents,
              };
            } catch (e) { return 'unreadable'; }
          })(),
        });
      } catch (e) { /* 忽略 */ }
      if (seen >= 5) {
        window.removeEventListener('pointerdown', onAny, true);
        window.removeEventListener('mousedown', onAny, true);
      }
    }
    window.addEventListener('pointerdown', onAny, true);
    window.addEventListener('mousedown', onAny, true);
  }

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }

  /**
   * 全局单调时间源（毫秒）。所有"过了 N 毫秒就做某事"的判断都必须走这里。
   *
   * 为什么不用 rAF 的 ts：无头浏览器 / --virtual-time-budget / 后台标签页下
   * rAF 会长时间不调度（实测整个脚本生命周期只跑了 5 帧），而 performance.now()
   * 照常走时。混用两个时钟是 m04324 里"掉落之后鱼消失、再也不回来"的根因：
   * 物理积分用停摆的 ts → dt 恒为 0 → 永远落不到底 → 永远不归位。
   */
  function performanceNow() {
    try {
      if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
        return performance.now();
      }
    } catch (e) { /* 忽略：退到 Date.now */ }
    return Date.now();
  }

  /** HTML 转义。 */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // -------------------------------------------------------------------------
  // 状态
  // -------------------------------------------------------------------------

  var S = {
    scene: null,
    /** AI 亮屏版的屏幕像素贴图（副/主各一张），取不到时为 null。 */
    litSub: null,
    litMain: null,
    /** 最小化木牌贴图。 */
    sign: null,
    seatsDoc: null,
    mainFrames: {},
    subSkins: [],
    snapshot: null,
    lastSeq: 0,
    /** seatId → agentId，用于识别"换人了"并触发入场走路。 */
    lastAgentIds: {},
    /** seatId → {t0, path:[{x,y}], len, spriteW}：入场折线路径（绕开桌椅） */
    walkIns: {},
    /** seatId → 气泡 DOM。 */
    bubbles: {},
    /**
     * seatId → 屏幕亮度 0..1。
     * 底图上显示器全是息屏的，亮起来是动态层按 §4.1 状态机推出来的连续量，
     * 这样才有"坐下才亮、人走渐灭"的过渡，而不是布尔跳变。
     */
    screenLit: {},
    /** 上一帧的 ts，屏幕亮度过渡要用帧间 dt（不能只看绝对时间，否则掉帧会跳变）。 */
    lastFrameTs: 0,
    /**
     * 灯光亮度 0..1（整间共用一档，两盏灯同步）。
     * 空场（一条鱼都没有）时灯全灭，有鱼才亮起来并进入呼吸 —— 与 screenLit 同一套
     * 「连续量 + 帧间 dt 线性逼近」的做法，避免布尔跳变。
     */
    lampLit: 0,
    raf: 0,
    /** 是否已挂着一个待触发的 rAF 回调（防止重复注册导致帧链翻倍）。 */
    rafPending: false,
    /** 帧链代数：watchdog 判定旧链已死时自增，迟到回调据此作废。 */
    rafGen: 0,
    /** 当前挂起回调的注册时刻，watchdog 用它判断"挂太久了"。 */
    rafPendingSince: 0,
    pollTimer: 0,
    dead: false,
    currentSessionId: null,
    /** Host 端点是否可达，用于诊断提示。 */
    hostOk: false,

    // --- D13 互动层状态 -----------------------------------------------------
    /** 主鱼正面 / 侧面坐姿帧（资产缺失时为空数组，自动回落到背面帧）。 */
    mainFront: [],
    mainSide: [],
    /** 主鱼「站着」的正面 / 侧面全身帧（拖拽与出画行走用，尺寸与坐姿齐平）。 */
    mainStandFront: [],
    mainStandSide: [],
    /** 副角正面 / 侧面坐姿帧：下标 = 装扮索引。 */
    subFront: [],
    subSide: [],
    /** 副角侧面行走帧：下标 = 装扮索引。 */
    subWalk: [],
    /** 副角正面行走帧：下标 = 装扮索引（m05088 第 5 条，AI 生图产出）。 */
    subWalkFront: [],
    /** 副角睡姿帧：下标 = 装扮索引（m03755，AI 生图产出）。 */
    subSleep: [],
    /** 主角睡姿帧（m04641，AI 生图产出，姿势与副鱼同一套）。 */
    mainSleep: [],
    /** 出逃告示牌贴图。 */
    board: null,
    /** seatId → 互动状态。见 ensureAct()。 */
    act: {},
    /** 出逃彩蛋阶段：0=未触发 1=排队集合 2=向右行走 3=告示牌已弹出。 */
    parade: 0,
    paradeT0: 0,
    /** 空格键是否按住（决定拖拽松手后是否归位）。 */
    spaceDown: false,
    /** 全景浮层（掉落/出逃用），{cv, ctx}。 */
    sky: null,
    /** 出逃顺序与排队位置。 */
    paradeIds: [],
    /** 告示牌 DOM。 */
    boardEl: null,
    boardBox: null,
    /** 出逃彩蛋揭幕用的深色幕布（浏览器里没有窗口最小化 API，用视觉等价物代替）。 */
    curtainEl: null,
    /** 坐在地上待机帧（空格彩蛋用）：主鱼 + 8 套副角。 */
    mainFloor: [],
    subFloor: [],
    /** seatId → {agentId, idx}：副工位独占的装扮索引（保证同屏不撞衫）。 */
    skinAssign: {},
    /** 入场排队：同一时刻只放一条鱼进门（用户要求 m02951）。 */
    enterQueue: [],
    /** 入场闸门：上一条鱼走到座位后才会放行下一条。 */
    enterBusyUntil: 0,
  };

  var cv = null;
  var g2d = null;
  var bubbleLayer = null;
  var stageEl = null;
  var rootEl = null;
  /** buildPanel() 的返回值，dispose 时用它拆监听。 */
  var panelApi = null;

  // -------------------------------------------------------------------------
  // 资产
  // -------------------------------------------------------------------------

  function assetUrl(rel) {
    return ASSET + '/' + rel.split('/').map(encodeURIComponent).join('/');
  }

  /** 并行加载全部资产。 */
  function loadAssets() {
    var jobs = [];

    jobs.push(loadImage(assetUrl('scene/office-dark-320.png')).then(function (img) {
      S.scene = img;
    }));

    jobs.push(getJson(API + '/seats').then(function (doc) {
      S.seatsDoc = doc && doc.scene ? doc : null;
      // 座位表就绪后立刻建一次寻路网格，之后所有走路都靠它绕桌
      buildNav();
    }).catch(function () { S.seatsDoc = null; NAV = null; }));

    // 亮屏贴图。取不到就退回加色填充，不影响主流程。
    jobs.push(loadImage(assetUrl('scene/screens/lit-sub.png')).then(function (img) {
      S.litSub = img;
    }).catch(function () {}));
    jobs.push(loadImage(assetUrl('scene/screens/lit-main.png')).then(function (img) {
      S.litMain = img;
    }).catch(function () {}));

    Object.keys(MAIN_FRAMES).forEach(function (key) {
      var names = MAIN_FRAMES[key];
      jobs.push(Promise.all(names.map(function (n) {
        return loadImage(assetUrl('char/main/final/' + n));
      })).then(function (imgs) {
        S.mainFrames[key] = imgs.filter(Boolean);
      }));
    });

    jobs.push(Promise.all(SUB_SKINS.map(function (n) {
      return loadImage(assetUrl('char/subs/final/' + n));
    })).then(function (imgs) {
      S.subSkins = imgs;
    }));

    // D13 朝向帧：正面 / 侧面。任一张缺失都静默回落，不阻塞主流程。
    //
    // 这里曾读 `sit-front` / `sit-side`，而那两套是早期的「圆球胖鱼」造型 ——
    // 用户反复要的「人形」在 `stand-front` / `stand-side`（whale-maid 参考图
    // 的像素版：蓝长发 + 白蕾丝头饰 + 女仆裙 + 鲸尾）。坐姿与站姿共用同一套
    // 人形帧，尺寸都是 38×50 / 34×54，脚底对齐后不会跳高度。
    jobs.push(Promise.all((MAIN_TURN.front || []).map(function (n) {
      return loadImage(assetUrl('char/main/stand-front/' + n));
    })).then(function (imgs) { S.mainFront = imgs.filter(Boolean); }));
    jobs.push(Promise.all((MAIN_TURN.side || []).map(function (n) {
      return loadImage(assetUrl('char/main/stand-side/' + n));
    })).then(function (imgs) { S.mainSide = imgs.filter(Boolean); }));

    jobs.push(Promise.all(SUB_NAMES.map(function (n) {
      return loadImage(assetUrl('char/subs/sit-front/' + n + '-front.png'));
    })).then(function (imgs) { S.subFront = imgs; }));
    jobs.push(Promise.all(SUB_NAMES.map(function (n) {
      return loadImage(assetUrl('char/subs/sit-side/' + n + '-side.png'));
    })).then(function (imgs) { S.subSide = imgs; }));

    // 站立全身帧：拖拽 / 出画行走时用，尺寸与坐姿齐平，避免"一抓就缩"。
    jobs.push(Promise.all((MAIN_STAND.front || []).map(function (n) {
      return loadImage(assetUrl('char/main/stand-front/' + n));
    })).then(function (imgs) { S.mainStandFront = imgs.filter(Boolean); }));
    jobs.push(Promise.all((MAIN_STAND.side || []).map(function (n) {
      return loadImage(assetUrl('char/main/stand-side/' + n));
    })).then(function (imgs) { S.mainStandSide = imgs.filter(Boolean); }));
    jobs.push(Promise.all(SUB_WALK.map(function (n) {
      return loadImage(assetUrl('char/subs/walk-side/' + n));
    })).then(function (imgs) { S.subWalk = imgs; }));

    // 副角正面行走帧（m05088 第 5 条）。缺帧给 null，movingFrame 会回落正面坐姿。
    jobs.push(Promise.all(SUB_WALK_FRONT.map(function (n) {
      return loadImage(assetUrl('char/subs/walk-front/' + n)).catch(function () { return null; });
    })).then(function (imgs) { S.subWalkFront = imgs; }));

    // 副角睡姿帧。缺失逐张回落（loadImage 失败给 null），frameFor 里再兜底。
    jobs.push(Promise.all(SUB_SLEEP.map(function (n) {
      return loadImage(assetUrl('char/subs/sleep/' + n)).catch(function () { return null; });
    })).then(function (imgs) { S.subSleep = imgs; }));

    // 主角睡姿帧（m04641）。同样缺失就留空数组，frameFor 回落 poseAsleep/sit。
    jobs.push(Promise.all(MAIN_SLEEP_SRC.map(function (n) {
      return loadImage(assetUrl('char/main/sleep/' + n)).catch(function () { return null; });
    })).then(function (imgs) { S.mainSleep = imgs.filter(Boolean); }));

    // 盘腿坐在地上帧（空格彩蛋，用户 m05088）。缺失时回落到正面站姿帧。
    // 注意目录是 char/main/floor/ —— 旧的 char/main/sit-floor/ 是圆球胖鱼造型的
    // 瘫坐帧，仅供历史对照，运行时不加载。
    jobs.push(Promise.all(MAIN_FLOOR_SRC.map(function (n) {
      return loadImage(assetUrl('char/main/floor/' + n)).catch(function () { return null; });
    })).then(function (imgs) { S.mainFloor = imgs.filter(Boolean); }));

    // 副角色坐地帧（空格彩蛋）：assets 里那 8 张 sit-floor 本来就是人形坐地/瘫坐，
    // 比正面站姿帧矮一截（m1 26×30 vs 站姿 26×37），正好读作"坐在地上"。
    jobs.push(Promise.all(SUB_NAMES.map(function (n) {
      return loadImage(assetUrl('char/subs/sit-floor/' + n + '-floor.png')).catch(function () { return null; });
    })).then(function (imgs) { S.subFloor = imgs; }));

    // 出逃告示牌（空白木牌，文字由代码像素字画上去）。
    jobs.push(loadImage(assetUrl('ui/board.png')).then(function (img) {
      S.board = img;
    }).catch(function () { S.board = null; }));

    // 最小化后的像素木牌。取不到就在标题按钮里退化成纯文字。
    jobs.push(loadImage(assetUrl(SIGN_SRC)).then(function (img) {
      S.sign = img;
    }).catch(function () { S.sign = null; }));

    return Promise.all(jobs);
  }

  // -------------------------------------------------------------------------
  // 轮询
  // -------------------------------------------------------------------------

  function poll() {
    if (S.dead) return Promise.resolve();
    if (document.visibilityState !== 'visible') return Promise.resolve();
    var url = API + '/state';
    if (S.currentSessionId) url += '?current=' + encodeURIComponent(S.currentSessionId);
    return getJson(url).then(function (body) {
      var snap = body && body.snapshot;
      if (!snap || typeof snap.seq !== 'number') {
        S.hostOk = false;
        return;
      }
      S.hostOk = true;
      if (snap.seq < S.lastSeq) return; // 乱序回包丢弃
      S.lastSeq = snap.seq;
      applySnapshot(snap);
    }).catch(function () { S.hostOk = false; });
  }

  /** 落快照 + 检测新入座（触发从门口走进来）。 */
  function applySnapshot(snap) {
    S.snapshot = snap;
    var seen = {};
    var doc = S.seatsDoc;

    // 先重排装扮，保证同屏不撞衫（m02968）
    assignSkins(snap);

    var consider = function (seatId, seat) {
      if (!seat || !seat.agentId) return;
      seen[seatId] = true;
      if (S.lastAgentIds[seatId] === seat.agentId) return;
      S.lastAgentIds[seatId] = seat.agentId;
      var target = seatPosition(seatId);
      if (!target || !doc) return;
      var spriteW = target.kind === 'main' ? doc.spriteSize.main : doc.spriteSize.sub;
      var spriteH = spriteHeightFor(seatId);
      var path = navRoute(
        { x: Math.round(doc.door.x + doc.door.w / 2 - spriteW / 2), y: Math.round(doc.door.y - spriteH) },
        { x: Math.round(target.x), y: Math.round(target.y) },
        spriteW,
        spriteH
      );
      var len = pathLen(path);
      // 用户要求（m02951）：一个一个人进来。先排队，由 stepEnter 逐条放行，
      // 避免多条鱼在门洞里叠在一起、彼此遮挡到看起来"头身分离"。
      var rec = {
        t0: 0,
        path: path,
        len: len,
        spriteW: spriteW,
        seatId: seatId,
        ready: false,
        dur: len / WALK_SPEED,
      };
      S.walkIns[seatId] = rec;
      if (S.enterQueue.indexOf(seatId) < 0) S.enterQueue.push(seatId);
    };

    consider('main', snap.main);
    if (Array.isArray(snap.subs)) {
      snap.subs.forEach(function (seat, i) { consider('sub:' + i, seat); });
    }
    Object.keys(S.lastAgentIds).forEach(function (seatId) {
      if (!seen[seatId]) {
        delete S.lastAgentIds[seatId];
        delete S.walkIns[seatId];
        var qi = S.enterQueue.indexOf(seatId);
        if (qi >= 0) S.enterQueue.splice(qi, 1);
      }
    });
  }

  /**
   * 入场闸门：同一时刻只允许一条鱼从门口往里走。
   * 上一条走到座位（或超时兜底）后，下一条才开始，间隔 ENTER_GAP_MS 留出视觉呼吸。
   */
  /**
   * 一段入场折线要走多久。
   *
   * 不能读 walk.dur —— 那是**建折线那一刻**按当时的 WALK_SPEED 算出来存下的
   * 快照值，设置里改速度后已经在走/排队的人不会跟着变。这里统一按当前
   * WALK_SPEED 现算，改档位立刻全线生效。
   */
  /**
   * 沿折线走了多少（0..1）。
   *
   * 关掉动画时直接返回 1（瞬间到位）。所有走路插值都必须走这个函数，
   * 否则「关动画」只对入场生效、拖拽回家仍在爬 —— 看起来像卡住了。
   */
  function walkProgress(t0, walkLen, ts) {
    if (CFG.animate === false) return 1;
    if (!(walkLen > 0)) return 1;
    return clamp((ts - t0) / (walkLen / WALK_SPEED), 0, 1);
  }

  /** 沿折线走完没有。 */
  function walkDone(t0, walkLen, ts) {
    return walkProgress(t0, walkLen, ts) >= 1;
  }

  function walkDur(walk) {
    if (!walk) return 0;
    // 设置里关掉动画 → 不做走路过程，所有人瞬间落到座位上（kk 除零得
    // Infinity 再被 clamp 到 1，正好等于"已经走完"）。
    if (CFG.animate === false) return 0;
    if (walk.len > 0) return walk.len / WALK_SPEED;
    return walk.dur || 0;
  }

  function stepEnter(ts) {
    if (!S.enterQueue.length) return;
    var head = S.enterQueue[0];
    var rec = S.walkIns[head];
    if (!rec) { S.enterQueue.shift(); return; }
    if (!rec.ready) {
      // 门里还是空的 / 上一条还没走完，等
      if (ts < S.enterBusyUntil) return;
      rec.ready = true;
      rec.t0 = ts;
      return;
    }
    var done = (ts - rec.t0) >= walkDur(rec);
    if (done) {
      S.enterQueue.shift();
      S.enterBusyUntil = ts + ENTER_GAP_MS;
    }
  }

  // -------------------------------------------------------------------------
  // 座位几何
  // -------------------------------------------------------------------------

  function seatPosition(seatId) {    var doc = S.seatsDoc;
    if (!doc) return null;
    if (seatId === 'main') {
      return { x: doc.main.seated.x, y: doc.main.seated.y, kind: 'main' };
    }
    var idx = Number(String(seatId).split(':')[1]);
    var sub = doc.subs && doc.subs[idx];
    if (!sub) return null;
    return { x: sub.seated.x, y: sub.seated.y, kind: 'sub' };
  }

  // --- 网格寻路（A*） --------------------------------------------------------
  // 用户 m03606 / m04324：「回去时要避开每个工位和办公室中的障碍物，看起来像从过道
  // 走过去的，不是飞过去」。
  //
  // 为什么废掉手写走道规则：桌与桌之间的纵向通道只有 20~22px，比角色身宽还窄，
  // 只要"竖直换排"就必然压到桌沿。实测 26 条用例 26 条碰撞，方案不可行。
  // 所以改成在「脚能不能站」的网格上跑 A*，绕障是搜索出来的而不是规定出来的。
  //
  // 坐标系：NAV 网格与所有 nav* 函数都工作在**脚底中心**坐标系
  // （x = 脚中心横坐标，y = 脚底那条线）。对外的路径点仍是精灵左上角，
  // 进出各做一次换算（见 navRoute），保证 walkPos / drawActor 不用改。
  //
  // ⚠️ tmp/test-nav.mjs 是本段的等价验证脚本，两边必须同步改（43 条用例全过）。

  var NAV_STEP = 2;      // 网格步长（逻辑像素）
  var NAV_FOOT_W = 8;    // 脚区宽
  var NAV_FOOT_H = 6;    // 脚区高（自脚底中心向上量）
  var NAV = null;        // { cols, rows, walk: Uint8Array }

  /** 建一次可行走网格。座位表加载完调用；重复调用是安全的。 */
  function buildNav() {
    var doc = S.seatsDoc;
    if (!doc || !doc.scene) { NAV = null; return; }
    var desks = [];
    var m = doc.main;
    if (m && m.deskL != null) {
      desks.push({ x: m.deskL, y: m.deskTop, w: m.deskR - m.deskL, h: m.deskBottom - m.deskTop });
    }
    var subs = doc.subs || [];
    for (var i = 0; i < subs.length; i += 1) {
      var s = subs[i];
      desks.push({ x: s.deskL, y: s.deskTop, w: s.deskR - s.deskL, h: s.deskBottom - s.deskTop });
    }
    var cols = Math.ceil(doc.scene.w / NAV_STEP);
    var rows = Math.ceil(doc.scene.h / NAV_STEP);
    var walk = new Uint8Array(cols * rows);
    var hw = NAV_FOOT_W / 2;
    for (var r = 0; r < rows; r += 1) {
      for (var c = 0; c < cols; c += 1) {
        // 脚区矩形：中心 (c*STEP, r*STEP)，宽 FOOT_W，自中心向上 FOOT_H
        var fx = c * NAV_STEP - hw;
        var fy = r * NAV_STEP - NAV_FOOT_H;
        var ok = 1;
        for (var k = 0; k < desks.length; k += 1) {
          var d = desks[k];
          if (fx < d.x + d.w && fx + NAV_FOOT_W > d.x && fy < d.y + d.h && fy + NAV_FOOT_H > d.y) { ok = 0; break; }
        }
        walk[r * cols + c] = ok;
      }
    }
    NAV = { cols: cols, rows: rows, walk: walk };
  }

  /**
   * 取某个座位角色的**基准帧高**（背面坐姿首帧）。
   *
   * 为什么不能用 frameFor('back') 现取：主鱼背面帧高度随 activity 在 49~52 之间变，
   * 每个 activity 切换都会让脚底线跳 1~3px；而且 seats.json 的 seated.y 是按
   * 背面坐姿帧标定的，基准必须固定成同一帧，路径与绘制才对得上。
   *
   * 这个值同时用于三处，必须唯一：
   *   1. navRoute 把左上角换算成脚底（y + baseH）
   *   2. 走路时按脚底对齐做补偿（走姿帧比坐姿帧高/矮，见 walkFootFix）
   *   3. drawSky 面板外的缩放绘制
   */
  function spriteHeightFor(seatId) {
    if (seatId === 'main') {
      var f = S.mainFrames && S.mainFrames.sit;
      if (f && f.length && f[0]) return f[0].height;
      return 51;
    }
    var idx = skinOf(seatId, seatData(seatId));
    var img = S.subSkins && S.subSkins[idx];
    if (img) return img.height;
    return 37;
  }

  /**
   * 副角色帧的「等高等比」归一化系数（用户 m05088 第 3 条）。
   *
   * 8 套副角的帧高极不统一（实测）：背面坐姿 m1 37 / m5 40 / m6 41 / m8 41，
   * 而正面帧 m1 30 / m5 26 / m8 24 —— 同一套衣服换朝向就矮掉 30%~40%，
   * 拖起来或被拖到画布外时读感就是「突然缩小」。
   *
   * 这里统一按「背面坐姿帧高」等比放大矮帧（只放大不压缩，上限 1.6 倍，
   * 避免 m5/m8 那种 1.7 倍的极端拉伸把描边糊掉），并保持脚底对齐。
   * 真正的解法是补一套与坐姿同高的正面 / 正面行走帧（见 m05088 第 5 条），
   * 在那之前这层归一化保证任何朝向都不会跳尺寸。
   */
  function subFrameNorm(seatId, img) {
    if (!img || !img.height) return 1;
    var base = spriteHeightFor(seatId);
    var n = base / img.height;
    if (!(n > 1)) return 1;
    return Math.min(1.6, n);
  }

  /**
   * 走路时的脚底对齐补偿量。
   *
   * 路径点的 y 是「按基准帧高的精灵左上角」，脚底 = y + baseH。
   * 但走姿帧高度和坐姿帧差很多（实测 m6-witch 走姿 51 vs 背面 41，
   * m5-sporty 走姿 26 vs 背面 40），若仍按左上角对齐，高的帧脚会陷进地板、
   * 矮的帧脚会悬空。这里返回要让脚底落回 baseH 所需的 y 偏移。
   */
  function walkFootFix(seatId, img) {
    if (!img) return 0;
    return spriteHeightFor(seatId) - img.height;
  }

  /** 最近的可站格（环形扩散），返回格索引。 */
  function navNearest(c, r) {
    var N = NAV;
    if (N.walk[r * N.cols + c]) return r * N.cols + c;
    for (var rad = 1; rad < 48; rad += 1) {
      var best = -1;
      var bestD = 1e9;
      for (var dr = -rad; dr <= rad; dr += 1) {
        for (var dc = -rad; dc <= rad; dc += 1) {
          if (Math.abs(dr) !== rad && Math.abs(dc) !== rad) continue;
          var rr = r + dr;
          var cc = c + dc;
          if (rr < 0 || rr >= N.rows || cc < 0 || cc >= N.cols) continue;
          if (!N.walk[rr * N.cols + cc]) continue;
          var d = dr * dr + dc * dc;
          if (d < bestD) { bestD = d; best = rr * N.cols + cc; }
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  /** 去掉共线的中间点，让折线拐点最少、走路不抖动。 */
  function navSimplify(pts) {
    if (pts.length <= 2) return pts;
    var out = [pts[0]];
    for (var i = 1; i < pts.length - 1; i += 1) {
      var a = out[out.length - 1];
      var b = pts[i];
      var c = pts[i + 1];
      if ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) !== 0) out.push(b);
    }
    out.push(pts[pts.length - 1]);
    return out;
  }

  /**
   * 在脚底网格上跑 A*，返回脚底坐标折线（不含端点吸附前的真实坐标）。
   * from/to 都是 { x, y } = 脚底中心。无解返回 null。
   */
  function navFind(from, to) {
    if (!NAV) buildNav();
    if (!NAV) return null;
    var N = NAV;
    var sc = function (x) { return clamp(Math.round(x / NAV_STEP), 0, N.cols - 1); };
    var sr = function (y) { return clamp(Math.round(y / NAV_STEP), 0, N.rows - 1); };
    var start = navNearest(sc(from.x), sr(from.y));
    var goal = navNearest(sc(to.x), sr(to.y));
    if (start < 0 || goal < 0) return null;
    var total = N.cols * N.rows;
    var gScore = new Float64Array(total);
    for (var i = 0; i < total; i += 1) gScore[i] = Infinity;
    var came = new Int32Array(total);
    for (i = 0; i < total; i += 1) came[i] = -1;
    // 每个格子是从哪个方向走进来的（DIRS 下标），用于转弯惩罚
    var cameDir = new Int8Array(total);
    for (i = 0; i < total; i += 1) cameDir[i] = -1;
    var closed = new Uint8Array(total);
    var gc = goal % N.cols;
    var gr = (goal - gc) / N.cols;
    var hfn = function (c, r) {
      var dx = Math.abs(c - gc);
      var dy = Math.abs(r - gr);
      return (dx + dy) + (Math.SQRT2 - 2) * Math.min(dx, dy);
    };
    // 二叉堆
    var hf = [];
    var hi = [];
    var push = function (f, idx) {
      hf.push(f); hi.push(idx);
      var k = hf.length - 1;
      while (k > 0) {
        var p = (k - 1) >> 1;
        if (hf[p] <= hf[k]) break;
        var tf = hf[p]; hf[p] = hf[k]; hf[k] = tf;
        var ti = hi[p]; hi[p] = hi[k]; hi[k] = ti;
        k = p;
      }
    };
    var pop = function () {
      var topF = hf[0];
      var topI = hi[0];
      var lf = hf.pop();
      var li = hi.pop();
      if (hf.length) {
        hf[0] = lf; hi[0] = li;
        var k = 0;
        for (;;) {
          var l = k * 2 + 1;
          var r2 = l + 1;
          var m = k;
          if (l < hf.length && hf[l] < hf[m]) m = l;
          if (r2 < hf.length && hf[r2] < hf[m]) m = r2;
          if (m === k) break;
          var tf = hf[m]; hf[m] = hf[k]; hf[k] = tf;
          var ti = hi[m]; hi[m] = hi[k]; hi[k] = ti;
          k = m;
        }
      }
      return { f: topF, i: topI };
    };
    gScore[start] = 0;
    push(hfn(start % N.cols, (start - start % N.cols) / N.cols), start);
    // 只用 4 邻接：角色只有上/下/侧三套行走帧，斜走会让朝向与移动方向对不上。
    // 4 邻接保证每段都是轴对齐的，walkPos 的 dir 判定就是真方向。
    var DIRS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1]];
    // 转弯惩罚：4 邻接在空地上有大量"长度完全相同"的等价路径，裸 A* 会随手挑一条
    // 锯齿最厉害的出来 —— 用户看到的就是「路线诡异、绕好几圈」(m00343 第六条)。
    // 给每次换向加一点代价，搜索就自然挑拐点最少的那条，视觉上是笔直的过道直走。
    var TURN_COST = 3;
    var found = false;
    while (hf.length) {
      var cur = pop().i;
      if (closed[cur]) continue;
      closed[cur] = 1;
      if (cur === goal) { found = true; break; }
      var cc = cur % N.cols;
      var cr = (cur - cc) / N.cols;
      for (var k2 = 0; k2 < DIRS.length; k2 += 1) {
        var dc = DIRS[k2][0];
        var dr = DIRS[k2][1];
        var nc = cc + dc;
        var nr = cr + dr;
        if (nc < 0 || nc >= N.cols || nr < 0 || nr >= N.rows) continue;
        var ni = nr * N.cols + nc;
        if (!N.walk[ni] || closed[ni]) continue;
        var prevDir = cameDir[cur];
        var stepCost = DIRS[k2][2];
        if (prevDir >= 0 && prevDir !== k2) stepCost += TURN_COST;
        var ng = gScore[cur] + stepCost;
        if (ng < gScore[ni]) {
          gScore[ni] = ng;
          came[ni] = cur;
          cameDir[ni] = k2;
          push(ng + hfn(nc, nr), ni);
        }
      }
    }
    if (!found) return null;
    var cells = [];
    var walker = goal;
    while (walker !== -1) {
      var wc = walker % N.cols;
      cells.push({ x: wc * NAV_STEP, y: ((walker - wc) / N.cols) * NAV_STEP });
      walker = came[walker];
    }
    cells.reverse();
    // 首尾用真实坐标，避免 2px 格点吸附带来的抖动
    if (cells.length) {
      cells[0] = { x: Math.round(from.x), y: Math.round(from.y) };
      cells[cells.length - 1] = { x: Math.round(to.x), y: Math.round(to.y) };
    }
    return navSimplify(cells);
  }

  /**
   * 对外统一的路径规划：任意精灵左上角 → 任意精灵左上角，返回左上角折线。
   * 内部把左上角换算成脚底中心（x + w/2, y + h）去寻路，再换算回来，
   * 这样 walkPos / drawActor 的坐标系完全不用动。
   */
  function navRoute(from, to, spriteW, spriteH) {
    var sw = spriteW || 26;
    var sh = spriteH || 37;
    var a = { x: from.x + sw / 2, y: from.y + sh };
    var b = { x: to.x + sw / 2, y: to.y + sh };
    var feet = navFind(a, b);
    if (!feet) {
      // 无解时退回直线（宁可穿一下也不要卡死不动）
      return [{ x: Math.round(from.x), y: Math.round(from.y) }, { x: Math.round(to.x), y: Math.round(to.y) }];
    }
    var out = [];
    for (var i = 0; i < feet.length; i += 1) {
      out.push({ x: Math.round(feet[i].x - sw / 2), y: Math.round(feet[i].y - sh) });
    }
    return navSimplify(out);
  }

  function pathLen(pts) {
    var sum = 0;
    for (var i = 1; i < pts.length; i += 1) {
      sum += Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y);
    }
    return sum;
  }

  /** 沿折线走 dist 像素后的位置与朝向。 */
  function walkPos(pts, dist) {
    var d = dist;
    for (var i = 1; i < pts.length; i += 1) {
      var a = pts[i - 1];
      var b = pts[i];
      var seg = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
      if (d <= seg) {
        var t = seg > 0 ? d / seg : 0;
        var dir;
        if (Math.abs(b.y - a.y) >= Math.abs(b.x - a.x)) dir = b.y > a.y ? 'down' : 'up';
        else dir = b.x > a.x ? 'right' : 'left';
        return { x: Math.round(lerp(a.x, b.x, t)), y: Math.round(lerp(a.y, b.y, t)), dir: dir };
      }
      d -= seg;
    }
    var last = pts[pts.length - 1];
    return { x: last.x, y: last.y, dir: 'up' };
  }

  function screenRect(seatId) {
    var doc = S.seatsDoc;
    if (!doc) return null;
    if (seatId === 'main') return doc.main.screen;
    var idx = Number(String(seatId).split(':')[1]);
    var sub = doc.subs && doc.subs[idx];
    return sub ? sub.screen : null;
  }

  /** 取一个座位的当前快照对象。 */
  function seatData(seatId) {
    var snap = S.snapshot;
    if (!snap) return null;
    if (seatId === 'main') return snap.main;
    var idx = Number(String(seatId).split(':')[1]);
    return snap.subs && snap.subs[idx] ? snap.subs[idx] : null;
  }

  // -------------------------------------------------------------------------
  // canvas
  // -------------------------------------------------------------------------

  function initCanvas(host) {
    var doc = S.seatsDoc;
    cv = document.createElement('canvas');
    cv.width = doc ? doc.scene.w : 320;
    cv.height = doc ? doc.scene.h : 431;
    cv.style.width = '100%';
    cv.style.height = 'auto';
    cv.style.display = 'block';
    cv.style.imageRendering = 'pixelated';
    cv.style.cursor = 'default';
    g2d = cv.getContext('2d');
    g2d.imageSmoothingEnabled = false;
    host.appendChild(cv);
  }

  /**
   * 全景浮层：掉落/出逃的角色要能掉到浏览器最底部、浮在所有内容之上，
   * canvas 会被面板裁掉，所以单独开一层 fixed canvas。
   */
  function initSky() {
    if (S.sky) return;
    var sk = document.createElement('canvas');
    sk.setAttribute('data-po-sky', '');
    sk.style.position = 'fixed';
    sk.style.left = '0';
    sk.style.top = '0';
    sk.style.width = '100%';
    sk.style.height = '100%';
    sk.style.zIndex = String(SKY_Z);
    sk.style.pointerEvents = 'none';
    sk.style.imageRendering = 'pixelated';
    sk.style.opacity = '0';
    document.body.appendChild(sk);
    var ctx = sk.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    S.sky = { cv: sk, ctx: ctx };
    resizeSky();
  }

  function resizeSky() {
    if (!S.sky) return;
    var dpr = window.devicePixelRatio || 1;
    S.sky.cv.width = Math.max(1, Math.round(window.innerWidth * dpr));
    S.sky.cv.height = Math.max(1, Math.round(window.innerHeight * dpr));
    S.sky.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    S.sky.ctx.imageSmoothingEnabled = false;
  }

  /** canvas 上的指针交互：按下可能开始拖拽，抬起可能触发单击/双击。 */
  function bindCanvasInput() {
    if (!cv) return;

    cv.addEventListener('pointerdown', function (e) {
      if (window.__poLog) window.__poLog('down btn=' + e.button + ' @' + Math.round(e.clientX) + ',' + Math.round(e.clientY) + ' parade=' + !!S.parade);
      if (e.button !== undefined && e.button !== 0) return;
      if (S.parade) return;
      var ts = performance.now();
      var seatId = hitTest(e.clientX, e.clientY, ts);
      if (window.__poLog) {
        var lp = toLogicalLoose(e.clientX, e.clientY);
        window.__poLog('hit=' + seatId + ' lp=' + JSON.stringify(lp && { x: Math.round(lp.x), y: Math.round(lp.y) }) +
          ' snap=' + !!S.snapshot + ' acts=' + Object.keys(S.act).join('|') +
          ' wins=' + Object.keys(S.walkIns).join('|') +
          ' mainBox=' + JSON.stringify(actorBox('main', ts)));
      }
      if (!seatId) return;
      var a = ensureAct(seatId);
      if (a.phase === 'confused' || a.phase === 'grabbing') return;
      beginGrab(seatId, e.clientX, e.clientY, ts);
      if (window.__poLog) window.__poLog('grabbed cursor=' + cv.style.cursor);
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      e.preventDefault();
    });

    cv.addEventListener('pointermove', function (e) {
      if (!dragState) return;
      moveGrab(e.clientX, e.clientY);
    });

    cv.addEventListener('pointerup', function (e) {
      if (!dragState) return;
      endGrab(e.clientX, e.clientY, performance.now());
    });

    cv.addEventListener('pointercancel', function () {
      if (!dragState) return;
      var a = S.act[dragState.seatId];
      dragState = null;
      if (a) { a.phase = 'seated'; a.pos = null; setFacingNow(a, 'back'); }
      if (cv) cv.style.cursor = 'default';
    });
  }

  /** 空格键：按住时拖拽出去的鱼不回家，就地坐在地上待机。 */
  function bindSpaceKey() {
    function isTyping(ev) {
      var t = ev.target;
      if (!t) return false;
      var tag = (t.tagName || '').toUpperCase();
      return tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable === true;
    }
    S.onKeyDown = function (e) {
      if (e.code !== 'Space' && e.key !== ' ') return;
      if (isTyping(e)) return;
      if (!S.spaceDown) {
        S.spaceDown = true;
        if (cv) cv.style.cursor = 'grab';
      }
      // 空格在 DSH 里是全局快捷键，只有指针在面板上时才吃掉这次按键
      var over = cv && cv.matches(':hover');
      if (over) e.preventDefault();
    };
    S.onKeyUp = function (e) {
      if (e.code !== 'Space' && e.key !== ' ') return;
      S.spaceDown = false;
      if (cv && !dragState) cv.style.cursor = 'default';
    };
    window.addEventListener('keydown', S.onKeyDown);
    window.addEventListener('keyup', S.onKeyUp);
  }

  function drawFrame(ts) {
    if (S.dead) return;
    var g = g2d;
    if (!g || !cv) return;

    if (S.scene) {
      g.clearRect(0, 0, cv.width, cv.height);
      g.drawImage(S.scene, 0, 0);
    } else {
      g.fillStyle = '#2b2136';
      g.fillRect(0, 0, cv.width, cv.height);
    }

    if (S.seatsDoc) {
      drawScreens(g, ts);
      drawActors(g, ts);
      drawEffects(g, ts);
      drawBackWallDynamics(g, ts);
    }
  }

  // -------------------------------------------------------------------------
  // D13.5 特效层：符号 / 烟雾 / 裂纹 / 扬尘
  // 全部按座位 act 状态画在角色之上（y 抬到头顶）
  // -------------------------------------------------------------------------

  /** 某个座位当前的绘制位置（含拖拽覆盖与走路插值）。 */
  function actorDrawPos(seatId) {
    var a = S.act[seatId];
    if (a && a.pos) return { x: a.pos.x, y: a.pos.y };
    var sp = seatPosition(seatId);
    return sp ? { x: sp.x, y: sp.y } : null;
  }

  function drawEffects(g, ts) {
    var snap = S.snapshot;
    if (!snap) return;
    var doc = S.seatsDoc;
    if (!doc) return;

    var ids = ['main'];
    for (var i = 0; i < 12; i += 1) ids.push('sub:' + i);

    for (var n = 0; n < ids.length; n += 1) {
      var seatId = ids[n];
      var seat = seatData(seatId);
      if (!seat || !seat.agentId) continue;
      var a = S.act[seatId];
      if (!a) continue;
      var p = actorDrawPos(seatId);
      if (!p) continue;
      var isMain = seatId === 'main';
      var sw = isMain ? doc.spriteSize.main : doc.spriteSize.sub;
      var sh = isMain ? 51 : 37;

      // --- 裂纹（画在脚底，角色之前就应画，但压在地板上放角色之后也读得清）
      if (a.crack) {
        var ck = clamp((ts - a.crack.t0) / CRACK_MS, 0, 1);
        drawCrack(g, a.crack.cx, a.crack.cy, a.crack.r, ck);
        if (ck >= 1) a.crack = null;
      }

      // --- 烟雾
      if (a.smoke) {
        var sk = clamp((ts - a.smoke.t0) / a.smoke.dur, 0, 1);
        drawSmoke(g, a.smoke.cx, a.smoke.cy, a.smoke.r, sk, a.smoke.dir);
        if (sk >= 1) a.smoke = null;
      }

      // --- 头顶符号
      if (a.glyph) {
        if (ts - a.glyph.t0 >= a.glyph.dur) {
          a.glyph = null;
        } else {
          var gs = glyphSize(a.glyph.name);
          var scale = isMain ? 1 : 1;
          var gx = Math.round(p.x + sw / 2 - (gs.w * scale) / 2 + (a.glyph.dx || 0));
          var gy = Math.round(p.y - gs.h * scale - 6 + (a.glyph.dy || 0));
          // 轻微上下浮动，符号才不像贴图钉在那里
          gy += Math.round(Math.sin(ts / 220) * 1);
          drawGlyph(g, a.glyph.name, gx, gy, scale, 1);
        }
      }

      // --- 第二个符号（🤓👆🏻 是组合，需要并排画）
      if (a.glyph2) {
        if (ts - a.glyph2.t0 >= a.glyph2.dur) {
          a.glyph2 = null;
        } else {
          var gs2 = glyphSize(a.glyph2.name);
          var gx2 = Math.round(p.x + sw / 2 - (gs2.w) / 2 + (a.glyph2.dx || 0));
          var gy2 = Math.round(p.y - gs2.h - 4 + (a.glyph2.dy || 0));
          gy2 += Math.round(Math.sin(ts / 220 + 1.2) * 1);
          drawGlyph(g, a.glyph2.name, gx2, gy2, 1, 1);
        }
      }

      // --- 睡着的鱼头顶冒 zzz（m03755）
      // 用户要求：睡着后不再挂气泡，改为头顶冒 zzz。
      // 仍然走 D13.5 的手写点阵（m02671：头上冒出的东西不许用 AI 绘图）。
      // 一段漂移 + 一个拖尾，读感是"Z 一个接一个往上飘"，而不是钉在头顶的贴图。
      if (seat.activity === 'asleep' && !a.glyph && !a.glyph2 && !a.hidden && !a.fall) {
        var zs = glyphSize('zzz');
        if (zs.w > 0) {
          var drift = (ts % 2600) / 2600;
          var zAlpha = drift < 0.14 ? drift / 0.14 : (drift > 0.80 ? (1 - drift) / 0.20 : 1);
          if (zAlpha < 0.02) zAlpha = 0;
          var zx = Math.round(p.x + sw / 2 + Math.sin(ts / 1100) * 1);
          var zy = Math.round(p.y - 2 - drift * 9);
          drawGlyph(g, 'zzz', zx, zy, 2, zAlpha);
          drawGlyph(g, 'zzz', zx + 15, zy - 13, 1, zAlpha * 0.7);
        }
      }
    }
  }

  /**
   * 屏幕亮光。
   * 底图里电脑是息屏（深色面）。有人坐下才点亮：
   *   - working → 满亮 + 呼吸脉动
   *   - done / idle → 常亮但暗一档
   * 亮屏画面是 AI 出图里裁下来的真实屏幕像素（scene/screens/lit-*.png），
   * 按 seats.json 的暗面板矩形贴满；只在贴图缺失时才退回加色填充兜底。
   */
  /**
   * 屏幕亮灭状态机（规划 §4.1）。
   *
   * 底图上所有显示器都是息屏的，亮起来完全是这一层画上去的。
   * 关键几点不能省：
   *  · 人还在走（入场/离场途中）时屏幕必须是黑的 —— 要"坐下才亮"；
   *  · 开机/关机各 3 帧、约 100ms，黑 → 一条横线展开 → 全亮，别做瞬切；
   *  · 人走了亮度在 300ms 内衰减到黑，不是一闪就灭；
   *  · REPORTING 时滚动减速（280ms/帧），和 WORKING 的 140ms/帧区分开。
   *
   * 每条屏幕的亮度存在 S.screenLit[seatId]，是 0..1 的连续量，
   * 由这里按时间推进，保证"逐渐亮/逐渐灭"而不是布尔跳变。
   */
  var SCREEN_ON_MS = 100;    // 开机 3 帧 × 33ms
  var SCREEN_OFF_MS = 300;   // 关机亮度衰减

  function seatWantsScreen(seatId, ts) {
    var snap = S.snapshot;
    var act = S.act[seatId];
    if (!snap) return false;
    var seat = seatData(seatId);
    if (!seat || !seat.agentId) return false;

    // 走路途中、走到一半、被拖着、出逃、掉落 —— 一律黑屏
    if (act) {
      if (act.phase === 'grabbed' || act.phase === 'confused') return false;
      if (act.phase === 'walkhome' || act.phase === 'reenter') return false;
      if (act.phase === 'escaping' || act.phase === 'parade') return false;
      if (act.hidden || act.fall) return false;
    }
    // 入场还没走完。这里只看 walk 记录本身，不能附加 walk.ready / act.phase 条件：
    // 排队中（ready=false）的鱼一旦被跳过判定，就会立刻亮屏，等轮到它 ready 时
    // 又突然熄灭、走完再亮 —— 用户看到的就是「亮屏闪一下」。
    var walk = S.walkIns[seatId];
    if (walk) {
      if (!walk.ready) return false;   // 还在 enterQueue 里排队，一律黑屏
      var need = walkDur(walk);
      var k = need > 0 ? clamp((ts - walk.t0) / need, 0, 1) : 1;   // 关动画时 need=0，直接放行
      if (k < 1) return false;
    }
    // 已经离场的（done/error 坐着仍亮，但要人不在了才灭）
    if (seat.activity === 'empty') return false;
    return true;
  }

  /** 屏幕亮度推进：目标 0/1，按 SCREEN_ON_MS / SCREEN_OFF_MS 线性逼近。 */
  function stepScreenLit(ts) {
    var snap = S.snapshot;
    if (!snap) return;
    var dt = S.lastFrameTs ? Math.min(120, Math.max(0, ts - S.lastFrameTs)) : 16;
    var ids = ['main'];
    if (Array.isArray(snap.subs)) {
      for (var i = 0; i < snap.subs.length; i += 1) ids.push('sub:' + i);
    }
    for (var j = 0; j < ids.length; j += 1) {
      var id = ids[j];
      var cur = typeof S.screenLit[id] === 'number' ? S.screenLit[id] : 0;
      var want = seatWantsScreen(id, ts) ? 1 : 0;
      if (cur === want) continue;
      var rate = want > cur ? (dt / SCREEN_ON_MS) : (dt / SCREEN_OFF_MS);
      cur = want > cur ? Math.min(want, cur + rate) : Math.max(want, cur - rate);
      S.screenLit[id] = cur;
    }
  }

  /** 办公室里有鱼吗：任一工位坐着一条、且状态不是 empty。 */
  function hasAnyFish() {
    var snap = S.snapshot;
    if (!snap) return false;
    if (snap.main && snap.main.agentId && snap.main.activity !== 'empty') return true;
    if (Array.isArray(snap.subs)) {
      for (var i = 0; i < snap.subs.length; i += 1) {
        var s = snap.subs[i];
        if (s && s.agentId && s.activity !== 'empty') return true;
      }
    }
    return false;
  }

  /**
   * 灯光亮度推进：空场目标 0，有鱼目标 1，按 LAMP_ON_MS / LAMP_OFF_MS 线性逼近。
   * 风格与 stepScreenLit 完全一致：必须在本帧覆盖 lastFrameTs 之前调用。
   */
  function stepLampLit(ts) {
    var dt = S.lastFrameTs ? Math.min(120, Math.max(0, ts - S.lastFrameTs)) : 16;
    var cur = typeof S.lampLit === 'number' ? S.lampLit : 0;
    var want = hasAnyFish() ? 1 : 0;
    if (cur === want) return;
    var rate = want > cur ? (dt / LAMP_ON_MS) : (dt / LAMP_OFF_MS);
    cur = want > cur ? Math.min(want, cur + rate) : Math.max(want, cur - rate);
    S.lampLit = clamp(cur, 0, 1);
  }

  function drawScreens(g, ts) {
    var snap = S.snapshot;
    if (!snap) return;

    var paint = function (seatId, seat) {
      if (!seat || !seat.agentId) return;
      var lit = typeof S.screenLit[seatId] === 'number' ? S.screenLit[seatId] : 0;
      if (lit <= 0.001) return;   // 全黑就走了，一次 draw 都不花
      var r = screenRect(seatId);
      if (!r) return;

      var busy = seat.activity === 'working';
      var reporting = seat.activity === 'done';
      // 滚动节奏：WORKING 140ms/帧，REPORTING 280ms/帧（写汇报要慢下来）
      var frameMs = reporting ? TYPE_FRAME_MS * 2 : TYPE_FRAME_MS;
      var img = seatId === 'main' ? S.litMain : S.litSub;

      // 开机过渡：亮度 <1 时先把高度压成一条横线再长开，模拟“扫出来”
      var openK = lit < 1 && lit > 0 ? clamp(lit, 0, 1) : 1;
      var hh = Math.max(1, Math.round(r.h * openK));
      var yy = r.y + Math.round((r.h - hh) / 2);

      if (img) {
        // 亮屏贴图是**直接从 AI 亮屏版裁下来的整块屏幕像素**，不是带溢光的图层。
        // 实测两张 lit 图 alpha 全 255、边缘就是屏幕边框本身，所以不需要内缩：
        // 原来的 inx=2/iny=2 等于白扔 8.9% 的像素，而且 w/h 减掉的是**相同**像素数、
        // 分母不同，主屏（w≈54 h≈26）会被拉成 50/22，纵向比横向多压 10.59%，
        // 桌面图标和文字都被压扁。这里改为整块贴满，只保留开机过渡的 yy/hh。
        var alpha = (busy ? (0.85 + 0.15 * Math.sin(ts / 340)) : 0.72) * lit;
        g.save();
        g.globalAlpha = alpha;
        g.drawImage(img, r.x, yy, Math.max(1, r.w), Math.max(1, hh));
        g.restore();
      } else {
        // 兜底：无贴图时用加色混合画一块青色，深色底上才不会变成死板色块
        var base = busy ? 0.30 : 0.14;
        g.save();
        g.globalCompositeOperation = 'lighter';
        g.globalAlpha = base * lit * (busy ? (0.85 + 0.15 * Math.sin(ts / 340)) : 1);
        g.fillStyle = '#5ee6c8';
        g.fillRect(r.x, yy, r.w, hh);
        g.globalAlpha = base * lit * 0.35;
        g.fillRect(r.x - 2, yy - 1, r.w + 4, hh + 3);
        g.restore();
      }

      // WORKING / REPORTING 时叠一道扫描亮条上滚（纯代码绘制，跟着 frameMs 走）
      if (lit > 0.6 && (busy || reporting)) {
        var barH = Math.max(1, Math.round(r.h / 6));
        var travel = Math.max(1, r.h - barH);
        var ph = (ts % frameMs) / frameMs;
        var by = r.y + Math.round(travel * ph);
        g.save();
        g.globalCompositeOperation = 'lighter';
        g.globalAlpha = 0.16 * lit;
        g.fillStyle = '#4fd6bb';
        g.fillRect(r.x + 1, by, Math.max(1, r.w - 2), barH);
        g.restore();
      }
    };

    paint('main', snap.main);
    if (Array.isArray(snap.subs)) {
      snap.subs.forEach(function (seat, i) { paint('sub:' + i, seat); });
    }
  }

  /** 画所有在座角色（含入场走路）。 */
  /** 角色当前脚底 y（用于 z-order；走到半路、被拖拽时都要按真实位置排）。 */
  function actorFootY(seatId, pos, ts) {
    var a = S.act[seatId];
    var y = pos.y;
    if (a && a.pos) y = a.pos.y;
    var walk = S.walkIns[seatId];
    if (walk && walk.ready && a && a.phase === 'seated') {
      var need = walkDur(walk);
      var k = clamp((ts - walk.t0) / need, 0, 1);
      if (k < 1) y = walkPos(walk.path, walk.len * k).y;
    }
    if (a && (a.phase === 'walkhome' || a.phase === 'reenter') && a.walkPath && a.walkLen > 0) {
      var kk = walkProgress(a.walkT0, a.walkLen, ts);
      y = walkPos(a.walkPath, a.walkLen * kk).y;
    }
    return y;
  }

  function drawActors(g, ts) {
    var snap = S.snapshot;
    if (!snap) return;

    var items = [];
    if (snap.main && snap.main.agentId) {
      var mp = seatPosition('main');
      if (mp) items.push({ seatId: 'main', seat: snap.main, pos: mp });
    }
    if (Array.isArray(snap.subs)) {
      snap.subs.forEach(function (seat, i) {
        if (!seat || !seat.agentId) return;
        var p = seatPosition('sub:' + i);
        if (p) items.push({ seatId: 'sub:' + i, seat: seat, pos: p });
      });
    }

    var doc = S.seatsDoc;
    // z-order：按"当前真实脚底 y"升序，同 y 按 x 升序（不做透视矩阵）。
    // 用真实位置而不是座位坐标，这样走道里交错时前后关系才对（m02951 头身分离问题的一半来源）。
    items.sort(function (a, b) {
      var ah = a.pos.kind === 'main' ? 51 : 37;
      var bh = b.pos.kind === 'main' ? 51 : 37;
      var ay = actorFootY(a.seatId, a.pos, ts) + ah;
      var by = actorFootY(b.seatId, b.pos, ts) + bh;
      return (ay - by) || (a.pos.x - b.pos.x);
    });

    items.forEach(function (item) { drawActor(g, item, ts); });
    void doc;
  }

  // -------------------------------------------------------------------------
  // D13.5 头顶符号与特效：全部代码绘制
  // 用户硬约束（m02671）：头上冒出的东西不要用 AI 绘图。
  // -------------------------------------------------------------------------

  /**
   * 画一个点阵符号。
   * @param {CanvasRenderingContext2D} g
   * @param {string} name GLYPHS 的键
   * @param {number} x 左上角 x（逻辑坐标）
   * @param {number} y 左上角 y（逻辑坐标）
   * @param {number} scale 每格放大倍数（1 = 原始像素）
   * @param {number} alpha 透明度
   */
  function drawGlyph(g, name, x, y, scale, alpha) {
    var rows = GLYPHS[name];
    if (!rows || !rows.length) return;
    var s = scale || 1;
    var a = alpha === undefined ? 1 : alpha;
    g.save();
    g.globalAlpha = a;

    // 第一遍：给所有实心格向外扩 1 格画深色/浅色描边，保证在任意底色上都读得清。
    g.fillStyle = '#0d0a14';
    for (var pass = 0; pass < 2; pass += 1) {
      for (var r = 0; r < rows.length; r += 1) {
        var line = rows[r];
        for (var c = 0; c < line.length; c += 1) {
          var ch = line[c];
          if (ch === '.' || ch === ' ') continue;
          if (pass === 0) {
            g.fillRect(Math.round(x + (c - 1) * s), Math.round(y + (r - 1) * s), s, s);
            g.fillRect(Math.round(x + (c + 1) * s), Math.round(y + (r - 1) * s), s, s);
            g.fillRect(Math.round(x + (c - 1) * s), Math.round(y + (r + 1) * s), s, s);
            g.fillRect(Math.round(x + (c + 1) * s), Math.round(y + (r + 1) * s), s, s);
          } else {
            g.fillStyle = PALETTE[ch] || '#fdf6e3';
            g.fillRect(Math.round(x + c * s), Math.round(y + r * s), s, s);
          }
        }
      }
      if (pass === 0) g.fillStyle = '#0d0a14';
    }
    g.restore();
  }

  /** 符号的像素尺寸（用于居中定位）。 */
  function glyphSize(name) {
    var rows = GLYPHS[name];
    if (!rows || !rows.length) return { w: 0, h: 0 };
    var w = 0;
    for (var i = 0; i < rows.length; i += 1) w = Math.max(w, rows[i].length);
    return { w: w, h: rows.length };
  }

  /**
   * 烟雾：不用图片。
   * 8px 网格上撒方块团，从中心向外扩散 + 透明度衰减。
   * @param {number} t 0→1（0=刚起，1=散尽）
   * @param {number} [dir] -1 = 反向（散开），默认 1（聚起）
   */
  function drawSmoke(g, cx, cy, radius, t, dir) {
    var k = dir === -1 ? 1 - t : t;   // 反向时把时间折回来
    var spread = radius * (0.35 + 0.9 * k);
    var fade = dir === -1 ? (1 - t) : (t < 0.5 ? t * 2 : 1);
    var cols = ['#cfc6e0', '#a99fc0', '#7d7396'];
    g.save();
    for (var i = 0; i < 14; i += 1) {
      // 固定伪随机，保证每帧形状稳定不抖
      var ang = (i * 2.399963) % (Math.PI * 2);
      var rr = spread * (0.35 + 0.65 * ((i * 37) % 100) / 100);
      var px = Math.round((cx + Math.cos(ang) * rr) / 4) * 4;
      var py = Math.round((cy + Math.sin(ang) * rr * 0.8) / 4) * 4;
      var sz = 4 + ((i * 13) % 3) * 4;
      g.globalAlpha = Math.max(0, Math.min(1, fade)) * (0.55 + 0.3 * ((i * 7) % 100) / 100);
      g.fillStyle = cols[i % cols.length];
      g.fillRect(px - sz / 2, py - sz / 2, sz, sz);
    }
    g.restore();
  }

  /** 地面裂纹：从落点向外画折线，长度随 t 从 4px 扩到 R。 */
  function drawCrack(g, cx, cy, R, t) {
    var reach = 4 + (R - 4) * t;
    g.save();
    g.lineWidth = 1;
    for (var i = 0; i < 5; i += 1) {
      var ang = (-Math.PI * 0.9) + i * (Math.PI * 1.8 / 4) + 0.22;
      var steps = 4;
      var x = cx;
      var y = cy;
      g.strokeStyle = '#0d0a14';
      g.beginPath();
      g.moveTo(x, y);
      for (var s = 1; s <= steps; s += 1) {
        var seg = (reach * s) / steps;
        var jitter = (s % 2 === 0 ? 1 : -1) * (1 + (i % 3));
        x = cx + Math.cos(ang) * seg + jitter;
        y = cy + Math.sin(ang) * seg * 0.55 + jitter * 0.5;
        g.lineTo(Math.round(x), Math.round(y));
      }
      g.stroke();
    }
    g.restore();
  }

  // -------------------------------------------------------------------------
  // D13.1 朝向与转身
  // -------------------------------------------------------------------------

  /**
   * 朝向 → 横向缩放。
   *
   * 早期侧视帧是"正面帧硬掰成侧面"的替代品，所以要 0.58 收窄才不显得胖。
   * 现在 `stand-side-*` / `main-walkside-*` / `subs/walk-side/*` 本身就是画好的
   * 侧身 sprite，再压 0.58 就是横向挤扁 —— 用户说的「在办公室中走路有畸变」
   * (m00343 第三条) 正是这个系数造成的。三向一律 1。
   */
  var FACING_SCALE = { back: 1, front: 1, side: 1 };

  function ensureAct(seatId) {
    var a = S.act[seatId];
    if (a) return a;
    a = {
      facing: 'back',
      turn: null,        // {t0, from, to}
      phase: 'seated',   // seated|grabbed|confused|walkhome|reenter|falling|escaping|parade
      phT0: 0,
      pos: null,         // 被拖走/懵逼时的覆盖位置（逻辑坐标）
      walkPath: null,    // 回家/出画的折线
      walkLen: 0,
      walkT0: 0,
      walkDir: 'up',
      dbl: 0,            // 双击级数 1..3
      lastUp: 0,
      lastX: 0,
      lastY: 0,
      busyUntil: 0,      // 互动动画期间忽略新的双击
      glyph: null,       // {name, t0, dur, dx, dy}
      smoke: null,       // {t0, dur, cx, cy, r, dir}
      crack: null,       // {t0, cx, cy, r}
      hop: null,         // {t0, n, baseY, landT}
      fall: null,        // {t0, y, vy, floorY, bounced}
      shakeUntil: 0,
      hidden: false,
      blinkAt: 0,
      blinkT0: 0,
      sitT0: 0,          // 就地坐下动画起点
      esc: false,        // 彩蛋：空格拖出后就地待机不回家
      escX: 0,
      escY: 0,
      sideMirror: false, // side 朝向是否镜像（朝左）
    };
    S.act[seatId] = a;
    return a;
  }

  /** 转身：from → to，走一程 TURN_MS。 */
  function startTurn(a, to, ts) {
    if (a.facing === to) return;
    a.turn = { t0: ts, from: a.facing, to: to };
    a.facing = to;
  }

  /** 立即到位（不做动画）。 */
  function setFacingNow(a, to) {
    a.facing = to;
    a.turn = null;
  }

  /** 转身进度：返回 {from, to, k}，k=1 表示动画结束。 */
  function turnProgress(a, ts) {
    if (!a.turn) return { from: a.facing, to: a.facing, k: 1 };
    var k = clamp((ts - a.turn.t0) / TURN_MS, 0, 1);
    if (k >= 1) {
      var done = a.turn;
      a.turn = null;
      return { from: done.to, to: done.to, k: 1 };
    }
    return { from: a.turn.from, to: a.turn.to, k: k };
  }

  /**
   * 该角色此刻是否处于"站着"状态。
   *
   * 站着 = 被拖拽中 / 懵框中 / 走到面板外 / 出逃排队，共同点是都不该用坐姿帧：
   * 坐姿帧的腿是折起来的，一路"坐"着被人拎着走、或者"坐"着走出面板，读感就很怪。
   * 这些状态下改用站立全身帧（主鱼 stand-*、副角 walk-side），尺寸与坐姿齐平。
   */
  function standingFor(seatId) {
    var a = S.act[seatId];
    if (!a) return false;
    return a.phase === 'grabbed' || a.phase === 'confused' ||
           a.phase === 'walkhome' || a.phase === 'reenter' ||
           a.phase === 'escaping';
  }

  /**
   * 取某个座位在指定朝向下的帧（缺失自动回落背面）。
   * @param {boolean} [standing] 站立态（被拖拽 / 走到面板外）：主鱼改用站姿全身帧。
   */
  function frameFor(seatId, seat, facing, ts, standing) {
    var isMain = seatId === 'main';
    var a = S.act[seatId];
    if (isMain) {
      var F = S.mainFrames;
      // 空格彩蛋「就地坐下」：用专门生成的盘腿坐地帧（m05088 第 1 条）。
      // 条件是 esc 且没有 walkPath（有 walkPath 说明正在被彩蛋队列带走）。
      // 旧的 sit-floor/floor-1.png 是圆球胖鱼造型的瘫坐帧，不能再用。
      if (a && a.esc && !a.walkPath && S.mainFloor.length) return S.mainFloor[0];
      // 站着（被拖拽 / 走出面板）：用站姿全身帧，尺寸与坐姿齐平，
      // 否则一抓起来换图就"突然缩小"（用户 m03606 第一条）。
      if (standing) {
        if (facing === 'side' && S.mainStandSide.length) return S.mainStandSide[0];
        if (facing === 'front' && S.mainStandFront.length) return S.mainStandFront[0];
      }
      // 睡着（m04641）：主鱼和副鱼同一套姿势，侧身蜷缩在工位、脸朝屏幕。
      // 必须排在 front/side 之前 —— 睡着时朝向可能还是互动残留的 front，
      // 若走下面的分支就会画出坐姿而不是睡姿。也只用于「坐着睡」：
      // 被拖起来 / 走到画布外时 standing=true，上面已经先返回站姿帧了。
      if (seat && seat.activity === 'asleep' && S.mainSleep.length) return S.mainSleep[0];
      if (facing === 'front' && S.mainFront.length) return S.mainFront[0];
      if (facing === 'side' && S.mainSide.length) return S.mainSide[0];
      // 背面：按活动状态选帧
      if (seat && seat.activity === 'working') {
        var tf = (F.type && F.type.length) ? F.type : F.sit;
        return tf[Math.floor(ts / TYPE_FRAME_MS) % tf.length] || null;
      }
      if (seat && seat.activity === 'done') return (F.poseDone && F.poseDone[0]) || (F.sit && F.sit[0]) || null;
      if (seat && seat.activity === 'error') return (F.poseThinking && F.poseThinking[0]) || (F.sit && F.sit[0]) || null;
      if (seat && seat.activity === 'asleep') return (F.poseAsleep && F.poseAsleep[0]) || (F.sit && F.sit[0]) || null;
      var sf = (F.sit && F.sit.length) ? F.sit : F.poseIdle;
      return (sf && sf.length) ? sf[Math.floor(ts / IDLE_FRAME_MS) % sf.length] : null;
    }
    var idx = skinOf(seatId, seat);
    // 空格彩蛋「就地坐下」：副角的 sit-floor 那 8 张本来就是人形坐地帧，
    // 比正面站姿矮一截，正好读作「坐在地上、等人来齐」。没有就回落正面帧。
    if (a && a.esc && !a.walkPath && S.subFloor[idx]) return S.subFloor[idx];
    // 站着（被拖拽 / 走出面板）：
    //   · 只有**真在横着走**时才用侧面行走帧（facing === 'side'）——
    //     曾经无条件用 S.subWalk，于是鼠标一按下（standing=true、facing 还是 back）
    //     就把坐姿帧换成侧面行走帧，而两套帧尺寸差极大：m5-sporty 坐姿 26×40
    //     满幅、行走帧 26×26 且墨迹只有 13×23，画出来就是「一抓就缩一半」，
    //     用户说的「副鱼被拖动后突然缩小」就是这里（m03550 第一条）。
    //   · 其余情况继续用坐姿帧，抓起来只是"被拎起来"，尺寸完全不跳变。
    if (standing && facing === 'side' && S.subWalk[idx]) return S.subWalk[idx];
    // 睡着（m03755）：侧身蜷缩在工位上、脸朝屏幕。这一帧只用于「坐着睡」，
    // 所以放在 standing 之后 —— 被拖起来或者走到面板外时仍是站姿。
    if (seat && seat.activity === 'asleep' && S.subSleep[idx]) return S.subSleep[idx];
    if (facing === 'front' && S.subFront[idx]) return S.subFront[idx];
    if (facing === 'side' && S.subSide[idx]) return S.subSide[idx];
    return S.subSkins[idx] || null;
  }

  /**
   * 画角色 sprite（含朝向与转身过渡）。
   * 转身过渡：旧朝向按 scaleX 收窄 + 淡出，新朝向按 scaleX 展开 + 淡入，
   * 两张同时画在同一个脚底锚点上，读感就是"原地转过身"。
   */
  function drawFacingSprite(g, seatId, seat, x, y, ts, normY) {
    var a = ensureAct(seatId);
    var tr = turnProgress(a, ts);
    var stand = standingFor(seatId);
    var isMain = seatId === 'main';
    // 等高等比归一化（m05088 第 3 条）：每张帧的系数不同（正面矮、背面高），
    // 所以按各自 img 现算；缩放由 drawSpriteScaled 的 sy 承担，
    // 再把 y 上移 h*(k-1)，脚底就钉在原地不外扩。
    function kyOf(img) { return (!img || isMain) ? (normY || 1) : subFrameNorm(seatId, img); }
    function yOf(img, k) { return (k > 1) ? y - Math.round(img.height * (k - 1)) : y; }
    if (tr.k === 1 || tr.from === tr.to) {
      var img1 = frameFor(seatId, seat, a.facing, ts, stand);
      if (!img1) return null;
      var sc1 = (a.facing === 'side') ? FACING_SCALE.side : 1;
      var mir = a.facing === 'side' && a.sideMirror;
      var k1 = kyOf(img1);
      drawSpriteScaled(g, img1, x, yOf(img1, k1), sc1, 1, mir, k1);
      return img1;
    }
    var fromImg = frameFor(seatId, seat, tr.from, ts, stand);
    var toImg = frameFor(seatId, seat, tr.to, ts, stand);
    var fromS = (tr.from === 'side') ? FACING_SCALE.side : 1;
    var toS = (tr.to === 'side') ? FACING_SCALE.side : 1;
    var kf = kyOf(fromImg);
    var kt = kyOf(toImg);
    if (fromImg) drawSpriteScaled(g, fromImg, x, yOf(fromImg, kf), lerp(fromS, toS * 0.9, tr.k), 1 - tr.k * 0.35, false, kf);
    if (toImg) drawSpriteScaled(g, toImg, x, yOf(toImg, kt), lerp(fromS * 0.9, toS, tr.k), tr.k, false, kt);
    return toImg || fromImg;
  }

  // -------------------------------------------------------------------------
  // D13.2 / D13.3 / D13.4 交互：拖拽、双击三级、空格彩蛋
  // -------------------------------------------------------------------------

  /**
   * 视口坐标 → 场景逻辑坐标的宽松版：**允许越出 canvas**。
   * 逻辑坐标可以是负数或超过 scene.w/h，拖拽时要靠它把鱼带到面板外面。
   */
  function toLogicalLoose(clientX, clientY) {
    if (!cv || !S.seatsDoc) return null;
    var r = cv.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    var sx = S.seatsDoc.scene.w / r.width;
    var sy = S.seatsDoc.scene.h / r.height;
    return { x: (clientX - r.left) * sx, y: (clientY - r.top) * sy };
  }

  /** 视口坐标 → 场景逻辑坐标（越界返回 null）。命中判定与"松手是否在办公室内"用它。 */
  function toLogical(clientX, clientY) {
    if (!cv || !S.seatsDoc) return null;
    var r = cv.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return null;
    return toLogicalLoose(clientX, clientY);
  }

  /** 场景逻辑坐标 → 视口坐标（CSS 像素）。天空浮层画面板外的角色时用。 */
  function logicalToView(x, y) {
    if (!cv || !S.seatsDoc) return null;
    var r = cv.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    var sx = r.width / S.seatsDoc.scene.w;
    var sy = r.height / S.seatsDoc.scene.h;
    return { x: r.left + x * sx, y: r.top + y * sy, sx: sx, sy: sy };
  }

  /**
   * 角色是否已越出 canvas 矩形。
   * canvas 会裁掉超界像素，被拖到面板外的鱼必须改由天空浮层绘制，
   * 否则用户看就是"鱼拖不出去 / 一出去就消失"（m03606 第三条）。
   */
  function isOutOfCanvas(seatId, ts) {
    var a = S.act[seatId];
    if (!a || !a.pos) return false;
    var b = actorBox(seatId, ts);
    if (!b) return false;
    var doc = S.seatsDoc;
    return (b.x < 0) || (b.y < 0) || (b.x + b.w > doc.scene.w) || (b.y + b.h > doc.scene.h);
  }

  /** 角色当前 bbox（逻辑坐标）。 */
  function actorBox(seatId, ts) {
    var a = S.act[seatId];
    var p = (a && a.pos) ? a.pos : seatPosition(seatId);
    if (!p) return null;
    var doc = S.seatsDoc;
    var isMain = seatId === 'main';
    var img = frameFor(seatId, seatData(seatId), (a && a.facing) || 'back', ts, standingFor(seatId));
    var w = img ? img.width : (isMain ? doc.spriteSize.main : doc.spriteSize.sub);
    var h = img ? img.height : (isMain ? 51 : 37);
    if (a && a.facing === 'side') w = Math.round(w * FACING_SCALE.side);
    return { x: p.x, y: p.y, w: w, h: h };
  }

  /** 命中检测：返回 z-order 最上者的 seatId。 */
  function hitTest(clientX, clientY, ts) {
    var p = toLogical(clientX, clientY);
    if (!p) return null;
    var snap = S.snapshot;
    if (!snap) return null;
    var cands = [];
    var push = function (seatId, seat) {
      if (!seat || !seat.agentId) return;
      var a = S.act[seatId];
      if (a && a.hidden) return;
      // 排队还没进门的鱼不参与命中（人还在门外，画面上没它）
      var w = S.walkIns[seatId];
      if (w && !w.ready) return;
      var b = actorBox(seatId, ts);
      if (!b) return;
      if (p.x >= b.x - 2 && p.x <= b.x + b.w + 2 && p.y >= b.y - 2 && p.y <= b.y + b.h + 2) {
        cands.push({ seatId: seatId, z: b.y + b.h, x: b.x });
      }
    };
    push('main', snap.main);
    if (Array.isArray(snap.subs)) {
      snap.subs.forEach(function (seat, i) { push('sub:' + i, seat); });
    }
    if (!cands.length) return null;
    cands.sort(function (m, n) { return (n.z - m.z) || (n.x - m.x); });
    return cands[0].seatId;
  }

  /**
   * 从任意落点（含被拖到面板外的点）走回目标座位。
   *
   * 直接连会横穿整排桌子（用户 m03606「看起来像从过道走过去的，不是飞过去」），
   * 所以交给 navRoute 在脚底网格上跑 A*：绕障是搜出来的，不是规定出来的。
   * 落点在面板外（x 负、y 超界）时也成立：寻路网格外的点会被吸附到最近可站格，
   * 第一段读感是"从屏幕外走回画面内"。
   */
  function planPathFrom(from, target, spriteH, spriteW) {
    return navRoute(
      { x: Math.round(from.x), y: Math.round(from.y) },
      { x: Math.round(target.x), y: Math.round(target.y) },
      spriteW,
      spriteH || 37
    );
  }

  function dedupePath(pts) {
    var out = [pts[0]];
    for (var j = 1; j < pts.length; j += 1) {
      var q = out[out.length - 1];
      if (q.x !== pts[j].x || q.y !== pts[j].y) out.push(pts[j]);
    }
    return out;
  }

  /**
   * 走到门口并出画的折线。
   * 用 navRoute 走到门口下方的出画点，天然绕开所有工位；
   * 最后补一段竖直出画，保证人物是笔直穿过门洞离开，而不是斜着飘出去。
   */
  function planPathToDoor(from, spriteH, spriteW) {
    var doc = S.seatsDoc;
    var sh = spriteH || 37;
    var sw = spriteW || 26;
    var doorX = Math.round(doc.door.x + doc.door.w / 2 - sw / 2);
    var exitY = doc.scene.h + 6;
    var pts = navRoute(
      { x: Math.round(from.x), y: Math.round(from.y) },
      { x: doorX, y: Math.round(doc.door.y - sh) },
      sw,
      sh
    );
    pts.push({ x: doorX, y: exitY });
    return dedupePath(pts);
  }

  /** 朝某个方向设置朝向（side 时根据左右决定镜像）。 */
  function faceToward(a, dir) {
    if (dir === 'left' || dir === 'right') {
      a.sideMirror = dir === 'left';
      startTurn(a, 'side', performance.now());
    } else if (dir === 'up') {
      startTurn(a, 'back', performance.now());
    } else {
      startTurn(a, 'front', performance.now());
    }
  }

  function setGlyph(seatId, name, dur, dx, dy) {
    var a = ensureAct(seatId);
    a.glyph = { name: name, t0: performance.now(), dur: dur, dx: dx || 0, dy: dy || 0 };
  }

  function smokeAt(seatId, dur, dir) {
    var a = ensureAct(seatId);
    var p = actorDrawPos(seatId);
    if (!p) return;
    var doc = S.seatsDoc;
    var isMain = seatId === 'main';
    var sw = isMain ? doc.spriteSize.main : doc.spriteSize.sub;
    var sh = isMain ? 46 : 34;
    a.smoke = {
      t0: performance.now(),
      dur: dur || SMOKE_MS,
      cx: p.x + sw / 2,
      cy: p.y + sh / 2,
      r: Math.max(sw, sh) * 0.9,
      dir: dir || 1,
    };
  }

  /** 开始懵逼：1s 后按 in/out 分叉。 */
  function startConfuse(seatId, outside) {
    var a = ensureAct(seatId);
    a.phase = 'confused';
    a.phT0 = performance.now();
    a.shakeUntil = performance.now() + CONFUSE_MS;
    setGlyph(seatId, 'question', CONFUSE_MS + 200, 0, 0);
    a.confuseOutside = !!outside;
    // 朝向：全部转正面朝观众（用户 m05088 第 2 条：副鱼拖出来懵逼状态没有转过来正面面对）。
    // 曾经副鱼保持背面，是因为副鱼正面帧只有 26×24~26×30、比背面帧 26×37~41 矮一大截，
    // 一松手切正面就会二次缩小。现在绘制侧有 subFrameNorm 做等高等比归一化，
    // 任何朝向都拉到同一基准高，所以可以放心转正面。
    setFacingNow(a, 'front');
  }

  /** 懵逼结束，决定回家路线。 */
  /**
   * 从画布外经门洞走进工位的折线。
   *
   * 起点固定在 `scene.h + 6`（门下方、画布外），先竖直穿过门洞到门口站位，
   * 再交给 A* 绕障走到工位。分三段是必须的：第一段保证"从门口进来"这件事
   * 看得见，后一段保证不压桌沿。
   *
   * @param {{x:number,y:number}} [from] 松手落点。给了就把落点接在折线最前面，
   *   让鱼「原地垂直落出画布 → 沿画布外底部走到门口 → 穿门进来」，
   *   而不是从落点直接瞬移到门外（那是用户 m03550 第 2 条说的"直接瞬移回去"）。
   */
  function planPathFromDoorIn(seatId, target, from) {
    var doc = S.seatsDoc;
    if (!doc || !target) return null;
    var spriteW = target.kind === 'main' ? doc.spriteSize.main : doc.spriteSize.sub;
    var sh = spriteHeightFor(seatId);
    var doorCx = Math.round(doc.door.x + doc.door.w / 2 - spriteW / 2);
    var doorTopY = Math.round(doc.door.y - sh);
    var exitY = doc.scene.h + 6;
    var inPath = navRoute(
      { x: doorCx, y: doorTopY },
      { x: Math.round(target.x), y: Math.round(target.y) },
      spriteW,
      sh
    );
    var head = [];
    if (from && typeof from.x === 'number' && typeof from.y === 'number') {
      var fx = Math.round(from.x);
      var fy = Math.round(from.y);
      head.push({ x: fx, y: fy });
      // 先**原地竖直**落到出画线，再横向走到门口正下方 —— 两段都必须纯轴向。
      // 少了中间那一点就会变成 (落点)→(门口) 的一条长斜线（用户说的"斜着飘/瞬移"）。
      head.push({ x: fx, y: exitY });
      head.push({ x: doorCx, y: exitY });
    } else {
      head.push({ x: doorCx, y: exitY });
    }
    head.push({ x: doorCx, y: doorTopY });
    return dedupePath(head.concat(inPath));
  }

  function resolveConfuse(seatId, ts) {
    var a = S.act[seatId];
    if (!a) return;
    void ts;
    var target = seatPosition(seatId);
    if (!target) { a.phase = 'seated'; a.pos = null; return; }
    var from = a.pos || target;
    var doc = S.seatsDoc;
    var isMain = seatId === 'main';
    var sw = doc ? (isMain ? doc.spriteSize.main : doc.spriteSize.sub) : 26;
    if (a.confuseOutside) {
      // 松手时已经在画布外：落点接在折线最前面，鱼会先原地落出到画布外底部、
      // 再沿画布外走到门口正下方、竖直穿门进来。以前这里直接把起点写死成门外，
      // 落点被丢弃 —— 用户看到的就是"直接瞬移回去了"（m03550 第 2 条）。
      var scene = doc ? doc.scene : null;
      var shBox = spriteHeightFor(seatId);
      // 判据必须用包围盒，不能只判左上角：鱼宽 26、被拖到天花板时 y 可能还是正的，
      // 但整个身子已经出画了（以前只判 from.y < 0，于是斜插回工位，m03550 第 2 条）。
      var outside = scene && (
        from.x < 0 || from.y < 0 ||
        from.x + sw > scene.w || from.y + shBox > scene.h
      );
      if (outside) {
        var inOnly = planPathFromDoorIn(seatId, target, from);
        if (inOnly) {
          a.walkPath = inOnly;
          a.walkLen = pathLen(inOnly);
          a.walkT0 = performance.now();
          a.phase = 'reenter';
          a.reenterStage = 'in';
          setFacingNow(a, 'back');
          return;
        }
      }
      // 在画布内但拖到面板外松手：先走到门口出画，再从门口走回来
      var out = planPathToDoor(from, spriteHeightFor(seatId), sw);
      a.walkPath = out;
      a.walkLen = pathLen(out);
      a.walkT0 = performance.now();
      a.phase = 'reenter';
      a.reenterStage = 'exit';
    } else {
      var home = planPathFrom(from, target, spriteHeightFor(seatId), sw);
      a.walkPath = home;
      a.walkLen = pathLen(home);
      a.walkT0 = performance.now();
      a.phase = 'walkhome';
    }
  }

  /**
   * 解除空格彩蛋：就地坐地的鱼被双击后站起来、走回自己的工位。
   *
   * 路线与懵逼结束（resolveConfuse）同一套，因为两种情形在几何上完全一样：
   *   · 落点在画布外 → 先原地落出画布底、沿画布外走到门口正下方、竖直穿门进来；
   *   · 落点在画布内 → 交给 navRoute 绕开桌椅走回工位。
   * 早期版本想「直接 set 回 seated」，鱼就瞬移回工位了 —— 这正是 m03550 第 2 条
   * 抱怨过的表现，所以这里一律走折线。
   *
   * @returns {boolean} 是否真的解除了（本来就 esc=false 时返回 false）。
   */
  function releaseEsc(seatId) {
    var a = S.act[seatId];
    if (!a || !a.esc) return false;
    var doc = S.seatsDoc;
    var target = seatPosition(seatId);
    var from = a.pos || { x: a.escX, y: a.escY };

    // 先把彩蛋标记清干净：坐地帧、出逃槽位、抖动、符号都不该带进回家路。
    a.esc = false;
    a.escSlotX = 0;
    a.escFeetY = 0;
    a.sitT0 = 0;
    a.glyph = null;
    a.shakeUntil = 0;
    a.dbl = 0;
    a.busyUntil = 0;

    if (!target || !doc) {
      a.phase = 'seated';
      a.pos = null;
      setFacingNow(a, 'back');
      return true;
    }
    var isMain = seatId === 'main';
    var sw = isMain ? doc.spriteSize.main : doc.spriteSize.sub;
    var sh = spriteHeightFor(seatId);
    var sc = doc.scene;
    // 判外与 resolveConfuse 一致：必须看包围盒，不能只看左上角。
    var outside = !sc || (
      from.x < 0 || from.y < 0 ||
      from.x + sw > sc.w || from.y + sh > sc.h
    );
    var path = null;
    if (outside) {
      path = planPathFromDoorIn(seatId, target, from);
      if (path) {
        a.walkPath = path;
        a.walkLen = pathLen(path);
        a.walkT0 = performance.now();
        a.phase = 'reenter';
        a.reenterStage = 'in';
        setFacingNow(a, 'back');
        return true;
      }
    }
    path = planPathFrom(from, target, sh, sw);
    if (!path) {
      a.phase = 'seated';
      a.pos = null;
      setFacingNow(a, 'back');
      return true;
    }
    a.walkPath = path;
    a.walkLen = pathLen(path);
    a.walkT0 = performance.now();
    a.phase = 'walkhome';
    setFacingNow(a, 'back');
    return true;
  }

  /**
   * 视口坐标命中「就地坐地的彩蛋鱼」。
   *
   * hitTest 用的 toLogical() 在画布外返回 null，所以被拖到面板外的鱼根本点不到；
   * 而空格彩蛋的鱼大多数时候恰好就在面板外。解除操作必须能覆盖这种情形，
   * 于是单开一个只认 esc 态的命中函数：换算走 toLogicalLoose（允许越界），
   * 包围盒与面板内同一套 actorBox，z 用脚底线。
   *
   * 命中范围比 hitTest 的 ±2 放宽到 ±4：坐地帧会叠加 walkFootFix/sitDrop 的
   * 竖向补偿，实际看到的矩形和 a.pos 能差几个像素，严格贴合会点不中脚底。
   */
  function hitEscAt(clientX, clientY, ts) {
    var p = toLogicalLoose(clientX, clientY);
    if (!p) return null;
    var ids = Object.keys(S.act);
    var best = null;
    for (var i = 0; i < ids.length; i += 1) {
      var id = ids[i];
      var a = S.act[id];
      if (!a || !a.esc || a.hidden || !a.pos) continue;
      // 排队还没进门的席位画面上没人，不该被点到
      var w = S.walkIns[id];
      if (w && !w.ready) continue;
      var b = actorBox(id, ts);
      if (!b) continue;
      if (p.x >= b.x - 4 && p.x <= b.x + b.w + 4 &&
          p.y >= b.y - 4 && p.y <= b.y + b.h + 4) {
        var z = b.y + b.h;
        if (!best || z > best.z) best = { seatId: id, z: z };
      }
    }
    return best ? best.seatId : null;
  }

  /**
   * 承载「双击解除彩蛋」的窗口级监听。
   *
   * 为什么必须挂在 window 上：面板外的鱼由天空浮层绘制，而浮层是
   * pointer-events:none，canvas 自身的事件也只在指针落进它的矩形内才触发。
   * 这里只在**指针不在 canvas 内**时接手（面板内的命中仍由 canvas 的
   * pointerdown → endGrab → onTap 处理），且只做观察，不 preventDefault、
   * 不 stopPropagation，不会干扰宿主 UI。
   */
  function bindEscRelease() {
    S.onEscDown = function (e) {
      if (e.button !== undefined && e.button !== 0) return;
      if (S.parade) return;
      var now = performance.now();
      // 面板内交给 canvas 自己的链路，避免同一次按下被判定两次
      if (toLogical(e.clientX, e.clientY)) return;
      var seatId = hitEscAt(e.clientX, e.clientY, now);
      if (!seatId) return;
      var a = S.act[seatId];
      if (!a) return;
      var near = Math.abs(e.clientX - a.lastX) + Math.abs(e.clientY - a.lastY) < DBL_SLOP * 2;
      if (now - a.lastUp < DBL_MS && near) {
        a.lastUp = 0;
        a.lastX = 0;
        a.lastY = 0;
        releaseEsc(seatId);
        return;
      }
      a.lastUp = now;
      a.lastX = e.clientX;
      a.lastY = e.clientY;
    };
    window.addEventListener('pointerdown', S.onEscDown, true);
  }

  // --- 双击三级互动 ---------------------------------------------------------

  function doDoubleClick(seatId) {
    var a = ensureAct(seatId);
    var now = performance.now();
    if (now < a.busyUntil) return;
    // 空格彩蛋的鱼：双击 = 解除彩蛋、走回工位，不再演三级互动。
    // 三级互动是「在工位上原地」演的，而 esc 的鱼坐在地上/面板外，
    // 演起来会又飘又错位，用户要的也是「解除」这个语义。
    if (a.esc) {
      releaseEsc(seatId);
      return;
    }
    a.dbl = (a.dbl % 3) + 1;
    if (a.dbl === 1) levelOne(seatId, now);
    else if (a.dbl === 2) levelTwo(seatId, now);
    else levelThree(seatId, now);
  }

  /** 第 1 级：转过来 + 爱心 + 2s 后转回去。 */
  function levelOne(seatId, now) {
    var a = ensureAct(seatId);
    setFacingNow(a, 'back');
    startTurn(a, 'front', now);
    a.busyUntil = now + 2600;
    setTimeout(function () {
      if (S.dead || !S.act[seatId]) return;
      setGlyph(seatId, 'heart', 1900, 0, 0);
    }, 340);
    setTimeout(function () {
      if (S.dead || !S.act[seatId]) return;
      startTurn(S.act[seatId], 'back', performance.now());
    }, 2400);
  }

  /** 第 2 级：转身 → 烟雾消失 → 2s → 烟雾出现 + 🤓👆🏻 → 转回。 */
  function levelTwo(seatId, now) {
    var a = ensureAct(seatId);
    setFacingNow(a, 'back');
    startTurn(a, 'front', now);
    a.busyUntil = now + 5600;

    setTimeout(function () {
      if (S.dead) return;
      smokeAt(seatId, SMOKE_MS, 1);
    }, 360);
    setTimeout(function () {
      if (S.dead || !S.act[seatId]) return;
      S.act[seatId].hidden = true;
    }, 760);
    setTimeout(function () {
      if (S.dead) return;
      smokeAt(seatId, SMOKE_MS, -1);
    }, 2760);
    setTimeout(function () {
      if (S.dead || !S.act[seatId]) return;
      S.act[seatId].hidden = false;
      S.act[seatId].facing = 'front';
      setGlyph(seatId, 'nerd', 2000, -6, 0);
      setGlyph2(seatId, 'pointUp', 2000, 7, 2);
    }, 2820);
    setTimeout(function () {
      if (S.dead || !S.act[seatId]) return;
      startTurn(S.act[seatId], 'back', performance.now());
    }, 4900);
  }

  /** 同时挂两个符号（🤓 + 👆🏻）。 */
  function setGlyph2(seatId, name, dur, dx, dy) {
    var a = ensureAct(seatId);
    a.glyph2 = { name: name, t0: performance.now(), dur: dur, dx: dx || 0, dy: dy || 0 };
  }

  /** 第 3 级：跳 3 次 → 裂纹 → 掉落 → 触底反弹 → 😡 → 双烟雾归位。 */
  function levelThree(seatId, now) {
    var a = ensureAct(seatId);
    setFacingNow(a, 'back');
    startTurn(a, 'front', now);
    a.busyUntil = now + 9000;
    a.hop = { t0: now + 300, n: HOP_TIMES };

    var hopTotal = 300 + HOP_MS * HOP_TIMES;
    setTimeout(function () {
      if (S.dead || !S.act[seatId]) return;
      var p = actorDrawPos(seatId);
      if (!p) return;
      var doc = S.seatsDoc;
      var isMain = seatId === 'main';
      var sw = isMain ? doc.spriteSize.main : doc.spriteSize.sub;
      S.act[seatId].crack = {
        t0: performance.now(),
        cx: p.x + sw / 2,
        cy: p.y + (isMain ? 50 : 36),
        r: sw,
      };
      S.act[seatId].shakeUntil = performance.now() + 220;
    }, hopTotal);

    var fallStart = hopTotal + CRACK_MS;
    setTimeout(function () {
      if (S.dead || !S.act[seatId]) return;
      startFall(seatId);
    }, fallStart);
  }

  /** 掉落：进全景浮层，一路掉到视口底部再反弹。 */
  function startFall(seatId) {
    var a = S.act[seatId];
    if (!a || !cv) return;
    var p = actorDrawPos(seatId);
    if (!p) return;
    // 起点必须用逻辑→视口换算（sx/sy 各自独立），
    // 早期版本宽高都乘同一个 sc = r.width/scene.w，面板不是等比时起点就会偏，
    // 读感是"从裂缝掉下去却在半空消失"（m04324 第四条）。
    var vp = logicalToView(p.x, p.y);
    if (!vp) return;
    var img = frameFor(seatId, seatData(seatId), 'front', performance.now(), true);
    var isMain = seatId === 'main';
    var fw = img ? img.width : (isMain ? 36 : 26);
    var fh = img ? img.height : (isMain ? 51 : 37);
    a.fall = {
      t0: performance.now(),
      vx: 0,
      vy: 0.02,
      x: vp.x,
      y: vp.y,
      w: Math.max(1, Math.round(fw * vp.sx)),
      h: Math.max(1, Math.round(fh * vp.sy)),
      sc: vp.sx,
      sy: vp.sy,
      isMain: isMain,
      // 不要用 performance.now() 初始化：stepFall 收到的是 rAF 时间戳 ts，
      // 两者不同源（虚拟时间/后台标签下差异极大），ts - lastT 会 ≤0，
      // 被 Math.max(0,…) 钳成 0 后 dt 恒为 0，重力永远不生效、角色永远落不下去。
      // 用 null 而不是 0 作"还没基准"的哨兵：无头/虚拟时间下 rAF 的 ts 本身就从 0 起算，
      // 用 0 当哨兵会让首帧基准永远建立不起来（每帧都判定未初始化 → 每帧 continue）。
      lastT: null,
      bounced: false,
      grounded: false,
      groundT: 0,
    };
    a.hidden = true;
    a.facing = 'front';
    a.busyUntil = performance.now() + 9000;
  }

  /**
   * 掉落状态推进（每帧由 loop 调用）。
   *
   * ⚠️ 时间源：只用 performance.now()，既不用 rAF 传进来的 ts，也不用 setTimeout。
   * 原因：无头/虚拟时间（--virtual-time-budget）下 rAF 只调度了 5 帧就停，
   * 而 performance.now() 照常走时。掉落是纯物理积分，用停摆的 ts 会让 dt 恒为 0，
   * 角色永远落不下去 —— 这正是 m04324 第四条"掉出界面后消失"的根因。
   * 归位原来走 setTimeout，同理会被冻结，改成用 f.restoreAt 时间戳判定，
   * 让整条"起跳→裂→掉落→触底→😡→双烟雾→回工位"链路只有一个时钟。
   */
  function stepFall(ts) {
    void ts;
    var now = performanceNow();
    var ids = Object.keys(S.act);
    for (var i = 0; i < ids.length; i += 1) {
      var seatId = ids[i];
      var a = S.act[seatId];
      if (!a || !a.fall) continue;
      var f = a.fall;

      // 烟雾已起、等烟散完再露面（不再用 setTimeout）
      if (f.smoked) {
        if (!f.restored && now >= f.restoreAt) {
          f.restored = true;
          applyRestore(seatId);
        }
        continue;
      }

      if (f.grounded) {
        // 落地后：先冒 😡，2s 后双烟雾换回工位
        if (!f.angry && now - f.groundT > 120) {
          f.angry = true;
          setGlyph(seatId, 'angry', 1900, 0, 0);
          a.shakeUntil = now + 200;
        }
        if (!f.smoked && now - f.groundT > 2000) {
          f.smoked = true;
          f.restoreAt = now + SMOKE_MS * 2;
          smokeAtViewport(seatId);
          smokeAt(seatId, SMOKE_MS * 2, 1);
        }
        continue;
      }

      // 首帧只建立基准，不平移。用严格 null 判定而不是 falsy：ts 可能真的是 0。
      if (f.lastT === null || f.lastT === undefined) { f.lastT = now; continue; }
      var dt = Math.min(48, Math.max(0, now - f.lastT));
      f.lastT = now;
      f.vy += FALL_G * dt;
      f.y += f.vy * dt;
      var floorY = getFloorY(f);
      if (f.y >= floorY) {
        f.y = floorY;
        if (!f.bounced) {
          f.bounced = true;
          f.vy = -Math.abs(f.vy) * FALL_BOUNCE;
        } else {
          f.grounded = true;
          f.groundT = now;
        }
      }
    }
  }

  /**
   * 掉落后真正切回座位（由 stepFall 在烟散时按时间戳调用，不再自己排 setTimeout）。
   * 视觉上"从烟里出来"：清掉 fall/smoke 状态、解除 hidden、回到 seated 背面坐姿。
   */
  function applyRestore(seatId) {
    if (S.dead) return;
    var aa = S.act[seatId];
    if (aa) {
      aa.fall = null;
      aa.smokeView = null;
      aa.hidden = false;
      aa.pos = null;
      aa.phase = 'seated';
      aa.busyUntil = 0;
      setFacingNow(aa, 'back');
    }
    var sk = S.sky;
    if (sk && sk.ctx) sk.ctx.clearRect(0, 0, sk.cv.width, sk.cv.height);
  }

  function getFloorY(f) {
    return Math.max(0, window.innerHeight - f.h - 2);
  }

  /** 视口层的烟雾（掉落收尾用）。 */
  function smokeAtViewport(seatId) {
    var a = S.act[seatId];
    if (!a || !a.fall) return;
    a.smokeView = { t0: performance.now(), dur: SMOKE_MS * 2, x: a.fall.x, y: a.fall.y, r: 40 };
  }

  /** 画掉落角色、越出面板的角色与视口烟雾（固定浮层）。 */
  function drawSky(ts) {
    var sky = S.sky;
    if (!sky || !sky.ctx) return;
    var g = sky.ctx;
    g.clearRect(0, 0, sky.cv.width, sky.cv.height);
    // 浮层可观测计数（每帧重置）：模糊区抖动 / 冒符号都是纯绘制，
    // 没有 DOM 可断言，只能把"这一帧到底画了没有"暴露给调试钩子。
    S.skyShake = 0;
    S.skyGlyph = 0;
    var any = false;
    var ids = Object.keys(S.act);
    for (var i = 0; i < ids.length; i += 1) {
      var seatId = ids[i];
      var a = S.act[seatId];
      if (!a) continue;

      // --- 掉落中：整条鱼交给浮层，在浏览器最底部反弹 ---
      if (a.fall) {
        any = true;
        var f = a.fall;
        var img = frameFor(seatId, seatData(seatId), 'front', ts, true);
        if (img) {
          // 尺寸用 startFall 时按 vp.sx/vp.sy 记下的 w/h，
          // 保证掉落全程大小与裂缝上的那一刻完全一致。
          var w = f.w || Math.round(img.width * (f.sc || 1));
          var h = f.h || Math.round(img.height * (f.sc || 1));
          g.save();
          g.imageSmoothingEnabled = false;
          // 双手挥舞：左右交替倾斜
          var tilt = Math.sin(ts / 90) * 0.10;
          g.translate(f.x + w / 2, f.y + h / 2);
          g.rotate(tilt);
          g.drawImage(img, -w / 2, -h / 2, w, h);
          g.restore();
        }
        continue;
      }

      // --- 被拖到面板外：canvas 会裁掉超界像素，改由浮层在同位置画一份 ---
      // 尺寸直接用 canvas 的缩放比换算，保证出画前后大小完全一致（m03606 第一条）。
      if (a.pos && !a.hidden && isOutOfCanvas(seatId, ts)) {
        var vp = logicalToView(a.pos.x, a.pos.y);
        // 面板外也走行走帧：有方向就取同款行走帧，静止时才取站立帧。
        // 这是 m04324 第三条「拖出办公室在屏幕上行走动画有问题」的修复点。
        var mv = a.walkDir ? movingFrame(seatId, seatData(seatId), a.walkDir, ts) : null;
        var im2 = mv ? mv.img : frameFor(seatId, seatData(seatId), a.facing, ts, standingFor(seatId));
        var mir2 = mv ? mv.mirror : false;
        if (vp && im2) {
          any = true;
          var dw = Math.round(im2.width * vp.sx);
          var dh = Math.round(im2.height * vp.sy);
          // 面板外与面板内必须用同一套脚底对齐，否则鱼跨出画布边缘时会突然上下跳一下。
          var fix2 = mv ? Math.round(walkFootFix(seatId, im2) * vp.sy) : 0;
          g.save();
          g.imageSmoothingEnabled = false;
          // 侧向走时按朝向收窄，与面板内 FACING_SCALE.side 保持一致
          var nar = (a.walkDir === 'left' || a.walkDir === 'right' ||
                     (!mv && a.facing === 'side')) ? FACING_SCALE.side : 1;
          var w2 = Math.max(1, Math.round(dw * nar));
          var off2 = Math.round((dw - w2) / 2);
          // 副角帧等高等比归一化（m05088 第 3 条）：面板内由 drawActor 做，
          // 出画后改这里画，必须用同一套系数，否则跨出画布边缘会突然缩小/放大。
          var nrm = 1;
          if (seatId !== 'main') {
            nrm = subFrameNorm(seatId, im2);
            if (nrm > 1) dh = Math.round(im2.height * vp.sy * nrm);
          }
          // 副角正面/背面走动也有迈步起伏（m05088 第 5 条）：资产里没有正面行走帧序列，
          // 面板内靠 subsWalkBob/subsWalkLean 叠出来，出画后同样要叠，否则一出画就"滑行"。
          var wbob = 0;
          var wlean = 0;
          if (mv && seatId !== 'main') {
            var wph = (ts % (WALK_FRAME_MS * 2)) / (WALK_FRAME_MS * 2);
            wbob = -Math.round(Math.abs(Math.sin(wph * Math.PI)) * 2 * vp.sy);
            wlean = Math.round(Math.sin(wph * Math.PI * 2) * vp.sx);
          }
          // 懵逼抖动（m03550 第 12 条）：面板内的抖动写在 drawActor 里，而
          // drawActor 在越界时提前 return 改走这里，所以面板外必须自己再抖一次，
          // 否则「拖出办公室后同样的抖动冒问号」这条根本不会发生。
          var shx = 0;
          if (a.shakeUntil && ts < a.shakeUntil) {
            shx = Math.round(Math.sin(ts / 18) * 2 * vp.sx);
            S.skyShake = (S.skyShake || 0) + 1;
          }
          g.translate(vp.x + off2 + (mir2 ? w2 : 0) + shx + wlean, vp.y + fix2 + wbob);
          if (mir2) g.scale(-1, 1);
          g.drawImage(im2, 0, 0, w2, dh);
          g.restore();
        }
      }

      // --- 面板外也要冒符号（m03550 第 12 条）
      // 同样的道理：drawEffects 画在 stage canvas 上，越界部分被裁掉，
      // 所以画布外的问号/爱心等必须在浮层上补画一份。
      if (a.pos && !a.hidden && !a.fall && isOutOfCanvas(seatId, ts)) {
        var vpg = logicalToView(a.pos.x, a.pos.y);
        if (vpg) {
          var gname = a.glyph && ts - a.glyph.t0 < a.glyph.dur ? a.glyph.name : null;
          if (gname) {
            var gsz = glyphSize(gname);
            if (gsz.w > 0) {
              // 浮层是设备像素坐标，点阵要按同一个缩放比放大，才和面板内一样大。
              var gsc = Math.max(1, Math.round(vpg.sx));
              // seatsDoc 可能还没到（首帧 / 切会话窗口）：裸解引用会抛 TypeError，
              // 而这个异常发生在 rAF 回调里 —— 帧链直接断掉，整个像素办公室停摆。
              var swG = S.seatsDoc
                ? (seatId === 'main' ? S.seatsDoc.spriteSize.main : S.seatsDoc.spriteSize.sub)
                : 26;
              var gxG = Math.round(vpg.x + (swG * vpg.sx) / 2 - (gsz.w * gsc) / 2 +
                                   (a.glyph.dx || 0) * vpg.sx);
              var gyG = Math.round(vpg.y - gsz.h * gsc - 6 * vpg.sy +
                                   (a.glyph.dy || 0) * vpg.sy + Math.sin(ts / 220) * Math.round(vpg.sy));
              any = true;
              drawGlyph(g, gname, gxG, gyG, gsc, 1);
              S.skyGlyph = (S.skyGlyph || 0) + 1;
            }
          }
        }
      }

      if (a.smokeView) {
        var sv = a.smokeView;
        var k = clamp((ts - sv.t0) / sv.dur, 0, 1);
        if (k >= 1) { a.smokeView = null; continue; }
        any = true;
        drawSmoke(g, sv.x + 16, sv.y + 16, sv.r, k, 1);
      }
    }
    sky.cv.style.opacity = any ? '1' : '0';
  }

  // --- D13.4 空格彩蛋 -------------------------------------------------------

  /** 全员是否都已被空格拖出并在外面待机。 */
  function allEscaped() {
    var snap = S.snapshot;
    if (!snap) return false;
    var total = 0;
    var esc = 0;
    var check = function (seatId, seat) {
      if (!seat || !seat.agentId) return;
      total += 1;
      var a = S.act[seatId];
      if (a && a.esc) esc += 1;
    };
    check('main', snap.main);
    if (Array.isArray(snap.subs)) snap.subs.forEach(function (s, i) { check('sub:' + i, s); });
    return total > 0 && esc === total;
  }

  /** 开始出逃：依次转身、排队、向右走。 */
  function startParade() {
    if (S.parade) return;
    var doc = S.seatsDoc;
    if (!doc) return;
    S.parade = 1;
    S.paradeT0 = performance.now();
    // 只收「快照里真的还有 agentId」的席位：act 里可能残留已离场席位的 esc 标记，
    // 带着它排队会在队列中间留一个空槽（人早没了，槽位还被占着）。
    var ids = Object.keys(S.act).filter(function (id) {
      if (!S.act[id].esc) return false;
      var seat = seatData(id);
      return !!(seat && seat.agentId);
    });
    if (!ids.length) { S.parade = 0; return; }
    // 按落点 x 排序，排队才有秩序
    ids.sort(function (m, n) { return S.act[m].escX - S.act[n].escX; });
    S.paradeIds = ids;

    // 槽位必须**累积**算：slotX[i] = 前面所有鱼的宽度 + 间隔。
    // 原来写的是 18 + i*(sw + QUEUE_GAP)，sw 取的是第 i 条鱼**自己的**宽度，
    // 主鱼 36 / 副鱼 26 混排时后面的鱼会被前一条压进去（或间隙忽大忽小），
    // 满员时队列还会直接排到画布外。
    var widths = ids.map(function (id) {
      return id === 'main' ? doc.spriteSize.main : doc.spriteSize.sub;
    });
    var sumW = 0;
    for (var wi = 0; wi < widths.length; wi += 1) sumW += widths[wi];
    var gap = QUEUE_GAP;
    var avail = doc.scene.w - 24;
    var totalW = sumW + gap * (widths.length - 1);
    // 满员（1 主 + 11 副）时一列会宽过画布，先压间隔，再不行从左沿起排。
    if (totalW > avail && widths.length > 1) {
      gap = Math.max(1, Math.floor((avail - sumW) / (widths.length - 1)));
      totalW = sumW + gap * (widths.length - 1);
    }
    var cursor = totalW <= avail ? Math.max(6, Math.round((doc.scene.w - totalW) / 2)) : 6;

    ids.forEach(function (id, i) {
      var a = S.act[id];
      var sw = widths[i];
      var slotX = cursor;
      cursor += sw + gap;
      a.phase = 'escaping';
      a.shakeUntil = 0;
      a.escSlotX = slotX;
      a.escFeetY = ROW_GAPS[0];
      setTimeout(function () {
        if (S.dead) return;
        // ROW_GAPS 存的是**脚底线**；walkPath 用的是精灵左上角，所以减一个身高。
        // 直接拿脚底线当顶部用会让脚踩在下一排桌面上（同一个坑踩过一次了）。
        var sh = spriteHeightFor(id);
        var laneTopY = Math.round(ROW_GAPS[0] - sh);
        a.walkPath = navRoute(
          { x: Math.round(a.pos ? a.pos.x : a.escX), y: Math.round(a.pos ? a.pos.y : a.escY) },
          { x: slotX, y: laneTopY },
          sw,
          sh
        );
        a.walkLen = pathLen(a.walkPath);
        a.walkT0 = performance.now();
        faceToward(a, 'left');
      }, i * 180);
    });
  }

  /** 排队完成后一起向右走，最后一个出画 → 弹告示牌。 */
  function stepParade(ts) {
    if (S.parade === 1) {
      var allQueued = S.paradeIds.every(function (id) {
        var a = S.act[id];
        if (!a || !a.walkPath) return false;
        return walkDone(a.walkT0, a.walkLen, ts);
      });
      if (!allQueued) return;
      S.parade = 2;
      S.paradeT0 = ts;
      S.paradeIds.forEach(function (id) {
        var a = S.act[id];
        var doc = S.seatsDoc;
        var isMain = id === 'main';
        var sw = isMain ? doc.spriteSize.main : doc.spriteSize.sub;
        // 沿队列那条脚底线横向走出画面右侧
        var laneTopY = Math.round((a.escFeetY != null ? a.escFeetY : ROW_GAPS[0]) - spriteHeightFor(id));
        a.walkPath = dedupePath([
          { x: Math.round(a.escSlotX), y: laneTopY },
          { x: Math.round(doc.scene.w + sw + 12), y: laneTopY },
        ]);
        a.walkLen = pathLen(a.walkPath);
        a.walkT0 = ts;
        faceToward(a, 'right');
      });
      return;
    }
    if (S.parade === 2) {
      // 必须等**每一条**都走出右边沿才弹牌。
      // 原来只判 paradeIds 的末位，而 paradeIds 是「落点 x 升序」——
      // 最右边那条槽位最右、走得最短，反而**最先**走完，
      // 牌就在队列还有大半截在画面里的时候弹了出来（用户说的「没做好」）。
      var allOut = S.paradeIds.every(function (id) {
        var a2 = S.act[id];
        if (!a2) return true;            // 中途离场的席位不再等它
        if (!a2.walkPath) return false;  // 还没开始走
        return walkDone(a2.walkT0, a2.walkLen, ts);
      });
      if (!allOut) return;
      S.parade = 3;
      showBoard();
    }
  }

  // --- 告示牌 ---------------------------------------------------------------

  /**
   * 把一段文字按低分辨率光栅化再放大，得到"像素字"效果。
   * 用户要求（m02609）：文字像素的同时要保证能认清 —— 先按 1/scale 尺寸画到离屏 canvas，
   * 再用 nearest 放大贴回，笔画会变成整齐的方块，同时汉字结构完整可读。
   */
  function drawPixelText(g, text, cx, cy, px, scale, color) {
    var off = document.createElement('canvas');
    var octx = off.getContext('2d');
    var font = px + 'px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif';
    octx.font = font;
    var w = Math.ceil(octx.measureText(text).width) + 2;
    var h = Math.ceil(px * 1.4);
    off.width = Math.max(1, w);
    off.height = Math.max(1, h);
    octx = off.getContext('2d');
    octx.font = font;
    octx.textBaseline = 'middle';
    octx.fillStyle = color || '#3b2416';
    octx.fillText(text, 1, h / 2);
    g.save();
    g.imageSmoothingEnabled = false;
    g.drawImage(off, Math.round(cx - (w * scale) / 2), Math.round(cy - (h * scale) / 2), w * scale, h * scale);
    g.restore();
  }

  /**
   * 告示牌文字排版：自动缩字号 + 按宽度断行 + 内边距留白。
   *
   * 旧实现直接 `drawPixelText(tg, line, bw/2, bh*0.30, bw/13, 2, …)`：
   * px 是离屏光栅化字号，真正显示尺寸 = px * scale，两头都没跟板面宽度挂钩。
   * 9 个字 × (520/13=40) × 2 = 720px 宽，而板面可用宽只有约 464px，
   * 文字必然从左边木框一直溢出到右边木框外。
   */
  var boardTextCtx = null;
  function boardTextWidth(text, px) {
    if (!boardTextCtx) boardTextCtx = document.createElement('canvas').getContext('2d');
    boardTextCtx.font = px + 'px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif';
    return boardTextCtx.measureText(text).width;
  }

  /** 按「离屏可用宽度」把一段文字断成多行。 */
  function boardWrap(text, px, maxW) {
    var out = [];
    var cur = '';
    var chars = String(text).split('');
    for (var i = 0; i < chars.length; i += 1) {
      var next = cur + chars[i];
      if (cur && boardTextWidth(next, px) > maxW) { out.push(cur); cur = chars[i]; }
      else cur = next;
    }
    if (cur) out.push(cur);
    return out;
  }

  function drawBoardText(g, para, bw, bh, color) {
    var SRC_W = 262;
    var SRC_H = 247;
    var SCALE = 2;
    // 内板实测矩形换进 tc 画布坐标，再内缩出留白
    var bx0 = 7 * bw / SRC_W;
    var bx1 = 240 * bw / SRC_W;
    var by0 = 6 * bh / SRC_H;
    var by1 = 166 * bh / SRC_H;
    var ax0 = bx0 + (bx1 - bx0) * 0.08;
    var ax1 = bx1 - (bx1 - bx0) * 0.08;
    var ay0 = by0 + (by1 - by0) * 0.10;
    var ay1 = by1 - (by1 - by0) * 0.10;
    var availW = Math.max(24, ax1 - ax0);
    var availH = Math.max(24, ay1 - ay0);
    var offMaxW = availW / SCALE;   // 离屏 canvas 可用宽度
    var offMaxH = availH / SCALE;   // 离屏 canvas 可用总高

    // 起手按「一行 12 字也放得下」估一个字号，再往下收敛
    var px = Math.max(6, Math.round(Math.min(bw / 16, offMaxW / 12)));
    var lines = [];
    for (;;) {
      lines = [];
      for (var i = 0; i < para.length; i += 1) {
        var part = boardWrap(para[i], px, offMaxW);
        for (var j = 0; j < part.length; j += 1) lines.push(part[j]);
      }
      var offBlockH = lines.length * px * 1.4;
      if (px <= 6 || offBlockH <= offMaxH) break;
      px -= 1;
    }

    var lineH = px * 1.4 * SCALE;         // 显示后的行高
    var cx = (ax0 + ax1) / 2;
    var yTop = (ay0 + ay1) / 2 - (lines.length * lineH) / 2;
    for (var k = 0; k < lines.length; k += 1) {
      drawPixelText(g, lines[k], cx, yTop + lineH * (k + 0.5), px, SCALE, color);
    }
  }

  /**
   * "DSH 被最小化"的视觉等价物。
   * 浏览器里拿不到宿主窗口的最小化 API（Web GUI 无此能力），
   * 所以用一层深色幕布把整个界面盖掉 —— 读感上就是"DSH 缩走了、只剩告示牌"。
   * 点击告示牌后幕布淡出，界面复原。
   */
  function showCurtain() {
    if (S.curtainEl) return;
    var c = document.createElement('div');
    c.setAttribute('data-dsh-plugin', 'pixel-office');
    c.setAttribute('data-po-curtain', '');
    c.style.position = 'fixed';
    c.style.left = '0';
    c.style.top = '0';
    c.style.width = '100%';
    c.style.height = '100%';
    c.style.background = 'radial-gradient(circle at 50% 46%, #1a1526 0%, #0b0810 62%, #050409 100%)';
    c.style.zIndex = String(CURTAIN_Z);
    c.style.pointerEvents = 'auto';
    c.style.opacity = '0';
    c.style.transition = 'opacity 420ms ease';
    document.body.appendChild(c);
    S.curtainEl = c;
    // 下一帧再改 opacity，transition 才会生效
    requestAnimationFrame(function () { c.style.opacity = '1'; });
  }

  function hideCurtain() {
    var c = S.curtainEl;
    if (!c) return;
    S.curtainEl = null;
    c.style.opacity = '0';
    setTimeout(function () {
      if (c.parentNode) c.parentNode.removeChild(c);
    }, 460);
  }

  /** 弹出硕大木质像素告示牌（elasticOut）。 */
  function showBoard() {
    if (S.boardEl) return;
    // 浏览器里没有"最小化宿主窗口"的 API，用两件事凑出等价观感：
    //   1) 办公室面板自己收成木牌（这一步是真的最小化）
    //   2) 一层深色幕布把整个界面盖掉，只剩中央的大告示牌
    if (panelApi && typeof panelApi.setMinimized === 'function') {
      try { panelApi.setMinimized(true); } catch (e) { /* 忽略 */ }
    }
    showCurtain();
    var wrap = document.createElement('div');
    wrap.setAttribute('data-dsh-plugin', 'pixel-office');
    wrap.setAttribute('data-po-board', '');
    wrap.style.position = 'fixed';
    wrap.style.left = '0';
    wrap.style.top = '0';
    wrap.style.width = '100%';
    wrap.style.height = '100%';
    wrap.style.display = 'flex';
    wrap.style.alignItems = 'center';
    wrap.style.justifyContent = 'center';
    wrap.style.zIndex = String(BOARD_Z);
    wrap.style.pointerEvents = 'none';
    var bw = 520;
    var bh = Math.round(bw * (247 / 262));
    var box = document.createElement('div');
    box.style.position = 'relative';
    box.style.width = bw + 'px';
    box.style.height = bh + 'px';
    box.style.pointerEvents = 'auto';
    box.style.cursor = 'pointer';
    box.style.transform = 'scale(0.02)';
    box.style.willChange = 'transform';

    var img = document.createElement('img');
    img.src = assetUrl('ui/board.png');
    img.style.width = '100%';
    img.style.height = '100%';
    img.style.imageRendering = 'pixelated';
    img.style.display = 'block';
    box.appendChild(img);

    var tc = document.createElement('canvas');
    tc.width = bw;
    tc.height = bh;
    tc.style.position = 'absolute';
    tc.style.left = '0';
    tc.style.top = '0';
    tc.style.width = '100%';
    tc.style.height = '100%';
    tc.style.pointerEvents = 'none';
    box.appendChild(tc);

    var tg = tc.getContext('2d');
    tg.imageSmoothingEnabled = false;
    // 板面可用区实测：board.png 262x247 里内板是 x 7..240 / y 6..166。
    // drawBoardText 按这个矩形自动缩字号、按宽度断行、并在内板里居中；
    // 旧的写法（bx/13 当字号再乘 2）在 520px 宽下单行就要 720px，必然溢出木牌。
    drawBoardText(tg, ['您的全体员工已出逃', '无法继续工作！'], bw, bh, '#2a1a10');

    wrap.appendChild(box);
    document.body.appendChild(wrap);
    S.boardEl = wrap;
    S.boardBox = box;

    // elasticOut：0.02 → 1.18 → 0.94 → 1
    try {
      box.animate([
        { transform: 'scale(0.02) rotate(-6deg)' },
        { transform: 'scale(1.18) rotate(2deg)', offset: 0.62 },
        { transform: 'scale(0.94) rotate(-1deg)', offset: 0.82 },
        { transform: 'scale(1) rotate(0deg)' },
      ], { duration: BOARD_MS, easing: 'ease-out', fill: 'forwards' });
      box.style.transform = 'scale(1)';
    } catch (e) {
      box.style.transform = 'scale(1)';
    }

    box.addEventListener('click', function () {
      restoreFromBoard();
    });
  }

  /** 点击告示牌：全员从门口走回工位，告示牌缩回，幕布淡出。 */
  function restoreFromBoard() {
    if (!S.boardEl) return;
    hideCurtain();
    var wrap = S.boardEl;
    var box = S.boardBox;
    S.boardEl = null;
    S.boardBox = null;
    try {
      var an = box.animate([{ transform: 'scale(1)' }, { transform: 'scale(0.02)', opacity: 0 }],
        { duration: 320, easing: 'ease-in', fill: 'forwards' });
      an.onfinish = function () { wrap.remove(); };
    } catch (e) {
      wrap.remove();
    }
    S.parade = 0;
    var ids = Object.keys(S.act);
    ids.forEach(function (id) {
      var a = S.act[id];
      a.esc = false;
      a.phase = 'seated';
      a.hidden = false;
      a.fall = null;
      a.pos = null;
      a.walkPath = null;
      setFacingNow(a, 'back');
    });
    // 重新触发入场：清掉 agentId 记录，下一次快照就会从门口走进来
    S.lastAgentIds = {};
    S.walkIns = {};
    S.enterQueue = [];
    S.enterBusyUntil = 0;
  }

  // --- 拖拽 -----------------------------------------------------------------

  var dragState = null;

  function beginGrab(seatId, clientX, clientY, ts) {
    var a = ensureAct(seatId);
    var p = toLogical(clientX, clientY);
    if (!p) return;
    var b = actorBox(seatId, ts);
    if (!b) return;
    dragState = {
      seatId: seatId,
      offX: p.x - b.x,
      offY: p.y - b.y,
      moved: false,
      startX: clientX,
      startY: clientY,
    };
    a.phase = 'grabbed';
    a.hidden = false;
    a.fall = null;
    a.walkPath = null;
    a.glyph = null;
    // 抓住时**不切换朝向**。正面帧比背面帧矮得多（m8-idol 24px vs 41px），
    // 一抓就切正面会明显变小（用户反馈"拖出来后会突然缩小"）。
    a.pos = { x: b.x, y: b.y };
    if (cv) cv.style.cursor = 'grabbing';
  }

  function moveGrab(clientX, clientY) {
    if (!dragState) return;
    var d = Math.abs(clientX - dragState.startX) + Math.abs(clientY - dragState.startY);
    if (d > 3) {
      if (!dragState.moved) {
        // 真正开始拖了：这时才转回背面。
        // 用户明确要求「拖拽过程中不显示正面」——正面帧要留给双击互动与松手后的
        // 懵逼/落地姿态；但**不能在 pointerdown 就转**，否则单击一下也会翻面
        //（单击只该什么都不发生，翻身是双击才有的效果）。
        dragState.moved = true;
        var ga = S.act[dragState.seatId];
        if (ga) setFacingNow(ga, 'back');
      }
    }
    if (!dragState.moved) return;
    var a = S.act[dragState.seatId];
    if (!a) return;
    // 宽松换算：允许拖到 canvas 之外（负数/超界），鱼才能真正离开面板显示在屏幕上。
    var p = toLogicalLoose(clientX, clientY);
    if (p) {
      a.pos = { x: Math.round(p.x - dragState.offX), y: Math.round(p.y - dragState.offY) };
    }
  }

  function endGrab(clientX, clientY, ts) {
    if (!dragState) return;
    var d = dragState;
    var a = S.act[d.seatId];
    dragState = null;
    if (cv) cv.style.cursor = 'default';
    if (!a) return;
    if (!d.moved) {
      // 没移动 = 一次点击，交给双击检测。
      // onTap 返回 true 表示这一下凑成了双击：双击的三级动画全是「在工位上原地」演的，
      // 所以这里必须把 grabbed 状态收干净（清 pos、回到 seated），
      // 但**不能**调 setFacingNow('back')——那会把 levelOne/Two/Three 刚起的
      // 正面转身覆盖掉，双击就形同没发生（踩过一次）。
      // 空格彩蛋的鱼要单独收口：
      //   · 双击 → onTap 里已经调 releaseEsc，把 phase 设成 walkhome/reenter 并排好折线，
      //     这里再写 phase='seated' 会把路线一笔勾销，鱼就瞬移回工位了；
      //   · 单击 → 什么都不该发生。以前无条件 a.pos=null / phase='seated'，
      //     坐地待机的鱼被点一下就闪回工位（esc 标记还在，于是坐在工位上摆坐地姿势）。
      var wasEsc = !!a.esc;
      var fired = onTap(d.seatId, clientX, clientY, ts);
      if (wasEsc) {
        if (!a.esc) return;                       // 已经解除，路线归 releaseEsc 管
        a.phase = 'seated';                       // 单击：原样坐回去
        a.pos = { x: a.escX, y: a.escY };
        setFacingNow(a, 'front');
        return;
      }
      a.pos = null;
      a.phase = 'seated';
      if (fired) return;
      // 单击不做任何朝向变化。
      // 曾经这里无条件 setFacingNow(a,'back')，于是「本来朝正面坐着」的鱼被点一下
      // 就翻回背面（用户反馈「副鱼单击为何会切换到转身？只设定了双击切换到正面互动」）。
      // 翻开/转身只能是双击互动、拖拽、以及互动结束自己复位的结果，单击保持原样。
      return;
    }
    // 判"是否还在办公室内"必须看整条鱼的包围盒，不能只看指针位置。
    // 鱼宽 26/36、被拖到贴边时指针还在画布内，但半个身子已经出画了
    // （m03550 第 2 条「有的从别的地方走进去了」就是这里判错导致的）。
    var inside = !!toLogical(clientX, clientY);
    var posLog = a.pos || toLogicalLoose(clientX, clientY);
    if (posLog && S.seatsDoc && S.seatsDoc.scene) {
      var sc = S.seatsDoc.scene;
      var bw = d.seatId === 'main' ? S.seatsDoc.spriteSize.main : S.seatsDoc.spriteSize.sub;
      var bh = spriteHeightFor(d.seatId);
      inside = !(
        posLog.x < 0 || posLog.y < 0 ||
        posLog.x + bw > sc.w || posLog.y + bh > sc.h
      );
    }
    if (S.spaceDown) {
      // 空格彩蛋：就地待机，不回家
      a.esc = true;
      a.escX = a.pos ? a.pos.x : 0;
      a.escY = a.pos ? a.pos.y : 0;
      a.phase = 'seated';
      a.sitT0 = performance.now();
      setFacingNow(a, 'front');
      a.blinkAt = performance.now() + BLINK_MIN + Math.random() * (BLINK_MAX - BLINK_MIN);
      if (allEscaped()) startParade();
      return;
    }
    startConfuse(d.seatId, !inside);
  }

  /**
   * 单击 / 双击判定。
   * @returns {boolean} true = 这一下凑成了双击，调用方不要再动朝向与相位。
   */
  function onTap(seatId, clientX, clientY, ts) {
    var a = ensureAct(seatId);
    var now = performance.now();
    void ts;
    var near = Math.abs(clientX - a.lastX) + Math.abs(clientY - a.lastY) < DBL_SLOP * 2;
    if (now - a.lastUp < DBL_MS && near) {
      a.lastUp = 0;
      doDoubleClick(seatId);
      return true;
    }
    a.lastUp = now;
    a.lastX = clientX;
    a.lastY = clientY;
    return false;
  }

  /**
   * 画一个 sprite：水平按脚底中心对齐、**垂直按左上角（头顶）对齐**。
   *
   * 为什么垂直不能按脚底对齐（用户反馈 m03606「有的鱼拖出来后会突然缩小」）：
   * 每套鱼的背面/正面/侧面帧高度差很大（m8-idol 背面 41px、正面只有 24px）。
   * 底部对齐会让"脚"钉在原地，正面帧矮出来的那 17px 全从头顶丢，读感就是整条鱼缩小了。
   * seats.json 里的 seated.y 本来就是按"头顶落点"标定的，头顶对齐才与锚点一致；
   * 正面/侧面变矮只是腿被桌子挡住的部分少了，头还在原处。
   */
  function drawSpriteScaled(g, img, x, y, sx, alpha, mirror, sy) {
    var w = img.width;
    var ky = (sy === undefined || sy === null) ? 1 : sy;
    var cxp = x + w / 2;
    g.save();
    g.globalAlpha = clamp(alpha, 0, 1);
    g.translate(cxp, y);
    g.scale(mirror ? -sx : sx, ky);
    g.drawImage(img, -w / 2, 0);
    g.restore();
  }

  /**
   * 行走帧选择：面板内（drawActor）与面板外（drawSky）共用同一套。
   *
   * 用户 m04324 第三条「拖出办公室在屏幕上行走动画有问题」的根因是：
   * 面板外由 drawSky 绘制，而它只取一张静止站立帧，人物就变成平移滑行。
   * 抽成公用函数后，出画前后取到的是同一帧序列，动画无缝。
   *
   * 返回 { img, mirror }；无可用帧返回 null。
   */
  function movingFrame(seatId, seat, dir, ts) {
    var d = dir || 'up';
    if (seatId === 'main') {
      var F = S.mainFrames;
      var pool = F.walkUp;
      if (d === 'down') pool = F.walkDown;
      else if (d === 'left' || d === 'right') pool = F.walkSide || F.walkUp;
      if (!pool || !pool.length) pool = F.sit;
      if (!pool || !pool.length) return null;
      return { img: pool[Math.floor(ts / WALK_FRAME_MS) % pool.length], mirror: d === 'left' };
    }
    // 副鱼没有上下行走帧序列，只能按方向挑最接近的整图：
    //   朝上走 → 背面坐姿那一套（观众看到的就是背影）
    //   朝下走 → 正面行走帧（S.subWalkFront，m05088 新生成的资产），缺帧才回落正面坐姿
    //   横走   → 真正的侧面行走帧（S.subWalk），左走镜像
    // 注意不能传 standing=true，否则 frameFor 会一律返回侧面行走帧，
    // 上下走时就变成"横着飘"了。
    var idx = skinOf(seatId, seat);
    if (d === 'left' || d === 'right') {
      var sw = S.subWalk[idx];
      if (sw) return { img: sw, mirror: d === 'left' };
      if (S.subSide[idx]) return { img: S.subSide[idx], mirror: d === 'left' };
      return null;
    }
    if (d === 'down') {
      var wf = S.subWalkFront && S.subWalkFront[idx];
      if (wf) return { img: wf, mirror: false };
      if (S.subFront[idx]) return { img: S.subFront[idx], mirror: false };
    }
    if (S.subSkins[idx]) return { img: S.subSkins[idx], mirror: false };
    return null;
  }

  function drawActor(g, item, ts) {
    var seatId = item.seatId;
    var seat = item.seat;
    var pos = item.pos;
    var isMain = pos.kind === 'main';
    var a = ensureAct(seatId);
    var x = pos.x;
    var y = pos.y;
    var walking = false;
    var walkDir = 'up';
    var mirrored = false;

    // 被抓住 / 懵逼 / 回家途中：位置由 act 覆盖
    if (a.pos) {
      x = a.pos.x;
      y = a.pos.y;
    }

    // 已消失（双击第 2/3 级的烟雾期间）
    if (a.hidden) return;

    // 入场折线（Host 快照带来的新 agent）
    // 排队未放行的鱼先不出画（人还在门外），放行后才从门口开始走。
    var walk = S.walkIns[seatId];
    if (walk && a.phase === 'seated') {
      if (!walk.ready) return;
      var need = walkDur(walk);
      var k = clamp((ts - walk.t0) / need, 0, 1);
      if (k >= 1) {
        delete S.walkIns[seatId];
      } else {
        walking = true;
        var wp = walkPos(walk.path, walk.len * k);
        x = wp.x;
        y = wp.y;
        walkDir = wp.dir;
      }
    }

    // 拖拽后的回家 / 出画重进 / 彩蛋出逃：靠 act 自己的折线走
    if ((a.phase === 'walkhome' || a.phase === 'reenter' || a.phase === 'escaping') &&
        a.walkPath && a.walkLen > 0) {
      var kk = walkProgress(a.walkT0, a.walkLen, ts);
      var p2 = walkPos(a.walkPath, a.walkLen * kk);
      x = p2.x;
      y = p2.y;
      walkDir = p2.dir;
      walking = true;
      // 让 a.pos 跟着折线走：命中检测、特效锚点、以及"是否越出面板"都读它。
      // 从面板外走回来时，浮层会一直画到鱼真正进入 canvas 为止，交接不出缝。
      a.pos = { x: Math.round(p2.x), y: Math.round(p2.y) };
      if (kk >= 1) {
        a.pos = null;
        // 相位推进统一交给 stepAct()（它对 reenter 有两段：出画 → 再进门）。
        // 这里只负责把"走到头"的位置停在终点，不擅自改 reenter / escaping 的 phase。
        if (a.phase === 'walkhome') {
          a.walkPath = null;
          a.phase = 'seated';
          setFacingNow(a, 'back');
        }
      }
    }

    // 就地坐下（空格彩蛋）：轻微下沉 + 竖向压扁
    var sitScale = 1;
    var sitDrop = 0;
    if (a.sitT0 && ts - a.sitT0 < SITDOWN_MS) {
      var sk = (ts - a.sitT0) / SITDOWN_MS;
      sitScale = 0.94 + 0.06 * sk;
      sitDrop = Math.round(3 * (1 - sk));
    }

    // 跳跃（跺地）：y 上抛
    var hopY = 0;
    if (a.hop) {
      var hk = (ts - a.hop.t0) / HOP_MS;
      if (hk >= 1) {
        a.hop.n -= 1;
        if (a.hop.n > 0) {
          a.hop.t0 = ts;
        } else {
          a.hop = null;
        }
      } else {
        hopY = -Math.round(HOP_PX * Math.sin(hk * Math.PI));
      }
    }

    // 掉落中：完全交给视口浮层（drawSky）绘制，面板内不再画
    if (a.fall) return;

    // 把当前行走朝向记在 act 上：面板外的分身由 drawSky 绘制，
    // 它读这个字段才能选出同样的行走帧，出画前后动画不会突然变成"滑行"。
    a.walkDir = walking ? walkDir : null;

    // 越出面板：canvas 会裁掉超界像素，整条鱼改由视口浮层画（见 drawSky）。
    // 这里提前退出，避免"画布内露出半条 + 浮层又画一份"的重影。
    if (a.pos && isOutOfCanvas(seatId, ts)) return;

    var drawX = Math.round(x);
    var drawY = Math.round(y) + hopY + sitDrop;

    // 抖动（懵逼 / 落地震屏）
    if (a.shakeUntil && ts < a.shakeUntil) {
      drawX += Math.round(Math.sin(ts / 18) * 2);
    }

    var img = null;
    var bob = 0;
    var subsWalkBob = 0;
    var subsWalkLean = 0;
    var stand = standingFor(seatId);

    if (isMain) {
      if (walking) {
        // 面板内行走：与面板外（drawSky）共用 movingFrame，出画前后帧序列一致
        var mf = movingFrame(seatId, seat, walkDir, ts);
        if (mf) { img = mf.img; mirrored = mf.mirror; }
      } else {
        // 非走路态统一走朝向系统（会自动按 activity 选背面帧）
        img = frameFor(seatId, seat, a.facing, ts, stand);
      }
    } else {
      // 副鱼走路也交给 movingFrame：横走用侧面行走帧、上走用背影、下走用正面，
      // 不能一律传 standing=true（那样上下走会拿侧面帧，看起来像横着飘）。
      if (walking) {
        var mf2 = movingFrame(seatId, seat, walkDir, ts);
        if (mf2) { img = mf2.img; mirrored = mf2.mirror; }
      } else {
        img = frameFor(seatId, seat, a.facing, ts, stand);
      }
      if (img && !walking) {
        if (seat.activity === 'working') {
          bob = Math.round(Math.sin(ts / 130));
        } else {
          bob = Math.round(Math.sin(ts / 900));
        }
      }
      // 副角走路：资产里每套只有**一张**侧面走姿帧（char/subs/walk-side/*），
      // 没有帧序列，所以照帧表播是"贴图平移"，用户说的「侧面走路没有动画」
      // 就是它（m00343 第二条）。这里按走路节拍叠一个上下起伏 + 横向轻微摆动，
      // 单帧也能读出迈步节奏，不依赖再生成资产。
      if (img && walking) {
        var ph = (ts % (WALK_FRAME_MS * 2)) / (WALK_FRAME_MS * 2);
        subsWalkBob = -Math.round(Math.abs(Math.sin(ph * Math.PI)) * 2);
        subsWalkLean = Math.round(Math.sin(ph * Math.PI * 2));
      }
    }

    // 眨眼：只有正面朝向才看得见眼睛。到点时在眼部画两条短横线（闭眼），
    // 不做逐帧资产，纯代码叠画，和头顶符号一样走"不依赖 AI 出图"的路。
    var blinking = false;
    if (!walking && a.facing === 'front' && img) {
      if (!a.blinkAt) a.blinkAt = ts + BLINK_MIN + Math.random() * (BLINK_MAX - BLINK_MIN);
      if (ts >= a.blinkAt) {
        if (!a.blinkT0) a.blinkT0 = ts;
        if (ts - a.blinkT0 > BLINK_MS) {
          a.blinkT0 = 0;
          a.blinkAt = ts + BLINK_MIN + Math.random() * (BLINK_MAX - BLINK_MIN);
        } else {
          blinking = true;
        }
      }
    }

    if (img) {
      var dx = drawX + subsWalkLean;
      var dy = drawY + bob + subsWalkBob;
      // 走姿帧与坐姿帧高度不同（m6-witch 走 51 / 坐 41，m5-sporty 走 26 / 坐 40），
      // 按左上角对齐会让脚陷进地板或悬空。走路时按脚底对齐补偿。
      if (walking) dy += walkFootFix(seatId, img);
      // 空格彩蛋的「坐在地上」帧比基准坐姿帧矮（主鱼 39×48 vs 36×51、
      // 副鱼 26×30 vs 26×37），同样必须按脚底对齐，否则会悬在半空。
      var onFloor = !walking && a.esc && !a.walkPath;
      if (onFloor) dy += walkFootFix(seatId, img);
      // 副角帧等高等比归一化（m05088 第 3 条）：8 套副角的正/侧/走帧高度差最多
      // 40%（m1 正面 30 vs 背面 37、m8 正面 24 vs 背面 41），换个朝向就"突然缩小"。
      // 这里把矮帧竖向拉到基准高，并按头顶锚点回退位移，脚底位置保持不变。
      // 坐地帧（esc）例外：它本来就该比坐姿矮，拉平反而看不出"坐到地上"。
      var normY = 1;
      if (!isMain && !onFloor) {
        normY = subFrameNorm(seatId, img);
        if (normY > 1) dy -= Math.round(img.height * (normY - 1));
      }
      if (walking && isMain) {
        if (mirrored) {
          g.save();
          g.translate(dx + img.width, dy);
          g.scale(-1, 1);
          g.drawImage(img, 0, 0);
          g.restore();
        } else {
          g.drawImage(img, dx, dy);
        }
      } else {
        // 静止态与副角走路态都走同一套：朝向系统 + 头顶锚点缩放绘制。
        // 副角走路用真侧面行走帧（S.subWalk），横向移动时按方向镜像。
        var scx = (a.facing === 'side' || walking) ? FACING_SCALE.side : 1;
        if (a.turn && !walking) {
          drawFacingSprite(g, seatId, seat, dx, dy, ts, normY);
        } else if (sitScale !== 1) {
          // 坐下：按头顶锚点竖向压扁，脚往下沉一点点，重心才不像被拔起来
          g.save();
          g.translate(dx + img.width / 2, dy);
          g.scale(scx, sitScale * normY);
          g.drawImage(img, -img.width / 2, 0);
          g.restore();
        } else {
          var mir2 = walking ? mirrored : (a.facing === 'side' && a.sideMirror);
          drawSpriteScaled(g, img, dx, dy, scx, 1, mir2, normY);
        }
      }
      // 闭眼：在正面朝向上叠两条 3x1 的深色短横，位置按 sprite 比例取
      if (blinking) {
        var bw = Math.max(2, Math.round(img.width * 0.13));
        var eyY = Math.round(dy + img.height * 0.34);
        var eyX1 = Math.round(dx + img.width * 0.30);
        var eyX2 = Math.round(dx + img.width * 0.56);
        g.fillStyle = '#2b2136';
        g.fillRect(eyX1, eyY, bw, 1);
        g.fillRect(eyX2, eyY, bw, 1);
      }
    }

    // 出错标记：角色眉心一个 2x2 红点，便于一眼定位
    if (seat.activity === 'error') {
      g.fillStyle = '#ff5470';
      g.fillRect(Math.round(x) + (isMain ? 17 : 12), Math.round(y) + (isMain ? 6 : 5), 2, 2);
    }
  }

  /**
   * 后墙动态：钟面指针 + 吊灯呼吸。
   * 这两样都在 y<130 的后墙上，用加色混合叠画，不会压到前场角色身上。
   *
   * 参数全部来自规划 §4.2 / §4.3，不要凭手感改：
   *  · 秒针**每秒跳一格**，绝不连续扫 —— 像素画里连续扫会糊成抖动团；
   *  · 三针端点一律 round()，否则亚像素抗锯齿会把 1px 线涂成 2px 灰边；
   *  · 灯光是双正弦叠加、幅度 ≤5%，掉电是 40~90s 一次、仅 120ms 的偶发；
   *    这两条都是"微妙氛围"而不是"故障"的硬约束。
   */
  var INK = '#4a3f33';        // 墙面墨色：时针/分针/钟心
  var CARPET_INK = '#a8304a'; // 地毯暗红：只有秒针用这个色，"在走"才被眼睛抓住
  var LAMP_SLOT_MS = 60000;   // 掉电排期槽长
  var LAMP_OUT_MS = 120;      // 掉电持续时长
  var LAMP_ON_MS = 500;       // 空场 → 有鱼：灯亮起来的过渡
  var LAMP_OFF_MS = 450;      // 鱼全走光 → 灯渐灭的过渡

  /** 确定性伪随机：同一个 (i, k) 永远得到同一个值，刷新页面不会跳变。 */
  function hash01(i, k) {
    var h = (i + 1) * 374761393 + (k + 1) * 668265263;
    h = (h ^ (h >>> 13)) * 1274126177;
    h = (h ^ (h >>> 16)) >>> 0;
    return (h % 100000) / 100000;
  }

  /** 某盏灯在时间 ts 是否处于掉电瞬间（40~90s 一次，持续 120ms）。 */
  function lampOutage(i, ts) {
    var base = Math.floor(ts / LAMP_SLOT_MS);
    for (var d = -1; d <= 1; d += 1) {
      var k = base + d;
      var t0 = k * LAMP_SLOT_MS + hash01(i, k) * (LAMP_SLOT_MS - LAMP_OUT_MS);
      if (ts >= t0 && ts < t0 + LAMP_OUT_MS) return true;
    }
    return false;
  }

  /** 该灯附近是否有正在干活的工位（人多气场足，光晕平均上调 4%）。 */
  function lampBusyBoost(lamp) {
    var snap = S.snapshot;
    var doc = S.seatsDoc;
    if (!snap || !doc) return 0;
    var hit = false;
    if (snap.main && snap.main.agentId && snap.main.activity === 'working') {
      if (Math.abs(doc.main.deskCx - lamp.x) < 110) hit = true;
    }
    if (!hit && Array.isArray(snap.subs)) {
      for (var i = 0; i < snap.subs.length; i += 1) {
        var s = snap.subs[i];
        if (!s || !s.agentId || s.activity !== 'working') continue;
        var sub = doc.subs && doc.subs[i];
        if (sub && Math.abs(sub.deskCx - lamp.x) < 60) { hit = true; break; }
      }
    }
    return hit ? 0.04 : 0;
  }

  function drawBackWallDynamics(g, ts) {
    var doc = S.seatsDoc;

    // --- 挂钟：三针，秒针跳格（§4.3）---
    var clock = doc.clock;
    if (clock) {
      var cx = clock.cx;
      var cy = clock.cy;
      var r = clock.r;
      var minAng = (ts / 60000) * Math.PI * 2 - Math.PI / 2;
      var hourAng = (ts / 720000) * Math.PI * 2 - Math.PI / 2;
      // 秒针：先取整到秒再算角度 → 每秒跳一格，格与格之间角度完全不变
      var secAng = (Math.floor(ts / 1000) / 60) * Math.PI * 2 - Math.PI / 2;

      g.save();
      g.lineCap = 'butt';

      // 分针 0.72r / 1px；时针 0.5r / 2px。端点 round() 保证像素对齐。
      g.strokeStyle = INK;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(Math.round(cx), Math.round(cy));
      g.lineTo(Math.round(cx + Math.cos(minAng) * (r * 0.72)), Math.round(cy + Math.sin(minAng) * (r * 0.72)));
      g.stroke();

      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(Math.round(cx), Math.round(cy));
      g.lineTo(Math.round(cx + Math.cos(hourAng) * (r * 0.5)), Math.round(cy + Math.sin(hourAng) * (r * 0.5)));
      g.stroke();

      // 秒针最后画（压在最上面），唯一有色的一根
      g.strokeStyle = CARPET_INK;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(Math.round(cx), Math.round(cy));
      g.lineTo(Math.round(cx + Math.cos(secAng) * (r * 0.8)), Math.round(cy + Math.sin(secAng) * (r * 0.8)));
      g.stroke();

      // 钟心 2x2 盖住三针根部
      g.fillStyle = INK;
      g.fillRect(Math.round(cx) - 1, Math.round(cy) - 1, 2, 2);
      g.restore();
    }

    // --- 吊灯：双正弦叠加 + 3 圈光晕 + 偶发掉电（§4.2）---
    var lamps = doc.lamps || [];
    for (var i = 0; i < lamps.length; i += 1) {
      var lamp = lamps[i];
      // 慢波 5.5s（呼吸）+ 快波 0.7s（细微抖动），两盏灯相位错开
      var slow = Math.sin(ts / 5500 * Math.PI * 2 + i * 2.1) * 0.045;
      var fast = Math.sin(ts / 700 * Math.PI * 2 + i * 1.3) * 0.015;
      // 空场时整间灯熄灭：lampLevel 由 stepLampLit 按帧间 dt 推出（0..1）。
      // 全灭直接 continue —— 三圈光晕一次 draw 都不花（§4.5 单帧 ≤6 draw 的预算）。
      var lampLevel = typeof S.lampLit === 'number' ? S.lampLit : 0;
      if (lampLevel <= 0.001) continue;
      // 呼吸幅度不额外处理：k 本身 ≤1，乘上 0→1 的 lampLevel 后，
      // 点亮过程中正弦幅度是同步渐入的，不会出现"暗着还在抖"。
      var k = (0.94 + slow + fast + lampBusyBoost(lamp)) * lampLevel;
      if (lampOutage(i, ts)) k *= 0.72;

      // 三圈：外圈最淡、内圈最实；只乘 k，不改变灯罩本体
      var rings = [
        { rx: 1.0, ry: 1.0, a: 0.075 },
        { rx: 0.66, ry: 0.62, a: 0.060 },
        { rx: 0.34, ry: 0.30, a: 0.050 },
      ];
      g.save();
      g.globalCompositeOperation = 'lighter';
      g.fillStyle = '#ffd166';
      for (var ri = 0; ri < rings.length; ri += 1) {
        var ring = rings[ri];
        g.globalAlpha = ring.a * k;
        g.beginPath();
        g.ellipse(lamp.x, lamp.y + lamp.ry * 0.6, lamp.rx * ring.rx, lamp.ry * ring.ry, 0, 0, Math.PI * 2);
        g.fill();
      }
      g.restore();
    }
  }

  // -------------------------------------------------------------------------
  // 气泡（DOM）
  // -------------------------------------------------------------------------

  /** 气泡滚动所需的样式只需注入一次。 */
  var bubbleStyleReady = false;
  function ensureBubbleStyle() {
    if (bubbleStyleReady || !bubbleLayer) return;
    bubbleStyleReady = true;
    var st = document.createElement('style');
    st.setAttribute('data-po-bubble-style', '');
    // · 10 字 / 5 字窗口：外层裁切、内层整段左移；
    // · 微信式小三角：::after 画深色描边、::before 画气泡底色，两层叠出 2px 边。
    st.textContent =
      '@keyframes po-bubble-scroll{'
      + '0%,14%{transform:translateX(0)}'
      + '86%,100%{transform:translateX(var(--po-shift,0px))}'
      + '}'
      + '.po-bubble-win{display:block;overflow:hidden;white-space:nowrap}'
      + '.po-bubble-inner{display:inline-block;white-space:nowrap;'
      + 'animation-name:po-bubble-scroll;animation-timing-function:linear;'
      + 'animation-iteration-count:infinite;will-change:transform;'
      + 'animation-duration:var(--po-dur,4s)}'
      + '.po-bubble-tail::after,.po-bubble-tail::before{content:"";position:absolute;'
      + 'left:var(--po-tail-x,50%);transform:translateX(-50%);width:0;height:0;border-style:solid}'
      + '.po-bubble-tail::after{border-width:9px 8px 0 8px;'
      + 'border-color:#1a1526 transparent transparent transparent;bottom:-11px}'
      + '.po-bubble-tail::before{border-width:6px 5px 0 5px;'
      + 'border-color:var(--po-tail-bg,#fdf6e3) transparent transparent transparent;bottom:-7px;z-index:1}';
    (document.head || document.body).appendChild(st);
  }

  function ensureBubble(seatId, isMain) {
    var el = S.bubbles[seatId];
    if (el) return el;
    var doc = S.seatsDoc;
    ensureBubbleStyle();

    el = document.createElement('div');
    el.setAttribute('data-po-seat', seatId);
    el.style.position = 'absolute';
    el.style.left = '0';
    el.style.bottom = '0';
    el.style.zIndex = isMain ? '30' : String(20 + Number(String(seatId).split(':')[1] || 0));
    el.style.pointerEvents = 'auto';
    el.style.maxWidth = (isMain ? doc.bubble.main.maxW : doc.bubble.sub.maxW) + 'px';
    el.style.background = isMain ? '#fdf6e3' : '#e8eef6';
    el.style.color = '#1a1526';
    el.style.border = '2px solid #1a1526';
    el.style.borderRadius = '6px';
    el.style.padding = '4px 6px';
    el.style.fontSize = isMain ? '11px' : '10px';
    el.style.lineHeight = '1.4';
    el.style.fontFamily = 'ui-monospace, "Cascadia Code", Consolas, monospace';
    el.style.boxShadow = '2px 2px 0 rgba(0,0,0,.5)';
    el.style.overflowWrap = 'anywhere';
    el.style.wordBreak = 'break-word';
    el.style.boxSizing = 'border-box';
    el.style.transition = 'opacity .15s';

    bubbleLayer.appendChild(el);
    S.bubbles[seatId] = el;
    return el;
  }

  /** 逻辑坐标 → stage 的 CSS 像素。 */
  function toStage(logicalX, logicalY, stageW, stageH) {
    // 同 drawSky：seatsDoc 迟到时不能裸解引用（rAF 回调里抛异常 = 帧链断死）
    var sceneW = (S.seatsDoc && S.seatsDoc.scene) ? S.seatsDoc.scene.w : 320;
    var scale = stageW / sceneW;
    return { left: logicalX * scale, bottom: stageH - logicalY * scale };
  }

  /**
   * 此刻这条鱼的气泡该不该藏起来。
   *
   * 用户要求（m03550）：
   *   · 双击播互动特效时气泡消失 —— 否则爱心/🤓👆/😡 全被气泡盖住；
   *   · 鱼被拖出办公室时气泡消失 —— 鱼在画布外飘着、气泡还钉在原位很怪。
   * 本质上"看不清鱼在干什么"的时刻都不该有气泡，所以一并把被抓、懵逼、
   * 走回、重进、出逃、掉落、睡着这些状态算进来。
   */
  function bubbleHiddenFor(seatId, seat) {
    var now = performanceNow();
    var a = S.act[seatId];
    if (a) {
      // 三级互动特效窗口：L1 2.6s / L2 5.6s / L3 9s 内 busyUntil 都大于 now
      if (a.busyUntil > now) return true;
      if (a.hidden) return true;
      if (a.fall) return true;
      if (a.phase === 'grabbed' || a.phase === 'confused' || a.phase === 'walkhome'
        || a.phase === 'reenter' || a.phase === 'escaping' || a.phase === 'parade'
        || a.phase === 'falling') return true;
      if (a.pos && isOutOfCanvas(seatId, now)) return true;
    }
    if (S.parade) return true;
    // 睡着的鱼头上改冒 zzz（点阵在 drawActor 里画），不挂气泡
    if (seat && seat.activity === 'asleep') return true;
    return false;
  }

  function renderBubble(seatId, seat, stageW, stageH) {
    var isMain = seatId === 'main';
    // 气泡规则（m01404 / m01439）：
    //   · 文字一律不截断。窗口只决定"同时看得到几个字"：
    //     主鱼 10 个字、副鱼 5 个字；超出的部分在窗口里横向循环滚动，整段都会读到。
    //   · 外形是微信式：圆角气泡 + 底部一个指向鱼头顶的小三角，位置就在鱼上方一点，
    //     既不压住鱼，也不飘太远。
    var win = isMain ? MAIN_WINDOW_CHARS : BUBBLE_SUB_CHARS;

    // 该藏的场合优先于"有没有文字"：空气泡也不该留在屏幕上。
    if (bubbleHiddenFor(seatId, seat)) {
      var goneEl = S.bubbles[seatId];
      if (goneEl) { goneEl.remove(); delete S.bubbles[seatId]; }
      return;
    }

    var bub = (seat && seat.agentId && seat.bubble) ? seat.bubble : null;
    var fullRaw = bub ? (bub.text || '') : '';
    var headline = bub ? (bub.headline || '') : '';
    // 主鱼与副鱼一个逻辑：都是"窗口窄、内容全、横向滚动"。
    // 主鱼窗口 10 字、副鱼 5 字；副鱼的 headline 只是滚动播到的那一小段起手句，
    // 正文优先，headline 只在旧快照/假数据缺正文时兜底。
    var text = fullRaw || headline;

    // 滚动速度守恒：走完一屏最多给 SCROLL_MAX_DUR 秒，按 SCROLL_CPS 字/秒算，
    // 一屏最多也就放得下 SCROLL_MAX_DUR*SCROLL_CPS 个字。正文再长就只滚
    // 最近这一段（streaming 时最新内容在后面，读感也更像"正在说这句"）。
    // 不这么做的话 4000 字被压进 16 秒 = 2500px/s，肉眼完全跟不上。
    var maxBubbleChars = Math.max(win, Math.round(SCROLL_MAX_DUR * SCROLL_CPS));
    if (text.length > maxBubbleChars) {
      text = '…' + text.slice(-maxBubbleChars);
    }

    if (!text) {
      var stale = S.bubbles[seatId];
      if (stale) { stale.remove(); delete S.bubbles[seatId]; }
      return;
    }

    var pos = seatPosition(seatId);
    if (!pos) return;
    var el = ensureBubble(seatId, isMain);
    var doc = S.seatsDoc;
    var scale = stageW / doc.scene.w;

    var typing = !!(bub && bub.streaming);
    var caret = typing ? '<span style="opacity:.45">▍</span>' : '';
    var html = '<span class="po-bubble-win">'
      + '<span class="po-bubble-inner" data-po-scroll="1">' + esc(text) + caret + '</span></span>';

    if (el._poHtml !== html) {
      el.innerHTML = html;
      el._poHtml = html;
    }
    el.classList.add('po-bubble-tail');
    el.style.setProperty('--po-tail-bg', isMain ? '#fdf6e3' : '#e8eef6');

    // 同一排的副气泡必然横向重叠（列距约 62px，气泡宽得多），所以纵向分三层错开。
    // ⚠ 这件事必须在"避让计算"之前定下来：marginBottom 会改变气泡实际占的纵向空间，
    // 等算完避让再设，气泡就会按没有错层的位置判定，结果压到别的鱼身上。
    var stagger = 0;
    if (!isMain) {
      var idx = Number(String(seatId).split(':')[1]);
      stagger = (idx % 3) * 34;
    }
    el.style.marginBottom = stagger + 'px';

    // 窗口宽度按真实字宽量，不靠估算：把 content 的宽度逐字加上去。
    // 等宽字体下 CJK 与西文字宽不同，光按 fontSize 猜会差 2~3 个字。
    // +16 = 左右 padding(6+6) + 左右 border(2+2)：el 是 border-box，而下面
    // 算可用宽度用的是 clientWidth（已扣 border）再减 padding，所以这里必须把
    // 两份都补上。曾经写 +12，正好少 4px，于是任何刚好填满窗口的短句（副鱼 5 字）
    // 都会恒定溢出 4px，被 overflow>2 判成"要滚动"，气泡就原地来回抖。
    var charW = measureCharWidth(el, isMain);
    var winW = Math.min(
      isMain ? doc.bubble.main.maxW : doc.bubble.sub.maxW,
      Math.ceil(win * charW) + 16
    );
    el.style.maxWidth = winW + 'px';
    el.style.maxHeight = (isMain ? BUBBLE_MAXH_MAIN : BUBBLE_MAXH_SUB) + 'px';
    // 注意：这里不能给 el 设 overflow:hidden —— 小三角是 ::after 画在 el 外沿（bottom:-11px），
    // 一旦裁切就整条消失。裁剪交给内层 .po-bubble-win。
    el.style.overflow = 'visible';

    // 锚点：鱼头顶正上方一点。sprite 是从 pos.y 往下画的，所以 pos.y 就是头顶那条线。
    var spriteW = isMain ? doc.spriteSize.main : doc.spriteSize.sub;
    var head = toStage(pos.x + spriteW / 2, pos.y, stageW, stageH);
    var headCssX = head.left;
    var headCssTop = stageH - head.bottom;   // 左上原点的头顶 y

    var margin = 4;
    el.style.left = '0px';
    el.style.transform = 'none';
    var bw = el.offsetWidth || winW;
    var bh = el.offsetHeight || 22;
    var wantLeft = headCssX - bw / 2;
    var maxLeft = Math.max(margin, stageW - bw - margin);
    var leftCss = Math.round(clamp(wantLeft, margin, maxLeft));
    el.style.left = leftCss + 'px';

    // 小三角高度 11px：气泡底边放在头顶上方 13px，三角尖端刚好落在头顶上方 2px。
    var TAIL_H = 11;
    // marginBottom 是错层偏移，它把气泡整体往上推了 stagger，这里要算进底边。
    var bubbleBottomCss = headCssTop - TAIL_H - 2 + stagger;

    // 不压到任何一条鱼（含自己）：从理想位置往上顶，三角仍朝下，只挪气泡。
    // 从"自己的头顶"开始判会永远相交，所以跳过自己这一条。
    var fish = fishBoxes(stageW, stageH, seatId);
    for (var attempt = 0; attempt < 24; attempt += 1) {
      var top = bubbleBottomCss - bh;
      if (top <= 2) break;
      var hit = false;
      for (var fi = 0; fi < fish.length; fi += 1) {
        var fb = fish[fi];
        if (fb.self) continue;
        if (leftCss < fb.right && leftCss + bw > fb.left && top < fb.bottom && top + bh > fb.top) {
          hit = true;
          break;
        }
      }
      if (!hit) break;
      bubbleBottomCss -= 8;
    }
    // 顶部钳制：气泡不许跑出面板上沿（此时三角可能离开鱼头顶，但仍指向它）
    if (bubbleBottomCss - bh < 2) bubbleBottomCss = bh + 2;
    el.style.bottom = Math.round(stageH - bubbleBottomCss) + 'px';

    // 三角对准鱼头顶：算出鱼头顶在气泡内的相对横坐标并钳进 [10, bw-10]。
    var tailX = clamp(Math.round(headCssX - leftCss), 10, Math.max(10, bw - 10));
    el.style.setProperty('--po-tail-x', tailX + 'px');

    // 滚动：量出溢出量，按"每秒约 3 个字"定动画时长。
    // 正文再长也不能让速度失控 —— 速度恒定时长会线性变长，所以先按
    // 最长可读时长反推出"最多滚多少字"，超出的尾巴裁掉（一轮结束的汇报
    // 本来就已被 host 换成固定短句，这里保的是极端长句的兜底）。
    var inner = el.querySelector('[data-po-scroll]');
    if (inner) {
      var avail = Math.max(1, el.clientWidth - 12);
      var overflow = inner.scrollWidth - avail;
      // 设置里关掉动画 → 气泡不滚，超出窗口的部分直接裁掉（.po-bubble-win
      // 本身就是 overflow:hidden），保证「关动画」时画面是完全静止的。
      if (CFG.animate === false) {
        inner.style.animation = 'none';
        inner.style.animationPlayState = 'paused';
        inner.style.setProperty('--po-shift', '0px');
        return;
      }
      if (overflow > 2) {
        // 3 字/秒 ≈ charW*3 px/秒；时长 = 距离 / 速度，并夹在可读区间内。
        var pxPerSec = charW * SCROLL_CPS;
        var dur = Math.max(SCROLL_MIN_DUR, Math.min(SCROLL_MAX_DUR, overflow / pxPerSec));
        inner.style.setProperty('--po-shift', '-' + Math.round(overflow) + 'px');
        inner.style.setProperty('--po-dur', dur.toFixed(1) + 's');
        inner.style.animation = '';
        inner.style.animationPlayState = 'running';
      } else {
        inner.style.animation = 'none';
        inner.style.setProperty('--po-shift', '0px');
      }
    }
  }

  /**
   * 量一个 CJK 字的真实像素宽度。等宽字体下 CJK 与西文宽度不同，
   * 按 fontSize 硬猜会让 10 字窗口实际塞进 13 个字。
   */
  function measureCharWidth(el, isMain) {
    var probe = el.querySelector('[data-po-probe]');
    if (!probe) {
      probe = document.createElement('span');
      probe.setAttribute('data-po-probe', '');
      probe.style.position = 'absolute';
      probe.style.visibility = 'hidden';
      probe.style.whiteSpace = 'pre';
      probe.style.pointerEvents = 'none';
      probe.style.font = (isMain ? '11px' : '10px') + ' ui-monospace, "Cascadia Code", Consolas, monospace';
      probe.textContent = '\u56fd\u56fd\u56fd\u56fd\u56fd\u56fd\u56fd\u56fd';
      el.appendChild(probe);
    }
    var w = probe.getBoundingClientRect().width;
    if (!w || !isFinite(w)) return isMain ? 11 : 10;
    return w / 8;
  }

  /**
   * 所有在场角色的屏幕包围盒（CSS 像素，左上原点），供气泡避让。
   * 只收真正会被画出来的：有人、没隐身。selfId 命中的那一条会被标 self，
   * 气泡不去避让它自己。
   */
  function fishBoxes(stageW, stageH, selfId) {
    var out = [];
    var snap = S.snapshot;
    var doc = S.seatsDoc;
    if (!snap || !doc) return out;
    var scale = stageW / doc.scene.w;
    var push = function (seatId, seat, isMain) {
      if (!seat || !seat.agentId) return;
      var a = S.act[seatId];
      if (a && a.hidden) return;
      var pos = seatPosition(seatId);
      if (!pos) return;
      var w = isMain ? doc.spriteSize.main : doc.spriteSize.sub;
      var h = spriteHeightFor(seatId) || (isMain ? 51 : 41);
      var anchor = toStage(pos.x, pos.y, stageW, stageH);
      // toStage 给的是 CSS bottom 值；换成左上原点的 top/bottom 好做矩形相交
      var boxTop = stageH - anchor.bottom;
      out.push({
        self: seatId === selfId,
        left: anchor.left,
        right: anchor.left + w * scale,
        top: boxTop,
        bottom: boxTop + h * scale,
      });
    };
    push('main', snap.main, true);
    if (Array.isArray(snap.subs)) {
      snap.subs.forEach(function (seat, i) { push('sub:' + i, seat, false); });
    }
    return out;
  }

  /** 节流到 ~15fps 的重排。 */
  var lastBubblePass = 0;
  function bubblePass(ts) {
    if (!S.seatsDoc || !cv || !bubbleLayer) return;
    if (ts - lastBubblePass < 66) return;
    lastBubblePass = ts;

    var rect = cv.getBoundingClientRect();
    if (rect.width < 1) return;
    var stageW = rect.width;
    var stageH = rect.height;

    var alive = {};
    var snap = S.snapshot;
    if (snap) {
      if (snap.main) {
        alive.main = true;
        renderBubble('main', snap.main, stageW, stageH);
      }
      if (Array.isArray(snap.subs)) {
        snap.subs.forEach(function (seat, i) {
          if (!seat) return;
          alive['sub:' + i] = true;
          renderBubble('sub:' + i, seat, stageW, stageH);
        });
      }
    }
    Object.keys(S.bubbles).forEach(function (seatId) {
      if (!alive[seatId]) {
        S.bubbles[seatId].remove();
        delete S.bubbles[seatId];
      }
    });
  }

  // -------------------------------------------------------------------------
  // 文件预览
  // -------------------------------------------------------------------------

  function openPreview(filePath) {
    if (!filePath) return;
    var pane = rootEl && rootEl.querySelector('[data-po-preview]');
    if (!pane) return;
    // 预览在卡片内部，最小化状态下点文件要先展开
    if (panelApi && typeof panelApi.setMinimized === 'function') panelApi.setMinimized(false);
    pane.style.display = 'flex';
    pane.setAttribute('data-po-open', '1');

    var title = pane.querySelector('[data-po-preview-title]');
    var body = pane.querySelector('[data-po-preview-body]');
    if (title) title.textContent = String(filePath).split(/[\\/]/).pop() || filePath;
    if (body) body.textContent = L.loading;

    getJson(API + '/file?path=' + encodeURIComponent(filePath)).then(function (data) {
      if (!body) return;
      if (!data || !data.ok) {
        body.textContent = L.loadFail + ((data && data.error) || L.unknownError);
        return;
      }
      if (data.kind === 'image') {
        body.textContent = '';
        var img = document.createElement('img');
        img.src = data.url;
        img.style.maxWidth = '100%';
        img.style.imageRendering = 'pixelated';
        img.style.display = 'block';
        body.appendChild(img);
      } else {
        body.textContent = data.text || '';
      }
    }).catch(function (err) {
      if (body) body.textContent = L.loadFail + (err && err.message ? err.message : String(err));
    });
  }

  // -------------------------------------------------------------------------
  // DOM 骨架
  // -------------------------------------------------------------------------

  /** 小按钮工厂。 */
  function mkBtn(text, title) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    if (title) b.title = title;
    b.style.background = 'transparent';
    b.style.border = '1px solid #3a3048';
    b.style.color = '#c9c2dd';
    b.style.font = 'inherit';
    b.style.cursor = 'pointer';
    b.style.padding = '0 5px';
    b.style.lineHeight = '15px';
    b.style.borderRadius = '3px';
    b.style.flex = '0 0 auto';
    // 按钮必须自己收事件，不能被窗口拖拽区接管
    b.style.webkitAppRegion = 'no-drag';
    b.style.appRegion = 'no-drag';
    return b;
  }

  // -------------------------------------------------------------------------
  // 位置 / 折叠状态的持久化
  // -------------------------------------------------------------------------

  var UI_KEY = 'dsh-pixel-office.ui';
  var CFG_KEY = 'dsh-pixel-office.settings';

  // -------------------------------------------------------------------------
  // 设置项落地（规划 P12）
  // -------------------------------------------------------------------------

  function saveSettings() {
    try {
      var o = {};
      for (var i = 0; i < SETTING_KEYS.length; i += 1) o[SETTING_KEYS[i]] = CFG[SETTING_KEYS[i]];
      localStorage.setItem(CFG_KEY, JSON.stringify(o));
    } catch (e) { /* 隐私模式下写不了，忽略 */ }
  }

  /**
   * 把 CFG 应用到运行时。
   *
   * 三件事：
   *  1. 帧间隔与走速 —— 直接改 WALK_SPEED / *_FRAME_MS 这几个**可变**模块变量，
   *     所有走路插值、帧轮播都引用它们，改一处全生效；
   *  2. 面板宽度 —— 卡片宽度按 scale 缩放，canvas 是 width:100% 跟着变的，
   *     逻辑分辨率不变（始终 320×431），只是显示更大更清晰；
   *  3. 动画开关 —— 关掉后不管走路插值，直接落座（`stepEnter` / `stepAct`
   *     里都用 `CFG.animate` 判断），气泡也不滚。
   */
  function applySettings() {
    // 1) 速度：倍率越大，走速越快、帧间隔越短
    var sp = CFG.speed > 0 ? CFG.speed : 1;
    WALK_SPEED = BASE_WALK_SPEED * sp;
    WALK_FRAME_MS = Math.max(40, Math.round(BASE_WALK_FRAME_MS / sp));
    TYPE_FRAME_MS = Math.max(40, Math.round(BASE_TYPE_FRAME_MS / sp));
    IDLE_FRAME_MS = Math.max(120, Math.round(BASE_IDLE_FRAME_MS / sp));

    // 2) 尺寸：卡片宽度随档位变，canvas 逻辑尺寸不变
    var w = Math.round(PANEL_W * CFG.scale);

    // 3) 可见性与动画
    if (panelApi && typeof panelApi.applySettings === 'function') {
      try { panelApi.applySettings(CFG, w); } catch (e) { /* 面板还没建好，忽略 */ }
    }
  }

  function loadSettings(inject) {
    var stored = {};
    try {
      var raw = localStorage.getItem(CFG_KEY);
      if (raw) stored = JSON.parse(raw);
    } catch (e) { stored = {}; }
    var norm = normalizeSettings(stored);
    for (var i = 0; i < SETTING_KEYS.length; i += 1) {
      var k = SETTING_KEYS[i];
      CFG[k] = norm[k];
    }
    L = pickLocale(inject);
    applySettings();
  }

  function loadUiState() {
    try {
      var raw = localStorage.getItem(UI_KEY);
      if (!raw) return {};
      var o = JSON.parse(raw);
      return o && typeof o === 'object' ? o : {};
    } catch (e) {
      return {};
    }
  }

  function saveUiState(patch) {
    try {
      var o = loadUiState();
      Object.keys(patch).forEach(function (k) { o[k] = patch[k]; });
      localStorage.setItem(UI_KEY, JSON.stringify(o));
    } catch (e) { /* 隐私模式下写不了，忽略 */ }
  }

  /**
   * 把坐标夹进可视区，保证标题条始终可抓。
   *
   * 上边界不能是 0：DSH 桌面端是 Electron 无边框窗口，窗口顶部那一条带
   * 属于窗口标题栏/顶栏（可能由独立 WebContentsView 承载，也可能是
   * `-webkit-app-region: drag` 拖拽区）。落在带内的面板**看得见、DOM 也
   * 命中得到**（elementsFromPoint 会列出它），但鼠标按下事件根本不会
   * 送进渲染进程 —— 表现就是按钮点不动、标题条拖不动。
   * 实测面板曾被存到 y=13.33px 正压在这条带上，所以这里强制留出安全边。
   */
  var SAFE_TOP = 52;

  function clampPos(x, y, w, h) {
    var maxX = Math.max(0, window.innerWidth - Math.min(w, 80));
    var maxY = Math.max(SAFE_TOP, window.innerHeight - 32);
    return {
      x: Math.min(Math.max(0, x), maxX),
      y: Math.min(Math.max(SAFE_TOP, y), maxY),
    };
  }

  /**
   * DSH 开屏（boot 页）门控：开屏期间先藏插件，开屏结束再显示。
   *
   * 为什么需要：插件 apply() 在 DSH 的 runPluginBoot 阶段执行，早于 mountApp，
   * 所以插件 DOM 一定和开屏动画重叠。
   *
   * 检测手段（多重兜底，任一命中就继续藏）：
   *   1. [data-dsh-boot]        —— boot 页根节点（dataset 常量，不随构建哈希变）
   *   2. [data-dsh-boot-spinner]—— boot 页加载圈
   *   3. class 含 _onboardingOverlay_ —— onboarding 遮罩（它会让 #root inert）
   *   4. #root 的 inert 属性      —— onboarding 期间 DSH 会置 true
   * 兜底出口：MutationObserver + 150ms 轮询 + 8s 硬超时；首帧就找不到任何痕迹 → 立刻显示。
   * 全程只用 DOM，不 inject 任何 service（inject 非空会让 web boot 失败）。
   */
  var bootGateStop = null;

  function bootOverlayPresent() {
    try {
      if (document.querySelector('[data-dsh-boot]')) return true;
      if (document.querySelector('[data-dsh-boot-spinner]')) return true;
      if (document.querySelector('[class*="_onboardingOverlay_"]')) return true;
      var dshRoot = document.getElementById('root');
      if (dshRoot && dshRoot.inert === true) return true;
    } catch (e) { /* 选择器/属性异常一律当作"没有开屏" */ }
    return false;
  }

  function holdUntilBootDone(node) {
    if (!node) return;
    var shown = false;
    var obs = null;
    var iv = 0;
    var guard = 0;

    function show() {
      if (shown) return;
      shown = true;
      if (obs) { try { obs.disconnect(); } catch (e) { /* 忽略 */ } obs = null; }
      if (iv) { clearInterval(iv); iv = 0; }
      if (guard) { clearTimeout(guard); guard = 0; }
      S.bootGateIv = null;
      S.bootGateGuard = null;
      bootGateStop = null;
      node.style.display = '';
    }

    function check() {
      if (S.dead) { show(); return; }
      if (!bootOverlayPresent()) show();
    }

    // 首帧就找不到开屏痕迹（普通浏览器、或 DSH 已完成启动）→ 直接显示
    if (!bootOverlayPresent()) return;

    node.style.display = 'none';
    try {
      obs = new MutationObserver(check);
      obs.observe(document.body, { childList: true, subtree: true });
    } catch (e) { obs = null; }
    iv = setInterval(check, 150);
    guard = setTimeout(show, 8000);   // 硬兜底：最多藏 8s，绝不永久隐身
    // 句柄同时挂在 S 上，dispose() 才收得掉（门控成功结束时 bootGateStop 已被置空，
    // 光靠它兜不住，会在已卸载的页面上继续跑 150ms 轮询）。
    S.bootGateIv = iv;
    S.bootGateGuard = guard;
    bootGateStop = show;
  }

  /**
   * 木牌默认 X：落在主内容区左上角（左侧边栏右边一点）。
   *
   * 探测顺序：
   *   1. [data-dockkit-surface] —— DSH 主内容区根节点，它的 left 就是"侧栏右沿"。
   *   2. 探测不到 → 退回 12px（宁可贴左，也不要把木牌藏到看不见的地方）。
   * 结果再夹一层，保证木牌整体在视口内。
   */
  function defaultSignX() {
    var left = 0;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    // 主内容区的左边界。DSH 桌面端的 DOM 结构没有公开契约，class 名是压缩过的
    // （实测 main 内容列叫 DIV.BynINW_centerCol），所以不能靠选择器硬编码。
    // 做法：在视口中心偏右的位置点一下，取该点元素链里第一个"足够大的、left>0"
    // 的祖先——那就是主内容区的左上角（左侧边栏的 right 边界）。
    try {
      var probe = document.elementsFromPoint(Math.round(vw * 0.6), Math.round(vh * 0.5));
      for (var i = 0; i < probe.length; i += 1) {
        var pr = probe[i].getBoundingClientRect();
        if (pr && pr.left > 0 && pr.width > vw * 0.35 && pr.height > vh * 0.35) {
          left = Math.round(pr.left);
          break;
        }
      }
    } catch (e) { /* 探测失败就走下面的选择器兜底 */ }
    // 兜底：几何探测没结果时试几个常见语义选择器。
    if (!left) {
      var sel = ['[data-dockkit-surface]', '[data-dsh-main]', '[role="main"]', 'main',
        '[class*="centerCol"]', '[class*="mainContent"]', '[class*="contentArea"]'];
      for (var k = 0; k < sel.length && !left; k += 1) {
        try {
          var el = document.querySelector(sel[k]);
          if (!el) continue;
          var r = el.getBoundingClientRect();
          if (r && r.width > 200 && r.height > 200 && r.left > 0 && r.left < vw - 120) {
            left = Math.round(r.left);
          }
        } catch (e) { /* 选择器不合法，继续试下一个 */ }
      }
    }
    var x = left + 12;
    var maxX = Math.max(12, vw - SIGN_W - 12);
    return Math.round(Math.min(Math.max(x, 12), maxX));
  }

  /**
   * 悬浮卡片。
   * 布局：一张贴着场景大小的浮动卡，标题条可拖动，位置与折叠态存 localStorage；
   * 最小化后只剩一块像素木牌。每次启动都强制从木牌态开始（用户要求），
   * 默认落在主内容区左上角、避开 Electron 顶部标题栏带（SAFE_TOP）。
   */
  function buildPanel() {
    var ui = loadUiState();

    var root = document.createElement('div');
    root.setAttribute('data-dsh-plugin', 'pixel-office');
    root.setAttribute('data-pixel-office-root', '');
    root.style.position = 'fixed';
    // 卡片要浮在 DSH 自身所有浮层（对话框、通知条、调试条）之上，否则会被
    // 一层看不见的覆盖层吃掉 pointerdown → 按钮点不动、标题条拖不动。
    root.style.zIndex = String(PANEL_Z);
    root.style.fontFamily = 'ui-monospace, "Cascadia Code", Consolas, monospace';
    root.style.color = '#c9c2dd';
    root.style.userSelect = 'none';
    root.style.pointerEvents = 'auto';
    // 显式声明整棵面板不参与窗口拖拽：Electron 里若某块区域被标成 drag，
    // 鼠标事件会被窗口管理器接管、页面收不到 press。面板要自己拖，不能交给壳。
    root.style.webkitAppRegion = 'no-drag';
    root.style.appRegion = 'no-drag';

    // --- 卡片本体 -----------------------------------------------------------
    var card = document.createElement('div');
    card.setAttribute('data-po-card', '');
    card.style.width = Math.round(PANEL_W * CFG.scale) + 'px';
    card.style.display = 'flex';
    card.style.flexDirection = 'column';
    card.style.background = '#1a1526';
    card.style.border = '2px solid #0d0a14';
    card.style.borderRadius = '4px';
    card.style.boxShadow = '0 6px 22px rgba(0,0,0,.55)';
    card.style.overflow = 'hidden';
    card.style.position = 'relative';
    card.style.willChange = 'transform, opacity';
    card.style.transformOrigin = '50% 50%';
    card.style.backfaceVisibility = 'hidden';

    // --- 标题条（拖动把手） ---
    var bar = document.createElement('div');
    bar.setAttribute('data-po-bar', '');
    bar.style.display = 'flex';
    bar.style.alignItems = 'center';
    bar.style.gap = '5px';
    bar.style.padding = '4px 6px';
    bar.style.background = '#221b30';
    bar.style.borderBottom = '1px solid #0d0a14';
    bar.style.fontSize = '10px';
    bar.style.letterSpacing = '.08em';
    bar.style.flex = '0 0 auto';
    bar.style.cursor = 'grab';
    bar.style.webkitAppRegion = 'no-drag';
    bar.style.appRegion = 'no-drag';

    var dot = document.createElement('span');
    dot.setAttribute('data-po-dot', '');
    dot.style.width = '6px';
    dot.style.height = '6px';
    dot.style.borderRadius = '50%';
    dot.style.background = '#4a4258';
    dot.style.flex = '0 0 auto';

    var label = document.createElement('span');
    label.setAttribute('data-po-title', '');
    label.textContent = L.title;
    label.style.opacity = '.7';
    label.style.flex = '1';
    label.style.overflow = 'hidden';
    label.style.whiteSpace = 'nowrap';

    var setBtn = mkBtn(L.settings, L.settingsTitle);
    var minBtn = mkBtn(L.min, L.minTitle);

    bar.appendChild(dot);
    bar.appendChild(label);
    bar.appendChild(setBtn);
    bar.appendChild(minBtn);

    // --- 场景舞台 ---
    var stage = document.createElement('div');
    stage.setAttribute('data-po-stage', '');
    stage.style.position = 'relative';
    stage.style.flex = '0 0 auto';
    stage.style.background = '#120f1c';
    stage.style.overflow = 'hidden';

    // --- 预览面板（默认隐藏；打开时长高但不超过视口一半） ---
    var preview = document.createElement('div');
    preview.setAttribute('data-po-preview', '');
    preview.setAttribute('data-po-open', '0');
    preview.style.display = 'none';
    preview.style.flexDirection = 'column';
    preview.style.flex = '0 1 auto';
    preview.style.maxHeight = '46vh';
    preview.style.minHeight = '0';
    preview.style.borderTop = '2px solid #0d0a14';
    preview.style.background = '#141122';

    var phd = document.createElement('div');
    phd.style.display = 'flex';
    phd.style.alignItems = 'center';
    phd.style.gap = '5px';
    phd.style.padding = '3px 6px';
    phd.style.background = '#221b30';
    phd.style.fontSize = '10px';
    phd.style.flex = '0 0 auto';

    var ptitle = document.createElement('span');
    ptitle.setAttribute('data-po-preview-title', '');
    ptitle.style.flex = '1';
    ptitle.style.overflow = 'hidden';
    ptitle.style.textOverflow = 'ellipsis';
    ptitle.style.whiteSpace = 'nowrap';

    var pclose = mkBtn(L.close, L.closeTitle);
    pclose.addEventListener('click', function () {
      preview.style.display = 'none';
      preview.setAttribute('data-po-open', '0');
    });

    phd.appendChild(ptitle);
    phd.appendChild(pclose);

    var pbody = document.createElement('pre');
    pbody.setAttribute('data-po-preview-body', '');
    pbody.style.flex = '1 1 auto';
    pbody.style.margin = '0';
    pbody.style.padding = '6px';
    pbody.style.overflow = 'auto';
    pbody.style.fontSize = '10px';
    pbody.style.lineHeight = '1.5';
    pbody.style.whiteSpace = 'pre-wrap';
    pbody.style.overflowWrap = 'anywhere';
    pbody.style.color = '#b9b1cf';

    preview.appendChild(phd);
    preview.appendChild(pbody);

    // --- 设置面板（默认收起，点标题条 ⚙ 展开）-------------------------------
    var settings = document.createElement('div');
    settings.setAttribute('data-po-settings', '');
    settings.setAttribute('data-po-open', '0');
    settings.style.display = 'none';
    settings.style.flexDirection = 'column';
    settings.style.gap = '4px';
    settings.style.padding = '6px 8px';
    settings.style.borderTop = '2px solid #0d0a14';
    settings.style.background = '#141122';
    settings.style.fontSize = '10px';
    settings.style.flex = '0 0 auto';

    /** 一行「标签 + 分段按钮组」。返回 {row, sync}，sync 用来把当前值刷到按钮上。 */
    function mkSegRow(text, values, names, get, set) {
      var row = document.createElement('div');
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.gap = '5px';

      var tag = document.createElement('span');
      tag.textContent = text;
      tag.style.opacity = '.62';
      tag.style.flex = '0 0 52px';

      var group = document.createElement('div');
      group.style.display = 'flex';
      group.style.gap = '3px';
      group.style.flex = '1 1 auto';

      var btns = [];
      values.forEach(function (v, i) {
        var b = mkBtn(names[i], names[i]);
        b.setAttribute('data-po-val', String(v));
        b.addEventListener('click', function () { set(v); sync(); });
        btns.push(b);
        group.appendChild(b);
      });

      function sync() {
        var cur = get();
        btns.forEach(function (b) {
          var on = Number(b.getAttribute('data-po-val')) === cur;
          // 选中态靠反色，不做额外 DOM 结构
          b.style.background = on ? '#c9c2dd' : 'transparent';
          b.style.color = on ? '#1a1526' : '#c9c2dd';
          b.style.borderColor = on ? '#c9c2dd' : '#3a3048';
        });
      }

      row.appendChild(tag);
      row.appendChild(group);
      return { row: row, sync: sync };
    }

    // 显隐
    var visRow = mkSegRow(
      L.visible, [1, 0], [L.on, L.off],
      function () { return CFG.visible ? 1 : 0; },
      function (v) { CFG.visible = v === 1; saveSettings(); applySettings(); syncAll(); }
    );

    // 尺寸
    var scaleRow = mkSegRow(
      L.scale, SCALE_STEPS, L.scaleNames,
      function () { return CFG.scale; },
      function (v) { CFG.scale = v; saveSettings(); applySettings(); syncAll(); }
    );

    // 速度
    var speedRow = mkSegRow(
      L.speed, SPEED_STEPS, L.speedNames,
      function () { return CFG.speed; },
      function (v) { CFG.speed = v; saveSettings(); applySettings(); syncAll(); }
    );

    // 动画开关
    var animRow = mkSegRow(
      L.animate, [1, 0], [L.on, L.off],
      function () { return CFG.animate ? 1 : 0; },
      function (v) { CFG.animate = v === 1; saveSettings(); applySettings(); syncAll(); }
    );

    var resetRow = document.createElement('div');
    resetRow.style.display = 'flex';
    resetRow.style.justifyContent = 'flex-end';
    var resetBtn = mkBtn(L.reset, L.reset);
    resetBtn.addEventListener('click', function () {
      var d = SETTING_DEFAULTS;
      CFG.visible = d.visible;
      CFG.scale = d.scale;
      CFG.speed = d.speed;
      CFG.animate = d.animate;
      saveSettings();
      applySettings();
      syncAll();
    });
    resetRow.appendChild(resetBtn);

    function syncAll() {
      visRow.sync();
      scaleRow.sync();
      speedRow.sync();
      animRow.sync();
    }

    settings.appendChild(visRow.row);
    settings.appendChild(scaleRow.row);
    settings.appendChild(speedRow.row);
    settings.appendChild(animRow.row);
    settings.appendChild(resetRow);
    syncAll();

    setBtn.addEventListener('click', function () {
      var open = settings.getAttribute('data-po-open') === '1';
      settings.setAttribute('data-po-open', open ? '0' : '1');
      settings.style.display = open ? 'none' : 'flex';
    });

    card.appendChild(bar);
    card.appendChild(stage);
    card.appendChild(settings);
    card.appendChild(preview);

    // --- 最小化后的像素木牌 -------------------------------------------------
    var sign = document.createElement('div');
    sign.setAttribute('data-po-sign', '');
    sign.title = L.signTitle;
    sign.style.display = 'none';
    sign.style.cursor = 'grab';
    sign.style.lineHeight = '0';
    sign.style.filter = 'drop-shadow(0 4px 10px rgba(0,0,0,.6))';
    sign.style.transformOrigin = '50% 50%';
    sign.style.willChange = 'transform, opacity';

    var signImg = document.createElement('img');
    signImg.setAttribute('data-po-sign-img', '');
    signImg.alt = '';
    signImg.draggable = false;
    signImg.style.width = SIGN_W + 'px';
    signImg.style.height = 'auto';
    signImg.style.display = 'block';
    signImg.style.imageRendering = 'pixelated';
    signImg.style.pointerEvents = 'none';

    // 木牌素材缺失时退化成一块纯 CSS 小木牌，保证最小化态仍可点击展开
    var signFallback = document.createElement('div');
    signFallback.setAttribute('data-po-sign-fallback', '');
    signFallback.textContent = L.signFallback;
    signFallback.style.display = 'none';
    signFallback.style.padding = '8px 10px';
    signFallback.style.background = '#5a3a28';
    signFallback.style.border = '2px solid #2a1a12';
    signFallback.style.borderRadius = '3px';
    signFallback.style.color = '#ffd166';
    signFallback.style.fontSize = '10px';
    signFallback.style.letterSpacing = '.1em';
    signFallback.style.lineHeight = '1';

    signImg.addEventListener('error', function () {
      signImg.style.display = 'none';
      signFallback.style.display = 'block';
    });
    signImg.src = assetUrl(SIGN_SRC);

    sign.appendChild(signImg);
    sign.appendChild(signFallback);

    root.appendChild(card);
    root.appendChild(sign);

    // --- 位置 ---------------------------------------------------------------
    // 每次启动都强制最小化成木牌（用户要求：重启后默认就是木牌，不恢复上次展开态）。
    // 木牌与卡片共用 root 的 left/top（sign 自己没有定位），所以"木牌在哪"就是这里的
    // pos 初值：主内容区左上角、避开 SAFE_TOP 那条 Electron 标题栏带。
    var startMinimized = true;
    var pos = startMinimized
      ? { x: defaultSignX(), y: SAFE_TOP + 8 }
      : {
        x: typeof ui.x === 'number' ? ui.x : Math.max(8, window.innerWidth - Math.round(PANEL_W * CFG.scale) - 24),
        y: typeof ui.y === 'number' ? ui.y : 96,
      };

    // 木牌尺寸缓存：隐藏态 offsetWidth 为 0，需要临时量一次
    var minimized = startMinimized;   // 当前是否处于最小化（提前声明，applyPos 要用）
    var signSizeCache = { w: SIGN_W + 2, h: Math.round(SIGN_W * 0.87) };
    var signMeasured = false;
    function signSize() {
      if (signMeasured) return signSizeCache;
      var prevD = sign.style.display;
      var prevV = sign.style.visibility;
      sign.style.visibility = 'hidden';
      sign.style.display = 'block';
      if (sign.offsetWidth > 0) {
        signSizeCache = { w: sign.offsetWidth, h: sign.offsetHeight };
        signMeasured = true;
      }
      sign.style.display = prevD;
      sign.style.visibility = prevV;
      return signSizeCache;
    }
    signImg.addEventListener('load', function () {
      signMeasured = false;
      signSize();
      if (minimized) applyPos();
    });

    function applyPos() {
      var cw = card.offsetWidth || Math.round(PANEL_W * CFG.scale);
      var ch = 200;
      if (minimized) {
        var ss = signSize();
        cw = ss.w;
        ch = ss.h;
      }
      var p = clampPos(pos.x, pos.y, cw, ch);
      pos.x = p.x;
      pos.y = p.y;
      root.style.left = p.x + 'px';
      root.style.top = p.y + 'px';
    }

    applyPos();

    // --- 最小化 / 展开：折纸动效 ---------------------------------------------
    var animating = false;
    var animatingSince = 0;
    var cardAnim = null;

    function canAnimate() {
      if (CFG.animate === false) return false;   // 设置里关掉动画
      if (typeof card.animate !== 'function') return false;
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
      return true;
    }

    // 木牌中心相对 root 原点的位移（卡片左上角同样在 root 原点）
    function foldDelta() {
      var cw = card.offsetWidth || Math.round(PANEL_W * CFG.scale);
      var ch = card.offsetHeight || 300;
      var ss = signSize();
      return { tx: Math.round(ss.w / 2 - cw / 2), ty: Math.round(ss.h / 2 - ch / 2) };
    }

    function stopAnim() {
      if (!cardAnim) return;
      var a = cardAnim;
      cardAnim = null;
      try { a.onfinish = null; a.oncancel = null; a.cancel(); } catch (e) { /* 忽略 */ }
    }

    function swapTo(next) {
      stopAnim();
      card.style.display = next ? 'none' : 'flex';
      sign.style.display = next ? 'block' : 'none';
      card.style.pointerEvents = '';
      applyPos();
    }

    // 木牌落地时轻微弹一下，强化“纸被塞进去后牌子晃了晃”的观感
    function popSign() {
      if (typeof sign.animate !== 'function') return;
      try {
        sign.animate([
          { transform: 'scale(.72)', opacity: .45 },
          { transform: 'scale(1.08)', opacity: 1, offset: .62 },
          { transform: 'scale(1)', opacity: 1 },
        ], { duration: 240, easing: 'cubic-bezier(.2,.9,.3,1.25)' });
      } catch (e) { /* 忽略 */ }
    }

    /**
     * 收/展动画的安全闸。
     *
     * 动画期间会把 card 的 pointerEvents 设成 none 并置 animating=true。
     * 若 card.animate() 抛异常、或 onfinish 永不触发（后台标签页里
     * Web Animations 会被暂停），这两个状态就永久卡死 —— 面板看着好好的，
     * 但最小化和拖动同时失效，正是用户反馈的现象。所以每次开动画都挂一个
     * 超时闸：到点还没收尾就强制落到目标态并把交互恢复。
     */
    var animGuard = 0;

    function armAnimGuard(ms, target) {
      if (animGuard) { clearTimeout(animGuard); animGuard = 0; }
      animGuard = setTimeout(function () {
        animGuard = 0;
        if (!animating) return;
        animating = false;
        stopAnim();
        swapTo(target);
      }, ms);
    }

    function clearAnimGuard() {
      if (!animGuard) return;
      clearTimeout(animGuard);
      animGuard = 0;
    }

    function setMinimized(next, opts) {
      var instant = !!(opts && opts.instant);
      // 动效进行中忽略重复触发；但如果这个"进行中"已经卡了很久，
      // 说明 onfinish 永远不会来了（后台标签页会暂停 Web Animations），
      // 直接强拆，别让最小化永久失灵。
      if (animating) {
        if (performanceNow() - animatingSince < 1500) return;
        try { console.warn('pixel-office: 收起动画疑似卡死，强制复位'); } catch (e) { /* 忽略 */ }
        clearAnimGuard();
        animating = false;
        stopAnim();
        swapTo(minimized);
      }
      if (next === minimized && !instant) return;
      minimized = next;
      saveUiState({ minimized: next, x: pos.x, y: pos.y });
      if (instant || !canAnimate()) { swapTo(next); reportDiag('minimized:' + next); return; }

      var d = foldDelta();
      animating = true;
      animatingSince = performanceNow();
      card.style.pointerEvents = 'none';

      // 动画一旦跑不起来，靠这个闸把 pointerEvents / animating 收回来
      function failSafe(err) {
        if (err) {
          try { console.warn('pixel-office: setMinimized 动画失败，直接切目标态', err); } catch (e) { /* 忽略 */ }
        }
        clearAnimGuard();
        animating = false;
        stopAnim();
        swapTo(minimized);
        reportDiag('minimize:fail-safe');
      }

      if (next) {
        // 收起：先上下对折成一条横带 → 再向内收短 → 最后缩成小片钻进木牌
        sign.style.display = 'none';
        card.style.display = 'flex';
        armAnimGuard(420 + 400, true);
        try {
          cardAnim = card.animate([
            { transform: 'translate(0px,0px) scale(1,1)', opacity: 1 },
            { transform: 'translate(0px,0px) scale(1,.10)', opacity: 1, offset: .34 },
            { transform: 'translate(' + Math.round(d.tx * 0.7) + 'px,' + Math.round(d.ty * 0.7) + 'px) scale(.38,.10)', opacity: .85, offset: .7 },
            { transform: 'translate(' + d.tx + 'px,' + d.ty + 'px) scale(.10,.07)', opacity: 0 },
          ], { duration: 420, easing: 'cubic-bezier(.5,.02,.6,1)', fill: 'forwards' });
          cardAnim.onfinish = function () {
            clearAnimGuard();
            animating = false;
            swapTo(true);
            popSign();
            reportDiag('minimize:anim-end');
          };
          cardAnim.oncancel = function () { clearAnimGuard(); animating = false; swapTo(true); reportDiag('minimize:anim-cancel'); };
        } catch (err) {
          failSafe(err);
        }
      } else {
        // 展开：从木牌位置先横向摊开，再上下铺满
        sign.style.display = 'none';
        card.style.display = 'flex';
        applyPos();
        armAnimGuard(480 + 400, false);
        try {
          cardAnim = card.animate([
            { transform: 'translate(' + d.tx + 'px,' + d.ty + 'px) scale(.10,.07)', opacity: 0 },
            { transform: 'translate(' + Math.round(d.tx * 0.7) + 'px,' + Math.round(d.ty * 0.7) + 'px) scale(.38,.10)', opacity: .85, offset: .3 },
            { transform: 'translate(0px,0px) scale(1,.10)', opacity: 1, offset: .66 },
            { transform: 'translate(0px,0px) scale(1,1)', opacity: 1 },
          ], { duration: 480, easing: 'cubic-bezier(.3,1.05,.4,1)', fill: 'forwards' });
          cardAnim.onfinish = function () { clearAnimGuard(); animating = false; swapTo(false); };
          cardAnim.oncancel = function () { clearAnimGuard(); animating = false; swapTo(false); };
        } catch (err) {
          failSafe(err);
        }
      }
    }

    minBtn.addEventListener('click', function () { setMinimized(true); });

    // --- 拖动（标题条与木牌都能拖）------------------------------------------
    var drag = null;          // {dx, dy, moved}
    var suppressClick = false; // 木牌刚被拖动过，吞掉这次 click 不再展开

    function beginDrag(e, el, cx, cy) {
      if (e.button !== undefined && e.button !== 0) return;
      if (e.target && e.target.tagName === 'BUTTON') return;
      var x = typeof cx === 'number' ? cx : e.clientX;
      var y = typeof cy === 'number' ? cy : e.clientY;
      drag = { dx: x - pos.x, dy: y - pos.y, moved: false, kind: el === sign ? 'sign' : 'bar' };
      if (el === bar) bar.style.cursor = 'grabbing';
      root.style.zIndex = String(PANEL_Z_TOP);
      if (e.pointerId !== undefined) {
        try { el.setPointerCapture(e.pointerId); } catch (err) { /* 旧浏览器忽略 */ }
      }
      try { e.preventDefault(); } catch (err) { /* 忽略 */ }
    }

    function onBarDown(e) { beginDrag(e, bar); }
    function onSignDown(e) { beginDrag(e, sign); }

    /**
     * 统一按下入口。
     *
     * 真实 GUI 里宿主可能在自己那层对 pointerdown 调 stopPropagation，甚至
     * 整个不派发 Pointer Events。所以这里不依赖任何单一事件类型：
     * pointerdown / mousedown / touchstart 三条路都挂到 window 捕获阶段，
     * 谁先到就用谁，用时间戳去重，保证同一次物理按下只处理一次。
     */
    var lastDownAt = 0;

    function pointOf(e) {
      if (e.touches && e.touches.length) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
      if (e.changedTouches && e.changedTouches.length) return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
      return { x: e.clientX, y: e.clientY };
    }

    function hitRect(el, x, y) {
      if (!el || el.style.display === 'none') return false;
      var r = el.getBoundingClientRect();
      if (!r || r.width <= 0 || r.height <= 0) return false;
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    }

    function onWindowDownCapture(e) {
      // 只认左键 / 单指
      if (e.button !== undefined && e.button > 0) return;
      var now = performanceNow();
      if (now - lastDownAt < 40) return; // 同一次按下被多种事件重复派发
      lastDownAt = now;

      var t = e.target;
      var p = pointOf(e);
      var x = p.x;
      var y = p.y;

      // 最小化按钮：捕获阶段自己派发，绕开宿主对 click 的拦截
      if (minBtn && (t === minBtn || (t && t.parentNode === minBtn))) {
        setMinimized(true);
        reportDiag('minimize');
        try { e.stopPropagation(); } catch (err) { /* 忽略 */ }
        try { e.preventDefault(); } catch (err) { /* 忽略 */ }
        return;
      }

      // 标题条 / 木牌：开始拖动
      if (hitRect(bar, x, y) && !(t && t.tagName === 'BUTTON')) {
        beginDrag(e, bar, x, y);
        return;
      }
      if (hitRect(sign, x, y)) {
        beginDrag(e, sign, x, y);
      }
    }

    function onWindowMove(e) {
      if (!drag) return;
      if (e.button !== undefined && e.button > 0 && e.type !== 'touchmove') return;
      var p = pointOf(e);
      onPointerMove(p.x, p.y);
      try { e.preventDefault(); } catch (err) { /* 忽略 */ }
    }

    function onWindowUp() {
      onPointerUp();
    }

    function onPointerMove(cx, cy) {
      if (!drag) return;
      var nx = cx - drag.dx;
      var ny = cy - drag.dy;
      if (Math.abs(nx - pos.x) > 3 || Math.abs(ny - pos.y) > 3) drag.moved = true;
      pos.x = nx;
      pos.y = ny;
      applyPos();
    }

    function onPointerUp() {
      if (!drag) return;
      var moved = drag.moved;
      var kind = drag.kind;
      drag = null;
      bar.style.cursor = 'grab';
      root.style.zIndex = String(PANEL_Z);
      if (moved) {
        // 拖过木牌就算拖动，不再触发展开
        suppressClick = true;
        setTimeout(function () { suppressClick = false; }, 0);
        reportDiag('drag');
      } else if (kind === 'sign') {
        // 点木牌展开：不走 click（宿主可能吞掉冒泡），直接在这里收口
        setMinimized(false);
        suppressClick = false;
        reportDiag('expand');
      }
      saveUiState({ x: pos.x, y: pos.y, minimized: minimized });
    }

    sign.addEventListener('click', function (e) {
      if (suppressClick) { e.stopPropagation(); e.preventDefault(); suppressClick = false; return; }
      setMinimized(false);
    }, true);

    // 三条事件路都挂到 window 捕获阶段：window 捕获是事件传播的第一站，
    // 宿主在自己那层调 stopPropagation 拦不住这里；就算整个不派发 Pointer
    // Events，mousedown / touchstart 仍能兜住。
    window.addEventListener('pointerdown', onWindowDownCapture, true);
    window.addEventListener('mousedown', onWindowDownCapture, true);
    window.addEventListener('touchstart', onWindowDownCapture, { capture: true, passive: false });
    // 兜底：非 Pointer Events 环境仍走元素自身的冒泡路径
    bar.addEventListener('pointerdown', onBarDown);
    sign.addEventListener('pointerdown', onSignDown);
    bar.addEventListener('mousedown', onBarDown);
    sign.addEventListener('mousedown', onSignDown);

    window.addEventListener('pointermove', onWindowMove, true);
    window.addEventListener('mousemove', onWindowMove, true);
    window.addEventListener('touchmove', onWindowMove, { capture: true, passive: false });
    window.addEventListener('pointerup', onWindowUp, true);
    window.addEventListener('mouseup', onWindowUp, true);
    window.addEventListener('touchend', onWindowUp, true);
    window.addEventListener('pointercancel', onWindowUp, true);
    window.addEventListener('touchcancel', onWindowUp, true);
    // 指针在面板外松开（或窗口失焦）也要把拖动状态收掉，否则会一直粘着鼠标
    window.addEventListener('blur', onWindowUp);

    // 视口变化时重新夹一次，避免拖出屏幕后找不回来
    function onResize() { applyPos(); }
    window.addEventListener('resize', onResize);

    setMinimized(minimized, { instant: true });

    return {
      root: root,
      stage: stage,
      dot: dot,
      preview: preview,
      previewTitle: ptitle,
      previewBody: pbody,
      setMinimized: setMinimized,
      /**
       * 把设置刷到面板上。
       *
       * `w` 是卡片宽度（已按 scale 算好）。改宽度后必须重新 applyPos ——
       * 否则面板贴着右边缘时会因为变宽而溢出屏幕；clampPos 里已经处理了
       * 「窗口比卡片窄」的情形（maxX 留 80px 抓取余量）。
       *
       * 「显隐」只藏场景画布（含气泡层），标题条与设置面板永远留着 ——
       * 否则关掉之后就再也点不到开关，只能去清 localStorage。气泡层是
       * stage 的子节点，stage 一隐它跟着一起隐，不用单独处理。
       */
      applySettings: function (cfg, w) {
        if (typeof w === 'number' && w > 0) card.style.width = w + 'px';
        stage.style.display = cfg.visible === false ? 'none' : '';
        syncAll();
        applyPos();
      },
      teardown: function () {
        stopAnim();
        clearAnimGuard();
        window.removeEventListener('pointerdown', onWindowDownCapture, true);
        window.removeEventListener('mousedown', onWindowDownCapture, true);
        window.removeEventListener('touchstart', onWindowDownCapture, true);
        bar.removeEventListener('pointerdown', onBarDown);
        sign.removeEventListener('pointerdown', onSignDown);
        bar.removeEventListener('mousedown', onBarDown);
        sign.removeEventListener('mousedown', onSignDown);
        window.removeEventListener('pointermove', onWindowMove, true);
        window.removeEventListener('mousemove', onWindowMove, true);
        window.removeEventListener('touchmove', onWindowMove, true);
        window.removeEventListener('pointerup', onWindowUp, true);
        window.removeEventListener('mouseup', onWindowUp, true);
        window.removeEventListener('touchend', onWindowUp, true);
        window.removeEventListener('pointercancel', onWindowUp, true);
        window.removeEventListener('touchcancel', onWindowUp, true);
        window.removeEventListener('blur', onWindowUp);
        window.removeEventListener('resize', onResize);
      },
    };
  }

  // -------------------------------------------------------------------------
  // 主循环
  // -------------------------------------------------------------------------

  /**
   * 互动状态推进：懵逼 1s 结束时决定回家路线；出画重进跑到门口后掉头走回工位。
   * 这些逻辑都要在主循环里推进，不能只靠 setTimeout —— 否则面板最小化/后台标签页
   * 时定时器被节流，相位就会卡死在 confused / reenter。
   */
  function stepAct(ts) {
    var ids = Object.keys(S.act);
    for (var i = 0; i < ids.length; i += 1) {
      var seatId = ids[i];
      var a = S.act[seatId];
      if (!a) continue;

      // --- 懵逼：1s（含抖动）后走回家或先出画
      if (a.phase === 'confused') {
        if (window.__poStep) window.__poStep(seatId, ts, a.phT0, ts - a.phT0);
        if (ts - a.phT0 >= CONFUSE_MS) {
          resolveConfuse(seatId, ts);
          continue;
        }
      }

      // --- 出画重进：走到门口 → 瞬移回门外 → 再从门口走进来
      if (a.phase === 'reenter' && a.walkPath && a.walkLen > 0) {
        var k = walkProgress(a.walkT0, a.walkLen, ts);
        if (k >= 1) {
          if (a.reenterStage === 'exit') {
            // 到门口出画：接第二段折线，必须从**画布外**接着走回来。
            //
            // 早先这里直接把起点设成 `{doorX, door.y - sh2}`（门口上方），
            // 而第一段实际停在 `scene.h + 6`（画布底外），两者差着一整个门洞，
            // 于是鱼在画布外凭空消失、又在门里凭空出现 —— 用户报的
            // 「走回办公室时有时没有走到门口进去 / 有瞬移」(m00343 第五、六条)
            // 就是这个接缝。现在补一段竖直进门：画布外 → 门内 → 过道 → 工位。
            var target = seatPosition(seatId);
            if (target) {
              var doc = S.seatsDoc;
              var spriteW = target.kind === 'main' ? doc.spriteSize.main : doc.spriteSize.sub;
              var sh2 = spriteHeightFor(seatId);
              var doorCx = Math.round(doc.door.x + doc.door.w / 2 - spriteW / 2);
              var doorTopY = Math.round(doc.door.y - sh2);
              var exitY = doc.scene.h + 6;
              var inPath = navRoute(
                { x: doorCx, y: doorTopY },
                { x: Math.round(target.x), y: Math.round(target.y) },
                spriteW,
                sh2
              );
              // 先竖直穿门，再把 navRoute 的结果接上（去掉重复的门口点）
              var through = dedupePath([{ x: doorCx, y: exitY }, { x: doorCx, y: doorTopY }].concat(inPath));
              a.walkPath = through;
              a.walkLen = pathLen(through);
              a.walkT0 = ts;
              a.reenterStage = 'in';
              setFacingNow(a, 'back');
            } else {
              a.phase = 'seated';
              a.pos = null;
            }
          } else {
            a.phase = 'seated';
            a.pos = null;
            setFacingNow(a, 'back');
          }
        }
        continue;
      }

      // --- 坐下动画到点就清标记（避免每帧都算）
      if (a.sitT0 && ts - a.sitT0 > SITDOWN_MS) {
        a.sitT0 = 0;
      }
    }
  }

  /**
   * 主循环的"时间源选择器"。
   *
   * rAF 的 ts 只在真正被调度时才可信；无头/虚拟时间/后台标签页下它可能停摆，
   * 这时退回到 performance.now()，否则所有基于 ts 的计时（入场走路、掉落、
   * 游行、冒泡精灵）会集体冻住。两个时钟只在"是否前进"上做取舍，不混算差值。
   */
  function loopTime(ts) {
    var now = performanceNow();
    if (typeof ts !== 'number' || !isFinite(ts)) return now;
    // rAF 的 ts 与 performance.now() 同源（都以页面导航为原点），
    // 只要它没落后太多就用它（帧对齐更稳），落后说明 rAF 停摆，改用 now。
    return ts > now - 250 ? ts : now;
  }

  /** 画一帧（纯计算 + 绘制，不负责排下一帧）。 */
  function frame(ts) {
    if (S.dead) return;
    var t = loopTime(ts);
    S.frameCount = (S.frameCount || 0) + 1;
    // 屏幕亮度是按帧间 dt 推进的，必须在覆盖 lastFrameTs 之前算完
    stepScreenLit(t);
    stepLampLit(t);
    S.lastFrameTs = t;
    stepEnter(t);
    stepAct(t);
    stepFall(t);
    stepParade(t);
    drawFrame(t);
    drawSky(t);
    bubblePass(t);
  }

  /**
   * rAF 链条回调：画一帧，再排下一帧。
   *
   * 全流程只有这里会注册 requestAnimationFrame —— 兜底驱动（watchdog）只调
   * frame()，绝不自己排帧。否则 rAF 停摆期间每 120ms 就会积一个待触发回调，
   * 恢复时几十个 loop 同时开跑，动画会瞬间暴走。
   */
  function loop(ts) {
    S.rafPending = false;
    if (S.dead) return;
    frame(ts);
    scheduleFrame();
  }

  /**
   * 排下一帧（幂等）。
   *
   * rafPending 保证同一时刻最多只有一个待触发回调；rafGen 让"被 watchdog
   * 判定为已死、随后又迟到触发"的旧回调自动作废，不会跟新链条打架。
   */
  function scheduleFrame() {
    if (S.dead || S.rafPending) return;
    S.rafPending = true;
    S.rafGen = (S.rafGen || 0) + 1;
    S.rafPendingSince = performanceNow();
    var gen = S.rafGen;
    S.raf = requestAnimationFrame(function (ts) {
      if (S.dead || gen !== S.rafGen) return; // 过期回调：丢掉，别和新链条抢帧
      loop(ts);
    });
  }

  /**
   * rAF 停摆兜底驱动。
   *
   * 无头浏览器（--virtual-time-budget / headless=new）、后台标签页、以及
   * 部分 GPU 降级场景下 requestAnimationFrame 会长时间不回调（实测整段脚本
   * 只跑了 5 帧）。此时像素办公室里所有动画都会冻住 —— 用户看到的就是
   * "鱼掉下去以后再也没回来"（m04324 第四条）。
   *
   * 兜底策略：定时器每 120ms 检查一次，若超过 300ms 没有新帧，就手动推进一帧。
   * 只画帧、不排 rAF —— 排帧永远由 loop() 自己负责，这里绝不累积待触发回调。
   * rAF 健在时这个检查什么都不做，不额外消耗。
   *
   * 另外：一个 rAF 回调挂起超过 1s 还没被调用，就认定这条链已经死了，
   * 作废它（rafGen 自增）并重新注册一条 —— 标签页重新可见 / 无头环境换了
   * 时间源之后，帧率能自动回到 60fps，不用等页面重载。
   */
  var WATCHDOG_MS = 120;
  var WATCHDOG_STARVE_MS = 300;
  var WATCHDOG_REVIVE_MS = 1000;

  function startWatchdog() {
    if (S.watchdogTimer) return;
    S.watchdogTimer = setInterval(function () {
      if (S.dead) return;
      var now = performanceNow();
      // 帧链疑似已死：作废挂起的回调，重新排一条（幂等 + 代际隔离）
      if (S.rafPending && now - (S.rafPendingSince || 0) > WATCHDOG_REVIVE_MS) {
        S.rafPending = false;
        scheduleFrame();
      }
      if (now - (S.lastFrameTs || 0) < WATCHDOG_STARVE_MS) return;
      frame(now);
    }, WATCHDOG_MS);
  }

  function detectSessionId() {
    try {
      var m = /\/s(?:ession)?\/([0-9a-zA-Z_-]{6,})/.exec(location.pathname);
      if (m) return m[1];
      var q = new URLSearchParams(location.search).get('session');
      if (q) return q;
    } catch (e) { /* ignore */ }
    return null;
  }

  function showFatal(msg) {
    var warn = document.createElement('div');
    warn.setAttribute('data-dsh-plugin', 'pixel-office');
    warn.setAttribute('data-pixel-office-root', '');
    warn.textContent = 'pixel office: ' + msg;
    warn.style.position = 'fixed';
    warn.style.right = '8px';
    warn.style.bottom = '8px';
    warn.style.zIndex = String(PANEL_Z_TOP);
    warn.style.background = '#2b2136';
    warn.style.color = '#ff5470';
    warn.style.padding = '6px 8px';
    warn.style.font = '11px ui-monospace, monospace';
    warn.style.border = '1px solid #ff5470';
    document.body.appendChild(warn);
    setTimeout(function () { warn.remove(); }, 12000);
  }

  function boot() {
    // 跨实例接管：清掉上一次残留的 DOM
    var stale = document.querySelectorAll('[data-pixel-office-root]');
    for (var i = 0; i < stale.length; i += 1) stale[i].remove();

    S.currentSessionId = detectSessionId();
    // 设置要在建面板与画第一帧之前就位：面板宽度、走速、帧率都依赖它。
    // 这里先按 localStorage 里的值初始化一次，locale 服务拿不到就按
    // navigator.language 兜底（见 pickLocale 的注释：不去 inject，避免 boot 失败）。
    loadSettings({});

    loadAssets().then(function () {
      if (S.dead) return;
      if (!S.seatsDoc) {
        showFatal('资产端点不可达（' + API + '/seats）');
        return;
      }

      var built = buildPanel();
      document.body.appendChild(built.root);
      // DSH 开屏结束前不露脸（boot 页 / onboarding 覆盖层消失后再显示）
      holdUntilBootDone(built.root);
      rootEl = built.root;
      stageEl = built.stage;
      panelApi = built;
      initCanvas(stageEl);
      // 面板就绪后立刻把设置刷上去（尺寸/显隐），否则第一帧用的是建面板
      // 那一刻的默认值 —— 用户上次设的「小尺寸 + 隐藏场景」会晚一帧生效。
      try { built.applySettings(CFG, Math.round(PANEL_W * CFG.scale)); } catch (e) { /* 忽略 */ }
      reportDiag('boot');
      probeFirstInput();

      bubbleLayer = document.createElement('div');
      bubbleLayer.style.position = 'absolute';
      bubbleLayer.style.left = '0';
      bubbleLayer.style.top = '0';
      bubbleLayer.style.width = '100%';
      bubbleLayer.style.height = '100%';
      bubbleLayer.style.pointerEvents = 'none';
      stageEl.appendChild(bubbleLayer);

      // 标题条的连接指示灯
      var dotEl = built.dot;
      // 句柄必须存下来：原来是个裸 setInterval，dispose() 之后它还在跑，
      // 每次都摸已经被移除的 dotEl（切会话/关面板后每秒白烧一次）。
      S.dotTimer = setInterval(function () {
        if (S.dead) return;
        dotEl.style.background = (S.hostOk && S.snapshot && S.snapshot.main) ? '#5ee6c8' : '#4a4258';
      }, 700);

      poll();
      S.pollTimer = setInterval(poll, POLL_MS);
      scheduleFrame();
      startWatchdog();

      // 全景浮层（掉落/出逃时鱼要掉到视口底部、浮在所有内容之上）
      initSky();
      window.addEventListener('resize', onWindowResize);
      bindCanvasInput();
      bindSpaceKey();
      // 空格彩蛋的鱼常被拖到面板外，那里 canvas 收不到指针事件（天空浮层是
      // pointer-events:none），双击解除只能靠窗口级监听兜住。
      bindEscRelease();
      // 调试钩子：验收台据此确认命中/抓取状态（正式使用时不触发任何行为）
      window.__pixelOfficeDebug = function (lx, ly) {
        var ts = performance.now();
        var r = cv.getBoundingClientRect();
        var doc0 = S.seatsDoc;
        if (!doc0) return { hit: null, box: null, boxes: {}, why: ['noSeatsDoc'] };
        var cx = r.left + lx * (r.width / doc0.scene.w);
        var cy = r.top + ly * (r.height / doc0.scene.h);
        var out = { hit: hitTest(cx, cy, ts), box: null, boxes: {}, why: [] };
        // 场景逻辑尺寸也带出去：验收脚本要把 actorBox 的逻辑坐标换算回视口坐标，
        // 原来只能在脚本里写死 320/431，场景一变就全错。
        out.scene = { w: doc0.scene.w, h: doc0.scene.h };
        out.rect = { left: r.left, top: r.top, width: r.width, height: r.height };
        var p = toLogical(cx, cy);
        out.logical = p;
        var snap = S.snapshot;
        var probeSeat = function (seatId, seat) {
          if (!seat || !seat.agentId) { out.why.push(seatId + ':noAgent'); return; }
          var a = S.act[seatId];
          if (a && a.hidden) { out.why.push(seatId + ':hidden'); return; }
          var w = S.walkIns[seatId];
          if (w && !w.ready) { out.why.push(seatId + ':notReady'); return; }
          var b = actorBox(seatId, ts);
          if (!b) { out.why.push(seatId + ':noBox'); return; }
          var inX = p && p.x >= b.x - 2 && p.x <= b.x + b.w + 2;
          var inY = p && p.y >= b.y - 2 && p.y <= b.y + b.h + 2;
          out.why.push(seatId + ':' + (inX && inY ? 'HIT' : 'miss') + ' bx[' + b.x + ',' + (b.x + b.w) + '] by[' + b.y + ',' + (b.y + b.h) + ']');
        };
        if (snap) {
          probeSeat('main', snap.main);
          if (Array.isArray(snap.subs)) snap.subs.forEach(function (s, i) { probeSeat('sub:' + i, s); });
        } else {
          out.why.push('noSnapshot');
        }
        if (snap) {
          out.box = actorBox('main', ts);
          // 主鱼也要进 boxes：验收脚本原来只能扫 boxes['main'] 判空，
          // 而这里只填副鱼，导致「主鱼空格拖拽」这条根本没法定位（m05088 第 1 条验收卡在这）。
          if (out.box) out.boxes.main = out.box;
          if (Array.isArray(snap.subs)) {
            snap.subs.forEach(function (s, i) {
              if (s && s.agentId) out.boxes['sub:' + i] = actorBox('sub:' + i, ts);
            });
          }
        }
        return out;
      };
      window.__pixelOfficeWalk = function () {
        var o = { q: S.enterQueue.slice(), win: {}, act: {} };
        Object.keys(S.walkIns).forEach(function (k) {
          var w = S.walkIns[k];
          o.win[k] = { ready: !!w.ready, t0: Math.round(w.t0), dur: Math.round(w.dur || 0), len: Math.round(w.len || 0) };
        });
        Object.keys(S.act).forEach(function (k) {
          o.act[k] = {
            phase: S.act[k].phase,
            facing: S.act[k].facing,
            dbl: S.act[k].dbl || 0,
            busy: Math.max(0, Math.round((S.act[k].busyUntil || 0) - performance.now())),
            fall: !!S.act[k].fall,
            hidden: !!S.act[k].hidden,
            glyph: S.act[k].glyph ? S.act[k].glyph.name : null,
            hop: !!S.act[k].hop,
            // 掉落内部状态：无重力问题时这四项足以判断卡在哪一步
            f: S.act[k].fall
              ? {
                  x: Math.round(S.act[k].fall.x),
                  y: Math.round(S.act[k].fall.y),
                  vy: Math.round(S.act[k].fall.vy * 100) / 100,
                  lastT: Math.round(S.act[k].fall.lastT),
                  grounded: !!S.act[k].fall.grounded,
                  bounced: !!S.act[k].fall.bounced,
                }
              : null,
            floor: S.act[k].fall ? Math.round(getFloorY(S.act[k].fall)) : null,
            // 每条鱼自己的落点与折线（原来只有 main 的 o.pos/o.path，
            // 副鱼的拖拽路径根本没法断言 —— 见 m03550 第 2 条、
            // 第 12 条的验收困难）。
            pos: S.act[k].pos ? { x: Math.round(S.act[k].pos.x), y: Math.round(S.act[k].pos.y) } : null,
            path: S.act[k].walkPath ? S.act[k].walkPath.slice() : null,
            shake: Math.max(0, Math.round((S.act[k].shakeUntil || 0) - performance.now())),
            esc: !!S.act[k].esc,
            // 这一帧到底用的是哪张图（m05088 的验收关键）：
            // 光看截图分不出「坐姿帧」和「坐地帧」、「正面坐姿」和「正面行走帧」，
            // 所以把选帧结果原样暴露出来 —— 文件名 + 原始像素尺寸 + 竖向拉伸系数。
            // 选帧逻辑直接复用 frameFor / movingFrame，两者都是纯函数，重算无副作用。
            frame: (function () {
              var a2 = S.act[k];
              var seat2 = seatData(k);
              var ts2 = S.lastFrameTs || 0;
              var stand2 = standingFor(k);
              var wd = a2.walkDir;
              var mv2 = wd ? movingFrame(k, seat2, wd, ts2) : null;
              var im2 = mv2 ? mv2.img : frameFor(k, seat2, a2.facing, ts2, stand2);
              if (!im2) return null;
              var onF = !wd && !!a2.esc && !a2.walkPath;
              var ny = (k !== 'main' && !onF) ? subFrameNorm(k, im2) : 1;
              var src = im2.src ? String(im2.src) : '';
              var slash = src.lastIndexOf('/');
              return {
                file: slash >= 0 ? src.slice(slash + 1) : src,
                w: im2.width,
                h: im2.height,
                ny: Math.round(ny * 1000) / 1000,
                onFloor: !!onF,
                walking: !!wd,
              };
            })(),
          };
        });
        var ma = S.act.main;
        o.path = (ma && ma.walkPath) ? ma.walkPath.slice() : null;
        o.pos = (ma && ma.pos) ? ma.pos : null;
        o.now = Math.round(performance.now());
        o.frames = S.frameCount || 0;
        o.lastTs = Math.round(S.lastFrameTs || 0);
        // 空格彩蛋（m06554 第 6 条）的排队出逃阶段：0 未触发 / 1 排队中 / 2 向右走 / 3 已弹告示牌。
        // 这条链路全是 canvas 内的相位变化，没有 DOM 可断言，只能把内部量暴露出来。
        o.parade = S.parade || 0;
        o.paradeIds = (S.paradeIds || []).slice();
        // 双击解除彩蛋（m08712）的窗口级监听是否已挂上：
        // 面板外的鱼靠它接指针事件，没挂上时双击会静默无反应，
        // 而"有没有挂上"在页面里没有任何其他可观测痕迹。
        o.escDown = !!S.onEscDown;
        // 面板外浮层上一帧画了什么（m03550 第 12 条）：
        // skyShake>0 = 画布外的鱼正在懵逼抖动，skyGlyph>0 = 画布外冒出了头顶符号。
        o.skyShake = S.skyShake || 0;
        o.skyGlyph = S.skyGlyph || 0;
        // 环境动态层（§4.1 屏幕 / §4.2 灯光 / §4.3 挂钟）的可观测快照。
        // 这三样是纯绘制、没有 DOM，只能靠这里把内部量暴露出来做验收。
        o.screens = (function () {
          var out = {};
          Object.keys(S.screenLit).forEach(function (k) {
            var v = S.screenLit[k];
            out[k] = Math.round(v * 1000) / 1000;
          });
          return out;
        })();
        o.lamps = (function () {
          var doc = S.seatsDoc;
          if (!doc || !doc.lamps) return null;
          return doc.lamps.map(function (lamp, i) {
            return {
              i: i,
              outage: lampOutage(i, S.lastFrameTs),
              boost: Math.round(lampBusyBoost(lamp) * 1000) / 1000,
              level: Math.round((typeof S.lampLit === 'number' ? S.lampLit : 0) * 1000) / 1000,
            };
          });
        })();
        o.clock = (function () {
          var doc = S.seatsDoc;
          if (!doc || !doc.clock) return null;
          var t = S.lastFrameTs || 0;
          return {
            // 秒针角度取整到秒后算出来再取整，用来断言"跳格、不连续扫"
            secDeg: Math.round(((Math.floor(t / 1000) / 60) % 1) * 360),
            minDeg: Math.round(((t / 60000) % 1) * 360),
          };
        })();
        return o;
      };

      window.addEventListener('popstate', function () {
        S.currentSessionId = detectSessionId();
        S.lastSeq = 0;
        poll();
      });

      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') poll();
      });
    });
  }

  function onWindowResize() {
    resizeSky();
  }

  function dispose() {
    if (bootGateStop) { try { bootGateStop(); } catch (e) { /* 忽略 */ } bootGateStop = null; }
    S.dead = true;
    if (S.raf) cancelAnimationFrame(S.raf);
    S.raf = null;
    S.rafPending = false;
    S.rafGen = (S.rafGen || 0) + 1; // 让所有已挂起的回调失效
    if (S.watchdogTimer) { clearInterval(S.watchdogTimer); S.watchdogTimer = null; }
    if (S.pollTimer) clearInterval(S.pollTimer);
    if (S.dotTimer) { clearInterval(S.dotTimer); S.dotTimer = null; }
    // bootGate 里那个 setInterval/setTimeout（开屏门控）以前只靠 bootGateStop 收，
    // 而 bootGateStop 在「门控成功结束」时已经被置空 —— 于是那些定时器漏网。
    if (S.bootGateIv) { clearInterval(S.bootGateIv); S.bootGateIv = null; }
    if (S.bootGateGuard) { clearTimeout(S.bootGateGuard); S.bootGateGuard = null; }
    if (panelApi && typeof panelApi.teardown === 'function') {
      try { panelApi.teardown(); } catch (e) { /* 忽略 */ }
    }
    panelApi = null;
    if (S.onKeyDown) window.removeEventListener('keydown', S.onKeyDown);
    if (S.onKeyUp) window.removeEventListener('keyup', S.onKeyUp);
    // 捕获阶段注册的指针监听必须用同一个 capture 值摘除，否则摘不掉，
    // 插件热重载后会堆叠出多个 releaseEsc 判定。
    if (S.onEscDown) window.removeEventListener('pointerdown', S.onEscDown, true);
    S.onKeyDown = null;
    S.onKeyUp = null;
    S.onEscDown = null;
    window.removeEventListener('resize', onWindowResize);
    if (S.sky) {
      if (S.sky.cv && S.sky.cv.parentNode) S.sky.cv.parentNode.removeChild(S.sky.cv);
      S.sky = null;
    }
    if (S.boardEl && S.boardEl.parentNode) S.boardEl.parentNode.removeChild(S.boardEl);
    S.boardEl = null;
    S.boardBox = null;
    if (S.curtainEl && S.curtainEl.parentNode) S.curtainEl.parentNode.removeChild(S.curtainEl);
    S.curtainEl = null;
    var roots = document.querySelectorAll('[data-pixel-office-root]');
    for (var i = 0; i < roots.length; i += 1) roots[i].remove();
    S.bubbles = {};
  }

  // -------------------------------------------------------------------------
  // 注册
  // -------------------------------------------------------------------------

  window.__ModuleLoader__.load({
    id: 'dsh-pixel-office',
    factory: function () {
      /** client 侧不 inject 任何 service：只用 DOM / canvas / 同源 fetch。 */
      var inject = [];
      function apply() {
        boot();
        return dispose;
      }
      return { apply: apply, inject: inject };
    },
  });
})();
