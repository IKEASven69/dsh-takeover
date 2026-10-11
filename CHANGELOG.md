# Changelog — dsh-takeover

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
