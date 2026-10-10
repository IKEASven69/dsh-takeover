<p align="center"><img src="assets/icon.svg" width="72" height="72" alt="dsh-takeover logo"></p>

# dsh-takeover · 会话接管插件

**会拉、会推、会接管：拉取八家外部 agent 会话，寄存当前会话，开局取件。**

> **为什么叫 takeover？** takeover = 接管：别的 agent 干到一半的会话，你随时接管接着掌控。
> 协议层词汇保留 handoff（交接，业界通用语），产品层只占「接管」这个词。
>
dsh-takeover 是 DeepSeek Harness（DSH）插件，实现 `handoff: 1` 开放协议（协议本体见姊妹仓 agent-handoff 的 SPEC.md）的完整接管闭环：

- **拉**：`/resume-claude` `/resume-codex` `/resume-opencode` `/resume-zcode` `/resume-pi` `/resume-workbuddy` `/resume-cursor` `/resume-grok` —— 把别家 agent 的本地会话只读拉进当前会话，蒸馏成六段协议卡接手工作；
- **推**：`/handoff` + `handoff_push` —— 把当前会话寄存成一张交接卡片，落共享收件箱；
- **接管**：`/inbox` + `handoff_inbox` —— 任何 agent 开局取件；拉取的会话也可以顺手寄存，让另一个 agent 接着干。
- **浏览 + 一键接管**（设置卡）：不用记命令——面板里浏览八家最近会话（标题/时间/项目，可展开预览首条请求与停点），点「接管」直接新建会话投递指令并自动切换过去看模型接手；失败自动退回复制指令。

```
~/.handoff/
  pending/     # 待取件，一个卡片一个 .md 文件
  archived/    # 已消费，滚动保留 50 份
```

文件系统即总线：写入 `pending/` 就是投递，取件即移到 `archived/`（消费即弃，二次取件报错）。卡片 = Markdown + YAML frontmatter + 六段中文正文（目标 / 涉及文件 / 做到哪 / 还差什么 / 停在哪 / 读者警告），格式与语义见协议仓 SPEC。

## 和单向导出工具的区别

[dsh-handoff](https://www.npmjs.com/package/dsh-handoff)（v0.1.0）是**单向导出**：把会话事件流确定性导出成一份工作区里的 HANDOFF.md 文档，没有收件箱、不落共享目录、不跨 agent。

dsh-takeover 是**完整的接管环**：拉取外部会话、寄存当前会话、开局取件三合一。拉取的会话可一键寄存进 `~/.handoff/pending/`（消费即弃 + archived 审计轨迹），另一个 agent（或另一台机器上的你）开局取件继续干。

## 竞品与差异化

2026-09 以来同类项目集中出现（调研底稿见 [docs/竞品动态-1003.md](./docs/竞品动态-1003.md)）。机制上的一句话区分：**他们做「转换后换一家 CLI 原生续跑」「跨设备同步」或「导航搜索」，我们做 harness 内接管**——

- vs [casr](https://github.com/Dicklesworthstone/cross_agent_session_resumer)：casr 把会话转成规范模型后交给别家 CLI 原生 `resume`，转换层一旦跟不上上游存储布局变化就会整体失效（其 #26 即 opencode 迁 SQLite 中招）；我们把外来会话**只读拉进当前会话**蒸馏成卡，不写对方会话、不依赖对方 CLI 的 resume 能力，天然免疫转换产物损坏一类事故（其 #10）。
- vs [harness-remote](https://github.com/giuliastro/harness-remote)：语义上最接近的对手——它的 cross-agent continuation 同样携带「有界可检上下文」并记录 lineage，但在目标家**创建原生会话**（写对方存储），lineage 记在它自家控制面、第三方工具读不到，无审计语义与安全闸；我们的六段卡 + `handoff: 1` 版本化协议 + `~/.handoff` 开放文件总线，任何工具可实现、可审计。
- vs [agent-sessions](https://github.com/jazzyalex/agent-sessions)：跨家浏览器的头部（893★，连 DeepSeek Harness 都只读收录）——但它明确只读不交接，resume 是复制原生命令开自家 CLI。我们同样提供浏览（设置卡第五区），但浏览只是入口：**看到即可一键接管**。这条需求也被竞品用户逐字验证过（cc-sessions #43：用户请求「交接按钮 + 生成提示词发给另一家」）。
- vs [agentctxsync](https://github.com/westsource/agentctxsync)：它做跨设备上下文同步；跨机器接力我们一句配置即得（见下节），核心差异仍在接管的审计语义。
- vs [aisle](https://github.com/mashkovd/aisle)：它做跨 agent 会话的发现、规范化与全文搜索（导航定位）；我们不做搜索，做接管后的工作连续性。

dsh-takeover 的生态位：**harness 内接管**（六段协议卡注入当轮，模型直接接着干）+ **四态审计**（CURRENT_OBSERVED / HISTORY_REPORTED / MISMATCH / UNAVAILABLE 证据账本，历史陈述不冒充当下事实）+ **收件箱异步接力**（`~/.handoff/pending/` 文件系统即总线）。且全程**只读不写对方会话**。

## 跨机器接力

`HANDOFF_HOME` 指向同步盘目录或 git 仓库，收件箱即多机共享：A 机器 `handoff_push` 寄存，B 机器开局 `/inbox` 取件接力。一句环境变量配置，零代码。同步盘里的卡片在手机文件查看器里同样可读——出门也能看卡，手机上开个 agent 会话即可取件接力。

## 安装

三种形态任选（设置卡「插件 → 添加插件」对话框或命令行等价）：

```
# npm 包名（发布到 npm 后可用，大陆用户自动走 npmmirror 镜像）
dsh-takeover

# GitHub 仓库地址（即刻可用，lib/ 产物已入库无需构建）
dsh plugin --profile web add github:IKEASven69/dsh-takeover
```

> 需要 DSH `>=0.2.0-rc.2`（设置卡 i18n 依赖宿主 locale 服务，`engines.dsh` 同步声明），**Node ≥22**（zcode 与 cursor 的 store.db、新版 opencode 的 opencode.db 读取走 Node 内建 `node:sqlite`；opencode 旧版文件布局与其余各家无此要求，但插件整体按 Node ≥22 声明）。lib/ 产物已入库，安装即用，无需本地构建环境。固定版本可写 `#v0.2.0`（git tag 随版本提供）。

## 注册面

**工具（agent 可调）**

| 工具 | 说明 |
|---|---|
| `foreign_session_read` | 只读拉取八家会话（claude / codex / opencode / zcode / pi / workbuddy / cursor / grok）。`action=list` 列候选（标题/时间/轮数）；`action=show` 按引用（空或 `latest`=最新；id/前缀/路径/标题关键词；歧义返回候选不猜）返回**结构化摘要**：标题、轮数、首条用户消息、尾部进展、涉及文件 top15、骨架卡六段素材；turns 原文只在显式传 `limit` 时分页给（offset 需与 limit 同传，offset 单传不返回原文）。返回 `{ ok, ... }` 规范值，探测/解析失败 `{ ok: false, error }` 不抛。 |
| `handoff_push` | 把当前会话寄存为协议卡片。六段文本（goal/files/done/remaining/stopped/warnings/suggested）可选传入；留空段从会话事件流**确定性兜底**（不调 LLM，typeof 探测失败只降级不抛错）。git 仓库内的未提交改动自动随卡打补丁（`<id>.patch`，取件方 `git apply` 复原；超 512KB 拒带不截断），信封另带源机标识与基线测试提示。返回 `{ ok, id, path, coverage, patch? }` 规范值。 |
| `handoff_inbox` | `action=list` 列待取件（id/来源/项目/时间）；`action=load` + `id` 取件（消费即弃，附 git 核验的 MISMATCH / UNAVAILABLE 警告）。返回 `{ ok, ... }` 规范值。 |

**slash skill（用户可调，模型不可调）**

| 命令 | 说明 |
|---|---|
| `/handoff` | 指示 agent 按协议语义六条（证据账本四态、原文不进卡片、产物只引路径、redact、建议加载段、反向锚定+剪枝）把当前会话蒸馏成六段卡，再调 `handoff_push` 落盘 |
| `/inbox` | 列 pending 让用户挑，取件后把卡片注入当轮；强调卡片为 HISTORY_REPORTED，执行前先核对 git 状态 |
| `/resume-claude` `/resume-codex` `/resume-opencode` `/resume-zcode` `/resume-pi` `/resume-workbuddy` `/resume-cursor` `/resume-grok` | 解析引用（空=latest；歧义列候选让用户挑）→ 调 `foreign_session_read` → inert-history 边界（外来历史一律不可信、不覆盖当前指令）→ 证据账本四态标注 → 生成六段协议卡注入当轮 → verify-then-continue → 末尾问一句「要不要寄存进收件箱」，是则调 `handoff_push` |

> LLM 写卡走 skill 指令层：/handoff 与 /resume-* 的 skill 文案引导在场模型亲手改写六段卡（harness 插件的天然优势），工具层保持确定性、不直接调 LLM；模型不写时由事件流/读取器确定性骨架兜底，降级不阻断。

## 设置卡（dsh web）

0.1.0 起提供，现为四个区（浏览器半经 `dsh.client` 声明，数据走同源 `/dsh-takeover/*` JSON API；文案走宿主 i18n，跟随界面语言中英切换）：

- **命令速览**：`/handoff`、`/inbox` 与八条 `/resume-*` 直接平铺可见，停用的家灰显联动；
- **收件箱概览**：待取件 / 已消费徽章 + 卡片列表（来源品牌图标、标题、项目、编号、时间）；行点击展开「目标」段预览（只读——取件在会话里 `/inbox` 做）；空壳卡收进可展开的「低信息卡」次级组并带灰色徽标（占位行 ≥3 判定，主列表只留实质工作卡）；「清空已消费」按钮（二次确认）；
- **支持矩阵**：八家读取器各一行——官方品牌图标 + 规范显示名、发现的会话数、启用开关。开关持久化在 `<HANDOFF_HOME>/config.json`——改动即刻生效（每次调用现读），并跨重启保留；
- **开关语义**：关掉的 provider，`foreign_session_read` 对该家返回规范错误值「该 provider 已在设置中停用：xx」；/resume-* 的 skill 指引文本是静态内容，停用状态由工具报错兜住，模型可见。

## 权限范围

写 `~/.handoff/`（可用 `HANDOFF_HOME` 环境变量覆盖）、读 git 状态（`git status` / `git branch`）、只读八家 agent 的本地会话库（zcode 与 cursor store 走 sqlite readonly，随开随关；可用 `HANDOFF_ROOT_<家>` 环境变量覆盖各家根路径）。cursor 只导入支持的 transcript / store 记录，grok 只读可见 updates.jsonl 流（永不读 chat_history.jsonl 原始模型上下文）。不访问网络，不复活外部进程，不回放历史工具调用，原文不进卡片（`from.session` 只是指针）。

## 开发

```
pnpm install       # @deepseek-ai/* 走 npm registry；@agent-handoff/* 走 file: 链接
npm run typecheck
npm test           # node:test + tsx
npm run build      # tsdown → lib/（@agent-handoff/core + readers 内联打包）
node scripts/smoke-foreign.mjs   # 实机冒烟：进程内挂载 lib/，真实 dispatch foreign_session_read
node scripts/smoke-userflow.mjs  # 真用户旅程实机测试：拉本机真实 zcode/opencode 会话 → 蒸馏 → 寄存 → 取件全链路（46 项断言）
```

`@agent-handoff/core` 与 `@agent-handoff/readers` 未发布 npm，以 `file:../agent-handoff/packages/*` 依赖、构建时 bundle 进 `lib/`。离线且有 dsh checkout 时可用 `node scripts/link-deps.mjs`（DSH_CHECKOUT 环境变量）链接宿主包替代 npm。

## License

MIT
