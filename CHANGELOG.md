# Changelog — dsh-takeover

## [0.4.0] — 2026-10-21

深度版本：五层证据基建——接力质量从「感觉」变成「数字、测试与第三方可复核的证明」。

**真机验收收尾（2026-10-23 补）**：全流程真实浏览器验收后落地——记忆卡折叠栏去重（双图标/双文案）、两处 [?] 打开帮助即滚至卡顶、导出入口合并为「导出 ▾」菜单、「只看新卡」从来源 chips 独立为复选框未读开关、浮层双列各自内滚（标题栏/横幅固定，窄容器退化为整体内滚）、已消费徽标改为「已存档」口径并在悬浮提示披露 archived/ 的 50 张滚动保留策略。收件箱组件高级化：统计条改软胶囊（热态品牌描边）、卡行卡片化（hover 描边、未读行首品牌渐变强调条——该类名此前从未有样式）、展开预览内嵌软面板、筛选行合并（未读开关与来源 chips 同行）、双列细滚动条。

- **解析层**：真实会话结构克隆脱敏语料（`scripts/corpus-build.mjs`）+ 13 份 golden files 逐字节回归闸（`tests/corpus-golden.spec.ts`）+ 竞品事故回归（casr #10 一族 + BOM/CRLF 边界）+ 恢复语义故障注入（`tests/recovery.spec.ts`）。挖出并修复两个真缺陷：Windows 并发 rename 双成功击穿消费即弃保证（core 引入独占创建认领文件仲裁 + 过期自愈）、补丁孤儿崩溃窗口（清扫扩展到补丁）。
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
