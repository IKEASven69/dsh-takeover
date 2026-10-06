import { createRequire } from "node:module";
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
//#region ../agent-handoff/packages/readers/dist/index.mjs
/** 路径形态判断：含分隔符或盘符即按路径匹配（文件系适配器的 id 就是绝对路径）。 */
function looksLikePath(reference) {
	return /[\\/]/.test(reference) || /^[A-Za-z]:/.test(reference);
}
const normPath = (p) => p.replace(/\//g, "\\").toLowerCase();
/**
* 在 refs 中解析 reference：
* - 'latest' / 空串 → 最新一条；
* - id 精确命中 → 直接返回；
* - 其余策略（id 前缀、路径、标题子串）合并候选，1 条解析、多条歧义、0 条 not-found。
*/
function resolveReference(reference, refs) {
	const sorted = [...refs].sort((a, b) => b.updatedAt - a.updatedAt);
	const q = reference.trim();
	if (q === "" || q.toLowerCase() === "latest") return sorted.length > 0 ? {
		kind: "resolved",
		ref: sorted[0]
	} : {
		kind: "not-found",
		reference
	};
	const exact = sorted.find((r) => r.id === q);
	if (exact !== void 0) return {
		kind: "resolved",
		ref: exact
	};
	const candidates = /* @__PURE__ */ new Map();
	const push = (r) => {
		candidates.set(r.id, r);
	};
	for (const r of sorted) if (r.id.startsWith(q) || r.kind === "file" && normPath(r.id).startsWith(normPath(q))) push(r);
	if (looksLikePath(q)) {
		const nq = normPath(q);
		for (const r of sorted) {
			if (r.kind !== "file") continue;
			const nid = normPath(r.id);
			if (nid === nq || nid.endsWith(nq)) push(r);
		}
	}
	const lq = q.toLowerCase();
	for (const r of sorted) if (r.title.toLowerCase().includes(lq)) push(r);
	const list = [...candidates.values()].sort((a, b) => b.updatedAt - a.updatedAt);
	if (list.length === 1) return {
		kind: "resolved",
		ref: list[0]
	};
	if (list.length > 1) return {
		kind: "ambiguous",
		candidates: list
	};
	return {
		kind: "not-found",
		reference
	};
}
function makeTurn(partial) {
	return {
		cwd: "",
		ts: "",
		toolName: "",
		toolFailed: false,
		model: "",
		...partial
	};
}
/** 逐行解析 transcript JSONL；非 JSON / 空行静默跳过（损坏记录不拖垮整会话） */
function* parseJsonl(text) {
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		try {
			yield JSON.parse(line);
		} catch {
			continue;
		}
	}
}
/** 把 Claude message.content（字符串或 block 数组）压平为纯文本 */
function extractTextContent(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.filter((b) => b && typeof b === "object" && b.type === "text").map((b) => typeof b.text === "string" ? b.text : "").join("\n");
	return "";
}
/** tool_use 的人类可读一行摘要 */
function summarizeToolCall(name, input) {
	if (!input || typeof input !== "object" || Array.isArray(input)) return name;
	const inp = input;
	const cmd = inp.command;
	if (typeof cmd === "string") {
		const v = cmd.replace(/\s+/g, " ").trim();
		return v.slice(0, 100) + (v.length > 100 ? "…" : "");
	}
	for (const key of [
		"file_path",
		"path",
		"filePath"
	]) {
		const v = inp[key];
		if (typeof v === "string") return `${name}: ${v}`;
	}
	for (const v of Object.values(inp)) if (typeof v === "string") {
		const s = v.replace(/\s+/g, " ").trim();
		return `${name}: ${s.slice(0, 80)}` + (s.length > 80 ? "…" : "");
	}
	return name;
}
/** 把一行 Claude transcript JSON 拆成 Turn 列表 */
function entryToTurns(entry) {
	const turns = [];
	const etype = entry.type;
	const msg = entry.message ?? {};
	const cwd = typeof entry.cwd === "string" ? entry.cwd : "";
	const ts = typeof entry.timestamp === "string" ? entry.timestamp : "";
	const model = typeof msg.model === "string" ? msg.model : "";
	const content = msg.content;
	if (etype === "user" && msg.role === "user") {
		if (Array.isArray(content)) {
			const textParts = [];
			for (const block of content) {
				if (!block || typeof block !== "object") continue;
				if (block.type === "tool_result") {
					const rc = extractTextContent(block.content);
					turns.push(makeTurn({
						role: "tool",
						text: rc,
						cwd,
						ts,
						toolFailed: Boolean(block.is_error)
					}));
				} else if (block.type === "text") textParts.push(typeof block.text === "string" ? block.text : "");
			}
			const text = textParts.join("\n").trim();
			if (text) turns.push(makeTurn({
				role: "user",
				text,
				cwd,
				ts
			}));
		} else if (typeof content === "string") {
			const text = content.trim();
			if (text) turns.push(makeTurn({
				role: "user",
				text,
				cwd,
				ts
			}));
		}
		return turns;
	}
	if (etype === "assistant" && msg.role === "assistant") {
		if (typeof content === "string") turns.push(makeTurn({
			role: "assistant",
			text: content,
			cwd,
			ts,
			model
		}));
		else if (Array.isArray(content)) for (const block of content) {
			if (!block || typeof block !== "object") continue;
			const btype = block.type;
			if (btype === "text" && typeof block.text === "string" && block.text.trim()) turns.push(makeTurn({
				role: "assistant",
				text: block.text,
				cwd,
				ts,
				model
			}));
			else if (btype === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) turns.push(makeTurn({
				role: "assistant",
				text: "[thinking] " + block.thinking,
				cwd,
				ts,
				model
			}));
			else if (btype === "tool_use") {
				const name = typeof block.name === "string" ? block.name : "";
				turns.push(makeTurn({
					role: "assistant",
					cwd,
					ts,
					model,
					text: summarizeToolCall(name, block.input),
					toolName: name
				}));
			}
		}
	}
	return turns;
}
/**
* Claude Code 适配器：~/.claude/projects 下递归的全部 .jsonl（引擎原生格式）。
* 移植自 dsh-hippo src/agents/claude.ts；root 可用 HANDOFF_ROOT_CLAUDE 覆盖（测试用）。
*/
const ROOT$5 = process.env["HANDOFF_ROOT_CLAUDE"] ?? join(homedir(), ".claude", "projects");
function* walkJsonl$1(dir) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		const p = join(dir, e.name);
		if (e.isDirectory()) yield* walkJsonl$1(p);
		else if (e.isFile() && e.name.endsWith(".jsonl")) yield p;
	}
}
/** cwd 侦测窗口（首行一般 <8KB；超长首行的会话视为未记录而非伪造） */
const CWD_WINDOW = 8192;
/** 从转录头部窗口取真实 cwd（用户条目带 cwd 字段）。
* 目录名解码有歧义（连字符 vs 路径分隔符），拿目录名编一个「像路径的伪 cwd」比空更误导——
* 窗口内找不到（首行超长 / 字段缺失 / 读失败）一律回空串，让上层给「未记录工作区目录」警告。 */
function realCwd(file) {
	try {
		const fd = openSync(file, "r");
		try {
			const buf = Buffer.alloc(CWD_WINDOW);
			const n = readSync(fd, buf, 0, CWD_WINDOW, 0);
			const head = buf.toString("utf8", 0, n);
			const m = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head);
			if (m) return JSON.parse(`"${m[1]}"`);
		} finally {
			closeSync(fd);
		}
	} catch {}
	return "";
}
const claudeAdapter = {
	name: "claude-code",
	root: ROOT$5,
	supported: true,
	discover() {
		const out = [];
		for (const file of walkJsonl$1(ROOT$5)) {
			let mtime = 0, size = 0;
			try {
				const st = statSync(file);
				mtime = st.mtimeMs;
				size = st.size;
			} catch {
				continue;
			}
			out.push({
				agent: this.name,
				id: file,
				title: basename(file, ".jsonl"),
				cwd: realCwd(file),
				updatedAt: mtime,
				fingerprint: `${Math.round(mtime)}:${size}`,
				kind: "file"
			});
		}
		return out.sort((a, b) => b.updatedAt - a.updatedAt);
	},
	parse(id) {
		let text;
		try {
			text = readFileSync(id, "utf8");
		} catch {
			return [];
		}
		const turns = [];
		for (const entry of parseJsonl(text)) turns.push(...entryToTurns(entry));
		return turns;
	}
};
/**
* 假 0 哨兵：存储根目录存在但 discover 为 0——上游可能已迁移存储布局。
* 出处：opencode 1.18 迁 SQLite 后旧读取器本机假报 0（casr #26 同日中招）。
* 适用于文件布局适配器（codex / cursor / grok）与 opencode 的 storage 回退路径；
* 根目录不存在（没装）不触发——那是正常静默。
*/
const FAKE_ZERO_NOTE = "存储目录存在但未发现会话——上游可能已迁移存储布局（参考 opencode 1.18 迁 SQLite）";
/**
* Codex 适配器：~/.codex/sessions 下递归的 rollout-*.jsonl。
* session_meta 给 cwd；response_item 是权威消息流（event_msg 为 UI 事件，跳过避免重复）。
* 移植自 dsh-hippo src/agents/codex.ts；root 可用 HANDOFF_ROOT_CODEX 覆盖（测试用）。
*/
const ROOT$4 = process.env["HANDOFF_ROOT_CODEX"] ?? join(homedir(), ".codex", "sessions");
function* walkJsonl(dir) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		const p = join(dir, e.name);
		if (e.isDirectory()) yield* walkJsonl(p);
		else if (e.isFile() && e.name.endsWith(".jsonl")) yield p;
	}
}
function parseCodexText(text) {
	let cwd = "";
	const turns = [];
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line === "") continue;
		let obj;
		try {
			obj = JSON.parse(line);
		} catch {
			continue;
		}
		const ts = obj.timestamp ?? "";
		if (obj.type === "session_meta") {
			cwd = typeof obj.payload?.cwd === "string" ? obj.payload.cwd : "";
			continue;
		}
		if (obj.type !== "response_item" || obj.payload === void 0) continue;
		const p = obj.payload;
		if (p.type === "message") {
			const role = p.role === "user" ? "user" : p.role === "assistant" ? "assistant" : "";
			if (!role) continue;
			const body = (Array.isArray(p.content) ? p.content : []).map((c) => c && typeof c === "object" && typeof c.text === "string" ? c.text : "").filter(Boolean).join("\n");
			if (body) turns.push(makeTurn({
				role,
				text: body,
				cwd,
				ts,
				model: typeof p.model === "string" ? p.model : ""
			}));
		} else if (p.type === "function_call" || p.type === "custom_tool_call" || p.type === "local_shell_call") {
			const name = typeof p.name === "string" ? p.name : String(p.type);
			turns.push(makeTurn({
				role: "tool",
				text: name,
				cwd,
				ts,
				toolName: name
			}));
		} else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
			const out = typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? "");
			turns.push(makeTurn({
				role: "tool",
				text: out.slice(0, 2e3),
				cwd,
				ts,
				toolFailed: /\berror\b/i.test(out.slice(0, 400))
			}));
		}
	}
	return turns;
}
const codexAdapter = {
	name: "codex",
	root: ROOT$4,
	supported: true,
	discover() {
		const out = [];
		for (const file of walkJsonl(ROOT$4)) {
			let mtime = 0, size = 0;
			try {
				const st = statSync(file);
				mtime = st.mtimeMs;
				size = st.size;
			} catch {
				continue;
			}
			out.push({
				agent: this.name,
				id: file,
				title: basename(file, ".jsonl"),
				cwd: "",
				updatedAt: mtime,
				fingerprint: `${Math.round(mtime)}:${size}`,
				kind: "file"
			});
		}
		this.note = out.length === 0 && existsSync(ROOT$4) ? FAKE_ZERO_NOTE : void 0;
		return out.sort((a, b) => b.updatedAt - a.updatedAt);
	},
	parse(id) {
		try {
			return parseCodexText(readFileSync(id, "utf8"));
		} catch {
			return [];
		}
	}
};
/**
* opencode 适配器：双布局自动探测。
* - 新版：~/.local/share/opencode/opencode.db（SQLite）——session / message / part 三表，
*   message.data 与 part.data 均为 JSON 文本（role / type: text | tool）。
* - 旧版：storage/ 三层文件布局——session/<projectID>/ses_*.json → message/<ses>/msg_*.json
*   → part/<msg>/prt_*.json。
* opencode.db 存在即优先走 DB（node:sqlite 只读打开，不拿写锁）；node:sqlite 不可用或
* DB 不存在时回退旧版文件布局；两者皆缺返回空列表。
* 移植自 dsh-hippo src/agents/opencode.ts；root 可用 HANDOFF_ROOT_OPENCODE 覆盖
* （指向包含 opencode.db 或 storage/ 的目录，测试用）。
*/
const BASE = process.env["HANDOFF_ROOT_OPENCODE"] ?? join(homedir(), ".local", "share", "opencode");
const DB_PATH$1 = join(BASE, "opencode.db");
const LEGACY_ROOT = join(BASE, "storage");
/** node:sqlite 可用性：createRequire 同步加载内建模块，失败即回退文件布局（不拖垮其他适配器）。 */
function loadSqlite$2() {
	try {
		return createRequire(import.meta.url)("node:sqlite").DatabaseSync;
	} catch {
		return null;
	}
}
const DatabaseSync$2 = loadSqlite$2();
/** node:sqlite 缺席但新版 DB 在场的静态说明（走 DB 前先挂上）；假 0 哨兵触发时被覆盖 */
const BASE_NOTE$1 = DatabaseSync$2 === null && existsSync(DB_PATH$1) ? "需要 Node ≥22（node:sqlite）读取新版 opencode.db" : void 0;
function openDb(dbPath = DB_PATH$1) {
	if (DatabaseSync$2 === null || !existsSync(dbPath)) return null;
	try {
		return new DatabaseSync$2(dbPath, { readOnly: true });
	} catch {
		return null;
	}
}
function parseJsonFile(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}
function safeJson(text) {
	try {
		return JSON.parse(String(text));
	} catch {
		return null;
	}
}
/** 旧版文件布局：一个 ses_*.json 会话文件 → Turn 流 */
function parseOpenCodeSession(sessionFile, storageRoot) {
	const session = parseJsonFile(sessionFile);
	if (!session?.id) return [];
	const cwd = session.directory ?? "";
	const msgDir = join(storageRoot, "message", session.id);
	let msgFiles;
	try {
		msgFiles = readdirSync(msgDir).filter((f) => f.endsWith(".json")).map((f) => join(msgDir, f));
	} catch {
		return [];
	}
	const msgs = msgFiles.map((f) => parseJsonFile(f)).filter((m) => m !== null && (m.role === "user" || m.role === "assistant") && typeof m.id === "string").sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0));
	const turns = [];
	for (const m of msgs) {
		const partDir = join(storageRoot, "part", m.id);
		let partFiles;
		try {
			partFiles = readdirSync(partDir).filter((f) => f.endsWith(".json")).map((f) => join(partDir, f));
		} catch {
			partFiles = [];
		}
		const parts = partFiles.map((f) => parseJsonFile(f)).filter((p) => p !== null);
		const body = parts.filter((p) => p.type === "text" && p.text).map((p) => p.text).join("\n");
		const ts = m.time?.created ? new Date(m.time.created).toISOString() : "";
		if (body) turns.push(makeTurn({
			role: m.role === "user" ? "user" : "assistant",
			text: body,
			cwd,
			ts
		}));
		for (const p of parts) {
			if (p.type !== "tool") continue;
			turns.push(makeTurn({
				role: "tool",
				text: (p.text ?? "").slice(0, 2e3),
				cwd,
				ts,
				toolName: p.tool ?? "",
				toolFailed: p.state?.status === "error"
			}));
		}
	}
	return turns;
}
/** DB 模式：按 session id 读 opencode.db。dbPath 可注入（单测用临时库）。 */
function parseOpenCodeDbSession(sessionId, dbPath = DB_PATH$1) {
	const db = openDb(dbPath);
	if (db === null) return [];
	try {
		const cwd = db.prepare("SELECT directory FROM session WHERE id = ?").all(sessionId)[0]?.directory ?? "";
		const messages = db.prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id").all(sessionId);
		const turns = [];
		for (const m of messages) {
			const meta = safeJson(m.data);
			if (!meta || meta.role !== "user" && meta.role !== "assistant") continue;
			const ts = meta.time?.created ? new Date(meta.time.created).toISOString() : "";
			const parts = db.prepare("SELECT data FROM part WHERE message_id = ? ORDER BY time_created, id").all(m.id);
			const texts = [];
			for (const row of parts) {
				const part = safeJson(row.data);
				if (!part) continue;
				if (part.type === "text" && part.text) {
					texts.push(part.text);
					continue;
				}
				if (part.type === "tool") turns.push(makeTurn({
					role: "tool",
					text: (part.text ?? "").slice(0, 2e3),
					cwd,
					ts,
					toolName: part.tool ?? "",
					toolFailed: part.state?.status === "error"
				}));
			}
			const body = texts.join("\n");
			if (body) turns.push(makeTurn({
				role: meta.role === "user" ? "user" : "assistant",
				text: body,
				cwd,
				ts
			}));
		}
		return turns;
	} finally {
		db.close();
	}
}
const opencodeAdapter = {
	name: "opencode",
	root: BASE,
	supported: true,
	note: BASE_NOTE$1,
	discover() {
		const out = [];
		const db = openDb();
		if (db !== null) try {
			const rows = db.prepare("SELECT id, title, directory, time_updated FROM session ORDER BY time_updated DESC").all();
			for (const r of rows) out.push({
				agent: this.name,
				id: String(r.id),
				title: r.title ?? "",
				cwd: r.directory ?? "",
				updatedAt: Number(r.time_updated ?? 0),
				fingerprint: String(r.time_updated ?? 0),
				kind: "sqlite"
			});
			return out;
		} finally {
			db.close();
		}
		const sessionRoot = join(LEGACY_ROOT, "session");
		let projects = [];
		try {
			projects = readdirSync(sessionRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(sessionRoot, d.name));
		} catch {
			if (existsSync(LEGACY_ROOT)) this.note = FAKE_ZERO_NOTE;
			return out;
		}
		for (const projDir of projects) {
			let names = [];
			try {
				names = readdirSync(projDir);
			} catch {
				continue;
			}
			for (const f of names) {
				if (!f.endsWith(".json")) continue;
				const file = join(projDir, f);
				const meta = parseJsonFile(file);
				let mtime = 0;
				try {
					mtime = statSync(file).mtimeMs;
				} catch {
					continue;
				}
				out.push({
					agent: this.name,
					id: file,
					title: meta?.title ?? basename(f, ".json"),
					cwd: meta?.directory ?? "",
					updatedAt: meta?.time?.updated ?? mtime,
					fingerprint: `${Math.round(mtime)}`,
					kind: "file"
				});
			}
		}
		if (out.length === 0 && existsSync(LEGACY_ROOT)) this.note = FAKE_ZERO_NOTE;
		else if (out.length > 0) this.note = BASE_NOTE$1;
		return out.sort((a, b) => b.updatedAt - a.updatedAt);
	},
	parse(id) {
		if (id.endsWith(".json")) return parseOpenCodeSession(id, LEGACY_ROOT);
		return parseOpenCodeDbSession(id);
	}
};
/**
* zcode 适配器：~/.zcode/cli/db/db.sqlite 的 session/message/part 三层表。
* 活库（当前会话在写）——一律 readonly 打开，随开随关。
* part 类型：text（正文）/ reasoning（思考，映射为 assistant 轮）/ tool（state.status=error
* 是失败信号）/ step-start（跳过）。
*
* 移植自 dsh-hippo src/agents/zcode.ts，依赖消除：better-sqlite3 → Node 内置
* node:sqlite（DatabaseSync，Node ≥22 自带；不支持则 supported=false 优雅降级，
* 不引入任何原生模块）。dbPath 可用 HANDOFF_ROOT_ZCODE 覆盖（测试用）。
*/
const DB_PATH = process.env["HANDOFF_ROOT_ZCODE"] ?? join(homedir(), ".zcode", "cli", "db", "db.sqlite");
/** node:sqlite 可用性：createRequire 同步加载内建模块，失败即不支持（不拖垮其他适配器）。 */
function loadSqlite$1() {
	try {
		return createRequire(import.meta.url)("node:sqlite").DatabaseSync;
	} catch {
		return null;
	}
}
const DatabaseSync$1 = loadSqlite$1();
function openReadonly(dbPath = DB_PATH) {
	if (DatabaseSync$1 === null || !existsSync(dbPath)) return null;
	try {
		return new DatabaseSync$1(dbPath, { readOnly: true });
	} catch {
		return null;
	}
}
/** dbPath 可注入（单测用临时库），缺省真实 ~/.zcode/cli/db/db.sqlite。 */
function parseZcodeSession(sessionId, dbPath = DB_PATH) {
	const db = openReadonly(dbPath);
	if (db === null) return [];
	try {
		const cwd = db.prepare("SELECT id, path FROM session WHERE id = ?").all(sessionId)[0]?.path ?? "";
		const messages = db.prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY sequence").all(sessionId);
		const turns = [];
		for (const m of messages) {
			let role = null;
			let created = 0;
			try {
				const d = JSON.parse(m.data);
				role = d.role === "user" ? "user" : d.role === "assistant" ? "assistant" : null;
				created = d.time?.created ?? 0;
			} catch {
				continue;
			}
			if (role === null) continue;
			const ts = created ? new Date(created).toISOString() : "";
			const parts = db.prepare("SELECT data FROM part WHERE message_id = ? ORDER BY sequence").all(m.id);
			for (const p of parts) {
				let pd;
				try {
					pd = JSON.parse(p.data);
				} catch {
					continue;
				}
				if (pd.type === "text" && pd.text) turns.push(makeTurn({
					role,
					text: pd.text,
					cwd,
					ts
				}));
				else if (pd.type === "reasoning" && pd.text) turns.push(makeTurn({
					role: "assistant",
					text: "[thinking] " + pd.text.slice(0, 4e3),
					cwd,
					ts
				}));
				else if (pd.type === "tool") {
					const failed = pd.state?.status === "error";
					const input = typeof pd.state?.input === "object" && pd.state?.input !== null ? JSON.stringify(pd.state.input).slice(0, 300) : "";
					const output = typeof pd.state?.output === "string" ? pd.state.output.slice(0, 2e3) : "";
					turns.push(makeTurn({
						role: "tool",
						text: (input + "\n" + output).trim(),
						cwd,
						ts,
						toolName: pd.tool ?? "",
						toolFailed: failed
					}));
				}
			}
		}
		return turns;
	} finally {
		db.close();
	}
}
const zcodeAdapter = {
	name: "zcode",
	root: DB_PATH,
	supported: DatabaseSync$1 !== null,
	note: DatabaseSync$1 === null ? "需要 Node ≥22（node:sqlite 内建模块）" : void 0,
	discover() {
		const db = openReadonly();
		if (db === null) return [];
		try {
			return db.prepare("SELECT id, path, title, time_created, time_updated FROM session").all().map((r) => ({
				agent: this.name,
				id: r.id,
				title: r.title ?? r.id.slice(0, 18),
				cwd: r.path ?? "",
				updatedAt: r.time_updated ?? r.time_created ?? 0,
				fingerprint: String(r.time_updated ?? r.time_created ?? 0),
				kind: "sqlite"
			})).sort((a, b) => b.updatedAt - a.updatedAt);
		} catch {
			return [];
		} finally {
			db.close();
		}
	},
	parse(id) {
		return parseZcodeSession(id);
	}
};
/**
* pi 适配器（badlogic/pi-mono）：~/.pi/agent/sessions/<路径转义>/时间戳_uuid.jsonl
* 事件流格式：type=session 给 cwd；type=message 的 message.content[] 是文本块。
* 标题取首条用户消息前 40 字（发现期限量读首 64KB，不整文件解析）。
* 移植自 dsh-hippo src/agents/pi.ts；root 可用 HANDOFF_ROOT_PI 覆盖（测试用）。
*/
const ROOT$3 = process.env["HANDOFF_ROOT_PI"] ?? join(homedir(), ".pi", "agent", "sessions");
/** 限量读文件头（标题/cwd 用，避免发现期整读大会话）。 */
function readHead$1(path, bytes = 65536) {
	try {
		const fd = openSync(path, "r");
		try {
			const buf = Buffer.alloc(bytes);
			const n = readSync(fd, buf, 0, bytes, 0);
			return buf.toString("utf8", 0, n);
		} finally {
			closeSync(fd);
		}
	} catch {
		return "";
	}
}
function cwdOf(headText) {
	for (const raw of headText.split("\n")) {
		if (raw.trim() === "") continue;
		try {
			const ev = JSON.parse(raw);
			if (ev.type === "session" && typeof ev.cwd === "string") return ev.cwd;
		} catch {
			continue;
		}
	}
	return "";
}
function titleOf(headText) {
	for (const raw of headText.split("\n")) {
		if (raw.trim() === "") continue;
		try {
			const ev = JSON.parse(raw);
			if (ev.type === "message" && ev.message?.role === "user") {
				const text = (ev.message.content ?? []).map((c) => c.text ?? "").join(" ").trim();
				if (text) return text.slice(0, 40);
			}
		} catch {
			continue;
		}
	}
	return "";
}
function parsePiText(text) {
	let cwd = "";
	const turns = [];
	for (const raw of text.split("\n")) {
		if (raw.trim() === "") continue;
		let ev;
		try {
			ev = JSON.parse(raw);
		} catch {
			continue;
		}
		if (ev.type === "session" && typeof ev.cwd === "string") {
			cwd = ev.cwd;
			continue;
		}
		if (ev.type !== "message" || !ev.message) continue;
		const role = ev.message.role === "user" ? "user" : ev.message.role === "assistant" ? "assistant" : "";
		if (!role) continue;
		const body = (ev.message.content ?? []).filter((c) => c.type === "text" && c.text).map((c) => c.text).join("\n");
		if (body) turns.push(makeTurn({
			role,
			text: body,
			cwd
		}));
	}
	return turns;
}
const piAdapter = {
	name: "pi",
	root: ROOT$3,
	supported: true,
	discover() {
		const out = [];
		let dirs = [];
		try {
			dirs = readdirSync(ROOT$3, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(ROOT$3, d.name));
		} catch {
			return out;
		}
		for (const dir of dirs) {
			let files = [];
			try {
				files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
			} catch {
				continue;
			}
			for (const f of files) {
				const file = join(dir, f);
				let mtime = 0, size = 0;
				try {
					const st = statSync(file);
					mtime = st.mtimeMs;
					size = st.size;
				} catch {
					continue;
				}
				const head = readHead$1(file);
				out.push({
					agent: this.name,
					id: file,
					title: titleOf(head) || basename(f, ".jsonl"),
					cwd: cwdOf(head),
					updatedAt: mtime,
					fingerprint: `${Math.round(mtime)}:${size}`,
					kind: "file"
				});
			}
		}
		return out.sort((a, b) => b.updatedAt - a.updatedAt);
	},
	parse(id) {
		try {
			return parsePiText(readFileSync(id, "utf8"));
		} catch {
			return [];
		}
	}
};
/**
* WorkBuddy 适配器：~/.workbuddy/projects/<workspace-slug>/<uuid>.jsonl
* 一文件 = 一会话（单 sessionId）。记录类型（2026-09-01 实测真实会话）：
*
*   message(role=user|assistant) → 用户/助手轮。content 是块数组，取
*     input_text/output_text 块的 text 拼接；image_blob_ref 等其他块跳过。
*   reasoning → 思考行，跳过（与 function_call 交织密度高，并入会打乱轮次结构；
*     交接只要显式陈述，思考本就是过程自语）。
*   function_call → 工具调用轮：toolName=name，text=name+arguments 摘要。
*   function_call_result → 工具结果轮：text=output.text，status!=='completed' 即 toolFailed。
*   file-history-snapshot / ai-title / resend-fork-notice → 跳过
*     （ai-title 的标题在 discover 阶段取走作 SessionRef.title）。
*
* 移植自 dsh-hippo src/agents/workbuddy.ts；root 可用 HANDOFF_ROOT_WORKBUDDY 覆盖（测试用）。
*/
const ROOT$2 = process.env["HANDOFF_ROOT_WORKBUDDY"] ?? join(homedir(), ".workbuddy", "projects");
/** 逐行读 JSONL（坏行跳过，与 claude 适配器同策略）。 */
function* readJsonl(file) {
	for (const line of readFileSync(file, "utf8").split("\n")) {
		const t = line.trim();
		if (t === "") continue;
		try {
			yield JSON.parse(t);
		} catch {}
	}
}
/** content 块数组 → 纯文本（取 *_text 块，其余块跳过）。 */
function blocksToText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const b of content) if (b !== null && typeof b === "object" && typeof b.type === "string") {
		const { type, text } = b;
		if (type.endsWith("_text") && typeof text === "string" && text !== "") parts.push(text);
	}
	return parts.join("\n").trim();
}
/** function_call_result 的 output：{type:'text',text} 对象或纯字符串。 */
function resultToText(output) {
	if (typeof output === "string") return output;
	if (output !== null && typeof output === "object") {
		const { text } = output;
		if (typeof text === "string") return text;
	}
	return "";
}
const workbuddyAdapter = {
	name: "workbuddy",
	root: ROOT$2,
	supported: true,
	discover() {
		const out = [];
		let projectDirs;
		try {
			projectDirs = readdirSync(ROOT$2, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
		} catch {
			return out;
		}
		for (const dir of projectDirs) {
			let files;
			try {
				files = readdirSync(join(ROOT$2, dir)).filter((f) => f.endsWith(".jsonl"));
			} catch {
				continue;
			}
			for (const f of files) {
				const full = join(ROOT$2, dir, f);
				let mtime = 0;
				let size = 0;
				try {
					const st = statSync(full);
					mtime = st.mtimeMs;
					size = st.size;
				} catch {
					continue;
				}
				let title = basename(f, ".jsonl");
				let cwd = "";
				try {
					const fd = openSync(full, "r");
					const buf = Buffer.alloc(65536);
					const n = readSync(fd, buf, 0, buf.length, 0);
					closeSync(fd);
					const head = buf.slice(0, n).toString("utf8");
					const m = head.match(/"type":\s*"ai-title",[^}]*?"aiTitle":\s*"((?:[^"\\]|\\.)*)"/);
					if (m) try {
						title = JSON.parse(`"${m[1]}"`);
					} catch {
						title = m[1];
					}
					const cm = head.match(/"cwd":\s*"((?:[^"\\]|\\.)*)"/);
					if (cm) try {
						cwd = JSON.parse(`"${cm[1]}"`);
					} catch {
						cwd = cm[1];
					}
				} catch {}
				out.push({
					agent: this.name,
					id: full,
					title,
					cwd,
					updatedAt: mtime,
					fingerprint: `${Math.round(mtime)}:${size}`,
					kind: "file"
				});
			}
		}
		return out.sort((a, b) => b.updatedAt - a.updatedAt);
	},
	parse(id) {
		let entries;
		try {
			entries = [...readJsonl(id)];
		} catch {
			return [];
		}
		const turns = [];
		for (const e of entries) {
			const type = e.type;
			const cwd = typeof e.cwd === "string" ? e.cwd : "";
			const ts = typeof e.timestamp === "number" ? new Date(e.timestamp).toISOString() : "";
			if (type === "message") {
				const role = e.role === "user" ? "user" : e.role === "assistant" ? "assistant" : null;
				if (role === null) continue;
				const text = blocksToText(e.content);
				if (text === "") continue;
				turns.push(makeTurn({
					role,
					text,
					cwd,
					ts
				}));
			} else if (type === "function_call") {
				const name = typeof e.name === "string" ? e.name : "";
				if (name === "") continue;
				const args = typeof e.arguments === "string" ? e.arguments.slice(0, 400) : "";
				turns.push(makeTurn({
					role: "tool",
					text: args === "" ? name : `${name} ${args}`,
					cwd,
					ts,
					toolName: name
				}));
			} else if (type === "function_call_result") {
				const name = typeof e.name === "string" ? e.name : "";
				const status = typeof e.status === "string" ? e.status : "";
				const text = resultToText(e.output).slice(0, 2e3);
				turns.push(makeTurn({
					role: "tool",
					text: text === "" ? `(${name} 无输出)` : text,
					cwd,
					ts,
					toolName: name === "" ? "result" : name,
					toolFailed: status !== "" && status !== "completed"
				}));
			}
		}
		return turns;
	}
};
/**
* Cursor 适配器（自研 TS 实现；格式为公开逆向调研，
* Apache-2.0，其 NOTICE 声明该 reader 逐字节来自 xAI Grok 1.0.5 捆绑 skill——
* 此处只学存储格式，不复制其代码）。
*
* 两种本地存储形态（root 可用 HANDOFF_ROOT_CURSOR 覆盖，测试用）：
*
* 1) transcript 文件：<root>/projects/<工作区目录>/agent-transcripts/<会话id>/<会话id>.jsonl
*    逐行 JSON，每行是一个带 role 的 value（与 store blob 同构）。
* 2) CLI chats：<root>/chats/<md5(cwd)>/<uuid>/，内含 meta.json（标题/cwd/更新时间）
*    与 store.db（SQLite：meta 表存元数据、blobs 表存 value，value 可能是
*    UTF-8 JSON 或十六进制编码的 JSON；二进制 / protobuf 块标不可用、不臆造）。
*
* value 渲染纪律：
* - value.type 为 thinking / reasoning / redacted_thinking → 整条跳过（隐藏推理）。
* - role 归一后不在 user / assistant / tool 内（system / developer / instruction /
*   preamble 等）→ 整条跳过（系统提示不进交接）。
* - content 块：text / input_text / output_text 取正文；thinking / signature 跳过；
*   tool_use / tool_call 成 assistant 工具轮（只记 name+input 摘要，永不回放）；
*   tool_result / tool_output 成 tool 轮（is_error → toolFailed）。
* - 顶层 value.tool_calls（OpenAI 形态）同样只记摘要。
* - user 正文：优先抽 <user_query>…</user_query>；以 <environment_context /
*   <user_instructions / <system_reminder / <manually_attached_skills / <timestamp
*   等包装开头的一律丢弃；生成元文本（XML 标签开头 / [Request interrupted by user）丢弃。
* - value 里的 messages / turns / conversation / bubbles 嵌套数组递归展开。
*
* 只读不写：store.db 一律 readonly 打开随开随关；不复活 Cursor、不回放存储的调用。
*/
const ROOT$1 = process.env["HANDOFF_ROOT_CURSOR"] ?? join(homedir(), ".cursor");
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** 系统提示 / 前言 / 指令类 role：整条跳过 */
const SKIPPED_ROLES = /* @__PURE__ */ new Set([
	"system",
	"developer",
	"instruction",
	"instructions",
	"preamble"
]);
/** 隐藏推理块 / 签名块：跳过 */
const SKIPPED_BLOCK_TYPES = /* @__PURE__ */ new Set([
	"thinking",
	"reasoning",
	"redacted_thinking",
	"signature"
]);
/** user 正文里这些包装开头 = 环境/指令注入，不是用户原话 */
const BLOCKED_USER_WRAPPERS = [
	"<environment_context",
	"<user_instructions",
	"<system_reminder",
	"<manually_attached_skills",
	"<timestamp"
];
/** 生成元文本：XML 标签开头，或 "[Request interrupted by user" */
const GENERATED_META_RE = /^\s*<[a-z][A-Za-z0-9_.:-]*(?:\s|\/?>)/;
const INTERRUPTED_RE = /^\s*\[Request interrupted by user/i;
/** node:sqlite 可用性（与 zcode 适配器同策略）：缺失时 store.db 形态不可用，transcript 不受影响。 */
function loadSqlite() {
	try {
		return createRequire(import.meta.url)("node:sqlite").DatabaseSync;
	} catch {
		return null;
	}
}
const DatabaseSync = loadSqlite();
/** content 归一为块数组：字符串 → 单 text 块；对象 → 单块；数组过滤非对象。 */
function blocksOf(content) {
	if (typeof content === "string") return [{
		type: "text",
		text: content
	}];
	if (Array.isArray(content)) return content.filter((b) => b !== null && typeof b === "object");
	if (content !== null && typeof content === "object") return [content];
	return [];
}
/** tool_result 块的 content → 纯文本（字符串 / 块数组 / {text} 对象）。 */
function contentText(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const parts = [];
		for (const item of content) if (typeof item === "string") parts.push(item);
		else if (item !== null && typeof item === "object") {
			const t = item.text;
			if (typeof t === "string") parts.push(t);
		}
		return parts.join("\n");
	}
	if (content !== null && typeof content === "object") {
		const t = content.text;
		if (typeof t === "string") return t;
	}
	return "";
}
/** user 正文清洗：抽 <user_query>；包装注入丢弃；其余原样。 */
function cursorUserText(text) {
	const matches = [...text.matchAll(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/g)];
	if (matches.length > 0) {
		const joined = matches.map((m) => (m[1] ?? "").trim()).filter((s) => s !== "").join("\n");
		return joined === "" ? null : joined;
	}
	const stripped = text.trimStart();
	if (BLOCKED_USER_WRAPPERS.some((w) => stripped.startsWith(w))) return null;
	return text;
}
/**
* 渲染一个 Cursor value 为 Turn 流（text 轮 + 工具调用轮 + 工具结果轮）。
* 返回空数组 = 该 value 是系统提示 / 隐藏推理 / 空内容（调用方计数即可）。
*/
function renderCursorValue(value) {
	if (value === null || typeof value !== "object") return [];
	const v = value;
	const vtype = typeof v.type === "string" ? v.type : "";
	if (SKIPPED_BLOCK_TYPES.has(vtype)) return [];
	const role = typeof v.role === "string" ? v.role.toLowerCase() : "";
	if (role === "" || SKIPPED_ROLES.has(role)) {
		for (const key of [
			"messages",
			"turns",
			"conversation",
			"bubbles"
		]) {
			const nested = v[key];
			if (Array.isArray(nested)) return nested.flatMap((item) => renderCursorValue(item));
		}
		return [];
	}
	if (role !== "user" && role !== "assistant" && role !== "tool") return [];
	const ts = typeof v.timestamp === "string" ? v.timestamp : typeof v.timestamp === "number" ? new Date(v.timestamp).toISOString() : "";
	const message = v.message !== null && typeof v.message === "object" ? v.message : null;
	const content = message !== null && "content" in message ? message.content : v.content;
	const texts = [];
	const callTurns = [];
	const resultTurns = [];
	for (const block of blocksOf(content)) {
		const btype = typeof block.type === "string" ? block.type : "";
		if (SKIPPED_BLOCK_TYPES.has(btype)) continue;
		if (btype === "text" || btype === "input_text" || btype === "output_text") {
			const raw = typeof block.text === "string" ? block.text : "";
			if (raw === "") continue;
			const rendered = role === "user" ? cursorUserText(raw) : GENERATED_META_RE.test(raw) || INTERRUPTED_RE.test(raw) ? null : raw;
			if (rendered !== null && rendered.trim() !== "") texts.push(rendered);
		} else if (btype === "tool_use" || btype === "tool_call") {
			const name = typeof block.name === "string" ? block.name : "unknown";
			const input = "input" in block ? block.input : block.arguments;
			callTurns.push(makeTurn({
				role: "assistant",
				text: summarizeToolCall(name, input),
				ts,
				toolName: name
			}));
		} else if (btype === "tool_result" || btype === "tool_output") resultTurns.push(makeTurn({
			role: "tool",
			text: contentText(block.content).slice(0, 2e3),
			ts,
			toolFailed: Boolean(block.is_error)
		}));
	}
	if (Array.isArray(v.tool_calls)) for (const call of v.tool_calls) {
		if (call === null || typeof call !== "object") continue;
		const c = call;
		const fn = c.function !== null && typeof c.function === "object" ? c.function : c;
		const name = typeof fn.name === "string" ? fn.name : "unknown";
		let input = "arguments" in fn ? fn.arguments : fn.input;
		if (typeof input === "string") try {
			input = JSON.parse(input);
		} catch {}
		callTurns.push(makeTurn({
			role: "assistant",
			text: summarizeToolCall(name, input),
			ts,
			toolName: name
		}));
	}
	if (role === "tool" && resultTurns.length === 0) {
		resultTurns.push(makeTurn({
			role: "tool",
			text: contentText(content).slice(0, 2e3),
			ts,
			toolFailed: Boolean(v.is_error)
		}));
		texts.length = 0;
	}
	const turns = [];
	const text = texts.join("\n").trim();
	if (text !== "") turns.push(makeTurn({
		role: role === "tool" ? "tool" : role,
		text,
		ts
	}));
	turns.push(...callTurns, ...resultTurns);
	return turns;
}
/** transcript JSONL 文本 → Turn 流（坏行静默跳过）。 */
function parseCursorTranscriptText(text) {
	const turns = [];
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line === "") continue;
		let value;
		try {
			value = JSON.parse(line);
		} catch {
			continue;
		}
		turns.push(...renderCursorValue(value));
	}
	return turns;
}
/** store blob 解码：Buffer/字符串 → JSON；偶数长度纯十六进制串先试 hex 解码；失败 = 二进制/protobuf，返回 null。 */
function decodeCursorBlob(raw) {
	let text;
	if (raw instanceof Uint8Array) try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
	} catch {
		return null;
	}
	else if (typeof raw === "string") text = raw;
	else if (raw !== null && typeof raw === "object") return raw;
	else return null;
	const stripped = text.trim();
	if (stripped === "") return null;
	if (stripped.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(stripped)) try {
		return JSON.parse(Buffer.from(stripped, "hex").toString("utf-8"));
	} catch {}
	try {
		return JSON.parse(stripped);
	} catch {
		return null;
	}
}
/** store.db（blobs 表：id/data 或 key/value 等列名）→ Turn 流；缺库/缺 sqlite 返回 []。 */
function parseCursorStore(dbPath) {
	if (DatabaseSync === null || !existsSync(dbPath)) return [];
	let db;
	try {
		db = new DatabaseSync(dbPath, { readOnly: true });
	} catch {
		return [];
	}
	try {
		const cols = new Set(db.prepare("PRAGMA table_info(\"blobs\")").all().map((c) => c.name));
		const keyCol = [
			"id",
			"key",
			"hash"
		].find((c) => cols.has(c));
		const valCol = [
			"data",
			"value",
			"blob"
		].find((c) => cols.has(c));
		if (keyCol === void 0 || valCol === void 0) return [];
		const rows = db.prepare(`SELECT "${valCol}" FROM blobs ORDER BY "${keyCol}"`).all();
		const turns = [];
		for (const row of rows) {
			const value = decodeCursorBlob(Array.isArray(row) ? row[0] : row[valCol]);
			if (value === null) continue;
			turns.push(...renderCursorValue(value));
		}
		return turns;
	} catch {
		return [];
	} finally {
		db.close();
	}
}
/** 限量读文件头（发现期取标题用）。 */
function readHead(path, bytes = 65536) {
	try {
		const fd = openSync(path, "r");
		try {
			const buf = Buffer.alloc(bytes);
			const n = readSync(fd, buf, 0, bytes, 0);
			return buf.toString("utf8", 0, n);
		} finally {
			closeSync(fd);
		}
	} catch {
		return "";
	}
}
/** 头部文本里第一条 user 正文前 40 字作标题。 */
function transcriptTitle(head) {
	for (const turn of parseCursorTranscriptText(head)) if (turn.role === "user" && turn.text.trim() !== "") return turn.text.trim().slice(0, 40);
	return "";
}
/** meta.json → 标题 / cwd / 更新时间（尽力而为，字段缺失留空）。 */
function readMetaJson(path) {
	const meta = {
		title: "",
		cwd: "",
		updatedAt: 0
	};
	try {
		const value = JSON.parse(readFileSync(path, "utf8"));
		if (typeof value.title === "string") meta.title = value.title;
		else if (typeof value.name === "string") meta.title = value.name;
		if (typeof value.cwd === "string") meta.cwd = value.cwd;
		else if (typeof value.workspacePath === "string") meta.cwd = value.workspacePath;
		const ws = value.workspaceIdentifier;
		if (meta.cwd === "" && ws !== null && typeof ws === "object") {
			const w = ws;
			const uri = w.uri !== null && typeof w.uri === "object" ? w.uri : null;
			meta.cwd = typeof uri?.fsPath === "string" && uri.fsPath || typeof uri?.path === "string" && uri.path || typeof w.fsPath === "string" && w.fsPath || "";
		}
		for (const key of [
			"updatedAtMs",
			"lastUpdatedAt",
			"updated_at_ms"
		]) {
			const t = value[key];
			if (typeof t === "number" && t > 0) {
				meta.updatedAt = t < 0xe8d4a51000 ? t * 1e3 : t;
				break;
			}
		}
	} catch {}
	return meta;
}
/** node:sqlite 缺席时的静态说明（有数据但仍缺 sqlite 时显示）；假 0 哨兵触发时被覆盖，有数据后恢复 */
const BASE_NOTE = DatabaseSync === null ? "CLI store.db 形态需要 Node ≥22（node:sqlite）；transcript 形态不受影响" : void 0;
const cursorAdapter = {
	name: "cursor",
	root: ROOT$1,
	supported: true,
	note: BASE_NOTE,
	discover() {
		const out = [];
		const seenSessions = /* @__PURE__ */ new Set();
		const projects = join(ROOT$1, "projects");
		let wsDirs = [];
		try {
			wsDirs = readdirSync(projects, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.isSymbolicLink()).map((d) => join(projects, d.name));
		} catch {
			wsDirs = [];
		}
		for (const ws of wsDirs) {
			const atDir = join(ws, "agent-transcripts");
			let sidDirs = [];
			try {
				sidDirs = readdirSync(atDir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.isSymbolicLink()).map((d) => d.name);
			} catch {
				continue;
			}
			for (const sid of sidDirs) {
				const file = join(atDir, sid, `${sid}.jsonl`);
				let mtime = 0, size = 0;
				try {
					const st = statSync(file);
					mtime = st.mtimeMs;
					size = st.size;
				} catch {
					continue;
				}
				seenSessions.add(sid.toLowerCase());
				out.push({
					agent: this.name,
					id: file,
					title: transcriptTitle(readHead(file)) || sid,
					cwd: "",
					updatedAt: mtime,
					fingerprint: `${Math.round(mtime)}:${size}`,
					kind: "file"
				});
			}
		}
		const chats = join(ROOT$1, "chats");
		let hashDirs = [];
		try {
			hashDirs = readdirSync(chats, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.isSymbolicLink()).map((d) => join(chats, d.name));
		} catch {
			hashDirs = [];
		}
		for (const hashDir of hashDirs) {
			let sessionDirs = [];
			try {
				sessionDirs = readdirSync(hashDir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.isSymbolicLink() && UUID_RE.test(d.name)).map((d) => d.name);
			} catch {
				continue;
			}
			for (const sid of sessionDirs) {
				if (seenSessions.has(sid.toLowerCase())) continue;
				const dir = join(hashDir, sid);
				const storePath = join(dir, "store.db");
				const metaPath = join(dir, "meta.json");
				const hasStore = existsSync(storePath);
				if (!hasStore && !existsSync(metaPath)) continue;
				const meta = readMetaJson(metaPath);
				let mtime = meta.updatedAt, size = 0;
				try {
					const st = statSync(hasStore ? storePath : metaPath);
					if (mtime === 0) mtime = st.mtimeMs;
					size = st.size;
				} catch {
					continue;
				}
				out.push({
					agent: this.name,
					id: hasStore ? storePath : metaPath,
					title: meta.title || sid,
					cwd: meta.cwd,
					updatedAt: mtime,
					fingerprint: `${Math.round(mtime)}:${size}`,
					kind: hasStore ? "sqlite" : "file"
				});
			}
		}
		this.note = out.length === 0 && existsSync(ROOT$1) ? FAKE_ZERO_NOTE : BASE_NOTE;
		return out.sort((a, b) => b.updatedAt - a.updatedAt);
	},
	parse(id) {
		try {
			if (id.endsWith(".jsonl")) return parseCursorTranscriptText(readFileSync(id, "utf8"));
			if (basename(id) === "store.db") return parseCursorStore(id);
			if (basename(id) === "meta.json") return [];
			return [];
		} catch {
			return [];
		}
	}
};
/**
* Grok 适配器（自研 TS 实现；格式为公开逆向调研，
* Apache-2.0，其 NOTICE 声明该 reader 逐字节来自 xAI Grok 1.0.5 捆绑 skill——
* 此处只学存储格式，不复制其代码）。
*
* 存储形态（root 可用 HANDOFF_ROOT_GROK 覆盖，测试用；缺省 $GROK_HOME/sessions
* 或 ~/.grok/sessions）：
*
*   <root>/<urlencode(工作区路径)>/<会话id>/
*     summary.json   会话元数据：info.id / info.cwd / generated_title /
*                    session_summary / created_at / last_active_at / updated_at /
*                    current_model_id / head_branch / git_root_dir
*     updates.jsonl  可见更新流（ACP 形态）：每行 {params:{update:{...}}}，
*                    导出流也可能直接是内层 update 对象
*     chat_history.jsonl  原始模型上下文 —— 永不读取（恢复边界）
*
* updates.jsonl 的 update.sessionUpdate（或 update.type）分派：
* - user_message_chunk / agent_message_chunk → 用户/助手文本轮；
*   content 只取 type=text 块，非文本块标「内容不可用」；连续的同角色 chunk
*   是流式分片，合并成一轮。
* - agent_thought_chunk → 隐藏推理，丢弃。
* - hook_execution → hook 执行记录，丢弃。
* - tool_call / tool_call_update → status 缺省/pending 成 assistant 工具轮
*   （name 取 _meta["x.ai/tool"].name/label 或 title/kind；只记摘要，永不回放）；
*   completed/failed 成 tool 结果轮（failed → toolFailed；按 toolCallId 去重）。
*   结果正文：content 块（字符串 / {type:content,content:{type:text}} /
*   {type:text}）；{type:diff} 只留路径标不可用；兜底 rawOutput。
* - plan / turn_completed / 未知类型 → 跳过。
*
* 只读不写、不复活 Grok 进程；损坏行静默跳过；summary.json 损坏的会话不发现。
*/
const GROK_HOME = process.env["GROK_HOME"] ?? join(homedir(), ".grok");
const ROOT = process.env["HANDOFF_ROOT_GROK"] ?? join(GROK_HOME, "sessions");
/** 时间戳 → ms epoch：数字（秒/毫秒自适应）或 ISO 字符串；不可解析返回 0。 */
function toMillis(value) {
	if (typeof value === "number" && Number.isFinite(value)) {
		const n = Math.trunc(value);
		return Math.abs(n) < 0xe8d4a51000 ? n * 1e3 : n;
	}
	if (typeof value === "string" && value !== "") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return 0;
}
/** summary.json → 元数据；文件缺失/损坏返回 null（该会话不发现）。 */
function readSummary(sessionDir) {
	let value;
	try {
		value = JSON.parse(readFileSync(join(sessionDir, "summary.json"), "utf8"));
	} catch {
		return null;
	}
	if (value === null || typeof value !== "object") return null;
	const info = value.info !== null && typeof value.info === "object" ? value.info : {};
	const title = typeof value.generated_title === "string" && value.generated_title !== "" ? value.generated_title : typeof value.session_summary === "string" ? value.session_summary : "";
	return {
		cwd: typeof info.cwd === "string" ? info.cwd : "",
		sessionId: typeof info.id === "string" && info.id !== "" ? info.id : basename(sessionDir),
		title,
		updatedAt: toMillis(value.last_active_at) || toMillis(value.updated_at) || toMillis(value.created_at),
		model: typeof value.current_model_id === "string" ? value.current_model_id : ""
	};
}
/** message chunk 的 content → 纯文本：只取 type=text 块，非文本块标不可用。 */
function grokMessageText(content) {
	const blocks = typeof content === "string" ? [{
		type: "text",
		text: content
	}] : Array.isArray(content) ? content.filter((b) => b !== null && typeof b === "object") : content !== null && typeof content === "object" ? [content] : [];
	const parts = [];
	for (const block of blocks) if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	else {
		const label = typeof block.type === "string" ? block.type.replace(/_/g, " ") : "unknown";
		parts.push(`[${label} 内容不可用]`);
	}
	return parts.join("\n");
}
/** 连续同角色文本 chunk 是流式分片：并入上一轮；否则新开一轮。 */
function appendTextTurn(turns, role, content, cwd, model) {
	const text = grokMessageText(content).trim();
	if (text === "") return;
	const last = turns.at(-1);
	if (last !== void 0 && last.role === role && last.toolName === "") {
		last.text = `${last.text}\n${text}`;
		return;
	}
	turns.push(makeTurn({
		role,
		text,
		cwd,
		model
	}));
}
/** 工具名：_meta["x.ai/tool"].name/label → title → kind → 兜底 grok_tool。 */
function grokToolName(update) {
	const meta = update._meta !== null && typeof update._meta === "object" ? update._meta : {};
	const toolMeta = meta["x.ai/tool"] !== null && typeof meta["x.ai/tool"] === "object" ? meta["x.ai/tool"] : {};
	for (const candidate of [
		toolMeta.name,
		toolMeta.label,
		update.title,
		update.kind
	]) if (typeof candidate === "string" && candidate !== "") return candidate;
	return "grok_tool";
}
/** 工具结果正文：content 块拼接；diff 只留路径；兜底 rawOutput。 */
function grokToolOutput(update) {
	const content = update.content;
	const blocks = Array.isArray(content) ? content : content === void 0 ? [] : [content];
	const parts = [];
	for (const block of blocks) {
		if (typeof block === "string") {
			parts.push(block);
			continue;
		}
		if (block === null || typeof block !== "object") continue;
		const b = block;
		if (b.type === "content") {
			const nested = b.content;
			if (typeof nested === "string") parts.push(nested);
			else if (nested !== null && typeof nested === "object") {
				const n = nested;
				if (n.type === "text" && typeof n.text === "string") parts.push(n.text);
			}
		} else if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
		else if (b.type === "diff") {
			const path = typeof b.path === "string" && b.path !== "" ? b.path : "unknown path";
			parts.push(`[diff 内容不可用：${path}]`);
		}
	}
	let output = parts.join("\n");
	if (output === "" && typeof update.rawOutput === "string") output = update.rawOutput;
	return output.slice(0, 2e3);
}
/**
* updates.jsonl 文本 → Turn 流。只读可见更新流；
* chat_history.jsonl（原始模型上下文）不在此处也永不在此处被读取。
*/
function parseGrokUpdatesText(text, cwd = "", model = "") {
	const turns = [];
	const emittedCalls = /* @__PURE__ */ new Set();
	const emittedResults = /* @__PURE__ */ new Set();
	const callNames = /* @__PURE__ */ new Map();
	let index = 0;
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line === "") continue;
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		index += 1;
		if (record === null || typeof record !== "object") continue;
		const params = record.params !== null && typeof record.params === "object" ? record.params : {};
		let update = params.update !== null && typeof params.update === "object" ? params.update : null;
		if (update === null && typeof record.sessionUpdate === "string") update = record;
		if (update === null) continue;
		const updateType = typeof update.sessionUpdate === "string" ? update.sessionUpdate : typeof update.type === "string" ? update.type : "";
		if (updateType === "user_message_chunk") appendTextTurn(turns, "user", update.content, cwd, model);
		else if (updateType === "agent_message_chunk") appendTextTurn(turns, "assistant", update.content, cwd, model);
		else if (updateType === "agent_thought_chunk" || updateType === "hook_execution") continue;
		else if (updateType === "tool_call" || updateType === "tool_call_update") {
			const callId = update.toolCallId !== void 0 && update.toolCallId !== null ? String(update.toolCallId) : `grok-call-${index}`;
			const status = typeof update.status === "string" ? update.status : "";
			const name = callNames.get(callId) ?? grokToolName(update);
			if (status === "completed" || status === "failed") {
				if (emittedResults.has(callId)) continue;
				emittedResults.add(callId);
				turns.push(makeTurn({
					role: "tool",
					text: grokToolOutput(update),
					cwd,
					toolName: name,
					toolFailed: status === "failed"
				}));
			} else if (!emittedCalls.has(callId)) {
				emittedCalls.add(callId);
				callNames.set(callId, name);
				const meta = update._meta !== null && typeof update._meta === "object" ? update._meta : {};
				const toolMeta = meta["x.ai/tool"] !== null && typeof meta["x.ai/tool"] === "object" ? meta["x.ai/tool"] : {};
				const rawInput = update.rawInput !== void 0 ? update.rawInput : toolMeta.input;
				turns.push(makeTurn({
					role: "assistant",
					text: summarizeToolCall(name, rawInput),
					cwd,
					toolName: name
				}));
			}
		}
	}
	return turns;
}
/** 解析一个会话目录（或 summary.json / updates.jsonl 路径）。 */
function parseGrokSession(id) {
	const base = basename(id);
	const dir = base === "summary.json" || base === "updates.jsonl" ? dirname(id) : id;
	const summary = readSummary(dir);
	const cwd = summary?.cwd ?? "";
	const model = summary?.model ?? "";
	let text;
	try {
		text = readFileSync(join(dir, "updates.jsonl"), "utf8");
	} catch {
		return [];
	}
	return parseGrokUpdatesText(text, cwd, model);
}
/**
* @agent-handoff/readers：八家 agent 会话的只读读取层。
* 移植自 dsh-hippo src/agents/，零三方运行时依赖（zcode / cursor store 用 Node 内建 node:sqlite）。
* cursor / grok 两家为自研实现（格式为公开逆向调研）。
*
* 公共 API：
*   listSessions(agent?) → SessionRef[]   发现 + 按更新时间倒序
*   readSession(agent, ref) → Turn[]      解析一个会话为 Turn 流
*   resolveReference(agent, reference)    引用解析（歧义返回候选列表，不猜）
*/
const AGENTS = [
	claudeAdapter,
	codexAdapter,
	opencodeAdapter,
	zcodeAdapter,
	piAdapter,
	workbuddyAdapter,
	cursorAdapter,
	{
		name: "grok",
		root: ROOT,
		supported: true,
		discover() {
			const out = [];
			let wsDirs = [];
			try {
				wsDirs = readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.isSymbolicLink()).map((d) => join(ROOT, d.name));
			} catch {
				return out;
			}
			for (const ws of wsDirs) {
				let sessionDirs = [];
				try {
					sessionDirs = readdirSync(ws, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.isSymbolicLink()).map((d) => join(ws, d.name));
				} catch {
					continue;
				}
				for (const dir of sessionDirs) {
					let updatesStat;
					try {
						updatesStat = statSync(join(dir, "updates.jsonl"));
						if (!updatesStat.isFile()) continue;
					} catch {
						continue;
					}
					const summary = readSummary(dir);
					if (summary === null) continue;
					const updatedAt = summary.updatedAt || updatesStat.mtimeMs;
					out.push({
						agent: this.name,
						id: dir,
						title: summary.title || summary.sessionId,
						cwd: summary.cwd,
						updatedAt,
						fingerprint: `${Math.round(updatedAt)}:${updatesStat.size}`,
						kind: "file"
					});
				}
			}
			this.note = out.length === 0 ? FAKE_ZERO_NOTE : void 0;
			return out.sort((a, b) => b.updatedAt - a.updatedAt);
		},
		parse(id) {
			try {
				return parseGrokSession(id);
			} catch {
				return [];
			}
		}
	}
];
const byName = new Map(AGENTS.map((a) => [a.name, a]));
/** 取适配器；未知名抛中文错（CLI 层转成用户可读信息）。 */
function adapterFor(agent) {
	const a = byName.get(agent);
	if (a === void 0) throw new Error(`未知 agent：${agent}（支持：${AGENTS.map((x) => x.name).join(" / ")}）`);
	return a;
}
/** 发现会话：给 agent 名只查该家；不给则查全部支持的家，单家失败不拖垮整体。 */
function listSessions(agent) {
	if (agent !== void 0) {
		const a = adapterFor(agent);
		if (!a.supported) return [];
		return a.discover().sort((x, y) => y.updatedAt - x.updatedAt);
	}
	const out = [];
	for (const a of AGENTS) {
		if (!a.supported) continue;
		try {
			out.push(...a.discover());
		} catch {}
	}
	return out.sort((x, y) => y.updatedAt - x.updatedAt);
}
/** 解析一个会话为 Turn 流；ref 可以是 SessionRef 或适配器 id 字符串。
* 同一文件（mtime+size 指纹不变）重复读取命中缓存——list 对 20 个候选逐个
* readSession 数用户轮、show 全量解析后才分页，无缓存时每次调用都重付
* O(总字节) 的同步 readFileSync+JSON.parse（30s 轮询场景成倍放大）。
* 缓存有界：条目上限与累计正文上限双闸，超出按 LRU 淘汰。 */
function readSession(agent, ref) {
	const a = adapterFor(agent);
	if (!a.supported) return [];
	const id = typeof ref === "string" ? ref : ref.id;
	const fingerprint = fileFingerprint(id);
	const cacheKey = `${a.name}\u0000${id}`;
	const hit = fingerprint === "" ? void 0 : sessionCache.get(cacheKey);
	if (hit !== void 0 && hit.fingerprint === fingerprint) {
		hit.used = ++cacheTick;
		return hit.turns;
	}
	let turns;
	try {
		turns = a.parse(id);
	} catch {
		return [];
	}
	if (fingerprint !== "" && turns.length > 0) {
		const chars = turns.reduce((n, t) => n + t.text.length, 0);
		if (chars <= CACHE_MAX_CHARS) {
			sessionCache.set(cacheKey, {
				fingerprint,
				turns,
				chars,
				used: ++cacheTick
			});
			while (sessionCache.size > CACHE_MAX_ENTRIES) evictOldest();
			trimByChars();
		}
	}
	return turns;
}
const sessionCache = /* @__PURE__ */ new Map();
const CACHE_MAX_ENTRIES = 6;
const CACHE_MAX_CHARS = 24e6;
let cacheTick = 0;
function evictOldest() {
	let oldestKey;
	let oldest = Number.POSITIVE_INFINITY;
	for (const [key, entry] of sessionCache) if (entry.used < oldest) {
		oldest = entry.used;
		oldestKey = key;
	}
	if (oldestKey !== void 0) sessionCache.delete(oldestKey);
}
function trimByChars() {
	while (cacheTotalChars() > CACHE_MAX_CHARS && sessionCache.size > 1) evictOldest();
}
function cacheTotalChars() {
	let n = 0;
	for (const entry of sessionCache.values()) n += entry.chars;
	return n;
}
/** 文件指纹（mtime:size）；stat 失败回空串（不可缓存，直接现读） */
function fileFingerprint(id) {
	try {
		const st = statSync(id);
		return st.isFile() ? `${Math.round(st.mtimeMs)}:${st.size}` : "";
	} catch {
		return "";
	}
}
/** 引用解析：先发现该 agent 的会话，再按 id/路径/标题规则匹配。 */
function resolveAgentReference(agent, reference) {
	return resolveReference(reference, listSessions(agent));
}
//#endregion
export { AGENTS, listSessions, readSession, resolveAgentReference };

//# sourceMappingURL=dist-DJ8wNyGr.js.map