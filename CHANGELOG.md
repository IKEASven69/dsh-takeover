# Changelog

> **版本体系重置（2026-10-01）**：0.1–0.5 时期的版本号随开发过程推进过快、颗粒度失真，经用户要求自本日起**重置为 0.1.0 重新起算**——0.1.0 = 当前功能全集（八家拉取 / 交接寄存 / 收件箱取件 / 设置卡四区 / 双语 i18n / 八家品牌图标）经完整真用户流测试通过后的首个版本。此前的版本号历史见文末归档，仅作记录，不再构成发布序列。

## [0.4.0] — 未发布

### 新增
- **四态覆盖率统计（审计语义产品化）**：`handoff_push` 落卡前对「做到哪」段逐行确定性统计——空行与 `#` 小节标题行不计，其余每行算一条完成/交付陈述，含 CURRENT_OBSERVED / HISTORY_REPORTED / MISMATCH / UNAVAILABLE 任一计已标注；结果写入卡片 `extras.coverage`（`{ statements, marked, unmarked }`）随卡持久化（取件侧可读回），push 结果同步返回 `coverage`。push 与取件渲染各追加一行「账本覆盖：x/y 条已标注状态（z 条未标——取件方按 HISTORY_REPORTED 处理）」。**口径纪律：只统计不强制**——不为覆盖率设任何门槛，防止「为覆盖率假标」污染账本；未标注行的消费口径由取件方按 HISTORY_REPORTED 兜底
- **机器信封（双形态输出：人的卡片 + 机器的接手信封；协议扩展提案）**：`handoff_push` 成功后在 pending/ 落第二文件 `<id>.envelope.json`（`{ handoff: 1, kind: "envelope", id, from: {agent, title}, goal, done, remaining, stopped, warnings, files }`），各段确定性截断（goal/done ≤300 字，remaining/stopped/warnings ≤200 字，from ≤100 字，files 取卡片 files 段前 10 条非空行、单条 ≤120 字），总 JSON ≤1200 字为目标（段上限负责封顶最坏情形）；`handoff_inbox` load 取件消费 .md 时同步删除对应信封，并提示「机器信封已随卡归档（n chars）」——信封读/删失败只降级，绝不影响取件成败，残留信封对不认识它的实现天然无害。**handoff: 1 SPEC 一字未动**：信封是独立派生文件而非 frontmatter 扩展，作为协议扩展提案提交上游（agent-handoff 协议仓）

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
