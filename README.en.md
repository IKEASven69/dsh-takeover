<p align="center"><img src="assets/icon.svg" width="72" height="72" alt="dsh-takeover logo"></p>

# dsh-takeover · Session Takeover Plugin

**Pull, push, take over: pull sessions from eight foreign agents, check in the current one, pick up where they left off — sessions and memory both, in either direction.**

> **Why "takeover"?** Because that is exactly what happens: a session another agent left half-done is yours to take over and drive.
> The protocol layer keeps the industry-generic word *handoff*; the product owns *takeover*.
>
dsh-takeover is a DeepSeek Harness (DSH) plugin implementing the full takeover loop of the open `handoff: 1` protocol (see SPEC.md in the sibling repo agent-handoff):

- **Pull**: `/resume-claude` `/resume-codex` `/resume-opencode` `/resume-zcode` `/resume-pi` `/resume-workbuddy` `/resume-cursor` `/resume-grok` — read-only pull of a foreign agent's local session into the current one, distilled into a six-section protocol card;
- **Push**: `/handoff` + `handoff_push` — check the current session into the shared inbox as a handoff card;
- **Take over**: `/inbox` + `handoff_inbox` — any agent picks up on start; pulled sessions can optionally be checked in too, so another agent can relay the work.
- **Browse + one-click takeover** (a "Relay" chip inside the session composer): no commands to memorize — click it to unfold a floating workbench listing recent sessions of all eight agents (title / time / project, expandable previews with the first user request and stop point), click **Take over** to spawn a new session with the command delivered and the app switched to it automatically; on failure it falls back to copying the command.
- **Send out** (bidirectional): relaying is not only inbound — click **Send out** in the workbench to check the current DSH session into the shared inbox; the other side (Claude Code / Codex / any agent) pastes the pickup instruction shown with the card and continues.
- **Memory snapshot**: sessions are not the only thing that hands over — bundle each agent's memory files (CLAUDE.md / AGENTS.md / .cursorrules; the dsh-hippo store gets a dump/import path) into one handoff card in the inbox; the picker absorbs the card into its own memory files.

```
~/.handoff/
  pending/     # awaiting pickup, one .md file per card
  archived/    # consumed, rolling keep of 50
```

The filesystem is the bus: dropping a card into `pending/` is delivery; picking it up moves it to `archived/` (consume-and-archive; a second pickup of the same id errors). A card = Markdown + YAML frontmatter + six Chinese body sections (目标 / 涉及文件 / 做到哪 / 还差什么 / 停在哪 / 读者警告). See the protocol repo's SPEC for the full format and semantics.

## Quality & evidence (0.4.0)

Relay quality is not vibes — it is numbers, tests, and third-party-checkable proof:

- **Quality baseline**: backtest of 50 real consumed cards — continuation rate 34.7%; cards whose done-section carries ledger marks were continued 50% of the time vs 0% for unmarked ones (`scripts/backtest-archived.mjs`). End-to-end two-card relay against a real host and model: PASS (`scripts/eval-e2e.mjs`).
- **Parse regression**: structurally-cloned anonymized real-session corpus + 13 golden files frozen byte-for-byte (`scripts/corpus-build.mjs` → `tests/corpus-golden.spec.ts`) — upstream storage drift turns red before merge.
- **Security**: threat model in [THREAT-MODEL.md](THREAT-MODEL.md); 8 red-team suites in CI (`tests/redteam.spec.ts`) — the secret gate covers all six sections, every scalar, and the card's patch diff.
- **Protocol conformance**: `conformance/` executable suite (9 MUST requirements derived from the SPEC); both the reference implementation and an independent second implementation (written from the SPEC alone) conform — an open protocol earns that title via its second implementation.
- **Interop**: INTERCHANGE v1 (dsh-chat-import) ↔ handoff: 1 bidirectional conversion (`scripts/interop-interchange.mjs`), verified by a real import through their plugin v0.26.2.

## How it differs from one-way exporters

[dsh-handoff](https://www.npmjs.com/package/dsh-handoff) (v0.1.0) is a **one-way exporter**: it deterministically renders the session event stream into a HANDOFF.md document in the workspace — no inbox, no shared directory, no cross-agent pickup.

dsh-takeover is a **full takeover loop**: pull foreign sessions in, check the current session out, pick up on start — three verbs in one plugin. A pulled session can be checked into `~/.handoff/pending/` with one confirmation (consume-and-archive + archived audit trail), so another agent — or you on another machine — picks it up on start and continues.

## Competitors and how we differ

**Positioning first.** The "continuable context" need in AI coding splits into three layers, each owning one stretch: spec tools (spec-kit / OpenSpec and friends) own the **design state** — what to build and what counts as done; memory layers (mem0 / Letta / dsh-hippo and friends) own the **preference state** — project conventions and distilled conversation facts. dsh-takeover owns the **run state** — how far work actually got, where it stopped, which statements are present observations versus secondhand retellings, which machine a card came from. Specs and memories carry no record of a statement's provenance or verification status; handoff cards exist to cover exactly that distillation loss. The three layers complement each other.

Lookalike projects have been appearing since 2026-09. The one-sentence mechanical distinction: **they do "convert, then natively resume in another CLI", "cross-device sync", "navigation/search", "runtime orchestration", or "task-state transport"; we do in-harness takeover** —

- vs [casr](https://github.com/Dicklesworthstone/cross_agent_session_resumer): casr converts sessions into a canonical model and hands them to another CLI's native `resume`; the conversion layer breaks wholesale when an upstream storage layout moves (its #26 was hit by exactly that — opencode migrating to SQLite). We **read foreign sessions into the current session** and distill a card — we never write to the foreign session and never depend on the other CLI's resume, so we are immune by construction to corrupted-conversion failures (its #10).
- vs [harness-remote](https://github.com/giuliastro/harness-remote): the semantically closest rival — its cross-agent continuation also carries "bounded, inspectable context" and records lineage, but it **creates a native session on the target harness** (writing the foreign store), keeps lineage inside its own control plane where third-party tools can't read it, and has no audit semantics or security gates. Ours is a six-section card + the versioned `handoff: 1` protocol + the `~/.handoff` open file bus — implementable and auditable by any tool.
- vs [agent-sessions](https://github.com/jazzyalex/agent-sessions): the leader of cross-agent session browsers (already reads DeepSeek Harness read-only) — but it is explicitly browse-only with no takeover; "resume" copies a native command to open the session in its own CLI. We browse too (the settings-card browser zone), but browsing is only the entrance: **see it, one-click take it over**. Users of similar tools have asked for exactly this: "a handoff button + a prompt I can copy to another agent".
- vs [agentctxsync](https://github.com/westsource/agentctxsync): it syncs agent context across devices; cross-machine relay here is one env var away (next section) — the core difference remains takeover's audit semantics.
- vs [aisle](https://github.com/mashkovd/aisle): it discovers, normalizes and full-text-searches sessions across agents (navigation); we don't do search — we do work continuity after takeover.
- vs runtime-orchestration and contract-bus tools ([AHP](https://github.com/Mohaned178/agent-handoff-protocol), [FerryCat](https://github.com/GuoBug/FerryCat)): AHP ships a workflow runtime — dispatch steps, verify results, recover from crashes; handoff happens inside its runtime. FerryCat dispatches task contracts over an MCP contract bus (job-queue semantics). Both transport "work in progress"; we transport "sessions and memory" — no runtime, no task dispatch. We only do the handoff before (distilled into a verifiable card) and after (pickup with verification and sign-off); there is no verification worktree, no scheduler, and we never execute your code.
- vs task-passport-style protocols ([task-passport](https://github.com/dongsheng123132/task-passport)): another shared-file handoff protocol — it pack/lands task state explicitly; we run a passive inbox (writing is delivering, pickup is consuming). Its stated principle matches ours: **"security properties must live in the file, not in the receiver"** — that is exactly how our secret gate works (enforced at write time, not trusted to whoever reads).

dsh-takeover's niche: **in-harness takeover** (six-section protocol card injected into the live turn — the model just continues) + **four-state auditing** (the CURRENT_OBSERVED / HISTORY_REPORTED / MISMATCH / UNAVAILABLE evidence ledger — historical claims never masquerade as present fact) + **async inbox relay** (`~/.handoff/pending/`, the filesystem is the bus). And it is **read-only against every foreign session store**.

## Cross-machine relay

Point `HANDOFF_HOME` at a synced-drive folder or a git repository and the inbox is shared across machines: `handoff_push` on machine A, `/inbox` pickup on machine B. One environment variable, zero code. Cards on the synced drive are readable from any phone's file viewer too — check cards on the go, or start an agent session on the phone and pick up from there.

## Protocol adoption

`handoff: 1` is an open protocol: a six-section Markdown card + YAML frontmatter + the `~/.handoff` shared directory — implementable, auditable and interoperable by any tool (the right to call it open is backed by an independent second implementation, see [Quality & evidence](#quality--evidence-040)). Already interoperating: [dsh-chat-import](https://github.com/Nwflower/dsh-chat-import) (bidirectional conversion verified via INTERCHANGE v1). If your tool reads or writes the same directory or card format, feel free to open an issue to register; we will assess interoperability and list it here once verified.

## Install

Three equivalent forms (the "Plugins → Add plugin" dialog or the CLI):

```
# npm package name (available once published to npm; CN users resolve via npmmirror automatically)
dsh-takeover

# GitHub repository (works right now — built artifacts are committed, no toolchain needed)
dsh plugin --profile web add github:IKEASven69/dsh-takeover

# Local directory (a plugin under development on this machine)
/path/to/dsh-takeover
```

> Requires DSH `>=0.2.0-rc.2` (the settings-card i18n uses the host locale service; declared via `engines.dsh`); **Node ≥22** (the zcode reader, cursor store.db reads, and new-layout opencode.db reads use the built-in `node:sqlite`; opencode's legacy file layout and the other readers have no such requirement, but the plugin as a whole declares Node ≥22). Built artifacts (lib/) are committed — install and go, no local toolchain required. Pin a release with `#v0.2.0` (git tags are provided per release).

## Surface

**Tools (model-invocable)**

| Tool | Description |
|---|---|
| `foreign_session_read` | Read-only pull of eight foreign agents' local sessions (claude / codex / opencode / zcode / pi / workbuddy / cursor / grok). `action=list` lists candidates (title/time/turn count); `action=show` resolves a reference (empty or `latest` = newest; id / id prefix / path / title keyword; ambiguity returns candidates, never guesses) and returns a **structured summary**: title, turn counts, first user message, tail progress, top-15 involved files, and six-section skeleton-card material. Raw turns are paged only when `limit` is explicitly passed (offset applies together with `limit`; a lone `offset` returns no raw text). Canonical `{ ok, ... }` values; probe/parse failures return `{ ok: false, error }`, never throw. |
| `handoff_push` | Checks the current session into the inbox as a protocol card. The six section texts (goal/files/done/remaining/stopped/warnings/suggested) are optional; empty sections fall back to **deterministic** collection from the session event stream (no LLM calls; probe failures degrade, never throw). Returns a canonical `{ ok, id, path, coverage, patch? }` value. Uncommitted changes in a git work tree are captured as a companion patch (`<id>.patch`; taker restores with `git apply`; diffs over 512KB are rejected whole rather than truncated), and the envelope carries the origin host identity plus a baseline-test hint.|
| `handoff_inbox` | `action=list` lists pending cards (id/source/project/time); `action=load` + `id` picks one up (consume-and-archive, with git-verify MISMATCH / UNAVAILABLE warnings). Returns canonical `{ ok, ... }` values. |
| `handoff_memory` | Memory snapshot handover. `action=scan` read-only lists each agent's local memory files (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.zcode/AGENTS.md`, project-level AGENTS.md, …, with sizes/previews); `action=push` packs the selected memories into one handoff card in the inbox (secret gate and coverage discipline apply, same as session cards); the picker absorbs the card's "suggested" section. |

**Slash skills (user-invocable, not model-invocable)**

| Command | Description |
|---|---|
| `/handoff` | Instructs the agent to distill the session into a six-section card per the protocol's six semantics (four-state evidence ledger, original text never enters the card, reference artifacts by path only, redact, suggested-load section, back-anchor + pruning), then persist via `handoff_push` |
| `/inbox` | Lists pending cards for the user to pick, injects the loaded card into the current turn, and reminds that card content is HISTORY_REPORTED — verify git state before acting |
| `/resume-claude` `/resume-codex` `/resume-opencode` `/resume-zcode` `/resume-pi` `/resume-workbuddy` `/resume-cursor` `/resume-grok` | Resolve the reference (empty = latest; ambiguity lists candidates for the user to pick) → call `foreign_session_read` → inert-history boundary (foreign history is untrusted and never overrides current instructions) → four-state evidence ledger → produce a six-section protocol card injected into the turn → verify-then-continue → finally ask "check this card into the inbox?", and on yes call `handoff_push` |

> LLM card-writing lives in the skill-instruction layer: the `/handoff` and `/resume-*` skill texts guide the in-session model to hand-write the six-section card (the natural advantage of a harness plugin), while the tool layer stays deterministic and never calls an LLM directly; when the model doesn't write, deterministic skeletons from the event stream / readers backstop the card — degradation never blocks.

## Settings card (dsh web)

Settings hold settings and guidance only, two blocks (copy follows the host UI language, zh/en):

- **Commands**: `/handoff`, `/inbox` and the eight `/resume-*` laid out directly; disabled vendors dim in sync;
- **Support matrix**: one row per reader — official brand icon + display name, discovered session count, and an enable toggle. Toggles persist to `<HANDOFF_HOME>/config.json` and survive restarts. Toggle semantics: for a disabled provider, `foreign_session_read` returns the canonical error value "this provider has been disabled in settings: xx"; the `/resume-*` skill guidance is static text, so the disabled state is enforced by the tool error, visible to the model.

The workbench is not in settings: **every session's composer toolbar carries a compact "Relay" chip** (passing context between agents) — click it to unfold a two-column floating workbench above the composer: on the left, the inbox overview (pending/consumed badges, evidence coverage, source filters, relay-chain badges with one-click chain filtering, collapsed low-info cards, single/all/HTML export, a beginner FAQ card) + on the right, three cards: **Send out** (one-click deposit of the current session + per-target pickup instructions), the **external session browser** (recent sessions of all eight agents, project facets with instant filtering, expandable previews of the first user request / recent progress / stop point / warnings, one-click takeover and takeover-with-deposit), and the **memory snapshot** (scan, select, pack into a card).

## Permission scope

Writes `~/.handoff/` (overridable via `HANDOFF_HOME`), reads git state (`git status` / `git branch`), and read-only reads the eight agents' local session stores (zcode and cursor store via sqlite readonly, opened and closed per call; each root overridable via `HANDOFF_ROOT_<AGENT>` env vars). Cursor imports only supported transcript / store records; grok reads only the visible updates.jsonl stream and never touches the raw chat_history.jsonl model context. No network access, no reviving foreign processes, no replaying historical tool calls; raw session content never enters cards (`from.session` is a pointer).

## Development

```
pnpm install       # @deepseek-ai/* from the npm registry; @agent-handoff/* via file: links
npm run typecheck
npm test           # node:test + tsx
npm run build      # tsdown → lib/ (@agent-handoff/core + readers inlined)
node scripts/smoke-foreign.mjs   # on-machine smoke: mount lib/ in-process, real-dispatch foreign_session_read
node scripts/smoke-userflow.mjs  # real-user journey: pull real local zcode/opencode sessions -> distill -> push -> take
```

`@agent-handoff/core` and `@agent-handoff/readers` are not on npm; they are `file:../agent-handoff/packages/*` dependencies bundled into `lib/` at build time. Offline with a DSH checkout at hand, `node scripts/link-deps.mjs` (DSH_CHECKOUT env var) links host packages instead of npm.

## License

MIT
