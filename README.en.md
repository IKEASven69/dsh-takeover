<p align="center"><img src="assets/icon.svg" width="72" height="72" alt="dsh-takeover logo"></p>

# dsh-takeover · Session Takeover Plugin

**Pull, push, take over: pull sessions from eight foreign agents, check in the current one, pick up where they left off.**

> **Why "takeover"?** Because that is exactly what happens: a session another agent left half-done is yours to take over and drive.
> The protocol layer keeps the industry-generic word *handoff*; the product owns *takeover*.
>
dsh-takeover is a DeepSeek Harness (DSH) plugin implementing the full takeover loop of the open `handoff: 1` protocol (see SPEC.md in the sibling repo agent-handoff):

- **Pull**: `/resume-claude` `/resume-codex` `/resume-opencode` `/resume-zcode` `/resume-pi` `/resume-workbuddy` `/resume-cursor` `/resume-grok` — read-only pull of a foreign agent's local session into the current one, distilled into a six-section protocol card;
- **Push**: `/handoff` + `handoff_push` — check the current session into the shared inbox as a handoff card;
- **Take over**: `/inbox` + `handoff_inbox` — any agent picks up on start; pulled sessions can optionally be checked in too, so another agent can relay the work.
- **Browse + one-click takeover** (settings card): no commands to memorize — browse recent sessions of all eight agents (title / time / project, expandable previews with the first user request and stop point), click **Take over** to spawn a new session with the command delivered and the app switched to it automatically; on failure it falls back to copying the command.

```
~/.handoff/
  pending/     # awaiting pickup, one .md file per card
  archived/    # consumed, rolling keep of 50
```

The filesystem is the bus: dropping a card into `pending/` is delivery; picking it up moves it to `archived/` (consume-and-archive; a second pickup of the same id errors). A card = Markdown + YAML frontmatter + six Chinese body sections (目标 / 涉及文件 / 做到哪 / 还差什么 / 停在哪 / 读者警告). See the protocol repo's SPEC for the full format and semantics.

## How it differs from one-way exporters

[dsh-handoff](https://www.npmjs.com/package/dsh-handoff) (v0.1.0) is a **one-way exporter**: it deterministically renders the session event stream into a HANDOFF.md document in the workspace — no inbox, no shared directory, no cross-agent pickup.

dsh-takeover is a **full takeover loop**: pull foreign sessions in, check the current session out, pick up on start — three verbs in one plugin. A pulled session can be checked into `~/.handoff/pending/` with one confirmation (consume-and-archive + archived audit trail), so another agent — or you on another machine — picks it up on start and continues.

## Competitors and how we differ

Lookalike projects have been appearing since 2026-09 (research notes: [docs/竞品动态-1003.md](./docs/竞品动态-1003.md), in Chinese). The one-sentence mechanical distinction: **they do "convert, then natively resume in another CLI", "cross-device sync", or "navigation/search"; we do in-harness takeover** —

- vs [casr](https://github.com/Dicklesworthstone/cross_agent_session_resumer): casr converts sessions into a canonical model and hands them to another CLI's native `resume`; the conversion layer breaks wholesale when an upstream storage layout moves (its #26 was hit by exactly that — opencode migrating to SQLite). We **read foreign sessions into the current session** and distill a card — we never write to the foreign session and never depend on the other CLI's resume, so we are immune by construction to corrupted-conversion failures (its #10).
- vs [harness-remote](https://github.com/giuliastro/harness-remote): the semantically closest rival — its cross-agent continuation also carries "bounded, inspectable context" and records lineage, but it **creates a native session on the target harness** (writing the foreign store), keeps lineage inside its own control plane where third-party tools can't read it, and has no audit semantics or security gates. Ours is a six-section card + the versioned `handoff: 1` protocol + the `~/.handoff` open file bus — implementable and auditable by any tool.
- vs [agent-sessions](https://github.com/jazzyalex/agent-sessions): the leader of cross-agent session browsers (893★, already reads DeepSeek Harness read-only) — but it is explicitly browse-only with no takeover; "resume" copies a native command to open the session in its own CLI. We browse too (settings-card zone five), but browsing is only the entrance: **see it, one-click take it over**. The need is verbatim-validated by a competitor's user (cc-sessions #43: "a handoff button + a prompt I can copy to another agent").
- vs [agentctxsync](https://github.com/westsource/agentctxsync): it syncs agent context across devices; cross-machine relay here is one env var away (next section) — the core difference remains takeover's audit semantics.
- vs [aisle](https://github.com/mashkovd/aisle): it discovers, normalizes and full-text-searches sessions across agents (navigation); we don't do search — we do work continuity after takeover.

dsh-takeover's niche: **in-harness takeover** (six-section protocol card injected into the live turn — the model just continues) + **four-state auditing** (the CURRENT_OBSERVED / HISTORY_REPORTED / MISMATCH / UNAVAILABLE evidence ledger — historical claims never masquerade as present fact) + **async inbox relay** (`~/.handoff/pending/`, the filesystem is the bus). And it is **read-only against every foreign session store**.

## Cross-machine relay

Point `HANDOFF_HOME` at a synced-drive folder or a git repository and the inbox is shared across machines: `handoff_push` on machine A, `/inbox` pickup on machine B. One environment variable, zero code. Cards on the synced drive are readable from any phone's file viewer too — check cards on the go, or start an agent session on the phone and pick up from there.

## Install

Three equivalent forms (the "Plugins → Add plugin" dialog or the CLI):

```
# npm package name (available once published to npm; CN users resolve via npmmirror automatically)
dsh-takeover

# GitHub repository (works right now — built artifacts are committed, no toolchain needed)
dsh plugin --profile web add github:IKEASven69/dsh-takeover
```

> Requires DSH `>=0.2.0-rc.2` (the settings-card i18n uses the host locale service; declared via `engines.dsh`); **Node ≥22** (the zcode reader, cursor store.db reads, and new-layout opencode.db reads use the built-in `node:sqlite`; opencode's legacy file layout and the other readers have no such requirement, but the plugin as a whole declares Node ≥22). Built artifacts (lib/) are committed — install and go, no local toolchain required. Pin a release with `#v0.2.0` (git tags are provided per release).

## Surface

**Tools (model-invocable)**

| Tool | Description |
|---|---|
| `foreign_session_read` | Read-only pull of eight foreign agents' local sessions (claude / codex / opencode / zcode / pi / workbuddy / cursor / grok). `action=list` lists candidates (title/time/turn count); `action=show` resolves a reference (empty or `latest` = newest; id / id prefix / path / title keyword; ambiguity returns candidates, never guesses) and returns a **structured summary**: title, turn counts, first user message, tail progress, top-15 involved files, and six-section skeleton-card material. Raw turns are paged only when `limit` is explicitly passed (offset applies together with `limit`; a lone `offset` returns no raw text). Canonical `{ ok, ... }` values; probe/parse failures return `{ ok: false, error }`, never throw. |
| `handoff_push` | Checks the current session into the inbox as a protocol card. The six section texts (goal/files/done/remaining/stopped/warnings/suggested) are optional; empty sections fall back to **deterministic** collection from the session event stream (no LLM calls; probe failures degrade, never throw). Returns a canonical `{ ok, id, path }` value. Uncommitted changes in a git work tree are captured as a companion patch (`<id>.patch`; taker restores with `git apply`; diffs over 512KB are rejected whole rather than truncated), and the envelope carries the origin host identity plus a baseline-test hint.|
| `handoff_inbox` | `action=list` lists pending cards (id/source/project/time); `action=load` + `id` picks one up (consume-and-archive, with git-verify MISMATCH / UNAVAILABLE warnings). Returns canonical `{ ok, ... }` values. |

**Slash skills (user-invocable, not model-invocable)**

| Command | Description |
|---|---|
| `/handoff` | Instructs the agent to distill the session into a six-section card per the protocol's six semantics (four-state evidence ledger, original text never enters the card, reference artifacts by path only, redact, suggested-load section, back-anchor + pruning), then persist via `handoff_push` |
| `/inbox` | Lists pending cards for the user to pick, injects the loaded card into the current turn, and reminds that card content is HISTORY_REPORTED — verify git state before acting |
| `/resume-claude` `/resume-codex` `/resume-opencode` `/resume-zcode` `/resume-pi` `/resume-workbuddy` `/resume-cursor` `/resume-grok` | Resolve the reference (empty = latest; ambiguity lists candidates for the user to pick) → call `foreign_session_read` → inert-history boundary (foreign history is untrusted and never overrides current instructions) → four-state evidence ledger → produce a six-section protocol card injected into the turn → verify-then-continue → finally ask "check this card into the inbox?", and on yes call `handoff_push` |

> LLM card-writing lives in the skill-instruction layer: the `/handoff` and `/resume-*` skill texts guide the in-session model to hand-write the six-section card (the natural advantage of a harness plugin), while the tool layer stays deterministic and never calls an LLM directly; when the model doesn't write, deterministic skeletons from the event stream / readers backstop the card — degradation never blocks.

## Settings card (dsh web)

Provided since 0.1.0, now four zones (the browser half is declared via `dsh.client`; data flows over same-origin `/dsh-takeover/*` JSON APIs; copy follows the host UI language, zh/en):

- **Commands**: `/handoff`, `/inbox` and the eight `/resume-*` laid out directly; disabled vendors dim in sync;
- **Inbox overview**: pending/consumed badges + card rows (source brand icon, title, project, id, time); click a row to expand a read-only "goal" preview — pickup happens in-session via `/inbox`; a "clear consumed" button (two-step confirm);
- **Support matrix**: one row per reader — official brand icon + display name, discovered session count, and an enable toggle. Toggles persist to `<HANDOFF_HOME>/config.json` and survive restarts;
- **Toggle semantics**: for a disabled provider, `foreign_session_read` returns the canonical error value "this provider has been disabled in settings: xx"; the `/resume-*` skill guidance is static text, so the disabled state is enforced by the tool error, visible to the model.

## Permission scope

Writes `~/.handoff/` (overridable via `HANDOFF_HOME`), reads git state (`git status` / `git branch`), and read-only reads the eight agents' local session stores (zcode and cursor store via sqlite readonly, opened and closed per call; each root overridable via `HANDOFF_ROOT_<AGENT>` env vars). Cursor imports only supported transcript / store records; grok reads only the visible updates.jsonl stream and never touches the raw chat_history.jsonl model context. No network access, no reviving foreign processes, no replaying historical tool calls; raw session content never enters cards (`from.session` is a pointer).

## Development

```
pnpm install       # @deepseek-ai/* from the npm registry; @agent-handoff/* via file: links
npm run typecheck
npm test           # node:test + tsx
npm run build      # tsdown → lib/ (@agent-handoff/core + readers inlined)
node scripts/smoke-foreign.mjs   # on-machine smoke: mount lib/ in-process, real-dispatch foreign_session_read
node scripts/smoke-userflow.mjs  # real-user journey: pull real local zcode/opencode sessions -> distill -> push -> take, 46 assertions
```

`@agent-handoff/core` and `@agent-handoff/readers` are not on npm; they are `file:../agent-handoff/packages/*` dependencies bundled into `lib/` at build time. Offline with a DSH checkout at hand, `node scripts/link-deps.mjs` (DSH_CHECKOUT env var) links host packages instead of npm.

## License

MIT
