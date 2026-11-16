# Changelog — dsh-takeover

## [0.25.0] — 2026-11-16

读取器大扩容 + 写回最小闭环：外部会话面从九家推到二十三家（Tier 2 十四家），云端先立诚实的边界；产品第一次从只读转向受控写回。硬线不动摇——**外部 harness 的会话存储永不写**，写回仅限记忆/配置，且全部是显式授权动作（confirm 两步）、写前原物快照可回滚。THREAT-MODEL 新增 T8（写回面）。

- **Tier 2 十四家读取器**（总面二十三家，家数以 `src/providers.ts` 注册表为准）：
  - **jsonl 族四家**：kimi（`wd_<目录>/<会话>/agents/main/wire.jsonl` 事件流）、codebuddy（projects 下 cwd 转义目录一文件一会 JSONL）、qoder（Claude Code 同族主会话 JSONL）、kiro（`sessions/cli/<uuid>.jsonl` 事件流，伴生 `.json` / `.history` 不读）；
  - **sqlite/文件族六家**：copilot / devin / mimo 各家明文 SQLite（node:sqlite readonly 随开随关，列名探测自适应、探测不中如实报降级；mimo 应用目录名未完全核实、候选扫描全不命中时如实标注不可用），aider（项目根 `.aider.chat.history.md` 半结构化 markdown，解析尽力而为并以 note 标注），cline（VS Code 变体 globalStorage 的 `api_conversation_history.json`，ui_messages 不读），continue（`~/.continue/sessions` 索引 + 会话文件）；
  - **收尾四家**：qwen（`~/.qwen` tmp/ 与 projects/ 双布局）、antigravity（brain 目录 transcript.jsonl，跨端索引库只作 cwd 索引）、openclaw（新版 `openclaw-agent.sqlite` + 旧版 sessions/ JSONL 双形态，zstd 缺支持时压缩行跳过并如实降级）、goose（候选路径探测——路径按上游源码推导、未实机核实，全不命中时如实标注待社区确认，`HANDOFF_ROOT_GOOSE` 可直指）；
  - **双轴纪律照旧**：十四家全部只进读取器轴、不进交接目标轴（`OUTBOUND_TARGETS` 一家不加）。
- **注册表派生的新 resume 技能**：二十三条 `/resume-*` 规格全部从 `src/providers.ts` 注册表 map 派生（id / product / description / recoveryBoundary 一表出），消灭手抄数组的漂移面。
- **云端导出落盘通路**：约定 `<HANDOFF_HOME>/exports/<provider>/`——云端会话凡能导出成文件的，按该家本地记录的**原生格式**丢进子目录，读取器原样吃掉（复用既有文件系适配器，零新增解析面；`HANDOFF_EXPORTS` 可直指，`foreign_session_read` 与会话浏览器发现层自动并网）；支持矩阵该行显示 ☁ 导出计数；纯 SQLite 四家（zcode / copilot / devin / mimo）记录在库内、无可对齐的导出格式，诚实不参与。
- **卡链历史 UI**：收件箱视图新增「历史」块——懒加载 `/dsh-takeover/history` 回查 archived/ 已归档卡（id / 标题 / 停点摘要 / 接替链，时间正序），首次展开才拉、30s 轮询共享缓存。
- **接力账本继承**：`supersedes` 在场时新卡确定性继承父卡「还差什么」段前缀（零 LLM、2KB 截断原样并入、不总结不改写）；继承发生在密钥闸之前——父卡遗留里若藏着密钥照拦，不因拼接放行；前缀命中失败时诚实降级，行为与无父卡完全一致。
- **跨机演示脚本**：`scripts/demo-tier2.mjs`——合成 Kiro 会话 fixture → readers discover/parse → 蒸馏六段卡 → `syncNow` 跨机 → B 机取件断言 Turn / 六段齐全（断言不过非零退出，tests/tier2-demo.spec.ts 随全量守门）。
- **记忆写回 `handoff_absorb`**：把已取件（archived/）的 memory 轴记忆卡「建议加载」段条目写进目标 harness 的记忆文件。目标闭集 = MEMORY_SOURCES 的八条文件型记忆路径（AGENTS.md 族事实标准优先；hippo-db 是 zvec 引擎目录，明确拒收并回退指引 `hippo import`）。confirm 两步强制（先 `handoff_inbox load` 看卡、再 absorb 落盘，缺 confirm 一律拒绝并逐条回显计划）；追加前按条目 sha256 去重（已有内容不重写，重复 absorb 幂等 = 0 追加）；写前把目标原物快照进 `archived/absorb-backup/<id>-<target>.md`（同名快照不被覆盖）；tmp+rename 原子替换；写后记 `absorbed-write` 生命周期事件。
- **配置写回 `handoff_env action=inject`**（最小面：MCP servers 与 skills 两样，事实标准可映射）：把备份包内的 `.mcp.json`（`{ mcpServers }` 形态）与 `.agents/skills/**` 条目合并进目标 harness 对应配置。映射闭集 `INJECT_TARGETS`：claude（`~/.claude.json` 的 mcpServers + `~/.claude/skills`）、cursor（`~/.cursor/mcp.json`）、gemini（`~/.gemini/settings.json`）、zcode（skills 即 `~/.agents/skills` 事实标准目录）；codex 的 config.toml（TOML）语义不等价——明确不做。confirm 两步强制、逐条列出将写入什么；**只新增不覆盖**（同名 MCP server / 已存在 skill 文件一律跳过，同内容/冲突分开如实报告）；既有配置被改前原物快照进 `env-backup/restore-checkpoint-inject-*`（与 applyRestore 同款 checkpoint 布局，`action=rollback` 直接可回滚）；写后记 `config-injected` 事件。hooks / 权限 / 插件登记语义不等价，明确不做并如实标注。
- **备份范围补 `.mcp.json`**（category `mcp-config`）：备份清单从此携带用户级 MCP servers 事实标准配置（inject 的源条目）；新增 `readBackupEntryBlobs`（口令解密按谓词取包内条目原文，纯读不落盘）。
- **生命周期闭集新增**：`absorbed-write`（记忆写回正向回执）与 `config-injected`（配置写回正向回执）——写回动作全部入账本。
- **文档**：README 双语补「支持面与分层承诺」表（Tier 1 无缝 = DSH + 原九家 / Tier 2 可接管 = 本期十四家，mimo 目录与 goose 路径诚实降级显式标注 / Tier 3 云端策略）、「写回」功能叙述（只读承诺措辞改为「读取零写入；写回仅记忆/配置且两步确认、原物可回滚」）；THREAT-MODEL 新增 T8（写回面：显式授权、闭集注册表、会话存储零写入硬线、快照可回滚与诚实残余风险）。

- **记忆写回 `handoff_absorb`**：把已取件（archived/）的 memory 轴记忆卡「建议加载」段条目写进目标 harness 的记忆文件。目标闭集 = MEMORY_SOURCES 的八条文件型记忆路径（AGENTS.md 族事实标准优先；hippo-db 是 zvec 引擎目录，明确拒收并回退指引 `hippo import`）。confirm 两步强制（先 `handoff_inbox load` 看卡、再 absorb 落盘，缺 confirm 一律拒绝并逐条回显计划）；追加前按条目 sha256 去重（已有内容不重写，重复 absorb 幂等 = 0 追加）；写前把目标原物快照进 `archived/absorb-backup/<id>-<target>.md`（同名快照不被覆盖）；tmp+rename 原子替换；写后记 `absorbed-write` 生命周期事件。
- **配置写回 `handoff_env action=inject`**（最小面：MCP servers 与 skills 两样，事实标准可映射）：把备份包内的 `.mcp.json`（`{ mcpServers }` 形态）与 `.agents/skills/**` 条目合并进目标 harness 对应配置。映射闭集 `INJECT_TARGETS`：claude（`~/.claude.json` 的 mcpServers + `~/.claude/skills`）、cursor（`~/.cursor/mcp.json`）、gemini（`~/.gemini/settings.json`）、zcode（skills 即 `~/.agents/skills` 事实标准目录）；codex 的 config.toml（TOML）语义不等价——明确不做。confirm 两步强制、逐条列出将写入什么；**只新增不覆盖**（同名 MCP server / 已存在 skill 文件一律跳过，同内容/冲突分开如实报告）；既有配置被改前原物快照进 `env-backup/restore-checkpoint-inject-*`（与 applyRestore 同款 checkpoint 布局，`action=rollback` 直接可回滚）；写后记 `config-injected` 事件。hooks / 权限 / 插件登记语义不等价，明确不做并如实标注。
- **备份范围补 `.mcp.json`**（category `mcp-config`）：备份清单从此携带用户级 MCP servers 事实标准配置（inject 的源条目）；新增 `readBackupEntryBlobs`（口令解密按谓词取包内条目原文，纯读不落盘）。
- **生命周期闭集新增**：`absorbed-write`（记忆写回正向回执）与 `config-injected`（配置写回正向回执）——写回动作全部入账本。
- **文档**：README「只读承诺」措辞改为「读取零写入；写回仅记忆/配置且两步确认、原物可回滚」；THREAT-MODEL 新增 T8（写回面：显式授权、闭集注册表、会话存储零写入硬线、快照可回滚与诚实残余风险）。
- 质量闸：新增 `tests/writeback.spec.ts`——confirm 缺省拒零写盘、去重幂等、快照回滚、多目标各留各账、**会话存储零写入全树指纹对账**（负向断言）、无映射家诚实拒绝；`tests/tier2-demo.spec.ts` 以子进程整跑 `scripts/demo-tier2.mjs` 守门（退出码 0、全链横幅在场）；typecheck 零错误、全量测试 **460** 全绿（2026-11-16 实测，`npm run check` + `npx tsc -p tsconfig.json --noEmit` 双跑确认）。

## [0.2.0] — 2026-11-12

四轴贯通完整版：会话 / 上下文 / 记忆 / 配置四轴协议内立约（各卡带 `axis`/`payload` 轴标记）、同走一根同步链跨机——「寄存 A 机、取件 B 机」从一句文档变成两条命令。卡同步走用户自己的 git 仓库（零存储凭据），环境备份是单文件加密包随同步走。

- **四轴 IR 立约**：卡片 extras 的 `axis`（session / memory / config）与 `payload`（files / distilled / manifest）协议内立约——会话卡、记忆卡、配置卡各归其位，取件方按标记决定「接着干 / 按条目吸收 / 先预演再落盘」；旧卡无标记按会话卡处理，round-trip 不丢。
- **repo 基线**：寄存时采集 origin / HEAD / 分支三元组进 `extras.baseline`，取件方按 clone → checkout → apply → 跑测试四步复原寄存现场（remote/head 拿不到如实降级为说明行，不写空壳假基线）。
- **上下文物质层**：未跟踪新文件（单件 <64KB）手拼新增 diff 随补丁走，超大/二进制只列清单；补丁超 512KB 先 gzip 压缩随卡、压缩后仍超则 480KB 分块 `.patch.NNN.gz`——最需要带走的时刻也带得走，取件侧按 gzip magic 自动解压重组，解压失败原样归档并如实警告。
- **救生艇**：设置卡「🛟」一键——上下文炸了模型吐不出工具调用时，`POST /dsh-takeover/lifeboat` 不经模型把当前会话事件流确定性抢出成卡（空壳闸按救生艇语义放行，密钥闸不旁路），同步已启用时自动 syncNow 推走；出卡记生命周期 `lifeboat` 事件留痕。
- **配置载荷卡**：`handoff_env action=card` 把最近一次备份的清单（path/category/sha256 + backupFile 指针 + bytes）写成 axis='config' 载荷卡寄存进收件箱——writeCard + 信封签名全套纪律，密文 blob 仍在 env-backup/ 随同步盘走，口令永不进卡。
- **记忆轴贯通**：记忆卡 `payload='files'` 立约随卡；引擎型记忆库（hippo 等）走通用 MEMORY_STORES 掏取契约——条目 JSONL 在场掏条目进「建议加载」段、缺席退回指引；取件即出「记忆已随卡注入」吸收回执（生命周期账本新记 `memory-absorbed`）。
- **卡链检索**：`handoff_inbox action=history` 按 project / cwd 回查 archived/ 已归档卡（id/标题/寄存时刻/停点摘要/接替 supersedes，时间正序尾 50 条）——接力链可溯，supersedes 走卡面 extras 持久通道。
- **provider 注册表收敛**：`src/providers.ts` 单一真源，消灭读取器名表/适配器映射/skill 规格四份平行表的漂移面。
- **换机上下文同步 `handoff_sync`**：设置卡「换机」页填一个私有 git 仓库地址即启用；`setup` / `now`（拉推一步到位）/`push`/`pull`/`status`。HANDOFF_HOME 即工作树：pending/archived 全部卡与机器信封 + 签名密钥 + 环境备份包随仓库走，机器本地记录（生命周期日志/取件溯源/插件开关）经 .gitignore 不入版本库。已消费的卡经 archived tombstone 不在另一台机器重放；合并冲突中止并诚实报错，本地文件原样保留。安全面：插件零存储凭据（userinfo 形态 URL 入口拒收），git 子进程超时硬杀 + 禁交互，仓库本地强制 autocrlf=false（卡字节是信封签名面）。state 路径零网络——30s 轮询不碰任何网。
- **环境备份/恢复 `handoff_env`**：DSH 全家桶（settings/插件登记五件套/会话库/智能中枢登记/~/.agents/skills/ZCode 用户层）打包单个 .dshenv 加密文件（纯 node 容器，scrypt+AES-256-GCM，口令永不落盘），随同步跨机。恢复三段纪律：`dry` 预演（新建/覆盖/相同三态 diff）→ `apply`（confirm 确认，被覆盖原物自动 checkpoint）→ `rollback` 一键回滚。凭据类文件只存在于加密包内；路径穿越硬闸；node_modules/缓存/日志排除（5.9G 压到 <60M）。
- **同步盘换机契约**：五条不变量钉死——Syncthing/OneDrive 冲突副本同 id 去重不幻影、原件已消费的迟到副本进可见拒收清单、半截文件拒收可见不塌收件箱、HANDOFF_HOME 链接目录全链穿透、消费即弃跨机不重放。
- **设置卡**：「换机」「环境」两枚新页签（五页签 + 方向键导航不变）；概览新增同步状态瓦片（落后数即待办）。
- **Windows 4 红清零**：vendor readers 陈旧链 bump（gemini 适配器落地本机）+ .gitattributes 全仓源码钉 LF + 文档断言行尾归一化。
- 质量闸：测试 **386** 全绿、typecheck+build 干净；双 home + 裸远端真 git 集成测试（换机六场景 + 四轴贯通全链）；THREAT-MODEL 新增 T7（环境备份面）并修订 T6（网络面唯一例外 + 救生艇无模型旁路）。

## [0.1.0] — 2026-11-02

首发版。功能面：九家外部会话读取器（claude / codex / opencode / zcode / pi / workbuddy / cursor / grok / gemini）、`handoff: 1` 协议收件环、信封机器签名、单卡忽略、记忆快照交接、接力工作台（导航轨 + 四全宽视图指挥台）。

- 文档：README 双语重写为场景驱动版——徽标 hero、三场景、30 秒安装与上手指南、工作原理速览、工具与命令参考。
- 质量闸：测试 327 全绿、typecheck + build 干净。

## [0.4.5] — 2026-11-01

指挥台版：浮层重排成导航轨 + 四全宽视图——收件箱概览瓦片化、设置卡三段页签化、`--tk-*` 语义 token 落地；设计宪法 DESIGN.md 首次引入，实现按其执行。

- **工作台导航轨 + 四全宽视图**：两栏拼盘废除，改为 148px 左导航轨（logo + 收件箱/会话浏览器/交接/记忆快照四视图 + 上手指南 + 版本徽标）+ 右侧全宽视图；四视图常驻挂载、display 切换保状态，视图头=标题 + 一句副标 + 过滤输入 + 视图级动作，视图内滚动、头部与导航轨常驻。
- **收件箱概览瓦片化**：统计胶囊升级为一行大数字瓦片（19px tabular 大数字 + 小标签 + 左缘 3px 语义色条）——待取件/已存档/可查证/信封/拒收五枚常驻，重复卡热态追加一枚，窄容器自动换行。
- **设置卡三段页签化**：一屏长滚动废除，改为分段器三页签（命令速览 / 支持矩阵 / 开关语义）；`button[role=tab]` + `aria-selected`/`aria-controls` + 方向键导航，[?] 帮助与刷新常驻卡头。
- **`--tk-*` 语义 token 落地**：表面/描边/文字/品牌渐变/状态三色全部收敛为 CSS 变量——一处引用一处定义，组件禁止裸色值，状态三色闭集映射全局唯一。
- **设计宪法 DESIGN.md 首次引入**：按 Google Stitch 九段约定固化指挥台设计系统，绑定纪律=改 UI 前必读、改设计先改本文件再改代码；本版实现按其执行。
- 质量闸：测试 **320** 全绿、typecheck+build 干净；构建产物徽标经 esbuild define 注入验证（`lib/client.js` 含 `v0.4.5`）。

## [0.4.4] — 2026-11-01

信用版：卡带上机器签名、收件箱装上「忽略」、读取器进到第九家——「诚实交接 + 最小惊扰」两条原则落到字节层。

- **信封机器签名**：首次 push 自动生成总线密钥 `.signing-key.json`（密钥同步域=信任域）；签名面=信封全字段+卡面 `cardSha256`——未持钥改卡面（信封原样）同样可检出。取件侧三态裁决 `ok / tampered / no-key`（跨信任域绝不误报篡改），篡改进死亡地图新理由 `sig_tampered`，取件渲染 🔐/🚨 行；未签名旧卡完全兼容。诚实边界：持全权者连密钥一起换防不住——总线文件的系统权限是最后防线。
- **pending 单卡忽略**：工作台卡行「忽略」按钮 + `POST /dsh-takeover/dismiss-pending` + `dismissPending`——卡/信封/patch 边车三件原样移入 `archived/`，id 消毒防路径穿越；全新总线无 `archived/` 时先建目录。
- **第九家读取器 Gemini CLI**：`/resume-gemini` + list/show 全链——JSON/JSONL 双格式、子代理嵌套、`.project_root` cwd 还原；图标走中性兜底；`OUTBOUND_TARGETS` 不加 gemini（交接目标与读取器两轴独立）。
- **记忆探测路径修正**：hippo-db 探测从遗留 `memory.db` 改到现役 zvec 位置（`~/.hippo` 系）——记忆快照 tab 在现部署下显示真实记忆库。
- **项目身份系统（会话浏览器）**：cwd 确定性哈希 → 十色板——项目筛选 chips 与会话行同源同色（彩色文件夹图标 + 选中态项目色描边 + 行首项目色左缘条 + 行内同色项目标），456 个会话的长列表滚动中「哪片是哪个项目」一眼可辨；空 cwd 归中性灰不占身份位。
- **交接目标图标化**：「交接给谁」八家目标补品牌图标（与来源 pills 同款），裸文字钮退场；任意 agent 用本插件品牌小标。
- **版本徽标自动化**：`v0.4.x` 徽标从 client.ts 手写常量改为构建期经 esbuild define 注入 package.json 版本——发版不再漂移（0.4.3 时代它停在旧值无人察觉）。
- **测试基建信用修复**：`tests/secret-gate.spec.ts` 三处 `pushHandoff` 缺 `{ dir: home }`——每次全量测试向真实 `~/.handoff` 泄漏一张骨架卡 + 账本拒收事件（历史残留卡的增长规律由此解释），修复后以「跑前跑后 pending 数与 lifecycle 行数双不变」验证；smoke-foreign 技能数断言跟上九家（10→11）；smoke-userflow 上总线隔离守卫（默认拒真实总线，`--allow-real-bus` 逃生）+ act5 文案纠偏。
- 质量闸：测试 **314** 全绿、typecheck+build 干净；真宿主浏览器点击链复验（三段 tab/忽略链：通知行、16→15、archived 三件套盘面核对）；密钥闸实战佐证——工作区 diff 含测试夹具串时 patch 边车扫描当场拦截 push（设计行为，假阳性按 redact 指引处理）。

## [0.4.3] — 2026-10-28

居中模态版：接力工作台浮层从「锚定接力按钮位置弹出」改为**真正的视口居中模态**（inset:0 + margin:auto + fit-content，双轴居中）——多台机器、任意窗口尺寸下面板不再偏移；与宿主滚动完全解耦（移除捕获阶段滚动监听）；宽度三档分档与高度自适应保持不变。

## [0.4.2] — 2026-10-27

设计语言版：收件箱浮层对齐 Linear 式六支柱（表面分层 / 字体阶梯 / 渐变收敛 / 动效 token / 间距网格 / 细节微光），纯视觉层，数据流与工具语义零改动。

- **三级表面 + 描边浮现**：卡片与预览块改为「极淡底 + 1px 描边 + 顶部 1px 内发光」的浮现式呈现；卡行 hover 才浮现描边（30s 轮询长列表不成卡海），未读行保留常驻品牌描边。
- **字体阶梯收敛**：14（标题，负字距）/ 13（行标题）/ 12（正文）/ 11（meta）/ 10（徽标）五档制度化，`.bt-title-sec` 二级标题类替换全部行内覆写。
- **渐变收敛 + 徽标降饱和**：品牌渐变只保留未读强调条与主按钮；「新 / 空卡 / 接力自」徽标改低饱和底 + 同色描边。
- **动效 token 化**：`--bt-ease` / `--bt-dur` 统一缓动与时长；未读强调条 scaleY 展开；骨架脉冲与全部动画带 `prefers-reduced-motion` 降级。
- **骨架屏**：收件箱冷启动显示脉冲骨架条，替换「加载」纯文字；暗轴补 `--bt-hover` 覆写保证骨架可见。
- **测试夹具去本机路径样式**：relay.spec 的 `D:/fixture-ws` 虚构串改 `D:/fixture-ws`。
- 质量闸：独立设计评审（未参与实施者冷读 diff）high/medium 意见清零后合入；测试 300 全绿。

## [0.4.1] — 2026-10-26

归因版：0.4.0 建了证据基建，0.4.1 让证据开口说话——每个数字能回答「为什么」，每个改进能指出「归因结论第几条」。

- **死亡地图（拒收证据结构化）**：新增卡片生命周期事件层 `src/lifecycle.ts`——写侧（密钥闸/空壳闸拒收）与取侧（git 核验 MISMATCH/UNAVAILABLE）事件持久化 `~/.handoff/lifecycle.jsonl`（闭集理由 + 尾 500 封顶），读侧坏卡跳过进 state 活性视图；收件箱概览新增「拒收 {n}」徽标与悬浮明细。多写方场景「寄了没消费」从此可自检。
- **失败归因管线**：`scripts/attribution.mjs` 三源合并（lifecycle 事件 + relay 记录 + archived 回测）出闭集死亡分类——写侧拒收 / 读侧跳过 / **僵尸卡（relay 有取件记录但卡未被消费）** / 存活 / 执行死亡 / 不可归因 / 在册。首轮实测：僵尸卡 10 张（三臂实验取证：取件会话在卡 id 不合规时会绕过收件工具直接读文件，消费即弃被架空）。
- **三臂对照实验**：`scripts/eval-three-arm.mjs` + `scripts/section-utility.mjs`（行为探针法——不可猜测事实埋进 warnings 段，接手产物逐一检验存活）。隔离收件箱首轮结果：structured 3/3、plain 3/3、minimal 任务完成 3/3 但 marker 探针 **0/3**——诚实结论：强模型小任务下结构化不提升完成率，**交接卡的价值在传递不可猜测的运行态事实**（带交接 6/6 vs 无交接 0/3）；阴性结果如实入档。
- **评测可复现包**：`eval/README.md` 预注册口径（臂设计/探针/统计声明/复现步骤/隐私纪律）——同脚本可追加轮次，第三方可重跑同数字。
- **蒸馏反哺**：50 张真实卡回测结论（done 段带账本标注的卡延续率 50%、无标注 0%）写进 `skills/handoff.ts` 写卡纪律——标注纪律从形式要求升级为有数字支撑的接手成功率分水岭。
- 质量闸：测试 276 → **300**（生命周期/归因/探针三套新测试），全量绿。

## [0.4.0] — 2026-10-21

深度版本：五层证据基建——接力质量从「感觉」变成「数字、测试与第三方可复核的证明」。

**真机验收收尾（2026-10-23 补）**：全流程真实浏览器验收后落地——记忆卡折叠栏去重（双图标/双文案）、两处 [?] 打开帮助即滚至卡顶、导出入口合并为「导出 ▾」菜单、「只看新卡」从来源 chips 独立为复选框未读开关、浮层双列各自内滚（标题栏/横幅固定，窄容器退化为整体内滚）、已消费徽标改为「已存档」口径并在悬浮提示披露 archived/ 的 50 张滚动保留策略。收件箱组件高级化：统计条改软胶囊（热态品牌描边）、卡行卡片化（hover 描边、未读行首品牌渐变强调条——该类名此前从未有样式）、展开预览内嵌软面板、筛选行合并（未读开关与来源 chips 同行）、双列细滚动条。

- **解析层**：真实会话结构克隆脱敏语料（`scripts/corpus-build.mjs`）+ 13 份 golden files 逐字节回归闸（`tests/corpus-golden.spec.ts`）+ 已知生态事故回归（上游存储布局漂移 + BOM/CRLF 边界）+ 恢复语义故障注入（`tests/recovery.spec.ts`）。挖出并修复两个真缺陷：Windows 并发 rename 双成功击穿消费即弃保证（core 引入独占创建认领文件仲裁 + 过期自愈）、补丁孤儿崩溃窗口（清扫扩展到补丁）。
- **质量层**：首个接力质量基线——50 张真实 archived 卡回测延续率 34.7%，且账本标注率高的卡延续率 50% vs 无标注 0%（`scripts/backtest-archived.mjs`）；端到端双卡接力真 host 真模型评测 PASS（`scripts/eval-e2e.mjs`）；蒸馏保真度评测器（`scripts/eval-distill.mjs`）。附带修复：`<local-command-*>`/`<command-name>` 命令回声不再冒充用户请求进 goal。
- **安全层**：`THREAT-MODEL.md` 六类威胁 + 红队套件 8 组进 CI（`tests/redteam.spec.ts`）。修复红队驱动出的缺口：补丁 diff 密钥走私（diff 现过密钥闸）、赋值规则短口令漏网（值下限 14→8 带字符混合要求）。
- **协议层**：`conformance/`——handoff: 1 可执行符合性套件（11 条要求推导自 SPEC 原文，零依赖）。参考实现与独立第二实现（实现者只读 SPEC，与两仓代码零接触）双双 9/9 MUST 符合；第二实现暴露的 10 条规范歧义记录在 `conformance/SPEC-NOTES.md`。
- **互通层**：INTERCHANGE v1（dsh-chat-import）↔ handoff: 1 双向转换（`scripts/interop-interchange.mjs`，bundle 双层 sha256 校验 + 确定性蒸馏）。真实交换验证：转换产物经对方插件 v0.26.2 真实 `import_chat` 导入成功。

## [0.3.0] — 2026-10-20

Relaying goes bidirectional, and memory joins the loop.

- **Send out**: the workbench grows an outbound card — one click queues the deposit instruction into the *current* DSH session; the agent distills and checks the card into the shared inbox, and the other side (Claude Code / Codex / any agent) pastes the per-target pickup instruction shown under the card. Falls back to copying the instruction on hosts without the session controller.
- **Memory snapshot**: a new card (and a `handoff_memory` tool) scans each agent's local memory files — `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.zcode/AGENTS.md`, `~/.config/opencode/AGENTS.md`, `~/.cursorrules`, project-level AGENTS.md / CLAUDE.md / .cursorrules, plus a dsh-hippo store probe with the official `/memory dump` / `/memory import` interop path — and packs the selected ones into a handoff card in the inbox. Secret gate, skeleton gate, coverage ledger and machine envelope all apply, same as session cards.
- **Beginner pass**: a built-in FAQ card (8 entries, zh/en) ships in the workbench and the settings card; the coverage badge is renamed 「可查证 / Evidence」, the envelope stat is humanized (7426 → 7.4K) with a plain-language tooltip, foreign sessions without a human title get one sniffed from their first user message, and the browser's provider pills now carry brand icons.

## [0.2.3] — 2026-10-19

Two-column relay workbench: the popover widens to a side-by-side layout — inbox overview on the left, external session browser on the right — collapsing back to a single column in narrow containers. Visual polish aligned with the product one-pager.

## [0.2.2] — 2026-10-17

Relay provenance store: every takeover, takeover-with-deposit, and directed pickup writes `<HANDOFF_HOME>/relay/<sessionId>.json` — which external agent and session (or which inbox card) a session came from, timestamped. Durable in the plugin's own store, cross-machine via `HANDOFF_HOME` sync. The host's experimental plugin-record append stays layered on top as best-effort.

## [0.2.1] — 2026-10-16

Relay provenance in the session log itself. Takeover, takeover-with-deposit, and directed pickup now append a first-party record into the DSH session log through the host's experimental plugin-record API (`@deepseek-ai/dsh-session ≥0.2.1-alpha.2`): which external agent and session (or which inbox card) a session came from, timestamped, written right after the delivery lands. The record is an ignorable event — it never enters model context, rides along with forks and resumes, and survives as durable proof of a session's origin. Best-effort by design: on hosts without the API the plugin behaves exactly like 0.2.0.

## [0.2.0] — 2026-10-10

First public release. Cross-agent session takeover for DeepSeek Harness: pull, deposit, and take over work across eight external agents over the open `handoff: 1` protocol.

### Added

- **External session browser + inbox workbench** (a compact "Relay" chip in the composer toolbar — click it in any session to unfold a floating workbench): browse the most recent sessions of eight external agents — Claude Code, Codex, OpenCode, ZCode, Pi, WorkBuddy, Cursor, Grok — with titles, relative times, project facets, instant filtering, and expandable per-session previews (turn counts, first user request, recent progress, stop point, warnings), plus the consume-once inbox overview with directed pickup, relay-chain filtering, and exports. Readers are lazy: nothing is scanned until you select a provider. The settings card stays settings-only: command quick-reference, reader toggles, and a pointer to the chip.
- **One-click takeover**: *Take over* / *Take over + deposit* on any listed session creates a new DSH session, delivers the takeover command, renames the session for findability, and switches the app to it automatically. Delivered payloads are identical to the copyable commands; any failure falls back to the clipboard path automatically with the reason surfaced.
- **Directed pickup**: every inbox card has a *Pick up* action that creates a session and delivers a pickup command naming that exact card.
- **Handoff cards** (`handoff: 1` open protocol): six-section cards with a four-state evidence ledger (CURRENT_OBSERVED / HISTORY_REPORTED / MISMATCH / UNAVAILABLE), consume-once pickup, and a patch sidecar (uncommitted changes ride with the card as a `.patch`; rejected above 512 KB rather than truncated).
- **Relay-chain visualization**: cards carry a "← supersedes <id>" badge with one-click chain filtering; chains are verified across hops.
- **Shared-inbox relay across machines**: point `HANDOFF_HOME` at a synced folder or git repository and the inbox is shared — deposit on one machine, pick up on another (or from a phone file viewer).
- **Subagent session grouping**: workflow/subagent sessions are folded into a collapsed group so the main list stays work-only.
- **Project facets & instant filtering** in the browser; per-session structured previews are fetched on demand and never include raw transcripts.
- **Copy-command fallbacks**: every takeover action has an identical copyable command; reference parsing accepts id, path, title keyword, or `latest`, and cuts at the first newline so a trailing instruction never breaks resolution.
- **Exports**: single-card and all-card `.md`, plus a self-contained HTML report.
- **Distillation fidelity benchmark**: a re-runnable probe suite over real sessions (deterministic layer).

### Security

- Loopback-only panel: every route rejects non-loopback connections regardless of headers; POST routes additionally require same-origin, and identical takeover requests within a short window are deduplicated.
- Secret gate on deposit: credential-pattern scanning with redaction guidance; bypasses are recorded on the card.
- Skeleton gate: all-placeholder cards are rejected unless explicitly confirmed.
- Read-side size gates for cards and envelopes; task-snapshot caps.
- Provider disable switch enforced uniformly across reads, previews, and takeovers.
- Read-only discipline: foreign session stores are never written; no network access beyond the loopback panel.

### Fixed

- Inbox new-only filter inversion; stale-response race on the 30s poll; lost-update race on provider toggles.
- First-run degraded state (missing `pending/` no longer reports an inbox error).
- Orphan-envelope cleanup now preserves envelopes whose card file is still on disk.
- Facet filters can no longer become invisible stale filters across provider switches or queries.
- Several accessibility fixes (ARIA roles, keyboard focus rings, no nested interactive elements, locale-safe labels).
- Build pipeline: template-escape corruption in the unbundled client build no longer affects copied commands or `.md` exports.

### Quality

- 207 automated tests (unit, route-level and UI-render) all green; CI runs typecheck + the full suite + the build on every push and PR.
- Verified end-to-end on a live host: takeover-with-deposit of a 7,284-turn session completed in ~50s with full ledger coverage; directed pickup consumed a card in ~40s; a scripted end-to-end run (browse → takeover → deposit → directed pickup) completed with zero typing.
