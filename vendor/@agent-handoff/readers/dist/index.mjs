import { createRequire } from "node:module";
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
//#region src/resolve.ts
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
//#endregion
//#region src/transcript.ts
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
//#endregion
//#region src/claude.ts
/**
* Claude Code 适配器：~/.claude/projects 下递归的全部 .jsonl（引擎原生格式）。
* 移植自 dsh-hippo src/agents/claude.ts；root 可用 HANDOFF_ROOT_CLAUDE 覆盖（测试用）。
*/
const ROOT$6 = process.env["HANDOFF_ROOT_CLAUDE"] ?? join(homedir(), ".claude", "projects");
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
	root: ROOT$6,
	supported: true,
	discover() {
		const out = [];
		for (const file of walkJsonl$1(ROOT$6)) {
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
//#endregion
//#region src/types.ts
/**
* 假 0 哨兵：存储根目录存在但 discover 为 0——上游可能已迁移存储布局。
* 出处：opencode 1.18 迁 SQLite 后旧读取器本机假报 0（casr #26 同日中招）。
* 适用于文件布局适配器（codex / cursor / grok）与 opencode 的 storage 回退路径；
* 根目录不存在（没装）不触发——那是正常静默。
*/
const FAKE_ZERO_NOTE = "存储目录存在但未发现会话——上游可能已迁移存储布局（参考 opencode 1.18 迁 SQLite）";
//#endregion
//#region src/codex.ts
/**
* Codex 适配器：~/.codex/sessions 下递归的 rollout-*.jsonl。
* session_meta 给 cwd；response_item 是权威消息流（event_msg 为 UI 事件，跳过避免重复）。
* 移植自 dsh-hippo src/agents/codex.ts；root 可用 HANDOFF_ROOT_CODEX 覆盖（测试用）。
*/
const ROOT$5 = process.env["HANDOFF_ROOT_CODEX"] ?? join(homedir(), ".codex", "sessions");
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
	root: ROOT$5,
	supported: true,
	discover() {
		const out = [];
		for (const file of walkJsonl(ROOT$5)) {
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
		this.note = out.length === 0 && existsSync(ROOT$5) ? FAKE_ZERO_NOTE : void 0;
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
//#endregion
//#region src/opencode.ts
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
//#endregion
//#region src/zcode.ts
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
//#endregion
//#region src/pi.ts
/**
* pi 适配器（badlogic/pi-mono）：~/.pi/agent/sessions/<路径转义>/时间戳_uuid.jsonl
* 事件流格式：type=session 给 cwd；type=message 的 message.content[] 是文本块。
* 标题取首条用户消息前 40 字（发现期限量读首 64KB，不整文件解析）。
* 移植自 dsh-hippo src/agents/pi.ts；root 可用 HANDOFF_ROOT_PI 覆盖（测试用）。
*/
const ROOT$4 = process.env["HANDOFF_ROOT_PI"] ?? join(homedir(), ".pi", "agent", "sessions");
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
	root: ROOT$4,
	supported: true,
	discover() {
		const out = [];
		let dirs = [];
		try {
			dirs = readdirSync(ROOT$4, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(ROOT$4, d.name));
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
//#endregion
//#region src/workbuddy.ts
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
* 0.1.3 起记录归一（parseWorkbuddyKernelText）与文件头元数据（workbuddyHeadMeta）
* 提为与 codebuddy 适配器共用的单一实现——两家同内核，行为以本家的实测口径为准。
*/
const ROOT$3 = process.env["HANDOFF_ROOT_WORKBUDDY"] ?? join(homedir(), ".workbuddy", "projects");
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
	root: ROOT$3,
	supported: true,
	discover() {
		const out = [];
		let projectDirs;
		try {
			projectDirs = readdirSync(ROOT$3, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
		} catch {
			return out;
		}
		for (const dir of projectDirs) {
			let files;
			try {
				files = readdirSync(join(ROOT$3, dir)).filter((f) => f.endsWith(".jsonl"));
			} catch {
				continue;
			}
			for (const f of files) {
				const full = join(ROOT$3, dir, f);
				let mtime = 0;
				let size = 0;
				try {
					const st = statSync(full);
					mtime = st.mtimeMs;
					size = st.size;
				} catch {
					continue;
				}
				// 标题 / cwd 与 codebuddy 同源：文件头 64KB 抠 ai-title 与 cwd（共用函数）
				const meta = workbuddyHeadMeta(full);
				out.push({
					agent: this.name,
					id: full,
					title: meta.title !== "" ? meta.title : basename(f, ".jsonl"),
					cwd: meta.cwd,
					updatedAt: mtime,
					fingerprint: `${Math.round(mtime)}:${size}`,
					kind: "file"
				});
			}
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
		// 记录归一与 codebuddy 同内核：parseWorkbuddyKernelText（坏行在内部静默跳过）
		return parseWorkbuddyKernelText(text);
	}
};
//#endregion
//#region src/cursor.ts
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
const ROOT$2 = process.env["HANDOFF_ROOT_CURSOR"] ?? join(homedir(), ".cursor");
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
	root: ROOT$2,
	supported: true,
	note: BASE_NOTE,
	discover() {
		const out = [];
		const seenSessions = /* @__PURE__ */ new Set();
		const projects = join(ROOT$2, "projects");
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
		const chats = join(ROOT$2, "chats");
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
		this.note = out.length === 0 && existsSync(ROOT$2) ? FAKE_ZERO_NOTE : BASE_NOTE;
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
//#endregion
//#region src/grok.ts
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
const ROOT$1 = process.env["HANDOFF_ROOT_GROK"] ?? join(GROK_HOME, "sessions");
/** 时间戳 → ms epoch：数字（秒/毫秒自适应）或 ISO 字符串；不可解析返回 0。 */
function toMillis$1(value) {
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
		updatedAt: toMillis$1(value.last_active_at) || toMillis$1(value.updated_at) || toMillis$1(value.created_at),
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
const grokAdapter = {
	name: "grok",
	root: ROOT$1,
	supported: true,
	discover() {
		const out = [];
		let wsDirs = [];
		try {
			wsDirs = readdirSync(ROOT$1, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.isSymbolicLink()).map((d) => join(ROOT$1, d.name));
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
};
//#endregion
//#region src/gemini.ts
/**
* Gemini CLI 适配器（自研 TS 实现；格式为公开逆向调研，2026-10 核实）。
*
* 存储形态（root 可用 HANDOFF_ROOT_GEMINI 覆盖，测试用；缺省 ~/.gemini/tmp）：
*
*   <root>/<项目标识>/                 项目标识 = slug 或旧版 sha256 哈希（不做格式判断，直接枚举）
*     .project_root                    明文 cwd（读不到留空，调用方有空 cwd 警告兜底）
*     chats/
*       session-<timestamp>-<8位id>.jsonl   新格式（2026-10-01 起）
*       session-<timestamp>-<8位id>.json    旧格式（整块 JSON：metadata+messages 单对象）
*       <parentShortId>/session-*.jsonl     子代理会话再嵌一层（metadata.kind='subagent'）
*
* JSONL 行法：首行 metadata（sessionId/startTime/lastUpdated/summary/directories/kind）
* → 每行一条 MessageRecord → 穿插控制行——已知类型分派、未知行静默跳过：
* - MessageRecord.type: user | gemini | info | error | warning；
* - content 是字符串或 Part 数组（取 text 部分）；info / error / warning 是 CLI UI
*   消息，不计用户轮也不进 Turn；
* - user 文本以 '/' 或 '?' 开头是斜杠命令/快捷键，跳过（首条用户消息口径对齐全包）；
* - gemini 轮带 toolCalls[{name,args,result,status,timestamp}]：每个调用出一个
*   assistant 工具轮（toolName=原生名，text=summarizeToolCall 摘要；write_file /
*   replace / read_file 是文件类、run_shell_command args.command 是命令类——与 grok
*   适配器同口径：原生名直透 toolName，不做改名）；result/status 再出一个 tool 结果
*   轮，status==='error' 记 toolFailed。
* - $patch / $set / $rewindTo 控制行跳过。
*
* 只读不写、不复活 Gemini CLI 进程；坏行/损坏文件静默跳过或返回空流。
*/
const ROOT = process.env["HANDOFF_ROOT_GEMINI"] ?? join(homedir(), ".gemini", "tmp");
/** ISO 时间戳 → ms epoch；不可解析返回 0。 */
function toMillis(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value !== "") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return 0;
}
/** 控制行（$patch / $set / $rewindTo）：顶层带 $ 键，或 type 以 $ 开头。 */
function isControlLine(record) {
	if ("$patch" in record || "$set" in record || "$rewindTo" in record) return true;
	const type = record.type;
	return typeof type === "string" && type.startsWith("$");
}
/** content（字符串或 Part 数组）→ 纯文本：取 text 部分，其余块跳过。 */
function geminiContentText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const block of content) if (block !== null && typeof block === "object" && typeof block.text === "string") parts.push(block.text);
	return parts.join("\n");
}
/** user 文本以 '/' 或 '?' 开头 = 斜杠命令/快捷输入，不是对话内容。 */
function isSlashCommand(text) {
	const t = text.trimStart();
	return t.startsWith("/") || t.startsWith("?");
}
/** toolCall 的 result：字符串直用；对象取 output/text 字符串字段；其余空。 */
function toolResultText(result) {
	if (typeof result === "string") return result;
	if (result !== null && typeof result === "object") {
		const r = result;
		for (const key of ["output", "text"]) if (typeof r[key] === "string") return r[key];
	}
	return "";
}
/** 单条 MessageRecord → Turn 列表。info/error/warning 与斜杠命令不产生 Turn。 */
function recordToTurns(record, cwd) {
	const type = typeof record.type === "string" ? record.type : "";
	const ts = typeof record.timestamp === "string" ? record.timestamp : "";
	const model = typeof record.model === "string" ? record.model : "";
	const turns = [];
	if (type === "user") {
		const text = geminiContentText(record.content).trim();
		if (text !== "" && !isSlashCommand(text)) turns.push(makeTurn({
			role: "user",
			text,
			cwd,
			ts
		}));
		return turns;
	}
	if (type === "gemini") {
		const text = geminiContentText(record.content).trim();
		if (text !== "") turns.push(makeTurn({
			role: "assistant",
			text,
			cwd,
			ts,
			model
		}));
		const toolCalls = Array.isArray(record.toolCalls) ? record.toolCalls : [];
		for (const call of toolCalls) {
			if (call === null || typeof call !== "object") continue;
			const c = call;
			const name = typeof c.name === "string" && c.name !== "" ? c.name : "gemini_tool";
			const args = c.args;
			const status = typeof c.status === "string" ? c.status : "";
			turns.push(makeTurn({
				role: "assistant",
				text: summarizeToolCall(name, args),
				cwd,
				ts,
				model,
				toolName: name
			}));
			const result = toolResultText(c.result);
			if (result !== "" || status === "error") turns.push(makeTurn({
				role: "tool",
				text: result.slice(0, 2e3),
				cwd,
				ts: typeof c.timestamp === "string" ? c.timestamp : ts,
				toolName: name,
				toolFailed: status === "error"
			}));
		}
	}
	return turns;
}
/** JSONL 文本 → Turn 流：已知类型分派，控制行与未知行静默跳过。 */
function parseGeminiText(text, cwd = "") {
	const turns = [];
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line === "") continue;
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		if (record === null || typeof record !== "object" || Array.isArray(record)) continue;
		if (isControlLine(record)) continue;
		if (typeof record.type !== "string") continue;
		turns.push(...recordToTurns(record, cwd));
	}
	return turns;
}
/** 旧 .json（metadata+messages 单对象）→ Turn 流。 */
function parseGeminiJson(text, cwd = "") {
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		return [];
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
	const messages = value.messages;
	if (!Array.isArray(messages)) return [];
	const turns = [];
	for (const message of messages) {
		if (message === null || typeof message !== "object" || Array.isArray(message)) continue;
		if (isControlLine(message)) continue;
		turns.push(...recordToTurns(message, cwd));
	}
	return turns;
}
/**
* cwd 反查：会话文件所在目录到 <root>/<项目标识> 沿途找 .project_root 明文文件
* （主会话在项目目录、子代理在 chats/<parent>/ 下——子到父逐层找，都不越过项目目录）。
* 读不到留空（调用方有空 cwd 警告兜底）。
*/
function projectCwd(file) {
	let dir = dirname(file);
	for (let depth = 0; depth < 6; depth += 1) {
		let raw = "";
		try {
			raw = readFileSync(join(dir, ".project_root"), "utf8");
		} catch {
			raw = "";
		}
		const cwd = raw.trim();
		if (cwd !== "") return cwd;
		const parent = dirname(dir);
		if (parent === dir || basename(parent) === "tmp" || depth + 1 >= 6) return "";
		dir = parent;
	}
	return "";
}
/** 会话文件路径（.jsonl 新格式 / .json 旧格式）→ Turn 流。文件缺失/损坏返回 []。 */
function parseGeminiSession(id) {
	let text;
	try {
		text = readFileSync(id, "utf8");
	} catch {
		return [];
	}
	const cwd = projectCwd(id);
	return id.toLowerCase().endsWith(".json") ? parseGeminiJson(text, cwd) : parseGeminiText(text, cwd);
}
/** 会话文件是否为 gemini 会话命名：session-*.jsonl / session-*.json。 */
function isSessionFile(name) {
	return name.startsWith("session-") && (name.endsWith(".jsonl") || name.endsWith(".json"));
}
/** 头部 64KB 抠 metadata：summary（标题）/ lastUpdated（更新时间）——别全读大文件。 */
function readHeadMeta(file, isJson) {
	let head = "";
	try {
		const buf = readFileSync(file);
		head = buf.subarray(0, Math.min(buf.length, 65536)).toString("utf8");
	} catch {
		return {
			summary: "",
			lastUpdated: 0
		};
	}
	let summary = "";
	let lastUpdated = 0;
	if (isJson) try {
		const meta = JSON.parse(head);
		if (typeof meta.summary === "string") summary = meta.summary;
		lastUpdated = toMillis(meta.lastUpdated);
	} catch {}
	if (summary === "") {
		const m = head.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/);
		if (m) try {
			summary = JSON.parse(`"${m[1]}"`);
		} catch {
			summary = m[1];
		}
	}
	if (lastUpdated === 0) {
		const m = head.match(/"lastUpdated"\s*:\s*"([^"]*)"/);
		if (m) lastUpdated = toMillis(m[1]);
	}
	return {
		summary,
		lastUpdated
	};
}
function refFromFile(file) {
	let mtime = 0;
	let size = 0;
	try {
		const st = statSync(file);
		if (!st.isFile()) return null;
		mtime = st.mtimeMs;
		size = st.size;
	} catch {
		return null;
	}
	const meta = readHeadMeta(file, file.toLowerCase().endsWith(".json"));
	return {
		agent: "gemini",
		id: file,
		title: meta.summary !== "" ? meta.summary : basename(file),
		cwd: projectCwd(file),
		updatedAt: meta.lastUpdated || mtime,
		fingerprint: `${Math.round(mtime)}:${size}`,
		kind: "file"
	};
}
//#endregion
//#region src/kimi.ts
/**
* Kimi Code（月之暗面 MoonshotAI/kimi-code）适配器（自研 TS 实现；格式为公开逆向调研，
* 2026-11 经多解析器交叉核实：claude-replay / uniflo / ai-toolbox 三方一致）。
*
* 存储形态（root 可用 HANDOFF_ROOT_KIMI 覆盖，测试用；缺省 ~/.kimi-code/sessions）：
*
*   <root>/wd_<工作目录名>_<hash>/<会话目录>/
*     agents/main/wire.jsonl     主代理 wire 事件流（本适配器唯一解析的正文）
*     state.json                 伴生元数据：title / workDir / createdAt（尽力读取）
*   <root>/session_index.jsonl   全局索引行 {sessionId, workDir, ...}（也可能在其上级 ~/.kimi-code）
*
* wire.jsonl 行法（已知类型分派、未知行静默跳过）：
* - turn.prompt：input[] 取 type=text 块 → 用户轮（time 为 epoch，秒/毫秒自适应）；
* - context.append_loop_event：event 分派——
*   - content.part：part.type=text → 助手文本轮；think → [thinking] 标记保留
*     （交接模板按标记段不蒸馏，与 claude / zcode 同口径）；
*   - tool.call → 助手工具轮（toolName=原生名，text=summarizeToolCall 摘要，永不回放）；
*   - tool.result → 工具结果轮（result.isError → toolFailed）；
*   - step.begin / step.end → 步骤边界控制行，跳过。
*
* 只读不写、不复活 Kimi CLI 进程；坏行/损坏文件静默跳过或返回空流。
*/
const ROOT$7 = process.env["HANDOFF_ROOT_KIMI"] ?? join(homedir(), ".kimi-code", "sessions");
/** 会话目录元数据：state.json（title/workDir）优先，session_index.jsonl 按 sessionId 兜底
* （索引行一行一会话，体量天然小，整读包在 try 里；两处可能位置都试）。 */
function kimiMeta(sessionDir) {
	let title = "";
	let cwd = "";
	try {
		const st = JSON.parse(readFileSync(join(sessionDir, "state.json"), "utf8"));
		if (st !== null && typeof st === "object") {
			if (typeof st.title === "string" && st.title !== "") title = st.title;
			if (typeof st.workDir === "string") cwd = st.workDir;
		}
	} catch {}
	if (cwd === "" && title === "") for (const idx of [join(ROOT$7, "session_index.jsonl"), join(dirname(ROOT$7), "session_index.jsonl")]) {
		let indexText;
		try {
			indexText = readFileSync(idx, "utf8");
		} catch {
			continue;
		}
		for (const entry of parseJsonl(indexText)) {
			if (entry === null || typeof entry !== "object") continue;
			if (entry.sessionId === basename(sessionDir)) {
				if (typeof entry.workDir === "string") cwd = entry.workDir;
				if (typeof entry.title === "string" && entry.title !== "") title = entry.title;
				break;
			}
		}
		if (cwd !== "" || title !== "") break;
	}
	return {
		title,
		cwd
	};
}
/** wire.jsonl 会话文件路径 → 所属会话目录（<会话目录>/agents/main/wire.jsonl 上溯三层）。 */
function kimiSessionDir(file) {
	return dirname(dirname(dirname(file)));
}
/** 单行 wire 记录 → Turn 列表（未知类型行静默跳过）。 */
function kimiRecordToTurns(record, cwd) {
	const turns = [];
	const rtype = typeof record.type === "string" ? record.type : "";
	const ts = toMillis$1(record.time) !== 0 ? new Date(toMillis$1(record.time)).toISOString() : "";
	if (rtype === "turn.prompt") {
		const text = (Array.isArray(record.input) ? record.input : []).filter((b) => b !== null && typeof b === "object" && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n").trim();
		if (text !== "") turns.push(makeTurn({
			role: "user",
			text,
			cwd,
			ts
		}));
		return turns;
	}
	if (rtype !== "context.append_loop_event") return turns;
	const ev = record.event !== null && typeof record.event === "object" ? record.event : null;
	if (ev === null) return turns;
	const evType = typeof ev.type === "string" ? ev.type : "";
	const ets = toMillis$1(record.time) !== 0 ? new Date(toMillis$1(record.time)).toISOString() : "";
	if (evType === "content.part") {
		const part = ev.part !== null && typeof ev.part === "object" ? ev.part : null;
		if (part === null) return turns;
		if (part.type === "text" && typeof part.text === "string" && part.text.trim() !== "") turns.push(makeTurn({
			role: "assistant",
			text: part.text,
			cwd,
			ts: ets
		}));
		else if (part.type === "think" && typeof part.think === "string" && part.think.trim() !== "") turns.push(makeTurn({
			role: "assistant",
			text: "[thinking] " + part.think,
			cwd,
			ts: ets
		}));
	} else if (evType === "tool.call") {
		const name = typeof ev.name === "string" && ev.name !== "" ? ev.name : "kimi_tool";
		turns.push(makeTurn({
			role: "assistant",
			text: summarizeToolCall(name, ev.args),
			cwd,
			ts: ets,
			toolName: name
		}));
	} else if (evType === "tool.result") {
		const result = ev.result !== null && typeof ev.result === "object" ? ev.result : {};
		const output = typeof result.output === "string" ? result.output : JSON.stringify(result.output ?? "");
		turns.push(makeTurn({
			role: "tool",
			text: output.slice(0, 2e3),
			cwd,
			ts: ets,
			toolFailed: Boolean(result.isError)
		}));
	}
	return turns;
}
/** wire.jsonl 文本 → Turn 流：已知事件分派，metadata / step 边界与未知行静默跳过。 */
function parseKimiWireText(text, cwd = "") {
	const turns = [];
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line === "") continue;
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		if (record === null || typeof record !== "object" || Array.isArray(record)) continue;
		turns.push(...kimiRecordToTurns(record, cwd));
	}
	return turns;
}
/** 头部窗口里首条用户输入前 40 字作标题（discover 期限量读，别整读大会话）。 */
function kimiHeadTitle(head) {
	for (const turn of parseKimiWireText(head)) if (turn.role === "user" && turn.text.trim() !== "") return turn.text.trim().slice(0, 40);
	return "";
}
const kimiAdapter = {
	name: "kimi",
	root: ROOT$7,
	supported: true,
	discover() {
		const out = [];
		let wdDirs = [];
		try {
			wdDirs = readdirSync(ROOT$7, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.isSymbolicLink()).map((d) => join(ROOT$7, d.name));
		} catch {
			return out;
		}
		for (const wdDir of wdDirs) {
			let sessDirs = [];
			try {
				sessDirs = readdirSync(wdDir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.isSymbolicLink()).map((d) => join(wdDir, d.name));
			} catch {
				continue;
			}
			for (const sessDir of sessDirs) {
				const file = join(sessDir, "agents", "main", "wire.jsonl");
				let mtime = 0, size = 0;
				try {
					const st = statSync(file);
					if (!st.isFile()) continue;
					mtime = st.mtimeMs;
					size = st.size;
				} catch {
					continue;
				}
				const meta = kimiMeta(sessDir);
				out.push({
					agent: this.name,
					id: file,
					title: meta.title !== "" ? meta.title : kimiHeadTitle(readHead$1(file)) || basename(sessDir),
					cwd: meta.cwd,
					updatedAt: mtime,
					fingerprint: `${Math.round(mtime)}:${size}`,
					kind: "file"
				});
			}
		}
		this.note = out.length === 0 && existsSync(ROOT$7) ? FAKE_ZERO_NOTE : void 0;
		return out.sort((a, b) => b.updatedAt - a.updatedAt);
	},
	parse(id) {
		try {
			return parseKimiWireText(readFileSync(id, "utf8"), kimiMeta(kimiSessionDir(id)).cwd);
		} catch {
			return [];
		}
	}
};
//#endregion
//#region src/codebuddy.ts
/**
* CodeBuddy（腾讯）适配器：WorkBuddy 内核的 jsonl 族（自研 TS 实现；格式为公开逆向调研，
* 2026-11 经 uniflo 等多解析器交叉核实）。
*
* 存储形态（root 可用 HANDOFF_ROOT_CODEBUDDY 覆盖，测试用；缺省 ~/.codebuddy/projects）：
*
*   <root>/<cwd 转义目录>/<sessionId>.jsonl   一文件 = 一主会话（布局与 Claude Code 同形）
*   <root>/<cwd 转义目录>/<sessionId>/subagents/agent-*.jsonl   子代理 transcript——本期不做：
*     discover 只扫 cwd 转义目录一层，子目录不进候选（主会话优先）
*
* 记录族与 WorkBuddy 同内核（message 的 input_text / output_text 块、function_call /
* function_call_result、ai-title），归一与 WorkBuddy 适配器共用同一套函数。
* 只读不写、不复活 CodeBuddy 进程；坏行/损坏文件静默跳过或返回空流。
*/
const ROOT$8 = process.env["HANDOFF_ROOT_CODEBUDDY"] ?? join(homedir(), ".codebuddy", "projects");
/** WorkBuddy 内核记录 JSONL 文本 → Turn 流（workbuddy / codebuddy 两家共用归一）。 */
function parseWorkbuddyKernelText(text) {
	const turns = [];
	for (const e of parseJsonl(text)) {
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
/** 文件头 64KB 抠 ai-title 与 cwd（workbuddy / codebuddy 两家 discover 共用）。 */
function workbuddyHeadMeta(file) {
	let title = "";
	let cwd = "";
	try {
		const fd = openSync(file, "r");
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
	return {
		title,
		cwd
	};
}
const codebuddyAdapter = {
	name: "codebuddy",
	root: ROOT$8,
	supported: true,
	discover() {
		const out = [];
		let projectDirs;
		try {
			projectDirs = readdirSync(ROOT$8, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
		} catch {
			return out;
		}
		for (const dir of projectDirs) {
			let files;
			try {
				files = readdirSync(join(ROOT$8, dir)).filter((f) => f.endsWith(".jsonl"));
			} catch {
				continue;
			}
			for (const f of files) {
				const full = join(ROOT$8, dir, f);
				let mtime = 0;
				let size = 0;
				try {
					const st = statSync(full);
					mtime = st.mtimeMs;
					size = st.size;
				} catch {
					continue;
				}
				const meta = workbuddyHeadMeta(full);
				out.push({
					agent: this.name,
					id: full,
					title: meta.title !== "" ? meta.title : basename(f, ".jsonl"),
					cwd: meta.cwd,
					updatedAt: mtime,
					fingerprint: `${Math.round(mtime)}:${size}`,
					kind: "file"
				});
			}
		}
		this.note = out.length === 0 && existsSync(ROOT$8) ? FAKE_ZERO_NOTE : void 0;
		return out.sort((a, b) => b.updatedAt - a.updatedAt);
	},
	parse(id) {
		try {
			return parseWorkbuddyKernelText(readFileSync(id, "utf8"));
		} catch {
			return [];
		}
	}
};
//#endregion
//#region src/qoder.ts
/**
* Qoder（阿里）适配器（自研 TS 实现；格式为公开逆向调研，2026-11 经 ChatCrystal /
* uniflo / dsh-config-manager 三方交叉核实）。
*
* 存储形态（root 可用 HANDOFF_ROOT_QODER 覆盖，测试用；缺省 ~/.qoder/projects）：
*
*   <root>/<项目目录（cwd 转义）>/<sessionId>.jsonl   主会话，记录与 Claude Code 同族
*     （type user / assistant + message.content + cwd + timestamp，另有 ai-title /
*     custom-title 标题行）——归一直接复用 claude 适配器的 entryToTurns。
*   <root>/<项目目录>/<sessionId>/subagents/*.jsonl   子代理 transcript——非主会话，不读。
*
* discover 只扫项目目录一层的主会话文件（子目录不进候选）。cwd 取自记录本身的
* realCwd 头部窗口（读不到留空，调用方有空 cwd 警告兜底——目录名反解有歧义，不猜）。
* 只读不写、不复活 Qoder；坏行/损坏文件静默跳过或返回空流。
*/
const ROOT$9 = process.env["HANDOFF_ROOT_QODER"] ?? join(homedir(), ".qoder", "projects");
/** 头部文本里的标题：custom-title 优先于 ai-title（用户改过的名字说了算），都缺回空串。 */
function qoderHeadTitle(head) {
	let ai = "";
	const custom = head.match(/"customTitle"\s*:\s*"((?:[^"\\]|\\.)*)"/);
	if (custom) try {
		return JSON.parse(`"${custom[1]}"`).trim();
	} catch {
		return custom[1].trim();
	}
	const m = head.match(/"aiTitle"\s*:\s*"((?:[^"\\]|\\.)*)"/);
	if (m) try {
		ai = JSON.parse(`"${m[1]}"`);
	} catch {
		ai = m[1];
	}
	return ai.trim();
}
const qoderAdapter = {
	name: "qoder",
	root: ROOT$9,
	supported: true,
	discover() {
		const out = [];
		let projectDirs = [];
		try {
			projectDirs = readdirSync(ROOT$9, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.isSymbolicLink()).map((d) => join(ROOT$9, d.name));
		} catch {
			return out;
		}
		for (const dir of projectDirs) {
			let names = [];
			try {
				names = readdirSync(dir);
			} catch {
				continue;
			}
			for (const f of names) {
				if (!f.endsWith(".jsonl")) continue;
				const file = join(dir, f);
				let mtime = 0, size = 0;
				try {
					const st = statSync(file);
					if (!st.isFile()) continue;
					mtime = st.mtimeMs;
					size = st.size;
				} catch {
					continue;
				}
				const head = readHead$1(file);
				out.push({
					agent: this.name,
					id: file,
					title: qoderHeadTitle(head) || basename(f, ".jsonl"),
					cwd: realCwd(file),
					updatedAt: mtime,
					fingerprint: `${Math.round(mtime)}:${size}`,
					kind: "file"
				});
			}
		}
		this.note = out.length === 0 && existsSync(ROOT$9) ? FAKE_ZERO_NOTE : void 0;
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
//#endregion
//#region src/kiro.ts
/**
* Kiro（AWS）适配器（自研 TS 实现；格式为公开逆向调研，2026-11 经 hstry（对 kiro-cli
* 2.22.0 实录核对）/ codeburn / uniflo 三方交叉核实）。
*
* 存储形态（root 可用 HANDOFF_ROOT_KIRO 覆盖，测试用；缺省 ~/.kiro/sessions/cli）：
*
*   <root>/<uuid>.jsonl     CLI 会话事件流（本适配器唯一读取的正文）
*   <root>/<uuid>.json      伴生 header（session_state 计量）——不读
*   <root>/<uuid>.history   伴生历史——不读
*
* jsonl 行法：一行一 {version, kind, data} 事件，已知 kind 分派、未知行静默跳过：
* - Prompt → 用户轮（content[] 取 kind=text 块的 data）；
* - AssistantMessage → 助手轮：text 块为正文，toolUse 块 {toolUseId, name, input} 成
*   助手工具轮（toolName=原生名，text=摘要，永不回放）；
* - ToolResults → 工具结果轮：toolResult 块 {content[], status}，status==='error'
*   记 toolFailed；content 的 text / json 块拼正文。
* meta.timestamp 为 epoch 秒（毫秒自适应）。事件流里没有 cwd 字段——如实留空
* （上层有空 cwd 警告兜底）；标题取首条用户输入前 40 字。
* 只读不写、不复活 Kiro；坏行/损坏文件静默跳过或返回空流。
*/
const ROOT$10 = process.env["HANDOFF_ROOT_KIRO"] ?? join(homedir(), ".kiro", "sessions", "cli");
/** toolResult 的 content 块 → 纯文本：text 取 data；json 序列化 data；其余块跳过。 */
function kiroContentText(blocks) {
	const parts = [];
	for (const block of blocks) {
		if (block === null || typeof block !== "object") continue;
		if (block.kind === "text" && typeof block.data === "string") parts.push(block.data);
		else if (block.kind === "json") parts.push(JSON.stringify(block.data ?? ""));
	}
	return parts.join("\n");
}
/** cli/<uuid>.jsonl 文本 → Turn 流：已知 kind 分派，未知行静默跳过。 */
function parseKiroSessionText(text) {
	const turns = [];
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line === "") continue;
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		if (record === null || typeof record !== "object") continue;
		const data = record.data !== null && typeof record.data === "object" && !Array.isArray(record.data) ? record.data : null;
		if (data === null) continue;
		const blocks = Array.isArray(data.content) ? data.content : [];
		const stamp = data.meta !== null && typeof data.meta === "object" ? toMillis$1(data.meta.timestamp) : 0;
		const ts = stamp !== 0 ? new Date(stamp).toISOString() : "";
		if (record.kind === "Prompt") {
			const text = blocks.filter((b) => b !== null && typeof b === "object" && b.kind === "text" && typeof b.data === "string").map((b) => b.data).join("\n").trim();
			if (text !== "") turns.push(makeTurn({
				role: "user",
				text,
				cwd: "",
				ts
			}));
		} else if (record.kind === "AssistantMessage") {
			for (const block of blocks) {
				if (block === null || typeof block !== "object") continue;
				if (block.kind === "text" && typeof block.data === "string" && block.data.trim() !== "") turns.push(makeTurn({
					role: "assistant",
					text: block.data,
					cwd: "",
					ts
				}));
				else if (block.kind === "toolUse" && block.data !== null && typeof block.data === "object") {
					const name = typeof block.data.name === "string" && block.data.name !== "" ? block.data.name : "kiro_tool";
					turns.push(makeTurn({
						role: "assistant",
						text: summarizeToolCall(name, block.data.input),
						cwd: "",
						ts,
						toolName: name
					}));
				}
			}
		} else if (record.kind === "ToolResults") {
			for (const block of blocks) {
				if (block === null || typeof block !== "object" || block.kind !== "toolResult") continue;
				const d = block.data !== null && typeof block.data === "object" ? block.data : {};
				turns.push(makeTurn({
					role: "tool",
					text: kiroContentText(Array.isArray(d.content) ? d.content : []).slice(0, 2e3),
					cwd: "",
					ts,
					toolFailed: d.status === "error"
				}));
			}
		}
	}
	return turns;
}
/** 头部窗口里首条用户输入前 40 字作标题（伴生 .json 的 title 不读，标题出自正文）。 */
function kiroHeadTitle(head) {
	for (const turn of parseKiroSessionText(head)) if (turn.role === "user" && turn.text.trim() !== "") return turn.text.trim().slice(0, 40);
	return "";
}
const kiroAdapter = {
	name: "kiro",
	root: ROOT$10,
	supported: true,
	discover() {
		const out = [];
		let names = [];
		try {
			names = readdirSync(ROOT$10);
		} catch {
			return out;
		}
		for (const f of names) {
			if (!f.endsWith(".jsonl")) continue;
			const file = join(ROOT$10, f);
			let mtime = 0, size = 0;
			try {
				const st = statSync(file);
				if (!st.isFile()) continue;
				mtime = st.mtimeMs;
				size = st.size;
			} catch {
				continue;
			}
			out.push({
				agent: this.name,
				id: file,
				title: kiroHeadTitle(readHead$1(file)) || basename(f, ".jsonl"),
				cwd: "",
				updatedAt: mtime,
				fingerprint: `${Math.round(mtime)}:${size}`,
				kind: "file"
			});
		}
		this.note = out.length === 0 && existsSync(ROOT$10) ? FAKE_ZERO_NOTE : void 0;
		return out.sort((a, b) => b.updatedAt - a.updatedAt);
	},
	parse(id) {
		try {
			return parseKiroSessionText(readFileSync(id, "utf8"));
		} catch {
			return [];
		}
	}
};
//#endregion
//#region src/sqlite-common.ts
/**
 * sqlite 族公共件（copilot / devin / mimo 三家共用，2026-11）：
 * 列名不做硬编码假设——PRAGMA table_info 探测常见命名，探测不中即降级并诚实浮出；
 * 时间单元格 epoch 秒 / 毫秒 / ISO 字符串自适应。活库一律 readonly 随开随关（zcode 先例）。
 */
/** node:sqlite 可用性：createRequire 同步加载内建模块，失败即不支持（不拖垮其他适配器）。 */
function loadSqliteFamily() {
	try {
		return createRequire(import.meta.url)("node:sqlite").DatabaseSync;
	} catch {
		return null;
	}
}
const DatabaseSync$3 = loadSqliteFamily();
/** 随开随关 readonly 打开：sqlite 缺席 / 文件不存在 / 打开失败一律 null。 */
function openFamilyDb(dbPath) {
	if (DatabaseSync$3 === null || !existsSync(dbPath)) return null;
	try {
		return new DatabaseSync$3(dbPath, { readOnly: true });
	} catch {
		return null;
	}
}
/** 表列名集合（PRAGMA table_info）；表不存在 / 查询失败返回空集。 */
function tableColumns(db, table) {
	try {
		return new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name));
	} catch {
		return new Set();
	}
}
/** 列名集合里按候选序取第一个存在的列名。 */
function firstCol(cols, names) {
	for (const n of names) if (cols.has(n)) return n;
	return void 0;
}
/** 单元格 → ms epoch：数字秒（<1e12）/毫秒自适应、字符串数字同走、ISO 串 Date.parse；不可解析回 0。 */
function cellToMs(v) {
	if (typeof v === "number" && Number.isFinite(v) && v > 0) return v < 1e12 ? v * 1e3 : v;
	if (typeof v === "string" && v !== "") {
		const n = Number(v);
		if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1e3 : n;
		const parsed = Date.parse(v);
		if (Number.isFinite(parsed)) return parsed;
	}
	return 0;
}
/** 单元格 → Turn 角色：user/human → user；assistant/model/ai/copilot → assistant；
 * tool/tool_result/function → tool；其余回 null（未知角色整行跳过）。 */
function turnRole(v) {
	if (typeof v !== "string") return null;
	const r = v.trim().toLowerCase();
	if (r === "user" || r === "human") return "user";
	if (r === "assistant" || r === "model" || r === "ai" || r === "copilot") return "assistant";
	if (r === "tool" || r === "tool_result" || r === "function") return "tool";
	return null;
}
/** 会话元数据表探测：sessions / session 等常见表名，需有 id 类列；探测不中回 null。 */
function sqliteSessionsTable(db) {
	for (const table of ["sessions", "session"]) {
		const cols = tableColumns(db, table);
		if (cols.size === 0) continue;
		const idCol = firstCol(cols, ["id", "session_id", "sessionId"]);
		if (idCol === void 0) continue;
		return {
			table,
			idCol,
			titleCol: firstCol(cols, ["title", "name", "summary"]),
			cwdCol: firstCol(cols, ["cwd", "path", "working_directory", "working_dir", "directory", "workspace"]),
			updatedCol: firstCol(cols, ["updated_at", "updatedAt", "last_updated", "updated", "last_active"]),
			createdCol: firstCol(cols, ["created_at", "createdAt", "created", "started_at"])
		};
	}
	return null;
}
/** 逐轮记录表探测：turns / messages / events 等常见表名，需同时有会话引用列与正文列；探测不中回 null。 */
function sqliteTurnTable(db) {
	for (const table of ["turns", "messages", "events", "session_turns", "session_messages"]) {
		const cols = tableColumns(db, table);
		if (cols.size === 0) continue;
		const sessionCol = firstCol(cols, ["session_id", "sessionId", "session"]);
		const textCol = firstCol(cols, ["content", "text", "message", "body", "output"]);
		if (sessionCol === void 0 || textCol === void 0) continue;
		return {
			table,
			sessionCol,
			textCol,
			roleCol: firstCol(cols, ["role", "sender", "type"]),
			tsCol: firstCol(cols, ["created_at", "createdAt", "timestamp", "ts", "time"]),
			seqCol: firstCol(cols, ["sequence", "seq", "idx", "turn_index", "position"]),
			idCol: firstCol(cols, ["id"])
		};
	}
	return null;
}
/** sessions 表全行 → SessionRef 列表（id/title/cwd/时间列名自适应；时间列缺失退 0）。 */
function sqliteDiscoverRefs(agent, db, st) {
	const orderCol = st.updatedCol ?? st.createdCol ?? st.idCol;
	let rows = [];
	try {
		rows = db.prepare(`SELECT * FROM "${st.table}" ORDER BY "${orderCol}" DESC`).all();
	} catch {
		return [];
	}
	const out = [];
	for (const row of rows) {
		const idCell = row[st.idCol];
		const id = typeof idCell === "string" || typeof idCell === "number" ? String(idCell) : "";
		if (id === "") continue;
		const updated = st.updatedCol !== void 0 ? cellToMs(row[st.updatedCol]) : st.createdCol !== void 0 ? cellToMs(row[st.createdCol]) : 0;
		const titleCell = st.titleCol !== void 0 ? row[st.titleCol] : void 0;
		const cwdCell = st.cwdCol !== void 0 ? row[st.cwdCol] : void 0;
		out.push({
			agent,
			id,
			title: typeof titleCell === "string" && titleCell.trim() !== "" ? titleCell : id.slice(0, 18),
			cwd: typeof cwdCell === "string" ? cwdCell : "",
			updatedAt: updated,
			fingerprint: String(st.updatedCol !== void 0 ? row[st.updatedCol] ?? "" : updated),
			kind: "sqlite"
		});
	}
	return out.sort((a, b) => b.updatedAt - a.updatedAt);
}
/** 一个会话的逐轮记录 → Turn 流（按序号列/行号列稳定排序；空正文与坏行静默跳过）。 */
function sqliteSessionTurns(db, sessionId, tt) {
	const order = tt.seqCol !== void 0 ? `"${tt.seqCol}"` : tt.idCol !== void 0 ? `"${tt.idCol}"` : "rowid";
	let rows = [];
	try {
		rows = db.prepare(`SELECT * FROM "${tt.table}" WHERE "${tt.sessionCol}" = ? ORDER BY ${order}`).all(sessionId);
	} catch {
		return [];
	}
	const turns = [];
	for (const row of rows) {
		const role = tt.roleCol !== void 0 ? turnRole(row[tt.roleCol]) : "assistant";
		if (role === null) continue;
		const body = typeof row[tt.textCol] === "string" ? row[tt.textCol].trim() : "";
		if (body === "") continue;
		const tsMs = tt.tsCol !== void 0 ? cellToMs(row[tt.tsCol]) : 0;
		turns.push(makeTurn({
			role,
			text: body,
			ts: tsMs > 0 ? new Date(tsMs).toISOString() : ""
		}));
	}
	return turns;
}
//#endregion
//#region src/copilot.ts
/**
 * GitHub Copilot CLI 适配器（自研 TS 实现；存储规格为调研口径，2026-11）。
 *
 * 存储形态（db 路径可用 HANDOFF_ROOT_COPILOT 覆盖，测试用；缺省 ~/.copilot/session-store.db）：
 *   明文 SQLite：sessions 表（会话元数据）+ turns 表（逐轮记录）。
 * 列名探测自适应（sqlite-common）；库缺表 / 列探测不中时 parse 恒空，note 诚实浮出
 * （不粉饰成「没有会话」）。活库随开随关一律 readonly（zcode 先例）；
 * node:sqlite 缺席 → supported=false 优雅降级，不引入任何原生模块。
 * 只读不写、不复活 Copilot CLI。
 */
const COPILOT_DB = process.env["HANDOFF_ROOT_COPILOT"] ?? join(homedir(), ".copilot", "session-store.db");
/** dbPath 可注入（单测用临时库），缺省真实 ~/.copilot/session-store.db。 */
function parseCopilotSession(sessionId, dbPath = COPILOT_DB) {
	const db = openFamilyDb(dbPath);
	if (db === null) return [];
	try {
		const tt = sqliteTurnTable(db);
		if (tt === null) return [];
		return sqliteSessionTurns(db, sessionId, tt);
	} finally {
		db.close();
	}
}
const copilotAdapter = {
	name: "copilot",
	root: COPILOT_DB,
	supported: DatabaseSync$3 !== null,
	note: DatabaseSync$3 === null ? "需要 Node ≥22（node:sqlite 内建模块）" : void 0,
	discover() {
		const db = openFamilyDb(COPILOT_DB);
		if (db === null) return [];
		try {
			const st = sqliteSessionsTable(db);
			if (st === null) {
				this.note = "库文件在册但未识别会话元数据表（列名探测不中）——上游可能已迁移存储布局";
				return [];
			}
			const out = sqliteDiscoverRefs(this.name, db, st);
			this.note = sqliteTurnTable(db) === null ? "已识别会话表但未识别逐轮记录表——正文解析为空（列名探测不中，格式未完全核实）" : void 0;
			return out;
		} finally {
			db.close();
		}
	},
	parse(id) {
		return parseCopilotSession(id);
	}
};
//#endregion
//#region src/devin.ts
/**
 * Devin CLI（Cognition）适配器（自研 TS 实现；存储规格为调研口径，2026-11）。
 *
 * 存储形态（db 路径可用 HANDOFF_ROOT_DEVIN 覆盖，测试用；缺省 XDG 数据根探测）：
 *   <XDG_DATA_HOME>/devin/cli/sessions.db   sessions 表（main_chain_id 血缘字段）
 * XDG 数据根 = XDG_DATA_HOME ?? ~/.local/share；app 目录层同时探测 devin/cli 与
 * cli 两形态（公开资料未完全钉死，候选按序取第一个在册的）。
 * main_chain_id 是链式会话的血缘字段：本读取器只读 sessions 表自身元数据与逐轮
 * 记录表（探测不中则 parse 恒空并诚实浮出 note），链首尾合并不在本期范围。
 * 只读不写、不复活 Devin。
 */
const XDG_DATA$1 = process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share");
const DEVIN_DB_CANDIDATES = [join(XDG_DATA$1, "devin", "cli", "sessions.db"), join(XDG_DATA$1, "cli", "sessions.db")];
const DEVIN_DB = process.env["HANDOFF_ROOT_DEVIN"] ?? (DEVIN_DB_CANDIDATES.find((p) => existsSync(p)) ?? DEVIN_DB_CANDIDATES[0]);
/** sessionId + dbPath 可注入（单测用临时库），缺省 XDG 数据根探测结果。 */
function parseDevinSession(sessionId, dbPath = DEVIN_DB) {
	const db = openFamilyDb(dbPath);
	if (db === null) return [];
	try {
		const tt = sqliteTurnTable(db);
		if (tt === null) return [];
		return sqliteSessionTurns(db, sessionId, tt);
	} finally {
		db.close();
	}
}
const devinAdapter = {
	name: "devin",
	root: DEVIN_DB,
	supported: DatabaseSync$3 !== null,
	note: DatabaseSync$3 === null ? "需要 Node ≥22（node:sqlite 内建模块）" : void 0,
	discover() {
		const db = openFamilyDb(DEVIN_DB);
		if (db === null) return [];
		try {
			const st = sqliteSessionsTable(db);
			if (st === null) {
				this.note = "库文件在册但未识别 sessions 表（列名探测不中）——上游可能已迁移存储布局";
				return [];
			}
			const out = sqliteDiscoverRefs(this.name, db, st);
			this.note = sqliteTurnTable(db) === null ? "已识别 sessions 表（main_chain_id 血缘）但未识别逐轮记录表——正文解析为空（格式未完全核实）" : void 0;
			return out;
		} finally {
			db.close();
		}
	},
	parse(id) {
		return parseDevinSession(id);
	}
};
//#endregion
//#region src/mimo.ts
/**
 * 小米 MiMo Code 适配器（自研 TS 实现；目录名未完全核实——2026-11 候选扫描口径）。
 *
 * 存储形态：~/.local/share 下应用数据目录中的明文 SQLite（session 表）。
 * 候选目录逐个探测（mimo-code / MiMoCode / mimo / xiaomi-mimo / mimo_code /
 * xiaomi/mimo），命中含会话表的库即取用；全不命中 → supported=false + note
 * 诚实标注——目录名未核实 ≠ 布局可信，盲猜固定路径只会造出假 0。
 * HANDOFF_ROOT_MIMO 直接指定 db 文件（测试用；布局核实后可固化缺省）。
 * 只读不写、不复活 MiMo Code。
 */
const MIMO_DIR_CANDIDATES = [
	join(homedir(), ".local", "share", "mimo-code"),
	join(homedir(), ".local", "share", "MiMoCode"),
	join(homedir(), ".local", "share", "mimo"),
	join(homedir(), ".local", "share", "xiaomi-mimo"),
	join(homedir(), ".local", "share", "mimo_code"),
	join(homedir(), ".local", "share", "xiaomi", "mimo")
];
/** MiMo db 解析：HANDOFF_ROOT_MIMO 直指优先（存在与否不门 supported）；否则候选
 * 目录扫描，取首个「库可 readonly 打开且会话表探测命中」的文件；全不中回 null。 */
function resolveMimoDb() {
	const override = process.env["HANDOFF_ROOT_MIMO"];
	if (typeof override === "string" && override !== "") return override;
	for (const dir of MIMO_DIR_CANDIDATES) {
		let files = [];
		try {
			files = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(dir, e.name));
		} catch {
			continue;
		}
		for (const f of files) {
			if (!/\.(db|sqlite|sqlite3)$/i.test(f)) continue;
			const db = openFamilyDb(f);
			if (db === null) continue;
			try {
				if (sqliteSessionsTable(db) !== null) return f;
			} finally {
				db.close();
			}
		}
	}
	return null;
}
const MIMO_OVERRIDE = process.env["HANDOFF_ROOT_MIMO"];
const MIMO_DB = resolveMimoDb();
const MIMO_DEFAULT_ROOT = join(homedir(), ".local", "share", "mimo-code");
const mimoAdapter = {
	name: "mimo",
	root: MIMO_DB ?? MIMO_DEFAULT_ROOT,
	supported: DatabaseSync$3 !== null && (MIMO_DB !== null),
	note: DatabaseSync$3 === null
		? "需要 Node ≥22（node:sqlite 内建模块）"
		: MIMO_DB === null
			? "未找到 MiMo Code 应用数据目录——候选 ~/.local/share/{mimo-code,MiMoCode,mimo,xiaomi-mimo,mimo_code,xiaomi/mimo} 均不在册（目录名未完全核实）；确认后可用 HANDOFF_ROOT_MIMO 指定库文件"
			: void 0,
	discover() {
		const db = openFamilyDb(MIMO_DB ?? "");
		if (db === null) return [];
		try {
			const st = sqliteSessionsTable(db);
			if (st === null) {
				this.note = "库文件在册但未识别 session 表（列名探测不中）——上游可能已迁移存储布局";
				return [];
			}
			const out = sqliteDiscoverRefs(this.name, db, st);
			this.note = sqliteTurnTable(db) === null ? "已识别 session 表但未识别逐轮记录表——正文解析为空（MiMo 存储格式未完全核实）" : void 0;
			return out;
		} finally {
			db.close();
		}
	},
	parse(id) {
		return parseMimoSession(id);
	}
};
/** sessionId + dbPath 可注入（单测用临时库），缺省模块加载时解析的 MiMo 库。 */
function parseMimoSession(sessionId, dbPath = MIMO_DB ?? "") {
	const db = openFamilyDb(dbPath);
	if (db === null) return [];
	try {
		const tt = sqliteTurnTable(db);
		if (tt === null) return [];
		return sqliteSessionTurns(db, sessionId, tt);
	} finally {
		db.close();
	}
}
//#endregion
//#region src/aider.ts
/**
 * Aider 适配器（自研 TS 实现；无会话库——历史直接落在各项目根，2026-11 口径）：
 *   <项目根>/.aider.chat.history.md   对话历史（markdown，半结构化：`> ` 前缀为用户轮）
 *   <项目根>/.aider.input.history     输入历史（readline 形态，仅当无对话历史时兜底为正文）
 * discover：从起点（HANDOFF_ROOT_AIDER 覆盖，测试用；缺省 process.cwd()）向上逐层
 * 探测含历史文件的项目根（到文件系统根为止，深度封顶防循环），每命中一个根收一条会话。
 * parse：markdown 历史段尽力而为解析——`> ` 行聚用户轮、其余非空行聚 assistant 轮、
 * 「# Aider chat conversation」头只作边界；半结构化日志不保证完整（工具输出/截断段
 * 可能混入），note 诚实标注。只读不写、不复活 Aider。
 */
const AIDER_START = process.env["HANDOFF_ROOT_AIDER"] ?? process.cwd();
const AIDER_NOTE = "Aider 无会话库：markdown 历史为半结构化日志，解析尽力而为（工具输出/截断段可能混入）";
/** 向上探测：起点 → 文件系统根沿途含历史文件的目录（近根在前）。 */
function aiderHistoryDirs(startDir) {
	const out = [];
	let dir = startDir;
	for (let depth = 0; depth < 32; depth += 1) {
		if (existsSync(join(dir, ".aider.chat.history.md")) || existsSync(join(dir, ".aider.input.history"))) out.push(dir);
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return out;
}
/** 头部文本的首条用户输入（`> ` 行）前 40 字作标题；读不到回项目目录名。 */
function aiderHeadTitle(head, fallback) {
	const m = /^> ?(.*)$/m.exec(head);
	if (m !== null && m[1].trim() !== "") return m[1].trim().slice(0, 40);
	return fallback;
}
/** markdown 历史文本 → Turn 流：`> ` 行聚用户轮、其余非空行聚 assistant 轮，
 * 会话头只作边界；连续同类行合并为一个 Turn（空行不断开同侧正文）。 */
function parseAiderHistoryText(text) {
	const turns = [];
	let role = null;
	let buf = [];
	const flush = () => {
		if (role === null) return;
		const body = buf.join("\n").trim();
		if (body !== "") turns.push(makeTurn({
			role,
			text: body
		}));
		role = null;
		buf = [];
	};
	for (const raw of text.split("\n")) {
		const line = raw.replace(/\r$/, "");
		const m = /^> ?(.*)$/.exec(line);
		if (m !== null) {
			if (role !== "user") flush();
			role = "user";
			buf.push(m[1]);
			continue;
		}
		if (line.startsWith("# Aider chat conversation")) {
			flush();
			continue;
		}
		if (line.trim() === "") {
			if (role !== null) buf.push("");
			continue;
		}
		if (role !== "assistant") flush();
		role = "assistant";
		buf.push(line);
	}
	flush();
	return turns;
}
/** 输入历史文本 → Turn 流（兜底形态）：跳过 readline 时间戳分隔行（### … ###）
 * 与历史文件头标记（_HiStOrY_V2_，写法不分大小写），每条非空输入记一个用户轮；
 * 该文件没有 assistant 侧正文。 */
function parseAiderInputText(text) {
	const turns = [];
	for (const raw of text.split("\n")) {
		const line = raw.replace(/\r$/, "").trim();
		if (line === "" || line.startsWith("###") || /^_history_v2_/i.test(line)) continue;
		turns.push(makeTurn({
			role: "user",
			text: line
		}));
	}
	return turns;
}
const aiderAdapter = {
	name: "aider",
	root: AIDER_START,
	supported: true,
	note: AIDER_NOTE,
	discover() {
		const out = [];
		for (const dir of aiderHistoryDirs(AIDER_START)) {
			const chat = join(dir, ".aider.chat.history.md");
			const input = join(dir, ".aider.input.history");
			const hasChat = existsSync(chat);
			const body = hasChat ? chat : input;
			let mtime = 0, size = 0;
			try {
				const st = statSync(body);
				if (!st.isFile()) continue;
				mtime = st.mtimeMs;
				size = st.size;
			} catch {
				continue;
			}
			out.push({
				agent: this.name,
				id: body,
				title: hasChat ? aiderHeadTitle(readHead$1(chat), basename(dir)) : basename(dir),
				cwd: dir,
				updatedAt: mtime,
				fingerprint: `${Math.round(mtime)}:${size}`,
				kind: "file"
			});
		}
		return out.sort((a, b) => b.updatedAt - a.updatedAt);
	},
	parse(id) {
		try {
			const text = readFileSync(id, "utf8");
			return basename(id) === ".aider.input.history" ? parseAiderInputText(text) : parseAiderHistoryText(text);
		} catch {
			return [];
		}
	}
};
//#endregion
//#region src/cline.ts
/**
 * Cline（VS Code 扩展，原 Claude Dev）适配器（自研 TS 实现；格式为公开调研，2026-11）。
 *
 * 存储形态（root 可用 HANDOFF_ROOT_CLINE 覆盖，测试用；缺省 VS Code 各变体
 * globalStorage 候选探测）：
 *   <globalStorage>/<扩展目录>/tasks/<taskId>/api_conversation_history.json
 *     Anthropic 风格 {role, content} 消息数组——content 为字符串或块数组
 *     （text / thinking / tool_use / tool_result），Claude 同族，归一复用 entryToTurns。
 * 扩展目录候选：saoudrizwan.claude-dev（原 publisher）与 cline.cline（改名后）；
 * 变体候选：Code / Code - Insiders / VSCodium / Cursor / Windsurf 的 globalStorage。
 * ui_messages.json（say/ask UI 事件流）不读；api 历史没有 cwd 字段——如实留空
 * （上层有空 cwd 警告兜底）。只读不写、不复活 Cline；文件缺失/损坏返回空流。
 */
const CLINE_EXT_DIRS = ["saoudrizwan.claude-dev", "cline.cline"];
const CLINE_VARIANTS = ["Code", "Code - Insiders", "VSCodium", "Cursor", "Windsurf"];
/** 各平台 VS Code 变体的 globalStorage 候选（win32 APPDATA / darwin App Support / 其余 XDG config）。 */
function clineGlobalStorageCandidates() {
	if (process.platform === "win32") {
		const base = process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming");
		return CLINE_VARIANTS.map((v) => join(base, v, "User", "globalStorage"));
	}
	if (process.platform === "darwin") {
		const base = join(homedir(), "Library", "Application Support");
		return CLINE_VARIANTS.map((v) => join(base, v, "User", "globalStorage"));
	}
	const base = process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
	return CLINE_VARIANTS.map((v) => join(base, v, "User", "globalStorage"));
}
/** root 解析：HANDOFF_ROOT_CLINE 直指 > 候选里第一个在册的 tasks 目录 > 首个候选（显示兜底）。 */
function resolveClineRoot() {
	const override = process.env["HANDOFF_ROOT_CLINE"];
	if (typeof override === "string" && override !== "") return override;
	for (const gs of clineGlobalStorageCandidates()) for (const ext of CLINE_EXT_DIRS) {
		const tasks = join(gs, ext, "tasks");
		if (existsSync(tasks)) return tasks;
	}
	return join(clineGlobalStorageCandidates()[0], CLINE_EXT_DIRS[0], "tasks");
}
const CLINE_ROOT = resolveClineRoot();
/** 头部文本里的任务标题：首个 text 块剥 <task> 壳后取首个非空行前 40 字
 * （Cline 首条用户输入是 <task> 正文 + environment_details 连排，标题只取正文首行）。 */
function clineTaskTitle(head, fallback) {
	const m = head.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
	if (!m) return fallback.slice(0, 40);
	let raw;
	try {
		raw = JSON.parse(`"${m[1]}"`);
	} catch {
		raw = m[1];
	}
	const t = raw.replace(/<\/?task>/g, " ");
	const first = t.split("\n").map((s) => s.trim()).find((s) => s !== "") ?? "";
	return (first !== "" ? first : fallback).slice(0, 40);
}
/** 任务目录 → SessionRef（正文取 api_conversation_history.json；文件缺席回 null）。 */
function clineRefFromTask(taskDir) {
	const file = join(taskDir, "api_conversation_history.json");
	let mtime = 0, size = 0;
	try {
		const st = statSync(file);
		if (!st.isFile()) return null;
		mtime = st.mtimeMs;
		size = st.size;
	} catch {
		return null;
	}
	return {
		agent: "cline",
		id: file,
		title: clineTaskTitle(readHead$1(file), basename(taskDir)),
		cwd: "",
		updatedAt: mtime,
		fingerprint: `${Math.round(mtime)}:${size}`,
		kind: "file"
	};
}
/** api_conversation_history.json 文本 → Turn 流：{role, content} 数组逐条包成
 * Claude 同族 entry 复用 entryToTurns；非数组 / 坏 JSON / 未知 role 静默降级。 */
function parseClineConversationText(text) {
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		return [];
	}
	if (!Array.isArray(value)) return [];
	const turns = [];
	for (const item of value) {
		if (item === null || typeof item !== "object") continue;
		const role = item.role === "user" ? "user" : item.role === "assistant" ? "assistant" : "";
		if (role === "") continue;
		turns.push(...entryToTurns({
			type: role,
			message: {
				role,
				content: item.content
			}
		}));
	}
	return turns;
}
const clineAdapter = {
	name: "cline",
	root: CLINE_ROOT,
	supported: true,
	discover() {
		const out = [];
		let taskDirs = [];
		try {
			taskDirs = readdirSync(CLINE_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.isSymbolicLink()).map((d) => join(CLINE_ROOT, d.name));
		} catch {
			this.note = out.length === 0 && existsSync(CLINE_ROOT) ? FAKE_ZERO_NOTE : void 0;
			return out;
		}
		for (const dir of taskDirs) {
			const ref = clineRefFromTask(dir);
			if (ref !== null) out.push(ref);
		}
		this.note = out.length === 0 && existsSync(CLINE_ROOT) ? FAKE_ZERO_NOTE : void 0;
		return out.sort((a, b) => b.updatedAt - a.updatedAt);
	},
	parse(id) {
		try {
			return parseClineConversationText(readFileSync(id, "utf8"));
		} catch {
			return [];
		}
	}
};
//#endregion
//#region src/continue.ts
/**
 * Continue（continuedev/continue，IDE 扩展）适配器（自研 TS 实现；格式为公开调研，2026-11）。
 *
 * 存储形态（root 可用 HANDOFF_ROOT_CONTINUE 覆盖，测试用；缺省 ~/.continue/sessions）：
 *   sessions.json        会话索引（元数据数组，sessionId / title / date 等）
 *   <sessionId>.json     会话文件：history 消息流（{message: {role, content}}）
 * 索引读取容忍 {sessions:[...]} 包装；索引缺席时退化为目录扫描兜底（sessions.json
 * 自身排除）。content 字符串或块数组（text 块取 text）；没有 cwd 字段——只在索引
 * / 会话文件带 workspace 路径时尽力提取（file:// URL 解码），否则如实留空。
 * 只读不写、不复活 Continue；坏行/损坏文件静默跳过或返回空流。
 */
const CONTINUE_ROOT = process.env["HANDOFF_ROOT_CONTINUE"] ?? join(homedir(), ".continue", "sessions");
/** continue content（字符串或块数组）→ 纯文本：取 text 部分，其余块跳过。 */
function continueContentText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const block of content) if (block !== null && typeof block === "object" && typeof block.text === "string") parts.push(block.text);
	return parts.join("\n");
}
/** file:// URL 尽力转本地路径（Windows 盘符去前导斜杠）；非 file 协议原样返回。 */
function fileUrlToPath(u) {
	try {
		const url = new URL(u);
		if (url.protocol !== "file:") return u;
		const p = decodeURIComponent(url.pathname);
		return /^\/[A-Za-z]:/.test(p) ? p.slice(1) : p;
	} catch {
		return u;
	}
}
/** 索引条目 / 会话文件的 workspace 字段 → cwd 尽力而为：字符串（file:// 解码）或
 * 对象的 path/uri/folder/directory 字段；都缺回空串（不猜）。 */
function continueWorkspaceCwd(ws) {
	if (typeof ws === "string" && ws.trim() !== "") return fileUrlToPath(ws.trim());
	if (ws !== null && typeof ws === "object") for (const key of ["path", "uri", "folder", "directory"]) {
		const w = ws[key];
		if (typeof w === "string" && w.trim() !== "") return fileUrlToPath(w.trim());
	}
	return "";
}
/** 索引条目 → 标题（title / name 字段，缺省空）。 */
function continueItemTitle(item) {
	if (typeof item.title === "string" && item.title.trim() !== "") return item.title;
	if (typeof item.name === "string" && item.name.trim() !== "") return item.name;
	return "";
}
/** sessions.json 索引 → 元数据条目数组（容忍 {sessions:[...]} 包装）；坏 JSON / 缺文件回 null。 */
function readContinueIndex(root) {
	try {
		const value = JSON.parse(readFileSync(join(root, "sessions.json"), "utf8"));
		if (Array.isArray(value)) return value;
		if (value !== null && typeof value === "object" && Array.isArray(value.sessions)) return value.sessions;
		return null;
	} catch {
		return null;
	}
}
/** Continue 会话文件文本 → Turn 流：history 消息流逐条取 user/assistant 文本
 * （content 字符串或 text 块数组；system/tool 角色与空正文跳过；fullState 包装容忍）。 */
function parseContinueSessionText(text) {
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		return [];
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
	const v = value;
	const history = Array.isArray(v.history) ? v.history : v.fullState !== null && typeof v.fullState === "object" && Array.isArray(v.fullState.history) ? v.fullState.history : [];
	const turns = [];
	for (const item of history) {
		if (item === null || typeof item !== "object") continue;
		const message = item.message;
		if (message === null || typeof message !== "object") continue;
		const role = message.role === "user" ? "user" : message.role === "assistant" ? "assistant" : "";
		if (role === "") continue;
		const body = continueContentText(message.content).trim();
		if (body === "") continue;
		const tsMs = cellToMs(message.timestamp ?? item.timestamp ?? "");
		turns.push(makeTurn({
			role,
			text: body,
			ts: tsMs > 0 ? new Date(tsMs).toISOString() : ""
		}));
	}
	return turns;
}
const continueAdapter = {
	name: "continue",
	root: CONTINUE_ROOT,
	supported: true,
	discover() {
		const out = [];
		const seen = new Set();
		const index = readContinueIndex(CONTINUE_ROOT);
		if (index !== null) for (const item of index) {
			if (item === null || typeof item !== "object") continue;
			const sid = typeof item.sessionId === "string" && item.sessionId !== "" ? item.sessionId : typeof item.id === "string" && item.id !== "" ? item.id : "";
			if (sid === "" || seen.has(sid)) continue;
			const file = join(CONTINUE_ROOT, `${sid}.json`);
			let mtime = 0, size = 0;
			try {
				const st = statSync(file);
				if (!st.isFile()) continue;
				mtime = st.mtimeMs;
				size = st.size;
			} catch {
				continue;
			}
			seen.add(sid);
			const dateMs = cellToMs(item.date ?? item.createdAt ?? item.created ?? "");
			out.push({
				agent: this.name,
				id: file,
				title: continueItemTitle(item) || sid.slice(0, 18),
				cwd: continueWorkspaceCwd(item.workspace),
				updatedAt: dateMs > 0 ? dateMs : mtime,
				fingerprint: `${Math.round(mtime)}:${size}`,
				kind: "file"
			});
		}
		// 索引缺席 → 目录扫描兜底（sessions.json 自身排除；标题从文件头 title 字段尽力抠）
		if (index === null) {
			let names = [];
			try {
				names = readdirSync(CONTINUE_ROOT);
			} catch {}
			for (const name of names) {
				if (!name.endsWith(".json") || name === "sessions.json") continue;
				const file = join(CONTINUE_ROOT, name);
				let mtime = 0, size = 0;
				try {
					const st = statSync(file);
					if (!st.isFile()) continue;
					mtime = st.mtimeMs;
					size = st.size;
				} catch {
					continue;
				}
				const head = readHead$1(file);
				const m = head.match(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/);
				let title = "";
				if (m) try {
					title = JSON.parse(`"${m[1]}"`).trim();
				} catch {
					title = m[1].trim();
				}
				out.push({
					agent: this.name,
					id: file,
					title: title || basename(name, ".json").slice(0, 18),
					cwd: "",
					updatedAt: mtime,
					fingerprint: `${Math.round(mtime)}:${size}`,
					kind: "file"
				});
			}
		}
		this.note = out.length === 0 && existsSync(CONTINUE_ROOT) ? FAKE_ZERO_NOTE : void 0;
		return out.sort((a, b) => b.updatedAt - a.updatedAt);
	},
	parse(id) {
		try {
			return parseContinueSessionText(readFileSync(id, "utf8"));
		} catch {
			return [];
		}
	}
};
//#endregion
//#region src/qwen.ts
/**
* Qwen Code（阿里 QwenLM/qwen-code，Gemini CLI 分叉）适配器（自研 TS 实现；格式对上游
* 源码核实，2026-11：packages/cli/src/config/storage-paths-lite.ts 的 getGlobalQwenDirLite、
* packages/core/src/config/storage.ts 与 services/chatRecordingService.ts）。
*
* 存储形态（root 可用 HANDOFF_ROOT_QWEN 覆盖，测试用；QWEN_HOME 优先于缺省 ~/.qwen，
* 与上游 getGlobalQwenDirLite 同序，含 ~/ 前缀展开）：
*
*   <root>/tmp/<项目哈希>/chats/            旧版布局（Gemini 族遗产）
*     session-<timestamp>-<8位id>.jsonl/.json   Gemini 族记录（metadata + messages；
*     分叉早期类型就是 user / gemini，未改名——v0.0.14 源码核实）
*   <root>/projects/<cwd 转义>/chats/       新版布局（上游当前 getProjectDir）
*     <sessionId>.jsonl                     ChatRecord 树记录（uuid/parentUuid 链）
*     <sessionId>.runtime.json              运行态 sidecar——不读
*
* 两布局都探测（历史版本写前者、当前版本写后者），命中哪个走哪个；记录按行分派：
* - Gemini 族记录（content 字段）：复用 gemini 适配器同款归一（recordToTurns——
*   user / gemini 轮、toolCalls 拆调用 + 结果轮、info/error/warning 不进流）；
* - ChatRecord 记录（message.parts / uuid 字段）：user → 用户轮（subtype 为
*   agent_mention / agent_message / slash_command / ui_telemetry 的控制记录与
*   provenance=mod_prompt 的代提交不进流）；assistant → 文本轮（model 透传）+
*   thought 块 [thinking] 标记 + functionCall 块工具轮；tool_result →
*   functionResponse 块工具结果轮（toolCallResult.status==='error' 或
*   response.error 记 toolFailed）；system 与未知类型静默跳过。
* cwd 取自记录本身（新版每条 ChatRecord 带 cwd），Gemini 族记录沿 .project_root
* 反查（gemini 同款，读不到留空）。
* QWEN.md 记忆体系不在本期（会话轴 only）。
* 只读不写、不复活 Qwen Code 进程；坏行/损坏文件静默跳过或返回空流。
*/
/** QWEN_HOME 解析（上游语义：~/ 前缀展开到 home，其余按绝对路径；缺省 ~/.qwen）。 */
function qwenHomeDir() {
	const env = process.env["QWEN_HOME"];
	if (typeof env === "string" && env !== "") {
		if (env === "~") return homedir();
		if (env.startsWith("~/") || env.startsWith("~\\")) return join(homedir(), ...env.slice(2).split(/[\\/]+/).filter(Boolean));
		return env;
	}
	return join(homedir(), ".qwen");
}
const QWEN_ROOT = process.env["HANDOFF_ROOT_QWEN"] ?? qwenHomeDir();
/** qwen 控制性 subtype：type==='user' 但永远不是真人输入（上游 contract.ts 原话），
* 与 slash / UI 遥测一起不进对话流。 */
const QWEN_CONTROL_SUBTYPES = new Set(["agent_mention", "agent_message", "slash_command", "ui_telemetry"]);
/** 单条 ChatRecord → Turn 列表。system / 控制 subtype / 代提交不产生 Turn。 */
function qwenChatRecordToTurns(record, defaultCwd) {
	const type = typeof record.type === "string" ? record.type : "";
	if (type === "system") return [];
	if (typeof record.subtype === "string" && QWEN_CONTROL_SUBTYPES.has(record.subtype)) return [];
	if (record.provenance === "mod_prompt") return [];
	const cwd = typeof record.cwd === "string" && record.cwd !== "" ? record.cwd : defaultCwd;
	const ts = typeof record.timestamp === "string" ? record.timestamp : "";
	const model = typeof record.model === "string" ? record.model : "";
	const message = record.message !== null && typeof record.message === "object" ? record.message : null;
	const parts = message !== null && Array.isArray(message.parts) ? message.parts.filter((p) => p !== null && typeof p === "object") : [];
	const turns = [];
	if (type === "user") {
		const text = parts.filter((p) => p.thought !== true && typeof p.text === "string").map((p) => p.text).join("\n").trim();
		if (text !== "") turns.push(makeTurn({
			role: "user",
			text,
			cwd,
			ts
		}));
		return turns;
	}
	if (type === "assistant") {
		for (const part of parts) {
			if (part.thought === true && typeof part.text === "string" && part.text.trim() !== "") turns.push(makeTurn({
				role: "assistant",
				text: `[thinking] ${part.text.trim()}`,
				cwd,
				ts,
				model
			}));
			else if (typeof part.text === "string" && part.text.trim() !== "") turns.push(makeTurn({
				role: "assistant",
				text: part.text.trim(),
				cwd,
				ts,
				model
			}));
			const call = part.functionCall;
			if (call !== null && typeof call === "object") {
				const name = typeof call.name === "string" && call.name !== "" ? call.name : "qwen_tool";
				turns.push(makeTurn({
					role: "assistant",
					text: summarizeToolCall(name, call.args),
					cwd,
					ts,
					model,
					toolName: name
				}));
			}
		}
		return turns;
	}
	if (type === "tool_result") {
		const callResult = record.toolCallResult !== null && typeof record.toolCallResult === "object" ? record.toolCallResult : null;
		for (const part of parts) {
			const fr = part.functionResponse;
			if (fr === null || typeof fr !== "object") continue;
			const name = typeof fr.name === "string" && fr.name !== "" ? fr.name : "qwen_tool";
			const response = fr.response !== null && typeof fr.response === "object" ? fr.response : {};
			let result = toolResultText(response);
			const failed = callResult !== null && callResult.status === "error" || response.error !== void 0 && response.error !== null;
			if (result === "" && response.error !== void 0 && response.error !== null) result = typeof response.error === "string" ? response.error : JSON.stringify(response.error);
			turns.push(makeTurn({
				role: "tool",
				text: result.slice(0, 2e3),
				cwd,
				ts,
				toolName: name,
				toolFailed: failed
			}));
		}
	}
	return turns;
}
/** 判断一行记录是否 ChatRecord（uuid / message 字段是 Gemini 族记录没有的）。 */
function isQwenChatRecord(record) {
	return typeof record.uuid === "string" || record.message !== null && typeof record.message === "object";
}
/** JSONL 文本 → Turn 流：按记录形态分派（ChatRecord / Gemini 族），坏行静默跳过。 */
function parseQwenText(text, cwd = "") {
	const turns = [];
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line === "") continue;
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		if (record === null || typeof record !== "object" || Array.isArray(record)) continue;
		if (isQwenChatRecord(record)) {
			turns.push(...qwenChatRecordToTurns(record, cwd));
			continue;
		}
		if (typeof record.type !== "string") continue;
		if (isControlLine(record)) continue;
		turns.push(...recordToTurns(record, cwd));
	}
	return turns;
}
/** 会话文件路径（.json 旧格式 / .jsonl 两族流式）→ Turn 流。文件缺失/损坏返回 []。 */
function parseQwenSession(id) {
	let text;
	try {
		text = readFileSync(id, "utf8");
	} catch {
		return [];
	}
	const head = readHead$1(id);
	const cwd = qwenHeadCwd(head) || projectCwd(id);
	return id.toLowerCase().endsWith(".json") ? parseGeminiJson(text, cwd) : parseQwenText(text, cwd);
}
/** 头部窗口里首条 ChatRecord 的 cwd（新版每条记录都带；旧版没有 → 空串走反查）。 */
function qwenHeadCwd(head) {
	for (const raw of head.split("\n")) {
		const line = raw.trim();
		if (line === "") continue;
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		if (record !== null && typeof record === "object" && typeof record.cwd === "string" && record.cwd !== "") return record.cwd;
	}
	return "";
}
/** 头部窗口里首条用户输入前 40 字作标题（Gemini 族 summary 元数据优先在外层处理）。 */
function qwenHeadUserText(head) {
	for (const turn of parseQwenText(head, "")) if (turn.role === "user" && turn.text.trim() !== "") return turn.text.trim().slice(0, 40);
	return "";
}
function qwenRefFromFile(file) {
	let mtime = 0;
	let size = 0;
	try {
		const st = statSync(file);
		if (!st.isFile()) return null;
		mtime = st.mtimeMs;
		size = st.size;
	} catch {
		return null;
	}
	const meta = readHeadMeta(file, file.toLowerCase().endsWith(".json"));
	const head = readHead$1(file);
	const userTitle = qwenHeadUserText(head);
	return {
		agent: "qwen",
		id: file,
		title: meta.summary !== "" ? meta.summary : userTitle !== "" ? userTitle : basename(file),
		cwd: qwenHeadCwd(head) || projectCwd(file),
		updatedAt: meta.lastUpdated || mtime,
		fingerprint: `${Math.round(mtime)}:${size}`,
		kind: "file"
	};
}
const qwenAdapter = {
	name: "qwen",
	root: QWEN_ROOT,
	supported: true,
	discover() {
		const out = [];
		for (const base of [join(QWEN_ROOT, "tmp"), join(QWEN_ROOT, "projects")]) {
			let projectDirs = [];
			try {
				projectDirs = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.isSymbolicLink()).map((d) => join(base, d.name));
			} catch {
				continue;
			}
			for (const projectDir of projectDirs) {
				const chatsDir = join(projectDir, "chats");
				let chatEntries = [];
				try {
					chatEntries = readdirSync(chatsDir, { withFileTypes: true });
				} catch {
					continue;
				}
				const files = [];
				for (const entry of chatEntries) {
					const full = join(chatsDir, entry.name);
					if (entry.isFile()) {
						if (isSessionFile(entry.name) || entry.name.endsWith(".jsonl")) files.push(full);
					} else if (entry.isDirectory() && !entry.isSymbolicLink()) try {
						for (const name of readdirSync(full)) if (isSessionFile(name)) files.push(join(full, name));
					} catch {
						continue;
					}
				}
				for (const file of files) {
					const ref = qwenRefFromFile(file);
					if (ref !== null) out.push(ref);
				}
			}
		}
		this.note = out.length === 0 && existsSync(QWEN_ROOT) ? FAKE_ZERO_NOTE : void 0;
		return out.sort((a, b) => b.updatedAt - a.updatedAt);
	},
	parse(id) {
		try {
			return parseQwenSession(id);
		} catch {
			return [];
		}
	}
};
//#endregion
//#region src/antigravity.ts
/**
* Antigravity（Google）适配器（自研 TS 实现；格式为公开调研，2026-11 经社区读取器
* 交叉核实：dpavlin/agy-explore 对实录解析、mjacobs/agy-reader 对目录布局、
* fliberty 实测文章对 IDE 2.0 的 brain 路径）。
*
* 存储形态（root 可用 HANDOFF_ROOT_ANTIGRAVITY 覆盖，测试用；缺省 ~/.gemini/antigravity-cli）：
*
*   <root>/conversation_summaries.db      跨端索引（SQLite WAL，conversation_summaries 表：
*                                         conversation_id + workspace_uris）——只作 cwd 映射
*   <root>/brain/<会话id>/.system_generated/logs/transcript_full.jsonl | transcript.jsonl
*   ~/.gemini/antigravity/brain/<会话id>/logs/transcript.jsonl   IDE 2.0 布局（brain 候选
*                                         双目录都探测：antigravity-cli 与 antigravity）
*
* transcript JSONL 行法（一行一步骤，已知组合分派、未知行静默跳过）：
* - source=USER_EXPLICIT 且 type=USER_INPUT → 用户轮（<USER_REQUEST> 壳剥离，
*   agy-explore 同口径）；
* - source=MODEL 且 type=PLANNER_RESPONSE → 助手文本轮；
* - thinking 字段 → [thinking] 标记轮（在该步正文之前）；
* - tool_calls[] → 每个调用一个助手工具轮（toolName=原生名，text=摘要，永不回放）。
* cwd 取自 conversation_summaries 索引（workspace_uris JSON 数组首项 file:// 解码，
* 正则兜底）；索引库缺席 / 列探测不中时如实留空（上层有空 cwd 警告兜底）。
* 标题取首条用户输入前 40 字。created_at ISO 时间戳。
* 只读不写、不复活 Antigravity；坏行/损坏文件静默跳过或返回空流。
*/
const ANTIGRAVITY_ROOT = process.env["HANDOFF_ROOT_ANTIGRAVITY"] ?? join(homedir(), ".gemini", "antigravity-cli");
const ANTIGRAVITY_BRAIN_DIRS = [join(ANTIGRAVITY_ROOT, "brain"), join(homedir(), ".gemini", "antigravity", "brain")];
const ANTIGRAVITY_SUMMARIES_DB = join(ANTIGRAVITY_ROOT, "conversation_summaries.db");
/** transcript 候选路径（按序取首个在册；.system_generated 是社区工具核实的主形态）。 */
const ANTIGRAVITY_TRANSCRIPT_RELS = [".system_generated/logs/transcript_full.jsonl", ".system_generated/logs/transcript.jsonl", "logs/transcript.jsonl"];
/** 会话目录 → transcript 文件；三种候选都不在册回 null。 */
function antigravityTranscriptOf(convDir) {
	for (const rel of ANTIGRAVITY_TRANSCRIPT_RELS) {
		const file = join(convDir, rel);
		try {
			if (statSync(file).isFile()) return file;
		} catch {}
	}
	return null;
}
/** transcript 路径 → 会话 id：上溯到 brain/ 的直接子目录名（找不到回空串）。 */
function antigravityConvIdOf(file) {
	let dir = dirname(file);
	for (let depth = 0; depth < 5; depth += 1) {
		const parent = dirname(dir);
		if (parent === dir) return "";
		if (basename(parent) === "brain") return basename(dir);
		dir = parent;
	}
	return "";
}
/** 用户输入正文：<USER_REQUEST> 壳剥离（agy-explore 同口径），其余原样 trim。 */
function antigravityRequestText(content) {
	if (typeof content !== "string") return "";
	const text = content.includes("<USER_REQUEST>") ? content.split("<USER_REQUEST>").pop().split("</USER_REQUEST>")[0] : content;
	return text.trim();
}
/** workspace_uris 单元格 → cwd 尽力而为：JSON 数组首项 → file:// 正则兜底 →
* 绝对路径原样；都不是回空串（不猜）。 */
function antigravityWorkspaceCwd(cell) {
	if (typeof cell === "string" && cell.trim() !== "") {
		try {
			const v = JSON.parse(cell);
			if (Array.isArray(v) && typeof v[0] === "string" && v[0].trim() !== "") return fileUrlToPath(v[0].trim());
		} catch {}
		const m = /file:\/\/[^\s"']+/.exec(cell);
		if (m) return fileUrlToPath(m[0]);
		const trimmed = cell.trim();
		if (/^([A-Za-z]:[\\/]|\/)/.test(trimmed)) return trimmed;
	}
	return "";
}
/** 跨端索引库 → 会话 id → cwd 映射。库缺席 / 表列探测不中回空映射（不抛）。 */
function antigravityWorkspaceMap() {
	const map = new Map();
	const db = openFamilyDb(ANTIGRAVITY_SUMMARIES_DB);
	if (db === null) return map;
	try {
		const cols = tableColumns(db, "conversation_summaries");
		const idCol = firstCol(cols, ["conversation_id", "conversationId", "id"]);
		const wsCol = firstCol(cols, ["workspace_uris", "workspaceUris", "workspaces", "workspace"]);
		if (idCol === void 0 || wsCol === void 0) return map;
		let rows = [];
		try {
			rows = db.prepare('SELECT * FROM "conversation_summaries"').all();
		} catch {
			return map;
		}
		for (const row of rows) {
			const id = row[idCol];
			if (typeof id !== "string" || id === "") continue;
			const cwd = antigravityWorkspaceCwd(row[wsCol]);
			if (cwd !== "") map.set(id, cwd);
		}
	} finally {
		db.close();
	}
	return map;
}
/** 单条步骤记录 → Turn 列表：thinking → 正文（用户 / 助手）→ 工具调用。 */
function antigravityRecordToTurns(record, cwd) {
	const turns = [];
	const tsMs = toMillis(record.created_at);
	const ts = tsMs !== 0 ? new Date(tsMs).toISOString() : "";
	const thinking = typeof record.thinking === "string" ? record.thinking.trim() : "";
	if (thinking !== "") turns.push(makeTurn({
		role: "assistant",
		text: `[thinking] ${thinking}`,
		cwd,
		ts
	}));
	if (record.source === "USER_EXPLICIT" && record.type === "USER_INPUT") {
		const text = antigravityRequestText(record.content);
		if (text !== "") turns.push(makeTurn({
			role: "user",
			text,
			cwd,
			ts
		}));
	} else if (record.source === "MODEL" && record.type === "PLANNER_RESPONSE") {
		const text = typeof record.content === "string" ? record.content.trim() : "";
		if (text !== "") turns.push(makeTurn({
			role: "assistant",
			text,
			cwd,
			ts
		}));
	}
	const toolCalls = Array.isArray(record.tool_calls) ? record.tool_calls : [];
	for (const call of toolCalls) {
		if (call === null || typeof call !== "object") continue;
		const c = call;
		const name = typeof c.name === "string" && c.name !== "" ? c.name : "antigravity_tool";
		turns.push(makeTurn({
			role: "assistant",
			text: summarizeToolCall(name, c.args),
			cwd,
			ts,
			toolName: name
		}));
	}
	return turns;
}
/** transcript JSONL 文本 → Turn 流：坏行静默跳过。 */
function parseAntigravityTranscriptText(text, cwd = "") {
	const turns = [];
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line === "") continue;
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		if (record === null || typeof record !== "object" || Array.isArray(record)) continue;
		turns.push(...antigravityRecordToTurns(record, cwd));
	}
	return turns;
}
/** 头部窗口里首条用户输入前 40 字作标题（索引库没有标题列，标题出自正文）。 */
function antigravityHeadTitle(head) {
	for (const turn of parseAntigravityTranscriptText(head, "")) if (turn.role === "user" && turn.text.trim() !== "") return turn.text.trim().slice(0, 40);
	return "";
}
const antigravityAdapter = {
	name: "antigravity",
	root: ANTIGRAVITY_ROOT,
	supported: true,
	discover() {
		const out = [];
		const seen = new Set();
		const workspaces = antigravityWorkspaceMap();
		for (const brainDir of ANTIGRAVITY_BRAIN_DIRS) {
			let entries = [];
			try {
				entries = readdirSync(brainDir, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const entry of entries) {
				if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
				const convDir = join(brainDir, entry.name);
				const file = antigravityTranscriptOf(convDir);
				if (file === null || seen.has(file)) continue;
				let mtime = 0, size = 0;
				try {
					const st = statSync(file);
					mtime = st.mtimeMs;
					size = st.size;
				} catch {
					continue;
				}
				seen.add(file);
				out.push({
					agent: this.name,
					id: file,
					title: antigravityHeadTitle(readHead$1(file)) || entry.name,
					cwd: workspaces.get(entry.name) ?? "",
					updatedAt: mtime,
					fingerprint: `${Math.round(mtime)}:${size}`,
					kind: "file"
				});
			}
		}
		this.note = out.length === 0 && ANTIGRAVITY_BRAIN_DIRS.some((d) => existsSync(d)) ? FAKE_ZERO_NOTE : void 0;
		return out.sort((a, b) => b.updatedAt - a.updatedAt);
	},
	parse(id) {
		try {
			const convId = antigravityConvIdOf(id);
			const cwd = convId !== "" ? antigravityWorkspaceMap().get(convId) ?? "" : "";
			return parseAntigravityTranscriptText(readFileSync(id, "utf8"), cwd);
		} catch {
			return [];
		}
	}
};
//#endregion
//#region src/openclaw.ts
/**
* OpenClaw 适配器（自研 TS 实现；格式对上游源码核实，2026-11：
* src/config/state-dir.ts、src/state/openclaw-agent-db.paths.ts、
* src/state/openclaw-agent-schema.sql、src/config/sessions/paths.ts 与官方文档
* docs/concepts/session.md「Where state lives」节）。
*
* 存储形态（root 可用 HANDOFF_ROOT_OPENCLAW 覆盖，测试用；OPENCLAW_STATE_DIR 优先于
* 缺省 ~/.openclaw，与上游 resolveStateDir 同序）：
*
*   <root>/agents/<agentId>/agent/openclaw-agent.sqlite   新版：运行态会话库
*     session_nodes      会话节点（session_key PK / current_session_id / label /
*                        display_name / entry_json / updated_at）
*     transcript_events  逐事件（session_id + seq PK；event_json 明文 JSON 或
*                        event_zstd 压缩 BLOB——zstd 缺席的 Node 上跳过并如实降级）
*   <root>/agents/<agentId>/sessions/                     旧版：归档 transcript
*     sessions.json      旧版索引（迁移源；数组 / {sessions:[...]} / 键→条目映射
*                        三形态容忍，sessionFile 绝对路径字段兼容旧版）
*     <sessionId>.jsonl  旧版 transcript（一行一 {message:{role, content}}，pi 族
*                        风格的 {type:'session', cwd} 头行容忍）
*
* 两形态都探测，命中哪个走哪个（同一会话在两形态各有存储物，各自成候选不去重）。
* transcript 正文只取 user / assistant 文本（content 字符串或 text 块数组），
* 工具与其他事件类型静默跳过；session_nodes 没有 cwd 字段——如实留空。
* 只读不写、不复活 OpenClaw；坏行/损坏行静默跳过或返回空流。
*/
const OPENCLAW_ROOT = process.env["HANDOFF_ROOT_OPENCLAW"] ?? process.env["OPENCLAW_STATE_DIR"] ?? join(homedir(), ".openclaw");
const OPENCLAW_AGENTS_DIR = join(OPENCLAW_ROOT, "agents");
/** event_zstd 压缩行解码：Node ≥22.15 才有 zstdDecompressSync；缺席回 null
*（压缩行静默跳过，正文按可用行归一——降级如实，不粉饰成空会话正常）。 */
let OPENCLAW_ZSTD = null;
try {
	OPENCLAW_ZSTD = createRequire(import.meta.url)("node:zlib").zstdDecompressSync ?? null;
} catch {}
/** content（字符串 / text 块数组 / 混合）→ 纯文本。 */
function openclawContentText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const block of content) {
		if (typeof block === "string") {
			parts.push(block);
			continue;
		}
		if (block !== null && typeof block === "object" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n");
}
/** 单条 transcript 事件 → Turn 列表：只取 {message:{role, content}} 形态的
* user / assistant 文本，其余事件类型静默跳过。 */
function openclawEventToTurns(ev, cwd, ts) {
	const turns = [];
	if (ev === null || typeof ev !== "object") return turns;
	const message = ev.message !== null && typeof ev.message === "object" ? ev.message : null;
	if (message === null) return turns;
	const role = message.role === "user" ? "user" : message.role === "assistant" ? "assistant" : "";
	if (role === "") return turns;
	const body = openclawContentText(message.content).trim();
	if (body === "") return turns;
	turns.push(makeTurn({
		role,
		text: body,
		cwd,
		ts
	}));
	return turns;
}
/** transcript JSONL 文本（旧版 sessions/*.jsonl）→ Turn 流：{type:'session'} 头行
* 给 cwd（pi 族风格，容忍在册与否），{message:{role, content}} 行归一。 */
function parseOpenclawTranscriptText(text, cwd = "") {
	let dir = cwd;
	const turns = [];
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line === "") continue;
		let ev;
		try {
			ev = JSON.parse(line);
		} catch {
			continue;
		}
		if (ev === null || typeof ev !== "object") continue;
		if (ev.type === "session" && typeof ev.cwd === "string" && ev.cwd !== "") {
			dir = ev.cwd;
			continue;
		}
		const tsMs = cellToMs(ev.timestamp ?? ev.created_at ?? "");
		turns.push(...openclawEventToTurns(ev, dir, tsMs > 0 ? new Date(tsMs).toISOString() : ""));
	}
	return turns;
}
/** 头部窗口里首条用户输入前 40 字作标题（目录扫描兜底用；索引在册时用索引标题）。 */
function openclawHeadTitle(head) {
	for (const turn of parseOpenclawTranscriptText(head, "")) if (turn.role === "user" && turn.text.trim() !== "") return turn.text.trim().slice(0, 40);
	return "";
}
/** agents/ 下的 agent 目录 → 各自的 openclaw-agent.sqlite 路径（parse 缺省 dbPath
* 时逐库探测用；openclaw 多 agent 各一库，无全局索引）。 */
function openclawAgentDbs() {
	const out = [];
	let entries = [];
	try {
		entries = readdirSync(OPENCLAW_AGENTS_DIR, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
		const dbFile = join(OPENCLAW_AGENTS_DIR, entry.name, "agent", "openclaw-agent.sqlite");
		if (existsSync(dbFile)) out.push(dbFile);
	}
	return out;
}
/** sessionId + dbPath 可注入（单测用临时库），缺省扫描 agents/ 逐库找。 */
function parseOpenclawSession(sessionId, dbPath) {
	const dbs = dbPath !== void 0 && dbPath !== "" ? [dbPath] : openclawAgentDbs();
	for (const path of dbs) {
		const db = openFamilyDb(path);
		if (db === null) continue;
		try {
			const cols = tableColumns(db, "transcript_events");
			const sidCol = firstCol(cols, ["session_id"]);
			const eventCol = firstCol(cols, ["event_json"]);
			if (sidCol === void 0 || eventCol === void 0) continue;
			const zstdCol = firstCol(cols, ["event_zstd"]);
			const createdCol = firstCol(cols, ["created_at"]);
			const seqCol = firstCol(cols, ["seq"]);
			const order = seqCol !== void 0 ? `"${seqCol}"` : "rowid";
			let rows = [];
			try {
				rows = db.prepare(`SELECT * FROM "transcript_events" WHERE "${sidCol}" = ? ORDER BY ${order}`).all(sessionId);
			} catch {
				continue;
			}
			if (rows.length === 0) continue;
			const turns = [];
			for (const row of rows) {
				const created = createdCol !== void 0 ? cellToMs(row[createdCol]) : 0;
				const ts = created > 0 ? new Date(created).toISOString() : "";
				if (typeof row[eventCol] === "string" && row[eventCol].trim() !== "") {
					try {
						turns.push(...openclawEventToTurns(JSON.parse(row[eventCol]), "", ts));
					} catch {
						continue;
					}
					continue;
				}
				if (zstdCol !== void 0 && row[zstdCol] != null && OPENCLAW_ZSTD !== null) try {
					turns.push(...openclawEventToTurns(JSON.parse(OPENCLAW_ZSTD(Buffer.from(row[zstdCol])).toString("utf8")), "", ts));
				} catch {
					continue;
				}
			}
			return turns;
		} finally {
			db.close();
		}
	}
	return [];
}
/** session_nodes 行 → SessionRef 列表（标题 label / display_name / entry_json 三层
* 探测；updated_at 是库行变更时间，列表排序用——上游文档口径）。cwd 字段不在库
* schema 里——如实留空。表探测不中回 null（调用方诚实浮出 note）。 */
function openclawSqliteRefs(agent, db) {
	const cols = tableColumns(db, "session_nodes");
	if (cols.size === 0) return null;
	const keyCol = firstCol(cols, ["session_key"]);
	const sidCol = firstCol(cols, ["current_session_id"]);
	if (keyCol === void 0) return null;
	const idCol = sidCol ?? keyCol;
	const labelCol = firstCol(cols, ["label"]);
	const displayCol = firstCol(cols, ["display_name"]);
	const entryCol = firstCol(cols, ["entry_json"]);
	const updatedCol = firstCol(cols, ["updated_at"]);
	const orderCol = updatedCol ?? keyCol;
	let rows = [];
	try {
		rows = db.prepare(`SELECT * FROM "session_nodes" ORDER BY "${orderCol}" DESC`).all();
	} catch {
		return [];
	}
	const out = [];
	for (const row of rows) {
		const idCell = row[idCol];
		const id = typeof idCell === "string" ? idCell : typeof idCell === "number" ? String(idCell) : "";
		if (id === "") continue;
		let title = "";
		for (const col of [labelCol, displayCol]) {
			const cell = col !== void 0 ? row[col] : void 0;
			if (typeof cell === "string" && cell.trim() !== "") {
				title = cell.trim();
				break;
			}
		}
		if (title === "" && entryCol !== void 0 && typeof row[entryCol] === "string") try {
			const entry = JSON.parse(row[entryCol]);
			if (entry !== null && typeof entry === "object") for (const key of ["label", "displayName", "subject"]) {
				const v = entry[key];
				if (typeof v === "string" && v.trim() !== "") {
					title = v.trim();
					break;
				}
			}
		} catch {}
		const updated = updatedCol !== void 0 ? cellToMs(row[updatedCol]) : 0;
		out.push({
			agent,
			id,
			title: title !== "" ? title : id.slice(0, 18),
			cwd: "",
			updatedAt: updated,
			fingerprint: String(updatedCol !== void 0 ? row[updatedCol] ?? "" : updated),
			kind: "sqlite"
		});
	}
	return out.sort((a, b) => b.updatedAt - a.updatedAt);
}
/** 索引条目 → 标题（label / displayName / subject / title / name 探测，缺省空）。 */
function openclawIndexTitle(item) {
	for (const key of ["label", "displayName", "subject", "title", "name"]) {
		const v = item[key];
		if (typeof v === "string" && v.trim() !== "") return v.trim();
	}
	return "";
}
/** sessions.json → 条目数组：数组 / {sessions:[...]} / 键→条目映射三形态容忍
* （映射形态把键注入 sessionKey 字段）；坏 JSON / 缺文件回 null。 */
function openclawReadIndex(sessionsDir) {
	try {
		const value = JSON.parse(readFileSync(join(sessionsDir, "sessions.json"), "utf8"));
		if (Array.isArray(value)) return value;
		if (value !== null && typeof value === "object" && Array.isArray(value.sessions)) return value.sessions;
		if (value !== null && typeof value === "object") {
			const rows = Object.entries(value).map(([key, row]) => row !== null && typeof row === "object" && !Array.isArray(row) ? {
				sessionKey: key,
				...row
			} : row);
			return rows.some((r) => r !== null && typeof r === "object") ? rows : null;
		}
		return null;
	} catch {
		return null;
	}
}
/** 旧版 sessions/ 目录 → SessionRef 列表：索引优先（条目带 sessionFile /
* sessionsFile 绝对路径字段时兼容旧版），索引缺席 → 目录扫描兜底。 */
function openclawLegacyRefs(agent, sessionsDir) {
	const out = [];
	const seen = new Set();
	const index = openclawReadIndex(sessionsDir);
	if (index !== null) for (const item of index) {
		if (item === null || typeof item !== "object") continue;
		let sid = "";
		for (const key of ["sessionId", "sessionKey", "session_key", "id"]) {
			const v = item[key];
			if (typeof v === "string" && v !== "") {
				sid = v;
				break;
			}
		}
		if (sid === "" || seen.has(sid)) continue;
		let file = "";
		for (const key of ["sessionFile", "sessionsFile", "transcriptPath"]) {
			const v = item[key];
			if (typeof v === "string" && v !== "") {
				file = v;
				break;
			}
		}
		if (file === "") file = join(sessionsDir, `${sid}.jsonl`);
		let mtime = 0, size = 0;
		try {
			const st = statSync(file);
			if (!st.isFile()) continue;
			mtime = st.mtimeMs;
			size = st.size;
		} catch {
			continue;
		}
		seen.add(sid);
		const updated = cellToMs(item.updatedAt ?? item.lastUpdated ?? item.lastInteractionAt ?? "");
		out.push({
			agent,
			id: file,
			title: openclawIndexTitle(item) || sid.slice(0, 18),
			cwd: "",
			updatedAt: updated > 0 ? updated : mtime,
			fingerprint: `${Math.round(mtime)}:${size}`,
			kind: "file"
		});
	}
	if (index === null) {
		let names = [];
		try {
			names = readdirSync(sessionsDir);
		} catch {}
		for (const name of names) {
			if (!name.endsWith(".jsonl")) continue;
			const file = join(sessionsDir, name);
			let mtime = 0, size = 0;
			try {
				const st = statSync(file);
				if (!st.isFile()) continue;
				mtime = st.mtimeMs;
				size = st.size;
			} catch {
				continue;
			}
			out.push({
				agent,
				id: file,
				title: openclawHeadTitle(readHead$1(file)) || basename(name, ".jsonl").slice(0, 18),
				cwd: "",
				updatedAt: mtime,
				fingerprint: `${Math.round(mtime)}:${size}`,
				kind: "file"
			});
		}
	}
	return out;
}
const openclawAdapter = {
	name: "openclaw",
	root: OPENCLAW_ROOT,
	supported: true,
	discover() {
		const out = [];
		let note = void 0;
		let entries = [];
		try {
			entries = readdirSync(OPENCLAW_AGENTS_DIR, { withFileTypes: true });
		} catch {
			this.note = void 0;
			return out;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
			const agentDir = join(OPENCLAW_AGENTS_DIR, entry.name);
			// 新形态：agent/openclaw-agent.sqlite（node:sqlite 缺席时优雅跳过，旧形态仍可读）
			if (DatabaseSync$3 !== null) {
				const db = openFamilyDb(join(agentDir, "agent", "openclaw-agent.sqlite"));
				if (db !== null) try {
					const refs = openclawSqliteRefs(this.name, db);
					if (refs === null) note = "agent 库在册但未识别 session_nodes 表（列名探测不中）——上游可能已迁移存储布局";
					else out.push(...refs);
				} finally {
					db.close();
				}
			}
			// 旧形态：sessions/sessions.json 索引 + sessions/*.jsonl（两者都探测）
			out.push(...openclawLegacyRefs(this.name, join(agentDir, "sessions")));
		}
		if (out.length === 0 && note === void 0 && existsSync(OPENCLAW_AGENTS_DIR)) note = FAKE_ZERO_NOTE;
		this.note = note;
		return out.sort((a, b) => b.updatedAt - a.updatedAt);
	},
	parse(id) {
		try {
			if (id.toLowerCase().endsWith(".jsonl")) return parseOpenclawTranscriptText(readFileSync(id, "utf8"));
			return parseOpenclawSession(id);
		} catch {
			return [];
		}
	}
};
//#endregion
//#region src/goose.ts
/**
* Goose（Block）适配器（自研 TS 实现；会话存储格式对上游源码核实，2026-11：
* crates/goose/src/session/session_manager.rs 的 sessions.db 建表语句与
* session/legacy.rs 的旧版 JSONL 实录 fixture）。
*
* 存储形态（<数据目录>/sessions/ 下两形态都探测，命中哪个走哪个）：
*   sessions.db                    新版：SQLite（sessions 表 + messages 表）
*     sessions  id / name / working_dir / created_at / updated_at …
*     messages  session_id / role / content_json（text 块数组）/ created_timestamp
*   <YYYYMMDD_HHMMSS>.jsonl        旧版：首行会话元数据（description / id /
*                                  updated_at …），其后一行一消息（role / created
*                                  epoch 秒 / content [{type:'text',text}]）
*
* 数据目录路径：上游按 etcetera 应用策略解析（GOOSE_PATH_ROOT/data、Windows
* %APPDATA%\Block\goose、macOS ~/Library/Application Support/Block/goose、Linux
* $XDG_DATA_HOME/goose ?? ~/.local/share/goose，另探历史候选 ~/.config/goose），
* 但候选未在实机逐一核实——候选目录扫描命中（sessions/ 在册）才启用；全不命中
* → supported=false + note 诚实标注（绝不臆造固定路径），HANDOFF_ROOT_GOOSE 可
* 直指数据目录（sessions/ 所在层）。
* 只读不写、不复活 Goose 进程；坏行/损坏文件静默跳过或返回空流。
*/
const GOOSE_ROOT_CANDIDATES = [
	typeof process.env["GOOSE_PATH_ROOT"] === "string" && process.env["GOOSE_PATH_ROOT"] !== "" ? join(process.env["GOOSE_PATH_ROOT"], "data") : "",
	typeof process.env["APPDATA"] === "string" && process.env["APPDATA"] !== "" ? join(process.env["APPDATA"], "Block", "goose") : "",
	join(homedir(), "Library", "Application Support", "Block", "goose"),
	join(process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share"), "goose"),
	join(homedir(), ".config", "goose")
].filter((p) => p !== "");
/** Goose 数据目录解析：HANDOFF_ROOT_GOOSE 直指优先（存在与否不门 supported）；
* 否则候选目录扫描（sessions/ 在册即命中）；全不中回 null（诚实降级）。 */
function resolveGooseRoot() {
	const override = process.env["HANDOFF_ROOT_GOOSE"];
	if (typeof override === "string" && override !== "") return override;
	for (const dir of GOOSE_ROOT_CANDIDATES) if (existsSync(join(dir, "sessions"))) return dir;
	return null;
}
const GOOSE_ROOT = resolveGooseRoot();
const GOOSE_ROOT_DEFAULT = GOOSE_ROOT_CANDIDATES[0] ?? join(homedir(), ".config", "goose");
const GOOSE_NOTE_UNRESOLVED = `未找到 Goose 数据目录——候选 ${GOOSE_ROOT_CANDIDATES.join(" / ")} 均不在册（路径按上游应用策略推导，未在实机核实，待社区确认）；确认后可用 HANDOFF_ROOT_GOOSE 指定 sessions/ 所在的数据目录`;
/** 旧版 JSONL 文本 → Turn 流：首行会话元数据（无 role）与未知行静默跳过，
* 消息行只取 text 块（created epoch 秒自适应转 ISO）。 */
function parseGooseLegacyText(text) {
	const turns = [];
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line === "") continue;
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		if (record === null || typeof record !== "object" || Array.isArray(record)) continue;
		const role = record.role === "user" ? "user" : record.role === "assistant" ? "assistant" : "";
		if (role === "") continue;
		const blocks = Array.isArray(record.content) ? record.content : [];
		const body = blocks.filter((b) => b !== null && typeof b === "object" && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n").trim();
		if (body === "") continue;
		const tsMs = toMillis$1(record.created);
		turns.push(makeTurn({
			role,
			text: body,
			ts: tsMs !== 0 ? new Date(tsMs).toISOString() : ""
		}));
	}
	return turns;
}
/** sessionId + dbPath 可注入（单测用临时库），缺省探测命中的 sessions/sessions.db。
* content_json 是 text 块数组的 JSON——解出 text 拼正文，解不开原样透出（不粉饰）。 */
function parseGooseSession(sessionId, dbPath = GOOSE_ROOT !== null ? join(GOOSE_ROOT, "sessions", "sessions.db") : "") {
	const db = openFamilyDb(dbPath);
	if (db === null) return [];
	try {
		const cols = tableColumns(db, "messages");
		const sessionCol = firstCol(cols, ["session_id", "sessionId"]);
		const contentCol = firstCol(cols, ["content_json", "content"]);
		if (sessionCol === void 0 || contentCol === void 0) return [];
		const roleCol = firstCol(cols, ["role"]);
		const tsCol = firstCol(cols, ["created_timestamp", "timestamp"]);
		const idCol = firstCol(cols, ["id"]);
		const order = idCol !== void 0 ? `"${idCol}"` : "rowid";
		let rows = [];
		try {
			rows = db.prepare(`SELECT * FROM "messages" WHERE "${sessionCol}" = ? ORDER BY ${order}`).all(sessionId);
		} catch {
			return [];
		}
		const turns = [];
		for (const row of rows) {
			const role = turnRole(roleCol !== void 0 ? row[roleCol] : "assistant");
			if (role === null) continue;
			const raw = row[contentCol];
			let body = "";
			if (typeof raw === "string" && raw.trim() !== "") {
				try {
					const value = JSON.parse(raw);
					const blocks = Array.isArray(value) ? value : [value];
					body = blocks.filter((b) => b !== null && typeof b === "object" && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n").trim();
				} catch {
					body = raw.trim();
				}
			}
			if (body === "") continue;
			const tsMs = tsCol !== void 0 ? cellToMs(row[tsCol]) : 0;
			turns.push(makeTurn({
				role,
				text: body,
				ts: tsMs > 0 ? new Date(tsMs).toISOString() : ""
			}));
		}
		return turns;
	} finally {
		db.close();
	}
}
const gooseAdapter = {
	name: "goose",
	root: GOOSE_ROOT ?? GOOSE_ROOT_DEFAULT,
	supported: GOOSE_ROOT !== null,
	note: GOOSE_ROOT === null ? GOOSE_NOTE_UNRESOLVED : void 0,
	discover() {
		const out = [];
		if (GOOSE_ROOT === null) return out;
		const sessionsDir = join(GOOSE_ROOT, "sessions");
		let note = void 0;
		// 新形态：sessions.db（sessions / messages 表，sqlite-common 列名探测自适应）
		const db = openFamilyDb(join(sessionsDir, "sessions.db"));
		if (db !== null) try {
			const st = sqliteSessionsTable(db);
			if (st === null) note = "sessions.db 在册但未识别会话表（列名探测不中）——上游可能已迁移存储布局";
			else {
				out.push(...sqliteDiscoverRefs(this.name, db, st));
				if (sqliteTurnTable(db) === null) note = "已识别 sessions 表但未识别 messages 表——正文解析为空（列名探测不中）";
			}
		} finally {
			db.close();
		}
		// 旧形态：sessions/<时间戳>.jsonl（首行会话元数据作标题）
		let names = [];
		try {
			names = readdirSync(sessionsDir);
		} catch {}
		for (const name of names) {
			if (!name.endsWith(".jsonl")) continue;
			const file = join(sessionsDir, name);
			let mtime = 0, size = 0;
			try {
				const st = statSync(file);
				if (!st.isFile()) continue;
				mtime = st.mtimeMs;
				size = st.size;
			} catch {
				continue;
			}
			let meta = null;
			try {
				const first = readHead$1(file, 4096).split("\n")[0] ?? "";
				const value = JSON.parse(first);
				if (value !== null && typeof value === "object" && !Array.isArray(value)) meta = value;
			} catch {}
			const metaDescription = meta !== null && typeof meta.description === "string" ? meta.description.trim() : "";
			const metaId = meta !== null && typeof meta.id === "string" ? meta.id.trim() : "";
			const updated = meta !== null ? cellToMs(meta.updated_at) : 0;
			out.push({
				agent: this.name,
				id: file,
				title: (metaDescription !== "" ? metaDescription : metaId !== "" ? metaId : basename(name, ".jsonl")).slice(0, 80),
				cwd: "",
				updatedAt: updated > 0 ? updated : mtime,
				fingerprint: `${Math.round(mtime)}:${size}`,
				kind: "file"
			});
		}
		if (out.length === 0 && note === void 0 && existsSync(sessionsDir)) note = FAKE_ZERO_NOTE;
		this.note = note;
		return out.sort((a, b) => b.updatedAt - a.updatedAt);
	},
	parse(id) {
		try {
			if (id.toLowerCase().endsWith(".jsonl")) return parseGooseLegacyText(readFileSync(id, "utf8"));
			return parseGooseSession(id);
		} catch {
			return [];
		}
	}
};
//#endregion
//#region src/exports.ts
/**
* 云端导出落盘过渡通路（exports 目录探测）：
* 约定 <HANDOFF_HOME>/exports/<provider>/ 目录——各家云端会话凡能「导出成文件」的，
* 把导出文件按该家本地记录的原生格式丢进对应子目录，即被现有文件系适配器原样吃掉
* （零新增解析面：解析仍走各适配器既有 parse）。要点：
* - 根目录解析复用 HANDOFF_HOME 惯例（env 非空优先，缺省 ~/.handoff，与 core
*   resolveHome 同口径）；测试钩子 HANDOFF_EXPORTS 可直指 exports 根——与
*   HANDOFF_ROOT_* 同为「模块加载时读一次」的惯例。
* - 参与者 = 文件系适配器（发现/解析都以文件路径为轴）。纯 SQLite 四家
*   （zcode / copilot / devin / mimo）的 parse 只认库内会话 id，导出文件没有
*   可对齐的格式，不参与——诚实边界，不假装能吃。openclaw / goose 的
*   jsonl 旧格式可按扩展名分派，照常参与。
* - claude 的适配器名是 claude-code，导出目录按 provider 名约定为 exports/claude；
*   适配器同吃 exports/claude-code 别名目录（两轴名字差异只此一家）。
* - 只读不写；目录缺失 / 不可读 / 无文件 = 无导出，静默返回空，绝不抛错。
* - 不进交接目标轴（OUTBOUND_TARGETS）：导出探测是读取器能力，两轴独立。
*/
const HANDOFF_HOME_ENV = (process.env["HANDOFF_HOME"] ?? "").trim();
const HANDOFF_EXPORTS_ENV = (process.env["HANDOFF_EXPORTS"] ?? "").trim();
const EXPORTS_ROOT = HANDOFF_EXPORTS_ENV !== ""
	? HANDOFF_EXPORTS_ENV
	: join(HANDOFF_HOME_ENV !== "" ? HANDOFF_HOME_ENV : join(homedir(), ".handoff"), "exports");
/** 纯 SQLite 四家不参与（parse 只认库内会话 id，导出文件无格式可对齐） */
const EXPORTS_SKIP = new Set(["zcode", "copilot", "devin", "mimo"]);
/** 适配器名 → 导出目录名候选（provider 名约定 + 适配器名别名；差异只 claude 一家） */
const EXPORTS_DIR_ALIASES = { "claude-code": ["claude", "claude-code"] };
/** 某家适配器的导出目录候选（按候选序去重，别名与本体可能同名） */
function exportsDirsFor(agent) {
	const names = EXPORTS_DIR_ALIASES[agent] ?? [agent];
	return [...new Set(names.map((n) => join(EXPORTS_ROOT, n)))];
}
/** 扫一个导出目录 → SessionRef[]（常规文件逐个入册；cwd 如实留空） */
function exportsRefsOfDir(agent, dir) {
	const out = [];
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const file = join(dir, entry.name);
		let mtime = 0;
		let size = 0;
		try {
			const st = statSync(file);
			if (!st.isFile()) continue;
			mtime = st.mtimeMs;
			size = st.size;
		} catch {
			continue;
		}
		out.push({
			agent,
			id: file,
			title: basename(file),
			cwd: "",
			updatedAt: mtime,
			fingerprint: `${Math.round(mtime)}:${size}`,
			kind: "file"
		});
	}
	return out;
}
/** 某家适配器的导出会话（全部候选目录并集） */
function exportsRefsFor(agent) {
	if (EXPORTS_SKIP.has(agent)) return [];
	const out = [];
	for (const dir of exportsDirsFor(agent)) out.push(...exportsRefsOfDir(agent, dir));
	return out;
}
//#endregion
//#region src/index.ts
/**
* @agent-handoff/readers：二十三家 agent 会话的只读读取层。
* 移植自 dsh-hippo src/agents/，零三方运行时依赖（zcode / cursor store / copilot /
* devin / mimo / openclaw / goose 用 Node 内建 node:sqlite）。
* cursor / grok / gemini / kimi / codebuddy / qoder / kiro / copilot / devin / mimo /
* aider / cline / continue / qwen / antigravity / openclaw / goose 十七家为自研实现
* （格式为公开逆向调研；qwen / antigravity / openclaw / goose 对上游源码与社区
* 读取器核实）。
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
	grokAdapter,
	{
		name: "gemini",
		root: ROOT,
		supported: true,
		discover() {
			const out = [];
			let projectDirs = [];
			try {
				projectDirs = readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.isSymbolicLink()).map((d) => join(ROOT, d.name));
			} catch {
				return out;
			}
			for (const projectDir of projectDirs) {
				let chatEntries = [];
				const chatsDir = join(projectDir, "chats");
				try {
					chatEntries = readdirSync(chatsDir, { withFileTypes: true });
				} catch {
					continue;
				}
				const files = [];
				for (const entry of chatEntries) {
					const full = join(chatsDir, entry.name);
					if (entry.isFile() && isSessionFile(entry.name)) files.push(full);
					else if (entry.isDirectory() && !entry.isSymbolicLink()) try {
						for (const name of readdirSync(full)) if (isSessionFile(name)) files.push(join(full, name));
					} catch {
						continue;
					}
				}
				for (const file of files) {
					const ref = refFromFile(file);
					if (ref !== null) out.push(ref);
				}
			}
			this.note = out.length === 0 ? FAKE_ZERO_NOTE : void 0;
			return out.sort((a, b) => b.updatedAt - a.updatedAt);
		},
		parse(id) {
			try {
				return parseGeminiSession(id);
			} catch {
				return [];
			}
		}
	},
	kimiAdapter,
	codebuddyAdapter,
	qoderAdapter,
	kiroAdapter,
	copilotAdapter,
	devinAdapter,
	mimoAdapter,
	aiderAdapter,
	clineAdapter,
	continueAdapter,
	qwenAdapter,
	antigravityAdapter,
	openclawAdapter,
	gooseAdapter
];
const byName = new Map(AGENTS.map((a) => [a.name, a]));
/** 取适配器；未知名抛中文错（CLI 层转成用户可读信息）。 */
function adapterFor(agent) {
	const a = byName.get(agent);
	if (a === void 0) throw new Error(`未知 agent：${agent}（支持：${AGENTS.map((x) => x.name).join(" / ")}）`);
	return a;
}
/** 导出会话按 id 去重并入（防同一文件在发现层与导出层重复入册） */
function mergeExportsRefs(native, adapter) {
	const exports = exportsRefsFor(adapter.name);
	if (exports.length === 0) return native;
	// 有导出会话就不再报「假 0 布局迁移」哨兵——会话明明在册（导出落盘的），哨兵会说谎
	if (native.length === 0) adapter.note = void 0;
	const seen = new Set(native.map((r) => r.id));
	return [...native, ...exports.filter((r) => !seen.has(r.id))];
}
/** 发现会话：给 agent 名只查该家；不给则查全部支持的家，单家失败不拖垮整体。
* 本地发现之外并入 exports 导出落盘的会话（云端导出过渡通路），仍按更新时间倒序。 */
function listSessions(agent) {
	if (agent !== void 0) {
		const a = adapterFor(agent);
		if (!a.supported) return [];
		const refs = a.discover();
		return mergeExportsRefs(refs, a).sort((x, y) => y.updatedAt - x.updatedAt);
	}
	const out = [];
	for (const a of AGENTS) {
		if (!a.supported) continue;
		try {
			out.push(...a.discover());
		} catch {}
	}
	for (const a of AGENTS) {
		if (!a.supported || EXPORTS_SKIP.has(a.name)) continue;
		try {
			out.push(...exportsRefsFor(a.name));
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
/** 测试钩子：清空解析缓存 */
function clearSessionCache() {
	sessionCache.clear();
}
/** 引用解析：先发现该 agent 的会话，再按 id/路径/标题规则匹配。 */
function resolveAgentReference(agent, reference) {
	return resolveReference(reference, listSessions(agent));
}
/** 各 agent 的 inventory（root / 会话数 / 支持情况）。 */
function inventory() {
	return AGENTS.map((a) => ({
		agent: a.name,
		root: a.root,
		sessions: a.supported ? a.discover().length : 0,
		supported: a.supported,
		note: a.note
	}));
}
//#endregion
export { AGENTS, clearSessionCache, decodeCursorBlob, entryToTurns, inventory, listSessions, makeTurn, parseAiderHistoryText, parseAiderInputText, parseAntigravityTranscriptText, parseClineConversationText, parseCodexText, parseContinueSessionText, parseCopilotSession, parseCursorStore, parseCursorTranscriptText, parseDevinSession, parseGeminiJson, parseGeminiSession, parseGeminiText, parseGooseLegacyText, parseGooseSession, parseGrokSession, parseGrokUpdatesText, parseJsonl, parseKimiWireText, parseKiroSessionText, parseMimoSession, parseOpenCodeSession, parseOpenclawSession, parseOpenclawTranscriptText, parsePiText, parseQwenSession, parseQwenText, parseWorkbuddyKernelText, parseZcodeSession, readSession, renderCursorValue, resolveAgentReference, resolveGooseRoot, resolveMimoDb, summarizeToolCall };
