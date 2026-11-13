# dsh-takeover 开发路线 · 2026 Q4

> 2026-11-12 定稿（同日补定：0.2.0 执行现状对齐，见 §一）。基线：**0.1.0**（2026-11-02 发布，327 测试全绿，typecheck + build 干净）。
> 主题：**把 takeover 从「九家读取器 + 收件环」推成「交接大师」——会话、记忆、跨机器三件一起带走。**
> 节奏（与 dsh-hippo 同款）：**每两周一个可演示状态，任何时刻拿得出手。**
> 协议纪律：`handoff: 1` 的正典是 [agent-handoff](https://github.com/IKEASven69/agent-handoff) 仓的 SPEC，本仓是实现与消费方，**不自定义卡片格式**。
>
> **版本纪律（用户 2026-11-12 定）**：0.2.0 = 本路线 Q1–Q4 / M1–M4，**版本号以此为准**。执行中先行落地的「卡同步」并入 Q4（跨机器），「环境备份」撞「不碰配置面」边界、单列待裁决（见 §七），「救生艇」为下版本方向（见 §六·下版本方向）——三者都不另立版本号。

---

## 〇、一句话与边界

**takeover = 把任何 agent 干到一半的活接过来继续干。**

与邻居的边界（经常被混，必须说清）：

| 邻居 | 它管什么 | takeover 不管什么 |
|---|---|---|
| **agent-handoff** | 协议正典：SPEC + 零依赖参考实现 | takeover 不发明格式，只实现与消费 |
| **dsh-hippo** | 记忆的**生产**：会话蒸馏 → 判决 → 编译进 AGENTS.md | takeover 不做蒸馏判决，只做记忆的**搬运**（打包成卡 / 取件吸收） |
| **magpie / ccswitch** | 模型路由、账号切换——管「走哪条路」「换过去」 | takeover 管切换之后最痛的「**带过去**」 |
| **AHP / FerryCat** | 运行时与任务派发（job-queue 语义） | takeover 不做运行时、不派任务，只做交接前蒸馏 + 交接后核验签收 |
| **casr / harness-remote** | 写对方会话存储、依赖对方 CLI 的 resume | takeover **只读拉进当前会话**，不写对方存储、不依赖对方 resume 能力 |

---

## 一、现状基线（0.1.0 实测 + 2026-11-12 执行现状对齐）

### 已交付

| 能力 | 实现 | 状态 |
|---|---|---|
| **九家读取器** | claude / codex / opencode / zcode / pi / workbuddy / cursor / grok / gemini —— `/resume-<agent>` 只读拉取 → 六段卡注入当前轮 | ✅ |
| **协议收件环** | 直接读写 `~/.handoff/{pending,archived}/`，写入即投递、取件即消费 | ✅ |
| **信封机器签名** | 首次 push 生成 `.signing-key.json`；签名面 = 信封全字段 + 卡面 `cardSha256`；取件三态 `ok / tampered / no-key`（跨信任域不误报） | ✅ |
| **单卡忽略** | `dismiss-pending` —— 卡/信封/patch 边车三件原样移入 `archived/`，id 消毒防路径穿越 | ✅ |
| **记忆快照** | `handoff_memory`：`scan` 只读列各 agent 记忆文件（大小/预览）；`push` 勾选打包成卡，取件方按「建议加载」段吸收 | ✅ |
| **接力工作台** | 导航轨 + 四全宽视图（收件箱 / 会话浏览器 / 交接 / 记忆快照）；`--tk-*` 语义 token；DESIGN.md 设计宪法 | ✅ |
| **跨机器·同步盘** | `HANDOFF_HOME` 指向同步盘/junction 即可接力；五条冲突不变量已钉死（同 id 去重不幻影 / 迟到副本可见拒收 / 半截文件不塌 / 链接目录全链 / 消费即弃跨机不重放） | ✅（2026-11-12 契约测试落地） |
| **跨机器·卡同步** | `handoff_sync`：HANDOFF_HOME 即工作树经用户 git 仓库跨机（零存储凭据 / archived tombstone 不重放 / 冲突 abort 诚实报错）；真机双机链路已验（A 寄存→B 取件→收敛） | ✅（并入 Q4，见下） |
| **质量闸** | 344 测试全绿（+17）；构建产物徽标经 esbuild define 注入验证 | ✅ |

> **2026-11-12 执行现状**：上表「跨机器·卡同步」是执行中先行落地、现并入 Q4 的成果；另有「环境备份」（`handoff_env`，全家桶加密备份/恢复）**撞 §〇「不碰配置面」边界**，单列待裁决（见 §七），不计入 0.2.0 核心。

### 四个已知缺口

1. **收件箱二义** —— hippo 另有一套私有收件箱（`~/.hippo/handoff-inbox.json`）+ `handoff-export.ts` 转协议卡，**同一映射存在 2~3 份**（见 hippo `ROADMAP-2026Q4.md` 前置拍板 ③）。
2. **协议采用登记为空** —— agent-handoff README 的采用列表写着「暂无登记」，而 takeover 与 hippo 都已经在读写 `handoff: 1` 卡片。
3. **记忆载荷边界未划清** —— takeover 的 `handoff_memory` 是「文件打包成卡」，hippo 是「蒸馏成记忆条目」，两者互补但**谁负责什么没写下来**。
4. **跨机器未真验** —— ~~`HANDOFF_HOME` 同步盘路径存在，但双端签名、冲突、幂等没有实测记录~~ **→ 2026-11-12 已解决**：同步盘冲突契约 + `handoff_sync` 真机双机链路均已实测（并入 Q4）；剩余仅「归档滚动 50 份上限」一类细项待 M3 收尾。

---

## 二、目标形态：三层分工

「交接大师」不是一个大包，是**三层各归其位**：

| 层 | 归谁 | takeover 在这一层做什么 |
|---|---|---|
| **协议** | `agent-handoff`（SPEC + 参考实现） | 作为**实现方与消费方**；采用登记挂名；不自定义格式 |
| **生产** | `dsh-hippo`（蒸馏/判决/编译）、`agent-memory`（对话检索/跨设备同步） | 接收它们产出的载荷；不重复造记忆系统 |
| **执行** | **takeover** | 九家读取器拉取 → 六段卡蒸馏 → `~/.handoff/` 传输 → 取件核验签收 → 注入续命 |

**为什么不是「把 takeover 和记忆合并成一个包」**：合并等于造第 4 套记忆实现。记忆赛道已有 mem0 / Letta / Zep / Cognee 等成熟方案，dsh 生态内 `dsh-mnemon`、`dsh-auto-memory` 等也在做跨 agent 共享——**takeover 的位置是搬运与传输，不是存储与判决**。存储层交给已有的记忆引擎，takeover 只负责「把它们打包成卡、送到对的机器、让对的 agent 吸收」。

---

## 三、四个待解问题（各带验收标准）

### Q1 · 收件箱二义收敛

**现状**：hippo 侧 `src/hippo/handoff-inbox.ts` 维护私有 JSON 收件箱，`handoff-export.ts` 再把它重写成 `~/.handoff/` 协议卡；takeover 侧直接读写 `~/.handoff/`。一个语义两套实现、三处映射。

**目标**：hippo 的私有收件箱降级为**纯缓存**，读写路径统一走 agent-handoff 参考实现（`packages/core` + `packages/pickup`）；takeover 保持现状但**改为调用参考实现的读写函数**，不再自己解析 frontmatter。

**验收**：
- [ ] takeover 的 `src/` 中不再有自写的 frontmatter 解析，改为 import `@agent-handoff/core`
- [ ] hippo 侧 `handoff-export.ts` 的迷你 YAML 重写被参考实现取代，映射只剩 1 份
- [ ] 双方在同一张卡上往返读写，字节级一致（新增 conformance 用例）
- [ ] `~/.hippo/handoff-inbox.json` 仍可读（向后兼容），但只作为历史数据迁移入口

### Q2 · 协议采用登记

**现状**：agent-handoff README 采用列表为空。

**目标**：takeover 与 hippo 都登记挂名，并把「我们实现了哪些语义」写清楚。

**验收**：
- [ ] [agent-handoff Issues](https://github.com/IKEASven69/agent-handoff/issues) 开登记 issue（项目名 + 链接）
- [ ] takeover README 加一段「协议实现声明」：实现了 SPEC 语义五条中的哪几条、哪几条是生产者义务
- [ ] hippo 同步登记

### Q3 · 记忆载荷边界

**现状**：`handoff_memory` 的 `push` 把 CLAUDE.md / AGENTS.md 等**原文件**打包成卡；hippo 把会话**蒸馏**成带判决的记忆条目。两种载荷形态不同，但卡片的「建议加载」段没有约定区分。

**目标**：在 SPEC 的「建议加载」段（语义 5 · 生产者义务）下，约定两种载荷的标记方式，让取件方知道该「原样吸收」还是「按条目入库」。

**验收**：
- [ ] 卡片 frontmatter 增加 `payload` 字段（`files` | `distilled`），**只加字段不改语义**（符合 SPEC 版本纪律）
- [ ] takeover 的 `handoff_memory push` 写 `payload: files`；hippo 导出写 `payload: distilled`
- [ ] 取件方按 `payload` 分流：`files` → 按路径吸收进目标记忆文件；`distilled` → 交记忆引擎入库
- [ ] 该字段向后兼容：老卡无 `payload` 时按 `files` 处理（默认值）

### Q4 · 跨机器可靠性

**现状**：`HANDOFF_HOME` 同步盘机制在 + 五条冲突不变量已钉死；执行中已先行落地 `handoff_sync`（卡同步，git-native 零存储凭据，archived tombstone 跨机不重放，冲突 abort 诚实报错）并跑通真机双机链路（A 寄存→B 取件→收敛）；签名密钥 `.signing-key.json` 随目录同步 = **密钥同步域 = 信任域**（0.4.4 CHANGELOG 已记）。**本 Q4 的传输层已由卡同步兑现，剩余是收尾与文档。**

**目标**：把「公司机寄存 → 家里机取件」跑成一条有据可查、双向都实测的路径，明确密钥同步边界，并把卡同步正式纳入 Q4 交付。

**验收**：
- [x] 双端实测脚本入库：`tests/sync.spec.ts`（双 home + 裸远端真 git 六场景）+ `tests/sync-conflict.spec.ts`（同步盘五不变量）
- [x] 冲突场景有结论：同 id 去重不幻影 / 迟到副本可见拒收 / 消费即弃跨机不重放（tombstone）——已写进契约测试
- [x] 传输层：`handoff_sync`（setup/now/push/pull/status）真机双机链路验证通过
- [ ] README「跨机器接力」补实测数据与已知限制（同步盘延迟、密钥共享风险、双机先开同步再干活以免密钥分叉 no-key）
- [ ] 归档滚动 50 份上限 + 签名三态在双端链路的端到端复核（M3 收尾项）
- [ ] 「跨机器状态」进工作台（并入 M4 工作台补全）

---

## 四、里程碑（两周一个桩）

| 桩 | 内容 | 交付物 | 硬闸 |
|---|---|---|---|
| **M1**（11-下旬） | **Q2 采用登记 + Q1 部分收敛** | 登记 issue；takeover 改用 `@agent-handoff/core` 读写；conformance 往返用例 | 327 → ≥335 测试全绿；`npm pack --dry-run` 干净 |
| **M2**（12-上旬） | **Q3 记忆载荷边界** | `payload` 字段落地 + 双端分流 + 向后兼容 | 新增载荷分流用例 ≥6；老卡回归不破 |
| **M3**（12-中旬） | **Q4 跨机器收尾**（传输层卡同步已落地） | 归档滚动 50 上限 + 签名三态双端复核 + README 实测数据/限制 + 冲突结论写 SPEC 注记 | 实机跑通一次完整寄存→同步→取件链路（录屏留档） |
| **M4**（12-下旬） | **Q1 收敛完成 + 工作台补全** | hippo 侧映射只剩 1 份；工作台补「跨机器状态」视图（`handoff_sync` 状态） | 全量测试 + typecheck + build 三绿；CHANGELOG 0.2.0 |

> 每桩结束必须**可演示**——哪怕只是一条命令跑通 + 截图，不攒大招。

---

## 五、非目标（v1 不做）

- **不做运行时**：不派步骤、不验结果、不做崩溃恢复（那是 AHP / FerryCat 的地盘）
- **不做路由与切换**：不管模型走哪条路、不管账号怎么换（magpie / ccswitch 的地盘）
- **不做搜索导航**：不做跨会话全文检索（`aisle` / `agent-sessions` 的地盘；AnyFind 已覆盖）
- **不做记忆存储与判决**：不建第 4 套记忆引擎（hippo / agent-memory / dsh-mnemon 等已有）
- **不写对方会话存储**：只读拉取，永不写 claude / codex / opencode 等的原生会话文件

---

## 六、竞争位置（2026-11-12 核，逐项机制对比见 [COMPARISON.md](./COMPARISON.md)）

本节只记**新出现的同类**与**对 takeover 定位有影响的**，不重复 COMPARISON.md 已有条目。

| 项目 | 数据 | 与 takeover 的关系 |
|---|---|---|
| [Nwflower/dsh-chat-import](https://github.com/Nwflower/dsh-chat-import) | 309★，2026-11-12 仍在推 | **单向一次性导入**：把 25+ 家 agent 的对话历史导成可续聊的 dsh 会话。takeover 是**双向持续接力**（读进来 + 寄存出去 + 开局取件），且不依赖对方 CLI 的 resume 能力 |
| [xiajiajun516/dsh-config-manager](https://github.com/xiajiajun516/dsh-config-manager) | 330★ | **配置/插件/MCP/技能/工作区**的备份导出迁移。takeover 不碰配置面，只做会话与记忆载荷——两者可并存，不构成替代 |
| [Totoro-qaq/dsh-plugin-bridge](https://github.com/Totoro-qaq/dsh-plugin-bridge) | 167★ | dsh **内部**跨 Agent Preset 的五段式会话迁移。takeover 跨的是**外部 CLI agent**，且走开放协议卡 |
| [dongsheng123132/task-passport](https://github.com/dongsheng123132/task-passport) | 10★ | 开放任务交接协议，覆盖 DSH / WorkBuddy / Claude Code / Codex。**原则同源**（安全属性长在文件里），但它 pack/land 显式搬运任务状态，takeover 走被动收件箱搬运会话与记忆 |

**takeover 的位置**：九家读取器 + 开放协议卡 + 签名审计 + 记忆载荷打包，四样一起的组合目前未见第二家同时具备。

---

## 七、决策点（需拍板）

| # | 决策 | 影响 |
|---|---|---|
| D1 | **M1 是否把 `@agent-handoff/core` 作为依赖引入**（vs 继续自带解析） | 引入 = 单一真源，但多一个包依赖；不引入 = 二义无法根治 |
| D2 | **`payload` 字段的默认值**（老卡按 `files` 还是按 `distilled`） | 按 `files` 安全（原样吸收不会丢）；按 `distilled` 会把原文件当记忆条目处理，风险更高 |
| D3 | **密钥同步策略**：`.signing-key.json` 放同步盘（现状）vs 各机独立生成 | 同步盘 = 跨机免配置但信任域变大；独立 = 更安全但取件方 `no-key` 概率上升 |
| D4 | **M4 的工作台「跨机器状态」视图**是否进 0.2.0 | 进 = 演示性强；不进 = 0.2.0 只做协议收敛，范围更可控 |
| **D5** | **已裁决：配置轴由 takeover 承担（备份/恢复/迁移入卡），保留** | 2026-11-14 裁决：不交 config-manager、不砍。`handoff_env` 保留并转正——`action=card` 把最近一次备份的清单（files[{path,sha256,category}] + backupFile + bytes）写成 axis='config' 载荷卡（writeCard + 信封签名全套纪律），密文 blob 仍在 env-backup/ 随同步盘走，卡只带清单+指针、口令永不进卡；备份/恢复/迁移由此并入配置轴职责，§〇「不碰配置面」措辞按此修订 |

---

## 八、风险

1. **协议演进风险**：`handoff: 1` 纪律是「只加字段不改语义」，`payload` 属于新增字段，符合纪律；但若 SPEC 后续对 frontmatter 收紧，需要跟着改——**改前必读 SPEC 版本节**。
2. **依赖收敛的回归面**：Q1 把 frontmatter 解析换成参考实现，会动到 327 个测试覆盖的路径。**必须 conformance 往返用例先行**（原型先行），再动实现。
3. **双端同步的时序**：同步盘有延迟，`pending/` 里可能短暂出现半写文件。取件侧需容忍（SPEC 语义 3 的宽松模式已覆盖，但要实测确认）。
4. **与 hippo 的排期耦合**：Q1、Q2 都需要 hippo 侧配合。若 hippo 那边排期延后，takeover 侧的 M1 可以先做「改用参考实现」这半边，登记 issue 不阻塞。

---

## 九、下版本方向（0.3.0 候选）：救生艇 —— 上下文炸了换机接着开发

> **来源（真实需求）**：用户 2026-11-12 亲历——会话上下文出问题（降级/满了/卡死），被迫换台台式机继续项目的开发。这是**热需求**（会话当场失效、不换机干不下去），比 config-manager/FerryCat 的冷需求「搬环境」更硬，是「会话+跨机器带走」主题的最强验证。
>
> **架构已正对，缺口明确**：`pushHandoff` 六段确定性兜底零模型依赖（`src/collect.ts`/`src/tools.ts`），`admitTakeover` 的 `deps.sessions.get` 能拿 session 对象（`src/server.ts:221`）——「无模型旁路抢救」架构上可行。

**四个 HIGH 缺口 → 方向**：

| # | 缺口 | 方向 |
|---|---|---|
| 1 | **无救生艇**：上下文炸了模型吐不出工具调用，所有抓取入口都经模型回合，救不走 | `POST /dsh-takeover/lifeboat`：`sessions.get` 取 session → 无模型直接 `pushHandoff` → 落卡 + `syncNow`；设置卡「🛟 救生艇」一键按钮；事前 contextHealth 预警（事件条数代理） |
| 2 | **卡缺 repo 基线**：不记 remote+HEAD，新机器不知去哪 clone/checkout | `pushHandoff` 补抓 remote URL + HEAD sha → `extras.baseline`；恢复侧给 clone/checkout/apply/test 指引 |
| 3 | **untracked 新文件内容不旅行**：长会话新建没 `git add` 的文件换机直接丢 | 小 untracked 文件（<64KB）内容并进补丁边车（过 secretscan），大件列清单+提示 |
| 4 | **补丁 512KB 整份拒带**：最需要带走的时刻（大量未提交改动）反而带不走 | 补丁边车 gzip 压缩突破上限，超限拆 `.patch.N` 分块，不再整份丢 |

**恢复侧「接得顺」**：结构化 `nextCommand`（clone/checkout/apply/test）+ 跨机路径映射提示。

**边界（诚实）**：项目源码本体的 clone/push 是用户自己项目仓的事，只带「基线指针+补丁」不替用户管项目仓；host 无 token API，用事件条数代理并如实标注。

---

## 附：相关文档

- 协议正典：[agent-handoff SPEC](https://github.com/IKEASven69/agent-handoff/blob/main/SPEC.md)
- 逐项竞品机制对比：[docs/COMPARISON.md](./COMPARISON.md)
- 设计宪法（改 UI 前必读）：[../DESIGN.md](../DESIGN.md)
- 威胁模型：[../THREAT-MODEL.md](../THREAT-MODEL.md)
- hippo 侧对应路线：`dsh-hippo/docs/ROADMAP-2026Q4.md`（前置拍板 ①③ 与本文 Q1/Q2 直接对应）
