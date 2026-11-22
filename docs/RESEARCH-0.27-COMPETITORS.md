# 会话接管/交接/多机赛道竞品功能调研

> 调研时间：2026-11-22
> 方法：GitHub REST API、npm registry、raw README、中文目录站、websearch
> 用途：dsh-takeover 0.27 及后续版本的功能面参考；区分「撞位/红海」与「空位」。

## 证据标注

- 【事实】有 GitHub API / npm / 一手链接可查
- 【推测】基于证据的判断
- 星数/更新时间均为 2026-11-22 抓取快照，口径可能与目录站有差异，以 GitHub/registry 实测为准

---

## 一、生态大盘（为什么功能面不能盲目铺）

| 目录站 | 插件数（快照） |
|---|---|
| dshcrate.com | 47,313 |
| plugin.dshdesk.com | 26,787 |
| deepseekplugin.cn | 23,924 |
| dsh-market 官方 | 12,000+ |
| 官方 11-05 数据 | 日活 154 万，第三方插件 3.5 万，60% 用户装过插件 |

**结论**：通用功能位已被填死。新插件要么切极窄的缝，要么做别人做不了的工程深度。这是 0.27 不盲目堆功能面、先做体验的根本原因。

---

## 二、跨 agent 会话接管/导入类（takeover 的直接对标）

### 竞品定位速览

| 项目 | 一句话定位 | stars |
|---|---|---|
| FrozMN/dsh-session-adopt | 运行时收养 + 本机跨 harness 导入，把 pi 会话合成为原生 DSH v4 会话（侧栏 picker + JSON API） | 0 |
| uu88s/dsh-session-handoff | 反向交接：DSH → Codex 原生 rollout，给 `codex resume <id>` | 0 |
| changhang155/dsh-plugin-claude-import | Claude Code 单向上下文导入，明确拒绝事件回放 | 1 |
| yangyizhu8/dsh-session-handoff | DSH 内部会话移交，八节接手包 + takeover protocol v1 + watchdog + readback 白名单 | 1 |
| aa2246740/dsh-resume | **功能几乎重叠**：`/resume-*` 六段卡 + 四态标注，8 家（Codex/Claude/Cursor/Grok/Pi/Qoder/WorkBuddy/ZCode） | 8 |
| Chang-Tong/dsh-unified-context | 同类最热：5 家会话完整可 resume（含 tool result）+ AGENTS.md/skills symlink 单一真源 + composer Sync 按钮 | 22 |
| zhukeu2-lang/dsh-takeover | 同名参照：Windows 桌面版右键移交，六段/最近20轮/自动读取三模式 + 交接文档清理页 | 1 |
| **@cold777/dsh-takeover（本产品）** | 23 家只读拉取 + `handoff: 1` 开放协议 + 跨机器 + 四轴一卡 + 救生艇 | 2 |

### 功能覆盖对比（本产品的领先与落后）

**领先【事实】**：
- 源覆盖断层领先：23 家 vs 竞品 0–8 家
- 唯一打通「跨机器 + 四轴交接」：`handoff_sync` git 同步 + tombstone + 全环境加密备份
- 开放协议有第三方背书：独立第二实现从 SPEC 手写 + conformance + 与 dsh-chat-import INTERCHANGE v1 互通
- 证据/安全体系最严：四态账本、机器签名三态、14 份 golden、8 组红队随 CI、T8 硬线
- 工程严谨：754 tests（0.26）vs 竞品多数 0–29

**落后【事实 + 推测】**：
1. **缺「何时该交接」的主动预警**：compact-relay 有四色环 + 原生压缩线 + 「交接线已晚」警示，session-matrix 有真实压缩点算法 + 压缩次数判定，Session Watcher 有 EOQ 账单模型
2. **缺常驻可视化与交接链导航**：竞品最强易用性资产是「看见就该点」——环形指示器、底栏胶囊、每条回复按钮、接力条双向跳转
3. **「一条命令原地续接」形态不同**：Session Watcher `/sw-continue` 原地清空续接、compact-relay `/handoff` 自动开新会话并注入切换；本产品 `/resume-*` 是把卡注入当前会话，不是干净新会话
4. **手机端最大落差**：dsh-mobile 扫码直连/实时看进度/点批准/回消息/任务完成推送；本产品只有「同步盘里的卡手机可读」
5. **社区势能偏弱**：2★ vs session-watcher 6★ / compact-relay 4★；npm 周下载 713 vs session-matrix 2868 / xwide 1149
6. **门面元数据滞后**：GitHub description 曾写「九家」（现已改「二十三家」，以发布时实测为准）

### 竞品机制（0.27 只借思想，不抄代码）

| 机制 | 代表 | 可迁移点 |
|---|---|---|
| 侧栏 Import picker（1击同步 + 勾选导入） | dsh-session-adopt | 一键接管入口 |
| dry-run 预演 + 预检 + 可撤销（形状不对宁可报错不硬写） | uu88s | 交接预览-确认 |
| 五段摘要 + 预览确认 + 原会话不动（95% vs 裸重启 55%） | dsh-plugin-bridge / #2984 | 可审查现场包 |
| 八节接手包 + readback 按需回溯（原文不携带） | yangyizhu8 | `show --with-context N` |
| composer Sync 按钮 + symlink 单一真源 | dsh-unified-context | 一键动作 + 一致性 |

---

## 三、交接卡 / compact 续接 / 跨设备类

### 机制分类

| 类 | 代表 | 核心解法 |
|---|---|---|
| A 压缩+换会话交接 | compact-relay、auto-handoff（三家同名）、handoff-button、xwide | 阈值到→生成交接文档→开干净新会话注入 |
| B 交接链导航 | compact-relay | 父子指针、双向跳、最多8层、归档恢复 |
| C 提示词协议/手动 | session-matrix、token-handoff | 插件生成提示词，人自己粘 |
| D 经济学择时+原地续接 | Session Watcher | EOQ 模型 + `/sw-continue` |
| E 手机/跨设备实时连接 | dsh-mobile、dsh-carry | 不搬上下文，直连原会话 |
| F 跨 agent 开放协议收件箱 | 本产品、agent-handoff | 文件系统即总线，卡是可移植数据 |

### 关键竞品机制

- **dsh-compact-relay**（v0.5.8，4★）：28px 环形占用指示器（灰/蓝/琥珀/红 + 原生压缩线红闪）+ 九段 `/handoff` + 接力条完整交接链（按需读取、双向跳转、最多8层、成环停、归档自愈、强制归档二次确认）。**交接链可视化产品级最成熟**。
- **Session Watcher**（nomadop，6★，有 DOI 论文）：EOQ 库存理论映射 prompt cache，算「继续付费 vs 重启重建」账单溢价 `br`，灯色 + 告警时钟 + 分桶预览；`sw-handoff` skill 写包 → `/sw-continue` 一条命令原地清空续接（`/sw-load` 不清空需确认）。
- **dsh-session-matrix**（Wanqiu12345，3★，周下载 2868）：多栏原生会话并行（2–4 格）+ 智能体脉络图（真实 parentSession 边）+ 压缩点算法预警 + **压缩次数决定要不要交接**（0次不推、1–2次推、≥3次升级）。
- **dsh-xwide-handoff**（XWIDE，1★，周下载 1149）：`/handoff <重点>` → 结构化卡 + 新会话自动命名/置顶/归组，`autoReady` 半自动（占用≥0.7 自动备棒，默认关）。
- **dsh-handoff-button**（whiteS18，0★，周下载 254）：每条 AI 回复底部圆形按钮 → LLM 写五段文档落盘；**不建新会话、不注入**，需人肉搬运；有 LLM 不可用时的启发式降级。
- **@orderg-x/dsh-mobile**（3★，周下载 359）：扫码在手机浏览器用电脑那个 DSH，Cloudflare 免费隧道，会话实时同步，Bark/ntfy/Server酱推送「跑完/待批准」；网关代持登录态（手机不持凭证）。
- **dsh-carry**（winlin926，3★，372 tests）：手机扫码 → 远程继续会话、审批工具、看工作区文件/HTML 预览。

---

## 四、多机/fleet 赛道（termfleet 搁置的参考）

### czhmisaka/dsh-fleet（重点竞品）

**不是 termfleet 被整包做了**——它做的是机器级多机可观测性面板，**没碰**同意总线、审批、插话、任务板、团队记忆、PTY。

- 版本 v0.6.0（11-20），3★，MIT，创建 11-18，**两天 13 版**，单人高节奏，无 npm 包（只 GitHub 分发）
- 完整功能：多机实例栏、跨设备会话总表、面板内打开远端会话、看板嵌入（各机 :40005）、远程启动会话、用量总览（tokens/费用/缓存/TOP50）、上下文压力（70/85%）、预算告警、DSH 助手（内嵌 master 真实会话 + fleetctl dispatch 派任务到最空闲实例）、3D 办公室（Three.js 等距场景 + 语言气泡）、主从角色、安全默认（cookie 只存 master、127.0.0.1、无 key 401）

**与 termfleet 逐项对比**：它覆盖「多机」一格且很深；「同意/审批、插话、任务板、团队记忆、PTY、审计流」六格基本没做。它的模型是 master 集中持有从机 cookie、从机无条件——与 termfleet 的成员主权正好相反。

**市场拥挤度**：叫 `dsh-fleet` 的 GitHub 仓库至少 11 个，npm fleet 类至少 9 个（scriptsnet/dsh-fleet、dsh-fleet-monitor、dph-fleet→dsh-devices、dsh-team-conductor 等）。「机器级 fleet」极度拥挤，但「人对人 + 同意治理」层仍是空位。

### 市场趋势判断

- 别人的 takeover（zhukeu2-lang）：1★，创建后 46 分钟完工、疑似停更；占通用 npm 包名 + 目录站默认条目 + dsh.so L5 徽章；但本产品周下载 713 vs 它 214（3.3×），功能碾压。**威胁在品牌/命名维度，不在功能维度**。
- 多机面板赛道已被 czhmisaka/dsh-fleet 与 dsh-team-conductor 做深；通用团队面板胜算低。

---

## 五、市场/目录站格局（dsh-market + 社媒）

### dsh-market 现状
- 官方是 cordis 插件 + 安装 UI，本身不策展，实时拉 `awesome-dsh-plugin.com/plugins.json`；GitHub 13,103★、npm `dshmarket@1.78.0` 周下载 27 万
- 空白从「市场 UI 元能力」转移到**策展/证据层**（评分、反灌水、安全扫描结果可信度），正被目录站和官方下载榜瓜分

### B站/微博社媒
- B站热度极高：官方号 301.1 万粉；记忆类插件视频 15.6 万/13.8 万播放；「真实下载榜 Top10」28.9 万播放——中文用户对记忆 + 真实数据选插件敏感
- B站工具插件泛滥并进入治理阶段（「大肥鱼灾」→ 反制插件）
- **微博**：未搜到公开讨论（如实报告）
- 一手需求信号：GitHub Discussion #13522（用户出门后手机没法继续审批/回答问题/多会话管理）——验证「远程审批 + 继续工作」是真需求

---

## 六、总结：功能面该不该铺

| 方向 | 判定 | 依据 |
|---|---|---|
| 跨 agent 读取器扩张 | 护城河已建立（23家），边际收益递减 | 竞品最多 8 家 |
| 交接卡 UI 形态 | 红海，别再做新形态 | dshfind #handoff 38 款 |
| 多机通用面板 | 红海且被做深 | fleet 类 20+ 项目 |
| 择时预警 / 原地续接 / 常驻可视化 | 竞品有、本产品弱——**体验差距，0.27 补** | compact-relay / Session Watcher |
| 手机只读面 / 签收可见 | 空位（真·直连推送是新功能面，留后） | dsh-mobile 有直连，交接类没有 |
| 可诊断 / 失败原因码 / 预览确认 | 空位且用户骂得最狠 | cfanzx #3、#9635、#2984 |

**一句话**：功能面护城河（23家+协议+跨机）已经够了；0.27 该补的是竞品早已验证、用户真实在骂的**体验与可诊断性**，而不是再堆新家数/新形态。
