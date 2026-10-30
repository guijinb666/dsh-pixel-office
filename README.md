# 像素工作台

DSH 的像素办公室插件。每开一个会话，就有一只像素小人从门口走进来坐下打字；主 agent 坐双屏大桌，子 agent 一人一格，各有工位和皮肤。它们敲键盘的时候，桌面上的屏幕同一刻亮起来。

介绍页（含实机录屏与八套皮肤）：**https://guijinb666.github.io/dsh-pixel-office/**

---

## 装上

插件只有一个包，没有第三方运行依赖。

```bash
# 1. 把插件包放进 DSH 的 node_modules
cp -r packages/dsh-pixel-office ~/.dsh/profiles/desktop/node_modules/

# 2. 重启 DSH（客户端包在启动时读一次，改完必须重启）
```

然后开一个会话。鱼会自己从门口走进来坐下。

Windows 上想改源码即时生效，可以做成 Junction：

```powershell
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-pixel-office" `
  -Target "<本仓库>\packages\dsh-pixel-office"
```

DSH 要求 `>= 0.1.7-rc.1`，平台 web。

---

## 它做什么

**入场与离场**。新会话进来一只，排队从门洞走进去；回程走 `planPathFromDoorIn` 的三段式路线（先落到出画线、再竖直走进门洞、再拐进工位），不会瞬移。会话结束就从工位起身走出去。

**气泡**。头顶一个微信式小气泡，尖角精确指向头顶。主 agent 一窗十个字、子 agent 一窗五个，长句按 3 字/秒横向滚动，不截断、不换行、不裁掉尖角。一轮结束只留一句固定提示。

**环境动态层**。没人在的时候吊灯和屏幕是灭的；有人进来，屏幕扫描线展开、灯管亮起，之后进入呼吸。吊灯每六十秒掉一次电，持续 120ms。挂钟按秒跳格，不连续扫。

**拖拽**。直接拖着鱼走；拖到画布外它会就地坐下、头顶冒问号抖一秒，然后自己找路回来。

**空格彩蛋**。按住空格再拖，鱼就地坐在地上。全部拖出画布，它们排成一列向右走掉，画布中央掉下一块木牌。双击任何一条坐地的鱼，它就解除出逃、走回工位。

**设置**。四行：显示、尺寸、速度、动画，加一个恢复默认。切到隐藏，整间办公室收成一块木牌。位置与开合状态存 localStorage。

---

## 仓库结构

```
packages/dsh-pixel-office/   插件本体（lib/client.js 客户端半 + lib/index.js host 半 + assets）
docs/                        介绍页（GitHub Pages 用这个目录）；总规划文档也在这里
tools/                       生图与精灵处理管线
tmp/                         验收台与十六套验收脚本
assets/scene/seats.json      场景坐标表（座位锚点、门洞、挂灯、挂钟）
```

`assets/` 里的 AI 原图（166MB）与调试截图不进版本库，能用 `tools/gen-*.mjs` 与 `tools/sprite-prep.mjs` 重新生成。

---

## 验收怎么跑

十六套脚本，合计约 250 项断言。浏览器套件靠一个假的 DSH 界面（验收台）驱动真实代码，用真实指针事件。

```bash
# host 侧（会话事件解析、设置项、路由）
node tmp/smoke-test.mjs
node tmp/sleep-test.mjs
node tmp/replay-real.mjs

# 先起验收台
node tmp/harness-server.mjs 8791

# 浏览器套件（需要 puppeteer-core 与 Edge/Chromium）
node tmp/browser/verify.mjs
node tmp/browser/m05088.mjs
node tmp/browser/bubble-scroll.mjs
node tmp/browser/panel.mjs
node tmp/browser/panel-hostile.mjs
node tmp/browser/diag-report.mjs
node tmp/browser/ambient.mjs
node tmp/browser/settings.mjs
node tmp/browser/d13.mjs
node tmp/browser/confuse-out.mjs
node tmp/browser/parade.mjs
node tmp/browser/escrelease.mjs
```

`tmp/browser/node_modules` 是软链，指向 DSH 装好的依赖。

---

## 许可

Apache-2.0。
