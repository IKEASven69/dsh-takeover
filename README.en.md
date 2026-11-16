<p align="center"><img src="assets/icon.svg" width="72" height="72" alt="dsh-takeover logo"></p>

# dsh-takeover · Session Takeover

**Take over any agent's half-finished work and keep going — read-only session pull from thirteen CLIs, one-click check-in, pickup on start. Sessions and memory both hand over.**

[![npm](https://img.shields.io/npm/v/@cold777/dsh-takeover)](https://www.npmjs.com/package/@cold777/dsh-takeover) ![tests](https://img.shields.io/badge/tests-327%20passing-brightgreen) ![DSH](https://img.shields.io/badge/DSH-%3E%3D0.2.0--rc.2-orange) ![Node](https://img.shields.io/badge/node-%3E%3D22-green) ![license](https://img.shields.io/badge/license-MIT-lightgrey)

- **Take over**: a task half-done in Claude Code — one `/resume-claude` injects a six-section handoff card into the current session and the model just continues;
- **Hand off**: session too long, switching environments? `/handoff` checks the current session out as a card that any agent can pick up on start;
- **Across machines**: `handoff_sync` moves the inbox over your own git repo in one command — consumed cards never replay on the other machine; the zero-setup `HANDOFF_HOME`-on-a-synced-drive path still works, and cards stay readable from your phone.

## Install (30 seconds)

**npm package name** (paste it in the "Plugins → Add plugin" dialog; CN users resolve via npmmirror automatically):

```
@cold777/dsh-takeover
```

**CLI (GitHub source, works right now):**

```bash
dsh plugin --profile web add github:IKEASven69/dsh-takeover
```

**Settings card:** DSH Settings → Plugins → Add plugin → paste `github:IKEASven69/dsh-takeover`

**Let your agent install it** — send this to your DSH agent verbatim:

> Please install the dsh-takeover plugin: run `dsh plugin --profile web add github:IKEASven69/dsh-takeover`. When it finishes, restart the DSH web app, confirm dsh-takeover is enabled under Settings → Plugins, then report the result back to me.

Works out of the box (built artifacts are committed — no local toolchain). Pin a release: `github:IKEASven69/dsh-takeover#v0.1.0`. Requires DSH ≥0.2.0-rc.2 and Node ≥22.

## First 30 seconds

| You want to | Say / type | What happens |
|---|---|---|
| Take over a foreign session | `/resume-claude` (or plain words: "take over the latest Claude Code session") | Read-only pull → six-section card injected into the live turn → the model continues |
| Hand the current session off | `/handoff` | Current session distilled into a protocol card, uncommitted changes attached as a patch |
| Pick up on start | `/inbox` | List pending cards → verify and sign for one → context injected, keep working |
| Browse before deciding | Click the "Relay" chip next to the composer | Workstation opens: browse thirteen agents' recent sessions, one-click takeover / check-out, memory snapshot |
| Hand memory over too | Workstation → Memory snapshot → select and pack | CLAUDE.md / AGENTS.md and friends packed into a card; the receiver absorbs them per its "suggested loads" |

## How it works (60 seconds)

**The filesystem is the bus.** One card per `.md` file in `~/.handoff/pending/`: writing is delivery, pickup moves it to `archived/` (rolling 50 kept; consume-and-archive, a second pickup of the same id errors).

**A card = Markdown + YAML frontmatter + six body sections** (goal / files involved / how far it got / what's left / where it stopped / reader warnings), carrying a four-state evidence ledger (CURRENT_OBSERVED / HISTORY_REPORTED / MISMATCH / UNAVAILABLE) — historical claims never masquerade as present fact. Uncommitted changes in a git repo are attached as a patch automatically (refused above 512KB, never truncated).

**Trust lives in the file.** First push generates a bus signing key; cards carry machine signatures; pickup rules three ways — `ok / tampered / no-key`. Tampering is detectable, cross-trust-domain never false-positives.

**Read-only promise.** No writes to any foreign agent's session store, no network access, no replaying historical tool calls; raw text never enters the card — only pointers.

## All in one · Four axes, one chain

Handover is never one thing — it is four. All four share the same `handoff: 1` card format, the same `~/.handoff` bus, and the same git sync chain; on the user's side it is always a single command:

- **Session axis**: `/handoff` distills a half-finished session into a six-section card; any agent picks it up with `/inbox` and keeps going;
- **Context axis**: uncommitted changes ride along as a patch and the repo baseline (origin / HEAD / branch) travels on the card — a new machine restores the exact scene via clone → checkout → apply → run tests;
- **Memory axis**: CLAUDE.md / AGENTS.md and friends are packed into a card; the receiver absorbs them into its own memory files via the "suggested loads" section;
- **Config axis**: the manifest + pointer of the encrypted family backup rides the card while the encrypted blob travels with the sync — restore on a new machine with a dry preview → confirm apply → rollback.

What does one card carry? After one `handoff_sync` command, the other machine's inbox holds not just "where the chat left off" but the entire scene needed to keep working: the six-section session, uncommitted code, accumulated memory, and a restorable environment. The `axis` / `payload` contract markers on the card tell the receiver at a glance whether to continue working, absorb per entry, or preview before writing — four axes, all in one, one chain.

## Tools & commands reference

**Agent tools (model-callable)**

| Tool | What it does |
|---|---|
| `foreign_session_read` | Read-only pull across thirteen agents. `action=list` lists candidates (title/time/turns); `action=show` resolves a reference (empty/`latest`, id, prefix, path, title keyword — ambiguity returns candidates, never guesses) into a structured summary: title, turns, first user message, recent progress, top-15 files, six-section card material. Raw turns only when `limit` is passed explicitly; probe/parse failures return `{ ok: false, error }` instead of throwing |
| `handoff_push` | Check the current session out as a protocol card. Sections left empty are deterministically backfilled from the session event stream (no LLM call); uncommitted changes attach as a patch; returns `{ ok, id, path, coverage, patch? }` |
| `handoff_inbox` | `action=list` pending cards; `action=load` picks one up (consume-and-archive, with signature and git-verified MISMATCH / UNAVAILABLE warnings) |
| `handoff_sync` | Machine-switch sync: `action=setup` enables (git repo URL; credentials stay with system git, never in the plugin); `action=now` pulls and pushes in one step; `push`/`pull`/`status` for one-way and read-only. Consumed cards do not replay on the other machine — archived/ is the tombstone |
| `handoff_env` | Environment backup/restore: packs the DSH family (settings / plugin registrations / session library / user skills / workspace registries) into one AES-256-GCM-encrypted file that rides sync across machines; `dry` previews a three-state diff → `apply` (confirm-gated, overwritten originals auto-checkpointed) → `rollback` |
| `handoff_memory` | Memory snapshot. `action=scan` read-only lists each agent's memory files (size/preview); `action=push` packs selections into a card the receiver absorbs via "suggested loads" |

**Slash commands (user types, agent follows the playbook)**

| Command | What it does |
|---|---|
| `/resume-*` (thirteen) | Resolve reference → read-only pull → four-state marking (foreign history is untrusted and never overrides current instructions) → six-section card injected into the live turn → ends by asking whether to check the session into the inbox |
| `/handoff` | Distills the current session per the protocol's six rules (four-state ledger, no raw text, artifacts as paths only, redact, suggested-loads section, reverse-anchoring + pruning) and checks it in |
| `/inbox` | Lists pending cards for the user to pick; after pickup the card is injected as HISTORY_REPORTED — verify git state before executing |

## Cross-machine relay

Point `HANDOFF_HOME` at a synced-drive folder or a git repository and the inbox is shared: `handoff_push` on machine A, `/inbox` pickup on machine B. One environment variable, zero code. Cards are readable from any phone's file viewer too. Sync-service conflict copies never become phantom cards: same-id copies are deduplicated to one entry, late copies whose original is gone land in the inbox's visible rejection list (with reasons), and so do half-written files.

**Built-in sync (0.2.0)**: enter a private git repo URL on the settings card's "Switch" tab — machine A runs `handoff_sync` (setup + now), machine B sets up the same URL and runs now, and the cards are in its inbox. Credentials stay entirely with system git (zero stored credentials; URLs embedding `user:pass@` are rejected outright); scope = every card and machine envelope in pending/archived + the signing key + environment backups, while machine-local records (lifecycle log, relay provenance, plugin switches) never sync; merge conflicts abort with an honest error and local files stay untouched.

## Quality & evidence

Relay quality is not vibes — it is numbers, tests, and third-party-checkable proof (methodology and reproduction steps in [eval/README.md](eval/README.md)):

- **Backtest**: 50 real consumed cards — continuation rate 34.7%; cards with ledger marks in the done section continued 50% of the time vs 0% for unmarked ones. End-to-end two-card relay against a real host and model: PASS.
- **Parse regression**: 13 golden files frozen byte-for-byte against a structurally-cloned, anonymized real-session corpus — upstream storage drift turns red before merge.
- **Security**: threat model in [THREAT-MODEL.md](THREAT-MODEL.md); 8 red-team suites in CI — the secret gate covers all six sections, every scalar, and the card's patch diff.
- **Protocol**: `conformance/` executable suite (9 MUST requirements derived from the SPEC); both the reference implementation and an independent second implementation (written from the SPEC alone) conform.
- **Interop**: INTERCHANGE v1 (dsh-chat-import) ↔ handoff: 1 bidirectional conversion, verified by a real import through their plugin v0.26.2.

## Positioning

The "continuable context" need in AI coding splits into three layers: spec tools (spec-kit / OpenSpec and friends) own the **design state**; memory layers (mem0 / Letta / dsh-hippo and friends) own the **preference state**; dsh-takeover owns the **run state** — how far work actually got, where it stopped, which statements are present observations versus secondhand retellings, which machine a card came from. The three layers complement each other.

The one-sentence mechanical distinction: **they do "convert, then natively resume in another CLI", "environment backup", "navigation/search", "runtime orchestration", or "task-state transport"; we do in-harness takeover plus machine-switch context sync — cards and backups ride your own git repo, and the handoff semantics and ledgers never change hands.**

## Protocol adoption

`handoff: 1` is an open protocol: a six-section Markdown card + YAML frontmatter + the `~/.handoff` shared directory — implementable, auditable and interoperable by any tool (the right to call it open is backed by an independent second implementation, see [Quality & evidence](#quality--evidence)). Already interoperating: [dsh-chat-import](https://github.com/Nwflower/dsh-chat-import) (bidirectional conversion verified via INTERCHANGE v1). If your tool reads or writes the same directory or card format, open an issue to register interoperability.

## Permission scope

Writes `~/.handoff/` (override via `HANDOFF_HOME`), reads git status, read-only access to the thirteen agents' local session stores (zcode and cursor via sqlite readonly, opened on demand; per-agent roots overridable via `HANDOFF_ROOT_<agent>`). cursor imports only supported transcript / store records; grok reads only the visible updates.jsonl stream (never the raw chat_history.jsonl model context); gemini reads only local chats/ session files; the four jsonl-family readers added in 0.3.0: kimi reads only the wire.jsonl event stream (state.json / session_index used for metadata only), codebuddy / qoder read only main-session JSONL files (subagent transcripts excluded), kiro reads only sessions/cli <uuid>.jsonl (companion .json / .history files are never read). Two explicit exceptions since 0.2.0: (1) `handoff_sync` talks to the git repository **you explicitly configure**, via system git (the plugin process builds no network connection and stores no credentials); (2) `handoff_env` backs up and restores family-wide config paths — restore requires a dry preview then explicit confirm before anything is written, overwritten originals are auto-checkpointed for rollback, and credential files exist only inside the encrypted archive (see THREAT-MODEL T6/T7). No reviving external processes, no replaying historical tool calls, raw text never enters cards.

## Development

```bash
pnpm install       # @deepseek-ai/* via npm registry; @agent-handoff/* via file: links
npm run typecheck
npm test           # node:test + tsx
npm run build      # tsdown → lib/ (@agent-handoff/core + readers bundled in)
node scripts/smoke-foreign.mjs   # live smoke: in-process mount of lib/, real foreign_session_read dispatch
node scripts/smoke-userflow.mjs  # real user journey: pull real local zcode/opencode sessions → check in → pick up
```

`@agent-handoff/core` and `@agent-handoff/readers` are unpublished; they are wired via `file:../agent-handoff/packages/*` and bundled into `lib/` at build time.

## License

MIT
