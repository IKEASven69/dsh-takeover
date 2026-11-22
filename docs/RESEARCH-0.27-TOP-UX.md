# 顶级用户体验调研：可迁移到 DSH 会话接管（dsh-takeover 0.26.0）的设计思想与机制

> 调研时间：2026-11-22。方法：实际 websearch/webfetch + 本地源码核验（`src/client.ts` 行号已逐条核对）。
> 事实与推测已显式标注：带「【事实】」的是有来源/源码支撑；带「【推测】」的是基于设计的推论，需你自行验证。
> 目标不是「列功能」，而是回答：顶级产品**为什么好用**，以及**怎么把思想变成我们的**。

---

## ① 每个顶级产品的体验机制拆解

### 1. Session Watcher（nomadop）—— 把「上下文焦虑」变成一个可决策的时点

来源：
- https://github.com/nomadop/session-watcher
- https://github.com/deepseek-ai/deepseek-harness/discussions/13863（作者中文详述）
- https://glama.ai/mcp/servers/nomadop/session-watcher
- 论文：https://doi.org/10.5281/zenodo.21236704

**① 核心体验主张（一句话）**：长会话的每次调用都在为背着的全部上下文「付租金」；实时算出**租金何时超过重启成本**，并在那一刻让你用**一条命令原地交接**——只带走下一个任务真正需要的东西。

**② 用户能感知的具体机制**
- **输入框下的 dock（状态灯 + 账单溢价读数 + 提醒时钟）**：绿灯安心干活，变色再看；零打扰、纯观测。【事实】
- **择时不是看占用率**：用 EOQ（经济订货批量）库存模型，把 prompt cache 当库存；给出位置 `u`、账单溢价 `br`、可移动成本上界 41.4%（论文在 1,016 份真实会话上测量）。左臂（尚未到甜点）灯白/绿，越过甜点才告警。【事实】
- **分桶表 + 实时曲线预览**：哪些文件/skill/工具各占多少 token；勾选/取消任意一项，U 型曲线实时预览「如果只带这些重启我会落在哪」。【事实】
- **一条命令的交接闭环**：`sw-handoff` skill 挑文件与 skill、写摘要与下一步 → `/sw-continue` 原地清空并加载交接，agent 一句话说明接着做什么，然后继续。不用新开会话、不用复制粘贴。【事实】
- **清空 ≠ 失忆**：每轮留在 lineage，可翻页/搜索回查原文；保留的文件按磁盘当前内容重读，不是过期摘要转述。【事实】
- **零上下文污染**：MCP 工具只返回 URL，不把指标数字/会话内容塞回模型上下文；状态纯本地 `~/.session-watcher`，无遥测。【事实】

**③ 为什么让人觉得「顶级」**
- **把模糊焦虑变成单一决策变量**：「快满了」是错误问题（30% 可能已在亏钱，80% 可能还值得继续）；灯色让人**不用理解模型也能做对决策**——这是「把复杂计算封装成一个颜色」的典范。【事实 + 推测：心理学上的「认知卸载」】
- **可信度来自可解释**：给的是账单溢价、位置、分桶，不是拍脑袋的百分比；用户能核对依据。【事实】
- **动作与原地把点一致**：dock 就地显示就地执行，视线不离开输入框。【推测：菲茨定律 + 减少上下文切换】

**④ 迁移到 takeover**
- 我们现在有预警条（`client.ts:3429-3442`，warn/critical、`ctxHealth.basis` + triggers）——**已有「状态可见」骨架**。差距在「择时质量」与「原地动作」：预警条当前的 basis 概念可借鉴 SW 的「为什么现在该交接」，而不是只报占用百分比。
- 在预警条里增加「分桶预览」思想：可点开看到「会话 / 未提交代码 / 记忆 / 环境」四轴各占多少、带走哪几项，勾选后预览交接后的状态。【推测：需服务端支持 basis 明细】
- 把 `/sw-continue` 的「原地续接」思想映射到 ComposerChip：接力后不新开界面、一句「接着做什么」就地续上。【事实：takeover 的 `onboard2`「点接管，新会话自动接着跑」已是这个思想的雏形，`src/client.ts:2413`】

---

### 2. dsh-compact-relay（cfanzx）—— 把不可逆操作变成「预览-确认-可回查」

来源：
- https://github.com/cfanzx/dsh-compact-relay
- https://dshmp.com/en/plugins/dsh-compact-relay
- https://dshcrate.com/p/cfanzx/dsh-compact-relay
- https://blog.yeyupiaoling.cn/article/1792633533784

**① 核心体验主张**：把上下文占用、压缩判断、交接阈值收进输入框旁一枚 28px 环；**任何会改写历史的操作都必须先预览、经确认才做**。

**② 机制**
- **28px 环分段显色**：灰（低于最小线）/蓝（常规满，可手动压）/琥珀带缺口（建议压缩点）/红（交接阈值）；越过原生自动压缩线整环红色闪烁；交接提醒线晚于实际触发线时环上出现红色小警示，悬停卡与菜单同步标「交接线已晚」。【事实】
- **悬浮即解释**：悬停看已用容量、压缩次数、当前建议、判断点、原生自动压缩线。【事实】
- **预览-确认压缩 `/bc`**：先看待压缩范围、条数、预计释放容量；二次确认才执行；确认前可随时取消，未提交不改历史。确认卡还列「本段 N 条·已收藏 M 条·建议补 K 条」，是压缩前最后一次补救机会。【事实】
- **收藏两步走 + 推荐收藏**：点星只写一行标记，原文只在压缩时落档；小模型异步打分，够档位星标金色微亮并带「推荐」——**只点亮、绝不自动收藏**，确认仍要你点。【事实】
- **接力条 + 双向跳转**：交接后输入卡上方出现「已接力自 历史 N」，点开看完整交接链；父侧变「已交接给新会话」，「去新会话」一键切回；按需读取（不展开不发请求）；最多 8 层、成环自动停、读不到保留已读行 + 诚实报错。【事实】
- **长动作异步化**：`/handoff` 起后台任务立即返回 id，客户端轮询显示「已 Ns」并可取消；确认面板明确写「会停止正在跑的任务、中断后无法恢复」。【事实】

**③ 为什么顶级**
- **可逆性设计**：破坏性动作一律先预览后确认，把「不可逆」变「可反悔」。【推测：控制感 = 满意度核心来源】
- **诚实反馈**：读不到就说读不到、不给假成功；「暂无交接单」而不是猜一个。【事实】
- **信息按需加载**：完整交接链点开才读，普通会话零额外请求——速度与克制的统一。【事实】

**④ 迁移到 takeover**
- 我们的「交接出去」流程可加**预览-确认**层：点交接先展示「会话 / 未提交代码 / 记忆 / 环境」四轴将打包什么、目标 agent、是否归档源，确认后才执行。
- 接力条思想 → ComposerChip 浮层（`src/client.ts:3728-3739`）可增加「本卡来自哪个会话 / 已交接给谁」的双向跳转，父侧与子侧互跳。
- 收件箱的「已归档卡历史」块（源码 `history` / `archived/`，`src/client.ts:535,538-545`）与 relay 的交接链同构：可强化「按需读取 + 读不到诚实标注 + 成环停」。

---

### 3. dsh-mobile / dsh-carry —— 零配置配对 + 网关代持登录态 + 完成/待批准推送

来源：
- https://github.com/kinocode-jp/dsh-mobile（blog 解读：https://blog.yeyupiaoling.cn/article/1792680156404）
- https://github.com/agent-mobile/dsh-mobile-gateway
- https://github.com/saya-ch/dsh-mobile
- https://github.com/dshapp/dsh-mobile-bridge（讨论：https://github.com/deepseek-ai/deepseek-harness/discussions/10995）
- https://blog.yeyupiaoling.cn/article/1791775234039（任务完成推送）

**① 核心体验主张**：人离开电脑，任务不卡——扫码一次配对，手机上就是**同一台电脑的同一批会话**，审批与追问推进通知栏，回来接着干。

**② 机制**
- **扫码直连**：侧栏扫码或复制链接配对；配对码**一次性、5 分钟过期**；设备可逐台移除、立即撤销访问。【事实】
- **网关代持登录态**：手机不持有 DSH 自身登录态，网关直接登录本机 webserver，给最长 12 小时会话；手机只拿到受限网关会话。【事实】
- **推送的是「需要你」的时刻**：任务完成一轮、等待审批/追问时推通知；任意设备先答生效，各端提示一起关闭；默认推送不含会话正文、锁屏脱敏。【事实】
- **诚实列限制**：iOS 后台提醒可能迟到、中转能看到明文、默认不鉴权——把边界写清楚。【事实】

**③ 为什么顶级**
- **零配置起步**：扫一次码，无需公网 IP/端口映射/VPN；「第一次就能用」优先于「功能全」。【事实】
- **把人从轮询里解放**：只在「需要你」时打断，其余时间沉默——**通知的价值在于精准，不在于多**。【推测：注意力尊重】
- **最小权限原则可被用户理解**：代持登录态而不是交出登录态，降低用户的安全焦虑。【事实】

**④ 迁移到 takeover**
- 我们的核心场景是「一张卡跨机器带走」→ 可借鉴「扫码直连」：收件箱/交接视图里给「扫码把卡带到这台机器」入口，一次性码 + 短过期。
- 「待批准推送」思想 → 预警条在 critical 时可提示「有卡等待接管/批准」，但只在真正需要人时打断（对应我们的 `ctxHealth.level === 'critical'` 才出救生艇按钮，`src/client.ts:3442`）。
- 「代持登录态」思想 → 跨机器接管时明确告诉用户「你没在这台机器上登录，环境由网关代持」，减少信任疑虑。【推测：需在文档/设置卡说明】

---

### 4. Linear —— 「一种好方式」胜过「一百种可能」

来源：
- https://linear.app/now/behind-the-latest-design-refresh（2026 刷新：don't compete for attention / structure felt not seen）
- https://linear.app/now/how-we-redesigned-the-linear-ui（2024 重设计）
- https://gunpowderlabs.com/2024/12/22/linear-delightful-patterns
- https://interfacelineage.com/linear-keyboard-first-multiplayer
- https://performance.dev/how-is-linear-so-fast-a-technical-breakdown
- https://merge.rocks/blog/ux-best-practices-weve-learned-from-productivity-apps-like-notion

**① 核心体验主张**：速度就是产品；通过**克制的约定**（一种好方式）而不是无尽的选项，让专业用户更快、让新手不被劝退。官方原话："We design it so that there's one really good way of doing things."

**② 机制**
- **Cmd+K 命令面板是「前门」**：所有动作都在本地内存对象池里模糊搜索、即时执行；**上下文化**——在看 cycles 时优先显示 cycle 相关命令；还能在调用位置附近弹出「几乎像下拉菜单」。【事实】
- **键盘语法**：单字母编辑当前 issue（`S` 状态、`A` 负责人），两键序列导航（`G I`、`O C`），修饰键全局；有个 `?` 全局速查表；鼠标用户也能看到菜单旁标注的快捷键。【事实】
- **信息密度做对**：13px 正文 / 4px 网格 / 32-36px 行高；用符号和图标替代文字标签；hover/选中才显细节；渐进披露。【事实】
- **视觉降噪**：侧栏调暗、tab 收窄、减少图标与分隔线、LCH 均匀色彩系统、单强调色——「结构应被感觉而非看见」。【事实】
- **本地优先同步引擎**：工作区在客户端，delta 流式同步，50 条更新 = 50 个单元格重绘而非整列表重绘。【事实】
- **模型短语一致**：projects / teams / issues / milestones 都是通用词，降低认知负荷本身就是速度。【事实】

**③ 为什么顶级**
- **一个入口承载全部**：命令面板不常驻、不占地方；用户「知道名字就能做」，不用记菜单位置——把空间记忆负担转成语义记忆。【推测：认知心理学】
- **密度服务于留存**：常驻用户一屏看更多状态、少切换上下文；且密度与 cramped 不同——小字必须光学居中对齐（「feel rather than notice」）。【事实】
- **不发明术语**降低上手门槛。【事实】

**④ 迁移到 takeover**
- 我们已有 `Cmd/Ctrl+K` 与 `/`（`onRootKeyDown`，`src/client.ts:3121-3130`）——**骨架对**。差距是「命令面板承载全部动作」：让 Cmd+K 不止聚焦过滤框，而是提供上下文化的动作清单（接管本卡 / 交接出去 / 记忆快照 / 导出 / 切换视图），并在每项旁显示快捷键。
- 单字母/两键语法可渐进加入：`G I` 收件箱、`G B` 会话浏览器、`G H` 交接、`G M` 记忆、`G ?` 指南——对应五视图；`?` 打开速查（我们 guide 视图已有雏形，`src/client.ts:3719-3722`）。
- 817 卡行的信息密度：借鉴「符号替代文字、hover 显细节」，保持一屏多卡但别堆所有元数据；用 `--tk-mut/--tk-dim`（源码 token）压低辅助信息对比度。
- 视觉降噪原则可直接套 `--tk-*` token：侧栏 `--tk-rail` 已比 `--tk-surface` 暗，符合「工作区优先」。

---

### 5. Raycast —— 两个键承载 2,500 个扩展

来源：
- https://www.raycast.com/blog/a-fresh-look-and-feel（三原则 fast/simple/delightful；action bar；compact mode）
- https://www.raycast.com/blog/how-raycast-api-extensions-work（80/20：常用动作进 Raycast，复杂工作留 Jira）
- https://www.bearliu.com/blog/raycast-the-interaction-model（两个键的语法 + AI 的局限）
- https://scalingdevtools.com/podcast/episodes/raycast（创始人：dogfooding、两周发布、小版本高质量）
- https://www.raycast.com/blog/a-technical-deep-dive-into-the-new-raycast（自研 UI 而非标准组件）

**① 核心体验主张**：一个全局、快的命令栏，连接你所有工具；**不是省时间，是「感觉不到在浪费时间」**。

**② 机制**
- **两个键的语法**：`Enter` 执行最可能动作，`Cmd+K` 对该条目展开其他动作（Open / Show in Finder / Copy Path / Add to Favourites）。用户不用学 2,500 个扩展，只学**一种语法**。【事实】
- **搜索栏居中放大 + 大图标结果**：几乎每次交互都经过它；结果图标放大便于扫视。【事实】
- **底部 action bar**：把动作、toast、导航标题集中；快捷键显示在动作旁，边用边学；toast 可展开看详情。【事实】
- **Compact Mode**：极简外观，只留「输入→回车」主流程。【事实】
- **80/20 集成**：常用动作进命令栏，复杂工作留给原工具（如 Jira）；扩展像原生，不出现「二等迷你应用」。【事实】
- **质量来自 dogfooding**：全员用内部版本数周才发布；两周一个发布周期、必带一个亮点功能。【事实】

**③ 为什么顶级**
- **一致性复利**：一种语法覆盖一切，肌肉记忆可迁移到新扩展。【事实 + 推测】
- **快捷键可被发现**：动作旁显示快捷键，把「学习」嵌入「使用」。【事实】
- **识别产品边界**：AI 的「persist/iterate」节奏与命令栏「appear/act/disappear」冲突——诚实承认设计的天花板。【事实】

**④ 迁移到 takeover**
- 「`Enter` 主动作 + 次级动作菜单」→ ComposerChip 浮层每项卡片：主按钮「一键接管」，旁边小结「交接 / 记忆 / 导出」次级动作，不必把所有按钮平铺。
- 「action bar 显示快捷键」→ 我们的按钮/浮层项旁标注 `⌘K`、`/`、`↑/↓`，边用边学。
- 「80/20」→ takeover 只把「一张卡带走会话/未提交代码/记忆/环境」这一高频动作做到极致，把低频复杂配置收进设置卡，不要平铺。
- 「dogfooding + 两周亮点」→ 作为发布纪律建议，非界面元素。

---

### 6. Warp Terminal —— 给无结构的数据流加上「块」结构

来源：
- https://www.warp.dev/blog/how-we-design-warp-our-product-philosophy（8 条原则）
- https://www.warp.dev/blog/block-model-behind-warps-agentic-development-environment
- https://www.warp.dev/blog/how-warp-works
- https://www.warp.dev/modern-terminal
- https://docs.warp.dev/terminal/blocks/block-basics

**① 核心体验主张**：保留命令行的全部能力，修好它的 UI——让 CLI 新手也有老手的生产力。

**② 机制**
- **Block 模型**：把「命令 + 其输出」分组为一个有类型的块，垂直堆叠成 BlockList；可按键在块间跳转、一次手势选中整块输出、把块分享成永久链接、对整块执行后续动作。【事实】
- **开箱即用**：400+ CLI 工具智能补全、命令描述、搜索、语法高亮，零额外配置。【事实】
- **Workflows**：按名称/描述搜索难记的长命令，可参数化、可 Tab 在参数间跳转、可按仓库共享。【事实】
- **8 条产品原则**：兼容现有 shell/键位（meet developers where they are）、保留能力但修 UI、开箱即用、为速度构建（Rust + GPU）、建平台等。【事实】

**③ 为什么顶级**
- **给无结构信息加结构**：传统终端只有字节流，Warp 把「一次命令」变成一等对象，于是导航/选择/分享/复用都变得自然。【事实 + 推测：结构即可用性】
- **向后兼容降低迁移成本**：第一天生产力不低于旧终端。【事实】

**④ 迁移到 takeover**
- **Block 思想直接对应我们的「一张卡」**：会话/未提交代码/记忆/环境四轴被打成一个可整体操作的「卡对象」——强化「卡是一等对象」：可整卡跳转、整卡分享、整卡回查，而不是散落的字段。【推测：我们的卡已接近这个抽象，可在 UI 上更明确「一卡一对象」】
- 开箱即用原则 → 首次打开就给出 onboard 三步（`onboard1/2/3`，`src/client.ts:2412-2414`），无需配置。

---

### 7. Claude Code（Anthropic）—— 把「不可逆」推迟到「可审阅」之后再发生

来源：
- https://code.claude.com/docs/en/best-practices
- https://code.claude.com/docs/en/permission-modes
- https://code.claude.com/docs/en/interactive-mode
- https://claude.com/blog/seeing-like-an-agent（AskUserQuestion 工具的设计取舍）

**① 核心体验主张**：默认就能把第一句话做对；把探索/计划与执行分离，让「决定」发生在还便宜、可回退的时候。

**② 机制**
- **Plan Mode**：`Shift+Tab` 循环模式、`/plan` 单轮计划、`--permission-mode plan`；计划写成 `~/.claude/plans/` 下的文件，`Ctrl+G` 可直接编辑；审批前不改源码。官方判据："如果一句话能描述 diff，就跳过计划"。【事实】
- **权限模式梯度**：default / acceptEdits / plan / auto（分类器审查常规动作、拦高风险）/ bypassPermissions；auto 连续被拦 3 次或累计 20 次会退回询问。【事实】
- **交互式快捷键**：`/` 命令、`!` shell 模式、`@` 文件提及（还会建议本机其他 live session）、`:` emoji、`?` 空输入时速查；`Tab` 接受补全；`↑/↓` 导航历史。【事实】
- **证据优于断言**：官方要求 agent 给出测试输出/命令与返回/截图，而不是口头说成功。【事实】
- **自动压缩 + 子代理**：长会话自动压缩、独立工作委派给子代理并只在必要时汇报。【事实】

**③ 为什么顶级**
- **把昂贵决策放在可回退窗口**：「生成代码变便宜，决定做什么仍昂贵」——plan mode 让你在被不可逆动作锁死前花掉那笔可丢弃的开销。【推测，来源文章观点】
- **模式是连续的**，不是「全允许/全拒绝」二元：auto 分类器承担常规判断，只在真正风险点打扰你。【事实】
- **降低提问摩擦**：问问题时给结构化选项（AskUserQuestion），而不是纯文本来回——提高沟通带宽。【事实】

**④ 迁移到 takeover**
- Plan Mode 思想 → 交接出去前给「交接预览卡」（对应上面 compact-relay 的预览-确认），把「决定带什么」放在不可逆的提交之前。
- 证据优于断言 → 接管后展示「核对依据」：会话原文地址、git 快照、记忆来源，而不是一句「已接管成功」。
- `?` 速查、`@` 提及会话 → 我们的 `?`（guide 视图）与 `/`（聚焦）已部分具备；可让 `@` 在 ComposerChip 里提及某张卡/某个 agent 会话。
- 连续被打断降级 → 预警条 warn 只提示、critical 才给救生艇按钮（我们已是这个梯度，`src/client.ts:3432,3442`）。

> 可选（用户列为可选、本次未深挖）：1Password / Arc 的渐进披露与命令面板。其「渐进披露」思想已由 Figma/Linear/Raycast 的资料覆盖（见原则 2），此处不另列，避免无来源的空谈。

---

## ② 顶级体验的共性规律（7 条原则）

| # | 原则 | 来源支撑 | takeover 现状（已核验） |
|---|------|----------|--------------------------|
| 1 | **零配置起步**：第一次就能用，配置是后来才需要的 | Warp #3、dsh-mobile 扫码、Claude Code「first prompt already does the right thing」 | ✅ 三步 onboard（`src/client.ts:2412-2414`）；可继续压缩到「一点即用」 |
| 2 | **渐进披露**：默认简单，细节按需展开；hover/点开才显 | Linear、Raycast Compact、Figma（merge.rocks） | ✅ 五视图分片 + ComposerChip 浮层按需弹出 |
| 3 | **一键动作 / 原地完成**：高频动作一步到位，视线不离开当前上下文 | SW `/sw-continue`、Linear 命令面板、relay 接力条 | ✅ 「一键接管」「交接出去」；可强化原地续接 |
| 4 | **状态可见且可解释**：不只报数字，要报「为什么现在该做」 | SW 灯色 + 账单溢价、relay 环 + 悬浮明细 | ⚠️ 有预警条与 basis，但择时解释可分桶细化 |
| 5 | **可逆 / 可撤销 / 预览-确认**：不可逆动作先预览后确认，读不到就诚实说 | compact-relay、Claude Code plan mode | ⚠️ 交接流程可加预览-确认层 |
| 6 | **键盘流 + 命令面板承载全部**：一个入口 + 可发现快捷键 | Linear、Raycast、Claude Code | ✅ `Cmd/Ctrl+K`、`/`、`↑/↓`（`onRootKeyDown`）；可扩为完整命令面板 |
| 7 | **信息密度服务留存 + 视觉降噪**：一屏多状态，辅助信息压低对比，结构「被感觉而非看见」 | Linear 2024/2026 刷新、13px/4px 网格 | ✅ 817 卡行 + `--tk-*` token；注意别堆元数据 |

补充两条贯穿性原理（来自调研，不单列原则）：
- **诚实反馈**：读不到说读不到、不给假成功（compact-relay、dsh-mobile 限制说明、Claude Code 证据优于断言）。
- **一致性复利**：一种语法/一个抽象覆盖全部（Raycast 两键、Warp Block、Linear「一种好方式」）——takeover 的抽象是**「一即是全·四轴一根链的一张卡」**，应让这个抽象在所有界面一致出现。

---

## ③ 迁移到 takeover 的具体建议（每条对应真实挂点）

> 行号基于 `D:\coding\dsh-takeover\src\client.ts`（已核验）。token 基于 `--tk-*`。

### A. 把命令面板做成真正的「前门」（原则 6）
- **挂点**：`onRootKeyDown`（`client.ts:3121-3130`）现在 Cmd/K 只 `focusFilter()`。
- **建议**：Cmd/K 打开一个浮层命令面板，列出**上下文化**动作：收件箱/会话浏览器/交接/记忆快照/指南五视图切换、一键接管本卡、交接出去、导出、设置；每项右侧显示快捷键。`/` 继续聚焦过滤（保留现有肌肉记忆）。
- **为什么**：Linear/Raycast 证明「一个入口承载全部 + 快捷键可见」能同时服务新手与高手。

### B. 键盘语法单字母/两键序列（原则 6）
- **挂点**：`onRootKeyDown` + 五视图 + guide 视图（`client.ts:3719-3722`、`src/client.ts` 各 `section(...)`）。
- **建议**：`G I/B/H/M/?` 五视图；`?` 在空输入时打开 guide（速查表）；`J/K` 在卡行间移动、`Enter` 接管——与现有 `↑/↓` 兼容。
- **为什么**：Raycast「两键语法 + 快捷键旁显示」让学习嵌入使用。

### C. 预警条从「报占用」升级到「报决策」（原则 4）
- **挂点**：预警条 `client.ts:3429-3442`（`ctxHealth.basis`、triggers、warn/critical）。
- **建议**：basis 文案借鉴 SW「为什么现在该交接」：给出「继续背着 vs 现在交接」的对比依据；点开可看四轴分桶（会话/未提交代码/记忆/环境各占多少），勾选预览交接后状态。维持 warn 只提示、critical 才出救生艇按钮的梯度。
- **为什么**：SW 证明「一个颜色 + 一句可解释依据」胜过裸百分比。

### D. 交接/接管加「预览-确认」层（原则 5）
- **挂点**：「交接出去」按钮、`/dsh-takeover/lifeboat` 与 `/dsh-takeover/send`（预警条按钮已调用，`client.ts:3442+`）。
- **建议**：点击后先出确认卡：将打包的四轴明细、目标 agent/机器、是否归档源、源会话是否仍有任务在跑；确认才执行；取消不动任何状态。失败时明确报错，不假装成功。
- **为什么**：compact-relay 的 `/bc` 预览-确认 + 诚实报错是其口碑核心。

### E. 接力条双向跳转 + 按需读取（原则 3、5）
- **挂点**：ComposerChip 浮层（`client.ts:3728-3739`）与收件箱「历史/archived 块」（`client.ts:535,538-545`）。
- **建议**：浮层顶部显示「本卡接力自 X / 已交接给 Y」，两侧互跳；完整链点开才读（不展开不发请求）；读不到保留已读行 + 标注原因；成环自动停。
- **为什么**：compact-relay 的接力链 + relay 的诚实兜底。

### F. 卡是一等对象（原则 7 + 一致性）
- **挂点**：817 卡行渲染与各 `section(...)`。
- **建议**：把「一张卡」显式做成可整体操作的对象：整卡跳转、整卡分享（生成卡链接/文件）、整卡回查原文；行内用图标/符号，hover 显细节，辅助信息用 `--tk-mut/--tk-dim` 降对比。
- **为什么**：Warp Block 让「命令+输出」成为一等对象后，导航/选择/分享自然成立。

### G. 视觉降噪沿用 `--tk-*` token（原则 7）
- **挂点**：CSS token 定义（`src/client.ts` 约 305-340 行；lib/client.js 约 1630-1666）。
- **建议**：保持侧栏 `--tk-rail`、辅助 `--tk-mut/--tk-dim` 低对比，工作区 `--tk-text` 聚焦；单强调色 `--tk-a/--tk-grad`；分隔线少而柔。避免给每张卡都上满色徽标。
- **为什么**：Linear 2024/2026 刷新直接验证「降低视觉噪声、结构被感觉而非看见」。

### H. 一键动作原地完成 + onboard 收束（原则 1、3）
- **挂点**：`onboard1/2/3`（`client.ts:2412-2414`）、ComposerChip。
- **建议**：把「浏览→接管→交接出去」三步压缩为浮层内一键闭环；交接后 agent 一句「接着做什么」就地续上（SW `/sw-continue` 思想）。首次进入即显 onboard，可永久关闭。
- **为什么**：SW 原地续接 + Warp/Claude Code 开箱即用。

### I. 待批准时刻才打断（原则 4 + 诚实）
- **挂点**：预警条 critical 分支（`client.ts:3442`）。
- **建议**：把「有卡等待接管/批准」做成只在真正需要人时出现的可执行提示；消息默认不含会话正文、敏感信息脱敏；明确说明跨机器时环境由网关代持。
- **为什么**：dsh-mobile 的「只在需要你时推、默认正文脱敏」是信任的关键。

---

## ④ 反面案例与我们要避免的

来源：
- https://www.howtogeek.com/how-feature-creep-is-ruining-software-gadgets-and-video-games
- https://dovetail.com/product-development/what-is-feature-creep
- https://www.smashingmagazine.com/2024/01/feature-centricity-harming-product/
- https://www.uxmatters.com/mt/archives/2014/03/beware-of-feature-overload-a-case-study.php
- https://buttondown.com/blog/avoiding-feature-creep（Word 2003：31 工具栏 / 19 任务窗格 / 250+ 菜单项）
- https://www.friday.ie/blog/how-feature-creep-can-alienate-your-most-valuable-customers

| 反面案例 | 被批评的点（事实） | 我们要避免 |
|----------|-------------------|-----------|
| **Adobe Photoshop / Office 2003** | 功能堆砌、菜单无处安放、新手需长教程；Office 17 年堆到 31 工具栏/250+ 菜单【事实】 | 五视图 + 设置卡**不要继续平铺新按钮**；新能力优先收进命令面板 |
| **MySpace** | 照片/视频/博客/论坛/游戏全堆在**一页**，失去「为什么存在」【事实】 | 避免「一个浮层塞下所有功能」；保持一卡一对象、一视图一职责 |
| **Skype** | 团队被功能牵着走，没时间修通话质量/稳定性【事实】 | 宁可两周一个高质量亮点，不要堆功能牺牲稳定（Raycast 纪律） |
| **Figma（近年）** | 频繁改版让老用户「对基本编辑迟疑」【事实】 | 重构 UI 时保持「evolution 而非 revolution」（Linear 2024 原则） |
| **Raycast 的 AI** | 「appear-act-disappear」节奏装不下需要 persist/iterate 的 AI 对话【事实】 | takeover 的会话是「持久对象」，不要用一次性浮层承载长会话；浮层只做入口，工作台做持久 |
| **Smart fridge / 智能洗衣机** | 功能异质性高、互不相关→用户觉得难用、不信任【事实，Hoyer 研究】 | 四轴（会话/代码/记忆/环境）要讲清「一根链」的统一叙事，别让人觉得是四个无关工具拼盘 |
| **Pendo 数据** | 80% 功能很少或从未被使用【事实】 | 每次加功能先问「这是不是那高频的一张卡？」 |

**一条总纪律（可直接执行）**：**「一个好方式 + 一张卡 + 一个入口」**——新增任何能力前，先确认它能挂到现有 `--tk-*` / ComposerChip / 五视图 / 预警条的某个已有挂点上；不能挂入统一叙事的功能，宁可不做。

---

## 事实 / 推测边界小结

- **已核验事实**：takeover 的 `onRootKeyDown`（3121-3130）、预警条（3429-3442）、ComposerChip（3728-3739）、五视图 section（3708-3722）、onboard 三步（2412-2414）、`--tk-*` token（约 305-340），均来自本地源码逐行读取。
- **带来源事实**：所有产品的机制、数字、原则均附来源链接。
- **推测（需你自行验证）**：心理学解释（认知卸载、控制感、菲茨定律、一致性复利）为推论；「basis 明细分桶」「跨机器代持登录态提示」「@ 提及卡」等属于建议而非现状；70%/85% 阈值来自任务描述，源码中预警条以 `ctxHealth.level`/basis 触发，具体阈值需探针侧确认。
