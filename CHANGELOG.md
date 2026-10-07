# Changelog

> **版本体系重置（2026-10-01）**：0.1–0.5 时期的版本号随开发过程推进过快、颗粒度失真，经用户要求自本日起**重置为 0.1.0 重新起算**——0.1.0 = 当前功能全集（八家拉取 / 交接寄存 / 收件箱取件 / 设置卡四区 / 双语 i18n / 八家品牌图标）经完整真用户流测试通过后的首个版本。此前的版本号历史见文末归档，仅作记录，不再构成发布序列。

## [0.4.1] — 未发布

### 新增（收件箱噪音治理 + 安全闸——三路工作流调研裁决 build 项）
- **push 密钥闸**（先例：gitleaks/Push Protection——阻断为默认+留痕旁路）：确定性扫描六段文本（云厂商 key 前缀/私钥头/常见 token 前缀 + 敏感词赋值高熵值），命中拒绝并回喂 redact 指引；`allowSecrets: true` 留痕旁路（旁路规则名进返回值与 note）。卡随同步盘跨机传播并进入下游会话上下文——比 git 更宽的泄漏面，git 仓有 gitleaks 守、交接盘原来什么都没有
- **push 空壳卡守门**（调研遗漏项：42% 噪音的根因在生产者侧）：六段全是兜底占位**且零手写段**时拒绝落卡，理由回喂（模型可亲手蒸馏重试）；`confirmSkeleton: true` 留痕旁路保住「诚实的空卡」场景。部分手写+部分兜底的卡不拦（判据与文案字面一致），由收件箱徽标兜底
- **收件箱低信息组**（先例：Linear 次级桶/actions/stale 打标先行）：`PendingRow.lowInfo` 由盘面原文确定性计算（占位行 ≥3），客户端把低信息卡收进可展开的「低信息卡（N）」次级组（默认折叠），行内带灰色徽标——主列表只留实质工作卡；TTL 自动归档按调研共识缓行
- **取件补丁指引加 `-3` 兜底**：`--check` 失败（目标仓已前进）时 `git apply -3` 三方合并自助解决冲突（裁决 P3：文案级成本趋零）
- **接力链 UI** 按裁决 defer：数据层已实现但真实卡零使用，等首个真实 supersedes 卡出现再补最后一公里

### 新增（物质层交接：卡不只是地图，也是货物清单）
- **补丁随卡**：`handoff_push` 时若源目录是 git 仓库且有未提交改动，`git diff HEAD` 落第三文件 `<id>.patch` 进 pending/（与信封同款 sidecar 模式，SPEC 一字不动）；取件时补丁与卡同步搬 archived/，文案给出 `git apply --check` → `git apply` 指引。**截断的补丁不能 apply——diff 超 512KB 整份拒带**（不半截携带），文案提示自行 commit/push；未跟踪新文件只进信封清单（≤20 条）不带货，防 node_modules 级噪音
- **非 git 仓诚实警告**：源目录未识别为 git 仓库时，卡片警告段如实标注「文件改动无法随卡携带、取件侧无法 git 核验」——不再让 `git.branch` 静默空串（昨日实卡 `ho-muw3beig-evr3` 暴露的盲区）
- **信封物质层扩展**（全部可选，旧消费者天然忽略）：`host`（源机 hostname/platform——跨机接管判断路径体系）、`untracked`（未跟踪清单）、`test`（源目录 package.json 有 test 脚本时的基线命令提示）、`supersedes`（接力链，push 新增可选参数）
- **取件物质层指引**：取件文案逐条给出——补丁 apply 指引（先 --check 再 apply，有冲突如实报告不硬塞）、基线测试提示（接手先跑对比，对不上按 MISMATCH 处理）、接力链回溯 id
- **写卡纪律 7/8 条**（skill 层）：失败尝试与放弃原因写进警告段（接手方不重复踩坑）；环境状态（服务/端口/env/工具版本/源机 OS）写进警告段、仅源机路径标注「仅源机」

### 安全与加固
- **连接级回环闸**：`/dsh-takeover/*` 全路由先校验 `socket.remoteAddress` 是本机回环（127.0.0.1/::1），非回环一律 403——此前只验 Host/Origin/Sec-Fetch-Site 请求头，而宿主 webServer 一等支持 0.0.0.0 绑定，头部对非浏览器客户端全可伪造（LAN 直连可未鉴权读卡/翻开关/清归档）
- **读侧尺寸闸**（姊妹仓 core 同步修）：`listDirCards`/`loadCard` 读前 statSync，超 8 MiB 的外来巨卡列表跳过 / 取件拒载不消费——共享收件箱是多写方目录，巨文件同步读会放大进宿主事件循环；信封消费同步加同款闸
- **tasks 快照封顶**：todo 条数 ≤50、单条 text ≤120 字、priority ≤10 字；keyFiles 去重集合 ≤200——六段之外唯一全量入卡的结构不再能被构造事件流撑爆

### 修正
- **「只看新卡」过滤反转**（P1）：`filterPending` 把新 id 集写反成「只显旧卡」，开筛后真正的新卡全被藏掉——修正并补回归测试
- **「最后一条用户请求」保头弃尾**：userMessages/commands/gitCommits 超上限时保头，长会话蒸馏出的「最后一条用户请求」实际是几百轮前的旧请求——改保尾弃头（`at(-1)` 恒为真·最后一条）
- **全新安装误报「收件箱概览不可用：ENOENT」**：pending/ 目录在首次 push 前不存在，buildState 无条件 readdir 抛错进降级态——目录缺失按空收件箱语义处理（与 core listDirCards 对齐）
- **provider 开关并发丢更新**：读-改-写 config.json 无串行化，双开同停 A/B 只停了 B——路由层写队列串行化
- **孤儿信封无清理**：旧版实现取走 .md 后信封永留 pending/，envelopeChars 无界失真——buildState 顺手清扫无主信封（纯派生物，删除无害）
- **空收件箱误显「没有匹配」**：rows 为空与筛选无命中共用 filterEmpty 文案——空收件箱改用 emptyInbox（原为死键）
- **刷新竞态**：30s 轮询慢 GET 晚于开关 POST 返回会把开关弹回旧状态——请求代数守卫，过期响应丢弃
- **opencode 图标坏 path**：`d="#5A5858"` 颜色串当路径数据（浏览器静默忽略）——删除使代码与渲染一致
- **重复计数 chip 无样式**：`.bt-stat-warn` 类没有对应 CSS 规则——补上（接 warn 色轴）
- **主题探测退化**：body 背景透明时不回退 html 根元素；oklch/oklab 等 modern 色彩函数被 `\d+` 抓成 `r=0,g=98` 误判深色——透明回退 + 亮度分量解析
- **aria-description 不是有效 ARIA**：读屏不识别——改 `aria-describedby` 指向可见 note 节点
- **行内嵌套可交互**：展开态预览与「导出 .md」按钮嵌在 role=button 行内（ARIA 禁则）——预览块移出为兄弟节点，外壳承接 flex-wrap 布局
- **组头读屏串混中文标点**：aria-label 硬编码全角逗号——改走词典模板 `groupAria`
- **「（未知来源）」中文字面量泄漏 EN 界面与导出**：host 侧改下发空串，客户端词典渲染兜底（新增 `unknownSource` 键）
- **报告跳过横幅方向错**：「不计入上方列表」实际列表在下方——zh/en 同步改「下方 / below」

### 测试
- **真宿主可见测试会话（跨会话交接实证）**：宿主部署 0.4.1 构建后，浏览器驱动真实创建两个会话跑完接管环——会话 A `/resume-zcode` 拉真实「dsh-baton」会话（2466 轮）蒸馏六段卡（四态标注齐全）→ 用户答「寄存」→ `handoff_push` 落卡+信封；会话 B `/inbox` 列 13 张 → 用户答「取 1 号」→ 消费即弃归档 + 六段接管简报（git 核验 UNAVAILABLE 如实标注）。盘面核对无孤儿无残留。0.3.0 已知项「阻塞面板不弹」以实证关闭：寄存确认以会话内文本问答形态工作，与 P0 定案一致
- 单测 123/123（新增 7 条审查回归）；smoke-foreign 与 smoke-userflow（46 断言）双绿

### 文档
- skill 两处承诺对齐实现：/resume-claude 边界由「沿可恢复分支读取，排除私密与被替换内容」改为如实描述（全量读取，thinking 以 [thinking] 标记保留）；inert-history 段「隐藏推理已排除」改为「[thinking] 标记段不蒸馏进卡片」——姊妹仓 zcode 读取器同批补上此前缺失的推理标记
- README 双语「协议语义五条」补第六条「反向锚定+剪枝」；en 版开发节补 smoke-userflow 一行
- handoff_push 工具描述「六段（…suggested）」实列 7 项——改为「六段 + 可选 suggested」

## [0.4.0] — 2026-10-04

### 新增
- **四态覆盖率统计（审计语义产品化）**：`handoff_push` 落卡前对「做到哪」段逐行确定性统计——空行与 `#` 小节标题行不计，其余每行算一条完成/交付陈述，含 CURRENT_OBSERVED / HISTORY_REPORTED / MISMATCH / UNAVAILABLE 任一计已标注；结果写入卡片 `extras.coverage`（`{ statements, marked, unmarked }`）随卡持久化（取件侧可读回），push 结果同步返回 `coverage`。push 与取件渲染各追加一行「账本覆盖：x/y 条已标注状态（z 条未标——取件方按 HISTORY_REPORTED 处理）」。**口径纪律：只统计不强制**——不为覆盖率设任何门槛，防止「为覆盖率假标」污染账本；未标注行的消费口径由取件方按 HISTORY_REPORTED 兜底
- **机器信封（双形态输出：人的卡片 + 机器的接手信封；协议扩展提案）**：`handoff_push` 成功后在 pending/ 落第二文件 `<id>.envelope.json`（`{ handoff: 1, kind: "envelope", id, from: {agent, title}, goal, done, remaining, stopped, warnings, files }`），各段确定性截断（goal/done ≤300 字，remaining/stopped/warnings ≤200 字，from ≤100 字，files 取卡片 files 段前 10 条非空行、单条 ≤120 字），总 JSON ≤1200 字为目标（段上限负责封顶最坏情形）；`handoff_inbox` load 取件消费 .md 时同步删除对应信封，并提示「机器信封已随卡归档（n chars）」——信封读/删失败只降级，绝不影响取件成败，残留信封对不认识它的实现天然无害。**handoff: 1 SPEC 一字未动**：信封是独立派生文件而非 frontmatter 扩展，作为协议扩展提案提交上游（agent-handoff 协议仓）

- **HTML 单文件报告导出**：「导出 HTML 报告」把整个 state 编译成自包含 styled HTML（品牌渐变头 / 统计卡 / 全部待取件卡 / 八家支持矩阵），escHtml 全量转义，零依赖 Blob 下载，zh/en 双语；`reportWords` 从本卡词典组装报告文案包（漏译在 locales 键位对齐测试拦下）
- **state 聚合透出**：`TakeoverState` 新增 `coverage` / `envelopeChars` 聚合字段，设置卡防御式消费（字段缺席整行不渲染）；statstrip 徽章行升级为统计条
- **设置卡高级感走查**：间距/圆角/层级体系化打磨（0cbf1b6、9c03ae8）

### 测试
- **真用户旅程实机测试**（`scripts/smoke-userflow.mjs`，46 项断言）：用本机真实 opencode（109 条）与 zcode（149 条）会话走完整接管环——list 候选 → show 蒸馏 → push 寄存（覆盖率吃到真实 HISTORY_REPORTED 行、信封落盘且体量受控）→ 换身份 inbox 取件（六段完整、信封随卡消费、消费即弃二次取件报规范错误值）→ 歧义引用与全空段兜底 → 设置卡 state API 分屋诚实跳过；另在运行中宿主浏览器实测设置卡全件（新卡徽标、展开预览、筛选 chips 计数联动、八家品牌图标支持矩阵、覆盖率徽标与信封行）

## [0.3.1] — 2026-10-03

### 修正
- 全面测试与加固：24 项深审发现（安全注入/路径穿越/资源耗尽/数据边界/行为一致性）全部独立复核证实并修复，新增对抗性测试 spec（84/84）
- 设置卡 muted/语义色按宿主背景亮度自适应（浅色对比度修复的体系化）
- README 安装断链、「0.2.2 起提供」等历史残留清理

## [0.3.0] — 2026-10-03

### 新增
- **收件箱即时过滤**：头部过滤框按标题 / 来源 / 编号子串即时过滤（纯前端，清空恢复，全滤空显示「没有匹配」）
- **新卡徽标**：state 首现卡片显示「新」，展开即记已见（localStorage 按 HANDOFF_HOME 散列键隔离，上限 1000，坏 JSON 降级不抛）
- **重复卡分组**：相邻同来源 + 同标题卡片折叠一组（组头徽标「共 N 张」/ en「N cards」），展开逐条；组内任一新卡则组头带「新」
- **导出**：展开态「导出 .md」（单卡 frontmatter + 六段）+「导出全部」（全部待取件拼一个 .md）；导出只写 state 真有字段，「目标」段为 240 字预览、缺失段就地注明边界
- 新增 `src/inbox-view.ts` 纯函数层与 13 条单测（过滤 / 分组 / FNV-1a 已见集合 / 导出含 parseCard round-trip）；`TakeoverState` 新增 `home` 字段（客户端已见键散列数据源）

### 变更
- **P0 通知形态定案**：阻塞式面板前置条件 = 目标会话已绑定当前浏览器且用户正看着——与通知「用户可能不在看」天然冲突，**通知形态定为收件箱行内新卡高亮**；同会话在线时的确认面板代码保留（正向场景仍有效）。根因排查全链见工作流报告（api-remotes 载体校验 → api-gateway 投递 → api-session-controller retainAgentScope 三段证据）
- 通知降级可观测：降级码进日志（区分未认领 / 已中止）

### 已知项
- 实机复测：会话打开 + 绑定条件下 `/handoff` 推送成功但面板仍未弹出（1 个数据点，与源码分析的正向预测不符）；剩余未排除分支 = 网关 answer() 客户端异常，抓浏览器 console.error 复跑可定位

## [0.2.0] — 2026-10-03

### 新增
- **假 0 哨兵 + 浮出**：读取器存储根目录存在但 discover 为 0 时，适配器 note 置「存储目录存在但未发现会话——上游可能已迁移存储布局（参考 opencode 1.18 迁 SQLite）」；设置卡支持矩阵行在 supported 且 note 非空时以橙色小字行内浮出（title 悬浮与 aria-description 同步），不再静默 0。哨兵本体在 agent-handoff readers（codex / cursor / grok + opencode storage 回退路径；有数据的家 note 保持空），随构建打包
- **空 cwd 警告**：外来会话未记录工作区目录时，`foreign_session_read` 骨架卡「读者警告」段追加「⚠ 该会话未记录工作区目录，接手前先确认目录」；/resume-* skill 的 verify-then-continue 段补同款规则（casr #20 同类）
- **设置卡自动刷新**：面板挂载后每 30s 自动拉取 `/dsh-takeover/state`，仅 `document.visibilityState === 'visible'` 时拉取；卸载清理 interval；手动刷新按钮保留
- **寄存/取件后的宿主通知**：`handoff_push` / `handoff_inbox`(load) 成功后经 `ctx.userQuestions.ask` 弹阻塞式问答面板（「已寄存/已取件会话卡片 handoff:<id>，需继续吗？」）。服务缺席（旧宿主）、客户端离线（NO_PROVIDER）、subagent 持有 agent（DELEGATED_CALLER）一律静默降级为工具结果文本，不阻断主流程。实机验证（0.3.0）：面板未按预测弹出，结论与后续排查见 [0.3.0] 已知项
- README 双语新增「竞品与差异化」「跨机器接力」小节（竞品调研底稿 docs/竞品动态-1003.md；`HANDOFF_HOME` 指向同步盘/git 仓库即多机接力，一句配置零代码）
- agent-handoff 协议仓 README 顶部 handoff: 1 协议声明 + 采用登记节（版本化开放协议；采用者 issue 登记；与 JarvanAI 同名仓无关联的澄清，中英同步）

### 修正
- README 安装说明两处话术残留：node:sqlite 要点名补上新版 opencode.db（0.1.1 起，旧文案只写 zcode/cursor）；「固定版本可写 `#v0.5.1`」指向重置前已不存在的 tag，改为真实存在的 `#v0.1.0`

### 依赖
- devDependencies 增 `@deepseek-ai/dsh-user-questions@0.2.0-rc.2`（仅类型消费：触发 Context 声明合并；运行时服务由宿主提供，缺席走防御降级）
- `@agent-handoff/readers` 随构建更新（假 0 哨兵）

## [0.1.1] — 2026-10-02

### 修正
- **opencode 读取器支持新版 `opencode.db`（SQLite）**：此前只扫旧版 `storage/` 三层文件布局，新版 opencode（npm 2.0+）把会话迁进 SQLite 后本机会话假报 0（实测 109 个会话不可见）。现 DB 存在即优先走 DB（node:sqlite 只读），旧布局回退保留（修复在 agent-handoff readers，随构建打包）
- README 安装命令断链、兼容声明虚标、设置卡描述停在旧版（同日全仓审查修正，见 0.5.x 归档之后的第一批提交）

### 验证
- 矩阵 opencode 109 会话可见；`/resume-opencode latest` 真用户流实跑（GLM-5.3-Flash）：正确拉取最新 1310 轮"工作区整理"会话并生成六段卡

## [0.1.0] — 2026-10-01（重置起点）

功能全集：`/resume-*` 八家会话拉取（结构化摘要 + 分页原文）、`/handoff` 寄存、`/inbox` 取件（消费即弃 + git 核验警告）、设置卡四区（命令速览 / 收件箱概览 / 支持矩阵 / 开关语义）、宿主 i18n 双语、八家官方品牌图标 + DSH 官方鲸尾标。

**真用户流验收（GLM-5.3-Flash 实跑）**：① `/resume-zcode latest` 拉取→六段卡→verify-then-continue 提问 ✓ ② 答复后 `handoff_push` 寄存（待取件 4→5）✓ ③ 新会话 `/inbox` 列 5 张→用户挑选→消费取件（5→4）+ 四态账本简报 ✓ ④ `/handoff` 直接交接寄出 `ho-mupqcuek-1105` ✓；沙箱 ACL 故障下核验降级纪律正确生效。

---

## 归档：重置前的版本号历史（仅作记录）

### [0.5.1] — 2026-10-01

### 修正
- README 安装命令引用了不存在的 git tag（`#v0.4.0`），照抄会安装失败——改为可用的无版本引用，本版本起提供 git tag
- README 支持矩阵「重启生效」与实现不符：开关改动即刻生效（每次调用现读 `config.json`），已更正
- `engines.dsh` 与 peerDependencies 兼容下限虚标 `0.1.7-rc.2`，如实抬到 `0.2.0-rc.2`（设置卡 i18n 依赖宿主 locale 服务）
- 移除遗留的 `pnpm-lock.yaml` / `pnpm-workspace.yaml`（开发流程为 npm，双 lockfile 易腐）
- `package.json` 补 `repository` / `homepage` / `bugs`；keywords 补 takeover / session-takeover / resume / multi-agent

### 新增
- git tag 发版起点（v0.5.1）

## [0.5.0] — 2026-10-01

### 变更
- **品牌定名 dsh-takeover（接管）**：插件名、设置卡路由（`/dsh-takeover/*`）、locale 命名空间、文档全量切换；协议层（`handoff: 1`、`handoff_push` / `handoff_inbox`、`~/.handoff/`）不变
- 收件箱列表重设计：去外框的列表行（hover / 展开浅底色）、行点击展开「目标」段预览、时间智能格式（当天只显时刻）

### 新增
- 品牌图标换接管意象（双箭头 » 进格 |，`assets/icon.svg` 与设置卡内联同步）
- dsh 宿主来源使用官方鲸尾标（取自宿主 web UI brandMark），`DeepSeek Harness` 规范标签
- README 双语「为什么叫 takeover」命名故事

### 修正
- 全仓审查：安装命令失效 tag、设置卡描述停留在三区、六家残留、双 lockfile、词典漏译无拦截（新增 `tests/locales.spec.ts`：zh/en 键集对齐 + zh 值必含中文）
- 展开态 preview 挤压标题的 flex 回归

## [0.4.x] — 2026-10-01

- **0.4.0** 仓库与插件改名 dsh-baton → dsh-takeover；版本对齐（远端此前已发至 0.3.3 同源）
- **0.4.1** 品牌图标接管意象（首版）；窄容器适配（≤430px 命令单列）；pending 行键盘可达（role/tabIndex/Enter+Space）；smoke 与 harness 测试脚本旧账校正
- **0.4.2** 界面词零英文：待取件 / 已消费 / 编号徽章进词典；术语规范成文（`locales.ts`：界面词全走词典、命令与工具名是标识符不译、品牌词不译）
- **0.4.3 / 0.4.4** 收件箱卡片首版重排；展开态 preview 挤压标题的 flex 回归修复

## [0.3.0] — 2026-10-01

- 设置卡接入宿主 i18n：zh / en 词典全量，文案经 `ctx.locale.bind` 取词，语言切换实时重渲染（宿主 locale 缺席回退静态 zh）
- pi 图标换官方 pi.dev 矢量（`logo-auto.svg` 三色几何标）

## [0.2.x] — 2026-09

- **0.2.0** `/handoff` `/inbox` slash 命令 + `foreign_session_read` 六家会话拉取（claude / codex / opencode / zcode / pi / workbuddy）
- **0.2.1** 增至八家（+cursor / +grok）
- **0.2.2** 设置卡：收件箱概览 + 八家支持矩阵 + provider 开关（持久化 `config.json`）
- **0.2.3** 品牌图标 + 设置卡视觉打磨

## [0.1.x] — 2026-09

- `handoff: 1` 协议落地：`handoff_push` 寄存、`handoff_inbox` 取件、`~/.handoff/` 文件系统总线；与单向导出工具 [dsh-handoff](https://www.npmjs.com/package/dsh-handoff) 并行，后者不并入本插件
- （注：此 0.1.x 为重置前的旧序列，与本版 0.1.0 无继承关系）
