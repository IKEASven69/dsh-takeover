# DSH 会话接管/交接类插件真实用户需求调研

> 调研时间：2026-11-22
> 方法：GitHub REST/GraphQL API（gh CLI）、webfetch、websearch、curl
> 用途：指导 dsh-takeover 0.27 版本——先调研真实用户需求，再做产品。

## 证据分级标注

- 🟢 **一手原话**：抓到原始帖子正文/评论全文（GitHub API 或网页正文）
- 🟡 **搜索索引片段**：websearch 返回的标题+开头，原站直连失败，未拿到全文
- 🔵 **二手整理**：博客/插件 README 作者对插件与场景的转述
- 🟣 **推测**：推断，非用户原话

**抓取受限说明（如实报告）**：V2EX（t/1238750 等）、LINUX DO（多个 topic）、知乎正文、B站评论区均直连/代理失败（Transport error / 空返回），只能拿到搜索引擎索引的片段，已逐条标注 🟡。B站只搜到视频标题（如「我给DSH做了个抗降智上下文压缩引擎」），未拿到评论区内容。`agent-handoff/agent-handoff` 仓库不存在（gh api 返回 MISSING）。所列竞品仓库中多数 `open_issues=0`，真实抱怨主要集中在 deepseek-harness 主仓 Discussions 与 cfanzx/dsh-compact-relay。

---

## ① 一手需求清单（按痛点强度排序）

### 需求 1｜上下文溢出后会话「永久卡死」，压缩本身把 ctx 毁掉 ★★★★★

**强度依据**：单帖 #9635 有 7 条评论 + 2 条回复、7 位独立参与者，且从 0.2.1-alpha.2 一路追到 0.2.2-rc.1 仍在追「still not fixed」；另有 #9727、#6510、LINUX DO 多帖独立复现。这是全生态最集中的抱怨。

- 🟢 [#9635 [compaction bug] Session becomes permanently unusable on context overflow](https://github.com/deepseek-ai/deepseek-harness/discussions/9635)（Zabrell，2026-10-13，7 comments / 7 participants）
  > "Four compaction attempts (1 automatic mid-turn + 3 manual `/compact`) all failed with **'Compaction could not produce a useful summary'**. The session was dead: every subsequent message (including bare `?`) reproduced the identical 400 error until manual surgery on the persisted JSONL was performed outside the harness."
  >
  > "There is no in-product recovery path for a wedged session (no 'drop region without summary', no range-limited manual compact, no fallback route for the auxiliary call)."

- 🟢 同帖 brandonzyy（2026-10-22）的**中文特有问题**：
  > "DeepSeek's tokenizer emits ~0.6–1 token per CJK character, so on Chinese-heavy sessions the estimate is **3–4x below reality**... context panel showed **24%**, while the failing compaction/turn requests were rejected at >1,048,568 tokens — a clean ~4x gap on an all-Chinese session."

- 🟢 同帖 silverqx 的「终极 Boss」评论（2赞）：
  > "ctx compression and memory is a very hard problem; it's the final boss... every harness is compressing the whole ctx auto under pressure, and the user has very little control over it, every harness virtually ruins your ctx once you hit the compression point, you can't tell what you want to compress, how you want to compress it, or what you need to focus on during compression..."
  >
  > d1ffuser 回复："sounds amazing! I don't think this has to be sci-fi – please write that as a plugin :)"

- 🟢 [#9727 [Bug][Web] Session stuck in ghost "running/compacting" state after crash or failed resume — no UI recovery path](https://github.com/deepseek-ai/deepseek-harness/discussions/9727)（higs-A，0 comments）
  > "UI permanently shows '运行中 / compact 正在压缩…'; the send button stays disabled... **Only workaround: the undocumented `POST /api/session/cancel` RPC**... Resume failure is all-or-nothing: one mis-configured plugin row aborts the entire session resume."

- 🟢 [#6510 Automatically disable thinking during context compression](https://github.com/deepseek-ai/deepseek-harness/discussions/6510)（gillbilliee，2 comments）：压缩时模型把 budget 烧在 thinking 上；作者 workaround 是「建两个 profile，一个 thinking on 一个 off」。

- 🟡 [LINUX DO t/2937207](https://linux.do/t/topic/2937207)「dsh 0.1.7 上下文压缩条件变了，可能导致频繁压缩」；[LINUX DO t/3151802](https://linux.do/t/topic/3151802) 用户自写分块压缩插件，描述「把上下文按 5% 分块压缩、逐个替换直到 15% 以内」。

- 🔵 [dsh-context-keeper 博客介绍](https://blog.yeyupiaoling.cn/article/1793815885627?lang=zh-cn)（夜雨飘零，2026-11-05）：
  > "上下文窗口被占满后，要么硬续聊丢细节，要么开新会话又要从头对齐……README 明确说明测量后放弃了「缩短思考」的原目标。"

### 需求 2｜「交接」不是「压缩」——缺一个一等公民的手动 handoff 入口 ★★★★★

**强度依据**：官方帖 #11108 明确论证「社区至少 4 个插件各造一套格式」本身就是需求证据；cnblogs 666 会话复盘给出**数据量化的用户行为证据**（80 个会话首条消息是「继续/按交接文档继续」）。

- 🟢 [#11108 [Feature request] Manual handoff entry point — hand a session over, don't just compact it](https://github.com/deepseek-ai/deepseek-harness/discussions/11108)（zeroarpania，2026-10-26，0 comments）
  > "`/compact` is not a substitute. Compaction keeps the session and replaces the timeline with a summary. A handoff *ends* the session and carries a reviewable artifact forward. They solve different problems, but only compaction has a first-class entry point."
  >
  > "Community plugins fill the gap with their own formats — dsh-plugin-bridge, StateDock, Sourcebook, dsh-delivery-board — so every user ends up with an incompatible handoff shape. **That divergence is itself evidence the need is real and unfilled.**"
  >
  > 具体案例：「从早跑到晚、多次重启、数百次工具调用，只有把对话一直续着直到某个插件的交接仪式能触发，才干净交出去；有入口的话就是一个动作。」

- 🟢 [#13947 [Feature] Session continuity: a reliable resumed-vs-new signal and a pre-compaction handoff](https://github.com/deepseek-ai/deepseek-harness/discussions/13947)（wetqaq，2026-11-20，0 comments）
  > "A long-lived session used as a companion keeps the facts after compaction but **loses its own voice: the summary drops tone, open threads and intent**... Today the choice is 'keep one session and get thinner' or 'start over'."
  >
  > "for companion-style use, 'a new session' is not a UX inconvenience; it is **the loss of the entity the user was talking to**."

- 🔵 [cnblogs《把 666 个会话摊开看》](https://www.cnblogs.com/znlgis/p/23489729)（2026-10-30，基于 666 个真实会话离线解析，文带 AIGC 标识）
  > "**经验三：重启之前，先写交接。** 哪怕只写三行——'做到哪了、卡在哪、下一步是什么'——也能让新会话省掉一半的取证时间。数据里能看到这种做法的痕迹：**有 80 个会话的首条消息是'继续/按交接文档继续/下一步是 X'这类接续式表述**，它们的取证阶段明显更短。"
  >
  > "**把关键信息写进文件。上下文会被压缩、会话会被重启，文件不会。压缩后第一件事是落盘，不是继续推理。**"
  >
  > 另有「重启风暴」：同一天同一工作目录多个根会话 **47 组、165 个会话，最多一天开 12 个**。

- 🟡 [LINUX DO t/3038183「压缩上下文继续对话🆚 新开对话」](https://linux.do/t/topic/3038183)：
  > "一个对话干得其实不错，但是进行了很多轮的交互，且已经压缩上下文非常多次了……"

### 需求 3｜跨会话「人肉传话筒」——顶层会话之间不能读、不能接力 ★★★★☆

**强度依据**：#12365 有明确 +1；#9922 来自 26 workspace / 400+ session 的重度用户；V2EX 与博客各自独立出现同类插件，说明是普遍工作流。

- 🟢 [#12365 [Feature] 跨会话上下文互通：让会话之间能读、能接力（cross-session handoff API）](https://github.com/deepseek-ai/deepseek-harness/discussions/12365)（lihaiyang616，2026-11-06，2 comments / 3 participants）
  > "用户经常同时开多个会话（不同工作区、远程/手机端各一个），于是**人成了传话筒**：在 A 会话讨论完，要去 B 会话再复述一遍，或者把 A 的结论复制到 B。"
  >
  > 评论 QIANLING-0831：「跨会话读消息、投递任务还没做……最好再有按 operationId 查完成/失败状态的接口，免得投递成功后又得人工追问。」
  >
  > 评论 DYZhang-ai：「**需要跨会话互通+1**」

- 🟢 [#9922 Feature request — request-reply contract for inter-session messaging](https://github.com/deepseek-ai/deepseek-harness/discussions/9922)（aavainer，0 comments）
  > "We run a large multi-session workspace (**26 workspaces, 400+ sessions**, hub-and-spoke coordination)... the worker must remember to manually call `session/prompt` back to the requester — and **sessions frequently forget**."
  > 记录的事故：「an arbiter's verdict never returned to the requester」「a handoff between two sessions 'dropped'」。

- 🟢 [#6444 [Bug] Inter-session coordination degrades: handoffs are not picked up](https://github.com/deepseek-ai/deepseek-harness/discussions/6444)（aavainer，0 comments）
  > "Handoff is not picked up — the producer session finishes and reports done, but the consumer session never notices."
  > "Duplication is user-confirmed ('same request arrives 2+ times; **had to repeat 100–500 times**')."

- 🟡 [V2EX t/1238750「session to session 让多个会话能互相喊话」](https://www.v2ex.com/t/1238750)：
  > "s2s 找到名为'部署'的会话，发现它静止了，把它拉起来，并把交接消息投进去。部署醒来，看到上下文和下一步，继续把发布收尾——**不用重新开一遍、也不用重新交代**。"

- 🔵 [夜雨飘零：dsh-session-messaging](https://blog.yeyupiaoling.cn/article/1793941397417?lang=zh-cn)（2026-11-06，提到该插件 20 stars/4 forks）：
  > "想做跨会话交接（A 会话让 B 会话查回归结果、顺手新开会话写 CHANGELOG），以前只能靠人手动复制粘贴。"

### 需求 4｜交接内容质量：「新会话不知道上个会话做到哪了」 ★★★★☆

- 🟢 [cfanzx/dsh-compact-relay issue #1](https://github.com/cfanzx/dsh-compact-relay/issues/1) 用户 qqsd364 的真实评论（**终端用户原话**，非插件作者）：
  > "在我会话正常压缩过一次后无法压缩第二次，显示会话过短，图上下文到70%我担心无法交接新文档就直接交接了，**交接的新文档不知道上个文档做到哪里了只看关键位置就动手做**，希望解决后可以告知我QQ邮箱3297539230qq.com，谢谢"
  > 同帖还提：「我最近看一些视频可以把**会话压缩成文件格式，需要时调动查看**，不知道是否可以在这个项目上使用」——即「可归档、可回读的交接文件」。

- 🟢 [#2984 dsh-plugin-bridge — Cross-preset session migration with fixed-schema handoff summaries](https://github.com/deepseek-ai/deepseek-harness/discussions/2984)（Totoro-qaq）
  > 中文原文：「preset 锁得对，但锁完不该是死路。本插件把会话「搬家」——压缩成**五段交接摘要（goal / state / decisions / files / next step）**，在新 preset 下开新会话接力，**摘要先给你预览确认，原会话一字不动**。」
  > 实测数据：「pro tier: 95% probe recall, 100% summary fidelity, ~2K tokens per migration (~0.4% of a working session)；bare-restart control: **55%**」——**交接卡比裸重启有效性几乎翻倍**，这是「结构化交接卡」价值的量化证据。

- 🟢 [#13023 [RFC] Verbatim relay: main-agent transcription normalizes CJK curly quotes](https://github.com/deepseek-ai/deepseek-harness/discussions/13023)（zonglong1025）：中文逐字内容经模型转述会丢字节保真；提出「**file-SSOT**」——内容由确定性脚本写盘（sha 可验证），消息只带指针。

- 🔵 [dsh-baize-session 博客](https://blog.yeyupiaoling.cn/article/1792311038768?lang=zh-cn)：支持跨对话/跨工作区挑消息迁移，写入前估 token、超限拒写；「选中的消息会被重写为一段文本插入目标对话开头，而不是作为事件重放」——反映用户对「可控搬运 + 预算护栏」的需求。

### 需求 5｜跨机器/跨 agent 的环境与记忆一起带走 ★★★☆☆

**强度依据**：生态插件数量最多（StateDock、Sourcebook、DSH-Projects、dsh-fusion、dsh-memory-spaces、dsh-unified-context、dsh-mobile、dsh-carry 等），但多为插件作者自述（🔵），一手抱怨较少。

- 🟢 [#9776 StateDock — Keep plans, task context and handoffs across coding tools](https://github.com/deepseek-ai/deepseek-harness/discussions/9776)：Plan / Pickup / Update 三技能，「keep the task, decisions and handoff available when you switch tools」；明确「plugin does not execute task code...」，且只验证 0.2.0-rc.2。
- 🟢 [#4625 dsh-memory-spaces](https://github.com/deepseek-ai/deepseek-harness/discussions/4625)（icearia0219）：
  > "在架构会话中确定的约束，编码会话并不知道；新会话需要重新解释项目背景、偏好和历史决策；有价值的结论往往留在最初讨论它们的会话里；手动复制信息容易遗漏。"
  > 「从旧会话交接到新会话」被列为三大场景之一。
- 🟢 [Chang-Tong/dsh-unified-context issue #7](https://github.com/Chang-Tong/dsh-unified-context/issues/7)：`encodeCurrent requires Session format v3` —— **版本兼容脆弱**。
- 🔵 [dsh-auto-handoff README](https://raw.githubusercontent.com/S3K926/dsh-auto-handoff/main/README.md)：「**跨设备没做：手机侧没有同一套 Web 客户端，切会话要另想办法**」；交接包 1200 字上限、「**交接包是压缩后的接手起点，不是复制品——新会话一开就吃满上下文等于把坑搬过去**」。仓库描述标注「已弃用 2026-10-17：换会话整条退役」（🟡 来自搜索摘要）。

### 需求 6｜可诊断性：静默失败比报错更招骂 ★★★☆☆

- 🟢 [cfanzx/dsh-compact-relay issue #3](https://github.com/cfanzx/dsh-compact-relay/issues/3)（Xdd0808）：
  > "四条出口共用一句 '暂无可压缩内容'…… 再加上 measurePressure 的异常被静默 catch 掉，**用户和作者都无法判断到底卡在哪一步。我这次为了定位，只能把 lib/ 里的代码一路读下来反推**。"
  > 规律：「每条对话只有第一次压缩能成功，之后每次都说「暂无可压缩内容」」。
- 🟢 [#4909 生命周期交接契约缺失](https://github.com/deepseek-ai/deepseek-harness/discussions/4909)（yamingmou/OfferKuai，10 comments，多人参与）：「父退子留；孤儿不释放；**交接信息丢失**；崩溃静默死」「长委托链下游结算通知永久丢失 → 用户失聪，以为任务还在跑」。
- 🟢 同帖 xngyan 的实测：「等到人类发现并中断时，它已累计约 **199K token，交付产出为零**」；bobcyw：「A 40-second job lived 3 seconds」（job 在 turn/end 被杀）。

---

## ② 用户真正在意什么（5 个主题）

| 主题 | 证据归纳 | 一句话 |
|---|---|---|
| **A. 要「现场」不要「摘要」** | #11108「reviewable artifact」、#2984 五段卡 95% vs 裸重启 55%、qqsd364「不知道做到哪了只看关键位置就动手做」 | 用户要的是能回看、能核验、能回滚的交接口，不是一段被 LLM 改写过的话 |
| **B. 控制权与可预览** | #9635 silverqx「user has very little control」、#2984「摘要先给你预览确认」、cfanzx #3「无法诊断」、dsh-auto-handoff 的 `dryRun: true` 与「别打断正在打字的人」 | 先预览/先干跑/明确确认，别在我正看着屏幕时替我做决定；失败要告诉我为什么 |
| **C. 连续性 = 身份与语气** | #13947「loses its own voice / the loss of the entity the user was talking to」、cnblogs「压缩后第一件事是落盘」 | 保住事实不够，开放线索、意图、风格、未完成动作都要能带走 |
| **D. 可靠性优先于功能数量** | #9635「permanently wedged」、#9727「ghost running」、#6444 handoff 不pickup/重复100–500次、订单 #3 静默失败 | 一次静默丢交接比「功能少」严重得多；用户宁愿慢也要确定送达 |
| **E. 多 agent/多机是常态，但要零配置可审计** | #12365 人肉传话筒、#9922 400+ sessions、夜雨飘零 session-messaging 20 stars、V2EX s2s、cfanzx 各插件 pin 死版本 | 人本来就在多个 harness/多台机器间切换；交接必须跨工具且不能要求用户改配置 |

---

## ③ 负面信号 / 现有产品被骂的点

1. **「压缩即毁上下文」已成共识**：silverqx「every harness virtually ruins your ctx once you hit the compression point」；CJK token 低估 3–4 倍（brandonzyy）。
2. **卡死无逃生按钮**：#9635 用户手动改 JSONL 才能救；0.2.2-rc.1 仍在报；#9727 只有未文档化的 RPC 能救。
3. **静默失败/无诊断**：cfanzx #3 四个失败出口共用一个文案；#4909「kick 的 catch 静默吞掉所有错误」。
4. **交接后「只看关键位置就动手做」**（qqsd364）——这是交接类插件最具体的差评。
5. **兼容性脆弱**：StateDock 只认 0.2.0-rc.2；dsh-unified-context `encodeCurrent requires Session format v3`；cfanzx 用户环境 DSH 0.2.2-rc.3；dsh-auto-handoff「装 bundle、改 config 都认重启（HMR 不可靠）」。
6. **升级覆盖用户改动**：OrderG dsh-mobile #2「每次插件升级都会覆盖 node_modules，补丁就丢了，得重打一次」。
7. **UI 细节割裂**：cfanzx #1/#2 浮层离按钮很远、滚动抽搐、内容被裁；dsh-mobile #1 手机竖屏侧栏发灰点不动。这些贴说明用户会认真吐槽「体验毛刺」。
8. **方案路线被证伪/弃用**：S3K926/dsh-auto-handoff 仓库描述标注换会话整条退役（🟡）；其 README 自述默认 `autoTrigger: false`、`dryRun: true`、不写档案——反映「怕自动切会话打扰用户」「怕写脏数据」的保守心态。
9. **插件越多越乱**：知乎文章（🟡/🔵）「插件和插件之间可能会打架……有些插件会往上下文里塞东西，白白浪费 Token」。

---

## ④ 对 dsh-takeover 0.27 的启示（具体到功能形态）

结合产品现状（0.26 已有六段卡、四态证据账本、git 补丁、handoff_sync、加密环境备份、23 家读取器、五项预检、会话医生等），0.27 应把「体验打磨」集中打在以下四点，而不是继续堆能力：

### 1. 把「交接卡」升级为「可审查现场包」——直接命中需求 2/4
- **一键 Handoff 入口 + 预览确认**：对话标题栏「Handoff」按钮 + `/handoff`，生成卡后**强制先展示六段预览**，用户可编辑再寄存（#2984 的预览确认是其 100% 保真度的关键）。
- **加「做到哪了」强字段**：在六段中把「做到哪 / 还差什么 / 停在哪」做成**机器可校验的锚点**——附 git HEAD/分支/dirty 文件清单/最后一条命令与输出摘要，取件侧打开卡片第一屏就是它。直接回应 qqsd364「不知道上个文档做到哪里了只看关键位置就动手做」。
- **「回读原文」开关**：卡片只存指针（符合现有「原文不进卡」），但提供 `handoff_inbox show --with-context N` 从源会话按 seq 拉取有界原文（默认关闭、显式授权）。呼应「会话压缩成文件、需要时调出查看」。[cfanzx #1](https://github.com/cfanzx/dsh-compact-relay/issues/1)

### 2. 「可诊断 + 不打断」做成默认体验——直接命中需求 1/6
- **五种失败原因码**：寄存/取件/同步的每步失败给稳定 code（如 `NO_COMPACTABLE_RANGE` / `TOKEN_METER_UNAVAILABLE` / `PATCH_TOO_LARGE` / `SIGNATURE_MISMATCH` / `GIT_CONFLICT`），UI 按 code 给人话文案，而不是统一「暂无可交接内容」。抄 cfanzx #3 的建议。
- **绝不自动切会话**：沿用 dsh-auto-handoff 的教训——默认只写卡 + 提示「可以取件了」，由用户点「开新会话/取件」；`autoTrigger` 若要给，也要加 `draft-report` 类似的「正在打字就不打断」守卫。
- **dry-run 默认**：`handoff_push --dry` / `handoff_env dry` 作为首次使用默认引导，日志显示「本来会写什么」，零落盘。

### 3. 交接的「回声」与幂等——直接命中需求 3
- **签收回执 + 幂等键**：每张卡带 `operationId`，取件写 tombstone，`/inbox` 显示「已投递 / 已签收 / 取件方已开工」三态；避免 #6444「handoff 没被 pickup」「重复 100–500 次」和 #9922「result never returned」。
- **跨机器用 git 已有基础，补「送达可见」**：`handoff_sync` 已用 tombstone 防重放，0.27 把 `status` 做成一屏可懂的「哪张卡到哪台机器、谁取了、谁还没读」，而不是只报同步成功。

### 4. 兼容性与可靠性护栏——直接命中负面信号 5/7/9
- **版本兼容矩阵 + 降级提示**：每张卡/每次同步记录 DSH 版本与 card schema；遇到不兼容（类似 `Session format v3`）给明确提示和 migration 指引，不静默失败。
- **升级不丢用户配置**：你已有 checkpoint/回滚；0.27 把「升级后自动校验用户补丁仍在」做成自检项（OrderG 被骂的点）。
- **CJK 特化预算显示**：参考 brandonzyy 的发现，在余量预警里对中文会话加保守系数并明示估算口径，避免用户看到「24%」却突然 overflow——这是 takeover 做「上下文余量预警」时最容易踩的坑。

### 优先级建议
**P0**：需求 1/2 的「预览 + 做到哪了 + 失败原因码 + 不自动切」（用户骂得最狠、竞品验证最充分）
**P1**：需求 3 的「签收回声 + 幂等」
**P2**：需求 5 的兼容性矩阵（防止升级潮中口碑翻车）

---

## 诚实说明

本次未能拿到 V2EX、LINUX DO、知乎、B站评论区的完整一手评论（直连阻断），相关条目已全部标🟡；B站评论区内容**搜不到**；`agent-handoff/agent-handoff` **仓库不存在**。因此「多少人提」只在有 GitHub 评论数/参与者数或跨源不同用户名时给出可核实计数，其余用「多源独立出现」表述，未编造具体人数。
