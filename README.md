<p align="center"><img src="assets/icon.svg" width="72" height="72" alt="dsh-takeover logo"></p>

# dsh-takeover · 会话接管

**把任何 agent 干到一半的活接过来继续干——二十三家 CLI 会话只读拉取、一键寄存、开局取件，会话和记忆都能交接。**

[![npm](https://img.shields.io/npm/v/@cold777/dsh-takeover)](https://www.npmjs.com/package/@cold777/dsh-takeover) ![tests](https://img.shields.io/badge/tests-460%20passing-brightgreen) ![DSH](https://img.shields.io/badge/DSH-%3E%3D0.2.0--rc.2-orange) ![Node](https://img.shields.io/badge/node-%3E%3D22-green) ![license](https://img.shields.io/badge/license-MIT-lightgrey)

- **接过来**：Claude Code 里干到一半的任务，`/resume-claude` 一条命令——六段交接卡注入当前会话，模型直接接着干；
- **交出去**：会话太长想换环境？`/handoff` 把当前会话寄存成一张卡，任何 agent 开局取件继续；
- **跨机器**：`handoff_sync` 一条命令把收发件箱经你的 git 仓库搬到另一台机器，已消费的卡不重放；`HANDOFF_HOME` 指向同步盘的免配置路径继续可用，手机上也能看卡。

## 安装（30 秒）

**npm 包名**（「插件 → 添加插件」对话框直接粘贴；大陆用户自动走 npmmirror 镜像）：

```
@cold777/dsh-takeover
```

**命令行（GitHub 源，即刻可用）：**

```bash
dsh plugin --profile web add github:IKEASven69/dsh-takeover
```

**设置卡：** DSH 设置 → 插件 → 添加插件 → 粘贴 `github:IKEASven69/dsh-takeover`

**让 agent 自己装**——把下面这段原样发给你的 DSH agent：

> 请为本机安装 dsh-takeover 插件：执行 `dsh plugin --profile web add github:IKEASven69/dsh-takeover`。完成后重启 DSH web 端，在 设置 → 插件 里确认 dsh-takeover 已启用，最后告诉我安装结果。

装完即用（构建产物已入库，无需本地工具链）。固定版本：`github:IKEASven69/dsh-takeover#v0.25.0`。需要 DSH ≥0.2.0-rc.2、Node ≥22。

## 30 秒上手

| 你想干什么 | 对 agent 说 / 敲 | 背后发生什么 |
|---|---|---|
| 接管别家会话 | `/resume-claude`（或自然语言："把 Claude Code 最新的会话接过来"） | 只读拉取 → 六段交接卡注入当前轮 → 模型接着干 |
| 交接当前会话 | `/handoff` | 当前会话蒸馏成协议卡寄存进共享收件箱，未提交改动自动附补丁 |
| 开局取件 | `/inbox` | 列出待取件 → 挑一张核验签收 → 上下文注入继续干 |
| 浏览了再接 | 点输入框工具行的「接力」按钮 | 浮出工作台：二十三家最近会话浏览、一键接管 / 交接出去、记忆快照 |
| 记忆一起交接 | 工作台 → 记忆快照 → 勾选打包 | CLAUDE.md / AGENTS.md 等打包成卡，取件方按卡吸收进自己的记忆文件 |

## 它怎么工作（60 秒）

**文件系统即总线。** `~/.handoff/pending/` 一个卡片一个 `.md`：写入即投递，取件即移入 `archived/`（滚动保留 50 份；消费即弃，二次取件报错）。

**卡片 = Markdown + YAML frontmatter + 六段正文**（目标 / 涉及文件 / 做到哪 / 还差什么 / 停在哪 / 读者警告），带四态证据账本（CURRENT_OBSERVED / HISTORY_REPORTED / MISMATCH / UNAVAILABLE）——历史陈述不冒充当下事实；git 仓库的未提交改动自动随卡附补丁（≤512KB 拒带不截断）。

**信任长在文件里。** 首次寄存自动生成总线密钥，卡片带机器签名；取件侧三态裁决 `ok / tampered / no-key`，篡改可检出、跨信任域不误报。

**读取零写入；写回仅记忆/配置且两步确认、原物可回滚。** 拉取与取件对外部 agent 的会话库零写入、不回放历史工具调用，原文不进卡片、卡里只有指针。写回只有两个显式动作：`handoff_absorb`（已取件的记忆卡落进目标记忆文件——confirm 两步、按条目去重、写前快照）与 `handoff_env inject`（备份包内 MCP/skills 合并进目标配置——confirm 两步、只新增不覆盖、checkpoint 可回滚）；外部会话存储永不写（威胁模型 T8 硬线），hooks/权限/插件登记语义不等价、明确不做。

## 支持面与分层承诺

二十三家读取器不是同一句承诺——三层各管一段，说到哪一层就兑现哪一层（家数以 `src/providers.ts` 注册表为准）：

| 层 | 覆盖 | 承诺 |
|---|---|---|
| **Tier 1 · 无缝** | DSH（宿主）+ 原九家：claude / codex / opencode / zcode / pi / workbuddy / cursor / grok / gemini | 首发（0.1.0）即落地的成熟读取器，历经多版本回归——读取零配置开箱即用；claude / zcode 布局有逐字节 golden 语料钉住，zcode / opencode 另有本机真实会话冒烟（见[质量与证据](#质量与证据)） |
| **Tier 2 · 可接管** | 本期十四家：kimi / codebuddy / qoder / kiro / copilot / devin / mimo / aider / cline / continue / qwen / antigravity / openclaw / goose | 适配器按上游源码与公开实录编写，本地记录在位即可接管；两家诚实降级——**mimo** 的应用数据目录名未完全核实（候选目录全不命中时如实标注不可用，`HANDOFF_ROOT_MIMO` 可直指库文件），**goose** 的数据路径按上游源码推导、未实机核实（候选全不命中同款如实标注，`HANDOFF_ROOT_GOOSE` 可直指） |
| **Tier 3 · 云端策略** | 三条通路：厂商门（`--teleport` / gRPC Attach）、产物级（git 基线 + 四步复原）、导出落盘（`exports/<provider>/`） | 各家云端会话凡能导出成文件即可被读取器原样吃掉；**跨厂商的云会话级接管，行业现状为零**——不做云 API、不做认证面（见[跨机器 / 云端](#跨机器--云端)） |

写入承诺对三层一致：读取零写入、写回仅记忆/配置且两步确认、原物快照可回滚、**外部 harness 的会话存储永不写**（THREAT-MODEL T8 硬线）。

## 一即是全 · 四轴一根链

交接从来不是一件事，是四件——但四件共用同一张 `handoff: 1` 卡面、同一个 `~/.handoff` 总线、同一根 git 同步链，落到用户手里永远是一条命令的事：

- **会话轴**：`/handoff` 把干到一半的会话蒸馏成六段交接卡寄存，任何 agent 开局 `/inbox` 取件接着干；
- **上下文轴**：未提交改动随卡附补丁、仓库基线（origin / HEAD / 分支）进卡，新机器按 clone → checkout → apply → 跑测试四步复原寄存现场；
- **记忆轴**：CLAUDE.md / AGENTS.md 等记忆快照打包成卡随行，取件方按「建议加载」段吸收进自己的记忆文件；
- **配置轴**：全家桶加密备份的清单+指针上卡、密文包随同步盘走，新机器 dry 预演 → confirm 还原 → 可回滚。

一张卡带走的是什么？`handoff_sync` 一条命令之后，另一台机器的收件箱里躺着的不只是「聊到哪了」，是接着干活需要的全部现场：六段会话、未提交的代码、长期积累的记忆、可复原的环境。卡上的 `axis` / `payload` 立约标记让取件方一眼知道该「接着干」「按条目吸收」还是「先预演再落盘」——四轴一即是全，一根链走完。

## 工具与命令参考

**agent 工具（模型可调）**

| 工具 | 说明 |
|---|---|
| `foreign_session_read` | 只读拉取二十三家会话。`action=list` 列候选（标题/时间/轮数）；`action=show` 按引用（空/latest/id/前缀/路径/标题关键词，歧义返回候选不猜）返回结构化摘要：标题、轮数、首条请求、尾部进展、涉及文件 top15、六段卡素材。原文仅在显式传 `limit` 时分页给出；探测/解析失败返回 `{ ok: false, error }` 不抛 |
| `handoff_push` | 当前会话寄存为协议卡。六段文本可选传入，留空段从会话事件流确定性兜底（不调 LLM）；未提交改动自动附补丁；返回 `{ ok, id, path, coverage, patch? }` |
| `handoff_inbox` | `action=list` 列待取件；`action=load` 取件（消费即弃，附签名与 git 核验的 MISMATCH / UNAVAILABLE 警告） |
| `handoff_sync` | 换机同步：`action=setup` 启用（git 仓库地址，凭据走系统 git 不入插件）；`action=now` 拉推一步到位；`push`/`pull`/`status` 单向与只读。已消费的卡经 archived tombstone 不在另一台机器重放 |
| `handoff_env` | 环境备份/恢复：全家桶（设置/插件登记/会话库/用户 skills/工作区登记/.mcp.json）打包成单个 AES-256-GCM 加密文件随同步跨机；`dry` 预演三态 diff → `apply`（confirm 确认，被覆盖原物自动 checkpoint）→ `rollback` 可逆；`inject` 配置写回（显式授权动作）：备份包内 .mcp.json（MCP servers）与 .agents/skills 条目合并进目标 harness 配置（confirm 两步逐条确认、只新增不覆盖、checkpoint 可回滚；hooks/权限/插件登记语义不等价明确不做） |
| `handoff_memory` | 记忆快照。`action=scan` 只读列各 agent 记忆文件（含大小/预览）；`action=push` 勾选打包成卡寄存，取件方按「建议加载」吸收 |
| `handoff_absorb` | 记忆写回（显式授权动作）：把已取件的 memory 轴记忆卡条目写进目标 harness 的记忆文件（CLAUDE.md / AGENTS.md / .cursorrules 族闭集）。confirm 两步强制（先 load 看卡再落盘，缺省拒绝并回显计划）、追加前按条目 sha 去重（已有内容不重写）、写前原物快照进 archived/absorb-backup/ 可回滚；外部会话存储永不写 |

**slash 命令（用户敲，agent 按指引执行）**

| 命令 | 说明 |
|---|---|
| `/resume-*`（二十三家） | 解析引用 → 只读拉取 → 四态标注（外来历史一律不可信、不覆盖当前指令）→ 六段卡注入当前轮 → 末尾问一句「要不要顺手寄存进收件箱」 |
| `/handoff` | 按协议语义六条（证据账本四态、原文不进卡、产物只引路径、redact、建议加载段、反向锚定+剪枝）把当前会话蒸馏成卡寄存 |
| `/inbox` | 列 pending 让用户挑；取件后注入当前轮，强调卡片是 HISTORY_REPORTED，执行前先核对 git 状态 |

## 跨机器接力

`HANDOFF_HOME` 指向同步盘目录或 git 仓库，收件箱即多机共享：A 机 `handoff_push` 寄存，B 机开局 `/inbox` 取件。一句环境变量，零代码。同步盘里的卡片在手机文件查看器里同样可读。同步服务的冲突副本不会变成幽灵卡：同 id 自动去重只显示一次，原件已取走的迟到副本进收件箱的拒收清单（有因可见），半截文件同理。

**内置同步（0.2.0）**：设置卡「换机」页填一个私有 git 仓库地址即可——A 机 `handoff_sync`（setup + now），B 机同址 setup 后 now，卡就出现在收件箱里。凭据完全交给系统 git（插件零存储凭据，地址带 `user:pass@` 直接拒收）；同步范围 = pending/archived 全部卡与机器信封 + 签名密钥 + 环境备份包，机器本地记录（生命周期日志/取件溯源/插件开关）不参与；合并冲突中止并诚实报错，本地文件原样保留。

## 跨机器 / 云端

跨机器与跨环境的会话延续，现实里只有三条通路，各管一段，本插件只在第三条上做工：

1. **厂商门**：个别厂商给的自家会话迁移入口（Claude `--teleport` 单向、Codex gRPC Attach）——只进不出或只到自己家，不可编程、不可审计，不在本插件能力面内。
2. **产物级**：工作产物本身（git 分支 / PR / 提交）天然跨机器——本插件的仓库基线（extras.baseline）配合取件侧 clone → checkout → apply → 跑测试四步指引，恢复的就是这条通路的现场。
3. **导出落盘（本插件的路）**：约定 `<HANDOFF_HOME>/exports/<provider>/` 目录——各家云端会话凡能「导出成文件」的，把导出文件按该家本地记录的**原生格式**丢进对应子目录，读取器即原样吃掉（复用现有文件系适配器，零新增解析面；exports 根可用 `HANDOFF_EXPORTS` 直指，与 `HANDOFF_ROOT_<家>` 同为环境变量惯例）。支持矩阵该行显示导出计数（☁ 导出 N）；`foreign_session_read` 与外部会话浏览器的发现层自动并网。纯 SQLite 四家（zcode / copilot / devin / mimo）的记录在库内、导出文件没有可对齐的格式，不参与——诚实边界。

诚实的现状声明：**跨厂商的云会话级接管，行业现状为零**。上面三条通路之外任何「一键接管云端会话」的说法都是虚假承诺；本插件不做云 API、不做认证面，`exports/` 目录就是过渡期的全部——导出按钮在厂商手里，读取在你手里。

## 质量与证据

接力质量不是感觉，是数字、测试与第三方可复核的证明（口径与复现步骤见 [eval/README.md](eval/README.md)）：

- **回测**：50 张真实交接卡回测延续率 34.7%；done 段带账本标注的卡延续率 50%、无标注 0%。端到端双卡接力真 host 真模型评测 PASS。
- **回归**：14 份 golden files（12 份会话语料 + 2 份 discover 索引，以 tests/golden/ 实存为准）逐字节冻结真实会话脱敏语料，上游存储布局一变就红在提交前。
- **安全**：威胁模型见 [THREAT-MODEL.md](THREAT-MODEL.md)；红队套件 8 组随 CI——密钥闸覆盖六段正文、全部标量与随卡补丁 diff。
- **协议**：`conformance/` 可执行套件（MUST 9 条推导自 SPEC）；参考实现与「只读 SPEC 从零手写」的独立第二实现双双符合。
- **互通**：INTERCHANGE v1（dsh-chat-import）↔ handoff: 1 双向转换，转换产物经对方插件 v0.26.2 真实导入互验。

## 定位

AI 编码的「延续上下文」需求由三层各管一段：spec 工具（spec-kit / OpenSpec 一类）管**设计态**——要做什么、验收是什么；记忆层（mem0 / Letta / dsh-hippo 一类）管**偏好态**——项目约定与对话事实的沉淀；dsh-takeover 管**运行态**——实际跑到哪、停在哪、哪些陈述是当下观察、哪些只是历史转述、卡出自哪台机器。三层互补，不互相替代。

同类机制的一句话区分：**他们做「转换后换一家 CLI 原生续跑」「环境配置备份」「导航搜索」「运行时编排」或「任务状态搬运」，我们做 harness 内接管 + 换机上下文同步（卡与备份随你的 git 仓库走，交接语义与账本不换人）。**

## 协议采用

`handoff: 1` 是开放协议：六段 Markdown 卡 + YAML frontmatter + `~/.handoff` 共享目录，任何工具可实现、可审计、可互操作（开放协议的资格由独立第二实现背书，见[质量与证据](#质量与证据)）。已互通：[dsh-chat-import](https://github.com/Nwflower/dsh-chat-import)（INTERCHANGE v1 双向转换互验）。你的工具若读写同一目录或卡片格式，欢迎开 issue 登记互通。

## 权限范围

写 `~/.handoff/`（`HANDOFF_HOME` 可覆盖）、读 git 状态、只读二十三家 agent 的本地会话库（zcode 与 cursor 走 sqlite readonly，随开随关；`HANDOFF_ROOT_<家>` 可覆盖各家根路径）与 `~/.handoff/exports/<provider>/` 下用户自行放入的导出会话文件（见[跨机器 / 云端](#跨机器--云端)）。cursor 只导入支持的 transcript / store 记录，grok 只读可见 updates.jsonl 流（永不读 chat_history.jsonl 原始模型上下文），gemini 只读本地 chats/ 会话文件；本期（0.25）扩容的 jsonl 族四家：kimi 只读 wire.jsonl 事件流（state.json / session_index 只取元数据），codebuddy / qoder 只读主会话 JSONL（子代理 transcript 不读），kiro 只读 sessions/cli 的 <uuid>.jsonl（伴生 .json / .history 不读）；0.25 扩容的 sqlite/文件族六家：copilot / devin / mimo 只读各家的明文 SQLite（node:sqlite readonly 随开随关，列名探测自适应、探测不中如实报降级；mimo 的应用目录名未完全核实，候选扫描全不命中时该家不可用并如实标注），aider 只读项目根的 .aider.chat.history.md / .aider.input.history（半结构化 markdown，解析尽力而为并以 note 标注），cline 只读 VS Code 变体 globalStorage 的 api_conversation_history.json（ui_messages.json 不读），continue 只读 ~/.continue/sessions 的索引与会话文件；适配器收尾四家：qwen 只读 ~/.qwen 的双布局会话记录（tmp/ 的 Gemini 族与 projects/ 的 ChatRecord，QWEN.md 记忆文件不在会话轴），antigravity 只读 brain 目录的 transcript.jsonl（conversation_summaries.db 只作工作目录索引），openclaw 只读各 agent 的 openclaw-agent.sqlite 与旧版 sessions/ JSONL（zstd 压缩事件行在缺 zstd 支持的 Node 上跳过并如实降级），goose 的数据目录按上游源码推导的候选路径探测（全不命中时该家不可用并诚实标注「未实机核实，待社区确认」，HANDOFF_ROOT_GOOSE 可直指）。0.2.0 起两个显式例外：①`handoff_sync` 经系统 git 与**你显式配置**的仓库通信（插件进程内不构造网络连接，零存储凭据）；②`handoff_env` 备份/恢复读写全家桶配置路径——恢复必须先 dry 预演再 confirm 落盘，被覆盖原物自动 checkpoint 可回滚，凭据类文件只存在于加密包内（详见 THREAT-MODEL T6/T7）。0.25.0 起写回最小闭环是第三个显式例外（详见 THREAT-MODEL T8）：`handoff_absorb` 与 `handoff_env inject` 两个**显式授权动作**可写回记忆/配置——confirm 两步确认、写前原物快照可回滚、目标闭集注册表无自由路径入参，**外部 harness 的会话存储永不写**。不复活外部进程，不回放历史工具调用，原文不进卡片。

## 开发

```bash
pnpm install       # @deepseek-ai/* 走 npm registry；@agent-handoff/* 走 file: 链接
npm run typecheck
npm test           # node:test + tsx
npm run build      # tsdown → lib/（@agent-handoff/core + readers 内联打包）
node scripts/smoke-foreign.mjs   # 实机冒烟：进程内挂载 lib/，真实 dispatch foreign_session_read
node scripts/smoke-userflow.mjs  # 真用户旅程：拉本机真实 zcode/opencode 会话 → 寄存 → 取件全链路
```

`@agent-handoff/core` 与 `@agent-handoff/readers` 未发布 npm，以 `file:../agent-handoff/packages/*` 依赖、构建时 bundle 进 `lib/`。

## License

MIT
