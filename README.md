<p align="center"><img src="assets/icon.svg" width="72" height="72" alt="dsh-takeover logo"></p>

# dsh-takeover · 会话接管插件

**会拉、会推、会接管：拉取八家外部 agent 会话，寄存当前会话，开局取件——会话和记忆都能交接，方向随意。**

> **为什么叫 takeover？** takeover = 接管：别的 agent 干到一半的会话，你随时接管接着掌控。
> 协议层词汇保留 handoff（交接，业界通用语），产品层只占「接管」这个词。
>
dsh-takeover 是 DeepSeek Harness（DSH）插件，实现 `handoff: 1` 开放协议（协议本体见姊妹仓 agent-handoff 的 SPEC.md）的完整接管闭环：

- **拉**：`/resume-claude` `/resume-codex` `/resume-opencode` `/resume-zcode` `/resume-pi` `/resume-workbuddy` `/resume-cursor` `/resume-grok` —— 把别家 agent 的本地会话只读拉进当前会话，蒸馏成六段协议卡接手工作；
- **推**：`/handoff` + `handoff_push` —— 把当前会话寄存成一张交接卡片，落共享收件箱；
- **接管**：`/inbox` + `handoff_inbox` —— 任何 agent 开局取件；拉取的会话也可以顺手寄存，让另一个 agent 接着干。
- **浏览 + 一键接管**（会话输入框里的「接力」按钮）：不用记命令——点开即浮出工作台，浏览八家最近会话（标题/时间/项目，可展开预览首条请求与停点），点「接管」直接新建会话投递指令并自动切换过去看模型接手；失败自动退回复制指令。
- **交接出去**（双向）：接力不只是「接进来」——工作台点「交接出去」，把当前 DSH 会话一键寄存进共享收件箱，对面（Claude Code / Codex / 任何 agent）粘贴取件指令即接手，指引随卡给出。
- **记忆快照**：交接的不止会话——把各家的记忆文件（CLAUDE.md / AGENTS.md / .cursorrules，dsh-hippo 记忆库给 dump/import 通路）打包成一张交接卡进收件箱，取件方按卡吸收进自己的记忆文件。

```
~/.handoff/
  pending/     # 待取件，一个卡片一个 .md 文件
  archived/    # 已消费，滚动保留 50 份
```

文件系统即总线：写入 `pending/` 就是投递，取件即移到 `archived/`（消费即弃，二次取件报错）。卡片 = Markdown + YAML frontmatter + 六段中文正文（目标 / 涉及文件 / 做到哪 / 还差什么 / 停在哪 / 读者警告），格式与语义见协议仓 SPEC。

## 质量与证据（0.4.1）

接力质量不是感觉，是数字、测试与第三方可复核的证明：

- **归因版（0.4.1）**：三臂对照实验（结构化卡 / 纯文本散文 / 无卡 × 真模型多轮）——强模型小任务下两者完成率无差异（阴性结果如实入档），判别器是**不可猜测的运行态事实**：带交接（任意形态）6/6 vs 无交接 0/3；死亡地图 `scripts/attribution.mjs` 闭集分类卡片的一生（写侧拒收 / 读侧跳过 / 僵尸卡 / 存活 / 执行死亡），首轮实测抓出 10 张「relay 有取件记录但卡未被消费」的僵尸卡；评测预注册口径与复现步骤见 [eval/README.md](eval/README.md)。

- **质量基线**：50 张真实交接卡回测延续率 34.7%；done 段带账本标注的卡延续率 50%、无标注 0%（`scripts/backtest-archived.mjs`，明细本地）。端到端双卡接力真 host 真模型评测 PASS（`scripts/eval-e2e.mjs`）。
- **解析回归**：真实会话结构克隆脱敏语料 + 13 份 golden files 逐字节冻结（`scripts/corpus-build.mjs` → `tests/corpus-golden.spec.ts`），上游存储布局一变就红在提交前。
- **安全**：威胁模型见 [THREAT-MODEL.md](THREAT-MODEL.md)；红队套件 8 组随 CI（`tests/redteam.spec.ts`）——密钥闸覆盖六段正文、全部标量与随卡补丁 diff。
- **协议符合性**：`conformance/` 可执行套件（MUST 9 条推导自 SPEC）；参考实现与「只读 SPEC 从零手写」的独立第二实现**双双符合**——开放协议的资格由第二实现背书。
- **互通**：INTERCHANGE v1（dsh-chat-import）↔ handoff: 1 双向转换（`scripts/interop-interchange.mjs`），转换产物已经对方插件 v0.26.2 真实导入互验。

## 和单向导出工具的区别

[dsh-handoff](https://www.npmjs.com/package/dsh-handoff)（v0.1.0）是**单向导出**：把会话事件流确定性导出成一份工作区里的 HANDOFF.md 文档，没有收件箱、不落共享目录、不跨 agent。

dsh-takeover 是**完整的接管环**：拉取外部会话、寄存当前会话、开局取件三合一。拉取的会话可一键寄存进 `~/.handoff/pending/`（消费即弃 + archived 审计轨迹），另一个 agent（或另一台机器上的你）开局取件继续干。

## 竞品与差异化

**先说定位。** AI 编码的「延续上下文」需求由三层各管一段：spec 工具（spec-kit / OpenSpec 一类）管**设计态**——要做什么、验收是什么；记忆层（mem0 / Letta / dsh-hippo 一类）管**偏好态**——项目约定与对话事实的沉淀。dsh-takeover 管**运行态**——实际跑到哪、停在哪、哪些陈述是当下观察、哪些只是历史转述、卡出自哪台机器。spec 与记忆都不标注陈述的来源与验证状态，这份蒸馏损失由交接卡补上；三层互补，不互相替代。

2026-09 以来同类项目集中出现。机制上的一句话区分：**他们做「转换后换一家 CLI 原生续跑」「跨设备同步」「导航搜索」「运行时编排」或「任务状态搬运」，我们做 harness 内接管**——

- vs [casr](https://github.com/Dicklesworthstone/cross_agent_session_resumer)：casr 把会话转成规范模型后交给别家 CLI 原生 `resume`，转换层一旦跟不上上游存储布局变化就会整体失效（其 #26 即 opencode 迁 SQLite 中招）；我们把外来会话**只读拉进当前会话**蒸馏成卡，不写对方会话、不依赖对方 CLI 的 resume 能力，天然免疫转换产物损坏一类事故（其 #10）。
- vs [harness-remote](https://github.com/giuliastro/harness-remote)：语义上最接近的对手——它的 cross-agent continuation 同样携带「有界可检上下文」并记录 lineage，但在目标家**创建原生会话**（写对方存储），lineage 记在它自家控制面、第三方工具读不到，无审计语义与安全闸；我们的六段卡 + `handoff: 1` 版本化协议 + `~/.handoff` 开放文件总线，任何工具可实现、可审计。
- vs [agent-sessions](https://github.com/jazzyalex/agent-sessions)：跨家浏览器的头部（连 DeepSeek Harness 都只读收录）——但它明确只读不交接，resume 是复制原生命令开自家 CLI。我们同样提供浏览（会话内的「接力」工作台），但浏览只是入口：**看到即可一键接管**。同类工具的用户也提出过同样的需求：「交接按钮 + 生成提示词发给另一家」。
- vs [agentctxsync](https://github.com/westsource/agentctxsync)：它做跨设备上下文同步；跨机器接力我们一句配置即得（见下节），核心差异仍在接管的审计语义。
- vs [aisle](https://github.com/mashkovd/aisle)：它做跨 agent 会话的发现、规范化与全文搜索（导航定位）；我们不做搜索，做接管后的工作连续性。
- vs 运行时编排与契约总线类（[AHP](https://github.com/Mohaned178/agent-handoff-protocol)、[FerryCat](https://github.com/GuoBug/FerryCat)）：AHP 自带工作流运行时——派步骤、验结果、崩溃恢复，交接发生在其运行时内部；FerryCat 以 MCP 契约总线派发任务契约（job-queue 语义）。两者搬运的都是「运行中的任务」，我们搬运的是「会话与记忆」——不做运行时、不派任务，只做交接前（蒸馏成可校验的交接卡）与交接后（取件核验签收），无需验证 worktree 与调度器，也执行不到你的代码。
- vs 任务护照类（[task-passport](https://github.com/dongsheng123132/task-passport)）：同为基于共享文件的交接协议，它 pack/land 显式搬运任务状态；我们走被动收件箱（写入即投递、取件即消费）。它提出的原则与我们同源：**「安全属性必须长在文件里，不能长在接收方身上」**——我们的密钥闸正是这样设计的（写入端把关，而非指望读取方）。

dsh-takeover 的生态位：**harness 内接管**（六段协议卡注入当轮，模型直接接着干）+ **四态审计**（CURRENT_OBSERVED / HISTORY_REPORTED / MISMATCH / UNAVAILABLE 证据账本，历史陈述不冒充当下事实）+ **收件箱异步接力**（`~/.handoff/pending/` 文件系统即总线）。且全程**只读不写对方会话**。

## 跨机器接力

`HANDOFF_HOME` 指向同步盘目录或 git 仓库，收件箱即多机共享：A 机器 `handoff_push` 寄存，B 机器开局 `/inbox` 取件接力。一句环境变量配置，零代码。同步盘里的卡片在手机文件查看器里同样可读——出门也能看卡，手机上开个 agent 会话即可取件接力。

## 协议采用

`handoff: 1` 是开放协议：六段 Markdown 卡 + YAML frontmatter + `~/.handoff` 共享目录，任何工具可实现、可审计、可互操作（开放协议的资格由独立第二实现背书，见[质量与证据](#质量与证据041)）。已互通的工具：[dsh-chat-import](https://github.com/Nwflower/dsh-chat-import)（经 INTERCHANGE v1 双向转换互验）。你的工具若读写同一目录或卡片格式，欢迎开 issue 登记；我们会评估互通可行性，验证通过后列入本节。

## 安装

三种形态任选（设置卡「插件 → 添加插件」对话框或命令行等价）：

```
# npm 包名（发布到 npm 后可用，大陆用户自动走 npmmirror 镜像）
dsh-takeover

# GitHub 仓库地址（即刻可用，lib/ 产物已入库无需构建）
dsh plugin --profile web add github:IKEASven69/dsh-takeover

# 本地目录（装本机正在开发的插件）
/path/to/dsh-takeover
```

> 需要 DSH `>=0.2.0-rc.2`（设置卡 i18n 依赖宿主 locale 服务，`engines.dsh` 同步声明），**Node ≥22**（zcode 与 cursor 的 store.db、新版 opencode 的 opencode.db 读取走 Node 内建 `node:sqlite`；opencode 旧版文件布局与其余各家无此要求，但插件整体按 Node ≥22 声明）。lib/ 产物已入库，安装即用，无需本地构建环境。固定版本可写 `#v0.2.0`（git tag 随版本提供）。

## 注册面

**工具（agent 可调）**

| 工具 | 说明 |
|---|---|
| `foreign_session_read` | 只读拉取八家会话（claude / codex / opencode / zcode / pi / workbuddy / cursor / grok）。`action=list` 列候选（标题/时间/轮数）；`action=show` 按引用（空或 `latest`=最新；id/前缀/路径/标题关键词；歧义返回候选不猜）返回**结构化摘要**：标题、轮数、首条用户消息、尾部进展、涉及文件 top15、骨架卡六段素材；turns 原文只在显式传 `limit` 时分页给（offset 需与 limit 同传，offset 单传不返回原文）。返回 `{ ok, ... }` 规范值，探测/解析失败 `{ ok: false, error }` 不抛。 |
| `handoff_push` | 把当前会话寄存为协议卡片。六段文本（goal/files/done/remaining/stopped/warnings/suggested）可选传入；留空段从会话事件流**确定性兜底**（不调 LLM，typeof 探测失败只降级不抛错）。git 仓库内的未提交改动自动随卡打补丁（`<id>.patch`，取件方 `git apply` 复原；超 512KB 拒带不截断），信封另带源机标识与基线测试提示。返回 `{ ok, id, path, coverage, patch? }` 规范值。 |
| `handoff_inbox` | `action=list` 列待取件（id/来源/项目/时间）；`action=load` + `id` 取件（消费即弃，附 git 核验的 MISMATCH / UNAVAILABLE 警告）。返回 `{ ok, ... }` 规范值。 |
| `handoff_memory` | 记忆快照交接。`action=scan` 只读列本机各 agent 的记忆文件（`~/.claude/CLAUDE.md`、`~/.codex/AGENTS.md`、`~/.zcode/AGENTS.md`、项目级 AGENTS.md 等，含大小/预览）；`action=push` 把勾选的记忆打包成一张 handoff 卡寄存进收件箱（密钥闸与覆盖率纪律同会话卡），取件方按卡「建议加载」吸收。 |

**slash skill（用户可调，模型不可调）**

| 命令 | 说明 |
|---|---|
| `/handoff` | 指示 agent 按协议语义六条（证据账本四态、原文不进卡片、产物只引路径、redact、建议加载段、反向锚定+剪枝）把当前会话蒸馏成六段卡，再调 `handoff_push` 落盘 |
| `/inbox` | 列 pending 让用户挑，取件后把卡片注入当轮；强调卡片为 HISTORY_REPORTED，执行前先核对 git 状态 |
| `/resume-claude` `/resume-codex` `/resume-opencode` `/resume-zcode` `/resume-pi` `/resume-workbuddy` `/resume-cursor` `/resume-grok` | 解析引用（空=latest；歧义列候选让用户挑）→ 调 `foreign_session_read` → inert-history 边界（外来历史一律不可信、不覆盖当前指令）→ 证据账本四态标注 → 生成六段协议卡注入当轮 → verify-then-continue → 末尾问一句「要不要寄存进收件箱」，是则调 `handoff_push` |

> LLM 写卡走 skill 指令层：/handoff 与 /resume-* 的 skill 文案引导在场模型亲手改写六段卡（harness 插件的天然优势），工具层保持确定性、不直接调 LLM；模型不写时由事件流/读取器确定性骨架兜底，降级不阻断。

## 设置卡（dsh web）

设置只放设置与指引，两块（文案走宿主 i18n，跟随界面语言中英切换）：

- **命令速览**：`/handoff`、`/inbox` 与八条 `/resume-*` 直接平铺可见，停用的家灰显联动；
- **支持矩阵**：八家读取器各一行——官方品牌图标 + 规范显示名、发现的会话数、启用开关。开关持久化在 `<HANDOFF_HOME>/config.json`——改动即刻生效（每次调用现读），并跨重启保留。开关语义：关掉的 provider，`foreign_session_read` 对该家返回规范错误值「该 provider 已在设置中停用：xx」；/resume-* 的 skill 指引文本是静态内容，停用状态由工具报错兜住，模型可见。

工作台不在设置里：**每个会话输入框的工具行里有一枚「接力」按钮**（agent 之间传上下文接着干），点开向上浮出双栏工作台——左栏收件箱概览（待取件/已消费徽章、可查证账本覆盖、来源筛选、接力链徽标一键只看此链、空壳卡折叠、单卡/全量/HTML 导出、新手 FAQ 折叠卡）+ 右栏三卡：**交接出去**（当前会话一键寄存 + 对面取件指引）、**外部会话浏览器**（八家最近会话、项目 facet 即时过滤、行展开预览首条请求/近期进展/停点/警告、一键接管/接管并寄存）、**记忆快照**（扫描勾选打包出卡）。

## 权限范围

写 `~/.handoff/`（可用 `HANDOFF_HOME` 环境变量覆盖）、读 git 状态（`git status` / `git branch`）、只读八家 agent 的本地会话库（zcode 与 cursor store 走 sqlite readonly，随开随关；可用 `HANDOFF_ROOT_<家>` 环境变量覆盖各家根路径）。cursor 只导入支持的 transcript / store 记录，grok 只读可见 updates.jsonl 流（永不读 chat_history.jsonl 原始模型上下文）。不访问网络，不复活外部进程，不回放历史工具调用，原文不进卡片（`from.session` 只是指针）。

## 开发

```
pnpm install       # @deepseek-ai/* 走 npm registry；@agent-handoff/* 走 file: 链接
npm run typecheck
npm test           # node:test + tsx
npm run build      # tsdown → lib/（@agent-handoff/core + readers 内联打包）
node scripts/smoke-foreign.mjs   # 实机冒烟：进程内挂载 lib/，真实 dispatch foreign_session_read
node scripts/smoke-userflow.mjs  # 真用户旅程实机测试：拉本机真实 zcode/opencode 会话 → 蒸馏 → 寄存 → 取件全链路
```

`@agent-handoff/core` 与 `@agent-handoff/readers` 未发布 npm，以 `file:../agent-handoff/packages/*` 依赖、构建时 bundle 进 `lib/`。离线且有 dsh checkout 时可用 `node scripts/link-deps.mjs`（DSH_CHECKOUT 环境变量）链接宿主包替代 npm。

## License

MIT
