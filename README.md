<p align="center"><img src="assets/icon.svg" width="72" height="72" alt="dsh-takeover logo"></p>

# dsh-takeover · 会话接管

**把任何 agent 干到一半的活接过来继续干——九家 CLI 会话只读拉取、一键寄存、开局取件，会话和记忆都能交接。**

![version](https://img.shields.io/badge/version-0.1.0-blue) ![tests](https://img.shields.io/badge/tests-327%20passing-brightgreen) ![DSH](https://img.shields.io/badge/DSH-%3E%3D0.2.0--rc.2-orange) ![Node](https://img.shields.io/badge/node-%3E%3D22-green) ![license](https://img.shields.io/badge/license-MIT-lightgrey)

- **接过来**：Claude Code 里干到一半的任务，`/resume-claude` 一条命令——六段交接卡注入当前会话，模型直接接着干；
- **交出去**：会话太长想换环境？`/handoff` 把当前会话寄存成一张卡，任何 agent 开局取件继续；
- **跨机器**：`HANDOFF_HOME` 指向同步盘，公司机器寄存、家里机器取件，手机上也能看卡。

## 安装（30 秒）

**命令行：**

```bash
dsh plugin --profile web add github:IKEASven69/dsh-takeover
```

**设置卡：** DSH 设置 → 插件 → 添加插件 → 粘贴 `github:IKEASven69/dsh-takeover`

**让 agent 自己装**——把下面这段原样发给你的 DSH agent：

> 请为本机安装 dsh-takeover 插件：执行 `dsh plugin --profile web add github:IKEASven69/dsh-takeover`。完成后重启 DSH web 端，在 设置 → 插件 里确认 dsh-takeover 已启用，最后告诉我安装结果。

装完即用（构建产物已入库，无需本地工具链）。固定版本：`github:IKEASven69/dsh-takeover#v0.1.0`。需要 DSH ≥0.2.0-rc.2、Node ≥22。

## 30 秒上手

| 你想干什么 | 对 agent 说 / 敲 | 背后发生什么 |
|---|---|---|
| 接管别家会话 | `/resume-claude`（或自然语言："把 Claude Code 最新的会话接过来"） | 只读拉取 → 六段交接卡注入当前轮 → 模型接着干 |
| 交接当前会话 | `/handoff` | 当前会话蒸馏成协议卡寄存进共享收件箱，未提交改动自动附补丁 |
| 开局取件 | `/inbox` | 列出待取件 → 挑一张核验签收 → 上下文注入继续干 |
| 浏览了再接 | 点输入框工具行的「接力」按钮 | 浮出工作台：九家最近会话浏览、一键接管 / 交接出去、记忆快照 |
| 记忆一起交接 | 工作台 → 记忆快照 → 勾选打包 | CLAUDE.md / AGENTS.md 等打包成卡，取件方按卡吸收进自己的记忆文件 |

## 它怎么工作（60 秒）

**文件系统即总线。** `~/.handoff/pending/` 一个卡片一个 `.md`：写入即投递，取件即移入 `archived/`（滚动保留 50 份；消费即弃，二次取件报错）。

**卡片 = Markdown + YAML frontmatter + 六段正文**（目标 / 涉及文件 / 做到哪 / 还差什么 / 停在哪 / 读者警告），带四态证据账本（CURRENT_OBSERVED / HISTORY_REPORTED / MISMATCH / UNAVAILABLE）——历史陈述不冒充当下事实；git 仓库的未提交改动自动随卡附补丁（≤512KB 拒带不截断）。

**信任长在文件里。** 首次寄存自动生成总线密钥，卡片带机器签名；取件侧三态裁决 `ok / tampered / no-key`，篡改可检出、跨信任域不误报。

**只读承诺。** 不写任何外部 agent 的会话库，不访问网络，不回放历史工具调用；原文不进卡片，卡里只有指针。

## 工具与命令参考

**agent 工具（模型可调）**

| 工具 | 说明 |
|---|---|
| `foreign_session_read` | 只读拉取九家会话。`action=list` 列候选（标题/时间/轮数）；`action=show` 按引用（空/latest/id/前缀/路径/标题关键词，歧义返回候选不猜）返回结构化摘要：标题、轮数、首条请求、尾部进展、涉及文件 top15、六段卡素材。原文仅在显式传 `limit` 时分页给出；探测/解析失败返回 `{ ok: false, error }` 不抛 |
| `handoff_push` | 当前会话寄存为协议卡。六段文本可选传入，留空段从会话事件流确定性兜底（不调 LLM）；未提交改动自动附补丁；返回 `{ ok, id, path, coverage, patch? }` |
| `handoff_inbox` | `action=list` 列待取件；`action=load` 取件（消费即弃，附签名与 git 核验的 MISMATCH / UNAVAILABLE 警告） |
| `handoff_memory` | 记忆快照。`action=scan` 只读列各 agent 记忆文件（含大小/预览）；`action=push` 勾选打包成卡寄存，取件方按「建议加载」吸收 |

**slash 命令（用户敲，agent 按指引执行）**

| 命令 | 说明 |
|---|---|
| `/resume-*`（九家） | 解析引用 → 只读拉取 → 四态标注（外来历史一律不可信、不覆盖当前指令）→ 六段卡注入当前轮 → 末尾问一句「要不要顺手寄存进收件箱」 |
| `/handoff` | 按协议语义六条（证据账本四态、原文不进卡、产物只引路径、redact、建议加载段、反向锚定+剪枝）把当前会话蒸馏成卡寄存 |
| `/inbox` | 列 pending 让用户挑；取件后注入当前轮，强调卡片是 HISTORY_REPORTED，执行前先核对 git 状态 |

## 跨机器接力

`HANDOFF_HOME` 指向同步盘目录或 git 仓库，收件箱即多机共享：A 机 `handoff_push` 寄存，B 机开局 `/inbox` 取件。一句环境变量，零代码。同步盘里的卡片在手机文件查看器里同样可读。

## 质量与证据

接力质量不是感觉，是数字、测试与第三方可复核的证明（口径与复现步骤见 [eval/README.md](eval/README.md)）：

- **回测**：50 张真实交接卡回测延续率 34.7%；done 段带账本标注的卡延续率 50%、无标注 0%。端到端双卡接力真 host 真模型评测 PASS。
- **回归**：13 份 golden files 逐字节冻结真实会话脱敏语料，上游存储布局一变就红在提交前。
- **安全**：威胁模型见 [THREAT-MODEL.md](THREAT-MODEL.md)；红队套件 8 组随 CI——密钥闸覆盖六段正文、全部标量与随卡补丁 diff。
- **协议**：`conformance/` 可执行套件（MUST 9 条推导自 SPEC）；参考实现与「只读 SPEC 从零手写」的独立第二实现双双符合。
- **互通**：INTERCHANGE v1（dsh-chat-import）↔ handoff: 1 双向转换，转换产物经对方插件 v0.26.2 真实导入互验。

## 定位

AI 编码的「延续上下文」需求由三层各管一段：spec 工具（spec-kit / OpenSpec 一类）管**设计态**——要做什么、验收是什么；记忆层（mem0 / Letta / dsh-hippo 一类）管**偏好态**——项目约定与对话事实的沉淀；dsh-takeover 管**运行态**——实际跑到哪、停在哪、哪些陈述是当下观察、哪些只是历史转述、卡出自哪台机器。三层互补，不互相替代。

同类机制的一句话区分：**他们做「转换后换一家 CLI 原生续跑」「跨设备同步」「导航搜索」「运行时编排」或「任务状态搬运」，我们做 harness 内接管。**

## 协议采用

`handoff: 1` 是开放协议：六段 Markdown 卡 + YAML frontmatter + `~/.handoff` 共享目录，任何工具可实现、可审计、可互操作（开放协议的资格由独立第二实现背书，见[质量与证据](#质量与证据)）。已互通：[dsh-chat-import](https://github.com/Nwflower/dsh-chat-import)（INTERCHANGE v1 双向转换互验）。你的工具若读写同一目录或卡片格式，欢迎开 issue 登记互通。

## 权限范围

写 `~/.handoff/`（`HANDOFF_HOME` 可覆盖）、读 git 状态、只读九家 agent 的本地会话库（zcode 与 cursor 走 sqlite readonly，随开随关；`HANDOFF_ROOT_<家>` 可覆盖各家根路径）。cursor 只导入支持的 transcript / store 记录，grok 只读可见 updates.jsonl 流（永不读 chat_history.jsonl 原始模型上下文），gemini 只读本地 chats/ 会话文件。不访问网络，不复活外部进程，不回放历史工具调用，原文不进卡片。

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
