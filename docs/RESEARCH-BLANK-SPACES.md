# DSH 插件生态空白方向调研

> 2026-11-22。方法：GitHub REST/GraphQL API 抓 Discussions、Releases API、`gh search repos`、websearch。
> 用途：用户问「其他项目有没有值得继续开发的空白方向」时的候选池；本文是调研结论，不是待办清单。

## 〇、方法论关键校正

**主仓 Ideas 区的 upvote 几乎全是作者自己的 1 票**（本次扫的 300+ 帖里最高才 6 票）。所以「多人 +1」信号在此生态**不成立**。

**真正的强信号是「同一诉求被多个独立帖反复提出」，且帖子带源码行号、实测数字、复现步骤。** 本文以此为准。

---

## 一、需求信号清单（一手帖 + 摘录 + 重复次数）

### 信号 1：插件依赖漂移 / 版本兼容 / 启动静默失败 —— 重复 20+ 帖（最强重复信号）

| 帖 | 摘录（原文） |
|---|---|
| [#12213](https://github.com/deepseek-ai/deepseek-harness/discussions/12213) | "The plugin compatibility gate **proves declarations, not compatibility** … The gate's verdict and the audit's verdict disagreed in three out of four interesting cases." |
| [#13798](https://github.com/deepseek-ai/deepseek-harness/discussions/13798) | "Official bridge packages pin host peers to exact versions, so hooks silently die after every DSH upgrade" |
| [#14077](https://github.com/deepseek-ai/deepseek-harness/discussions/14077) | "[Bug] Agent Teams 实验包 peer 写死 rc.1，官方无 rc.5 版本导致 profile 组合检查失败" |
| [#13253](https://github.com/deepseek-ai/deepseek-harness/discussions/13253) | "`dsh-error` is only a peer and never a dependency — every shell tool dies with 'Windows Job runner exited with exit code 1'" |
| [#13093](https://github.com/deepseek-ai/deepseek-harness/discussions/13093) | "a profile-shadowed dependency silently disables core workspace services (UI shows no sessions)" |
| [#11149](https://github.com/deepseek-ai/deepseek-harness/discussions/11149) | "there is no compatibility-aware way to see or repair a profile's plugin versions" |
| [#13765](https://github.com/deepseek-ai/deepseek-harness/discussions/13765) | "Should DeepSeek Harness adopt a **unified reliability strategy for external dependencies**?" |

同簇还有 #12516、#12210、#13109、#13081、#13003、#13901、#12378、#11012、#9411、#10849、#9907、#7177、#9194、#10751、#5869、#1800。

**事实**：需求极真；**但拥挤度也高**——`dsh-purge` 11553★（活跃，含宿主兼容/状态诊断）、`dsh-plugin-guard` 43★、`dsh-compat-vet` 0★（9/30 后停更）。**推测**：不宜单独立项，应把「槽位冲突」这一支拆出来做（见信号 3）。

### 信号 2：workspace-changes 快照 / 临时目录磁盘失控 —— 重复 8+ 帖，数字极端

| 帖 | 一手实测摘录 |
|---|---|
| [#14084](https://github.com/deepseek-ai/deepseek-harness/discussions/14084) | "TEMP … grew to **64.5 GB in one day** … 85 `tmp_obj_*` files totaling **57.51 GB**"（2026-11-22，最新帖） |
| [#11825](https://github.com/deepseek-ai/deepseek-harness/discussions/11825) | "两次将 **926 GB** 系统盘可用空间降至 **<1 GB**；单个快照目录 150 GB" |
| [#10336](https://github.com/deepseek-ai/deepseek-harness/discussions/10336) | "**60.45 GB across 131 orphan directories / 302,971 files**" |
| [#10870](https://github.com/deepseek-ai/deepseek-harness/discussions/10870) | "80 分钟 **103 个 / 25.79 GB**，256 GB 系统盘被写到 0 字节可用" |
| [#11904](https://github.com/deepseek-ai/deepseek-harness/discussions/11904) / [#11496](https://github.com/deepseek-ai/deepseek-harness/discussions/11496) | "leaves GB-scale snapshot directories … after unclean exits" / "massive disk consumption and orphan residue leaks" |

同簇还有 #13155、#13245、#11275、#10601、#12992、#13797。**重要反面证据**：#13155 明确写"第二条已附 PR"（作者已向上游提交修复，10 文件+测试）。**推测**：窗口正在关闭，需先验证上游是否已合并。

### 信号 3：插槽 / 组合包冲突 / 插件「静默不挂载」 —— 重复 18+ 帖，但无强占位者

| 帖 | 摘录 |
|---|---|
| [#13681](https://github.com/deepseek-ai/deepseek-harness/discussions/13681) | "voice-call 与官方 voice-input **争用 single 插槽** … 当前 `DshBundleManifest` 没有插件互斥声明" |
| [#12571](https://github.com/deepseek-ai/deepseek-harness/discussions/12571) | "`conversation.input.model.label` 建议由 single 改为 list：多连接器插件共存时该槽位会导致功能静默丢失" |
| [#13896](https://github.com/deepseek-ai/deepseek-harness/discussions/13896) | "插件注册 `settings.plugins.tab` 被**静默丢弃**" |
| [#9853](https://github.com/deepseek-ai/deepseek-harness/discussions/9853) | "Duplicate conversation tabs when multiple plugins register list slots … undeduped ledger render" |
| [#11026](https://github.com/deepseek-ai/deepseek-harness/discussions/11026) | "registers **duplicate factory** for ui-sidebar-documentpreview" |
| [#12665](https://github.com/deepseek-ai/deepseek-harness/discussions/12665) | "Right sidebar becomes unreachable when a rightbar Slot entry is **abdicated after a render crash**" |
| [#10398](https://github.com/deepseek-ai/deepseek-harness/discussions/10398) | "建议：为插件生态补充**细粒度语义 Slot**（消息级 / tool 级 / 输入区状态 / 面板工具栏）" |

同簇还有 #12289、#11244、#13552、#14030、#13988、#13883、#14014、#13927、#13544、#12148、#12391、#11996、#10912、#12141、#9834、#9326、#10516。

**拥挤度事实**：已有 `dsh-slot-explorer`、`dsh-slot-inspector`(1★)、`dsh-slots-manager`、`dsh-slot-manager` —— 但**全部 0–1★，且都只做「可视化/排序」，没有一个是「冲突检测 + 挂载失败归因」**。`gh search repos "slot conflict" --topic dsh-plugin` 返回空。

### 信号 4：输入队列 / turn 中断 / ask_user_question —— 重复 10+ 帖，但已有大量小插件

| 帖 | 摘录 |
|---|---|
| [#13953](https://github.com/deepseek-ai/deepseek-harness/discussions/13953) | "User message sent while a turn is blocked on `ask_user_question` is **silently dropped** … 该消息从未显示、从未执行、没有任何报错"，附 `session.v4.jsonl.zstd` 事件级证据 |
| [#13932](https://github.com/deepseek-ai/deepseek-harness/discussions/13932) | "public API to settle/cancel an in-flight user question" |
| [#13825](https://github.com/deepseek-ai/deepseek-harness/discussions/13825) | "Hold and release pending input across a turn boundary" |
| [#14022](https://github.com/deepseek-ai/deepseek-harness/discussions/14022) | "host-side hook to refuse a user prompt before `agent/inbox/spliced` records it" |
| [#13426](https://github.com/deepseek-ai/deepseek-harness/discussions/13426) | "a commit from one session contained files from another session's in-progress work" |

**拥挤度已高**：`dsh-auto-continue` 207★、`dsh-turn-rewind` 151★、`dsh-pause` 29★、`dsh-steer`/`dsh-steer-note`/`dsh-steering`、`dsh-fork-inbox-guard`、`dsh-branch-inbox-guard`。**判定：泛化方向不算空白**，仅窄路（方向 C）可考虑。

### 信号 5：共享会话 / 调用者身份 / 远程鉴权 —— 新出现，官方刚跟进

| 帖 | 摘录 |
|---|---|
| [#14023](https://github.com/deepseek-ai/deepseek-harness/discussions/14023) | "several authenticated people prompt the same Session, and each person may see and do different things (one can use the shell, another may only chat)"；需求是"which person's input caused it" |
| [#13820](https://github.com/deepseek-ai/deepseek-harness/discussions/13820) | "open a specific session from a `dsh://open?session=` deep link"（2 票 / 5 评论） |
| [#13402](https://github.com/deepseek-ai/deepseek-harness/discussions/13402) | "跨对话任务协作做成官方能力（对标 Codex）"，实测 `@ryuu-64/dsh-session-tools` 可用但有 4 个缺口 |

### 信号 6：工作区级作用域 —— 重复 9+ 帖，但全是 0–6★ 小插件

[#13943](https://github.com/deepseek-ai/deepseek-harness/discussions/13943)（2 票）"让插件只在某个工作区生效"；[#13149](https://github.com/deepseek-ai/deepseek-harness/discussions/13149) 项目级 MCP；[#13107](https://github.com/deepseek-ai/deepseek-harness/discussions/13107) 工作区级密钥；[#13763](https://github.com/deepseek-ai/deepseek-harness/discussions/13763) 隔离 Profile。现有 `dsh-workspace-scope`(6★/0★两个仓)、`dsh-mcp-workspace-scope`(2★) 等**均无赢家**。

### 中文社区核查（如实说明）

LINUX DO 搜索基本未命中 DSH 具体抱怨；V2EX 抓到相关但零散：[记一次 DeepSeek harness 吞对话的解决过程](https://hk.v2ex.com/t/1238749)、[deepseek-acp 把 DSH 接成编码智能体](https://cn.v2ex.com/t/1237353)、[dsh 官方消息汇总](https://v2ex.com/t/1234209)（提到插件冲突/回滚）、[备份同步插件分享](https://v2ex.com/t/1252005)。**结论：中文社区一手抱怨与官方 Discussions 的重复簇一致，没有额外新方向；主要证据仍来自主仓。**

---

## 二、新扩展点带来的缝隙

查 Releases API（**事实：截至 2026-11-22 没有 0.3，最新是 `dsh-v0.2.3-alpha.2`**，发布于 2026-11-22 11:00 UTC）。

**v0.2.3-alpha.1 真正的新扩展点：**

1. 代码审阅扩展机制：插件可添加审阅视图、行注解，并在工具栏/文件菜单/评论框加入自定义操作；支持 GitLab 评审合并。
2. 标准化连接鉴权 API 供插件注册（Web 远程登录/设备配对）。
3. 连接器账号统一管理 + MCP OAuth/凭据自动刷新。
4. 会话状态区域（工作目录/变更请求/子智能体/任务/插件状态，可停靠、拖动排序）。
5. 实验性时间线插件（任务树、阻塞、进展报告）。
6. 插件市场支持 Git 仓库源（含私有仓）。
7. 变更：Cordis 升到 4.0.0-rc.12；会话状态迁到 `dsh-client-ui-session-status`（读取方需在 inject 声明）；客户端 CSS Modules 类名格式变化；`fileAddressFor` 改相对地址；输入框行内提示；**可选 MCP 工具按需加载**；实验性 SQLite 会话后端；Web 跨会话消息工具（默认关闭）。

**较早扩展点**：v0.2.2-rc.1 统一右键/键盘菜单支持开发者扩展 + 完整历史会话复制为 Markdown；v0.2.2-rc.2 Git Worktree 按分支/提交/文件类型审阅；v0.2.1-rc.1 插件 Session 状态记录接口、自定义插件索引源。

**缝隙判断（推测）**：
- 今日刚落地的「代码审阅扩展」和「连接鉴权 API」是**真正的先发窗口**——别人还没来得及做。
- 但 v0.2.3 自带「MCP 按需加载」直接**判死**了此前社区的两个懒加载插件方向；自带「压缩摘要右侧栏预览 + SQLite 后端」也在吃掉会话存储/压缩方向。
- 每次升级都在制造新的「静默不挂载」（inject 声明、CSS 类名、相对地址、Cordis API 变更）→ **信号 3 的「挂载归因」需求会随版本持续再生**，这是它比一次性修复更有护城河的原因。

---

## 三、候选空白方向（五维评估）

评分 1–5，基于上文证据的**主观评估**（事实与推测已分开标注）。

### 方向 A：插件「插槽冲突 + 挂载失败归因」诊断器（Slot/Mount Doctor）★推荐

- **做什么**：扫描 profile bundle 清单与各插件的 `mount.ts`/cordis 声明，生成全量槽位占用表；检测 single 槽重复占用、list 槽重复 factory、被 abdicate 的槽、声明了但没进 client composition 的槽（如 `settings.plugins.tab`）；输出「为什么你的插件没出现」的证据报告 + 可复跑命令。
- **为谁**：数万名 DSH 插件作者 + 装了 30+ 插件的重度用户。
- **为什么现在是机会**：18+ 独立帖；现有 4 个 slot 工具全部 0–1★且只做可视化；0.2.3 升级又新增一批挂载破坏点。
- **五维**：需求 **5** / 拥挤度 **4**（低拥挤）/ 可行性 **5** / 协同 **5**（archmap 的源码解析+四层追溯+证据复跑几乎可直接复用）/ 采用量 **4**。
- **风险（推测）**：部分诉求需宿主加 API（互斥声明字段），插件只能做检测不能做自动仲裁；需持续跟版本解析规则。

### 方向 B：workspace-changes 磁盘生命周期护栏 ★推荐（带前置验证）

- **做什么**：实时监控 TEMP/TMPDIR 下 `dsh-workspace-changes-*` 目录，按容量/TTL/孤儿规则隔离清理；识别 NTFS junction、git-annex、模型大文件；给出「哪个会话哪一轮哪个文件吃掉了磁盘」的归因。
- **为谁**：Windows/macOS 上在大 git 工作区（ComfyUI、模型权重、数据集）干活的用户。
- **为什么现在是机会**：一手数字最触目惊心（64.5GB/天、926GB→<1GB、60GB 孤儿），现有 `dsh-storage`(1★)/`dsh-storage-monitor`(2★) 只是看板。
- **五维**：需求 **5** / 拥挤度 **3** / 可行性 **4** / 协同 **2** / 采用量 **4**。
- **风险（事实）**：#13155 已向上游提 PR；**必须先确认是否已合并**再决定投入。

### 方向 C：共享会话的「署名输入 + 收件箱排空 + 回执」层（复用 takeover）

- **做什么**：在 0.2.3 新连接鉴权 API 上，给多人共用 Session 补 caller 身份标注、caller 级工具权限、调用归因、inbox drain 与回执。
- **为谁**：团队 Host 插件开发者（#14023 的 automagik 是真实案例）、跨机协作用户。
- **五维**：需求 **4** / 拥挤度 **3** / 可行性 **3**（依赖新 API 稳定性）/ 协同 **5**（直接复用 takeover 的 handoff 协议与身份资产）/ 采用量 **3**。
- **判定**：更像 **takeover 的升级路线**，不算全新项目；官方 0.2.3 已开始做跨会话消息工具，需防撞位。

### 方向 D：代码审阅扩展点上的「证据化审查视图」（复用 archmap）

- **做什么**：用新审阅扩展机制做「变更 → 代码结构影响 → 证据 → 复跑」的审查视图，把 archmap 的四层追溯带进 PR 审阅流。
- **五维**：需求 **3** / 拥挤度 **3**（dsh-redline、dsh-cordis-review、dsh-codex-review、Task Pulse 已存在）/ 可行性 **4** / 协同 **5** / 采用量 **3**。
- **判定**：先发窗口真实，但拥挤会很快上来；适合作为 archmap 的**第二分发渠道**而非独立新项目。

### 方向 E：profile 依赖「行为级」预检（需求最大，但建议并入 A）

20+ 帖支撑，需求真实性 **5**；但 `dsh-purge` 11553★ 已覆盖宿主兼容/诊断，拥挤度仅 **2**，协同 **2**。**不建议单独立项**；把「shadowed dep + single 槽冲突」这一窄支并入方向 A。

---

## 四、最终推荐

### Top 1：方向 A —— 插件插槽冲突 / 挂载失败归因诊断器

**理由**：唯一同时满足「一手证据密集（18+ 帖）」「无强占位者（现有工具全 0–1★）」「有工程深度（需建模 slot 解析 + 静态分析）」「能复用用户资产（archmap）」「有天然分发渠道（在 Discussions 回答挂载问题）」的方向。需求会随每个版本再生，护城河是版本规则库+归因证据集，不是一次性补丁。

**第一步验证动作（3–7 天，不写完整产品）**：
1. 最小 CLI：输入 profile 目录 → 输出槽位占用表 + single 槽冲突清单。
2. 拿它去 #13681、#13896、#9853、#11026、#12571 五个帖下各回一条带实测输出的评论。
3. 判定标准：**≥2 个帖的提问者/其他用户回复「这正是我遇到的」或主动来装**，才立项；否则收窄到「single 槽冲突」单点。

### Top 2：方向 B —— workspace-changes 磁盘护栏（前置门槛：先查上游 PR）

1. 查 [#13155 附的 PR](https://github.com/chenxixian/deepseek-harness/pull/3) 是否已合并进 0.2.3；若已合并，转向「跨版本孤儿目录清理 + 容量告警」这一上游不会做的运维层。
2. 在 #14084 / #11825 / #10336 下贴一个针对其目录结构的实测清理报告，看是否有人跟帖要工具。

---

## 五、明确不建议的方向（红海 / 已死）

| 方向 | 事实依据 |
|---|---|
| 记忆引擎 | 313+ 插件、dsh-mnemon 979★；0.2.3 还在加记忆类实验插件 |
| 多机面板 / fleet | GitHub 11+ 同名仓、npm 9+ 包；dsh-passwords 96★、dsh-full-remote 52★ |
| 交接卡 UI / 会话压缩续接 | dshfind #handoff 38 款；0.2.3 自带压缩摘要右栏预览 + 实验 SQLite 后端 + live-compact 337★ |
| 插件市场 / 目录 | dsh-market 官方周下载 27 万；十几个目录站 |
| MCP 懒加载 | 社区已有 dsh-mcp-summon/dsh-mcp-lazy（#13332 点名），且 0.2.3 官方新增可选按需加载模式 |
| 破坏性操作护栏 / 权限规则 | cc-safety-net 2091★、dsh-permission-rules 141★、dsh-auto-mode 161★、dsh-plugin-guard 43★、agent-guard 25★、dsh-passwords 96★、dsh-secure-audit 86★ |
| 成本 / 计费统计 | dsh-cost-meter 745★、dsh-ui-usage-billing 110★、dsh-session-cost 20★ |
| 会话管理 / 备份 / 迁移 / 存储看板 | dsh-purge 11553★、dsh-config-manager 374★、dsh-session-manager 135★、dsh-backup 47★ |
| 泛化 turn 中断 / steer / inbox | dsh-auto-continue 207★、dsh-turn-rewind 151★、dsh-pause 29★；只有方向 C 的身份化窄路例外 |
| 桌面窗口持久化 / 托盘 / 移动端 | 重复帖极多但全是宿主功能，官方在逐版修；插件做不了 |
| 跨 agent 搜索 | 用户已否（Obelisk 969★ 吃掉） |

---

## 可信度声明

所有帖号、标题、摘录、release 内容、仓库 star 数均来自实际 API 调用；「为什么现在是机会」「拥挤度评分」「护城河判断」为基于证据的推测，已标注。中文社区部分命中有限，未找到能支撑新方向的一手抱怨，已如实说明。
